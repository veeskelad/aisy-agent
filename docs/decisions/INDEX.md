# Architecture Decision Records

This directory holds the project's ADRs in [MADR 3.0](https://adr.github.io/madr/)
style. ADRs capture **consequential architectural decisions** — technology
choices, license, packaging, security tradeoffs, deprecations. Bug fixes and
tactical refactors do not belong here.

See [`_template.md`](./_template.md) when creating a new ADR. File naming:
`YYYY-MM-DD-kebab-slug.md`. The logical id (`ADR-NNNN`) lives in the title and
in this index so cross-references stay stable.

## Index

| ID | Status | Date | Title | Tags |
|----|--------|------|-------|------|
| — | Accepted | 2026-06-11 | [Use Architecture Decision Records](./2026-06-11-use-adr.md) | meta |
| ADR-0001 | Proposed | 2026-06-11 | [Adopt "Aisy" Brand & File-Naming Conventions](./2026-06-11-adopt-aisy-brand-and-file-naming.md) | naming, meta |
| ADR-0002 | Proposed | 2026-06-11 | [Apache-2.0 License](./2026-06-11-apache-2-0-license.md) | license |
| ADR-0003 | Proposed | 2026-06-11 | [Monorepo (pnpm) with TS Core + Python Sidecars](./2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md) | packaging |
| ADR-0004 | Proposed | 2026-06-11 | [TypeScript for the Harness Core](./2026-06-11-typescript-for-core.md) | language |
| ADR-0005 | Proposed | 2026-06-11 | [Own Agent Loop (not a third-party SDK)](./2026-06-11-own-agent-loop.md) | architecture |
| ADR-0006 | Proposed | 2026-06-11 | [File-Based Memory with SQLite FTS5/BM25](./2026-06-11-file-based-memory-fts5-bm25.md) | memory |
| ADR-0007 | Proposed | 2026-06-11 | [Frozen Memory Snapshot per Session](./2026-06-11-frozen-memory-snapshot.md) | memory, performance |
| ADR-0008 | Proposed | 2026-06-11 | [Three-Step Lazy Memory Loading](./2026-06-11-three-step-lazy-memory-loading.md) | memory, performance |
| ADR-0009 | Proposed | 2026-06-11 | [Deterministic Pre/PostToolUse Hooks](./2026-06-11-deterministic-tool-hooks.md) | security |
| ADR-0010 | Proposed | 2026-06-11 | [Break the Lethal Trifecta via Separation](./2026-06-11-break-lethal-trifecta.md) | security |
| ADR-0011 | Proposed | 2026-06-11 | [Autonomy Gradient (Tiers 0–3)](./2026-06-11-autonomy-gradient.md) | security |
| ADR-0012 | Proposed | 2026-06-11 | [Docker Sandbox as Default](./2026-06-11-docker-sandbox-default.md) | security |
| ADR-0013 | Proposed | 2026-06-11 | [MCP Allowlist + Version Pinning + Descriptor Hashing](./2026-06-11-mcp-allowlist-pinning-hashing.md) | security, mcp |
| ADR-0014 | Proposed | 2026-06-11 | [Narrow-Waist Tool Set (<20)](./2026-06-11-narrow-waist-tool-set.md) | architecture |
| ADR-0015 | Proposed | 2026-06-11 | [Skill Format + Staged Creation](./2026-06-11-skill-format-staged-creation.md) | skills |
| ADR-0016 | Proposed | 2026-06-11 | [Generator + Separate Judge for Self-Learning](./2026-06-11-generator-judge-self-learning.md) | skills, memory |
| ADR-0017 | Proposed | 2026-06-11 | [External Verification by Real Traces](./2026-06-11-external-verification-by-traces.md) | verification |
| ADR-0018 | Proposed | 2026-06-11 | [3-Tier Model Router with Hysteresis Fallback](./2026-06-11-model-router-hysteresis-fallback.md) | routing |
| ADR-0019 | Accepted | 2026-06-11 | [Stable-Prefix KV-Cache](./2026-06-11-stable-prefix-kv-cache.md) | performance |
| ADR-0020 | Proposed | 2026-06-11 | [Loop Guardian (Period 1/2/3 Detection)](./2026-06-11-loop-guardian.md) | safety, observability |
| ADR-0021 | Proposed | 2026-06-11 | [Coordinator-Workers Orchestration + Decision Journal](./2026-06-11-coordinator-workers-orchestration.md) | orchestration |
| ADR-0022 | Proposed | 2026-06-11 | [rtk as Optional Compression Layer](./2026-06-11-rtk-optional-compression.md) | performance, dependency |
| ADR-0023 | Proposed | 2026-06-11 | [Durable Forgetting: Tombstones + Forget-List + Bi-temporal](./2026-06-11-durable-forgetting-tombstones.md) | memory |
| ADR-0024 | Proposed | 2026-06-11 | [Memory Contradiction Resolution Policy](./2026-06-11-memory-contradiction-resolution.md) | memory |
| ADR-0025 | Proposed | 2026-06-11 | [Transient-vs-Permanent Failure for Skills](./2026-06-11-transient-vs-permanent-skill-failure.md) | skills |
| ADR-0026 | Proposed | 2026-06-11 | [Plan Mode: Planning Phase, Clarification Gate, Verified TODO](./2026-06-11-plan-mode-clarification-verified-todo.md) | architecture, verification, safety |
| ADR-0027 | Proposed | 2026-06-11 | [Capability Narrowing When Untrusted Content Is in Context](./2026-06-11-capability-narrowing-untrusted-context.md) | security, architecture |
| ADR-0028 | Proposed | 2026-06-11 | [Default-Quarantine for External Input (Classifier Escalates Only)](./2026-06-11-default-quarantine-external-input.md) | security |
| ADR-0029 | Proposed | 2026-06-11 | [Human-Confirmation Provenance and Approval Integrity](./2026-06-11-human-confirmation-provenance-binding.md) | security, memory |
| ADR-0030 | Proposed | 2026-06-11 | [Forgetting Invariant Holds on Every Index and Write Path](./2026-06-11-forgetting-invariant-all-index-paths.md) | security, memory |
| ADR-0031 | Proposed | 2026-06-11 | [Optional Semantic Vector Plugin (potion-base-8M + sqlite-vec + RRF)](./2026-06-11-semantic-vector-plugin.md) | memory, retrieval, search |
| ADR-0032 | Proposed | 2026-06-11 | [Code Search: semble as Optional stdio MCP Sidecar](./2026-06-11-code-search-semble.md) | search, mcp, performance |
| ADR-0033 | Proposed | 2026-06-11 | [LLMwiki Pattern Borrow: Three-Layer Structure, Typed Edges, Nightly Lint Pass](./2026-06-11-llmwiki-pattern-borrow.md) | memory, architecture, contributors |
| ADR-0034 | Proposed | 2026-06-11 | [Onboarding & Operations Layer](./2026-06-11-onboarding-operations-layer.md) | onboarding, devex |
| ADR-0035 | Accepted (partly superseded by 0056) | 2026-06-11 | [Install & Packaging](./2026-06-11-install-and-packaging.md) | packaging, devex |
| ADR-0036 | Proposed | 2026-06-11 | [Cost-Transparency Surfacing](./2026-06-11-cost-transparency-surfacing.md) | cost, observability |
| ADR-0037 | Proposed | 2026-06-11 | [Eval & Red-Team Harness](./2026-06-11-eval-and-red-team-harness.md) | verification, security |
| ADR-0038 | Accepted  | 2026-06-12 | [Triggers & Proactivity (Two-Phase, Budget-Capped)](./2026-06-12-triggers-and-proactivity.md) | proactivity, cost |
| ADR-0039 | Accepted | 2026-06-12 | [First-Class Sub-Agent Delegation & Own-Scope Definition](./2026-06-12-first-class-subagent-delegation.md) | orchestration, delegation |
| ADR-0056 | Accepted  | 2026-06-24 | [npm-Package Distribution (primary)](./2026-06-24-npm-package-distribution.md) | packaging, devex, distribution |
| ADR-0055 | Accepted  | 2026-06-24 | [Content-Addressed Exact-Response Cache (#20)](./2026-06-24-exact-response-cache.md) | performance |
| ADR-0054 | Accepted  | 2026-06-23 | [Goal-Driven Loop Layer (/goal)](./2026-06-23-goal-driven-loop-layer.md) | agent-loop, goal, proactivity |
| ADR-0053 | Accepted  | 2026-06-22 | [Proactivity: In-Process Scheduler & Nightly Generator/Judge](./2026-06-22-proactivity-scheduler-and-nightly-generator.md) | proactivity, nightly, triggers, scheduler |
| ADR-0052 | Accepted  | 2026-06-19 | [Live Sub-Agent Runner Seam & Safety Model](./2026-06-19-live-subagent-runner-seam-and-safety.md) | orchestration, delegation, safety, runtime |
| ADR-0051 | Accepted  | 2026-06-17 | [Loop Control Seams — Turn Abort & Mid-Turn Budget](./2026-06-17-loop-control-abort-and-mid-turn-budget.md) | agent-loop, runtime, cost |
| ADR-0050 | Accepted  | 2026-06-16 | [Multi-Provider Catalog, Per-Agent Budget & On-Demand Spend](./2026-06-16-multi-provider-catalog-and-per-agent-budget.md) | providers, runtime, telegram, cost |
| ADR-0049 | Accepted  | 2026-06-16 | [Interactive Onboarding + Terminal Telegram Pairing](./2026-06-16-interactive-onboarding-and-telegram-pairing.md) | onboarding, telegram, security, cli |
| ADR-0048 | Accepted  | 2026-06-16 | [Runtime Composition Layer + @aisy/app Package](./2026-06-16-runtime-composition-and-app-package.md) | architecture, packaging, runtime, telegram |
| ADR-0047 | Accepted  | 2026-06-16 | [Scoped Approval Grants — once / session / always](./2026-06-16-scoped-approval-grants.md) | safety, gateway, telegram, approvals |
| ADR-0046 | Accepted  | 2026-06-16 | [Gateway `getIssuedCard` Read-Accessor for Transport Adapters](./2026-06-16-gateway-issued-card-view-accessor.md) | gateway, telegram, approval-cards, api-surface |
| ADR-0044 | Accepted  | 2026-06-15 | [Agent-Loop Per-Session Seq — Won't Fix](./2026-06-15-agent-loop-per-session-seq-wont-fix.md) | agent-loop, observability, single-user |
| ADR-0043 | Proposed  | 2026-06-15 | [Personality SHA-256 Domain-Separator and Hash Migration Plan](./2026-06-15-personality-hash-migration-plan.md) | personality, security, migration |
| ADR-0042 | Proposed  | 2026-06-15 | [NightlyCarveout Per-Kind Preconditions](./2026-06-15-nightly-carveout-per-kind-preconditions.md) | safety, nightly, maintenance |
| ADR-0041 | Proposed  | 2026-06-15 | [Budget-Precedence Chain Recording](./2026-06-15-budget-precedence-chain-recording.md) | orchestration, observability, cost |
| ADR-0040 | Proposed | 2026-06-13 | [Context Engine — Compaction as a View, Not a Destructive Write](./2026-06-13-context-engine-compaction-as-view.md) | context, memory, observability |

<!--
Maintenance:
- Add every new ADR as a row, grouped by id. Update status when it changes.
- When status changes (Accepted → Deprecated/Superseded), update the row and
  link the replacement.
- Keep Tags short (≤3, comma-separated).
-->
