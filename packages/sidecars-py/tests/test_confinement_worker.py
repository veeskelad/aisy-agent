from __future__ import annotations

import json
import os
import shutil
import stat
import sys
from pathlib import Path

import pytest

from aisy_sidecars import confinement_worker as worker


def request(root: Path, op: str, **extra: object) -> dict[str, object]:
    return {
        "version": worker.PROTOCOL_VERSION,
        "requestId": "req-1",
        "root": str(root),
        "op": op,
        **extra,
    }


def failure(root: Path, op: str, **extra: object) -> str:
    response, exit_code = worker._response_for(
        json.dumps(request(root, op, **extra)).encode(),
    )
    assert exit_code == 2
    assert response == {
        "version": worker.PROTOCOL_VERSION,
        "requestId": "req-1",
        "ok": False,
        "error": {"code": response["error"]["code"]},
    }
    return response["error"]["code"]


def test_read_write_list_and_scan_utf8(tmp_path: Path) -> None:
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "привет.txt").write_text("Привет, Aisy!", encoding="utf-8")

    read = worker.handle_request(request(tmp_path, "read", path="docs/привет.txt"))
    listing = worker.handle_request(request(tmp_path, "list", path="docs"))
    written = worker.handle_request(
        request(tmp_path, "write", path="docs/result.txt", text="готово"),
    )
    scan = worker.handle_request(request(tmp_path, "scan"))

    assert read["data"] == {"text": "Привет, Aisy!", "bytes": 19}
    assert listing["data"] == {"entries": ["привет.txt"]}
    assert written["data"] == {"bytes": 12}
    assert (tmp_path / "docs" / "result.txt").read_text(encoding="utf-8") == "готово"
    assert scan["data"] == {
        "entries": 3,
        "files": 2,
        "directories": 1,
        "totalBytes": 31,
    }


def test_runtime_probe_checks_platform_and_reports_exact_interpreter(tmp_path: Path) -> None:
    response = worker.handle_request(request(tmp_path, "runtime-probe"))

    assert response["data"] == {
        "pythonMajor": sys.version_info.major,
        "pythonMinor": sys.version_info.minor,
        "confinement": True,
    }
    assert failure(tmp_path, "runtime-probe", extra="denied") == "INVALID_REQUEST"


def test_edit_requires_an_exact_match_and_replace_all_is_explicit(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("alpha beta alpha", encoding="utf-8")
    target.chmod(0o750)

    assert failure(
        tmp_path,
        "edit",
        path="notes.txt",
        oldText="alpha",
        newText="gamma",
    ) == "AMBIGUOUS_MATCH"
    assert target.read_text(encoding="utf-8") == "alpha beta alpha"

    edited = worker.handle_request(
        request(
            tmp_path,
            "edit",
            path="notes.txt",
            oldText="alpha",
            newText="gamma",
            replaceAll=True,
        ),
    )
    assert edited["data"] == {"bytes": 16, "replacements": 2}
    assert target.read_text(encoding="utf-8") == "gamma beta gamma"
    assert stat.S_IMODE(target.stat().st_mode) == 0o750
    assert failure(
        tmp_path,
        "edit",
        path="notes.txt",
        oldText="missing",
        newText="private replacement",
    ) == "PRECONDITION_FAILED"
    assert failure(
        tmp_path,
        "edit",
        path="notes.txt",
        oldText="",
        newText="x",
    ) == "INVALID_REQUEST"
    assert not any(path.name.startswith(".aisy-edit-") for path in tmp_path.iterdir())


def test_edit_detects_atomic_target_replacement_before_publish(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("old", encoding="utf-8")
    original_read_all = worker._read_all
    reads = 0

    def replacing_read_all(file_fd: int, maximum: int) -> bytes:
        nonlocal reads
        reads += 1
        payload = original_read_all(file_fd, maximum)
        if reads == 2:
            replacement = tmp_path / "replacement.tmp"
            replacement.write_text("concurrent", encoding="utf-8")
            os.replace(replacement, target)
        return payload

    monkeypatch.setattr(worker, "_read_all", replacing_read_all)
    assert failure(
        tmp_path,
        "edit",
        path="notes.txt",
        oldText="old",
        newText="new",
    ) == "PATH_CHANGED"
    assert target.read_text(encoding="utf-8") == "concurrent"
    assert not any(path.name.startswith(".aisy-edit-") for path in tmp_path.iterdir())


@pytest.mark.parametrize(
    "path",
    ["../outside", "docs/../outside", "/etc/passwd", "docs//file", "docs/./file", ""],
)
def test_read_rejects_non_relative_canonical_paths(tmp_path: Path, path: str) -> None:
    assert failure(tmp_path, "read", path=path) == "INVALID_PATH"


def test_root_list_accepts_dot_but_not_absolute_path(tmp_path: Path) -> None:
    (tmp_path / "a.txt").write_text("a")
    response = worker.handle_request(request(tmp_path, "list", path="."))
    assert response["data"] == {"entries": ["a.txt"]}
    assert failure(tmp_path, "list", path=str(tmp_path)) == "INVALID_PATH"


def test_list_and_scan_reject_control_characters_in_entry_names(tmp_path: Path) -> None:
    (tmp_path / "hostile\nname.txt").write_text("content")
    assert failure(tmp_path, "list") == "INVALID_PATH"
    assert failure(tmp_path, "scan") == "INVALID_PATH"


@pytest.mark.parametrize("op", ["read", "write", "edit"])
def test_final_symlink_is_denied_without_touching_target(tmp_path: Path, op: str) -> None:
    outside = tmp_path.parent / f"outside-{tmp_path.name}.txt"
    outside.write_text("outside", encoding="utf-8")
    (tmp_path / "link.txt").symlink_to(outside)

    extra: dict[str, object] = {"path": "link.txt"}
    if op == "write":
        extra["text"] = "changed"
    elif op == "edit":
        extra.update({"oldText": "outside", "newText": "changed"})
    assert failure(tmp_path, op, **extra) == "SYMLINK_DENIED"
    assert outside.read_text(encoding="utf-8") == "outside"


@pytest.mark.parametrize("op", ["read", "write", "edit", "list", "scan"])
def test_symlinked_directory_component_is_denied(tmp_path: Path, op: str) -> None:
    outside = tmp_path.parent / f"outside-dir-{tmp_path.name}"
    outside.mkdir()
    (outside / "value.txt").write_text("outside")
    (tmp_path / "escape").symlink_to(outside, target_is_directory=True)

    if op == "read":
        extra: dict[str, object] = {"path": "escape/value.txt"}
    elif op == "write":
        extra = {"path": "escape/value.txt", "text": "changed"}
    elif op == "edit":
        extra = {
            "path": "escape/value.txt",
            "oldText": "outside",
            "newText": "changed",
        }
    else:
        extra = {"path": "escape"}
    assert failure(tmp_path, op, **extra) == "SYMLINK_DENIED"
    assert (outside / "value.txt").read_text() == "outside"


def test_scan_rejects_symlink_and_fifo(tmp_path: Path) -> None:
    (tmp_path / "link").symlink_to(tmp_path.parent)
    assert failure(tmp_path, "scan") == "SYMLINK_DENIED"
    (tmp_path / "link").unlink()

    if not hasattr(os, "mkfifo"):
        pytest.skip("FIFO is unavailable")
    os.mkfifo(tmp_path / "pipe")
    assert failure(tmp_path, "scan") == "SPECIAL_FILE_DENIED"


def test_read_edit_and_scan_reject_hardlinks(tmp_path: Path) -> None:
    original = tmp_path / "original.txt"
    original.write_text("content")
    os.link(original, tmp_path / "alias.txt")

    assert failure(tmp_path, "read", path="original.txt") == "HARDLINK_DENIED"
    assert failure(
        tmp_path,
        "edit",
        path="original.txt",
        oldText="content",
        newText="changed",
    ) == "HARDLINK_DENIED"
    assert original.read_text() == "content"
    assert failure(tmp_path, "scan") == "HARDLINK_DENIED"


def test_read_write_and_utf8_limits(tmp_path: Path) -> None:
    (tmp_path / "large.txt").write_text("abcd", encoding="utf-8")
    (tmp_path / "binary.dat").write_bytes(b"\xff")

    assert failure(tmp_path, "read", path="large.txt", maxBytes=3) == "LIMIT_EXCEEDED"
    assert failure(tmp_path, "read", path="binary.dat") == "UTF8_REQUIRED"
    assert failure(tmp_path, "write", path="new.txt", text="abcd", maxBytes=3) == "LIMIT_EXCEEDED"
    assert failure(
        tmp_path,
        "edit",
        path="large.txt",
        oldText="a",
        newText="long",
        maxBytes=4,
    ) == "LIMIT_EXCEEDED"
    assert not (tmp_path / "new.txt").exists()


@pytest.mark.parametrize(
    ("limit", "value"),
    [("maxEntries", 1), ("maxDepth", 1), ("maxFileBytes", 2), ("maxTotalBytes", 5)],
)
def test_scan_limits_fail_closed(tmp_path: Path, limit: str, value: int) -> None:
    (tmp_path / "a.txt").write_text("abc")
    (tmp_path / "nested").mkdir()
    (tmp_path / "nested" / "b.txt").write_text("def")
    (tmp_path / "nested" / "deep").mkdir()
    (tmp_path / "nested" / "deep" / "c.txt").write_text("ghi")

    assert failure(tmp_path, "scan", **{limit: value}) == "LIMIT_EXCEEDED"


def test_scan_rejects_limit_above_code_cap(tmp_path: Path) -> None:
    assert failure(tmp_path, "scan", maxEntries=worker.MAX_SCAN_ENTRIES + 1) == "LIMIT_EXCEEDED"


def test_root_symlink_is_denied(tmp_path: Path) -> None:
    link = tmp_path.parent / f"root-link-{tmp_path.name}"
    link.symlink_to(tmp_path, target_is_directory=True)
    assert failure(link, "scan") == "SYMLINK_DENIED"


def test_magic_link_shape_is_denied_when_proc_is_available(tmp_path: Path) -> None:
    proc_fd = Path("/proc/self/fd")
    if not proc_fd.exists():
        pytest.skip("procfs magic links are unavailable")
    (tmp_path / "magic").symlink_to(proc_fd)
    assert failure(tmp_path, "list", path="magic") == "SYMLINK_DENIED"


def test_identity_and_cross_device_checks_fail_closed(tmp_path: Path) -> None:
    info = os.stat(tmp_path)
    changed = list(info)
    changed[1] = info.st_ino + 1
    with pytest.raises(worker.ConfinementFailure, match="PATH_CHANGED"):
        worker._verify_identity(info, os.stat_result(changed))

    other_device = list(info)
    other_device[2] = info.st_dev + 1
    with pytest.raises(worker.ConfinementFailure, match="CROSS_DEVICE_DENIED"):
        worker._reject_unsafe_node(os.stat_result(other_device), info.st_dev)


def test_read_refuses_in_place_change_during_descriptor_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "researcher.md"
    target.write_text("first", encoding="utf-8")
    original = worker._read_all

    def mutate(fd: int, maximum: int) -> bytes:
        payload = original(fd, maximum)
        target.write_text("second", encoding="utf-8")
        return payload

    monkeypatch.setattr(worker, "_read_all", mutate)
    assert failure(tmp_path, "read", path="researcher.md", maxBytes=65536) == "PATH_CHANGED"


def test_read_refuses_entry_replacement_before_descriptor_open(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "researcher.md"
    target.write_text("trusted", encoding="utf-8")
    replacement = tmp_path / "replacement.md"
    replacement.write_text("replacement", encoding="utf-8")
    original = worker._lstat
    injected = False

    def replace_after_lstat(parent_fd: int, name: str) -> os.stat_result:
        nonlocal injected
        info = original(parent_fd, name)
        if name == "researcher.md" and not injected:
            injected = True
            os.replace(replacement, target)
        return info

    monkeypatch.setattr(worker, "_lstat", replace_after_lstat)
    assert failure(tmp_path, "read", path="researcher.md", maxBytes=65536) == "PATH_CHANGED"


def test_request_refuses_root_replacement_after_descriptor_open(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "researcher.md"
    target.write_text("trusted", encoding="utf-8")
    detached = tmp_path.parent / f"{tmp_path.name}-detached"
    original = worker._read

    def replace_root(root_fd: int, root_device: int, request_value: dict[str, object]) -> dict[str, object]:
        result = original(root_fd, root_device, request_value)
        os.rename(tmp_path, detached)
        tmp_path.mkdir()
        (tmp_path / "researcher.md").write_text("replacement", encoding="utf-8")
        return result

    monkeypatch.setattr(worker, "_read", replace_root)
    try:
        assert failure(tmp_path, "read", path="researcher.md", maxBytes=65536) == "PATH_CHANGED"
        assert (tmp_path / "researcher.md").read_text(encoding="utf-8") == "replacement"
    finally:
        shutil.rmtree(detached, ignore_errors=True)


def test_request_refuses_root_replacement_between_stat_and_open(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "researcher.md").write_text("trusted", encoding="utf-8")
    detached = tmp_path.parent / f"{tmp_path.name}-detached-before-open"
    original = os.open
    injected = False

    def replace_before_open(
        path: str | bytes,
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal injected
        if path == str(tmp_path) and dir_fd is None and not injected:
            injected = True
            os.rename(tmp_path, detached)
            tmp_path.mkdir()
            (tmp_path / "researcher.md").write_text("replacement", encoding="utf-8")
        return original(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "open", replace_before_open)
    monkeypatch.setattr(worker, "_require_platform", lambda: None)
    try:
        assert failure(tmp_path, "read", path="researcher.md", maxBytes=65536) == "PATH_CHANGED"
    finally:
        shutil.rmtree(detached, ignore_errors=True)


def test_pinned_root_identity_is_required_as_an_exact_pair(tmp_path: Path) -> None:
    info = os.stat(tmp_path)
    valid = {
        "expectedRootDevice": str(info.st_dev),
        "expectedRootInode": str(info.st_ino),
    }
    assert worker.handle_request(request(tmp_path, "list", **valid))["ok"] is True
    assert failure(tmp_path, "list", expectedRootDevice=str(info.st_dev)) == "INVALID_REQUEST"
    assert failure(tmp_path, "list", expectedRootDevice="-1", expectedRootInode=str(info.st_ino)) == "INVALID_REQUEST"
    assert failure(tmp_path, "list", expectedRootDevice=str(info.st_dev), expectedRootInode=str(info.st_ino + 1)) == "PATH_CHANGED"


def test_protocol_errors_are_redacted(tmp_path: Path) -> None:
    payload = json.dumps(request(tmp_path, "read", path="missing/private.txt")).encode()
    response, exit_code = worker._response_for(payload)

    assert exit_code == 2
    serialized = json.dumps(response)
    assert response["error"] == {"code": "NOT_FOUND"}
    assert str(tmp_path) not in serialized
    assert "missing/private.txt" not in serialized


def test_malformed_protocol_and_unknown_operation_are_rejected(tmp_path: Path) -> None:
    malformed, malformed_exit = worker._response_for(b"not-json")
    unknown, unknown_exit = worker._response_for(
        json.dumps(request(tmp_path, "execute")).encode(),
    )

    assert malformed_exit == 2
    assert malformed["error"] == {"code": "INVALID_REQUEST"}
    assert unknown_exit == 2
    assert unknown["error"] == {"code": "INVALID_REQUEST"}


@pytest.mark.parametrize(
    "payload",
    [
        b'{"version":1,"version":1,"requestId":"req-1","root":"/tmp","op":"scan"}',
        b'{"version":1,"requestId":"req-1","root":"/tmp","op":"scan","maxDepth":NaN}',
    ],
)
def test_non_canonical_json_is_rejected(payload: bytes) -> None:
    response, exit_code = worker._response_for(payload)
    assert exit_code == 2
    assert response["error"] == {"code": "INVALID_REQUEST"}
