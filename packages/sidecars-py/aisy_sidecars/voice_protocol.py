"""Bounded control protocol shared by the root voice broker boundaries."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1
MAX_CONTROL_BYTES = 64 * 1024
MAX_RESULT_BYTES = 1024 * 1024 + 4096

_HASH = re.compile(r"^[a-f0-9]{64}$")
_OPAQUE = re.compile(r"^[A-Za-z0-9_-]{20,160}$")
_CONTENT_TYPES = frozenset({"audio/ogg", "audio/opus", "audio/webm"})


class ProtocolFailure(Exception):
    """Stable, redacted protocol refusal."""


@dataclass(frozen=True)
class BrokerFrame:
    sequence: int
    operation: str
    payload: dict[str, object]


_FIELDS: dict[str, frozenset[str]] = {
    "stage-media": frozenset(
        {
            "installationHash",
            "bindingHash",
            "audioSha256",
            "audioBytes",
            "contentType",
        }
    ),
    "cancel-media": frozenset({"mediaTicket"}),
    "prepare": frozenset({"mediaTicket", "reservationRecoveryKey"}),
    "cancel-prepared": frozenset({"dispatchPermitId"}),
    "dispatch": frozenset({"dispatchPermitId"}),
}


def _object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolFailure("MALFORMED_FRAME")
        result[key] = value
    return result


def _hash(value: object) -> bool:
    return isinstance(value, str) and _HASH.fullmatch(value) is not None


def _opaque(value: object) -> bool:
    return isinstance(value, str) and _OPAQUE.fullmatch(value) is not None


def decode_request(raw: bytes) -> BrokerFrame:
    """Decode one exact request without accepting extension fields."""

    if not raw or len(raw) > MAX_CONTROL_BYTES:
        raise ProtocolFailure("FRAME_BOUNDS")
    try:
        value = json.loads(raw, object_pairs_hook=_object_without_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError, ProtocolFailure):
        raise ProtocolFailure("MALFORMED_FRAME") from None
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion",
        "sequence",
        "operation",
        "payload",
    }:
        raise ProtocolFailure("MALFORMED_FRAME")
    sequence = value["sequence"]
    operation = value["operation"]
    payload = value["payload"]
    if (
        isinstance(value["schemaVersion"], bool)
        or not isinstance(value["schemaVersion"], int)
        or value["schemaVersion"] != PROTOCOL_VERSION
        or isinstance(sequence, bool)
        or not isinstance(sequence, int)
        or sequence < 1
        or sequence > 2**63 - 1
        or not isinstance(operation, str)
        or operation not in _FIELDS
        or not isinstance(payload, dict)
        or set(payload) != _FIELDS[operation]
    ):
        raise ProtocolFailure("MALFORMED_FRAME")
    _validate_payload(operation, payload)
    return BrokerFrame(sequence, operation, payload)


def _validate_payload(operation: str, payload: dict[str, object]) -> None:
    if operation == "stage-media":
        if (
            not _hash(payload["installationHash"])
            or not _hash(payload["bindingHash"])
            or not _hash(payload["audioSha256"])
            or isinstance(payload["audioBytes"], bool)
            or not isinstance(payload["audioBytes"], int)
            or not 1 <= payload["audioBytes"] <= 20 * 1024 * 1024
            or not isinstance(payload["contentType"], str)
            or payload["contentType"] not in _CONTENT_TYPES
        ):
            raise ProtocolFailure("INVALID_REQUEST")
        return
    if not all(_opaque(value) for value in payload.values()):
        raise ProtocolFailure("INVALID_REQUEST")


def encode_result(sequence: int, result: dict[str, object]) -> bytes:
    if (
        isinstance(sequence, bool)
        or not isinstance(sequence, int)
        or not 1 <= sequence <= 2**63 - 1
        or not isinstance(result, dict)
    ):
        raise ProtocolFailure("INVALID_RESULT")
    try:
        raw = json.dumps(
            {
                "schemaVersion": PROTOCOL_VERSION,
                "sequence": sequence,
                "result": result,
            },
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError):
        raise ProtocolFailure("INVALID_RESULT") from None
    if len(raw) > MAX_RESULT_BYTES:
        raise ProtocolFailure("RESULT_BOUNDS")
    return raw


class SessionSequence:
    """Fail closed when a private session is replayed or reordered."""

    def __init__(self) -> None:
        self._next = 1

    def accept(self, frame: BrokerFrame) -> None:
        if frame.sequence != self._next:
            raise ProtocolFailure("SEQUENCE_REFUSED")
        self._next += 1
