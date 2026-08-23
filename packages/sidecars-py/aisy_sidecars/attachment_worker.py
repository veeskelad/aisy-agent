"""Descriptor-relative binary attachment import worker.

The protocol carries paths and expected digests only. Attachment bytes never
cross stdout: the worker opens both roots without following symlinks, streams
the source into a code-owned temporary file, and publishes with a no-overwrite
hard-link boundary.
"""

from __future__ import annotations

import errno
import hashlib
import importlib.util
import json
import os
import re
import stat
import sys
from pathlib import Path
from types import ModuleType
from typing import Any, NoReturn


def _load_confinement_worker() -> ModuleType:
    if __package__:
        from . import confinement_worker

        return confinement_worker
    path = Path(__file__).with_name("confinement_worker.py")
    spec = importlib.util.spec_from_file_location("aisy_attachment_confinement", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("confinement worker unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


confinement = _load_confinement_worker()

PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_RECORD_BYTES = 1024 * 1024
MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024
COPY_CHUNK_BYTES = 1024 * 1024
HASH = re.compile(r"^[a-f0-9]{64}$")


class AttachmentFailure(Exception):
    """A deliberately redacted attachment protocol failure."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _fail(code: str) -> NoReturn:
    raise AttachmentFailure(code)


def _map_confinement_failure(error: confinement.ConfinementFailure) -> NoReturn:
    raise AttachmentFailure(error.code) from error


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        _fail("INVALID_REQUEST")
    return value


def _exact_keys(value: dict[str, Any], expected: set[str]) -> None:
    if set(value) != expected:
        _fail("INVALID_REQUEST")


def _required_string(value: dict[str, Any], key: str, maximum: int) -> str:
    candidate = value.get(key)
    if (
        not isinstance(candidate, str)
        or not candidate
        or "\x00" in candidate
        or len(candidate.encode("utf-8")) > maximum
    ):
        _fail("INVALID_REQUEST")
    return candidate


def _bounded_int(value: dict[str, Any], key: str, maximum: int) -> int:
    candidate = value.get(key)
    if isinstance(candidate, bool) or not isinstance(candidate, int) or candidate < 0:
        _fail("INVALID_REQUEST")
    if candidate > maximum:
        _fail("LIMIT_EXCEEDED")
    return candidate


def _expected(value: dict[str, Any]) -> tuple[str, int, int]:
    digest = _required_string(value, "expectedSha256", 64)
    if HASH.fullmatch(digest) is None:
        _fail("INVALID_REQUEST")
    size = _bounded_int(value, "expectedSizeBytes", MAX_ATTACHMENT_BYTES)
    maximum = _bounded_int(value, "maxBytes", MAX_ATTACHMENT_BYTES)
    if size > maximum:
        _fail("LIMIT_EXCEEDED")
    return digest, size, maximum


def _open_root(value: dict[str, Any], key: str) -> tuple[int, int]:
    root = _required_string(value, key, confinement.MAX_PATH_BYTES)
    try:
        return confinement._open_root(root)
    except confinement.ConfinementFailure as error:
        _map_confinement_failure(error)


def _path(value: dict[str, Any], key: str) -> tuple[str, ...]:
    try:
        return confinement._path_parts(value.get(key), allow_root=False)
    except confinement.ConfinementFailure as error:
        _map_confinement_failure(error)


def _open_regular(parent_fd: int, name: str, root_device: int) -> tuple[int, os.stat_result]:
    try:
        return confinement._open_regular(parent_fd, name, root_device)
    except confinement.ConfinementFailure as error:
        _map_confinement_failure(error)


def _walk(root_fd: int, parts: tuple[str, ...], root_device: int) -> int:
    try:
        return confinement._walk_directories(root_fd, parts, root_device)
    except confinement.ConfinementFailure as error:
        _map_confinement_failure(error)


def _walk_or_create(root_fd: int, parts: tuple[str, ...], root_device: int) -> int:
    current = os.dup(root_fd)
    try:
        for part in parts:
            try:
                following = confinement._open_directory(current, part, root_device)
            except confinement.ConfinementFailure as error:
                if error.code != "NOT_FOUND":
                    _map_confinement_failure(error)
                try:
                    os.mkdir(part, 0o700, dir_fd=current)
                    os.fsync(current)
                except OSError as mkdir_error:
                    if mkdir_error.errno != errno.EEXIST:
                        try:
                            confinement._map_os_error(mkdir_error)
                        except confinement.ConfinementFailure as mapped:
                            _map_confinement_failure(mapped)
                try:
                    following = confinement._open_directory(current, part, root_device)
                except confinement.ConfinementFailure as retry_error:
                    _map_confinement_failure(retry_error)
            os.close(current)
            current = following
        return current
    except BaseException:
        os.close(current)
        raise


def _digest_fd(descriptor: int, maximum: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    while True:
        try:
            chunk = os.read(descriptor, min(COPY_CHUNK_BYTES, maximum + 1 - size))
        except OSError as error:
            try:
                confinement._map_os_error(error)
            except confinement.ConfinementFailure as mapped:
                _map_confinement_failure(mapped)
        if not chunk:
            return digest.hexdigest(), size
        size += len(chunk)
        if size > maximum:
            _fail("LIMIT_EXCEEDED")
        digest.update(chunk)


def _digest_path(
    root_fd: int,
    root_device: int,
    parts: tuple[str, ...],
    maximum: int,
) -> tuple[str, int]:
    parent_fd = _walk(root_fd, parts[:-1], root_device)
    try:
        descriptor, info = _open_regular(parent_fd, parts[-1], root_device)
        try:
            if info.st_size > maximum:
                _fail("LIMIT_EXCEEDED")
            return _digest_fd(descriptor, maximum)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_fd)


def _matches(
    parent_fd: int,
    name: str,
    root_device: int,
    expected_hash: str,
    expected_size: int,
    maximum: int,
) -> bool:
    descriptor, info = _open_regular(parent_fd, name, root_device)
    try:
        if info.st_size != expected_size or info.st_size > maximum:
            return False
        actual_hash, actual_size = _digest_fd(descriptor, maximum)
        return actual_hash == expected_hash and actual_size == expected_size
    finally:
        os.close(descriptor)


def _lstat_optional(parent_fd: int, name: str) -> os.stat_result | None:
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    except OSError as error:
        try:
            confinement._map_os_error(error)
        except confinement.ConfinementFailure as mapped:
            _map_confinement_failure(mapped)


def _reject_node(info: os.stat_result, root_device: int, *, links: int = 1) -> None:
    if stat.S_ISLNK(info.st_mode):
        _fail("SYMLINK_DENIED")
    if info.st_dev != root_device:
        _fail("CROSS_DEVICE_DENIED")
    if not stat.S_ISREG(info.st_mode):
        _fail("SPECIAL_FILE_DENIED")
    if info.st_nlink != links:
        _fail("HARDLINK_DENIED")


def _cleanup_owned_link(
    parent_fd: int,
    final_name: str,
    temporary: str,
    root_device: int,
) -> None:
    final = _lstat_optional(parent_fd, final_name)
    temp = _lstat_optional(parent_fd, temporary)
    if final is None or temp is None or final.st_nlink != 2 or temp.st_nlink != 2:
        return
    _reject_node(final, root_device, links=2)
    _reject_node(temp, root_device, links=2)
    if final.st_dev != temp.st_dev or final.st_ino != temp.st_ino:
        _fail("HARDLINK_DENIED")
    try:
        os.unlink(temporary, dir_fd=parent_fd)
        os.fsync(parent_fd)
    except OSError as error:
        try:
            confinement._map_os_error(error)
        except confinement.ConfinementFailure as mapped:
            _map_confinement_failure(mapped)


def _copy_source(
    source_fd: int,
    output_fd: int,
    expected_hash: str,
    expected_size: int,
    maximum: int,
) -> None:
    digest = hashlib.sha256()
    size = 0
    while True:
        try:
            chunk = os.read(source_fd, min(COPY_CHUNK_BYTES, maximum + 1 - size))
        except OSError as error:
            try:
                confinement._map_os_error(error)
            except confinement.ConfinementFailure as mapped:
                _map_confinement_failure(mapped)
        if not chunk:
            break
        size += len(chunk)
        if size > maximum:
            _fail("LIMIT_EXCEEDED")
        digest.update(chunk)
        offset = 0
        while offset < len(chunk):
            try:
                written = os.write(output_fd, chunk[offset:])
            except OSError as error:
                try:
                    confinement._map_os_error(error)
                except confinement.ConfinementFailure as mapped:
                    _map_confinement_failure(mapped)
            if written <= 0:
                _fail("IO_FAILED")
            offset += written
    if size != expected_size or digest.hexdigest() != expected_hash:
        _fail("HASH_MISMATCH")
    try:
        os.fsync(output_fd)
    except OSError as error:
        try:
            confinement._map_os_error(error)
        except confinement.ConfinementFailure as mapped:
            _map_confinement_failure(mapped)


def _copy_exact(request: dict[str, Any], *, install: bool) -> dict[str, Any]:
    source_parts = _path(request, "sourcePath")
    destination_parts = _path(request, "destinationPath")
    operation_id = _required_string(request, "operationId", 64)
    if HASH.fullmatch(operation_id) is None:
        _fail("INVALID_REQUEST")
    expected_hash, expected_size, maximum = _expected(request)
    source_root_fd, source_device = _open_root(request, "sourceRoot")
    destination_root_fd, destination_device = _open_root(request, "destinationRoot")
    temporary = f".aisy-import-{operation_id}.tmp"
    destination_parent_fd = -1
    source_parent_fd = -1
    source_file_fd = -1
    try:
        source_parent_fd = _walk(source_root_fd, source_parts[:-1], source_device)
        source_file_fd, source_info = _open_regular(
            source_parent_fd,
            source_parts[-1],
            source_device,
        )
        if source_info.st_size != expected_size or source_info.st_size > maximum:
            _fail("HASH_MISMATCH")
        destination_parent_fd = _walk_or_create(
            destination_root_fd,
            destination_parts[:-1],
            destination_device,
        )

        _cleanup_owned_link(
            destination_parent_fd,
            destination_parts[-1],
            temporary,
            destination_device,
        )
        existing = _lstat_optional(destination_parent_fd, destination_parts[-1])
        if existing is not None:
            _reject_node(existing, destination_device)
            if _matches(
                destination_parent_fd,
                destination_parts[-1],
                destination_device,
                expected_hash,
                expected_size,
                maximum,
            ):
                return {"status": "already-installed" if install else "already-staged"}
            return {"status": "collision" if install else "state-conflict"}

        temp = _lstat_optional(destination_parent_fd, temporary)
        if temp is not None:
            _reject_node(temp, destination_device)
            if not _matches(
                destination_parent_fd,
                temporary,
                destination_device,
                expected_hash,
                expected_size,
                maximum,
            ):
                try:
                    os.unlink(temporary, dir_fd=destination_parent_fd)
                    os.fsync(destination_parent_fd)
                except OSError as error:
                    try:
                        confinement._map_os_error(error)
                    except confinement.ConfinementFailure as mapped:
                        _map_confinement_failure(mapped)
                temp = None
        if temp is None:
            try:
                output_fd = os.open(
                    temporary,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                    0o600,
                    dir_fd=destination_parent_fd,
                )
            except OSError as error:
                try:
                    confinement._map_os_error(error)
                except confinement.ConfinementFailure as mapped:
                    _map_confinement_failure(mapped)
            try:
                _copy_source(source_file_fd, output_fd, expected_hash, expected_size, maximum)
            finally:
                os.close(output_fd)

        try:
            os.link(
                temporary,
                destination_parts[-1],
                src_dir_fd=destination_parent_fd,
                dst_dir_fd=destination_parent_fd,
                follow_symlinks=False,
            )
            os.fsync(destination_parent_fd)
        except FileExistsError:
            pass
        except OSError as error:
            try:
                confinement._map_os_error(error)
            except confinement.ConfinementFailure as mapped:
                _map_confinement_failure(mapped)

        _cleanup_owned_link(
            destination_parent_fd,
            destination_parts[-1],
            temporary,
            destination_device,
        )
        if not _matches(
            destination_parent_fd,
            destination_parts[-1],
            destination_device,
            expected_hash,
            expected_size,
            maximum,
        ):
            return {"status": "collision" if install else "state-conflict"}
        return {"status": "installed" if install else "staged"}
    finally:
        if source_file_fd >= 0:
            os.close(source_file_fd)
        if source_parent_fd >= 0:
            os.close(source_parent_fd)
        if destination_parent_fd >= 0:
            os.close(destination_parent_fd)
        os.close(source_root_fd)
        os.close(destination_root_fd)


def _read_record(request: dict[str, Any]) -> dict[str, Any]:
    parts = _path(request, "path")
    maximum = _bounded_int(request, "maxBytes", MAX_RECORD_BYTES)
    root_fd, root_device = _open_root(request, "root")
    try:
        parent_fd = _walk(root_fd, parts[:-1], root_device)
        try:
            descriptor, info = _open_regular(parent_fd, parts[-1], root_device)
            try:
                if info.st_size > maximum:
                    _fail("LIMIT_EXCEEDED")
                try:
                    payload = confinement._read_all(descriptor, maximum)
                except confinement.ConfinementFailure as error:
                    _map_confinement_failure(error)
            finally:
                os.close(descriptor)
        finally:
            os.close(parent_fd)
    finally:
        os.close(root_fd)
    try:
        record = json.loads(
            payload,
            object_pairs_hook=confinement._json_object,
            parse_constant=confinement._json_constant,
        )
    except (json.JSONDecodeError, UnicodeDecodeError):
        _fail("INVALID_RECORD")
    if not isinstance(record, dict):
        _fail("INVALID_RECORD")
    return {"record": record}


def _verify(request: dict[str, Any]) -> dict[str, Any]:
    parts = _path(request, "path")
    maximum = _bounded_int(request, "maxBytes", MAX_ATTACHMENT_BYTES)
    root_fd, root_device = _open_root(request, "root")
    try:
        try:
            digest, size = _digest_path(root_fd, root_device, parts, maximum)
        except AttachmentFailure as error:
            if error.code == "NOT_FOUND":
                return {"exists": False}
            raise
    finally:
        os.close(root_fd)
    return {"exists": True, "sha256": digest, "sizeBytes": size}


def handle_request(raw_request: Any) -> dict[str, Any]:
    request = _object(raw_request)
    request_id = _required_string(request, "requestId", 1024)
    if request.get("version") != PROTOCOL_VERSION:
        _fail("INVALID_REQUEST")
    operation = _required_string(request, "op", 32)
    if operation == "read-record":
        _exact_keys(request, {"version", "requestId", "op", "root", "path", "maxBytes"})
        data = _read_record(request)
    elif operation == "verify":
        _exact_keys(request, {"version", "requestId", "op", "root", "path", "maxBytes"})
        data = _verify(request)
    elif operation in ("stage", "install"):
        _exact_keys(request, {
            "version", "requestId", "op", "sourceRoot", "sourcePath",
            "destinationRoot", "destinationPath", "operationId",
            "expectedSha256", "expectedSizeBytes", "maxBytes",
        })
        data = _copy_exact(request, install=operation == "install")
    else:
        _fail("INVALID_REQUEST")
    return {"version": PROTOCOL_VERSION, "requestId": request_id, "ok": True, "data": data}


def _response_for(payload: bytes) -> tuple[dict[str, Any], int]:
    request_id = "unknown"
    try:
        if len(payload) > MAX_REQUEST_BYTES:
            _fail("LIMIT_EXCEEDED")
        decoded = json.loads(
            payload,
            object_pairs_hook=confinement._json_object,
            parse_constant=confinement._json_constant,
        )
        if isinstance(decoded, dict) and isinstance(decoded.get("requestId"), str):
            candidate = decoded["requestId"]
            if candidate and len(candidate.encode("utf-8")) <= 1024 and "\x00" not in candidate:
                request_id = candidate
        response = handle_request(decoded)
        if len(json.dumps(response, ensure_ascii=False).encode("utf-8")) > MAX_RESPONSE_BYTES:
            _fail("LIMIT_EXCEEDED")
        return response, 0
    except (json.JSONDecodeError, UnicodeDecodeError):
        code = "INVALID_REQUEST"
    except confinement.ConfinementFailure as error:
        code = error.code
    except AttachmentFailure as error:
        code = error.code
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
