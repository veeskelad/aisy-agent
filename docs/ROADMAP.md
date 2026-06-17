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

### Tier 3 — sub-agents (delegation) — the big capability
| # | Task | Effort | Risk | Depends |
|---|------|--------|------|---------|
| 8 | Export + wire `DelegationManager` into the runner; spawn sub-agents with own model+budget (closes Phase-3 inheritance). **New ADR** for the runner-seam. | L | high | orchestration (built, dormant); budget-tracker keys on agent-id already |

→ Plan: TBD (own writing-plans plan + ADR; do as a dedicated arc).

### Tier 4 — proactivity (after real memory)
| # | Task | Effort | Risk | Depends |
|---|------|--------|------|---------|
| 9 | Nightly consolidation: cron/timer → `ConsolidationRunner` → staging gate (`/consolidate` already builds the PendingAction) | M | low | #1 (memory) |
| 10 | Triggers/proactivity: `TriggerEngine` → watch/scheduler → fire | M–L | med | a scheduler |

→ Plan: TBD.

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
