from __future__ import annotations

import json
import os
import socket
import stat
import struct
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import aisy_sidecars.voice_proxy_service as service_module
from aisy_sidecars.voice_proxy_service import (
    PROTOCOL,
    BrokerService,
    ServiceFailure,
    atomic_bytes,
    atomic_public,
    control_request,
    control_response,
    json_object,
    node_result,
    start_systemd_worker_socket,
    systemd_worker_fence,
)


@pytest.mark.parametrize("publisher", ["bytes", "public"])
def test_public_runtime_projection_ignores_restrictive_service_umask(
    tmp_path: Path,
    publisher: str,
) -> None:
    path = tmp_path / "projection"
    previous = os.umask(0o077)
    try:
        if publisher == "bytes":
            atomic_bytes(path, b"42\n")
        else:
            atomic_public(path, {"schemaVersion": 1})
    finally:
        os.umask(previous)

    assert stat.S_IMODE(path.stat().st_mode) == 0o644


def test_control_stream_accepts_only_exact_bounded_frame() -> None:
    left, right = socket.socketpair()
    request_id = "A" * 32
    body = json.dumps(
        [PROTOCOL, request_id, "submit", ["code"], 3], separators=(",", ":")
    ).encode()
    try:
        left.sendall(struct.pack(">I", len(body)) + body + b"key")
        assert control_request(right) == (request_id, "submit", ["code"], bytearray(b"key"))
        response = control_response(request_id, True, ["ready", "opaque", 1])
        assert struct.unpack(">I", response[:4])[0] == len(response) - 4
        assert json.loads(response[4:]) == [
            PROTOCOL, request_id, "ok", ["ready", "opaque", 1],
        ]
    finally:
        left.close()
        right.close()


def test_duplicate_json_and_unknown_worker_result_fail_closed() -> None:
    with pytest.raises(ServiceFailure, match="JSON_REFUSED"):
        json_object([("schemaVersion", 1), ("schemaVersion", 1)])
    assert node_result({"ok": False, "code": "raw-vendor-detail"}) == {
        "ok": False,
        "transcript": None,
        "language": None,
        "durationMs": None,
        "code": "UPSTREAM_UNAVAILABLE",
        "dispatch": "none",
    }


@pytest.mark.parametrize(
    "code",
    ["AUTH_REJECTED", "QUOTA_EXCEEDED", "TIMEOUT", "UPSTREAM_UNAVAILABLE"],
)
def test_public_worker_errors_stay_in_closed_union(code: str) -> None:
    assert node_result({"ok": False, "code": code, "dispatch": "attempted"})[
        "code"
    ] == code


def test_revoke_fence_stops_activation_and_requires_zero_live_workers() -> None:
    calls: list[list[str]] = []

    def run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=b"", stderr=b"")

    assert systemd_worker_fence(run)
    assert calls == [
        ["/usr/bin/systemctl", "stop", "aisy-voice-worker.socket"],
        [
            "/usr/bin/systemctl",
            "list-units",
            "--type=service",
            "--state=activating,running,deactivating",
            "--no-legend",
            "--no-pager",
            "--plain",
            "aisy-voice-worker@*.service",
        ],
    ]

    def active(
        argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(argv, 0, stdout=b"active-worker\n")

    assert not systemd_worker_fence(active)


def test_completed_revoke_restores_worker_socket() -> None:
    calls: list[list[str]] = []

    def run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=b"", stderr=b"")

    start_systemd_worker_socket(run)
    assert calls == [
        ["/usr/bin/systemctl", "start", "aisy-voice-worker.socket"],
    ]


def test_revoke_operation_passes_fence_and_restores_socket(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[object] = []

    class Broker:
        @staticmethod
        def binding_hash(*binding: str) -> str:
            calls.append(binding)
            return "binding-hash"

    class Backend:
        @staticmethod
        def revoke(binding_hash: str, fence: object) -> int:
            calls.append(binding_hash)
            assert callable(fence)
            assert fence(2)
            return 2

    monkeypatch.setattr(service_module, "systemd_worker_fence", lambda: True)
    monkeypatch.setattr(
        service_module,
        "start_systemd_worker_socket",
        lambda: calls.append("socket-started"),
    )
    service = object.__new__(BrokerService)
    service.config = SimpleNamespace(installation_hash="d" * 64)
    service.broker = Broker()
    service.backend = Backend()
    owned = bytearray(b"unused")

    assert service.operation(
        "revoke",
        ["d" * 64, "operator-e2e", "profile-e2e", "deepgram-cloud"],
        owned,
    ) == ["revoked", 2]
    assert calls == [
        ("d" * 64, "operator-e2e", "profile-e2e", "deepgram-cloud"),
        "binding-hash",
        "socket-started",
    ]
    assert owned == bytearray(len(owned))
