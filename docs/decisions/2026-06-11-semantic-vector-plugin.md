# ADR-0031: Optional Semantic Vector Plugin (potion-base-8M + sqlite-vec + RRF)

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** memory, retrieval, search

## Context

ADR-0006 ships FTS5/BM25 as the sole retrieval mechanism (sub-1ms, zero RAM overhead,
deterministic, already deployed). It explicitly earmarks an optional, flag-gated vector
plugin for a later milestone when semantic/paraphrase recall needs to improve — for
example, to reduce resurrection-guard false negatives on paraphrases like "dislikes
cilantro" vs "hates coriander". This ADR makes the concrete technology choice for that
plugin.

Constraints on any plugin candidate:

- CPU-only VPS, 2–8 GB RAM
- No embedding services (no external API calls)
- Apache-2.0 compatible license
- Deterministic in the retrieval ranking path (same query + same corpus = same result)
- Files remain canonical; vector index is a derived, disposable artifact
- Must not displace FTS5/BM25 as the hot-path baseline

## Decision

Adopt **potion-base-8M** (model2vec, MinishLab) as the embedding model, **sqlite-vec**
as the vector storage/search extension, and **Reciprocal Rank Fusion (RRF)** to merge
results with the existing FTS5/BM25 index.

The plugin is flag-gated (`AISY_SEMANTIC_PLUGIN=1`) and loaded lazily on first query.
It is earmarked for v0.3; nothing in v0.1/v0.2 ships with this dependency.

Key numbers:

| Dimension | Value |
|-----------|-------|
| potion-base-8M model disk | ~8–10 MB |
| potion-base-8M model RAM | ~25–40 MB |
| Encode latency | 0.04–0.10 ms/sentence (~25k sentences/sec on CPU) |
| Model cold-start | ~50–200 ms once per process |
| sqlite-vec (10k entries, 384-dim) RAM | ~9 MB |
| sqlite-vec (10k entries, 384-dim) disk | ~15 MB |
| sqlite-vec query at 10k entries | ~0.7 ms (brute-force, perfect recall) |
| RRF merge overhead | ~0.5 ms |
| Total round-trip with plugin | ~2–8 ms (vs <1–5 ms without) |
| Total new RAM overhead on 2 GB VPS | ~35–55 MB |
| Total new disk overhead | ~25 MB |
| NDCG@10 improvement over BM25 alone | +5–8 pp |
| License (model2vec) | MIT |
| License (sqlite-vec) | Apache-2.0 / MIT (dual) |

**Resurrection-guard integration:** cosine similarity ≥ 0.82 from potion-base-8M raises
a "possible duplicate" flag for human review — it is a flagging mechanism, not an
autonomous gate. The 0.82 threshold is a starting point; it is domain-dependent and must
be calibrated against real Aisy memory logs before production use. potion-base-8M STS
score (~73) means ~7–10% more subtle-paraphrase misses than bge-small-en-v1.5 (STS ~81),
but bge-small was eliminated by 5× RAM overhead (~200 MB) and 100× slower encode
(10–15 ms/sentence).

**Invariants:**

- Files remain canonical; the vector index is a derived, disposable artifact that can
  always be rebuilt from the markdown files.
- The model version is stored alongside vectors in the sqlite-vec table; any version bump
  invalidates and rebuilds the index.
- Every write and reindex through the vector layer still passes through the indexer choke
  point (ADR-0030), so the forgetting invariant (`do_not_remember` denylist,
  `invalid_at` filter) holds.

## Consequences

- **Positive:** Adds paraphrase recall ("cilantro"/"coriander" class of misses) at
  ~35–55 MB RAM and 1–3 ms latency overhead — fits a 2 GB VPS comfortably. No server
  process, no external API, fully deterministic in the ranking path. Lazy-loaded and
  flag-gated: zero overhead in v0.1/v0.2 installations without the flag.
- **Neutral:** The vector index is a rebuild artifact, not a source of truth. sqlite-vec
  is pinned in `pyproject.toml` and wrapped behind a thin abstraction layer to isolate
  API churn. The model version is persisted in the index table; a version bump triggers
  a full reindex.
- **Negative:** sqlite-vec is pre-v1.0 and the author warns of breaking API changes —
  mitigated by version pinning and a migration test on every bump. At ~250k entries,
  brute-force sqlite-vec hits latency limits (~680 ms for 1M × 384-dim float32); an ANN
  migration path must be planned before that scale (sqlite-vec is adding ANN support;
  vectorlite is an alternative). The 0.82 cosine threshold is domain-fuzzy; calibration
  against actual Aisy memory logs is required before enabling the resurrection-guard
  signal in production. potion-base-8M is English-focused; significant non-English memory
  content requires the multilingual variant (potion-multilingual-128M, ~128 MB).

## Alternatives considered

**bge-small-en-v1.5 (ONNX, STS 81.59).** Better semantic accuracy than potion-base-8M
(STS 81 vs 73), but eliminated by ~200 MB RAM footprint, 10–15 ms/sentence encode, and
~2 s cold-start — 5× the RAM overhead is not justified for a flag-for-human-review
signal on a 2 GB VPS.

**Full transformer models (MiniLM, CodeRankEmbed).** 550 MB+ RAM, GPU preferred,
encode latency 15–50 ms/sentence — incompatible with the 2–8 GB CPU-only VPS constraint.

**External vector databases (LanceDB, Chroma, Qdrant, Weaviate).** All require a server
process and a network dependency, and several carry licenses that complicate Apache-2.0
distribution. Violates the "no extra running service" constraint established in ADR-0006.

## References

- Related: [ADR-0006 file-based memory + FTS5/BM25](./2026-06-11-file-based-memory-fts5-bm25.md)
- Related: [ADR-0023 durable forgetting](./2026-06-11-durable-forgetting-tombstones.md)
- Related: [ADR-0030 forgetting invariant all index paths](./2026-06-11-forgetting-invariant-all-index-paths.md)
- model2vec / potion-base-8M: https://github.com/MinishLab/model2vec
- sqlite-vec: https://github.com/asg017/sqlite-vec
- Reciprocal Rank Fusion: Cormack, Clarke & Buettcher (2009)

<!--
Quick rules:
- Filename: YYYY-MM-DD-kebab-slug.md
- Keep the "ADR-NNNN" logical id in the title and in docs/decisions/INDEX.md.
- Status transitions: never silently delete. Mark Deprecated/Superseded and
  link the replacement.
- Keep it under ~150 lines. ADR is a decision record, not a design doc.
- Update docs/decisions/INDEX.md when you add or change an ADR.
-->
