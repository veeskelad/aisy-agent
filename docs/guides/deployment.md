# Deployment

Single-user, self-hosted. No multi-tenant/SaaS mode (VISION non-goals).

## Topologies

| | Use | Notes |
|---|---|---|
| **npm** (`npm i -g @aisy/app`) | simplest | Node 22; `aisy init` → `aisy run` |
| **systemd service** | durable VPS | `aisy.service` (see [README](../../README.md) Quickstart); `Restart=on-failure`, `journalctl -u aisy` |
| **From source** | dev loop | `scripts/install.sh`; Node 22 + pnpm ≥9 |

## Prerequisites

- **Node 22 LTS** (npm install); **pnpm ≥9** (via corepack) for the from-source path.
- Optional: **Docker ≥24** — only for the opt-in bash sandbox (`AISY_SANDBOX_IMAGE`);
  **gVisor (runsc)** for stronger isolation (ADR-0012), Aisy falls back to standard
  Docker and `doctor` reports the degraded level.
- Optional: voice is served by a multimodal provider, or a self-installed transcriber.

## The sandbox & the Docker socket

When the bash sandbox is enabled, the harness runs each tool task in a fresh,
network-denied, cap-dropped container (spec 05, ADR-0012). To orchestrate them it
talks to the host Docker engine — grant the agent's OS user access to
`/var/run/docker.sock`. That socket is **host-root-equivalent**:

- Only on a host you fully trust. Never expose the socket (or the harness) to
  untrusted ingress.
- The harness's own config is **read-only outside the agent namespace** (a Phase-5
  review fix; letting the agent rewrite its own runtime config was the AutoGPT
  CVE-2023-37273 class).
- Prefer gVisor where available. If you don't enable the sandbox, the `bash` tool
  simply reports unavailable and Docker isn't required at all.

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
