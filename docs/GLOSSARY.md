# Glossary

Domain terms used across Aisy Agent docs. Linked from the
[decisions](decisions/INDEX.md) and [concepts](concepts/).

### aisy doctor
The full-stack health-check command that folds in `sandbox:doctor` and reports on
the harness's runtime, dependencies, and configuration. See
[ADR-0034](decisions/2026-06-11-onboarding-operations-layer.md).

### aisy init
The idempotent setup wizard that prepares a working Aisy install; safe to re-run.
See [ADR-0034](decisions/2026-06-11-onboarding-operations-layer.md).

### Agent loop
The stateless turn cycle at the core: assemble prompt → call model → run
proposed tool calls through hooks → return results → repeat. See
[ADR-0005](decisions/2026-06-11-own-agent-loop.md).

### Autonomy gradient
Tiered permissioning (Tier 0 read-only … Tier 3 irreversible). Higher tiers
require confirmation. See [ADR-0011](decisions/2026-06-11-autonomy-gradient.md).

### Bi-temporal fact
A memory fact carrying both `valid_at` (when it became true) and `invalid_at`
(when it stopped). Deleting sets `invalid_at` instead of erasing. See
[ADR-0023](decisions/2026-06-11-durable-forgetting-tombstones.md).

### BOOTSTRAP.md
The guided first-run conversation file that walks the operator through initial
setup. See [ADR-0034](decisions/2026-06-11-onboarding-operations-layer.md).

### Constitution
The ordered, normative principles loaded into every session as part of the
stable prefix. A frame the agent is free *inside*, not a flat rule list.

### Context window vs. session
The **session** is the full on-disk record. The **context window** is only the
subset the harness chose to show the model on a given turn. Context is input
capacity, not storage.

### Decision Journal
An append-only log where workers record decisions (FOR / AGAINST / because)
instead of chatting peer-to-peer. The coordinator reconciles from it. See
[ADR-0021](decisions/2026-06-11-coordinator-workers-orchestration.md).

### Descriptor hashing
Hashing an MCP server's tool descriptions on connect; a changed hash after an
update disables the server and raises a diff card. Defense against rug-pull and
line-jumping. See [ADR-0013](decisions/2026-06-11-mcp-allowlist-pinning-hashing.md).

### diagnostics bundle
The redacted support-bundle export used for troubleshooting, with secrets
stripped before it leaves the host. See
[ADR-0034](decisions/2026-06-11-onboarding-operations-layer.md).

### Forget-list (`do_not_remember`)
An explicit denylist of fact ids that must never be re-introduced, surviving any
rewrite or consolidation. See
[ADR-0023](decisions/2026-06-11-durable-forgetting-tombstones.md).

### Frozen snapshot
The always-loaded memory layer is read once at session start and frozen;
within-session writes appear only next session. Keeps the KV-cache prefix
stable. See [ADR-0007](decisions/2026-06-11-frozen-memory-snapshot.md).

### FTS5 / BM25
SQLite's full-text search extension with BM25 relevance ranking — fast keyword
search (~20ms) with no LLM calls. The core memory index. See
[ADR-0006](decisions/2026-06-11-file-based-memory-fts5-bm25.md).

### Generation (generational loop)
On a dead end, the agent starts a fresh working directory carrying only the
constitution and distilled lessons. Borrowed from anima_sdk. See
[ADR-0005](decisions/2026-06-11-own-agent-loop.md).

### HARD_DENY
A regex set in the PreToolUse hook that unconditionally blocks the most
dangerous operations (terraform destroy, `rm -rf`, DROP/TRUNCATE, DELETE without
WHERE, force-push, money moves, secret reads). See
[ADR-0009](decisions/2026-06-11-deterministic-tool-hooks.md).

### Hooks (Pre/PostToolUse)
Deterministic code run before a tool (allow/deny/ask/modify) and after it
(errors-as-results, optional compression). The security boundary; the model does
not participate. See [ADR-0009](decisions/2026-06-11-deterministic-tool-hooks.md).

### KV-cache
Provider-side key/value cache that makes a byte-stable prompt prefix cheap to
reuse (up to ~90% input savings). Requires an append-only, unchanging prefix.
See [ADR-0019](decisions/2026-06-11-stable-prefix-kv-cache.md).

### Lethal trifecta
Private data + untrusted input + an outbound channel. With all three present,
injection-driven data theft is near-inevitable; Aisy breaks at least one per
flow. See [ADR-0010](decisions/2026-06-11-break-lethal-trifecta.md).

### Lint pass
The nightly Stage 2b sub-step that scans `working/*.md` for structural health:
orphaned cross-links (pages with no inbound references), missing fact_key
neighbors (broken `supersedes`/`contradicts`/`extends` edges), and stale
annotations. LLM-generated remediation proposals go through the standard staging
gate — they are never auto-promoted to live memory. Degrades gracefully: if the
generator is unavailable, the step is skipped and the morning card reports "lint
pass skipped".

### Loop Guardian
Detects repeated tool-call cycles of period 1, 2, and 3 and caps repeats. See
[ADR-0020](decisions/2026-06-11-loop-guardian.md).

### MCP (Model Context Protocol)
Anthropic's open standard for connecting tools to an agent. Transports: stdio
and Streamable HTTP. See [concepts/mcp-integration](concepts/mcp-integration.md).

### Narrow waist
A small, stable set of base tools (<20); capability grows through skills and MCP,
not tool count. See [ADR-0014](decisions/2026-06-11-narrow-waist-tool-set.md).

### Nightly consolidation (dreaming)
A nightly pipeline that drafts memory/skill updates with a cheap generator,
validates with a separate judge plus deterministic checks, and stages for a
morning approval card. See
[concepts/nightly-consolidation](concepts/nightly-consolidation.md).

### Plan Mode
A loop state, entered by risk/complexity threshold or explicit user request, that
forces an explicit planning phase before mutating actions: the model writes a
verified TODO (each step declares its proof-of-done trace), code blocks execution
until the plan passes a lint, each step closes only on a passing trace (not
self-report), and ambiguity halts the loop for a clarifying question. See
[ADR-0026](decisions/2026-06-11-plan-mode-clarification-verified-todo.md).

### Raw/Immutable Input Layer
The first tier of Aisy's three-layer memory structure. Comprises daily logs
(`logs/YYYY-MM-DD.md`) and the archive. Serves as the generator's read-only
input during nightly consolidation. Files are never modified after writing; they
rotate and move to the archive.

### Resurrection-guard
A deterministic validator that blocks any consolidation commit re-introducing a
tombstoned or forbidden fact, routing it to human review instead. See
[ADR-0023](decisions/2026-06-11-durable-forgetting-tombstones.md).

### RRF (Reciprocal Rank Fusion)
A rank-fusion algorithm that merges two ranked result lists (e.g., FTS5/BM25
hits and sqlite-vec KNN hits) by summing the reciprocal of each item's rank in
each list. Adds approximately 0.5 ms overhead at personal-corpus scale. Improves
NDCG@10 by 5–8 percentage points over BM25 alone. Used in the optional v0.3
semantic plugin.

### Schema/Config Layer
The third tier of Aisy's three-layer memory structure. Comprises normative
documents (`AGENTS.md`, `constitution.md`) that define Aisy's identity and
operating constraints. Updated only by humans; never overwritten by nightly
consolidation.

### Sidecar
An out-of-process helper (Python) for work the TS core does not do well, e.g.
Whisper transcription. See
[ADR-0003](decisions/2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md).

### skill trust-by-source
Grading a skill's trust by where it came from — builtin > trusted-repo >
community > user — with the model unable to raise its own skill's level. See
[ADR-0015](decisions/2026-06-11-skill-format-staged-creation.md).

### SKILL.md
A skill file (YAML frontmatter + body) capturing procedural memory. Only the
menu line sits in the prompt; the body loads on trigger. See
[ADR-0015](decisions/2026-06-11-skill-format-staged-creation.md).

### SOUL.md
The persona file — values, tone, behavioral ideal — loaded each session. Carries
identity across an LLM swap. (Supersedes the older `SELF_MODEL.md` name.) See
[ADR-0001](decisions/2026-06-11-adopt-aisy-brand-and-file-naming.md).

### Three-step lazy loading
Working-memory documents load as annotation (~50 tokens) → overview (~500) →
full doc, deepening only as needed (~95% token saving). See
[ADR-0008](decisions/2026-06-11-three-step-lazy-memory-loading.md).

### Tombstone
A soft-deleted fact: kept in history for audit, excluded from retrieval via
`invalid_at`. See [ADR-0023](decisions/2026-06-11-durable-forgetting-tombstones.md).

### Typed relationship edges
Explicit YAML frontmatter fields (`supersedes`, `contradicts`, `extends`) on
`working/*.md` fact records that make contradiction and supersession chains
human-readable in files. Complements the bi-temporal `invalid_at` index in
SQLite (ADR-0024) by providing an explicit, auditable link between related facts
directly in the markdown layer.

### Verification by traces
Confirming a result against objective evidence (file exists, DB row changed, API
responded) rather than the model's self-report. See
[ADR-0017](decisions/2026-06-11-external-verification-by-traces.md).

### Wiki/Synthesized Layer
The second tier of Aisy's three-layer memory structure. Comprises `working/*.md`
files and `MEMORY.md`. Progressively synthesized knowledge updated by nightly
consolidation. The primary read surface for the agent during active sessions.
