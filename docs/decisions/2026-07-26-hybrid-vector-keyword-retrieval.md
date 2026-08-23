# ADR-0065: Hybrid Vector and Keyword Retrieval

**Status:** Accepted
**Date:** 2026-07-26
**Tags:** memory, retrieval, embeddings

## Context

The reference assistant exposes three knowledge-search modes: keyword,
semantic and hybrid.
Embeddings are requested through OpenRouter, vectors remain in a local database,
unchanged documents are cached, and the system falls back to text search when no
embedding connection is available.

Aisy currently ships FTS5/BM25. ADR-0031 proposed a later flag-gated local
English-focused model, which does not match the approved
connection and multilingual product flow. The operator has explicitly required
vector search in Aisy.

## Decision

Ship hybrid retrieval as a first-class capability with three explicit modes:

- `keyword`: FTS5/BM25, local, deterministic and always available;
- `semantic`: cosine/KNN ranking over local sqlite-vec indexes using a pinned
  embedding model through an `EmbeddingProvider`;
- `hybrid`: retrieve at most 20 candidates per leg and scope, then merge with
  Reciprocal Rank Fusion using `k=60`. Ties sort by fused score descending,
  best component rank ascending, then required bytewise `scopeId` (`global`, `project:<projectId>`, or `monitoring:<monitorId>`), `sourcePath`, and
  `chunkId` ascending. This is the default when embeddings are healthy.

The first external adapter is OpenRouter, connected through the same
Telegram-first secrets/settings flow as other APIs. Both query text and selected
chunks leave the server only after the operator connects the provider and
accepts that explicit disclosure. A deterministic pre-embedding scanner checks
path policy, credential formats and high-entropy tokens: matching chunks are
skipped and audited; matching queries stay local, semantic reports
`SENSITIVE_INPUT_LOCAL_ONLY`, and hybrid uses keyword only. Disconnect/revoke
blocks calls immediately, purges provider-scoped query cache, and deletes its
document cache/vector rows before re-enable. Without a healthy key, semantic
mode reports `SEMANTIC_UNAVAILABLE` and keyword/hybrid requests deterministically
degrade to keyword with visible status. A future local multilingual adapter may
implement the same interface.

Canonical files remain authoritative. Vectors and embedding cache are local,
derived and disposable. Deterministic chunks carry content hash, scope,
project id, source path, provenance, provider, model id/revision, dimensions,
normalization version and chunker version. The document/query cache key is
`SHA-256(provider || model-id || model-revision || dimensions || normalization-version ||
chunker-version || normalized-content-hash)`; unchanged chunks or repeated
queries cause no API request. Changing any keyed field invalidates only the
affected derived scope.

Global Workspace, every Project and monitoring storage have separate indexes.
Automatic recall opens only global plus the active Project; monitoring remains
behind its dedicated tool. From Workspace, explicit read-only
`search_all_projects` requires a one-use authenticated-operator receipt bound
to owner, Workspace session, generation, query hash, mode and archive flag.
It fans out bounded top-k queries to each active Project index and
deterministically merges labelled results. Every hit returns a short-lived
one-use read capability bound to its exact project/path/chunk/content hash; no
arbitrary-path open is accepted. Model, prompt-injected, nested, missing,
replayed, wrong-query and stale requests fail closed. No shared cross-project
index is created, archived projects are excluded by default, and modifying a
hit requires switching to its owning Project.

Every vector write/rebuild/search applies the same live/tombstone/
`do_not_remember` filters as FTS. Semantic similarity may flag a possible
duplicate for review but cannot autonomously override forgetting or authorize a
memory mutation.

## Consequences

- **Positive:** Aisy recalls paraphrases and concepts while preserving fast,
  free exact search and the agreed degraded behaviour.
- **Positive:** local scoped indexes, deterministic RRF and content-addressed
  cache make retrieval inspectable and avoid repeated embedding cost.
- **Positive:** provider abstraction fits API onboarding and can later support a
  local multilingual model.
- **Neutral:** semantic quality/cost depends on the configured embedding model;
  model/version becomes persisted index metadata.
- **Negative:** query text and selected memory/knowledge chunks are sent to the
  embedding provider; the UI must disclose both, deterministic secret scanning
  may conservatively skip content, and disconnect/revoke purges provider-scoped
  derived data.
- **Negative:** sqlite-vec is a pinned native dependency requiring build,
  migration and integrity coverage.

## Alternatives considered

**Keep vector search optional and hidden behind a flag.** Rejected because the
operator requires it as a product capability and the reference assistant
exposes it directly.

**Use the ADR-0031 English-only local potion model as the sole adapter.**
Rejected for this release because it diverges from the requested OpenRouter
connection flow and multilingual Russian/English use. It remains a possible
future provider behind the interface.

**External vector database.** Rejected because per-scope local SQLite is simpler,
auditable and sufficient at current scale.

**Semantic-only retrieval.** Rejected because provider outages and exact
identifiers require the always-available BM25 leg.

## References

- [ADR-0031 — superseded optional plugin](./2026-06-11-semantic-vector-plugin.md)
- [ADR-0006 — file-based memory and FTS5](./2026-06-11-file-based-memory-fts5-bm25.md)
- [ADR-0030 — forgetting invariant](./2026-06-11-forgetting-invariant-all-index-paths.md)
- [ADR-0063 — layered Workspace/Project memory](./2026-07-26-layered-workspace-project-memory.md)
- Private reference material on agent tools, the memory system and monitoring
