# ADR-0021: Coordinator-Workers Orchestration + Decision Journal

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** orchestration

## Context
Multi-step work in Aisy spans research, code, and review across more files than a
single context window can hold safely. Two failure modes drive this decision.

First, **peer-to-peer agent chatter is expensive and unsafe**. When equal agents
message each other, every exchange re-injects the other's full output into both
contexts, so token cost multiplies with the number of agents and rounds. Worse,
the LLM is a stateless probabilistic CPU at ~70% instruction adherence; chaining
70%-reliable agents conversationally compounds error rather than averaging it out.

Second, **the conversation is not a durable control plane**. History compaction
(needed once context approaches 250-300k tokens) silently drops in-conversation
instructions and intermediate reasoning. Any coordination state that lives only in
chat turns can be erased mid-task. Control must therefore live *outside* the
conversation, in deterministic OS-layer artifacts (code hooks = 100% vs prompts =
70%), echoing the file-based inter-step state pattern (STATE/DECISIONS/NOTES) we
borrowed conceptually from ANIMA_SDK.

Workers must also stay isolated for safety: each runs minimal-scope in its own
sandbox/worktree, consistent with our sandbox policy (network none, read-only,
cap_drop ALL, one-shot) and worktree isolation for parallel agents.

## Decision
For multi-step work, a **coordinator** decomposes the task and spawns **isolated
workers** — each minimal-scope, each in its own sandbox/worktree, with no
peer-to-peer messaging. Workers communicate only by appending to a shared
**Decision Journal** (`decided FOR / AGAINST / because`), which the coordinator
reads to reconcile conflicts and assemble the result.

- **Coordinator:** owns decomposition, spawn, reconciliation, and the final merge.
  It is the only agent that reads the whole Journal and resolves contradictions.
- **Workers:** receive an explicit scope ("you own X; do NOT touch Y"), do the
  work, and emit structured Journal entries. They never read each other's chat.
- **Decision Journal:** append-only, file-based, in git. Each entry records the
  choice, the rejected option, and the rationale, so reconciliation is auditable
  and survives compaction (the live conversation is not the source of truth).

## Consequences
- **Positive:** token cost scales with work done, not with agent×round chatter;
  errors are reconciled deliberately by one coordinator instead of amplified
  through peer dialogue; coordination state survives history compaction because it
  lives in a durable artifact; worker isolation upholds least-privilege and sandbox
  guarantees; the Journal gives a git-tracked, human-reviewable audit trail.
- **Neutral:** introduces a fixed Journal schema and a reconciliation step; the
  coordinator becomes a single point of merge (intentional, not a bottleneck for
  reversible work).
- **Negative:** added orchestration machinery (spawn, scope contracts, Journal
  parser) for tasks that a single agent could handle — so this applies only to
  genuinely multi-step work, not one-shot requests; a poorly-scoped coordinator can
  still emit contradictory worker briefs.

## Alternatives considered
**Equal peers messaging each other.** Rejected: token cost blows up
super-linearly with agents and rounds, and conversationally chaining ~70%-reliable
agents amplifies errors instead of catching them; no single place holds ground
truth.

**Workers but no Journal (glue the outputs).** Rejected: without a structured
`FOR/AGAINST/because` record, the coordinator cannot detect when two workers made
incompatible choices, so it silently glues conflicting parts together; rationale is
also lost to compaction, defeating auditability.

## References
- [ADR-0020](./2026-06-11-loop-guardian.md) — Loop Guardian cycle detection
- [ADR-0012](./2026-06-11-docker-sandbox-default.md) — Worker sandbox/worktree isolation
- Simon Willison, "The lethal trifecta" (control outside the conversation)
