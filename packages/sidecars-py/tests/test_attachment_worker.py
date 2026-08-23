from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from aisy_sidecars import attachment_worker as worker


def envelope(op: str, **extra: object) -> dict[str, object]:
    return {
        "version": worker.PROTOCOL_VERSION,
        "requestId": "req-1",
        "op": op,
        **extra,
    }


def failure(op: str, **extra: object) -> str:
    response, exit_code = worker._response_for(json.dumps(envelope(op, **extra)).encode())
    assert exit_code == 2
    return response["error"]["code"]


def copy_request(
    operation: str,
    source_root: Path,
    destination_root: Path,
    payload: bytes,
    *,
    destination_path: str,
) -> dict[str, object]:
    return envelope(
        operation,
        sourceRoot=str(source_root),
        sourcePath="objects/upload-1",
        destinationRoot=str(destination_root),
        destinationPath=destination_path,
        operationId="a" * 64,
        expectedSha256=hashlib.sha256(payload).hexdigest(),
        expectedSizeBytes=len(payload),
        maxBytes=1024 * 1024,
    )


def test_reads_exact_inbox_record_and_rejects_duplicate_keys(tmp_path: Path) -> None:
    records = tmp_path / "records"
    records.mkdir()
    record = {"schemaVersion": 1, "fileId": "upload-1", "originalName": "данные.bin"}
    (records / "upload-1.json").write_text(json.dumps(record), encoding="utf-8")

    response = worker.handle_request(
        envelope(
            "read-record",
            root=str(tmp_path),
            path="records/upload-1.json",
            maxBytes=worker.MAX_RECORD_BYTES,
        ),
    )

    assert response["data"] == {"record": record}
    (records / "upload-1.json").write_text('{"fileId":"a","fileId":"b"}')
    assert failure(
        "read-record",
        root=str(tmp_path),
        path="records/upload-1.json",
        maxBytes=worker.MAX_RECORD_BYTES,
    ) == "INVALID_REQUEST"


def test_stages_and_installs_binary_without_overwrite(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    staging = tmp_path / "staging"
    project = tmp_path / "project"
    (inbox / "objects").mkdir(parents=True)
    staging.mkdir()
    project.mkdir()
    payload = b"\x00\xffAisy\n\x80"
    (inbox / "objects" / "upload-1").write_bytes(payload)

    staged = worker.handle_request(
        copy_request("stage", inbox, staging, payload, destination_path=f"{'a' * 64}.bin"),
    )
    installed_request = copy_request(
        "install",
        staging,
        project,
        payload,
        destination_path="knowledge/imports/upload-1",
    )
    installed_request["sourcePath"] = f"{'a' * 64}.bin"
    installed = worker.handle_request(installed_request)
    retried = worker.handle_request(installed_request)

    assert staged["data"] == {"status": "staged"}
    assert installed["data"] == {"status": "installed"}
    assert retried["data"] == {"status": "already-installed"}
    assert (project / "knowledge" / "imports" / "upload-1").read_bytes() == payload

    (project / "imports").mkdir()
    (project / "imports" / "upload-1").write_bytes(b"other")
    collision_request = dict(installed_request)
    collision_request["destinationPath"] = "imports/upload-1"
    assert worker.handle_request(collision_request)["data"] == {"status": "collision"}
    assert (project / "imports" / "upload-1").read_bytes() == b"other"


def test_install_recovers_owned_link_boundary_after_process_crash(tmp_path: Path) -> None:
    staging = tmp_path / "staging"
    project = tmp_path / "project"
    staging.mkdir()
    destination = project / "imports"
    destination.mkdir(parents=True)
    payload = b"recover-me"
    source = staging / f"{'a' * 64}.bin"
    source.write_bytes(payload)
    temporary = destination / f".aisy-import-{'a' * 64}.tmp"
    temporary.write_bytes(payload)
    os.link(temporary, destination / "upload-1")
    request = copy_request(
        "install",
        staging,
        project,
        payload,
        destination_path="imports/upload-1",
    )
    request["sourcePath"] = source.name

    result = worker.handle_request(request)

    assert result["data"] == {"status": "already-installed"}
    assert not temporary.exists()
    assert os.stat(destination / "upload-1").st_nlink == 1


def test_symlinks_hardlinks_and_hash_changes_fail_closed(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    staging = tmp_path / "staging"
    outside = tmp_path / "outside"
    (inbox / "objects").mkdir(parents=True)
    staging.mkdir()
    outside.mkdir()
    payload = b"expected"
    source = inbox / "objects" / "upload-1"
    source.write_bytes(payload)

    source.unlink()
    source.symlink_to(outside / "secret")
    (outside / "secret").write_bytes(payload)
    request = copy_request("stage", inbox, staging, payload, destination_path=f"{'a' * 64}.bin")
    assert failure(**request) == "SYMLINK_DENIED"

    source.unlink()
    source.write_bytes(payload)
    os.link(source, inbox / "objects" / "alias")
    assert failure(**request) == "HARDLINK_DENIED"
    (inbox / "objects" / "alias").unlink()

    source.write_bytes(b"tampered")
    assert failure(**request) == "HASH_MISMATCH"


def test_verify_reports_missing_and_rejects_path_escape(tmp_path: Path) -> None:
    missing = worker.handle_request(
        envelope(
            "verify",
            root=str(tmp_path),
            path="objects/missing",
            maxBytes=1024,
        ),
    )
    assert missing["data"] == {"exists": False}
    assert failure(
        "verify",
        root=str(tmp_path),
        path="../escape",
        maxBytes=1024,
    ) == "INVALID_PATH"
