#!/usr/bin/python3.12
"""Root-owned launcher for the manifest-verified provider broker installer."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve(strict=True).parent
if ROOT != Path(__file__).absolute().parent:
    raise SystemExit(70)
sys.path.insert(0, str(ROOT))

from aisy_sidecars.provider_proxy_install import main

raise SystemExit(main())
