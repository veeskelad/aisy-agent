from __future__ import annotations

import hashlib
import json
import struct

import pytest

from aisy_sidecars.provider_broker_protocol import (
    DESCRIPTORS,
    FRAME_DATA,
    FRAME_END,
    FRAME_HEADER,
    MAX_FRAME_BYTES,
    ProviderProtocolFailure,
    decode_frame,
    decode_request_header,
    encode_frame,
    response_header,
)


def request_header(**changes: object) -> bytes:
    value: dict[str, object] = {
        "schemaVersion": 1,
        "requestId": "request_" + "a" * 32,
        "descriptorId": "openai.chat-completions.v1",
        "method": "POST",
        "contentType": "application/json",
        "bodyLength": 2,
        "bodySha256": hashlib.sha256(b"{}").hexdigest(),
        "deadlineMs": 60_000,
        "headers": {"accept": "application/json"},
    }
    value.update(changes)
    return json.dumps(value, separators=(",", ":")).encode()


def test_descriptors_are_unique_and_static_https_targets() -> None:
    assert len({item.provider_id for item in DESCRIPTORS}) == len(DESCRIPTORS) == 7
    assert len({item.descriptor_id for item in DESCRIPTORS}) == len(DESCRIPTORS)
    assert all(item.host and item.path.startswith("/") for item in DESCRIPTORS)
    assert all("?" not in item.path and "#" not in item.path for item in DESCRIPTORS)


def test_request_header_accepts_only_exact_descriptor_and_safe_headers() -> None:
    decoded = decode_request_header(request_header())
    assert decoded.descriptor.provider_id == "openai"
    assert decoded.body_length == 2
    assert decoded.headers == (("accept", "application/json"),)

    for changes in (
        {"schemaVersion": 1.0},
        {"descriptorId": "custom"},
        {"method": "GET"},
        {"contentType": "text/plain"},
        {"bodyLength": True},
        {"bodyLength": 0},
        {"deadlineMs": 999},
        {"headers": {"authorization": "Bearer caller-value"}},
        {"headers": {"x-api-key": "caller-value"}},
        {"headers": {"host": "internal.example"}},
        {"headers": {"x-ok": "line\r\nbreak"}},
        {"extension": True},
    ):
        with pytest.raises(ProviderProtocolFailure):
            decode_request_header(request_header(**changes))


def test_request_header_rejects_duplicate_fields() -> None:
    raw = request_header()
    duplicate = raw[:-1] + b',"bodyLength":2}'
    with pytest.raises(ProviderProtocolFailure, match="MALFORMED_FRAME"):
        decode_request_header(duplicate)


def test_binary_frames_are_exact_and_bounded() -> None:
    raw = encode_frame(FRAME_DATA, b"chunk")
    assert decode_frame(raw) == (FRAME_DATA, b"chunk")
    assert decode_frame(encode_frame(FRAME_END)) == (FRAME_END, b"")

    with pytest.raises(ProviderProtocolFailure):
        decode_frame(struct.pack(">I", 9) + FRAME_DATA + b"short")
    with pytest.raises(ProviderProtocolFailure):
        encode_frame(FRAME_END, b"not-empty")
    with pytest.raises(ProviderProtocolFailure):
        encode_frame(FRAME_DATA, b"x" * (MAX_FRAME_BYTES + 1))


def test_response_projects_only_allowlisted_content_type() -> None:
    kind, payload = decode_frame(response_header(200, "application/json"))
    assert kind == FRAME_HEADER
    assert json.loads(payload) == {
        "schemaVersion": 1,
        "status": 200,
        "headers": {"content-type": "application/json"},
    }
