from __future__ import annotations

import stat
import subprocess
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[3]


def test_retired_package_manager_surface_is_absent() -> None:
    retired = (
        "packaging/apt",
        "scripts/build-apt-repository.py",
        "scripts/build-system-packages.py",
        "scripts/sign-apt-release.sh",
        "packages/sidecars-py/aisy_sidecars/apt_repository_builder.py",
        "packages/sidecars-py/aisy_sidecars/system_package_builder.py",
        "packages/sidecars-py/aisy_sidecars/system_package_install.py",
        "packages/sidecars-py/aisy_sidecars/system_package_trust.py",
        "packages/sidecars-py/provider_package_install.py",
        "packages/sidecars-py/voice_package_install.py",
    )

    assert [path for path in retired if (REPOSITORY / path).exists()] == []

    tracked = subprocess.run(
        ["git", "-C", str(REPOSITORY), "ls-files"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    production = [
        path for path in tracked
        if path.startswith(("packaging/", "scripts/", "packages/sidecars-py/"))
        and "/tests/" not in f"/{path}"
    ]
    retired_tokens = (
        "apt_repository",
        "system_package",
        "_package_install",
        "build-apt",
        "build-system-package",
        "sign-apt",
        "archive-keyring",
    )
    assert [
        path for path in production
        if path.startswith("packaging/")
        or path.endswith((".deb", ".gpg"))
        or any(token in path for token in retired_tokens)
    ] == []


def test_bundle_helpers_are_executable_and_use_fixed_system_python() -> None:
    helpers = (
        "packages/sidecars-py/sidecar_bundle_receiver.py",
        "packages/sidecars-py/provider_bundle_install.py",
        "packages/sidecars-py/voice_bundle_install.py",
    )

    for relative in helpers:
        path = REPOSITORY / relative
        assert stat.S_IMODE(path.stat().st_mode) & stat.S_IXUSR
        assert path.read_text().startswith("#!/usr/bin/python3.12 -I\n")


def test_managed_bootstrap_contains_no_package_manager_privilege_commands() -> None:
    source = (REPOSITORY / "scripts/install.sh").read_text().lower()

    assert "apt-get" not in source
    assert "dpkg" not in source
    assert "sudo" not in source
    assert "gpg" not in source
