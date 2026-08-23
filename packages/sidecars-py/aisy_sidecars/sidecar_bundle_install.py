"""Root helper for activating verified Aisy sidecar bundles."""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

from .sidecar_bundle_delivery import (
    INBOX_ROOT,
    LEDGER_ROOT,
    BundleDeliveryFailure,
    SealedDelivery,
    claim_sealed_delivery,
    complete_claimed_delivery,
)
from .system_runtime_binding import (
    AccountLookup,
    PathCheck,
    ProcessInspect,
    RuntimeBinding,
    SystemdShow,
    _check_runtime_path,
    _inspect_process,
    _lookup_account,
    _show_systemd,
    resolve_runtime_binding,
)

_COMPONENTS = frozenset({"provider", "voice"})
_ACTIVE_ROOTS = {
    "provider": Path("/usr/lib/aisy/provider-broker/current"),
    "voice": Path("/usr/lib/aisy/voice-proxy/current"),
}
_PYTHON = Path("/usr/bin/python3.12")
_PROVIDER = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_RELEASE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
_COMPONENT_FAILURES = frozenset({
    "ACCOUNT_REFUSED", "ARGUMENT_REFUSED", "ATOMIC_CUTOVER_REFUSED",
    "COMMAND_REFUSED", "CONFIG_REFUSED", "EXPECTED_RELEASE_REFUSED",
    "FILE_DIGEST_REFUSED", "HANDSHAKE_REFUSED", "HOST_REFUSED",
    "INSTALL_ROOT_REFUSED", "MANIFEST_DIGEST_REFUSED", "MANIFEST_REFUSED",
    "PUBLISH_REFUSED", "ROLLBACK_HANDSHAKE_REFUSED", "ROLLBACK_REFUSED",
    "SOURCE_CHANGED", "SOURCE_REFUSED", "UNIT_REFUSED",
})


def _read_regular(
    path: Path,
    *,
    expected_uid: int,
    trusted_root: Path,
    mode: int,
    maximum: int,
) -> bytes:
    descriptor = -1
    try:
        root_info = trusted_root.lstat()
        if (
            not path.is_absolute()
            or not trusted_root.is_absolute()
            or trusted_root.resolve(strict=True) != trusted_root.absolute()
            or path != path.absolute()
            or not stat.S_ISDIR(root_info.st_mode)
            or stat.S_ISLNK(root_info.st_mode)
            or root_info.st_uid != expected_uid
            or root_info.st_mode & 0o022
        ):
            raise OSError
        relative = path.relative_to(trusted_root)
        current = trusted_root
        for part in relative.parts[:-1]:
            current /= part
            info = current.lstat()
            if (
                not stat.S_ISDIR(info.st_mode)
                or stat.S_ISLNK(info.st_mode)
                or info.st_uid != expected_uid
                or info.st_mode & 0o022
            ):
                raise OSError
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
        raw = os.read(descriptor, maximum + 1)
        after = os.fstat(descriptor)
        if (
            len(raw) != before.st_size
            or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        ):
            raise OSError
        return raw
    except (OSError, ValueError):
        raise BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED") from None
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _providers(raw: str) -> tuple[str, ...]:
    values = tuple(raw.split(","))
    if (
        not values
        or values != tuple(sorted(values))
        or len(values) != len(set(values))
        or len(values) > 16
        or any(_PROVIDER.fullmatch(value) is None for value in values)
    ):
        raise BundleDeliveryFailure("RUNTIME_BINDING_REFUSED")
    return values


def _arguments(argv: list[str], names: tuple[str, ...]) -> dict[str, str]:
    if len(argv) != len(names):
        raise BundleDeliveryFailure("RUNTIME_BINDING_REFUSED")
    result: dict[str, str] = {}
    for raw in argv:
        if not raw.startswith("--") or "=" not in raw:
            raise BundleDeliveryFailure("RUNTIME_BINDING_REFUSED")
        name, value = raw[2:].split("=", 1)
        if name not in names or name in result or not value or len(value) > 512 or "\0" in value:
            raise BundleDeliveryFailure("RUNTIME_BINDING_REFUSED")
        result[name] = value
    if set(result) != set(names):
        raise BundleDeliveryFailure("RUNTIME_BINDING_REFUSED")
    return result


def _provider_values(binding: RuntimeBinding, providers: tuple[str, ...]) -> list[str]:
    return [
        f"--runtime-uid={binding.runtime_uid}",
        f"--runtime-gid={binding.runtime_gid}",
        f"--runtime-unit={binding.runtime_unit}",
        f"--runtime-cgroup={binding.runtime_cgroup}",
        f"--installation-hash={binding.installation_hash}",
        f"--providers={','.join(providers)}",
    ]


def component_argv(
    delivery: SealedDelivery,
    binding: RuntimeBinding,
    *,
    providers: tuple[str, ...] = (),
    python: Path = _PYTHON,
) -> list[str]:
    component = delivery.receipt.component
    if (component == "provider") != bool(providers):
        raise BundleDeliveryFailure("RUNTIME_BINDING_REFUSED")
    entrypoint = delivery.bundle / f"{component}_proxy_install.py"
    shared = [
        f"--source={delivery.bundle}",
        f"--expected-manifest-sha256={delivery.receipt.manifest_sha256}",
        f"--expected-commit={delivery.receipt.commit}",
        f"--runtime-uid={binding.runtime_uid}",
    ]
    if component == "provider":
        shared.extend([
            f"--runtime-gid={binding.runtime_gid}",
            f"--runtime-unit={binding.runtime_unit}",
        ])
    shared.extend([
        f"--runtime-cgroup={binding.runtime_cgroup}",
        f"--installation-hash={binding.installation_hash}",
    ])
    if component == "provider":
        shared.append(f"--providers={','.join(providers)}")
    return [str(python), "-I", str(entrypoint), "install", *shared]


def active_component_argv(
    component: str,
    binding: RuntimeBinding,
    *,
    operation: str,
    providers: tuple[str, ...] = (),
    active_root: Path | None = None,
    python: Path = _PYTHON,
) -> list[str]:
    if component not in _COMPONENTS or operation not in {"rollback", "uninstall"}:
        raise BundleDeliveryFailure("RUNTIME_BINDING_REFUSED")
    if (component == "provider") != bool(providers):
        raise BundleDeliveryFailure("RUNTIME_BINDING_REFUSED")
    root = _ACTIVE_ROOTS[component] if active_root is None else active_root
    command = [str(python), "-I", str(root / f"{component}_proxy_install.py"), operation]
    if operation == "uninstall":
        if component == "provider":
            return [*command, *_provider_values(binding, providers), "--preserve-encrypted-credentials"]
        return [*command, "--preserve-encrypted-credential"]
    if component == "provider":
        return [*command, *_provider_values(binding, providers)]
    return [
        *command,
        f"--runtime-uid={binding.runtime_uid}",
        f"--runtime-cgroup={binding.runtime_cgroup}",
        f"--installation-hash={binding.installation_hash}",
    ]


def _run(argv: list[str]) -> str:
    try:
        result = subprocess.run(
            argv,
            check=True,
            cwd="/",
            env={"PATH": "/usr/bin"},
            stdin=subprocess.DEVNULL,
            capture_output=True,
            close_fds=True,
            timeout=600,
            text=True,
        )
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() if isinstance(error.stderr, str) else ""
        if error.returncode == 70 and detail in _COMPONENT_FAILURES:
            raise BundleDeliveryFailure(detail) from None
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED") from None
    except (OSError, subprocess.SubprocessError):
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED") from None
    output = result.stdout.strip()
    if not output or len(output) > 256 or any(ord(char) < 32 for char in output):
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    return output


def _release_status(
    root: Path,
    *,
    expected_uid: int,
    trusted_root: Path,
) -> str:
    try:
        raw = _read_regular(
            root / "manifest.json",
            expected_uid=expected_uid,
            trusted_root=trusted_root,
            mode=0o644,
            maximum=256 * 1024,
        )
        value = json.loads(raw)
        release = value.get("release") if isinstance(value, dict) else None
        if not isinstance(release, str) or _RELEASE.fullmatch(release) is None:
            raise ValueError
        return release
    except (BundleDeliveryFailure, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return "refused" if root.exists() else "absent"


def execute(
    component: str,
    argv: list[str],
    *,
    expected_uid: int = 0,
    trusted_root: Path = Path("/usr"),
    inbox_root: Path = INBOX_ROOT,
    ledger_root: Path = LEDGER_ROOT,
    active_root: Path | None = None,
    python: Path = _PYTHON,
    account_lookup: AccountLookup = _lookup_account,
    systemd_show: SystemdShow = _show_systemd,
    process_inspect: ProcessInspect = _inspect_process,
    path_check: PathCheck = _check_runtime_path,
    runner: Callable[[list[str]], str] = _run,
) -> str:
    if component not in _COMPONENTS or not argv:
        raise BundleDeliveryFailure("RUNTIME_BINDING_REFUSED")
    operation = argv.pop(0)
    if operation not in {"status", "install", "rollback", "uninstall"}:
        raise BundleDeliveryFailure("RUNTIME_BINDING_REFUSED")
    shared = ("runtime-user", "runtime-unit", "aisy-home")
    names = shared
    if operation == "install":
        names = ("deployment-id", *names)
    if component == "provider" and operation != "status":
        names = (*names, "providers")
    preserve = "preserve-encrypted-credentials" if component == "provider" else "preserve-encrypted-credential"
    if operation == "uninstall":
        names = (*names, preserve)
    values = _arguments(argv, names)
    if operation == "uninstall" and values[preserve] != "yes":
        raise BundleDeliveryFailure("RUNTIME_BINDING_REFUSED")
    providers = _providers(values["providers"]) if "providers" in values else ()
    binding = resolve_runtime_binding(
        component=component,
        runtime_user=values["runtime-user"],
        runtime_unit=values["runtime-unit"],
        aisy_home=values["aisy-home"],
        account_lookup=account_lookup,
        systemd_show=systemd_show,
        process_inspect=process_inspect,
        path_check=path_check,
    )
    root = _ACTIVE_ROOTS[component] if active_root is None else active_root
    if operation == "status":
        return (
            f"component={component} active={_release_status(root, expected_uid=expected_uid, trusted_root=trusted_root)} "
            f"previous={_release_status(root.parent / 'previous', expected_uid=expected_uid, trusted_root=trusted_root)} "
            "binding=ready"
        )
    _read_regular(
        python,
        expected_uid=expected_uid,
        trusted_root=trusted_root,
        mode=0o755,
        maximum=32 * 1024 * 1024,
    )
    delivery: SealedDelivery | None = None
    if operation == "install":
        delivery = claim_sealed_delivery(
            values["deployment-id"],
            expected_component=component,
            inbox_root=inbox_root,
            ledger_root=ledger_root,
            expected_uid=expected_uid,
        )
        _read_regular(
            delivery.bundle / f"{component}_proxy_install.py",
            expected_uid=expected_uid,
            trusted_root=trusted_root,
            mode=0o755,
            maximum=8 * 1024 * 1024,
        )
    else:
        _read_regular(
            root / f"{component}_proxy_install.py",
            expected_uid=expected_uid,
            trusted_root=trusted_root,
            mode=0o755,
            maximum=8 * 1024 * 1024,
        )
    reconfirmed = resolve_runtime_binding(
        component=component,
        runtime_user=values["runtime-user"],
        runtime_unit=values["runtime-unit"],
        aisy_home=values["aisy-home"],
        account_lookup=account_lookup,
        systemd_show=systemd_show,
        process_inspect=process_inspect,
        path_check=path_check,
    )
    if reconfirmed != binding:
        raise BundleDeliveryFailure("RUNTIME_BINDING_REFUSED")
    if delivery is not None:
        command = component_argv(delivery, reconfirmed, providers=providers, python=python)
    else:
        command = active_component_argv(
            component,
            reconfirmed,
            operation=operation,
            providers=providers,
            active_root=root,
            python=python,
        )
    output = runner(command)
    if delivery is not None:
        try:
            complete_claimed_delivery(
                delivery.deployment_id,
                inbox_root=inbox_root,
                ledger_root=ledger_root,
                expected_uid=expected_uid,
            )
        except (BundleDeliveryFailure, OSError):
            # Activation is already committed. Housekeeping is crash-convergent
            # and must not turn a completed privileged effect into a retryable
            # install failure.
            return output
    return output


def main(component: str, argv: list[str] | None = None) -> int:
    try:
        if os.geteuid() != 0 or sys.platform != "linux":
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        print(execute(component, list(sys.argv[1:] if argv is None else argv)))
        return 0
    except BundleDeliveryFailure as error:
        print(str(error), file=sys.stderr)
        return 70
