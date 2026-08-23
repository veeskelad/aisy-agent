# Quick start

> Pre-alpha. The production CLI and Telegram composition are connected; exact
> target acceptance and intentionally dormant surfaces are tracked in the
> [production matrix](../reviews/2026-08-23-production-readiness-matrix.md).

Aisy is a **single-user** personal agent harness you self-host. Zero-to-running:

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/veeskelad/aisy-agent/master/scripts/install.sh | bash
# optional local npm channel: npm install -g @aisy/app
```

Managed install поддерживает `aisy update`, offline `aisy update --rollback` и
`aisy update --cleanup`. Для dev loop используйте frozen workspace install и
build из checkout, не production bootstrap.

## 2. Configure and pair

```bash
aisy init
```

Interactive setup selects the brain, accepts the Telegram bot token and performs
terminal-side pairing with exactly one chat. A pairing request arriving as a
Telegram message never grants authority. On headless Linux, native provider and
cloud-voice secrets are enrolled later through a one-use code plus a local
no-echo TTY; never paste them into Telegram or a model-visible message.

## 3. Validate

```bash
aisy doctor
```

`aisy init` is idempotent. `aisy doctor` is read-only by default and reports
redacted provider, Telegram, memory, MCP, sandbox and sidecar readiness.
`aisy doctor --json` is deterministic and secret-free.

## 4. Install the supervisor

```bash
aisy service install
aisy service status
```

The service runs `aisy supervise`; direct `aisy run` remains the explicit
rollback/development path without supervisor recovery authority.

## 5. First conversation

Open the paired bot and send a text message. Use `/menu` for Projects, Sessions,
Skills, MCP, Monitoring and Agent settings. Approval buttons are one-use and
bound to the exact card; a model-authored message cannot confirm itself.

## Status

- ✅ Telegram, scoped memory, tools, Skills, stdio MCP, monitoring, goals and
  supervised sub-agents are wired in the production binary.
- 🚧 Cloud voice/native provider enrollment and the clean managed-distribution
  cutover require the target gates named in the production matrix.
- 🧊 HTTP MCP, arbitrary provider origins and a shared IDE control plane are not
  silently enabled.

See [deployment.md](deployment.md) and [operations-runbook.md](operations-runbook.md).
