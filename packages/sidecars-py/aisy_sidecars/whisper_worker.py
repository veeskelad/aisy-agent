"""One-shot, descriptor-relative Whisper transcription worker.

The control protocol carries only a private read-only root, a relative audio
path, and an expected digest. The production image contains the model and runs
with Docker network=none; this worker never downloads models or emits raw
diagnostics. Transcript text is untrusted data at the TypeScript boundary.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, BinaryIO, NoReturn


def _load_confinement_worker() -> ModuleType:
    if __package__:
        from . import confinement_worker

        return confinement_worker
    path = Path(__file__).with_name("confinement_worker.py")
    spec = importlib.util.spec_from_file_location("aisy_whisper_confinement", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("confinement worker unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


confinement = _load_confinement_worker()

PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_AUDIO_BYTES = 256 * 1024 * 1024
MAX_TRANSCRIPT_BYTES = 1024 * 1024
MAX_SEGMENTS = 10_000
READ_CHUNK_BYTES = 1024 * 1024
MODEL_PATH = "/models/whisper"
HASH = re.compile(r"^[a-f0-9]{64}$")
LANGUAGE = re.compile(r"^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$")


class WhisperFailure(Exception):
    """A deliberately redacted protocol failure."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Transcription:
    text_segments: Iterable[str]
    language: str | None = None
    duration_seconds: float | None = None


Transcriber = Callable[[BinaryIO, str | None], Transcription]


def _fail(code: str) -> NoReturn:
    raise WhisperFailure(code)


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        _fail("INVALID_REQUEST")
    return value


def _required_string(value: dict[str, Any], key: str, maximum: int) -> str:
    candidate = value.get(key)
    if (
        not isinstance(candidate, str)
        or not candidate
        or "\x00" in candidate
        or len(candidate.encode("utf-8")) > maximum
    ):
        _fail("INVALID_REQUEST")
    return candidate


def _bounded_int(value: dict[str, Any], key: str, maximum: int) -> int:
    candidate = value.get(key)
    if isinstance(candidate, bool) or not isinstance(candidate, int) or candidate < 0:
        _fail("INVALID_REQUEST")
    if candidate > maximum:
        _fail("LIMIT_EXCEEDED")
    return candidate


def _map_confinement(error: confinement.ConfinementFailure) -> NoReturn:
    raise WhisperFailure(error.code) from error


def _open_audio(request: dict[str, Any]) -> tuple[int, int]:
    root = _required_string(request, "root", confinement.MAX_PATH_BYTES)
    root_fd: int | None = None
    parent_fd: int | None = None
    try:
        root_fd, root_device = confinement._open_root(root)
        parts = confinement._path_parts(request.get("path"), allow_root=False)
        parent_fd = confinement._walk_directories(root_fd, parts[:-1], root_device)
        audio_fd, info = confinement._open_regular(parent_fd, parts[-1], root_device)
    except confinement.ConfinementFailure as error:
        _map_confinement(error)
    finally:
        if parent_fd is not None:
            os.close(parent_fd)
        if root_fd is not None:
            os.close(root_fd)
    return audio_fd, info.st_size


def _verify_audio(
    descriptor: int,
    actual_size: int,
    expected_hash: str,
    expected_size: int,
    maximum: int,
) -> None:
    if actual_size != expected_size:
        _fail("HASH_MISMATCH")
    if actual_size > maximum:
        _fail("LIMIT_EXCEEDED")
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = os.read(descriptor, min(READ_CHUNK_BYTES, maximum + 1 - size))
        if not chunk:
            break
        size += len(chunk)
        if size > maximum:
            _fail("LIMIT_EXCEEDED")
        digest.update(chunk)
    if size != expected_size or digest.hexdigest() != expected_hash:
        _fail("HASH_MISMATCH")
    os.lseek(descriptor, 0, os.SEEK_SET)


def _default_transcriber(audio: BinaryIO, language: str | None) -> Transcription:
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise WhisperFailure("MODEL_UNAVAILABLE") from error
    if not Path(MODEL_PATH).is_dir():
        _fail("MODEL_UNAVAILABLE")
    try:
        model = WhisperModel(MODEL_PATH, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            audio,
            beam_size=1,
            vad_filter=True,
            language=language,
            condition_on_previous_text=False,
        )
        return Transcription(
            (str(segment.text) for segment in segments),
            language=str(info.language) if info.language else None,
            duration_seconds=float(info.duration) if info.duration is not None else None,
        )
    except WhisperFailure:
        raise
    except Exception as error:
        raise WhisperFailure("TRANSCRIPTION_FAILED") from error


def _normalize_transcription(value: Transcription) -> dict[str, Any]:
    if not isinstance(value, Transcription):
        _fail("TRANSCRIPTION_FAILED")
    text_parts: list[str] = []
    total = 0
    for index, segment in enumerate(value.text_segments):
        if index >= MAX_SEGMENTS or not isinstance(segment, str) or "\x00" in segment:
            _fail("LIMIT_EXCEEDED")
        total += len(segment.encode("utf-8"))
        if total > MAX_TRANSCRIPT_BYTES:
            _fail("LIMIT_EXCEEDED")
        text_parts.append(segment)
    text = "".join(text_parts).strip()
    if not text:
        _fail("TRANSCRIPTION_FAILED")
    language = value.language
    if language is not None and LANGUAGE.fullmatch(language.lower()) is None:
        _fail("TRANSCRIPTION_FAILED")
    duration_ms: int | None = None
    if value.duration_seconds is not None:
        if not isinstance(value.duration_seconds, (int, float)) or isinstance(
            value.duration_seconds, bool
        ):
            _fail("TRANSCRIPTION_FAILED")
        if value.duration_seconds < 0 or value.duration_seconds > 86_400:
            _fail("TRANSCRIPTION_FAILED")
        duration_ms = round(float(value.duration_seconds) * 1000)
    return {
        "text": text,
        **({"language": language.lower()} if language is not None else {}),
        **({"durationMs": duration_ms} if duration_ms is not None else {}),
    }


def handle_request(request: dict[str, Any], transcriber: Transcriber = _default_transcriber) -> dict[str, Any]:
    value = _object(request)
    allowed = {
        "version",
        "requestId",
        "op",
        "root",
        "path",
        "expectedSha256",
        "expectedSizeBytes",
        "maxBytes",
        "language",
    }
    required = allowed - {"language"}
    if set(value) - allowed or not required.issubset(value):
        _fail("INVALID_REQUEST")
    if value.get("version") != PROTOCOL_VERSION or value.get("op") != "transcribe":
        _fail("INVALID_REQUEST")
    _required_string(value, "requestId", 1024)
    expected_hash = _required_string(value, "expectedSha256", 64)
    if HASH.fullmatch(expected_hash) is None:
        _fail("INVALID_REQUEST")
    expected_size = _bounded_int(value, "expectedSizeBytes", MAX_AUDIO_BYTES)
    maximum = _bounded_int(value, "maxBytes", MAX_AUDIO_BYTES)
    if expected_size > maximum:
        _fail("LIMIT_EXCEEDED")
    language = value.get("language")
    if language is not None and (
        not isinstance(language, str) or LANGUAGE.fullmatch(language.lower()) is None
    ):
        _fail("INVALID_REQUEST")

    descriptor, actual_size = _open_audio(value)
    try:
        _verify_audio(descriptor, actual_size, expected_hash, expected_size, maximum)
        with os.fdopen(os.dup(descriptor), "rb", closefd=True) as audio:
            try:
                transcription = transcriber(audio, language.lower() if language else None)
            except WhisperFailure:
                raise
            except Exception as error:
                raise WhisperFailure("TRANSCRIPTION_FAILED") from error
        return _normalize_transcription(transcription)
    finally:
        os.close(descriptor)


def _strict_json(raw: bytes) -> dict[str, Any]:
    if not raw or len(raw) > MAX_REQUEST_BYTES:
        _fail("INVALID_REQUEST")

    def pairs(values: list[tuple[str, Any]]) -> dict[str, Any]:
        output: dict[str, Any] = {}
        for key, value in values:
            if key in output:
                _fail("INVALID_REQUEST")
            output[key] = value
        return output

    try:
        return _object(json.loads(raw.decode("utf-8"), object_pairs_hook=pairs))
    except WhisperFailure:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        _fail("INVALID_REQUEST")


def _response_for(raw: bytes, transcriber: Transcriber = _default_transcriber) -> tuple[dict[str, Any], int]:
    request_id = "invalid"
    try:
        request = _strict_json(raw)
        if isinstance(request.get("requestId"), str):
            request_id = request["requestId"][:1024]
        data = handle_request(request, transcriber)
        return {
            "version": PROTOCOL_VERSION,
            "requestId": request_id,
            "ok": True,
            "data": data,
        }, 0
    except WhisperFailure as error:
        return {
            "version": PROTOCOL_VERSION,
            "requestId": request_id,
            "ok": False,
            "error": {"code": error.code},
        }, 2
    except Exception:  # noqa: BLE001 - protocol boundary must redact unexpected backend detail
        return {
            "version": PROTOCOL_VERSION,
            "requestId": request_id,
            "ok": False,
            "error": {"code": "INTERNAL_ERROR"},
        }, 2


def main() -> int:
    response, exit_code = _response_for(sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1))
    encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_RESPONSE_BYTES:
        encoded = json.dumps(
            {
                "version": PROTOCOL_VERSION,
                "requestId": "invalid",
                "ok": False,
                "error": {"code": "LIMIT_EXCEEDED"},
            },
            separators=(",", ":"),
        ).encode("utf-8")
        exit_code = 2
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
