from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
from types import ModuleType

import pytest

REPOSITORY = Path(__file__).resolve().parents[3]
COMMIT = "a" * 40
DEPLOYMENT = "b" * 32


def _module(name: str, relative: str) -> ModuleType:
    specification = importlib.util.spec_from_file_location(name, REPOSITORY / relative)
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


builder = _module("aisy_bootstrap_builder", "scripts/build-sidecar-ssh-bootstrap.py")
installer = _module("aisy_bootstrap_installer", "scripts/sidecar-bootstrap-install.py")


def test_bootstrap_builder_refuses_unresolvable_commit_authority() -> None:
    with pytest.raises(ValueError, match="BOOTSTRAP_BUILD_REFUSED"):
        builder.verify_exact_commit(REPOSITORY, "f" * 40)


def _build(tmp_path: Path) -> tuple[Path, Path, bytes]:
    tmp_path.mkdir(exist_ok=True)
    incoming = tmp_path / "incoming"
    incoming.mkdir(mode=0o700)
    source = incoming / DEPLOYMENT
    raw = builder.build(
        source,
        COMMIT,
        expected_uid=os.getuid(),
        commit_verifier=lambda _repository, _commit: None,
    )
    target = tmp_path / "target"
    target.mkdir(mode=0o700)
    return incoming, target, raw


def test_bootstrap_build_is_deterministic_and_installs_exact_files(tmp_path: Path) -> None:
    first_incoming, target, first = _build(tmp_path / "first")
    second_incoming, _unused, second = _build(tmp_path / "second")
    assert first == second

    source = first_incoming / DEPLOYMENT
    installer.install(
        source,
        expected_manifest_sha256=hashlib.sha256(first).hexdigest(),
        expected_commit=COMMIT,
        target_root=target,
        incoming_root=first_incoming,
        expected_uid=os.getuid(),
    )

    assert (target / "usr/libexec/aisy-sidecar-receiver").stat().st_mode & 0o777 == 0o755
    assert not (source / "usr/libexec/aisy-sidecar-bootstrap-install").exists()
    assert not (target / "usr/libexec/aisy-sidecar-bootstrap-install").exists()
    assert (target / "usr/lib/aisy/bootstrap/aisy_sidecars/sidecar_bundle_delivery.py").is_file()
    assert (target / "usr/lib/aisy/incoming").stat().st_mode & 0o777 == 0o700
    assert (target / "var/lib/aisy/delivery").stat().st_mode & 0o777 == 0o700

    installer.install(
        source,
        expected_manifest_sha256=hashlib.sha256(second).hexdigest(),
        expected_commit=COMMIT,
        target_root=target,
        incoming_root=first_incoming,
        expected_uid=os.getuid(),
    )
    assert second_incoming.exists()


@pytest.mark.parametrize(
    "mutation",
    ["digest", "content", "symlink", "hardlink", "unknown", "unknown-directory"],
)
def test_bootstrap_refuses_authority_or_inventory_mutation(
    tmp_path: Path,
    mutation: str,
) -> None:
    incoming, target, raw = _build(tmp_path)
    source = incoming / DEPLOYMENT
    digest = hashlib.sha256(raw).hexdigest()
    member = source / "usr/libexec/aisy-sidecar-receiver"
    if mutation == "digest":
        digest = "c" * 64
    elif mutation == "content":
        member.write_bytes(b"changed")
        member.chmod(0o755)
    elif mutation == "symlink":
        original = member.with_suffix(".original")
        member.rename(original)
        member.symlink_to(original)
    elif mutation == "hardlink":
        member.with_suffix(".link").hardlink_to(member)
    elif mutation == "unknown":
        extra = source / "unknown"
        extra.write_bytes(b"unknown")
        extra.chmod(0o644)
    else:
        (source / "unknown").mkdir(mode=0o700)

    with pytest.raises(installer.BootstrapFailure):
        installer.install(
            source,
            expected_manifest_sha256=digest,
            expected_commit=COMMIT,
            target_root=target,
            incoming_root=incoming,
            expected_uid=os.getuid(),
        )
