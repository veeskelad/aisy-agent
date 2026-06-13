# Component 03: Memory — Specification

**Status:** Draft
**Component:** 03 / 12
**Related ADRs:** ADR-0006, ADR-0007, ADR-0008, ADR-0023, ADR-0024, ADR-0030
**Depends on:** Core / Agent Loop (#01), Nightly Consolidation (#10), Observability & Verification (#12)

> Memory is the durable, human-readable, git-versioned substrate the harness reads from and writes to so the agent persists across sessions even though the stateless model does not — and the deterministic layer that makes "forget this" actually stick on every path.

## 1. Purpose

The language model is a stateless probabilistic CPU: it forgets everything the moment a request returns. Memory is the part of the OS that survives the CPU. It owns four file levels (markdown in git), a per-session frozen snapshot, three-step lazy retrieval over an SQLite FTS5/BM25 index, and the durable-forgetting machinery (bi-temporal facts, a forget-list, a resurrection-guard, contradiction resolution).

Aisy's memory follows a three-layer structure:

- **Raw/Immutable Input Layer** — daily logs (`logs/YYYY-MM-DD.md`) and archive; the generator's read-only input during nightly consolidation. Files rotate and are archived but are never modified after writing.
- **Wiki/Synthesized Layer** — `working/*.md` and `MEMORY.md`; progressively synthesized knowledge updated by nightly consolidation. This is the primary read surface for the agent.
- **Schema/Config Layer** — `AGENTS.md` and `constitution.md`; normative framing and identity constraints, updated only by humans.

The split between deterministic code and the model is sharp here:

- **Deterministic code (100%):** the indexer choke point, the read/ingestion filter `WHERE invalid_at IS NULL AND id NOT IN do_not_remember`, the resurrection-guard, contradiction resolution, the frozen-snapshot read, fact-key extraction, corruption detection/rebuild, and deterministic MEMORY.md serialization. Forgetting is code, never a prompt instruction at ~70% adherence (NIST: at least one deterministic enforcement layer not judged by an LLM).
- **The model (~70%):** decides *whether to deepen* a lazy-load (annotation → overview → full), proposes ADD/UPDATE/DELETE/NOOP operations during nightly consolidation, and drafts annotations/overviews. It never decides to actually delete, resurrect, or commit a fact.

## 2. Responsibilities

What this component **owns**:

- The four storage levels: `constitution.md` / `SOUL.md` / `USER.md` / `MEMORY.md` (Level 1, always-loaded prefix), `daily/YYYY-MM-DD.md` (Level 2), `working/*.md` (Level 3), `archive/*.md` (Level 4). The markdown files are canonical ([ADR-0006](../decisions/2026-06-11-file-based-memory-fts5-bm25.md)).
- The **single indexer choke point** every write, reindex, and import passes through ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md)).
- The SQLite FTS5/BM25 index and its bi-temporal schema (`valid_at`, `invalid_at`, `is_human_confirmed`, fact-key), and the `do_not_remember` forget-list table.
- The read/ingestion filter, the resurrection-guard, fact-key (equivalence-class) extraction, and contradiction resolution as **deterministic** code.
- The frozen per-session snapshot read of Level 1 ([ADR-0007](../decisions/2026-06-11-frozen-memory-snapshot.md)).
- Three-step lazy loading (annotation → overview → full) over ranked candidates ([ADR-0008](../decisions/2026-06-11-three-step-lazy-memory-loading.md)).
- Index integrity check and rebuild-from-files on corruption.
- The forget-invariant contract that **every derived index** (FTS5 today, the optional vector plugin tomorrow) must enforce.

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

type MemoryOp =
  | { op: 'ADD'; text: string }
  | { op: 'UPDATE'; targetId: string; text: string }
  | { op: 'DELETE'; targetId: string; humanConfirmed: boolean; reason: string }
  | { op: 'NOOP'; targetId: string }

type GuardVerdict =
  | { decision: 'PASS' }
  | { decision: 'BLOCK'; matched: 'tombstone' | 'forget_list' | 'human_confirmed_delete'; factId: string }
  | { decision: 'REVIEW'; reason: 'residual_paraphrase' } // fail-safe, never a silent commit

export interface Memory {
  // READ PATH — every result is filtered: invalid_at IS NULL AND id NOT IN do_not_remember
  search(query: string, opts?: { limit?: number }): Promise<RankedHit[]>      // FTS5/BM25 ~20ms
  load(hitId: string, step: 'annotation' | 'overview' | 'full'): Promise<string>

  // SESSION SNAPSHOT — read once at session start, frozen for the session
  readFrozenSnapshot(): Promise<{ bytes: Buffer; sha256: string }>

  // WRITE PATH — the SINGLE choke point. Within-session and nightly both call this.
  // Applies read filter + resurrection-guard + contradiction resolution, then reindexes.
  // Returns BLOCK/REVIEW without storing a searchable fact on guard hit.
  commit(op: MemoryOp, ctx: { withinSession: boolean }): Promise<CommitResult>

  // FORGET-LIST — append-only, integrity-protected. No raw-write path exists.
  forget(factId: string, reason: string, humanConfirmed: boolean): Promise<void>

  // DERIVED-INDEX CONTRACT — any reindex/import/rebuild routes here, never around it.
  reindex(scope: 'all' | { ids: string[] }): Promise<void>
  rebuildFromFiles(): Promise<void> // used on corruption; re-applies the full forget invariant

  // DETERMINISM — byte-stable regeneration of the MEMORY.md index file
  serializeMemoryIndex(): Promise<{ content: string; sha256: string }>

  // INTEGRITY — PRAGMA integrity_check + FTS5 consistency
  integrityCheck(): Promise<{ ok: boolean; detail?: string }>
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

**Fact row (FTS5 + bi-temporal columns).** The unit of forgetting and contradiction resolution.

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

**Frozen snapshot.** The concatenation of Level 1 files, read once at session start, with a `sha256`. It is the cacheable prefix; it **must be byte-identical** for the whole session so the KV-cache breakpoint holds ([ADR-0007](../decisions/2026-06-11-frozen-memory-snapshot.md), [ADR-0019](../decisions/2026-06-11-stable-prefix-kv-cache.md)). Within-session writes never mutate it.

**MEMORY.md index file.** A compact (≤200-line) table of contents regenerated nightly. Its serialization **must be byte-deterministic**: facts sorted by a stable key (e.g. `(fact_key, valid_at, id)`), fixed timestamp format (UTC, second precision), `\n` line endings, no trailing whitespace, a single trailing newline. Two runs over identical inputs produce an identical SHA-256 (§5.7).

**Annotation / overview metadata.** Each indexed `working/`/`archive/` document carries a ~50-token annotation and ~500-token overview, regenerated whenever the body changes; both inherit the `invalid_at` / forget filter so a tombstoned doc never surfaces even as an annotation ([ADR-0008](../decisions/2026-06-11-three-step-lazy-memory-loading.md)).

## 5. Behavior & control flow

### 5.1 The indexer choke point (one path for every write)

Every path that adds or re-derives a searchable fact — within-session write, nightly promotion, rebuild-from-files, MCP/import — passes through the **same** `commit()` indexer ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §1). The indexer applies the read filter, runs the resurrection-guard, resolves contradictions, then reindexes FTS5 in the same transaction. No method writes a searchable fact while bypassing it; a write arriving by any other route raises `BypassError`.

```
write request (within-session | nightly | import | rebuild)
        │
        ▼
   [ INDEXER CHOKE POINT — deterministic ]
        │  1. apply read filter (invalid_at IS NULL AND id NOT IN do_not_remember)
        │  2. resurrection-guard on fact_key  ─── BLOCK ──▶ surface, do not store
        │                                      ─── REVIEW ─▶ human queue (fail-safe)
        │  3. contradiction resolution (priority order)
        │  4. write row + reindex FTS5 (one transaction)
        ▼
   COMMITTED / SUPERSEDED  +  journal event
```

### 5.2 Read path and three-step lazy loading

`search()` ranks candidates by FTS5/BM25 (~20ms, zero LLM calls) **with the filter applied in the SQL itself**, so a soft-deleted or forgotten fact is never a candidate. The model then deepens only as needed: annotation (~50 tok) → overview (~500 tok) → full body, stopping when the step in hand suffices ([ADR-0008](../decisions/2026-06-11-three-step-lazy-memory-loading.md)). The filter applies at **every** step, including the annotation, so a tombstoned fact cannot leak even as 50 tokens.

### 5.3 Frozen snapshot read (session start)

On `session.start`, Memory reads Level 1 once and freezes it (§4). Within-session writes hit disk and the live FTS5 layer immediately (durable now), but are **not** re-read into the frozen prefix; they surface this session only via explicit `search()`, and enter the prefix next session ([ADR-0007](../decisions/2026-06-11-frozen-memory-snapshot.md)).

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

Before serving reads and as part of nightly hygiene, `integrityCheck()` runs `PRAGMA integrity_check` plus an FTS5 consistency probe. On detected corruption the indexer **fails loud** (`CorruptIndexError`) — it never returns wrong or empty results that would silently break the forget filter — and `rebuildFromFiles()` reconstructs the index from the canonical markdown, **re-applying the full forget invariant** (filter + guard) during rebuild so no forgotten fact re-enters via the rebuild path (Eng-7, CSO-H3).

## 6. Dependencies

- **Internal:**
  - **Core / Agent Loop (#01)** — consumes `readFrozenSnapshot()` for the stable prefix; calls `search()`/`load()` during a turn. Memory emits, Core places.
  - **Nightly Consolidation (#10)** — calls `commit()` to promote approved staged ops, calls `reindex()`/`integrityCheck()`/`serializeMemoryIndex()` during the night. Memory owns the guard/filter/op-model primitives the night orchestrates.
  - **Observability & Verification (#12)** — receives every `memory.*` event and the contradiction/guard audit records; provides the append-only journal that `provenance` binds to.
- **External:**
  - **SQLite with FTS5/BM25** — the in-process index and `bm25()` ranking ([ADR-0006](../decisions/2026-06-11-file-based-memory-fts5-bm25.md)).
  - **git** — the canonical markdown tree is version-controlled ([ADR-0006](../decisions/2026-06-11-file-based-memory-fts5-bm25.md)).
  - **Optional vector plugin** — flag-gated, derived, disposable; **must** enforce the same `invalid_at` / `do_not_remember` exclusion as a contract ([ADR-0006](../decisions/2026-06-11-file-based-memory-fts5-bm25.md), [ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §4). Never the core store.

    **Optional semantic plugin (v0.3, flag-gated):** When `AISY_SEMANTIC_PLUGIN=1`, query retrieval adds a second leg: the query is encoded via potion-base-8M (~0.1 ms, static embeddings), sqlite-vec performs KNN search (~0.7 ms at 10k entries), and the two ranked lists are merged via RRF (~0.5 ms). Total round-trip: ~2–8 ms vs <1–5 ms without the plugin. Files remain canonical; the vector index is a derived, disposable artifact rebuilt from files. Earmarked for v0.3.
  - **Filesystem boundary** — the canonical memory tree is **not** mounted writable into any sandbox or MCP filesystem server (enforced at Safety #05 / MCP #07; Memory rejects any write that did not pass its choke point).

## 7. Failure & degraded modes (mandatory)

| Failure | Detection | Behavior | Recovery |
|---|---|---|---|
| **Cold start** — no index file / fresh checkout | Index file absent or empty at startup | **Fail-closed to reads** until built: `rebuildFromFiles()` reconstructs FTS5 from canonical markdown, applying filter + guard; reads blocked (not "empty results") until rebuild completes | Rebuild completes; integrity check returns `ok`; reads enabled |
| **SQLite/FTS5 index corruption** (Eng-7) | `integrityCheck()` (`PRAGMA integrity_check` + FTS5 probe) fails | **Fail-loud** `CorruptIndexError`; never serve wrong/empty results; auto-`rebuildFromFiles()` re-applying the forget invariant | Rebuild from canonical files; verify forgotten facts still absent post-rebuild |
| **Within-session write of a forgotten/contradicting fact** (Eng-8) | Resurrection-guard on the **write path** (not only nightly) | Live within-session check rejects the write (`BLOCK`); the fact is surfaced, never silently stored or made live-searchable | Agent/user informed with forget reason; legitimate re-learn goes to human review |
| **Paraphrase of a forgotten fact** (Eng-2, CSO-H4) | `fact_key` equivalence-class match; residual non-collapsible re-wording flagged | Matched paraphrase **BLOCK**; residual re-wording routed to **human review** (fail-safe), never silent commit | Human confirms/denies; on confirm-forget the new key is appended to `do_not_remember` |
| **Direct file/DB edit re-introducing a tombstone** (CSO-H3) | Every reindex/import/rebuild routes through the choke point; a write not via the choke point raises `BypassError` | Forget invariant re-applied on **every** reindex; canonical tree not writable by sandbox/MCP; bypass write rejected | Reindex drops the re-introduced fact; tamper surfaced on morning card |
| **`do_not_remember` tampering** (CSO-H3) | Hash-chain verification on the forget-list (`prev_hash`/`row_hash`) | **Fail-loud** `ForgetListTamperError`; refuse to serve reads that depend on the forget filter until reconciled | Restore forget-list from git/backup; re-verify chain |
| **Vector plugin returns a forgotten fact** (CSO-H4) | Contract test: derived index queried for a forgotten `fact_key` | Derived index **must** apply the same exclusion; any hit is a hard failure that disables the plugin | Plugin rebuilt from files with the filter; disabled until the contract test passes |
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
| **Memory poisoning via derived index** — vector plugin surfaces a forgotten fact (CSO-H4) | Every derived index enforces the same `invalid_at` / `do_not_remember` exclusion as a contract; a test asserts no derived index can return a forgotten fact, else the index is disabled | Code ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §4, [ADR-0006](../decisions/2026-06-11-file-based-memory-fts5-bm25.md)) |
| **Repudiation / silent corruption** — a corrupt index returns wrong/empty results, silently breaking the filter (Eng-7) | Integrity check detects corruption and **fails loud**, then rebuilds from files re-applying the forget invariant; never wrong/empty | Code ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §6) |
| **Improper deletion / resurrection** — newer log mention silently undoes a deliberate deletion (Eng-6) | Human-confirmed deletions go on the guard-protected forget-list (`is_human_confirmed = 1`) and are permanent; non-confirmed supersedes are recency-governed tombstones only | Code ([ADR-0023](../decisions/2026-06-11-durable-forgetting-tombstones.md), [ADR-0024](../decisions/2026-06-11-memory-contradiction-resolution.md)) |
| **Within-session bypass** — a forgotten fact written and queried before nightly (Eng-8) | The read filter + a lightweight resurrection check run at **write time**, not only at nightly | Code ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §2) |

**Code vs model.** Enforced by code (100%): the choke point, read filter, resurrection-guard, fact-key extraction, contradiction priority, forget-list integrity, corruption fail-loud, derived-index contract. Left to the model (~70%): proposing ops, drafting annotations, deciding lazy-load depth — none of which can commit, resurrect, or bypass a forget.

## 9. Acceptance criteria (mandatory)

1. **AC-03-1** — Calling `commit({op:'ADD'})` for a brand-new fact inserts exactly one row with `invalid_at IS NULL` and a populated `fact_key`, and `search()` for it returns that row (happy path, write→read).
2. **AC-03-2** — After `forget(factId, reason, humanConfirmed=true)`, `search()` over any query matching that fact returns **zero** rows for it; the FTS5 query plan includes `WHERE invalid_at IS NULL AND id NOT IN (SELECT … FROM do_not_remember)` (read filter; ADR-0030 §1).
3. **AC-03-3** — `load(hitId, 'annotation')` for a forgotten fact returns nothing; the filter is asserted to apply at the annotation step, not only at `full` (lazy-load filter; ADR-0008).
4. **AC-03-4** — Two `readFrozenSnapshot()` calls within one session return byte-identical buffers with the same SHA-256, even after a within-session `commit()` ran between them (frozen snapshot; ADR-0007).
5. **AC-03-5** — A within-session `commit({op:'ADD'})` whose `fact_key` matches a `do_not_remember` entry returns `status:'BLOCKED'`, inserts **no** live-searchable row, and a follow-up `search()` returns zero hits for it — proving the guard runs at write time, not only nightly (Eng-8; ADR-0030 §2).
6. **AC-03-6** — Forgetting "I live in Berlin", then committing the paraphrase "my home is Berlin", yields `status:'BLOCKED'` (same `fact_key`); a residual re-wording the key cannot collapse yields `status:'ROUTED_TO_REVIEW'` and is **not** stored as live — never a silent commit (Eng-2, CSO-H4; ADR-0030 §3).
7. **AC-03-7** — A non-human-confirmed supersede sets `invalid_at` on the loser but adds **no** `do_not_remember` row, and a later newer mention can re-assert it; a **human-confirmed** deletion adds a `do_not_remember` row with `is_human_confirmed=1` and a subsequent newer log mention via `commit()` returns `BLOCKED` (recency vs forget-list boundary; Eng-6; ADR-0024/0023).
8. **AC-03-8** — Writing a tombstoned `fact_key` directly into a markdown file and then calling `reindex()` results in that fact being **absent** from `search()` (the forget invariant re-applies on the reindex path); a write attempted off the choke point raises `BypassError` (CSO-H3; ADR-0030 §1).
9. **AC-03-9** — Any attempt to mount the canonical memory tree writable into a sandbox/MCP context is rejected, and a fact-mutating write that did not pass `commit()` raises `BypassError`; test asserts no write-capable mount of the memory tree exists (CSO-H3; ADR-0030 §5).
10. **AC-03-10** — Tampering with a `do_not_remember` row (altering `reason`/`fact_key`) breaks the hash chain; the next `integrityCheck()` returns `ok:false` and `forget()`/read paths raise `ForgetListTamperError` rather than serving an unfiltered read (CSO-H3; ADR-0030 §5).
11. **AC-03-11** — Corrupting the SQLite/FTS5 index file causes `integrityCheck()` to return `ok:false` and reads to raise `CorruptIndexError` (never wrong/empty); `rebuildFromFiles()` reconstructs the index and a previously forgotten fact remains absent from `search()` after rebuild (Eng-7; ADR-0030 §6).
12. **AC-03-12** — Running `serializeMemoryIndex()` twice over identical inputs produces byte-identical `content` and the same SHA-256; reordering input fact insertion order does not change the output (deterministic MEMORY.md; Eng-10).
13. **AC-03-13** — A derived index (FTS5 and the vector-plugin stub) is queried for a forgotten `fact_key` and returns **zero** hits; the contract test fails the build if any derived index returns a forgotten fact, and a non-conforming plugin is disabled (CSO-H4; ADR-0030 §4, ADR-0006).
14. **AC-03-14** — On cold start with no index, reads are blocked (not "empty") until `rebuildFromFiles()` completes and `integrityCheck()` returns `ok`; the rebuilt index reflects all current tombstones and forget-list entries (cold start; §7).
15. **AC-03-15** — When the Observability journal is unavailable, a `commit()` that cannot write its provenance/audit record returns without mutating the fact table (fail-closed); no untracked fact mutation is observable afterward (dependency-unavailable; §7).
16. **AC-03-16** — When SQLite is locked / file I/O fails mid-write, no partial or unfiltered row is committed and `search()` degrades to the frozen snapshot only, never to unfiltered results (dependency-unavailable; §7).

## 10. Open questions

- **Equivalence-class precision tuning.** The `(entity, relation, object)` extractor's recall/precision threshold (how aggressively to collapse vs route to review) is deferred to v0.2 hardening; v0.1 ships the conservative key plus human-review fail-safe ([ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) "Consequences for v0.1").
- **Vector plugin contract test surface.** The full bi-temporal machinery and the vector-index contract harden in v0.2; v0.1 ships the FTS5 forget invariant and a stub contract test ([ADR-0006](../decisions/2026-06-11-file-based-memory-fts5-bm25.md), [ADR-0030](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md) §4).
- **Provenance binding to confirmation.** Exactly who may confirm a delete and how that binds to provenance is owned by [ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md); the interface here assumes `humanConfirmed` is validated upstream.

## 11. References

- ADRs:
  - [ADR-0006 — File-based memory with SQLite FTS5/BM25](../decisions/2026-06-11-file-based-memory-fts5-bm25.md)
  - [ADR-0007 — Frozen memory snapshot per session](../decisions/2026-06-11-frozen-memory-snapshot.md)
  - [ADR-0008 — Three-step lazy memory loading](../decisions/2026-06-11-three-step-lazy-memory-loading.md)
  - [ADR-0023 — Durable forgetting: tombstones + forget-list + bi-temporal](../decisions/2026-06-11-durable-forgetting-tombstones.md)
  - [ADR-0024 — Memory contradiction resolution policy](../decisions/2026-06-11-memory-contradiction-resolution.md)
  - [ADR-0030 — Forgetting invariant holds on every index and write path](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md)
  - Supporting: [ADR-0014 (narrow-waist tool set)](../decisions/2026-06-11-narrow-waist-tool-set.md), [ADR-0019 (stable-prefix KV-cache)](../decisions/2026-06-11-stable-prefix-kv-cache.md), [ADR-0029 (human-confirmation provenance binding)](../decisions/2026-06-11-human-confirmation-provenance-binding.md)
- Concept docs:
  - [`docs/concepts/memory-system.md`](../concepts/memory-system.md)
  - [`docs/concepts/nightly-consolidation.md`](../concepts/nightly-consolidation.md)
