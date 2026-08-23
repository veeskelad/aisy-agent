"""Manifest-verified root installer for the Aisy voice proxy release."""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

SCHEMA_VERSION = 1
PROTOCOL_VERSION = 1
MAX_MANIFEST_BYTES = 128 * 1024
MAX_FILE_BYTES = 8 * 1024 * 1024
_HASH = re.compile(r"^[a-f0-9]{64}$")
_COMMIT = re.compile(r"^[a-f0-9]{40,64}$")
_RELEASE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
_FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.@_/-]{0,199}$")
_CGROUP = re.compile(r"^/[A-Za-z0-9_.@:/-]{1,511}$")
_ALLOWED_MODES = frozenset({0o644, 0o755})
RENAME_EXCHANGE = 2
INSTALL_ROOT = Path("/usr/lib/aisy/voice-proxy")
STATE_ROOT = Path("/var/lib/aisy/voice")
CONFIG_PATH = Path("/etc/aisy/voice-proxy.json")
UNIT_ROOT = Path("/etc/systemd/system")
PYTHON = Path("/usr/bin/python3.12")
SYSTEMD_CREDS = Path("/usr/bin/systemd-creds")
WORKER_USER = "aisy-voice-proxy"


class InstallFailure(Exception):
    """Stable, redacted installer refusal."""


@dataclass(frozen=True)
class ManifestFile:
    path: str
    sha256: str
    size: int
    mode: int


@dataclass(frozen=True)
class ReleaseManifest:
    release: str
    commit: str
    files: tuple[ManifestFile, ...]
    digest: str
    raw: bytes


def _object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise InstallFailure("MANIFEST_REFUSED")
        result[key] = value
    return result


def _member(path: object) -> str:
    if not isinstance(path, str) or _FILE.fullmatch(path) is None:
        raise InstallFailure("MANIFEST_REFUSED")
    pure = PurePosixPath(path)
    if pure.is_absolute() or ".." in pure.parts or "." in pure.parts or len(pure.parts) < 1:
        raise InstallFailure("MANIFEST_REFUSED")
    return path


def _root(path: Path, expected_uid: int) -> tuple[int, os.stat_result]:
    try:
        info = path.lstat()
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != expected_uid
            or info.st_mode & 0o022
            or path.resolve(strict=True) != path.absolute()
        ):
            raise OSError
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise OSError
        return descriptor, opened
    except OSError:
        raise InstallFailure("SOURCE_REFUSED") from None


def _open_member(root_fd: int, root_info: os.stat_result, member: str, uid: int) -> int:
    current = os.dup(root_fd)
    try:
        parts = PurePosixPath(member).parts
        for part in parts[:-1]:
            child = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=current,
            )
            os.close(current)
            current = child
            info = os.fstat(current)
            if (
                not stat.S_ISDIR(info.st_mode)
                or info.st_uid != uid
                or info.st_mode & 0o022
                or info.st_dev != root_info.st_dev
            ):
                raise OSError
        descriptor = os.open(
            parts[-1], os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=current,
        )
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != uid
            or info.st_dev != root_info.st_dev
            or not 1 <= info.st_size <= MAX_FILE_BYTES
            or stat.S_IMODE(info.st_mode) not in _ALLOWED_MODES
        ):
            os.close(descriptor)
            raise OSError
        return descriptor
    except OSError:
        raise InstallFailure("SOURCE_REFUSED") from None
    finally:
        os.close(current)


def _read(descriptor: int, maximum: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = os.read(descriptor, min(65536, maximum + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > maximum:
            raise InstallFailure("SOURCE_REFUSED")
        chunks.append(chunk)
    return b"".join(chunks)


def _write_all(descriptor: int, content: bytes) -> None:
    offset = 0
    while offset < len(content):
        written = os.write(descriptor, content[offset:])
        if written <= 0:
            raise InstallFailure("PUBLISH_REFUSED")
        offset += written


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def verify_bundle(
    source: Path,
    *,
    expected_manifest_sha256: str,
    expected_commit: str,
    expected_uid: int = 0,
) -> ReleaseManifest:
    if _HASH.fullmatch(expected_manifest_sha256) is None or _COMMIT.fullmatch(expected_commit) is None:
        raise InstallFailure("EXPECTED_RELEASE_REFUSED")
    root_fd, root_info = _root(source, expected_uid)
    try:
        manifest_fd = _open_member(root_fd, root_info, "manifest.json", expected_uid)
        try:
            raw = _read(manifest_fd, MAX_MANIFEST_BYTES)
        finally:
            os.close(manifest_fd)
        digest = hashlib.sha256(raw).hexdigest()
        if digest != expected_manifest_sha256:
            raise InstallFailure("MANIFEST_DIGEST_REFUSED")
        try:
            value = json.loads(raw, object_pairs_hook=_object)
        except (UnicodeDecodeError, json.JSONDecodeError, InstallFailure):
            raise InstallFailure("MANIFEST_REFUSED") from None
        if not isinstance(value, dict) or set(value) != {
            "schemaVersion", "protocolVersion", "release", "commit", "files",
        }:
            raise InstallFailure("MANIFEST_REFUSED")
        if (
            value["schemaVersion"] != SCHEMA_VERSION
            or value["protocolVersion"] != PROTOCOL_VERSION
            or not isinstance(value["release"], str)
            or _RELEASE.fullmatch(value["release"]) is None
            or value["commit"] != expected_commit
            or not isinstance(value["files"], list)
            or not 1 <= len(value["files"]) <= 64
        ):
            raise InstallFailure("MANIFEST_REFUSED")
        files: list[ManifestFile] = []
        previous = ""
        for entry in value["files"]:
            if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "size", "mode"}:
                raise InstallFailure("MANIFEST_REFUSED")
            member = _member(entry["path"])
            if member <= previous or member == "manifest.json":
                raise InstallFailure("MANIFEST_REFUSED")
            previous = member
            if (
                not isinstance(entry["sha256"], str) or _HASH.fullmatch(entry["sha256"]) is None
                or isinstance(entry["size"], bool) or not isinstance(entry["size"], int)
                or not 1 <= entry["size"] <= MAX_FILE_BYTES
                or isinstance(entry["mode"], bool) or entry["mode"] not in _ALLOWED_MODES
            ):
                raise InstallFailure("MANIFEST_REFUSED")
            descriptor = _open_member(root_fd, root_info, member, expected_uid)
            try:
                info = os.fstat(descriptor)
                content = _read(descriptor, entry["size"])
                after = os.fstat(descriptor)
            finally:
                os.close(descriptor)
            if (
                len(content) != entry["size"]
                or stat.S_IMODE(info.st_mode) != entry["mode"]
                or hashlib.sha256(content).hexdigest() != entry["sha256"]
                or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            ):
                raise InstallFailure("FILE_DIGEST_REFUSED")
            files.append(ManifestFile(member, entry["sha256"], entry["size"], entry["mode"]))
        return ReleaseManifest(
            value["release"], value["commit"], tuple(files), digest, raw
        )
    finally:
        os.close(root_fd)


def stage_bundle(
    source: Path,
    manifest: ReleaseManifest,
    destination: Path,
    *,
    expected_uid: int = 0,
) -> None:
    root_fd, root_info = _root(source, expected_uid)
    try:
        destination.mkdir(mode=0o755, parents=False, exist_ok=False)
        for item in manifest.files:
            target = destination / item.path
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            descriptor = _open_member(root_fd, root_info, item.path, expected_uid)
            output = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, item.mode)
            digest = hashlib.sha256()
            total = 0
            try:
                while True:
                    chunk = os.read(descriptor, 65536)
                    if not chunk:
                        break
                    _write_all(output, chunk)
                    digest.update(chunk)
                    total += len(chunk)
                os.fchmod(output, item.mode)
                os.fsync(output)
            finally:
                os.close(output)
                os.close(descriptor)
            if total != item.size or digest.hexdigest() != item.sha256:
                raise InstallFailure("SOURCE_CHANGED")
        manifest_path = destination / "manifest.json"
        manifest_path.write_bytes(manifest.raw)
        os.chmod(manifest_path, 0o644)
        manifest_fd = os.open(manifest_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            os.fsync(manifest_fd)
        finally:
            os.close(manifest_fd)
        directories = [path for path in destination.rglob("*") if path.is_dir()]
        for directory in sorted(directories, key=lambda path: len(path.parts), reverse=True):
            _fsync_directory(directory)
        _fsync_directory(destination)
        _fsync_directory(destination.parent)
    except BaseException:
        shutil.rmtree(destination, ignore_errors=True)
        raise
    finally:
        os.close(root_fd)


def exchange_directories(left: Path, right: Path) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None or renameat2(-100, os.fsencode(left), -100, os.fsencode(right), RENAME_EXCHANGE) != 0:
        raise InstallFailure("ATOMIC_CUTOVER_REFUSED")


def activate_staged(
    staged: Path,
    current: Path,
    previous: Path,
    exchange: Callable[[Path, Path], None] = exchange_directories,
) -> None:
    if not current.exists():
        os.rename(staged, current)
        _fsync_directory(current.parent)
        return
    exchange(staged, current)
    if previous.exists():
        exchange(staged, previous)
        shutil.rmtree(staged)
    else:
        os.rename(staged, previous)
    _fsync_directory(current.parent)


def rollback(
    current: Path,
    previous: Path,
    handshake: Callable[[Path], bool],
    exchange: Callable[[Path, Path], None] = exchange_directories,
) -> None:
    if not current.is_dir() or not previous.is_dir() or not handshake(previous):
        raise InstallFailure("ROLLBACK_REFUSED")
    exchange(current, previous)
    _fsync_directory(current.parent)
    if not handshake(current):
        exchange(current, previous)
        _fsync_directory(current.parent)
        raise InstallFailure("ROLLBACK_HANDSHAKE_REFUSED")


CommandRunner = Callable[[list[str]], None]


def _run(argv: list[str]) -> None:
    try:
        subprocess.run(
            argv,
            check=True,
            cwd="/",
            env={"PATH": "/usr/sbin:/usr/bin"},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            close_fds=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        raise InstallFailure("COMMAND_REFUSED") from None


def _system_file(path: Path, *, executable: bool) -> None:
    try:
        info = path.lstat()
        mode = stat.S_IMODE(info.st_mode)
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or mode & 0o022
            or (executable and mode & 0o111 == 0)
            or path.resolve(strict=True) != path.absolute()
        ):
            raise OSError
    except OSError:
        raise InstallFailure("HOST_REFUSED") from None


def _root_directory(path: Path, mode: int | None = None) -> None:
    try:
        info = path.lstat()
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_mode & 0o022
            or (mode is not None and stat.S_IMODE(info.st_mode) != mode)
            or path.resolve(strict=True) != path.absolute()
        ):
            raise OSError
    except OSError:
        raise InstallFailure("INSTALL_ROOT_REFUSED") from None


def verify_host() -> None:
    if os.geteuid() != 0 or sys.platform != "linux":
        raise InstallFailure("HOST_REFUSED")
    _system_file(PYTHON, executable=True)
    _system_file(SYSTEMD_CREDS, executable=True)
    try:
        result = subprocess.run(
            ["/usr/bin/systemd", "--version"],
            check=True,
            cwd="/",
            env={"PATH": "/usr/bin"},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            timeout=5,
        )
        version = int(result.stdout.split(maxsplit=2)[1], 10)
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        raise InstallFailure("HOST_REFUSED") from None
    if version < 255:
        raise InstallFailure("HOST_REFUSED")


def worker_uid(runner: CommandRunner = _run) -> int:
    try:
        account = pwd.getpwnam(WORKER_USER)
    except KeyError:
        runner([
            "/usr/sbin/useradd", "--system", "--user-group",
            "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin",
            WORKER_USER,
        ])
        try:
            account = pwd.getpwnam(WORKER_USER)
        except KeyError:
            raise InstallFailure("ACCOUNT_REFUSED") from None
    if account.pw_uid == 0 or account.pw_dir != "/nonexistent":
        raise InstallFailure("ACCOUNT_REFUSED")
    return account.pw_uid


def _atomic_file(path: Path, raw: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    _root_directory(path.parent)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        mode,
    )
    try:
        _write_all(descriptor, raw)
        os.fchmod(descriptor, mode)
        os.fchown(descriptor, 0, 0)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def _config(
    release: str,
    runtime_uid: int,
    runtime_cgroup: str,
    installation_hash: str,
) -> bytes:
    if (
        _RELEASE.fullmatch(release) is None
        or isinstance(runtime_uid, bool)
        or not 1 <= runtime_uid <= 2**31 - 1
        or not isinstance(runtime_cgroup, str)
        or _CGROUP.fullmatch(runtime_cgroup) is None
        or "//" in runtime_cgroup
        or ".." in Path(runtime_cgroup).parts
        or _HASH.fullmatch(installation_hash) is None
    ):
        raise InstallFailure("CONFIG_REFUSED")
    return (json.dumps({
        "schemaVersion": 1,
        "runtimeUid": runtime_uid,
        "runtimeCgroup": runtime_cgroup,
        "release": release,
        "installationHash": installation_hash,
    }, sort_keys=True, separators=(",", ":")) + "\n").encode()


_BROKER_UNIT_GATES = (
    "User=root", "NoNewPrivileges=yes", "ProtectSystem=strict",
    "CapabilityBoundingSet=", "MemoryDenyWriteExecute=yes",
)
_WORKER_UNIT_GATES = (
    f"User={WORKER_USER}", "LoadCredentialEncrypted=aisy-deepgram-cloud-primary:",
    "StandardInput=socket", "NoNewPrivileges=yes", "ProtectSystem=strict",
    "IPAddressDeny=localhost", "IPAddressDeny=10.0.0.0/8",
)


def validate_units(release_root: Path) -> dict[str, bytes]:
    sources = {
        "aisy-voice-broker.service": _BROKER_UNIT_GATES,
        "aisy-voice-worker.socket": ("ListenSequentialPacket=", "SocketMode=0600"),
        "aisy-voice-worker@.service": _WORKER_UNIT_GATES,
    }
    validated: dict[str, bytes] = {}
    for name, gates in sources.items():
        source = release_root / "systemd" / name
        try:
            raw = source.read_bytes()
            text = raw.decode("utf-8")
        except (OSError, UnicodeDecodeError):
            raise InstallFailure("UNIT_REFUSED") from None
        if not raw or len(raw) > 32 * 1024 or any(gate not in text for gate in gates):
            raise InstallFailure("UNIT_REFUSED")
        validated[name] = raw
    return validated


def install_units(release_root: Path) -> None:
    for name, raw in validate_units(release_root).items():
        _atomic_file(UNIT_ROOT / name, raw, 0o644)


def release_name(root: Path) -> str:
    try:
        value = json.loads((root / "manifest.json").read_bytes(), object_pairs_hook=_object)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, InstallFailure):
        raise InstallFailure("MANIFEST_REFUSED") from None
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != SCHEMA_VERSION
        or value.get("protocolVersion") != PROTOCOL_VERSION
        or not isinstance(value.get("release"), str)
        or _RELEASE.fullmatch(value["release"]) is None
    ):
        raise InstallFailure("MANIFEST_REFUSED")
    return value["release"]


def release_handshake(root: Path, runner: CommandRunner = _run) -> bool:
    try:
        release = release_name(root)
        launcher = root / "voice_proxy_service.py"
        _system_file(launcher, executable=True)
        runner([str(PYTHON), "-I", str(launcher), "self-check", release])
        return True
    except InstallFailure:
        return False


def restart_services(runner: CommandRunner = _run) -> None:
    runner(["/usr/bin/systemctl", "daemon-reload"])
    runner([
        "/usr/bin/systemctl", "enable",
        "aisy-voice-broker.service", "aisy-voice-worker.socket",
    ])
    runner([
        "/usr/bin/systemctl", "restart", "aisy-voice-broker.service",
    ])
    runner([
        "/usr/bin/systemctl", "restart", "aisy-voice-worker.socket",
    ])
    runner(["/usr/bin/systemctl", "is-active", "aisy-voice-broker.service"])
    runner(["/usr/bin/systemctl", "is-active", "aisy-voice-worker.socket"])


def install_release(
    source: Path,
    *,
    expected_manifest_sha256: str,
    expected_commit: str,
    runtime_uid: int,
    runtime_cgroup: str,
    installation_hash: str,
    runner: CommandRunner = _run,
) -> ReleaseManifest:
    verify_host()
    worker_uid(runner)
    manifest = verify_bundle(
        source,
        expected_manifest_sha256=expected_manifest_sha256,
        expected_commit=expected_commit,
    )
    INSTALL_ROOT.mkdir(parents=True, exist_ok=True, mode=0o755)
    STATE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chown(INSTALL_ROOT, 0, 0)
    os.chmod(INSTALL_ROOT, 0o755)
    os.chown(STATE_ROOT, 0, 0)
    os.chmod(STATE_ROOT, 0o700)
    _root_directory(INSTALL_ROOT, 0o755)
    _root_directory(STATE_ROOT, 0o700)
    staged = INSTALL_ROOT / f".stage-{os.getpid()}-{int(time.time())}"
    current = INSTALL_ROOT / "current"
    previous = INSTALL_ROOT / "previous"
    stage_bundle(source, manifest, staged)
    if not release_handshake(staged, runner):
        shutil.rmtree(staged, ignore_errors=True)
        raise InstallFailure("HANDSHAKE_REFUSED")
    activate_staged(staged, current, previous)
    try:
        _atomic_file(
            CONFIG_PATH,
            _config(
                manifest.release, runtime_uid, runtime_cgroup, installation_hash
            ),
            0o644,
        )
        install_units(current)
        restart_services(runner)
    except BaseException:
        if previous.is_dir():
            rollback(current, previous, lambda root: release_handshake(root, runner))
            old_release = release_name(current)
            _atomic_file(
                CONFIG_PATH,
                _config(old_release, runtime_uid, runtime_cgroup, installation_hash),
                0o644,
            )
            install_units(current)
            restart_services(runner)
        raise
    return manifest


def rollback_release(
    *,
    runtime_uid: int,
    runtime_cgroup: str,
    installation_hash: str,
    runner: CommandRunner = _run,
) -> str:
    verify_host()
    _root_directory(INSTALL_ROOT, 0o755)
    current = INSTALL_ROOT / "current"
    previous = INSTALL_ROOT / "previous"
    rollback(current, previous, lambda root: release_handshake(root, runner))
    release = release_name(current)
    _atomic_file(
        CONFIG_PATH,
        _config(release, runtime_uid, runtime_cgroup, installation_hash),
        0o644,
    )
    install_units(current)
    restart_services(runner)
    return release


def uninstall_preserving_encrypted_state(
    runner: CommandRunner = _run,
) -> None:
    verify_host()
    runner([
        "/usr/bin/systemctl", "disable", "--now",
        "aisy-voice-worker.socket", "aisy-voice-broker.service",
    ])
    for name in (
        "aisy-voice-broker.service",
        "aisy-voice-worker.socket",
        "aisy-voice-worker@.service",
    ):
        path = UNIT_ROOT / name
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
                raise InstallFailure("UNIT_REFUSED")
            path.unlink()
        except FileNotFoundError:
            pass
    runner(["/usr/bin/systemctl", "daemon-reload"])
    try:
        info = INSTALL_ROOT.lstat()
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
        ):
            raise InstallFailure("INSTALL_ROOT_REFUSED")
        shutil.rmtree(INSTALL_ROOT)
    except FileNotFoundError:
        pass
    try:
        info = CONFIG_PATH.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
            raise InstallFailure("CONFIG_REFUSED")
        CONFIG_PATH.unlink()
    except FileNotFoundError:
        pass


def _arguments(argv: list[str], names: tuple[str, ...]) -> dict[str, str]:
    if len(argv) != len(names):
        raise InstallFailure("ARGUMENT_REFUSED")
    result: dict[str, str] = {}
    for raw in argv:
        if not raw.startswith("--") or "=" not in raw:
            raise InstallFailure("ARGUMENT_REFUSED")
        name, value = raw[2:].split("=", 1)
        if name in result or name not in names or not value or "\0" in value:
            raise InstallFailure("ARGUMENT_REFUSED")
        result[name] = value
    if set(result) != set(names):
        raise InstallFailure("ARGUMENT_REFUSED")
    return result


def _uid(raw: str) -> int:
    if not raw.isascii() or not raw.isdecimal():
        raise InstallFailure("ARGUMENT_REFUSED")
    value = int(raw, 10)
    if not 1 <= value <= 2**31 - 1:
        raise InstallFailure("ARGUMENT_REFUSED")
    return value


def main(argv: list[str] | None = None) -> int:
    values = list(sys.argv[1:] if argv is None else argv)
    try:
        if not values:
            raise InstallFailure("ARGUMENT_REFUSED")
        operation = values.pop(0)
        shared = ("runtime-uid", "runtime-cgroup", "installation-hash")
        if operation == "install":
            arguments = _arguments(values, (
                "source", "expected-manifest-sha256", "expected-commit", *shared,
            ))
            manifest = install_release(
                Path(arguments["source"]),
                expected_manifest_sha256=arguments["expected-manifest-sha256"],
                expected_commit=arguments["expected-commit"],
                runtime_uid=_uid(arguments["runtime-uid"]),
                runtime_cgroup=arguments["runtime-cgroup"],
                installation_hash=arguments["installation-hash"],
            )
            print(f"installed {manifest.release}")
            return 0
        if operation == "rollback":
            arguments = _arguments(values, shared)
            release = rollback_release(
                runtime_uid=_uid(arguments["runtime-uid"]),
                runtime_cgroup=arguments["runtime-cgroup"],
                installation_hash=arguments["installation-hash"],
            )
            print(f"rolled back {release}")
            return 0
        if operation == "uninstall" and values == [
            "--preserve-encrypted-credential"
        ]:
            uninstall_preserving_encrypted_state()
            print("uninstalled; encrypted state preserved")
            return 0
        raise InstallFailure("ARGUMENT_REFUSED")
    except InstallFailure as error:
        print(str(error), file=sys.stderr)
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
