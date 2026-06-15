# Roadmap

This is the public roadmap for **Aisy** — an open-source harness (the "OS")
around an LLM (the "CPU"). The document covers the next 6–12 months. Dates are
directional, not contractual; scope and ordering may shift as we learn.

For the rationale behind individual decisions, see the Architecture Decision
Records under [`docs/decisions/`](docs/decisions/). Each milestone below links
the ADRs that govern it.

## Guiding principles

These constraints shape every milestone and will not be traded away for speed:

- **The 70-vs-100 split.** The model handles reversible and creative work; code
  handles everything irreversible or critical (delete, deploy, money, budgets,
  fallback). An LLM follows instructions roughly 70% of the time; a code hook
  enforces them 100% of the time. We treat that gap as a category difference,
  not a quality one.
- **Deterministic enforcement is non-negotiable.** At least one safety layer is
  always code that is never judged by an LLM.
- **Files first.** Memory is markdown in git plus an SQLite FTS5 index, not a
  vector database. Vectors are an optional, flag-gated plugin (see *Deferred*).
- **Human-in-the-loop for self-improvement.** Anything the agent writes about
  itself — skills, learned lessons, memory edits flagged as deletions — lands in
  staging and waits for human approval. Nothing the agent authors reaches prod
  unattended.

## Status legend

| Mark | Meaning |
|------|---------|
| ✅ | Shipped |
| 🚧 | In progress |
| ⏳ | Planned |
| 🧊 | Explicitly deferred (see *Deferred* section) |

## Build progress (snapshot 2026-06-15)

Spec-driven design is **complete**: 15 component specs + 40 ADRs. Implementation
(`@aisy/core`, TypeScript, test-first) status:

- ✅ **All 15 components implemented** — 01–13 engine + 14 triggers + 15 context-engine. **496 tests green, `tsc` clean, 0 unhandled errors.**
- ✅ **Phase-5 adversarial pre-merge review** — 32 confirmed defects (that green tests missed) found and fixed, each with a regression test (`docs/reviews/2026-06-13-phase5-review.md`).
- ✅ **First-class sub-agent delegation (ADR-0039)** — goal-DAG scheduler, AgentCard capability authority, scope composition + pairwise disjointness, hash-chained per-delegation shards with compact observations, checkpoint/resume + cascade-skip (AC-11-16..20). Adversarially reviewed.
- ✅ **Eval & red-team harness (ADR-0037)** — `pass^k` scoring + golden-trajectory replay/diff (`src/eval/`).
- ✅ **Medium/low review triage** — 16 of the 59 lower findings resolved (15 fixed TDD + 1 by design); the remaining 43 are bucketed with rationale in the review doc.
- ✅ **Operational shell (partial)** — `aisy` CLI router (tested), Dockerfile + Compose + install script (ADR-0035), operator guides (`docs/guides/`).
- 🚧 **Remaining for a runnable v0.1** — wire the `aisy` bin to real node adapters (fs/prereq/provider-ping/Telegram/SQLite/Docker probes).

---

## v0.1 — "Full day-one" (target: Q3 2026) 🚧

The first release ships the **full architecture**, not a toy subset. The thesis
is that the harness only makes sense as a whole: memory without safety is
dangerous, safety without routing is brittle, routing without a loop is just a
chat box. So v0.1 stands the entire skeleton up end to end, then later versions
harden it.

**Scope:**

- **Core agent loop.** Three nested loops (step → loop → meta-loop) with
  file-based inter-step state (`STATE`/`TODO`/`NOTES`/`LESSONS`/`DECISIONS`/
  `INBOX.md`) and a `STOP` signal file.
  → [`docs/decisions/2026-06-11-own-agent-loop.md`](docs/decisions/2026-06-11-own-agent-loop.md)
- **File-based memory + FTS5.** Four levels (always-loaded stable prefix;
  daily logs; on-demand working set; archive). BM25 ranking over SQLite FTS5,
  ~20 ms lookups, no LLM calls in the retrieval path. Three-step lazy loading
  (annotation → overview → full doc).
  → [`docs/decisions/2026-06-11-file-based-memory-fts5-bm25.md`](docs/decisions/2026-06-11-file-based-memory-fts5-bm25.md)
- **Minimum durable forgetting.** Ships *with* consolidation so v0.1 does not
  reintroduce the "asked to delete, it came back" bug: a `do_not_remember`
  forget-list, a single indexer choke point that every write and reindex passes
  through, and the read/ingestion filter
  `WHERE invalid_at IS NULL AND id NOT IN do_not_remember`. The full bi-temporal
  machinery and resurrection-guard harden in v0.2.
  → [`docs/decisions/2026-06-11-forgetting-invariant-all-index-paths.md`](docs/decisions/2026-06-11-forgetting-invariant-all-index-paths.md)
- **Plan Mode.** Risk/complexity-triggered (or user-requested) planning phase: a
  verified TODO whose steps close only on a real trace, not the model's
  self-report, plus a mandatory clarification gate on ambiguity. Compensates for
  weaker/cheaper providers from day one.
  → [`docs/decisions/2026-06-11-plan-mode-clarification-verified-todo.md`](docs/decisions/2026-06-11-plan-mode-clarification-verified-todo.md)
- **Deterministic safety hooks.** `HARD_DENY` regex layer (blocks
  `terraform destroy`, `rm -rf`, `DROP`/`TRUNCATE`, `DELETE` without `WHERE`,
  git force-push, money operations, reads of secret files). Lethal-trifecta
  mitigations: break at least one of {private data, untrusted input, outbound
  channel} per sensitive flow. No skip-permissions on irreversible operations.
  → [`docs/decisions/2026-06-11-deterministic-tool-hooks.md`](docs/decisions/2026-06-11-deterministic-tool-hooks.md)
- **Untrusted-input containment.** All external text (tool output, fetched pages,
  MCP responses, voice transcripts, forwarded content) is quarantined by default
  and provenance-tagged; the classifier may only escalate, never downgrade to
  trusted. While any untrusted span is in context, code disables outbound and
  Tier-2/3 tools (capability narrowing), deterministically breaking the trifecta's
  outbound leg.
  → [`docs/decisions/2026-06-11-capability-narrowing-untrusted-context.md`](docs/decisions/2026-06-11-capability-narrowing-untrusted-context.md),
  [`docs/decisions/2026-06-11-default-quarantine-external-input.md`](docs/decisions/2026-06-11-default-quarantine-external-input.md)
- **Approval integrity.** Trust/permanence flags (`is_human_confirmed`) are set
  only by a deterministic approval handler bound to a real human tap on a
  hash-pinned artifact; never by model-authored content. Approval cards carry a
  single-use nonce, and irreversible/permanence approvals require a second factor.
  → [`docs/decisions/2026-06-11-human-confirmation-provenance-binding.md`](docs/decisions/2026-06-11-human-confirmation-provenance-binding.md)
- **Sandbox.** Docker, `network: none`, read-only filesystem, `cap_drop: ALL`,
  `no-new-privileges`, one-shot containers.
  → [`docs/decisions/2026-06-11-docker-sandbox-default.md`](docs/decisions/2026-06-11-docker-sandbox-default.md)
- **Telegram interface.** Single-user personal channel: text in, replies out,
  voice transcription via the Whisper sidecar.
- **MCP integration with defenses.** Allowlist only, version pinning, tool
  descriptor hashing on connect (hash change → disable + diff card), per-process
  minimal-scope tokens, MCP output passed through the same input classifier as
  any external text.
  → [`docs/decisions/2026-06-11-mcp-allowlist-pinning-hashing.md`](docs/decisions/2026-06-11-mcp-allowlist-pinning-hashing.md)
- **Provider routing.** Router selects a model by task type; fallback triggers
  on two consecutive errors (hysteresis), not the first timeout; the session
  survives a fallback and only the KV-cache is lost.
  → [`docs/decisions/2026-06-11-model-router-hysteresis-fallback.md`](docs/decisions/2026-06-11-model-router-hysteresis-fallback.md)
- **KV-cache discipline.** Byte-identical prefix for the whole session,
  append-only history, frozen memory snapshot so within-session writes stay out
  of the live prefix and appear next session.
  → [`docs/decisions/2026-06-11-stable-prefix-kv-cache.md`](docs/decisions/2026-06-11-stable-prefix-kv-cache.md)
- **Skills.** `SKILL.md` with YAML frontmatter (name, description ≤60 chars,
  version, provenance, triggers). Only the menu sits in the prompt; the body
  loads on trigger. A `verification` section is mandatory.
  → [`docs/decisions/2026-06-11-skill-format-staged-creation.md`](docs/decisions/2026-06-11-skill-format-staged-creation.md)
- **Nightly consolidation loop.** Routine model summarizes daily logs into the
  working set and stable memory, then proposes lessons for human review.
  → [`docs/decisions/2026-06-11-generator-judge-self-learning.md`](docs/decisions/2026-06-11-generator-judge-self-learning.md)

**Exit criteria for v0.1:**

- A single user can talk to Aisy from Telegram, have it use a skill and an MCP
  tool, and find the result in memory the next day.
- Every irreversible operation in the `HARD_DENY` set is blocked by code, with a
  test proving each one is blocked even when the model is prompted to perform it.
- The nightly loop runs unattended and produces a human-reviewable diff.
- A fact the user told Aisy to forget stays gone through a full nightly
  consolidation cycle — the minimum regression test for the founding bug.
- In Plan Mode, a TODO step whose action did not actually happen is marked failed,
  not done — a test proves the trace gate catches a "said done, didn't do" step.

---

## v0.2 — Hardening (target: Q4 2026) ⏳

v0.1 proves the architecture exists; v0.2 makes it trustworthy under repetition,
adversarial input, and the one failure mode the project was founded on: a memory
that refuses to forget.

**Scope:**

- **Full bi-temporal memory and the resurrection-guard.** v0.1 already shipped the
  forget-list, the indexer choke point, and the read/ingestion filter, so deletion
  is durable from day one. v0.2 hardens the rest: facts carry
  `valid_at`/`invalid_at` and `is_human_confirmed`; deletions are soft, not hard;
  a **resurrection-guard** validator blocks any consolidation commit (and any
  reindex/import) that re-introduces a tombstoned or forbidden fact and routes it
  to human review; tombstoning keys on an `(entity, relation, object)` equivalence
  class so paraphrases are caught. Contradiction priority is
  human-confirmed > recency > source-authority > confidence, and human-confirmed
  deletions are permanent.
  → [`docs/decisions/2026-06-11-durable-forgetting-tombstones.md`](docs/decisions/2026-06-11-durable-forgetting-tombstones.md),
  [`docs/decisions/2026-06-11-forgetting-invariant-all-index-paths.md`](docs/decisions/2026-06-11-forgetting-invariant-all-index-paths.md)
- **Loop Guardian.** Detect cycles of period 1, 2, and 3 in a sliding window of
  recent tool calls and cap repeats at 3 — covering A–B–A–B and A–B–C–A–B–C
  patterns, not just period-1 spins.
  → [`docs/decisions/2026-06-11-loop-guardian.md`](docs/decisions/2026-06-11-loop-guardian.md)
- **Tool-output compression (RTK).** Route tool output through the Rust Token
  Killer CLI proxy to compress 60–90% before it reaches context, falling back to
  raw output on any error and pinning the version.
  → [`docs/decisions/2026-06-11-rtk-optional-compression.md`](docs/decisions/2026-06-11-rtk-optional-compression.md)
- **MCP rug-pull hardening.** Promote descriptor hashing into a full
  connect-time integrity check with diff cards and an auto-disable path, plus a
  classifier pass over every MCP tool description (tool-poisoning defense).
  → [`docs/decisions/2026-06-11-mcp-allowlist-pinning-hashing.md`](docs/decisions/2026-06-11-mcp-allowlist-pinning-hashing.md)
- **Skill staging governance.** Agent-authored skills land in a staging area
  with provenance; a reviewer UI surfaces the diff and the triggering context so
  a transient failure cannot fossilize into a learned-helplessness skill.
  → [`docs/decisions/2026-06-11-skill-format-staged-creation.md`](docs/decisions/2026-06-11-skill-format-staged-creation.md)
- **Provider-cost telemetry.** Per-task token and dollar accounting, budget
  ceilings enforced by code, and a nightly cost report.
  → [`docs/decisions/2026-06-11-model-router-hysteresis-fallback.md`](docs/decisions/2026-06-11-model-router-hysteresis-fallback.md)

**Exit criteria for v0.2:**

- A regression suite reproduces the memory-resurrection bug and proves the
  resurrection-guard blocks it through a full nightly consolidation cycle.
- Loop Guardian halts a scripted A–B–A–B loop within the cap.
- A simulated MCP rug-pull (descriptor swap) trips the hash check and disables
  the server automatically.

---

## v0.3 — Optional plugins and advanced features (target: Q1 2027) ⏳

With the core hardened, v0.3 adds capabilities that are valuable but optional,
each behind a flag so the default install stays small and file-based.

**Scope:**

- **Optional vector-memory plugin (flag-gated).** A pluggable semantic-search
  backend for large, fuzzy corpora where BM25 is not enough. It is **not** the
  basis of memory and is off by default; the file paradigm remains primary. This
  graduates the deferred item below into an opt-in plugin, not a core dependency.
  → [`docs/decisions/2026-06-11-file-based-memory-fts5-bm25.md`](docs/decisions/2026-06-11-file-based-memory-fts5-bm25.md)
- **Generational self-model.** On a dead-end, start a fresh generation carrying
  only the constitution and accumulated lessons forward; persist persona in a
  self-model document so identity survives across generations.
  → [`docs/decisions/2026-06-11-own-agent-loop.md`](docs/decisions/2026-06-11-own-agent-loop.md)
- **IDE reachability.** Second front-end alongside Telegram so the same agent and
  memory are reachable from the editor.

**Exit criteria for v0.3:**

- The default install runs with no vector store and no Redis; both are
  one-flag opt-ins with documented trade-offs.
- A generation reset preserves persona and lessons while discarding dead-end
  working state.

---

## v1.0 — Stable (target: Q2 2027) ⏳

v1.0 is about commitment, not new features: stable interfaces, a documented
upgrade path, and a security posture we are willing to stand behind publicly.

**Scope:**

- Frozen public contracts for skills (`SKILL.md`), memory layout, hook
  configuration, and the provider-adapter interface, with semantic-versioning
  guarantees from this point forward.
- Documented migration from any 0.x install.
- A published security model: deterministic enforcement layer, lethal-trifecta
  mitigations, MCP supply-chain defenses, and the memory-deletion guarantees,
  each mapped to its enforcing code path.
- Apache-2.0, clean dependency provenance, reproducible build.
  → [`docs/decisions/2026-06-11-apache-2-0-license.md`](docs/decisions/2026-06-11-apache-2-0-license.md)

**Exit criteria for v1.0:**

- No breaking change to a public contract without a major-version bump.
- The security model document is complete and every claim points at a test.

---

## Explicitly deferred

We are deliberately **not** doing these in the 6–12 month window. Listing them
keeps the scope honest.

- 🧊 **Vector memory as the basis of recall.** The file + FTS5 paradigm is
  primary. A large-corpus player abandoned vector-first memory in 2026 for a
  file paradigm, and we follow that lesson. Vectors return only as the optional,
  off-by-default plugin in v0.3 — never as the default memory store.
- 🧊 **Multi-agent orchestration / scale-out.** Aisy is a single-user personal
  agent. Redis queues in v0.3 add durability for one agent's jobs; they are
  **not** a step toward fleets of agents, shared workers, or horizontal
  scale-out. Distributed orchestration is out of scope for this roadmap.
- 🧊 **Multi-tenant / hosted SaaS.** No shared-tenant deployment, billing, or
  account system. Aisy is self-hosted and single-user.
- 🧊 **Autonomous self-modification to prod.** The agent will never push its own
  skills, lessons, or memory deletions to production without human approval.
  This is a permanent design constraint, not a deferral.

---

## How to follow along

- Architecture decisions: [`docs/decisions/`](docs/decisions/) (start with the
  index).
- This roadmap is reviewed at each milestone boundary. Open an issue to propose
  a change of priority; substantive shifts are recorded as new ADRs.
