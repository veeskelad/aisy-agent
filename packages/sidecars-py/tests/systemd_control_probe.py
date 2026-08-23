#!/usr/bin/python3.12
"""Unprivileged control-socket probe for the real-systemd release gate."""

from __future__ import annotations

import json
import socket
import struct
import sys

PROTOCOL = "aisy.voice.control.v1"
CONTROL = "/run/aisy/voice-control.sock"
BINDING = ["d" * 64, "operator-e2e", "profile-e2e", "deepgram-cloud"]


def receive(connection: socket.socket, size: int) -> bytes:
    owned = bytearray(size)
    offset = 0
    while offset < size:
        received = connection.recv_into(memoryview(owned)[offset:])
        if received <= 0:
            raise RuntimeError("CONTROL_REFUSED")
        offset += received
    return bytes(owned)


def request(operation: str, payload: list[object], secret: bytearray) -> list[object]:
    request.counter += 1
    request_id = f"{request.counter:032d}"
    body = json.dumps(
        [PROTOCOL, request_id, operation, payload, len(secret)],
        separators=(",", ":"),
    ).encode()
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(30)
    try:
        connection.connect(CONTROL)
        connection.sendall(struct.pack(">I", len(body)) + body)
        if secret:
            connection.sendall(secret)
        secret[:] = b"\0" * len(secret)
        response_size = struct.unpack(">I", receive(connection, 4))[0]
        if not 1 <= response_size <= 64 * 1024:
            raise RuntimeError("CONTROL_REFUSED")
        value = json.loads(receive(connection, response_size))
    finally:
        secret[:] = b"\0" * len(secret)
        connection.close()
    if (
        not isinstance(value, list)
        or len(value) != 4
        or value[:3] != [PROTOCOL, request_id, "ok"]
        or not isinstance(value[3], list)
    ):
        raise RuntimeError("CONTROL_REFUSED")
    return value[3]


request.counter = 0


def activate(marker: bytes, revision: int) -> None:
    challenge = request("begin", BINDING, bytearray())
    if (
        len(challenge) != 3
        or challenge[0] != "challenge"
        or not isinstance(challenge[1], str)
    ):
        raise RuntimeError("ENROLLMENT_REFUSED")
    ready = request("submit", [challenge[1]], bytearray(marker * 48))
    if len(ready) != 3 or ready[0] != "ready" or ready[2] != revision:
        raise RuntimeError("ENROLLMENT_REFUSED")


def inspect(revision: int | None) -> None:
    state = request("inspect", BINDING, bytearray())
    if revision is None and state != ["state", "unavailable"]:
        raise RuntimeError("READINESS_REFUSED")
    if revision is not None and (
        len(state) != 3 or state[0] != "ready" or state[2] != revision
    ):
        raise RuntimeError("READINESS_REFUSED")


def revision_base(arguments: list[str]) -> tuple[list[str], int]:
    if arguments and arguments[-1].startswith("--revision-base="):
        raw = arguments.pop().split("=", 1)[1]
        if not raw.isascii() or not raw.isdecimal():
            raise RuntimeError("REVISION_BASE_REFUSED")
        base = int(raw)
        if not 0 <= base <= 1_000_000:
            raise RuntimeError("REVISION_BASE_REFUSED")
        return arguments, base
    return arguments, 0


def main() -> int:
    arguments, base = revision_base(sys.argv[1:])
    if arguments == ["activate-a"]:
        activate(b"A", base + 1)
    elif arguments == ["activate-b"]:
        activate(b"B", base + 2)
    elif arguments == ["inspect-a"]:
        inspect(base + 1)
    elif arguments == ["inspect-b"]:
        inspect(base + 2)
    elif arguments == ["revoke-a"]:
        if request("revoke", BINDING, bytearray()) != ["revoked", base + 1]:
            raise RuntimeError("REVOKE_REFUSED")
    elif arguments in (["revoke"], ["revoke-b"]):
        if request("revoke", BINDING, bytearray()) != ["revoked", base + 2]:
            raise RuntimeError("REVOKE_REFUSED")
    elif arguments == ["inspect-unavailable"]:
        inspect(None)
    else:
        return 64
    print("ok")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError):
        print("AISY_SYSTEMD_CONTROL_PROBE_REFUSED", file=sys.stderr)
        raise SystemExit(70) from None
