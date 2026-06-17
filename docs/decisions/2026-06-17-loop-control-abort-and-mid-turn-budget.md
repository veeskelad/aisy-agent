# ADR-0051: Loop control seams — turn abort and mid-turn budget

- Status: Accepted
- Date: 2026-06-17
- Supersedes: —
- Related: ADR-0050 (multi-provider catalog + per-agent budget), ADR-0048 (transport/outbound), ADR-0026 (loop discipline)

## Context

The agent loop (`makeAgentLoop`) was non-interruptible mid-turn and enforced
budget only at turn entry (the transport's pre-turn gate). The operator needs
phone-side control: `/stop` must hard-kill an in-flight turn, and an enabled
per-agent budget must halt a turn the moment its accumulated spend crosses the
cap — not only refuse the next turn. The loop is the most safety-critical,
most-tested module, so the change must be additive and not alter any existing
halt/gate semantics.

## Decision

Two **optional** seams, threaded through the existing injection chain:

1. **Turn abort.** `TurnInput.signal?: AbortSignal` rides through `runner.handle`
   (which forwards `input` verbatim) into the loop. `ProviderAdapter.complete`
   gains an optional 2nd `signal?` parameter; each adapter merges it with its own
   timeout via `AbortSignal.any` (the CLI adapter kills its child). An abort is
   mapped to a clean `Halt('stopped')` at the loop boundary — never an error —
   and the loop also checks the signal between tool dispatches. The transport owns
   a per-turn `AbortController` and fires it on `/stop`.

2. **Mid-turn budget.** `AgentLoopDeps.budgetCheck?(usage)` is consulted after each
   model call with the turn's running usage; a positive verdict throws
   `Halt('budget-capped')`. The probe is wired in `aisy.ts`, closing over the
   existing settings + budget stores, so the loop stays pure. The transport renders
   the existing `budget.capped` card.

`HaltReason` (hence `TurnResult.haltReason` and `TurnState` halted) gains
`"stopped"` and `"budget-capped"`.

**Outbound lockout (#6):** the gateway's egress guard (`streamReply` throws
`OutboundBlocked` while locked, re-checks per token, fails closed when Safety is
unavailable) was already implemented and tested (AC-02-6, REG-02-D, AC-02-19) but
the live binary hardcoded `isOutboundLocked: () => false`, so it never fired in
production. It is now wired to the live narrowed state: the bot mirrors each
turn's `TurnResult.narrowed` into the flag the gateway reads (`setOutboundLocked`),
so the proven guard is truthful in production and self-clears on a clean operator
turn. The bot also retains its own reply hold behind an allow/block tap
(`presentOutboundLockout`) as the primary user-facing UX — a richer interaction
than a thrown block — so the lockout has both a transport-layer hold and a
truthful gateway-egress guard.

## Consequences

- **Positive:** `/stop` is a real hard-kill; budget enforcement is mid-turn, not
  just turn-gated. Both seams are optional — every existing caller and test is
  unaffected (a 1-arg `complete` stays assignable to the 2-arg signature; absent
  `signal`/`budgetCheck` = today's behavior). No safety gate or grant rule changed.
- **Negative / trade-offs:** `ProviderAdapter.complete` signature widened (all
  adapters updated). Abort granularity is per-model-call and per-dispatch, not
  truly preemptive inside a running tool. `budgetCheck` sees the in-flight turn's
  usage plus ledger spend, so the cap is enforced approximately at the call that
  crosses it (the crossing call's tokens are already spent). The halted turn now
  carries that usage on its result so the transport records it to the ledger,
  keeping the cap and cost view honest; a halted turn also reports `narrowed` so
  the outbound lockout persists correctly when a narrowed turn hits a halt.
- **Follow-ups:** the bot mirrors `result.narrowed` into `isOutboundLocked` after
  the turn, so the gateway flag trails the in-turn state by one turn — acceptable
  because the bot's own reply hold uses the fresh `result.narrowed` and the gateway
  egress is not the bot's reply path. If `streamReply` ever becomes the reply path,
  source the flag from the loop's live session state instead of the post-turn mirror.

## Alternatives considered

- **Construction-time abort dep on the runner.** Rejected: the bot builds the
  runner once but needs a fresh controller per turn; a per-turn `TurnInput.signal`
  is the natural carrier and needs no runner signature change.
- **Budget enforced by wrapping the provider adapter.** Rejected: the adapter
  lacks per-agent/turn context and the settings store; the loop is where usage
  accumulates, so the probe belongs there.
- **A dedicated options bag `complete(req, opts)`.** Deferred (YAGNI): a single
  optional `signal?` is the only per-call cross-cutting concern today.
