from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from aisy_sidecars import whisper_worker as worker


def request(root: Path, payload: bytes, **extra: object) -> dict[str, object]:
    return {
        "version": worker.PROTOCOL_VERSION,
        "requestId": "voice-1",
        "op": "transcribe",
        "root": str(root),
        "path": "voice.ogg",
        "expectedSha256": hashlib.sha256(payload).hexdigest(),
        "expectedSizeBytes": len(payload),
        "maxBytes": 1024 * 1024,
        **extra,
    }


def fake_transcriber(audio, language: str | None) -> worker.Transcription:
    assert audio.read() == b"OggS voice bytes"
    assert language == "ru"
    return worker.Transcription(["  Привет", ", мир.  "], "ru", 1.25)


def failure(payload: dict[str, object]) -> str:
    response, exit_code = worker._response_for(json.dumps(payload).encode(), fake_transcriber)
    assert exit_code == 2
    return response["error"]["code"]


def test_transcribes_verified_regular_file_with_bounded_metadata(tmp_path: Path) -> None:
    payload = b"OggS voice bytes"
    (tmp_path / "voice.ogg").write_bytes(payload)

    response = worker.handle_request(request(tmp_path, payload, language="RU"), fake_transcriber)

    assert response == {"text": "Привет, мир.", "language": "ru", "durationMs": 1250}


def test_rejects_hash_size_path_and_duplicate_key_before_model(tmp_path: Path) -> None:
    payload = b"OggS voice bytes"
    (tmp_path / "voice.ogg").write_bytes(payload)
    calls = 0

    def never(audio, language):
        nonlocal calls
        calls += 1
        return worker.Transcription(["must not run"])

    changed = request(tmp_path, payload)
    changed["expectedSha256"] = "0" * 64
    assert failure(changed) == "HASH_MISMATCH"
    changed = request(tmp_path, payload)
    changed["expectedSizeBytes"] = len(payload) + 1
    assert failure(changed) == "HASH_MISMATCH"
    changed = request(tmp_path, payload)
    changed["path"] = "../voice.ogg"
    assert failure(changed) == "INVALID_PATH"

    raw = json.dumps(request(tmp_path, payload)).replace(
        '"op": "transcribe"', '"op":"transcribe","op":"transcribe"'
    )
    response, exit_code = worker._response_for(raw.encode(), never)
    assert exit_code == 2
    assert response["error"]["code"] == "INVALID_REQUEST"
    assert calls == 0


def test_rejects_symlink_and_hardlink_audio(tmp_path: Path) -> None:
    payload = b"OggS voice bytes"
    outside = tmp_path / "outside.ogg"
    outside.write_bytes(payload)
    link = tmp_path / "voice.ogg"
    link.symlink_to(outside)
    assert failure(request(tmp_path, payload)) == "SYMLINK_DENIED"

    link.unlink()
    link.write_bytes(payload)
    os.link(link, tmp_path / "alias.ogg")
    assert failure(request(tmp_path, payload)) == "HARDLINK_DENIED"


def test_redacts_backend_failure_and_missing_model(tmp_path: Path) -> None:
    payload = b"OggS voice bytes"
    (tmp_path / "voice.ogg").write_bytes(payload)

    def broken(audio, language):
        raise RuntimeError("secret backend detail")

    response, exit_code = worker._response_for(json.dumps(request(tmp_path, payload)).encode(), broken)
    assert exit_code == 2
    assert response["error"] == {"code": "TRANSCRIPTION_FAILED"}
    assert "secret" not in json.dumps(response)


def test_real_one_shot_process_reports_missing_local_model_without_diagnostics(
    tmp_path: Path,
) -> None:
    payload = b"OggS voice bytes"
    (tmp_path / "voice.ogg").write_bytes(payload)

    completed = subprocess.run(
        [sys.executable, str(Path(worker.__file__).resolve())],
        input=json.dumps(request(tmp_path, payload)).encode(),
        capture_output=True,
        check=False,
        timeout=10,
    )

    response = json.loads(completed.stdout)
    assert completed.returncode == 2
    assert response["error"] == {"code": "MODEL_UNAVAILABLE"}
    assert completed.stderr == b""


def test_bounds_transcript_and_is_stateless_across_requests(tmp_path: Path) -> None:
    payload = b"OggS voice bytes"
    (tmp_path / "voice.ogg").write_bytes(payload)

    def stable(audio, language):
        return worker.Transcription(["same transcript"], "en", 0.5)

    first = worker.handle_request(request(tmp_path, payload), stable)
    second = worker.handle_request(request(tmp_path, payload), stable)
    assert first == second

    def oversized(audio, language):
        return worker.Transcription(["x" * (worker.MAX_TRANSCRIPT_BYTES + 1)])

    response, exit_code = worker._response_for(
        json.dumps(request(tmp_path, payload)).encode(), oversized
    )
    assert exit_code == 2
    assert response["error"]["code"] == "LIMIT_EXCEEDED"
