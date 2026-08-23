# ADR-0064: Full-Fidelity Hash-Chained Session Transcript

**Status:** Accepted
**Date:** 2026-07-26
**Tags:** sessions, context, observability

## Context

Aisy now requires multiple resumable sessions across Workspace and Projects.
The live `session-log.jsonl` is an audit/event stream: it does not durably
store every user, assistant and tool span, its sequence restarts with a runner,
and it cannot reconstruct missing dialogue.

ADR-0044 deliberately rejected session identifiers and sequence numbers while
Aisy had one active session per process. That premise no longer holds after
ADR-0060/0063 and the approved Workspace/Project design.

## Decision

Introduce a permission-restricted v2 transcript journal with full-fidelity,
context-bound envelopes:

```ts
interface TranscriptEnvelope {
  eventId: string
  operatorId: string
  profileId: string
  projectId: string
  sessionId: string
  sessionSeq: number
  role: 'system' | 'user' | 'assistant' | 'tool'
  provenance: 'operator' | 'untrusted'
  content: string
  ts: string
  loadBearing: boolean // code-owned compaction metadata; never caller-supplied
  loadBearingClassifierVersion: string
  prevSessionHash: string
  rowHash: string
}
```

A session manifest stores its context ownership, next durable sequence,
hash-chain head, frozen-prefix snapshot/hash and resume capability. Appends are
serialized, fsynced and idempotent by `eventId`; each row hash covers all
fields—including code-owned `loadBearing` and its classifier version—and the
previous session hash. The transcript port derives those fields after append
input validation; model/tool callers cannot submit or override them.

The context engine projects/compacts this journal at read time and never mutates
it. Telemetry remains content-redacted, while the private transcript retains
the content required for exact resume.

Legacy `session-log.jsonl` remains byte-identical and checksum-anchored. Since
it lacks dialogue, migrated sessions are labelled `metadata-only`; Aisy never
fabricates an exact resume. Continuing one creates a v2 session linked by a
migration-boundary event.

This decision supersedes ADR-0044.

## Consequences

- **Positive:** Workspace and Project sessions can resume exact v2 dialogue
  after process restart and remain auditable by context/session.
- **Positive:** per-session ordering and integrity survive concurrent sessions
  without relying on process-local counters.
- **Neutral:** the audit event stream and private transcript are distinct
  projections with different privacy surfaces.
- **Negative:** full transcripts consume more disk and require retention,
  permissions, integrity checks and recovery tooling.
- **Negative:** pre-v2 dialogue cannot be recovered and is shown honestly as
  metadata-only.

## Alternatives considered

**Treat the legacy event log as a transcript.** Rejected because its missing
content cannot be reconstructed by a manifest.

**One process-global sequence only.** Rejected because restarts and concurrent
sessions need durable ownership and session ordering; a unique event id alone
does not prove per-session order.

**Store only summaries.** Rejected because summaries cannot prove exact resume
and would make compaction destructive.

## References

- [ADR-0044 — superseded sequence decision](./2026-06-15-agent-loop-per-session-seq-wont-fix.md)
- [ADR-0040 — compaction as a view](./2026-06-13-context-engine-compaction-as-view.md)
- [ADR-0060 — project-scoped sessions](./2026-07-26-project-scoped-sessions-file-ownership.md)
- [Workspace/Project design](../superpowers/specs/2026-07-26-workspace-project-context-design.md)
