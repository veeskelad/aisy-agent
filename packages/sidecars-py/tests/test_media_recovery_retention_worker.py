from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from aisy_sidecars import confinement_worker as worker


def owner_payload(index: int, *, prefix: str = "archive") -> bytes:
    return (json.dumps({
        "version": 1,
        "pid": 10_000 + index,
        "nonce": f"{prefix}-{index}",
        "acquiredAt": f"2026-08-{1 + index // 1440:02d}T{(index // 60) % 24:02d}:{index % 60:02d}:00.000Z",
    }, separators=(",", ":")) + "\n").encode()


def private_directory(path: Path) -> None:
    path.mkdir(mode=0o700)
    path.chmod(0o700)


def owner_directory(parent: Path, name: str, payload: bytes) -> Path:
    target = parent / name
    private_directory(target)
    (target / "owner.json").write_bytes(payload)
    (target / "owner.json").chmod(0o600)
    return target


def live_writer(root: Path) -> dict[str, object]:
    lock = root / ".writer.lock"
    owner = owner_directory(root, ".writer.lock", owner_payload(999, prefix="live")) / "owner.json"
    root_info = root.stat()
    lock_info = lock.stat()
    owner_info = owner.stat()
    return {
        "version": worker.PROTOCOL_VERSION,
        "requestId": "retention-1",
        "root": str(root),
        "op": "media-recovery-retention",
        "expectedRootDevice": str(root_info.st_dev),
        "expectedRootInode": str(root_info.st_ino),
        "expectedWriterLockDevice": str(lock_info.st_dev),
        "expectedWriterLockInode": str(lock_info.st_ino),
        "expectedWriterOwnerDevice": str(owner_info.st_dev),
        "expectedWriterOwnerInode": str(owner_info.st_ino),
        "expectedWriterOwnerFingerprint": (
            f"sha256:{hashlib.sha256(owner.read_bytes()).hexdigest()}"
        ),
    }


def archive(root: Path, index: int) -> str:
    archive_root = root / worker.MEDIA_RECOVERY_ROOT
    if not archive_root.exists():
        private_directory(archive_root)
    name = f"recovery-fixture-{index:03d}"
    owner_directory(archive_root, name, owner_payload(index))
    return name


def pending(root: Path, index: int, *, with_owner: bool = True) -> str:
    gc_root = root / worker.MEDIA_RECOVERY_GC_ROOT
    if not gc_root.exists():
        private_directory(gc_root)
    name = f"recovery-pending-{index:03d}"
    target = gc_root / name
    private_directory(target)
    if with_owner:
        (target / "owner.json").write_bytes(owner_payload(index, prefix="pending"))
        (target / "owner.json").chmod(0o600)
    return name


def failure(request: dict[str, object]) -> str:
    response, exit_code = worker._response_for(json.dumps(request).encode())
    assert exit_code == 2
    return str(response["error"]["code"])


def test_repairs_sixty_five_archives_and_keeps_exact_newest_eight(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    request = live_writer(tmp_path)
    for index in range(65):
        archive(tmp_path, index)

    response = worker.handle_request(request)

    assert response["data"] == {"removed": 57, "retained": 8}
    assert sorted(path.name for path in (tmp_path / worker.MEDIA_RECOVERY_ROOT).iterdir()) == [
        f"recovery-fixture-{index:03d}" for index in range(57, 65)
    ]
    assert not (tmp_path / worker.MEDIA_RECOVERY_GC_ROOT).exists()
    assert (tmp_path / worker.MEDIA_WRITER_LOCK / worker.MEDIA_WRITER_OWNER).exists()


@pytest.mark.parametrize(
    "failure_point",
    ["after-gc-root", "after-archive-rename", "after-owner-unlink"],
)
def test_hard_crash_points_converge(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_point: str,
) -> None:
    tmp_path.chmod(0o700)
    request = live_writer(tmp_path)
    for index in range(10):
        archive(tmp_path, index)
    crashed = False

    def fault(point: str) -> None:
        nonlocal crashed
        if not crashed and point == failure_point:
            crashed = True
            raise RuntimeError("simulated hard crash")

    monkeypatch.setattr(worker, "_media_retention_fault", fault)
    response, exit_code = worker._response_for(json.dumps(request).encode())
    assert exit_code == 2
    assert response["error"] == {"code": "INTERNAL_ERROR"}

    monkeypatch.setattr(worker, "_media_retention_fault", lambda _point: None)
    recovered = worker.handle_request(request)
    assert recovered["data"]["retained"] == 8
    assert len(list((tmp_path / worker.MEDIA_RECOVERY_ROOT).iterdir())) == 8
    assert not (tmp_path / worker.MEDIA_RECOVERY_GC_ROOT).exists()


def test_full_ceiling_converges_after_crash(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tmp_path.chmod(0o700)
    request = live_writer(tmp_path)
    for index in range(worker.MAX_MEDIA_RECOVERY_ENTRIES):
        archive(tmp_path, index)

    def crash_after_gc_root(point: str) -> None:
        if point == "after-gc-root":
            raise RuntimeError("simulated process death")

    monkeypatch.setattr(worker, "_media_retention_fault", crash_after_gc_root)
    response, exit_code = worker._response_for(json.dumps(request).encode())
    assert exit_code == 2
    assert response["error"] == {"code": "INTERNAL_ERROR"}

    monkeypatch.setattr(worker, "_media_retention_fault", lambda _point: None)
    recovered = worker.handle_request(request)
    assert recovered["data"] == {"removed": 248, "retained": 8}
    archive_root = tmp_path / worker.MEDIA_RECOVERY_ROOT
    assert len(list(archive_root.iterdir())) == 8
    assert not (tmp_path / worker.MEDIA_RECOVERY_GC_ROOT).exists()


def test_validates_full_inventory_before_mutation(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    request = live_writer(tmp_path)
    for index in range(9):
        archive(tmp_path, index)
    (tmp_path / worker.MEDIA_RECOVERY_ROOT / "recovery-fixture-008" / "unexpected").write_text(
        "foreign",
    )

    assert failure(request) == "STATE_CORRUPT"
    assert len(list((tmp_path / worker.MEDIA_RECOVERY_ROOT).iterdir())) == 9
    assert not (tmp_path / worker.MEDIA_RECOVERY_GC_ROOT).exists()


def test_rejects_duplicate_names_and_combined_ceiling(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    request = live_writer(tmp_path)
    duplicate = archive(tmp_path, 1)
    gc_root = tmp_path / worker.MEDIA_RECOVERY_GC_ROOT
    private_directory(gc_root)
    owner_directory(gc_root, duplicate, owner_payload(1, prefix="pending"))
    assert failure(request) == "STATE_CORRUPT"

    second = tmp_path / "second"
    private_directory(second)
    second_request = live_writer(second)
    for index in range(200):
        archive(second, index)
    for index in range(100):
        pending(second, index)
    assert failure(second_request) == "STATE_CORRUPT"
    assert len(list((second / worker.MEDIA_RECOVERY_ROOT).iterdir())) == 200
    assert len(list((second / worker.MEDIA_RECOVERY_GC_ROOT).iterdir())) == 100


def test_rejects_archive_root_replacement_that_preserves_child_inodes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tmp_path.chmod(0o700)
    request = live_writer(tmp_path)
    for index in range(9):
        archive(tmp_path, index)
    original = tmp_path / worker.MEDIA_RECOVERY_ROOT
    displaced = tmp_path / ".writer-lock-recovery-displaced"

    def replace_root(point: str) -> None:
        if point != "before-mutation":
            return
        original.rename(displaced)
        private_directory(original)
        for child in tuple(displaced.iterdir()):
            child.rename(original / child.name)

    monkeypatch.setattr(worker, "_media_retention_fault", replace_root)
    assert failure(request) == "PATH_CHANGED"
    assert len(list(original.iterdir())) == 9
    assert not (tmp_path / worker.MEDIA_RECOVERY_GC_ROOT).exists()


def test_rejects_inbox_root_replacement_before_own_mutation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "inbox"
    private_directory(root)
    request = live_writer(root)
    for index in range(9):
        archive(root, index)
    displaced = tmp_path / "inbox-displaced"

    def replace_root(point: str) -> None:
        if point != "before-mutation":
            return
        root.rename(displaced)
        private_directory(root)

    monkeypatch.setattr(worker, "_media_retention_fault", replace_root)
    assert failure(request) == "PATH_CHANGED"
    assert len(list((displaced / worker.MEDIA_RECOVERY_ROOT).iterdir())) == 9
    assert not (displaced / worker.MEDIA_RECOVERY_GC_ROOT).exists()
    assert not (root / worker.MEDIA_RECOVERY_GC_ROOT).exists()


def test_rejects_entry_substitution_and_writer_seal_mismatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tmp_path.chmod(0o700)
    request = live_writer(tmp_path)
    for index in range(9):
        archive(tmp_path, index)
    archive_root = tmp_path / worker.MEDIA_RECOVERY_ROOT
    victim = archive_root / "recovery-fixture-000"
    displaced = archive_root / "recovery-displaced"

    def replace_entry(point: str) -> None:
        if point != "before-mutation":
            return
        victim.rename(displaced)
        owner_directory(archive_root, victim.name, owner_payload(777, prefix="substituted"))

    monkeypatch.setattr(worker, "_media_retention_fault", replace_entry)
    assert failure(request) == "PATH_CHANGED"
    assert victim.exists() and displaced.exists()
    assert not (tmp_path / worker.MEDIA_RECOVERY_GC_ROOT).exists()

    monkeypatch.setattr(worker, "_media_retention_fault", lambda _point: None)
    request["expectedWriterOwnerInode"] = "1"
    assert failure(request) == "PATH_CHANGED"


def test_empty_pending_gc_entry_converges(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    request = live_writer(tmp_path)
    pending(tmp_path, 1, with_owner=False)

    response = worker.handle_request(request)

    assert response["data"] == {"removed": 1, "retained": 0}
    assert not (tmp_path / worker.MEDIA_RECOVERY_GC_ROOT).exists()


def test_empty_pending_gc_entry_is_identity_pinned(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tmp_path.chmod(0o700)
    request = live_writer(tmp_path)
    name = pending(tmp_path, 1, with_owner=False)
    gc_root = tmp_path / worker.MEDIA_RECOVERY_GC_ROOT
    victim = gc_root / name
    displaced = gc_root / "recovery-empty-displaced"

    def replace_empty(point: str) -> None:
        if point != "before-mutation":
            return
        victim.rename(displaced)
        private_directory(victim)

    monkeypatch.setattr(worker, "_media_retention_fault", replace_empty)
    assert failure(request) == "PATH_CHANGED"
    assert victim.exists() and displaced.exists()


def test_parent_sigkill_orphan_worker_serializes_immediate_restart(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    request = live_writer(tmp_path)
    for index in range(65):
        archive(tmp_path, index)
    marker = tmp_path / "orphan-ready"
    release = tmp_path / "orphan-release"
    restart_attempt = tmp_path / "restart-flock-attempt"
    child_pid_path = tmp_path / "orphan-pid"
    child_code = """
import sys, time
from pathlib import Path
from aisy_sidecars import confinement_worker as worker
marker, release = Path(sys.argv[1]), Path(sys.argv[2])
def fault(point):
    if point == 'before-mutation':
        marker.touch()
        while not release.exists():
            time.sleep(0.01)
worker._media_retention_fault = fault
raise SystemExit(worker.main())
"""
    parent_code = """
import subprocess, sys
from pathlib import Path
child = subprocess.Popen(
    [sys.executable, '-c', sys.argv[1], sys.argv[2], sys.argv[3]],
    stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
Path(sys.argv[4]).write_text(str(child.pid))
child.communicate(sys.argv[5].encode())
"""
    restart_code = """
import sys
from pathlib import Path
from aisy_sidecars import confinement_worker as worker
attempt = Path(sys.argv[1])
original_flock = worker.fcntl.flock
def marked_flock(fd, operation):
    attempt.touch()
    return original_flock(fd, operation)
worker.fcntl.flock = marked_flock
raise SystemExit(worker.main())
"""
    payload = json.dumps(request)
    parent = subprocess.Popen([
        sys.executable,
        "-c",
        parent_code,
        child_code,
        str(marker),
        str(release),
        str(child_pid_path),
        payload,
    ])
    restart: subprocess.Popen[bytes] | None = None
    child_pid = 0
    try:
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert marker.exists()
        child_pid = int(child_pid_path.read_text())

        os.kill(parent.pid, signal.SIGKILL)
        parent.wait(timeout=5)
        os.kill(child_pid, 0)

        restart = subprocess.Popen(
            [sys.executable, "-c", restart_code, str(restart_attempt)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert restart.stdin is not None
        restart.stdin.write(payload.encode())
        restart.stdin.flush()
        restart.stdin.close()
        restart.stdin = None
        deadline = time.monotonic() + 5
        while not restart_attempt.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert restart_attempt.exists()
        assert restart.poll() is None
        release.touch()
        stdout, stderr = restart.communicate(timeout=10)
        assert restart.returncode == 0, stderr.decode()
        assert json.loads(stdout) == {
            "version": worker.PROTOCOL_VERSION,
            "requestId": request["requestId"],
            "ok": True,
            "data": {"removed": 0, "retained": 8},
        }
        assert len(list((tmp_path / worker.MEDIA_RECOVERY_ROOT).iterdir())) == 8
    finally:
        release.touch(exist_ok=True)
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
        if restart is not None and restart.poll() is None:
            restart.kill()
            restart.wait(timeout=5)
        if child_pid > 0:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    os.kill(child_pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.01)
            else:
                os.kill(child_pid, signal.SIGKILL)
