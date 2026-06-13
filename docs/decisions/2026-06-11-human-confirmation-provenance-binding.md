# ADR-0029: Human-Confirmation Provenance and Approval Integrity

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** security, memory

## Context
`is_human_confirmed` sits at the top of the contradiction-priority order
([ADR-0024](./2026-06-11-memory-contradiction-resolution.md)) and marks a deletion as
permanent ([ADR-0023](./2026-06-11-durable-forgetting-tombstones.md)). But nothing
defines what *sets* the flag or how it is protected. The nightly generator
([ADR-0016](./2026-06-11-generator-judge-self-learning.md)) authors candidate memory ops
— including `DELETE → is_human_confirmed` and `UPDATE → new fact is_human_confirmed` —
while reading untrusted day-log content. If the generator can emit a fact carrying
`is_human_confirmed: true`, untrusted input can mint an unbeatable, un-forgettable fact,
or a permanent human-confirmed *deletion* of a real fact (a denial-of-service on memory).
Separately, the approval surface itself is weak: the Telegram approval card and the
morning "approve all" have no nonce binding a tap to a specific action, no protection
against a staging-area swap between judge-accept and human-approve (TOCTOU), and no
step-up factor for irreversible/permanent approvals. The human tap is the root of trust
for the whole self-improvement loop, yet it is the least specified part.

## Decision
**`is_human_confirmed` and every other trust/permanence flag are set only by a
deterministic approval handler bound to a real human action on a specific, hash-pinned
artifact.**

1. **No model-set trust.** Any `is_human_confirmed` (or equivalent trust/permanence)
   field present in generator or judge output is stripped and ignored. Model-authored
   content can *propose* a deletion or fact; it can never *confirm* one.
2. **Confirmation = deterministic handler + human tap.** The flag is set only by the
   approval handler, in code, in direct response to a human approving a specific diff.
   The handler records an audit binding: which card tap → which fact id / op → at what
   time.
3. **Staging hash-identity.** The artifact the human approves must be byte-identical to
   the artifact the judge accepted. Each staged patch is hashed at judge-accept; the
   promotion step re-verifies the hash before applying. A mismatch aborts and routes to
   human review — closing the judge-accept-then-swap TOCTOU.
4. **Per-action nonce.** Every approval card carries a single-use nonce plus an
   action-hash. The handler rejects replays and stale taps; a tap only applies to the
   exact pending action it was issued for.
5. **Step-up for irreversible approvals.** Tier-3 actions ([ADR-0011](./2026-06-11-autonomy-gradient.md)),
   money operations, and memory-permanence approvals (human-confirmed deletes) require a
   second factor beyond a single tap — a passphrase, TOTP, or retyping the action text.
   A plain tap is insufficient for permanence.

## Consequences
- **Positive:** Untrusted input can no longer mint or permanently delete
  human-confirmed facts — the top of the priority order is unforgeable. The staging hash
  and per-action nonce close TOCTOU and replay on the approval surface. Step-up makes the
  permanent, irreversible decisions deliberate, defeating click-fatigue on exactly the
  taps that matter.
- **Neutral:** Adds an approval-handler component (Component 5/8) and an audit log of
  tap→action bindings. The morning "approve all" becomes "approve all, with step-up on
  any permanence item in the batch."
- **Negative:** Step-up adds friction to confirming deletions and Tier-3 ops — intended,
  but it must be fast enough not to push the user toward disabling it. If the second
  factor is lost, a human-confirmed deletion cannot be made; recovery is an operator-level
  out-of-band reset, documented in SECURITY.

## Alternatives considered
**Trust the generator/judge to set `is_human_confirmed` honestly.** This is the
vulnerability; untrusted content drives the generator. Rejected.

**Single tap for everything (no step-up).** Simpler, but a stolen/oversharing Telegram
session then controls memory permanence and Tier-3 with one tap. The whole human-gate
model rests on this surface; a single factor is too weak for permanence.

**Sign each fact with a user key instead of a flag.** Stronger cryptographically, but
heavy for a single-user personal agent; the deterministic handler + audit binding gives
most of the benefit. Kept as a future hardening option.

## References
- [ADR-0023](./2026-06-11-durable-forgetting-tombstones.md) — what permanence protects
- [ADR-0024](./2026-06-11-memory-contradiction-resolution.md) — where the flag ranks
- [ADR-0016](./2026-06-11-generator-judge-self-learning.md) — the generator that must not set it
- [ADR-0011](./2026-06-11-autonomy-gradient.md) — the Tier-3 card this hardens
- OWASP LLM03 (Training/Memory Data Poisoning); STRIDE Spoofing/Tampering
