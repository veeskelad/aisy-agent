# Component 03: Memory — Specification

**Status:** Draft
**Component:** 03 / 17
**Related ADRs:** ADR-0006, ADR-0007, ADR-0008, ADR-0023, ADR-0024, ADR-0030, ADR-0065, ADR-0088
**Depends on:** Core / Agent Loop (#01), Nightly Consolidation (#10), Observability & Verification (#12)

> Memory is the durable, human-readable, git-versioned substrate the harness reads from and writes to so the agent persists across sessions even though the stateless model does not — and the deterministic layer that makes "forget this" actually stick on every path.

## 1. Purpose

The language model is a stateless probabilistic CPU: it forgets everything the moment a request returns. Memory is the part of the OS that survives the CPU. It owns four file levels (markdown in git), a per-session frozen snapshot, three-step lazy retrieval over an SQLite FTS5/BM25 index, and the durable-forgetting machinery (bi-temporal facts, a forget-list, a resurrection-guard, contradiction resolution).

Aisy's memory follows a three-layer structure:

- **Raw/Immutable Input Layer** — daily logs (`memory/YYYY-MM-DD.md`) and archive; the generator's read-only input during nightly consolidation. Files rotate and are archived but are never modified after writing.
- **Canonical Fact/Wiki Layer** — readable live facts in `memory/facts/*.md`
  plus `working/*.md`; all changes pass the scoped commit/WAL choke point.
- **Generated Prefix and Schema/Config Layer** — `MEMORY.md` is a
  deterministic bounded projection of live facts, while `AGENTS.md` and
  `constitution.md` are human-owned normative framing. The projection is
  never an authored fact sink.

The split between deterministic code and the model is sharp here:

- **Deterministic code (100%):** the indexer choke point, the read/ingestion filter `WHERE invalid_at IS NULL AND fact_key NOT IN (SELECT fact_key FROM do_not_remember)`, the resurrection-guard, contradiction resolution, the frozen-snapshot read, fact-key extraction, corruption detection/rebuild, and deterministic MEMORY.md serialization. Forgetting is code, never a prompt instruction at ~70% adherence (NIST: at least one deterministic enforcement layer not judged by an LLM).
- **The model (~70%):** decides *whether to deepen* a lazy-load (annotation → overview → full), proposes ADD/UPDATE/DELETE/NOOP operations during nightly consolidation, and drafts annotations/overviews. It never decides to actually delete, resurrect, or commit a fact.

## 2. Responsibilities

What this component **owns**:

- The four retrieval levels: полный global DNA prefix из `constitution.md`,
  `SOUL.md`, `USER.md`, generated `MEMORY.md`, `MISSION.md`, `GOALS.md`,
  `PROJECTS.md`, `PREFERENCES.md`, `LEARNED.md`, `CLAUDE.md` и `SERVICES.md`
  в этом code-owned порядке (Level 1, always-loaded prefix),
  `memory/YYYY-MM-DD.md` (Level 2), `working/*.md` (Level 3), and
  `archive/*.md` (Level 4). Canonical authored sources are the human-owned
  config/DNA files, daily/working/archive files and `memory/facts/*.md`;
  `MEMORY.md` is the deterministic projection defined by ADR-0063
  ([ADR-0006](../decisions/2026-06-11-file-based-memory-fts5-bm25.md)).
- The **single indexer choke point** every write, reindex, and import passes through ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md)).
- A protected, backup-verified ledger database containing bi-temporal fact
  state (`valid_at`, `invalid_at`, `is_human_confirmed`, fact-key),
  relations and the `do_not_remember` forget-list; plus physically separate,
  disposable FTS5/BM25/vector/cache databases rebuilt only while the ledger is
  healthy.
- The read/ingestion filter, the resurrection-guard, fact-key (equivalence-class) extraction, and contradiction resolution as **deterministic** code.
- The frozen per-session snapshot read of Level 1 ([ADR-0007](../decisions/2026-06-11-frozen-memory-snapshot.md)).
- Three-step lazy loading (annotation → overview → full) over ranked candidates ([ADR-0008](../decisions/2026-06-11-three-step-lazy-memory-loading.md)).
- Separate protected-ledger and disposable-index integrity checks; only
  disposable FTS/vector/cache state may rebuild from files, and only while the
  verified forget ledger is healthy.
- The forget-invariant contract that **every derived index** (FTS5/BM25 and the
  first-class scoped vector index) must enforce.

What this component **does not** do (boundaries):

- It does **not** run the nightly batch, the generator/judge loop, the morning approval card, or daily-log rotation/cleaning. That is **Nightly Consolidation (#10)**; Memory exposes the primitives (op-model, guard, filter, reindex) the night calls.
- It does **not** assemble the prompt or own the KV-cache breakpoints. The frozen snapshot is *handed to* **Core / Agent Loop (#01)**, which places it in the stable prefix.
- It does **not** emit the append-only audit/journal stream or detect loops. Memory *writes records into* the journal owned by **Observability & Verification (#12)**.
- It does **not** classify untrusted input, enforce the sandbox, or own MCP allowlists. The fact that no MCP/sandbox mount may write the canonical memory tree is enforced at the **Safety (#05)** / **MCP (#07)** boundary; Memory states it as a required invariant and rejects any write that did not pass its own choke point.

## 3. Interfaces

Conceptual surface. The narrow-waist principle ([ADR-0014](../decisions/2026-06-11-narrow-waist-tool-set.md)) applies: every fact-mutating path funnels through `commit()`, and every read through `search()` / `load()`. There is **no** public method that writes a searchable fact while bypassing the indexer.

```ts
// illustrative, not binding

type FactKey = string // hash of normalized (entity, relation, object) equivalence class

interface MemoryFact {
  id: string
  text: string            // canonical surface form (markdown source of truth)
  factKey: FactKey
  validAt: string         // ISO; when the fact became true
  invalidAt: string | null // null === live; set === soft-deleted/superseded
  isHumanConfirmed: boolean
  sourceAuthority: number | null
  confidence: number | null
  provenance: string      // origin record id (session, log line, import)
  supersedes?: string     // fact_key this record replaces; sets predecessor invalid_at = now
  contradicts?: string    // fact_key that conflicts; flagged for human contradiction resolution
  extends?: string        // fact_key this record elaborates or specializes
}

// Personal memory is already owner/profile/scope-bound. A second-person
// surface form means the current operator under that binding; it is not a new
// mutable subject field and remains byte-identical through retrieval.
interface PersonalFactProjection {
  ownerId: string
  profileId: string
  scopeId: string
  text: string
  perspective: 'operator-memory'
}

type MemoryOp =
  | { op: 'ADD'; text: string }
  | { op: 'UPDATE'; targetId: string; text: string }
  | { op: 'DELETE'; targetId: string; humanConfirmed: boolean; reason: string }
  | { op: 'NOOP'; targetId: string }

type GuardVerdict =
  | { decision: 'PASS' }
  | { decision: 'BLOCK'; matched: 'tombstone' | 'forget_list' | 'human_confirmed_delete'; factId: string }
  | { decision: 'REVIEW'; reason: 'residual_paraphrase' } // fail-safe, never a silent commit

interface ScopedRankedHit {
  hitId: string
  scope: 'global' | 'project' | 'monitoring'
  scopeId: string // "global" | "project:<projectId>" | "monitoring:<monitorId>"
  projectId?: string
  sourcePath: string
  chunkId: string
  contentHash: string
  provenance: string
  score: number
}

interface ProjectSearchHit extends ScopedRankedHit {
  scope: 'project'
  projectId: string
  readCapability: ExcerptReadCapability
}

export interface Memory {
  // Every ordinary operation requires the immutable owner/context/session lease.
  // READ PATH — every result is filtered: invalid_at IS NULL AND fact_key NOT IN (SELECT fact_key FROM do_not_remember)
  search(lease: TurnContextLease, query: string, opts?: { limit?: number; mode?: 'keyword' | 'semantic' | 'hybrid' }): Promise<ScopedRankedHit[]>
  load(lease: TurnContextLease, hitId: string, step: 'annotation' | 'overview' | 'full'): Promise<string>

  // SESSION SNAPSHOT — read once at session start, frozen for the leased session
  readFrozenSnapshot(lease: TurnContextLease): Promise<{ bytes: Buffer; sha256: string }>

  // WRITE PATH — the SINGLE choke point. Within-session and nightly both call this.
  // Applies read filter + resurrection-guard + contradiction resolution, then reindexes.
  // Returns BLOCK/REVIEW without storing a searchable fact on guard hit.
  commit(lease: TurnContextLease, op: MemoryOp, ctx: { withinSession: boolean }): Promise<CommitResult>

  // FORGET-LIST — append-only, integrity-protected. No raw-write path exists.
  forget(lease: TurnContextLease, factId: string, reason: string, humanConfirmed: boolean): Promise<void>

  // DERIVED-INDEX CONTRACT — any reindex/import/rebuild routes here, never around it.
  reindex(lease: TurnContextLease, ids?: string[]): Promise<void>
  rebuildFromFiles(lease: TurnContextLease): Promise<void>

  // DETERMINISM — byte-stable regeneration of the MEMORY.md index file
  serializeMemoryIndex(lease: TurnContextLease): Promise<{ content: string; sha256: string }>

  // INTEGRITY — protected-ledger verification plus disposable-index checks
  integrityCheck(lease: TurnContextLease): Promise<{ ok: boolean; detail?: string }>
}

export interface WorkspaceProjectSearch {
  // Separate operator-authorized boundary; never callable with a Project lease
  // or without the one-use query-bound receipt.
  searchAllProjects(
    workspaceLease: TurnContextLease,
    receipt: CrossProjectSearchReceipt,
    query: string,
    opts?: { limitPerProject?: number; mode?: 'keyword' | 'semantic' | 'hybrid' },
  ): Promise<ProjectSearchHit[]>
  openSearchHit(
    workspaceLease: TurnContextLease,
    capability: ExcerptReadCapability,
  ): Promise<string>
}

interface CommitResult {
  status: 'COMMITTED' | 'BLOCKED' | 'ROUTED_TO_REVIEW' | 'SUPERSEDED'
  factId?: string
  verdict?: GuardVerdict
}
```

**Errors returned:** `CorruptIndexError` (fail-loud, never wrong/empty results), `ForgetListTamperError` (hash-chain break on `do_not_remember`), `BypassError` (a write that did not pass the choke point), `GuardBlocked` (resurrection match).

**Events emitted** (consumed by Observability #12): `memory.committed`, `memory.superseded`, `memory.guard_blocked`, `memory.routed_to_review`, `memory.index_corrupt`, `memory.rebuilt`. **Events consumed:** `session.start` (triggers frozen-snapshot read), `nightly.promote` (Nightly #10 promotes approved staged ops via `commit`).

## 4. Data structures

**Protected ledger fact row (bi-temporal columns).** This is the
authoritative unit of forgetting and contradiction resolution. FTS5 and vector
rows live in physically separate disposable retrieval databases and reference
`id`, `fact_key`, scope, content hash and ledger publication state; they do
not own bi-temporal truth.

| Column | Type | Purpose |
|---|---|---|
| `id` | text (uuid) | Stable identity |
| `text` | text | Canonical markdown surface form (files remain authoritative) |
| `fact_key` | text | Hash of the normalized `(entity, relation, object)` equivalence class — the match key for the guard and contradiction detection (§5.4) |
| `valid_at` | text (ISO) | When the fact became true |
| `invalid_at` | text or NULL | **NULL = live.** Set = soft-deleted/superseded. No hard `DELETE`. |
| `is_human_confirmed` | int (0/1) | Permanence flag; a human-confirmed fact/deletion can only be overturned by another human-confirmed one |
| `source_authority` | int or NULL | Contradiction tier 3 |
| `confidence` | real or NULL | Contradiction tier 4 |
| `provenance` | text | Origin record (binds to Observability journal) |

**`do_not_remember` (forget-list).** The negation primitive. **Append-only and integrity-protected** (hash-chained: each row stores `prev_hash` and `row_hash = H(prev_hash ‖ fact_key ‖ key_tokens ‖ reason ‖ ts)` — `key_tokens` is included so tampering the residual-paraphrase equivalence class breaks the chain too, CSO-H4), held outside agent-writable file scope ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §5).

| Column | Type | Purpose |
|---|---|---|
| `fact_key` | text | Equivalence-class key forgotten (catches paraphrases) |
| `reason` | text | Human-readable rationale; mitigates false blocks on legitimate re-learning |
| `is_human_confirmed` | int (0/1) | Permanence: a human-confirmed forget is never auto-resurrected by recency |
| `ts` | text (ISO) | When forgotten |
| `prev_hash` / `row_hash` | text | Hash-chain integrity (tamper-evident) |

**Frozen snapshot.** Source-reader собирает Level 1 files в фиксированном
порядке для каждой новой Session и возвращает bytes + `sha256`. Agent Loop
вызывает его один раз на Session, а durable transcript сохраняет эти exact
bytes для restart/resume. Prefix **byte-identical** внутри Session; правка DNA
становится видима только новой Session ([ADR-0007](../decisions/2026-06-11-frozen-memory-snapshot.md), [ADR-0019](../decisions/2026-06-11-stable-prefix-kv-cache.md), ADR-0063).

**MEMORY.md index file.** A compact (≤200-line) table of contents regenerated nightly. Its serialization **must be byte-deterministic**: facts sorted by a stable key (e.g. `(fact_key, valid_at, id)`), fixed timestamp format (UTC, second precision), `\n` line endings, no trailing whitespace, a single trailing newline. Two runs over identical inputs produce an identical SHA-256 (§5.7).

**Annotation / overview metadata.** Each indexed `working/`/`archive/` document carries a ~50-token annotation and ~500-token overview, regenerated whenever the body changes; both inherit the `invalid_at` / forget filter so a tombstoned doc never surfaces even as an annotation ([ADR-0008](../decisions/2026-06-11-three-step-lazy-memory-loading.md)).

## 5. Behavior & control flow

### 5.1 The indexer choke point (one path for every write)

Every path that adds or re-derives a searchable fact — within-session write,
nightly promotion, rebuild-from-files, MCP/import — passes through the same
lease-scoped `commit()` choke point ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §1). After the read filter,
resurrection guard and contradiction resolution, it acquires the scope-exclusive
barrier and runs the Component 17/Design §8 WAL:
`PREPARED → DB_PENDING → FILE_INSTALLED → PUBLISHED → AUDITED`.
`DB_PENDING` writes a `published=0` protected-ledger row plus idempotent audit
outbox; `FILE_INSTALLED` descriptor-safely publishes the hashed canonical file;
`PUBLISHED` verifies that hash, sets the ledger row `published=1`, and
updates the physically separate FTS keyword projection; `AUDITED` повторяет
доставку outbox с устойчивым `event_id`, пока идемпотентный приёмник не
подтвердит effective-once результат. Only then is the scope barrier released.
Семантический backfill — только положительная идемпотентная derivation после
публикации: он не владеет удалением и никогда не откатывает canonical state.
Недоступный, отозванный или устаревший vector scope помечает semantic unavailable
и переводит hybrid на keyword, но не блокирует ledger/file/FTS publication или
keyword reads. Fact reads expose only `published=1` ledger rows with the expected file
hash; keyword reads additionally require the matching FTS identity; vector
reads use only fresh matching rows and otherwise follow ADR-0065 degradation.
No filesystem, protected-ledger, FTS or audit path can independently publish a
keyword-searchable fact; off-choke-point writes raise `BypassError`.

```
request → filter/guard/resolve
        → PREPARED
        → protected ledger published=0 + audit outbox
        → canonical file installed and hash-verified
        → protected ledger published=1 + scoped FTS projection
        → audit outbox retried by stable event_id to effective-once receiver
        → barrier released: COMMITTED / SUPERSEDED
        → async idempotent vector derivation (may be unavailable/stale)
```

### 5.2 Read path and three-step lazy loading

`search(lease, query, {mode})` first validates the immutable scope and dispatches
exactly one ADR-0065 mode: `keyword` runs scoped FTS5/BM25; `semantic` runs
scoped sqlite-vec cosine/KNN; `hybrid` запускает независимые legs с cap 20 и
сливает их через RRF `k=60`. Поэтому semantic-only hit не обязан находиться в
keyword top-20. Результат явно несёт `requestedMode`, `effectiveMode`, `status`
и `componentRanks`. После ranking/fusion каждый hit заново материализуется через
live protected ledger и проверяется по exact scope, canonical content hash,
forget/tombstone state и установленному canonical file.
Every leg joins/validates against the same healthy protected ledger and applies
`published=1 AND invalid_at IS NULL AND fact_key NOT IN (SELECT fact_key FROM do_not_remember)` before
ranking; hybrid cannot merge an unfiltered candidate. Provider failure follows
the documented keyword degradation without widening scope. The model then
deepens only as needed: annotation (~50 tok) → overview (~500 tok) → full body
([ADR-0008](../decisions/2026-06-11-three-step-lazy-memory-loading.md)).
`load(lease, ...)` revalidates owner/scope, live ledger state, hit-bound source
hash and the same forget filter at every step, so neither a stale vector nor a
tombstoned annotation can leak.

### 5.3 Frozen snapshot read (session start)

On `session.start`, Agent Loop читает свежий Level 1 source snapshot и
замораживает его (§4). Within-session writes hit disk and the live FTS5 layer
immediately (durable now), but are **not** re-read into the frozen prefix; они
появляются через explicit `search()` и входят в prefix только новой Session
([ADR-0007](../decisions/2026-06-11-frozen-memory-snapshot.md)).

### 5.4 Fact-key extraction (equivalence class)

"Semantic-aware but deterministic" is resolved by keying on an extracted `(entity, relation, object)` equivalence class, **not** surface text ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §3, addressing Eng-2 / CSO-H4). Extraction is deterministic (normalize casing/whitespace/inflection, canonicalize entities, hash the triple to a `fact_key`). Common paraphrases ("I live in Berlin" / "my home is Berlin") collapse to the same key and are caught. Residual re-wordings the key provably cannot collapse are routed to **human review** (`REVIEW`), never committed silently — fail-safe by construction. No model call is on this path.

### 5.5 Resurrection-guard (within-session AND nightly)

For every `ADD`/`UPDATE` candidate the guard asks: would committing this re-introduce a fact whose `fact_key` is tombstoned (`invalid_at` set) or on `do_not_remember`, or covered by a human-confirmed deletion? On match it returns **BLOCK** — the candidate is surfaced (within-session: rejected to the user/agent with the forget reason; nightly: listed under "Tried to resurrect" on the morning card) and is **not** stored as a searchable fact ([ADR-0023](../decisions/2026-06-11-durable-forgetting-tombstones.md), [ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §2). The guard runs on the **write path itself**, so the day-long hole between writes and nightly is closed (Eng-8).

### 5.6 Contradiction resolution vs forget-list boundary

When two live facts share a `fact_key` but disagree, resolution applies the fixed priority **human-confirmed > recency > source-authority > confidence** at write time ([ADR-0024](../decisions/2026-06-11-memory-contradiction-resolution.md)). The loser is soft-invalidated (not erased); the winner links to it. The boundary against forgetting is precise (Eng-6):

- A **non-human-confirmed supersede** is governed by recency: a newer mention may win, and the older fact becomes a tombstone (`invalid_at` set) but is **not** added to `do_not_remember`. It can be legitimately re-asserted later by a newer log mention.
- A **human-confirmed deletion** goes on the guard-protected `do_not_remember` list with `is_human_confirmed = 1`. It is **permanent**: no recency, source-authority, confidence, or later log mention may silently resurrect it. Only a human re-adding it by hand overrides it.

Thus a non-human-confirmed soft-delete is a recency-governed supersede; only human-confirmed deletions get the guard-protected permanence. This is what prevents a newer casual log mention from silently undoing a deliberate deletion.

### 5.7 Deterministic MEMORY.md serialization

Nightly regeneration of MEMORY.md is byte-deterministic (§4): stable sort, fixed UTC formatting, `\n` endings, single trailing newline, no nondeterministic map iteration. The same inputs yield the same SHA-256 so the git diff is minimal and the file is reproducible (Eng-10).

### 5.8 Corruption detection and rebuild

Before serving reads and as part of nightly hygiene, `integrityCheck(lease)` verifies
the protected ledger and its backup chain separately from FTS/vector/cache
consistency. Disposable-index corruption fails loud (`CorruptIndexError`) and
`rebuildFromFiles(lease)` reconstructs only those indexes from canonical
markdown after reading the healthy protected ledger and reapplying its complete
forget invariant. Protected-ledger corruption fails closed with
`ForgetLedgerCorruptError`; reads and rebuild remain blocked until a verified
backup is restored or an operator recovery is completed. The ledger is never
reconstructed from live files (Eng-7, CSO-H3).

## 6. Dependencies

- **Internal:**
  - **Core / Agent Loop (#01)** — consumes `readFrozenSnapshot()` for the stable prefix; calls `search()`/`load()` during a turn. Memory emits, Core places.
  - **Nightly Consolidation (#10)** — calls `commit()` to promote approved staged ops, calls `reindex()`/`integrityCheck(lease)`/`serializeMemoryIndex()` during the night. Memory owns the guard/filter/op-model primitives the night orchestrates.
  - **Observability & Verification (#12)** — receives every `memory.*` event and the contradiction/guard audit records; provides the append-only journal that `provenance` binds to.
- **External:**
  - **SQLite with FTS5/BM25** — the in-process index and `bm25()` ranking ([ADR-0006](../decisions/2026-06-11-file-based-memory-fts5-bm25.md)).
  - **git** — the canonical markdown tree is version-controlled ([ADR-0006](../decisions/2026-06-11-file-based-memory-fts5-bm25.md)).
  - **First-class hybrid retrieval (ADR-0065)** — keyword FTS5/BM25 is always
    available; semantic uses a pinned OpenRouter embedding adapter plus local
    scoped sqlite-vec; hybrid uses cap 20 per leg/scope, RRF `k=60`, and the
    normative stable tie-break. Vectors and the full provider/model-id/model-revision/
    dimensions/normalization/chunker/content cache are derived/disposable and
    enforce the same `invalid_at` / `do_not_remember` exclusion. Query plus
    chunks are disclosed and deterministically secret-scanned. Provider failure
    degrades to keyword without broadening scope; revocation purges its derived
    data.
  - **Filesystem boundary** — the canonical memory tree is **not** mounted writable into any sandbox or MCP filesystem server (enforced at Safety #05 / MCP #07; Memory rejects any write that did not pass its choke point).

## 7. Failure & degraded modes (mandatory)

| Failure | Detection | Behavior | Recovery |
|---|---|---|---|
| **Cold start** — no index file / fresh checkout | Index file absent or empty at startup | **Fail-closed to reads** until built: `rebuildFromFiles(lease)` reconstructs FTS5 from canonical markdown, applying filter + guard; reads blocked (not "empty results") until rebuild completes | Rebuild completes; integrity check returns `ok`; reads enabled |
| **Disposable FTS/vector/cache corruption** (Eng-7) | Scoped index consistency probe fails while protected ledger verifies | **Fail-loud** `CorruptIndexError`; never serve wrong/empty results; rebuild only derived indexes while reapplying the healthy ledger | Rebuild from canonical files plus protected ledger; verify forgotten facts remain absent |
| **Protected forget-ledger corruption** | Ledger integrity/hash chain or verified backup check fails | **Fail-closed** `ForgetLedgerCorruptError`; no read, write or derived-index rebuild may proceed | Restore a verified ledger backup or complete explicit operator recovery; never infer it from live files |
| **Within-session write of a forgotten/contradicting fact** (Eng-8) | Resurrection-guard on the **write path** (not only nightly) | Live within-session check rejects the write (`BLOCK`); the fact is surfaced, never silently stored or made live-searchable | Agent/user informed with forget reason; legitimate re-learn goes to human review |
| **Paraphrase of a forgotten fact** (Eng-2, CSO-H4) | `fact_key` equivalence-class match; residual non-collapsible re-wording flagged | Matched paraphrase **BLOCK**; residual re-wording routed to **human review** (fail-safe), never silent commit | Human confirms/denies; on confirm-forget the new key is appended to `do_not_remember` |
| **Direct file/DB edit re-introducing a tombstone** (CSO-H3) | Every reindex/import/rebuild routes through the choke point; a write not via the choke point raises `BypassError` | Forget invariant re-applied on **every** reindex; canonical tree not writable by sandbox/MCP; bypass write rejected | Reindex drops the re-introduced fact; tamper surfaced on morning card |
| **`do_not_remember` tampering** (CSO-H3) | Hash-chain verification on the forget-list (`prev_hash`/`row_hash`) | **Fail-loud** `ForgetListTamperError`; refuse to serve reads that depend on the forget filter until reconciled | Restore forget-list from git/backup; re-verify chain |
| **Vector index returns a forgotten fact** (CSO-H4) | Contract test queries every derived scope for a forgotten `fact_key` | Hard failure disables semantic/hybrid for that scope | Rebuild through the choke point; keyword remains filtered/available |
| **Dependency unavailable — SQLite locked / file I/O error** | Write transaction or `search()` raises | **Fail-closed** on writes (no partial/unfiltered write); reads degrade to the frozen snapshot only (no lazy loading), never to unfiltered results | Retry with backoff; on persistent failure surface to Observability and morning card |
| **Dependency unavailable — Observability journal down** | Event emit fails | **Fail-closed**: a `commit()` that cannot write its provenance/audit record is rolled back (no untracked fact mutation) | Queue + retry; block irreversible deletes until the journal is writable |
| **Non-deterministic MEMORY.md output** (Eng-10) | Re-run over identical inputs yields a differing SHA-256 | Treated as a defect; serialization is pinned (stable sort, fixed format) | Regenerate; assert byte-equality before the nightly git commit |
| **Stale annotation hides a live document** | Body changed without annotation regen | Annotation/overview regenerated on body change; filter applied at every lazy step | Nightly re-derives metadata; query falls back to deeper step |

## 8. Security & threat model

Memory is security-relevant: it is the store the founding "deleted memory came back" bug lives in, and a target for memory-poisoning (OWASP LLM03) and tampering (STRIDE-T). The enforcing principle: forgetting and the read filter are **deterministic code**, never model judgment.

| Threat (STRIDE / OWASP-LLM) | Deterministic mitigation | Enforced by |
|---|---|---|
| **Tampering** — direct file/DB edit re-introduces a tombstoned fact (CSO-H3) | The forget filter + guard are a **property of the indexer**, re-applied on every reindex/import/rebuild; no MCP or sandbox mount has write access to the canonical memory tree; off-choke-point writes raise `BypassError` | Code ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §1, §5); Safety #05 / MCP #07 mount policy |
| **Tampering** — forget-list edited to un-forget (CSO-H3) | `do_not_remember` is **append-only and hash-chained**; chain break is fail-loud `ForgetListTamperError`; the agent edits memory only via the op-model + guard, never raw writes | Code ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §5) |
| **Memory poisoning (LLM03)** — paraphrase evades the match (Eng-2, CSO-H4) | Match on `(entity, relation, object)` **equivalence-class** key, not surface text; residual re-wordings fail **safe** to human review, never a silent commit | Code ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §3) |
| **Memory poisoning via derived index** — vector retrieval surfaces a forgotten fact (CSO-H4) | Every scope enforces the same `invalid_at` / `do_not_remember` exclusion; any violation disables semantic/hybrid for that scope | Code ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §4, ADR-0065) |
| **Repudiation / silent corruption** — a corrupt index returns wrong/empty results, silently breaking the filter (Eng-7) | Integrity check detects corruption and **fails loud**, then rebuilds from files re-applying the forget invariant; never wrong/empty | Code ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §6) |
| **Improper deletion / resurrection** — newer log mention silently undoes a deliberate deletion (Eng-6) | Human-confirmed deletions go on the guard-protected forget-list (`is_human_confirmed = 1`) and are permanent; non-confirmed supersedes are recency-governed tombstones only | Code ([ADR-0023](../decisions/2026-06-11-durable-forgetting-tombstones.md), [ADR-0024](../decisions/2026-06-11-memory-contradiction-resolution.md)) |
| **Within-session bypass** — a forgotten fact written and queried before nightly (Eng-8) | The read filter + a lightweight resurrection check run at **write time**, not only at nightly | Code ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §2) |

**Code vs model.** Enforced by code (100%): the choke point, read filter, resurrection-guard, fact-key extraction, contradiction priority, forget-list integrity, corruption fail-loud, derived-index contract. Left to the model (~70%): proposing ops, drafting annotations, deciding lazy-load depth — none of which can commit, resurrect, or bypass a forget.

### 8.1 Текущее production-состояние hybrid runtime

Базовый слой ADR-0065 реализован, но внешний semantic provider и его lifecycle
ещё не подключены к `aisy run`:

- protected scoped router использует нормативный `makeHybridRetrieval`:
  независимые keyword/semantic legs с cap 20, RRF `k=60`, bytewise tie-break и
  semantic-only hits вне keyword top-20. Global и exact active Project
  объединяются детерминированно без project-first shortcut и без cross-project
  widening;
- каждый результат содержит обязательные `requestedMode`, `effectiveMode`,
  `status` и `componentRanks`. Отсутствующий или неисправный provider даёт
  `SEMANTIC_UNAVAILABLE`, sensitive query — `SENSITIVE_INPUT_LOCAL_ONLY` без
  semantic I/O; compatibility alias `semanticDegraded` выставляется только для
  aggregate `SEMANTIC_UNAVAILABLE`;
- после RRF каждый candidate повторно проходит live ledger/forget/tombstone
  filter, exact scope/identity/path/content/provenance match и canonical-file
  verification. Ошибка целостности не маскируется keyword degradation;
- canonical `contentHash` остаётся SHA-256 exact canonical bytes и служит
  read/forget identity. Нормализованный NFKC/LF hash применяется отдельно к
  embedding-cache content; он не заменяет canonical hash в candidate или
  protected ledger;
- Node semantic store опционален. `provider=none` — настоящий keyword-only
  режим без открытия/создания sqlite-vec. Неполный или недопустимый OpenRouter
  descriptor отклоняется до создания ledger, FTS, vector или иных artifacts;
- `protected-memory-semantic-reconciler.ts` реализует положительный backfill,
  готовый для startup/post-commit composition: recovery и exact scope snapshot
  предшествуют provider I/O, unavailable/revoked выполняют zero embed,
  sensitive/stale items пропускаются, ошибки отдельных элементов редактируются
  и не останавливают остальные факты, а concurrent requests коалесцируются.
  DELETE/UPDATE WAL по-прежнему единолично владеет purge; reconciler ничего не
  удаляет и не откатывает canonical state;
- sqlite-vec `0.1.9`, OpenRouter adapter, sensitivity scanner, cache/revoke и
  scope/descriptor restart checks остаются покрыты тестами базового слоя Core.

Evidence текущего среза: полный workspace regression — 3234 теста прошли,
2 пропущены (Core 2039/1, Telegram 146/0, App 1049/1); workspace
typecheck и build — зелёные.

**Ещё не LIVE:** создание OpenRouter provider из защищённых credentials,
явный consent/disclosure, connection/revision health, подключение semantic
runtime и reconciler к startup/post-commit lifecycle в `bin/aisy.ts`. До этого
`aisy run` не отправляет memory query/chunks во внешний embedding provider и не
должен заявляться как live semantic/hybrid activation.

Будущий live path обязан пройти отдельный durable gate ADR-0088: точное
согласие связывает оператора, профиль, provider connection с его revision,
назначение `memory.semantic-embedding.v1`, полный descriptor и revision
code-owned disclosure. `off`/`none`, revoke, несовпадение binding или restart
без доказанной authority дают zero provider I/O; all-project receipt не заменяет
это согласие. Секреты для provider доступны только через границу ADR-0087.

### 8.2 Текущее production-состояние миграции legacy memory

Offline-подготовка lossless migration реализована в
`legacy-memory-migration.ts` и намеренно не содержит install/cutover API:

- source SQLite открывается read-only, проходит `PRAGMA integrity_check`, exact
  schema check и проверку полной hash-chain `do_not_remember`; неизвестная
  колонка блокирует миграцию вместо silent data loss;
- сериализованный consistent image становится byte-verified backup, а новый
  candidate — отдельным protected ledger без FTS. Все fact rows, tombstones,
  relations, `key_tokens`, authority/confidence/provenance и forget rows
  переносятся с исходными `rowid` и значениями;
- canonical `memory/facts/*.md` создаются только для live и не забытых строк.
  Tombstoned/forgotten текст остаётся историей protected ledger, получает
  `published=0` и не имеет file path/content hash, поэтому migration не
  воскрешает его в canonical/search surface;
- private staging использует каталоги `0700`, файлы `0600`, exclusive writes,
  file/directory `fsync`, atomic manifest publication и фазы
  `PREPARED → COPIED → VERIFIED`. Resume повторно сверяет source image,
  каждый artifact, ledger↔backup equivalence, canonical file bytes и forget
  chain; tamper/source change закрываются ошибкой;
- манифест обязан нести cohort-привязку к миграции реестра
  ([ADR-0070](../decisions/2026-07-29-unified-migration-cohort-binding.md)):
  `cohort.registryMigrationId` совпадает с собственным `migrationId`, а
  `cohort.sourceRegistrySha256` — с полем манифеста реестра. Оба поля читаются
  как own-свойства ровно один раз, поэтому унаследованный от загрязнённого
  прототипа `cohort` не считается привязкой, а accessor не может отдать одно
  значение проверке и другое потребителю. Путь манифеста
  выводится из когорты, поэтому readiness и doctor не выбирают его
  сканированием каталога или по `mtime`; отсутствующая когорта, чужой id,
  изменившийся source реестра и манифест вне вычисленного пути дают
  fail-closed отказ. Оба входа пути обязательны — необязательная проверка была бы
  fail-open по умолчанию. Манифест проверяется на symlink и приватный режим до
  канонизации пути, поэтому подменённая ссылка не переносит весь бандл из
  приватного staging. Bundle-верификация принимает уже доказанную когорту и
  сверяет её при повторном чтении с диска, поэтому файл, подменённый между двумя
  чтениями, не проходит как проверенный. Признак `bothMigrationsTerminal`
  сообщает только о терминальных фазах обеих миграций и сам по себе не является
  вердиктом активации: activation gate дополнительно требует rollback rehearsal и
  runtime-проверок;
- `scoped-memory.ts` уже выполняет ordinary recall как Workspace=global-only и
  Project=global+exact leased project, без обращения к другому project; ошибка
  project memory видимо деградирует только к global, а forget-ledger tamper не
  деградирует;
- protected scoped hits сохраняют `scopeId`, canonical `sourcePath` и exact
  provenance из проверенной fact row. Production lazy-context adapter требует
  все три поля и отклоняет legacy/forged hit вместо синтеза фиктивного пути.

Проверено 10 migration tests: lossless fields/relations/provenance, отсутствие
FTS в ledger, tombstone/forget non-publication, private modes, restart из
частичного `PREPARED`, tamper, stale source, damaged forget chain, unknown
schema, unsafe source mode, no-overwrite и mutated-plan path. Это ещё не live v2 memory: legacy DB
остаётся единственным authoritative store до отдельно согласованного cutover.

### 8.3 Текущее production-состояние all-project search

Explicit Workspace all-project path WP-33 реализован offline и не подключён к
модели или Telegram:

- `CrossProjectSearchReceipt` выпускается только trusted pre-router boundary
  для `source=operator, nested=false`; HMAC связывает owner, exact Workspace
  project/session/generation, нормализованный query hash, mode, archive flag и
  code-bounded `limitPerProject`;
- receipt потребляется один раз до registry fan-out. Сервис не создаёт общий
  индекс: получает owner-scoped Project records, исключает archive без явно
  связанного флага, сортирует проекты bytewise и обращается к каждому exact
  isolated index;
- каждый hit независимо проверяется на exact `project:<id>`, content hash,
  safe relative path и отсутствие duplicate chunk. Merge не сравнивает
  несопоставимые BM25/cosine scores между БД: используется deterministic
  per-project rank, затем project/path/chunk tie-break;
- `openSearchHit` не принимает свободный путь. Он потребляет отдельную
  HMAC-signed one-use `ExcerptReadCapability`, связанную с exact
  project/path/chunk/content hash и Workspace lease, после чего ещё раз
  проверяет hash и code-owned size cap возвращённого excerpt;
- Node nonce store разделяет `search`/`excerpt` namespaces, сохраняет issue и
  consume через exclusive temp, file/directory `fsync` и atomic rename.
  Consumed receipt/capability не воскресают после restart; malformed/duplicate
  durable state закрывается ошибкой.

Проверено 11 core tests и 5 Node persistence tests: normalized query, active/
archived fan-out, wrong binding/replay/expiry, Project-lease/model/nested deny,
cross-scope/traversal/duplicate hit, missing index/project cap/foreign registry,
exact excerpt/tamper и restart после issue/consume. Ordinary Workspace recall
не изменён и по-прежнему не обращается к Project indexes.

### 8.4 Текущее production-состояние protected mutation WAL

Core state machines и permission-restricted Node-композиция полного
`ADD/UPDATE/DELETE/FORGET` mutation path реализованы offline:

- `publishFact` принимает lease и explicit global/exact-project scope; другой
  Project отклоняется до storage resolution. Deterministic `prepareFact` port
  обязан вернуть `factKey = SHA-256(keyTokens)` и проверенные bi-temporal/
  relation metadata — raw model metadata не становится ledger row;
- operation id связывает owner/profile/session/scope/fact/content/provenance,
  а WAL хранит strict exact-schema snapshot `published=false` и проходит
  `PREPARED → DB_PENDING → FILE_INSTALLED → PUBLISHED → AUDITED`;
- `DB_PENDING` атомарно требует pending ledger row и audit outbox;
  `FILE_INSTALLED` проверяет code-owned canonical path/content hash;
  `PUBLISHED` требует idempotent ledger + physically separate keyword
  projection; `AUDITED` доставляет outbox с устойчивым idempotency key и только
  затем удаляет WAL. Транспорт audit допускает повторную попытку после crash между внешним
  эффектом и локальной отметкой; стабильный `event_id` делает приёмник
  идемпотентным и обеспечивает effective-once результат;
- весь цикл выполняется под обязательным injected scope-exclusive barrier, а
  `assertScopeRecovered` блокирует reader до исчезновения всех WAL scope.
  Recovery проверяет owner/scope, сортирует durable WAL и идемпотентно
  завершает каждый effect;
- 19 core tests покрывают happy path, 11 crash points, premature-visibility
  gate, restart/recovery, completed retry, global routing, foreign project,
  collision, file tamper, malformed WAL и invalid deterministic metadata.
- `protected-memory-sqlite-store.ts` хранит canonical ledger/WAL/outbox и FTS5
  в физически разных SQLite-файлах `0600`, закрепляет оба файла за exact
  owner/profile/scope и проверяет exact schema, WAL/outbox hashes и полный
  `do_not_remember` chain до любого чтения или изменения. Защищённый
  `forget_count + forget_head_hash` anchor обнаруживает в том числе удаление
  хвоста цепочки, которое одна цепочка без anchor доказать не может;
- `protected-memory-file-store.ts` создаёт только code-owned
  `memory/facts/<sha256(factId)>.md`, использует private staging, exclusive
  create, `fsync`, hard-link publication без overwrite, `O_NOFOLLOW`, mode/hash/
  size/inode/link-count verification и restart-recovery на границе link/unlink;
- `protected-memory-scope-barrier.ts` использует отдельную SQLite
  `BEGIN IMMEDIATE` transaction как межпроцессный advisory barrier. Конкурент
  получает `SCOPE_BUSY`, а смерть процесса снимает OS lock и откатывает owner
  row без небезопасного time-based stale takeover;
- 19 дополнительных Node tests проходят реальные DB/file restart boundaries:
  12 fault points, включая partial staging link, cross-process contention +
  `SIGKILL` recovery, physical
  ledger/FTS isolation, permissions, symlink/collision/tamper, audit corruption,
  owner rebinding/unbound-candidate deny без создания FTS side effect, forget
  guard и tail-truncation detection.
- `DELETE/FORGET` использует отдельный WAL
  `PREPARED → TOMBSTONED → KEYWORD_PURGED → DERIVED_PURGED → FILE_REMOVED → AUDITED`.
  Tombstone, deletion-outbox и human-confirmed append-only forget-row создаются
  в одной ledger transaction; FTS, vector/cache и canonical live file
  удаляются и повторно проверяются перед audit. Уже существующий non-human
  tombstone можно повысить до permanent forget: исходный `invalid_at` остаётся
  историческим временем удаления, а audit `ts` фиксирует последующее
  человеческое подтверждение;
- `UPDATE` использует WAL
  `PREPARED → DB_PENDING → FILE_INSTALLED → LEDGER_SWAPPED → KEYWORD_SWAPPED → DERIVED_PURGED → OLD_FILE_REMOVED → AUDITED`.
  Новая версия до swap имеет `published=false`; ledger атомарно переводит старую
  версию в tombstone и новую в live. Затем физически отдельный FTS переключается
  old→new, старые vector/cache и canonical file удаляются, а
  `memory.superseded` outbox доставляется с тем же idempotency key;
- reopen проверяет recovery-shape всех трёх WAL и запрещает completed outbox с
  `delivered=0`, если соответствующий WAL уже исчез. Completed retry повторно
  сверяет ledger/FTS, canonical files, derived purge и audit, поэтому
  воскрешённый файл или vector не принимается как успешный результат;
- 9 core deletion tests и 4 Node deletion tests покрывают 13 логических и 9
  реальных durable-effect crash boundaries, permanent forget, повышение
  tombstone→forget, foreign scope, recovery gate и outbox corruption. 2 strict
  update-schema tests и 4 Node update tests покрывают 14 реальных durable
  boundaries, completed retry/resurrection, foreign scope, recovery gate и
  orphan outbox fail-closed.
- `protected-memory-recovery-gate.ts` одной атомарной проверкой под exact
  межпроцессным scope-lock охватывает publication/deletion/update WAL и итоговый
  `integrityCheck`. Один незавершённый family направляется своему recoverer;
  несколько одновременных family считаются невозможным состоянием и блокируются
  как `RECOVERY_CONFLICT`. 4 tests покрывают все family, final integrity и
  foreign scope.
- `protected-scoped-memory.ts` является lease-bound адаптером публичного
  `ScopedMemoryRouter`: Workspace обращается только к global runtime, Project —
  к global и ровно своему `project:<id>`. Перед каждым read/write выполняется
  recovery gate, а каждый read-hit повторно связывается с published ledger row
  и hash/size канонического файла. Отсутствующий Project runtime и повреждение
  производного keyword index дают наблюдаемую деградацию только к global;
  scope/file mismatch, любой recovery error и все ошибки protected ledger
  проходят fail-closed без деградации. Human-confirmed delete/forget выполняется
  только после отдельного code-owned authorization callback; перед карточкой
  router загружает точную цель из protected ledger и повторно проверяет её
  `operationId`, `factKey`, canonical `sourcePath`, `contentHash`, owner/scope и
  фактическое состояние файла. Свободного boolean на этой границе недостаточно;
- `protected-memory-permanence-authority.ts` реализует ADR-0029: создаёт только
  Tier-3 карточку с обязательным step-up и domain-separated SHA-256 по exact
  lease/scope/fact/operation/key/path/content/reason. Подтверждение принимается
  только как свежий code-minted `ApprovalProof` Gateway с совпадающими
  `actionId`/`actionHash`/`cardId`; generic adapter без proof fail closed.
  После подтверждения authority подписывает HMAC-receipt, атомарно выпускает и
  гасит его в долговечном одноразовом журнале, а разрешение возвращает только
  после audit `memory.permanence.authorized`, связывающего tap с точным фактом;
- `memory-permanence-nonce-store.ts` хранит consumed tombstone до TTL, поэтому
  crash/restart не оживляет receipt. Файл и каталог имеют права `0600/0700`;
  symlink, hardlink, публичные права, повреждённая/лишняя schema, duplicate id,
  неверный MAC, stale receipt и ошибка durable publication отклоняются;
- `makeNodeProtectedMemoryPreviewRouter` собирает этот адаптер из реальных
  global/exact-project Node runtimes только в `preview`. При `off` возвращается
  `null`; legacy/live router не изменяется. 16 core tests проверяют routing,
  canonical-file validation, controlled degradation, recovery/ledger fail-closed,
  ADD/UPDATE/DELETE/NOOP, exact-target authorization, tombstone/file checks,
  idempotent absent forget и authorization deny. Ещё 8 core tests проверяют
  authority, 7 app tests — durable one-use store, 2 app tests — Node authority
  composition, а отдельный Gateway→authority→SQLite/file→restart E2E доказывает
  permanent forget без повторного recall. App integration
  выполняет настоящий global+project ADD→FTS search через раздельные ledger,
  файлы и scope barriers. Отдельный app integration создаёт Project через
  durable registry/provisioner, пишет project-факт через `remember`, после
  полного restart восстанавливает exact project/session/generation и факт,
  переключается во второй Project по one-use receipt и доказывает взаимную
  отрицательную выдачу двух project-фактов, затем в Workspace не видит ни один
  из них при сохранении отдельной global memory.

- `deriveDeterministicMemoryFactKey` теперь является одним code-owned
  Unicode/legacy normalizer для legacy и protected memory. Protected runtime
  всегда сам вычисляет `factKey/keyTokens`; optional metadata-preparer не может
  их подменить. Без него `validAt` берётся из code-owned clock, а trust metadata
  получает консервативные значения.
- Protected SQLite store предоставляет только verdict
  `PASS/FORGOTTEN/REVIEW` по bounded candidate keys: перед ответом он проверяет
  hash-chain и отсутствие незавершённых mutation WAL, но не раскрывает наружу
  строки `do_not_remember`, причины, токены или пути.
- Offline nightly forget adapter под exact Project maintenance lease проверяет
  обе области — global и ровно `project:<id>` — под существующими scope
  barriers. Exact key удаляется как forgotten, остаточное пересечение токенов
  консервативно удаляется как review. В telemetry уходят только счётчики;
  stale lease, recovery/tamper, неизвестный structured activity payload и
  отсутствие любого runtime дают один стабильный code-only отказ.

Это ещё не live memory commit: mutation contract и preview adapter собраны, но
не подключены к model-facing tools или `aisy run`. Hash-pinned approval/step-up
callback и его restart-E2E готовы; ещё нужны approved binding/install
миграционного candidate, полный live-compatible E2E и rollback rehearsal. Legacy
`Memory.commit()` не перенаправлен; activation и необратимый cutover требуют
отдельного явного согласования оператора.

## 9. Acceptance criteria (mandatory)

1. **AC-03-1** — Calling `commit({op:'ADD'})` for a brand-new fact inserts exactly one row with `invalid_at IS NULL` and a populated `fact_key`, and `search()` for it returns that row (happy path, write→read).
2. **AC-03-2** — After `forget(factId, reason, humanConfirmed=true)`, `search()` over any query matching that fact returns **zero** rows for it; the FTS5 query plan includes `WHERE invalid_at IS NULL AND fact_key NOT IN (SELECT fact_key FROM do_not_remember)` (read filter; ADR-0030 §1).
3. **AC-03-3** — `load(lease, hitId, 'annotation')` for a forgotten fact returns nothing; the filter is asserted to apply at the annotation step, not only at `full` (lazy-load filter; ADR-0008).
4. **AC-03-4** — Source snapshot содержит все 11 global DNA files в точном
   ADR-0063 порядке. Agent Loop читает его ровно один раз на Session: два turn
   одной Session сохраняют byte-identical prefix после DNA/DB changes, новая
   Session видит новые bytes, а restart старой Session восстанавливает её
   persisted prefix/hash (ADR-0007/0063).
5. **AC-03-5** — A within-session `commit({op:'ADD'})` whose `fact_key` matches a `do_not_remember` entry returns `status:'BLOCKED'`, inserts **no** live-searchable row, and a follow-up `search()` returns zero hits for it — proving the guard runs at write time, not only nightly (Eng-8; ADR-0030 §2).
6. **AC-03-6** — Forgetting "I live in Berlin", then committing the paraphrase "my home is Berlin", yields `status:'BLOCKED'` (same `fact_key`); a residual re-wording the key cannot collapse yields `status:'ROUTED_TO_REVIEW'` and is **not** stored as live — never a silent commit (Eng-2, CSO-H4; ADR-0030 §3).
7. **AC-03-7** — A non-human-confirmed supersede sets `invalid_at` on the loser but adds **no** `do_not_remember` row, and a later newer mention can re-assert it; a **human-confirmed** deletion adds a `do_not_remember` row with `is_human_confirmed=1` and a subsequent newer log mention via `commit()` returns `BLOCKED` (recency vs forget-list boundary; Eng-6; ADR-0024/0023).
8. **AC-03-8** — Writing a tombstoned `fact_key` directly into a markdown file and then calling `reindex()` results in that fact being **absent** from `search()` (the forget invariant re-applies on the reindex path); a write attempted off the choke point raises `BypassError` (CSO-H3; ADR-0030 §1).
9. **AC-03-9** — Any attempt to mount the canonical memory tree writable into a sandbox/MCP context is rejected, and a fact-mutating write that did not pass `commit()` raises `BypassError`; test asserts no write-capable mount of the memory tree exists (CSO-H3; ADR-0030 §5).
10. **AC-03-10** — Tampering with a `do_not_remember` row (altering `reason`/`fact_key`) breaks the hash chain; the next `integrityCheck(lease)` returns `ok:false` and `forget()`/read paths raise `ForgetListTamperError` rather than serving an unfiltered read (CSO-H3; ADR-0030 §5).
11. **AC-03-11** — Corrupting only a disposable FTS/vector/cache database causes
    scoped reads to raise `CorruptIndexError`; `rebuildFromFiles(lease)`
    reconstructs it from canonical files plus the verified protected ledger and
    a previously forgotten fact remains absent. Corrupting the protected ledger
    instead raises `ForgetLedgerCorruptError` and blocks reads and rebuild until
    verified backup restore; no test may recreate the ledger from live files
    (Eng-7; ADR-0030 §6).
12. **AC-03-12** — Running `serializeMemoryIndex()` twice over identical inputs produces byte-identical `content` and the same SHA-256; reordering input fact insertion order does not change the output (deterministic MEMORY.md; Eng-10).
13. **AC-03-13** — A derived index (FTS5 and each scoped vector index) is queried for a forgotten `fact_key` and returns **zero** hits; the contract test fails the build if any derived index returns a forgotten fact, and a non-conforming plugin is disabled (CSO-H4; ADR-0030 §4, ADR-0006).
14. **AC-03-14** — On cold start with no index, reads are blocked (not "empty") until `rebuildFromFiles(lease)` completes and `integrityCheck(lease)` returns `ok`; the rebuilt index reflects all current tombstones and forget-list entries (cold start; §7).
15. **AC-03-15** — When the Observability journal is unavailable, a `commit()` that cannot write its provenance/audit record returns without mutating the fact table (fail-closed); no untracked fact mutation is observable afterward (dependency-unavailable; §7).
16. **AC-03-16** — When SQLite is locked / file I/O fails mid-write, no partial or unfiltered row is committed and `search()` degrades to the frozen snapshot only, never to unfiltered results (dependency-unavailable; §7).
17. **AC-03-17** — Keyword, semantic and hybrid modes return the same scoped identities/provenance and required
    `scopeId`/`sourcePath`/`chunkId`; fixed inputs use cap 20 per leg/scope, RRF `k=60`
    and the normative tie-break to produce byte-stable ordering. A failed/
    missing embedding provider visibly degrades hybrid to keyword while
    semantic reports unavailable.
18. **AC-03-18** — Unchanged document/query content produces zero new embedding
    calls through the full provider/model-id/model-revision/dimensions/normalization/
    chunker/content cache key; changing any keyed field rebuilds only the
    affected scope. The disclosure covers query plus chunks; deterministic
    secret fixtures never leave the host; revocation blocks calls and purges
    provider-scoped cache/index rows.
19. **AC-03-19** — Every ordinary API rejects a missing, stale, wrong-owner or
    wrong-scope `TurnContextLease`. Cross-project search additionally rejects
    a Project lease and missing/replayed/stale/wrong-query, wrong-mode or wrong-archive operator receipt;
    opening a hit accepts only its exact one-use path/chunk/content capability.
20. **AC-03-20** — Legacy migration preparation copies every fact and
    `do_not_remember` column losslessly into a physically separate protected
    ledger candidate, publishes canonical files only for live/non-forgotten
    rows, contains no FTS table, survives restart from `PREPARED`, and fails
    closed on source drift, schema drift, chain break, artifact/file tamper or
    caller-mutated paths или небезопасные права source/artifacts. Preparation
    can stop only at `VERIFIED`; no test or
    public API activates the candidate.
21. **AC-03-21** — Preview scoped router читает Workspace как global-only, а
    Project как global+exact-project; каждый hit проходит recovery и
    canonical-file hash/size verification. Отказ только производного Project
    keyword index явно деградирует к global; scope/file mismatch, recovery
    conflict/required/integrity failure и protected-ledger corruption никогда
    не деградируют. Human-confirmed delete/forget не вызывает mutation service
    без успешного code-owned authorization callback. В режиме `off` router не
    создаётся, а live legacy binding остаётся неизменным.
22. **AC-03-22** — Permanent forget до показа карточки связывается с точными
    `operationId`, `factKey`, `sourcePath` и `contentHash` проверенного ledger/file
    target. Gateway принимает только exact nonce/hash и обязательный step-up,
    выдаёт свежий code-owned proof; authority атомарно гасит HMAC-receipt в
    private durable store и пишет audit tap→fact. Replay, restart, stale/future
    proof, generic confirmation без proof, target/file tamper, неправильный
    owner/scope и audit failure fail closed без вызова mutation service.
23. **AC-03-23** — Nightly ingestion использует тот же deterministic fact-key
    normalizer и проверяет каждый text record одновременно против
    integrity-protected global и exact-Project forget-list. Exact match и
    residual overlap отсутствуют в результате; другой Project не читается.
    Store возвращает только verdict, restart воспроизводит тот же результат,
    а stale lease, pending WAL, damaged chain или неподдерживаемая structured
    schema блокируют весь Project snapshot с code-only telemetry.
24. **AC-03-24** — Только `ACTIVE` authority ADR-0088 с точным actor, profile,
    provider connection revision, purpose, descriptor и disclosure revision
    разрешает вызов semantic provider; `CONSENTED` и все остальные состояния
    дают zero provider I/O, а keyword fallback остаётся явным.
25. **AC-03-25** — `off`/`none`, revoke и restart сохраняют fail-closed
    поведение: новые и уже начатые embedding calls не публикуют cache/index
    rows, а purge охватывает global и все принадлежащие профилю Project scopes.
26. **AC-03-26** — Изменение provider connection, descriptor, disclosure или
    data scope требует нового consent; all-project receipt и сохранённая
    конфигурация не могут заменить semantic-egress authority.
27. **AC-03-27** — Создание и подтверждение semantic-egress карточки используют
    единый durable transition: `AWAITING_CONSENT` + nonce +
    `disclosure_issued`, а затем consumed nonce + `CONSENTED` +
    `consent_granted` появляются атомарно. Crash на каждой границе не создаёт
    consent без audit и не допускает replay; outbox после restart доставляется
    повторно с тем же `eventId`.
28. **AC-03-28** — Startup recovery инвалидирует все незавершённые карточки
    прошлого boot и их nonce, увеличивает revision/generation, переводит старые
    `ACTIVE`/`DEGRADED` в `SUSPENDED` и возвращает каждый `REVOKING` для
    обязательного purge. Старый Telegram tap и use proof после restart дают
    zero provider I/O независимо от успеха очистки UI.
29. **AC-03-29** — Use-start одной транзакцией проверяет exact `ACTIVE`
    authority/revision/generation/binding, гасит one-use nonce и создаёт
    `request_started`; общий durable transition не может обойти эту проверку.
    Revoke под тем же per-slot барьером фиксирует `REVOKING`, закрывает новые
    use, abort'ит активные lease и ждёт их фактический settlement до purge.
    Публикация до границы revoke затем удаляется purge, а публикация после неё
    не вызывает callback и не создаёт derived state. `DEGRADED`, `SUSPENDED`,
    `BLOCKED` и повторная boot recovery используют тот же publish-fence; ошибка
    записи revoke intent немедленно закрывает локальный gate и abort'ит lease.
30. **AC-03-30** — Recovery worker сохраняет insertion order и head-of-line:
    sink получает только exact redacted event, а durable `ackOutboxHead`
    вызывается только после `accepted` или `duplicate-exact`. Crash/timeout/
    stop до вызова ack оставляет ту же голову для restart redelivery;
    idempotent sink применяет один логический эффект. `not-head`, unknown ack,
    malformed event, private-anchor mismatch или ошибка sink останавливают pass
    без пропуска и без доставки следующего события. Code-owned timeout
    ограничивает delivery/read/ack, но их поздний результат не может продолжить
    pass. После неоднозначного `ACK_TIMEOUT` новый pass перечитывает durable
    голову: она могла измениться, если поздний ack успел зафиксироваться.
31. **AC-03-31** — Remembered second-person fact хранится и извлекается
    byte-identical под exact owner/profile/scope, prompt projection всегда
    code-owned `operator-memory` без языковой классификации, а другой
    owner/profile/Project не получает этот fact. Никакое model-authored subject
    metadata не участвует в owner routing.

## 10. Open questions

- **Equivalence-class precision tuning.** The `(entity, relation, object)` extractor's recall/precision threshold (how aggressively to collapse vs route to review) is deferred to v0.2 hardening; v0.1 ships the conservative key plus human-review fail-safe ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) "Consequences for v0.1").
- **Embedding model calibration.** Provider model, dimensions, chunk size and
  per-scope top-k are versioned configuration and require multilingual recall,
  cost and latency evals before release; mechanism and fallback are fixed by
  ADR-0065.

## 11. References

- ADRs:
  - [ADR-0006 — File-based memory with SQLite FTS5/BM25](../decisions/2026-06-11-file-based-memory-fts5-bm25.md)
  - [ADR-0007 — Frozen memory snapshot per session](../decisions/2026-06-11-frozen-memory-snapshot.md)
  - [ADR-0008 — Three-step lazy memory loading](../decisions/2026-06-11-three-step-lazy-memory-loading.md)
  - [ADR-0023 — Durable forgetting: tombstones + forget-list + bi-temporal](../decisions/2026-06-11-durable-forgetting-tombstones.md)
  - [ADR-0024 — Memory contradiction resolution policy](../decisions/2026-06-11-memory-contradiction-resolution.md)
  - [ADR-0030 — Forgetting invariant holds on every index and write path](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md)
  - [ADR-0065 — Hybrid vector and keyword retrieval](../decisions/2026-07-26-hybrid-vector-keyword-retrieval.md)
  - [ADR-0087 — Непрозрачный broker секретов и credential-injecting proxy](../decisions/2026-07-29-opaque-secret-broker-backend-proxy.md)
  - [ADR-0088 — Долговечное согласие на semantic egress памяти](../decisions/2026-07-29-durable-semantic-egress-consent.md)
  - Supporting: [ADR-0014 (narrow-waist tool set)](../decisions/2026-06-11-narrow-waist-tool-set.md), [ADR-0019 (stable-prefix KV-cache)](../decisions/2026-06-11-stable-prefix-kv-cache.md), [ADR-0029 (human-confirmation provenance binding)](../decisions/2026-06-11-human-confirmation-provenance-binding.md)
- Concept docs:
  - [`docs/concepts/memory-system.md`](../concepts/memory-system.md)
  - [`docs/concepts/nightly-consolidation.md`](../concepts/nightly-consolidation.md)
