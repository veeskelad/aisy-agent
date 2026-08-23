from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from aisy_sidecars.restricted_clone_egress import (
    GatewayFailure,
    GatewayPolicy,
    connect_reviewed,
    parse_connect_request,
)
from aisy_sidecars.restricted_clone_worker import (
    WorkerFailure,
    WorkerPolicy,
    git_argv,
    git_environment,
    run_clone,
)


def gateway_environment(**overrides: str) -> dict[str, str]:
    return {
        "AISY_EGRESS_HOST": "git.example.org",
        "AISY_EGRESS_IPS_JSON": '["93.184.216.34","2001:4860:4860::8888"]',
        "AISY_EGRESS_MAX_BYTES": str(16 * 1024 * 1024),
        **overrides,
    }


def worker_environment(**overrides: str) -> dict[str, str]:
    return {
        "AISY_EXECUTION_ID": "clone-1",
        "AISY_POLICY_HASH": "a" * 64,
        "AISY_CLONE_URL": "https://git.example.org/team/repo.git",
        "AISY_HTTPS_PROXY": "http://egress:3128",
        "AISY_WALL_TIME_MS": "300000",
        **overrides,
    }


def test_gateway_policy_accepts_only_canonical_public_exact_addresses() -> None:
    policy = GatewayPolicy.from_environment(gateway_environment())

    assert policy.hostname == "git.example.org"
    assert policy.addresses == ("93.184.216.34", "2001:4860:4860::8888")
    assert policy.max_tunnel_bytes == 16 * 1024 * 1024

    for addresses in ('["10.0.0.7"]', '["169.254.169.254"]', '["not-an-ip"]', '[]'):
        with pytest.raises(GatewayFailure):
            GatewayPolicy.from_environment(
                gateway_environment(AISY_EGRESS_IPS_JSON=addresses)
            )

    ipv6_host = GatewayPolicy.from_environment(
        gateway_environment(AISY_EGRESS_HOST="2001:0db8::1")
    )
    assert ipv6_host.hostname == "2001:db8::1"


def test_connect_parser_allows_only_exact_hostname_443_without_proxy_auth() -> None:
    policy = GatewayPolicy.from_environment(gateway_environment())
    parse_connect_request(
        b"CONNECT git.example.org:443 HTTP/1.1\r\n"
        b"Host: git.example.org:443\r\nProxy-Connection: keep-alive\r\n\r\n",
        policy,
    )

    denied = [
        b"CONNECT metadata.internal:443 HTTP/1.1\r\nHost: metadata.internal:443\r\n\r\n",
        b"CONNECT git.example.org:80 HTTP/1.1\r\nHost: git.example.org:80\r\n\r\n",
        b"GET https://git.example.org/ HTTP/1.1\r\nHost: git.example.org:443\r\n\r\n",
        (
            b"CONNECT git.example.org:443 HTTP/1.1\r\nHost: git.example.org:443\r\n"
            b"Proxy-Authorization: Basic abc\r\n\r\n"
        ),
        b"CONNECT git.example.org:443 HTTP/1.1\r\n\r\n",
    ]
    for request in denied:
        with pytest.raises(GatewayFailure):
            parse_connect_request(request, policy)


def test_gateway_dials_reviewed_ips_directly_without_dns_and_fails_over() -> None:
    policy = GatewayPolicy.from_environment(gateway_environment())
    attempts: list[tuple[str, int, float]] = []
    expected_socket = object()

    def connector(address: str, port: int, timeout: float) -> Any:
        attempts.append((address, port, timeout))
        if len(attempts) == 1:
            raise OSError("first IP unavailable")
        return expected_socket

    assert connect_reviewed(policy, connector) is expected_socket
    assert attempts == [
        ("93.184.216.34", 443, 10.0),
        ("2001:4860:4860::8888", 443, 10.0),
    ]


def test_worker_policy_rejects_credentials_redirect_surface_and_wrong_proxy() -> None:
    policy = WorkerPolicy.from_environment(worker_environment())
    assert policy.url == "https://git.example.org/team/repo.git"

    invalid = [
        {"AISY_CLONE_URL": "http://git.example.org/team/repo.git"},
        {"AISY_CLONE_URL": "https://user@git.example.org/team/repo.git"},
        {"AISY_CLONE_URL": "https://git.example.org/team/repo.git?token=x"},
        {"AISY_HTTPS_PROXY": "http://other:3128"},
        {"AWS_SECRET_ACCESS_KEY": "must-not-enter-container"},
        {"AISY_TOKEN": "must-not-enter-container"},
    ]
    for patch in invalid:
        with pytest.raises(WorkerFailure):
            WorkerPolicy.from_environment(worker_environment(**patch))


def test_worker_git_argv_and_environment_are_credential_free_and_hardened(tmp_path: Path) -> None:
    policy = WorkerPolicy.from_environment(worker_environment())
    destination = tmp_path / "repo"
    argv = git_argv(policy, destination)
    environment = git_environment(policy)

    assert argv[-3:] == ["--", policy.url, str(destination)]
    assert "core.hooksPath=/dev/null" in argv
    assert "credential.helper=" in argv
    assert "http.followRedirects=false" in argv
    assert "--no-recurse-submodules" in argv
    assert environment["GIT_ALLOW_PROTOCOL"] == "https"
    assert environment["GIT_TERMINAL_PROMPT"] == "0"
    assert environment["GIT_CONFIG_GLOBAL"] == "/dev/null"
    assert environment["GIT_LFS_SKIP_SMUDGE"] == "1"
    assert environment["HTTPS_PROXY"] == "http://egress:3128"
    assert all("TOKEN" not in key and "PASSWORD" not in key for key in environment)


def test_worker_emits_only_bound_ready_status_and_waits_for_supervisor_export(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    run_root = tmp_path / "run"
    workspace.mkdir()
    run_root.mkdir()
    policy = WorkerPolicy.from_environment(worker_environment())
    seen: dict[str, Any] = {}

    def runner(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        seen["argv"] = argv
        seen.update(kwargs)
        (workspace / "repo").mkdir()
        (workspace / "repo" / "README.md").write_text("# cloned\n")
        return subprocess.CompletedProcess(argv, 0)

    assert run_clone(
        policy,
        workspace,
        run_root,
        runner=runner,
        wait_after_success=False,
    ) == 0
    assert json.loads((run_root / "ready.json").read_text()) == {
        "executionId": "clone-1",
        "policyHash": "a" * 64,
        "status": "ready",
        "version": 1,
    }
    assert "shell" not in seen
    assert seen["stdin"] is subprocess.DEVNULL
    assert seen["stdout"] is subprocess.DEVNULL
    assert seen["stderr"] is subprocess.DEVNULL
    assert seen["env"] == git_environment(policy)


def test_worker_failure_is_redacted_and_does_not_publish_ready(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    run_root = tmp_path / "run"
    workspace.mkdir()
    run_root.mkdir()
    policy = WorkerPolicy.from_environment(worker_environment())

    def runner(argv: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(argv, 128, stderr=b"credential-shaped raw error")

    assert run_clone(
        policy,
        workspace,
        run_root,
        runner=runner,
        wait_after_success=False,
    ) == 2
    assert not (run_root / "ready.json").exists()
    text = (run_root / "failed.json").read_text()
    assert "credential-shaped" not in text
    assert json.loads(text)["status"] == "failed"


def test_worker_requires_empty_quota_workspace_and_run_root(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    run_root = tmp_path / "run"
    workspace.mkdir()
    run_root.mkdir()
    (workspace / "unexpected").write_text("x")
    policy = WorkerPolicy.from_environment(worker_environment())

    with pytest.raises(WorkerFailure, match="WORKSPACE_NOT_EMPTY"):
        run_clone(policy, workspace, run_root, wait_after_success=False)
