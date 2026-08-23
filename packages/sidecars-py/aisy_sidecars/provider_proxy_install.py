"""Manifest-verified install and rollback for the Aisy provider broker."""

from __future__ import annotations

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
from pathlib import Path

from .provider_broker_protocol import DESCRIPTOR_BY_PROVIDER
from .voice_proxy_install import (
    InstallFailure,
    ReleaseManifest,
    _atomic_file,
    _fsync_directory,
    _root_directory,
    _run,
    _system_file,
    activate_staged,
    rollback,
    stage_bundle,
    verify_bundle,
)

INSTALL_ROOT = Path("/usr/lib/aisy/provider-broker")
STATE_ROOT = Path("/var/lib/aisy/provider")
CONFIG_PATH = Path("/etc/aisy/provider-broker.json")
UNIT_ROOT = Path("/etc/systemd/system")
PYTHON = Path("/usr/bin/python3.12")
SYSTEMD_CREDS = Path("/usr/bin/systemd-creds")
SYSTEMD = Path("/usr/bin/systemd")
WORKER_USER = "aisy-provider-proxy"
BROKER_UNIT = "aisy-provider-broker.service"
WORKER_SERVICE = "aisy-provider-worker@.service"
WORKER_SOCKET = "aisy-provider-worker@.socket"
VALIDATOR_SERVICE = "aisy-provider-validator@.service"
VALIDATOR_SOCKET = "aisy-provider-validator@.socket"
_HASH = re.compile(r"^[a-f0-9]{64}$")
_RELEASE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
_UNIT = re.compile(r"^[A-Za-z0-9_.@-]{1,128}\.service$")
_CGROUP = re.compile(r"^/[A-Za-z0-9_.@:/-]{1,511}$")
_PRESERVE_OPTION = "--preserve-encrypted-credentials"

CommandRunner = Callable[[list[str]], None]
Verifier = Callable[[], None]


def verify_host() -> None:
    if os.geteuid() != 0 or sys.platform != "linux":
        raise InstallFailure("HOST_REFUSED")
    _system_file(PYTHON, executable=True)
    _system_file(SYSTEMD_CREDS, executable=True)
    try:
        result = subprocess.run(
            [str(SYSTEMD), "--version"],
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


def worker_identity(runner: CommandRunner = _run) -> tuple[int, int]:
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
    if account.pw_uid == 0 or account.pw_gid == 0 or account.pw_dir != "/nonexistent":
        raise InstallFailure("ACCOUNT_REFUSED")
    return account.pw_uid, account.pw_gid


def _providers(raw: str) -> tuple[str, ...]:
    values = tuple(raw.split(","))
    if (
        not values
        or values != tuple(sorted(values))
        or len(set(values)) != len(values)
        or any(value not in DESCRIPTOR_BY_PROVIDER for value in values)
    ):
        raise InstallFailure("CONFIG_REFUSED")
    return values


def config_bytes(
    *,
    runtime_uid: int,
    runtime_gid: int,
    runtime_unit: str,
    runtime_cgroup: str,
    installation_hash: str,
    release_digest: str,
    providers: tuple[str, ...],
) -> bytes:
    if (
        isinstance(runtime_uid, bool) or not 1 <= runtime_uid <= 2**31 - 1
        or isinstance(runtime_gid, bool) or not 1 <= runtime_gid <= 2**31 - 1
        or _UNIT.fullmatch(runtime_unit) is None
        or _CGROUP.fullmatch(runtime_cgroup) is None
        or "//" in runtime_cgroup
        or _HASH.fullmatch(installation_hash) is None
        or _HASH.fullmatch(release_digest) is None
        or not providers
        or providers != tuple(sorted(providers))
        or len(set(providers)) != len(providers)
        or any(value not in DESCRIPTOR_BY_PROVIDER for value in providers)
    ):
        raise InstallFailure("CONFIG_REFUSED")
    return (json.dumps({
        "schemaVersion": 1,
        "runtimeUid": runtime_uid,
        "runtimeGid": runtime_gid,
        "runtimeUnit": runtime_unit,
        "runtimeCgroup": runtime_cgroup,
        "installationHash": installation_hash,
        "releaseDigest": release_digest,
        "providers": list(providers),
    }, sort_keys=True, separators=(",", ":")) + "\n").encode()


def validate_units(release_root: Path) -> dict[str, bytes]:
    gates = {
        BROKER_UNIT: (
            "User=root", "RestrictAddressFamilies=AF_UNIX", "ProtectSystem=strict",
            "MemoryDenyWriteExecute=yes", "RuntimeDirectoryPreserve=yes",
        ),
        WORKER_SERVICE: (
            f"User={WORKER_USER}", "LoadCredentialEncrypted=aisy-provider:",
            "CapabilityBoundingSet=", "ProtectSystem=strict", "IPAddressDeny=localhost",
        ),
        WORKER_SOCKET: (
            "ListenStream=/run/aisy/provider/worker-%i.sock", "SocketMode=0600", "Accept=no",
            "DirectoryMode=0755",
        ),
        VALIDATOR_SERVICE: (
            f"User={WORKER_USER}", "validator --provider=%i", "CapabilityBoundingSet=",
            "ProtectSystem=strict", "IPAddressDeny=localhost",
        ),
        VALIDATOR_SOCKET: (
            "ListenStream=/run/aisy/provider/validator-%i.sock", "SocketMode=0600", "Accept=no",
            "DirectoryMode=0755",
        ),
    }
    result: dict[str, bytes] = {}
    for name, required in gates.items():
        path = release_root / "systemd" / name
        try:
            info = path.lstat()
            raw = path.read_bytes()
            text = raw.decode("utf-8")
        except (OSError, UnicodeDecodeError):
            raise InstallFailure("UNIT_REFUSED") from None
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or not raw
            or len(raw) > 32 * 1024
            or any(value not in text for value in required)
        ):
            raise InstallFailure("UNIT_REFUSED")
        result[name] = raw
    return result


def install_units(release_root: Path) -> None:
    for name, raw in validate_units(release_root).items():
        _atomic_file(UNIT_ROOT / name, raw, 0o644)


def installed_metadata(root: Path, *, expected_uid: int = 0) -> tuple[str, str]:
    path = root / "manifest.json"
    try:
        info = path.lstat()
        raw = path.read_bytes()
        value = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise InstallFailure("MANIFEST_REFUSED") from None
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != expected_uid
        or info.st_mode & 0o022
        or not isinstance(value, dict)
        or value.get("schemaVersion") != 1
        or value.get("protocolVersion") != 1
        or not isinstance(value.get("release"), str)
        or _RELEASE.fullmatch(value["release"]) is None
    ):
        raise InstallFailure("MANIFEST_REFUSED")
    return value["release"], hashlib.sha256(raw).hexdigest()


def release_handshake(root: Path, runner: CommandRunner = _run) -> bool:
    try:
        release, _digest = installed_metadata(root)
        launcher = root / "provider_proxy_service.py"
        _system_file(launcher, executable=True)
        runner([str(PYTHON), "-I", str(launcher), "self-check", release])
        return True
    except InstallFailure:
        return False


def restart_services(providers: tuple[str, ...], runner: CommandRunner = _run) -> None:
    sockets = [f"aisy-provider-worker@{provider}.socket" for provider in providers]
    validators = [f"aisy-provider-validator@{provider}.socket" for provider in providers]
    runner(["/usr/bin/systemctl", "daemon-reload"])
    runner(["/usr/bin/systemctl", "enable", BROKER_UNIT, *sockets, *validators])
    runner(["/usr/bin/systemctl", "restart", *sockets, *validators])
    runner(["/usr/bin/systemctl", "restart", BROKER_UNIT])
    runner(["/usr/bin/systemctl", "is-active", BROKER_UNIT, *sockets, *validators])


def install_release(
    source: Path,
    *,
    expected_manifest_sha256: str,
    expected_commit: str,
    runtime_uid: int,
    runtime_gid: int,
    runtime_unit: str,
    runtime_cgroup: str,
    installation_hash: str,
    providers: tuple[str, ...],
    runner: CommandRunner = _run,
) -> ReleaseManifest:
    verify_host()
    worker_identity(runner)
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
        _atomic_file(CONFIG_PATH, config_bytes(
            runtime_uid=runtime_uid,
            runtime_gid=runtime_gid,
            runtime_unit=runtime_unit,
            runtime_cgroup=runtime_cgroup,
            installation_hash=installation_hash,
            release_digest=manifest.digest,
            providers=providers,
        ), 0o644)
        install_units(current)
        restart_services(providers, runner)
    except BaseException:
        if previous.is_dir():
            rollback(current, previous, lambda root: release_handshake(root, runner))
            _old_release, old_digest = installed_metadata(current)
            _atomic_file(CONFIG_PATH, config_bytes(
                runtime_uid=runtime_uid,
                runtime_gid=runtime_gid,
                runtime_unit=runtime_unit,
                runtime_cgroup=runtime_cgroup,
                installation_hash=installation_hash,
                release_digest=old_digest,
                providers=providers,
            ), 0o644)
            install_units(current)
            restart_services(providers, runner)
        raise
    return manifest


def rollback_release(
    *,
    runtime_uid: int,
    runtime_gid: int,
    runtime_unit: str,
    runtime_cgroup: str,
    installation_hash: str,
    providers: tuple[str, ...],
    runner: CommandRunner = _run,
) -> str:
    verify_host()
    current = INSTALL_ROOT / "current"
    previous = INSTALL_ROOT / "previous"
    rollback(current, previous, lambda root: release_handshake(root, runner))
    release, digest = installed_metadata(current)
    _atomic_file(CONFIG_PATH, config_bytes(
        runtime_uid=runtime_uid,
        runtime_gid=runtime_gid,
        runtime_unit=runtime_unit,
        runtime_cgroup=runtime_cgroup,
        installation_hash=installation_hash,
        release_digest=digest,
        providers=providers,
    ), 0o644)
    install_units(current)
    restart_services(providers, runner)
    return release


def _configured_providers(path: Path, expected_uid: int) -> tuple[str, ...]:
    descriptor = -1
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or before.st_uid != expected_uid
            or before.st_nlink != 1
            or before.st_mode & 0o022
            or not 1 <= before.st_size <= 16 * 1024
        ):
            raise OSError
        raw = os.read(descriptor, 16 * 1024 + 1)
        after = os.fstat(descriptor)
        if (
            len(raw) != before.st_size
            or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        ):
            raise OSError
        value = json.loads(raw, object_pairs_hook=_unique_object)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise InstallFailure("CONFIG_REFUSED") from None
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    providers_raw = value.get("providers") if isinstance(value, dict) else None
    if (
        not isinstance(value, dict)
        or set(value) != {
            "schemaVersion", "runtimeUid", "runtimeGid", "runtimeUnit", "runtimeCgroup",
            "installationHash", "releaseDigest", "providers",
        }
        or value.get("schemaVersion") != 1
        or isinstance(value.get("runtimeUid"), bool)
        or not isinstance(value.get("runtimeUid"), int)
        or not 1 <= value["runtimeUid"] <= 2**31 - 1
        or isinstance(value.get("runtimeGid"), bool)
        or not isinstance(value.get("runtimeGid"), int)
        or not 1 <= value["runtimeGid"] <= 2**31 - 1
        or not isinstance(value.get("runtimeUnit"), str)
        or _UNIT.fullmatch(value["runtimeUnit"]) is None
        or not isinstance(value.get("runtimeCgroup"), str)
        or _CGROUP.fullmatch(value["runtimeCgroup"]) is None
        or not isinstance(value.get("installationHash"), str)
        or _HASH.fullmatch(value["installationHash"]) is None
        or not isinstance(value.get("releaseDigest"), str)
        or _HASH.fullmatch(value["releaseDigest"]) is None
        or not isinstance(providers_raw, list)
        or any(not isinstance(item, str) for item in providers_raw)
    ):
        raise InstallFailure("CONFIG_REFUSED")
    providers = _providers(",".join(providers_raw))
    if config_bytes(
        runtime_uid=value["runtimeUid"],
        runtime_gid=value["runtimeGid"],
        runtime_unit=value["runtimeUnit"],
        runtime_cgroup=value["runtimeCgroup"],
        installation_hash=value["installationHash"],
        release_digest=value["releaseDigest"],
        providers=providers,
    ) != raw:
        raise InstallFailure("CONFIG_REFUSED")
    return providers


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def _exists(path: Path) -> bool:
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def _safe_directory(path: Path, expected_uid: int) -> None:
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
    except OSError:
        raise InstallFailure("INSTALL_ROOT_REFUSED") from None


def uninstall_preserving_state(
    *,
    providers: tuple[str, ...],
    runner: CommandRunner = _run,
    install_root: Path = INSTALL_ROOT,
    state_root: Path = STATE_ROOT,
    config_path: Path = CONFIG_PATH,
    unit_root: Path = UNIT_ROOT,
    expected_uid: int = 0,
    verify: Verifier = verify_host,
) -> None:
    verify()
    providers = _providers(",".join(providers))
    _safe_directory(state_root, expected_uid)
    _safe_directory(unit_root, expected_uid)
    unit_names = (
        BROKER_UNIT, WORKER_SERVICE, WORKER_SOCKET, VALIDATOR_SERVICE, VALIDATOR_SOCKET,
    )
    config_exists = _exists(config_path)
    install_exists = _exists(install_root)
    unit_exists = tuple(_exists(unit_root / name) for name in unit_names)
    if not config_exists:
        if not install_exists and not any(unit_exists):
            return
        raise InstallFailure("CONFIG_REFUSED")
    if providers != _configured_providers(config_path, expected_uid):
        raise InstallFailure("CONFIG_REFUSED")
    if install_exists:
        _safe_directory(install_root, expected_uid)
    sockets = [f"aisy-provider-worker@{provider}.socket" for provider in providers]
    validators = [f"aisy-provider-validator@{provider}.socket" for provider in providers]
    workers = [f"aisy-provider-worker@{provider}.service" for provider in providers]
    validation = [f"aisy-provider-validator@{provider}.service" for provider in providers]
    runner(["/usr/bin/systemctl", "disable", "--now", BROKER_UNIT, *sockets, *validators])
    runner(["/usr/bin/systemctl", "stop", *workers, *validation])
    for name, exists in zip(unit_names, unit_exists, strict=True):
        if not exists:
            continue
        path = unit_root / name
        info = path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != expected_uid
            or info.st_mode & 0o022
        ):
            raise InstallFailure("UNIT_REFUSED")
        path.unlink()
    _fsync_directory(unit_root)
    runner(["/usr/bin/systemctl", "daemon-reload"])
    if install_exists:
        shutil.rmtree(install_root)
        _fsync_directory(install_root.parent)
    config_path.unlink()
    _fsync_directory(config_path.parent)


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


def _positive(raw: str) -> int:
    if not raw.isascii() or not raw.isdecimal() or not 1 <= int(raw) <= 2**31 - 1:
        raise InstallFailure("ARGUMENT_REFUSED")
    return int(raw)


def main(argv: list[str] | None = None) -> int:
    values = list(sys.argv[1:] if argv is None else argv)
    try:
        if not values:
            raise InstallFailure("ARGUMENT_REFUSED")
        operation = values.pop(0)
        shared = (
            "runtime-uid", "runtime-gid", "runtime-unit", "runtime-cgroup",
            "installation-hash", "providers",
        )
        if operation == "uninstall":
            if not values or values.pop() != _PRESERVE_OPTION:
                raise InstallFailure("ARGUMENT_REFUSED")
            arguments = _arguments(values, shared)
        else:
            arguments = _arguments(values, (
                "source", "expected-manifest-sha256", "expected-commit", *shared,
            ) if operation == "install" else shared)
        common = {
            "runtime_uid": _positive(arguments["runtime-uid"]),
            "runtime_gid": _positive(arguments["runtime-gid"]),
            "runtime_unit": arguments["runtime-unit"],
            "runtime_cgroup": arguments["runtime-cgroup"],
            "installation_hash": arguments["installation-hash"],
            "providers": _providers(arguments["providers"]),
        }
        if operation == "install":
            manifest = install_release(
                Path(arguments["source"]),
                expected_manifest_sha256=arguments["expected-manifest-sha256"],
                expected_commit=arguments["expected-commit"],
                **common,
            )
            print(f"installed {manifest.release}")
            return 0
        if operation == "rollback":
            print(f"rolled back {rollback_release(**common)}")
            return 0
        if operation == "uninstall":
            uninstall_preserving_state(providers=common["providers"])
            print("uninstalled; encrypted state preserved")
            return 0
        raise InstallFailure("ARGUMENT_REFUSED")
    except InstallFailure as error:
        print(str(error), file=sys.stderr)
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
