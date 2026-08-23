from __future__ import annotations

import ctypes
import json
import os
import resource
import sys
import time


def open_descriptors() -> list[int]:
    result: list[int] = []
    for descriptor in range(64):
        try:
            os.fstat(descriptor)
        except OSError:
            continue
        result.append(descriptor)
    return result


def main() -> int:
    mode = sys.argv[1]
    owned = bytearray(sys.stdin.buffer.read())
    try:
        if mode == "sleep":
            time.sleep(5)
        if mode == "stderr":
            sys.stderr.buffer.write(b"x" * 9000)
            sys.stderr.buffer.flush()
        if mode == "fail":
            return 9
        dumpable = None
        if sys.platform == "linux":
            dumpable = ctypes.CDLL(None).prctl(3, 0, 0, 0, 0)  # PR_GET_DUMPABLE
        payload = {
            "argv": sys.argv[2:],
            "coreLimit": resource.getrlimit(resource.RLIMIT_CORE),
            "cwd": os.getcwd(),
            "dumpable": dumpable,
            "environment": dict(os.environ),
            "fds": open_descriptors(),
            "inputConsumed": bool(owned),
            "nofileLimit": resource.getrlimit(resource.RLIMIT_NOFILE),
            "umask": oct(os.umask(0o077)),
        }
        os.umask(0o077)
        sys.stdout.buffer.write(json.dumps(payload, sort_keys=True).encode())
        sys.stdout.buffer.flush()
        return 0
    finally:
        owned[:] = b"\0" * len(owned)


if __name__ == "__main__":
    raise SystemExit(main())
