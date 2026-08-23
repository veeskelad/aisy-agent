"""Credential-free Git clone worker for a capped one-shot container tmpfs."""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

PROTOCOL_VERSION = 1
EXECUTION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
FORBIDDEN_ENV = re.compile(
    r"(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|SSH_AUTH_SOCK|AWS_|GITHUB_|GITLAB_)",
    re.IGNORECASE,
)


class WorkerFailure(Exception):
    """Redacted worker failure."""


@dataclass(frozen=True)
class WorkerPolicy:
    execution_id: str
    policy_hash: str
    url: str
    proxy_url: str
    wall_time_ms: int

    @classmethod
    def from_environment(cls, env: Mapping[str, str]) -> WorkerPolicy:
        execution_id = env.get("AISY_EXECUTION_ID", "")
        policy_hash = env.get("AISY_POLICY_HASH", "")
        url = env.get("AISY_CLONE_URL", "")
        proxy_url = env.get("AISY_HTTPS_PROXY", "")
        wall_time = env.get("AISY_WALL_TIME_MS", "")
        if not EXECUTION_ID.fullmatch(execution_id) or not SHA256.fullmatch(policy_hash):
            raise WorkerFailure("INVALID_POLICY")
        if proxy_url != "http://egress:3128":
            raise WorkerFailure("INVALID_POLICY")
        try:
            parsed = urlsplit(url)
            timeout = int(wall_time, 10)
        except (TypeError, ValueError):
            raise WorkerFailure("INVALID_POLICY") from None
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
            or parsed.query
            or parsed.fragment
            or parsed.path in ("", "/")
            or not 1_000 <= timeout <= 600_000
        ):
            raise WorkerFailure("INVALID_POLICY")
        for key, value in env.items():
            if value and FORBIDDEN_ENV.search(key):
                raise WorkerFailure("CREDENTIAL_ENV_DENIED")
        return cls(execution_id, policy_hash, url, proxy_url, timeout)


def git_argv(policy: WorkerPolicy, destination: Path) -> list[str]:
    return [
        "git",
        "-c", "core.hooksPath=/dev/null",
        "-c", "credential.helper=",
        "-c", "http.followRedirects=false",
        "-c", f"http.proxy={policy.proxy_url}",
        "-c", "protocol.file.allow=never",
        "-c", "submodule.recurse=false",
        "clone",
        "--no-recurse-submodules",
        "--",
        policy.url,
        str(destination),
    ]


def git_environment(policy: WorkerPolicy) -> dict[str, str]:
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "HOME": "/nonexistent",
        "GIT_ALLOW_PROTOCOL": "https",
        "GIT_PROTOCOL_FROM_USER": "0",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_LFS_SKIP_SMUDGE": "1",
        "GIT_ASKPASS": "/bin/false",
        "SSH_ASKPASS": "/bin/false",
        "HTTPS_PROXY": policy.proxy_url,
        "https_proxy": policy.proxy_url,
        "NO_PROXY": "",
        "no_proxy": "",
    }


Runner = Callable[..., subprocess.CompletedProcess[bytes]]


def _status(path: Path, policy: WorkerPolicy, status: str) -> None:
    payload = json.dumps(
        {
            "version": PROTOCOL_VERSION,
            "executionId": policy.execution_id,
            "policyHash": policy.policy_hash,
            "status": status,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    temporary = path.with_suffix(".tmp")
    with temporary.open("xb") as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def run_clone(
    policy: WorkerPolicy,
    workspace: Path,
    run_root: Path,
    *,
    runner: Runner = subprocess.run,
    wait_after_success: bool = True,
) -> int:
    if not workspace.is_dir() or any(workspace.iterdir()):
        raise WorkerFailure("WORKSPACE_NOT_EMPTY")
    if not run_root.is_dir() or any(run_root.iterdir()):
        raise WorkerFailure("RUN_ROOT_NOT_EMPTY")
    destination = workspace / "repo"
    try:
        result = runner(
            git_argv(policy, destination),
            cwd="/",
            env=git_environment(policy),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=max(1.0, policy.wall_time_ms / 1000),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        _status(run_root / "failed.json", policy, "failed")
        return 2
    if result.returncode != 0 or not destination.is_dir():
        _status(run_root / "failed.json", policy, "failed")
        return 2
    _status(run_root / "ready.json", policy, "ready")
    if wait_after_success:
        while True:
            signal.pause()
    return 0


def main() -> int:
    os.umask(0o077)
    try:
        policy = WorkerPolicy.from_environment(os.environ)
        if len(sys.argv) == 2 and sys.argv[1] == "status":
            ready = Path("/run/aisy/ready.json")
            failed = Path("/run/aisy/failed.json")
            if ready.is_file():
                return 0
            if failed.is_file():
                return 2
            return 1
        if len(sys.argv) != 1:
            return 2
        return run_clone(policy, Path("/workspace"), Path("/run/aisy"))
    except WorkerFailure:
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
