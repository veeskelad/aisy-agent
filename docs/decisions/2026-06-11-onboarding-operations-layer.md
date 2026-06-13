# ADR-0034: Onboarding & Operations Layer

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** onboarding, devex, architecture

## Context

`VISION.md` deferred onboarding by design: "Not a no-code product (at least not first). The first audience can edit a config and read a log." In practice the only path from a fresh clone to a running agent is hand-editing `.env`, and the only health probe is `pnpm sandbox:doctor`, which checks Docker and nothing else. There is no credential validation, no store initialization helper, no guided first-run, and no way to ask "is my install healthy?".

A competitive audit of nine comparable harnesses (2026-06-11) found this is the gap class, not an isolated miss. The two projects that won the most adoption — OpenClaw and Hermes — **both** ship a setup wizard (`onboard` / `setup`), a `doctor` health-check, and a guided first-run conversation. Several competitors that lacked operational guardrails shipped catastrophic day-0 failures: auth off by default (hundreds of thousands of publicly-exposed instances, RCE CVEs), no spend caps ($150–3 600/mo bills), and destructive auto-runs. Meanwhile Aisy's *engine* (durable forgetting, sandbox, injection classifier, vault, spend caps, separate-judge consolidation, trace verification) is stronger than every competitor surveyed. **The gap is the operational shell around a well-designed engine.**

## Decision

Add a new component, **#13 Onboarding & Operations** (`docs/specs/13-onboarding-and-operations.md`), and **amend the `VISION.md` "no-code" non-goal**.

The component owns, as deterministic code: `aisy init` (idempotent, resumable wizard that detects prerequisites, validates credentials, scaffolds config + memory tree, seeds the vault, initializes the SQLite index); `aisy doctor` (full-stack health-check, read-only by default, `--fix`/`--json`/`--post-upgrade`, folding `sandbox:doctor`); `aisy diagnostics` (redacted support bundle); a `BOOTSTRAP.md` guided first-run conversation; and in-session Telegram commands (`/status`, `/usage`, `/context`, `/doctor`, `/consolidate`).

The VISION amendment: Aisy remains **not a no-code product** and everything stays a file the operator can edit and a log they can read — but day-0 is now **guided and validated**, not a raw config-editing cliff. The model's only role in this layer is the wording of the BOOTSTRAP conversation; all validation, scaffolding, health checks, and the "setup complete" flag are code. The engine (01–12) is untouched.

## Consequences

- **Positive:** correct, validated day-0 in minutes instead of trial-and-error; silent misconfiguration (bad key, un-indexed memory, missing cron) surfaces as a red `doctor` line instead of a runtime crash; parity with the adoption winners on the exact axis that converts newcomers; a single command to verify health after every upgrade.
- **Neutral:** a thirteenth component, a CLI surface, and a documented `.env` schema that `init` and `doctor` share as the single source of truth.
- **Negative:** more code to maintain and keep in sync with the `.env` schema and each subsystem's health contract; the wizard and `doctor` must evolve alongside specs 02/03/05/09/10/12.

## Alternatives considered

- **Keep hand-edit-only (status quo).** Rejected: every surveyed harness that won adoption ships a wizard + doctor; the status quo guarantees silent failures and abandoned installs even for a technical audience.
- **Docs-only quick-start guide.** Rejected: a guide explains steps but validates nothing — the operator still discovers a bad key or un-indexed store at runtime.
- **Full no-code product.** Rejected: conflicts with the single-user technical audience and the file-editable principle; the goal is a *validated* day-0, not hiding the config.

## References

- Spec: [13 Onboarding & Operations](../specs/13-onboarding-and-operations.md)
- Related ADRs: [ADR-0035](./2026-06-11-install-and-packaging.md), [ADR-0036](./2026-06-11-cost-transparency-surfacing.md), [ADR-0037](./2026-06-11-eval-and-red-team-harness.md), [ADR-0011](./2026-06-11-autonomy-gradient.md), [ADR-0012](./2026-06-11-docker-sandbox-default.md), [ADR-0029](./2026-06-11-human-confirmation-provenance-binding.md)
- Competitive audit: `memory/competitive-landscape.md` (workflow wa4slw1x5)
