"""Root-owned public metadata authority for the voice credential proxy."""

from __future__ import annotations

import array
import base64
import hashlib
import json
import os
import socket
import sqlite3
import stat
import struct
import time
import weakref
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Self

SCHEMA_VERSION = 1
CHALLENGE_TTL_SECONDS = 600
PERMIT_TTL_SECONDS = 120
_PROVIDER = "deepgram-cloud"
_SLOT = "primary"


class BrokerFailure(Exception):
    """Stable, redacted root broker refusal."""


@dataclass(frozen=True)
class EnrollmentChallenge:
    code: str
    expires_at: int


class CredentialClaim:
    """Unforgeable, process-local proof that a challenge was claimed."""

    __slots__ = ("__weakref__",)


@dataclass(frozen=True)
class OutboxEvent:
    event_id: str
    kind: str
    entity_hash: str
    payload: dict[str, object]
    created_at: int


@dataclass(frozen=True)
class BootstrapPolicy:
    expected_uid: int
    main_pid: int
    start_ticks: int
    cgroup: str
    release: str


@dataclass(frozen=True)
class BootstrapEvidence:
    pid: int
    uid: int
    start_ticks: int
    cgroup: str
    release: str
    dumpable: bool


FaultHook = Callable[[str], None]
ProcessInspector = Callable[[int], BootstrapEvidence]


_SCHEMA = """
CREATE TABLE broker_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE credential_binding (
  binding_hash TEXT PRIMARY KEY CHECK (length(binding_hash) = 64),
  installation_hash TEXT NOT NULL CHECK (length(installation_hash) = 64),
  operator_hash TEXT NOT NULL CHECK (length(operator_hash) = 64),
  profile_hash TEXT NOT NULL CHECK (length(profile_hash) = 64),
  provider_id TEXT NOT NULL CHECK (provider_id = 'deepgram-cloud'),
  slot_id TEXT NOT NULL CHECK (slot_id = 'primary'),
  credential_state TEXT NOT NULL CHECK (
    credential_state IN (
      'unconfigured','validating','committing','active','revoking','revoked'
    )
  ),
  active_revision INTEGER NOT NULL CHECK (active_revision >= 0),
  ciphertext_hash TEXT CHECK (ciphertext_hash IS NULL OR length(ciphertext_hash) = 64),
  target_revision INTEGER CHECK (target_revision IS NULL OR target_revision > 0),
  target_ciphertext_hash TEXT CHECK (
    target_ciphertext_hash IS NULL OR length(target_ciphertext_hash) = 64
  ),
  challenge_hash TEXT CHECK (challenge_hash IS NULL OR length(challenge_hash) = 64),
  challenge_state TEXT NOT NULL CHECK (
    challenge_state IN ('none','active','claimed','superseded','expired')
  ),
  challenge_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE dispatch_permit (
  permit_hash TEXT PRIMARY KEY CHECK (length(permit_hash) = 64),
  binding_hash TEXT NOT NULL REFERENCES credential_binding(binding_hash),
  credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
  recovery_hash TEXT NOT NULL CHECK (length(recovery_hash) = 64),
  state TEXT NOT NULL CHECK (
    state IN ('prepared','claimed','attempted','terminal-none','terminal-attempted')
  ),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE audit_outbox (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_hash TEXT NOT NULL CHECK (length(entity_hash) = 64),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER
) STRICT, WITHOUT ROWID;
"""

_EXPECTED_COLUMNS = {
    "broker_meta": ("singleton", "schema_version", "created_at"),
    "credential_binding": (
        "binding_hash",
        "installation_hash",
        "operator_hash",
        "profile_hash",
        "provider_id",
        "slot_id",
        "credential_state",
        "active_revision",
        "ciphertext_hash",
        "target_revision",
        "target_ciphertext_hash",
        "challenge_hash",
        "challenge_state",
        "challenge_expires_at",
        "created_at",
        "updated_at",
    ),
    "dispatch_permit": (
        "permit_hash",
        "binding_hash",
        "credential_revision",
        "recovery_hash",
        "state",
        "expires_at",
        "created_at",
        "updated_at",
    ),
    "audit_outbox": (
        "event_id",
        "kind",
        "entity_hash",
        "payload_json",
        "created_at",
        "acknowledged_at",
    ),
}


def _digest(domain: str, *parts: str) -> str:
    value = hashlib.sha256()
    value.update(f"aisy.voice.{domain}.v1\0".encode())
    for part in parts:
        encoded = part.encode("utf-8")
        value.update(len(encoded).to_bytes(4, "big"))
        value.update(encoded)
    return value.hexdigest()


def _token(size: int = 24) -> str:
    return base64.urlsafe_b64encode(os.urandom(size)).rstrip(b"=").decode()


def _token_from_digest(domain: str, *parts: str) -> str:
    raw = bytes.fromhex(_digest(domain, *parts))
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _require_text(value: str) -> None:
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode("utf-8")) > 512
        or any(ord(char) < 32 for char in value)
    ):
        raise BrokerFailure("INVALID_BINDING")


def _require_hash(value: str) -> None:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(char not in "0123456789abcdef" for char in value)
    ):
        raise BrokerFailure("INVALID_METADATA")


class VoiceCredentialBroker:
    """Strict SQLite state machine for public metadata."""

    def __init__(
        self,
        database: Path,
        *,
        expected_owner_uid: int | None = None,
        clock: Callable[[], float] = time.time,
        fault: FaultHook | None = None,
    ) -> None:
        self.database = database
        self.expected_owner_uid = (
            os.getuid() if expected_owner_uid is None else expected_owner_uid
        )
        self._clock = clock
        self._fault = fault or (lambda _point: None)
        self._claims: weakref.WeakKeyDictionary[CredentialClaim, tuple[str, int]] = (
            weakref.WeakKeyDictionary()
        )
        self._connection = self._open()

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def _private_path(self) -> None:
        parent = self.database.parent
        try:
            info = parent.lstat()
            canonical = parent.resolve(strict=True)
        except OSError:
            raise BrokerFailure("PRIVATE_STATE_REFUSED") from None
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or canonical != parent.absolute()
            or info.st_uid != self.expected_owner_uid
            or stat.S_IMODE(info.st_mode) != 0o700
        ):
            raise BrokerFailure("PRIVATE_STATE_REFUSED")

    def _check_file(self, path: Path) -> None:
        try:
            info = path.lstat()
        except OSError:
            raise BrokerFailure("PRIVATE_STATE_REFUSED") from None
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != self.expected_owner_uid
            or stat.S_IMODE(info.st_mode) != 0o600
        ):
            raise BrokerFailure("PRIVATE_STATE_REFUSED")

    def _discard_created_state(self) -> None:
        for candidate in (
            self.database,
            Path(f"{self.database}-wal"),
            Path(f"{self.database}-shm"),
        ):
            try:
                candidate.unlink(missing_ok=True)
            except OSError:
                pass

    def _open(self) -> sqlite3.Connection:
        self._private_path()
        created = False
        if not self.database.exists():
            descriptor: int | None = None
            try:
                descriptor = os.open(
                    self.database,
                    os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                )
                created = True
                os.fchmod(descriptor, 0o600)
            except OSError:
                if created:
                    self._discard_created_state()
                raise BrokerFailure("PRIVATE_STATE_REFUSED") from None
            finally:
                if descriptor is not None:
                    os.close(descriptor)
        self._check_file(self.database)
        connection: sqlite3.Connection | None = None
        try:
            connection = sqlite3.connect(self.database, timeout=5, isolation_level=None)
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA busy_timeout=5000")
            if created:
                if (
                    str(
                        connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
                    ).lower()
                    != "wal"
                ):
                    raise BrokerFailure("STATE_CONFIGURATION_REFUSED")
                connection.executescript(_SCHEMA)
                connection.execute("PRAGMA user_version=1")
                connection.execute(
                    "INSERT INTO broker_meta(singleton,schema_version,created_at) VALUES(1,1,?)",
                    (int(self._clock()),),
                )
            self._validate(connection)
            for suffix in ("-wal", "-shm"):
                sidecar = Path(f"{self.database}{suffix}")
                if sidecar.exists():
                    self._check_file(sidecar)
            return connection
        except BrokerFailure:
            if connection is not None:
                connection.close()
            if created:
                self._discard_created_state()
            raise
        except (sqlite3.DatabaseError, OSError):
            if connection is not None:
                connection.close()
            if created:
                self._discard_created_state()
            raise BrokerFailure("STATE_INTEGRITY_REFUSED") from None

    def _validate(self, connection: sqlite3.Connection) -> None:
        if connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise BrokerFailure("STATE_INTEGRITY_REFUSED")
        if connection.execute("PRAGMA user_version").fetchone() != (SCHEMA_VERSION,):
            raise BrokerFailure("STATE_SCHEMA_REFUSED")
        if (
            str(connection.execute("PRAGMA journal_mode").fetchone()[0]).lower()
            != "wal"
        ):
            raise BrokerFailure("STATE_CONFIGURATION_REFUSED")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA wal_autocheckpoint=100")
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        if tables != set(_EXPECTED_COLUMNS):
            raise BrokerFailure("STATE_SCHEMA_REFUSED")
        with sqlite3.connect(":memory:") as expected_connection:
            expected_connection.executescript(_SCHEMA)
            expected_schema = tuple(
                (row[0], " ".join(row[1].split()))
                for row in expected_connection.execute(
                    "SELECT name,sql FROM sqlite_schema WHERE type='table' "
                    "AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )
            )
        actual_schema = tuple(
            (row[0], " ".join(row[1].split()))
            for row in connection.execute(
                "SELECT name,sql FROM sqlite_schema WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        )
        if actual_schema != expected_schema:
            raise BrokerFailure("STATE_SCHEMA_REFUSED")
        for table, expected in _EXPECTED_COLUMNS.items():
            actual = tuple(
                row[1] for row in connection.execute(f"PRAGMA table_info({table})")
            )
            if actual != expected:
                raise BrokerFailure("STATE_SCHEMA_REFUSED")
        if connection.execute(
            "SELECT singleton,schema_version FROM broker_meta"
        ).fetchall() != [(1, SCHEMA_VERSION)]:
            raise BrokerFailure("STATE_SCHEMA_REFUSED")

    @contextmanager
    def _transaction(self, operation: str) -> Iterator[sqlite3.Connection]:
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            yield self._connection
            self._fault(f"before-commit:{operation}")
            self._connection.execute("COMMIT")
        except sqlite3.Error:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise BrokerFailure("STATE_OPERATION_REFUSED") from None
        except BaseException:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise

    def _event(
        self,
        connection: sqlite3.Connection,
        kind: str,
        entity_hash: str,
        payload: dict[str, object],
        now: int,
    ) -> None:
        _require_hash(entity_hash)
        connection.execute(
            "INSERT INTO audit_outbox(event_id,kind,entity_hash,payload_json,created_at) "
            "VALUES(?,?,?,?,?)",
            (
                _token(),
                kind,
                entity_hash,
                json.dumps(payload, separators=(",", ":"), sort_keys=True),
                now,
            ),
        )

    def binding_hash(
        self,
        installation_id: str,
        operator_id: str,
        profile_id: str,
        provider_id: str = _PROVIDER,
        slot_id: str = _SLOT,
    ) -> str:
        for value in (installation_id, operator_id, profile_id, provider_id, slot_id):
            _require_text(value)
        if provider_id != _PROVIDER or slot_id != _SLOT:
            raise BrokerFailure("INVALID_BINDING")
        return _digest(
            "binding", installation_id, operator_id, profile_id, provider_id, slot_id
        )

    def begin_enrollment(
        self,
        installation_id: str,
        operator_id: str,
        profile_id: str,
        *,
        provider_id: str = _PROVIDER,
        slot_id: str = _SLOT,
        now: int | None = None,
    ) -> EnrollmentChallenge:
        timestamp = int(self._clock()) if now is None else now
        binding = self.binding_hash(
            installation_id, operator_id, profile_id, provider_id, slot_id
        )
        code = _token()
        expires = timestamp + CHALLENGE_TTL_SECONDS
        with self._transaction("begin-enrollment") as connection:
            previous = connection.execute(
                "SELECT challenge_state FROM credential_binding WHERE binding_hash=?",
                (binding,),
            ).fetchone()
            if previous is not None and previous[0] == "active":
                self._event(
                    connection,
                    "voice.enrollment-superseded",
                    binding,
                    {},
                    timestamp,
                )
            connection.execute(
                "INSERT INTO credential_binding("
                "binding_hash,installation_hash,operator_hash,profile_hash,provider_id,slot_id,"
                "credential_state,active_revision,ciphertext_hash,target_revision,"
                "target_ciphertext_hash,challenge_hash,challenge_state,challenge_expires_at,"
                "created_at,updated_at) VALUES(?,?,?,?,?,?,'unconfigured',0,NULL,NULL,NULL,"
                "?,'active',?,?,?) ON CONFLICT(binding_hash) DO UPDATE SET "
                "challenge_hash=excluded.challenge_hash,challenge_state='active',"
                "challenge_expires_at=excluded.challenge_expires_at,updated_at=excluded.updated_at",
                (
                    binding,
                    _digest("installation", installation_id),
                    _digest("operator", operator_id),
                    _digest("profile", profile_id),
                    provider_id,
                    slot_id,
                    _digest("challenge", code),
                    expires,
                    timestamp,
                    timestamp,
                ),
            )
            self._event(
                connection,
                "voice.enrollment-begun",
                binding,
                {"expiresAt": expires},
                timestamp,
            )
        return EnrollmentChallenge(code, expires)

    def claim_enrollment(
        self,
        code: str,
        installation_id: str,
        operator_id: str,
        profile_id: str,
        *,
        provider_id: str = _PROVIDER,
        slot_id: str = _SLOT,
        now: int | None = None,
    ) -> CredentialClaim:
        _require_text(code)
        timestamp = int(self._clock()) if now is None else now
        binding = self.binding_hash(
            installation_id, operator_id, profile_id, provider_id, slot_id
        )
        code_hash = _digest("challenge", code)
        failure = False
        with self._transaction("claim-enrollment") as connection:
            row = connection.execute(
                "SELECT challenge_state,challenge_expires_at FROM credential_binding "
                "WHERE binding_hash=? AND challenge_hash=?",
                (binding, code_hash),
            ).fetchone()
            if row is None or row[0] != "active":
                failure = True
            elif row[1] is None or row[1] <= timestamp:
                connection.execute(
                    "UPDATE credential_binding SET challenge_state='expired',updated_at=? "
                    "WHERE binding_hash=? AND challenge_hash=? AND challenge_state='active'",
                    (timestamp, binding, code_hash),
                )
                self._event(
                    connection, "voice.enrollment-expired", binding, {}, timestamp
                )
                failure = True
            else:
                changed = connection.execute(
                    "UPDATE credential_binding SET challenge_state='claimed',updated_at=? "
                    "WHERE binding_hash=? AND challenge_hash=? AND challenge_state='active'",
                    (timestamp, binding, code_hash),
                ).rowcount
                if changed != 1:
                    failure = True
                else:
                    self._event(
                        connection, "voice.enrollment-claimed", binding, {}, timestamp
                    )
        if failure:
            raise BrokerFailure("CHALLENGE_REFUSED")
        claim = CredentialClaim()
        self._claims[claim] = (binding, timestamp)
        return claim

    def begin_validation(
        self, claim: CredentialClaim, *, now: int | None = None
    ) -> tuple[str, int]:
        timestamp = int(self._clock()) if now is None else now
        proof = self._claims.pop(claim, None)
        if proof is None:
            raise BrokerFailure("CLAIM_REFUSED")
        binding = proof[0]
        with self._transaction("begin-validation") as connection:
            row = connection.execute(
                "SELECT active_revision,challenge_state FROM credential_binding WHERE binding_hash=?",
                (binding,),
            ).fetchone()
            if row is None or row[1] != "claimed":
                raise BrokerFailure("CLAIM_REFUSED")
            revision = row[0] + 1
            connection.execute(
                "UPDATE credential_binding SET credential_state='validating',target_revision=?,"
                "target_ciphertext_hash=NULL,updated_at=? WHERE binding_hash=?",
                (revision, timestamp, binding),
            )
            self._event(
                connection,
                "voice.validation-begun",
                binding,
                {"revision": revision},
                timestamp,
            )
        return binding, revision

    def claim_enrollment_code(
        self,
        code: str,
        *,
        now: int | None = None,
    ) -> CredentialClaim:
        """Consume a public one-use code without persisting raw binding ids."""

        _require_text(code)
        timestamp = int(self._clock()) if now is None else now
        code_hash = _digest("challenge", code)
        binding: str | None = None
        claimed = False
        with self._transaction("claim-enrollment-code") as connection:
            rows = connection.execute(
                "SELECT binding_hash,challenge_state,challenge_expires_at "
                "FROM credential_binding WHERE challenge_hash=?",
                (code_hash,),
            ).fetchall()
            if len(rows) != 1 or rows[0][1] != "active":
                raise BrokerFailure("CHALLENGE_REFUSED")
            binding = rows[0][0]
            if rows[0][2] is None or rows[0][2] <= timestamp:
                connection.execute(
                    "UPDATE credential_binding SET challenge_state='expired',updated_at=? "
                    "WHERE binding_hash=? AND challenge_hash=? AND challenge_state='active'",
                    (timestamp, binding, code_hash),
                )
                self._event(
                    connection, "voice.enrollment-expired", binding, {}, timestamp
                )
            else:
                changed = connection.execute(
                    "UPDATE credential_binding SET challenge_state='claimed',updated_at=? "
                    "WHERE binding_hash=? AND challenge_hash=? AND challenge_state='active'",
                    (timestamp, binding, code_hash),
                ).rowcount
                if changed != 1:
                    raise BrokerFailure("CHALLENGE_REFUSED")
                self._event(connection, "voice.enrollment-claimed", binding, {}, timestamp)
                claimed = True
        if not claimed or binding is None:
            raise BrokerFailure("CHALLENGE_REFUSED")
        claim = CredentialClaim()
        self._claims[claim] = (binding, timestamp)
        return claim

    def active_credential(self) -> tuple[str, int, str]:
        """Return the only active binding as an opaque worker-facing handle."""

        rows = self._connection.execute(
            "SELECT binding_hash,active_revision FROM credential_binding "
            "WHERE credential_state IN ('active','validating') AND active_revision > 0"
        ).fetchall()
        if len(rows) != 1:
            raise BrokerFailure("CREDENTIAL_UNAVAILABLE")
        binding, revision = rows[0]
        return binding, revision, _token_from_digest("handle", binding, str(revision))

    def abort_validation(
        self,
        binding_hash: str,
        revision: int,
        stable_code: str,
        *,
        now: int | None = None,
    ) -> None:
        _require_hash(binding_hash)
        _require_text(stable_code)
        timestamp = int(self._clock()) if now is None else now
        with self._transaction("abort-validation") as connection:
            row = connection.execute(
                "SELECT active_revision FROM credential_binding WHERE binding_hash=? "
                "AND credential_state='validating' AND target_revision=?",
                (binding_hash, revision),
            ).fetchone()
            if row is None:
                raise BrokerFailure("CREDENTIAL_TRANSITION_REFUSED")
            next_state = "active" if row[0] > 0 else "unconfigured"
            connection.execute(
                "UPDATE credential_binding SET credential_state=?,target_revision=NULL,"
                "target_ciphertext_hash=NULL,challenge_hash=NULL,challenge_state='none',"
                "challenge_expires_at=NULL,updated_at=? WHERE binding_hash=?",
                (next_state, timestamp, binding_hash),
            )
            self._event(
                connection,
                "voice.validation-refused",
                binding_hash,
                {"code": stable_code, "revision": revision},
                timestamp,
            )

    def mark_committing(
        self,
        binding_hash: str,
        revision: int,
        ciphertext_hash: str,
        *,
        now: int | None = None,
    ) -> None:
        _require_hash(binding_hash)
        _require_hash(ciphertext_hash)
        timestamp = int(self._clock()) if now is None else now
        with self._transaction("mark-committing") as connection:
            busy = connection.execute(
                "SELECT 1 FROM dispatch_permit WHERE binding_hash=? "
                "AND state IN ('prepared','claimed','attempted') LIMIT 1",
                (binding_hash,),
            ).fetchone()
            if busy is not None:
                raise BrokerFailure("CREDENTIAL_EPOCH_BUSY")
            changed = connection.execute(
                "UPDATE credential_binding SET credential_state='committing',"
                "target_ciphertext_hash=?,updated_at=? WHERE binding_hash=? "
                "AND credential_state='validating' AND target_revision=?",
                (ciphertext_hash, timestamp, binding_hash, revision),
            ).rowcount
            if changed != 1:
                raise BrokerFailure("CREDENTIAL_TRANSITION_REFUSED")
            self._event(
                connection,
                "voice.credential-committing",
                binding_hash,
                {"revision": revision},
                timestamp,
            )

    def publish_credential(
        self,
        binding_hash: str,
        revision: int,
        ciphertext_hash: str,
        *,
        now: int | None = None,
    ) -> None:
        _require_hash(binding_hash)
        _require_hash(ciphertext_hash)
        timestamp = int(self._clock()) if now is None else now
        with self._transaction("publish-credential") as connection:
            changed = connection.execute(
                "UPDATE credential_binding SET credential_state='active',active_revision=?,"
                "ciphertext_hash=?,target_revision=NULL,target_ciphertext_hash=NULL,"
                "challenge_hash=NULL,challenge_state='none',challenge_expires_at=NULL,updated_at=? "
                "WHERE binding_hash=? AND credential_state='committing' AND target_revision=? "
                "AND target_ciphertext_hash=?",
                (
                    revision,
                    ciphertext_hash,
                    timestamp,
                    binding_hash,
                    revision,
                    ciphertext_hash,
                ),
            ).rowcount
            if changed != 1:
                raise BrokerFailure("CREDENTIAL_TRANSITION_REFUSED")
            self._event(
                connection,
                "voice.credential-published",
                binding_hash,
                {"revision": revision},
                timestamp,
            )

    def inspect(self, binding_hash: str) -> dict[str, object]:
        _require_hash(binding_hash)
        row = self._connection.execute(
            "SELECT credential_state,active_revision FROM credential_binding WHERE binding_hash=?",
            (binding_hash,),
        ).fetchone()
        if row is None:
            return {"state": "unconfigured"}
        if row[1] == 0 or row[0] not in {"active", "validating"}:
            return {"state": "unavailable"}
        return {
            "state": "ready",
            "handle": _token_from_digest("handle", binding_hash, str(row[1])),
            "revision": row[1],
        }

    def prepare_permit(
        self,
        binding_hash: str,
        credential_revision: int,
        reservation_recovery_key: str,
        *,
        now: int | None = None,
    ) -> str:
        _require_hash(binding_hash)
        _require_text(reservation_recovery_key)
        timestamp = int(self._clock()) if now is None else now
        permit = _token()
        permit_hash = _digest("permit", permit)
        recovery_hash = _digest("recovery", reservation_recovery_key)
        with self._transaction("prepare-permit") as connection:
            active = connection.execute(
                "SELECT 1 FROM credential_binding WHERE binding_hash=? "
                "AND credential_state IN ('active','validating') AND active_revision=?",
                (binding_hash, credential_revision),
            ).fetchone()
            if active is None:
                raise BrokerFailure("CREDENTIAL_UNAVAILABLE")
            connection.execute(
                "INSERT INTO dispatch_permit(permit_hash,binding_hash,credential_revision,"
                "recovery_hash,state,expires_at,created_at,updated_at) "
                "VALUES(?,?,?,?,'prepared',?,?,?)",
                (
                    permit_hash,
                    binding_hash,
                    credential_revision,
                    recovery_hash,
                    timestamp + PERMIT_TTL_SECONDS,
                    timestamp,
                    timestamp,
                ),
            )
            self._event(
                connection,
                "voice.permit-prepared",
                permit_hash,
                {
                    "bindingHash": binding_hash,
                    "recoveryHash": recovery_hash,
                    "revision": credential_revision,
                },
                timestamp,
            )
        return permit

    def transition_permit(
        self,
        permit: str,
        target: str,
        *,
        now: int | None = None,
    ) -> None:
        _require_text(permit)
        timestamp = int(self._clock()) if now is None else now
        permit_hash = _digest("permit", permit)
        allowed = {
            ("prepared", "claimed"),
            ("prepared", "terminal-none"),
            ("claimed", "attempted"),
            ("attempted", "terminal-attempted"),
        }
        failure = False
        with self._transaction("transition-permit") as connection:
            row = connection.execute(
                "SELECT state,expires_at,recovery_hash FROM dispatch_permit WHERE permit_hash=?",
                (permit_hash,),
            ).fetchone()
            if row is None:
                failure = True
            elif row[0] == "prepared" and row[1] <= timestamp:
                connection.execute(
                    "UPDATE dispatch_permit SET state='terminal-none',updated_at=? "
                    "WHERE permit_hash=? AND state='prepared'",
                    (timestamp, permit_hash),
                )
                self._event(
                    connection,
                    "voice.permit-terminal-none",
                    permit_hash,
                    {"recoveryHash": row[2]},
                    timestamp,
                )
                failure = True
            elif (row[0], target) not in allowed:
                failure = True
            else:
                changed = connection.execute(
                    "UPDATE dispatch_permit SET state=?,updated_at=? "
                    "WHERE permit_hash=? AND state=?",
                    (target, timestamp, permit_hash, row[0]),
                ).rowcount
                if changed != 1:
                    failure = True
                else:
                    self._event(
                        connection,
                        f"voice.permit-{target}",
                        permit_hash,
                        {"recoveryHash": row[2]},
                        timestamp,
                    )
        if failure:
            raise BrokerFailure("PERMIT_REFUSED")

    def reconcile_restart(self, *, now: int | None = None) -> int:
        timestamp = int(self._clock()) if now is None else now
        with self._transaction("reconcile-restart") as connection:
            rows = connection.execute(
                "SELECT permit_hash,state,recovery_hash FROM dispatch_permit "
                "WHERE state IN ('prepared','claimed','attempted') ORDER BY permit_hash"
            ).fetchall()
            for permit_hash, state, recovery_hash in rows:
                target = (
                    "terminal-none" if state == "prepared" else "terminal-attempted"
                )
                connection.execute(
                    "UPDATE dispatch_permit SET state=?,updated_at=? "
                    "WHERE permit_hash=? AND state=?",
                    (target, timestamp, permit_hash, state),
                )
                self._event(
                    connection,
                    f"voice.permit-{target}",
                    permit_hash,
                    {"recoveryHash": recovery_hash},
                    timestamp,
                )
        return len(rows)

    def credential_transition(self, binding_hash: str) -> dict[str, object]:
        _require_hash(binding_hash)
        try:
            row = self._connection.execute(
                "SELECT credential_state,active_revision,ciphertext_hash,target_revision,"
                "target_ciphertext_hash FROM credential_binding WHERE binding_hash=?",
                (binding_hash,),
            ).fetchone()
        except sqlite3.Error:
            raise BrokerFailure("STATE_OPERATION_REFUSED") from None
        if row is None:
            return {"state": "unconfigured", "activeRevision": 0}
        result: dict[str, object] = {"state": row[0], "activeRevision": row[1]}
        if row[2] is not None:
            result["ciphertextHash"] = row[2]
        if row[3] is not None:
            result["targetRevision"] = row[3]
        if row[4] is not None:
            result["targetCiphertextHash"] = row[4]
        return result

    def begin_revoke(
        self,
        binding_hash: str,
        *,
        now: int | None = None,
    ) -> tuple[int, str]:
        _require_hash(binding_hash)
        timestamp = int(self._clock()) if now is None else now
        with self._transaction("begin-revoke") as connection:
            row = connection.execute(
                "SELECT credential_state,active_revision,ciphertext_hash "
                "FROM credential_binding WHERE binding_hash=?",
                (binding_hash,),
            ).fetchone()
            if row is None or row[1] == 0 or row[2] is None:
                raise BrokerFailure("CREDENTIAL_UNAVAILABLE")
            if row[0] == "revoking":
                return row[1], row[2]
            if row[0] != "active":
                raise BrokerFailure("CREDENTIAL_TRANSITION_REFUSED")
            connection.execute(
                "UPDATE credential_binding SET credential_state='revoking',updated_at=? "
                "WHERE binding_hash=? AND credential_state='active'",
                (timestamp, binding_hash),
            )
            prepared = connection.execute(
                "SELECT permit_hash,recovery_hash FROM dispatch_permit "
                "WHERE binding_hash=? AND credential_revision=? AND state='prepared'",
                (binding_hash, row[1]),
            ).fetchall()
            for permit_hash, recovery_hash in prepared:
                connection.execute(
                    "UPDATE dispatch_permit SET state='terminal-none',updated_at=? "
                    "WHERE permit_hash=? AND state='prepared'",
                    (timestamp, permit_hash),
                )
                self._event(
                    connection,
                    "voice.permit-terminal-none",
                    permit_hash,
                    {"recoveryHash": recovery_hash},
                    timestamp,
                )
            self._event(
                connection,
                "voice.credential-revoking",
                binding_hash,
                {"revision": row[1]},
                timestamp,
            )
            return row[1], row[2]

    def fence_revoke_permits(
        self,
        binding_hash: str,
        revision: int,
        *,
        now: int | None = None,
    ) -> int:
        _require_hash(binding_hash)
        timestamp = int(self._clock()) if now is None else now
        with self._transaction("fence-revoke-permits") as connection:
            state = connection.execute(
                "SELECT credential_state,active_revision FROM credential_binding "
                "WHERE binding_hash=?",
                (binding_hash,),
            ).fetchone()
            if state != ("revoking", revision):
                raise BrokerFailure("CREDENTIAL_TRANSITION_REFUSED")
            permits = connection.execute(
                "SELECT permit_hash,recovery_hash FROM dispatch_permit WHERE binding_hash=? "
                "AND credential_revision=? AND state IN ('claimed','attempted')",
                (binding_hash, revision),
            ).fetchall()
            for permit_hash, recovery_hash in permits:
                connection.execute(
                    "UPDATE dispatch_permit SET state='terminal-attempted',updated_at=? "
                    "WHERE permit_hash=? AND state IN ('claimed','attempted')",
                    (timestamp, permit_hash),
                )
                self._event(
                    connection,
                    "voice.permit-terminal-attempted",
                    permit_hash,
                    {"recoveryHash": recovery_hash},
                    timestamp,
                )
            return len(permits)

    def complete_revoke(
        self,
        binding_hash: str,
        revision: int,
        ciphertext_hash: str,
        *,
        now: int | None = None,
    ) -> None:
        _require_hash(binding_hash)
        _require_hash(ciphertext_hash)
        timestamp = int(self._clock()) if now is None else now
        with self._transaction("complete-revoke") as connection:
            active = connection.execute(
                "SELECT 1 FROM dispatch_permit WHERE binding_hash=? "
                "AND credential_revision=? AND state IN ('prepared','claimed','attempted') LIMIT 1",
                (binding_hash, revision),
            ).fetchone()
            if active is not None:
                raise BrokerFailure("CREDENTIAL_EPOCH_BUSY")
            changed = connection.execute(
                "UPDATE credential_binding SET credential_state='revoked',active_revision=0,"
                "ciphertext_hash=NULL,target_revision=NULL,target_ciphertext_hash=NULL,"
                "challenge_hash=NULL,challenge_state='none',challenge_expires_at=NULL,updated_at=? "
                "WHERE binding_hash=? AND credential_state='revoking' AND active_revision=? "
                "AND ciphertext_hash=?",
                (timestamp, binding_hash, revision, ciphertext_hash),
            ).rowcount
            if changed != 1:
                raise BrokerFailure("CREDENTIAL_TRANSITION_REFUSED")
            self._event(
                connection,
                "voice.credential-revoked",
                binding_hash,
                {"revision": revision},
                timestamp,
            )

    def pending_events(self, *, limit: int = 100) -> list[OutboxEvent]:
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 1000
        ):
            raise BrokerFailure("INVALID_LIMIT")
        rows = self._connection.execute(
            "SELECT event_id,kind,entity_hash,payload_json,created_at FROM audit_outbox "
            "WHERE acknowledged_at IS NULL ORDER BY created_at,event_id LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            OutboxEvent(row[0], row[1], row[2], json.loads(row[3]), row[4])
            for row in rows
        ]

    def ack_event(self, event_id: str, *, now: int | None = None) -> None:
        _require_text(event_id)
        timestamp = int(self._clock()) if now is None else now
        with self._transaction("ack-event") as connection:
            if (
                connection.execute(
                    "SELECT 1 FROM audit_outbox WHERE event_id=?", (event_id,)
                ).fetchone()
                is None
            ):
                raise BrokerFailure("EVENT_REFUSED")
            connection.execute(
                "UPDATE audit_outbox SET acknowledged_at=COALESCE(acknowledged_at,?) "
                "WHERE event_id=?",
                (timestamp, event_id),
            )


def verify_bootstrap(
    peer_pid: int,
    peer_uid: int,
    evidence: BootstrapEvidence,
    policy: BootstrapPolicy,
) -> None:
    if (
        peer_uid != policy.expected_uid
        or peer_pid != policy.main_pid
        or evidence.pid != peer_pid
        or evidence.uid != peer_uid
        or evidence.start_ticks != policy.start_ticks
        or evidence.cgroup != policy.cgroup
        or evidence.release != policy.release
        or evidence.dumpable
    ):
        raise BrokerFailure("BOOTSTRAP_REFUSED")


def proc_start_ticks(pid: int) -> int:
    try:
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        remainder = raw[raw.rindex(")") + 2 :].split()
        return int(remainder[19], 10)
    except (OSError, ValueError, IndexError):
        raise BrokerFailure("PROCESS_EVIDENCE_REFUSED") from None


def proc_cgroup(pid: int) -> str:
    try:
        lines = Path(f"/proc/{pid}/cgroup").read_text(encoding="utf-8").splitlines()
    except OSError:
        raise BrokerFailure("PROCESS_EVIDENCE_REFUSED") from None
    for line in lines:
        try:
            hierarchy, controllers, path = line.split(":", 2)
        except ValueError:
            continue
        if hierarchy == "0" and not controllers and path.startswith("/"):
            return path
    raise BrokerFailure("PROCESS_EVIDENCE_REFUSED")


def grant_private_session(
    bootstrap: socket.socket,
    policy: BootstrapPolicy,
    inspector: ProcessInspector,
) -> socket.socket:
    """Attest the kernel peer and transfer one private CLOEXEC seqpacket fd."""

    if (
        not hasattr(socket, "SO_PEERCRED")
        or not hasattr(socket, "SO_PASSCRED")
        or not hasattr(socket, "SOCK_SEQPACKET")
    ):
        raise BrokerFailure("BOOTSTRAP_UNAVAILABLE")
    broker_end: socket.socket | None = None
    client_end: socket.socket | None = None
    try:
        if (
            bootstrap.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE)
            != socket.SOCK_SEQPACKET
        ):
            raise BrokerFailure("BOOTSTRAP_REFUSED")
        raw = bootstrap.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        peer_pid, peer_uid, _peer_gid = struct.unpack("3i", raw)
        verify_bootstrap(peer_pid, peer_uid, inspector(peer_pid), policy)
        pair_type = socket.SOCK_SEQPACKET | getattr(socket, "SOCK_CLOEXEC", 0)
        broker_end, client_end = socket.socketpair(socket.AF_UNIX, pair_type)
        if broker_end.get_inheritable() or client_end.get_inheritable():
            raise BrokerFailure("BOOTSTRAP_TRANSFER_REFUSED")
        broker_end.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        client_end.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        descriptors = array.array("i", [client_end.fileno()])
        sent = bootstrap.sendmsg(
            [b"A"],
            [(socket.SOL_SOCKET, socket.SCM_RIGHTS, descriptors.tobytes())],
        )
        if sent != 1:
            raise BrokerFailure("BOOTSTRAP_TRANSFER_REFUSED")
        client_end.close()
        return broker_end
    except BrokerFailure:
        if broker_end is not None:
            broker_end.close()
        if client_end is not None:
            client_end.close()
        raise
    except (OSError, struct.error):
        if broker_end is not None:
            broker_end.close()
        if client_end is not None:
            client_end.close()
        raise BrokerFailure("BOOTSTRAP_REFUSED") from None
