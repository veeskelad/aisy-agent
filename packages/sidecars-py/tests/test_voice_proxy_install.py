from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from aisy_sidecars.voice_proxy_install import (
    InstallFailure,
    _arguments,
    _config,
    activate_staged,
    restart_services,
    rollback,
    stage_bundle,
    validate_units,
    verify_bundle,
)


def _bundle(root: Path, *, protocol: int = 1) -> tuple[str, str]:
    files = {
        "aisy_sidecars/runtime.py": (b"runtime\n", 0o644),
        "aisy_voice_broker_bridge.node": (b"native\n", 0o755),
        "systemd/aisy-voice-broker.service": (b"[Service]\n", 0o644),
    }
    entries = []
    for relative, (content, mode) in sorted(files.items()):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(mode)
        entries.append({
            "path": relative,
            "sha256": hashlib.sha256(content).hexdigest(),
            "size": len(content),
            "mode": mode,
        })
    commit = "a" * 40
    raw = (json.dumps({
        "schemaVersion": 1,
        "protocolVersion": protocol,
        "release": "0.1.14-test",
        "commit": commit,
        "files": entries,
    }, sort_keys=True, separators=(",", ":")) + "\n").encode()
    (root / "manifest.json").write_bytes(raw)
    (root / "manifest.json").chmod(0o644)
    return hashlib.sha256(raw).hexdigest(), commit


def _exchange(left: Path, right: Path) -> None:
    temporary = left.with_name("exchange-tmp")
    left.rename(temporary)
    right.rename(left)
    temporary.rename(right)


def test_verifies_and_copies_every_file_from_the_attested_descriptor(tmp_path: Path) -> None:
    source = tmp_path / "bundle"
    source.mkdir(mode=0o755)
    digest, commit = _bundle(source)

    manifest = verify_bundle(
        source,
        expected_manifest_sha256=digest,
        expected_commit=commit,
        expected_uid=os.getuid(),
    )
    staged = tmp_path / "staged"
    stage_bundle(source, manifest, staged, expected_uid=os.getuid())

    assert (staged / "manifest.json").read_bytes() == manifest.raw
    for item in manifest.files:
        content = (staged / item.path).read_bytes()
        assert hashlib.sha256(content).hexdigest() == item.sha256
        assert (staged / item.path).stat().st_mode & 0o777 == item.mode


@pytest.mark.parametrize("mutation", ["digest", "commit", "protocol"])
def test_refuses_incompatible_or_unexpected_release(tmp_path: Path, mutation: str) -> None:
    source = tmp_path / "bundle"
    source.mkdir(mode=0o755)
    digest, commit = _bundle(source, protocol=2 if mutation == "protocol" else 1)
    with pytest.raises(InstallFailure):
        verify_bundle(
            source,
            expected_manifest_sha256="b" * 64 if mutation == "digest" else digest,
            expected_commit="c" * 40 if mutation == "commit" else commit,
            expected_uid=os.getuid(),
        )


@pytest.mark.parametrize("kind", ["symlink", "hardlink"])
def test_refuses_link_substitution(tmp_path: Path, kind: str) -> None:
    source = tmp_path / "bundle"
    source.mkdir(mode=0o755)
    digest, commit = _bundle(source)
    target = source / "aisy_sidecars/runtime.py"
    original = source / "original"
    target.rename(original)
    if kind == "symlink":
        target.symlink_to(original)
    else:
        os.link(original, target)

    with pytest.raises(InstallFailure, match="SOURCE_REFUSED"):
        verify_bundle(
            source,
            expected_manifest_sha256=digest,
            expected_commit=commit,
            expected_uid=os.getuid(),
        )


def test_refuses_unsafe_mode_and_source_swap(tmp_path: Path) -> None:
    source = tmp_path / "bundle"
    source.mkdir(mode=0o755)
    digest, commit = _bundle(source)
    target = source / "aisy_sidecars/runtime.py"
    target.chmod(0o600)
    with pytest.raises(InstallFailure, match="SOURCE_REFUSED"):
        verify_bundle(
            source,
            expected_manifest_sha256=digest,
            expected_commit=commit,
            expected_uid=os.getuid(),
        )

    target.chmod(0o644)
    manifest = verify_bundle(
        source,
        expected_manifest_sha256=digest,
        expected_commit=commit,
        expected_uid=os.getuid(),
    )
    target.write_bytes(b"changed\n")
    with pytest.raises(InstallFailure, match="SOURCE_CHANGED"):
        stage_bundle(source, manifest, tmp_path / "staged", expected_uid=os.getuid())


def test_atomic_activation_keeps_one_previous_release(tmp_path: Path) -> None:
    current = tmp_path / "current"
    previous = tmp_path / "previous"
    staged = tmp_path / "staged"
    for path, marker in ((current, "old"), (previous, "older"), (staged, "new")):
        path.mkdir()
        (path / "release").write_text(marker)

    activate_staged(staged, current, previous, _exchange)

    assert (current / "release").read_text() == "new"
    assert (previous / "release").read_text() == "old"
    assert not staged.exists()


def test_failed_rollback_handshake_restores_current(tmp_path: Path) -> None:
    current = tmp_path / "current"
    previous = tmp_path / "previous"
    for path, marker in ((current, "new"), (previous, "old")):
        path.mkdir()
        (path / "release").write_text(marker)
    calls = 0

    def handshake(path: Path) -> bool:
        nonlocal calls
        calls += 1
        return calls == 1

    with pytest.raises(InstallFailure, match="ROLLBACK_HANDSHAKE_REFUSED"):
        rollback(current, previous, handshake, _exchange)

    assert (current / "release").read_text() == "new"
    assert (previous / "release").read_text() == "old"


def test_exact_installer_arguments_and_public_config() -> None:
    values = _arguments(
        ["--runtime-uid=1000", "--runtime-cgroup=/user.slice/aisy.service"],
        ("runtime-uid", "runtime-cgroup"),
    )
    assert values == {
        "runtime-uid": "1000",
        "runtime-cgroup": "/user.slice/aisy.service",
    }
    value = json.loads(
        _config("release-1", 1000, "/user.slice/aisy.service", "d" * 64)
    )
    assert value == {
        "schemaVersion": 1,
        "runtimeUid": 1000,
        "runtimeCgroup": "/user.slice/aisy.service",
        "release": "release-1",
        "installationHash": "d" * 64,
    }
    with pytest.raises(InstallFailure, match="ARGUMENT_REFUSED"):
        _arguments(["--runtime-uid=1000", "--runtime-uid=1001"], ("runtime-uid",))
    with pytest.raises(InstallFailure, match="CONFIG_REFUSED"):
        _config("release-1", 1000, "/../foreign", "d" * 64)


def test_release_cutover_restarts_running_broker_and_worker_socket() -> None:
    calls: list[list[str]] = []

    restart_services(calls.append)

    assert calls == [
        ["/usr/bin/systemctl", "daemon-reload"],
        [
            "/usr/bin/systemctl",
            "enable",
            "aisy-voice-broker.service",
            "aisy-voice-worker.socket",
        ],
        [
            "/usr/bin/systemctl",
            "restart",
            "aisy-voice-broker.service",
        ],
        [
            "/usr/bin/systemctl",
            "restart",
            "aisy-voice-worker.socket",
        ],
        [
            "/usr/bin/systemctl",
            "is-active",
            "aisy-voice-broker.service",
        ],
        [
            "/usr/bin/systemctl",
            "is-active",
            "aisy-voice-worker.socket",
        ],
    ]


def test_shipped_units_keep_required_sandbox_gates() -> None:
    release_root = Path(__file__).parents[1]
    units = validate_units(release_root)
    assert set(units) == {
        "aisy-voice-broker.service",
        "aisy-voice-worker.socket",
        "aisy-voice-worker@.service",
    }
    assert b"LoadCredentialEncrypted=aisy-deepgram-cloud-primary:" in units[
        "aisy-voice-worker@.service"
    ]


def test_release_builder_emits_verifiable_external_digest(tmp_path: Path) -> None:
    repository = next(
        (
            parent
            for parent in Path(__file__).resolve().parents
            if (parent / "scripts/build-voice-proxy-release.py").is_file()
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
    addon = tmp_path / "bridge.node"
    addon.write_bytes(b"test-native-addon\n")
    addon.chmod(0o755)
    output = tmp_path / "bundle"
    result = subprocess.run(
        [
            sys.executable,
            str(repository / "scripts/build-voice-proxy-release.py"),
            f"--output={output}",
            f"--commit={commit}",
            "--release=0.1.14-test",
            f"--native-addon={addon}",
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
            str(repository / "scripts/build-voice-proxy-release.py"),
            f"--output={second_output}",
            f"--commit={commit}",
            "--release=0.1.14-test",
            f"--native-addon={addon}",
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
    assert manifest.release == "0.1.14-test"
    if os.geteuid() == 0:
        subprocess.run(
            [
                sys.executable,
                "-I",
                str(output / "voice_proxy_service.py"),
                "self-check",
                manifest.release,
            ],
            check=True,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            close_fds=True,
            timeout=10,
        )
