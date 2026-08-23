# Workspace and Project Context — Design

**Status:** Ready for user specification review; five independent review cycles completed and final findings self-audited
**Date:** 2026-07-26  
**Related:** ADR-0060, ADR-0063, Component 17  
**Scope:** First complete vertical slice for workspace/project switching, sessions,
context assembly, deterministic memory/file placement, and Telegram/natural-language
project controls.

## 1. Decision summary

Aisy has one persistent personal workspace and any number of isolated projects:

- `~/workspace/` is the special **Workspace** context. It contains Aisy's
  character, operator profile, goals, preferences, durable personal memory,
  learned working patterns, global journal, and global knowledge.
- `~/projects/<slug>/` is a **Project** context. It contains that project's
  repository and files, work notes, knowledge, tasks, skills, and current task.
- Every dialogue belongs to one resumable session inside exactly one context.
- Switching context changes the active root, project-local recall, active task,
  tools, and session. It does not change Aisy's character or global memory.
- Telegram menu actions, direct structured tools, and phrases such as
  “работаем над X”, “создай проект X”, and “склонируй <URL>” all call the same
  application service. They do not maintain parallel state.

The workspace is visible in the project picker but is not an ordinary project.
It is a non-archivable singleton with `kind: "workspace"`. Real projects have
`kind: "project"` and live under the configured projects root.

## 2. Evidence and current-state gap

The private reference material establishes the target behaviour: a shared
personal workspace, isolated project roots, and resumable sessions. ADR-0063
records that product decision for Aisy.

The current live code is only the registry foundation:

- `ProjectRegistryState.version` is `1`.
- `ProjectRecord` has `isDefault` but no workspace/project kind.
- `aisy run` calls `ensureDefault()` once, derives `activeWorkspaceRoot` once,
  and passes one fixed root and one fixed session id into the live runtime.
- Memory is one `~/.aisy/memory` store; recall is not scoped by project.
- The bot has no live create/list/switch project service.
- File confinement is lexical and fixed to the startup root; canonical symlink
  confinement is still missing.
- The context engine compacts an append-only session correctly, but its pinned
  prefix does not yet assemble global DNA plus the selected project layers.

Therefore a registry row alone does not yet switch Aisy's effective context.
The vertical slice is complete only when registry selection, session identity,
memory retrieval, file tools, and the Telegram experience switch atomically.

This document is the detailed normative design for Component 17. Component 17
has been aligned to it and maps its grouped AC-17 checks to the individual
WP-01…WP-41 evidence requirements below; neither document permits the old
“one default project” interpretation.

## 3. Goals and non-goals

### Goals

1. Make Workspace a first-class selectable context backed by the configured
   workspace root (fresh-install default: `~/workspace`).
2. Create and clone projects under the configured projects root
   (fresh-install default: `~/projects`).
3. Keep global DNA and long-term personal memory available in every context,
   while returning no project-local content from another project.
4. Give every turn an immutable, code-resolved
   `operator + profile + context + session` identity.
5. Route memory, notes, research, tasks, skills, and generated files to
   deterministic destinations with provenance.
6. Make project/session lifecycle available through Telegram buttons,
   natural-language intent, and structured agent tools.
7. Preserve existing installations without destructive moves and retain a
   rollback path.
8. Prove the behaviour with unit, migration, integration, and Telegram E2E
   tests, including negative isolation cases.

### Non-goals for this slice

- Multi-user collaboration inside one project.
- Cloud synchronization or a remote project filesystem.
- A remote/shared vector database or semantic-only retrieval. The first-class
  local semantic and hybrid modes required by ADR-0065 remain in this slice,
  with FTS5/BM25 as the always-available degraded baseline.
- Hard deletion of projects, sessions, transcripts, or imported files.
- Automatic cross-project fact promotion.
- Arbitrary model-chosen physical paths.
- A general IDE UI. The shared service is designed so an IDE can consume it
  later, but Telegram is the delivery surface in this slice.

## 4. Filesystem and state model

Fresh installations use these logical defaults; both user-visible roots are
configurable without changing the ownership rules:

```text
~/workspace/                         # special global Workspace context
├── constitution.md                  # retained compatibility/security prefix
├── SOUL.md
├── USER.md
├── MEMORY.md                        # hard 10 KiB; warning at 8 KiB
├── MISSION.md
├── GOALS.md
├── PROJECTS.md                      # generated projection of registry
├── PREFERENCES.md
├── LEARNED.md
├── CLAUDE.md
├── SERVICES.md
├── memory/YYYY-MM-DD.md             # cross-project daily journal
├── memory/facts/<fact-id>.md         # canonical readable live fact content
└── knowledge/
    ├── INDEX.md
    └── ...

~/projects/<slug>/                   # one isolated Project context
├── <repository and operator files>
├── memory/YYYY-MM-DD.md             # project work notes
├── memory/facts/<fact-id>.md         # canonical readable project facts
├── knowledge/INDEX.md
├── tasks/
├── skills/
└── .current-task.md

~/.aisy/                             # internal control-plane state
├── projects.json                    # registry v2, atomic publication
├── sessions/<session-id>/manifest.json
├── session-log.jsonl                # legacy audit/event log, preserved
├── transcript-v2.jsonl              # full-fidelity hash-chained transcript
├── memory-ledgers/global.db          # protected facts/forget/security ledger
├── memory-ledgers/projects/<project-id>.db
├── indexes/global.db                 # disposable FTS/vector/cache projection
├── indexes/projects/<project-id>.db
├── migrations/
├── inbox/
└── ... existing vault, grants, provider and journal state
```

Canonical readable live fact content lives under `~/workspace` or the active
project. `MEMORY.md` is the deterministic, generated, size-bounded prefix/index
over those live facts; it is not an authored fact sink. SQLite uses two physically separate classes of database. Disposable retrieval
databases store FTS/vector/cache projections and can be rebuilt. Protected
ledger databases store tombstones, contradiction/supersedure relations and the
hash-chained `do_not_remember` ledger, with integrity-checked backups. A
retrieval corruption rebuild reads canonical files only after verifying the
protected ledger and reapplies it. A missing/corrupt ledger fails closed and
requires verified backup restore or operator recovery; it is never reconstructed
from live files and never serves an unfiltered rebuild.

The existing `~/.aisy/session-log.jsonl` is preserved as a legacy audit/event
log, not misrepresented as a complete transcript: it lacks full user/assistant/
tool content, durable ordering across restarts and a hash chain. V2 sessions
append full-fidelity envelopes to permission-restricted
`~/.aisy/transcript-v2.jsonl`. Session manifests bind one context, persist the
frozen-prefix snapshot/hash, durable session sequence and resume capability; a
repository checkout therefore does not expose private dialogue.

`PROJECTS.md` is a deterministic, code-generated human-readable catalogue. The
registry JSON is authoritative for identifiers and selection. A manual edit to
`PROJECTS.md` cannot create, switch, or broaden access to a project.

## 5. Registry v2

The smallest compatible change keeps the public `ProjectRecord` name while
adding explicit semantics and deprecating `isDefault`:

```ts
type WorkContextKind = 'workspace' | 'project'

interface ProjectRecord {
  id: ProjectId
  operatorId: string
  profileId: string
  kind: WorkContextKind
  origin: 'workspace' | 'created' | 'cloned' | 'registered' | 'legacy'
  name: string
  slug?: string                 // required for kind=project
  root: string
  createdAt: string
  archivedAt?: string           // forbidden for kind=workspace
}

interface ProjectSelection {
  operatorId: string
  profileId: string
  projectId: ProjectId
  sessionId: ProjectSessionId
  generation: number            // persisted; increments on every selection change
}

interface ProjectRegistryStateV2 {
  version: 2
  projects: ProjectRecord[]     // includes one Workspace record per owner
  sessions: ProjectSessionRecord[]
  selections: ProjectSelection[]
}
```

`ProjectRecord` remains as a compatibility name in this slice so existing
consumers do not require a repository-wide rename. API/UI copy uses “context”
where both kinds are possible and “project” only for `kind=project`.

Registry invariants:

- Exactly one active `workspace` record exists for each operator/profile.
- A workspace cannot be archived, cloned, nested, or renamed to a project.
- Roots created or cloned by Aisy must be direct descendants of `projectsRoot`.
  A `registered` or `legacy` project may remain elsewhere only after the same
  protected-root, overlap, canonical-path, and explicit-approval checks; it is
  never silently moved or grandfathered around confinement.
- Workspace and active project roots cannot overlap each other or any other
  active root.
- No context root may equal, contain, or be contained by `~/.aisy`, its vault,
  inbox, session, index, migration, or staging roots. The home directory itself
  is never a valid context root.
- Slugs are normalized by code, stable, collision-checked, and never accepted
  as path fragments without validation.
- Sessions still belong to a record by `projectId`; a workspace session is
  therefore representable without a second session subsystem.
- Loaded duplicate ids, unsafe roots, owner mismatches, dangling references,
  multiple workspaces, or invalid kinds fail closed as `CORRUPT_STATE`.

The service surface becomes:

```ts
interface SwitchAuthorityReceipt {
  receiptId: string
  operatorId: string
  profileId: string
  targetProjectId: string
  targetSessionId?: string
  expectedGeneration: number
  sourceMessageHash: string
  expiresAt: string
  mac: string
}

interface ProjectService {
  ensureWorkspace(owner, configuredRoot, legacySessionId?): ProjectSelection
  listContexts(owner): ProjectRecord[]
  createProject(owner, { name, slug? }): Promise<ProjectSelection>
  cloneProject(owner, { remoteUrl, name?, slug? }): Promise<ProjectSelection>
  registerExistingProject(owner, { root, name }): Promise<ProjectSelection>
  archiveProject(owner, { projectId }, authority): ProjectRecord
  restoreProject(owner, { projectId }): ProjectRecord
  switchContext(owner, { projectId, sessionId? }, receipt: SwitchAuthorityReceipt): ProjectSelection
  createSession(owner, { projectId, name? }): ProjectSessionRecord
  renameSession(...): ProjectSessionRecord
  archiveSession(...): ProjectSessionRecord
  restoreSession(...): ProjectSessionRecord
  searchSessions(...): ProjectSessionRecord[]
  acquireTurnContext(owner): TurnContextLease
}
```

The core registry owns validated state transitions. The app service owns
filesystem initialization, git operations, migration orchestration, generated
catalogues, and user-facing errors. A receipt is one-use, short-lived,
owner/target/session/generation bound and MAC-verified. Only the authenticated
pre-router or verified Telegram callback adapter can mint it; model/tool callers
can carry an opaque receipt handle but cannot construct one. The service
consumes it atomically with selection mutation and rejects missing, replayed,
wrong-target, expired or stale receipts.

Archiving an actively selected project is itself an authorized switch barrier:
the service closes the old lease, selects Workspace and an active/new Workspace
session, increments generation, and archives the project in one registry-state
publication. Archiving the selected session similarly selects the most recent
other active session in that context or creates a replacement, increments
generation, then archives the old session atomically. Therefore a valid state
never contains an archived selection. Restoring a project re-runs protected-root,
overlap and canonical availability checks and does not auto-select it.

## 6. Immutable turn context

The fixed startup variables in `aisy.ts` are replaced by a context resolver.
At the start of every operator turn the app acquires one immutable lease:

```ts
interface TurnContextLease {
  operatorId: string
  profileId: string
  projectId: string
  projectKind: 'workspace' | 'project'
  sessionId: string
  root: string
  generation: number
  leaseId: string
}
```

The lease is passed to context assembly, memory recall, tool execution,
delegation, approvals, task state, and observability. None of those components
may read a process-global “current root” after the turn starts. `generation` is
stored in `ProjectSelection`, starts at 1, and increments atomically on every
context or session selection change. Telegram callbacks bind owner, target and
the generation they were rendered from.

`ContextLeaseCoordinator` distinguishes three states: `active`, `cancelling`,
and `closed`. A user switch first blocks admission of new tool operations on the
old interactive lease, aborts its model/tool signal, waits for any already
entered atomic filesystem operation to commit or roll back, closes the lease,
and only then persists the incremented selection. A tool must revalidate its
lease before entering an operation. After the barrier, the old lease fails with
`STALE_CONTEXT` before I/O. This is deterministic: old interactive turns are
cancelled, never allowed to keep writing after a user switch. Durable background
jobs use their own project-bound leases (§11) and are not retargeted by the
interactive selection generation.

A project-switch command is a control-plane barrier:

1. Mint and consume a `SwitchAuthorityReceipt` only from the authenticated
   operator message or an
   owner/generation-bound Telegram callback; untrusted spans cannot authorize a
   switch.
2. Resolve the target and target session, then quiesce and close the old lease.
3. Atomically persist the selection with `generation + 1`.
4. Acquire a new lease. If an existing session is resumed, load its persisted
   frozen prefix; create a new prefix only for a newly created session.
5. Confirm the active context/session to the operator.

For a compound request (“переключись на X и проверь README”), the pre-turn
router inspects only the original authenticated operator message, performs the
switch before any project-local retrieval or I/O, and then runs the task once
under the new lease. A model-issued `project.switch` is accepted only when bound
to explicit operator intent and before project-local I/O. Otherwise it requires
a fresh confirmation. A restart contains only the original operator span plus
a code-generated transition receipt and the new context; every old-project
retrieval, model, tool and untrusted span is discarded. A one-transition guard
prevents switch loops.

## 7. Context assembly

`LayeredContextAssembler` composes four sources without merging their storage:

1. **Frozen global prefix** — agent protocol plus Workspace DNA files,
   including `constitution.md`. It is captured exactly once when a session is
   created, persisted as a permission-restricted content-addressed snapshot,
   and obeys ADR-0007.
2. **Lazy global material** — cross-project-safe entries from today's global
   journal, the global knowledge catalogue, and relevant explicitly-global
   excerpts. Project event references are resolved only for their owning active
   project.
3. **Active-context material** — for a real project: `.current-task.md`, project
   memory/knowledge catalogues and retrieved excerpts; for Workspace: no
   project-local layer is invented.
4. **Session view and turn tail** — append-only transcript projected by the
   existing context engine, then current input and tool observations.

The automatic assembler accepts a `TurnContextLease` and never queries all
projects; cross-project fan-out exists only through the explicit Workspace
operation below.
Search is two explicit calls—global and active project—and returns typed hits:

```ts
interface ScopedMemoryHit extends RankedHit {
  scope: 'global' | 'project'
  scopeId: string // required byte string: "global" | "project:<id>" | "monitoring:<id>"
  projectId?: string
  sourcePath: string
  provenanceRef: string
}
```

For automatic recall, global hits and active-project hits may be ranked
together after both pass their own forget/tombstone filters. Other projects are
not queried. If the active project index is unavailable, the system degrades to
global-only recall with an explicit warning; it never substitutes another
project.

Workspace also exposes an explicit read-only `search_all_projects` operation
for requests such as “найди по всем проектам”. This is an operator-authorized
operation, not an autonomous model tool: the authenticated pre-router mints a
one-use `CrossProjectSearchReceipt` bound to owner, Workspace session,
selection generation, normalized query hash, mode and archive flag. The service
consumes that receipt and fans out to each eligible Project's isolated index,
takes a bounded top-k per project, and deterministically merges labelled hits
containing `projectId`, project name, path and provenance. Each hit carries a
short-lived, one-use `ExcerptReadCapability` bound to that exact
project/path/chunk/content hash; `open_search_hit` cannot accept an arbitrary
path. A model call, prompt-injected instruction, nested tool call, missing,
replayed, wrong-query or stale receipt fails closed. There is no shared
all-project index and ordinary Workspace recall remains project-free. Archived
projects are excluded unless explicitly requested by the operator. Opening a
selected excerpt is read-only; changing a found file requires an authorized
switch to its project.

```ts
interface WorkspaceProjectSearch {
  searchAllProjects(
    workspaceLease: TurnContextLease,
    receipt: CrossProjectSearchReceipt,
    query: string,
    opts: { mode: 'keyword' | 'semantic' | 'hybrid'; limitPerProject: number },
  ): Promise<ProjectSearchHit[]>
  openSearchHit(
    workspaceLease: TurnContextLease,
    capability: ExcerptReadCapability,
  ): Promise<string>
}
```

Creating a session persists its frozen prefix bytes, hash and source manifest.
Resuming that session reloads and verifies those exact bytes even if Workspace
DNA files have changed since creation. A missing or mismatched snapshot fails
closed with a doctor/new-session recovery choice; it is never silently rebuilt.
Only creation of another session observes newer DNA. Writes made during a
session are immediately searchable through the lazy layer but do not mutate
that session's frozen prefix.

### 7.1 Keyword, semantic, and hybrid retrieval

Aisy implements the three reference modes from ADR-0065:

- `keyword` uses scoped FTS5/BM25 and is always local/available;
- `semantic` embeds the query through the configured `EmbeddingProvider` and
  searches the scope's local sqlite-vec index by cosine similarity;
- `hybrid` (default when embeddings are healthy) retrieves at most 20
  candidates per leg and scope and merges them with RRF constant `k=60`,
  retaining scope/path/provenance labels. Ties sort by fused score descending,
  best component rank ascending, then `scopeId`, `sourcePath`, and `chunkId`
  ascending.

The first embedding adapter is OpenRouter, connected in Telegram settings. The
UI discloses before opt-in that both query text and selected memory/knowledge
chunks leave the server for embedding. Disconnecting or revoking the provider
atomically blocks new calls, purges its query cache, and schedules deletion of
all provider-scoped document cache/vector rows before semantic mode can be
re-enabled. Without a healthy key, `semantic` returns
`SEMANTIC_UNAVAILABLE`; `hybrid` visibly degrades to keyword rather than failing
or returning an unscoped result.

Chunking is deterministic by Markdown heading and bounded token window. Each
row stores scope/project id, source path, provenance, content hash, provider,
model id/revision, dimensions, normalization version and chunker version.
Document and query embeddings are cached by
`SHA-256(provider || model-id || model-revision || dimensions || normalization-version ||
chunker-version || normalized-content-hash)`; unchanged content makes no API
call. A change to any keyed field invalidates only the affected derived scope.
Global, each Project, and monitoring use separate vector tables/files. The
forget/live filter is applied before candidate ranking and at lazy load, so
vectors cannot resurrect a deleted fact.

Only canonical memory and knowledge are indexed by default. Arbitrary project
source trees require an explicit per-project indexing opt-in and code-owned
excludes. Before every external embedding request, deterministic secret
scanning checks path policy, known credential formats and high-entropy tokens.
A matching document chunk is skipped whole and audited; a matching query never
leaves the host, `semantic` reports `SENSITIVE_INPUT_LOCAL_ONLY`, and `hybrid`
uses keyword only. Vaults, `.env`, credentials, control-plane state, inbox
objects and ignored/protected paths are never sent to an embedding provider.
For `search_all_projects`, the query is embedded once per full cache-key version
and reused against isolated indexes; per-project caps prevent a large repository
from crowding out all other projects.

The global journal contains only explicit cross-project facts/summaries and
opaque project-event references (`projectId`, note hash, timestamp). Detailed
project text is written only to the project journal. Outside the owning project,
opaque references are not semantic recall candidates and their target text is
never loaded. This preserves a useful global activity chronology without
mixing Project A details into Workspace or Project B.

## 8. Deterministic memory and file routing

The model selects a semantic intent; code selects and validates the physical
destination. All write APIs accept the lease, a typed category, content, and a
provenance reference. They do not accept an unchecked absolute path.

| Semantic content | Canonical destination |
|---|---|
| Operator-owned constitution | Workspace `constitution.md` only through a separate authenticated operator operation with explicit confirmation; no model/profile tool can mutate it |
| Agent character/instructions | Workspace `SOUL.md` or `CLAUDE.md` through typed, reviewed profile tools |
| Operator fact/contact/preference | Workspace `USER.md`, `PREFERENCES.md`, plus `memory/facts/<id>.md`; generated `MEMORY.md` is refreshed |
| Mission or long-term goal | Workspace `MISSION.md` / `GOALS.md` |
| Demonstrated reusable pattern | Workspace `LEARNED.md`, with evidence and ADR-0061 promotion state |
| Explicit cross-project daily event | Workspace `memory/YYYY-MM-DD.md` |
| Project decision/work note | Active project `memory/YYYY-MM-DD.md` plus an opaque global event reference |
| Active multi-step work | Active project `.current-task.md`; Workspace equivalent only while Workspace is active |
| Research/template/configuration | Active project `knowledge/<code-owned-name>.md` |
| Explicitly cross-project knowledge | Workspace `knowledge/<code-owned-name>.md` |
| Durable project task | Active project `tasks/` store |
| Generated work product/source code | Relative path under the active context root after ownership checks |

Routing rules:

- Project-local writes require `projectKind=project`; there is no “last project”
  fallback while Workspace is active.
- Cross-project promotion is an explicit typed operation with provenance.
- `MEMORY.md` is regenerated deterministically from live facts. Generation
  warns when the projected prefix reaches 8 KiB and refuses a >10 KiB prefix
  until consolidation; it never rejects or loses the underlying canonical fact
  file. Daily notes and knowledge remain lazy-loaded.
- A memory commit uses a scope-exclusive WAL state machine:
  `PREPARED → DB_PENDING → FILE_INSTALLED → PUBLISHED → AUDITED`. The readable
  fact object is staged with hashes; SQLite stores the fact as `published=0` and
  an idempotent audit outbox; after descriptor-safe file installation a second
  transaction sets `published=1`; the outbox appends the audit row exactly once.
  All memory reads/search/snapshot/enumeration take the scope barrier and expose
  only `published=1` rows whose expected file exists. They remain blocked while
  recovery resolves an in-flight WAL, so neither a raw installed object nor a
  pending DB row is an authoritative visible fact. Restart recovery completes
  or tombstones/rolls back by operation id before serving reads.
  Tombstones and the `do_not_remember` chain stay in protected state and apply
  to file enumeration, snapshot generation, FTS, rebuild and every lazy load.
- Duplicate candidates are detected before append.
- Context roots may be ordinary descendants of the home directory, including
  the defaults. The home directory itself or any ancestor of it is invalid, and
  a context root must be disjoint (neither ancestor nor descendant) from every
  control-plane/vault/inbox/session/index/migration/staging path.
- `ConfinementPort` performs lexical registry validation followed by a
  descriptor-relative, no-follow filesystem walk. Linux uses `openat2` with
  `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV`; other platforms
  use an equivalent descriptor walk with `O_NOFOLLOW`, or fail closed for
  writes when race-safe confinement is unavailable. This covers symlink-swap,
  mount-point and TOCTOU attacks rather than relying on a pre-open `realpath`.
- `bash` is available only inside a sandbox that mounts the leased root and no
  control-plane, home, vault, inbox, session or index path; it receives an empty
  synthetic home and no secret environment by default. If the sandbox is
  unavailable, bash is disabled with a diagnostic while confined file tools and
  conversation remain available.
- Subagents receive an immutable child lease bound to the parent's project and
  never receive `project.switch`; only the authenticated interactive control
  plane changes selection. They never inherit a later parent selection.

## 9. Project creation, clone, and initialization

All creation paths use one staged transaction guarded by an exclusive
`projectsRoot` reservation lock:

1. Normalize the name, derive a collision-free slug, and atomically reserve both
   slug and final root. Concurrent create/clone calls for the same destination
   yield one winner and one deterministic `PROJECT_ROOT_RESERVED` result.
2. Create a random staging directory beside the final destination without
   publishing a registry row.
3. For a new project, initialize the layout. For a clone, run the restricted
   adapter below through the existing approval and action-contract path.
4. Write project metadata and required empty catalogues in staging.
5. Scan the tree through `ConfinementPort`; reject escaping symlinks, special
   files and nested mount points before publication. Submodules and hooks are
   not initialized or executed.
6. Atomically rename staging to the final root, create the registry row and
   initial session, publish selection, and regenerate Workspace `PROJECTS.md`.
7. Release the reservation only after publication or durable quarantine.

The first slice accepts only normalized public HTTPS repository URLs matching
`https://<public-dns-host>/<non-empty-path>` after WHATWG parsing. It rejects
userinfo/embedded credentials, fragments, query strings, control characters,
non-default local transports (`file`, `ext`, scp syntax), a first path/remote
component beginning with `-`, private/loopback/link-local DNS results, and any
redirect. SSH/private repositories are deferred to a separately authenticated
adapter instead of weakening this path.

Git is invoked as an argv array with explicit option termination and destination:
`git -c protocol.file.allow=never -c protocol.ext.allow=never -c
http.followRedirects=false clone --no-recurse-submodules -- <url> <staging>`.
The child runs in a dedicated clone sandbox. Its controlled resolver and
kernel egress policy deny private, loopback, link-local, metadata and reserved
ranges at connect time, so a second DNS answer cannot bypass the preflight.
Redirects remain disabled. The staging filesystem has a hard byte/inode quota;
cgroups bound memory, CPU, pids and wall time; clone defaults to shallow,
no-checkout/blob-filtered transfer where supported; post-transfer scan caps
file count, depth, individual and total expanded bytes before checkout/publication.

The child receives `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` disabled,
`GIT_LFS_SKIP_SMUDGE=1`, a minimal environment, bounded stdout/stderr with URL
redaction, and a process-group timeout that terminates descendants. Quota or
egress violations kill the process group and publish no project.

If any step before registry publication fails, no project is selectable and
the staging directory is retained/quarantined with a recovery id or cleaned by
an explicit doctor action. If registry publication fails after filesystem
rename, doctor detects the orphan and offers “register” or “quarantine”; Aisy
does not guess or delete it.

`registerExistingProject` is separate because it adopts pre-existing files. It
performs canonical/protected-root checks, overlap and repository detection, a
race-safe tree scan, and a preview/confirmation when outside `projectsRoot`.

## 10. Attachment inbox and import

Telegram/local attachments first enter `~/.aisy/inbox/<operator>/<upload-id>`
outside every context root with mode-restricted metadata. They are untrusted
session inputs and are never copied into Workspace memory, a project, or search
merely because they arrived.

```ts
interface ProjectFileManifest {
  fileId: string
  operatorId: string
  projectId: string
  sessionId: string
  source: 'telegram' | 'local' | 'generated' | 'import'
  originalName: string
  relativePath: string
  sha256: string
  provenanceRef: string
  createdAt: string
  importedFromFileId?: string
}
```

`importAttachment(lease, fileId, semanticDestination)` resolves a code-owned
relative destination, stages a copy, verifies hash and confinement, then uses a
project-exclusive WAL: `PREPARED → MANIFEST_PENDING → FILE_INSTALLED →
PUBLISHED → AUDITED`. The internal manifest store has a `published` flag and an
idempotent append-only-log outbox. Project file tools take the same scope
barrier and expose an imported destination only when its published manifest and
hash agree; recovery runs before the project is served. Thus a crash between
rename, manifest publication or audit append cannot expose one resource without
the other through Aisy. Name collisions produce a choice; overwrite requires
its own approval. Interruption leaves the inbox object intact. A foreign
owner/session or archived target fails before I/O.

## 11. Durable jobs, grants, and scoped autonomy

Every persisted goal, trigger, monitor, digest, subagent delegation, approval
grant, and current-task record carries a non-null binding:

```ts
interface WorkBinding {
  operatorId: string
  profileId: string
  projectId: string
  sessionId?: string
  scope: 'workspace' | 'project' | 'session'
}
```

Registration captures the active lease once. Later user switches never retarget
the record. On firing/restart the scheduler resolves the stored binding and
acquires a background lease for that exact context; it does not consult the
interactive selection. A session-scoped job pauses when its session is
archived. A project/workspace job uses a dedicated append-only system session.
Archiving a project pauses all of its jobs and revokes runtime use of its grants
until restore; running jobs are cancelled at a tool boundary.

Legacy records with a legacy session id bind to the migrated legacy project.
Unscoped goals/triggers/digests are quarantined paused for operator review;
legacy grants remain disabled until assigned to Workspace or a project. Global
nightly integrity maintenance binds to Workspace but may process a project only
through an explicit per-project maintenance lease. This migration is
identifier-only and never silently broadens a grant.

## 12. Telegram and natural-language experience

The normal reply keyboard remains hidden while the operator is composing or
sending free text. Project controls are opened explicitly from the compact
menu or commands.

The project screen contains:

- `🏠 Workspace` with the current marker when selected.
- One button per active project, paginated.
- `➕ Новый проект`.
- `📥 Клонировать репозиторий`.
- `📂 Подключить существующий`.
- `🗂 Сессии` for the selected context.
- `◀️ Назад`.

After selection Aisy sends a concise confirmation containing the context name,
session name, and root (home-abbreviated, not a secret), then removes the
inline picker. Free-text handling continues with no reply keyboard attached.

Natural-language routing supports Russian and English intent forms. It is not
implemented as a list of brittle phrases alone:

- Deterministic parsing handles unambiguous high-frequency commands and exact
  names from the registry.
- The model has structured `project.list`, `project.create`, `project.clone`,
  `project.switch`, and `session.*` tools for varied language and compound
  instructions.
- Every route calls `ProjectService`; authorization, approval, validation,
  persistence, and events are identical.
- Ambiguous names produce a choice card. A low-confidence create/switch intent
  asks one focused question instead of creating a directory.

## 13. Failure handling and recovery

| Failure | Required behaviour |
|---|---|
| Registry missing | Create one Workspace record and imported session idempotently |
| Registry v1 | Run the explicit v1→v2 migration described below |
| Registry corrupt | Fail closed; `aisy doctor` reports identifiers and recovery options |
| Workspace root unavailable | Keep internal state intact; block context-dependent turns with a clear recovery message |
| Project root unavailable | Allow switch/list metadata, but block file/project-memory actions; never substitute Workspace root |
| Project index unavailable | Global-only recall plus scoped warning; rebuild that project's derived index |
| Global memory unavailable | Do not start an agent turn without its identity prefix; diagnostics/menu remain available |
| Name matches multiple projects | Show disambiguation buttons; no state change |
| Clone/auth/network failure | No registry publication; preserve a redacted diagnostic and recovery id |
| Disk full/atomic rename failure | Keep old state authoritative; no partial JSON or half-published manifest |
| Switch during in-flight turn | Quiesce/abort the old lease; after the barrier it fails `STALE_CONTEXT` before I/O |
| Sandbox unavailable | Disable bash; keep confined file tools and diagnostics available |
| Protected/control root requested | Reject before registry publication or filesystem access |
| Stale callback button | Reject using callback generation/owner binding and redraw current state |

Errors and events contain ids, normalized error codes, and safe path metadata;
they do not include file contents, provider credentials, clone credentials, or
private project/session names in broad logs.

## 14. Migration and rollback

Migration is an exclusive, crash-resumable cutover. `aisy run` enters
maintenance mode, pauses schedulers, rejects state-changing callbacks/turns, and
acquires `~/.aisy/migrations/workspace-v2.lock` before touching state. A
permission-restricted manifest records source checksums, every backup, every
created artifact and these durable phases: `PREPARED`, `COPIED`, `VERIFIED`,
`COMMITTED`, `V2_WRITES_ENABLED`.

The idempotent procedure is:

1. Load and fully validate v1, the legacy memory DB/files, session log, jobs and
   grants without modifying them. Take a SQLite online backup while writers are
   closed, plus checksummed backups of `projects.json`, generated/identity files
   and any existing `PROJECTS.md`.
2. Treat every v1 row—including `isDefault=true`—as `kind: "project"` with
   `origin: "legacy"`. This is deliberate: v1 populated its default root from
   `AISY_WORKSPACE ?? process.cwd()`, so it may be an ordinary repository. Keep
   its id, root, sessions and current selection. Derive a safe slug and run all
   protected-root/confinement checks; an unsafe conflict stops for doctor.
3. Create a separate Workspace record with a new id at the explicit v2 global
   root (default `~/workspace`; new setting `AISY_GLOBAL_WORKSPACE`). V1 has no
   trustworthy Workspace marker, so no v1 repository is auto-promoted. If the
   requested global root overlaps a legacy project, migration stops and offers
   an explicit relocate/designate choice; it never guesses. Create a Workspace
   session without changing the preserved active legacy-project selection.
4. Copy all legacy prefix files—including `constitution.md`, `SOUL.md`,
   `USER.md`, `MEMORY.md` inputs and the remaining ADR-0063 DNA files—through a
   staging area only when destinations are absent. Any content conflict stops
   with both hashes and no publication.
5. Copy only authoritative legacy ledger state losslessly into the new global
   protected store, preserving ids, live facts, invalid/tombstoned rows,
   supersedure/contradiction edges, provenance and the complete hash-chained
   `do_not_remember` table. Export only live, non-forgotten fact content to
   canonical `memory/facts/<id>.md` files, then rebuild legacy FTS rows into
   the physically separate disposable retrieval database and generate vector
   state only through ADR-0065. Regenerate bounded `MEMORY.md`, and verify
   ledger integrity, table/row counts, id sets, forget-chain head, disposable
   index/search equivalence and frozen-prefix contents against the source. Forgotten
   text is not re-exported to readable files. The untouched backup remains the
   rollback source.
6. Preserve the legacy event log byte-for-byte and checksum-anchor it. Mark
   every migrated legacy session `resumeCapability: "metadata-only"`; missing
   dialogue is never fabricated, and continuing full-fidelity work creates a
   new v2 session linked by a migration-boundary event. V2 transcript envelopes
   contain `eventId`, owner/context/session ids, durable `sessionSeq`, role,
   provenance, full content/tool observation, timestamp, `prevSessionHash` and
   `rowHash`. Appends are serialized/fsynced and manifests advance the counter
   atomically/idempotently. This supersedes ADR-0044 through ADR-0064.
7. Apply §11 to legacy goals, triggers, digests and grants: session-linked work
   binds to the legacy project; unscoped work is paused/quarantined and grants
   disabled pending review.
8. In staging, build v2 JSON with persisted selection generation `1`, session
   manifests, indexes and generated catalogues. Validate all v2 invariants and
   run cross-scope negative probes before publication.
9. Atomically publish v2 registry and manifests, publish only manifest-listed
   Workspace files, regenerate `PROJECTS.md`, and write `COMMITTED` while all
   turns/callbacks/schedulers remain gated. After final verification, fsync the
   terminal `V2_WRITES_ENABLED` phase *before* releasing any write gate or the
   migration lock. Automatic downgrade is forbidden from that phase onward,
   even if no user mutation has happened.

On restart, the manifest phase determines recovery. Before `COMMITTED`, Aisy
removes only manifest-created artifacts whose hashes still match, restores all
backups, and retries or returns to v1. After `COMMITTED` but before
`V2_WRITES_ENABLED`, doctor can perform the same automatic rollback: restore v1 JSON
and generated files, remove only unchanged copied artifacts, use the untouched
legacy memory, and leave the append-only log and every pre-existing project root
unchanged. Staging/quarantine roots are never recursively guessed or deleted.
At and after `V2_WRITES_ENABLED`, automatic downgrade is refused because v2
writes may already exist; doctor pauses execution and exports a checksummed
recovery bundle and forward-repair plan. Crash tests immediately before/after
terminal-phase fsync and gate release, plus callback/job races, prove that
either v1 or v2 is authoritative and writes never reach both.

## 15. Observability and privacy

Add identifier-only lifecycle events:

- `context.workspace_migration_phase`, `context.workspace_migrated`
- `project.created`, `project.clone_started`, `project.clone_completed`
- `project.selected`
- `session.created`, `session.selected`, `session.archived`, `session.restored`
- `context.lease_acquired`, `context.assembled`
- `memory.route_selected`, `memory.scope_degraded`
- `attachment.received`, `attachment.imported`
- `job.binding_resolved`, `job.paused_context_archived`
- `project.root_unavailable`, `project.index_rebuild_requested`

Each turn-start event binds `projectId`, `sessionId`, lease generation, and
hashes of the global prefix and active-project catalogue. Tool events bind the
same lease identifiers. This makes a cross-project access claim externally
auditable without logging content.

Metrics include switch success/failure, project creation/clone latency,
context-assembly latency, scoped recall hit counts, index degradation, and
path-confinement denials. Project and session names are high-cardinality private
labels and are excluded from metrics.

## 16. Security model

- The Telegram owner id and profile are verified before every context lookup.
- Callback data is nonce/generation bound and cannot select another owner's
  record or replay a stale selection.
- Switch authority comes only from the authenticated operator span or a bound
  callback; repository/web/attachment text cannot authorize a context change.
- The model never receives or chooses an unchecked absolute path.
- Ordinary roots below home are allowed, but home itself/its ancestors and all
  overlapping control-plane/vault/inbox/session/index trees are rejected;
  descriptor-relative confinement rejects symlinks and mount escapes.
- Clone URLs are redacted before logging; embedded credentials, local protocols,
  redirects and private destinations are rejected.
- Repository content, web content, and attachments remain untrusted
  provenance. Switching projects does not upgrade their trust.
- Global profile mutation uses typed memory/profile tools. A project file tool
  cannot write into `~/workspace` through `../`, symlinks, mounts, or a shell
  working-directory trick.
- Bash is disabled unless the sandbox exposes only the leased root with an
  empty home and secret-free environment.
- Project autonomy grants, triggers, agents, and digests are scoped by
  `projectId`; a global grant is a separate explicit operator action.
- Archiving is reversible and does not delete files or transcripts. No hard
  deletion is introduced by this slice.

## 17. Test and acceptance matrix

### Registry and migration

1. **WP-01** Fresh state creates exactly one selectable Workspace and one
   session at `~/workspace` (or configured root).
2. **WP-02** V1 migration preserves every old id/root/session and the active
   selection by classifying the old default as a legacy Project, while creating
   a separate Workspace; a repository is never auto-promoted to global scope.
3. **WP-03** Memory migration preserves fact/tombstone/relationship id sets,
   row counts, forget-chain head, integrity and live-search results; forgotten
   text is absent from exported files and `constitution.md` remains in prefix.
4. **WP-04** The legacy event log is byte-identical and its sessions are
   honestly `metadata-only`. New v2 envelopes persist full content, durable
   session ordering and a valid per-session hash chain without duplicate rows
   across retry/restart.
5. **WP-05** Crash injection at every cutover phase—including immediately
   before/after `V2_WRITES_ENABLED` fsync and write-gate release—leaves exactly
   one authoritative schema; rollback is forbidden once v2 writes are enabled.
6. **WP-06** Multiple Workspace rows, root overlaps, invalid kinds/slugs,
   protected/home/control roots, dangling sessions, and foreign-owner
   selections fail closed.
7. **WP-07** Workspace cannot be archived. Archiving the active project
   atomically selects Workspace and increments generation; archiving the active
   session atomically selects/creates a replacement. Restore revalidates roots
   and never deletes or auto-selects state.

### Context and isolation

8. **WP-08** The same global DNA fact is available in Workspace, Project A, and
   Project B.
9. **WP-09** A Project A memory/file marker is absent from automatic Workspace
   and Project B recall after restart, compaction, and index rebuild.
10. **WP-10** A project-specific journal marker stays in Project A; other
    contexts see at most a non-semantic opaque event reference.
11. **WP-11** Switching A→B selects or creates a B-owned session and never
    reuses A's transcript, retrieval spans, tool results, or current task.
12. **WP-12** A new session captures a new frozen prefix; resuming an old session
    after DNA changes reloads its original byte-identical prefix/hash.
13. **WP-13** Within-session writes are immediately searchable without changing
    frozen prefix bytes, and compaction leaves the transcript byte-identical.
14. **WP-14** Concurrent switch/tool fixtures quiesce old operations, persist a
    monotonic generation through restart, and reject closed leases/callbacks
    with `STALE_CONTEXT` before I/O.
15. **WP-15** Untrusted repo/web/attachment instructions cannot switch context.
    Missing, replayed, expired, wrong-target and stale-generation receipts fail
    at `ProjectService`; a compound operator request switches before retrieval
    and carries no old-project spans.

### Files, creation, clone, and attachments

16. **WP-16** Every live read/write/list/bash/import operation carries one
    validated lease and resolves below its leased root before I/O.
17. **WP-17** Absolute/traversing paths, nested/protected roots, cross-project
    session ids, symlink swaps, magic links and cross-mount escapes fail in
    descriptor-relative adversarial fixtures before target I/O.
18. **WP-18** Without the root-only sandbox, bash is unavailable and cannot see
    home, vault, control-plane files or secret environment; confined file tools
    remain usable.
19. **WP-19** New-project and valid public-HTTPS clone flows initialize the
    layout, publish one registry row/session, and update `PROJECTS.md`.
20. **WP-20** Clone rejects option injection, userinfo, redirects,
    private/loopback targets, local/ext/file/scp transports, DNS rebinding at
    connect time, escaping symlinks, pack/expanded disk or inode bombs, and
    CPU/memory/pid/time/output limit violations without publishing a project.
21. **WP-21** Two concurrent requests for the same slug/root produce one
    published project and one deterministic reservation failure.
22. **WP-22** Clone, disk-full and atomic-rename failures publish no selectable
    project and expose only a recoverable redacted diagnostic.
23. **WP-23** Attachment import verifies owner/session/hash, confines a
    code-owned destination, publishes file+manifest atomically and preserves
    untrusted provenance.
24. **WP-24** Crash injection at every attachment WAL boundary, collision,
    foreign owner/session and archived target exposes neither destination nor
    manifest independently through Aisy; retry is idempotent and inbox remains.

### Memory routing

25. **WP-25** Every semantic category in the routing table lands in exactly the
    documented scope/path with a provenance reference.
26. **WP-26** Project-local writes are rejected while Workspace is active;
    cross-project promotion requires the explicit typed operation.
27. **WP-27** Crash injection at every memory WAL boundary never exposes a
    searchable fact without its readable object/audit state (or vice versa);
    retry is idempotent. Generated `MEMORY.md` remains ≤10 KiB without fact loss,
    and rebuild preserves tombstone/forget-list invariants.
28. **WP-28** Project-index failure produces global-only results and never a hit
    from another project's index.
29. **WP-29** `keyword`, `semantic`, and `hybrid` return scoped labelled results;
    hybrid uses per-leg cap 20, RRF `k=60`, and the documented stable tie-break
    order over BM25+cosine candidates.
30. **WP-30** Unchanged chunks/query use the full provider/model-id/model-revision/
    dimensions/normalization/chunker/content cache key with zero new embedding
    calls; changing any keyed field rebuilds only the affected scope.
31. **WP-31** Tombstoned/forgotten facts, protected paths and chunks/queries
    matching deterministic secret fixtures are absent from external requests,
    vector build, search and lazy load in every scope. Query blocking degrades
    locally, and provider revocation prevents calls and purges provider-scoped
    caches/indexes.
32. **WP-32** Missing/failed OpenRouter produces visible
    `SEMANTIC_UNAVAILABLE`; keyword still works and hybrid degrades to keyword
    without cross-project fallback.
33. **WP-33** Explicit Workspace all-project search with a valid one-use,
    owner/query/generation-bound receipt fans out isolated active project
    indexes, labels every hit, applies per-project caps and can load only the
    exact excerpt bound to its one-use capability. Missing/replayed/stale/
    wrong-query/wrong-mode/wrong-archive receipts, model/prompt-injected/nested calls and arbitrary-path
    excerpt reads fail closed; ordinary Workspace recall still returns no
    project-local marker and writes require switching.

### Telegram and natural language

34. **WP-34** Menu selection and Russian/English natural-language selection call
    the same service and produce the same persisted selection/lease.
35. **WP-35** Ambiguous names show owner-bound choices and do not mutate state.
36. **WP-36** The reply keyboard is absent from ordinary free-text replies;
    project/session controls appear only in the explicit inline menu flow.
37. **WP-37** Stale, replayed and foreign-owner callbacks cannot mint/consume a
    valid switch receipt or change context.

### Durable runtime and audit

38. **WP-38** Main agent, goal loop, trigger, monitor, digest, nightly task and
    subagent all receive an explicit binding/lease; no live path falls back to
    startup cwd, chat id, or current interactive selection.
39. **WP-39** A delayed Project A job still runs only in A after the user
    switches to B; archiving A pauses it. Legacy unscoped jobs/grants are
    quarantined/disabled rather than promoted globally.
40. **WP-40** Restart restores the exact active context/session/generation. A
    v2 session reconstructs its full append-only view and original prefix;
    migrated legacy sessions expose metadata only and never fabricate dialogue.
41. **WP-41** Lifecycle/tool/migration/job events prove
    project/session/generation binding without exposing content, names, secrets,
    clone credentials, or attachment bytes.

Release requires all 41 checks plus the existing core, app, and Telegram test
suites, typechecks, and builds. It also requires: an adversarial path/clone
suite; crash-at-each-migration-phase fixtures; and a two-project Telegram E2E
trace proving switch, resume, file import and negative recall isolation. Narrow
unit tests alone cannot establish the approved behaviour.

## 18. Delivery order

1. Registry v2 types, persisted selection generation, lifecycle validation,
   migration lock/manifest state machine, and crash-fixture harness.
2. Lossless memory-ledger/file export, session-manifest, job/grant migration and
   pre-cutover equivalence verifiers—without publishing v2 yet.
3. `ProjectService`, root/layout adapters, project archive/restore,
   create/register/restricted-clone transaction, reservations and doctor
   recovery.
4. `ContextLeaseCoordinator` and per-turn runtime factory; remove fixed startup
   root/session/chat-id fallbacks from all live execution paths.
5. Layered global/project memory, safe global journal, persisted frozen session
   snapshots, routing/context assembly, OpenRouter embeddings, scoped
   sqlite-vec indexes, cache, RRF and explicit all-project search.
6. Descriptor-relative confinement, protected roots, root-only bash sandbox and
   attachment inbox/import.
7. Durable project/session bindings for goals, triggers, monitoring, digests,
   nightly work, grants and subagents.
8. Telegram project/session UI, authenticated natural-language pre-router,
   structured tools and context-change barrier.
9. Exclusive v2 cutover, restart/rollback validation, adversarial suites,
   two-project Telegram E2E and evidence-matrix update.

Each step lands behind tests and preserves the old live path until its
replacement is proven. Normal writes stay gated during cutover. V2 publishes
only after registry, memory, transcript, job, confinement and lease equivalence
checks pass; rollback follows the phase manifest in §14 and never deletes an
unlisted/pre-existing root.

## 19. References

- `docs/decisions/2026-07-26-project-scoped-sessions-file-ownership.md`
- `docs/decisions/2026-07-26-layered-workspace-project-memory.md`
- `docs/decisions/2026-07-26-full-fidelity-session-transcript.md`
- `docs/decisions/2026-07-26-hybrid-vector-keyword-retrieval.md`
- `docs/specs/17-projects-sessions-context-files.md`
- `docs/specs/15-context-engine.md`
- `docs/reviews/2026-07-26-reference-screen-contract-matrix.md`
- `docs/reviews/2026-07-26-reference-assistants-live-gap-audit.md`
