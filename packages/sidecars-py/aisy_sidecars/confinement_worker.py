"""Descriptor-relative filesystem confinement worker.

The worker accepts one JSON request on stdin and emits one JSON response. All
target access starts from an open directory descriptor and uses ``O_NOFOLLOW``.
"""

from __future__ import annotations

import errno
import json
import os
import stat
import sys
from dataclasses import dataclass
from typing import Any, NoReturn
from uuid import uuid4

PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 64 * 1024 * 1024
MAX_PATH_BYTES = 4 * 1024
MAX_READ_BYTES = 8 * 1024 * 1024
MAX_WRITE_BYTES = 8 * 1024 * 1024
MAX_SCAN_ENTRIES = 50_000
MAX_SCAN_DEPTH = 64
MAX_SCAN_FILE_BYTES = 16 * 1024 * 1024
MAX_SCAN_TOTAL_BYTES = 256 * 1024 * 1024


class ConfinementFailure(Exception):
    """A deliberately redacted protocol failure."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class ScanState:
    entries: int = 0
    files: int = 0
    directories: int = 0
    total_bytes: int = 0


def _fail(code: str) -> NoReturn:
    raise ConfinementFailure(code)


def _require_platform() -> None:
    required_flags = ("O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC")
    if os.name != "posix" or any(not hasattr(os, flag) for flag in required_flags):
        _fail("UNSUPPORTED_PLATFORM")
    required_dir_fd = (os.open, os.stat, os.rename, os.unlink)
    if any(function not in os.supports_dir_fd for function in required_dir_fd):
        _fail("UNSUPPORTED_PLATFORM")
    if os.stat not in os.supports_follow_symlinks:
        _fail("UNSUPPORTED_PLATFORM")


def _as_object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail("INVALID_REQUEST")
    if any(not isinstance(key, str) for key in value):
        _fail("INVALID_REQUEST")
    return value


def _required_string(request: dict[str, Any], key: str, *, max_bytes: int = 1024) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value or "\x00" in value:
        _fail("INVALID_REQUEST")
    if len(value.encode("utf-8")) > max_bytes:
        _fail("LIMIT_EXCEEDED")
    return value


def _bounded_int(request: dict[str, Any], key: str, default: int, hard_maximum: int) -> int:
    value = request.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        _fail("INVALID_REQUEST")
    if value > hard_maximum:
        _fail("LIMIT_EXCEEDED")
    return value


def _required_decimal(request: dict[str, Any], key: str) -> int:
    value = request.get(key)
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 20
        or (value != "0" and value.startswith("0"))
        or not value.isascii()
        or not value.isdecimal()
    ):
        _fail("INVALID_REQUEST")
    parsed = int(value)
    if parsed < 0 or parsed > (1 << 64) - 1:
        _fail("INVALID_REQUEST")
    return parsed


def _expected_path_components(
    request: dict[str, Any],
    parts: tuple[str, ...],
    allowed_lengths: set[int],
) -> tuple[tuple[str, int, int], ...] | None:
    raw = request.get("expectedPathComponents")
    if raw is None:
        return None
    if not isinstance(raw, list) or len(raw) not in allowed_lengths or len(raw) > 256:
        _fail("INVALID_REQUEST")
    result: list[tuple[str, int, int]] = []
    for index, value in enumerate(raw):
        item = _as_object(value)
        if set(item) != {"name", "device", "inode"}:
            _fail("INVALID_REQUEST")
        name = _required_string(item, "name", max_bytes=MAX_PATH_BYTES)
        _safe_entry_name(name)
        if index >= len(parts) or name != parts[index]:
            _fail("INVALID_REQUEST")
        result.append((
            name,
            _required_decimal(item, "device"),
            _required_decimal(item, "inode"),
        ))
    return tuple(result)


def _path_parts(value: Any, *, allow_root: bool) -> tuple[str, ...]:
    if not isinstance(value, str) or "\x00" in value:
        _fail("INVALID_PATH")
    if len(value.encode("utf-8")) > MAX_PATH_BYTES:
        _fail("LIMIT_EXCEEDED")
    if value in ("", "."):
        if allow_root:
            return ()
        _fail("INVALID_PATH")
    if os.path.isabs(value) or value.startswith("/"):
        _fail("INVALID_PATH")
    parts = value.split("/")
    if any(
        part in ("", ".", "..")
        or any(ord(character) < 32 or ord(character) == 127 for character in part)
        for part in parts
    ):
        _fail("INVALID_PATH")
    return tuple(parts)


def _safe_entry_name(name: str) -> None:
    if (
        name in ("", ".", "..")
        or "/" in name
        or "\x00" in name
        or any(ord(character) < 32 or ord(character) == 127 for character in name)
    ):
        _fail("INVALID_PATH")


def _map_os_error(error: OSError) -> NoReturn:
    if error.errno in (errno.ELOOP, errno.EMLINK):
        _fail("SYMLINK_DENIED")
    if error.errno == errno.EXDEV:
        _fail("CROSS_DEVICE_DENIED")
    if error.errno == errno.ENOENT:
        _fail("NOT_FOUND")
    if error.errno == errno.ENOTDIR:
        _fail("NOT_DIRECTORY")
    if error.errno in (errno.EFBIG, errno.ENOSPC, errno.EDQUOT):
        _fail("LIMIT_EXCEEDED")
    _fail("IO_FAILED")


def _lstat(parent_fd: int, name: str) -> os.stat_result:
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as error:
        _map_os_error(error)


def _reject_unsafe_node(info: os.stat_result, root_device: int) -> None:
    if stat.S_ISLNK(info.st_mode):
        _fail("SYMLINK_DENIED")
    if info.st_dev != root_device:
        _fail("CROSS_DEVICE_DENIED")
    if not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode):
        _fail("SPECIAL_FILE_DENIED")
    if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
        _fail("HARDLINK_DENIED")


def _verify_identity(before: os.stat_result, after: os.stat_result) -> None:
    if before.st_dev != after.st_dev or before.st_ino != after.st_ino:
        _fail("PATH_CHANGED")


def _verify_expected_identity(
    info: os.stat_result,
    expected: tuple[str, int, int] | None,
) -> None:
    if expected is not None and (info.st_dev != expected[1] or info.st_ino != expected[2]):
        _fail("PATH_CHANGED")


def _open_root(
    root: str,
    expected_device: int | None = None,
    expected_inode: int | None = None,
) -> tuple[int, int]:
    if not os.path.isabs(root) or os.path.normpath(root) != root or root == os.path.abspath(os.sep):
        _fail("INVALID_REQUEST")
    try:
        before = os.stat(root, follow_symlinks=False)
        if stat.S_ISLNK(before.st_mode):
            _fail("SYMLINK_DENIED")
        if not stat.S_ISDIR(before.st_mode):
            _fail("NOT_DIRECTORY")
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except ConfinementFailure:
        raise
    except OSError as error:
        _map_os_error(error)
    try:
        after = os.fstat(root_fd)
        _verify_identity(before, after)
        if not stat.S_ISDIR(after.st_mode):
            _fail("NOT_DIRECTORY")
        if (
            (expected_device is not None and after.st_dev != expected_device)
            or (expected_inode is not None and after.st_ino != expected_inode)
        ):
            _fail("PATH_CHANGED")
        return root_fd, after.st_dev
    except BaseException:
        os.close(root_fd)
        raise


def _open_directory(
    parent_fd: int,
    name: str,
    root_device: int,
    expected: tuple[str, int, int] | None = None,
) -> int:
    before = _lstat(parent_fd, name)
    _reject_unsafe_node(before, root_device)
    if not stat.S_ISDIR(before.st_mode):
        _fail("NOT_DIRECTORY")
    try:
        opened = os.open(
            name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=parent_fd,
        )
    except OSError as error:
        _map_os_error(error)
    try:
        after = os.fstat(opened)
        _verify_identity(before, after)
        _verify_expected_identity(after, expected)
        _reject_unsafe_node(after, root_device)
        if not stat.S_ISDIR(after.st_mode):
            _fail("NOT_DIRECTORY")
        return opened
    except BaseException:
        os.close(opened)
        raise


def _walk_directories(
    root_fd: int,
    parts: tuple[str, ...],
    root_device: int,
    expected: tuple[tuple[str, int, int], ...] | None = None,
) -> int:
    current = os.dup(root_fd)
    try:
        for index, part in enumerate(parts):
            following = _open_directory(
                current,
                part,
                root_device,
                None if expected is None else expected[index],
            )
            os.close(current)
            current = following
        return current
    except BaseException:
        os.close(current)
        raise


def _open_regular(
    parent_fd: int,
    name: str,
    root_device: int,
    expected: tuple[str, int, int] | None = None,
) -> tuple[int, os.stat_result]:
    before = _lstat(parent_fd, name)
    _reject_unsafe_node(before, root_device)
    if not stat.S_ISREG(before.st_mode):
        _fail("NOT_REGULAR")
    try:
        opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    except OSError as error:
        _map_os_error(error)
    try:
        after = os.fstat(opened)
        _verify_identity(before, after)
        _verify_expected_identity(after, expected)
        _reject_unsafe_node(after, root_device)
        if not stat.S_ISREG(after.st_mode):
            _fail("NOT_REGULAR")
        return opened, after
    except BaseException:
        os.close(opened)
        raise


def _read_all(file_fd: int, maximum: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = os.read(file_fd, min(64 * 1024, maximum + 1 - total))
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > maximum:
            _fail("LIMIT_EXCEEDED")
        chunks.append(chunk)


def _read(root_fd: int, root_device: int, request: dict[str, Any]) -> dict[str, Any]:
    parts = _path_parts(request.get("path"), allow_root=False)
    expected = _expected_path_components(request, parts, {len(parts)})
    maximum = _bounded_int(request, "maxBytes", MAX_READ_BYTES, MAX_READ_BYTES)
    parent_fd = _walk_directories(
        root_fd,
        parts[:-1],
        root_device,
        None if expected is None else expected[:-1],
    )
    try:
        file_fd, info = _open_regular(
            parent_fd,
            parts[-1],
            root_device,
            None if expected is None else expected[-1],
        )
        try:
            if info.st_size > maximum:
                _fail("LIMIT_EXCEEDED")
            payload = _read_all(file_fd, maximum)
            opened_after = os.fstat(file_fd)
            _verify_identity(info, opened_after)
            if (
                opened_after.st_size != info.st_size
                or opened_after.st_mtime_ns != info.st_mtime_ns
                or opened_after.st_ctime_ns != info.st_ctime_ns
            ):
                _fail("PATH_CHANGED")
            current = _lstat(parent_fd, parts[-1])
            _verify_identity(info, current)
            _reject_unsafe_node(current, root_device)
        finally:
            os.close(file_fd)
    finally:
        os.close(parent_fd)
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        _fail("UTF8_REQUIRED")
    return {"text": text, "bytes": len(payload)}


def _write(root_fd: int, root_device: int, request: dict[str, Any]) -> dict[str, Any]:
    parts = _path_parts(request.get("path"), allow_root=False)
    expected = _expected_path_components(request, parts, {len(parts) - 1, len(parts)})
    text = request.get("text")
    if not isinstance(text, str):
        _fail("INVALID_REQUEST")
    payload = text.encode("utf-8")
    maximum = _bounded_int(request, "maxBytes", MAX_WRITE_BYTES, MAX_WRITE_BYTES)
    if len(payload) > maximum:
        _fail("LIMIT_EXCEEDED")
    parent_fd = _walk_directories(
        root_fd,
        parts[:-1],
        root_device,
        None if expected is None else expected[: len(parts) - 1],
    )
    temporary = f".aisy-write-{uuid4().hex}.tmp"
    temporary_created = False
    try:
        try:
            existing = _lstat(parent_fd, parts[-1])
        except ConfinementFailure as error:
            if error.code != "NOT_FOUND":
                raise
            if expected is not None and len(expected) == len(parts):
                _fail("PATH_CHANGED")
        else:
            if expected is not None and len(expected) != len(parts):
                _fail("PATH_CHANGED")
            _verify_expected_identity(existing, None if expected is None else expected[-1])
            _reject_unsafe_node(existing, root_device)
            if not stat.S_ISREG(existing.st_mode):
                _fail("NOT_REGULAR")
        try:
            output_fd = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
                dir_fd=parent_fd,
            )
            temporary_created = True
        except OSError as error:
            _map_os_error(error)
        try:
            offset = 0
            while offset < len(payload):
                written = os.write(output_fd, payload[offset:])
                if written <= 0:
                    _fail("IO_FAILED")
                offset += written
            os.fsync(output_fd)
        except OSError as error:
            _map_os_error(error)
        finally:
            os.close(output_fd)
        try:
            os.rename(temporary, parts[-1], src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            temporary_created = False
            os.fsync(parent_fd)
        except OSError as error:
            _map_os_error(error)
    finally:
        if temporary_created:
            try:
                os.unlink(temporary, dir_fd=parent_fd)
            except OSError:
                pass
        os.close(parent_fd)
    return {"bytes": len(payload)}


def _edit(root_fd: int, root_device: int, request: dict[str, Any]) -> dict[str, Any]:
    parts = _path_parts(request.get("path"), allow_root=False)
    old_text = request.get("oldText")
    new_text = request.get("newText")
    replace_all = request.get("replaceAll", False)
    if (
        not isinstance(old_text, str)
        or not old_text
        or not isinstance(new_text, str)
        or not isinstance(replace_all, bool)
    ):
        _fail("INVALID_REQUEST")
    if len(old_text.encode("utf-8")) > MAX_WRITE_BYTES:
        _fail("LIMIT_EXCEEDED")
    maximum = _bounded_int(request, "maxBytes", MAX_WRITE_BYTES, MAX_WRITE_BYTES)
    parent_fd = _walk_directories(root_fd, parts[:-1], root_device)
    temporary = f".aisy-edit-{uuid4().hex}.tmp"
    temporary_created = False
    file_fd = -1
    try:
        file_fd, original_info = _open_regular(parent_fd, parts[-1], root_device)
        if original_info.st_size > maximum:
            _fail("LIMIT_EXCEEDED")
        original_payload = _read_all(file_fd, maximum)
        try:
            current_text = original_payload.decode("utf-8")
        except UnicodeDecodeError:
            _fail("UTF8_REQUIRED")

        occurrences = current_text.count(old_text)
        if occurrences == 0:
            _fail("PRECONDITION_FAILED")
        if not replace_all and occurrences != 1:
            _fail("AMBIGUOUS_MATCH")
        updated_text = current_text.replace(old_text, new_text, -1 if replace_all else 1)
        updated_payload = updated_text.encode("utf-8")
        if len(updated_payload) > maximum:
            _fail("LIMIT_EXCEEDED")

        try:
            output_fd = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
                dir_fd=parent_fd,
            )
            temporary_created = True
        except OSError as error:
            _map_os_error(error)
        try:
            offset = 0
            while offset < len(updated_payload):
                written = os.write(output_fd, updated_payload[offset:])
                if written <= 0:
                    _fail("IO_FAILED")
                offset += written
            os.fchmod(output_fd, stat.S_IMODE(original_info.st_mode) & 0o777)
            os.fsync(output_fd)
        except OSError as error:
            _map_os_error(error)
        finally:
            os.close(output_fd)

        # Aisy writers publish by atomic rename. Recheck both the directory entry
        # and the opened file immediately before replacement so a concurrent
        # publication or in-place modification fails instead of losing updates.
        opened_info = os.fstat(file_fd)
        _verify_identity(original_info, opened_info)
        if (
            opened_info.st_size != original_info.st_size
            or opened_info.st_mtime_ns != original_info.st_mtime_ns
            or opened_info.st_ctime_ns != original_info.st_ctime_ns
        ):
            _fail("PATH_CHANGED")
        os.lseek(file_fd, 0, os.SEEK_SET)
        if _read_all(file_fd, maximum) != original_payload:
            _fail("PATH_CHANGED")
        current_info = _lstat(parent_fd, parts[-1])
        _verify_identity(original_info, current_info)
        _reject_unsafe_node(current_info, root_device)

        try:
            os.rename(temporary, parts[-1], src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            temporary_created = False
            os.fsync(parent_fd)
        except OSError as error:
            _map_os_error(error)
    finally:
        if file_fd >= 0:
            os.close(file_fd)
        if temporary_created:
            try:
                os.unlink(temporary, dir_fd=parent_fd)
            except OSError:
                pass
        os.close(parent_fd)
    return {"bytes": len(updated_payload), "replacements": occurrences if replace_all else 1}


def _list(root_fd: int, root_device: int, request: dict[str, Any]) -> dict[str, Any]:
    parts = _path_parts(request.get("path", "."), allow_root=True)
    expected = _expected_path_components(request, parts, {len(parts)})
    maximum = _bounded_int(request, "maxEntries", MAX_SCAN_ENTRIES, MAX_SCAN_ENTRIES)
    directory_fd = _walk_directories(root_fd, parts, root_device, expected)
    try:
        try:
            entries = sorted(os.listdir(directory_fd))
        except OSError as error:
            _map_os_error(error)
    finally:
        os.close(directory_fd)
    if len(entries) > maximum:
        _fail("LIMIT_EXCEEDED")
    for entry in entries:
        _safe_entry_name(entry)
    return {"entries": entries}


def _scan_directory(
    directory_fd: int,
    root_device: int,
    depth: int,
    limits: tuple[int, int, int, int],
    state: ScanState,
) -> None:
    max_entries, max_depth, max_file_bytes, max_total_bytes = limits
    if depth > max_depth:
        _fail("LIMIT_EXCEEDED")
    try:
        names = sorted(os.listdir(directory_fd))
    except OSError as error:
        _map_os_error(error)
    for name in names:
        _safe_entry_name(name)
        state.entries += 1
        if state.entries > max_entries:
            _fail("LIMIT_EXCEEDED")
        info = _lstat(directory_fd, name)
        _reject_unsafe_node(info, root_device)
        if stat.S_ISDIR(info.st_mode):
            child_fd = _open_directory(directory_fd, name, root_device)
            state.directories += 1
            try:
                _scan_directory(child_fd, root_device, depth + 1, limits, state)
            finally:
                os.close(child_fd)
            continue
        file_fd, opened_info = _open_regular(directory_fd, name, root_device)
        os.close(file_fd)
        if opened_info.st_size > max_file_bytes:
            _fail("LIMIT_EXCEEDED")
        state.files += 1
        state.total_bytes += opened_info.st_size
        if state.total_bytes > max_total_bytes:
            _fail("LIMIT_EXCEEDED")


def _scan(root_fd: int, root_device: int, request: dict[str, Any]) -> dict[str, Any]:
    parts = _path_parts(request.get("path", "."), allow_root=True)
    limits = (
        _bounded_int(request, "maxEntries", MAX_SCAN_ENTRIES, MAX_SCAN_ENTRIES),
        _bounded_int(request, "maxDepth", MAX_SCAN_DEPTH, MAX_SCAN_DEPTH),
        _bounded_int(request, "maxFileBytes", MAX_SCAN_FILE_BYTES, MAX_SCAN_FILE_BYTES),
        _bounded_int(request, "maxTotalBytes", MAX_SCAN_TOTAL_BYTES, MAX_SCAN_TOTAL_BYTES),
    )
    directory_fd = _walk_directories(root_fd, parts, root_device)
    state = ScanState()
    try:
        _scan_directory(directory_fd, root_device, 0, limits, state)
    finally:
        os.close(directory_fd)
    return {
        "entries": state.entries,
        "files": state.files,
        "directories": state.directories,
        "totalBytes": state.total_bytes,
    }


def handle_request(raw_request: Any) -> dict[str, Any]:
    request = _as_object(raw_request)
    request_id = _required_string(request, "requestId")
    if request.get("version") != PROTOCOL_VERSION:
        _fail("INVALID_REQUEST")
    root = _required_string(request, "root", max_bytes=MAX_PATH_BYTES)
    operation = _required_string(request, "op", max_bytes=32)
    handlers = {"read": _read, "write": _write, "edit": _edit, "list": _list, "scan": _scan}
    handler = handlers.get(operation)
    if handler is None:
        _fail("INVALID_REQUEST")
    has_expected_device = "expectedRootDevice" in request
    has_expected_inode = "expectedRootInode" in request
    if has_expected_device != has_expected_inode:
        _fail("INVALID_REQUEST")
    if "expectedPathComponents" in request and not has_expected_device:
        _fail("INVALID_REQUEST")
    expected_device = _required_decimal(request, "expectedRootDevice") if has_expected_device else None
    expected_inode = _required_decimal(request, "expectedRootInode") if has_expected_inode else None
    _require_platform()
    root_fd, root_device = _open_root(root, expected_device, expected_inode)
    try:
        root_info = os.fstat(root_fd)
        data = handler(root_fd, root_device, request)
        try:
            current_root = os.stat(root, follow_symlinks=False)
        except OSError:
            _fail("PATH_CHANGED")
        if stat.S_ISLNK(current_root.st_mode):
            _fail("SYMLINK_DENIED")
        if not stat.S_ISDIR(current_root.st_mode):
            _fail("PATH_CHANGED")
        _verify_identity(root_info, current_root)
    finally:
        os.close(root_fd)
    return {"version": PROTOCOL_VERSION, "requestId": request_id, "ok": True, "data": data}


def _json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("INVALID_REQUEST")
        result[key] = value
    return result


def _json_constant(_value: str) -> NoReturn:
    _fail("INVALID_REQUEST")


def _response_for(payload: bytes) -> tuple[dict[str, Any], int]:
    request_id = "unknown"
    try:
        if len(payload) > MAX_REQUEST_BYTES:
            _fail("LIMIT_EXCEEDED")
        decoded = json.loads(
            payload,
            object_pairs_hook=_json_object,
            parse_constant=_json_constant,
        )
        if isinstance(decoded, dict) and isinstance(decoded.get("requestId"), str):
            candidate = decoded["requestId"]
            if candidate and len(candidate.encode("utf-8")) <= 1024 and "\x00" not in candidate:
                request_id = candidate
        response = handle_request(decoded)
        return response, 0
    except (json.JSONDecodeError, UnicodeDecodeError):
        code = "INVALID_REQUEST"
    except ConfinementFailure as error:
        code = error.code
    # Protocol boundary: never expose an unexpected traceback or local path.
    except Exception:  # noqa: BLE001
        code = "INTERNAL_ERROR"
    return {
        "version": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": False,
        "error": {"code": code},
    }, 2


def main() -> int:
    response, exit_code = _response_for(sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1))
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
