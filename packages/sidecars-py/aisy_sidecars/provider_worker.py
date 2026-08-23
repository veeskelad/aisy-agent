"""One-request native API worker behind the root provider broker."""

from __future__ import annotations

import hashlib
import http.client
import ipaddress
import math
import os
import socket
import ssl
import stat
import struct
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Protocol

from .provider_broker_protocol import (
    FRAME_ATTEMPTED,
    FRAME_ATTEMPTED_ACK,
    FRAME_DATA,
    FRAME_END,
    FRAME_HEADER,
    MAX_FRAME_BYTES,
    MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
    ProviderProtocolFailure,
    ProviderRequest,
    decode_frame,
    decode_request_header,
    encode_frame,
    error_frame,
    response_header,
)

MAX_CREDENTIAL_BYTES = 8 * 1024
READ_CHUNK_BYTES = 64 * 1024


class ProviderWorkerFailure(Exception):
    def __init__(self, code: str, *, attempted: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.attempted = attempted


@dataclass(frozen=True)
class ProviderWorkerPolicy:
    provider_id: str
    expected_broker_uid: int
    credential_path: Path
    credential_owner_uid: int
    credential_owner_gid: int
    timeout_seconds: float = 120.0

    def validate(self) -> None:
        if (
            not isinstance(self.provider_id, str)
            or not self.provider_id
            or isinstance(self.expected_broker_uid, bool)
            or not isinstance(self.expected_broker_uid, int)
            or self.expected_broker_uid < 0
            or not isinstance(self.credential_path, Path)
            or not self.credential_path.is_absolute()
            or self.credential_path.name != "aisy-provider"
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
            raise ProviderWorkerFailure("WORKER_POLICY_REFUSED")


class ConnectedSocket(Protocol):
    def sendall(self, data: bytes | memoryview) -> None: ...

    def makefile(self, mode: str) -> BinaryIO: ...

    def settimeout(self, value: float) -> None: ...

    def close(self) -> None: ...


Resolver = Callable[[str, int], Sequence[str]]
Connector = Callable[[str, str, int, float], ConnectedSocket]


def _zero(buffer: bytearray) -> None:
    buffer[:] = b"\0" * len(buffer)


def _recv_exact(connection: socket.socket, size: int) -> bytes:
    if size < 0 or size > MAX_FRAME_BYTES + 1:
        raise ProviderWorkerFailure("FRAME_BOUNDS")
    output = bytearray(size)
    view = memoryview(output)
    offset = 0
    try:
        while offset < size:
            received = connection.recv_into(view[offset:])
            if received <= 0:
                raise ProviderWorkerFailure("FRAME_TRUNCATED")
            offset += received
        return bytes(output)
    finally:
        view.release()
        _zero(output)


def receive_frame(connection: socket.socket) -> tuple[bytes, bytes]:
    prefix = _recv_exact(connection, 4)
    declared = struct.unpack(">I", prefix)[0]
    raw = prefix + _recv_exact(connection, declared)
    try:
        return decode_frame(raw)
    except ProviderProtocolFailure as error:
        raise ProviderWorkerFailure(str(error)) from None


def send_frame(connection: socket.socket, kind: bytes, payload: bytes = b"") -> None:
    try:
        connection.sendall(encode_frame(kind, payload))
    except ProviderProtocolFailure as error:
        raise ProviderWorkerFailure(str(error)) from None
    except OSError:
        raise ProviderWorkerFailure("BROKER_CHANNEL_LOST") from None


def receive_request(connection: socket.socket) -> tuple[ProviderRequest, bytearray]:
    kind, payload = receive_frame(connection)
    if kind != FRAME_HEADER:
        raise ProviderWorkerFailure("MALFORMED_FRAME")
    try:
        request = decode_request_header(payload)
    except ProviderProtocolFailure as error:
        raise ProviderWorkerFailure(str(error)) from None
    body = bytearray()
    digest = hashlib.sha256()
    try:
        while True:
            kind, payload = receive_frame(connection)
            if kind == FRAME_END:
                break
            if kind != FRAME_DATA or not payload:
                raise ProviderWorkerFailure("MALFORMED_FRAME")
            if len(body) + len(payload) > MAX_REQUEST_BYTES:
                raise ProviderWorkerFailure("REQUEST_BOUNDS")
            body.extend(payload)
            digest.update(payload)
        if len(body) != request.body_length or digest.hexdigest() != request.body_sha256:
            raise ProviderWorkerFailure("REQUEST_DIGEST_REFUSED")
        return request, body
    except BaseException:
        _zero(body)
        raise


def attest_peer(connection: socket.socket, expected_uid: int) -> None:
    try:
        if not hasattr(socket, "SO_PEERCRED"):
            raise OSError
        raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        _pid, uid, _gid = struct.unpack("3i", raw)
        if uid != expected_uid:
            raise OSError
    except (OSError, struct.error):
        raise ProviderWorkerFailure("BROKER_PEER_REFUSED") from None


def read_systemd_credential(policy: ProviderWorkerPolicy) -> bytearray:
    policy.validate()
    descriptor = -1
    owned = bytearray()
    try:
        before = policy.credential_path.lstat()
        if not stat.S_ISREG(before.st_mode):
            raise OSError
        descriptor = os.open(
            policy.credential_path,
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        )
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
            or opened.st_nlink != 1
            or opened.st_uid != policy.credential_owner_uid
            or opened.st_gid != policy.credential_owner_gid
            or stat.S_IMODE(opened.st_mode) != 0o440
            or not 1 <= opened.st_size <= MAX_CREDENTIAL_BYTES
        ):
            raise OSError
        while len(owned) <= MAX_CREDENTIAL_BYTES:
            chunk = os.read(descriptor, min(4096, MAX_CREDENTIAL_BYTES + 1 - len(owned)))
            if not chunk:
                break
            owned.extend(chunk)
        after = os.fstat(descriptor)
        if (
            len(owned) != opened.st_size
            or (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
            or not all(0x20 < value < 0x7F for value in owned)
        ):
            raise OSError
        return owned
    except OSError:
        _zero(owned)
        raise ProviderWorkerFailure("CREDENTIAL_REFUSED") from None
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _default_resolver(host: str, port: int) -> Sequence[str]:
    return tuple(item[4][0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM))


def _default_connector(address: str, hostname: str, port: int, timeout: float) -> ConnectedSocket:
    ip = ipaddress.ip_address(address)
    family = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
    raw = socket.socket(family, socket.SOCK_STREAM | getattr(socket, "SOCK_CLOEXEC", 0))
    raw.settimeout(timeout)
    try:
        target: tuple[object, ...] = (address, port, 0, 0) if family == socket.AF_INET6 else (address, port)
        raw.connect(target)
        return ssl.create_default_context().wrap_socket(raw, server_hostname=hostname)
    except BaseException:
        raw.close()
        raise


def _public_addresses(addresses: Sequence[str]) -> tuple[str, ...]:
    result: set[str] = set()
    try:
        for value in addresses:
            address = ipaddress.ip_address(value)
            if not address.is_global:
                raise ProviderWorkerFailure("DESTINATION_REFUSED")
            result.add(address.compressed)
    except ValueError:
        raise ProviderWorkerFailure("DESTINATION_REFUSED") from None
    if not result:
        raise ProviderWorkerFailure("DESTINATION_REFUSED")
    return tuple(sorted(result))


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProviderWorkerFailure("PROVIDER_TIMEOUT", attempted=True)
    return remaining


def _request_head(request: ProviderRequest, credential: bytearray) -> bytes:
    descriptor = request.descriptor
    lines = [
        f"POST {descriptor.path} HTTP/1.1",
        f"Host: {descriptor.host}",
        "Content-Type: application/json",
        f"Content-Length: {request.body_length}",
        "Accept-Encoding: identity",
        "Connection: close",
        f"{descriptor.auth_header}: {descriptor.auth_prefix}{credential.decode('ascii')}",
    ]
    fixed_names = {name for name, _value in descriptor.fixed_headers}
    lines.extend(f"{name}: {value}" for name, value in descriptor.fixed_headers)
    lines.extend(
        f"{name}: {value}"
        for name, value in request.headers
        if name not in fixed_names and name not in {"content-type", "accept-encoding"}
    )
    return ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")


def _attempt_handshake(relay: socket.socket) -> None:
    send_frame(relay, FRAME_ATTEMPTED)
    kind, payload = receive_frame(relay)
    if kind != FRAME_ATTEMPTED_ACK or payload:
        raise ProviderWorkerFailure("ATTEMPT_ACK_AMBIGUOUS", attempted=True)


def _stream_response(
    relay: socket.socket,
    upstream: ConnectedSocket,
    response: http.client.HTTPResponse,
    deadline: float,
) -> None:
    content_type = response.headers.get("content-type")
    send_frame(relay, FRAME_HEADER, response_header(response.status, content_type)[5:])
    total = 0
    while True:
        upstream.settimeout(_remaining(deadline))
        chunk = response.read(READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_RESPONSE_BYTES:
            raise ProviderWorkerFailure("RESPONSE_BOUNDS", attempted=True)
        send_frame(relay, FRAME_DATA, chunk)
    send_frame(relay, FRAME_END)


def proxy_once(
    relay: socket.socket,
    request: ProviderRequest,
    body: bytearray,
    material: bytearray,
    *,
    resolver: Resolver = _default_resolver,
    connector: Connector = _default_connector,
) -> None:
    deadline = time.monotonic() + request.deadline_ms / 1000
    addresses = _public_addresses(resolver(request.descriptor.host, 443))
    _attempt_handshake(relay)
    upstream: ConnectedSocket | None = None
    head = bytearray()
    try:
        upstream = connector(addresses[0], request.descriptor.host, 443, _remaining(deadline))
        head.extend(_request_head(request, material))
        upstream.settimeout(_remaining(deadline))
        upstream.sendall(head)
        upstream.sendall(body)
        response = http.client.HTTPResponse(upstream)  # type: ignore[arg-type]
        response.begin()
        _stream_response(relay, upstream, response, deadline)
    except ProviderWorkerFailure:
        raise
    except (OSError, ssl.SSLError, http.client.HTTPException, UnicodeError):
        raise ProviderWorkerFailure("PROVIDER_TRANSPORT_REFUSED", attempted=True) from None
    finally:
        _zero(head)
        if upstream is not None:
            try:
                upstream.close()
            except OSError:
                pass


def run_one_shot(
    relay: socket.socket,
    policy: ProviderWorkerPolicy,
    *,
    resolver: Resolver = _default_resolver,
    connector: Connector = _default_connector,
) -> None:
    policy.validate()
    body = bytearray()
    material = bytearray()
    try:
        attest_peer(relay, policy.expected_broker_uid)
        request, body = receive_request(relay)
        if request.descriptor.provider_id != policy.provider_id:
            raise ProviderWorkerFailure("PROVIDER_BINDING_REFUSED")
        material = read_systemd_credential(policy)
        proxy_once(relay, request, body, material, resolver=resolver, connector=connector)
    except ProviderWorkerFailure as error:
        try:
            relay.sendall(error_frame(error.code, attempted=error.attempted))
        except (OSError, ProviderProtocolFailure):
            pass
        raise
    finally:
        _zero(body)
        _zero(material)
