from __future__ import annotations

import hashlib
import io
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from aisy_sidecars.sidecar_bundle_delivery import (
    BundleDeliveryFailure,
    begin_delivery,
    build_receipt,
    claim_sealed_delivery,
    complete_claimed_delivery,
    load_sealed_delivery,
    parse_receipt,
    receiver_main,
    seal_delivery,
    store_member,
    store_receipt,
)

COMMIT = "a" * 40
DEPLOYMENT = "b" * 32


def _roots(tmp_path: Path) -> tuple[Path, Path]:
    inbox = tmp_path / "incoming"
    ledger = tmp_path / "ledger"
    inbox.mkdir(mode=0o700)
    ledger.mkdir(mode=0o700)
    return inbox, ledger


def _bundle(tmp_path: Path, component: str = "provider") -> Path:
    bundle = tmp_path / f"{component}-bundle"
    bundle.mkdir(mode=0o700)
    entrypoint = bundle / f"{component}_proxy_install.py"
    entrypoint.write_bytes(b"#!/usr/bin/python3.12\n")
    entrypoint.chmod(0o755)
    entry = {
        "path": entrypoint.name,
        "sha256": hashlib.sha256(entrypoint.read_bytes()).hexdigest(),
        "size": entrypoint.stat().st_size,
        "mode": 0o755,
    }
    manifest = {
        "schemaVersion": 1,
        "protocolVersion": 1,
        "release": f"{component}-r1",
        "commit": COMMIT,
        "files": [entry],
    }
    manifest_path = bundle / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n"
    )
    manifest_path.chmod(0o644)
    return bundle


def _delivered(tmp_path: Path, component: str = "provider") -> tuple[str, Path, Path]:
    inbox_root, ledger_root = _roots(tmp_path)
    bundle = _bundle(tmp_path, component)
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
    return deployment_id, inbox_root, ledger_root


@pytest.mark.parametrize("component", ["provider", "voice"])
def test_build_receipt_is_canonical_and_reproducible(
    tmp_path: Path,
    component: str,
) -> None:
    bundle = _bundle(tmp_path, component)

    first = build_receipt(bundle, component)
    second = build_receipt(bundle, component)

    assert first == second
    receipt = parse_receipt(first)
    assert receipt.commit == COMMIT
    assert [item.path for item in receipt.files] == [
        "manifest.json",
        f"{component}_proxy_install.py",
    ]


def test_build_receipt_refuses_manifest_inventory_drift(tmp_path: Path) -> None:
    bundle = _bundle(tmp_path)
    value = json.loads((bundle / "manifest.json").read_text())
    value["files"][0]["sha256"] = "c" * 64
    (bundle / "manifest.json").write_text(
        json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
    )

    with pytest.raises(BundleDeliveryFailure, match="BUNDLE_RELEASE_REFUSED"):
        build_receipt(bundle, "provider")


def test_receipt_refuses_aggregate_size_above_global_bound() -> None:
    raw = (json.dumps({
        "schemaVersion": 1,
        "component": "provider",
        "commit": COMMIT,
        "release": "provider-r1",
        "manifestSha256": "d" * 64,
        "files": [{
            "path": "manifest.json" if index == 0 else f"file-{index}",
            "sha256": "e" * 64,
            "size": 8 * 1024 * 1024,
            "mode": 0o644,
        } for index in range(5)],
    }, sort_keys=True, separators=(",", ":")) + "\n").encode()

    with pytest.raises(BundleDeliveryFailure, match="BUNDLE_RELEASE_REFUSED"):
        parse_receipt(raw)


def test_seal_refuses_noncanonical_manifest_even_with_matching_receipt(tmp_path: Path) -> None:
    inbox_root, ledger_root = _roots(tmp_path)
    bundle = _bundle(tmp_path)
    manifest = json.loads((bundle / "manifest.json").read_text())
    (bundle / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    files = []
    for path in sorted(bundle.iterdir()):
        raw = path.read_bytes()
        files.append({
            "path": path.name,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "size": len(raw),
            "mode": path.stat().st_mode & 0o777,
        })
    manifest_raw = (bundle / "manifest.json").read_bytes()
    receipt_raw = (json.dumps({
        "schemaVersion": 1,
        "component": "provider",
        "commit": COMMIT,
        "release": "provider-r1",
        "manifestSha256": hashlib.sha256(manifest_raw).hexdigest(),
        "files": files,
    }, sort_keys=True, separators=(",", ":")) + "\n").encode()
    receipt = parse_receipt(receipt_raw)
    deployment_id, _ = begin_delivery(
        receipt.digest, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(), deployment_id_factory=lambda: DEPLOYMENT,
    )
    store_receipt(
        deployment_id, io.BytesIO(receipt_raw), inbox_root=inbox_root,
        expected_uid=os.getuid(),
    )
    for item in receipt.files:
        store_member(
            deployment_id, item.path, io.BytesIO((bundle / item.path).read_bytes()),
            inbox_root=inbox_root, expected_uid=os.getuid(),
        )

    with pytest.raises(BundleDeliveryFailure, match="BUNDLE_RELEASE_REFUSED"):
        seal_delivery(
            deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
            expected_uid=os.getuid(),
        )


def test_begin_generates_root_owned_one_shot_inbox(tmp_path: Path) -> None:
    inbox_root, ledger_root = _roots(tmp_path)
    digest = "d" * 64

    deployment_id, inbox = begin_delivery(
        digest,
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        expected_uid=os.getuid(),
        deployment_id_factory=lambda: DEPLOYMENT,
    )

    assert deployment_id == DEPLOYMENT
    assert inbox.stat().st_mode & 0o777 == 0o700
    assert (inbox / "authority.json").stat().st_mode & 0o777 == 0o600
    ledger = ledger_root / f"{DEPLOYMENT}.json"
    ledger_before = ledger.read_bytes()
    with pytest.raises(BundleDeliveryFailure):
        begin_delivery(
            digest,
            inbox_root=inbox_root,
            ledger_root=ledger_root,
            expected_uid=os.getuid(),
            deployment_id_factory=lambda: DEPLOYMENT,
        )
    assert ledger.read_bytes() == ledger_before
    assert inbox.is_dir()


def test_begin_enforces_global_open_deployment_quota(tmp_path: Path) -> None:
    inbox_root, ledger_root = _roots(tmp_path)
    for index in range(8):
        begin_delivery(
            "d" * 64,
            inbox_root=inbox_root,
            ledger_root=ledger_root,
            expected_uid=os.getuid(),
            deployment_id_factory=lambda index=index: f"{index:032x}",
        )
    with pytest.raises(BundleDeliveryFailure, match="BUNDLE_AUTHORITY_REFUSED"):
        begin_delivery(
            "d" * 64,
            inbox_root=inbox_root,
            ledger_root=ledger_root,
            expected_uid=os.getuid(),
            deployment_id_factory=lambda: "f" * 32,
        )


def test_concurrent_begin_is_serialized_at_exact_global_quota(tmp_path: Path) -> None:
    inbox_root, ledger_root = _roots(tmp_path)

    def create(index: int) -> str:
        try:
            return begin_delivery(
                "d" * 64,
                inbox_root=inbox_root,
                ledger_root=ledger_root,
                expected_uid=os.getuid(),
                deployment_id_factory=lambda: f"{index:032x}",
            )[0]
        except BundleDeliveryFailure as error:
            return str(error)

    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(create, range(12)))

    assert sum(result == "BUNDLE_AUTHORITY_REFUSED" for result in results) == 4
    assert len(list(inbox_root.iterdir())) == 8


def test_completed_deliveries_do_not_consume_open_quota(tmp_path: Path) -> None:
    inbox_root, ledger_root = _roots(tmp_path)
    bundle = _bundle(tmp_path)
    receipt_raw = build_receipt(bundle, "provider")
    receipt = parse_receipt(receipt_raw)

    for index in range(12):
        deployment_id, _ = begin_delivery(
            receipt.digest,
            inbox_root=inbox_root,
            ledger_root=ledger_root,
            expected_uid=os.getuid(),
            deployment_id_factory=lambda index=index: f"{index:032x}",
        )
        store_receipt(
            deployment_id, io.BytesIO(receipt_raw), inbox_root=inbox_root,
            expected_uid=os.getuid(),
        )
        for item in receipt.files:
            store_member(
                deployment_id, item.path, io.BytesIO((bundle / item.path).read_bytes()),
                inbox_root=inbox_root, expected_uid=os.getuid(),
            )
        seal_delivery(
            deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
            expected_uid=os.getuid(),
        )
        claim_sealed_delivery(
            deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
            expected_uid=os.getuid(),
        )
        complete_claimed_delivery(
            deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
            expected_uid=os.getuid(),
        )

    assert list(inbox_root.iterdir()) == []
    assert len(list(ledger_root.glob("*.json"))) == 12


def test_begin_prunes_stale_receiving_delivery(tmp_path: Path) -> None:
    inbox_root, ledger_root = _roots(tmp_path)
    begin_delivery(
        "d" * 64, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(), deployment_id_factory=lambda: DEPLOYMENT,
    )
    os.utime(ledger_root / f"{DEPLOYMENT}.json", ns=(1, 1))

    replacement = "c" * 32
    begin_delivery(
        "e" * 64, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(), deployment_id_factory=lambda: replacement,
    )

    assert not (inbox_root / DEPLOYMENT).exists()
    assert not (ledger_root / f"{DEPLOYMENT}.json").exists()
    assert (inbox_root / replacement).is_dir()


def test_begin_recovers_orphan_receiving_ledger_immediately(tmp_path: Path) -> None:
    inbox_root, ledger_root = _roots(tmp_path)
    orphan = ledger_root / f"{DEPLOYMENT}.json"
    orphan.write_text(json.dumps({
        "schemaVersion": 1,
        "deploymentId": DEPLOYMENT,
        "expectedReceiptSha256": "d" * 64,
        "phase": "receiving",
    }, sort_keys=True, separators=(",", ":")) + "\n")
    orphan.chmod(0o600)

    replacement = "c" * 32
    begin_delivery(
        "e" * 64, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(), deployment_id_factory=lambda: replacement,
    )

    assert not orphan.exists()
    assert (inbox_root / replacement).is_dir()


def test_begin_recovers_abandoned_exact_ledger_temporary(tmp_path: Path) -> None:
    inbox_root, ledger_root = _roots(tmp_path)
    temporary = ledger_root / f".{DEPLOYMENT}.json.tmp-{os.getpid()}"
    temporary.write_text("partial\n")
    temporary.chmod(0o600)

    begin_delivery(
        "e" * 64, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(), deployment_id_factory=lambda: "c" * 32,
    )

    assert not temporary.exists()


def test_begin_prunes_stale_claim_with_dead_owner_but_keeps_tombstone(tmp_path: Path) -> None:
    deployment_id, inbox_root, ledger_root = _delivered(tmp_path)
    claim_sealed_delivery(
        deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(),
    )
    claim = inbox_root / deployment_id / "claim"
    claim.write_text(json.dumps({
        "schemaVersion": 1,
        "deploymentId": deployment_id,
        "pid": 2**31 - 1,
        "processIdentity": "stale:2147483647",
    }, sort_keys=True, separators=(",", ":")) + "\n")
    claim.chmod(0o600)
    os.utime(ledger_root / f"{deployment_id}.json", ns=(1, 1))

    begin_delivery(
        "e" * 64, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(), deployment_id_factory=lambda: "c" * 32,
    )

    assert not (inbox_root / deployment_id).exists()
    assert (ledger_root / f"{deployment_id}.json").is_file()


def test_begin_bounds_completed_replay_tombstones(tmp_path: Path) -> None:
    inbox_root, ledger_root = _roots(tmp_path)
    for index in range(257):
        deployment_id = f"{index:032x}"
        path = ledger_root / f"{deployment_id}.json"
        path.write_text(json.dumps({
            "schemaVersion": 1,
            "deploymentId": deployment_id,
            "expectedReceiptSha256": "d" * 64,
            "phase": "claimed",
        }, sort_keys=True, separators=(",", ":")) + "\n")
        path.chmod(0o600)

    begin_delivery(
        "e" * 64, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(), deployment_id_factory=lambda: "f" * 32,
    )

    claimed = [
        path for path in ledger_root.glob("*.json")
        if json.loads(path.read_text())["phase"] == "claimed"
    ]
    assert len(claimed) == 256


def test_receipt_must_match_external_expected_digest(tmp_path: Path) -> None:
    inbox_root, ledger_root = _roots(tmp_path)
    raw = build_receipt(_bundle(tmp_path), "provider")
    deployment_id, _ = begin_delivery(
        "d" * 64,
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        expected_uid=os.getuid(),
        deployment_id_factory=lambda: DEPLOYMENT,
    )

    with pytest.raises(BundleDeliveryFailure, match="BUNDLE_AUTHORITY_REFUSED"):
        store_receipt(
            deployment_id,
            io.BytesIO(raw),
            inbox_root=inbox_root,
            expected_uid=os.getuid(),
        )


@pytest.mark.parametrize("deployment_id", ["", "../escape", "/tmp/escape", "a/b"])
def test_all_delivery_operations_refuse_noncanonical_deployment_id(
    tmp_path: Path,
    deployment_id: str,
) -> None:
    inbox_root, ledger_root = _roots(tmp_path)

    operations = (
        lambda: store_receipt(
            deployment_id, io.BytesIO(b"{}\n"),
            inbox_root=inbox_root, expected_uid=os.getuid(),
        ),
        lambda: store_member(
            deployment_id, "manifest.json", io.BytesIO(b"{}\n"),
            inbox_root=inbox_root, expected_uid=os.getuid(),
        ),
        lambda: seal_delivery(
            deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
            expected_uid=os.getuid(),
        ),
        lambda: load_sealed_delivery(
            deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
            expected_uid=os.getuid(),
        ),
        lambda: claim_sealed_delivery(
            deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
            expected_uid=os.getuid(),
        ),
    )
    for operation in operations:
        with pytest.raises(BundleDeliveryFailure, match="BUNDLE_AUTHORITY_REFUSED"):
            operation()


def test_authority_deployment_id_must_match_inbox(tmp_path: Path) -> None:
    inbox_root, ledger_root = _roots(tmp_path)
    raw = build_receipt(_bundle(tmp_path), "provider")
    receipt = parse_receipt(raw)
    deployment_id, inbox = begin_delivery(
        receipt.digest,
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        expected_uid=os.getuid(),
        deployment_id_factory=lambda: DEPLOYMENT,
    )
    authority = json.loads((inbox / "authority.json").read_text())
    authority["deploymentId"] = "c" * 32
    (inbox / "authority.json").write_text(
        json.dumps(authority, sort_keys=True, separators=(",", ":")) + "\n"
    )
    (inbox / "authority.json").chmod(0o600)

    with pytest.raises(BundleDeliveryFailure, match="BUNDLE_AUTHORITY_REFUSED"):
        store_receipt(
            deployment_id,
            io.BytesIO(raw),
            inbox_root=inbox_root,
            expected_uid=os.getuid(),
        )


@pytest.mark.parametrize("mutation", ["unknown", "wrong-hash", "duplicate"])
def test_member_upload_refuses_non_exact_inventory(tmp_path: Path, mutation: str) -> None:
    inbox_root, ledger_root = _roots(tmp_path)
    bundle = _bundle(tmp_path)
    raw = build_receipt(bundle, "provider")
    receipt = parse_receipt(raw)
    deployment_id, _ = begin_delivery(
        receipt.digest,
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        expected_uid=os.getuid(),
        deployment_id_factory=lambda: DEPLOYMENT,
    )
    store_receipt(
        deployment_id,
        io.BytesIO(raw),
        inbox_root=inbox_root,
        expected_uid=os.getuid(),
    )
    path = "unknown" if mutation == "unknown" else "provider_proxy_install.py"
    payload = (
        b"unknown"
        if mutation == "unknown"
        else b"wrong"
        if mutation == "wrong-hash"
        else (bundle / path).read_bytes()
    )
    if mutation == "duplicate":
        store_member(
            deployment_id,
            path,
            io.BytesIO(payload),
            inbox_root=inbox_root,
            expected_uid=os.getuid(),
        )

    with pytest.raises(BundleDeliveryFailure):
        store_member(
            deployment_id,
            path,
            io.BytesIO(payload),
            inbox_root=inbox_root,
            expected_uid=os.getuid(),
        )


@pytest.mark.parametrize("mutation", ["content", "symlink", "hardlink", "unknown-directory"])
def test_seal_and_load_refuse_post_upload_mutation(tmp_path: Path, mutation: str) -> None:
    deployment_id, inbox_root, ledger_root = _delivered(tmp_path)
    member = inbox_root / deployment_id / "bundle/provider_proxy_install.py"
    if mutation == "content":
        member.write_bytes(b"changed")
    elif mutation == "symlink":
        original = member.with_suffix(".original")
        member.rename(original)
        member.symlink_to(original)
    elif mutation == "hardlink":
        member.with_suffix(".link").hardlink_to(member)
    else:
        (member.parent / "unknown").mkdir(mode=0o700)

    with pytest.raises(BundleDeliveryFailure):
        load_sealed_delivery(
            deployment_id,
            inbox_root=inbox_root,
            ledger_root=ledger_root,
            expected_uid=os.getuid(),
        )


def test_claim_is_atomic_and_prevents_replay(tmp_path: Path) -> None:
    deployment_id, inbox_root, ledger_root = _delivered(tmp_path)

    delivery = claim_sealed_delivery(
        deployment_id,
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        expected_uid=os.getuid(),
    )

    assert delivery.receipt.component == "provider"
    with pytest.raises(BundleDeliveryFailure):
        claim_sealed_delivery(
            deployment_id,
            inbox_root=inbox_root,
            ledger_root=ledger_root,
            expected_uid=os.getuid(),
        )


def test_repeated_seal_after_claim_cannot_reopen_delivery(tmp_path: Path) -> None:
    deployment_id, inbox_root, ledger_root = _delivered(tmp_path)
    claim_sealed_delivery(
        deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(),
    )

    with pytest.raises(BundleDeliveryFailure, match="BUNDLE_AUTHORITY_REFUSED"):
        seal_delivery(
            deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
            expected_uid=os.getuid(),
        )

    assert json.loads((ledger_root / f"{deployment_id}.json").read_text())["phase"] == "claimed"
    with pytest.raises(BundleDeliveryFailure, match="BUNDLE_AUTHORITY_REFUSED"):
        claim_sealed_delivery(
            deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
            expected_uid=os.getuid(),
        )


def test_seal_recovers_after_marker_before_ledger_transition(tmp_path: Path) -> None:
    deployment_id, inbox_root, ledger_root = _delivered(tmp_path)
    receipt = parse_receipt((inbox_root / deployment_id / "receipt.json").read_bytes())
    (ledger_root / f"{deployment_id}.json").write_text(json.dumps({
        "schemaVersion": 1,
        "deploymentId": deployment_id,
        "expectedReceiptSha256": receipt.digest,
        "phase": "receiving",
    }, sort_keys=True, separators=(",", ":")) + "\n")
    (ledger_root / f"{deployment_id}.json").chmod(0o600)

    recovered = seal_delivery(
        deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(),
    )
    assert recovered.receipt.digest == receipt.digest


def test_claim_recovers_dead_owner_before_ledger_transition(tmp_path: Path) -> None:
    deployment_id, inbox_root, ledger_root = _delivered(tmp_path)
    claim = inbox_root / deployment_id / "claim"
    claim.write_text(json.dumps({
        "schemaVersion": 1,
        "deploymentId": deployment_id,
        "pid": 2**31 - 1,
        "processIdentity": "stale:2147483647",
    }, sort_keys=True, separators=(",", ":")) + "\n")
    claim.chmod(0o600)

    recovered = claim_sealed_delivery(
        deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(),
    )
    assert recovered.receipt.component == "provider"
    assert json.loads((ledger_root / f"{deployment_id}.json").read_text())["phase"] == "claimed"


def test_concurrent_dead_claim_recovery_executes_only_once(tmp_path: Path) -> None:
    deployment_id, inbox_root, ledger_root = _delivered(tmp_path)
    claim = inbox_root / deployment_id / "claim"
    claim.write_text(json.dumps({
        "schemaVersion": 1,
        "deploymentId": deployment_id,
        "pid": 2**31 - 1,
        "processIdentity": "stale:2147483647",
    }, sort_keys=True, separators=(",", ":")) + "\n")
    claim.chmod(0o600)

    def recover() -> str:
        try:
            claim_sealed_delivery(
                deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
                expected_uid=os.getuid(),
            )
            return "claimed"
        except BundleDeliveryFailure:
            return "refused"

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _index: recover(), range(2)))

    assert sorted(results) == ["claimed", "refused"]


def test_claim_recovery_distinguishes_reused_live_pid_by_process_identity(
    tmp_path: Path,
) -> None:
    deployment_id, inbox_root, ledger_root = _delivered(tmp_path)
    claim = inbox_root / deployment_id / "claim"
    claim.write_text(json.dumps({
        "schemaVersion": 1,
        "deploymentId": deployment_id,
        "pid": os.getpid(),
        "processIdentity": "previous-process-start",
    }, sort_keys=True, separators=(",", ":")) + "\n")
    claim.chmod(0o600)

    delivery = claim_sealed_delivery(
        deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(),
    )

    assert delivery.receipt.component == "provider"


def test_completion_recovers_after_partial_inbox_removal(tmp_path: Path) -> None:
    deployment_id, inbox_root, ledger_root = _delivered(tmp_path)
    delivery = claim_sealed_delivery(
        deployment_id, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(),
    )
    ledger = ledger_root / f"{deployment_id}.json"
    ledger.write_text(json.dumps({
        "schemaVersion": 1,
        "deploymentId": deployment_id,
        "expectedReceiptSha256": delivery.receipt.digest,
        "phase": "completing",
    }, sort_keys=True, separators=(",", ":")) + "\n")
    ledger.chmod(0o600)
    (inbox_root / deployment_id / "claim").unlink()

    begin_delivery(
        "e" * 64, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(), deployment_id_factory=lambda: "c" * 32,
    )

    assert not (inbox_root / deployment_id).exists()
    assert json.loads(ledger.read_text())["phase"] == "completed"


def test_receiver_accepts_only_bounded_forced_command(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    inbox_root, ledger_root = _roots(tmp_path)

    result = receiver_main(
        original_command="aisy-sidecar-receiver begin --expected-receipt-sha256=" + "d" * 64,
        stdin=io.BytesIO(),
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        expected_uid=os.getuid(),
    )

    assert result == 0
    assert len(capsys.readouterr().out.strip()) == 32
    assert receiver_main(
        original_command="sh -c id",
        stdin=io.BytesIO(),
        inbox_root=inbox_root,
        ledger_root=ledger_root,
        expected_uid=os.getuid(),
    ) == 70


def test_receiver_preserves_stable_release_refusal(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    inbox_root, ledger_root = _roots(tmp_path)
    begin_delivery(
        "d" * 64, inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(), deployment_id_factory=lambda: DEPLOYMENT,
    )

    assert receiver_main(
        original_command=f"aisy-sidecar-receiver receipt --deployment-id={DEPLOYMENT}",
        stdin=io.BytesIO(b"{}\n"), inbox_root=inbox_root, ledger_root=ledger_root,
        expected_uid=os.getuid(),
    ) == 70
    assert capsys.readouterr().err.strip() == "BUNDLE_RELEASE_REFUSED"
