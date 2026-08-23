from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
from pathlib import Path

import pytest

import aisy_sidecars.voice_credential_backend as backend_module
from aisy_sidecars.voice_credential_backend import (
    CREDENTIAL_NAME,
    BackendFailure,
    CiphertextStore,
    HostEncryptedCredentialBackend,
    StagedCiphertext,
    SystemdCredsEncryptor,
    validate_deepgram_credential,
)
from aisy_sidecars.voice_credential_broker import BrokerFailure, VoiceCredentialBroker

INSTALLATION = "backend-installation-sentinel"
OPERATOR = "backend-operator-sentinel"
PROFILE = "backend-profile-sentinel"
KEY = b"backend-key-sentinel-value"


class FakeSocket:
    def __init__(self, response: bytes, *, send_size: int = 1_000_000) -> None:
        self.response = bytearray(response)
        self.send_size = send_size
        self.sent = bytearray()
        self.offset = 0
        self.closed = False

    def send(self, data: memoryview) -> int:
        count = min(len(data), self.send_size)
        self.sent.extend(data[:count])
        return count

    def recv_into(self, buffer: bytearray) -> int:
        if self.offset == len(self.response):
            return 0
        count = min(len(buffer), len(self.response) - self.offset)
        buffer[:count] = self.response[self.offset : self.offset + count]
        self.offset += count
        return count

    def settimeout(self, _timeout: float) -> None:
        return

    def close(self) -> None:
        self.closed = True


class FakeEncryptor:
    def __init__(self, root: Path) -> None:
        self.root = root

    def stage_path(self, revision: int) -> Path:
        return self.root / f".deepgram-cloud.primary.r{revision}.stage"

    def encrypt(self, secret: bytearray, revision: int) -> StagedCiphertext:
        assert secret == KEY
        payload = f"ciphertext-revision-{revision}".encode()
        path = self.stage_path(revision)
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            os.write(descriptor, payload)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
            secret[:] = b"\0" * len(secret)
        return StagedCiphertext(path, hashlib.sha256(payload).hexdigest(), len(payload))


def roots(tmp_path: Path) -> tuple[Path, Path]:
    metadata = tmp_path / "metadata"
    ciphertext = tmp_path / "ciphertext"
    metadata.mkdir(mode=0o700)
    ciphertext.mkdir(mode=0o700)
    metadata.chmod(0o700)
    ciphertext.chmod(0o700)
    return metadata / "broker.db", ciphertext


def enrollment_claim(broker: VoiceCredentialBroker):
    challenge = broker.begin_enrollment(INSTALLATION, OPERATOR, PROFILE, now=100)
    return broker.claim_enrollment(
        challenge.code,
        INSTALLATION,
        OPERATOR,
        PROFILE,
        now=101,
    )


def backend_for(
    broker: VoiceCredentialBroker,
    root: Path,
    *,
    validator=lambda _secret: None,
    fault=None,
) -> HostEncryptedCredentialBackend:
    return HostEncryptedCredentialBackend(
        broker,
        FakeEncryptor(root),  # type: ignore[arg-type]
        CiphertextStore(root, expected_owner_uid=os.getuid(), fault=fault),
        validator=validator,
    )


def activate_once(
    broker: VoiceCredentialBroker,
    root: Path,
    *,
    backend: HostEncryptedCredentialBackend | None = None,
) -> str:
    binding = broker.binding_hash(INSTALLATION, OPERATOR, PROFILE)
    secret = bytearray(KEY)
    (backend or backend_for(broker, root)).activate(enrollment_claim(broker), secret)
    assert secret == bytearray(len(KEY))
    return binding


def test_validation_uses_one_exact_pinned_status_only_request() -> None:
    fake = FakeSocket(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}", send_size=7)
    observed: list[tuple[str, str]] = []

    def connector(address: str, hostname: str, _timeout: float) -> FakeSocket:
        observed.append((address, hostname))
        return fake

    secret = bytearray(KEY)
    validate_deepgram_credential(
        secret,
        resolver=lambda host, port: ["2606:4700:4700::1111", "1.1.1.1"],
        connector=connector,
    )
    assert observed == [("1.1.1.1", "api.deepgram.com")]
    assert fake.sent == (
        b"GET /v1/projects HTTP/1.1\r\n"
        b"Host: api.deepgram.com\r\n"
        b"Authorization: Token "
        + KEY
        + b"\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    )
    assert fake.closed
    assert secret == KEY
    fake.sent[:] = b"\0" * len(fake.sent)


@pytest.mark.parametrize(
    ("addresses", "response", "code"),
    [
        (["127.0.0.1"], b"", "VALIDATION_ADDRESS_REFUSED"),
        (["1.1.1.1", "10.0.0.1"], b"", "VALIDATION_ADDRESS_REFUSED"),
        (["1.1.1.1"], b"HTTP/1.1 302 Found\r\n\r\n", "VALIDATION_REFUSED"),
        (["1.1.1.1"], b"HTTP/1.1 401 Nope\r\n\r\nrich-detail", "VALIDATION_REFUSED"),
        (["1.1.1.1"], b"HTTP/1.1 200XYZ\r\n\r\n", "VALIDATION_RESPONSE_REFUSED"),
        (["1.1.1.1"], b"not-http", "VALIDATION_RESPONSE_REFUSED"),
    ],
)
def test_validation_faults_are_redacted(
    addresses: list[str],
    response: bytes,
    code: str,
) -> None:
    connected = False

    def connector(_address: str, _hostname: str, _timeout: float) -> FakeSocket:
        nonlocal connected
        connected = True
        return FakeSocket(response)

    with pytest.raises(BackendFailure, match=code) as raised:
        validate_deepgram_credential(
            bytearray(KEY),
            resolver=lambda _host, _port: addresses,
            connector=connector,
        )
    assert str(raised.value) == code
    assert connected is all(
        __import__("ipaddress").ip_address(address).is_global for address in addresses
    )


def test_validation_rejects_oversized_response_without_detail() -> None:
    response = b"HTTP/1.1 200 OK\r\n\r\n" + b"x" * (1024 * 1024 + 1)
    with pytest.raises(BackendFailure, match="VALIDATION_RESPONSE_BOUNDS"):
        validate_deepgram_credential(
            bytearray(KEY),
            resolver=lambda _host, _port: ["1.1.1.1"],
            connector=lambda *_args: FakeSocket(response),
        )


def test_store_rotation_and_exact_hash_recovery(tmp_path: Path) -> None:
    _database, root = roots(tmp_path)
    store = CiphertextStore(root, expected_owner_uid=os.getuid())
    first = root / ".deepgram-cloud.primary.r1.stage"
    first.write_bytes(b"first")
    first.chmod(0o600)
    first_hash = hashlib.sha256(b"first").hexdigest()
    store.activate(first, first_hash, active_revision=0, active_hash=None)
    store.verify(store.active_path, first_hash)

    second = root / ".deepgram-cloud.primary.r2.stage"
    second.write_bytes(b"second")
    second.chmod(0o600)
    second_hash = hashlib.sha256(b"second").hexdigest()
    store.activate(second, second_hash, active_revision=1, active_hash=first_hash)
    assert store.backup_path(1).read_bytes() == b"first"
    assert store.active_path.read_bytes() == b"second"
    store.retire(1, first_hash)
    assert not store.backup_path(1).exists()


def test_store_refuses_paths_outside_exact_state_root(tmp_path: Path) -> None:
    _database, root = roots(tmp_path)
    store = CiphertextStore(root, expected_owner_uid=os.getuid())
    outside = tmp_path / ".deepgram-cloud.primary.r1.stage"
    outside.write_bytes(b"outside")
    outside.chmod(0o600)

    with pytest.raises(BackendFailure, match="CIPHERTEXT_STATE_REFUSED"):
        store.discard_stage(outside)

    assert outside.read_bytes() == b"outside"


@pytest.mark.parametrize("point", ["after-backup", "after-rename"])
def test_store_recovers_each_ambiguous_rename_boundary(
    tmp_path: Path,
    point: str,
) -> None:
    _database, root = roots(tmp_path)
    base = CiphertextStore(root, expected_owner_uid=os.getuid())
    first = root / ".deepgram-cloud.primary.r1.stage"
    first.write_bytes(b"old")
    first.chmod(0o600)
    old_hash = hashlib.sha256(b"old").hexdigest()
    base.activate(first, old_hash, active_revision=0, active_hash=None)
    stage = root / ".deepgram-cloud.primary.r2.stage"
    stage.write_bytes(b"new")
    stage.chmod(0o600)
    new_hash = hashlib.sha256(b"new").hexdigest()

    def crash(actual: str) -> None:
        if actual == point:
            raise RuntimeError("crash")

    faulting = CiphertextStore(root, expected_owner_uid=os.getuid(), fault=crash)
    with pytest.raises(RuntimeError, match="crash"):
        faulting.activate(stage, new_hash, active_revision=1, active_hash=old_hash)
    base.recover_activate(stage, new_hash, active_revision=1, active_hash=old_hash)
    base.verify(base.active_path, new_hash)


def test_initial_activation_and_failed_rotation_keep_old_revision(
    tmp_path: Path,
) -> None:
    database, root = roots(tmp_path)
    with VoiceCredentialBroker(database) as broker:
        binding = activate_once(broker, root)
        before = root.joinpath("deepgram-cloud.primary.cred").read_bytes()

        def refuse(_secret: bytearray) -> None:
            raise BackendFailure("VALIDATION_REFUSED")

        secret = bytearray(KEY)
        with pytest.raises(BackendFailure, match="VALIDATION_REFUSED"):
            backend_for(broker, root, validator=refuse).activate(
                enrollment_claim(broker), secret
            )
        assert secret == bytearray(len(KEY))
        assert broker.inspect(binding)["revision"] == 1
        assert root.joinpath("deepgram-cloud.primary.cred").read_bytes() == before


def test_rotation_waits_for_nonterminal_epoch_and_cleans_stage(tmp_path: Path) -> None:
    database, root = roots(tmp_path)
    with VoiceCredentialBroker(database) as broker:
        binding = activate_once(broker, root)
        broker.prepare_permit(binding, 1, "recovery-busy", now=200)
        secret = bytearray(KEY)
        with pytest.raises(BackendFailure, match="CREDENTIAL_STAGE_REFUSED"):
            backend_for(broker, root).activate(enrollment_claim(broker), secret)
        assert broker.inspect(binding)["revision"] == 1
        assert not root.joinpath(".deepgram-cloud.primary.r2.stage").exists()


@pytest.mark.parametrize("point", ["after-backup", "after-rename"])
def test_backend_recovers_commit_without_revalidating(
    tmp_path: Path,
    point: str,
) -> None:
    database, root = roots(tmp_path)
    validation_count = 0

    def validate(_secret: bytearray) -> None:
        nonlocal validation_count
        validation_count += 1

    with VoiceCredentialBroker(database) as broker:
        binding = activate_once(
            broker, root, backend=backend_for(broker, root, validator=validate)
        )

        def crash(actual: str) -> None:
            if actual == point:
                raise RuntimeError("crash")

        secret = bytearray(KEY)
        with pytest.raises(BackendFailure, match="CREDENTIAL_COMMIT_AMBIGUOUS"):
            backend_for(broker, root, validator=validate, fault=crash).activate(
                enrollment_claim(broker), secret
            )
        assert broker.credential_transition(binding)["state"] == "committing"
        recovered = backend_for(broker, root, validator=validate).recover(binding)
        assert recovered == 2
        assert broker.inspect(binding)["revision"] == 2
        assert validation_count == 2


def test_revoke_fences_epoch_before_deleting_ciphertext(tmp_path: Path) -> None:
    database, root = roots(tmp_path)
    with VoiceCredentialBroker(database) as broker:
        binding = activate_once(broker, root)
        prepared = broker.prepare_permit(binding, 1, "recovery-prepared", now=200)
        claimed = broker.prepare_permit(binding, 1, "recovery-claimed", now=200)
        attempted = broker.prepare_permit(binding, 1, "recovery-attempted", now=200)
        broker.transition_permit(claimed, "claimed", now=201)
        broker.transition_permit(attempted, "claimed", now=201)
        broker.transition_permit(attempted, "attempted", now=202)
        backend = backend_for(broker, root)
        with pytest.raises(BackendFailure, match="REVOCATION_PENDING"):
            backend.revoke(binding, lambda _revision: False)
        assert broker.credential_transition(binding)["state"] == "revoking"
        assert root.joinpath("deepgram-cloud.primary.cred").exists()
        with pytest.raises(BrokerFailure, match="CREDENTIAL_UNAVAILABLE"):
            broker.prepare_permit(binding, 1, "recovery-new", now=203)

        assert backend.revoke(binding, lambda revision: revision == 1) == 1
        assert broker.credential_transition(binding)["state"] == "revoked"
        assert not root.joinpath("deepgram-cloud.primary.cred").exists()
        for permit in (prepared, claimed, attempted):
            with pytest.raises(BrokerFailure, match="PERMIT_REFUSED"):
                broker.transition_permit(permit, "claimed", now=204)


def test_revoke_restart_finishes_after_delete_before_metadata_commit(
    tmp_path: Path,
) -> None:
    database, root = roots(tmp_path)
    enabled = False

    def fault(point: str) -> None:
        if enabled and point == "before-commit:complete-revoke":
            raise RuntimeError("crash")

    with VoiceCredentialBroker(database, fault=fault) as broker:
        binding = activate_once(broker, root)
        enabled = True
        with pytest.raises(RuntimeError, match="crash"):
            backend_for(broker, root).revoke(binding, lambda _revision: True)
        assert broker.credential_transition(binding)["state"] == "revoking"
        assert not root.joinpath("deepgram-cloud.primary.cred").exists()
    with VoiceCredentialBroker(database) as broker:
        assert backend_for(broker, root).revoke(binding, lambda _revision: True) == 1
        assert broker.credential_transition(binding)["state"] == "revoked"


def test_systemd_creds_attestation_failure_zeroes_input(tmp_path: Path) -> None:
    _database, root = roots(tmp_path)
    executable = tmp_path / "unsafe-executable"
    executable.write_text("refused")
    executable.chmod(0o777)
    encryptor = SystemdCredsEncryptor(
        root,
        executable=executable,
        expected_owner_uid=os.getuid(),
        executable_owner_uid=os.getuid(),
    )
    secret = bytearray(KEY)

    with pytest.raises(BackendFailure, match="BACKEND_ATTESTATION_REFUSED"):
        encryptor.encrypt(secret, 1)

    assert secret == bytearray(len(KEY))
    assert not encryptor.stage_path(1).exists()


@pytest.mark.skipif(sys.platform != "linux", reason="Linux fork/exec boundary")
def test_systemd_creds_process_has_exact_argv_env_fds_and_limits(
    tmp_path: Path,
) -> None:
    _database, root = roots(tmp_path)
    fixture = Path(__file__).parent / "fixtures" / "fake_systemd_creds.py"
    executable = Path(sys.executable).resolve()
    encryptor = SystemdCredsEncryptor(
        root,
        executable=executable,
        command_prefix=(str(fixture), "ok"),
        expected_owner_uid=os.getuid(),
        executable_owner_uid=executable.stat().st_uid,
    )
    inherited = os.open("/dev/null", os.O_RDONLY)
    secret = bytearray(KEY)
    try:
        staged = encryptor.encrypt(secret, 1)
    finally:
        os.close(inherited)
    audit = json.loads(staged.path.read_text())
    assert audit["argv"] == [
        "encrypt",
        "--with-key=host",
        f"--name={CREDENTIAL_NAME}",
        "-",
        "-",
    ]
    assert audit["cwd"] == "/"
    assert audit["environment"] == {
        "LANG": "C",
        "LC_ALL": "C",
        "SYSTEMD_LOG_LEVEL": "err",
    }
    assert audit["fds"] == [0, 1, 2]
    assert audit["coreLimit"] == [0, 0]
    assert audit["nofileLimit"] == [64, 64]
    assert audit["umask"] == "0o77"
    assert audit["inputConsumed"] is True
    assert secret == bytearray(len(KEY))
    assert KEY not in staged.path.read_bytes()
    assert stat.S_IMODE(staged.path.stat().st_mode) == 0o600


@pytest.mark.skipif(sys.platform != "linux", reason="Linux fork/exec boundary")
def test_systemd_creds_prctl_failure_is_fail_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _database, root = roots(tmp_path)
    fixture = Path(__file__).parent / "fixtures" / "fake_systemd_creds.py"
    executable = Path(sys.executable).resolve()

    class RefusingLibc:
        @staticmethod
        def prctl(*_args: object) -> int:
            return -1

    monkeypatch.setattr(
        backend_module.ctypes, "CDLL", lambda *_args, **_kwargs: RefusingLibc()
    )
    encryptor = SystemdCredsEncryptor(
        root,
        executable=executable,
        command_prefix=(str(fixture), "ok"),
        expected_owner_uid=os.getuid(),
        executable_owner_uid=executable.stat().st_uid,
    )
    secret = bytearray(KEY)
    with pytest.raises(BackendFailure, match="ENCRYPT_PROCESS_REFUSED"):
        encryptor.encrypt(secret, 1)
    assert secret == bytearray(len(KEY))
    assert not encryptor.stage_path(1).exists()


@pytest.mark.skipif(sys.platform != "linux", reason="Linux fork/exec boundary")
@pytest.mark.parametrize(
    ("mode", "timeout", "code"),
    [
        ("stderr", 2.0, "ENCRYPT_STDERR_BOUNDS"),
        ("sleep", 0.2, "ENCRYPT_TIMEOUT"),
        ("fail", 2.0, "ENCRYPT_PROCESS_REFUSED"),
    ],
)
def test_systemd_creds_faults_kill_reap_zero_and_remove_stage(
    tmp_path: Path,
    mode: str,
    timeout: float,
    code: str,
) -> None:
    _database, root = roots(tmp_path)
    fixture = Path(__file__).parent / "fixtures" / "fake_systemd_creds.py"
    executable = Path(sys.executable).resolve()
    encryptor = SystemdCredsEncryptor(
        root,
        executable=executable,
        command_prefix=(str(fixture), mode),
        expected_owner_uid=os.getuid(),
        executable_owner_uid=executable.stat().st_uid,
        timeout_seconds=timeout,
    )
    secret = bytearray(KEY)
    with pytest.raises(BackendFailure, match=code):
        encryptor.encrypt(secret, 1)
    assert secret == bytearray(len(KEY))
    assert not encryptor.stage_path(1).exists()


@pytest.mark.skipif(sys.platform != "linux", reason="Linux fork/exec boundary")
@pytest.mark.parametrize("reported", [0, len(KEY) + 1])
def test_systemd_creds_short_write_is_fail_closed(
    tmp_path: Path,
    reported: int,
) -> None:
    _database, root = roots(tmp_path)
    fixture = Path(__file__).parent / "fixtures" / "fake_systemd_creds.py"
    executable = Path(sys.executable).resolve()
    encryptor = SystemdCredsEncryptor(
        root,
        executable=executable,
        command_prefix=(str(fixture), "ok"),
        expected_owner_uid=os.getuid(),
        executable_owner_uid=executable.stat().st_uid,
        write=lambda _descriptor, _data: reported,
    )
    secret = bytearray(KEY)
    with pytest.raises(BackendFailure, match="ENCRYPT_SHORT_WRITE"):
        encryptor.encrypt(secret, 1)
    assert secret == bytearray(len(KEY))
    assert not encryptor.stage_path(1).exists()
