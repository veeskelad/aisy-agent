"""Fixed Deepgram validation and host-encrypted credential publication."""

from __future__ import annotations

import ctypes
import hashlib
import ipaddress
import math
import os
import resource
import selectors
import signal
import socket
import ssl
import stat
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .voice_credential_broker import (
    BrokerFailure,
    CredentialClaim,
    VoiceCredentialBroker,
)

VALIDATION_DESCRIPTOR = "deepgram.credential.validate.v1"
VALIDATION_HOST = "api.deepgram.com"
VALIDATION_PORT = 443
VALIDATION_PATH = "/v1/projects"
SYSTEMD_CREDS = Path("/usr/bin/systemd-creds")
CREDENTIAL_NAME = "aisy-deepgram-cloud-primary"
MAX_KEY_BYTES = 8 * 1024
MAX_VALIDATION_RESPONSE = 1024 * 1024
MAX_VALIDATION_HEADERS = 16 * 1024
MAX_CIPHERTEXT_BYTES = 1024 * 1024
MAX_STDERR_BYTES = 8 * 1024


class BackendFailure(Exception):
    """Stable backend failure that never carries upstream or process detail."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class ConnectedSocket(Protocol):
    def send(self, data: memoryview) -> int: ...

    def recv_into(self, buffer: bytearray) -> int: ...

    def settimeout(self, timeout: float) -> None: ...

    def close(self) -> None: ...


Resolver = Callable[[str, int], Sequence[str]]
Connector = Callable[[str, str, float], ConnectedSocket]
Validator = Callable[[bytearray], None]
FaultHook = Callable[[str], None]


def _zero(buffer: bytearray) -> None:
    buffer[:] = b"\0" * len(buffer)


def _valid_key(secret: bytearray) -> bool:
    return (
        isinstance(secret, bytearray)
        and 1 <= len(secret) <= MAX_KEY_BYTES
        and all(0x20 < value < 0x7F for value in secret)
    )


def _default_resolver(host: str, port: int) -> Sequence[str]:
    return tuple(
        entry[4][0] for entry in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    )


def _default_connector(
    address: str, server_hostname: str, timeout: float
) -> ConnectedSocket:
    family = (
        socket.AF_INET6
        if ipaddress.ip_address(address).version == 6
        else socket.AF_INET
    )
    raw = socket.socket(family, socket.SOCK_STREAM | getattr(socket, "SOCK_CLOEXEC", 0))
    raw.settimeout(timeout)
    try:
        target: tuple[object, ...]
        target = (
            (address, VALIDATION_PORT, 0, 0)
            if family == socket.AF_INET6
            else (
                address,
                VALIDATION_PORT,
            )
        )
        raw.connect(target)
        context = ssl.create_default_context()
        return context.wrap_socket(raw, server_hostname=server_hostname)
    except BaseException:
        raw.close()
        raise


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise BackendFailure("VALIDATION_TIMEOUT")
    return remaining


def validate_deepgram_credential(
    secret: bytearray,
    *,
    resolver: Resolver = _default_resolver,
    connector: Connector = _default_connector,
    timeout_seconds: float = 10.0,
) -> None:
    """Perform one pinned, status-only request without returning vendor detail."""

    if not _valid_key(secret) or not 0.1 <= timeout_seconds <= 30.0:
        raise BackendFailure("INVALID_CREDENTIAL_INPUT")
    try:
        resolved = tuple(resolver(VALIDATION_HOST, VALIDATION_PORT))
        addresses = tuple(ipaddress.ip_address(value) for value in resolved)
    except (OSError, ValueError, TypeError):
        raise BackendFailure("VALIDATION_ADDRESS_REFUSED") from None
    if not addresses or any(not address.is_global for address in addresses):
        raise BackendFailure("VALIDATION_ADDRESS_REFUSED")
    selected = str(min(set(addresses), key=lambda value: (value.version, value.packed)))
    request = bytearray(f"GET {VALIDATION_PATH} HTTP/1.1\r\n".encode("ascii"))
    request.extend(f"Host: {VALIDATION_HOST}\r\n".encode("ascii"))
    request.extend(b"Authorization: Token ")
    request.extend(secret)
    request.extend(b"\r\nAccept: application/json\r\nConnection: close\r\n\r\n")
    response = bytearray()
    chunk = bytearray(16 * 1024)
    connection: ConnectedSocket | None = None
    deadline = time.monotonic() + timeout_seconds
    try:
        connection = connector(selected, VALIDATION_HOST, _remaining(deadline))
        offset = 0
        while offset < len(request):
            connection.settimeout(_remaining(deadline))
            written = connection.send(memoryview(request)[offset:])
            if written <= 0:
                raise BackendFailure("VALIDATION_TRANSPORT_REFUSED")
            offset += written
        while True:
            connection.settimeout(_remaining(deadline))
            received = connection.recv_into(chunk)
            if received == 0:
                break
            response.extend(memoryview(chunk)[:received])
            _zero(chunk)
            if len(response) > MAX_VALIDATION_RESPONSE:
                raise BackendFailure("VALIDATION_RESPONSE_BOUNDS")
        header_end = response.find(b"\r\n\r\n")
        line_end = response.find(b"\r\n")
        if (
            header_end < 0
            or header_end > MAX_VALIDATION_HEADERS
            or line_end < 12
            or response[:9] != b"HTTP/1.1 "
            or not all(48 <= value <= 57 for value in response[9:12])
            or (line_end > 12 and response[12] != 0x20)
        ):
            raise BackendFailure("VALIDATION_RESPONSE_REFUSED")
        if int(response[9:12]) != 200:
            raise BackendFailure("VALIDATION_REFUSED")
    except BackendFailure:
        raise
    except (OSError, ssl.SSLError, TimeoutError):
        raise BackendFailure("VALIDATION_TRANSPORT_REFUSED") from None
    finally:
        if connection is not None:
            connection.close()
        _zero(request)
        _zero(response)
        _zero(chunk)


@dataclass(frozen=True)
class StagedCiphertext:
    path: Path
    sha256: str
    size: int


class SystemdCredsEncryptor:
    """Fork/exec boundary with exact fd 0/1/2 and bounded process lifetime."""

    def __init__(
        self,
        state_root: Path,
        *,
        executable: Path = SYSTEMD_CREDS,
        command_prefix: Sequence[str] = (),
        expected_owner_uid: int = 0,
        executable_owner_uid: int = 0,
        timeout_seconds: float = 15.0,
        write: Callable[[int, memoryview], int] = os.write,
    ) -> None:
        self.state_root = state_root
        self.executable = executable
        self.command_prefix = tuple(command_prefix)
        self.expected_owner_uid = expected_owner_uid
        self.executable_owner_uid = executable_owner_uid
        self.timeout_seconds = timeout_seconds
        self._write = write

    def stage_path(self, revision: int) -> Path:
        if isinstance(revision, bool) or not 1 <= revision <= 2**31 - 1:
            raise BackendFailure("INVALID_REVISION")
        return self.state_root / f".deepgram-cloud.primary.r{revision}.stage"

    def _attest(self) -> None:
        try:
            root = self.state_root.lstat()
            canonical_root = self.state_root.resolve(strict=True)
            executable = self.executable.lstat()
            canonical = self.executable.resolve(strict=True)
        except OSError:
            raise BackendFailure("BACKEND_ATTESTATION_REFUSED") from None
        if (
            not stat.S_ISDIR(root.st_mode)
            or stat.S_IMODE(root.st_mode) != 0o700
            or root.st_uid != self.expected_owner_uid
            or canonical_root != self.state_root.absolute()
            or not stat.S_ISREG(executable.st_mode)
            or canonical != self.executable.absolute()
            or executable.st_uid != self.executable_owner_uid
            or executable.st_mode & 0o022
            or not executable.st_mode & stat.S_IXUSR
        ):
            raise BackendFailure("BACKEND_ATTESTATION_REFUSED")
        for prefix in self.command_prefix:
            if not prefix or "\0" in prefix or len(prefix.encode()) > 4096:
                raise BackendFailure("BACKEND_ATTESTATION_REFUSED")
        if self.executable_owner_uid == 0:
            for ancestor in canonical.parents:
                try:
                    info = ancestor.stat()
                except OSError:
                    raise BackendFailure("BACKEND_ATTESTATION_REFUSED") from None
                if info.st_uid != 0 or info.st_mode & 0o022:
                    raise BackendFailure("BACKEND_ATTESTATION_REFUSED")

    @staticmethod
    def _close_nonstdio() -> None:
        if sys.platform == "linux":
            try:
                descriptors = tuple(int(name) for name in os.listdir("/proc/self/fd"))
            except (OSError, ValueError):
                descriptors = ()
            else:
                for descriptor in descriptors:
                    if descriptor > 2:
                        try:
                            os.close(descriptor)
                        except OSError:
                            pass
                return
        open_max = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
        if open_max == resource.RLIM_INFINITY:
            open_max = 1_048_576
        os.closerange(3, min(int(open_max), 1_048_576))

    def _child(
        self,
        secret_read: int,
        stage_fd: int,
        stderr_write: int,
    ) -> None:
        argv = [
            str(self.executable),
            *self.command_prefix,
            "encrypt",
            "--with-key=host",
            f"--name={CREDENTIAL_NAME}",
            "-",
            "-",
        ]
        environment = {
            "LANG": "C",
            "LC_ALL": "C",
            "SYSTEMD_LOG_LEVEL": "err",
        }
        try:
            os.setsid()
            os.dup2(secret_read, 0, inheritable=True)
            os.dup2(stage_fd, 1, inheritable=True)
            os.dup2(stderr_write, 2, inheritable=True)
            os.chdir("/")
            os.umask(0o077)
            if sys.platform == "linux":
                libc = ctypes.CDLL(None, use_errno=True)
                if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
                    raise OSError(ctypes.get_errno(), "prctl")
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(
                resource.RLIMIT_FSIZE,
                (MAX_CIPHERTEXT_BYTES, MAX_CIPHERTEXT_BYTES),
            )
            cpu_limit = max(1, math.ceil(self.timeout_seconds) + 1)
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_limit, cpu_limit))
            self._close_nonstdio()
            resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
            os.execve(self.executable, argv, environment)
        except Exception:  # noqa: BLE001 - child must collapse every pre-exec fault
            try:
                os.write(2, b"EXEC_REFUSED")
            except OSError:
                pass
            os._exit(127)

    def _kill_and_reap(self, pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        while True:
            try:
                os.waitpid(pid, 0)
                return
            except InterruptedError:
                continue
            except ChildProcessError:
                return

    def _write_secret(
        self, descriptor: int, secret: bytearray, deadline: float
    ) -> None:
        os.set_blocking(descriptor, False)
        selector = selectors.DefaultSelector()
        selector.register(descriptor, selectors.EVENT_WRITE)
        offset = 0
        try:
            while offset < len(secret):
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise BackendFailure("ENCRYPT_TIMEOUT")
                try:
                    written = self._write(descriptor, memoryview(secret)[offset:])
                except BlockingIOError:
                    continue
                if written <= 0 or written > len(secret) - offset:
                    raise BackendFailure("ENCRYPT_SHORT_WRITE")
                offset += written
        finally:
            selector.close()

    def _wait(self, pid: int, stderr_read: int, deadline: float) -> int:
        os.set_blocking(stderr_read, False)
        selector = selectors.DefaultSelector()
        selector.register(stderr_read, selectors.EVENT_READ)
        captured = bytearray()
        scratch = bytearray(4096)
        status: int | None = None
        eof = False
        try:
            while status is None or not eof:
                if status is None:
                    try:
                        waited, candidate = os.waitpid(pid, os.WNOHANG)
                    except InterruptedError:
                        waited = 0
                        candidate = 0
                    if waited == pid:
                        status = candidate
                while not eof:
                    try:
                        received = os.readv(stderr_read, [scratch])
                    except BlockingIOError:
                        break
                    if received == 0:
                        eof = True
                        break
                    captured.extend(memoryview(scratch)[:received])
                    _zero(scratch)
                    if len(captured) > MAX_STDERR_BYTES:
                        raise BackendFailure("ENCRYPT_STDERR_BOUNDS")
                if status is not None and eof:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BackendFailure("ENCRYPT_TIMEOUT")
                selector.select(min(remaining, 0.05))
            return os.waitstatus_to_exitcode(status)
        except Exception:
            if status is None:
                self._kill_and_reap(pid)
            raise
        finally:
            selector.close()
            _zero(captured)
            _zero(scratch)

    def _hash_fd(self, descriptor: int) -> tuple[str, int]:
        os.lseek(descriptor, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        scratch = bytearray(16 * 1024)
        total = 0
        try:
            while True:
                received = os.readv(descriptor, [scratch])
                if received == 0:
                    break
                total += received
                if total > MAX_CIPHERTEXT_BYTES:
                    raise BackendFailure("ENCRYPT_OUTPUT_BOUNDS")
                digest.update(memoryview(scratch)[:received])
                _zero(scratch)
        finally:
            _zero(scratch)
        if total == 0:
            raise BackendFailure("ENCRYPT_OUTPUT_REFUSED")
        return digest.hexdigest(), total

    def _remove_stage(self, stage: Path) -> None:
        directory_fd = -1
        try:
            directory_fd = os.open(
                self.state_root,
                os.O_RDONLY
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_CLOEXEC", 0),
            )
            stage.unlink(missing_ok=True)
            os.fsync(directory_fd)
        except OSError:
            raise BackendFailure("ENCRYPT_CLEANUP_REFUSED") from None
        finally:
            if directory_fd >= 0:
                os.close(directory_fd)

    def encrypt(self, secret: bytearray, revision: int) -> StagedCiphertext:
        if not _valid_key(secret) or not 0.1 <= self.timeout_seconds <= 60.0:
            _zero(secret)
            raise BackendFailure("INVALID_CREDENTIAL_INPUT")
        try:
            self._attest()
            stage = self.stage_path(revision)
        except BackendFailure:
            _zero(secret)
            raise
        stage_fd = -1
        secret_read = secret_write = stderr_read = stderr_write = -1
        pid = -1
        deadline = time.monotonic() + self.timeout_seconds
        try:
            stage_fd = os.open(
                stage,
                os.O_CREAT
                | os.O_EXCL
                | os.O_RDWR
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0),
                0o600,
            )
            os.fchmod(stage_fd, 0o600)
            secret_read, secret_write = os.pipe2(os.O_CLOEXEC)
            stderr_read, stderr_write = os.pipe2(os.O_CLOEXEC)
            pid = os.fork()
            if pid == 0:
                self._child(secret_read, stage_fd, stderr_write)
                os._exit(127)
            os.close(secret_read)
            secret_read = -1
            os.close(stderr_write)
            stderr_write = -1
            try:
                self._write_secret(secret_write, secret, deadline)
            finally:
                _zero(secret)
                os.close(secret_write)
                secret_write = -1
            try:
                exit_code = self._wait(pid, stderr_read, deadline)
            finally:
                pid = -1
            if exit_code != 0:
                raise BackendFailure("ENCRYPT_PROCESS_REFUSED")
            os.fsync(stage_fd)
            info = os.fstat(stage_fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != self.expected_owner_uid
            ):
                raise BackendFailure("ENCRYPT_OUTPUT_REFUSED")
            sha256, size = self._hash_fd(stage_fd)
            after = os.fstat(stage_fd)
            if (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            ) != (
                info.st_dev,
                info.st_ino,
                info.st_size,
                info.st_mtime_ns,
                info.st_ctime_ns,
            ):
                raise BackendFailure("ENCRYPT_OUTPUT_REFUSED")
            return StagedCiphertext(stage, sha256, size)
        except BackendFailure:
            if pid > 0:
                self._kill_and_reap(pid)
                pid = -1
            try:
                self._remove_stage(stage)
            except BackendFailure:
                raise BackendFailure("ENCRYPT_CLEANUP_REFUSED") from None
            raise
        except (OSError, ValueError):
            if pid > 0:
                self._kill_and_reap(pid)
                pid = -1
            try:
                self._remove_stage(stage)
            except BackendFailure:
                raise BackendFailure("ENCRYPT_CLEANUP_REFUSED") from None
            raise BackendFailure("ENCRYPT_PROCESS_REFUSED") from None
        finally:
            _zero(secret)
            for descriptor in (
                secret_read,
                secret_write,
                stderr_read,
                stderr_write,
                stage_fd,
            ):
                if descriptor >= 0:
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass


class CiphertextStore:
    """Atomic active ciphertext publication with exact-hash crash recovery."""

    def __init__(
        self,
        state_root: Path,
        *,
        expected_owner_uid: int = 0,
        fault: FaultHook | None = None,
    ) -> None:
        self.state_root = state_root
        self.expected_owner_uid = expected_owner_uid
        self._fault = fault or (lambda _point: None)

    @property
    def active_path(self) -> Path:
        return self.state_root / "deepgram-cloud.primary.cred"

    def backup_path(self, revision: int) -> Path:
        if isinstance(revision, bool) or not 1 <= revision <= 2**31 - 1:
            raise BackendFailure("CIPHERTEXT_STATE_REFUSED")
        return self.state_root / f".deepgram-cloud.primary.r{revision}.retired"

    def _require_member(self, path: Path, *, stage_only: bool = False) -> None:
        if path.parent != self.state_root:
            raise BackendFailure("CIPHERTEXT_STATE_REFUSED")
        if not stage_only and path.name == self.active_path.name:
            return
        prefix = ".deepgram-cloud.primary.r"
        suffixes = (".stage",) if stage_only else (".stage", ".retired")
        suffix = next((value for value in suffixes if path.name.endswith(value)), None)
        if suffix is None or not path.name.startswith(prefix):
            raise BackendFailure("CIPHERTEXT_STATE_REFUSED")
        revision = path.name[len(prefix) : -len(suffix)]
        if (
            not revision.isascii()
            or not revision.isdigit()
            or str(int(revision)) != revision
        ):
            raise BackendFailure("CIPHERTEXT_STATE_REFUSED")
        if not 1 <= int(revision) <= 2**31 - 1:
            raise BackendFailure("CIPHERTEXT_STATE_REFUSED")

    def _directory_fd(self) -> int:
        try:
            info = self.state_root.lstat()
            canonical = self.state_root.resolve(strict=True)
            if (
                not stat.S_ISDIR(info.st_mode)
                or stat.S_IMODE(info.st_mode) != 0o700
                or info.st_uid != self.expected_owner_uid
                or canonical != self.state_root.absolute()
            ):
                raise OSError
            return os.open(
                self.state_root,
                os.O_RDONLY
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_CLOEXEC", 0),
            )
        except OSError:
            raise BackendFailure("CIPHERTEXT_STATE_REFUSED") from None

    def _hash_file(self, path: Path) -> tuple[str, int]:
        self._require_member(path)
        descriptor = -1
        scratch = bytearray(16 * 1024)
        try:
            descriptor = os.open(
                path,
                os.O_RDONLY
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0),
            )
            info = os.fstat(descriptor)
            if (
                not stat.S_ISREG(info.st_mode)
                or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != self.expected_owner_uid
                or not 1 <= info.st_size <= MAX_CIPHERTEXT_BYTES
            ):
                raise BackendFailure("CIPHERTEXT_STATE_REFUSED")
            digest = hashlib.sha256()
            total = 0
            while True:
                received = os.readv(descriptor, [scratch])
                if received == 0:
                    break
                total += received
                digest.update(memoryview(scratch)[:received])
                _zero(scratch)
            before = os.fstat(descriptor)
            if (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
                before.st_ctime_ns,
            ) != (
                info.st_dev,
                info.st_ino,
                info.st_size,
                info.st_mtime_ns,
                info.st_ctime_ns,
            ):
                raise BackendFailure("CIPHERTEXT_STATE_REFUSED")
            return digest.hexdigest(), total
        except BackendFailure:
            raise
        except OSError:
            raise BackendFailure("CIPHERTEXT_STATE_REFUSED") from None
        finally:
            _zero(scratch)
            if descriptor >= 0:
                os.close(descriptor)

    def verify(self, path: Path, expected_hash: str) -> None:
        actual, _size = self._hash_file(path)
        if actual != expected_hash:
            raise BackendFailure("CIPHERTEXT_HASH_REFUSED")

    def discard_stage(self, stage: Path) -> None:
        self._require_member(stage, stage_only=True)
        directory_fd = self._directory_fd()
        try:
            stage.unlink(missing_ok=True)
            os.fsync(directory_fd)
        except OSError:
            raise BackendFailure("CIPHERTEXT_CLEANUP_REFUSED") from None
        finally:
            os.close(directory_fd)

    def activate(
        self,
        stage: Path,
        target_hash: str,
        *,
        active_revision: int,
        active_hash: str | None,
    ) -> None:
        self._require_member(stage, stage_only=True)
        self.verify(stage, target_hash)
        directory_fd = self._directory_fd()
        backup = self.backup_path(active_revision) if active_revision > 0 else None
        try:
            if active_revision > 0:
                if active_hash is None:
                    raise BackendFailure("CIPHERTEXT_STATE_REFUSED")
                self.verify(self.active_path, active_hash)
                if backup is not None and backup.exists():
                    self.verify(backup, active_hash)
                elif backup is not None:
                    os.link(self.active_path, backup, follow_symlinks=False)
                    os.chmod(backup, 0o600, follow_symlinks=False)
                    os.fsync(directory_fd)
                self._fault("after-backup")
            os.replace(stage, self.active_path)
            os.fsync(directory_fd)
            self._fault("after-rename")
            self.verify(self.active_path, target_hash)
        except BackendFailure:
            raise
        except OSError:
            raise BackendFailure("CIPHERTEXT_PUBLISH_REFUSED") from None
        finally:
            os.close(directory_fd)

    def recover_activate(
        self,
        stage: Path,
        target_hash: str,
        *,
        active_revision: int,
        active_hash: str | None,
    ) -> None:
        try:
            self.verify(self.active_path, target_hash)
            return
        except BackendFailure:
            pass
        self.activate(
            stage,
            target_hash,
            active_revision=active_revision,
            active_hash=active_hash,
        )

    def retire(self, revision: int, expected_hash: str | None) -> None:
        if revision == 0:
            return
        if expected_hash is None:
            raise BackendFailure("CIPHERTEXT_STATE_REFUSED")
        backup = self.backup_path(revision)
        if not backup.exists():
            return
        self.verify(backup, expected_hash)
        directory_fd = self._directory_fd()
        try:
            backup.unlink()
            os.fsync(directory_fd)
        except OSError:
            raise BackendFailure("CIPHERTEXT_CLEANUP_REFUSED") from None
        finally:
            os.close(directory_fd)

    def remove_active(self, expected_hash: str, *, allow_missing: bool) -> None:
        if not self.active_path.exists():
            if allow_missing:
                return
            raise BackendFailure("CIPHERTEXT_STATE_REFUSED")
        self.verify(self.active_path, expected_hash)
        directory_fd = self._directory_fd()
        try:
            self.active_path.unlink()
            os.fsync(directory_fd)
        except OSError:
            raise BackendFailure("CIPHERTEXT_CLEANUP_REFUSED") from None
        finally:
            os.close(directory_fd)


class HostEncryptedCredentialBackend:
    """Orchestrate validation, encryption, atomic publish, recovery, and revoke."""

    def __init__(
        self,
        broker: VoiceCredentialBroker,
        encryptor: SystemdCredsEncryptor,
        store: CiphertextStore,
        *,
        validator: Validator = validate_deepgram_credential,
    ) -> None:
        self.broker = broker
        self.encryptor = encryptor
        self.store = store
        self.validator = validator

    def _abort(
        self,
        binding_hash: str,
        revision: int,
        code: str,
        stage: Path | None,
    ) -> None:
        transition = self.broker.credential_transition(binding_hash)
        if (
            transition.get("state") == "committing"
            and transition.get("targetRevision") == revision
        ):
            raise BackendFailure("CREDENTIAL_COMMIT_AMBIGUOUS")
        if stage is not None:
            self.store.discard_stage(stage)
        self.broker.abort_validation(binding_hash, revision, code)

    def activate(
        self,
        claim: CredentialClaim,
        secret: bytearray,
    ) -> int:
        binding_hash, revision = self.broker.begin_validation(claim)
        before = self.broker.credential_transition(binding_hash)
        active_revision = int(before.get("activeRevision", 0))
        active_hash_value = before.get("ciphertextHash")
        active_hash = active_hash_value if isinstance(active_hash_value, str) else None
        staged: StagedCiphertext | None = None
        try:
            self.validator(secret)
            staged = self.encryptor.encrypt(secret, revision)
            try:
                self.broker.mark_committing(binding_hash, revision, staged.sha256)
            except BrokerFailure as error:
                self._abort(binding_hash, revision, str(error), staged.path)
                raise BackendFailure("CREDENTIAL_STAGE_REFUSED") from None
            self.store.activate(
                staged.path,
                staged.sha256,
                active_revision=active_revision,
                active_hash=active_hash,
            )
            try:
                self.broker.publish_credential(binding_hash, revision, staged.sha256)
            except BrokerFailure:
                transition = self.broker.credential_transition(binding_hash)
                if not (
                    transition.get("state") == "active"
                    and transition.get("activeRevision") == revision
                    and transition.get("ciphertextHash") == staged.sha256
                ):
                    raise BackendFailure("CREDENTIAL_COMMIT_AMBIGUOUS") from None
            self.store.retire(active_revision, active_hash)
            return revision
        except BackendFailure as error:
            if staged is None:
                self._abort(binding_hash, revision, error.code, None)
            else:
                state = self.broker.credential_transition(binding_hash).get("state")
                if state == "validating":
                    self._abort(binding_hash, revision, error.code, staged.path)
                if state == "committing":
                    raise BackendFailure("CREDENTIAL_COMMIT_AMBIGUOUS") from None
            raise
        except Exception:  # noqa: BLE001 - boundary maps all detail to a stable code
            state = self.broker.credential_transition(binding_hash).get("state")
            if state == "validating":
                self._abort(
                    binding_hash,
                    revision,
                    "BACKEND_REFUSED",
                    staged.path if staged else None,
                )
            if state == "committing":
                raise BackendFailure("CREDENTIAL_COMMIT_AMBIGUOUS") from None
            raise BackendFailure("BACKEND_REFUSED") from None
        finally:
            _zero(secret)

    def recover(self, binding_hash: str) -> int:
        transition = self.broker.credential_transition(binding_hash)
        if transition.get("state") != "committing":
            raise BackendFailure("RECOVERY_NOT_REQUIRED")
        active_revision = int(transition["activeRevision"])
        target_revision = int(transition["targetRevision"])
        target_hash = str(transition["targetCiphertextHash"])
        active_hash_value = transition.get("ciphertextHash")
        active_hash = active_hash_value if isinstance(active_hash_value, str) else None
        stage = self.encryptor.stage_path(target_revision)
        self.store.recover_activate(
            stage,
            target_hash,
            active_revision=active_revision,
            active_hash=active_hash,
        )
        self.broker.publish_credential(binding_hash, target_revision, target_hash)
        self.store.retire(active_revision, active_hash)
        return target_revision

    def revoke(
        self,
        binding_hash: str,
        fence_workers: Callable[[int], bool],
    ) -> int:
        before = self.broker.credential_transition(binding_hash)
        was_revoking = before.get("state") == "revoking"
        if not was_revoking:
            active_hash = before.get("ciphertextHash")
            if not isinstance(active_hash, str):
                raise BackendFailure("CREDENTIAL_UNAVAILABLE")
            self.store.verify(self.store.active_path, active_hash)
        revision, ciphertext_hash = self.broker.begin_revoke(binding_hash)
        try:
            fenced = fence_workers(revision)
        except Exception:  # noqa: BLE001 - fencing detail must not escape the broker
            fenced = False
        if not fenced:
            raise BackendFailure("REVOCATION_PENDING")
        self.broker.fence_revoke_permits(binding_hash, revision)
        self.store.remove_active(ciphertext_hash, allow_missing=was_revoking)
        self.broker.complete_revoke(binding_hash, revision, ciphertext_hash)
        return revision
