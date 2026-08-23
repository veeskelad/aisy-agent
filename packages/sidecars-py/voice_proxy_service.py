#!/usr/bin/python3.12
"""Root-owned launcher for the versioned Aisy voice proxy package."""

from __future__ import annotations

import sys
from pathlib import Path

release_root = Path(__file__).resolve(strict=True).parent
if release_root != Path(__file__).absolute().parent:
    raise SystemExit(70)
sys.path.insert(0, str(release_root))

from aisy_sidecars.voice_proxy_service import main

raise SystemExit(main())
