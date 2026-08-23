"""Root-owned voice broker and one-shot worker entrypoint."""

from __future__ import annotations

import array
import fcntl
import hashlib
import json
import os
import pwd
import re
import selectors
import signal
import socket
import sqlite3
import stat
import struct
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from .voice_credential_backend import (
    CiphertextStore,
    HostEncryptedCredentialBackend,
    SystemdCredsEncryptor,
)
from .voice_credential_broker import (
    BootstrapEvidence,
    BootstrapPolicy,
    BrokerFailure,
    VoiceCredentialBroker,
    grant_private_session,
    proc_cgroup,
    proc_start_ticks,
)
from .voice_transcription_worker import (
    CREDENTIAL_NAME,
    DESCRIPTOR_ID,
    WorkerFailure,
    WorkerPolicy,
    run_one_shot,
)

CONTROL = Path("/run/aisy/voice-control.sock")
BOOTSTRAP = Path("/run/aisy/voice-bootstrap.sock")
WORKER = Path("/run/aisy/voice-worker.sock")
PID = Path("/run/aisy/voice-broker.pid")
STATUS = Path("/run/aisy/voice-status.json")
WORKER_POLICY = Path("/run/aisy/voice-worker-policy.json")
CONFIG = Path("/etc/aisy/voice-proxy.json")
STATE = Path("/var/lib/aisy/voice")
DB = STATE / "broker.sqlite"
AUDIT = STATE / "audit.sqlite"
PROTOCOL = "aisy.voice.control.v1"
MAX_CONTROL = 64 * 1024
MAX_AUDIO = 20 * 1024 * 1024
MAX_RESULT = 60 * 1024 + 4096
_HASH = re.compile(r"^[a-f0-9]{64}$")
_OPAQUE = re.compile(r"^[A-Za-z0-9_-]{20,160}$")
_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$")
_LANGUAGE = re.compile(r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$")
_CGROUP = re.compile(r"^/[A-Za-z0-9_.@:/-]{1,511}$")
_SYSTEM_ENV = {
    "LANG": "C",
    "LC_ALL": "C",
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
}


class ServiceFailure(Exception):
    """Stable process-boundary refusal."""


def systemd_worker_fence(
    run: object = subprocess.run,
) -> bool:
    """Stop new worker activation and prove no one-shot worker remains live."""

    if not callable(run):
        return False
    common = {
        "check": False,
        "stdin": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
        "timeout": 15,
        "env": _SYSTEM_ENV,
    }
    try:
        stopped = run(  # type: ignore[operator]
            ["/usr/bin/systemctl", "stop", "aisy-voice-worker.socket"],
            stdout=subprocess.DEVNULL,
            **common,
        )
        if stopped.returncode != 0:
            return False
        active = run(  # type: ignore[operator]
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
            stdout=subprocess.PIPE,
            **common,
        )
        return (
            active.returncode == 0
            and isinstance(active.stdout, bytes)
            and not active.stdout.strip()
        )
    except (OSError, subprocess.SubprocessError):
        return False


def start_systemd_worker_socket(run: object = subprocess.run) -> None:
    """Restore the worker listener only after a completed revoke fence."""

    if not callable(run):
        raise ServiceFailure("WORKER_SOCKET_REFUSED")
    try:
        result = run(  # type: ignore[operator]
            ["/usr/bin/systemctl", "start", "aisy-voice-worker.socket"],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            timeout=15,
            env=_SYSTEM_ENV,
        )
    except (OSError, subprocess.SubprocessError):
        raise ServiceFailure("WORKER_SOCKET_REFUSED") from None
    if result.returncode != 0:
        raise ServiceFailure("WORKER_SOCKET_REFUSED")


def json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for name, value in pairs:
        if name in result:
            raise ServiceFailure("JSON_REFUSED")
        result[name] = value
    return result


@dataclass(frozen=True)
class Config:
    runtime_uid: int
    runtime_cgroup: str
    release: str
    installation_hash: str


@dataclass
class Media:
    descriptor: int
    sha256: str
    size: int
    content_type: str
    expires_at: float


def exact_root_json(path: Path, maximum: int = 8192) -> object:
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_mode & 0o022
        or not 1 <= info.st_size <= maximum
        or path.resolve(strict=True) != path.absolute()
    ):
        raise ServiceFailure("CONFIG_REFUSED")
    raw = path.read_bytes()
    after = path.lstat()
    if (info.st_dev, info.st_ino, info.st_size) != (
        after.st_dev,
        after.st_ino,
        after.st_size,
    ):
        raise ServiceFailure("CONFIG_REFUSED")
    try:
        return json.loads(raw, object_pairs_hook=json_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ServiceFailure):
        raise ServiceFailure("CONFIG_REFUSED") from None


def load_config(path: Path = CONFIG) -> Config:
    value = exact_root_json(path)
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion", "runtimeUid", "runtimeCgroup", "release", "installationHash",
    }:
        raise ServiceFailure("CONFIG_REFUSED")
    if (
        value["schemaVersion"] != 1
        or isinstance(value["runtimeUid"], bool)
        or not isinstance(value["runtimeUid"], int)
        or value["runtimeUid"] < 1
        or not isinstance(value["runtimeCgroup"], str)
        or _CGROUP.fullmatch(value["runtimeCgroup"]) is None
        or "//" in value["runtimeCgroup"]
        or not isinstance(value["release"], str)
        or _SAFE.fullmatch(value["release"]) is None
        or not isinstance(value["installationHash"], str)
        or _HASH.fullmatch(value["installationHash"]) is None
    ):
        raise ServiceFailure("CONFIG_REFUSED")
    return Config(
        value["runtimeUid"], value["runtimeCgroup"],
        value["release"], value["installationHash"],
    )


def peer(connection: socket.socket) -> tuple[int, int]:
    if not hasattr(socket, "SO_PEERCRED"):
        raise ServiceFailure("PEER_REFUSED")
    pid, uid, _gid = struct.unpack(
        "3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    )
    return pid, uid


def token() -> str:
    import base64

    return base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()


def sealed_copy(source: int, expected_size: int, expected_hash: str) -> int:
    info = os.fstat(source)
    if not stat.S_ISREG(info.st_mode) or info.st_size != expected_size:
        raise ServiceFailure("MEDIA_REFUSED")
    descriptor = os.memfd_create(
        "aisy-voice", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING
    )
    digest = hashlib.sha256()
    total = 0
    try:
        os.lseek(source, 0, os.SEEK_SET)
        while total < expected_size:
            chunk = os.read(source, min(65536, expected_size - total))
            if not chunk:
                break
            if os.write(descriptor, chunk) != len(chunk):
                raise ServiceFailure("MEDIA_REFUSED")
            digest.update(chunk)
            total += len(chunk)
        if total != expected_size or digest.hexdigest() != expected_hash or os.read(source, 1):
            raise ServiceFailure("MEDIA_REFUSED")
        os.lseek(descriptor, 0, os.SEEK_SET)
        fcntl.fcntl(
            descriptor,
            fcntl.F_ADD_SEALS,
            fcntl.F_SEAL_SEAL
            | fcntl.F_SEAL_SHRINK
            | fcntl.F_SEAL_GROW
            | fcntl.F_SEAL_WRITE,
        )
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def recv_packet(connection: socket.socket, maximum: int = MAX_CONTROL) -> object:
    raw, ancillary, flags, _address = connection.recvmsg(
        maximum + 1, socket.CMSG_SPACE(array.array("i").itemsize)
    )
    descriptors: list[int] = []
    for level, kind, payload in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            values = array.array("i")
            values.frombytes(payload[: len(payload) - len(payload) % values.itemsize])
            descriptors.extend(values)
    for descriptor in descriptors:
        os.close(descriptor)
    if (
        not raw
        or len(raw) > maximum
        or ancillary
        or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC)
    ):
        raise ServiceFailure("WORKER_REFUSED")
    try:
        return json.loads(raw, object_pairs_hook=json_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ServiceFailure):
        raise ServiceFailure("WORKER_REFUSED") from None


def node_error(code: str, dispatch: str) -> dict[str, object]:
    return {
        "ok": False,
        "transcript": None,
        "language": None,
        "durationMs": None,
        "code": code,
        "dispatch": dispatch,
    }


def node_result(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or value.get("ok") is not True:
        worker_code = value.get("code") if isinstance(value, dict) else None
        code = {
            "AUTH_REJECTED": "AUTH_REJECTED",
            "QUOTA_EXCEEDED": "QUOTA_EXCEEDED",
            "TIMEOUT": "TIMEOUT",
            "TRANSCRIPTION_TIMEOUT": "TIMEOUT",
            "UPSTREAM_UNAVAILABLE": "UPSTREAM_UNAVAILABLE",
        }.get(worker_code, "UPSTREAM_UNAVAILABLE")
        dispatch = (
            "attempted"
            if isinstance(value, dict) and value.get("dispatch") == "attempted"
            else "none"
        )
        return node_error(code, dispatch)
    transcript = value.get("transcript")
    duration = value.get("durationMs")
    language = value.get("language")
    if (
        not isinstance(transcript, str)
        or "\0" in transcript
        or len(transcript.encode()) > 60 * 1024
        or isinstance(duration, bool)
        or not isinstance(duration, int)
        or duration < 0
        or (language is not None and not isinstance(language, str))
    ):
        return node_error("PROTOCOL_REFUSED", "attempted")
    return {
        "ok": True,
        "transcript": transcript,
        "language": language,
        "durationMs": duration,
        "code": None,
        "dispatch": None,
    }


def atomic_public(path: Path, value: object, mode: int = 0o644) -> None:
    raw = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        mode,
    )
    try:
        os.fchmod(descriptor, mode)
        offset = 0
        while offset < len(raw):
            written = os.write(descriptor, raw[offset:])
            if written <= 0:
                raise ServiceFailure("PUBLISH_REFUSED")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def atomic_bytes(path: Path, raw: bytes, mode: int = 0o644) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        mode,
    )
    try:
        os.fchmod(descriptor, mode)
        offset = 0
        while offset < len(raw):
            written = os.write(descriptor, raw[offset:])
            if written <= 0:
                raise ServiceFailure("PUBLISH_REFUSED")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def recv_exact(connection: socket.socket, size: int) -> bytearray:
    if not 0 <= size <= MAX_CONTROL:
        raise ServiceFailure("FRAME_REFUSED")
    owned = bytearray(size)
    offset = 0
    try:
        while offset < size:
            count = connection.recv_into(memoryview(owned)[offset:])
            if count <= 0:
                raise ServiceFailure("FRAME_REFUSED")
            offset += count
        return owned
    except BaseException:
        owned[:] = b"\0" * len(owned)
        raise


def control_response(request_id: str, ok: bool, payload: list[object]) -> bytes:
    body = json.dumps(
        [PROTOCOL, request_id, "ok" if ok else "error", payload],
        separators=(",", ":"),
    ).encode()
    if len(body) > MAX_CONTROL:
        raise ServiceFailure("FRAME_REFUSED")
    return struct.pack(">I", len(body)) + body


def control_request(
    connection: socket.socket,
) -> tuple[str, str, list[object], bytearray]:
    header_size = struct.unpack(">I", recv_exact(connection, 4))[0]
    if not 1 <= header_size <= MAX_CONTROL:
        raise ServiceFailure("FRAME_REFUSED")
    try:
        value = json.loads(
            recv_exact(connection, header_size), object_pairs_hook=json_object
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ServiceFailure):
        raise ServiceFailure("FRAME_REFUSED") from None
    if (
        not isinstance(value, list)
        or len(value) != 5
        or value[0] != PROTOCOL
        or not isinstance(value[1], str)
        or re.fullmatch(r"[A-Za-z0-9_-]{32}", value[1]) is None
        or value[2] not in {"begin", "inspect", "submit", "revoke"}
        or not isinstance(value[3], list)
        or isinstance(value[4], bool)
        or not isinstance(value[4], int)
        or not 0 <= value[4] <= 8192
    ):
        raise ServiceFailure("FRAME_REFUSED")
    owned = recv_exact(connection, value[4])
    return value[1], value[2], value[3], owned


def proc_dumpable(pid: int) -> bool:
    try:
        lines = Path(f"/proc/{pid}/status").read_text(encoding="utf-8").splitlines()
    except OSError:
        raise BrokerFailure("PROCESS_EVIDENCE_REFUSED") from None
    for line in lines:
        if line.startswith("Dumpable:"):
            return line.split(":", 1)[1].strip() != "0"
    # Linux 4.11 removed the public Dumpable line. A successful bootstrap still
    # requires the exact oldest process in the configured cgroup; the private
    # channel then pins SCM_CREDENTIALS to that pid for every request.
    return False


def cgroup_main_pid(cgroup: str) -> int:
    if ".." in Path(cgroup).parts:
        raise BrokerFailure("PROCESS_EVIDENCE_REFUSED")
    member_file = Path("/sys/fs/cgroup") / cgroup.lstrip("/") / "cgroup.procs"
    try:
        members = {
            int(line, 10)
            for line in member_file.read_text(encoding="ascii").splitlines()
            if line
        }
        if not members:
            raise ValueError
        return min(members, key=lambda member: (proc_start_ticks(member), member))
    except (OSError, ValueError):
        raise BrokerFailure("PROCESS_EVIDENCE_REFUSED") from None


def process_evidence(pid: int, config: Config) -> BootstrapEvidence:
    return BootstrapEvidence(
        pid=pid,
        uid=Path(f"/proc/{pid}").stat().st_uid,
        start_ticks=proc_start_ticks(pid),
        cgroup=proc_cgroup(pid),
        release=config.release,
        dumpable=proc_dumpable(pid),
    )


def listener(path: Path, mode: int, owner_uid: int, kind: int) -> socket.socket:
    try:
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
            raise ServiceFailure("SOCKET_REFUSED")
        path.unlink()
    except FileNotFoundError:
        pass
    created = socket.socket(
        socket.AF_UNIX, kind | getattr(socket, "SOCK_CLOEXEC", 0)
    )
    try:
        created.bind(str(path))
        runtime_gid = pwd.getpwuid(owner_uid).pw_gid
        os.chown(path, 0, runtime_gid)
        os.chmod(path, mode)
        created.listen(16)
        created.settimeout(1.0)
        return created
    except BaseException:
        created.close()
        raise


class BrokerService:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.broker = VoiceCredentialBroker(DB, expected_owner_uid=0)
        self.backend = HostEncryptedCredentialBackend(
            self.broker,
            SystemdCredsEncryptor(STATE),
            CiphertextStore(STATE),
        )
        self.broker.reconcile_restart()
        self.audit = sqlite3.connect(
            AUDIT, isolation_level=None, check_same_thread=False
        )
        self.audit.execute("PRAGMA journal_mode=DELETE")
        self.audit.execute("PRAGMA synchronous=FULL")
        self.audit.execute(
            "CREATE TABLE IF NOT EXISTS delivered_event ("
            "event_id TEXT PRIMARY KEY, event_json TEXT NOT NULL) STRICT"
        )
        os.chmod(AUDIT, 0o600)
        self.media: dict[str, Media] = {}
        self.permits: dict[str, Media] = {}
        self.lock = threading.Lock()
        self.stop = threading.Event()

    def close(self) -> None:
        for item in [*self.media.values(), *self.permits.values()]:
            try:
                os.close(item.descriptor)
            except OSError:
                pass
        self.audit.close()
        self.broker.close()

    def binding(self, payload: list[object]) -> tuple[str, str, str, str]:
        if (
            len(payload) != 4
            or payload[0] != self.config.installation_hash
            or not all(isinstance(value, str) for value in payload)
            or not all(_SAFE.fullmatch(value) is not None for value in payload)
            or payload[3] != "deepgram-cloud"
        ):
            raise ServiceFailure("REQUEST_REFUSED")
        installation, operator, profile, provider = payload
        assert isinstance(installation, str)
        assert isinstance(operator, str)
        assert isinstance(profile, str)
        assert isinstance(provider, str)
        return installation, operator, profile, provider

    def operation(
        self, operation: str, payload: list[object], owned: bytearray
    ) -> list[object]:
        try:
            if operation == "begin":
                installation, operator, profile, provider = self.binding(payload)
                challenge = self.broker.begin_enrollment(
                    installation, operator, profile, provider_id=provider
                )
                from datetime import UTC, datetime
                expires = datetime.fromtimestamp(challenge.expires_at, UTC).isoformat()
                return ["challenge", challenge.code, expires]
            if operation == "inspect":
                installation, operator, profile, provider = self.binding(payload)
                binding_hash = self.broker.binding_hash(
                    installation, operator, profile, provider
                )
                result = self.broker.inspect(binding_hash)
                if result["state"] == "ready":
                    return ["ready", result["handle"], result["revision"]]
                return ["state", result["state"]]
            if operation == "submit":
                if len(payload) != 1 or not isinstance(payload[0], str) or not owned:
                    raise ServiceFailure("REQUEST_REFUSED")
                claim = self.broker.claim_enrollment_code(payload[0])
                revision = self.backend.activate(claim, owned)
                _binding_hash, _revision, handle = self.broker.active_credential()
                return ["ready", handle, revision]
            if operation == "revoke":
                installation, operator, profile, provider = self.binding(payload)
                binding_hash = self.broker.binding_hash(
                    installation, operator, profile, provider
                )
                revision = self.backend.revoke(
                    binding_hash, lambda _revision: systemd_worker_fence()
                )
                start_systemd_worker_socket()
                return ["revoked", revision]
            raise ServiceFailure("REQUEST_REFUSED")
        finally:
            owned[:] = b"\0" * len(owned)

    def write_status(self) -> None:
        try:
            self.broker.active_credential()
            key_state = "ready"
        except BrokerFailure:
            key_state = "unconfigured"
        outbox = "ready" if not self.broker.pending_events(limit=1) else "unconfigured"
        atomic_public(STATUS, {
            "schemaVersion": 1,
            "backend": "ready",
            "key": key_state,
            "proxy": "ready",
            "outbox": outbox,
        })

    def drain_audit(self) -> None:
        events = self.broker.pending_events(limit=100)
        for event in events:
            raw = json.dumps({
                        "eventId": event.event_id,
                        "kind": event.kind,
                        "entityHash": event.entity_hash,
                        "payload": event.payload,
                        "createdAt": event.created_at,
                    }, sort_keys=True, separators=(",", ":"))
            try:
                self.audit.execute("BEGIN IMMEDIATE")
                self.audit.execute(
                    "INSERT OR IGNORE INTO delivered_event(event_id,event_json) "
                    "VALUES(?,?)",
                    (event.event_id, raw),
                )
                self.audit.execute("COMMIT")
            except sqlite3.Error:
                try:
                    self.audit.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise ServiceFailure("AUDIT_REFUSED") from None
            self.broker.ack_event(event.event_id)
        self.write_status()

    def control_connection(self, connection: socket.socket) -> None:
        request_id = "A" * 32
        try:
            _pid, uid = peer(connection)
            if uid != self.config.runtime_uid:
                raise ServiceFailure("PEER_REFUSED")
            request_id, operation, payload, owned = control_request(connection)
            with self.lock:
                result = self.operation(operation, payload, owned)
                self.drain_audit()
            connection.sendall(control_response(request_id, True, result))
        except (ServiceFailure, BrokerFailure, WorkerFailure) as error:
            code = "CHALLENGE_REFUSED" if str(error) == "CHALLENGE_REFUSED" else "CONTROL_UNAVAILABLE"
            try:
                connection.sendall(control_response(request_id, False, [code]))
            except OSError:
                pass
        finally:
            connection.close()

    def stage(
        self, request: dict[str, object], descriptors: list[int]
    ) -> dict[str, object]:
        expected = {
            "version", "type", "sequence", "mediaBindingHash", "expectedSha256",
            "expectedSizeBytes", "maxBytes", "contentType", "language",
        }
        size = request.get("expectedSizeBytes")
        maximum = request.get("maxBytes")
        digest = request.get("expectedSha256")
        media_binding = request.get("mediaBindingHash")
        language = request.get("language")
        if (
            set(request) != expected
            or len(descriptors) != 1
            or not isinstance(media_binding, str)
            or _HASH.fullmatch(media_binding) is None
            or isinstance(size, bool)
            or not isinstance(size, int)
            or not 1 <= size <= MAX_AUDIO
            or isinstance(maximum, bool)
            or not isinstance(maximum, int)
            or not size <= maximum <= MAX_AUDIO
            or not isinstance(digest, str)
            or _HASH.fullmatch(digest) is None
            or request.get("contentType") not in {"audio/ogg", "audio/opus", "audio/webm"}
            or (
                language is not None
                and (
                    not isinstance(language, str)
                    or _LANGUAGE.fullmatch(language) is None
                )
            )
        ):
            return {"ok": False, "mediaTicket": None, "code": "PROTOCOL_REFUSED"}
        descriptor = sealed_copy(descriptors[0], size, digest)
        media_ticket = token()
        while media_ticket in self.media:
            media_ticket = token()
        self.media[media_ticket] = Media(
            descriptor,
            digest,
            size,
            str(request["contentType"]),
            time.monotonic() + 120,
        )
        return {"ok": True, "mediaTicket": media_ticket, "code": None}

    def native_operation(
        self, kind: object, request: dict[str, object], descriptors: list[int]
    ) -> dict[str, object]:
        with self.lock:
            if kind == "stage-media":
                return self.stage(request, descriptors)
            if descriptors:
                raise ServiceFailure("DESCRIPTOR_REFUSED")
            if kind == "cancel-media":
                if set(request) != {"version", "type", "sequence", "mediaTicket"}:
                    raise ServiceFailure("REQUEST_REFUSED")
                ticket = request.get("mediaTicket")
                if not isinstance(ticket, str) or _OPAQUE.fullmatch(ticket) is None:
                    raise ServiceFailure("REQUEST_REFUSED")
                item = self.media.pop(ticket, None)
                if item is not None:
                    os.close(item.descriptor)
                return {"cancelled": item is not None}
            if kind == "prepare":
                if set(request) != {
                    "version", "type", "sequence", "mediaTicket",
                    "reservationRecoveryKey",
                }:
                    raise ServiceFailure("REQUEST_REFUSED")
                ticket = request.get("mediaTicket")
                if not isinstance(ticket, str) or _OPAQUE.fullmatch(ticket) is None:
                    raise ServiceFailure("REQUEST_REFUSED")
                media = self.media.get(ticket)
                recovery = request.get("reservationRecoveryKey")
                if (
                    media is None
                    or not isinstance(recovery, str)
                    or _OPAQUE.fullmatch(recovery) is None
                ):
                    return {
                        "ok": False,
                        "dispatchPermitId": None,
                        "code": "BACKEND_UNAVAILABLE",
                    }
                if media.expires_at <= time.monotonic():
                    del self.media[ticket]
                    os.close(media.descriptor)
                    return {
                        "ok": False,
                        "dispatchPermitId": None,
                        "code": "BACKEND_UNAVAILABLE",
                    }
                binding_hash, revision, _handle = self.broker.active_credential()
                permit = self.broker.prepare_permit(
                    binding_hash, revision, recovery
                )
                del self.media[ticket]
                self.permits[permit] = media
                self.drain_audit()
                return {"ok": True, "dispatchPermitId": permit, "code": None}
            if kind == "cancel-prepared":
                if set(request) != {
                    "version", "type", "sequence", "dispatchPermitId",
                }:
                    raise ServiceFailure("REQUEST_REFUSED")
                permit_value = request.get("dispatchPermitId")
                if (
                    not isinstance(permit_value, str)
                    or _OPAQUE.fullmatch(permit_value) is None
                ):
                    raise ServiceFailure("REQUEST_REFUSED")
                permit = permit_value
                media = self.permits.pop(permit, None)
                if media is None:
                    return {"outcome": "ambiguous"}
                self.broker.transition_permit(permit, "terminal-none")
                os.close(media.descriptor)
                self.drain_audit()
                return {"outcome": "cancelled"}
            if kind == "dispatch":
                if set(request) != {
                    "version", "type", "sequence", "dispatchPermitId",
                }:
                    raise ServiceFailure("REQUEST_REFUSED")
                permit_value = request.get("dispatchPermitId")
                if (
                    not isinstance(permit_value, str)
                    or _OPAQUE.fullmatch(permit_value) is None
                ):
                    raise ServiceFailure("REQUEST_REFUSED")
                return self.dispatch(permit_value)
            raise ServiceFailure("REQUEST_REFUSED")

    def private_packet(
        self, connection: socket.socket, expected_pid: int, sequence: int
    ) -> bool:
        raw, ancillary, flags, _address = connection.recvmsg(
            MAX_CONTROL + 1,
            socket.CMSG_SPACE(array.array("i").itemsize * 2)
            + socket.CMSG_SPACE(struct.calcsize("3i")),
        )
        if not raw or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
            return False
        descriptors: list[int] = []
        credentials: list[tuple[int, int, int]] = []
        for level, kind, payload in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                values = array.array("i")
                values.frombytes(
                    payload[: len(payload) - len(payload) % values.itemsize]
                )
                descriptors.extend(values)
            elif level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS:
                credentials.append(struct.unpack("3i", payload[:12]))
        try:
            request = json.loads(raw, object_pairs_hook=json_object)
            if (
                len(credentials) != 1
                or credentials[0][0] != expected_pid
                or credentials[0][1] != self.config.runtime_uid
                or not isinstance(request, dict)
                or request.get("version") != 1
                or request.get("sequence") != sequence
                or not isinstance(request.get("type"), str)
            ):
                raise ServiceFailure("FRAME_REFUSED")
            kind = request["type"]
            result = self.native_operation(kind, request, descriptors)
            response = {
                "version": 1,
                "type": f"{kind}-result",
                "sequence": sequence,
                **result,
            }
            encoded = json.dumps(response, separators=(",", ":")).encode()
            return connection.send(encoded) == len(encoded)
        finally:
            for descriptor in descriptors:
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    def dispatch(self, permit: str) -> dict[str, object]:
        media = self.permits.pop(permit, None)
        if media is None:
            return node_error("PROTOCOL_REFUSED", "attempted")
        relay: socket.socket | None = None
        claimed = False
        try:
            self.broker.transition_permit(permit, "claimed")
            claimed = True
            _binding_hash, _revision, handle = self.broker.active_credential()
            atomic_public(WORKER_POLICY, {
                "schemaVersion": 1,
                "brokerPid": os.getpid(),
                "installationHash": self.config.installation_hash,
                "handle": handle,
            })
            relay = socket.socket(
                socket.AF_UNIX, socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC
            )
            relay.settimeout(125)
            relay.connect(str(WORKER))
            claim = json.dumps({
                "schemaVersion": 1,
                "descriptorId": DESCRIPTOR_ID,
                "installationHash": self.config.installation_hash,
                "handle": handle,
                "dispatchPermitId": permit,
                "audioSha256": media.sha256,
                "audioBytes": media.size,
                "contentType": media.content_type,
            }, separators=(",", ":")).encode()
            sent = relay.sendmsg(
                [claim],
                [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [media.descriptor]))],
            )
            if sent != len(claim):
                raise ServiceFailure("WORKER_REFUSED")
            attempted_request = recv_packet(relay)
            if attempted_request != {
                "schemaVersion": 1,
                "operation": "mark-attempted",
                "dispatchPermitId": permit,
            }:
                raise ServiceFailure("WORKER_REFUSED")
            self.broker.transition_permit(permit, "attempted")
            attempted_ack = json.dumps({
                "schemaVersion": 1,
                "operation": "attempted",
                "dispatchPermitId": permit,
            }, separators=(",", ":")).encode()
            if relay.send(attempted_ack) != len(attempted_ack):
                raise ServiceFailure("WORKER_REFUSED")
            committed = recv_packet(relay, MAX_RESULT)
            if (
                not isinstance(committed, dict)
                or set(committed) != {
                    "schemaVersion", "operation", "dispatchPermitId", "result",
                }
                or committed.get("schemaVersion") != 1
                or committed.get("operation") != "commit-result"
                or committed.get("dispatchPermitId") != permit
            ):
                raise ServiceFailure("WORKER_REFUSED")
            self.broker.transition_permit(permit, "terminal-attempted")
            terminal_ack = json.dumps({
                "schemaVersion": 1,
                "operation": "result-committed",
                "dispatchPermitId": permit,
            }, separators=(",", ":")).encode()
            if relay.send(terminal_ack) != len(terminal_ack):
                raise ServiceFailure("WORKER_REFUSED")
            self.drain_audit()
            return node_result(committed["result"])
        except (OSError, BrokerFailure, ServiceFailure, WorkerFailure):
            if claimed:
                try:
                    self.broker.transition_permit(permit, "terminal-attempted")
                    self.drain_audit()
                except (BrokerFailure, ServiceFailure):
                    pass
            return node_error("BACKEND_UNAVAILABLE", "attempted")
        finally:
            os.close(media.descriptor)
            if relay is not None:
                relay.close()

    def cancel_activation(self) -> None:
        for media in self.media.values():
            os.close(media.descriptor)
        self.media.clear()
        failed = False
        for permit, media in list(self.permits.items()):
            try:
                self.broker.transition_permit(permit, "terminal-none")
            except BrokerFailure:
                failed = True
            finally:
                os.close(media.descriptor)
        self.permits.clear()
        self.drain_audit()
        if failed:
            raise ServiceFailure("ACTIVATION_CANCEL_REFUSED")

    def prune_media(self) -> None:
        now = time.monotonic()
        for ticket, media in list(self.media.items()):
            if media.expires_at <= now:
                del self.media[ticket]
                os.close(media.descriptor)

    def bootstrap_connection(
        self, connection: socket.socket
    ) -> tuple[socket.socket, int] | None:
        private: socket.socket | None = None
        try:
            peer_pid, peer_uid = peer(connection)
            if peer_uid != self.config.runtime_uid:
                raise ServiceFailure("PEER_REFUSED")
            if cgroup_main_pid(self.config.runtime_cgroup) != peer_pid:
                raise ServiceFailure("PEER_REFUSED")
            evidence = process_evidence(peer_pid, self.config)
            policy = BootstrapPolicy(
                expected_uid=self.config.runtime_uid,
                main_pid=peer_pid,
                start_ticks=evidence.start_ticks,
                cgroup=self.config.runtime_cgroup,
                release=self.config.release,
            )
            private = grant_private_session(
                connection,
                policy,
                lambda candidate: process_evidence(candidate, self.config),
            )
        except (OSError, BrokerFailure, ServiceFailure):
            if private is not None:
                private.close()
            connection.close()
            return None
        connection.close()
        return private, peer_pid

    def serve(self) -> None:
        control = listener(CONTROL, 0o660, self.config.runtime_uid, socket.SOCK_STREAM)
        bootstrap = listener(
            BOOTSTRAP, 0o660, self.config.runtime_uid, socket.SOCK_SEQPACKET
        )
        selector = selectors.DefaultSelector()
        selector.register(control, selectors.EVENT_READ, ("control", None))
        selector.register(bootstrap, selectors.EVENT_READ, ("bootstrap", None))
        active_private: socket.socket | None = None
        try:
            atomic_bytes(PID, f"{os.getpid()}\n".encode("ascii"))
            self.drain_audit()
            while not self.stop.is_set():
                for selected, _events in selector.select(timeout=1.0):
                    kind, state = selected.data
                    if kind == "control":
                        connection, _address = control.accept()
                        connection.settimeout(5.0)
                        self.control_connection(connection)
                    elif kind == "bootstrap":
                        connection, _address = bootstrap.accept()
                        if active_private is not None:
                            connection.close()
                            continue
                        result = self.bootstrap_connection(connection)
                        if result is not None:
                            private, peer_pid = result
                            active_private = private
                            selector.register(
                                private,
                                selectors.EVENT_READ,
                                ("private", [peer_pid, 1]),
                            )
                    else:
                        assert kind == "private"
                        private = selected.fileobj
                        assert isinstance(private, socket.socket)
                        assert isinstance(state, list)
                        try:
                            keep = self.private_packet(private, state[0], state[1])
                        except (
                            OSError,
                            BrokerFailure,
                            ServiceFailure,
                            WorkerFailure,
                            ValueError,
                        ):
                            keep = False
                        if keep:
                            state[1] += 1
                        else:
                            selector.unregister(private)
                            private.close()
                            active_private = None
                            self.cancel_activation()
                self.drain_audit()
                self.prune_media()
        finally:
            self.stop.set()
            for key in list(selector.get_map().values()):
                fileobj = key.fileobj
                try:
                    selector.unregister(fileobj)
                except (KeyError, ValueError):
                    pass
                if fileobj not in (control, bootstrap):
                    fileobj.close()
            selector.close()
            control.close()
            bootstrap.close()
            for path in (CONTROL, BOOTSTRAP, PID, STATUS, WORKER_POLICY):
                try:
                    info = path.lstat()
                    if info.st_uid == 0:
                        path.unlink()
                except FileNotFoundError:
                    pass


def worker() -> int:
    if os.geteuid() == 0:
        return 70
    phase = "POLICY"
    try:
        policy_value = exact_root_json(WORKER_POLICY)
        directory = os.environ.get("CREDENTIALS_DIRECTORY")
        if (
            not isinstance(policy_value, dict)
            or set(policy_value) != {
                "schemaVersion", "brokerPid", "installationHash", "handle",
            }
            or policy_value.get("schemaVersion") != 1
            or not isinstance(policy_value.get("brokerPid"), int)
            or not isinstance(policy_value.get("installationHash"), str)
            or not isinstance(policy_value.get("handle"), str)
            or directory is None
        ):
            return 70
        phase = "MATERIALIZED"
        credential_root = Path(directory)
        credential_path = credential_root / CREDENTIAL_NAME
        credential_root_info = credential_root.lstat()
        if (
            not credential_root.is_absolute()
            or credential_root.resolve(strict=True) != credential_root
            or credential_path.parent != credential_root
            or not stat.S_ISDIR(credential_root_info.st_mode)
            or stat.S_ISLNK(credential_root_info.st_mode)
            or credential_root_info.st_uid != 0
            or credential_root_info.st_gid != 0
            or stat.S_IMODE(credential_root_info.st_mode) != 0o550
            or not credential_root.is_mount()
        ):
            return 70
        phase = "RELAY"
        relay = socket.socket(fileno=0)
        if relay.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_SEQPACKET:
            relay.detach()
            return 70
        policy = WorkerPolicy(
            expected_broker_pid=policy_value["brokerPid"],
            expected_broker_uid=0,
            installation_hash=policy_value["installationHash"],
            credential_handle=policy_value["handle"],
            credential_path=credential_path,
            credential_owner_uid=0,
            credential_owner_gid=0,
        )
        phase = "REQUEST"
        run_one_shot(relay, policy)
        return 0
    except WorkerFailure as error:
        print(f"AISY_VOICE_WORKER_FAILED:{error.code}", file=os.sys.stderr)
        return 70
    except (OSError, ServiceFailure):
        print(f"AISY_VOICE_WORKER_FAILED:{phase}_REFUSED", file=os.sys.stderr)
        return 70


def broker(config: Config) -> int:
    if os.geteuid() != 0 or os.name != "posix" or not Path("/proc").is_dir():
        return 70
    for directory, mode in ((STATE, 0o700), (CONTROL.parent, 0o755)):
        directory.mkdir(parents=True, exist_ok=True, mode=mode)
        os.chown(directory, 0, -1)
        os.chmod(directory, mode)
    service = BrokerService(config)

    def stop(_signum: int, _frame: object) -> None:
        service.stop.set()

    previous_term = signal.signal(signal.SIGTERM, stop)
    previous_int = signal.signal(signal.SIGINT, stop)
    try:
        service.serve()
        return 0
    except (OSError, BrokerFailure, ServiceFailure, WorkerFailure):
        return 70
    finally:
        signal.signal(signal.SIGTERM, previous_term)
        signal.signal(signal.SIGINT, previous_int)
        service.close()


def self_check(expected_release: str) -> int:
    if _SAFE.fullmatch(expected_release) is None:
        return 70
    release_root = Path(__file__).resolve(strict=True).parent.parent
    try:
        manifest = exact_root_json(release_root / "manifest.json", 128 * 1024)
    except (OSError, ServiceFailure):
        return 70
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {
            "schemaVersion", "protocolVersion", "release", "commit", "files",
        }
        or manifest.get("schemaVersion") != 1
        or manifest.get("protocolVersion") != 1
        or manifest.get("release") != expected_release
        or not isinstance(manifest.get("files"), list)
    ):
        return 70
    return 0


def main() -> int:
    if len(os.sys.argv) == 3 and os.sys.argv[1] == "self-check":
        return self_check(os.sys.argv[2])
    if len(os.sys.argv) != 2 or os.sys.argv[1] not in {"broker", "worker"}:
        return 64
    if os.sys.argv[1] == "worker":
        return worker()
    try:
        config = load_config()
    except (OSError, ServiceFailure):
        return 70
    return broker(config)


if __name__ == "__main__":
    raise SystemExit(main())
