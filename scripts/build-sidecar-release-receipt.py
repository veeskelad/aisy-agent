#!/usr/bin/env python3
"""Build one canonical Aisy sidecar release receipt."""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path

REPOSITORY = Path(__file__).resolve(strict=True).parent.parent
SIDECARS = REPOSITORY / "packages/sidecars-py"
sys.path.insert(0, str(SIDECARS))

from aisy_sidecars.sidecar_bundle_delivery import (
    BundleDeliveryFailure,
    build_receipt,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--component", required=True, choices=("provider", "voice"))
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    values = parser.parse_args(argv)
    try:
        if (
            not values.bundle.is_absolute()
            or values.bundle.resolve(strict=True) != values.bundle
            or not values.output.is_absolute()
            or values.output.exists()
            or not values.output.parent.is_dir()
        ):
            raise BundleDeliveryFailure("BUNDLE_SOURCE_REFUSED")
        raw = build_receipt(values.bundle, values.component)
        descriptor = os.open(
            values.output,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o644,
        )
        try:
            offset = 0
            while offset < len(raw):
                written = os.write(descriptor, raw[offset:])
                if written <= 0:
                    raise OSError
                offset += written
            os.fchmod(descriptor, 0o644)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        parent = os.open(values.output.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        print(hashlib.sha256(raw).hexdigest())
        return 0
    except (OSError, BundleDeliveryFailure) as error:
        code = str(error) if isinstance(error, BundleDeliveryFailure) else "BUNDLE_SOURCE_REFUSED"
        print(code, file=sys.stderr)
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
