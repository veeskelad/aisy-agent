from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Self

import pytest

import aisy_sidecars.provider_broker_service as broker_module
import aisy_sidecars.provider_lifecycle as lifecycle_module
import aisy_sidecars.provider_proxy_service as service_module
from aisy_sidecars.provider_proxy_service import (
    ProviderServiceConfig,
    ProviderServiceFailure,
    load_config,
    main,
)
from aisy_sidecars.provider_worker import ProviderWorkerPolicy


def config_value(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schemaVersion": 1,
        "runtimeUid": 1000,
        "runtimeGid": 1000,
        "runtimeUnit": "aisy.service",
        "runtimeCgroup": "/system.slice/aisy.service",
        "installationHash": "a" * 64,
        "releaseDigest": "b" * 64,
        "providers": ["anthropic", "openai"],
    }
    value.update(changes)
    return value


def write_config(path: Path, **changes: object) -> None:
    path.write_text(json.dumps(config_value(**changes), separators=(",", ":")))
    path.chmod(0o644)


def test_root_config_is_exact_and_provider_sorted(tmp_path: Path) -> None:
    path = tmp_path / "provider-broker.json"
    write_config(path)
    assert load_config(path, expected_uid=os.getuid()) == ProviderServiceConfig(
        1000,
        1000,
        "aisy.service",
        "/system.slice/aisy.service",
        "a" * 64,
        "b" * 64,
        ("anthropic", "openai"),
    )

    for changes in (
        {"runtimeUid": True},
        {"runtimeUnit": "../foreign.service"},
        {"runtimeCgroup": "//foreign"},
        {"providers": ["openai", "anthropic"]},
        {"providers": ["openai", "custom"]},
        {"extension": True},
    ):
        write_config(path, **changes)
        with pytest.raises(ProviderServiceFailure, match="CONFIG_REFUSED"):
            load_config(path, expected_uid=os.getuid())


def test_entry_grammar_is_exact(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(service_module, "load_config", lambda: ProviderServiceConfig(
        1000, 1000, "aisy.service", "/system.slice/aisy.service", "a" * 64, "b" * 64, ("openai",),
    ))
    monkeypatch.setattr(service_module, "run_broker", lambda _config: calls.append(("broker",)))
    def run_worker(provider: str, path: Path) -> None:
        calls.append(("worker", provider, str(path)))
        if provider == "custom":
            raise ProviderServiceFailure("WORKER_ARGUMENT_REFUSED")

    monkeypatch.setattr(service_module, "run_worker", run_worker)
    monkeypatch.setattr(
        service_module,
        "run_validator",
        lambda provider: calls.append(("validator", provider)),
    )

    assert main(["broker"]) == 0
    assert main(["worker", "--provider=openai", "--material-path=/run/test/aisy-provider"]) == 0
    assert main(["worker", "--provider=openai"]) == 70
    assert main(["worker", "--provider=custom", "--material-path=/run/test/aisy-provider"]) == 70
    assert main(["validator", "--provider=openai"]) == 0
    assert main(["validator", "--provider=openai", "extra"]) == 70
    assert calls == [
        ("broker",),
        ("worker", "openai", "/run/test/aisy-provider"),
        ("worker", "custom", "/run/test/aisy-provider"),
        ("validator", "openai"),
    ]


def test_unix_socket_paths_are_normalized_for_python_312(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    addresses: list[tuple[str, str]] = []

    class ExactSocket:
        def bind(self, address: str) -> None:
            assert isinstance(address, str)
            addresses.append(("bind", address))
            Path(address).touch()

        def connect(self, address: str) -> None:
            assert isinstance(address, str)
            addresses.append(("connect", address))

        def listen(self, _backlog: int) -> None:
            return

        def close(self) -> None:
            return

    monkeypatch.setattr(service_module.socket, "socket", lambda *_args: ExactSocket())
    monkeypatch.setattr(service_module.os, "chown", lambda *_args: None)
    monkeypatch.setattr(service_module, "RUNTIME_ROOT", tmp_path)
    config = ProviderServiceConfig(
        1000,
        1000,
        "aisy.service",
        "/system.slice/aisy.service",
        "a" * 64,
        "b" * 64,
        ("openai",),
    )
    listener_path = tmp_path / "control.sock"

    assert service_module._prepare_listener(listener_path, config).__class__ is ExactSocket
    assert lifecycle_module._connect_validator(tmp_path / "validator.sock").__class__ is ExactSocket
    assert broker_module._connect_worker(tmp_path / "worker.sock").__class__ is ExactSocket
    assert addresses == [
        ("bind", str(listener_path)),
        ("connect", str(tmp_path / "validator.sock")),
        ("connect", str(tmp_path / "worker.sock")),
    ]


def test_worker_binds_root_owned_delivery_to_systemd_directory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[ProviderWorkerPolicy] = []

    class Relay:
        def __enter__(self) -> Self:
            return self

        def __exit__(self, *_args: object) -> None:
            return

    class Listener:
        def getsockopt(self, *_args: object) -> int:
            return 1

        def accept(self) -> tuple[Relay, None]:
            return Relay(), None

        def close(self) -> None:
            return

    delivered = Path("/run/credentials/aisy-provider-worker@openai.service/aisy-provider")
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(delivered.parent))
    monkeypatch.setattr(service_module.socket, "socket", lambda **_kwargs: Listener())

    def capture(_relay: object, worker_policy: ProviderWorkerPolicy) -> None:
        captured.append(worker_policy)

    monkeypatch.setattr(service_module, "run_one_shot", capture)

    service_module.run_worker("openai", delivered)

    assert len(captured) == 1
    worker_policy = captured[0]
    assert worker_policy.credential_path == delivered
    assert worker_policy.credential_owner_uid == 0
    assert worker_policy.credential_owner_gid == 0
    with pytest.raises(ProviderServiceFailure, match="WORKER_ARGUMENT_REFUSED"):
        service_module.run_worker("openai", Path("/run/foreign/aisy-provider"))


def test_systemd_units_keep_broker_and_worker_privileges_separate() -> None:
    root = Path(__file__).resolve().parents[1] / "systemd"
    broker = (root / "aisy-provider-broker.service").read_text()
    worker = (root / "aisy-provider-worker@.service").read_text()
    worker_socket = (root / "aisy-provider-worker@.socket").read_text()
    validator = (root / "aisy-provider-validator@.service").read_text()
    validator_socket = (root / "aisy-provider-validator@.socket").read_text()

    assert "User=root" in broker
    assert "RestrictAddressFamilies=AF_UNIX\n" in broker
    assert "RuntimeDirectoryPreserve=yes" in broker
    assert "User=aisy-provider-proxy" in worker
    assert "LoadCredentialEncrypted=aisy-provider:/var/lib/aisy/provider/%i.active.cred" in worker
    assert "--provider=%i --material-path=%d/aisy-provider" in worker
    assert "CapabilityBoundingSet=\n" in worker
    assert "Accept=no" in worker_socket
    assert "DirectoryMode=0755" in worker_socket
    assert "ListenStream=/run/aisy/provider/worker-%i.sock" in worker_socket
    assert "User=aisy-provider-proxy" in validator
    assert "validator --provider=%i" in validator
    assert "LoadCredentialEncrypted=" not in validator
    assert "CapabilityBoundingSet=\n" in validator
    assert "DirectoryMode=0755" in validator_socket
    assert "ListenStream=/run/aisy/provider/validator-%i.sock" in validator_socket
