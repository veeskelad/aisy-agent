from __future__ import annotations

import hashlib
import io
import json
import os
from collections.abc import Callable
from pathlib import Path

import pytest

import aisy_sidecars.sidecar_bundle_install as bundle_install
from aisy_sidecars.sidecar_bundle_delivery import (
    BundleDeliveryFailure,
    begin_delivery,
    build_receipt,
    parse_receipt,
    seal_delivery,
    store_member,
    store_receipt,
)
from aisy_sidecars.sidecar_bundle_install import _run, execute
from aisy_sidecars.system_runtime_binding import (
    ProcessProjection,
    RuntimeAccount,
    SystemdProjection,
)

COMMIT = "a" * 40
DEPLOYMENT = "b" * 32


def _delivery(tmp_path: Path, component: str = "provider") -> tuple[Path, Path]:
    inbox_root = tmp_path / "incoming"
    ledger_root = tmp_path / "ledger"
    bundle = tmp_path / "source"
    for path in (inbox_root, ledger_root, bundle):
        path.mkdir(mode=0o700)
    entrypoint = bundle / f"{component}_proxy_install.py"
    entrypoint.write_bytes(b"#!/usr/bin/python3.12\n")
    entrypoint.chmod(0o755)
    manifest = {
        "schemaVersion": 1,
        "protocolVersion": 1,
        "release": f"{component}-r1",
        "commit": COMMIT,
        "files": [{
            "path": entrypoint.name,
            "sha256": hashlib.sha256(entrypoint.read_bytes()).hexdigest(),
            "size": entrypoint.stat().st_size,
            "mode": 0o755,
        }],
    }
    manifest_path = bundle / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n"
    )
    manifest_path.chmod(0o644)
    receipt_raw = build_receipt(bundle, component)
    receipt = parse_receipt(receipt_raw)
    deployment_id, _ = begin_delivery(
        receipt.digest,
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        expected_uid=os.getuid(),
        deployment_id_factory=lambda: DEPLOYMENT,
    )
    store_receipt(
        deployment_id,
        io.BytesIO(receipt_raw),
        inbox_root=inbox_root,
        expected_uid=os.getuid(),
    )
    for item in receipt.files:
        store_member(
            deployment_id,
            item.path,
            io.BytesIO((bundle / item.path).read_bytes()),
            inbox_root=inbox_root,
            expected_uid=os.getuid(),
        )
    seal_delivery(
        deployment_id,
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        expected_uid=os.getuid(),
    )
    return inbox_root, ledger_root


def _projection(tmp_path: Path) -> SystemdProjection:
    return SystemdProjection(
        active_state="active",
        sub_state="running",
        main_pid=4242,
        control_group="/user.slice/user-1002.slice/user@1002.service/app.slice/aisy.service",
        fragment_path=tmp_path / "home/.config/systemd/user/aisy.service",
    )


def _execute(
    tmp_path: Path,
    component: str,
    argv: list[str],
    *,
    inbox_root: Path,
    ledger_root: Path,
    calls: list[list[str]],
    systemd_show: Callable[[str, str], SystemdProjection] | None = None,
) -> str:
    python = tmp_path / "python3.12"
    if not python.exists():
        python.write_bytes(b"python\n")
        python.chmod(0o755)
    projection = _projection(tmp_path)
    return execute(
        component,
        argv,
        expected_uid=os.getuid(),
        trusted_root=tmp_path,
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        active_root=tmp_path / f"active-{component}/current",
        python=python,
        account_lookup=lambda _user: RuntimeAccount(1002, 1003, tmp_path / "home"),
        systemd_show=systemd_show or (lambda _user, _unit: projection),
        process_inspect=lambda _pid: ProcessProjection(
            4242, 1002, 1003, projection.control_group
        ),
        path_check=lambda path, uid, kind: (path, uid, kind),
        runner=lambda command: calls.append(command) or f"installed {component}-r1",
    )


def test_install_claims_delivery_and_runs_only_receipt_entrypoint(tmp_path: Path) -> None:
    inbox_root, ledger_root = _delivery(tmp_path)
    calls: list[list[str]] = []

    output = _execute(
        tmp_path,
        "provider",
        [
            "install",
            f"--deployment-id={DEPLOYMENT}",
            "--runtime-user=aisy",
            "--runtime-unit=aisy.service",
            f"--aisy-home={tmp_path / 'home/.aisy'}",
            "--providers=anthropic,openai",
        ],
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        calls=calls,
    )

    assert output == "installed provider-r1"
    assert len(calls) == 1
    assert calls[0][0:4] == [
        str(tmp_path / "python3.12"),
        "-I",
        str(inbox_root / DEPLOYMENT / "bundle/provider_proxy_install.py"),
        "install",
    ]
    assert not (inbox_root / DEPLOYMENT).exists()
    assert json.loads((ledger_root / f"{DEPLOYMENT}.json").read_text())["phase"] == "completed"

    with pytest.raises(BundleDeliveryFailure):
        _execute(
            tmp_path,
            "provider",
            [
                "install",
                f"--deployment-id={DEPLOYMENT}",
                "--runtime-user=aisy",
                "--runtime-unit=aisy.service",
                f"--aisy-home={tmp_path / 'home/.aisy'}",
                "--providers=anthropic,openai",
            ],
            inbox_root=inbox_root,
            ledger_root=ledger_root,
            calls=calls,
        )


@pytest.mark.parametrize("failure", [
    BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED"),
    OSError("fsync"),
])
def test_cleanup_failure_after_activation_does_not_report_install_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: Exception,
) -> None:
    inbox_root, ledger_root = _delivery(tmp_path)
    calls: list[list[str]] = []
    monkeypatch.setattr(
        bundle_install,
        "complete_claimed_delivery",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(failure),
    )

    output = _execute(
        tmp_path,
        "provider",
        [
            "install",
            f"--deployment-id={DEPLOYMENT}",
            "--runtime-user=aisy",
            "--runtime-unit=aisy.service",
            f"--aisy-home={tmp_path / 'home/.aisy'}",
            "--providers=anthropic",
        ],
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        calls=calls,
    )

    assert output == "installed provider-r1"
    assert len(calls) == 1


def test_component_mismatch_refuses_before_execution(tmp_path: Path) -> None:
    inbox_root, ledger_root = _delivery(tmp_path, "voice")
    calls: list[list[str]] = []

    with pytest.raises(BundleDeliveryFailure, match="BUNDLE_RELEASE_REFUSED"):
        _execute(
            tmp_path,
            "provider",
            [
                "install",
                f"--deployment-id={DEPLOYMENT}",
                "--runtime-user=aisy",
                "--runtime-unit=aisy.service",
                f"--aisy-home={tmp_path / 'home/.aisy'}",
                "--providers=anthropic",
            ],
            inbox_root=inbox_root,
            ledger_root=ledger_root,
            calls=calls,
        )
    assert calls == []

    output = _execute(
        tmp_path,
        "voice",
        [
            "install",
            f"--deployment-id={DEPLOYMENT}",
            "--runtime-user=aisy",
            "--runtime-unit=aisy.service",
            f"--aisy-home={tmp_path / 'home/.aisy'}",
        ],
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        calls=calls,
    )
    assert output == "installed voice-r1"
    assert len(calls) == 1


def test_binding_drift_between_authority_check_and_component_call_is_refused(
    tmp_path: Path,
) -> None:
    inbox_root, ledger_root = _delivery(tmp_path)
    first = _projection(tmp_path)
    changed = SystemdProjection(
        active_state=first.active_state,
        sub_state=first.sub_state,
        main_pid=5252,
        control_group=first.control_group,
        fragment_path=first.fragment_path,
    )
    projections = [first, first, changed, changed]
    calls: list[list[str]] = []

    with pytest.raises(BundleDeliveryFailure, match="RUNTIME_BINDING_REFUSED"):
        _execute(
            tmp_path,
            "provider",
            [
                "install",
                f"--deployment-id={DEPLOYMENT}",
                "--runtime-user=aisy",
                "--runtime-unit=aisy.service",
                f"--aisy-home={tmp_path / 'home/.aisy'}",
                "--providers=anthropic",
            ],
            inbox_root=inbox_root,
            ledger_root=ledger_root,
            calls=calls,
            systemd_show=lambda _user, _unit: projections.pop(0),
        )
    assert calls == []


def test_voice_rollback_uses_only_active_verified_entrypoint(tmp_path: Path) -> None:
    inbox_root, ledger_root = _delivery(tmp_path, "voice")
    active = tmp_path / "active-voice/current"
    active.mkdir(parents=True, mode=0o700)
    entrypoint = active / "voice_proxy_install.py"
    entrypoint.write_bytes(b"#!/usr/bin/python3.12\n")
    entrypoint.chmod(0o755)
    calls: list[list[str]] = []

    _execute(
        tmp_path,
        "voice",
        [
            "rollback",
            "--runtime-user=aisy",
            "--runtime-unit=aisy.service",
            f"--aisy-home={tmp_path / 'home/.aisy'}",
        ],
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        calls=calls,
    )

    assert calls[0][0:4] == [
        str(tmp_path / "python3.12"),
        "-I",
        str(entrypoint),
        "rollback",
    ]


def test_root_helper_preserves_allowlisted_component_refusal(tmp_path: Path) -> None:
    command = tmp_path / "component"
    command.write_text("#!/bin/sh\nprintf 'CONFIG_REFUSED\\n' >&2\nexit 70\n")
    command.chmod(0o755)

    with pytest.raises(BundleDeliveryFailure, match="CONFIG_REFUSED"):
        _run([str(command)])


def test_unknown_selector_is_rejected_before_runtime_io(tmp_path: Path) -> None:
    inbox_root, ledger_root = _delivery(tmp_path, "voice")
    calls: list[list[str]] = []

    with pytest.raises(BundleDeliveryFailure, match="RUNTIME_BINDING_REFUSED"):
        _execute(
            tmp_path,
            "voice",
            [
                "install",
                f"--deployment-id={DEPLOYMENT}",
                "--runtime-user=aisy",
                "--runtime-unit=aisy.service",
                f"--aisy-home={tmp_path / 'home/.aisy'}",
                "--unexpected=value",
            ],
            inbox_root=inbox_root,
            ledger_root=ledger_root,
            calls=calls,
        )
    assert calls == []
