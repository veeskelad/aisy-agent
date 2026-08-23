#!/usr/bin/env python3
"""Собирает детерминированный release bundle provider broker."""

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
    (
        "packages/sidecars-py/aisy_sidecars/provider_broker_protocol.py",
        "aisy_sidecars/provider_broker_protocol.py",
        0o644,
    ),
    (
        "packages/sidecars-py/aisy_sidecars/provider_broker_service.py",
        "aisy_sidecars/provider_broker_service.py",
        0o644,
    ),
    (
        "packages/sidecars-py/aisy_sidecars/provider_lifecycle.py",
        "aisy_sidecars/provider_lifecycle.py",
        0o644,
    ),
    (
        "packages/sidecars-py/aisy_sidecars/provider_proxy_install.py",
        "aisy_sidecars/provider_proxy_install.py",
        0o644,
    ),
    (
        "packages/sidecars-py/aisy_sidecars/provider_proxy_service.py",
        "aisy_sidecars/provider_proxy_service.py",
        0o644,
    ),
    (
        "packages/sidecars-py/aisy_sidecars/provider_validation_worker.py",
        "aisy_sidecars/provider_validation_worker.py",
        0o644,
    ),
    (
        "packages/sidecars-py/aisy_sidecars/provider_worker.py",
        "aisy_sidecars/provider_worker.py",
        0o644,
    ),
    (
        "packages/sidecars-py/aisy_sidecars/voice_proxy_install.py",
        "aisy_sidecars/voice_proxy_install.py",
        0o644,
    ),
    ("packages/sidecars-py/provider_proxy_install.py", "provider_proxy_install.py", 0o755),
    ("packages/sidecars-py/provider_proxy_service.py", "provider_proxy_service.py", 0o755),
    (
        "packages/sidecars-py/systemd/aisy-provider-broker.service",
        "systemd/aisy-provider-broker.service",
        0o644,
    ),
    (
        "packages/sidecars-py/systemd/aisy-provider-validator@.service",
        "systemd/aisy-provider-validator@.service",
        0o644,
    ),
    (
        "packages/sidecars-py/systemd/aisy-provider-validator@.socket",
        "systemd/aisy-provider-validator@.socket",
        0o644,
    ),
    (
        "packages/sidecars-py/systemd/aisy-provider-worker@.service",
        "systemd/aisy-provider-worker@.service",
        0o644,
    ),
    (
        "packages/sidecars-py/systemd/aisy-provider-worker@.socket",
        "systemd/aisy-provider-worker@.socket",
        0o644,
    ),
)


def verify_exact_commit(repository: Path, commit: str) -> None:
    for source_name, _target, _mode in FILES:
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
    names = {"output", "commit", "release"}
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
        if HASH.fullmatch(values["commit"]) is None or RELEASE.fullmatch(values["release"]) is None:
            raise ValueError
        repository = Path(__file__).resolve(strict=True).parent.parent
        verify_exact_commit(repository, values["commit"])
        output = Path(values["output"]).absolute()
        if output.exists():
            raise ValueError
        output.mkdir(mode=0o755, parents=False)
        entries: list[dict[str, object]] = []
        for source_name, target, mode in sorted(FILES, key=lambda item: item[1]):
            source = repository / source_name
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
        print("PROVIDER_BROKER_RELEASE_REFUSED", file=sys.stderr)
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
