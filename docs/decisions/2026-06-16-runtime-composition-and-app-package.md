# ADR-0048: Runtime Composition Layer + `@aisy/app` Package

**Status:** Accepted
**Date:** 2026-06-16
**Tags:** architecture, packaging, runtime, telegram

## Context

All 15 core components were individually built and unit-tested, but nothing
assembled them into a live agent — `bin/aisy.ts` only ran onboarding. The
factories (`makeGateway`, `makeAgentLoop`, `makeSafetyPolicy`, …) were never
instantiated together, and there was no real LLM client, tool executor, or
Telegram transport. We need a runtime "spine" that boots a working phone agent.

Two structural facts shaped the design:
- The agent loop is already a complete turn driver; its provider seam is the
  high-level `ProviderAdapter.complete({spans}) → {reply, toolCalls}` (structured
  spans, not the opaque-bytes router). So a single real adapter suffices and the
  3-tier `ModelRouter` is not required for a working turn.
- `@aisy/core` cannot depend on `@aisy/telegram-gw` (cycle), yet the live runtime
  must wire both.

## Decision

**A runtime layer in `core-ts/src/runtime/` + a new `packages/app` that owns the
Telegram transport and composition root.**

- **`core-ts/src/runtime/`** (no Telegram dependency, fully unit-tested):
  - `provider-anthropic.ts` — real `ProviderAdapter.complete` (spans→Anthropic
    Messages API→`{reply,toolCalls}`).
  - `execute-tool.ts` — `ToolCall`→fs/bash/memory ports, workspace-confined.
  - `hook-gate.ts` — bridges the loop's `HookGate` to `SafetyPolicy` + grants +
    the approval round-trip. Because the loop awaits `pre()`, the whole `ask`
    resolution lives here: on `ask` it builds a `PendingAction`, awaits an
    injected `approve()` port, and returns allow/deny. **No agent-loop change.**
  - `agent-runner.ts` — `makeAgentRunner` wires safety+grants+hookGate+loop;
    all outside-world seams injected.
- **`@aisy/core` barrel** widened from "gateway types only" to the **composition
  surface**: the runtime factories, `makeGateway`, `makeGrantStore`, and the
  agent-loop vocabulary (`TurnInput`, `ContextSpan`, `ProviderAdapter`, …). The
  app imports the agent-loop vocabulary (not the safety/provider duplicates) to
  avoid name clashes.
- **`packages/app`** (depends on `@aisy/core` + `@aisy/telegram-gw` + grammY):
  `bot.ts` (grammY transport: menu, text-turn→runner→reply, approval cards via
  the bot-owned `approve` port, `/stop`) and `bin/run.ts` (`aisy-run`: wires real
  adapters from the vault and starts long-polling).

## Consequences

- **Positive:** A runnable agent for read/think/reply + Tier-2/3 approvals; the
  safety-critical composition is pure and machine-tested (594 tests across the
  workspace), transport is isolated.
- **Positive:** No package cycle; clean layering (core = library + non-transport
  runtime; app = transport + composition + bin).
- **MVP shortcuts (explicit, each a follow-on):** no sandbox (bash reports
  unavailable), cold-start memory + in-memory session log, a no-op loop guardian
  backed by a tool-call cap, and — not yet wired — Hermes debounce coalescing,
  Tier-3 step-up code capture, outbound-lockout enforcement via `streamReply`,
  the event-bridge alert stream, and the 3-tier provider router.
- **Bin:** `aisy-run` is a distinct command for now; unifying it with the
  `aisy` onboarding bin (one CLI: run + init + doctor) is a follow-on that needs
  the onboarding adapter wiring factored out of `core-ts/bin`.
- **API surface:** the widened barrel is now public; further widening stays
  deliberate.

## Alternatives considered

- **Composition in `core-ts/bin` with a Telegram port:** avoids a package but
  forces an abstraction over the transport and keeps non-onboarding concerns in
  core. Rejected for weaker separation.
- **`telegram-gw` hosts the composition root:** overloads the UX package with
  provider/sandbox concerns. Rejected.
- **Wire the 3-tier `ModelRouter` now:** unnecessary — the loop's `complete`
  seam is single-adapter; routing is a later optimization.

## References

- ADR-0047 (scoped grants — the approval round-trip records grants here)
- ADR-0046 (`getIssuedCard` — the transport reads the nonce to build the card)
- `packages/core-ts/src/runtime/*`, `packages/core-ts/src/index.ts`
- `packages/app/src/bot.ts`, `packages/app/src/bin/run.ts`
