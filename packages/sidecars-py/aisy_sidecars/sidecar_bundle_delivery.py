"""Root-owned one-shot inbox for Aisy sidecar bundles delivered over SSH."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import secrets
import shlex
import stat
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO

SCHEMA_VERSION = 1
MAX_RECEIPT_BYTES = 256 * 1024
MAX_MEMBER_BYTES = 8 * 1024 * 1024
MAX_BUNDLE_BYTES = 32 * 1024 * 1024
MAX_FILES = 128
MAX_OPEN_DEPLOYMENTS = 8
MAX_REPLAY_TOMBSTONES = 256
STALE_OPEN_SECONDS = 24 * 60 * 60
STALE_CLAIMED_SECONDS = 60 * 60
INBOX_ROOT = Path("/usr/lib/aisy/incoming")
LEDGER_ROOT = Path("/var/lib/aisy/delivery")

_DEPLOYMENT = re.compile(r"^[a-f0-9]{32}$")
_HASH = re.compile(r"^[a-f0-9]{64}$")
_COMMIT = re.compile(r"^[a-f0-9]{40}(?:[a-f0-9]{24})?$")
_RELEASE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
_MEMBER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.@_/-]{0,199}$")
_COMPONENTS = frozenset({"provider", "voice"})
_MODES = frozenset({0o644, 0o755})
_LEDGER_TEMP = re.compile(r"^\.([a-f0-9]{32})\.json\.tmp-([1-9][0-9]{0,9})$")
_PROCESS_IDENTITY = re.compile(r"^[A-Za-z0-9:._-]{1,128}$")


class BundleDeliveryFailure(Exception):
    """Stable redacted refusal for privileged bundle delivery."""


@dataclass(frozen=True)
class ReceiptFile:
    path: str
    sha256: str
    size: int
    mode: int


@dataclass(frozen=True)
class ReleaseReceipt:
    component: str
    commit: str
    release: str
    manifest_sha256: str
    files: tuple[ReceiptFile, ...]
    digest: str


@dataclass(frozen=True)
class SealedDelivery:
    deployment_id: str
    receipt: ReleaseReceipt
    bundle: Path


def _deployment_id(value: str) -> str:
    if not isinstance(value, str) or _DEPLOYMENT.fullmatch(value) is None:
        raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
    return value


def _object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
        result[key] = value
    return result


def _canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _member(value: object) -> str:
    if not isinstance(value, str) or _MEMBER.fullmatch(value) is None:
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    pure = PurePosixPath(value)
    if pure.is_absolute() or "." in pure.parts or ".." in pure.parts:
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    return value


def parse_receipt(raw: bytes) -> ReleaseReceipt:
    if not 1 <= len(raw) <= MAX_RECEIPT_BYTES:
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    try:
        value = json.loads(raw, object_pairs_hook=_object)
    except (UnicodeDecodeError, json.JSONDecodeError, BundleDeliveryFailure):
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED") from None
    if (
        not isinstance(value, dict)
        or set(value) != {
            "schemaVersion", "component", "commit", "release",
            "manifestSha256", "files",
        }
        or _canonical(value) != raw
        or value["schemaVersion"] != SCHEMA_VERSION
        or not isinstance(value["component"], str)
        or value["component"] not in _COMPONENTS
        or not isinstance(value["commit"], str)
        or _COMMIT.fullmatch(value["commit"]) is None
        or not isinstance(value["release"], str)
        or _RELEASE.fullmatch(value["release"]) is None
        or not isinstance(value["manifestSha256"], str)
        or _HASH.fullmatch(value["manifestSha256"]) is None
        or not isinstance(value["files"], list)
        or not 2 <= len(value["files"]) <= MAX_FILES
    ):
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    files: list[ReceiptFile] = []
    previous = ""
    total_size = 0
    for entry in value["files"]:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "size", "mode"}:
            raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
        path = _member(entry["path"])
        if (
            path <= previous
            or not isinstance(entry["sha256"], str)
            or _HASH.fullmatch(entry["sha256"]) is None
            or isinstance(entry["size"], bool)
            or not isinstance(entry["size"], int)
            or not 1 <= entry["size"] <= MAX_MEMBER_BYTES
            or isinstance(entry["mode"], bool)
            or entry["mode"] not in _MODES
        ):
            raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
        previous = path
        total_size += entry["size"]
        if total_size > MAX_BUNDLE_BYTES:
            raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
        files.append(ReceiptFile(path, entry["sha256"], entry["size"], entry["mode"]))
    if "manifest.json" not in {item.path for item in files}:
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    digest = hashlib.sha256(raw).hexdigest()
    return ReleaseReceipt(
        value["component"], value["commit"], value["release"],
        value["manifestSha256"], tuple(files), digest,
    )


def build_receipt(bundle: Path, component: str) -> bytes:
    if component not in _COMPONENTS:
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    try:
        manifest_raw = (bundle / "manifest.json").read_bytes()
        manifest = json.loads(manifest_raw, object_pairs_hook=_object)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, BundleDeliveryFailure):
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED") from None
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"schemaVersion", "protocolVersion", "release", "commit", "files"}
        or _canonical(manifest) != manifest_raw
        or manifest.get("schemaVersion") != 1
        or manifest.get("protocolVersion") != 1
        or not isinstance(manifest.get("release"), str)
        or not isinstance(manifest.get("commit"), str)
        or not isinstance(manifest.get("files"), list)
    ):
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    inventory: list[dict[str, object]] = []
    paths = ["manifest.json"]
    manifest_entries: dict[str, tuple[str, int, int]] = {}
    for entry in manifest["files"]:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "size", "mode"}:
            raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
        relative = _member(entry["path"])
        if (
            not isinstance(entry["sha256"], str)
            or _HASH.fullmatch(entry["sha256"]) is None
            or isinstance(entry["size"], bool)
            or not isinstance(entry["size"], int)
            or not 1 <= entry["size"] <= MAX_MEMBER_BYTES
            or isinstance(entry["mode"], bool)
            or entry["mode"] not in _MODES
        ):
            raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
        paths.append(relative)
        manifest_entries[relative] = (entry["sha256"], entry["size"], entry["mode"])
    if paths[1:] != sorted(paths[1:]) or len(paths) != len(set(paths)):
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    for relative in sorted(paths):
        path = bundle / relative
        try:
            info = path.lstat()
            raw = path.read_bytes()
        except OSError:
            raise BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED") from None
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_nlink != 1
            or not 1 <= len(raw) <= MAX_MEMBER_BYTES
            or stat.S_IMODE(info.st_mode) not in _MODES
        ):
            raise BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED")
        inventory.append({
            "path": relative,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "size": len(raw),
            "mode": stat.S_IMODE(info.st_mode),
        })
        if relative != "manifest.json" and manifest_entries.get(relative) != (
            inventory[-1]["sha256"], inventory[-1]["size"], inventory[-1]["mode"],
        ):
            raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    raw = _canonical({
        "schemaVersion": 1,
        "component": component,
        "commit": manifest["commit"],
        "release": manifest["release"],
        "manifestSha256": hashlib.sha256(manifest_raw).hexdigest(),
        "files": inventory,
    })
    parse_receipt(raw)
    return raw


def _safe_root(path: Path, expected_uid: int) -> None:
    current = path
    while True:
        try:
            info = current.lstat()
            if (
                not current.is_absolute()
                or current.resolve(strict=True) != current.absolute()
                or not stat.S_ISDIR(info.st_mode)
                or stat.S_ISLNK(info.st_mode)
                or info.st_uid not in {0, expected_uid}
                or info.st_mode & 0o022
                or (current == path and info.st_uid != expected_uid)
            ):
                raise OSError
        except OSError:
            raise BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED") from None
        parent = current.parent
        if parent == current:
            return
        current = parent


def _write_exclusive(path: Path, raw: bytes, mode: int) -> None:
    descriptor = -1
    created = False
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            mode,
        )
        created = True
        os.fchmod(descriptor, mode)
        offset = 0
        while offset < len(raw):
            written = os.write(descriptor, raw[offset:])
            if written <= 0:
                raise OSError
            offset += written
        os.fsync(descriptor)
    except OSError:
        if descriptor >= 0:
            os.close(descriptor)
            descriptor = -1
        if created:
            try:
                path.unlink()
                _fsync_directory(path.parent)
            except OSError:
                pass
        raise BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED") from None
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    _fsync_directory(path.parent)


def _replace(path: Path, raw: bytes, mode: int) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        _write_exclusive(temporary, raw, mode)
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _quota_lock(ledger_root: Path, expected_uid: int) -> int:
    path = ledger_root / "quota.lock"
    descriptor = -1
    try:
        descriptor = os.open(
            path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600,
        )
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != expected_uid
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
        ):
            raise OSError
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        return descriptor
    except OSError:
        if descriptor >= 0:
            os.close(descriptor)
        raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED") from None


def _ledger_state(path: Path, expected_uid: int) -> tuple[str, str, str, int]:
    raw = _read_exact_file(path, expected_uid, 2048, 0o600)
    try:
        value = json.loads(raw, object_pairs_hook=_object)
        info = path.stat()
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, BundleDeliveryFailure):
        raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED") from None
    deployment_id = path.name.removesuffix(".json")
    if (
        not isinstance(value, dict)
        or set(value) != {
            "schemaVersion", "deploymentId", "expectedReceiptSha256", "phase",
        }
        or _canonical(value) != raw
        or value["schemaVersion"] != 1
        or value["deploymentId"] != deployment_id
        or _DEPLOYMENT.fullmatch(deployment_id) is None
        or not isinstance(value["expectedReceiptSha256"], str)
        or _HASH.fullmatch(value["expectedReceiptSha256"]) is None
        or value["phase"] not in {"receiving", "sealed", "claimed", "completing", "completed"}
    ):
        raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
    return deployment_id, value["expectedReceiptSha256"], value["phase"], info.st_mtime_ns


def _process_identity(pid: int) -> str | None:
    if isinstance(pid, bool) or not isinstance(pid, int) or not 1 <= pid <= 2**31 - 1:
        return None
    if sys.platform != "linux":
        try:
            os.kill(pid, 0)
            return f"nonlinux:{pid}"
        except (OSError, ValueError):
            return None
    try:
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        process_stat = Path(f"/proc/{pid}/stat").read_text()
        command_end = process_stat.rfind(")")
        fields = process_stat[command_end + 2:].split()
        start_time = fields[19]
        identity = f"{boot_id}:{pid}:{start_time}"
        if (
            command_end < 2
            or not re.fullmatch(r"[a-f0-9-]{36}", boot_id)
            or not start_time.isdigit()
            or _PROCESS_IDENTITY.fullmatch(identity) is None
        ):
            return None
        return identity
    except (OSError, IndexError):
        return None


def _remove_inbox(inbox: Path, expected_uid: int) -> None:
    _safe_root(inbox, expected_uid)
    root = inbox.lstat()
    try:
        entries = sorted(inbox.rglob("*"), key=lambda path: len(path.parts), reverse=True)
        for path in entries:
            info = path.lstat()
            if info.st_uid != expected_uid or info.st_dev != root.st_dev or stat.S_ISLNK(info.st_mode):
                raise OSError
            if stat.S_ISDIR(info.st_mode):
                path.rmdir()
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                path.unlink()
            else:
                raise OSError
        inbox.rmdir()
        _fsync_directory(inbox.parent)
    except OSError:
        raise BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED") from None


def _prune_delivery_state(
    inbox_root: Path,
    ledger_root: Path,
    expected_uid: int,
    *,
    now_ns: int | None = None,
) -> None:
    now = time.time_ns() if now_ns is None else now_ns
    ledgers: list[tuple[str, str, str, int, Path]] = []
    for path in ledger_root.iterdir():
        if path.name == "quota.lock":
            continue
        temporary = _LEDGER_TEMP.fullmatch(path.name)
        if temporary is not None:
            try:
                info = path.lstat()
                if (
                    not stat.S_ISREG(info.st_mode)
                    or stat.S_ISLNK(info.st_mode)
                    or info.st_uid != expected_uid
                    or stat.S_IMODE(info.st_mode) != 0o600
                    or info.st_nlink != 1
                    or info.st_size > 2048
                ):
                    raise OSError
                # The caller holds quota.lock. No live ledger transition can
                # own this exact temporary once that lock has been acquired.
                path.unlink()
                _fsync_directory(ledger_root)
                continue
            except BundleDeliveryFailure:
                raise
            except OSError:
                raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED") from None
        if not path.name.endswith(".json"):
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        deployment_id, digest, phase, modified = _ledger_state(path, expected_uid)
        ledgers.append((deployment_id, digest, phase, modified, path))

    inboxes: dict[str, Path] = {}
    for path in inbox_root.iterdir():
        if _DEPLOYMENT.fullmatch(path.name) is None:
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        _safe_root(path, expected_uid)
        inboxes[path.name] = path

    stale_open_ns = STALE_OPEN_SECONDS * 1_000_000_000
    stale_claimed_ns = STALE_CLAIMED_SECONDS * 1_000_000_000
    ledger_ids = {
        deployment_id for deployment_id, _digest, _phase, _modified, _path in ledgers
    }
    if not set(inboxes).issubset(ledger_ids):
        raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
    remaining_inboxes = set(inboxes)
    for deployment_id, digest, phase, modified, ledger_path in ledgers:
        inbox = inboxes.get(deployment_id)
        if inbox is None:
            if phase in {"claimed", "completed"}:
                continue
            if phase == "completing":
                _replace(ledger_path, _canonical({
                    "schemaVersion": 1,
                    "deploymentId": deployment_id,
                    "expectedReceiptSha256": digest,
                    "phase": "completed",
                }), 0o600)
                continue
            if phase in {"receiving", "sealed"}:
                ledger_path.unlink()
                _fsync_directory(ledger_root)
                continue
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        age = max(0, now - modified)
        if phase == "completing":
            _remove_inbox(inbox, expected_uid)
            remaining_inboxes.discard(deployment_id)
            _replace(ledger_path, _canonical({
                "schemaVersion": 1,
                "deploymentId": deployment_id,
                "expectedReceiptSha256": digest,
                "phase": "completed",
            }), 0o600)
            continue
        if phase == "completed":
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        if phase in {"receiving", "sealed"} and age >= stale_open_ns:
            _remove_inbox(inbox, expected_uid)
            ledger_path.unlink()
            _fsync_directory(ledger_root)
            remaining_inboxes.discard(deployment_id)
            continue
        if phase == "claimed" and age >= stale_claimed_ns:
            claim_raw = _read_exact_file(inbox / "claim", expected_uid, 2048, 0o600)
            try:
                claim = json.loads(claim_raw, object_pairs_hook=_object)
                pid = claim.get("pid") if isinstance(claim, dict) else None
                process_identity = claim.get("processIdentity") if isinstance(claim, dict) else None
                valid = (
                    isinstance(claim, dict)
                    and set(claim) == {
                        "schemaVersion", "deploymentId", "pid", "processIdentity",
                    }
                    and _canonical(claim) == claim_raw
                    and claim["schemaVersion"] == 1
                    and claim["deploymentId"] == deployment_id
                    and not isinstance(pid, bool)
                    and isinstance(pid, int)
                    and 1 <= pid <= 2**31 - 1
                    and isinstance(process_identity, str)
                    and _PROCESS_IDENTITY.fullmatch(process_identity) is not None
                )
            except (UnicodeDecodeError, json.JSONDecodeError, BundleDeliveryFailure):
                valid = False
                pid = None
                process_identity = None
            if not valid or pid is None or process_identity is None:
                raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
            if _process_identity(pid) != process_identity:
                _remove_inbox(inbox, expected_uid)
                remaining_inboxes.discard(deployment_id)

    completed = sorted(
        (
            (modified, path)
            for deployment_id, _digest, phase, modified, path in ledgers
            if phase in {"claimed", "completing", "completed"}
            and deployment_id not in remaining_inboxes
        ),
        reverse=True,
    )
    for _modified, path in completed[MAX_REPLAY_TOMBSTONES:]:
        path.unlink()
        _fsync_directory(ledger_root)


def _read_exact_file(path: Path, expected_uid: int, maximum: int, mode: int) -> bytes:
    descriptor = -1
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != expected_uid
            or before.st_nlink != 1
            or stat.S_IMODE(before.st_mode) != mode
            or not 1 <= before.st_size <= maximum
        ):
            raise OSError
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(65536, maximum + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > maximum:
                raise OSError
            chunks.append(chunk)
        after = os.fstat(descriptor)
        if (
            total != before.st_size
            or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        ):
            raise OSError
        return b"".join(chunks)
    except OSError:
        raise BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED") from None
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _authority(inbox: Path, expected_uid: int, deployment_id: str) -> dict[str, object]:
    raw = _read_exact_file(inbox / "authority.json", expected_uid, 1024, 0o600)
    try:
        value = json.loads(raw, object_pairs_hook=_object)
    except (UnicodeDecodeError, json.JSONDecodeError, BundleDeliveryFailure):
        raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED") from None
    if (
        not isinstance(value, dict)
        or set(value) != {"schemaVersion", "deploymentId", "expectedReceiptSha256"}
        or _canonical(value) != raw
        or value["schemaVersion"] != 1
        or not isinstance(value["deploymentId"], str)
        or _DEPLOYMENT.fullmatch(value["deploymentId"]) is None
        or not isinstance(value["expectedReceiptSha256"], str)
        or _HASH.fullmatch(value["expectedReceiptSha256"]) is None
        or value["deploymentId"] != deployment_id
    ):
        raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
    return value


def begin_delivery(
    expected_receipt_sha256: str,
    *,
    inbox_root: Path = INBOX_ROOT,
    ledger_root: Path = LEDGER_ROOT,
    expected_uid: int = 0,
    deployment_id_factory: Callable[[], str] = lambda: secrets.token_hex(16),
) -> tuple[str, Path]:
    deployment_id = deployment_id_factory()
    if (
        _DEPLOYMENT.fullmatch(deployment_id) is None
        or _HASH.fullmatch(expected_receipt_sha256) is None
    ):
        raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
    _safe_root(inbox_root, expected_uid)
    _safe_root(ledger_root, expected_uid)
    quota = _quota_lock(ledger_root, expected_uid)
    ledger: Path | None = None
    inbox: Path | None = None
    ledger_created = False
    inbox_created = False
    try:
        _prune_delivery_state(inbox_root, ledger_root, expected_uid)
        open_deployments = list(inbox_root.iterdir())
        if len(open_deployments) >= MAX_OPEN_DEPLOYMENTS:
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        for path in open_deployments:
            if _DEPLOYMENT.fullmatch(path.name) is None:
                raise OSError
            _safe_root(path, expected_uid)
        ledger = ledger_root / f"{deployment_id}.json"
        _write_exclusive(ledger, _canonical({
            "schemaVersion": 1,
            "deploymentId": deployment_id,
            "expectedReceiptSha256": expected_receipt_sha256,
            "phase": "receiving",
        }), 0o600)
        ledger_created = True
        inbox = inbox_root / deployment_id
        inbox.mkdir(mode=0o700)
        inbox_created = True
        (inbox / "bundle").mkdir(mode=0o700)
        _write_exclusive(inbox / "authority.json", _canonical({
            "schemaVersion": 1,
            "deploymentId": deployment_id,
            "expectedReceiptSha256": expected_receipt_sha256,
        }), 0o600)
        _fsync_directory(inbox)
        _fsync_directory(inbox_root)
    except BundleDeliveryFailure:
        if inbox_created and inbox is not None and inbox.exists():
            try:
                _remove_inbox(inbox, expected_uid)
            except BundleDeliveryFailure:
                pass
        if ledger_created and ledger is not None and ledger.exists():
            try:
                ledger.unlink()
                _fsync_directory(ledger_root)
            except OSError:
                pass
        raise
    except OSError:
        if inbox_created and inbox is not None and inbox.exists():
            try:
                _remove_inbox(inbox, expected_uid)
            except BundleDeliveryFailure:
                pass
        if ledger_created and ledger is not None and ledger.exists():
            try:
                ledger.unlink()
                _fsync_directory(ledger_root)
            except OSError:
                pass
        raise BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED") from None
    finally:
        os.close(quota)
    return deployment_id, inbox


def complete_claimed_delivery(
    deployment_id: str,
    *,
    inbox_root: Path = INBOX_ROOT,
    ledger_root: Path = LEDGER_ROOT,
    expected_uid: int = 0,
) -> None:
    deployment_id = _deployment_id(deployment_id)
    _safe_root(inbox_root, expected_uid)
    _safe_root(ledger_root, expected_uid)
    quota = _quota_lock(ledger_root, expected_uid)
    try:
        inbox = inbox_root / deployment_id
        _safe_root(inbox, expected_uid)
        receipt = parse_receipt(_read_exact_file(
            inbox / "receipt.json", expected_uid, MAX_RECEIPT_BYTES, 0o600,
        ))
        ledger = _read_exact_file(
            ledger_root / f"{deployment_id}.json", expected_uid, 2048, 0o600,
        )
        if ledger != _canonical({
            "schemaVersion": 1,
            "deploymentId": deployment_id,
            "expectedReceiptSha256": receipt.digest,
            "phase": "claimed",
        }):
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        _replace(ledger_root / f"{deployment_id}.json", _canonical({
            "schemaVersion": 1,
            "deploymentId": deployment_id,
            "expectedReceiptSha256": receipt.digest,
            "phase": "completing",
        }), 0o600)
        _remove_inbox(inbox, expected_uid)
        _replace(ledger_root / f"{deployment_id}.json", _canonical({
            "schemaVersion": 1,
            "deploymentId": deployment_id,
            "expectedReceiptSha256": receipt.digest,
            "phase": "completed",
        }), 0o600)
        _prune_delivery_state(inbox_root, ledger_root, expected_uid)
    finally:
        os.close(quota)


def store_receipt(
    deployment_id: str,
    stream: BinaryIO,
    *,
    inbox_root: Path = INBOX_ROOT,
    expected_uid: int = 0,
) -> ReleaseReceipt:
    deployment_id = _deployment_id(deployment_id)
    inbox = inbox_root / deployment_id
    _safe_root(inbox, expected_uid)
    authority = _authority(inbox, expected_uid, deployment_id)
    raw = stream.read(MAX_RECEIPT_BYTES + 1)
    if not isinstance(raw, bytes) or len(raw) > MAX_RECEIPT_BYTES:
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    receipt = parse_receipt(raw)
    if receipt.digest != authority["expectedReceiptSha256"]:
        raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
    _write_exclusive(inbox / "receipt.json", raw, 0o600)
    return receipt


def _open_bundle_parent(bundle: Path, member: str, expected_uid: int) -> tuple[int, str]:
    _safe_root(bundle, expected_uid)
    current = os.open(bundle, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        parts = PurePosixPath(member).parts
        for part in parts[:-1]:
            try:
                os.mkdir(part, 0o700, dir_fd=current)
                os.fsync(current)
            except FileExistsError:
                pass
            child = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=current,
            )
            info = os.fstat(child)
            if (
                not stat.S_ISDIR(info.st_mode)
                or info.st_uid != expected_uid
                or info.st_mode & 0o022
            ):
                os.close(child)
                raise OSError
            os.close(current)
            current = child
        return current, parts[-1]
    except OSError:
        os.close(current)
        raise BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED") from None


def store_member(
    deployment_id: str,
    member: str,
    stream: BinaryIO,
    *,
    inbox_root: Path = INBOX_ROOT,
    expected_uid: int = 0,
) -> None:
    deployment_id = _deployment_id(deployment_id)
    member = _member(member)
    inbox = inbox_root / deployment_id
    _safe_root(inbox, expected_uid)
    authority = _authority(inbox, expected_uid, deployment_id)
    receipt_raw = _read_exact_file(inbox / "receipt.json", expected_uid, MAX_RECEIPT_BYTES, 0o600)
    receipt = parse_receipt(receipt_raw)
    if receipt.digest != authority["expectedReceiptSha256"]:
        raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
    entries = {item.path: item for item in receipt.files}
    entry = entries.get(member)
    if entry is None:
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    raw = stream.read(entry.size + 1)
    if not isinstance(raw, bytes) or len(raw) != entry.size or hashlib.sha256(raw).hexdigest() != entry.sha256:
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    parent, name = _open_bundle_parent(inbox / "bundle", member, expected_uid)
    descriptor = -1
    try:
        descriptor = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            entry.mode,
            dir_fd=parent,
        )
        os.fchmod(descriptor, entry.mode)
        offset = 0
        while offset < len(raw):
            written = os.write(descriptor, raw[offset:])
            if written <= 0:
                raise OSError
            offset += written
        os.fsync(descriptor)
        os.fsync(parent)
    except OSError:
        raise BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED") from None
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(parent)


def _inventory(bundle: Path, expected_uid: int) -> tuple[set[str], set[str]]:
    files: set[str] = set()
    directories: set[str] = set()
    try:
        root = bundle.lstat()
        for path in bundle.rglob("*"):
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or info.st_dev != root.st_dev:
                raise OSError
            relative = path.relative_to(bundle).as_posix()
            if stat.S_ISDIR(info.st_mode):
                if info.st_uid != expected_uid or info.st_mode & 0o022:
                    raise OSError
                directories.add(relative)
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise OSError
            files.add(relative)
    except OSError:
        raise BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED") from None
    return files, directories


def _verify_delivery(inbox: Path, expected_uid: int, deployment_id: str) -> ReleaseReceipt:
    _safe_root(inbox, expected_uid)
    _safe_root(inbox / "bundle", expected_uid)
    authority = _authority(inbox, expected_uid, deployment_id)
    receipt_raw = _read_exact_file(inbox / "receipt.json", expected_uid, MAX_RECEIPT_BYTES, 0o600)
    receipt = parse_receipt(receipt_raw)
    if receipt.digest != authority["expectedReceiptSha256"]:
        raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
    expected_files = {item.path for item in receipt.files}
    expected_directories: set[str] = set()
    for member in expected_files:
        parent = PurePosixPath(member).parent
        while parent != PurePosixPath("."):
            expected_directories.add(parent.as_posix())
            parent = parent.parent
    if _inventory(inbox / "bundle", expected_uid) != (expected_files, expected_directories):
        raise BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED")
    for item in receipt.files:
        raw = _read_exact_file(inbox / "bundle" / item.path, expected_uid, item.size, item.mode)
        if len(raw) != item.size or hashlib.sha256(raw).hexdigest() != item.sha256:
            raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    manifest_raw = _read_exact_file(
        inbox / "bundle" / "manifest.json", expected_uid, MAX_RECEIPT_BYTES, 0o644,
    )
    if hashlib.sha256(manifest_raw).hexdigest() != receipt.manifest_sha256:
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    try:
        manifest = json.loads(manifest_raw, object_pairs_hook=_object)
    except (UnicodeDecodeError, json.JSONDecodeError, BundleDeliveryFailure):
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED") from None
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"schemaVersion", "protocolVersion", "release", "commit", "files"}
        or _canonical(manifest) != manifest_raw
        or manifest.get("schemaVersion") != 1
        or manifest.get("protocolVersion") != 1
        or manifest.get("release") != receipt.release
        or manifest.get("commit") != receipt.commit
        or not isinstance(manifest.get("files"), list)
    ):
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    manifest_files = {
        entry.get("path"): (entry.get("sha256"), entry.get("size"), entry.get("mode"))
        for entry in manifest["files"]
        if isinstance(entry, dict) and set(entry) == {"path", "sha256", "size", "mode"}
    }
    receipt_files = {
        item.path: (item.sha256, item.size, item.mode)
        for item in receipt.files if item.path != "manifest.json"
    }
    if manifest_files != receipt_files or len(manifest_files) != len(manifest["files"]):
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    entrypoint = f"{receipt.component}_proxy_install.py"
    if entrypoint not in receipt_files or receipt_files[entrypoint][2] != 0o755:
        raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
    return receipt


def seal_delivery(
    deployment_id: str,
    *,
    inbox_root: Path = INBOX_ROOT,
    ledger_root: Path = LEDGER_ROOT,
    expected_uid: int = 0,
) -> SealedDelivery:
    deployment_id = _deployment_id(deployment_id)
    _safe_root(ledger_root, expected_uid)
    quota = _quota_lock(ledger_root, expected_uid)
    try:
        inbox = inbox_root / deployment_id
        receipt = _verify_delivery(inbox, expected_uid, deployment_id)
        sealed_raw = _canonical({
            "schemaVersion": 1,
            "deploymentId": deployment_id,
            "receiptSha256": receipt.digest,
            "component": receipt.component,
            "commit": receipt.commit,
        })
        ledger_path = ledger_root / f"{deployment_id}.json"
        ledger_raw = _read_exact_file(ledger_path, expected_uid, 2048, 0o600)
        receiving_ledger = _canonical({
            "schemaVersion": 1,
            "deploymentId": deployment_id,
            "expectedReceiptSha256": receipt.digest,
            "phase": "receiving",
        })
        sealed_ledger = _canonical({
            "schemaVersion": 1,
            "deploymentId": deployment_id,
            "expectedReceiptSha256": receipt.digest,
            "phase": "sealed",
        })
        if ledger_raw not in {receiving_ledger, sealed_ledger}:
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        sealed_path = inbox / "sealed.json"
        if sealed_path.exists():
            if _read_exact_file(sealed_path, expected_uid, 2048, 0o600) != sealed_raw:
                raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        else:
            _write_exclusive(sealed_path, sealed_raw, 0o600)
        if ledger_raw == receiving_ledger:
            _replace(ledger_path, sealed_ledger, 0o600)
        return SealedDelivery(deployment_id, receipt, inbox / "bundle")
    finally:
        os.close(quota)


def load_sealed_delivery(
    deployment_id: str,
    *,
    inbox_root: Path = INBOX_ROOT,
    ledger_root: Path = LEDGER_ROOT,
    expected_uid: int = 0,
) -> SealedDelivery:
    deployment_id = _deployment_id(deployment_id)
    inbox = inbox_root / deployment_id
    receipt = _verify_delivery(inbox, expected_uid, deployment_id)
    sealed_raw = _read_exact_file(inbox / "sealed.json", expected_uid, 2048, 0o600)
    ledger_raw = _read_exact_file(
        ledger_root / f"{deployment_id}.json", expected_uid, 2048, 0o600,
    )
    expected_sealed = _canonical({
        "schemaVersion": 1,
        "deploymentId": deployment_id,
        "receiptSha256": receipt.digest,
        "component": receipt.component,
        "commit": receipt.commit,
    })
    expected_ledger = _canonical({
        "schemaVersion": 1,
        "deploymentId": deployment_id,
        "expectedReceiptSha256": receipt.digest,
        "phase": "sealed",
    })
    if sealed_raw != expected_sealed or ledger_raw != expected_ledger:
        raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
    return SealedDelivery(deployment_id, receipt, inbox / "bundle")


def claim_sealed_delivery(
    deployment_id: str,
    *,
    expected_component: str | None = None,
    inbox_root: Path = INBOX_ROOT,
    ledger_root: Path = LEDGER_ROOT,
    expected_uid: int = 0,
) -> SealedDelivery:
    deployment_id = _deployment_id(deployment_id)
    _safe_root(ledger_root, expected_uid)
    quota = _quota_lock(ledger_root, expected_uid)
    try:
        delivery = load_sealed_delivery(
            deployment_id,
            inbox_root=inbox_root,
            ledger_root=ledger_root,
            expected_uid=expected_uid,
        )
        if expected_component is not None and delivery.receipt.component != expected_component:
            raise BundleDeliveryFailure("BUNDLE_RELEASE_REFUSED")
        inbox = inbox_root / deployment_id
        _safe_root(inbox, expected_uid)
        claim_path = inbox / "claim"
        process_identity = _process_identity(os.getpid())
        if process_identity is None:
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        claim_raw = _canonical({
            "schemaVersion": 1,
            "deploymentId": deployment_id,
            "pid": os.getpid(),
            "processIdentity": process_identity,
        })
        try:
            _write_exclusive(claim_path, claim_raw, 0o600)
        except BundleDeliveryFailure:
            previous = _read_exact_file(claim_path, expected_uid, 2048, 0o600)
            try:
                value = json.loads(previous, object_pairs_hook=_object)
                pid = value.get("pid") if isinstance(value, dict) else None
                if (
                    not isinstance(value, dict)
                    or set(value) != {
                        "schemaVersion", "deploymentId", "pid", "processIdentity",
                    }
                    or _canonical(value) != previous
                    or value["schemaVersion"] != 1
                    or value["deploymentId"] != deployment_id
                    or isinstance(pid, bool)
                    or not isinstance(pid, int)
                    or not 1 <= pid <= 2**31 - 1
                    or not isinstance(value["processIdentity"], str)
                    or _PROCESS_IDENTITY.fullmatch(value["processIdentity"]) is None
                ):
                    raise ValueError
                if _process_identity(pid) == value["processIdentity"]:
                    raise ValueError
                _replace(claim_path, claim_raw, 0o600)
            except (ValueError, OSError, BundleDeliveryFailure):
                raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED") from None
        _replace(ledger_root / f"{deployment_id}.json", _canonical({
            "schemaVersion": 1,
            "deploymentId": deployment_id,
            "expectedReceiptSha256": delivery.receipt.digest,
            "phase": "claimed",
        }), 0o600)
        return delivery
    finally:
        os.close(quota)


def _arguments(values: list[str], names: tuple[str, ...]) -> dict[str, str]:
    result: dict[str, str] = {}
    for value in values:
        if not value.startswith("--") or "=" not in value:
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        name, raw = value[2:].split("=", 1)
        if name not in names or name in result or not raw or "\0" in raw:
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        result[name] = raw
    if set(result) != set(names):
        raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
    return result


def receiver_main(
    *,
    original_command: str | None = None,
    stdin: BinaryIO | None = None,
    inbox_root: Path = INBOX_ROOT,
    ledger_root: Path = LEDGER_ROOT,
    expected_uid: int = 0,
) -> int:
    try:
        if os.geteuid() != expected_uid:
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        command = os.environ.get("SSH_ORIGINAL_COMMAND") if original_command is None else original_command
        if command is None or not 1 <= len(command) <= 512 or any(ord(char) < 32 for char in command):
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        values = shlex.split(command, posix=True)
        if not values or values[0] != "aisy-sidecar-receiver":
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        operation = values[1] if len(values) >= 2 else ""
        arguments = values[2:]
        source = sys.stdin.buffer if stdin is None else stdin
        output = "ok"
        if operation == "begin":
            parsed = _arguments(arguments, ("expected-receipt-sha256",))
            deployment_id, _ = begin_delivery(
                parsed["expected-receipt-sha256"],
                inbox_root=inbox_root, ledger_root=ledger_root, expected_uid=expected_uid,
            )
            output = deployment_id
        elif operation == "receipt":
            parsed = _arguments(arguments, ("deployment-id",))
            store_receipt(
                parsed["deployment-id"], source,
                inbox_root=inbox_root, expected_uid=expected_uid,
            )
        elif operation == "member":
            parsed = _arguments(arguments, ("deployment-id", "path"))
            store_member(
                parsed["deployment-id"], parsed["path"], source,
                inbox_root=inbox_root, expected_uid=expected_uid,
            )
        elif operation == "seal":
            parsed = _arguments(arguments, ("deployment-id",))
            seal_delivery(
                parsed["deployment-id"], inbox_root=inbox_root,
                ledger_root=ledger_root, expected_uid=expected_uid,
            )
        else:
            raise BundleDeliveryFailure("BUNDLE_AUTHORITY_REFUSED")
        print(output)
        return 0
    except BundleDeliveryFailure as error:
        code = str(error)
        if code not in {
            "BUNDLE_AUTHORITY_REFUSED", "BUNDLE_SOURCE_REFUSED", "BUNDLE_RELEASE_REFUSED",
        }:
            code = "BUNDLE_AUTHORITY_REFUSED"
        print(code, file=sys.stderr)
        return 70
    except (OSError, ValueError):
        print("BUNDLE_AUTHORITY_REFUSED", file=sys.stderr)
        return 70
