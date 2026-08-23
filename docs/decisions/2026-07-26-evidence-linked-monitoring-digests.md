# ADR-0062: Evidence-Linked Monitoring and Digest Pipeline

> **Русская исполнимая спецификация:**
> [Компонент 18 — Мониторинг и evidence-linked дайджесты](../specs/18-monitoring-and-digests.md).
> Она уточняет обязательный `ResolvedWorkBinding`, карантин legacy/unscoped
> записей, delivery lifecycle и проверяемые критерии, не меняя решение ADR.

**Status:** Accepted
**Date:** 2026-07-26
**Tags:** monitoring, digest, retrieval

## Context

Aisy has triggers, watches, memory search, and background budgets, but no product
pipeline for source collection, deduplication, ranking, and digest delivery.
The reference assistant demonstrates the useful end-to-end flow: configured
sources are collected,
ranked using operator criteria, stored locally, and delivered as a mobile-friendly
digest. A naive periodic LLM heartbeat would waste tokens and amplify untrusted
source content.

## Decision

Build monitoring as an evidence-preserving pipeline:

`source registry → deterministic collectors → normalization/deduplication →
local SQLite/FTS5 → optional semantic retrieval → scoring/diversity/time decay →
evidence-linked digest → operator feedback`.

Initial connector families are Telegram channels, RSS, YouTube, GitHub, and web
pages. Each item retains source URL/id, author, publication and collection times,
content hash, and trust provenance. Collection and change detection are
deterministic and zero-model where possible. Model scoring runs only on new or
changed items under background budgets and untrusted-content narrowing.

Регистрация источника одновременно создаёт code-owned read-only egress grant
только на его exact HTTPS domain. Grant связан с exact `sourceId`, не наследует
subdomains/wildcards, не допускает userinfo, credential-like query, нестандартный
порт или ambient fetch и действует до удаления источника. Пауза останавливает
poll, но не отзывает grant; удаление атомарно ставит tombstone и отзывает его.
Смена domain запрещена как update: оператор удаляет прежний source и явно
регистрирует новый. Каждый redirect заново проходит ту же exact-domain и
DNS/IP-pinned проверку; cross-domain redirect закрывается до следующего I/O.
Legacy source без сохранённого grant не повышается автоматически и уходит в
quarantine до повторного добавления.

The operator configures global and per-source criteria, schedules, item limits,
silent hours, and retention in Telegram. Ranking includes source/author diversity
and time decay. Every digest item links to its primary evidence. Explicit
important/not-useful feedback updates ranking preferences through the staged
learning path; it cannot silently mutate safety policy.

## Consequences

- **Positive:** proactive intelligence becomes reproducible, searchable, and
  grounded in primary sources rather than generated summaries alone.
- **Positive:** two-phase triggers avoid model cost when no source changed.
- **Neutral:** FTS5 is the required baseline; semantic search remains optional.
- **Negative:** every connector needs rate-limit, retry, deletion, and provenance
  handling, and third-party APIs may change.
- **Negative:** scoring quality requires ongoing feedback/evals and diversity
  constraints to avoid a narrow filter bubble.

## Alternatives considered

**Periodic full-context LLM heartbeat.** Rejected: unnecessary cost and a larger
prompt-injection surface when nothing changed.

**Generate digests without storing normalized evidence.** Rejected: results are
not reproducible, searchable, or correctable.

**Semantic store only.** Rejected: adds dependency and opacity; FTS5 provides a
durable, debuggable baseline.

## References

- [ADR-0006 — File Memory with SQLite FTS5](./2026-06-11-file-based-memory-fts5-bm25.md)
- [ADR-0027 — Capability Narrowing](./2026-06-11-capability-narrowing-untrusted-context.md)
- [ADR-0031 — Optional Semantic Plugin](./2026-06-11-semantic-vector-plugin.md)
- [ADR-0038 — Triggers and Proactivity](./2026-06-12-triggers-and-proactivity.md)
- [ADR-0053 — Proactivity Scheduler](./2026-06-22-proactivity-scheduler-and-nightly-generator.md)
- [ADR-0061 — Demonstration-Grounded Autonomy](./2026-07-26-demonstration-grounded-autonomy-promotion.md)
