# ADR-0003: Monorepo (pnpm) with TS Core + Python Sidecars

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** packaging

## Context
Aisy is a public, open-source harness ("OS") around an LLM ("CPU"): durable file-based
memory, deterministic safety hooks, skills, MCP, provider routing, and a nightly
self-improvement loop. The core is TypeScript; Python is needed only for sidecars
(Whisper voice transcription, an optional safety/scoring classifier). As a framework
meant for others to adopt, the project ships SDKs in both ecosystems (TS and Python),
and those SDKs evolve on a different cadence than the runtime core.

Constraints:
- The core and the SDKs have different audiences and release rhythms; bundling them
  forces a shared version and couples a public API contract to internal churn.
- The two languages must coexist without one becoming a second-class citizen, and a
  change spanning core + SDK + sidecar should be reviewable as one atomic commit.
- Safety hooks and the deterministic-OS boundary live in core-ts; sidecars are
  process-isolated (consistent with the Docker sandbox model used elsewhere).

## Decision
Use a single repository with pnpm workspaces and four packages with clear boundaries:
`packages/core-ts` (TS harness core), `packages/sidecars-py` (Whisper + optional
safety classifier), `packages/sdk-ts`, and `packages/sdk-py`. Each SDK is versioned
and published independently of the core.

## Consequences
- **Positive:** Independently versioned SDKs (sdk-ts, sdk-py) with stable public
  contracts decoupled from core churn; one repo means atomic cross-package changes
  and one source of truth for issues, CI, and docs.
- **Positive:** Clean language boundary — TS owns the deterministic core and hooks,
  Python is confined to process-isolated sidecars, matching the sandbox model.
- **Neutral:** Contributors must run a pnpm-based workflow even for Python-only
  changes; the Python package is managed alongside but built with its own toolchain.
- **Negative:** pnpm workspaces plus a task runner (e.g. turbo) and cross-package
  wiring add CI complexity — caching, build ordering, and release orchestration across
  two language toolchains in one pipeline.

## Alternatives considered
**Single package (everything in one publishable unit).** Rejected: it entangles the
public SDK surface with the core runtime, forcing a single version number and making
it impossible to version and ship the TS and Python SDKs independently. A breaking
change in core would bump the SDK even when its API is unchanged, eroding adopter
trust and slowing releases.

**Polyrepo (one repo per package).** Rejected: a change touching core + SDK + sidecar
would span multiple PRs across repos, losing atomicity and complicating CI, shared
tooling, and contributor onboarding for a project this early.

## References
- [ADR-0004](./2026-06-11-typescript-for-core.md) — TypeScript language choice rationale
- pnpm workspaces: https://pnpm.io/workspaces
- Turborepo: https://turbo.build/repo
