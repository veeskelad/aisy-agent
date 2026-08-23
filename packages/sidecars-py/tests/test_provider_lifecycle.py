from __future__ import annotations

import hashlib
import json
import os
import socket
import sqlite3
import threading
from collections.abc import Callable
from pathlib import Path

import pytest

from aisy_sidecars.provider_broker_protocol import (
    FRAME_DATA,
    FRAME_END,
    FRAME_ERROR,
    FRAME_HEADER,
    encode_frame,
    encode_json_frame,
    error_frame,
)
from aisy_sidecars.provider_broker_service import open_journal
from aisy_sidecars.provider_lifecycle import (
    CHALLENGE_TTL_NS,
    ProviderBinding,
    ProviderLifecycleFailure,
    ProviderLifecyclePolicy,
    begin_challenge,
    claim_challenge,
    encrypt_host_material,
    handle_control_connection,
    initialize_lifecycle,
    inspect_binding,
    reconcile_lifecycle,
    revoke_binding,
)
from aisy_sidecars.provider_worker import receive_frame

INSTALLATION = "a" * 64
RELEASE = "b" * 64
MATERIAL = bytearray(b"provider-test-material")


def policy(tmp_path: Path) -> ProviderLifecyclePolicy:
    return ProviderLifecyclePolicy(
        INSTALLATION,
        RELEASE,
        tmp_path,
        tmp_path / "validators",
        os.getuid(),
    )


def journal(tmp_path: Path) -> sqlite3.Connection:
    result = open_journal(tmp_path / "journal.sqlite")
    initialize_lifecycle(result)
    return result


def binding(provider: str = "openai") -> ProviderBinding:
    return ProviderBinding("operator-1", "profile-1", provider)


def fake_encrypt(material: bytearray, target: Path, expected_owner: int) -> str:
    assert expected_owner == os.getuid()
    payload = b"ciphertext:" + hashlib.sha256(material).hexdigest().encode("ascii")
    target.write_bytes(payload)
    target.chmod(0o600)
    return hashlib.sha256(payload).hexdigest()


def test_challenge_is_exact_bounded_one_use_and_superseded(tmp_path: Path) -> None:
    store = journal(tmp_path)
    first, first_expiry = begin_challenge(store, policy(tmp_path), binding(), now_ns=10)
    second, second_expiry = begin_challenge(store, policy(tmp_path), binding(), now_ns=20)

    assert first != second
    assert first_expiry == 10 + CHALLENGE_TTL_NS
    assert second_expiry == 20 + CHALLENGE_TTL_NS
    with pytest.raises(ProviderLifecycleFailure, match="CHALLENGE_REPLAY_REFUSED"):
        claim_challenge(store, policy(tmp_path), first, now_ns=21)
    claimed = claim_challenge(store, policy(tmp_path), second, now_ns=21)
    assert claimed.provider_id == "openai"
    with pytest.raises(ProviderLifecycleFailure, match="CHALLENGE_REPLAY_REFUSED"):
        claim_challenge(store, policy(tmp_path), second, now_ns=22)

    expired, expiry = begin_challenge(store, policy(tmp_path), binding(), now_ns=30)
    with pytest.raises(ProviderLifecycleFailure, match="CHALLENGE_EXPIRED"):
        claim_challenge(store, policy(tmp_path), expired, now_ns=expiry)
    store.close()


def test_binding_is_refused_when_provider_is_not_configured(tmp_path: Path) -> None:
    store = journal(tmp_path)
    restricted = ProviderLifecyclePolicy(
        INSTALLATION,
        RELEASE,
        tmp_path,
        tmp_path / "validators",
        os.getuid(),
        ("openai",),
    )

    with pytest.raises(ProviderLifecycleFailure, match="BINDING_REFUSED"):
        begin_challenge(store, restricted, binding("anthropic"))

    assert store.execute("SELECT COUNT(*) FROM provider_challenges").fetchone() == (0,)
    store.close()


def _validating_connector(
    store: sqlite3.Connection,
) -> tuple[Callable[[Path], socket.socket], list[str], threading.Thread]:
    broker, worker = socket.socketpair()
    observations: list[str] = []

    def validator() -> None:
        kind, payload = receive_frame(worker)
        assert kind == FRAME_HEADER
        request = json.loads(payload)
        assert request["providerId"] == "openai"
        kind, material = receive_frame(worker)
        assert kind == FRAME_DATA
        assert hashlib.sha256(material).hexdigest() == request["materialSha256"]
        assert receive_frame(worker) == (FRAME_END, b"")
        worker.sendall(encode_json_frame(FRAME_HEADER, {"schemaVersion": 1, "state": "valid"}))
        worker.sendall(encode_frame(FRAME_END))
        worker.close()

    thread = threading.Thread(target=validator)
    thread.start()

    def connect(path: Path) -> socket.socket:
        assert path.name == "validator-openai.sock"
        phase = store.execute(
            "SELECT phase FROM provider_challenges ORDER BY created_ns DESC LIMIT 1"
        ).fetchone()
        observations.append(phase[0])
        return broker

    return connect, observations, thread


def _submit_header(code: str, material: bytearray) -> bytes:
    return json.dumps(
        {
            "schemaVersion": 1,
            "action": "submit",
            "code": code,
            "materialLength": len(material),
            "materialSha256": hashlib.sha256(material).hexdigest(),
        },
        separators=(",", ":"),
    ).encode()


def test_submit_claims_before_read_and_rotates_a_b_without_plaintext_state(tmp_path: Path) -> None:
    store = journal(tmp_path)
    code, _expiry = begin_challenge(store, policy(tmp_path), binding())
    client, broker = socket.socketpair()
    material = bytearray(MATERIAL)
    captured: list[bytearray] = []
    connect, observations, validator_thread = _validating_connector(store)

    def encrypt(value: bytearray, target: Path, owner: int) -> str:
        captured.append(value)
        return fake_encrypt(value, target, owner)

    def client_side() -> None:
        client.sendall(encode_frame(FRAME_HEADER, _submit_header(code, material)))
        kind, payload = receive_frame(client)
        assert kind == FRAME_HEADER
        assert json.loads(payload) == {"schemaVersion": 1, "state": "claimed"}
        client.sendall(encode_frame(FRAME_DATA, material))
        client.sendall(encode_frame(FRAME_END))
        kind, payload = receive_frame(client)
        assert kind == FRAME_HEADER
        assert json.loads(payload)["revision"] == 1
        assert receive_frame(client) == (FRAME_END, b"")

    thread = threading.Thread(target=client_side)
    thread.start()
    handle_control_connection(
        broker,
        store,
        policy(tmp_path),
        attest=lambda _connection, action: observations.append(action),
        connect_validator=connect,
        encrypt=encrypt,
    )
    thread.join(timeout=5)
    validator_thread.join(timeout=5)

    row = store.execute(
        "SELECT phase, credential_revision, active_slot FROM provider_lifecycle WHERE provider_id='openai'"
    ).fetchone()
    assert row == ("ready", 1, "a")
    assert (tmp_path / "openai.a.cred").stat().st_ino == (tmp_path / "openai.active.cred").stat().st_ino
    assert observations[-2:] == ["submit", "claimed"]
    assert captured and captured[0] == bytearray(len(MATERIAL))
    raw_database = (tmp_path / "journal.sqlite").read_bytes()
    assert bytes(MATERIAL) not in raw_database
    store.close()
    client.close()
    broker.close()


def test_validation_failure_keeps_proven_active_revision(tmp_path: Path) -> None:
    store = journal(tmp_path)
    first_code, _expiry = begin_challenge(store, policy(tmp_path), binding())
    first = claim_challenge(store, policy(tmp_path), first_code)
    from aisy_sidecars.provider_lifecycle import rotate_material

    assert rotate_material(store, policy(tmp_path), first, bytearray(MATERIAL), encrypt=fake_encrypt)[0] == 1
    original = inspect_binding(store, policy(tmp_path), binding())
    second_code, _expiry = begin_challenge(store, policy(tmp_path), binding())
    client, broker = socket.socketpair()
    validator_broker, validator_worker = socket.socketpair()
    material = bytearray(b"different-provider-material")
    encrypted = False

    def client_side() -> None:
        client.sendall(encode_frame(FRAME_HEADER, _submit_header(second_code, material)))
        assert receive_frame(client)[0] == FRAME_HEADER
        client.sendall(encode_frame(FRAME_DATA, material))
        client.sendall(encode_frame(FRAME_END))
        assert receive_frame(client)[0] == FRAME_ERROR

    def validator_side() -> None:
        assert receive_frame(validator_worker)[0] == FRAME_HEADER
        assert receive_frame(validator_worker)[0] == FRAME_DATA
        assert receive_frame(validator_worker)[0] == FRAME_END
        validator_worker.sendall(error_frame("MATERIAL_REJECTED", attempted=False))

    def should_not_encrypt(_value: bytearray, _target: Path, _owner: int) -> str:
        nonlocal encrypted
        encrypted = True
        raise AssertionError

    client_thread = threading.Thread(target=client_side)
    validator_thread = threading.Thread(target=validator_side)
    client_thread.start()
    validator_thread.start()
    with pytest.raises(ProviderLifecycleFailure, match="MATERIAL_REJECTED"):
        handle_control_connection(
            broker,
            store,
            policy(tmp_path),
            attest=lambda _connection, _action: None,
            connect_validator=lambda _path: validator_broker,
            encrypt=should_not_encrypt,
        )
    client_thread.join(timeout=5)
    validator_thread.join(timeout=5)
    assert encrypted is False
    assert inspect_binding(store, policy(tmp_path), binding()) == original
    assert store.execute(
        "SELECT phase FROM provider_challenges ORDER BY created_ns DESC LIMIT 1"
    ).fetchone() == ("terminal",)
    store.close()
    client.close()
    broker.close()
    validator_worker.close()


def test_restart_finishes_only_attested_committing_slot(tmp_path: Path) -> None:
    store = journal(tmp_path)
    payload = bytearray(MATERIAL)
    digest = fake_encrypt(payload, tmp_path / "openai.a.cred", os.getuid())
    store.execute(
        "INSERT INTO provider_lifecycle VALUES "
        "('openai', ?, ?, ?, 'committing', 0, NULL, ?, NULL, 'a', ?, 1, ?, 1)",
        (INSTALLATION, "c" * 64, "d" * 64, digest, digest, RELEASE),
    )

    reconcile_lifecycle(store, policy(tmp_path))

    assert store.execute(
        "SELECT phase, credential_revision, active_slot FROM provider_lifecycle WHERE provider_id='openai'"
    ).fetchone() == ("ready", 1, "a")
    assert (tmp_path / "openai.active.cred").stat().st_ino == (tmp_path / "openai.a.cred").stat().st_ino

    upgraded = ProviderLifecyclePolicy(INSTALLATION, "e" * 64, tmp_path, tmp_path / "validators", os.getuid())
    reconcile_lifecycle(store, upgraded)
    assert store.execute(
        "SELECT release_digest, credential_revision FROM provider_lifecycle WHERE provider_id='openai'"
    ).fetchone() == ("e" * 64, 1)

    (tmp_path / "openai.active.cred").write_bytes(b"drift")
    (tmp_path / "openai.active.cred").chmod(0o600)
    reconcile_lifecycle(store, policy(tmp_path))
    assert store.execute(
        "SELECT phase FROM provider_lifecycle WHERE provider_id='openai'"
    ).fetchone() == ("unavailable",)
    store.close()


def test_revoke_deletes_both_slots_and_restart_does_not_restore(tmp_path: Path) -> None:
    store = journal(tmp_path)
    code, _expiry = begin_challenge(store, policy(tmp_path), binding())
    claimed = claim_challenge(store, policy(tmp_path), code)
    from aisy_sidecars.provider_lifecycle import rotate_material

    rotate_material(store, policy(tmp_path), claimed, bytearray(MATERIAL), encrypt=fake_encrypt)
    (tmp_path / "openai.b.cred").write_bytes(b"stale-ciphertext")
    (tmp_path / "openai.b.cred").chmod(0o600)

    revoke_binding(store, policy(tmp_path), binding(), "approval_" + "x" * 32)
    reconcile_lifecycle(store, policy(tmp_path))

    assert inspect_binding(store, policy(tmp_path), binding()) == {"state": "unconfigured"}
    assert not list(tmp_path.glob("openai.*.cred"))
    store.close()


@pytest.mark.skipif(not hasattr(os, "fork"), reason="fork is required")
def test_host_encrypt_uses_exact_fd_contract_without_plaintext_artifact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable = tmp_path / "systemd-creds-test"
    executable.write_text(
        "#!/bin/sh\n"
        "[ \"$1\" = encrypt ] || exit 9\n"
        "[ \"$2\" = --with-key=host ] || exit 9\n"
        "[ \"$3\" = --name=aisy-provider ] || exit 9\n"
        "[ \"$4\" = - ] || exit 9\n"
        "[ \"$5\" = - ] || exit 9\n"
        "dd of=/dev/null bs=8192 count=1 2>/dev/null\n"
        "printf test-host-ciphertext\n"
    )
    executable.chmod(0o755)
    import aisy_sidecars.provider_lifecycle as lifecycle

    monkeypatch.setattr(lifecycle, "SYSTEMD_CREDS", executable)
    monkeypatch.setattr(lifecycle, "_child_security", lambda: None)
    if not hasattr(os, "pipe2"):
        def pipe2(_flags: int) -> tuple[int, int]:
            descriptors = os.pipe()
            os.set_inheritable(descriptors[0], False)
            os.set_inheritable(descriptors[1], False)
            return descriptors

        monkeypatch.setattr(os, "pipe2", pipe2, raising=False)
    target = tmp_path / "openai.a.cred"
    material = bytearray(MATERIAL)

    digest = encrypt_host_material(material, target, os.getuid())

    assert target.read_bytes() == b"test-host-ciphertext"
    assert digest == hashlib.sha256(b"test-host-ciphertext").hexdigest()
    assert target.stat().st_mode & 0o777 == 0o600
    assert bytes(MATERIAL) not in target.read_bytes()
    assert sorted(path.name for path in tmp_path.iterdir()) == ["openai.a.cred", "systemd-creds-test"]
