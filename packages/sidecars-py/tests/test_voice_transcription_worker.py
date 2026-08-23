from __future__ import annotations

import array
import fcntl
import hashlib
import json
import os
import socket
import sys
import threading
from pathlib import Path

import pytest

import aisy_sidecars.voice_transcription_worker as worker_module
from aisy_sidecars.voice_transcription_worker import (
    CREDENTIAL_NAME,
    DESCRIPTOR_ID,
    REQUIRED_MEMFD_SEALS,
    TranscriptionClaim,
    WorkerFailure,
    WorkerPolicy,
    attest_audio,
    decode_claim,
    read_systemd_credential,
    run_one_shot,
)

INSTALLATION = "a" * 64
HANDLE = "handle_" + "b" * 32
PERMIT = "permit_" + "c" * 32
KEY = b"worker-key-sentinel"
AUDIO = b"OggS-one-shot-audio-sentinel"


class FakeConnection:
    def __init__(self, response: bytes, *, send_size: int = 1_000_000) -> None:
        self.response = bytearray(response)
        self.send_size = send_size
        self.sent = bytearray()
        self.offset = 0
        self.closed = False

    def send(self, data: memoryview) -> int:
        count = min(len(data), self.send_size)
        self.sent.extend(data[:count])
        return count

    def recv_into(self, buffer: bytearray) -> int:
        if self.offset == len(self.response):
            return 0
        count = min(len(buffer), len(self.response) - self.offset)
        buffer[:count] = self.response[self.offset : self.offset + count]
        self.offset += count
        return count

    def settimeout(self, _timeout: float) -> None:
        return

    def close(self) -> None:
        self.closed = True


def policy(tmp_path: Path) -> WorkerPolicy:
    return WorkerPolicy(
        os.getpid(),
        os.getuid(),
        INSTALLATION,
        HANDLE,
        tmp_path / CREDENTIAL_NAME,
        os.getuid(),
        os.getgid(),
        5.0,
    )


def claim_payload(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schemaVersion": 1,
        "descriptorId": DESCRIPTOR_ID,
        "installationHash": INSTALLATION,
        "handle": HANDLE,
        "dispatchPermitId": PERMIT,
        "audioSha256": hashlib.sha256(AUDIO).hexdigest(),
        "audioBytes": len(AUDIO),
        "contentType": "audio/ogg",
    }
    value.update(changes)
    return value


def encoded_claim(**changes: object) -> bytes:
    return json.dumps(claim_payload(**changes), separators=(",", ":")).encode()


def success_response(
    *, transcript: str = "проверенный текст", language: str = "en-US"
) -> bytes:
    body = json.dumps(
        {
            "metadata": {"duration": 1.25, "vendorIgnored": "not-projected"},
            "results": {
                "channels": [
                    {
                        "detected_language": language,
                        "alternatives": [{"transcript": transcript, "extra": True}],
                    }
                ]
            },
        },
        separators=(",", ":"),
    ).encode()
    return (
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\n\r\n"
        + body
    )


def create_audio_memfd(*, sealed: bool = True, payload: bytes = AUDIO) -> int:
    descriptor = os.memfd_create(
        "aisy-voice-test",
        os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING,
    )
    os.write(descriptor, payload)
    os.lseek(descriptor, 0, os.SEEK_SET)
    if sealed:
        fcntl.fcntl(descriptor, fcntl.F_ADD_SEALS, REQUIRED_MEMFD_SEALS)
    return descriptor


def write_credential(target: Path) -> None:
    target.write_bytes(KEY)
    target.chmod(0o440)


def broker_thread(
    relay: socket.socket,
    descriptor: int,
    events: list[dict[str, object]],
    errors: list[BaseException],
    *,
    mark_ack: bool = True,
    commit_ack: bool = True,
) -> threading.Thread:
    def exchange() -> None:
        try:
            rights = array.array("i", [descriptor])
            relay.sendmsg(
                [encoded_claim()],
                [(socket.SOL_SOCKET, socket.SCM_RIGHTS, rights.tobytes())],
            )
            os.close(descriptor)
            while True:
                raw = relay.recv(64 * 1024)
                if not raw:
                    return
                value = json.loads(raw)
                events.append(value)
                operation = value["operation"]
                if operation == "mark-attempted":
                    if not mark_ack:
                        relay.close()
                        return
                    relay.send(
                        json.dumps(
                            {
                                "schemaVersion": 1,
                                "operation": "attempted",
                                "dispatchPermitId": PERMIT,
                            },
                            separators=(",", ":"),
                            sort_keys=True,
                        ).encode()
                    )
                    continue
                if operation == "commit-result":
                    if commit_ack:
                        relay.send(
                            json.dumps(
                                {
                                    "schemaVersion": 1,
                                    "operation": "result-committed",
                                    "dispatchPermitId": PERMIT,
                                },
                                separators=(",", ":"),
                                sort_keys=True,
                            ).encode()
                        )
                    else:
                        relay.close()
                    return
                raise AssertionError("unexpected relay operation")
        except BaseException as error:  # noqa: BLE001 - surfaced in parent assertion
            errors.append(error)

    thread = threading.Thread(target=exchange)
    thread.start()
    return thread


def test_claim_parser_requires_exact_policy_binding_and_fields(tmp_path: Path) -> None:
    expected = policy(tmp_path)
    claim = decode_claim(encoded_claim(), expected)
    assert claim == TranscriptionClaim(
        INSTALLATION,
        HANDLE,
        PERMIT,
        hashlib.sha256(AUDIO).hexdigest(),
        len(AUDIO),
        "audio/ogg",
    )

    for changed in (
        {"schemaVersion": 1.0},
        {"descriptorId": "foreign"},
        {"installationHash": "d" * 64},
        {"handle": "foreign_" + "e" * 32},
        {"audioBytes": True},
        {"contentType": "audio/wav"},
        {"extension": True},
    ):
        with pytest.raises(WorkerFailure):
            decode_claim(encoded_claim(**changed), expected)

    duplicate = encoded_claim()[:-1] + b',"audioBytes":1}'
    with pytest.raises(WorkerFailure, match="MALFORMED_FRAME"):
        decode_claim(duplicate, expected)


def test_systemd_credential_read_is_exact_private_regular_file(tmp_path: Path) -> None:
    expected = policy(tmp_path)
    write_credential(expected.credential_path)
    owned = read_systemd_credential(expected)
    assert owned == KEY
    owned[:] = b"\0" * len(owned)

    expected.credential_path.chmod(0o644)
    with pytest.raises(WorkerFailure, match="CREDENTIAL_REFUSED"):
        read_systemd_credential(expected)

    expected.credential_path.unlink()
    target = tmp_path / "foreign"
    target.write_bytes(KEY)
    target.chmod(0o600)
    expected.credential_path.symlink_to(target)
    with pytest.raises(WorkerFailure, match="CREDENTIAL_REFUSED"):
        read_systemd_credential(expected)


@pytest.mark.skipif(sys.platform != "linux", reason="Linux sealed memfd boundary")
def test_audio_attestation_requires_exact_seals_size_and_hash() -> None:
    claim = TranscriptionClaim(
        INSTALLATION,
        HANDLE,
        PERMIT,
        hashlib.sha256(AUDIO).hexdigest(),
        len(AUDIO),
        "audio/ogg",
    )
    sealed = create_audio_memfd()
    unsealed = create_audio_memfd(sealed=False)
    wrong = create_audio_memfd(payload=AUDIO + b"x")
    try:
        attest_audio(sealed, claim)
        with pytest.raises(WorkerFailure, match="AUDIO_REFUSED"):
            attest_audio(unsealed, claim)
        with pytest.raises(WorkerFailure, match="AUDIO_REFUSED"):
            attest_audio(wrong, claim)
    finally:
        os.close(sealed)
        os.close(unsealed)
        os.close(wrong)


@pytest.mark.skipif(sys.platform != "linux", reason="Linux relay and memfd boundary")
def test_one_shot_posts_once_after_durable_mark_and_projects_typed_result(
    tmp_path: Path,
) -> None:
    expected = policy(tmp_path)
    write_credential(expected.credential_path)
    broker, worker = socket.socketpair(
        socket.AF_UNIX,
        socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC,
    )
    events: list[dict[str, object]] = []
    errors: list[BaseException] = []
    timeline: list[str] = []
    thread = broker_thread(broker, create_audio_memfd(), events, errors)
    connection = FakeConnection(success_response(), send_size=7)
    calls = 0

    def connector(address: str, hostname: str, _timeout: float) -> FakeConnection:
        nonlocal calls
        calls += 1
        timeline.append("connect")
        assert address == "1.1.1.1"
        assert hostname == "api.deepgram.com"
        assert events[0]["operation"] == "mark-attempted"
        return connection

    result = run_one_shot(
        worker,
        expected,
        resolver=lambda _host, _port: ["1.1.1.1"],
        connector=connector,
    )
    thread.join(timeout=5)
    worker.close()
    broker.close()

    assert not thread.is_alive()
    assert errors == []
    assert calls == 1
    assert timeline == ["connect"]
    assert [event["operation"] for event in events] == [
        "mark-attempted",
        "commit-result",
    ]
    assert result == {
        "ok": True,
        "transcript": "проверенный текст",
        "durationMs": 1250,
        "language": "en-US",
    }
    assert events[1]["result"] == result
    header, sent_audio = bytes(connection.sent).split(b"\r\n\r\n", 1)
    assert header.startswith(
        b"POST /v1/listen?model=nova-3&smart_format=true&detect_language=true "
        b"HTTP/1.1\r\nHost: api.deepgram.com\r\nAuthorization: Token " + KEY
    )
    assert sent_audio == AUDIO
    assert connection.closed
    connection.sent[:] = b"\0" * len(connection.sent)


@pytest.mark.skipif(sys.platform != "linux", reason="Linux relay and memfd boundary")
def test_lost_mark_ack_causes_zero_network_and_zeroizes_owned_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = policy(tmp_path)
    broker, worker = socket.socketpair(
        socket.AF_UNIX,
        socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC,
    )
    events: list[dict[str, object]] = []
    errors: list[BaseException] = []
    thread = broker_thread(
        broker,
        create_audio_memfd(),
        events,
        errors,
        mark_ack=False,
    )
    owned = bytearray(KEY)
    monkeypatch.setattr(
        worker_module,
        "read_systemd_credential",
        lambda _policy: owned,
    )
    calls = 0

    def connector(*_args: object) -> FakeConnection:
        nonlocal calls
        calls += 1
        return FakeConnection(success_response())

    with pytest.raises(WorkerFailure, match="BROKER_ACK_AMBIGUOUS"):
        run_one_shot(
            worker,
            expected,
            resolver=lambda _host, _port: ["1.1.1.1"],
            connector=connector,
        )
    thread.join(timeout=5)
    worker.close()

    assert not thread.is_alive()
    assert errors == []
    assert calls == 0
    assert [event["operation"] for event in events] == ["mark-attempted"]
    assert owned == bytearray(len(KEY))


@pytest.mark.skipif(sys.platform != "linux", reason="Linux relay and memfd boundary")
def test_unsealed_audio_returns_none_before_credential_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = policy(tmp_path)
    broker, worker = socket.socketpair(
        socket.AF_UNIX,
        socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC,
    )
    events: list[dict[str, object]] = []
    errors: list[BaseException] = []
    thread = broker_thread(
        broker,
        create_audio_memfd(sealed=False),
        events,
        errors,
    )
    reads = 0

    def refuse_read(_policy: WorkerPolicy) -> bytearray:
        nonlocal reads
        reads += 1
        return bytearray(KEY)

    monkeypatch.setattr(worker_module, "read_systemd_credential", refuse_read)
    result = run_one_shot(worker, expected)
    thread.join(timeout=5)
    worker.close()
    broker.close()

    assert errors == []
    assert reads == 0
    assert result == {"ok": False, "code": "AUDIO_REFUSED", "dispatch": "none"}
    assert [event["operation"] for event in events] == ["commit-result"]


@pytest.mark.skipif(sys.platform != "linux", reason="Linux relay and memfd boundary")
@pytest.mark.parametrize(
    ("status", "code"),
    [(401, "AUTH_REJECTED"), (403, "AUTH_REJECTED"), (429, "QUOTA_EXCEEDED")],
)
def test_upstream_refusal_is_attempted_once_without_raw_detail(
    tmp_path: Path, status: int, code: str
) -> None:
    expected = policy(tmp_path)
    write_credential(expected.credential_path)
    broker, worker = socket.socketpair(
        socket.AF_UNIX,
        socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC,
    )
    events: list[dict[str, object]] = []
    errors: list[BaseException] = []
    thread = broker_thread(broker, create_audio_memfd(), events, errors)
    response = (
        f"HTTP/1.1 {status} Nope\r\nContent-Length: 18\r\n\r\n"
        "raw-vendor-detail!"
    ).encode()
    connection = FakeConnection(response)
    calls = 0

    def connector(*_args: object) -> FakeConnection:
        nonlocal calls
        calls += 1
        return connection

    result = run_one_shot(
        worker,
        expected,
        resolver=lambda _host, _port: ["1.1.1.1"],
        connector=connector,
    )
    thread.join(timeout=5)
    worker.close()
    broker.close()

    assert errors == []
    assert calls == 1
    assert result == {
        "ok": False,
        "code": code,
        "dispatch": "attempted",
    }
    assert "raw-vendor-detail" not in json.dumps(events)
    connection.sent[:] = b"\0" * len(connection.sent)


@pytest.mark.skipif(sys.platform != "linux", reason="Linux relay and memfd boundary")
def test_mixed_address_answer_is_attempted_without_https_connect(
    tmp_path: Path,
) -> None:
    expected = policy(tmp_path)
    write_credential(expected.credential_path)
    broker, worker = socket.socketpair(
        socket.AF_UNIX,
        socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC,
    )
    events: list[dict[str, object]] = []
    errors: list[BaseException] = []
    thread = broker_thread(broker, create_audio_memfd(), events, errors)
    calls = 0

    def connector(*_args: object) -> FakeConnection:
        nonlocal calls
        calls += 1
        return FakeConnection(success_response())

    result = run_one_shot(
        worker,
        expected,
        resolver=lambda _host, _port: ["1.1.1.1", "127.0.0.1"],
        connector=connector,
    )
    thread.join(timeout=5)
    broker.close()

    assert errors == []
    assert calls == 0
    assert result == {
        "ok": False,
        "code": "TRANSCRIPTION_ADDRESS_REFUSED",
        "dispatch": "attempted",
    }
    assert [event["operation"] for event in events] == [
        "mark-attempted",
        "commit-result",
    ]


@pytest.mark.skipif(sys.platform != "linux", reason="Linux relay and memfd boundary")
@pytest.mark.parametrize(
    ("case", "code"),
    [
        ("redirect", "TRANSCRIPTION_REFUSED"),
        ("malformed-status", "TRANSCRIPTION_RESPONSE_REFUSED"),
        ("oversized", "TRANSCRIPTION_RESPONSE_BOUNDS"),
        ("duplicate-json", "TRANSCRIPTION_RESPONSE_REFUSED"),
        ("typed-bounds", "TRANSCRIPTION_RESPONSE_REFUSED"),
    ],
)
def test_http_and_body_faults_are_attempted_redacted_and_never_retried(
    tmp_path: Path,
    case: str,
    code: str,
) -> None:
    expected = policy(tmp_path)
    write_credential(expected.credential_path)
    if case == "redirect":
        response = b"HTTP/1.1 302 Found\r\nLocation: https://foreign.invalid/\r\n\r\n"
    elif case == "malformed-status":
        response = b"HTTP/1.1 200XYZ\r\n\r\n{}"
    elif case == "oversized":
        body = b"x" * (1024 * 1024 + 1)
        response = (
            b"HTTP/1.1 200 OK\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\n\r\n"
            + body
        )
    elif case == "duplicate-json":
        body = (
            b'{"metadata":{"duration":1},"metadata":{"duration":2},'
            b'"results":{"channels":[{"alternatives":[{"transcript":"x"}]}]}}'
        )
        response = (
            b"HTTP/1.1 200 OK\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\n\r\n"
            + body
        )
    else:
        response = success_response(transcript="x" * (60 * 1024 + 1))

    broker, worker = socket.socketpair(
        socket.AF_UNIX,
        socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC,
    )
    events: list[dict[str, object]] = []
    errors: list[BaseException] = []
    thread = broker_thread(broker, create_audio_memfd(), events, errors)
    connection = FakeConnection(response)
    calls = 0

    def connector(*_args: object) -> FakeConnection:
        nonlocal calls
        calls += 1
        return connection

    result = run_one_shot(
        worker,
        expected,
        resolver=lambda _host, _port: ["1.1.1.1"],
        connector=connector,
    )
    thread.join(timeout=5)
    broker.close()

    assert errors == []
    assert calls == 1
    assert result == {"ok": False, "code": code, "dispatch": "attempted"}
    assert events[-1]["result"] == result
    assert "foreign.invalid" not in json.dumps(events)
    connection.sent[:] = b"\0" * len(connection.sent)


@pytest.mark.skipif(sys.platform != "linux", reason="Linux relay and memfd boundary")
def test_short_upstream_write_is_attempted_once(tmp_path: Path) -> None:
    expected = policy(tmp_path)
    write_credential(expected.credential_path)
    broker, worker = socket.socketpair(
        socket.AF_UNIX,
        socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC,
    )
    events: list[dict[str, object]] = []
    errors: list[BaseException] = []
    thread = broker_thread(broker, create_audio_memfd(), events, errors)
    connection = FakeConnection(success_response(), send_size=0)
    calls = 0

    def connector(*_args: object) -> FakeConnection:
        nonlocal calls
        calls += 1
        return connection

    result = run_one_shot(
        worker,
        expected,
        resolver=lambda _host, _port: ["1.1.1.1"],
        connector=connector,
    )
    thread.join(timeout=5)
    broker.close()

    assert errors == []
    assert calls == 1
    assert result == {
        "ok": False,
        "code": "TRANSCRIPTION_TRANSPORT_REFUSED",
        "dispatch": "attempted",
    }


@pytest.mark.skipif(sys.platform != "linux", reason="Linux relay and memfd boundary")
def test_lost_terminal_ack_never_repeats_post_and_zeroizes_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = policy(tmp_path)
    broker, worker = socket.socketpair(
        socket.AF_UNIX,
        socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC,
    )
    events: list[dict[str, object]] = []
    errors: list[BaseException] = []
    thread = broker_thread(
        broker,
        create_audio_memfd(),
        events,
        errors,
        commit_ack=False,
    )
    owned = bytearray(KEY)
    monkeypatch.setattr(
        worker_module,
        "read_systemd_credential",
        lambda _policy: owned,
    )
    connection = FakeConnection(success_response())
    calls = 0

    def connector(*_args: object) -> FakeConnection:
        nonlocal calls
        calls += 1
        return connection

    with pytest.raises(WorkerFailure, match="BROKER_ACK_AMBIGUOUS"):
        run_one_shot(
            worker,
            expected,
            resolver=lambda _host, _port: ["1.1.1.1"],
            connector=connector,
        )
    thread.join(timeout=5)

    assert errors == []
    assert calls == 1
    assert [event["operation"] for event in events] == [
        "mark-attempted",
        "commit-result",
    ]
    assert owned == bytearray(len(KEY))
    connection.sent[:] = b"\0" * len(connection.sent)


@pytest.mark.skipif(sys.platform != "linux", reason="Linux relay and memfd boundary")
def test_chunked_empty_transcript_is_a_bounded_typed_success(tmp_path: Path) -> None:
    expected = policy(tmp_path)
    write_credential(expected.credential_path)
    body = success_response(transcript="").split(b"\r\n\r\n", 1)[1]
    response = (
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
        + f"{len(body):x}\r\n".encode()
        + body
        + b"\r\n0\r\n\r\n"
    )
    broker, worker = socket.socketpair(
        socket.AF_UNIX,
        socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC,
    )
    events: list[dict[str, object]] = []
    errors: list[BaseException] = []
    thread = broker_thread(broker, create_audio_memfd(), events, errors)
    connection = FakeConnection(response)

    result = run_one_shot(
        worker,
        expected,
        resolver=lambda _host, _port: ["1.1.1.1"],
        connector=lambda *_args: connection,
    )
    thread.join(timeout=5)
    broker.close()

    assert errors == []
    assert result == {
        "ok": True,
        "transcript": "",
        "durationMs": 1250,
        "language": "en-US",
    }
    connection.sent[:] = b"\0" * len(connection.sent)


@pytest.mark.skipif(sys.platform != "linux", reason="Linux relay and memfd boundary")
def test_foreign_broker_peer_is_refused_before_claim_read(tmp_path: Path) -> None:
    expected = policy(tmp_path)
    foreign = WorkerPolicy(
        expected.expected_broker_pid + 1,
        expected.expected_broker_uid,
        expected.installation_hash,
        expected.credential_handle,
        expected.credential_path,
        expected.credential_owner_uid,
        expected.credential_owner_gid,
        expected.timeout_seconds,
    )
    broker, worker = socket.socketpair(
        socket.AF_UNIX,
        socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC,
    )
    try:
        with pytest.raises(WorkerFailure, match="BROKER_PEER_REFUSED"):
            run_one_shot(worker, foreign)
    finally:
        worker.close()
        broker.close()
