#!/usr/bin/python3.12 -I
"""Install one externally pinned Aisy SSH bootstrap from root-owned staging."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path, PurePosixPath

_HASH = re.compile(r"^[a-f0-9]{64}$")
_COMMIT = re.compile(r"^[a-f0-9]{40}(?:[a-f0-9]{24})?$")
_DEPLOYMENT = re.compile(r"^[a-f0-9]{32}$")
_PATH = re.compile(r"^usr/(?:lib|libexec)/[A-Za-z0-9._/-]{1,199}$")
_MODES = frozenset({0o644, 0o755})
_MAX_FILE = 8 * 1024 * 1024
_EXPECTED_TARGETS = frozenset({
    "usr/lib/aisy/bootstrap/aisy_sidecars/__init__.py",
    "usr/lib/aisy/bootstrap/aisy_sidecars/sidecar_bundle_delivery.py",
    "usr/lib/aisy/bootstrap/aisy_sidecars/sidecar_bundle_install.py",
    "usr/lib/aisy/bootstrap/aisy_sidecars/system_runtime_binding.py",
    "usr/libexec/aisy-sidecar-receiver",
    "usr/libexec/aisy-provider-install",
    "usr/libexec/aisy-voice-install",
})


class BootstrapFailure(Exception):
    pass


def _object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise BootstrapFailure("BOOTSTRAP_SOURCE_REFUSED")
        result[key] = value
    return result


def _canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _safe_directory(path: Path, expected_uid: int, mode: int | None = None) -> None:
    try:
        info = path.lstat()
        if (
            not path.is_absolute()
            or path.resolve(strict=True) != path.absolute()
            or not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != expected_uid
            or info.st_mode & 0o022
            or (mode is not None and stat.S_IMODE(info.st_mode) != mode)
        ):
            raise OSError
    except OSError:
        raise BootstrapFailure("BOOTSTRAP_SOURCE_REFUSED") from None


def _safe_chain(path: Path, expected_uid: int) -> None:
    current = path
    while True:
        try:
            info = current.lstat()
            if (
                not current.is_absolute()
                or current.resolve(strict=True) != current.absolute()
                or not stat.S_ISDIR(info.st_mode)
                or stat.S_ISLNK(info.st_mode)
                or info.st_uid not in {0, expected_uid}
                or info.st_mode & 0o022
            ):
                raise OSError
        except OSError:
            raise BootstrapFailure("BOOTSTRAP_SOURCE_REFUSED") from None
        parent = current.parent
        if parent == current:
            return
        current = parent


def _ensure_target_directory(
    path: Path,
    *,
    target_root: Path,
    expected_uid: int,
    final_mode: int,
) -> None:
    try:
        relative = path.relative_to(target_root)
    except ValueError:
        raise BootstrapFailure("BOOTSTRAP_TARGET_REFUSED") from None
    current = target_root
    _safe_directory(current, expected_uid)
    for index, part in enumerate(relative.parts):
        current /= part
        mode = final_mode if index == len(relative.parts) - 1 else 0o755
        try:
            current.mkdir(mode=mode)
        except FileExistsError:
            pass
        try:
            info = current.lstat()
            if (
                not stat.S_ISDIR(info.st_mode)
                or stat.S_ISLNK(info.st_mode)
                or info.st_uid != expected_uid
                or info.st_mode & 0o022
            ):
                raise OSError
            if index == len(relative.parts) - 1:
                current.chmod(mode)
        except OSError:
            raise BootstrapFailure("BOOTSTRAP_TARGET_REFUSED") from None


def _read(path: Path, expected_uid: int, mode: int, maximum: int) -> bytes:
    descriptor = -1
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != expected_uid
            or before.st_nlink != 1
            or stat.S_IMODE(before.st_mode) != mode
            or not 1 <= before.st_size <= maximum
        ):
            raise OSError
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(65536, maximum + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > maximum:
                raise OSError
            chunks.append(chunk)
        after = os.fstat(descriptor)
        if (
            total != before.st_size
            or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        ):
            raise OSError
        return b"".join(chunks)
    except OSError:
        raise BootstrapFailure("BOOTSTRAP_SOURCE_REFUSED") from None
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _inventory(root: Path) -> tuple[set[str], set[str]]:
    files: set[str] = set()
    directories: set[str] = set()
    try:
        root_info = root.lstat()
        for path in root.rglob("*"):
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or info.st_dev != root_info.st_dev:
                raise OSError
            if stat.S_ISDIR(info.st_mode):
                if info.st_uid != root_info.st_uid or info.st_mode & 0o022:
                    raise OSError
                directories.add(path.relative_to(root).as_posix())
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise OSError
            files.add(path.relative_to(root).as_posix())
    except OSError:
        raise BootstrapFailure("BOOTSTRAP_SOURCE_REFUSED") from None
    return files, directories


def _parse_manifest(raw: bytes, expected_digest: str, expected_commit: str) -> tuple[dict[str, object], ...]:
    try:
        value = json.loads(raw, object_pairs_hook=_object)
    except (UnicodeDecodeError, json.JSONDecodeError, BootstrapFailure):
        raise BootstrapFailure("BOOTSTRAP_SOURCE_REFUSED") from None
    if (
        hashlib.sha256(raw).hexdigest() != expected_digest
        or not isinstance(value, dict)
        or set(value) != {"schemaVersion", "commit", "files"}
        or _canonical(value) != raw
        or value["schemaVersion"] != 1
        or value["commit"] != expected_commit
        or not isinstance(value["files"], list)
        or len(value["files"]) != len(_EXPECTED_TARGETS)
    ):
        raise BootstrapFailure("BOOTSTRAP_AUTHORITY_REFUSED")
    files: list[dict[str, object]] = []
    previous = ""
    for item in value["files"]:
        if not isinstance(item, dict) or set(item) != {"path", "sha256", "size", "mode"}:
            raise BootstrapFailure("BOOTSTRAP_SOURCE_REFUSED")
        path = item["path"]
        pure = PurePosixPath(path) if isinstance(path, str) else PurePosixPath("/")
        if (
            not isinstance(path, str)
            or _PATH.fullmatch(path) is None
            or pure.is_absolute()
            or "." in pure.parts
            or ".." in pure.parts
            or path <= previous
            or not isinstance(item["sha256"], str)
            or _HASH.fullmatch(item["sha256"]) is None
            or isinstance(item["size"], bool)
            or not isinstance(item["size"], int)
            or not 1 <= item["size"] <= _MAX_FILE
            or isinstance(item["mode"], bool)
            or item["mode"] not in _MODES
        ):
            raise BootstrapFailure("BOOTSTRAP_SOURCE_REFUSED")
        previous = path
        files.append(item)
    if {str(item["path"]) for item in files} != _EXPECTED_TARGETS:
        raise BootstrapFailure("BOOTSTRAP_SOURCE_REFUSED")
    return tuple(files)


def _write_exclusive(path: Path, raw: bytes, mode: int) -> None:
    descriptor = -1
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            mode,
        )
        offset = 0
        while offset < len(raw):
            written = os.write(descriptor, raw[offset:])
            if written <= 0:
                raise OSError
            offset += written
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    except OSError:
        raise BootstrapFailure("BOOTSTRAP_TARGET_REFUSED") from None
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def install(
    source: Path,
    *,
    expected_manifest_sha256: str,
    expected_commit: str,
    target_root: Path = Path("/"),
    incoming_root: Path = Path("/usr/lib/aisy/bootstrap-incoming"),
    expected_uid: int = 0,
) -> None:
    if (
        _HASH.fullmatch(expected_manifest_sha256) is None
        or _COMMIT.fullmatch(expected_commit) is None
        or source.parent != incoming_root
        or _DEPLOYMENT.fullmatch(source.name) is None
    ):
        raise BootstrapFailure("BOOTSTRAP_AUTHORITY_REFUSED")
    _safe_directory(incoming_root, expected_uid, 0o700)
    _safe_chain(incoming_root, expected_uid)
    _safe_directory(source, expected_uid, 0o700)
    if source.stat().st_dev != incoming_root.stat().st_dev:
        raise BootstrapFailure("BOOTSTRAP_SOURCE_REFUSED")
    raw = _read(source / "bootstrap.json", expected_uid, 0o644, 256 * 1024)
    files = _parse_manifest(raw, expected_manifest_sha256, expected_commit)
    expected_files = {"bootstrap.json", *(str(item["path"]) for item in files)}
    expected_directories: set[str] = set()
    for member in expected_files:
        parent = PurePosixPath(member).parent
        while parent != PurePosixPath("."):
            expected_directories.add(parent.as_posix())
            parent = parent.parent
    if _inventory(source) != (expected_files, expected_directories):
        raise BootstrapFailure("BOOTSTRAP_SOURCE_REFUSED")
    verified: list[tuple[Path, bytes, int]] = []
    for item in files:
        relative = Path(str(item["path"]))
        content = _read(source / relative, expected_uid, int(item["mode"]), _MAX_FILE)
        if len(content) != item["size"] or hashlib.sha256(content).hexdigest() != item["sha256"]:
            raise BootstrapFailure("BOOTSTRAP_SOURCE_REFUSED")
        verified.append((target_root / relative, content, int(item["mode"])))
    for path, content, mode in verified:
        _ensure_target_directory(
            path.parent,
            target_root=target_root,
            expected_uid=expected_uid,
            final_mode=0o755,
        )
        if path.exists() or path.is_symlink():
            if path.is_symlink() or _read(path, expected_uid, mode, _MAX_FILE) != content:
                raise BootstrapFailure("BOOTSTRAP_TARGET_REFUSED")
            continue
        _write_exclusive(path, content, mode)
    for relative in ("usr/lib/aisy/incoming", "var/lib/aisy/delivery"):
        path = target_root / relative
        _ensure_target_directory(
            path,
            target_root=target_root,
            expected_uid=expected_uid,
            final_mode=0o700,
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--expected-manifest-sha256", required=True)
    parser.add_argument("--expected-commit", required=True)
    values = parser.parse_args(argv)
    try:
        if os.geteuid() != 0 or sys.platform != "linux":
            raise BootstrapFailure("BOOTSTRAP_AUTHORITY_REFUSED")
        install(
            values.source,
            expected_manifest_sha256=values.expected_manifest_sha256,
            expected_commit=values.expected_commit,
        )
        print("installed")
        return 0
    except BootstrapFailure as error:
        print(str(error), file=sys.stderr)
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
