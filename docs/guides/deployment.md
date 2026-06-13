# Deployment

Single-user, self-hosted. No multi-tenant/SaaS mode (VISION non-goals).

## Topologies

| | Use | Notes |
|---|---|---|
| **Native (VPS/laptop)** | dev, simplest | `scripts/install.sh`; Node 22 + Docker ≥24 on the host |
| **Docker Compose** | durable VPS | `docker compose up -d`; memory in `./data`, secrets in `.env` |

## Prerequisites

- **Node 22 LTS**, **pnpm ≥9** (via corepack), **Docker ≥24**.
- Optional: **gVisor (runsc)** runtime for stronger sandbox isolation (ADR-0012);
  Aisy falls back to standard Docker and `doctor` reports the degraded level.
- Optional: **ffmpeg** + a Whisper model for voice (spec 02 sidecar).

## The sandbox & the Docker socket

The harness runs each tool task in a fresh, network-denied, cap-dropped
container (spec 05, ADR-0012). To orchestrate them it talks to the host Docker
engine. The compose file mounts `/var/run/docker.sock` — this is
**host-root-equivalent**:

- Only on a host you fully trust. Never expose the socket (or the harness) to
  untrusted ingress.
- The harness's own config/compose are **read-only outside the agent namespace**
  (a Phase-5 review fix; mounting the agent's own compose writable was the
  AutoGPT CVE-2023-37273 class).
- Prefer gVisor where available.

## Secrets & backup

- Secrets live in `.env` / `secrets/` (git-ignored) and the runtime vault; never
  in the image or git history.
- Memory is markdown + SQLite in `AISY_MEMORY_ROOT`, **git-backed**. Nightly
  consolidation pushes a fast-forward-only backup (spec 10) and reports the
  result on the morning card. Configure `AISY_BACKUP_REMOTE`.
- **Restore** (spec 10): re-clone the backup remote into `AISY_MEMORY_ROOT`, then
  `aisy doctor` rebuilds the SQLite index and re-applies the forget invariant
  (a forgotten fact never reappears post-restore).

## Upgrades

`aisy doctor --post-upgrade` is the gate: it re-checks the contracts most likely
to drift across a version bump (env schema, MCP descriptor-hash pins, provider
model ids). A failing post-upgrade check blocks serving until fixed.

## Compliance

If operating under the EU AI Act (applicability Aug 2026), see
[../compliance/eu-ai-act.md](../compliance/eu-ai-act.md) for the obligation map.
