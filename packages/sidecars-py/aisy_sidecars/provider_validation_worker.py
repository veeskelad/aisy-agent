"""One-shot network worker for status-only provider material validation."""

from __future__ import annotations

import hashlib
import http.client
import math
import socket
import ssl
import struct
import time
from dataclasses import dataclass

from .provider_broker_protocol import (
    DESCRIPTOR_BY_PROVIDER,
    FRAME_DATA,
    FRAME_END,
    FRAME_HEADER,
    MAX_HEADER_BYTES,
    ProviderProtocolFailure,
    decode_json,
    encode_frame,
    encode_json_frame,
    error_frame,
)
from .provider_worker import (
    ConnectedSocket,
    Connector,
    ProviderWorkerFailure,
    Resolver,
    _default_connector,
    _default_resolver,
    _public_addresses,
    receive_frame,
)

MAX_MATERIAL_BYTES = 8 * 1024


class ProviderValidationFailure(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ValidationRequest:
    provider_id: str
    material_length: int
    material_sha256: str
    deadline_ms: int


def _zero(value: bytearray) -> None:
    value[:] = b"\0" * len(value)


def _request(payload: bytes) -> ValidationRequest:
    try:
        value = decode_json(payload)
    except ProviderProtocolFailure as error:
        raise ProviderValidationFailure(str(error)) from None
    if set(value) != {
        "schemaVersion", "providerId", "materialLength", "materialSha256", "deadlineMs",
    }:
        raise ProviderValidationFailure("VALIDATION_FRAME_REFUSED")
    length = value["materialLength"]
    deadline = value["deadlineMs"]
    digest = value["materialSha256"]
    if (
        value["schemaVersion"] != 1
        or not isinstance(value["providerId"], str)
        or value["providerId"] not in DESCRIPTOR_BY_PROVIDER
        or isinstance(length, bool)
        or not isinstance(length, int)
        or not 1 <= length <= MAX_MATERIAL_BYTES
        or not isinstance(digest, str)
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
        or isinstance(deadline, bool)
        or not isinstance(deadline, int)
        or not 1_000 <= deadline <= 30_000
    ):
        raise ProviderValidationFailure("VALIDATION_FRAME_REFUSED")
    return ValidationRequest(value["providerId"], length, digest, deadline)


def _peer(connection: socket.socket, expected_uid: int) -> None:
    try:
        if not hasattr(socket, "SO_PEERCRED"):
            raise OSError
        raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        _pid, uid, _gid = struct.unpack("3i", raw)
        if uid != expected_uid:
            raise OSError
    except (OSError, struct.error):
        raise ProviderValidationFailure("VALIDATOR_PEER_REFUSED") from None


def _read_exact_into(connection: socket.socket, target: memoryview) -> None:
    offset = 0
    while offset < len(target):
        read = connection.recv_into(target[offset:])
        if read <= 0:
            raise ProviderValidationFailure("VALIDATION_FRAME_REFUSED")
        offset += read


def receive_material(connection: socket.socket) -> tuple[ValidationRequest, bytearray]:
    material = bytearray()
    frame_header = bytearray(5)
    try:
        kind, payload = receive_frame(connection)
        if kind != FRAME_HEADER:
            raise ProviderValidationFailure("VALIDATION_FRAME_REFUSED")
        request = _request(payload)
        material = bytearray(request.material_length)
        offset = 0
        while True:
            _read_exact_into(connection, memoryview(frame_header))
            size = struct.unpack(">I", frame_header[:4])[0]
            frame_kind = frame_header[4]
            if size < 1 or size > MAX_MATERIAL_BYTES + 1:
                raise ProviderValidationFailure("VALIDATION_FRAME_REFUSED")
            payload_size = size - 1
            if frame_kind == FRAME_END[0] and payload_size == 0:
                break
            if (
                frame_kind != FRAME_DATA[0]
                or payload_size < 1
                or offset + payload_size > request.material_length
            ):
                raise ProviderValidationFailure("VALIDATION_FRAME_REFUSED")
            _read_exact_into(
                connection,
                memoryview(material)[offset : offset + payload_size],
            )
            offset += payload_size
        if (
            offset != request.material_length
            or hashlib.sha256(material).hexdigest() != request.material_sha256
            or any(value <= 0x20 or value >= 0x7F for value in material)
        ):
            raise ProviderValidationFailure("MATERIAL_REFUSED")
        return request, material
    except ProviderWorkerFailure as error:
        _zero(material)
        raise ProviderValidationFailure(str(error)) from None
    except BaseException:
        _zero(material)
        raise
    finally:
        _zero(frame_header)


def _head(request: ValidationRequest, material: bytearray) -> bytearray:
    descriptor = DESCRIPTOR_BY_PROVIDER[request.provider_id]
    body = descriptor.validation_body
    lines = [
        f"{descriptor.validation_method} {descriptor.validation_path} HTTP/1.1",
        f"Host: {descriptor.host}",
        "Accept: application/json",
        "Accept-Encoding: identity",
        "Connection: close",
    ]
    if body:
        lines.extend(("Content-Type: application/json", f"Content-Length: {len(body)}"))
    lines.extend(f"{name}: {value}" for name, value in descriptor.fixed_headers)
    output = bytearray(("\r\n".join(lines) + "\r\n").encode("ascii"))
    output.extend(f"{descriptor.auth_header}: {descriptor.auth_prefix}".encode("ascii"))
    output.extend(material)
    output.extend(b"\r\n\r\n")
    output.extend(body)
    return output


def validate_once(
    request: ValidationRequest,
    material: bytearray,
    *,
    resolver: Resolver = _default_resolver,
    connector: Connector = _default_connector,
) -> None:
    descriptor = DESCRIPTOR_BY_PROVIDER[request.provider_id]
    deadline = time.monotonic() + request.deadline_ms / 1000
    try:
        addresses = _public_addresses(resolver(descriptor.host, 443))
    except ProviderWorkerFailure as error:
        raise ProviderValidationFailure(str(error)) from None
    upstream: ConnectedSocket | None = None
    head = bytearray()
    try:
        remaining = deadline - time.monotonic()
        if not math.isfinite(remaining) or remaining <= 0:
            raise ProviderValidationFailure("VALIDATION_TIMEOUT")
        upstream = connector(addresses[0], descriptor.host, 443, remaining)
        head = _head(request, material)
        upstream.settimeout(max(0.001, deadline - time.monotonic()))
        upstream.sendall(head)
        response = http.client.HTTPResponse(upstream)  # type: ignore[arg-type]
        response.begin()
        header_size = sum(len(name) + len(value) + 4 for name, value in response.headers.items())
        if header_size > MAX_HEADER_BYTES:
            raise ProviderValidationFailure("VALIDATION_RESPONSE_REFUSED")
        if response.status not in descriptor.validation_statuses:
            raise ProviderValidationFailure("MATERIAL_REJECTED")
    except ProviderValidationFailure:
        raise
    except (OSError, ssl.SSLError, http.client.HTTPException, UnicodeError):
        raise ProviderValidationFailure("VALIDATION_TRANSPORT_REFUSED") from None
    finally:
        _zero(head)
        if upstream is not None:
            try:
                upstream.close()
            except OSError:
                pass


def run_one_shot(
    relay: socket.socket,
    provider_id: str,
    *,
    expected_broker_uid: int = 0,
    resolver: Resolver = _default_resolver,
    connector: Connector = _default_connector,
) -> None:
    material = bytearray()
    try:
        if provider_id not in DESCRIPTOR_BY_PROVIDER:
            raise ProviderValidationFailure("PROVIDER_BINDING_REFUSED")
        _peer(relay, expected_broker_uid)
        request, material = receive_material(relay)
        if request.provider_id != provider_id:
            raise ProviderValidationFailure("PROVIDER_BINDING_REFUSED")
        validate_once(request, material, resolver=resolver, connector=connector)
        relay.sendall(encode_json_frame(FRAME_HEADER, {"schemaVersion": 1, "state": "valid"}))
        relay.sendall(encode_frame(FRAME_END))
    except ProviderValidationFailure as error:
        try:
            relay.sendall(error_frame(error.code, attempted=False))
        except (OSError, ProviderProtocolFailure):
            pass
        raise
    finally:
        _zero(material)
