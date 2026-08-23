"""Root broker daemon and systemd one-shot provider worker entrypoint."""

from __future__ import annotations

import json
import os
import re
import selectors
import signal
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .provider_broker_protocol import DESCRIPTOR_BY_PROVIDER
from .provider_broker_service import (
    ProviderBrokerFailure,
    ProviderBrokerPolicy,
    _process_identity,
    attest_client,
    handle_connection,
    open_journal,
)
from .provider_lifecycle import (
    ProviderLifecycleFailure,
    ProviderLifecyclePolicy,
    handle_control_connection,
    initialize_lifecycle,
    provider_dispatch_binding,
    ready_provider_ids,
    reconcile_lifecycle,
)
from .provider_validation_worker import ProviderValidationFailure
from .provider_validation_worker import run_one_shot as run_validation_one_shot
from .provider_worker import ProviderWorkerFailure, ProviderWorkerPolicy, run_one_shot

CONFIG = Path("/etc/aisy/provider-broker.json")
RUNTIME_ROOT = Path("/run/aisy/provider")
CONTROL = RUNTIME_ROOT / "control.sock"
ADMIN = RUNTIME_ROOT / "admin.sock"
READY = RUNTIME_ROOT / "ready.json"
STATE_ROOT = Path("/var/lib/aisy/provider")
JOURNAL = STATE_ROOT / "attempts.sqlite"
WORKER_SOCKET_ROOT = RUNTIME_ROOT
_HASH = re.compile(r"^[a-f0-9]{64}$")
_UNIT = re.compile(r"^[A-Za-z0-9_.@-]{1,128}\.service$")
_CGROUP = re.compile(r"^/[A-Za-z0-9_.@:/-]{1,511}$")
_RELEASE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


class ProviderServiceFailure(Exception):
    pass


@dataclass(frozen=True)
class ProviderServiceConfig:
    runtime_uid: int
    runtime_gid: int
    runtime_unit: str
    runtime_cgroup: str
    installation_hash: str
    release_digest: str
    providers: tuple[str, ...]


def _object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for name, value in pairs:
        if name in result:
            raise ProviderServiceFailure("CONFIG_REFUSED")
        result[name] = value
    return result


def load_config(path: Path = CONFIG, *, expected_uid: int = 0) -> ProviderServiceConfig:
    try:
        before = path.lstat()
        if (
            not stat.S_ISREG(before.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or before.st_uid != expected_uid
            or before.st_mode & 0o022
            or not 1 <= before.st_size <= 8192
            or path.resolve(strict=True) != path.absolute()
        ):
            raise OSError
        raw = path.read_bytes()
        after = path.lstat()
        if (before.st_dev, before.st_ino, before.st_size) != (after.st_dev, after.st_ino, after.st_size):
            raise OSError
        value = json.loads(raw, object_pairs_hook=_object)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ProviderServiceFailure):
        raise ProviderServiceFailure("CONFIG_REFUSED") from None
    fields = {
        "schemaVersion", "runtimeUid", "runtimeGid", "runtimeUnit", "runtimeCgroup",
        "installationHash", "releaseDigest", "providers",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise ProviderServiceFailure("CONFIG_REFUSED")
    providers = value["providers"]
    if (
        value["schemaVersion"] != 1
        or isinstance(value["runtimeUid"], bool)
        or not isinstance(value["runtimeUid"], int)
        or value["runtimeUid"] < 1
        or isinstance(value["runtimeGid"], bool)
        or not isinstance(value["runtimeGid"], int)
        or value["runtimeGid"] < 1
        or not isinstance(value["runtimeUnit"], str)
        or _UNIT.fullmatch(value["runtimeUnit"]) is None
        or not isinstance(value["runtimeCgroup"], str)
        or _CGROUP.fullmatch(value["runtimeCgroup"]) is None
        or "//" in value["runtimeCgroup"]
        or not isinstance(value["installationHash"], str)
        or _HASH.fullmatch(value["installationHash"]) is None
        or not isinstance(value["releaseDigest"], str)
        or _HASH.fullmatch(value["releaseDigest"]) is None
        or not isinstance(providers, list)
        or not 1 <= len(providers) <= len(DESCRIPTOR_BY_PROVIDER)
        or any(not isinstance(item, str) or item not in DESCRIPTOR_BY_PROVIDER for item in providers)
        or len(set(providers)) != len(providers)
        or providers != sorted(providers)
    ):
        raise ProviderServiceFailure("CONFIG_REFUSED")
    return ProviderServiceConfig(
        value["runtimeUid"], value["runtimeGid"], value["runtimeUnit"],
        value["runtimeCgroup"], value["installationHash"], value["releaseDigest"],
        tuple(providers),
    )


def _main_pid(unit: str) -> int:
    try:
        result = subprocess.run(
            ["/usr/bin/systemctl", "show", "--property=MainPID", "--value", unit],
            check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            timeout=5,
        )
        raw = result.stdout.strip()
        if not raw.isdigit() or int(raw) < 1:
            raise ValueError
        return int(raw)
    except (OSError, ValueError, subprocess.SubprocessError):
        raise ProviderServiceFailure("RUNTIME_IDENTITY_REFUSED") from None


def _lifecycle_policy(config: ProviderServiceConfig) -> ProviderLifecyclePolicy:
    return ProviderLifecyclePolicy(
        config.installation_hash,
        config.release_digest,
        STATE_ROOT,
        WORKER_SOCKET_ROOT,
        configured_providers=config.providers,
    )


def _active_providers(
    config: ProviderServiceConfig,
    journal: sqlite3.Connection,
) -> tuple[str, ...]:
    lifecycle_ready = set(ready_provider_ids(journal, _lifecycle_policy(config), config.providers))
    active: list[str] = []
    for provider in config.providers:
        if provider not in lifecycle_ready:
            continue
        worker_path = WORKER_SOCKET_ROOT / f"worker-{provider}.sock"
        validator_path = WORKER_SOCKET_ROOT / f"validator-{provider}.sock"
        try:
            worker = worker_path.lstat()
            validator = validator_path.lstat()
        except OSError:
            continue
        if (
            stat.S_ISSOCK(worker.st_mode)
            and worker.st_uid == 0
            and stat.S_IMODE(worker.st_mode) == 0o600
            and stat.S_ISSOCK(validator.st_mode)
            and validator.st_uid == 0
            and stat.S_IMODE(validator.st_mode) == 0o600
        ):
            active.append(provider)
    return tuple(active)


def _atomic_ready(config: ProviderServiceConfig, providers: tuple[str, ...]) -> None:
    raw = (json.dumps(
        {
            "protocolVersion": 1,
            "installationHash": config.installation_hash,
            "releaseDigest": config.release_digest,
            "providers": providers,
        },
        separators=(",", ":"),
        sort_keys=True,
    ) + "\n").encode()
    temp = RUNTIME_ROOT / ".ready.json.tmp"
    if temp.exists() or temp.is_symlink():
        stale = temp.lstat()
        if not stat.S_ISREG(stale.st_mode) or stale.st_uid != 0 or stale.st_nlink != 1:
            raise ProviderServiceFailure("READY_PATH_REFUSED")
        temp.unlink()
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o644)
    try:
        offset = 0
        while offset < len(raw):
            written = os.write(descriptor, raw[offset:])
            if written <= 0:
                raise OSError
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.rename(temp, READY)
    root_fd = os.open(RUNTIME_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(root_fd)
    finally:
        os.close(root_fd)


def _prepare_listener(path: Path, config: ProviderServiceConfig) -> socket.socket:
    RUNTIME_ROOT.mkdir(mode=0o755, parents=True, exist_ok=True)
    os.chown(RUNTIME_ROOT, 0, 0)
    os.chmod(RUNTIME_ROOT, 0o755)
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
            raise ProviderServiceFailure("SOCKET_REFUSED")
        path.unlink()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM | getattr(socket, "SOCK_CLOEXEC", 0))
    try:
        listener.bind(os.fspath(path))
        os.chown(path, 0, config.runtime_gid)
        os.chmod(path, 0o660)
        listener.listen(16)
        return listener
    except BaseException:
        listener.close()
        raise


def _runtime_policy(config: ProviderServiceConfig) -> ProviderBrokerPolicy:
    pid = _main_pid(config.runtime_unit)
    start_ticks, cgroup = _process_identity(pid)
    if cgroup != config.runtime_cgroup:
        raise ProviderServiceFailure("RUNTIME_IDENTITY_REFUSED")
    return ProviderBrokerPolicy(
        config.runtime_uid,
        pid,
        start_ticks,
        config.runtime_cgroup,
        WORKER_SOCKET_ROOT,
        JOURNAL,
    )


def _attest_runtime_uid(connection: socket.socket, expected_uid: int) -> None:
    try:
        if not hasattr(socket, "SO_PEERCRED"):
            raise OSError
        raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        _pid, uid, _gid = struct.unpack("3i", raw)
        if uid != expected_uid:
            raise OSError
    except (OSError, struct.error):
        raise ProviderServiceFailure("RUNTIME_UID_REFUSED") from None


def _attest_control(
    connection: socket.socket,
    action: str,
    config: ProviderServiceConfig,
    runtime_policy: ProviderBrokerPolicy,
) -> None:
    if action == "submit":
        _attest_runtime_uid(connection, config.runtime_uid)
    else:
        attest_client(connection, runtime_policy)


def run_broker(config: ProviderServiceConfig) -> None:
    data_listener = _prepare_listener(CONTROL, config)
    admin_listener = _prepare_listener(ADMIN, config)
    selector = selectors.DefaultSelector()
    selector.register(data_listener, selectors.EVENT_READ, "data")
    selector.register(admin_listener, selectors.EVENT_READ, "admin")
    journal = open_journal(JOURNAL)
    initialize_lifecycle(journal)
    lifecycle_policy = _lifecycle_policy(config)
    reconcile_lifecycle(journal, lifecycle_policy)
    stopping = False

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True
        data_listener.close()
        admin_listener.close()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    published_providers = _active_providers(config, journal)
    _atomic_ready(config, published_providers)

    def refresh_ready() -> tuple[str, ...]:
        nonlocal published_providers
        current = _active_providers(config, journal)
        if current != published_providers:
            _atomic_ready(config, current)
            published_providers = current
        return current

    try:
        while not stopping:
            try:
                events = selector.select(timeout=1)
            except OSError:
                if stopping:
                    break
                raise
            refresh_ready()
            for key, _mask in events:
                listener = key.fileobj
                if not isinstance(listener, socket.socket):
                    continue
                try:
                    client, _address = listener.accept()
                except OSError:
                    if stopping:
                        break
                    raise
                with client:
                    try:
                        client.settimeout(125 if key.data == "data" else 40)
                        runtime_policy = _runtime_policy(config)
                        if key.data == "data":
                            def authorize(provider_id: str) -> tuple[int, str]:
                                if provider_id not in refresh_ready():
                                    raise ProviderBrokerFailure("PROVIDER_UNCONFIGURED")
                                try:
                                    return provider_dispatch_binding(
                                        journal,
                                        lifecycle_policy,
                                        provider_id,
                                    )
                                except ProviderLifecycleFailure:
                                    raise ProviderBrokerFailure("PROVIDER_UNCONFIGURED") from None

                            handle_connection(
                                client,
                                runtime_policy,
                                journal,
                                authorize_provider=authorize,
                            )
                        else:
                            handle_control_connection(
                                client,
                                journal,
                                lifecycle_policy,
                                attest=lambda connection, action, runtime_policy=runtime_policy: _attest_control(
                                    connection,
                                    action,
                                    config,
                                    runtime_policy,
                                ),
                            )
                            refresh_ready()
                    except (
                        ProviderBrokerFailure,
                        ProviderLifecycleFailure,
                        ProviderServiceFailure,
                    ):
                        continue
    finally:
        journal.close()
        selector.close()
        data_listener.close()
        admin_listener.close()
        for path in (CONTROL, ADMIN, READY):
            try:
                path.unlink()
            except OSError:
                pass


def run_worker(provider: str, material_path: Path) -> None:
    credential_directory = os.environ.get("CREDENTIALS_DIRECTORY")
    expected_material_path = (
        Path(credential_directory) / "aisy-provider"
        if credential_directory is not None
        else None
    )
    if (
        provider not in DESCRIPTOR_BY_PROVIDER
        or expected_material_path is None
        or not expected_material_path.parent.is_absolute()
        or material_path != expected_material_path
    ):
        raise ProviderServiceFailure("WORKER_ARGUMENT_REFUSED")
    listener: socket.socket | None = None
    relay: socket.socket | None = None
    try:
        listener = socket.socket(fileno=3)
        if listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 1:
            raise OSError
        relay, _address = listener.accept()
    except OSError:
        raise ProviderServiceFailure("WORKER_SOCKET_REFUSED") from None
    finally:
        try:
            if listener is not None:
                listener.close()
        except OSError:
            pass
    if relay is None:
        raise ProviderServiceFailure("WORKER_SOCKET_REFUSED")
    with relay:
        run_one_shot(
            relay,
            ProviderWorkerPolicy(
                provider,
                0,
                material_path,
                0,
                0,
            ),
        )


def run_validator(provider: str) -> None:
    if provider not in DESCRIPTOR_BY_PROVIDER:
        raise ProviderServiceFailure("VALIDATOR_ARGUMENT_REFUSED")
    listener: socket.socket | None = None
    relay: socket.socket | None = None
    try:
        listener = socket.socket(fileno=3)
        if listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 1:
            raise OSError
        relay, _address = listener.accept()
    except OSError:
        raise ProviderServiceFailure("VALIDATOR_SOCKET_REFUSED") from None
    finally:
        try:
            if listener is not None:
                listener.close()
        except OSError:
            pass
    if relay is None:
        raise ProviderServiceFailure("VALIDATOR_SOCKET_REFUSED")
    with relay:
        run_validation_one_shot(relay, provider)


def main(argv: list[str] | None = None) -> int:
    values = sys.argv[1:] if argv is None else argv
    try:
        if values == ["broker"]:
            run_broker(load_config())
            return 0
        if len(values) == 2 and values[0] == "self-check" and _RELEASE.fullmatch(values[1]) is not None:
            if len(DESCRIPTOR_BY_PROVIDER) != 7:
                raise ProviderServiceFailure("DESCRIPTOR_SET_REFUSED")
            return 0
        if len(values) == 2 and values[0] == "validator" and values[1].startswith("--provider="):
            run_validator(values[1].split("=", 1)[1])
            return 0
        if len(values) == 3 and values[0] == "worker" and values[1].startswith("--provider=") and values[2].startswith("--material-path="):
            run_worker(values[1].split("=", 1)[1], Path(values[2].split("=", 1)[1]))
            return 0
        raise ProviderServiceFailure("ARGUMENT_REFUSED")
    except (
        OSError,
        ProviderBrokerFailure,
        ProviderServiceFailure,
        ProviderValidationFailure,
        ProviderWorkerFailure,
    ):
        return 70
