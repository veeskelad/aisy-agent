# ADR-0032: Code Search — semble as Optional stdio MCP Sidecar

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** search, mcp, performance

## Context

The agent's baseline code-search capability is ripgrep + Read. On exact-match
and regex queries, ripgrep is fast and deterministic. On concept-level queries
("where is retry logic implemented?", "what handles rate limiting?"), ripgrep
fails: Recall@500tokens = 0.001. This forces the agent to either read enormous
amounts of code (~45k tokens/query on average) or miss the relevant file
entirely. For a personal coding assistant working on its own codebase,
concept-level recall matters.

The question is: what code-search tool, if any, should be added as an opt-in
layer on top of the ripgrep baseline?

Constraints:

- CPU-only VPS, 2–8 GB RAM
- TS core with Python sidecars already allowed (ADR-0003)
- Non-load-bearing: if absent, agent must fall back to ripgrep+Read transparently
- Security model: MCP allowlist, version pinning, descriptor hashing (ADR-0013)
- Apache-2.0 compatible license
- Deterministic in the retrieval path (no LLM in the search step)

## Decision

Adopt **semble** (MinishLab, MIT) as an optional, allowlisted stdio MCP
sidecar for semantic code search. It is non-load-bearing: if the semble process
is absent or fails, the agent falls back to ripgrep+Read transparently.

The TS core spawns semble as a Python subprocess using stdio MCP transport —
the same pattern as all other MCP sidecars (ADR-0003). Python + uv is already
present in `packages/sidecars-py`. No new infrastructure required.

semble uses potion-code-16M (Model2Vec static embeddings, 256-dim, ~30 MB),
BM25, and tree-sitter for structural parsing. Both the BM25 and embedding legs
are fully deterministic: no LLM, no stochastic sampling. The same query on the
same index always returns the same ranked list.

Key numbers:

| Dimension | ripgrep+Read (baseline) | semble |
|-----------|------------------------|--------|
| Index time | 0 (no index) | 263 ms median |
| Query latency p50 | 1–5 ms | 1.5 ms CPU |
| Cold-start per session | 0 | ~100–300 ms |
| Model disk | 0 | ~30 MB |
| Runtime RAM | 0 | < 200 MB |
| NDCG@10 (semantic queries) | ~0.30 | 0.854 |
| Recall@500 tokens | 0.001 | 0.685 |
| Tokens per query (avg) | 45,692 | 566 (−98.8%) |
| License | MIT | MIT |
| Deterministic | yes | yes (static embeddings, no LLM) |

The 98.8% token reduction directly addresses Aisy's token-efficiency constraint.
The recall gap (0.685 vs 0.001 at the 500-token budget) means concept-level
retrieval goes from effectively broken to working.

**Security model** follows ADR-0013 exactly:

- Pin the exact PyPI version in `uv.lock`; verify the SHA-256 of the wheel
  before install.
- At registration, compute SHA-256 of each MCP tool descriptor (name +
  description + inputSchema); store as the pinned hash in the allowlist config.
- If a semble version upgrade changes any tool descriptor, the hash check fails,
  the server is disabled automatically, and a diff card is emitted for human
  review. No new security infrastructure required.

Note: semble does not help with the resurrection-guard/contradiction-matcher
paraphrase problem ("dislikes cilantro" vs "hates coriander") — that is a
natural-language memory problem, not a code-search problem. See ADR-0031 for
the memory semantic layer.

## Consequences

- **Positive:** Concept-level code recall rises from ~0 to 0.685 at a 500-token
  budget. Token cost per code-search operation drops 98.8% (566 vs 45,692
  tokens/query). Fits within VPS constraints (<200 MB RAM at runtime, ~30 MB
  model disk). Deterministic retrieval path; security model maps directly to the
  existing ADR-0013 pattern. Non-load-bearing: zero impact on agent reliability
  if absent.
- **Neutral:** A new session incurs a ~100–300 ms Python process cold-start.
  This is the known, documented latency floor for this sidecar; it is acceptable
  for a non-load-bearing tool.
- **Negative:** semble's benchmark labels were validated using Claude Sonnet 4.6
  as LLM-as-judge — treat the 0.854 NDCG as directionally correct but
  acknowledge it has not been verified against a human-labeled gold set. The
  BM25+vector index size for very large repos (>500k LOC) is not published;
  measure empirically on the target VPS before committing. semble is a
  relatively new PyPI package; pin to exact version and re-audit on every
  upgrade.

## Alternatives considered

**ripgrep+Read only (status quo).** NDCG ~0.30 on semantic queries,
Recall@500 = 0.001. Adequate for exact-match; inadequate for concept-level
retrieval. Kept as the mandatory fallback layer; not sufficient on its own.

**codebase-memory-mcp (C binary, tree-sitter knowledge graph).** Zero semantic
recall; pure structural queries. License unconfirmed from research. Worth
reconsidering as a complement for symbol/architecture queries once license is
verified — not a replacement for semble.

**CodeRankEmbed Hybrid (137M transformer).** 57 s index time, ~550 MB RAM,
16 ms query — eliminated by VPS resource constraints. semble achieves 99% of
its quality at 1/20th the cost.

**ctags / LSP-based.** ctags is GPL-2.0, which creates distribution risk
against the project's Apache-2.0 license (ADR-0002). Zero semantic recall.
Safe only as an optional external subprocess the user installs separately, never
as an Aisy dependency. Not suitable for this role.

## References

- [ADR-0003](./2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md) — TS Core + Python Sidecars
- [ADR-0013](./2026-06-11-mcp-allowlist-pinning-hashing.md) — MCP Allowlist + Version Pinning + Descriptor Hashing
- [ADR-0014](./2026-06-11-narrow-waist-tool-set.md) — Narrow-Waist Tool Set (<20)
- [ADR-0031](./2026-06-11-semantic-vector-plugin.md) — Optional Semantic Vector Plugin (memory layer)
- semble — https://github.com/MinishLab/semble
- Model2Vec / potion-code-16M — https://github.com/MinishLab/model2vec
