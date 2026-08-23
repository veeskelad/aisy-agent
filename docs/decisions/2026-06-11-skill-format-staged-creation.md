# ADR-0015: Skill Format + Staged Creation

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** skills

## Context
Skills are Aisy's procedural memory — reusable "how to" recipes the agent loads on demand.
They are shared with the wider ecosystem (Claude Code, anima_sdk), so the format must be a
portable, human-readable contract rather than a bespoke internal blob. Two pressures shape it:

- **Prompt budget.** The always-loaded prefix is already ~9-10k tokens. We cannot afford to
  inline every skill body. Only a menu (name + description) can live in the prompt; full bodies
  must load lazily on trigger, mirroring the three-step memory loading pattern.
- **Self-improvement safety.** The nightly loop lets the agent author and edit skills. Writing
  agent-generated skills straight to prod is exactly how Hermes fossilized a transient failure
  into learned helplessness (issue #6051) — a one-off error became a permanent "I can't do this"
  recipe. An LLM at ~70% adherence cannot be the final gate on what becomes durable behavior.

## Decision
Skills are `SKILL.md` files with YAML frontmatter (`name`, `description` ≤60 chars, `version`,
`provenance`, `triggers`) and a **mandatory `verification` section**; only the menu sits in the
prompt, the body loads on trigger, and usage telemetry lives in a sidecar (never mutating the
skill file). Any skill the agent creates or edits lands in **staging** and requires human
approval before prod; each approved save is a git commit.

- **Format.** Frontmatter is the machine-readable contract; `description` is capped at 60 chars
  so the prompt menu stays cheap. `provenance` records origin (human / agent-authored / imported)
  and `triggers` drive lazy loading. The `verification` section is required: a skill with no way
  to check its own success is rejected at save time.
- **Lazy loading.** Menu (name+description) is the only thing in the prefix. On trigger, the body
  loads; this keeps skill cost off the byte-identical KV-cache prefix.
- **Sidecar telemetry.** Hit counts, last-used, failure rate live outside `SKILL.md`, so the file
  stays a clean, diffable, shareable artifact and the prefix stays stable for cache reuse.
- **Staging gate.** Agent-authored/edited skills go to a staging area. A review card surfaces the
  full text with **save / edit / test** actions. Only on human approval is the skill committed to
  prod git. The deterministic gate — not the model — decides what becomes procedural memory.

## Consequences
- **Positive:** Skills are portable and ecosystem-compatible; the prompt menu stays tiny while
  bodies load on demand; the staging gate structurally prevents the Hermes #6051 fossilization
  failure; git history gives auditable, revertible skill evolution.
- **Neutral:** `description` ≤60 chars forces terse, trigger-oriented naming; telemetry lives in a
  second store that must be joined for analytics.
- **Negative:** A human is in the loop for every agent-authored skill, so self-improvement is
  gated by reviewer throughput; staging adds a promotion step versus writing files in place.

## Alternatives considered
**Write agent skills straight to prod.** Fastest self-improvement loop, but it is precisely
Hermes's mistake: a transient failure gets encoded as a permanent recipe (#6051), and a ~70%
agent has no deterministic check on what it persists. Rejected — the speed is not worth turning
errors into durable helplessness.

**Inline skill bodies in the prompt.** Removes lazy-loading complexity, but every skill then taxes
the always-loaded prefix and bloats the KV-cached region. Rejected on token budget.

**Custom binary/DB skill store instead of `SKILL.md`.** Could embed telemetry inline, but breaks
ecosystem interop with Claude Code / anima_sdk and makes skills non-diffable in git. Rejected.

## References
- Hermes issue #6051 — skill fossilized from a transient failure (learned helplessness).
- [ADR-0016](./2026-06-11-generator-judge-self-learning.md) — nightly loop that authors skills.
- [ADR-0025](./2026-06-11-transient-vs-permanent-skill-failure.md) — human-approval staging gate.
