# Aisy — Implementation Roadmap

> Living index of remaining work after the multi-provider + budget arc (ADR-0050).
> Detailed, executable plans live in `docs/superpowers/plans/` and are linked per tier.

## Framing — the gap is *wiring*, not building

All 11 core components are **implemented and tested** (memory 106 tests, orchestration/
delegation 32, nightly 34, triggers 14, observability 48, mcp 26, skills 37,
personality 23, tools 32, safety 50, eval 10). The live `aisy run` path
(`packages/app/src/bin/aisy.ts`) only wires a subset; most "not done" items are
**integration of already-green components** plus a handful of genuinely new seams
(runner abort, mid-turn budget halt, delegation runner-seam, doctor read-port).

This reframes effort: prefer wiring + small adapters over greenfield. **S** ≤ half a
day · **M** 1–2 days · **L** 3+ days. Risk = how much it touches the tested agent-loop.

## Tiers

### Tier 1 — make the agent genuinely useful (wire built components; low risk) — ✅ DONE
| # | Task | Effort | Risk | Depends | Status |
|---|------|--------|------|---------|--------|
| 1 | Real memory: `makeMemoryStore` → `MemoryPort` (snapshot/forget) + `search_memory` tool | M | low | memory (built) | ✅ done |
| 2 | Durable `SessionLog` (jsonl append; full crash-resume deferred) | S–M | low | — | ✅ done |
| 3 | Provider-aware `doctor` (read `providers.json`; stop false per-tier failures) | M | low | adds a read-port | ✅ done |

→ **Plan:** [`docs/superpowers/plans/2026-06-16-tier1-live-wiring.md`](./superpowers/plans/2026-06-16-tier1-live-wiring.md)
Shipped in commits `1634b61` (memory adapters), `2c2c2d3` (session log), `ffd46bd` (doctor),
`b8ebe57` (bin wiring), `67d9526` (graceful `search_memory`). 658 core tests green.
Residual surfaced in final review → folded into Tier 2 #4b below.

### Tier 2 — control & safety on the phone (shared loop abort-seam) — ✅ DONE (#4–#6)
| # | Task | Effort | Risk | Depends | Status |
|---|------|--------|------|---------|--------|
| 4 | `/stop` hard-kill: `AbortSignal` through loop → provider | M | med (loop) | — | ✅ done |
| 4b | Catch-all in `bot.ts` `runTurn`: a throwing turn now surfaces an error message + resets state instead of an unhandled rejection. (Found in Tier-1 final review.) Residual: error-detail secret redaction on this path not yet wired. | S | low | — | ✅ done |
| 5 | Mid-turn budget: `Halt('budget-capped')` + budget port in loop | M | med (loop) | shares #4 seam | ✅ done |
| 6 | Live outbound-lockout: `isOutboundLocked`/`narrowed` from safety (UI exists) | M | med | safety (built) | ✅ done |
| 7 | Voice: Whisper sidecar → `transcribeVoice` | M | med | sidecars-py | split to own plan |

→ **Plan:** [`docs/superpowers/plans/2026-06-17-tier2-loop-control.md`](./superpowers/plans/2026-06-17-tier2-loop-control.md) — #4/#5 via ADR-0051 loop seams; #6 wires the live `isOutboundLocked` source (bot mirrors `narrowed` → gateway egress guard) on top of the existing transport-layer hold. #7 (voice) split to its own plan.
Shipped in commits `e5c2408`+`18e65d6`+`92517b5` (#4 abort), `e5c2408`+`53be608`+`92517b5` (#5 budget), `ef09cf3` (#6 outbound-lockout). `be837ee` (#4b catch-all).

### Tier 3 — sub-agents (delegation) — the big capability — ✅ DONE (#8)
| # | Task | Effort | Risk | Depends | Status |
|---|------|--------|------|---------|--------|
| 8 | Export + wire `DelegationManager` into the runner; spawn sub-agents with own model+budget (closes Phase-3 inheritance). **New ADR** for the runner-seam. | L | high | orchestration (built, dormant); budget-tracker keys on agent-id already | ✅ done |

→ **Plan:** [`docs/superpowers/plans/2026-06-19-tier3-subagent-delegation.md`](./superpowers/plans/2026-06-19-tier3-subagent-delegation.md)
Shipped in commits implementing phases A–E (export + `makeSubAgentRunner`, scoped executor, `DelegationDriver` + `spawn_subagent` tool, bin wiring, ADR-0052). ADR-0039 promoted to Accepted; ADR-0052 captures the runner-seam and safety model.
v1 scope: explicit `spawn_subagent` tool (single-task or goal-DAG); concurrent-with-reverify execution; card-scoped isolation (fresh empty GrantStore, `toolTiers` from card, writes confined to `owns` lane); bundled read-only reserved `general` default card; narrowing inherited via the Tier-2 `outboundLocked` mirror (one-turn-stale).
Follow-ups: auto-delegation from a coordinator-emitted multi-task plan; real `skillTouchedPaths`/`mcpWritable` resolution when specs 06/07 go live; precise live narrowing (loop→executor seam); mid-sub-turn budget enforcement.

### Tier 4 — proactivity (after real memory) — ✅ DONE (#9–#10)
| # | Task | Effort | Risk | Depends | Status |
|---|------|--------|------|---------|--------|
| 9 | Nightly consolidation: in-process scheduler + missed-slot catch-up → `ConsolidationRunner` → LLM Generator/Judge (fail-safe) → staging gate (`approveStagedItem`) | M | low | #1 (memory) | ✅ done |
| 10 | Triggers/proactivity: `TriggerEngine` tick loop → operator `/remind` `/schedule` `/watch` `/triggers` `/untrigger` commands → budget-capped proactive turns via bot seam | M–L | med | a scheduler | ✅ done |

→ **Plan:** [`docs/superpowers/plans/2026-06-22-tier4-proactivity.md`](./superpowers/plans/2026-06-22-tier4-proactivity.md)
Shipped across phases A–E (journal sink + scheduler seam, `Memory.listLive()`, Generator/Judge LLM adapters + bridge, `ConsolidationRunner` + scheduler + morning card, trigger commands + `startTurn` proactive seam). ADR-0053 captures all four decisions; ADR-0038 promoted to Accepted. Final-review fixes: `52e10f4` (real commit-on-approve + single shared runner), `4c783f71` (trigger budget debit + proactive-turn concurrency guard).
v1 scope: in-process scheduler + missed-slot catch-up; LLM Generator/Judge with defensive parse + fail-safe staging; staging-gated nightly (Approve tap → `approveStagedItem` + TOCTOU + resurrection-guard); operator trigger commands (`/remind`, `/schedule`, `/watch`, `/triggers`, `/untrigger`); JSONL observability journal (`~/.aisy/journal.jsonl`); phase-1 probes (file/http/exit).
Follow-ups: real `draftSkills`; full hash-chained AuditLog (Component 12); SQL watch probes; `propose_trigger` agent tool; nightly git/hygiene/archive effect seams; judge==generator single-provider fallback; `/watch http:https://…` double-scheme UX; live fact freshness (nightly facts/validators are boot-time-captured until restart).

### Tier 5 — UX polish & small tails (quick wins)
| # | Task | Effort |
|---|------|--------|
| 11 | Debug toggle in ⚙️ Настройки (plan mentioned it, not added) | S |
| 12 | `/grants` listing + "Сбросить гранты" (ADR-0047 tail) | S |
| 13 | Menu actions `Сессии/Навыки/Агент` (currently "в разработке") | M |
| 14 | `aisy setup <element>` per-element re-config; `--help` lists `run/setup` | S |
| 15 | Per-call spend attribution (tiered shows "mixed (per-tier)") | S |

→ Plan: TBD (can batch into one small plan).

### Tier 6 — delivery (pipeline Phase 5–6)
| # | Task | Effort |
|---|------|--------|
| 16 | CI (lint + build + test gate) | M |
| 17 | Packaging / distribution (ADR-0035) | M |

### Tier 7 — goal-driven loop (`/goal`) — ✅ DONE (#18)
| # | Task | Effort | Risk | Status |
|---|------|--------|------|--------|
| 18 | Persistent session objective + verify-until-done loop on top of `runTurn` (à la Claude Code `/goal`; ANIMA persistent-agent model). Completion-condition reuses the existing `VerificationTrace`; budget/guardian/`Halt` + the Tier-4 scheduler (`/loop every 10m`) already exist. **ADR-0054** (loop contract: turn-based → goal-driven). | L | high (loop) | ✅ done |

→ **Plan:** [`docs/superpowers/plans/2026-06-23-tier7-goal-driven-loop.md`](./superpowers/plans/2026-06-23-tier7-goal-driven-loop.md)
Shipped across phases A–F (GoalSpec + store, `goal_done` Tier-0 tool, `makeGoalOrchestrator`, bot seam + `/goal` commands, bin wiring, ADR-0054).
v1 scope: 3 modes (`until` / `every:<interval>` / `budget:<n>`); model-claims → probe-verifies (probe-fail feeds back and continues); always-on backstop (`maxIterations` + token/$ ceiling, env-configurable via `AISY_GOAL_*`); `/stop` + `/goal stop` via goal-scoped `AbortController`; pre-grant read-only default scope; `~/.aisy/goal.json` crash-resume; app-level orchestrator (Core untouched).
Follow-ups: `every` cron/HH:MM scheduling (only relative intervals in v1); goal-store per-tick caching; sub-agent `goal_done` edge case (Core sentinel vs. orchestrator wrapper); single active goal (parallel goals deferred).
Distinct from the goal-DAG (orchestration, ADR-0039 — per-spawn delegation decomposition, not a top-level session goal).

### Tier 8 — caching — ✅ DONE (#19–#20)

> Semantic-caching the live loop is an anti-pattern; prefix caching is the real win (research 2026-06-23).

| # | Task | Effort | Risk | Status |
|---|------|--------|------|--------|
| 19 | **Finish PREFIX caching (ADR-0019)** — emit `cache_control: ephemeral` breakpoints (Anthropic bp1+bp2) + cache-aware tiered cost accounting; per-provider matrix (anthropic / openai-compat / openrouter / cli); `AISY_PREFIX_CACHE` kill-switch. | M | low | ✅ done |
| 20 | Optional narrow exact-cache on eval-replay + nightly generator/judge retries (deterministic, non-stateful). `makeExactCache` decorator; `AISY_NIGHTLY_EXACT_CACHE` opt-in. ADR-0055. | S | low | ✅ done |
| 21 | (Deferred) semantic-response cache ONLY behind the ADR-0031 embedding plugin, scoped to read-only paths, with invariants (no cross-session; invalidate on narrowed/forget; key includes prefixHash) — NEVER the live agent loop (anti-pattern: stateful turns → near-zero hit rate + safety-invariant bypass + key-collision risk). | L | high | deferred |

→ **Plan:** [`docs/superpowers/plans/2026-06-24-tier8-prefix-cache.md`](./superpowers/plans/2026-06-24-tier8-prefix-cache.md)
Shipped across phases A–D (Anthropic bp1+bp2 + cache-aware tiered dollars, OpenAI-compat auto/breakpoints, catalog + bin kill-switch, exact-cache decorator + nightly opt-in). ADR-0019 promoted to Accepted; ADR-0055 captures the exact-cache contract and invariants.
v1 scope: 2 breakpoints (stable prefix + conversation tail); per-provider cache matrix; `AISY_PREFIX_CACHE` kill-switch (default on); `makeExactCache` content-addressed decorator (`sha256(namespace + prefixBytes + spans)`, sessionId excluded); `AISY_NIGHTLY_EXACT_CACHE=1` opt-in for nightly paths.
Invariants: exact-cache NEVER wraps the live agent loop (stateful turns + safety bypass risk) and NEVER wraps an in-flight retry-for-a-fresh-sample.
Follow-ups: disk-backed exact-cache store (cross-run incremental eval); #21 semantic cache deferred pending ADR-0031 embedding plugin.

## Dependency notes

- **#4 + #5** share one loop abort/interrupt seam — implement together.
- **#9** needs real memory (**#1**) so consolidation has facts to stage.
- **#8** is the only item that changes the runner contract (sub-agent spawn) — gate it
  behind its own ADR; budget/config already key on arbitrary agent-ids, so the data
  model is ready.
- The opaque-bytes 3-tier router (`provider/types.ts`) stays untouched — the catalog has
  its own id-space (ADR-0050).

## Recommended order

Tier 1 → Tier 2 → (Tier 5 quick wins opportunistically) → Tier 3 → Tier 4 → Tier 6.
Each tier gets its own `writing-plans` plan as it starts; this file is the index back to them.
