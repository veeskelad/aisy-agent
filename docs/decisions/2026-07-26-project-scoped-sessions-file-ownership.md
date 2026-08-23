# ADR-0060: Project-Scoped Sessions and File Ownership

**Status:** Accepted (memory topology partly superseded by [ADR-0063](./2026-07-26-layered-workspace-project-memory.md))
**Date:** 2026-07-26
**Tags:** projects, sessions, files

## Context

The live Telegram composition currently derives the session id from the chat id
and uses one workspace root. A recent-session list exists, but creating,
switching, restoring, and compacting independent sessions does not. Files,
attachments, memory recall, and autonomy policy therefore have no durable
project ownership boundary.

The reference assistants demonstrate that projects and resumable sessions are product
state, not cosmetic grouping. Aisy's frozen memory and append-only context
invariants require explicit ownership before those flows can be added safely.

## Decision

Introduce a `ProjectRegistry` and make the live turn identity:

`operator_id + profile_id + project_id + session_id`.

Each project owns its root, project memory/knowledge, sessions, file metadata,
tasks/current-task state, and scoped autonomy grants. Switching projects builds
a new frozen context snapshot and cannot surface project-local recall from the
previous project.

Sessions support create, rename, switch, archive, restore, search, and compact.
The append-only transcript remains the record; compaction is only a read-time
view as required by ADR-0040.

Incoming attachments are stored outside the active workspace, keyed by operator
and session. They enter a project workspace or knowledge index only through an
explicit import with recorded provenance. File and memory access checks enforce
project ownership in code.

Memory topology is defined by ADR-0063. Global DNA, personal memory, learned
patterns, and the cross-project daily journal remain in the operator workspace;
each project owns its work notes, knowledge, tasks, skills, current-task state,
and indexed project corpus. Session transcript and compaction state additionally
carry `session_id`. A project switch builds a fresh context for the selected
project and must fail closed rather than fall back to another project's index.

## Consequences

- **Positive:** users can safely separate long-running work and resume exact
  sessions without context or file leakage.
- **Positive:** project scope becomes the durable boundary for project-local
  memory, delegation, autonomy, and monitoring outputs.
- **Neutral:** existing personal DNA/memory remains in the global operator
  workspace; legacy project material migrates into one default project and one
  imported session.
- **Negative:** registry/schema migrations and cross-project isolation tests are
  required before enabling the UI.
- **Negative:** moving sessions or files between projects requires an explicit
  provenance-preserving operation.

## Alternatives considered

**Use Telegram chat id as the session id.** Rejected: it cannot represent more
than one conversation or project for a single operator.

**Treat projects as tags only.** Rejected: tags do not enforce file, memory, or
autonomy isolation.

**Destructively summarize old sessions.** Rejected: it violates append-only
trace and context-compaction decisions.

## References

- [ADR-0007 — Frozen Memory Snapshot](./2026-06-11-frozen-memory-snapshot.md)
- [ADR-0023 — Durable Forgetting](./2026-06-11-durable-forgetting-tombstones.md)
- [ADR-0040 — Context Engine](./2026-06-13-context-engine-compaction-as-view.md)
- [ADR-0048 — Runtime Composition](./2026-06-16-runtime-composition-and-app-package.md)
- [ADR-0063 — Layered Workspace and Project Memory](./2026-07-26-layered-workspace-project-memory.md)

