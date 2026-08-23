"""Root relay for exact native API requests and one-shot systemd workers."""

from __future__ import annotations

import hashlib
import os
import re
import socket
import sqlite3
import stat
import struct
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .provider_broker_protocol import (
    FRAME_ATTEMPTED,
    FRAME_ATTEMPTED_ACK,
    FRAME_DATA,
    FRAME_END,
    FRAME_ERROR,
    FRAME_HEADER,
    MAX_REQUEST_BYTES,
    ProviderProtocolFailure,
    ProviderRequest,
    decode_json,
    decode_request_header,
    encode_frame,
    error_frame,
)
from .provider_worker import ProviderWorkerFailure, receive_frame

_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")


class ProviderBrokerFailure(Exception):
    def __init__(self, code: str, *, attempted: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.attempted = attempted


@dataclass(frozen=True)
class ProviderBrokerPolicy:
    expected_uid: int
    expected_pid: int
    expected_start_ticks: int
    expected_cgroup: str
    worker_socket_root: Path
    database_path: Path

    def validate(self) -> None:
        if (
            isinstance(self.expected_uid, bool)
            or not isinstance(self.expected_uid, int)
            or self.expected_uid < 0
            or isinstance(self.expected_pid, bool)
            or not isinstance(self.expected_pid, int)
            or self.expected_pid < 1
            or isinstance(self.expected_start_ticks, bool)
            or not isinstance(self.expected_start_ticks, int)
            or self.expected_start_ticks < 1
            or not isinstance(self.expected_cgroup, str)
            or not self.expected_cgroup.startswith("/")
            or not isinstance(self.worker_socket_root, Path)
            or not self.worker_socket_root.is_absolute()
            or not isinstance(self.database_path, Path)
            or not self.database_path.is_absolute()
        ):
            raise ProviderBrokerFailure("BROKER_POLICY_REFUSED")


def _process_identity(pid: int) -> tuple[int, str]:
    try:
        stat_fields = Path(f"/proc/{pid}/stat").read_text().split()
        start_ticks = int(stat_fields[21])
        cgroup_lines = Path(f"/proc/{pid}/cgroup").read_text().splitlines()
        unified = [line.split(":", 2)[2] for line in cgroup_lines if line.startswith("0::")]
        if len(unified) != 1:
            raise ValueError
        return start_ticks, unified[0]
    except (OSError, IndexError, ValueError):
        raise ProviderBrokerFailure("CLIENT_PEER_REFUSED") from None


def attest_client(connection: socket.socket, policy: ProviderBrokerPolicy) -> None:
    policy.validate()
    try:
        if not hasattr(socket, "SO_PEERCRED"):
            raise OSError
        raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        pid, uid, _gid = struct.unpack("3i", raw)
    except (OSError, struct.error):
        raise ProviderBrokerFailure("CLIENT_PEER_REFUSED") from None
    if pid != policy.expected_pid or uid != policy.expected_uid:
        raise ProviderBrokerFailure("CLIENT_PEER_REFUSED")
    start_ticks, cgroup = _process_identity(pid)
    if start_ticks != policy.expected_start_ticks or cgroup != policy.expected_cgroup:
        raise ProviderBrokerFailure("CLIENT_PEER_REFUSED")


def open_journal(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent = path.parent.lstat()
    if (
        not stat.S_ISDIR(parent.st_mode)
        or stat.S_ISLNK(parent.st_mode)
        or parent.st_uid != os.getuid()
        or parent.st_mode & 0o077
        or path.parent.resolve(strict=True) != path.parent.absolute()
    ):
        raise ProviderBrokerFailure("JOURNAL_PATH_REFUSED")
    if path.exists() or path.is_symlink():
        before = path.lstat()
        if (
            not stat.S_ISREG(before.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or before.st_uid != os.getuid()
            or before.st_nlink != 1
            or stat.S_IMODE(before.st_mode) != 0o600
            or path.resolve(strict=True) != path.absolute()
        ):
            raise ProviderBrokerFailure("JOURNAL_PATH_REFUSED")
    connection = sqlite3.connect(path, isolation_level=None, timeout=5)
    os.chmod(path, 0o600)
    opened = path.lstat()
    if not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.getuid() or opened.st_nlink != 1:
        connection.close()
        raise ProviderBrokerFailure("JOURNAL_PATH_REFUSED")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS provider_attempts (
          request_id TEXT PRIMARY KEY,
          descriptor_id TEXT NOT NULL,
          body_sha256 TEXT NOT NULL,
          credential_revision INTEGER NOT NULL,
          release_digest TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('prepared','attempted','terminal','ambiguous')),
          created_ns INTEGER NOT NULL,
          updated_ns INTEGER NOT NULL
        ) STRICT
        """
    )
    columns = {row[1] for row in connection.execute("PRAGMA table_info(provider_attempts)")}
    lifecycle_columns = {"credential_revision", "release_digest"}
    if not lifecycle_columns.issubset(columns):
        if columns & lifecycle_columns:
            connection.close()
            raise ProviderBrokerFailure("JOURNAL_SCHEMA_REFUSED")
        connection.execute(
            "ALTER TABLE provider_attempts ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0"
        )
        connection.execute(
            "ALTER TABLE provider_attempts ADD COLUMN release_digest TEXT NOT NULL DEFAULT ''"
        )
    connection.execute(
        "UPDATE provider_attempts SET phase='terminal', updated_ns=? WHERE phase='prepared'",
        (time.time_ns(),),
    )
    connection.execute(
        "UPDATE provider_attempts SET phase='ambiguous', updated_ns=? WHERE phase='attempted'",
        (time.time_ns(),),
    )
    return connection


def _transition(
    journal: sqlite3.Connection,
    request_id: str,
    expected: str,
    target: str,
) -> None:
    journal.execute("BEGIN IMMEDIATE")
    try:
        changed = journal.execute(
            "UPDATE provider_attempts SET phase=?, updated_ns=? WHERE request_id=? AND phase=?",
            (target, time.time_ns(), request_id, expected),
        ).rowcount
        if changed != 1:
            raise ProviderBrokerFailure("ATTEMPT_STATE_REFUSED", attempted=expected == "attempted")
        journal.execute("COMMIT")
    except BaseException:
        journal.execute("ROLLBACK")
        raise


def _prepare(
    journal: sqlite3.Connection,
    request: ProviderRequest,
    credential_revision: int,
    release_digest: str,
) -> None:
    now = time.time_ns()
    try:
        journal.execute(
            "INSERT INTO provider_attempts "
            "(request_id, descriptor_id, body_sha256, credential_revision, release_digest, "
            "phase, created_ns, updated_ns) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)",
            (
                request.request_id,
                request.descriptor.descriptor_id,
                request.body_sha256,
                credential_revision,
                release_digest,
                now,
                now,
            ),
        )
    except sqlite3.IntegrityError:
        raise ProviderBrokerFailure("REQUEST_REPLAY_REFUSED") from None


WorkerConnector = Callable[[Path], socket.socket]
ClientAttestor = Callable[[socket.socket, ProviderBrokerPolicy], None]
ProviderAuthorizer = Callable[[str], tuple[int, str]]


def _allow_provider(_provider_id: str) -> tuple[int, str]:
    return 0, ""


def _connect_worker(path: Path) -> socket.socket:
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM | getattr(socket, "SOCK_CLOEXEC", 0))
    try:
        connection.connect(os.fspath(path))
        return connection
    except BaseException:
        connection.close()
        raise


def _receive_client_request(
    client: socket.socket,
) -> tuple[ProviderRequest, bytes, tuple[bytes, ...]]:
    try:
        kind, header = receive_frame(client)
    except ProviderWorkerFailure as error:
        raise ProviderBrokerFailure(str(error)) from None
    if kind != FRAME_HEADER:
        raise ProviderBrokerFailure("MALFORMED_FRAME")
    try:
        request = decode_request_header(header)
    except ProviderProtocolFailure as error:
        raise ProviderBrokerFailure(str(error)) from None
    chunks: list[bytes] = []
    digest = hashlib.sha256()
    total = 0
    while True:
        try:
            kind, payload = receive_frame(client)
        except ProviderWorkerFailure as error:
            raise ProviderBrokerFailure(str(error)) from None
        if kind == FRAME_END:
            if payload:
                raise ProviderBrokerFailure("MALFORMED_FRAME")
            break
        if kind != FRAME_DATA or not payload:
            raise ProviderBrokerFailure("MALFORMED_FRAME")
        total += len(payload)
        if total > MAX_REQUEST_BYTES:
            raise ProviderBrokerFailure("REQUEST_BOUNDS")
        digest.update(payload)
        chunks.append(payload)
    if total != request.body_length or digest.hexdigest() != request.body_sha256:
        raise ProviderBrokerFailure("REQUEST_DIGEST_REFUSED")
    return request, header, tuple(chunks)


def _worker_failure(payload: bytes) -> ProviderBrokerFailure:
    try:
        value = decode_json(payload)
    except ProviderProtocolFailure:
        return ProviderBrokerFailure("WORKER_FRAME_REFUSED")
    if (
        set(value) != {"schemaVersion", "code", "attempted"}
        or value["schemaVersion"] != 1
        or not isinstance(value["code"], str)
        or _ERROR_CODE.fullmatch(value["code"]) is None
        or not isinstance(value["attempted"], bool)
    ):
        return ProviderBrokerFailure("WORKER_FRAME_REFUSED")
    return ProviderBrokerFailure(value["code"], attempted=value["attempted"])


def handle_connection(
    client: socket.socket,
    policy: ProviderBrokerPolicy,
    journal: sqlite3.Connection,
    *,
    attest: ClientAttestor = attest_client,
    connect_worker: WorkerConnector = _connect_worker,
    authorize_provider: ProviderAuthorizer = _allow_provider,
) -> None:
    worker: socket.socket | None = None
    request: ProviderRequest | None = None
    phase = "none"
    try:
        attest(client, policy)
        request, raw_header, chunks = _receive_client_request(client)
        credential_revision, release_digest = authorize_provider(request.descriptor.provider_id)
        _prepare(journal, request, credential_revision, release_digest)
        phase = "prepared"
        worker_path = policy.worker_socket_root / f"worker-{request.descriptor.provider_id}.sock"
        worker = connect_worker(worker_path)
        worker.sendall(encode_frame(FRAME_HEADER, raw_header))
        for chunk in chunks:
            worker.sendall(encode_frame(FRAME_DATA, chunk))
        worker.sendall(encode_frame(FRAME_END))

        while True:
            try:
                kind, payload = receive_frame(worker)
            except ProviderWorkerFailure as error:
                raise ProviderBrokerFailure(str(error), attempted=phase == "attempted") from None
            if kind == FRAME_ATTEMPTED and not payload and phase == "prepared":
                _transition(journal, request.request_id, "prepared", "attempted")
                phase = "attempted"
                client.sendall(encode_frame(FRAME_ATTEMPTED))
                worker.sendall(encode_frame(FRAME_ATTEMPTED_ACK))
                continue
            if kind == FRAME_ERROR:
                raise _worker_failure(payload)
            if kind == FRAME_HEADER and phase == "attempted":
                client.sendall(encode_frame(kind, payload))
                continue
            if kind == FRAME_DATA and phase == "attempted" and payload:
                client.sendall(encode_frame(kind, payload))
                continue
            if kind == FRAME_END and phase == "attempted" and not payload:
                client.sendall(encode_frame(FRAME_END))
                _transition(journal, request.request_id, "attempted", "terminal")
                phase = "terminal"
                return
            raise ProviderBrokerFailure("WORKER_FRAME_REFUSED", attempted=phase == "attempted")
    except ProviderBrokerFailure as error:
        if request is not None and phase == "prepared":
            _transition(journal, request.request_id, "prepared", "terminal")
            phase = "terminal"
        elif request is not None and phase == "attempted":
            _transition(journal, request.request_id, "attempted", "ambiguous")
            phase = "ambiguous"
        try:
            client.sendall(error_frame(error.code, attempted=error.attempted or phase == "ambiguous"))
        except (OSError, ProviderProtocolFailure):
            pass
        raise
    except (OSError, sqlite3.Error):
        if request is not None and phase == "prepared":
            _transition(journal, request.request_id, "prepared", "terminal")
        elif request is not None and phase == "attempted":
            _transition(journal, request.request_id, "attempted", "ambiguous")
        raise ProviderBrokerFailure("BROKER_IO_REFUSED", attempted=phase == "attempted") from None
    finally:
        if worker is not None:
            worker.close()
