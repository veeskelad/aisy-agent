#!/usr/bin/env bash
# Aisy harness — one-liner bootstrap (ADR-0035).
# Lands you at `aisy init`. Builds native deps from source against your Node ABI.
set -euo pipefail

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ missing prerequisite: $1 ($2)"; exit 1; }; }

echo "→ checking prerequisites"
need node "Node 22 LTS — https://nodejs.org"
# Docker is optional: only the opt-in bash sandbox (AISY_SANDBOX_IMAGE) uses it.
command -v docker >/dev/null 2>&1 || echo "ℹ Docker not found — fine; it's only needed if you enable the bash sandbox (AISY_SANDBOX_IMAGE)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "✗ Node ${NODE_MAJOR} found; Aisy needs ≥22"; exit 1; }

echo "→ enabling pnpm (corepack)"
corepack enable >/dev/null 2>&1 || true

echo "→ installing dependencies (native modules build from source)"
pnpm install --frozen-lockfile

echo "→ building"
pnpm -r build

echo
echo "✓ installed. Next:"
echo "    cp .env.example .env   # add provider keys + Telegram token"
echo "    aisy init              # validate & scaffold (idempotent)"
echo "    aisy doctor            # full-stack health check"
