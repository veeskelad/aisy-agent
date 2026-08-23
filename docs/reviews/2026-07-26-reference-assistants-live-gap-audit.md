# Reference Assistants to Aisy Live Gap Audit

> **Историческая baseline-матрица.** Статусы ниже фиксируют срез 2026-07-26 и
> не являются текущим production verdict. Актуальная сверка находится в
> [матрице от 2026-08-23](./2026-08-23-production-readiness-matrix.md).

**Date:** 2026-07-26  
**Last verified:** 2026-07-26 after Action Contract, ProjectRegistry Slice 1,
and full 24-lesson HTML/screen traceability review  
**Status:** Active implementation baseline  
**Decision confirmed by the operator:** Aisy remains the single controlling
core and owner of the agent loop. The two reference assistants are references for
user flows, interaction design, and product capabilities. They are not nested
as a second, competing tool loop.

## 1. Outcome

Turn Aisy from a capable but partially disconnected harness into a personal,
progressively autonomous agent that:

1. uses tools whenever a request requires observable action;
2. organises work into durable projects, sessions, and files;
3. completes onboarding and service setup conversationally;
4. delegates to visible, scoped, and budgeted sub-agents;
5. recalls and learns from operator examples, texts, corrections, and approvals;
6. promotes demonstrated workflows from suggestion to scoped autonomy;
7. monitors configured sources and produces evidence-linked digests.

The target is not merely feature parity. A capability counts as complete only
when it is reachable through the live Telegram/runtime composition and proven
by a behavioural test or trace.

## 2. Evidence rules

Every capability is classified as one of:

- **LIVE** — reachable through the production composition and covered by a
  representative behavioural or integration test.
- **DEGRADED** — live, but incomplete, unreliable, or materially weaker than the
  benchmark flow.
- **CORE-ONLY** — implementation and unit tests exist, but the live application
  does not compose or expose it.
- **MISSING** — no complete implementation seam exists.
- **UNVERIFIED-LIVE** — static wiring exists, but a provider-backed or Telegram
  end-to-end trace has not been captured.

Documentation, menu labels, types, and isolated unit tests are not sufficient
evidence of a live capability.

## 3. Reference product evidence

The reference behaviour was reconstructed from all 24 extracted course lessons,
the system map, three video analyses/contact sheets, and selected full-size
frames. Those sources are private local material and are deliberately not
linked from this repository: the video analysis and contact sheets, and the
lessons covering the system map, talking to the agent, the memory system,
projects and tasks, skills, MCP and services, voice and media, monitoring, and
digest scoring.

- [Full 24-lesson HTML and screen contract matrix](./2026-07-26-reference-screen-contract-matrix.md)

Hermes is used as a second reference for streaming, tool and sub-agent cards,
session/project organisation, workspace browsing, profiles, attachments,
scheduled jobs, and self-improving skills. The historical local review source is
not part of the Aisy repository or its public documentation graph.

## 4. Current live capability matrix

| Capability | Status | Current evidence | Gap against target |
|---|---|---|---|
| Telegram main menu | **DEGRADED** | [`bot.ts`](../../packages/app/src/bot.ts) renders the same labels | Several actions return `Раздел в разработке`; visual parity hides missing behaviour |
| Text conversation | **DEGRADED** | Telegram принимает `message:text`; guarded `text-delta` редактирует один ответ, а code-owned tool/subagent/action/usage lifecycle — одну redacted execution-card с `/stop` | Production API providers пока возвращают полный ответ, subscription runtime не активирован, durable crash/restart recovery карточки отсутствует |
| Required tool use | **DEGRADED** | Code-owned Action Contract требует inspect/mutate/delegate evidence, выполняет одну recovery-попытку, возвращает `unverified` вместо сухого успеха и показывает authoritative итог в Telegram | Нет opt-in real-provider/Telegram trace; lexical classification и provider tool compliance требуют behavioural eval telemetry |
| Tool-result synthesis | **LIVE** | [`agent-loop/index.ts`](../../packages/core-ts/src/agent-loop/index.ts) implements bounded dispatch → observe → synthesis rounds | Only helps after the model emits the first tool call |
| Plan mode | **CORE-ONLY** | Plan linting, approval, and tests exist in the core loop | Live provider adapters do not emit structured plans; plan execution currently dispatches named tools with empty arguments |
| Native tools | **DEGRADED** | Read/write/list, memory, web, sub-agent, goals, and optional sandboxed bash are composed in [`bin/aisy.ts`](../../packages/app/src/bin/aisy.ts); v2 preview additionally has lease-bound descriptor-relative `edit_file` with exact preconditions | Edit is not advertised by legacy live provider catalog before v2 activation; project, session, attachment, skill, MCP, and media tool families remain incomplete; bash disappears without a sandbox image |
| CLI providers | **DEGRADED** | Reply-only CLI adapter exists | It intentionally degrades to no tools; Hermes must not be integrated through this seam |
| Projects | **DEGRADED** | Durable `ProjectRegistry`, atomic `projects.json`, Default-project migration, non-overlapping roots, and selected project root are composed in the live binary | Telegram create/switch UI, project memory namespace, file manifest, canonical symlink guard, and switch-triggered context rebuild are not live |
| Sessions | **DEGRADED** | Telegram now receives a durable project session id; core supports create/switch/rename/archive/restore/search and restart restoration | UI exposes only recent log rows; transcript resume/compaction and dynamic selection are not composed |
| Context engine | **CORE-ONLY** | Compaction engine and acceptance tests exist | Not composed into the live Telegram application; no context indicator or compact action |
| Workspace files | **DEGRADED** | Native file tools operate inside one workspace | No attachment store, file cards/browser, project selection, upload index, or knowledge ingestion |
| Voice and media | **DEGRADED** | Live Telegram handler явно отклоняет disabled media без download; optional inbox seam сохраняет document/audio/photo/video/voice/animation, а album получает single-binding batching, cap и одну summary-card | `aisy.ts` ещё не активирует inbox; Whisper sidecar и media-to-model flow отсутствуют |
| Memory search and recall | **LIVE** | File + SQLite FTS5 memory, per-turn recall, `search_memory`, `remember`, and forgetting are composed | Product-visible memory layers, provenance, recall explanation, and corrections are incomplete |
| Personal operating memory | **DEGRADED** | Constitution, SOUL, USER, and MEMORY are frozen per session | Missing first-class goals, preferences, learned procedures, current-task, daily journal, and project-local knowledge views |
| Conversational onboarding | **CORE-ONLY** | `makeBootstrapFlow` and card-gated tests exist | Telegram does not start or resume the flow; the user sees a generic ready message |
| Provider/API setup | **DEGRADED** | Terminal `aisy init`, provider catalog, vault, and doctor exist | No complete in-chat masked connection flow, validation card, or service-specific onboarding |
| Autonomy controls | **DEGRADED** | Scoped approval grants, tiering, budgets, and hard denies are strong | No friendly work modes, evidence-based trust promotion, scenario scope, demotion, or autonomy history |
| Learning from operator examples | **MISSING** | Memory can be explicitly written | No demonstration store, correction events, procedure induction, shadow evaluation, or promotion policy |
| Sub-agent execution | **DEGRADED** | Live `spawn_subagent` исполняет DAG под scope/budget/grant правилами; Telegram показывает code-owned pending/running/completed/failed lifecycle без args/results | Invocation остаётся model-voluntary и JSON-in-a-string; ещё нет structured spawn schema, typed result validator и durable UI recovery |
| Skills | **DEGRADED** | Live binary загружает hash-pinned/trace-verified catalog, подключает frozen menu/body-on-trigger к main/goal и AgentCard-filtered child, а Telegram показывает bounded metadata-only каталог | Promotion/doctor/telemetry/verification-probe path не подключён; nightly skill drafts пусты, main AgentCard default cutover не согласован |
| MCP | **DEGRADED** | Live startup валидирует durable allowlist, а Telegram показывает bounded read-only каталог без connection data/raw descriptors | `mcpWritable=false`, active server set пуст; transport, provider tool injection и invocation не активированы |
| Nightly memory learning | **DEGRADED** | Generator/judge/staging pipeline is composed | It receives boot-time facts and little/no live day-log evidence; newly learned facts may wait for restart |
| Self-improving skills | **CORE-ONLY** | Lifecycle design protects against one-off failure fossilisation | Live nightly generator does not draft skills |
| Proactive goals | **LIVE** | Goal orchestrator, durable goal store, budget and stop handling are composed and tested | Product discovery and visibility are limited; it does not substitute for scenario learning |
| Monitoring and digests | **DEGRADED** | Live binary пассивно открывает scoped SQLite registry с deny-all HTTP; Telegram показывает exact-binding aggregate status без locator/content. Core также имеет пять collectors, dedupe/scoring/ranking, digest/feedback, receipt-gated coordinator, renderer/adapter и optional scheduler hook | Production egress port, collection/scorer callback, Telegram digest delivery и verified feedback follow-ups не активированы |
| Timers/triggers | **DEGRADED** | Live `/remind`, `/schedule`, `/watch`, cancellation, durable trigger store, startup catch-up, probes, proactive turns, and global background budget are composed | Command syntax is rigid, per-trigger debit persistence is deferred, and triggers are not monitoring-source collectors or a digest pipeline |
| Tool/sub-agent progress UI | **DEGRADED** | Code-owned tool/subagent/action/usage events редактируют одну execution-card; есть elapsed, terminal status, locked redaction и `/stop` | Нет persisted message binding и crash/restart reconciliation; расширенные file/autonomy cards ещё не подключены |
| Observability | **DEGRADED** | Journals, spend, session log, and many core traces exist | App JSONL journal and product telemetry do not yet prove cross-seam behaviour or dry-response rate |
| Behavioural E2E | **MISSING** | Unit suites are broad and currently green | No repeatable Telegram/provider/tool/memory end-to-end suite; live provider smoke requires explicit data-egress authorisation |

## 5. Primary root cause of dry answers

The original operating protocol told the model to use tools, but action was not
a runtime invariant. That root cause is now partially remediated by ADR-0059:
the live agent loop creates a code-owned Action Contract, records successful
tool evidence, requires readback after the last mutation, gives one constrained
recovery turn, and suppresses an unverified success claim. OpenAI and Anthropic
tool choice is still probabilistic, so provider-backed behavioural telemetry and
classifier evaluation remain required before this row can become `LIVE`.

The first implementation slice must introduce an **Action Contract** owned by
code:

```text
operator turn
  -> deterministic/structured intent classification
  -> answer-only | inspect-required | mutate-required | delegate-required
  -> allowed tool families + evidence requirement
  -> model turn
  -> zero required observations? one constrained recovery turn
  -> dispatch through existing safety/approval gates
  -> result verifier
  -> final synthesis with evidence
```

This is not “force a tool on every message.” Conversation, explanation, and
clarification remain answer-only. Requests that claim a real-world or workspace
action must produce an observation, a verified result, or a structured blocked
state.

### Required runtime outcomes

- An inspect-required request cannot finish with zero observations.
- A mutate-required request cannot claim success without a postcondition check.
- A delegate-required request exposes the selected AgentCard, scope, budget,
  progress, and result contract.
- Provider-specific tool forcing is a recovery mechanism, not the safety
  boundary; all irreversible checks remain in deterministic Aisy code.
- CLI/reply-only providers are ineligible for action-required turns unless they
  implement the same structured event/tool bridge.

## 6. Target architecture

### 6.1 Single loop ownership

Aisy owns:

- intent and action contracts;
- tool registry and dispatch;
- approval and autonomy policy;
- project/session state;
- memory writes and forgetting;
- delegation scope and budgets;
- trace, verification, and final completion status.

One reference contributes proven conversational flows, the other interface
patterns and may later provide UI components through an Aisy event API. Neither
is allowed to execute a hidden second tool loop behind a reply-only adapter.

### 6.2 Product state model

```text
Operator
  └── Profile / agent identity
      ├── Global workspace
      │   ├── DNA: identity, profile, mission, goals, preferences, projects
      │   ├── MEMORY.md and LEARNED.md
      │   ├── cross-project daily journal
      │   └── global knowledge catalogue
      ├── Project
      │   ├── policy and autonomy grants
      │   ├── resumable sessions
      │   ├── files and attachments
      │   ├── project memory and knowledge
      │   └── tasks / current-task state
      └── Services: providers, MCP, monitoring sources, delivery channels
```

A live turn key is at least:
`operator + profile + project_id + session_id`. Telegram chat id is transport
identity, not session identity.

### 6.3 Learned autonomy model

Autonomy is learned from the operator's demonstrations and corrections rather
than selected once as a global mode.

1. **Observe:** store a redacted demonstration trace containing intent,
   relevant context references, actions, result, operator feedback, and outcome.
2. **Induce:** propose a reusable procedure, style rule, decision rule, or memory
   candidate with source provenance.
3. **Shadow:** predict the plan/result while the operator or existing workflow
   remains authoritative; compare automatically.
4. **Confirm:** ask the operator to approve the candidate procedure and its
   exact project/tool/data scope.
5. **Assist:** execute with confirmation and record verified outcomes.
6. **Promote:** after a configurable number of successful distinct-session
   executions, offer scoped automatic execution.
7. **Operate:** run autonomously inside the grant, still verifying postconditions
   and reporting evidence.
8. **Correct/demote:** operator edits and failed verification update the
   procedure and can automatically reduce its autonomy level.

Every learned artefact carries:

- provenance references;
- confidence and evidence count;
- allowed projects, tools, resources, and side-effect tier;
- expiry/review date;
- version history and rollback pointer;
- success/failure and operator-correction counters.

Operator texts can teach voice, structure, vocabulary, and evaluation criteria.
Operator action traces teach procedures. Fine-tuning is optional and deferred
until a consented, high-quality demonstration corpus exists; the initial system
uses retrieval, structured preferences, procedures, and staged skills.

## 7. Delivery plan and acceptance gates

### Slice 0 — Baseline and behavioural harness

Deliver:

- checked-in capability matrix;
- scenario fixtures derived from the reference flows;
- fake-provider cross-seam tests and opt-in live-provider smoke runner;
- telemetry for `dry_response`, `tool_required`, `tool_observed`,
  `postcondition_verified`, and `completion_claimed`.

Gate: every matrix row has a reproducible command/test or is explicitly marked
unverified with the missing evidence named.

### Slice 1 — Reliable action, projects, and sessions

Deliver:

- Action Contract and verifier;
- structured provider recovery for required tool use;
- ProjectRegistry and active project selection;
- real session ids and create/switch/rename/archive/restore;
- context-engine composition and context indicator;
- attachment/file ownership model.

Gate:

- no dry completion across the action-required eval set;
- mutations require postcondition evidence;
- project isolation tests prove no memory/file/session leakage;
- Telegram E2E creates a project, starts two sessions, switches, resumes, and
  compacts without losing the append-only transcript.

### Slice 2 — Conversational onboarding and settings

Deliver:

- resumable Telegram onboarding state machine;
- agent name/persona/operator profile/mission/first project;
- provider and service connection cards with masked secret capture;
- digest, timezone, budget, and initial autonomy setup;
- live `/status`, `/usage`, `/context`, and `/doctor` commands.

Gate: a clean install reaches a validated first successful tool turn entirely
through chat, without manual file editing and without placing a secret in a
model-visible span.

### Slice 3 — Learned autonomy

Deliver:

- demonstration and correction event schema;
- procedure/style/decision candidate extraction;
- shadow evaluator;
- scoped trust grants and promotion/demotion state machine;
- autonomy history and Telegram review cards.

Gate: a representative repeated workflow progresses through observe → shadow →
confirm → assist → scoped-auto based on distinct verified runs, reproduces the
operator's approved style/criteria, and rolls back after a correction or failed
postcondition.

### Slice 4 — Agents and sub-agents

Deliver:

- visible AgentRegistry and role templates;
- structured spawn schema rather than JSON-in-a-string;
- model-visible capabilities and selection criteria;
- per-agent scope/budget enforcement during execution;
- typed result contracts, critic/judge, progress events, and final synthesis.

Gate: independent subtasks execute concurrently, conflicting scopes are
serialised or rejected, budget excess halts before the next provider/tool call,
and the parent cannot claim completion until required child contracts validate.

### Slice 5 — Memory, files, and controlled self-learning

Deliver:

- reference-compatible global DNA/MEMORY/LEARNED/daily layers plus project
  memory/knowledge/current-task/task layers from ADR-0063;
- explainable recall and correction/forget controls;
- live turn/day-log ingestion into nightly;
- current-fact refresh without process restart;
- staged skill drafts from repeated verified procedures.

Gate: a fact, preference, and procedure learned in one session are recalled with
provenance in another; correction and forgetting remove them from all retrieval
paths; a one-off failure cannot create a negative skill.

### Slice 6 — Monitoring and digests

Deliver:

- source registry and collectors for an initial small source set;
- normalised local store, text search first, optional semantic retrieval;
- per-source and global scoring criteria;
- schedules, evidence links, delivery, and user-feedback learning.

Gate: an operator configures sources and a schedule in Telegram, receives a
reproducible evidence-linked digest, and sees subsequent ranking respond to
explicit feedback without losing source diversity.

### Slice 7 — Product polish and release proof

Deliver:

- token/event streaming;
- tool, approval, sub-agent, file, and autonomy cards;
- voice/document/photo/video/album ingestion;
- cancellation and queued-message behaviour;
- updated README, roadmap, specs, migration notes, and operator runbook.

Gate: unit, integration, Telegram E2E, behavioural eval, security/privacy,
rollback, and observability suites pass against the production composition;
documentation makes no capability claim that lacks a live proof.

## 8. Test strategy

### 8.1 Behavioural scenario set

Each scenario records:

- operator input and provenance;
- expected intent class;
- required/forbidden tool families;
- approval and autonomy state;
- expected observations and postconditions;
- memory reads/writes;
- expected completion or structured block;
- maximum budget and latency class.

Minimum scenario families:

1. pure conversation — no forced tool;
2. factual workspace inspection — at least one read/search observation;
3. file mutation — approval as required plus read-back verification;
4. ambiguous action — clarification instead of invented action;
5. unavailable tool/provider — explicit blocked result, no fake success;
6. project switch — no context leakage;
7. session resume/compact — transcript preserved;
8. delegated research — child result contract and parent synthesis;
9. operator correction — learned candidate updated/demoted;
10. monitoring digest — source evidence and ranking feedback.

### 8.2 Test layers

- **Unit:** state machines, classifiers, policies, schemas, redaction, promotion.
- **Contract:** provider tool choice/results, Telegram events, vault, MCP, files.
- **Composition:** production dependency wiring; fail when a core-only feature is
  accidentally advertised as live.
- **Integration:** real filesystem/SQLite, sandbox, session/project switching.
- **Telegram E2E:** updates → cards/tools → response/status using a controlled bot
  transport fixture.
- **Provider behavioural eval:** opt-in external calls with redacted fixtures;
  never silently send repository or operator data.
- **Security/privacy:** cross-project isolation, approval binding, secret
  non-disclosure, untrusted-input narrowing, forgetting invariants.
- **Soak:** long session compaction, queued turns, scheduler, nightly, restart.

### 8.3 Release metrics

- action-required dry-response rate;
- verified-completion rate;
- first-attempt tool selection accuracy;
- postcondition failure and false-success rate;
- cross-project leakage rate (must be zero);
- autonomy confirmation, correction, demotion, and rollback counts;
- recall precision plus operator rejection rate;
- sub-agent contract success and budget-stop rate;
- digest source diversity and feedback-adjusted precision;
- cost and latency per scenario class.

## 9. Risk, compatibility, and rollback

- Preserve the current deterministic hard-deny, approval, sandbox, egress,
  forgetting, and budget boundaries.
- Add product capabilities behind versioned feature flags until their E2E gates
  pass; keep the existing single-workspace/single-session behaviour as migration
  input, not as a permanent parallel architecture.
- Migrate state append-only where possible. Back up and version project/session
  metadata before schema changes.
- Never ingest provider keys, secret values, raw private attachments, or full
  operator corpora into learning artefacts. Store references and redacted
  features unless the operator explicitly selects content for learning.
- Make every autonomy grant inspectable and revocable. A model cannot promote
  itself or widen its scope.
- Do not adopt the reference's approval-bypass examples or make unrestricted shell the
  default. The target is high autonomy with verified, learned scope—not hidden
  privilege escalation.
- Do not integrate Hermes as a reply-only CLI provider for action turns. Any
  Hermes-derived UI/runtime component must speak Aisy's structured event and
  tool protocol.

## 10. Immediate next implementation work

1. Convert this matrix into executable composition checks.
2. Specify `ActionContract`, `ActionEvidence`, and `VerificationResult` at the
   core/app boundary.
3. Add failing behavioural tests for the current dry-response path.
4. Implement required-action recovery in Anthropic and OpenAI adapters without
   weakening existing safety gates.
5. Introduce `ProjectRegistry` and transport-independent session identity.
6. Wire the context engine and session/project menu flows into Telegram.
7. Capture the first redacted end-to-end trace and update this matrix from
   `UNVERIFIED-LIVE` to the observed status.

## 11. Open decision record

The operator has selected Aisy as the controlling core. A new ADR should record
single-loop ownership, reference boundaries, migration compatibility, and
the structured integration rule. Per repository policy, the ADR must be created
only after explicit operator confirmation.
