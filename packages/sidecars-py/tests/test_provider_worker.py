from __future__ import annotations

import hashlib
import json
import os
import socket
import threading
from pathlib import Path

import pytest

import aisy_sidecars.provider_worker as worker_module
from aisy_sidecars.provider_broker_protocol import (
    FRAME_ATTEMPTED,
    FRAME_ATTEMPTED_ACK,
    FRAME_DATA,
    FRAME_END,
    FRAME_ERROR,
    FRAME_HEADER,
    decode_frame,
    encode_frame,
)
from aisy_sidecars.provider_worker import (
    ProviderWorkerFailure,
    ProviderWorkerPolicy,
    read_systemd_credential,
    receive_frame,
    run_one_shot,
)

BODY = b'{"model":"gpt-test","messages":[]}'
MATERIAL = b"provider-worker-material-sentinel"


class FakeUpstream:
    def __init__(self, response: bytes) -> None:
        self.response = response
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


class FakeHttpResponse:
    def __init__(self, upstream: FakeUpstream) -> None:
        self.status = 200
        self.headers = {"content-type": "application/json", "set-cookie": "private"}
        self._chunks = [upstream.response[:3], upstream.response[3:], b""]

    def begin(self) -> None:
        return

    def read(self, _size: int) -> bytes:
        return self._chunks.pop(0)


def policy(tmp_path: Path) -> ProviderWorkerPolicy:
    return ProviderWorkerPolicy(
        provider_id="openai",
        expected_broker_uid=os.getuid(),
        credential_path=tmp_path / "aisy-provider",
        credential_owner_uid=os.getuid(),
        credential_owner_gid=os.getgid(),
        timeout_seconds=5.0,
    )


def header(**changes: object) -> bytes:
    value: dict[str, object] = {
        "schemaVersion": 1,
        "requestId": "request_" + "a" * 32,
        "descriptorId": "openai.chat-completions.v1",
        "method": "POST",
        "contentType": "application/json",
        "bodyLength": len(BODY),
        "bodySha256": hashlib.sha256(BODY).hexdigest(),
        "deadlineMs": 5_000,
        "headers": {"accept": "application/json"},
    }
    value.update(changes)
    return json.dumps(value, separators=(",", ":")).encode()


def send_request(connection: socket.socket, **changes: object) -> None:
    connection.sendall(encode_frame(FRAME_HEADER, header(**changes)))
    connection.sendall(encode_frame(FRAME_DATA, BODY[:4]))
    connection.sendall(encode_frame(FRAME_DATA, BODY[4:]))
    connection.sendall(encode_frame(FRAME_END))


def write_material(target: Path) -> None:
    target.write_bytes(MATERIAL)
    target.chmod(0o440)


def test_systemd_credential_read_requires_exact_private_regular_file(tmp_path: Path) -> None:
    expected = policy(tmp_path)
    write_material(expected.credential_path)
    owned = read_systemd_credential(expected)
    assert owned == MATERIAL
    owned[:] = b"\0" * len(owned)

    expected.credential_path.chmod(0o644)
    with pytest.raises(ProviderWorkerFailure, match="CREDENTIAL_REFUSED"):
        read_systemd_credential(expected)

    expected.credential_path.unlink()
    foreign = tmp_path / "foreign"
    write_material(foreign)
    expected.credential_path.symlink_to(foreign)
    with pytest.raises(ProviderWorkerFailure, match="CREDENTIAL_REFUSED"):
        read_systemd_credential(expected)


@pytest.mark.skipif(not hasattr(socket, "SO_PEERCRED"), reason="Linux peer boundary")
def test_worker_marks_attempted_before_network_and_streams_projected_response(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = policy(tmp_path)
    write_material(expected.credential_path)
    broker, worker = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    upstream = FakeUpstream(b'{"ok":true}')
    timeline: list[str] = []
    failure: list[BaseException] = []

    monkeypatch.setattr(worker_module.http.client, "HTTPResponse", FakeHttpResponse)

    def connect(address: str, host: str, port: int, _timeout: float) -> FakeUpstream:
        timeline.append("connect")
        assert (address, host, port) == ("1.1.1.1", "api.openai.com", 443)
        return upstream

    def work() -> None:
        try:
            run_one_shot(
                worker,
                expected,
                resolver=lambda _host, _port: ["1.1.1.1"],
                connector=connect,
            )
        except BaseException as error:  # noqa: BLE001
            failure.append(error)

    thread = threading.Thread(target=work)
    thread.start()
    send_request(broker)
    kind, payload = receive_frame(broker)
    assert (kind, payload) == (FRAME_ATTEMPTED, b"")
    assert timeline == []
    broker.sendall(encode_frame(FRAME_ATTEMPTED_ACK))

    frames: list[tuple[bytes, bytes]] = []
    while True:
        frame = receive_frame(broker)
        frames.append(frame)
        if frame[0] == FRAME_END:
            break
    thread.join(timeout=5)
    broker.close()
    worker.close()

    assert not thread.is_alive()
    assert failure == []
    assert timeline == ["connect"]
    assert [kind for kind, _payload in frames] == [FRAME_HEADER, FRAME_DATA, FRAME_DATA, FRAME_END]
    assert json.loads(frames[0][1]) == {
        "headers": {"content-type": "application/json"},
        "schemaVersion": 1,
        "status": 200,
    }
    assert b"".join(item for kind, item in frames if kind == FRAME_DATA) == b'{"ok":true}'
    sent_head, sent_body = bytes(upstream.sent).split(b"\r\n\r\n", 1)
    assert sent_body == BODY
    assert b"Authorization: Bearer " + MATERIAL in sent_head
    upstream.sent[:] = b"\0" * len(upstream.sent)
    assert upstream.closed


@pytest.mark.skipif(not hasattr(socket, "SO_PEERCRED"), reason="Linux peer boundary")
def test_worker_rejects_private_dns_before_attempt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = policy(tmp_path)
    broker, worker = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    failure: list[BaseException] = []
    reads = 0

    def material(_policy: ProviderWorkerPolicy) -> bytearray:
        nonlocal reads
        reads += 1
        return bytearray(MATERIAL)

    monkeypatch.setattr(worker_module, "read_systemd_credential", material)

    def work() -> None:
        try:
            run_one_shot(
                worker,
                expected,
                resolver=lambda _host, _port: ["127.0.0.1"],
                connector=lambda *_args: (_ for _ in ()).throw(AssertionError("network")),
            )
        except BaseException as error:  # noqa: BLE001
            failure.append(error)

    thread = threading.Thread(target=work)
    thread.start()
    send_request(broker)
    kind, payload = receive_frame(broker)
    thread.join(timeout=5)
    broker.close()
    worker.close()

    assert kind == FRAME_ERROR
    assert json.loads(payload) == {
        "attempted": False,
        "code": "DESTINATION_REFUSED",
        "schemaVersion": 1,
    }
    assert reads == 1
    assert len(failure) == 1


def test_frame_decoder_refuses_truncated_input() -> None:
    left, right = socket.socketpair()
    try:
        left.sendall(b"\0\0\0\x05H{}")
        left.close()
        with pytest.raises(ProviderWorkerFailure, match="FRAME_TRUNCATED"):
            receive_frame(right)
    finally:
        right.close()


def test_protocol_frame_round_trip_remains_exact() -> None:
    assert decode_frame(encode_frame(FRAME_DATA, b"x")) == (FRAME_DATA, b"x")
