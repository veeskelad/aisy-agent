from __future__ import annotations

import hashlib
import json
import os
import socket
import sqlite3
import threading
from pathlib import Path

import pytest

from aisy_sidecars.provider_broker_protocol import (
    FRAME_ATTEMPTED,
    FRAME_ATTEMPTED_ACK,
    FRAME_DATA,
    FRAME_END,
    FRAME_ERROR,
    FRAME_HEADER,
    encode_frame,
    response_header,
)
from aisy_sidecars.provider_broker_service import (
    ProviderBrokerFailure,
    ProviderBrokerPolicy,
    handle_connection,
    open_journal,
)
from aisy_sidecars.provider_worker import receive_frame

BODY = b'{"model":"gpt-test"}'
REQUEST_ID = "request_" + "a" * 32


def policy(tmp_path: Path) -> ProviderBrokerPolicy:
    return ProviderBrokerPolicy(
        expected_uid=os.getuid(),
        expected_pid=os.getpid(),
        expected_start_ticks=1,
        expected_cgroup="/system.slice/aisy.service",
        worker_socket_root=tmp_path / "workers",
        database_path=tmp_path / "journal.sqlite",
    )


def request_header(request_id: str = REQUEST_ID) -> bytes:
    return json.dumps(
        {
            "schemaVersion": 1,
            "requestId": request_id,
            "descriptorId": "openai.chat-completions.v1",
            "method": "POST",
            "contentType": "application/json",
            "bodyLength": len(BODY),
            "bodySha256": hashlib.sha256(BODY).hexdigest(),
            "deadlineMs": 5_000,
            "headers": {},
        },
        separators=(",", ":"),
    ).encode()


def send_request(connection: socket.socket, request_id: str = REQUEST_ID) -> None:
    connection.sendall(encode_frame(FRAME_HEADER, request_header(request_id)))
    connection.sendall(encode_frame(FRAME_DATA, BODY))
    connection.sendall(encode_frame(FRAME_END))


def test_relay_persists_attempt_before_ack_and_streams_terminal_response(tmp_path: Path) -> None:
    client_peer, broker_client = socket.socketpair()
    broker_worker, worker_peer = socket.socketpair()
    journal = open_journal(policy(tmp_path).database_path)
    worker_events: list[str] = []
    client_frames: list[tuple[bytes, bytes]] = []

    def client_side() -> None:
        send_request(client_peer)
        while True:
            item = receive_frame(client_peer)
            client_frames.append(item)
            if item[0] == FRAME_END:
                return

    def worker_side() -> None:
        assert receive_frame(worker_peer)[0] == FRAME_HEADER
        assert receive_frame(worker_peer) == (FRAME_DATA, BODY)
        assert receive_frame(worker_peer) == (FRAME_END, b"")
        worker_peer.sendall(encode_frame(FRAME_ATTEMPTED))
        assert receive_frame(worker_peer) == (FRAME_ATTEMPTED_ACK, b"")
        observer = sqlite3.connect(policy(tmp_path).database_path)
        try:
            phase = observer.execute(
                "SELECT phase FROM provider_attempts WHERE request_id=?", (REQUEST_ID,)
            ).fetchone()
            worker_events.append(phase[0])
        finally:
            observer.close()
        worker_peer.sendall(response_header(200, "application/json"))
        worker_peer.sendall(encode_frame(FRAME_DATA, b'{"ok":true}'))
        worker_peer.sendall(encode_frame(FRAME_END))

    client_thread = threading.Thread(target=client_side)
    worker_thread = threading.Thread(target=worker_side)
    client_thread.start()
    worker_thread.start()
    handle_connection(
        broker_client,
        policy(tmp_path),
        journal,
        attest=lambda _client, _policy: None,
        connect_worker=lambda path: (
            broker_worker
            if path == tmp_path / "workers" / "worker-openai.sock"
            else (_ for _ in ()).throw(AssertionError(path))
        ),
        authorize_provider=lambda provider_id: (
            (7, "c" * 64)
            if provider_id == "openai"
            else (_ for _ in ()).throw(AssertionError(provider_id))
        ),
    )
    client_thread.join(timeout=5)
    worker_thread.join(timeout=5)

    assert worker_events == ["attempted"]
    assert [kind for kind, _payload in client_frames] == [FRAME_ATTEMPTED, FRAME_HEADER, FRAME_DATA, FRAME_END]
    assert journal.execute(
        "SELECT credential_revision, release_digest, phase FROM provider_attempts WHERE request_id=?",
        (REQUEST_ID,),
    ).fetchone() == (7, "c" * 64, "terminal")
    journal.close()
    client_peer.close()
    broker_client.close()
    worker_peer.close()


def test_replay_is_refused_before_worker_connection(tmp_path: Path) -> None:
    journal = open_journal(policy(tmp_path).database_path)
    journal.execute(
        "INSERT INTO provider_attempts VALUES (?, ?, ?, 1, ?, 'terminal', 1, 1)",
        (REQUEST_ID, "openai.chat-completions.v1", hashlib.sha256(BODY).hexdigest(), "c" * 64),
    )
    client_peer, broker_client = socket.socketpair()
    send_request(client_peer)
    with pytest.raises(ProviderBrokerFailure, match="REQUEST_REPLAY_REFUSED"):
        handle_connection(
            broker_client,
            policy(tmp_path),
            journal,
            attest=lambda _client, _policy: None,
            connect_worker=lambda _path: (_ for _ in ()).throw(AssertionError("worker")),
        )
    kind, payload = receive_frame(client_peer)
    assert kind == b"X"
    assert json.loads(payload)["attempted"] is False
    journal.close()
    client_peer.close()
    broker_client.close()


def test_restart_marks_inflight_attempt_ambiguous_without_replay(tmp_path: Path) -> None:
    database = policy(tmp_path).database_path
    journal = open_journal(database)
    journal.execute(
        "INSERT INTO provider_attempts VALUES (?, ?, ?, 1, ?, 'attempted', 1, 1)",
        (REQUEST_ID, "openai.chat-completions.v1", hashlib.sha256(BODY).hexdigest(), "c" * 64),
    )
    journal.close()
    recovered = open_journal(database)
    assert recovered.execute(
        "SELECT phase FROM provider_attempts WHERE request_id=?", (REQUEST_ID,)
    ).fetchone() == ("ambiguous",)
    recovered.close()


def test_journal_rejects_symlink_and_open_directory(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir(mode=0o700)
    linked = tmp_path / "linked"
    linked.symlink_to(real, target_is_directory=True)
    with pytest.raises(ProviderBrokerFailure, match="JOURNAL_PATH_REFUSED"):
        open_journal(linked / "attempts.sqlite")

    real.chmod(0o755)
    with pytest.raises(ProviderBrokerFailure, match="JOURNAL_PATH_REFUSED"):
        open_journal(real / "attempts.sqlite")


def test_journal_migrates_terminal_v1_attempts_without_losing_ambiguity_evidence(
    tmp_path: Path,
) -> None:
    root = tmp_path / "legacy"
    root.mkdir(mode=0o700)
    database = root / "attempts.sqlite"
    legacy = sqlite3.connect(database)
    legacy.execute(
        "CREATE TABLE provider_attempts (request_id TEXT PRIMARY KEY, descriptor_id TEXT NOT NULL, "
        "body_sha256 TEXT NOT NULL, phase TEXT NOT NULL, created_ns INTEGER NOT NULL, "
        "updated_ns INTEGER NOT NULL) STRICT"
    )
    legacy.execute(
        "INSERT INTO provider_attempts VALUES (?, ?, ?, 'attempted', 1, 1)",
        (REQUEST_ID, "openai.chat-completions.v1", hashlib.sha256(BODY).hexdigest()),
    )
    legacy.commit()
    legacy.close()
    database.chmod(0o600)

    migrated = open_journal(database)

    assert {row[1] for row in migrated.execute("PRAGMA table_info(provider_attempts)")} >= {
        "credential_revision",
        "release_digest",
    }
    assert migrated.execute(
        "SELECT phase, credential_revision, release_digest FROM provider_attempts WHERE request_id=?",
        (REQUEST_ID,),
    ).fetchone() == ("ambiguous", 0, "")
    migrated.close()


def test_worker_cannot_project_unbounded_error_detail(tmp_path: Path) -> None:
    client_peer, broker_client = socket.socketpair()
    broker_worker, worker_peer = socket.socketpair()
    journal = open_journal(policy(tmp_path).database_path)
    send_request(client_peer)

    def worker_side() -> None:
        assert receive_frame(worker_peer)[0] == FRAME_HEADER
        assert receive_frame(worker_peer)[0] == FRAME_DATA
        assert receive_frame(worker_peer)[0] == FRAME_END
        worker_peer.sendall(encode_frame(FRAME_ERROR, b'{"schemaVersion":1,"code":"raw detail","attempted":false}'))

    worker_thread = threading.Thread(target=worker_side)
    worker_thread.start()
    with pytest.raises(ProviderBrokerFailure, match="WORKER_FRAME_REFUSED"):
        handle_connection(
            broker_client,
            policy(tmp_path),
            journal,
            attest=lambda _client, _policy: None,
            connect_worker=lambda _path: broker_worker,
        )
    worker_thread.join(timeout=5)
    kind, payload = receive_frame(client_peer)
    assert kind == FRAME_ERROR
    assert json.loads(payload)["code"] == "WORKER_FRAME_REFUSED"
    journal.close()
    client_peer.close()
    broker_client.close()
    worker_peer.close()
