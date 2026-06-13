# ADR-0011: Autonomy Gradient (Tiers 0–3)

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** security

## Context
A personal agent reachable from Telegram and the IDE issues many tool calls per session. A flat
permission model forces a binary choice: confirm everything or confirm nothing. Confirming everything
is unlivable — at ~100 confirmations/hour the user just stops reading them, and 40%+ of users end up
enabling blanket auto-approve. Confirming nothing is how irreversible damage happens: DataTalksClub's
Claude Code ran `terraform destroy` and wiped 1.9M rows (2026-03-06); Replit deleted a production
database. The constitutional split applies — reversible/creative work belongs to the model (~70%
adherence), irreversible/critical work must pass a deterministic code gate (100%). The friction
problem and the safety problem pull in opposite directions, so the gate has to be *coarse* enough to
be livable while still being a *hard stop* on the operations that cannot be undone.

## Decision
Classify every tool call into one of four tiers and gate it deterministically in code (not by LLM
judgment), with a single global autonomy level the user sets:

- **Tier 0 — read-only** (Read, grep, FTS5 query, list): always auto. No prompt, ever.
- **Tier 1 — write in a worktree** (file edits, commits inside an isolated git worktree): auto.
  Reversible by design — the worktree is throwaway until the user merges.
- **Tier 2 — shell / network** (arbitrary commands, outbound HTTP, MCP calls with side effects):
  auto when global autonomy ≥ **Delegation**; otherwise ask.
- **Tier 3 — irreversible** (delete, deploy, money ops, force-push, prod DB writes, anything matching
  HARD_DENY): **always ask**, regardless of autonomy level, via a red Telegram confirmation card.

The Tier 3 card is visually distinct (red) and structurally separate from any Tier 0–2 prompt, so an
irreversible action can never be confirmed with the same muscle-memory tap as a harmless one. No
autonomy level and no skip-permissions flag can downgrade a Tier 3 op to auto.

## Consequences
- **Positive:** Coarse tiering keeps confirmation volume livable, removing the incentive to enable
  blanket auto-approve. Tier 3 is a deterministic hard stop that satisfies the NIST requirement for at
  least one enforcement layer not judged by an LLM. The red card defeats confirmation-fatigue habituation.
- **Neutral:** One global autonomy level is the only knob; only Tier 2 behavior changes with it. Tiers
  0/1/3 are fixed by design and not user-tunable.
- **Negative:** Tier assignment is a maintained classifier — a miscategorized irreversible op silently
  bypasses the red card, so the tier table is itself security-critical and needs review on every new tool.
  Worktree isolation must actually hold for Tier 1's "reversible" claim to be true.

## Alternatives considered
**Flat permissions (one allow/deny for all tools).** Forces all-or-nothing; either drowns the user or
disables safety entirely. This is precisely the model that pushed 40%+ of users to blanket auto-approve.

**Global skip-permissions including irreversible ops.** Maximum convenience, but removes the only
deterministic guard on `terraform destroy`, `rm -rf`, deploys, and money ops — the exact configuration
behind the DataTalksClub 1.9M-row wipe and the Replit prod-DB deletion. Rejected outright: no
skip-permissions on Tier 3, no exceptions.

**Per-tool fine-grained prompts.** More precise, but reproduces the 100-confirmations/hour problem and
reintroduces fatigue; coarse tiers are deliberately chosen over per-tool granularity.

## References
- [ADR-0009](./2026-06-11-deterministic-tool-hooks.md)
- DataTalksClub Claude Code `terraform destroy` incident, 2026-03-06 (1.9M rows lost)
- Simon Willison, "The lethal trifecta" (private data + untrusted input + outbound channel)
- NIST AI guidance: at least one deterministic enforcement layer not judged by an LLM
