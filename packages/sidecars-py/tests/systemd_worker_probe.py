"""Disposable-systemd probe for one encrypted one-shot worker request."""

from __future__ import annotations

import array
import fcntl
import hashlib
import json
import os
import socket
import sys
from pathlib import Path

INSTALLATION = "d" * 64
HANDLE = "H" * 43
PERMIT = "P" * 43
AUDIO = b"disposable-audio"
POLICY = Path("/run/aisy/voice-worker-policy.json")
WORKER = "/run/aisy/voice-worker.sock"


def packet(connection: socket.socket) -> object:
    raw = connection.recv(64 * 1024)
    if not raw:
        raise RuntimeError("WORKER_CLOSED")
    return json.loads(raw)


def send(connection: socket.socket, value: object) -> None:
    raw = json.dumps(value, separators=(",", ":")).encode()
    if connection.send(raw) != len(raw):
        raise RuntimeError("SHORT_WRITE")


def main(*, expected: str = "address-refused", diagnose: bool = False) -> int:
    policy = json.dumps({
        "schemaVersion": 1,
        "brokerPid": os.getpid(),
        "installationHash": INSTALLATION,
        "handle": HANDLE,
    }, sort_keys=True, separators=(",", ":"))
    POLICY.write_text(policy)
    POLICY.chmod(0o644)
    descriptor = os.memfd_create("aisy-systemd-probe", os.MFD_ALLOW_SEALING)
    os.write(descriptor, AUDIO)
    os.lseek(descriptor, 0, os.SEEK_SET)
    fcntl.fcntl(
        descriptor,
        fcntl.F_ADD_SEALS,
        fcntl.F_SEAL_SEAL
        | fcntl.F_SEAL_SHRINK
        | fcntl.F_SEAL_GROW
        | fcntl.F_SEAL_WRITE,
    )
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    connection.settimeout(10)
    connection.connect(WORKER)
    claim = json.dumps({
        "schemaVersion": 1,
        "descriptorId": "deepgram.nova3.transcribe.v1",
        "installationHash": INSTALLATION,
        "handle": HANDLE,
        "dispatchPermitId": PERMIT,
        "audioSha256": hashlib.sha256(AUDIO).hexdigest(),
        "audioBytes": len(AUDIO),
        "contentType": "audio/ogg",
    }, separators=(",", ":")).encode()
    connection.sendmsg(
        [claim],
        [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [descriptor]))],
    )
    attempted = packet(connection)
    if attempted != {
        "schemaVersion": 1,
        "operation": "mark-attempted",
        "dispatchPermitId": PERMIT,
    }:
        raise RuntimeError("ATTEMPT_PROTOCOL_REFUSED")
    send(connection, {
        "schemaVersion": 1,
        "operation": "attempted",
        "dispatchPermitId": PERMIT,
    })
    committed = packet(connection)
    expected_result = (
        {
            "ok": True,
            "transcript": "disposable transcript",
            "language": "en-US",
            "durationMs": 1250,
        }
        if expected == "success"
        else (
            {
                "ok": False,
                "code": "AUTH_REJECTED",
                "dispatch": "attempted",
            }
            if expected == "auth-rejected"
            else {
                "ok": False,
                "code": "TRANSCRIPTION_ADDRESS_REFUSED",
                "dispatch": "attempted",
            }
        )
    )
    if (
        not isinstance(committed, dict)
        or committed.get("operation") != "commit-result"
        or committed.get("dispatchPermitId") != PERMIT
    ):
        raise RuntimeError("RESULT_PROTOCOL_REFUSED")
    if not diagnose and committed.get("result") != expected_result:
        raise RuntimeError("RESULT_PROTOCOL_REFUSED")
    send(connection, {
        "schemaVersion": 1,
        "operation": "result-committed",
        "dispatchPermitId": PERMIT,
    })
    connection.close()
    os.close(descriptor)
    if diagnose:
        result = committed.get("result")
        if not isinstance(result, dict):
            raise RuntimeError("RESULT_PROTOCOL_REFUSED")
        print(
            json.dumps(
                {
                    "ok": result.get("ok"),
                    "code": result.get("code"),
                    "dispatch": result.get("dispatch"),
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )
    return 0


if __name__ == "__main__":
    modes = {
        (): "address-refused",
        ("--expect-success",): "success",
        ("--expect-auth-rejected",): "auth-rejected",
        ("--diagnose-result",): "diagnose",
    }
    mode = modes.get(tuple(sys.argv[1:]))
    if mode is None:
        raise SystemExit(64)
    raise SystemExit(main(expected=mode, diagnose=mode == "diagnose"))
