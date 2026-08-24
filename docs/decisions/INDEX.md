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
| ADR-0108 | Принято | 2026-08-25 | [Типизированные auto-skills активируются без выдачи полномочий](./2026-08-25-typed-auto-skills-without-authority.md) | skills, safety, learning |
| ADR-0107 | Принято | 2026-08-23 | [Чистый публичный snapshot вместо раскрытия приватной истории](./2026-08-23-clean-public-snapshot.md) | security, publishing, git |
| ADR-0106 | Принято | 2026-08-22 | [Managed Git и SSH-bundles вместо APT](./2026-08-22-managed-git-distribution-without-apt.md) | packaging, supply-chain, git, ssh |
| ADR-0105 | Заменено ADR-0106 | 2026-08-21 | [Подписанные системные пакеты как root trust root](./2026-08-21-signed-system-packages.md) | packaging, supply-chain, systemd |
| ADR-0104 | Принято | 2026-08-17 | [Подтверждение — это тап, а не кодовое слово](./2026-08-17-tap-is-the-second-factor.md) | safety, approvals |
| ADR-0103 | Принято | 2026-08-15 | [Обучаемая автономность включена в живой сборке](./2026-08-15-learned-autonomy-goes-live.md) | safety, approvals, autonomy |
| ADR-0102 | Accepted | 2026-07-11 | [Agent-Loop Tool-Result Synthesis Round](./2026-07-11-agent-loop-tool-result-synthesis-round.md) | agent-loop, runtime, tools |
| ADR-0101 | Принято | 2026-08-15 | [Карточка подтверждения говорит по-человечески](./2026-08-15-approval-card-speaks-russian.md) | approvals, ux |
| ADR-0100 | Принято | 2026-08-14 | [Plan Mode ждёт согласия оператора](./2026-08-14-plan-mode-waits-for-approval.md) | approvals, agent-loop, ux |
| ADR-0099 | Принято | 2026-08-14 | [Systemd-encrypted credentials и отдельный provider broker для native API](./2026-08-14-systemd-provider-broker.md) | providers, credentials, systemd |
| ADR-0098 | Принято | 2026-08-13 | [Host-encrypted credential и root-owned proxy для облачной транскрипции](./2026-08-13-systemd-encrypted-voice-credential-proxy.md) | voice, secrets, systemd |
| ADR-0097 | Принято | 2026-08-12 | [Глубокий поиск — одно подтверждение на исследование](./2026-08-12-one-confirmation-per-research.md) | approvals, delegation, tools |
| ADR-0096 | Принято | 2026-08-12 | [Сервисные API через закреплённый egress, ключ — только заголовком](./2026-08-12-service-apis-through-pinned-egress.md) | egress, safety, tools |
| ADR-0095 | Принято | 2026-08-10 | [Замок на ответе оператору отключён](./2026-08-10-outbound-reply-lockout-disabled.md) | safety, telegram, ux |
| ADR-0094 | Принято | 2026-08-10 | [Чтение произвольной страницы через закреплённый egress с подтверждением домена](./2026-08-10-open-page-fetch-with-domain-approval.md) | safety, egress, tools |
| ADR-0093 | Принято | 2026-08-09 | [Code-derived правила «похожие действия навсегда»](./2026-08-09-code-derived-similar-approval-grants.md) | safety, approvals, ux |
| ADR-0092 | Принято | 2026-08-09 | [Plan Mode как исследование перед автоматическим выполнением](./2026-08-09-plan-mode-research-then-execute.md) | agent-loop, safety, approvals |
| ADR-0091 | Принято | 2026-08-08 | [Явный durable-режим полного host Bash](./2026-08-08-explicit-host-bash-bypass.md) | safety, bash, ux |
| ADR-0090 | Принято | 2026-08-05 | [Подписочный мозг с инструментами Aisy через локальный MCP-мост](./2026-08-05-subscription-brain-over-local-mcp-bridge.md) | providers, tools, safety, subscriptions |
| ADR-0089 | Принято | 2026-08-01 | [Долговечное восстановление внешних ресурсов sidecar](./2026-08-01-durable-external-sidecar-resource-recovery.md) | sidecars, durability, safety |
| ADR-0088 | Принято | 2026-07-29 | [Долговечное согласие на semantic egress памяти](./2026-07-29-durable-semantic-egress-consent.md) | memory, privacy, consent |
| ADR-0087 | Принято | 2026-07-29 | [Непрозрачный broker секретов, production backend и credential-injecting proxy без plaintext fallback](./2026-07-29-opaque-secret-broker-backend-proxy.md) | secrets, providers, security |
| ADR-0086 | Accepted | 2026-07-29 | [Управление доступом к серверу — только заранее описанные операции, всегда с подтверждением и на срок](./2026-07-29-server-access-control.md) | operations, safety, approvals |
| ADR-0085 | Accepted | 2026-07-29 | [Транскрипция как подключаемый провайдер с явным ответом «покидает ли аудио хост»](./2026-07-29-transcription-providers.md) | voice, privacy, tools |
| ADR-0084 | Accepted | 2026-07-29 | [Ранжирование дайджеста тремя факторами и retention хранилища мониторинга](./2026-07-29-monitoring-ranking-and-retention.md) | monitoring, digest, operations |
| ADR-0083 | Accepted | 2026-07-29 | [Три режима исполнения поверх code-owned approvals](./2026-07-29-execution-modes.md) | safety, approvals, ux |
| ADR-0082 | Accepted | 2026-07-29 | [Дневной бюджет — предупреждение при 80 % и приостановка при 100 %](./2026-07-29-daily-budget-thresholds.md) | cost, safety, operations |
| ADR-0081 | Accepted | 2026-07-29 | [Персистентный трекер задач — третья сущность рядом с целями и триггерами](./2026-07-29-persistent-task-tracker.md) | proactivity, tools, state |
| ADR-0080 | Accepted | 2026-07-29 | [Примитивы зоны знаний и её привязка к scope](./2026-07-29-knowledge-zone-primitives.md) | knowledge, tools, safety |
| ADR-0079 | Accepted | 2026-07-29 | [Дневник дня — поздний контекст, автоматический сброс, чтение по запросу](./2026-07-29-daily-journal-as-late-context.md) | memory, context, tools |
| ADR-0078 | Accepted | 2026-07-29 | [Пороги памяти, дедупликация фактов и самодиагностика каждый turn](./2026-07-29-memory-thresholds-and-self-check.md) | memory, context, safety |
| ADR-0077 | Принято | 2026-07-29 | [Нативные хуки расширения и точки подгрузки контекста](./2026-07-29-native-extension-hooks.md) | tools, context, extensibility |
| ADR-0076 | Принято | 2026-07-29 | [Несколько ботов на одной установке](./2026-07-29-multi-bot-single-installation.md) | telegram, architecture, memory |
| ADR-0075 | Принято | 2026-07-29 | [Зона знаний с ленивым каталогом](./2026-07-29-knowledge-zone-lazy-index.md) | memory, context, retrieval |
| ADR-0074 | Принято | 2026-07-29 | [Защищённая scoped-память как единственная живая память](./2026-07-29-scoped-memory-as-live-memory.md) | memory, architecture, migration |
| ADR-0073 | Принято | 2026-07-29 | [Authority активации Workspace v2 и обязательная репетиция отката](./2026-07-29-workspace-v2-activation-authority.md) | migration, safety, release |
| ADR-0072 | Принято | 2026-07-29 | [Воспроизводимый CPU-образ Whisper для голосового ввода](./2026-07-29-reproducible-whisper-image.md) | media, supply-chain, security |
| ADR-0071 | Принято | 2026-07-29 | [Parent supervisor с подтверждённым IPC как authority восстановления](./2026-07-29-execution-recovery-parent-supervisor.md) | telegram, runtime, durability |
| ADR-0070 | Принято | 2026-07-29 | [Единый durable binding манифестов миграции](./2026-07-29-unified-migration-cohort-binding.md) | migration, durability, safety |
| ADR-0069 | Принято | 2026-07-29 | [Жизненный цикл Agent Cards — scopes, ревизии и публикация](./2026-07-29-agent-card-lifecycle.md) | agents, dna, security |
| ADR-0068 | Принято | 2026-07-29 | [Единственный process-lifetime writer журнала сессий](./2026-07-29-session-journal-singleton-writer.md) | transcript, durability, safety |
| ADR-0067 | Принято | 2026-07-29 | [Временная dual-era policy протокола MCP](./2026-07-29-mcp-dual-era-protocol-policy.md) | mcp, protocol, security |
| ADR-0066 | Принято | 2026-07-27 | [Одноразовый изолированный sidecar для публичного clone](./2026-07-27-one-shot-sandbox-for-public-clone.md) | security, projects, sandbox |
| ADR-0065 | Accepted | 2026-07-26 | [Hybrid Vector and Keyword Retrieval](./2026-07-26-hybrid-vector-keyword-retrieval.md) | memory, retrieval, embeddings |
| ADR-0064 | Accepted | 2026-07-26 | [Full-Fidelity Hash-Chained Session Transcript](./2026-07-26-full-fidelity-session-transcript.md) | sessions, context, observability |
| ADR-0063 | Accepted | 2026-07-26 | [Layered Workspace and Project Memory](./2026-07-26-layered-workspace-project-memory.md) | memory, projects, context |
| ADR-0062 | Accepted | 2026-07-26 | [Evidence-Linked Monitoring and Digest Pipeline](./2026-07-26-evidence-linked-monitoring-digests.md) | monitoring, digest, retrieval |
| ADR-0061 | Accepted | 2026-07-26 | [Demonstration-Grounded Scoped Autonomy Promotion](./2026-07-26-demonstration-grounded-autonomy-promotion.md) | autonomy, learning, memory |
| ADR-0060 | Accepted (memory topology partly superseded by ADR-0063) | 2026-07-26 | [Project-Scoped Sessions and File Ownership](./2026-07-26-project-scoped-sessions-file-ownership.md) | projects, sessions, files |
| ADR-0059 | Accepted | 2026-07-26 | [Action Contracts and Verified Completion](./2026-07-26-action-contracts-verified-completion.md) | agent-loop, tools, verification |
| ADR-0058 | Принято | 2026-07-26 | [Первоначальная настройка и подключения «мозга» через Telegram](./2026-07-26-telegram-first-bootstrap-brain-connections.md) | onboarding, telegram, authentication |
| ADR-0057 | Принято | 2026-07-26 | [Aisy как единая плоскость управления supervised runtime «мозга»](./2026-07-26-aisy-control-plane-supervised-brain-runtimes.md) | architecture, providers, runtime |
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
| ADR-0011 | Proposed (partly superseded by ADR-0061) | 2026-06-11 | [Autonomy Gradient (Tiers 0–3)](./2026-06-11-autonomy-gradient.md) | security |
| ADR-0012 | Proposed | 2026-06-11 | [Docker Sandbox as Default](./2026-06-11-docker-sandbox-default.md) | security |
| ADR-0013 | Proposed | 2026-06-11 | [MCP Allowlist + Version Pinning + Descriptor Hashing](./2026-06-11-mcp-allowlist-pinning-hashing.md) | security, mcp |
| ADR-0014 | Proposed | 2026-06-11 | [Narrow-Waist Tool Set (<20)](./2026-06-11-narrow-waist-tool-set.md) | architecture |
| ADR-0015 | Proposed (partly superseded by ADR-0108) | 2026-06-11 | [Skill Format + Staged Creation](./2026-06-11-skill-format-staged-creation.md) | skills |
| ADR-0016 | Proposed (partly superseded by ADR-0108) | 2026-06-11 | [Generator + Separate Judge for Self-Learning](./2026-06-11-generator-judge-self-learning.md) | skills, memory |
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
| ADR-0031 | Superseded by ADR-0065 | 2026-06-11 | [Optional Semantic Vector Plugin (potion-base-8M + sqlite-vec + RRF)](./2026-06-11-semantic-vector-plugin.md) | memory, retrieval, search |
| ADR-0032 | Proposed | 2026-06-11 | [Code Search: semble as Optional stdio MCP Sidecar](./2026-06-11-code-search-semble.md) | search, mcp, performance |
| ADR-0033 | Proposed | 2026-06-11 | [LLMwiki Pattern Borrow: Three-Layer Structure, Typed Edges, Nightly Lint Pass](./2026-06-11-llmwiki-pattern-borrow.md) | memory, architecture, contributors |
| ADR-0034 | Proposed | 2026-06-11 | [Onboarding & Operations Layer](./2026-06-11-onboarding-operations-layer.md) | onboarding, devex |
| ADR-0035 | Accepted (partly superseded by 0056) | 2026-06-11 | [Install & Packaging](./2026-06-11-install-and-packaging.md) | packaging, devex |
| ADR-0036 | Proposed | 2026-06-11 | [Cost-Transparency Surfacing](./2026-06-11-cost-transparency-surfacing.md) | cost, observability |
| ADR-0037 | Proposed | 2026-06-11 | [Eval & Red-Team Harness](./2026-06-11-eval-and-red-team-harness.md) | verification, security |
| ADR-0038 | Accepted  | 2026-06-12 | [Triggers & Proactivity (Two-Phase, Budget-Capped)](./2026-06-12-triggers-and-proactivity.md) | proactivity, cost |
| ADR-0039 | Accepted | 2026-06-12 | [First-Class Sub-Agent Delegation & Own-Scope Definition](./2026-06-12-first-class-subagent-delegation.md) | orchestration, delegation |
| ADR-0056 | Частично заменено ADR-0106 | 2026-06-24 | [npm-Package Distribution (primary)](./2026-06-24-npm-package-distribution.md) | packaging, devex, distribution |
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
| ADR-0044 | Superseded by ADR-0064 | 2026-06-15 | [Agent-Loop Per-Session Seq — Won't Fix](./2026-06-15-agent-loop-per-session-seq-wont-fix.md) | agent-loop, observability, single-user |
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
