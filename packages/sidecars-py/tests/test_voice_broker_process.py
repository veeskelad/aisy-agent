from __future__ import annotations

import array
import ctypes
import fcntl
import multiprocessing
import os
import socket
import struct
import sys
from dataclasses import replace
from multiprocessing.connection import Connection
from pathlib import Path

import pytest

from aisy_sidecars.voice_credential_broker import (
    BootstrapEvidence,
    BootstrapPolicy,
    BrokerFailure,
    grant_private_session,
    proc_cgroup,
    proc_start_ticks,
    verify_bootstrap,
)

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="Linux kernel boundary")


def _receive_private_descriptor(path: str, result: Connection) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
        result.send((False, -1))
        return
    bootstrap = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    bootstrap.connect(path)
    data, ancillary, _flags, _address = bootstrap.recvmsg(
        1,
        socket.CMSG_SPACE(array.array("i").itemsize),
        socket.MSG_CMSG_CLOEXEC,
    )
    descriptors = array.array("i")
    for level, kind, payload in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            descriptors.frombytes(
                payload[: len(payload) - (len(payload) % descriptors.itemsize)]
            )
    if data != b"A" or len(descriptors) != 1:
        result.send((False, -1))
        return
    descriptor = descriptors[0]
    cloexec = bool(fcntl.fcntl(descriptor, fcntl.F_GETFD) & fcntl.FD_CLOEXEC)
    os.write(descriptor, b"child")
    os.close(descriptor)
    bootstrap.close()
    result.send((cloexec, os.getpid()))


def test_kernel_peer_gets_one_cloexec_private_session(tmp_path: Path) -> None:
    path = tmp_path / "bootstrap.sock"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    listener.bind(str(path))
    listener.listen(1)
    parent_result, child_result = multiprocessing.Pipe(duplex=False)
    process = multiprocessing.get_context("fork").Process(
        target=_receive_private_descriptor,
        args=(str(path), child_result),
    )
    process.start()
    accepted, _address = listener.accept()
    assert process.pid is not None
    start = proc_start_ticks(process.pid)
    cgroup = proc_cgroup(process.pid)
    policy = BootstrapPolicy(os.getuid(), process.pid, start, cgroup, "release-a")

    def inspect(pid: int) -> BootstrapEvidence:
        return BootstrapEvidence(
            pid,
            os.getuid(),
            proc_start_ticks(pid),
            proc_cgroup(pid),
            "release-a",
            False,
        )

    broker_end = grant_private_session(accepted, policy, inspect)
    data, ancillary, _flags, _address = broker_end.recvmsg(
        16,
        socket.CMSG_SPACE(struct.calcsize("3i")),
    )
    credentials = [
        struct.unpack("3i", payload[: struct.calcsize("3i")])
        for level, kind, payload in ancillary
        if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS
    ]
    assert data == b"child"
    assert credentials == [(process.pid, os.getuid(), os.getgid())]
    assert parent_result.recv() == (True, process.pid)

    process.join(timeout=5)
    assert process.exitcode == 0
    broker_end.close()
    accepted.close()
    listener.close()


@pytest.mark.parametrize(
    ("peer_pid_delta", "peer_uid_delta", "evidence_changes"),
    [
        (1, 0, {}),
        (0, 1, {}),
        (0, 0, {"pid": 12}),
        (0, 0, {"uid": 34}),
        (0, 0, {"start_ticks": 56}),
        (0, 0, {"cgroup": "/foreign.service"}),
        (0, 0, {"release": "foreign"}),
        (0, 0, {"dumpable": True}),
    ],
)
def test_bootstrap_refuses_every_identity_mismatch(
    peer_pid_delta: int,
    peer_uid_delta: int,
    evidence_changes: dict[str, object],
) -> None:
    policy = BootstrapPolicy(1000, 2000, 3000, "/aisy.service", "release-a")
    evidence = BootstrapEvidence(2000, 1000, 3000, "/aisy.service", "release-a", False)
    with pytest.raises(BrokerFailure, match="BOOTSTRAP_REFUSED"):
        verify_bootstrap(
            2000 + peer_pid_delta,
            1000 + peer_uid_delta,
            replace(evidence, **evidence_changes),
            policy,
        )
