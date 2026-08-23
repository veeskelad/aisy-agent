# ADR-0014: Narrow-Waist Tool Set (<20)

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** architecture

## Context
The base tools exposed to the model are part of the always-loaded prompt prefix: every tool
definition costs tokens, sits inside the KV-cached stable prefix, and — more importantly —
competes for the model's attention at selection time. Aisy's CPU/OS thesis treats the model as
a stateless probabilistic CPU with ~70% instruction adherence; tool *selection* is exactly the
kind of probabilistic decision that degrades as the option space grows.

Empirically, past roughly 20 active tools the model's tool-selection quality falls off: it picks
the wrong tool, invents arguments, or oscillates between near-duplicate tools (the same class of
failure the Loop Guardian guards against). This mirrors the "narrow waist" principle from network
architecture — a small, stable, universal interface in the middle, with variation pushed to the
edges.

Aisy already has two edge-extension mechanisms designed for exactly this growth: skills
(see ./2026-06-11-skill-format-staged-creation.md) and MCP servers
(see ./2026-06-11-mcp-allowlist-pinning-hashing.md). Skills load their body only on trigger
(menu-in-prompt, body-on-demand); MCP tools are namespaced, allowlisted, and version-pinned.
Neither bloats the base tool set or the cached prefix.

Constraints:
- Tool definitions live in the byte-identical stable prefix that enables ~90% KV-cache savings;
  churn there invalidates the cache.
- At least one deterministic enforcement layer (HARD_DENY hooks) wraps `bash`, regardless of how
  many capabilities exist above it.

## Decision
Keep the set of base tools small and stable — under ~20 — and grow capability through skills and
MCP, never by adding new base tools.

The base set is the "narrow waist": run `bash` (in the Docker sandbox: network none, read-only,
cap_drop ALL, one-shot), read files, write/edit files, fetch the web via the egress proxy, and
call MCP. Anything domain-specific — a new integration, a new workflow, a new format — arrives as
a skill (a SKILL.md the model reads on trigger) or an MCP server (allowlisted, hash-pinned), not
as a new entry in the base tool list.

## Consequences
- **Positive:** Stable, byte-identical tool definitions preserve the KV-cache prefix; selection
  quality stays high because the model chooses among <20 universal tools; new capability ships
  without touching core or re-pinning the prefix; the deterministic `bash` hook layer covers a
  small, well-understood surface.
- **Neutral:** Capability is real but indirect — power lives in skills/MCP behind the waist, so
  "what can Aisy do?" is answered by the skill menu and MCP allowlist, not the tool list.
- **Negative:** A genuinely new *primitive* (one no skill or MCP can express) requires a
  deliberate ADR to widen the waist; contributors must resist the reflex to add a bespoke tool
  for every task and instead author a skill.

## Alternatives considered
**Large built-in tool catalog (dozens of first-class tools).** Rejected: selection quality
degrades past ~20 tools (the model mis-routes and oscillates between near-duplicates), every tool
permanently enlarges the cached prefix, and each one becomes a maintenance and security surface
that must be versioned and hook-guarded forever. The narrow waist gets the same capability through
skills/MCP without paying these costs.

## References
- ./2026-06-11-skill-format-staged-creation.md (ADR-0015 — skills as the primary growth path)
- ./2026-06-11-mcp-allowlist-pinning-hashing.md (ADR-0013 — MCP as the external-tool path)
