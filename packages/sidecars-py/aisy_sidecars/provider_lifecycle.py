"""Durable enrollment, rotation, and revoke lifecycle for provider material."""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import re
import resource
import secrets
import select
import signal
import socket
import sqlite3
import stat
import struct
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .provider_broker_protocol import (
    DESCRIPTOR_BY_PROVIDER,
    FRAME_DATA,
    FRAME_END,
    FRAME_ERROR,
    FRAME_HEADER,
    ProviderProtocolFailure,
    decode_json,
    encode_frame,
    encode_json_frame,
    error_frame,
)
from .provider_validation_worker import MAX_MATERIAL_BYTES
from .provider_worker import ProviderWorkerFailure, receive_frame

CHALLENGE_TTL_NS = 10 * 60 * 1_000_000_000
MAX_ID_BYTES = 256
MAX_CHILD_ERROR_BYTES = 4096
MAX_CIPHERTEXT_BYTES = 64 * 1024
SYSTEMD_CREDS = Path("/usr/bin/systemd-creds")
_APPROVAL = re.compile(r"^[A-Za-z0-9_-]{20,160}$")
_CODE = re.compile(r"^[A-Za-z0-9_-]{24,96}$")
_HASH = re.compile(r"^[a-f0-9]{64}$")


class ProviderLifecycleFailure(Exception):
    """Stable lifecycle refusal with no material or vendor detail."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ProviderBinding:
    operator_id: str
    profile_id: str
    provider_id: str

    def validate(self) -> None:
        for value in (self.operator_id, self.profile_id):
            if (
                not isinstance(value, str)
                or not value
                or len(value.encode("utf-8")) > MAX_ID_BYTES
                or any(ord(character) < 0x20 for character in value)
            ):
                raise ProviderLifecycleFailure("BINDING_REFUSED")
        if self.provider_id not in DESCRIPTOR_BY_PROVIDER:
            raise ProviderLifecycleFailure("BINDING_REFUSED")


@dataclass(frozen=True)
class ProviderLifecyclePolicy:
    installation_hash: str
    release_digest: str
    state_root: Path
    validator_socket_root: Path
    expected_owner: int = 0
    configured_providers: tuple[str, ...] = tuple(sorted(DESCRIPTOR_BY_PROVIDER))

    def validate(self) -> None:
        if (
            _HASH.fullmatch(self.installation_hash) is None
            or _HASH.fullmatch(self.release_digest) is None
            or not self.state_root.is_absolute()
            or not self.validator_socket_root.is_absolute()
            or isinstance(self.expected_owner, bool)
            or not isinstance(self.expected_owner, int)
            or self.expected_owner < 0
            or not self.configured_providers
            or self.configured_providers != tuple(sorted(self.configured_providers))
            or len(set(self.configured_providers)) != len(self.configured_providers)
            or any(provider not in DESCRIPTOR_BY_PROVIDER for provider in self.configured_providers)
        ):
            raise ProviderLifecycleFailure("LIFECYCLE_POLICY_REFUSED")


@dataclass(frozen=True)
class ClaimedChallenge:
    challenge_hash: str
    operator_hash: str
    profile_hash: str
    provider_id: str


Encryptor = Callable[[bytearray, Path, int], str]
ValidatorConnector = Callable[[Path], socket.socket]
ControlAttestor = Callable[[socket.socket, str], None]


def _zero(value: bytearray) -> None:
    value[:] = b"\0" * len(value)


def _domain_hash(domain: bytes, *values: str) -> str:
    digest = hashlib.sha256(domain + b"\0")
    for value in values:
        encoded = value.encode("utf-8")
        digest.update(struct.pack(">I", len(encoded)))
        digest.update(encoded)
    return digest.hexdigest()


def _binding_hashes(policy: ProviderLifecyclePolicy, binding: ProviderBinding) -> tuple[str, str]:
    binding.validate()
    if binding.provider_id not in policy.configured_providers:
        raise ProviderLifecycleFailure("BINDING_REFUSED")
    return (
        _domain_hash(b"aisy.provider.operator.v1", policy.installation_hash, binding.operator_id),
        _domain_hash(b"aisy.provider.profile.v1", policy.installation_hash, binding.profile_id),
    )


def _challenge_hash(code: str) -> str:
    if _CODE.fullmatch(code) is None:
        raise ProviderLifecycleFailure("CHALLENGE_REFUSED")
    return _domain_hash(b"aisy.provider.challenge.v1", code)


def initialize_lifecycle(journal: sqlite3.Connection) -> None:
    journal.execute(
        """
        CREATE TABLE IF NOT EXISTS provider_challenges (
          challenge_hash TEXT PRIMARY KEY,
          installation_hash TEXT NOT NULL,
          operator_hash TEXT NOT NULL,
          profile_hash TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('issued','claimed','terminal','superseded','expired')),
          created_ns INTEGER NOT NULL,
          expires_ns INTEGER NOT NULL,
          updated_ns INTEGER NOT NULL
        ) STRICT
        """
    )
    journal.execute(
        """
        CREATE TABLE IF NOT EXISTS provider_lifecycle (
          provider_id TEXT PRIMARY KEY,
          installation_hash TEXT NOT NULL,
          operator_hash TEXT NOT NULL,
          profile_hash TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('unconfigured','committing','ready','revoking','unavailable')),
          credential_revision INTEGER NOT NULL,
          active_slot TEXT CHECK(active_slot IN ('a','b') OR active_slot IS NULL),
          slot_a_hash TEXT,
          slot_b_hash TEXT,
          pending_slot TEXT CHECK(pending_slot IN ('a','b') OR pending_slot IS NULL),
          pending_hash TEXT,
          pending_revision INTEGER,
          release_digest TEXT NOT NULL,
          updated_ns INTEGER NOT NULL
        ) STRICT
        """
    )
    now = time.time_ns()
    journal.execute(
        "UPDATE provider_challenges SET phase='expired', updated_ns=? "
        "WHERE phase='issued' AND expires_ns<=?",
        (now, now),
    )
    journal.execute(
        "UPDATE provider_challenges SET phase='terminal', updated_ns=? WHERE phase='claimed'",
        (now,),
    )


def begin_challenge(
    journal: sqlite3.Connection,
    policy: ProviderLifecyclePolicy,
    binding: ProviderBinding,
    *,
    now_ns: int | None = None,
) -> tuple[str, int]:
    policy.validate()
    operator_hash, profile_hash = _binding_hashes(policy, binding)
    now = time.time_ns() if now_ns is None else now_ns
    expires = now + CHALLENGE_TTL_NS
    code = secrets.token_urlsafe(24)
    digest = _challenge_hash(code)
    journal.execute("BEGIN IMMEDIATE")
    try:
        active = journal.execute(
            "SELECT operator_hash, profile_hash, phase FROM provider_lifecycle WHERE provider_id=?",
            (binding.provider_id,),
        ).fetchone()
        if active is not None and active[2] != "unconfigured" and active[:2] != (
            operator_hash,
            profile_hash,
        ):
            raise ProviderLifecycleFailure("FOREIGN_BINDING_REFUSED")
        journal.execute(
            "UPDATE provider_challenges SET phase='superseded', updated_ns=? "
            "WHERE installation_hash=? AND provider_id=? AND phase='issued'",
            (now, policy.installation_hash, binding.provider_id),
        )
        journal.execute(
            "INSERT INTO provider_challenges VALUES (?, ?, ?, ?, ?, 'issued', ?, ?, ?)",
            (
                digest,
                policy.installation_hash,
                operator_hash,
                profile_hash,
                binding.provider_id,
                now,
                expires,
                now,
            ),
        )
        journal.execute("COMMIT")
    except BaseException:
        journal.execute("ROLLBACK")
        raise
    return code, expires


def claim_challenge(
    journal: sqlite3.Connection,
    policy: ProviderLifecyclePolicy,
    code: str,
    *,
    now_ns: int | None = None,
) -> ClaimedChallenge:
    policy.validate()
    digest = _challenge_hash(code)
    now = time.time_ns() if now_ns is None else now_ns
    journal.execute("BEGIN IMMEDIATE")
    try:
        row = journal.execute(
            "SELECT installation_hash, operator_hash, profile_hash, provider_id, phase, expires_ns "
            "FROM provider_challenges WHERE challenge_hash=?",
            (digest,),
        ).fetchone()
        if row is None or row[0] != policy.installation_hash:
            raise ProviderLifecycleFailure("CHALLENGE_REFUSED")
        if row[4] != "issued":
            raise ProviderLifecycleFailure("CHALLENGE_REPLAY_REFUSED")
        if row[5] <= now:
            journal.execute(
                "UPDATE provider_challenges SET phase='expired', updated_ns=? WHERE challenge_hash=?",
                (now, digest),
            )
            journal.execute("COMMIT")
            raise ProviderLifecycleFailure("CHALLENGE_EXPIRED")
        changed = journal.execute(
            "UPDATE provider_challenges SET phase='claimed', updated_ns=? "
            "WHERE challenge_hash=? AND phase='issued'",
            (now, digest),
        ).rowcount
        if changed != 1:
            raise ProviderLifecycleFailure("CHALLENGE_REPLAY_REFUSED")
        journal.execute("COMMIT")
        return ClaimedChallenge(digest, row[1], row[2], row[3])
    except ProviderLifecycleFailure:
        if journal.in_transaction:
            journal.execute("ROLLBACK")
        raise
    except BaseException:
        if journal.in_transaction:
            journal.execute("ROLLBACK")
        raise


def _terminal_challenge(journal: sqlite3.Connection, digest: str) -> None:
    journal.execute(
        "UPDATE provider_challenges SET phase='terminal', updated_ns=? "
        "WHERE challenge_hash=? AND phase='claimed'",
        (time.time_ns(), digest),
    )


def _read_exact_into(connection: socket.socket, target: memoryview) -> None:
    offset = 0
    while offset < len(target):
        read = connection.recv_into(target[offset:])
        if read <= 0:
            raise ProviderLifecycleFailure("MATERIAL_FRAME_REFUSED")
        offset += read


def receive_claimed_material(connection: socket.socket, length: int, expected_hash: str) -> bytearray:
    if (
        isinstance(length, bool)
        or not isinstance(length, int)
        or not 1 <= length <= MAX_MATERIAL_BYTES
        or _HASH.fullmatch(expected_hash) is None
    ):
        raise ProviderLifecycleFailure("MATERIAL_FRAME_REFUSED")
    material = bytearray(length)
    offset = 0
    header = bytearray(5)
    try:
        while True:
            _read_exact_into(connection, memoryview(header))
            size = struct.unpack(">I", header[:4])[0]
            kind = bytes(header[4:5])
            if size < 1 or size > MAX_MATERIAL_BYTES + 1:
                raise ProviderLifecycleFailure("MATERIAL_FRAME_REFUSED")
            payload_size = size - 1
            if kind == FRAME_END and payload_size == 0:
                break
            if kind != FRAME_DATA or payload_size < 1 or offset + payload_size > length:
                raise ProviderLifecycleFailure("MATERIAL_FRAME_REFUSED")
            _read_exact_into(connection, memoryview(material)[offset : offset + payload_size])
            offset += payload_size
        if (
            offset != length
            or hashlib.sha256(material).hexdigest() != expected_hash
            or any(value <= 0x20 or value >= 0x7F for value in material)
        ):
            raise ProviderLifecycleFailure("MATERIAL_REFUSED")
        return material
    except BaseException:
        _zero(material)
        raise
    finally:
        _zero(header)


def _connect_validator(path: Path) -> socket.socket:
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM | getattr(socket, "SOCK_CLOEXEC", 0))
    try:
        connection.connect(os.fspath(path))
        return connection
    except BaseException:
        connection.close()
        raise


def validate_material(
    provider_id: str,
    material: bytearray,
    policy: ProviderLifecyclePolicy,
    *,
    connect: ValidatorConnector = _connect_validator,
) -> None:
    if provider_id not in DESCRIPTOR_BY_PROVIDER or not 1 <= len(material) <= MAX_MATERIAL_BYTES:
        raise ProviderLifecycleFailure("MATERIAL_REFUSED")
    connection: socket.socket | None = None
    try:
        connection = connect(policy.validator_socket_root / f"validator-{provider_id}.sock")
        connection.settimeout(20)
        header = json.dumps(
            {
                "schemaVersion": 1,
                "providerId": provider_id,
                "materialLength": len(material),
                "materialSha256": hashlib.sha256(material).hexdigest(),
                "deadlineMs": 15_000,
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")
        connection.sendall(encode_frame(FRAME_HEADER, header))
        connection.sendall(struct.pack(">I", len(material) + 1) + FRAME_DATA)
        connection.sendall(memoryview(material))
        connection.sendall(encode_frame(FRAME_END))
        kind, payload = receive_frame(connection)
        if kind == FRAME_ERROR:
            try:
                value = decode_json(payload)
                code = value.get("code")
            except ProviderProtocolFailure:
                code = None
            if not isinstance(code, str) or re.fullmatch(r"[A-Z][A-Z0-9_]{2,63}", code) is None:
                code = "VALIDATION_REFUSED"
            raise ProviderLifecycleFailure(code)
        if kind != FRAME_HEADER:
            raise ProviderLifecycleFailure("VALIDATION_REFUSED")
        value = decode_json(payload)
        if value != {"schemaVersion": 1, "state": "valid"}:
            raise ProviderLifecycleFailure("VALIDATION_REFUSED")
        if receive_frame(connection) != (FRAME_END, b""):
            raise ProviderLifecycleFailure("VALIDATION_REFUSED")
    except ProviderLifecycleFailure:
        raise
    except (OSError, ProviderWorkerFailure, ProviderProtocolFailure):
        raise ProviderLifecycleFailure("VALIDATION_REFUSED") from None
    finally:
        if connection is not None:
            connection.close()


def _child_security() -> None:
    os.setsid()
    os.chdir("/")
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:
        os._exit(126)


def encrypt_host_material(material: bytearray, target: Path, expected_owner: int = 0) -> str:
    if (
        not target.is_absolute()
        or target.parent.resolve(strict=True) != target.parent.absolute()
        or not 1 <= len(material) <= MAX_MATERIAL_BYTES
    ):
        raise ProviderLifecycleFailure("ENCRYPTION_REFUSED")
    temporary = target.parent / f".{target.name}.tmp-{os.getpid()}-{secrets.token_hex(8)}"
    input_read = input_write = error_read = error_write = output_fd = -1
    pid = -1
    child_error = bytearray()
    try:
        input_read, input_write = os.pipe2(os.O_CLOEXEC)
        error_read, error_write = os.pipe2(os.O_CLOEXEC)
        output_fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
        )
        pid = os.fork()
        if pid == 0:
            try:
                _child_security()
                os.dup2(input_read, 0)
                os.dup2(output_fd, 1)
                os.dup2(error_write, 2)
                maximum = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
                os.closerange(3, min(int(maximum), 1_048_576))
                os.execve(
                    str(SYSTEMD_CREDS),
                    [
                        "systemd-creds",
                        "encrypt",
                        "--with-key=host",
                        "--name=aisy-provider",
                        "-",
                        "-",
                    ],
                    {"PATH": "/usr/bin", "LANG": "C"},
                )
            except (AttributeError, OSError, OverflowError, ValueError):
                os._exit(126)
        os.close(input_read)
        input_read = -1
        os.close(error_write)
        error_write = -1
        os.close(output_fd)
        output_fd = -1
        written = 0
        while written < len(material):
            count = os.write(input_write, memoryview(material)[written:])
            if count <= 0:
                raise OSError
            written += count
        os.close(input_write)
        input_write = -1

        deadline = time.monotonic() + 15
        status: int | None = None
        os.set_blocking(error_read, False)
        while status is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except OSError:
                    pass
                os.waitpid(pid, 0)
                pid = -1
                raise ProviderLifecycleFailure("ENCRYPTION_TIMEOUT")
            ready, _write, _error = select.select([error_read], [], [], min(0.05, remaining))
            if ready and len(child_error) <= MAX_CHILD_ERROR_BYTES:
                chunk = os.read(error_read, MAX_CHILD_ERROR_BYTES + 1 - len(child_error))
                child_error.extend(chunk)
            waited, raw_status = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                pid = -1
                status = raw_status
        if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
            raise ProviderLifecycleFailure("ENCRYPTION_REFUSED")
        info = temporary.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != expected_owner
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600
            or not 1 <= info.st_size <= MAX_CIPHERTEXT_BYTES
        ):
            raise ProviderLifecycleFailure("CIPHERTEXT_REFUSED")
        descriptor = os.open(temporary, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, target)
        _fsync_directory(target.parent)
        digest = _attest_ciphertext(target, expected_owner)
        return digest
    except ProviderLifecycleFailure:
        raise
    except OSError:
        raise ProviderLifecycleFailure("ENCRYPTION_REFUSED") from None
    finally:
        if pid > 0:
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                os.waitpid(pid, 0)
            except OSError:
                pass
        for descriptor in (input_read, input_write, error_read, error_write, output_fd):
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
        _zero(child_error)
        try:
            temporary.unlink()
        except OSError:
            pass


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _attest_ciphertext(path: Path, expected_owner: int) -> str:
    try:
        info = path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != expected_owner
            or stat.S_IMODE(info.st_mode) != 0o600
            or not 1 <= info.st_size <= MAX_CIPHERTEXT_BYTES
            or path.resolve(strict=True) != path.absolute()
        ):
            raise OSError
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            digest = hashlib.sha256()
            while True:
                chunk = os.read(descriptor, 8192)
                if not chunk:
                    break
                digest.update(chunk)
        finally:
            os.close(descriptor)
        return digest.hexdigest()
    except OSError:
        raise ProviderLifecycleFailure("CIPHERTEXT_REFUSED") from None


def _slot_path(policy: ProviderLifecyclePolicy, provider_id: str, slot: str) -> Path:
    return policy.state_root / f"{provider_id}.{slot}.cred"


def _active_path(policy: ProviderLifecyclePolicy, provider_id: str) -> Path:
    return policy.state_root / f"{provider_id}.active.cred"


def _publish_active(policy: ProviderLifecyclePolicy, provider_id: str, slot: str, digest: str) -> None:
    source = _slot_path(policy, provider_id, slot)
    if _attest_ciphertext(source, policy.expected_owner) != digest:
        raise ProviderLifecycleFailure("CIPHERTEXT_REFUSED")
    target = _active_path(policy, provider_id)
    temporary = policy.state_root / f".{provider_id}.active-{secrets.token_hex(8)}"
    try:
        os.link(source, temporary, follow_symlinks=False)
        os.replace(temporary, target)
        _fsync_directory(policy.state_root)
        if _attest_ciphertext(target, policy.expected_owner) != digest:
            raise ProviderLifecycleFailure("CIPHERTEXT_REFUSED")
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass


def rotate_material(
    journal: sqlite3.Connection,
    policy: ProviderLifecyclePolicy,
    claimed: ClaimedChallenge,
    material: bytearray,
    *,
    encrypt: Encryptor = encrypt_host_material,
) -> tuple[int, str]:
    policy.validate()
    row = journal.execute(
        "SELECT operator_hash, profile_hash, phase, credential_revision, active_slot, "
        "slot_a_hash, slot_b_hash FROM provider_lifecycle WHERE provider_id=?",
        (claimed.provider_id,),
    ).fetchone()
    if row is not None and row[2] != "unconfigured" and row[:2] != (
        claimed.operator_hash,
        claimed.profile_hash,
    ):
        raise ProviderLifecycleFailure("FOREIGN_BINDING_REFUSED")
    if row is not None and row[2] in {"committing", "revoking", "unavailable"}:
        raise ProviderLifecycleFailure("LIFECYCLE_BUSY")
    current_revision = 0 if row is None else row[3]
    active_slot = None if row is None else row[4]
    slot = "b" if active_slot == "a" else "a"
    revision = current_revision + 1
    target = _slot_path(policy, claimed.provider_id, slot)
    digest = encrypt(material, target, policy.expected_owner)
    if _HASH.fullmatch(digest) is None or _attest_ciphertext(target, policy.expected_owner) != digest:
        raise ProviderLifecycleFailure("CIPHERTEXT_REFUSED")
    now = time.time_ns()
    slot_a_hash = digest if slot == "a" else (None if row is None else row[5])
    slot_b_hash = digest if slot == "b" else (None if row is None else row[6])
    journal.execute("BEGIN IMMEDIATE")
    try:
        journal.execute(
            "INSERT INTO provider_lifecycle VALUES (?, ?, ?, ?, 'committing', ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(provider_id) DO UPDATE SET installation_hash=excluded.installation_hash, "
            "operator_hash=excluded.operator_hash, profile_hash=excluded.profile_hash, phase='committing', "
            "slot_a_hash=excluded.slot_a_hash, slot_b_hash=excluded.slot_b_hash, "
            "pending_slot=excluded.pending_slot, pending_hash=excluded.pending_hash, "
            "pending_revision=excluded.pending_revision, release_digest=excluded.release_digest, "
            "updated_ns=excluded.updated_ns",
            (
                claimed.provider_id,
                policy.installation_hash,
                claimed.operator_hash,
                claimed.profile_hash,
                current_revision,
                active_slot,
                slot_a_hash,
                slot_b_hash,
                slot,
                digest,
                revision,
                policy.release_digest,
                now,
            ),
        )
        journal.execute("COMMIT")
    except BaseException:
        journal.execute("ROLLBACK")
        raise
    _publish_active(policy, claimed.provider_id, slot, digest)
    journal.execute("BEGIN IMMEDIATE")
    try:
        changed = journal.execute(
            "UPDATE provider_lifecycle SET phase='ready', credential_revision=?, active_slot=?, "
            "pending_slot=NULL, pending_hash=NULL, pending_revision=NULL, updated_ns=? "
            "WHERE provider_id=? AND phase='committing' AND pending_slot=? AND pending_hash=?",
            (revision, slot, time.time_ns(), claimed.provider_id, slot, digest),
        ).rowcount
        if changed != 1:
            raise ProviderLifecycleFailure("COMMIT_STATE_REFUSED")
        _terminal_challenge(journal, claimed.challenge_hash)
        journal.execute("COMMIT")
    except BaseException:
        journal.execute("ROLLBACK")
        raise
    handle = _domain_hash(
        b"aisy.provider.handle.v1",
        policy.installation_hash,
        claimed.provider_id,
        str(revision),
        digest,
    )
    return revision, handle


def reconcile_lifecycle(journal: sqlite3.Connection, policy: ProviderLifecyclePolicy) -> None:
    policy.validate()
    initialize_lifecycle(journal)
    rows = journal.execute(
        "SELECT provider_id, installation_hash, release_digest, phase, credential_revision, "
        "active_slot, slot_a_hash, slot_b_hash, pending_slot, pending_hash, pending_revision "
        "FROM provider_lifecycle"
    ).fetchall()
    for row in rows:
        provider_id, phase = row[0], row[3]
        if provider_id not in DESCRIPTOR_BY_PROVIDER or row[1] != policy.installation_hash:
            journal.execute(
                "UPDATE provider_lifecycle SET phase='unavailable', updated_ns=? WHERE provider_id=?",
                (time.time_ns(), provider_id),
            )
            continue
        if row[2] != policy.release_digest:
            journal.execute(
                "UPDATE provider_lifecycle SET release_digest=?, updated_ns=? WHERE provider_id=?",
                (policy.release_digest, time.time_ns(), provider_id),
            )
        try:
            if phase == "committing":
                pending_slot, pending_hash, pending_revision = row[8], row[9], row[10]
                if pending_slot in {"a", "b"} and isinstance(pending_hash, str) and isinstance(
                    pending_revision, int
                ):
                    _publish_active(policy, provider_id, pending_slot, pending_hash)
                    journal.execute(
                        "UPDATE provider_lifecycle SET phase='ready', credential_revision=?, "
                        "active_slot=?, pending_slot=NULL, pending_hash=NULL, pending_revision=NULL, "
                        "updated_ns=? WHERE provider_id=?",
                        (pending_revision, pending_slot, time.time_ns(), provider_id),
                    )
                    continue
                raise ProviderLifecycleFailure("COMMIT_STATE_REFUSED")
            if phase == "ready":
                active_slot = row[5]
                active_hash = row[6] if active_slot == "a" else row[7]
                if (
                    active_slot not in {"a", "b"}
                    or not isinstance(active_hash, str)
                    or _attest_ciphertext(_active_path(policy, provider_id), policy.expected_owner)
                    != active_hash
                    or _attest_ciphertext(_slot_path(policy, provider_id, active_slot), policy.expected_owner)
                    != active_hash
                ):
                    raise ProviderLifecycleFailure("CIPHERTEXT_REFUSED")
            elif phase == "revoking":
                _delete_provider_files(policy, provider_id)
                journal.execute(
                    "UPDATE provider_lifecycle SET phase='unconfigured', active_slot=NULL, "
                    "slot_a_hash=NULL, slot_b_hash=NULL, pending_slot=NULL, pending_hash=NULL, "
                    "pending_revision=NULL, updated_ns=? WHERE provider_id=?",
                    (time.time_ns(), provider_id),
                )
        except (OSError, ProviderLifecycleFailure):
            journal.execute(
                "UPDATE provider_lifecycle SET phase='unavailable', updated_ns=? WHERE provider_id=?",
                (time.time_ns(), provider_id),
            )


def inspect_binding(
    journal: sqlite3.Connection,
    policy: ProviderLifecyclePolicy,
    binding: ProviderBinding,
) -> dict[str, object]:
    operator_hash, profile_hash = _binding_hashes(policy, binding)
    row = journal.execute(
        "SELECT operator_hash, profile_hash, phase, credential_revision, active_slot, "
        "slot_a_hash, slot_b_hash FROM provider_lifecycle WHERE provider_id=?",
        (binding.provider_id,),
    ).fetchone()
    if row is None or row[2] == "unconfigured":
        return {"state": "unconfigured"}
    if row[:2] != (operator_hash, profile_hash):
        raise ProviderLifecycleFailure("FOREIGN_BINDING_REFUSED")
    if row[2] != "ready":
        return {"state": "unavailable"}
    active_hash = row[5] if row[4] == "a" else row[6]
    if not isinstance(active_hash, str):
        return {"state": "unavailable"}
    handle = _domain_hash(
        b"aisy.provider.handle.v1",
        policy.installation_hash,
        binding.provider_id,
        str(row[3]),
        active_hash,
    )
    return {"state": "ready", "handle": handle, "revision": row[3]}


def ready_provider_ids(
    journal: sqlite3.Connection,
    policy: ProviderLifecyclePolicy,
    configured: tuple[str, ...],
) -> tuple[str, ...]:
    policy.validate()
    ready: list[str] = []
    for provider_id in configured:
        row = journal.execute(
            "SELECT installation_hash, release_digest, phase, active_slot, slot_a_hash, slot_b_hash "
            "FROM provider_lifecycle WHERE provider_id=?",
            (provider_id,),
        ).fetchone()
        if row is None or row[:3] != (policy.installation_hash, policy.release_digest, "ready"):
            continue
        active_slot = row[3]
        active_hash = row[4] if active_slot == "a" else row[5]
        if active_slot not in {"a", "b"} or not isinstance(active_hash, str):
            continue
        try:
            if (
                _attest_ciphertext(_slot_path(policy, provider_id, active_slot), policy.expected_owner)
                == active_hash
                and _attest_ciphertext(_active_path(policy, provider_id), policy.expected_owner)
                == active_hash
            ):
                ready.append(provider_id)
        except ProviderLifecycleFailure:
            continue
    return tuple(ready)


def provider_dispatch_binding(
    journal: sqlite3.Connection,
    policy: ProviderLifecyclePolicy,
    provider_id: str,
) -> tuple[int, str]:
    if provider_id not in ready_provider_ids(journal, policy, (provider_id,)):
        raise ProviderLifecycleFailure("PROVIDER_UNCONFIGURED")
    row = journal.execute(
        "SELECT credential_revision, release_digest FROM provider_lifecycle "
        "WHERE provider_id=? AND phase='ready'",
        (provider_id,),
    ).fetchone()
    if (
        row is None
        or isinstance(row[0], bool)
        or not isinstance(row[0], int)
        or row[0] < 1
        or row[1] != policy.release_digest
    ):
        raise ProviderLifecycleFailure("PROVIDER_UNCONFIGURED")
    return row[0], row[1]


def _delete_provider_files(policy: ProviderLifecyclePolicy, provider_id: str) -> None:
    for path in (
        _active_path(policy, provider_id),
        _slot_path(policy, provider_id, "a"),
        _slot_path(policy, provider_id, "b"),
    ):
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != policy.expected_owner:
                raise ProviderLifecycleFailure("CIPHERTEXT_REFUSED")
            path.unlink()
        except FileNotFoundError:
            pass
    _fsync_directory(policy.state_root)


def revoke_binding(
    journal: sqlite3.Connection,
    policy: ProviderLifecyclePolicy,
    binding: ProviderBinding,
    approval_id: str,
) -> None:
    if _APPROVAL.fullmatch(approval_id) is None:
        raise ProviderLifecycleFailure("APPROVAL_REFUSED")
    operator_hash, profile_hash = _binding_hashes(policy, binding)
    journal.execute("BEGIN IMMEDIATE")
    try:
        row = journal.execute(
            "SELECT operator_hash, profile_hash, phase FROM provider_lifecycle WHERE provider_id=?",
            (binding.provider_id,),
        ).fetchone()
        if row is None or row[2] == "unconfigured":
            journal.execute("COMMIT")
            return
        if row[:2] != (operator_hash, profile_hash):
            raise ProviderLifecycleFailure("FOREIGN_BINDING_REFUSED")
        if row[2] != "ready":
            raise ProviderLifecycleFailure("LIFECYCLE_BUSY")
        journal.execute(
            "UPDATE provider_lifecycle SET phase='revoking', updated_ns=? WHERE provider_id=?",
            (time.time_ns(), binding.provider_id),
        )
        descriptor_id = DESCRIPTOR_BY_PROVIDER[binding.provider_id].descriptor_id
        journal.execute(
            "UPDATE provider_attempts SET phase='terminal', updated_ns=? "
            "WHERE descriptor_id=? AND phase='prepared'",
            (time.time_ns(), descriptor_id),
        )
        journal.execute("COMMIT")
    except BaseException:
        journal.execute("ROLLBACK")
        raise
    try:
        _delete_provider_files(policy, binding.provider_id)
        journal.execute(
            "UPDATE provider_lifecycle SET phase='unconfigured', active_slot=NULL, "
            "slot_a_hash=NULL, slot_b_hash=NULL, pending_slot=NULL, pending_hash=NULL, "
            "pending_revision=NULL, updated_ns=? WHERE provider_id=? AND phase='revoking'",
            (time.time_ns(), binding.provider_id),
        )
    except BaseException:
        journal.execute(
            "UPDATE provider_lifecycle SET phase='unavailable', updated_ns=? WHERE provider_id=?",
            (time.time_ns(), binding.provider_id),
        )
        raise


def _control_request(payload: bytes) -> dict[str, object]:
    try:
        value = decode_json(payload)
    except ProviderProtocolFailure as error:
        raise ProviderLifecycleFailure(str(error)) from None
    if value.get("schemaVersion") != 1 or not isinstance(value.get("action"), str):
        raise ProviderLifecycleFailure("CONTROL_FRAME_REFUSED")
    return value


def _binding_from(value: dict[str, object]) -> ProviderBinding:
    if not all(isinstance(value.get(name), str) for name in ("operatorId", "profileId", "providerId")):
        raise ProviderLifecycleFailure("BINDING_REFUSED")
    return ProviderBinding(
        str(value["operatorId"]),
        str(value["profileId"]),
        str(value["providerId"]),
    )


def handle_control_connection(
    connection: socket.socket,
    journal: sqlite3.Connection,
    policy: ProviderLifecyclePolicy,
    *,
    attest: ControlAttestor,
    connect_validator: ValidatorConnector = _connect_validator,
    encrypt: Encryptor = encrypt_host_material,
) -> None:
    material = bytearray()
    claimed: ClaimedChallenge | None = None
    try:
        kind, payload = receive_frame(connection)
        if kind != FRAME_HEADER:
            raise ProviderLifecycleFailure("CONTROL_FRAME_REFUSED")
        value = _control_request(payload)
        action = str(value["action"])
        attest(connection, action)
        if action == "begin" and set(value) == {
            "schemaVersion", "action", "operatorId", "profileId", "providerId",
        }:
            code, expires_ns = begin_challenge(journal, policy, _binding_from(value))
            result: dict[str, object] = {
                "state": "issued",
                "code": code,
                "expiresAtMs": expires_ns // 1_000_000,
            }
        elif action == "inspect" and set(value) == {
            "schemaVersion", "action", "operatorId", "profileId", "providerId",
        }:
            result = inspect_binding(journal, policy, _binding_from(value))
        elif action == "revoke" and set(value) == {
            "schemaVersion", "action", "operatorId", "profileId", "providerId", "approvalId",
        } and isinstance(value["approvalId"], str):
            revoke_binding(journal, policy, _binding_from(value), value["approvalId"])
            result = {"state": "unconfigured"}
        elif action == "submit" and set(value) == {
            "schemaVersion", "action", "code", "materialLength", "materialSha256",
        } and isinstance(value["code"], str):
            claimed = claim_challenge(journal, policy, value["code"])
            connection.sendall(encode_json_frame(FRAME_HEADER, {"schemaVersion": 1, "state": "claimed"}))
            material = receive_claimed_material(
                connection,
                value["materialLength"],  # type: ignore[arg-type]
                value["materialSha256"],  # type: ignore[arg-type]
            )
            validate_material(claimed.provider_id, material, policy, connect=connect_validator)
            revision, handle = rotate_material(journal, policy, claimed, material, encrypt=encrypt)
            result = {"state": "ready", "handle": handle, "revision": revision}
        else:
            raise ProviderLifecycleFailure("CONTROL_FRAME_REFUSED")
        connection.sendall(encode_json_frame(FRAME_HEADER, {"schemaVersion": 1, **result}))
        connection.sendall(encode_frame(FRAME_END))
    except ProviderLifecycleFailure as error:
        if claimed is not None:
            _terminal_challenge(journal, claimed.challenge_hash)
        try:
            connection.sendall(error_frame(error.code, attempted=False))
        except (OSError, ProviderProtocolFailure):
            pass
        raise
    except (OSError, ProviderWorkerFailure, sqlite3.Error):
        if claimed is not None:
            _terminal_challenge(journal, claimed.challenge_hash)
        try:
            connection.sendall(error_frame("CONTROL_IO_REFUSED", attempted=False))
        except (OSError, ProviderProtocolFailure):
            pass
        raise ProviderLifecycleFailure("CONTROL_IO_REFUSED") from None
    finally:
        _zero(material)
