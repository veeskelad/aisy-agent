"""Exact bounded protocol and provider descriptors for the native API broker."""

from __future__ import annotations

import json
import re
import struct
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 8 * 1024 * 1024
MAX_CONTROL_BYTES = 64 * 1024
MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_HEADER_BYTES = 16 * 1024

FRAME_HEADER = b"H"
FRAME_DATA = b"D"
FRAME_END = b"E"
FRAME_ERROR = b"X"
FRAME_ATTEMPTED = b"A"
FRAME_ATTEMPTED_ACK = b"K"

_HASH = re.compile(r"^[a-f0-9]{64}$")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{20,160}$")
_HEADER_NAME = re.compile(r"^[a-z0-9-]{1,64}$")


class ProviderProtocolFailure(Exception):
    """Stable refusal that contains no provider response or credential material."""


@dataclass(frozen=True)
class ProviderDescriptor:
    provider_id: str
    descriptor_id: str
    host: str
    path: str
    auth_header: str
    auth_prefix: str
    validation_method: str
    validation_path: str
    validation_body: bytes
    validation_statuses: tuple[int, ...]
    fixed_headers: tuple[tuple[str, str], ...] = ()


DESCRIPTORS: tuple[ProviderDescriptor, ...] = (
    ProviderDescriptor(
        "openai",
        "openai.chat-completions.v1",
        "api.openai.com",
        "/v1/chat/completions",
        "authorization",
        "Bearer ",
        "GET",
        "/v1/models",
        b"",
        (200,),
    ),
    ProviderDescriptor(
        "anthropic",
        "anthropic.messages.v1",
        "api.anthropic.com",
        "/v1/messages",
        "x-api-key",
        "",
        "GET",
        "/v1/models",
        b"",
        (200,),
        (("anthropic-version", "2023-06-01"),),
    ),
    ProviderDescriptor(
        "openrouter",
        "openrouter.chat-completions.v1",
        "openrouter.ai",
        "/api/v1/chat/completions",
        "authorization",
        "Bearer ",
        "GET",
        "/api/v1/key",
        b"",
        (200,),
    ),
    ProviderDescriptor(
        "deepseek",
        "deepseek.chat-completions.v1",
        "api.deepseek.com",
        "/v1/chat/completions",
        "authorization",
        "Bearer ",
        "GET",
        "/models",
        b"",
        (200,),
    ),
    ProviderDescriptor(
        "qwen",
        "qwen.chat-completions.v1",
        "dashscope.aliyuncs.com",
        "/compatible-mode/v1/chat/completions",
        "authorization",
        "Bearer ",
        "POST",
        "/compatible-mode/v1/chat/completions",
        b'{"model":"aisy-validation-invalid","messages":[{"role":"user","content":"x"}]}',
        (400, 402, 404, 422, 429),
    ),
    ProviderDescriptor(
        "glm",
        "glm.chat-completions.v1",
        "open.bigmodel.cn",
        "/api/paas/v4/chat/completions",
        "authorization",
        "Bearer ",
        "POST",
        "/api/paas/v4/chat/completions",
        b'{"model":"aisy-validation-invalid","messages":[{"role":"user","content":"x"}]}',
        (400, 402, 404, 422, 429),
    ),
    ProviderDescriptor(
        "gemini",
        "gemini.chat-completions.v1",
        "generativelanguage.googleapis.com",
        "/v1beta/openai/chat/completions",
        "authorization",
        "Bearer ",
        "GET",
        "/v1beta/openai/models",
        b"",
        (200,),
    ),
)

DESCRIPTOR_BY_ID = {item.descriptor_id: item for item in DESCRIPTORS}
DESCRIPTOR_BY_PROVIDER = {item.provider_id: item for item in DESCRIPTORS}


@dataclass(frozen=True)
class ProviderRequest:
    request_id: str
    descriptor: ProviderDescriptor
    body_length: int
    body_sha256: str
    deadline_ms: int
    headers: tuple[tuple[str, str], ...]


def _object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ProviderProtocolFailure("MALFORMED_FRAME")
        value[key] = item
    return value


def encode_frame(kind: bytes, payload: bytes = b"") -> bytes:
    if kind not in {
        FRAME_HEADER,
        FRAME_DATA,
        FRAME_END,
        FRAME_ERROR,
        FRAME_ATTEMPTED,
        FRAME_ATTEMPTED_ACK,
    }:
        raise ProviderProtocolFailure("FRAME_KIND_REFUSED")
    if kind == FRAME_END and payload:
        raise ProviderProtocolFailure("FRAME_BOUNDS")
    if len(payload) > MAX_FRAME_BYTES:
        raise ProviderProtocolFailure("FRAME_BOUNDS")
    return struct.pack(">I", len(payload) + 1) + kind + payload


def decode_frame(raw: bytes) -> tuple[bytes, bytes]:
    if len(raw) < 5:
        raise ProviderProtocolFailure("FRAME_BOUNDS")
    declared = struct.unpack(">I", raw[:4])[0]
    if declared < 1 or declared > MAX_FRAME_BYTES + 1 or len(raw) != declared + 4:
        raise ProviderProtocolFailure("FRAME_BOUNDS")
    kind = raw[4:5]
    payload = raw[5:]
    encode_frame(kind, payload)
    return kind, payload


def encode_json_frame(kind: bytes, value: dict[str, object]) -> bytes:
    try:
        payload = json.dumps(
            value,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError):
        raise ProviderProtocolFailure("MALFORMED_FRAME") from None
    if not payload or len(payload) > MAX_CONTROL_BYTES:
        raise ProviderProtocolFailure("FRAME_BOUNDS")
    return encode_frame(kind, payload)


def decode_json(payload: bytes) -> dict[str, object]:
    if not payload or len(payload) > MAX_CONTROL_BYTES:
        raise ProviderProtocolFailure("FRAME_BOUNDS")
    try:
        value = json.loads(payload, object_pairs_hook=_object_without_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError, ProviderProtocolFailure):
        raise ProviderProtocolFailure("MALFORMED_FRAME") from None
    if not isinstance(value, dict):
        raise ProviderProtocolFailure("MALFORMED_FRAME")
    return value


def decode_request_header(payload: bytes) -> ProviderRequest:
    value = decode_json(payload)
    fields = {
        "schemaVersion",
        "requestId",
        "descriptorId",
        "method",
        "contentType",
        "bodyLength",
        "bodySha256",
        "deadlineMs",
        "headers",
    }
    if set(value) != fields:
        raise ProviderProtocolFailure("MALFORMED_FRAME")
    descriptor_id = value["descriptorId"]
    descriptor = (
        DESCRIPTOR_BY_ID.get(descriptor_id)
        if isinstance(descriptor_id, str)
        else None
    )
    body_length = value["bodyLength"]
    deadline_ms = value["deadlineMs"]
    if (
        isinstance(value["schemaVersion"], bool)
        or not isinstance(value["schemaVersion"], int)
        or value["schemaVersion"] != PROTOCOL_VERSION
        or not isinstance(value["requestId"], str)
        or _REQUEST_ID.fullmatch(value["requestId"]) is None
        or descriptor is None
        or value["method"] != "POST"
        or value["contentType"] != "application/json"
        or isinstance(body_length, bool)
        or not isinstance(body_length, int)
        or not 1 <= body_length <= MAX_REQUEST_BYTES
        or not isinstance(value["bodySha256"], str)
        or _HASH.fullmatch(value["bodySha256"]) is None
        or isinstance(deadline_ms, bool)
        or not isinstance(deadline_ms, int)
        or not 1_000 <= deadline_ms <= 120_000
        or not isinstance(value["headers"], dict)
    ):
        raise ProviderProtocolFailure("INVALID_REQUEST")
    headers: list[tuple[str, str]] = []
    for name, header_value in value["headers"].items():
        if (
            not isinstance(name, str)
            or _HEADER_NAME.fullmatch(name) is None
            or not isinstance(header_value, str)
            or len(header_value.encode("utf-8")) > 4096
            or "\r" in header_value
            or "\n" in header_value
        ):
            raise ProviderProtocolFailure("INVALID_REQUEST")
        lowered = name.lower()
        if lowered in {
            "authorization",
            "x-api-key",
            "proxy-authorization",
            "cookie",
            "host",
            "content-length",
            "transfer-encoding",
            "connection",
        }:
            raise ProviderProtocolFailure("CALLER_HEADER_REFUSED")
        headers.append((lowered, header_value))
    if sum(len(name) + len(item) + 4 for name, item in headers) > MAX_HEADER_BYTES:
        raise ProviderProtocolFailure("HEADER_BOUNDS")
    return ProviderRequest(
        value["requestId"],
        descriptor,
        body_length,
        value["bodySha256"],
        deadline_ms,
        tuple(sorted(headers)),
    )


def response_header(status: int, content_type: str | None) -> bytes:
    if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599:
        raise ProviderProtocolFailure("INVALID_RESPONSE")
    if content_type is not None and (
        not isinstance(content_type, str)
        or len(content_type) > 256
        or "\r" in content_type
        or "\n" in content_type
    ):
        raise ProviderProtocolFailure("INVALID_RESPONSE")
    return encode_json_frame(
        FRAME_HEADER,
        {
            "schemaVersion": PROTOCOL_VERSION,
            "status": status,
            "headers": {} if content_type is None else {"content-type": content_type},
        },
    )


def error_frame(code: str, *, attempted: bool) -> bytes:
    if not re.fullmatch(r"[A-Z][A-Z0-9_]{2,63}", code):
        raise ProviderProtocolFailure("INVALID_RESPONSE")
    return encode_json_frame(
        FRAME_ERROR,
        {"schemaVersion": PROTOCOL_VERSION, "code": code, "attempted": attempted},
    )
