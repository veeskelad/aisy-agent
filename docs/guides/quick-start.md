# Quick start

> Pre-alpha. The `aisy` CLI wires the (already-tested) onboarding logic to real
> adapters in v0.2 — see [Status](#status). The steps below are the target flow.

Aisy is a **single-user** personal agent harness you self-host. Zero-to-running:

## 1. Install

```bash
# one-liner (checks Node 22 + Docker, installs, builds native deps from source)
bash scripts/install.sh
# — or — containerized:
docker compose build
```

## 2. Configure

```bash
cp .env.example .env
$EDITOR .env
```

Fill at minimum:

| Var | What |
|---|---|
| `AISY_PROVIDER_REASONING_KEY` / `_CRITIQUE_KEY` / `_ROUTINE_KEY` | provider API keys (3-tier router, spec 09) |
| `AISY_TELEGRAM_BOT_TOKEN` | your bot token (from @BotFather) |
| `AISY_TELEGRAM_CHAT_ID` | **exactly one** chat id — the single-user allowlist |
| `AISY_MEMORY_ROOT` | path to the git-backed memory tree (default `./data/memory`) |

`.env` and `secrets/` are git-ignored and vault-backed at runtime — keys never
enter the live prompt (spec 05).

## 3. Validate & scaffold

```bash
aisy init      # idempotent: validates keys/token, scaffolds SOUL.md/constitution.md/AGENTS.md/USER.md,
               # inits the memory git repo + SQLite FTS5 index. Re-run is safe.
aisy doctor    # full-stack health check: env, providers, telegram, memory, vault,
               # sandbox, mcp, nightly, sidecars, disk, clock. Exit 0 = healthy.
```

`aisy doctor --json` is byte-deterministic and secret-free — use it as a CI gate.

## 4. First conversation (BOOTSTRAP)

Message your bot. On the first message the agent reads `BOOTSTRAP.md` and walks
you through naming it, picking a persona, setting a default autonomy tier, and
budget caps — each committed by **tapping a confirmation card**, never by the
model itself (spec 13, ADR-0029).

## In-session commands

`/status` (model routing + context + cost) · `/usage` (spend breakdown) ·
`/context` (what's injected) · `/doctor` (health) · `/consolidate` (trigger a
nightly consolidation pass into the staging gate).

## Status

- ✅ Onboarding logic (`init`/`doctor`/`diagnostics`), 13 engine components — implemented, 450 tests green.
- 📋 v0.2: the `aisy` bin wires real adapters (fs/prereq/provider-ping/Telegram/SQLite/Docker probes); triggers + context-engine run.

See [deployment.md](deployment.md) and [operations-runbook.md](operations-runbook.md).
