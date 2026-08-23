#!/usr/bin/python3.12
"""Root state probe using the production host-encrypted backend."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path

RELEASE = Path("/usr/lib/aisy/voice-proxy/current")
sys.path.insert(0, str(RELEASE))

from aisy_sidecars.voice_credential_backend import (
    CiphertextStore,
    HostEncryptedCredentialBackend,
    SystemdCredsEncryptor,
)
from aisy_sidecars.voice_credential_broker import VoiceCredentialBroker

STATE = Path("/var/lib/aisy/voice")
DATABASE = STATE / "broker.sqlite"
INSTALLATION = "d" * 64
SCAN_ROOTS = (
    STATE,
    Path("/run/aisy"),
    Path("/usr/lib/aisy/voice-proxy"),
)
SYSTEMD_UNITS = (
    Path("/etc/systemd/system/aisy-voice-broker.service"),
    Path("/etc/systemd/system/aisy-voice-worker.socket"),
    Path("/etc/systemd/system/aisy-voice-worker@.service"),
)


def activate(marker: bytes) -> None:
    broker = VoiceCredentialBroker(DATABASE, expected_owner_uid=0)
    try:
        challenge = broker.begin_enrollment(
            INSTALLATION,
            "operator-e2e",
            "profile-e2e",
            provider_id="deepgram-cloud",
        )
        claim = broker.claim_enrollment_code(challenge.code)

        def validate(owned: bytearray) -> None:
            if owned != bytearray(marker * 48):
                raise RuntimeError("VALIDATION_REFUSED")

        backend = HostEncryptedCredentialBackend(
            broker,
            SystemdCredsEncryptor(STATE),
            CiphertextStore(STATE),
            validator=validate,
        )
        owned = bytearray(marker * 48)
        try:
            backend.activate(claim, owned)
        finally:
            owned[:] = b"\0" * len(owned)
    finally:
        broker.close()


def assert_no_plaintext_artifacts() -> None:
    markers = (b"A" * 48, b"B" * 48)
    candidates = list(SYSTEMD_UNITS)
    for root in SCAN_ROOTS:
        if root.exists():
            candidates.extend(path for path in root.rglob("*") if path.is_file())
    for path in candidates:
        try:
            metadata = path.lstat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 16 * 1024 * 1024:
                continue
            content = path.read_bytes()
        except OSError:
            raise RuntimeError("ARTIFACT_SCAN_REFUSED") from None
        if any(marker in content for marker in markers):
            raise RuntimeError("PLAINTEXT_ARTIFACT_FOUND")
    journal = subprocess.run(
        [
            "/usr/bin/journalctl",
            "--no-pager",
            "--output=cat",
            "-u",
            "aisy-voice-broker.service",
            "-u",
            "aisy-voice-worker@*.service",
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env={"LANG": "C", "PATH": "/usr/bin:/bin"},
    ).stdout
    if any(marker in journal for marker in markers):
        raise RuntimeError("PLAINTEXT_JOURNAL_FOUND")


def main() -> int:
    if os.geteuid() != 0:
        return 70
    if sys.argv[1:] == ["activate-a"]:
        activate(b"A")
    elif sys.argv[1:] == ["activate-b"]:
        activate(b"B")
    elif sys.argv[1:] == ["assert-no-plaintext"]:
        assert_no_plaintext_artifacts()
    else:
        return 64
    print("ok")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError):
        print("AISY_SYSTEMD_STATE_PROBE_REFUSED", file=sys.stderr)
        raise SystemExit(70) from None
