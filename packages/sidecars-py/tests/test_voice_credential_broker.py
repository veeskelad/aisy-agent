from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from aisy_sidecars.voice_credential_broker import (
    BrokerFailure,
    CredentialClaim,
    VoiceCredentialBroker,
)
from aisy_sidecars.voice_protocol import (
    MAX_CONTROL_BYTES,
    BrokerFrame,
    ProtocolFailure,
    SessionSequence,
    decode_request,
)

INSTALLATION = "installation-sentinel-9f62"
OPERATOR = "operator-sentinel-73aa"
PROFILE = "profile-sentinel-a410"
RECOVERY = "reservation-sentinel-d905"
CIPHERTEXT_HASH = "a" * 64


def private_database(tmp_path: Path) -> Path:
    root = tmp_path / "private"
    root.mkdir(mode=0o700)
    root.chmod(0o700)
    return root / "broker.db"


def activate(broker: VoiceCredentialBroker, *, now: int = 100) -> str:
    challenge = broker.begin_enrollment(INSTALLATION, OPERATOR, PROFILE, now=now)
    claim = broker.claim_enrollment(
        challenge.code,
        INSTALLATION,
        OPERATOR,
        PROFILE,
        now=now + 1,
    )
    binding = broker.binding_hash(INSTALLATION, OPERATOR, PROFILE)
    claimed_binding, revision = broker.begin_validation(claim, now=now + 2)
    assert claimed_binding == binding
    broker.mark_committing(binding, revision, CIPHERTEXT_HASH, now=now + 3)
    broker.publish_credential(binding, revision, CIPHERTEXT_HASH, now=now + 4)
    return binding


def test_enrollment_and_publish_store_only_public_hashed_metadata(
    tmp_path: Path,
) -> None:
    database = private_database(tmp_path)
    with VoiceCredentialBroker(database) as broker:
        challenge = broker.begin_enrollment(INSTALLATION, OPERATOR, PROFILE, now=1_000)
        assert len(challenge.code) == 32
        assert challenge.expires_at == 1_600
        claim = broker.claim_enrollment(
            challenge.code, INSTALLATION, OPERATOR, PROFILE, now=1_001
        )
        binding = broker.binding_hash(INSTALLATION, OPERATOR, PROFILE)
        assert broker.begin_validation(claim, now=1_002) == (binding, 1)
        with pytest.raises(BrokerFailure, match="CLAIM_REFUSED"):
            broker.begin_validation(claim, now=1_003)
        with pytest.raises(BrokerFailure, match="CLAIM_REFUSED"):
            broker.begin_validation(CredentialClaim(), now=1_003)
        broker.mark_committing(binding, 1, CIPHERTEXT_HASH, now=1_004)
        broker.publish_credential(binding, 1, CIPHERTEXT_HASH, now=1_005)
        status = broker.inspect(binding)
        assert status["state"] == "ready"
        assert status["revision"] == 1
        assert isinstance(status["handle"], str)
        assert broker.active_credential() == (binding, 1, status["handle"])
        permit = broker.prepare_permit(binding, 1, RECOVERY, now=1_006)
        broker._connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    stored = b"".join(
        path.read_bytes() for path in database.parent.iterdir() if path.is_file()
    )
    for raw in (INSTALLATION, OPERATOR, PROFILE, RECOVERY, challenge.code, permit):
        assert raw.encode() not in stored


def test_challenge_is_exact_binding_one_use_and_superseding(tmp_path: Path) -> None:
    database = private_database(tmp_path)
    with VoiceCredentialBroker(database) as broker:
        old = broker.begin_enrollment(INSTALLATION, OPERATOR, PROFILE, now=100)
        current = broker.begin_enrollment(INSTALLATION, OPERATOR, PROFILE, now=101)
        assert any(
            event.kind == "voice.enrollment-superseded"
            for event in broker.pending_events()
        )
        with pytest.raises(BrokerFailure, match="CHALLENGE_REFUSED"):
            broker.claim_enrollment(old.code, INSTALLATION, OPERATOR, PROFILE, now=102)
        with pytest.raises(BrokerFailure, match="CHALLENGE_REFUSED"):
            broker.claim_enrollment(
                current.code, INSTALLATION, OPERATOR, "foreign", now=102
            )
        broker.claim_enrollment(current.code, INSTALLATION, OPERATOR, PROFILE, now=102)
        with pytest.raises(BrokerFailure, match="CHALLENGE_REFUSED"):
            broker.claim_enrollment(
                current.code, INSTALLATION, OPERATOR, PROFILE, now=102
            )


def test_public_code_claim_resolves_binding_once_without_raw_ids(tmp_path: Path) -> None:
    database = private_database(tmp_path)
    with VoiceCredentialBroker(database) as broker:
        challenge = broker.begin_enrollment(INSTALLATION, OPERATOR, PROFILE, now=100)
        claim = broker.claim_enrollment_code(challenge.code, now=101)
        binding = broker.binding_hash(INSTALLATION, OPERATOR, PROFILE)
        assert broker.begin_validation(claim, now=102) == (binding, 1)
        with pytest.raises(BrokerFailure, match="CHALLENGE_REFUSED"):
            broker.claim_enrollment_code(challenge.code, now=103)


def test_expired_challenge_is_durably_refused(tmp_path: Path) -> None:
    database = private_database(tmp_path)
    with VoiceCredentialBroker(database) as broker:
        challenge = broker.begin_enrollment(INSTALLATION, OPERATOR, PROFILE, now=100)
        with pytest.raises(BrokerFailure, match="CHALLENGE_REFUSED"):
            broker.claim_enrollment(
                challenge.code, INSTALLATION, OPERATOR, PROFILE, now=700
            )
        assert any(
            event.kind == "voice.enrollment-expired"
            for event in broker.pending_events()
        )


def test_concurrent_challenge_claim_has_one_winner(tmp_path: Path) -> None:
    database = private_database(tmp_path)
    with VoiceCredentialBroker(database) as broker:
        challenge = broker.begin_enrollment(INSTALLATION, OPERATOR, PROFILE, now=100)

    def claim() -> bool:
        with VoiceCredentialBroker(database) as contender:
            try:
                contender.claim_enrollment(
                    challenge.code, INSTALLATION, OPERATOR, PROFILE, now=101
                )
            except BrokerFailure:
                return False
            return True

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _index: claim(), range(2))) == [False, True]


def test_transaction_fault_rolls_back_transition_and_outbox(tmp_path: Path) -> None:
    database = private_database(tmp_path)
    with VoiceCredentialBroker(database) as broker:
        binding = activate(broker)
        permit = broker.prepare_permit(binding, 1, RECOVERY, now=110)
        baseline = [event.event_id for event in broker.pending_events()]

    def fail(point: str) -> None:
        if point == "before-commit:transition-permit":
            raise RuntimeError("simulated crash")

    with VoiceCredentialBroker(database, fault=fail) as broker:
        with pytest.raises(RuntimeError, match="simulated crash"):
            broker.transition_permit(permit, "claimed", now=111)
        assert [event.event_id for event in broker.pending_events()] == baseline

    with VoiceCredentialBroker(database) as broker:
        broker.transition_permit(permit, "claimed", now=112)


def test_outbox_replays_same_event_until_idempotent_ack(tmp_path: Path) -> None:
    database = private_database(tmp_path)
    with VoiceCredentialBroker(database) as broker:
        broker.begin_enrollment(INSTALLATION, OPERATOR, PROFILE, now=100)
        event_id = broker.pending_events()[0].event_id
    with VoiceCredentialBroker(database) as broker:
        assert broker.pending_events()[0].event_id == event_id
        broker.ack_event(event_id, now=101)
        broker.ack_event(event_id, now=102)
        assert broker.pending_events() == []


def test_restart_conservatively_terminalizes_nonterminal_permits(
    tmp_path: Path,
) -> None:
    database = private_database(tmp_path)
    with VoiceCredentialBroker(database) as broker:
        binding = activate(broker)
        prepared = broker.prepare_permit(binding, 1, f"{RECOVERY}-p", now=200)
        claimed = broker.prepare_permit(binding, 1, f"{RECOVERY}-c", now=200)
        attempted = broker.prepare_permit(binding, 1, f"{RECOVERY}-a", now=200)
        broker.transition_permit(claimed, "claimed", now=201)
        broker.transition_permit(attempted, "claimed", now=201)
        broker.transition_permit(attempted, "attempted", now=202)
        before = {event.event_id for event in broker.pending_events()}
    with VoiceCredentialBroker(database) as broker:
        assert before <= {event.event_id for event in broker.pending_events()}
        assert broker.reconcile_restart(now=203) == 3
        terminal = [
            event.kind for event in broker.pending_events() if event.created_at == 203
        ]
        assert terminal.count("voice.permit-terminal-none") == 1
        assert terminal.count("voice.permit-terminal-attempted") == 2
        assert all(
            "recoveryHash" in event.payload
            for event in broker.pending_events()
            if event.created_at == 203
        )
        for permit in (prepared, claimed, attempted):
            with pytest.raises(BrokerFailure, match="PERMIT_REFUSED"):
                broker.transition_permit(permit, "claimed", now=204)


def test_permit_expires_at_exact_deadline_without_claim(tmp_path: Path) -> None:
    database = private_database(tmp_path)
    with VoiceCredentialBroker(database) as broker:
        binding = activate(broker)
        permit = broker.prepare_permit(binding, 1, RECOVERY, now=300)
        with pytest.raises(BrokerFailure, match="PERMIT_REFUSED"):
            broker.transition_permit(permit, "claimed", now=420)
        assert any(
            event.kind == "voice.permit-terminal-none"
            for event in broker.pending_events()
        )


def test_corrupt_and_future_schema_are_not_reinitialized(tmp_path: Path) -> None:
    corrupt = private_database(tmp_path)
    corrupt.write_bytes(b"not-a-sqlite-database")
    corrupt.chmod(0o600)
    before = corrupt.read_bytes()
    with pytest.raises(BrokerFailure, match="STATE_INTEGRITY_REFUSED"):
        VoiceCredentialBroker(corrupt)
    assert corrupt.read_bytes() == before

    future_root = tmp_path / "future"
    future_root.mkdir(mode=0o700)
    future_root.chmod(0o700)
    future = future_root / "broker.db"
    with VoiceCredentialBroker(future) as broker:
        broker._connection.execute("PRAGMA user_version=2")
    with pytest.raises(BrokerFailure, match="STATE_SCHEMA_REFUSED"):
        VoiceCredentialBroker(future)

    drift_root = tmp_path / "drift"
    drift_root.mkdir(mode=0o700)
    drift_root.chmod(0o700)
    drift = drift_root / "broker.db"
    with VoiceCredentialBroker(drift):
        pass
    with sqlite3.connect(drift) as connection:
        connection.execute("PRAGMA writable_schema=ON")
        connection.execute(
            "UPDATE sqlite_schema SET sql=replace(sql,'event_id TEXT PRIMARY KEY',"
            "'event_id BLOB PRIMARY KEY') WHERE name='audit_outbox'"
        )
        connection.execute("PRAGMA writable_schema=OFF")
        connection.execute("PRAGMA schema_version=2")
    with pytest.raises(BrokerFailure, match="STATE_SCHEMA_REFUSED"):
        VoiceCredentialBroker(drift)


def test_private_directory_and_database_modes_are_enforced(tmp_path: Path) -> None:
    root = tmp_path / "open"
    root.mkdir(mode=0o700)
    root.chmod(0o755)
    with pytest.raises(BrokerFailure, match="PRIVATE_STATE_REFUSED"):
        VoiceCredentialBroker(root / "broker.db")

    private = tmp_path / "actual"
    private.mkdir(mode=0o700)
    private.chmod(0o700)
    target = private / "target"
    target.write_bytes(b"x")
    target.chmod(0o600)
    link = private / "broker.db"
    link.symlink_to(target)
    with pytest.raises(BrokerFailure, match="PRIVATE_STATE_REFUSED"):
        VoiceCredentialBroker(link)

    mode_root = tmp_path / "mode"
    mode_root.mkdir(mode=0o700)
    mode_root.chmod(0o700)
    mode_database = mode_root / "broker.db"
    with VoiceCredentialBroker(mode_database):
        pass
    mode_database.chmod(0o644)
    with pytest.raises(BrokerFailure, match="PRIVATE_STATE_REFUSED"):
        VoiceCredentialBroker(mode_database)


def test_protocol_rejects_extensions_duplicates_bounds_and_replay() -> None:
    payload = {
        "schemaVersion": 1,
        "sequence": 1,
        "operation": "stage-media",
        "payload": {
            "installationHash": "1" * 64,
            "bindingHash": "2" * 64,
            "audioSha256": "3" * 64,
            "audioBytes": 42,
            "contentType": "audio/ogg",
        },
    }
    frame = decode_request(json.dumps(payload).encode())
    sequence = SessionSequence()
    sequence.accept(frame)
    with pytest.raises(ProtocolFailure, match="SEQUENCE_REFUSED"):
        sequence.accept(frame)

    payload["extension"] = True
    with pytest.raises(ProtocolFailure, match="MALFORMED_FRAME"):
        decode_request(json.dumps(payload).encode())
    with pytest.raises(ProtocolFailure, match="MALFORMED_FRAME"):
        decode_request(b'{"schemaVersion":1,"schemaVersion":1}')
    with pytest.raises(ProtocolFailure, match="FRAME_BOUNDS"):
        decode_request(b"x" * (MAX_CONTROL_BYTES + 1))
    payload.pop("extension")
    payload["operation"] = []
    with pytest.raises(ProtocolFailure, match="MALFORMED_FRAME"):
        decode_request(json.dumps(payload).encode())
    payload["operation"] = "stage-media"
    payload["schemaVersion"] = True
    with pytest.raises(ProtocolFailure, match="MALFORMED_FRAME"):
        decode_request(json.dumps(payload).encode())
    with pytest.raises(ProtocolFailure, match="SEQUENCE_REFUSED"):
        SessionSequence().accept(
            BrokerFrame(2, "dispatch", {"dispatchPermitId": "x" * 20})
        )
