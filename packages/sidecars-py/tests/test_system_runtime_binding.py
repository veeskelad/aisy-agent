from __future__ import annotations

import hashlib
import os
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from aisy_sidecars import system_runtime_binding as runtime_binding
from aisy_sidecars.sidecar_bundle_delivery import BundleDeliveryFailure
from aisy_sidecars.system_runtime_binding import (
    ProcessProjection,
    RuntimeAccount,
    RuntimeBinding,
    SystemdProjection,
    installation_hash,
    resolve_runtime_binding,
)


def test_runtime_path_check_rejects_symlink_and_writable_home(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir(mode=0o700)
    runtime_binding._check_runtime_path(home, os.getuid(), "home")

    home.chmod(0o775)
    with pytest.raises(BundleDeliveryFailure, match="RUNTIME_BINDING_REFUSED"):
        runtime_binding._check_runtime_path(home, os.getuid(), "home")
    home.chmod(0o700)
    link = tmp_path / "home-link"
    link.symlink_to(home, target_is_directory=True)
    with pytest.raises(BundleDeliveryFailure, match="RUNTIME_BINDING_REFUSED"):
        runtime_binding._check_runtime_path(link, os.getuid(), "home")


def test_installation_hash_matches_production_domain_separator() -> None:
    home = "/srv/aisy/runtime"
    assert installation_hash("voice", home) == hashlib.sha256(
        b"aisy.voice.installation.v1\0/srv/aisy/runtime"
    ).hexdigest()
    assert installation_hash("provider", home) == hashlib.sha256(
        b"aisy.provider.installation.v1\0/srv/aisy/runtime"
    ).hexdigest()


def test_bounded_proc_reader_accepts_zero_reported_size(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "proc-like"
    path.write_text("Uid:\t1002 1002 1002 1002\n")
    real_fstat = os.fstat

    def zero_size(descriptor: int) -> SimpleNamespace:
        info = real_fstat(descriptor)
        return SimpleNamespace(st_mode=info.st_mode, st_size=0)

    monkeypatch.setattr(runtime_binding.os, "fstat", zero_size)
    assert runtime_binding._bounded(path, 1024).startswith("Uid:")


def _projection() -> SystemdProjection:
    return SystemdProjection(
        active_state="active",
        sub_state="running",
        main_pid=4242,
        control_group="/user.slice/user-1002.slice/user@1002.service/app.slice/aisy.service",
        fragment_path=Path("/home/aisy/.config/systemd/user/aisy.service"),
    )


def test_resolves_runtime_binding_from_two_stable_systemd_reads() -> None:
    projection = _projection()
    calls = 0

    def show(_user: str, _unit: str) -> SystemdProjection:
        nonlocal calls
        calls += 1
        return projection

    binding = resolve_runtime_binding(
        component="provider",
        runtime_user="aisy",
        runtime_unit="aisy.service",
        aisy_home="/home/aisy/.aisy",
        account_lookup=lambda _user: RuntimeAccount(1002, 1003, Path("/home/aisy")),
        systemd_show=show,
        process_inspect=lambda _pid: ProcessProjection(
            4242, 1002, 1003, projection.control_group
        ),
        path_check=lambda path, uid, kind: (path, uid, kind),
    )

    assert calls == 2
    assert binding == RuntimeBinding(
        runtime_uid=1002,
        runtime_gid=1003,
        runtime_unit="aisy.service",
        runtime_cgroup=projection.control_group,
        installation_hash=installation_hash("provider", "/home/aisy/.aisy"),
    )


@pytest.mark.parametrize("drift", [
    "inactive", "pid", "uid", "gid", "cgroup", "fragment", "second-read",
])
def test_refuses_runtime_binding_drift(drift: str) -> None:
    first = replace(
        _projection(),
        fragment_path=Path("/home/other/.config/systemd/user/aisy.service"),
    ) if drift == "fragment" else _projection()
    projections = [
        first,
        replace(first, main_pid=5252) if drift == "second-read" else first,
    ]

    def show(_user: str, _unit: str) -> SystemdProjection:
        value = projections.pop(0)
        return replace(value, active_state="failed") if drift == "inactive" else value

    process = ProcessProjection(
        4242,
        2000 if drift == "uid" else 1002,
        2001 if drift == "gid" else 1003,
        "/foreign.slice" if drift == "cgroup" else first.control_group,
    )
    if drift == "pid":
        process = replace(process, pid=5252)

    with pytest.raises(BundleDeliveryFailure, match="RUNTIME_BINDING_REFUSED"):
        resolve_runtime_binding(
            component="voice",
            runtime_user="aisy",
            runtime_unit="aisy.service",
            aisy_home="/home/aisy/.aisy",
            account_lookup=lambda _user: RuntimeAccount(1002, 1003, Path("/home/aisy")),
            systemd_show=show,
            process_inspect=lambda _pid: process,
            path_check=lambda path, uid, kind: (path, uid, kind),
        )
