from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from aisy_sidecars import provider_proxy_install as provider_install
from aisy_sidecars.provider_proxy_install import (
    BROKER_UNIT,
    VALIDATOR_SERVICE,
    VALIDATOR_SOCKET,
    WORKER_SERVICE,
    WORKER_SOCKET,
    config_bytes,
    installed_metadata,
    restart_services,
    uninstall_preserving_state,
    validate_units,
)
from aisy_sidecars.voice_proxy_install import InstallFailure, verify_bundle


def test_config_is_exact_sorted_and_release_bound() -> None:
    raw = config_bytes(
        runtime_uid=1000,
        runtime_gid=1000,
        runtime_unit="aisy.service",
        runtime_cgroup="/system.slice/aisy.service",
        installation_hash="a" * 64,
        release_digest="b" * 64,
        providers=("anthropic", "openai"),
    )
    assert json.loads(raw) == {
        "schemaVersion": 1,
        "runtimeUid": 1000,
        "runtimeGid": 1000,
        "runtimeUnit": "aisy.service",
        "runtimeCgroup": "/system.slice/aisy.service",
        "installationHash": "a" * 64,
        "releaseDigest": "b" * 64,
        "providers": ["anthropic", "openai"],
    }

    with pytest.raises(InstallFailure, match="CONFIG_REFUSED"):
        config_bytes(
            runtime_uid=1000,
            runtime_gid=1000,
            runtime_unit="aisy.service",
            runtime_cgroup="/system.slice/aisy.service",
            installation_hash="a" * 64,
            release_digest="b" * 64,
            providers=("openai", "anthropic"),
        )


def test_shipped_units_pass_provider_specific_gates() -> None:
    root = Path(__file__).resolve().parents[1]
    validated = validate_units(root)
    assert set(validated) == {
        BROKER_UNIT, WORKER_SERVICE, WORKER_SOCKET, VALIDATOR_SERVICE, VALIDATOR_SOCKET,
    }


def test_restart_enables_only_selected_exact_instances() -> None:
    calls: list[list[str]] = []
    restart_services(("anthropic", "openai"), calls.append)
    sockets = ["aisy-provider-worker@anthropic.socket", "aisy-provider-worker@openai.socket"]
    validators = ["aisy-provider-validator@anthropic.socket", "aisy-provider-validator@openai.socket"]
    assert calls == [
        ["/usr/bin/systemctl", "daemon-reload"],
        ["/usr/bin/systemctl", "enable", BROKER_UNIT, *sockets, *validators],
        ["/usr/bin/systemctl", "restart", *sockets, *validators],
        ["/usr/bin/systemctl", "restart", BROKER_UNIT],
        ["/usr/bin/systemctl", "is-active", BROKER_UNIT, *sockets, *validators],
    ]


def test_installed_metadata_rejects_writable_or_malformed_manifest(tmp_path: Path) -> None:
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps({
        "schemaVersion": 1,
        "protocolVersion": 1,
        "release": "provider-r1",
    }))
    path.chmod(0o644)
    release, digest = installed_metadata(tmp_path, expected_uid=os.getuid())
    assert release == "provider-r1"
    assert len(digest) == 64

    path.chmod(0o666)
    with pytest.raises(InstallFailure, match="MANIFEST_REFUSED"):
        installed_metadata(tmp_path, expected_uid=os.getuid())


def test_release_builder_emits_verifiable_self_checking_bundle(tmp_path: Path) -> None:
    repository = next(
        (
            parent
            for parent in Path(__file__).resolve().parents
            if (parent / "scripts/build-provider-broker-release.py").is_file()
        ),
        None,
    )
    if repository is None:
        pytest.skip("repository release builder is not mounted")
    commit = subprocess.run(
        ["git", "-C", str(repository), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    output = tmp_path / "bundle"
    result = subprocess.run(
        [
            sys.executable,
            str(repository / "scripts/build-provider-broker-release.py"),
            f"--output={output}",
            f"--commit={commit}",
            "--release=0.1.14-provider-test",
        ],
        check=True,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        close_fds=True,
        timeout=10,
        text=True,
    )
    digest = result.stdout.strip()
    assert len(digest) == 64
    second_output = tmp_path / "bundle-second"
    second = subprocess.run(
        [
            sys.executable,
            str(repository / "scripts/build-provider-broker-release.py"),
            f"--output={second_output}",
            f"--commit={commit}",
            "--release=0.1.14-provider-test",
        ],
        check=True,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        close_fds=True,
        timeout=10,
        text=True,
    )
    assert second.stdout.strip() == digest
    assert (second_output / "manifest.json").read_bytes() == (output / "manifest.json").read_bytes()
    manifest = verify_bundle(
        output,
        expected_manifest_sha256=digest,
        expected_commit=commit,
        expected_uid=os.getuid(),
    )
    assert manifest.release == "0.1.14-provider-test"
    assert {item.path for item in manifest.files} == {
        "aisy_sidecars/__init__.py",
        "aisy_sidecars/provider_broker_protocol.py",
        "aisy_sidecars/provider_broker_service.py",
        "aisy_sidecars/provider_lifecycle.py",
        "aisy_sidecars/provider_proxy_install.py",
        "aisy_sidecars/provider_proxy_service.py",
        "aisy_sidecars/provider_validation_worker.py",
        "aisy_sidecars/provider_worker.py",
        "aisy_sidecars/voice_proxy_install.py",
        "provider_proxy_install.py",
        "provider_proxy_service.py",
        "systemd/aisy-provider-broker.service",
        "systemd/aisy-provider-validator@.service",
        "systemd/aisy-provider-validator@.socket",
        "systemd/aisy-provider-worker@.service",
        "systemd/aisy-provider-worker@.socket",
    }
    for item in manifest.files:
        assert (second_output / item.path).read_bytes() == (output / item.path).read_bytes()
    subprocess.run(
        [
            sys.executable,
            "-I",
            str(output / "provider_proxy_service.py"),
            "self-check",
            manifest.release,
        ],
        check=True,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        close_fds=True,
        timeout=10,
    )


def test_uninstall_fences_units_and_preserves_state(tmp_path: Path) -> None:
    install_root = tmp_path / "install"
    state_root = tmp_path / "state"
    unit_root = tmp_path / "units"
    config_path = tmp_path / "provider.json"
    install_root.mkdir()
    state_root.mkdir()
    unit_root.mkdir()
    (install_root / "release").write_text("active\n")
    (state_root / "broker.db").write_text("preserved\n")
    config_path.write_bytes(config_bytes(
        runtime_uid=1002,
        runtime_gid=1003,
        runtime_unit="aisy.service",
        runtime_cgroup="/user.slice/aisy.service",
        installation_hash="a" * 64,
        release_digest="b" * 64,
        providers=("anthropic", "openai"),
    ))
    config_path.chmod(0o644)
    for name in (
        BROKER_UNIT, WORKER_SERVICE, WORKER_SOCKET, VALIDATOR_SERVICE, VALIDATOR_SOCKET,
    ):
        (unit_root / name).write_text("[Unit]\n")
        (unit_root / name).chmod(0o644)
    calls: list[list[str]] = []

    uninstall_preserving_state(
        providers=("anthropic", "openai"),
        runner=calls.append,
        install_root=install_root,
        state_root=state_root,
        config_path=config_path,
        unit_root=unit_root,
        expected_uid=os.getuid(),
        verify=lambda: None,
    )

    sockets = ["aisy-provider-worker@anthropic.socket", "aisy-provider-worker@openai.socket"]
    validators = [
        "aisy-provider-validator@anthropic.socket", "aisy-provider-validator@openai.socket",
    ]
    workers = ["aisy-provider-worker@anthropic.service", "aisy-provider-worker@openai.service"]
    validation = [
        "aisy-provider-validator@anthropic.service", "aisy-provider-validator@openai.service",
    ]
    assert calls == [
        ["/usr/bin/systemctl", "disable", "--now", BROKER_UNIT, *sockets, *validators],
        ["/usr/bin/systemctl", "stop", *workers, *validation],
        ["/usr/bin/systemctl", "daemon-reload"],
    ]
    assert not install_root.exists()
    assert not config_path.exists()
    assert list(unit_root.iterdir()) == []
    assert (state_root / "broker.db").read_text() == "preserved\n"

    uninstall_preserving_state(
        providers=("anthropic", "openai"),
        runner=calls.append,
        install_root=install_root,
        state_root=state_root,
        config_path=config_path,
        unit_root=unit_root,
        expected_uid=os.getuid(),
        verify=lambda: None,
    )
    assert len(calls) == 3


def test_main_routes_only_explicit_preserving_uninstall(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(
        provider_install,
        "uninstall_preserving_state",
        lambda *, providers: calls.append(providers),
    )
    common = [
        "--runtime-uid=1002",
        "--runtime-gid=1003",
        "--runtime-unit=aisy.service",
        "--runtime-cgroup=/user.slice/aisy.service",
        f"--installation-hash={'a' * 64}",
        "--providers=anthropic,openai",
    ]

    assert provider_install.main([
        "uninstall", *common, provider_install._PRESERVE_OPTION,
    ]) == 0
    assert calls == [("anthropic", "openai")]
    assert provider_install.main(["uninstall", *common]) == 70
