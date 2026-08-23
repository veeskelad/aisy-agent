#!/usr/bin/env python3
"""Собирает детерминированный release bundle голосового proxy."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

HASH = re.compile(r"^[a-f0-9]{40,64}$")
RELEASE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
FILES = (
    ("packages/sidecars-py/aisy_sidecars/__init__.py", "aisy_sidecars/__init__.py", 0o644),
    ("packages/sidecars-py/aisy_sidecars/voice_proxy_install.py", "aisy_sidecars/voice_proxy_install.py", 0o644),
    ("packages/sidecars-py/aisy_sidecars/voice_proxy_service.py", "aisy_sidecars/voice_proxy_service.py", 0o644),
    ("packages/sidecars-py/aisy_sidecars/voice_transcription_worker.py", "aisy_sidecars/voice_transcription_worker.py", 0o644),
    ("packages/sidecars-py/voice_proxy_install.py", "voice_proxy_install.py", 0o755),
    ("packages/sidecars-py/voice_proxy_service.py", "voice_proxy_service.py", 0o755),
    ("packages/sidecars-py/systemd/aisy-voice-broker.service", "systemd/aisy-voice-broker.service", 0o644),
    ("packages/sidecars-py/systemd/aisy-voice-worker.socket", "systemd/aisy-voice-worker.socket", 0o644),
    ("packages/sidecars-py/systemd/aisy-voice-worker@.service", "systemd/aisy-voice-worker@.service", 0o644),
)
MODULE_PATTERNS = ("voice_*_backend.py", "voice_*_broker.py")


def verify_exact_commit(repository: Path, commit: str, source_names: tuple[str, ...]) -> None:
    for source_name in source_names:
        try:
            result = subprocess.run(
                ["git", "-C", str(repository), "show", f"{commit}:{source_name}"],
                check=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            raise ValueError from None
        if result.stdout != (repository / source_name).read_bytes():
            raise ValueError


def arguments(argv: list[str]) -> dict[str, str]:
    names = {"output", "commit", "release", "native-addon"}
    if len(argv) != len(names):
        raise ValueError
    result: dict[str, str] = {}
    for item in argv:
        if not item.startswith("--") or "=" not in item:
            raise ValueError
        name, value = item[2:].split("=", 1)
        if name not in names or name in result or not value or "\0" in value:
            raise ValueError
        result[name] = value
    if set(result) != names:
        raise ValueError
    return result


def main() -> int:
    try:
        values = arguments(sys.argv[1:])
        if (
            HASH.fullmatch(values["commit"]) is None
            or RELEASE.fullmatch(values["release"]) is None
        ):
            raise ValueError
        repository = Path(__file__).resolve(strict=True).parent.parent
        output = Path(values["output"]).absolute()
        addon = Path(values["native-addon"]).absolute()
        if output.exists() or not addon.is_file() or addon.is_symlink():
            raise ValueError
        output.mkdir(mode=0o755, parents=False)
        sources = [
            *((repository / source, target, mode) for source, target, mode in FILES),
            (addon, "aisy_voice_broker_bridge.node", 0o755),
        ]
        module_root = repository / "packages/sidecars-py/aisy_sidecars"
        for pattern in MODULE_PATTERNS:
            matches = list(module_root.glob(pattern))
            if len(matches) != 1:
                raise ValueError
            sources.append((matches[0], f"aisy_sidecars/{matches[0].name}", 0o644))
        tracked_sources = tuple(
            source.relative_to(repository).as_posix()
            for source, _target, _mode in sources
            if source != addon
        )
        verify_exact_commit(repository, values["commit"], tracked_sources)
        entries: list[dict[str, object]] = []
        for source, target, mode in sorted(sources, key=lambda item: item[1]):
            info = source.stat()
            if (
                source.is_symlink()
                or source.resolve(strict=True) != source.absolute()
                or not stat.S_ISREG(info.st_mode)
                or info.st_size < 1
                or info.st_size > 8 * 1024 * 1024
            ):
                raise ValueError
            destination = output / target
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            shutil.copyfile(source, destination, follow_symlinks=False)
            destination.chmod(mode)
            raw = destination.read_bytes()
            entries.append({
                "path": target,
                "sha256": hashlib.sha256(raw).hexdigest(),
                "size": len(raw),
                "mode": mode,
            })
        manifest = (json.dumps({
            "schemaVersion": 1,
            "protocolVersion": 1,
            "release": values["release"],
            "commit": values["commit"],
            "files": entries,
        }, sort_keys=True, separators=(",", ":")) + "\n").encode()
        (output / "manifest.json").write_bytes(manifest)
        (output / "manifest.json").chmod(0o644)
        print(hashlib.sha256(manifest).hexdigest())
        return 0
    except (OSError, ValueError):
        print("VOICE_PROXY_RELEASE_REFUSED", file=sys.stderr)
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
