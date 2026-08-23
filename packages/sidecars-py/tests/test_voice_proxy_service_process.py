from __future__ import annotations

import json
import multiprocessing
import os
import shutil
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

import pytest

from aisy_sidecars.voice_proxy_service import PROTOCOL

pytestmark = pytest.mark.skipif(
    sys.platform != "linux"
    or os.geteuid() != 0
    or os.environ.get("AISY_SYSTEM_VOICE_TEST") != "1",
    reason="opt-in disposable root Linux test",
)

CONTROL = Path("/run/aisy/voice-control.sock")
CONFIG = Path("/etc/aisy/voice-proxy.json")
STATE = Path("/var/lib/aisy/voice")
RUNTIME_UID = 65534


def _runtime_request(queue: multiprocessing.Queue[object]) -> None:
    os.setgid(RUNTIME_UID)
    os.setuid(RUNTIME_UID)
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.connect(str(CONTROL))
    request_id = "A" * 32
    request = json.dumps([
        PROTOCOL,
        request_id,
        "begin",
        ["d" * 64, "telegram:42", "default", "deepgram-cloud"],
        0,
    ], separators=(",", ":")).encode()
    connection.sendall(struct.pack(">I", len(request)) + request)
    size = struct.unpack(">I", connection.recv(4))[0]
    response = bytearray()
    while len(response) < size:
        response.extend(connection.recv(size - len(response)))
    connection.close()
    queue.put(json.loads(response))


def test_real_broker_process_serves_exact_runtime_uid() -> None:
    if any(path.exists() for path in (CONFIG, STATE, CONTROL.parent)):
        pytest.skip("disposable paths are not empty")
    CONFIG.parent.mkdir(parents=True, mode=0o755)
    CONFIG.write_text(json.dumps({
        "schemaVersion": 1,
        "runtimeUid": RUNTIME_UID,
        "runtimeCgroup": "/not-used-by-control-test",
        "release": "test-release",
        "installationHash": "d" * 64,
    }, separators=(",", ":")))
    CONFIG.chmod(0o644)
    process = subprocess.Popen(
        [sys.executable, "-m", "aisy_sidecars.voice_proxy_service", "broker"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    try:
        deadline = time.monotonic() + 5
        while not CONTROL.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        assert process.poll() is None
        queue: multiprocessing.Queue[object] = multiprocessing.Queue()
        client = multiprocessing.Process(target=_runtime_request, args=(queue,))
        client.start()
        client.join(timeout=5)
        assert client.exitcode == 0
        response = queue.get(timeout=1)
        assert isinstance(response, list)
        assert response[:3] == [PROTOCOL, "A" * 32, "ok"], response
        assert response[3][0] == "challenge"
        assert isinstance(response[3][1], str) and len(response[3][1]) >= 20
        status = json.loads(Path("/run/aisy/voice-status.json").read_text())
        assert status == {
            "schemaVersion": 1,
            "backend": "ready",
            "key": "unconfigured",
            "proxy": "ready",
            "outbox": "ready",
        }
    finally:
        process.terminate()
        process.wait(timeout=5)
        shutil.rmtree(Path("/run/aisy"), ignore_errors=True)
        shutil.rmtree(STATE, ignore_errors=True)
        try:
            STATE.parent.rmdir()
        except OSError:
            pass
        CONFIG.unlink(missing_ok=True)
