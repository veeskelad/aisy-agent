"""Bind privileged installers to one verified live Aisy runtime process."""

from __future__ import annotations

import hashlib
import os
import pwd
import re
import stat
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .sidecar_bundle_delivery import BundleDeliveryFailure

PackageInstallFailure = BundleDeliveryFailure

_USER = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
_UNIT = re.compile(r"^[A-Za-z0-9_.@-]{1,128}\.service$")
_CGROUP = re.compile(r"^/[A-Za-z0-9_.@:/-]{1,511}$")
_COMPONENTS = frozenset({"provider", "voice"})
_DOMAIN = {
    "provider": b"aisy.provider.installation.v1\0",
    "voice": b"aisy.voice.installation.v1\0",
}


@dataclass(frozen=True)
class RuntimeAccount:
    uid: int
    gid: int
    home: Path


@dataclass(frozen=True)
class SystemdProjection:
    active_state: str
    sub_state: str
    main_pid: int
    control_group: str
    fragment_path: Path


@dataclass(frozen=True)
class ProcessProjection:
    pid: int
    uid: int
    gid: int
    control_group: str


@dataclass(frozen=True)
class RuntimeBinding:
    runtime_uid: int
    runtime_gid: int
    runtime_unit: str
    runtime_cgroup: str
    installation_hash: str


AccountLookup = Callable[[str], RuntimeAccount]
SystemdShow = Callable[[str, str], SystemdProjection]
ProcessInspect = Callable[[int], ProcessProjection]
PathCheck = Callable[[Path, int, str], object]


def installation_hash(component: str, aisy_home: str) -> str:
    domain = _DOMAIN.get(component)
    if domain is None or not isinstance(aisy_home, str) or "\0" in aisy_home:
        raise PackageInstallFailure("RUNTIME_BINDING_REFUSED")
    path = Path(aisy_home)
    if not path.is_absolute() or ".." in path.parts or str(path) != aisy_home:
        raise PackageInstallFailure("RUNTIME_BINDING_REFUSED")
    return hashlib.sha256(domain + aisy_home.encode()).hexdigest()


def _lookup_account(user: str) -> RuntimeAccount:
    try:
        account = pwd.getpwnam(user)
    except KeyError:
        raise PackageInstallFailure("RUNTIME_BINDING_REFUSED") from None
    return RuntimeAccount(account.pw_uid, account.pw_gid, Path(account.pw_dir))


def _parse_systemd(raw: bytes) -> SystemdProjection:
    values: dict[str, str] = {}
    try:
        for line in raw.decode().splitlines():
            key, value = line.split("=", 1)
            if key in values:
                raise ValueError
            values[key] = value
        if set(values) != {
            "ActiveState",
            "SubState",
            "MainPID",
            "ControlGroup",
            "FragmentPath",
        }:
            raise ValueError
        return SystemdProjection(
            values["ActiveState"],
            values["SubState"],
            int(values["MainPID"], 10),
            values["ControlGroup"],
            Path(values["FragmentPath"]),
        )
    except (UnicodeDecodeError, ValueError):
        raise PackageInstallFailure("RUNTIME_BINDING_REFUSED") from None


def _show_systemd(user: str, unit: str) -> SystemdProjection:
    try:
        result = subprocess.run(
            [
                "/usr/bin/systemctl",
                "--user",
                f"--machine={user}@.host",
                "show",
                unit,
                "--property=ActiveState",
                "--property=SubState",
                "--property=MainPID",
                "--property=ControlGroup",
                "--property=FragmentPath",
                "--no-pager",
            ],
            check=True,
            cwd="/",
            env={"PATH": "/usr/bin"},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        raise PackageInstallFailure("RUNTIME_BINDING_REFUSED") from None
    return _parse_systemd(result.stdout)


def _bounded(path: Path, maximum: int) -> str:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
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
            if total < 1:
                raise OSError
            return b"".join(chunks).decode()
        finally:
            os.close(descriptor)
    except (OSError, UnicodeDecodeError):
        raise PackageInstallFailure("RUNTIME_BINDING_REFUSED") from None


def _inspect_process(pid: int) -> ProcessProjection:
    if not 1 <= pid <= 2**31 - 1:
        raise PackageInstallFailure("RUNTIME_BINDING_REFUSED")
    status_text = _bounded(Path(f"/proc/{pid}/status"), 64 * 1024)
    cgroup_text = _bounded(Path(f"/proc/{pid}/cgroup"), 64 * 1024)
    uid: int | None = None
    gid: int | None = None
    for line in status_text.splitlines():
        if line.startswith("Uid:\t"):
            values = line.split()[1:]
            if len(values) == 4 and len(set(values)) == 1:
                uid = int(values[0], 10)
        elif line.startswith("Gid:\t"):
            values = line.split()[1:]
            if len(values) == 4 and len(set(values)) == 1:
                gid = int(values[0], 10)
    cgroups = [line[3:] for line in cgroup_text.splitlines() if line.startswith("0::/")]
    if uid is None or gid is None or len(cgroups) != 1:
        raise PackageInstallFailure("RUNTIME_BINDING_REFUSED")
    return ProcessProjection(pid, uid, gid, cgroups[0])


def _check_runtime_path(path: Path, expected_uid: int, kind: str) -> None:
    try:
        if not path.is_absolute() or path.resolve(strict=True) != path.absolute():
            raise OSError
        info = path.lstat()
        allowed = stat.S_ISDIR(info.st_mode) if kind == "home" else stat.S_ISREG(info.st_mode)
        if (
            not allowed
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != expected_uid
            or info.st_mode & 0o022
        ):
            raise OSError
    except OSError:
        raise PackageInstallFailure("RUNTIME_BINDING_REFUSED") from None


def resolve_runtime_binding(
    *,
    component: str,
    runtime_user: str,
    runtime_unit: str,
    aisy_home: str,
    account_lookup: AccountLookup = _lookup_account,
    systemd_show: SystemdShow = _show_systemd,
    process_inspect: ProcessInspect = _inspect_process,
    path_check: PathCheck = _check_runtime_path,
) -> RuntimeBinding:
    if (
        component not in _COMPONENTS
        or _USER.fullmatch(runtime_user) is None
        or _UNIT.fullmatch(runtime_unit) is None
    ):
        raise PackageInstallFailure("RUNTIME_BINDING_REFUSED")
    try:
        account = account_lookup(runtime_user)
    except (KeyError, OSError, ValueError):
        raise PackageInstallFailure("RUNTIME_BINDING_REFUSED") from None
    if (
        isinstance(account.uid, bool)
        or isinstance(account.gid, bool)
        or not 1 <= account.uid <= 2**31 - 1
        or not 1 <= account.gid <= 2**31 - 1
        or not account.home.is_absolute()
    ):
        raise PackageInstallFailure("RUNTIME_BINDING_REFUSED")
    home = Path(aisy_home)
    expected_fragment = account.home / ".config/systemd/user" / runtime_unit
    try:
        path_check(home, account.uid, "home")
        first = systemd_show(runtime_user, runtime_unit)
        if (
            first.active_state != "active"
            or first.sub_state != "running"
            or not 1 <= first.main_pid <= 2**31 - 1
            or _CGROUP.fullmatch(first.control_group) is None
            or "//" in first.control_group
            or first.fragment_path != expected_fragment
        ):
            raise PackageInstallFailure("RUNTIME_BINDING_REFUSED")
        path_check(first.fragment_path, account.uid, "fragment")
        process = process_inspect(first.main_pid)
        if (
            process.pid != first.main_pid
            or process.uid != account.uid
            or process.gid != account.gid
            or process.control_group != first.control_group
        ):
            raise PackageInstallFailure("RUNTIME_BINDING_REFUSED")
        second = systemd_show(runtime_user, runtime_unit)
        if second != first:
            raise PackageInstallFailure("RUNTIME_BINDING_REFUSED")
    except PackageInstallFailure:
        raise
    except (OSError, ValueError):
        raise PackageInstallFailure("RUNTIME_BINDING_REFUSED") from None
    return RuntimeBinding(
        account.uid,
        account.gid,
        runtime_unit,
        first.control_group,
        installation_hash(component, aisy_home),
    )
