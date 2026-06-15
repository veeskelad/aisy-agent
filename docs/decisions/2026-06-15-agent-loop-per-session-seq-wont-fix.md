# ADR-0044: Agent-Loop Per-Session Sequence Numbers — Won't Fix

**Status:** Accepted
**Date:** 2026-06-15
**Tags:** agent-loop, observability, single-user

## Context

`makeAgentLoop` maintains a single module-level `let seq = 0` counter that
increments with every `sessionLog.append()` call across all sessions in the
same process lifetime. The spec `LogEntry` type (§4, lines 238-245) declares:

```
{ seq: number; ts: number; kind: string; payloadHash: string; payload: unknown }
```

There is no `sessionId` field in `LogEntry`. The B1 review raised whether
per-session sequence numbers should be added (a new counter that resets to 0
at the start of each session, allowing per-session integrity verification).

This would require either:
(a) adding a `sessionId` field to `LogEntry` — a spec deviation, or
(b) maintaining two counters (`globalSeq` + `sessionSeq`) — observable
   complexity without a defined consumer.

## Decision

**Won't fix. Keep the single global `seq` counter. Do not add `sessionId` to
`LogEntry`.**

Rationale:
- **Single-user, single-active-session architecture (ADR-0021):** Aisy is
  single-user and, at runtime, runs at most one active session per process.
  Per-session seq reset adds no tamper-evidence benefit because there is never
  a legitimate multi-session log in a single journal file.
- **Spec fidelity:** `LogEntry` has no `sessionId`. Adding one widens Core
  types without spec authority. The spec is the contract; deviating without an
  accepted ADR revision risks silent divergence in consumers.
- **Global seq is sufficient for tamper-evidence:** An adversary deleting or
  reordering entries is caught by a gap in the global seq. A per-session reset
  would *weaken* this guarantee (a gap at seq=0 after a session boundary looks
  identical to session start).
- **Operational reality:** journal files are per-run (component 06 writes one
  file per invocation); session boundaries coincide with file boundaries, so
  seq-within-file is already implicitly per-session.

If a future multi-session journal (e.g., a unified audit log across runs) is
ever introduced, the correct path is an explicit spec revision adding
`sessionId` and a coordinating `SessionStartEntry`, not a silent counter.

## Consequences

- **Positive:** No spec deviation; no Core type widening.
- **Positive:** Global seq continues to provide strong tamper-evidence within
  a single journal file.
- **Neutral:** AC that asked for per-session seq is closed as won't-fix. If
  the spec is later revised, revisit this ADR.
- **Negative:** A consumer that reads multiple journal files and tries to
  correlate entries across sessions has no session-scoped seq. They must use
  `ts` (timestamp) or file-path as session boundary markers.

## Alternatives considered

**Add `sessionId` to `LogEntry`:** Requires spec revision. Deferred until a
concrete multi-session use-case exists (currently none). The single-user model
makes it speculative over-engineering.

**Maintain dual counters (`globalSeq` + `sessionSeq`):** Two counters with
no defined consumer is dead code at best, confusion at worst. Rejected.

## References

- Spec §4 `LogEntry` definition (line 238-245)
- ADR-0021 (Single-user, no-SaaS — locked decision)
- `packages/core-ts/src/agent-loop/index.ts` — `let seq = 0` at line ~154
