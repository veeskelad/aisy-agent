from __future__ import annotations

import hashlib
import json
import os
import socket
import threading

import pytest

import aisy_sidecars.provider_validation_worker as validator_module
from aisy_sidecars.provider_broker_protocol import (
    DESCRIPTOR_BY_PROVIDER,
    FRAME_DATA,
    FRAME_END,
    FRAME_ERROR,
    FRAME_HEADER,
    encode_frame,
)
from aisy_sidecars.provider_validation_worker import (
    ProviderValidationFailure,
    receive_material,
    run_one_shot,
)
from aisy_sidecars.provider_worker import receive_frame

MATERIAL = b"provider-validation-material-sentinel"


class FakeUpstream:
    def __init__(self) -> None:
        self.sent = bytearray()
        self.closed = False

    def sendall(self, data: bytes | memoryview) -> None:
        self.sent.extend(data)

    def makefile(self, _mode: str):
        raise AssertionError("unexpected makefile call")

    def settimeout(self, _value: float) -> None:
        return

    def close(self) -> None:
        self.closed = True


class FakeResponse:
    status = 200

    def __init__(self, _upstream: FakeUpstream) -> None:
        self.status = type(self).status
        self.headers = {"content-type": "application/json"}

    def begin(self) -> None:
        return


def send_material(connection: socket.socket, provider: str, material: bytes = MATERIAL) -> None:
    header = json.dumps({
        "schemaVersion": 1,
        "providerId": provider,
        "materialLength": len(material),
        "materialSha256": hashlib.sha256(material).hexdigest(),
        "deadlineMs": 5_000,
    }, separators=(",", ":")).encode()
    connection.sendall(encode_frame(FRAME_HEADER, header))
    connection.sendall(encode_frame(FRAME_DATA, material))
    connection.sendall(encode_frame(FRAME_END))


@pytest.mark.skipif(not hasattr(socket, "SO_PEERCRED"), reason="Linux peer boundary")
def test_validator_returns_status_only_after_exact_authenticated_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    broker, worker = socket.socketpair()
    upstream = FakeUpstream()
    failures: list[BaseException] = []
    monkeypatch.setattr(validator_module.http.client, "HTTPResponse", FakeResponse)

    def work() -> None:
        try:
            run_one_shot(
                worker,
                "openai",
                expected_broker_uid=os.getuid(),
                resolver=lambda _host, _port: ["1.1.1.1"],
                connector=lambda *_args: upstream,
            )
        except BaseException as error:  # noqa: BLE001
            failures.append(error)

    thread = threading.Thread(target=work)
    thread.start()
    send_material(broker, "openai")
    header = receive_frame(broker)
    end = receive_frame(broker)
    thread.join(timeout=5)

    assert failures == []
    assert json.loads(header[1]) == {"schemaVersion": 1, "state": "valid"}
    assert end == (FRAME_END, b"")
    sent_head, sent_body = bytes(upstream.sent).split(b"\r\n\r\n", 1)
    assert sent_body == b""
    assert sent_head.startswith(b"GET /v1/models HTTP/1.1")
    assert b"Authorization: Bearer " + MATERIAL in sent_head
    upstream.sent[:] = b"\0" * len(upstream.sent)
    assert upstream.closed
    broker.close()
    worker.close()


@pytest.mark.skipif(not hasattr(socket, "SO_PEERCRED"), reason="Linux peer boundary")
def test_validator_rejects_auth_failure_and_private_destination(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    broker, worker = socket.socketpair()
    upstream = FakeUpstream()
    failures: list[BaseException] = []
    FakeResponse.status = 401
    monkeypatch.setattr(validator_module.http.client, "HTTPResponse", FakeResponse)

    def work() -> None:
        try:
            run_one_shot(
                worker,
                "openai",
                expected_broker_uid=os.getuid(),
                resolver=lambda _host, _port: ["1.1.1.1"],
                connector=lambda *_args: upstream,
            )
        except BaseException as error:  # noqa: BLE001
            failures.append(error)

    thread = threading.Thread(target=work)
    thread.start()
    send_material(broker, "openai")
    kind, payload = receive_frame(broker)
    thread.join(timeout=5)
    assert kind == FRAME_ERROR
    assert json.loads(payload)["code"] == "MATERIAL_REJECTED"
    assert len(failures) == 1
    broker.close()
    worker.close()

    with pytest.raises(ProviderValidationFailure, match="DESTINATION_REFUSED"):
        validator_module.validate_once(
            validator_module.ValidationRequest(
                "openai", len(MATERIAL), hashlib.sha256(MATERIAL).hexdigest(), 5_000,
            ),
            bytearray(MATERIAL),
            resolver=lambda _host, _port: ["127.0.0.1"],
            connector=lambda *_args: (_ for _ in ()).throw(AssertionError("network")),
        )


def test_validation_descriptors_are_static_and_status_bounded() -> None:
    assert set(DESCRIPTOR_BY_PROVIDER) == {
        "openai", "anthropic", "openrouter", "deepseek", "qwen", "glm", "gemini",
    }
    for descriptor in DESCRIPTOR_BY_PROVIDER.values():
        assert descriptor.validation_method in {"GET", "POST"}
        assert descriptor.validation_path.startswith("/")
        assert 401 not in descriptor.validation_statuses
        assert 403 not in descriptor.validation_statuses
        assert 300 not in descriptor.validation_statuses


def test_material_frames_support_fragmentation_into_one_owned_buffer() -> None:
    broker, worker = socket.socketpair()
    header = json.dumps({
        "schemaVersion": 1,
        "providerId": "openai",
        "materialLength": len(MATERIAL),
        "materialSha256": hashlib.sha256(MATERIAL).hexdigest(),
        "deadlineMs": 5_000,
    }, separators=(",", ":")).encode()
    broker.sendall(encode_frame(FRAME_HEADER, header))
    framed = encode_frame(FRAME_DATA, MATERIAL) + encode_frame(FRAME_END)
    for value in framed:
        broker.sendall(bytes((value,)))

    request, owned = receive_material(worker)

    assert request.provider_id == "openai"
    assert owned == bytearray(MATERIAL)
    owned[:] = b"\0" * len(owned)
    broker.close()
    worker.close()
