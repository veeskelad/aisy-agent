#!/usr/bin/env python3
"""Build a deterministic root bootstrap tree for Aisy SSH sidecar delivery."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

COMMIT = re.compile(r"^[a-f0-9]{40}(?:[a-f0-9]{24})?$")
REPOSITORY = Path(__file__).resolve(strict=True).parent.parent
SOURCES = {
    "usr/lib/aisy/bootstrap/aisy_sidecars/__init__.py": "packages/sidecars-py/aisy_sidecars/__init__.py",
    "usr/lib/aisy/bootstrap/aisy_sidecars/sidecar_bundle_delivery.py": "packages/sidecars-py/aisy_sidecars/sidecar_bundle_delivery.py",
    "usr/lib/aisy/bootstrap/aisy_sidecars/sidecar_bundle_install.py": "packages/sidecars-py/aisy_sidecars/sidecar_bundle_install.py",
    "usr/lib/aisy/bootstrap/aisy_sidecars/system_runtime_binding.py": "packages/sidecars-py/aisy_sidecars/system_runtime_binding.py",
    "usr/libexec/aisy-sidecar-receiver": "packages/sidecars-py/sidecar_bundle_receiver.py",
    "usr/libexec/aisy-provider-install": "packages/sidecars-py/provider_bundle_install.py",
    "usr/libexec/aisy-voice-install": "packages/sidecars-py/voice_bundle_install.py",
}


def _canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def verify_exact_commit(repository: Path, commit: str) -> None:
    for source_name in sorted(set(SOURCES.values())):
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
            raise ValueError("BOOTSTRAP_BUILD_REFUSED") from None
        if result.stdout != (repository / source_name).read_bytes():
            raise ValueError("BOOTSTRAP_BUILD_REFUSED")


def build(
    output: Path,
    commit: str,
    *,
    expected_uid: int,
    commit_verifier: Callable[[Path, str], None] = verify_exact_commit,
) -> bytes:
    if (
        not output.is_absolute()
        or output.exists()
        or not output.parent.is_dir()
        or COMMIT.fullmatch(commit) is None
    ):
        raise ValueError("BOOTSTRAP_BUILD_REFUSED")
    commit_verifier(REPOSITORY, commit)
    output.mkdir(mode=0o700)
    files: list[dict[str, object]] = []
    try:
        for target, source_name in sorted(SOURCES.items()):
            source = REPOSITORY / source_name
            info = source.lstat()
            if (
                not stat.S_ISREG(info.st_mode)
                or stat.S_ISLNK(info.st_mode)
                or info.st_uid != expected_uid
                or info.st_nlink != 1
                or info.st_mode & 0o022
                or not 1 <= info.st_size <= 8 * 1024 * 1024
            ):
                raise ValueError("BOOTSTRAP_BUILD_REFUSED")
            destination = output / target
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            shutil.copyfile(source, destination, follow_symlinks=False)
            mode = 0o755 if target.startswith("usr/libexec/") else 0o644
            destination.chmod(mode)
            raw = destination.read_bytes()
            files.append({
                "path": target,
                "sha256": hashlib.sha256(raw).hexdigest(),
                "size": len(raw),
                "mode": mode,
            })
        manifest = _canonical({
            "schemaVersion": 1,
            "commit": commit,
            "files": files,
        })
        path = output / "bootstrap.json"
        path.write_bytes(manifest)
        path.chmod(0o644)
        return manifest
    except BaseException:
        shutil.rmtree(output, ignore_errors=True)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    values = parser.parse_args(argv)
    try:
        raw = build(values.output, values.commit, expected_uid=os.getuid())
        print(hashlib.sha256(raw).hexdigest())
        return 0
    except (OSError, ValueError):
        print("BOOTSTRAP_BUILD_REFUSED", file=sys.stderr)
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
