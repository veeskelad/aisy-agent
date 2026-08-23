#!/usr/bin/python3.12 -I
"""Root-owned forced-command launcher for Aisy sidecar delivery."""

from __future__ import annotations

import stat
import sys
from pathlib import Path

ROOT = Path("/usr/lib/aisy/bootstrap")
PACKAGE = ROOT / "aisy_sidecars"
DIRECTORIES = (Path("/usr"), Path("/usr/lib"), Path("/usr/lib/aisy"), ROOT, PACKAGE)
FILES = (PACKAGE / "__init__.py", PACKAGE / "sidecar_bundle_delivery.py")

try:
    for path in DIRECTORIES:
        info = path.lstat()
        if (
            path.resolve(strict=True) != path
            or not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_mode & 0o022
        ):
            raise OSError
    for path in FILES:
        info = path.lstat()
        if (
            path.resolve(strict=True) != path
            or not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o644
        ):
            raise OSError
except OSError:
    raise SystemExit(70) from None

sys.path.insert(0, str(ROOT))

from aisy_sidecars.sidecar_bundle_delivery import receiver_main

raise SystemExit(receiver_main())
