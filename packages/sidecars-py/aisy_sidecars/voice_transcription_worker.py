"""One-request Deepgram worker behind an attested root broker relay."""

from __future__ import annotations

import array
import fcntl
import hashlib
import ipaddress
import json
import math
import os
import re
import socket
import ssl
import stat
import struct
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .voice_credential_backend import CREDENTIAL_NAME

DESCRIPTOR_ID = "deepgram.nova3.transcribe.v1"
UPSTREAM_HOST = "api.deepgram.com"
UPSTREAM_PORT = 443
UPSTREAM_PATH = "/v1/listen?model=nova-3&smart_format=true&detect_language=true"
MAX_CONTROL_BYTES = 64 * 1024
MAX_AUDIO_BYTES = 20 * 1024 * 1024
MAX_CREDENTIAL_BYTES = 8 * 1024
MAX_RESPONSE_HEADERS = 16 * 1024
MAX_RESPONSE_BODY = 1024 * 1024
MAX_TRANSCRIPT_BYTES = 60 * 1024
MAX_LANGUAGE_BYTES = 35
MAX_DURATION_MS = 24 * 60 * 60 * 1000
F_GET_SEALS = getattr(fcntl, "F_GET_SEALS", None)
REQUIRED_MEMFD_SEALS = (
    getattr(fcntl, "F_SEAL_WRITE", 0)
    | getattr(fcntl, "F_SEAL_GROW", 0)
    | getattr(fcntl, "F_SEAL_SHRINK", 0)
    | getattr(fcntl, "F_SEAL_SEAL", 0)
)

_HASH = re.compile(r"^[a-f0-9]{64}$")
_OPAQUE = re.compile(r"^[A-Za-z0-9_-]{20,160}$")
_LANGUAGE = re.compile(r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$")
_CONTENT_TYPES = frozenset({"audio/ogg", "audio/opus", "audio/webm"})


class WorkerFailure(Exception):
    """Stable refusal without vendor, secret, or response detail."""

    def __init__(self, code: str, *, attempted: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.attempted = attempted


@dataclass(frozen=True)
class WorkerPolicy:
    expected_broker_pid: int
    expected_broker_uid: int
    installation_hash: str
    credential_handle: str
    credential_path: Path
    credential_owner_uid: int
    credential_owner_gid: int
    timeout_seconds: float = 120.0

    def validate(self) -> None:
        if (
            isinstance(self.expected_broker_pid, bool)
            or not isinstance(self.expected_broker_pid, int)
            or self.expected_broker_pid < 1
            or isinstance(self.expected_broker_uid, bool)
            or not isinstance(self.expected_broker_uid, int)
            or self.expected_broker_uid < 0
            or not isinstance(self.installation_hash, str)
            or _HASH.fullmatch(self.installation_hash) is None
            or not isinstance(self.credential_handle, str)
            or _OPAQUE.fullmatch(self.credential_handle) is None
            or not isinstance(self.credential_path, Path)
            or not self.credential_path.is_absolute()
            or self.credential_path.name != CREDENTIAL_NAME
            or isinstance(self.credential_owner_uid, bool)
            or not isinstance(self.credential_owner_uid, int)
            or self.credential_owner_uid < 0
            or isinstance(self.credential_owner_gid, bool)
            or not isinstance(self.credential_owner_gid, int)
            or self.credential_owner_gid < 0
            or isinstance(self.timeout_seconds, bool)
            or not isinstance(self.timeout_seconds, (int, float))
            or not math.isfinite(self.timeout_seconds)
            or not 1.0 <= self.timeout_seconds <= 120.0
        ):
            raise WorkerFailure("WORKER_POLICY_REFUSED")


@dataclass(frozen=True)
class TranscriptionClaim:
    installation_hash: str
    handle: str
    dispatch_permit_id: str
    audio_sha256: str
    audio_bytes: int
    content_type: str


class ConnectedSocket(Protocol):
    def send(self, data: memoryview) -> int: ...

    def recv_into(self, buffer: bytearray) -> int: ...

    def settimeout(self, timeout: float) -> None: ...

    def close(self) -> None: ...


Resolver = Callable[[str, int], Sequence[str]]
Connector = Callable[[str, str, float], ConnectedSocket]


def _zero(buffer: bytearray) -> None:
    buffer[:] = b"\0" * len(buffer)


def _object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise WorkerFailure("MALFORMED_FRAME")
        value[key] = item
    return value


def _decode_json(raw: bytes, *, bounds_code: str) -> object:
    if not raw or len(raw) > MAX_CONTROL_BYTES:
        raise WorkerFailure(bounds_code)
    try:
        return json.loads(raw, object_pairs_hook=_object_without_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError, WorkerFailure):
        raise WorkerFailure("MALFORMED_FRAME") from None


def decode_claim(raw: bytes, policy: WorkerPolicy) -> TranscriptionClaim:
    """Decode the exact root-issued envelope before touching a credential."""

    policy.validate()
    value = _decode_json(raw, bounds_code="FRAME_BOUNDS")
    fields = {
        "schemaVersion",
        "descriptorId",
        "installationHash",
        "handle",
        "dispatchPermitId",
        "audioSha256",
        "audioBytes",
        "contentType",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise WorkerFailure("MALFORMED_FRAME")
    audio_bytes = value["audioBytes"]
    if (
        isinstance(value["schemaVersion"], bool)
        or not isinstance(value["schemaVersion"], int)
        or value["schemaVersion"] != 1
        or value["descriptorId"] != DESCRIPTOR_ID
        or value["installationHash"] != policy.installation_hash
        or value["handle"] != policy.credential_handle
        or not isinstance(value["dispatchPermitId"], str)
        or _OPAQUE.fullmatch(value["dispatchPermitId"]) is None
        or not isinstance(value["audioSha256"], str)
        or _HASH.fullmatch(value["audioSha256"]) is None
        or isinstance(audio_bytes, bool)
        or not isinstance(audio_bytes, int)
        or not 1 <= audio_bytes <= MAX_AUDIO_BYTES
        or not isinstance(value["contentType"], str)
        or value["contentType"] not in _CONTENT_TYPES
    ):
        raise WorkerFailure("INVALID_REQUEST")
    return TranscriptionClaim(
        value["installationHash"],
        value["handle"],
        value["dispatchPermitId"],
        value["audioSha256"],
        audio_bytes,
        value["contentType"],
    )


def _close_descriptors(descriptors: Sequence[int]) -> None:
    for descriptor in descriptors:
        try:
            os.close(descriptor)
        except OSError:
            pass


def receive_claim(
    relay: socket.socket,
    policy: WorkerPolicy,
) -> tuple[TranscriptionClaim, int]:
    """Receive exactly one CLOEXEC sealed-memfd claim from the exact root peer."""

    policy.validate()
    descriptors: list[int] = []
    try:
        if (
            not hasattr(socket, "SO_PEERCRED")
            or not hasattr(socket, "MSG_CMSG_CLOEXEC")
            or relay.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE)
            != socket.SOCK_SEQPACKET
        ):
            raise WorkerFailure("RELAY_UNAVAILABLE")
        peer_raw = relay.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        peer_pid, peer_uid, _peer_gid = struct.unpack("3i", peer_raw)
        if (
            peer_pid != policy.expected_broker_pid
            or peer_uid != policy.expected_broker_uid
        ):
            raise WorkerFailure("BROKER_PEER_REFUSED")
        raw, ancillary, flags, _address = relay.recvmsg(
            MAX_CONTROL_BYTES + 1,
            socket.CMSG_SPACE(array.array("i").itemsize * 2),
            socket.MSG_CMSG_CLOEXEC,
        )
        if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
            raise WorkerFailure("FRAME_BOUNDS")
        if len(ancillary) != 1:
            raise WorkerFailure("DESCRIPTOR_REFUSED")
        for level, kind, payload in ancillary:
            if level != socket.SOL_SOCKET or kind != socket.SCM_RIGHTS:
                raise WorkerFailure("DESCRIPTOR_REFUSED")
            received = array.array("i")
            if not payload or len(payload) % received.itemsize:
                raise WorkerFailure("DESCRIPTOR_REFUSED")
            received.frombytes(payload)
            descriptors.extend(received)
        if len(descriptors) != 1:
            raise WorkerFailure("DESCRIPTOR_REFUSED")
        descriptor = descriptors[0]
        if not fcntl.fcntl(descriptor, fcntl.F_GETFD) & fcntl.FD_CLOEXEC:
            raise WorkerFailure("DESCRIPTOR_REFUSED")
        claim = decode_claim(raw, policy)
        descriptors.clear()
        return claim, descriptor
    except WorkerFailure:
        _close_descriptors(descriptors)
        raise
    except (OSError, struct.error, ValueError):
        _close_descriptors(descriptors)
        raise WorkerFailure("RELAY_REFUSED") from None


def attest_audio(descriptor: int, claim: TranscriptionClaim) -> None:
    """Verify exact memfd seals, size, and digest before credential read."""

    scratch = bytearray(16 * 1024)
    try:
        if F_GET_SEALS is None or REQUIRED_MEMFD_SEALS == 0:
            raise WorkerFailure("AUDIO_UNAVAILABLE")
        if os.get_inheritable(descriptor):
            raise WorkerFailure("AUDIO_REFUSED")
        seals = fcntl.fcntl(descriptor, F_GET_SEALS)
        if seals != REQUIRED_MEMFD_SEALS:
            raise WorkerFailure("AUDIO_REFUSED")
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size != claim.audio_bytes:
            raise WorkerFailure("AUDIO_REFUSED")
        os.lseek(descriptor, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        total = 0
        while True:
            received = os.readv(descriptor, [scratch])
            if received == 0:
                break
            total += received
            if total > MAX_AUDIO_BYTES:
                raise WorkerFailure("AUDIO_REFUSED")
            digest.update(memoryview(scratch)[:received])
            _zero(scratch)
        after = os.fstat(descriptor)
        if (
            total != claim.audio_bytes
            or digest.hexdigest() != claim.audio_sha256
            or (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            )
            != (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
                before.st_ctime_ns,
            )
        ):
            raise WorkerFailure("AUDIO_REFUSED")
        os.lseek(descriptor, 0, os.SEEK_SET)
    except WorkerFailure:
        raise
    except OSError:
        raise WorkerFailure("AUDIO_REFUSED") from None
    finally:
        _zero(scratch)


def read_systemd_credential(policy: WorkerPolicy) -> bytearray:
    """Read one private systemd credential file into an owned zeroizable buffer."""

    policy.validate()
    descriptor = -1
    owned = bytearray()
    try:
        info = policy.credential_path.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise WorkerFailure("CREDENTIAL_REFUSED")
        descriptor = os.open(
            policy.credential_path,
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        )
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_dev != info.st_dev
            or opened.st_ino != info.st_ino
            or opened.st_nlink != 1
            or opened.st_uid != policy.credential_owner_uid
            or opened.st_gid != policy.credential_owner_gid
            or stat.S_IMODE(opened.st_mode) != 0o440
            or not 1 <= opened.st_size <= MAX_CREDENTIAL_BYTES
        ):
            raise WorkerFailure("CREDENTIAL_REFUSED")
        scratch = bytearray(4096)
        try:
            while len(owned) <= MAX_CREDENTIAL_BYTES:
                received = os.readv(descriptor, [scratch])
                if received == 0:
                    break
                owned.extend(memoryview(scratch)[:received])
                _zero(scratch)
        finally:
            _zero(scratch)
        after = os.fstat(descriptor)
        if (
            len(owned) != opened.st_size
            or (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            )
            != (
                opened.st_dev,
                opened.st_ino,
                opened.st_size,
                opened.st_mtime_ns,
                opened.st_ctime_ns,
            )
            or not all(0x20 < value < 0x7F for value in owned)
        ):
            raise WorkerFailure("CREDENTIAL_REFUSED")
        return owned
    except WorkerFailure:
        _zero(owned)
        raise
    except OSError:
        _zero(owned)
        raise WorkerFailure("CREDENTIAL_REFUSED") from None
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _encode_packet(value: dict[str, object]) -> bytes:
    try:
        raw = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
    except (TypeError, ValueError):
        raise WorkerFailure("RESULT_REFUSED") from None
    if not raw or len(raw) > MAX_CONTROL_BYTES:
        raise WorkerFailure("RESULT_REFUSED")
    return raw


class RelaySession:
    """Exact no-retry acknowledgement protocol with the root broker."""

    def __init__(self, relay: socket.socket, timeout_seconds: float) -> None:
        self.relay = relay
        self.timeout_seconds = timeout_seconds

    def _exchange(
        self, request: dict[str, object], expected: dict[str, object]
    ) -> None:
        raw = _encode_packet(request)
        self.relay.settimeout(self.timeout_seconds)
        try:
            sent = self.relay.send(raw)
            if sent != len(raw):
                raise WorkerFailure("BROKER_ACK_AMBIGUOUS", attempted=True)
            response, ancillary, flags, _address = self.relay.recvmsg(
                MAX_CONTROL_BYTES + 1,
                socket.CMSG_SPACE(array.array("i").itemsize),
                socket.MSG_CMSG_CLOEXEC,
            )
            descriptors: list[int] = []
            for level, kind, payload in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    received = array.array("i")
                    received.frombytes(
                        payload[: len(payload) - (len(payload) % received.itemsize)]
                    )
                    descriptors.extend(received)
            _close_descriptors(descriptors)
            if ancillary or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
                raise WorkerFailure("BROKER_ACK_AMBIGUOUS", attempted=True)
            try:
                value = _decode_json(response, bounds_code="BROKER_ACK_AMBIGUOUS")
            except WorkerFailure:
                raise WorkerFailure("BROKER_ACK_AMBIGUOUS", attempted=True) from None
            if value != expected:
                raise WorkerFailure("BROKER_ACK_AMBIGUOUS", attempted=True)
        except WorkerFailure as error:
            if error.attempted:
                raise
            raise WorkerFailure("BROKER_ACK_AMBIGUOUS", attempted=True) from None
        except OSError:
            raise WorkerFailure("BROKER_ACK_AMBIGUOUS", attempted=True) from None

    def mark_attempted(self, permit: str) -> None:
        self._exchange(
            {
                "schemaVersion": 1,
                "operation": "mark-attempted",
                "dispatchPermitId": permit,
            },
            {
                "schemaVersion": 1,
                "operation": "attempted",
                "dispatchPermitId": permit,
            },
        )

    def commit_result(self, permit: str, result: dict[str, object]) -> None:
        self._exchange(
            {
                "schemaVersion": 1,
                "operation": "commit-result",
                "dispatchPermitId": permit,
                "result": result,
            },
            {
                "schemaVersion": 1,
                "operation": "result-committed",
                "dispatchPermitId": permit,
            },
        )


def _default_resolver(host: str, port: int) -> Sequence[str]:
    return tuple(
        item[4][0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    )


def _default_connector(address: str, hostname: str, timeout: float) -> ConnectedSocket:
    ip = ipaddress.ip_address(address)
    family = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
    raw = socket.socket(family, socket.SOCK_STREAM | getattr(socket, "SOCK_CLOEXEC", 0))
    raw.settimeout(timeout)
    try:
        target: tuple[object, ...] = (
            (address, UPSTREAM_PORT, 0, 0)
            if family == socket.AF_INET6
            else (address, UPSTREAM_PORT)
        )
        raw.connect(target)
        return ssl.create_default_context().wrap_socket(raw, server_hostname=hostname)
    except BaseException:
        raw.close()
        raise


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise WorkerFailure("TRANSCRIPTION_TIMEOUT", attempted=True)
    return remaining


def _send_all(connection: ConnectedSocket, data: memoryview, deadline: float) -> None:
    offset = 0
    while offset < len(data):
        connection.settimeout(_remaining(deadline))
        sent = connection.send(data[offset:])
        if sent <= 0 or sent > len(data) - offset:
            raise WorkerFailure("TRANSCRIPTION_TRANSPORT_REFUSED", attempted=True)
        offset += sent


def _decode_chunked(body: bytes) -> bytes:
    output = bytearray()
    offset = 0
    try:
        while True:
            line_end = body.find(b"\r\n", offset)
            if line_end < 0 or line_end - offset > 16:
                raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True)
            size_raw = body[offset:line_end]
            if not size_raw or b";" in size_raw:
                raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True)
            if re.fullmatch(rb"[0-9A-Fa-f]+", size_raw) is None:
                raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True)
            size = int(size_raw, 16)
            offset = line_end + 2
            if size == 0:
                if body[offset:] != b"\r\n":
                    raise WorkerFailure(
                        "TRANSCRIPTION_RESPONSE_REFUSED", attempted=True
                    )
                return bytes(output)
            if size > MAX_RESPONSE_BODY - len(output):
                raise WorkerFailure("TRANSCRIPTION_RESPONSE_BOUNDS", attempted=True)
            end = offset + size
            if end + 2 > len(body) or body[end : end + 2] != b"\r\n":
                raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True)
            output.extend(body[offset:end])
            offset = end + 2
    finally:
        _zero(output)


def _http_body(response: bytearray) -> bytes:
    header_end = response.find(b"\r\n\r\n")
    line_end = response.find(b"\r\n")
    if (
        header_end < 0
        or header_end > MAX_RESPONSE_HEADERS
        or line_end < 12
        or response[:9] != b"HTTP/1.1 "
        or not all(48 <= value <= 57 for value in response[9:12])
        or (line_end > 12 and response[12] != 0x20)
    ):
        raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True)
    status = int(response[9:12])
    if status in {401, 403}:
        raise WorkerFailure("AUTH_REJECTED", attempted=True)
    if status == 429:
        raise WorkerFailure("QUOTA_EXCEEDED", attempted=True)
    if status != 200:
        raise WorkerFailure("TRANSCRIPTION_REFUSED", attempted=True)
    headers: dict[str, str] = {}
    header_block = response[line_end + 2 : header_end]
    for raw_line in header_block.split(b"\r\n") if header_block else ():
        if not raw_line or raw_line[:1] in b" \t" or b":" not in raw_line:
            raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True)
        name_raw, value_raw = raw_line.split(b":", 1)
        try:
            name = name_raw.decode("ascii").lower()
            value = value_raw.decode("ascii").strip()
        except UnicodeDecodeError:
            raise WorkerFailure(
                "TRANSCRIPTION_RESPONSE_REFUSED", attempted=True
            ) from None
        if (
            not name
            or name in headers
            or not re.fullmatch(r"[a-z0-9-]+", name)
            or any(ord(character) < 0x20 and character != "\t" for character in value)
            or any(ord(character) == 0x7F for character in value)
        ):
            raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True)
        headers[name] = value
    encoded_body = bytes(response[header_end + 4 :])
    transfer = headers.get("transfer-encoding")
    length = headers.get("content-length")
    if transfer is not None:
        if transfer.lower() != "chunked" or length is not None:
            raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True)
        decoded = _decode_chunked(encoded_body)
    elif length is not None:
        if not length.isascii() or not length.isdigit():
            raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True)
        expected = int(length)
        if expected != len(encoded_body):
            raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True)
        decoded = encoded_body
    else:
        decoded = encoded_body
    if not decoded or len(decoded) > MAX_RESPONSE_BODY:
        raise WorkerFailure("TRANSCRIPTION_RESPONSE_BOUNDS", attempted=True)
    return decoded


def _typed_result(body: bytes) -> dict[str, object]:
    try:
        value = json.loads(body, object_pairs_hook=_object_without_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError, WorkerFailure):
        raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True) from None
    try:
        metadata = value["metadata"]
        results = value["results"]
        channel = results["channels"][0]
        alternative = channel["alternatives"][0]
        transcript = alternative["transcript"]
        duration = metadata["duration"]
        language = channel.get("detected_language")
    except (KeyError, IndexError, TypeError):
        raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True) from None
    if (
            not isinstance(transcript, str)
            or "\x00" in transcript
        or len(transcript.encode()) > MAX_TRANSCRIPT_BYTES
        or isinstance(duration, bool)
        or not isinstance(duration, (int, float))
        or not math.isfinite(duration)
        or duration < 0
    ):
        raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True)
    duration_ms = round(duration * 1000)
    if duration_ms > MAX_DURATION_MS:
        raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True)
    result: dict[str, object] = {
        "ok": True,
        "transcript": transcript,
        "durationMs": duration_ms,
    }
    if language is not None:
        if (
            not isinstance(language, str)
            or len(language.encode()) > MAX_LANGUAGE_BYTES
            or _LANGUAGE.fullmatch(language) is None
        ):
            raise WorkerFailure("TRANSCRIPTION_RESPONSE_REFUSED", attempted=True)
        result["language"] = language
    return result


def transcribe_once(
    claim: TranscriptionClaim,
    audio_descriptor: int,
    credential: bytearray,
    relay: RelaySession,
    *,
    resolver: Resolver = _default_resolver,
    connector: Connector = _default_connector,
    timeout_seconds: float = 120.0,
) -> dict[str, object]:
    """Mark attempted once, then issue one fixed HTTPS POST without retry."""

    if (
        not credential
        or len(credential) > MAX_CREDENTIAL_BYTES
        or not all(0x20 < value < 0x7F for value in credential)
        or isinstance(timeout_seconds, bool)
        or not isinstance(timeout_seconds, (int, float))
        or not math.isfinite(timeout_seconds)
        or not 1.0 <= timeout_seconds <= 120.0
    ):
        raise WorkerFailure("CREDENTIAL_REFUSED")
    try:
        os.lseek(audio_descriptor, 0, os.SEEK_SET)
    except OSError:
        raise WorkerFailure("AUDIO_REFUSED") from None
    relay.mark_attempted(claim.dispatch_permit_id)
    deadline = time.monotonic() + timeout_seconds
    try:
        resolved = tuple(resolver(UPSTREAM_HOST, UPSTREAM_PORT))
        addresses = tuple(ipaddress.ip_address(value) for value in resolved)
    except (OSError, TypeError, ValueError):
        raise WorkerFailure("TRANSCRIPTION_ADDRESS_REFUSED", attempted=True) from None
    if not addresses or any(not address.is_global for address in addresses):
        raise WorkerFailure("TRANSCRIPTION_ADDRESS_REFUSED", attempted=True)
    selected = str(min(set(addresses), key=lambda value: (value.version, value.packed)))
    header = bytearray(f"POST {UPSTREAM_PATH} HTTP/1.1\r\n".encode("ascii"))
    header.extend(f"Host: {UPSTREAM_HOST}\r\n".encode("ascii"))
    header.extend(b"Authorization: Token ")
    header.extend(credential)
    header.extend(f"\r\nContent-Type: {claim.content_type}\r\n".encode("ascii"))
    header.extend(f"Content-Length: {claim.audio_bytes}\r\n".encode("ascii"))
    header.extend(b"Accept: application/json\r\nConnection: close\r\n\r\n")
    response = bytearray()
    scratch = bytearray(16 * 1024)
    connection: ConnectedSocket | None = None
    try:
        connection = connector(selected, UPSTREAM_HOST, _remaining(deadline))
        _send_all(connection, memoryview(header), deadline)
        sent_audio = 0
        while sent_audio < claim.audio_bytes:
            received = os.readv(audio_descriptor, [scratch])
            if received == 0:
                raise WorkerFailure("AUDIO_REFUSED", attempted=True)
            _send_all(connection, memoryview(scratch)[:received], deadline)
            sent_audio += received
            _zero(scratch)
        if sent_audio != claim.audio_bytes:
            raise WorkerFailure("AUDIO_REFUSED", attempted=True)
        while True:
            connection.settimeout(_remaining(deadline))
            received = connection.recv_into(scratch)
            if received == 0:
                break
            response.extend(memoryview(scratch)[:received])
            _zero(scratch)
            if len(response) > MAX_RESPONSE_HEADERS + MAX_RESPONSE_BODY:
                raise WorkerFailure("TRANSCRIPTION_RESPONSE_BOUNDS", attempted=True)
        return _typed_result(_http_body(response))
    except WorkerFailure:
        raise
    except (OSError, ssl.SSLError, TimeoutError):
        raise WorkerFailure("TRANSCRIPTION_TRANSPORT_REFUSED", attempted=True) from None
    finally:
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass
        _zero(header)
        _zero(response)
        _zero(scratch)


def error_result(error: WorkerFailure) -> dict[str, object]:
    return {
        "ok": False,
        "code": error.code,
        "dispatch": "attempted" if error.attempted else "none",
    }


def run_one_shot(
    relay_socket: socket.socket,
    policy: WorkerPolicy,
    *,
    resolver: Resolver = _default_resolver,
    connector: Connector = _default_connector,
) -> dict[str, object]:
    """Consume one relay request, commit one typed result, and release all ownership."""

    audio_descriptor = -1
    credential = bytearray()
    claim: TranscriptionClaim | None = None
    session = RelaySession(relay_socket, policy.timeout_seconds)
    try:
        try:
            claim, audio_descriptor = receive_claim(relay_socket, policy)
            attest_audio(audio_descriptor, claim)
            credential = read_systemd_credential(policy)
            result = transcribe_once(
                claim,
                audio_descriptor,
                credential,
                session,
                resolver=resolver,
                connector=connector,
                timeout_seconds=policy.timeout_seconds,
            )
        except WorkerFailure as error:
            if claim is None or error.code == "BROKER_ACK_AMBIGUOUS":
                raise
            result = error_result(error)
        if claim is None:
            raise WorkerFailure("INVALID_REQUEST")
        session.commit_result(claim.dispatch_permit_id, result)
        return result
    finally:
        _zero(credential)
        if audio_descriptor >= 0:
            try:
                os.close(audio_descriptor)
            except OSError:
                pass
        try:
            relay_socket.close()
        except OSError:
            pass
