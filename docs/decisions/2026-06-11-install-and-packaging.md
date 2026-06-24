# ADR-0035: Install & Packaging

**Status:** Accepted
**Date:** 2026-06-11
**Tags:** packaging, devex, install

> **Partially superseded by [ADR-0056](./2026-06-24-npm-package-distribution.md) (2026-06-24):**
> the "reject `npm i -g` only" stance below was predicated on bundling the Python
> Whisper sidecar — but 0.1.0 ships **pure Node** (voice is deferred and, per
> ADR-0056, handled by multimodal providers rather than a bundled sidecar), so npm
> is viable and becomes the **primary** distribution. The **Docker/Compose
> deployment path proposed here is removed** (deleted; its sidecar-bundling
> rationale is gone and `npm i -g` + systemd covers self-host — see ADR-0056);
> `scripts/install.sh` remains as the from-source path, and Docker stays only as
> the opt-in bash-sandbox runtime. The "build-from-source over pinned binaries"
> principle still holds for native deps (`better-sqlite3`). Re-introduce a
> deployment image only if a Python sidecar or container-deploy demand returns.

## Context

Aisy is pre-alpha: no published npm/PyPI package, no Docker Compose, no container image, no install script. The documented path is a manual loop (clone → nvm → corepack → pnpm install → pnpm build). The competitive audit (2026-06-11) showed every surveyed harness offers a lower-friction entry: one-liner installers (`npm i -g`, `curl … | sh`), Docker Compose bundles, or both.

It also showed a concrete failure class to avoid: **Leon** distributes pre-built platform binaries with hard version pins, and its top recurring issues are install failures from that choice — GLIBC mismatches, a TCP-server binary built against Python 3.9 failing on 3.12, corrupted binary downloads with no integrity check, and a renamed upstream CLI command breaking the install script. Shipping pinned binaries trades a smooth happy path for a long tail of environment-specific breakage.

This component needs a defined entrypoint that lands the operator at `aisy init` (ADR-0034) without that tail.

## Decision

Ship two supported install paths, both ending at `aisy init`:

1. **One-liner bootstrap script** that checks prerequisites (Node 22, pnpm ≥9, Docker ≥24), clones/installs, builds, and prints the `aisy init` next step.
2. **Docker Compose** bundling the Node core and the Python sidecars (Whisper), with a published, versioned, multi-arch container image.

Prefer **build-from-source or containerized execution over shipping pinned platform binaries.** Where a native dependency is unavoidable (e.g. `better-sqlite3`), it is built at install time against the operator's actual runtime, not fetched as a pinned prebuilt that can mismatch the host. Apache-2.0 and the GPL/AGPL hard-block (ADR-0002) apply to every bundled dependency.

## Consequences

- **Positive:** a newcomer reaches `aisy init` in one command or one `docker compose up`; no GLIBC/DLL/version-mismatch tail; the image is reproducible and pinned by digest.
- **Neutral:** CI must build, test, and publish the image and verify the install script on the supported OS matrix; the monorepo (ADR-0003) already separates the TS core from Python sidecars cleanly for this.
- **Negative:** an install script and a Dockerfile to maintain across OSes; container image size; build-from-source adds first-install time for native deps.

## Alternatives considered

- **Pinned platform binaries (Leon's model).** Rejected: directly reproduces the documented GLIBC / Python-ABI / corrupted-download failure class.
- **`npm i -g` only.** Rejected: Node-version sensitivity and global-install permission issues; does not cover the Python sidecars.
- **Docker-only.** Rejected as the *sole* path: excludes operators who want a native dev loop; kept as one of the two supported paths.

## References

- Related ADRs: [ADR-0003 Monorepo](./2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md), [ADR-0012 Docker sandbox](./2026-06-11-docker-sandbox-default.md), [ADR-0002 Apache-2.0](./2026-06-11-apache-2-0-license.md), [ADR-0034 Onboarding & operations](./2026-06-11-onboarding-operations-layer.md)
- Spec: [13 Onboarding & Operations](../specs/13-onboarding-and-operations.md)
- Competitive audit: `memory/competitive-landscape.md`
