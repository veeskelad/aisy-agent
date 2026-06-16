# ADR-0047: Scoped Approval Grants — "once / session / always"

**Status:** Accepted
**Date:** 2026-06-16
**Tags:** safety, gateway, telegram, approvals

## Context

Every Tier-2/Tier-3 action shows a 2-button approval card (Confirm / Reject) and
`handleCardTap` confirms exactly one action. There was no "remember this decision"
mechanism anywhere in the codebase. Repeated low-risk actions (e.g. `bash` for
`npm test`, `write_file` in the workspace) nag on every call.

We want the familiar pattern (Hermes / Claude Code permission prompts): a 4-button
card — **Подтвердить (once) / На сессию / Навсегда / Отменить** — where "session"
and "always" remember the approval so matching future actions auto-run.

The danger: a careless "remember" could silently widen what the agent may do
unattended. The design must guarantee a grant can only ever skip a *prompt*, never
weaken a *block*.

## Decision

Add scoped approval grants with these locked properties:

1. **Granularity = per base tool.** A grant keys on `ToolCall.tool` (e.g. `bash`,
   `write_file`). Exact-`actionHash` granularity was rejected (an "always" grant for
   one exact command is useless — the next command differs); tool+resource scoping is
   deferred (more code, no current need).

2. **A grant suppresses only the Tier-2 `ask`, never a `deny`.** In
   `SafetyPolicy.evaluate`, the grant check runs **after** every deny check
   (HARD_DENY, unbounded-DELETE, tainted-args, narrowed-outbound, degraded-sandbox)
   and **before** the Tier-2 ask:
   ```
   …all deny checks… → tier = tierOf(call)
     tier 3 → ask        (NEVER consults grants)
     tier 2 → grants.has(tool) ? allow : ask
     else   → allow
   ```
   So "always allow bash" still cannot `rm -rf`, run on tainted args, or send while
   narrowed — the deny layer remains the always-on backstop.

3. **Tier-3 is never grantable.** Step-up (TOTP/passphrase) is required every time.
   Defense-in-depth: `Gateway.handleCardTap` **drops** a `session`/`always` scope to
   `once` on any `requiresStepUp` card, even if a buggy or hostile client sends one.

4. **Storage:** session grants live in an in-memory `Set` (cleared on restart);
   "always" grants persist to `~/.aisy/grants.json` (mode `0o600`,
   `{ "always": ["bash", …] }`) via an injected `GrantPersistencePort` — same DI/file
   pattern as the vault and mcp-allowlist. `makeGrantStore` works in-memory when no
   persistence is injected (tests, and pre-assembly).

5. **Scope flow.** `CardTap.approvalScope?: 'once'|'session'|'always'` carries the
   tapped button; `ApprovalResult` confirmed echoes `scope?: 'session'|'always'`
   (post Tier-3 guard). `handleCardTap` stays the pure, deterministic confirmer — it
   does not mutate grant state. Recording happens in the layer that holds the
   `ToolCall` (the agent-loop/orchestrator that called `issueCard`): on a confirmed
   result with a scope it calls `grants.record(call.tool, scope)`.

## Consequences

- **Positive:** Real friction reduction for routine tools, with the safety invariant
  intact and machine-checked (a test asserts an `always` bash grant still denies
  `rm -rf`, tainted args, and narrowed-outbound; Tier-3 always asks).
- **Positive:** Additive. `SafetyPolicyDeps.grants?` is optional ⇒ absent ⇒ baseline
  behavior; all prior safety/gateway tests pass unchanged (546 green, +19 new).
- **Positive:** Telegram specifics stay in the adapter (4-button render, verb encoding
  within the 64-byte callback cap); core exposes only data + the `ApprovalScope` type.
- **Negative / accepted:** Per-tool "always allow bash" is coarse — it trusts the
  deny-layer to catch the dangerous specifics. Acceptable because that layer is
  non-overridable; a finer tool+resource scope can be added later without a breaking
  change (the grant key is internal).
- **Deferred:** The `grants.json` persistence adapter in `bin/aisy.ts` and the
  grant-recording call are wired when the full agent (safety + orchestrator) is
  assembled — the same integration seam as the Telegram `bot.ts`/runner. Writing them
  now would be dead code (nothing constructs `makeSafetyPolicy` outside tests yet).
  A `/grants` listing + ⚙️ "Сбросить гранты" reset are a UI follow-on on `bot.ts`.

## Alternatives considered

- **Exact-`actionHash` granularity:** safest but "always" is near-useless. Rejected.
- **Tool + resource (path/host prefix) scope:** more precise, more code (resource
  normalization). Deferred until a concrete need.
- **Allowing Tier-3 grants:** would defeat step-up — the entire point of Tier-3.
  Rejected; enforced by the `handleCardTap` drop-guard.
- **Recording in `handleCardTap`:** rejected — it has no tool name and must stay the
  pure confirmer (ADR-0029); recording belongs in the verdict/orchestration layer.

## References

- ADR-0009 (deterministic Pre/PostToolUse hooks), ADR-0011 (autonomy gradient / tiers)
- ADR-0029 (a tap applies only to the exact pending action), ADR-0046 (`getIssuedCard`)
- `packages/core-ts/src/safety/grants.ts`, `safety/index.ts` (`evaluate`),
  `gateway/types.ts` / `gateway/index.ts` (`ApprovalScope`, scope echo + guard)
- `packages/telegram-gw/src/approval-card.ts` (4-button keyboard),
  `approval-flow.ts` (`resolveTap` scope)
