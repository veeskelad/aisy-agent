# ADR-0067: Временная dual-era policy протокола MCP

**Статус:** Принято
**Дата:** 2026-07-29
**Теги:** mcp, protocol, security

## Контекст

Aisy подключает внешние MCP-серверы и одновременно должна работать с
закреплённым Codex runtime. На момент решения состояние экосистемы такое:

- Финальный релиз спецификации MCP `2026-07-28` и versioned final schema ещё не
  опубликованы. Верхним в списке релизов остаётся pre-release `2026-07-28-RC`,
  а `2025-11-25` помечен `Latest`. Современная schema доступна только по пути
  `schema/draft/`.
- Split-пакеты официального TypeScript SDK v2 опубликованы как stable `2.0.0`;
  устаревшая фраза `First beta release of SDK v2` в release notes — это
  рассинхронизация текста, а не признак beta-статуса пакетов.
- Modern lifecycle не включается фактом установки `2.0.0`: ручной
  `Client.connect()` по умолчанию выполняет legacy `initialize`, modern требует
  явного `versionNegotiation`.
- Закреплённый `codex-cli 0.144.5` зависит от `rmcp 1.8.0`, где константа
  `2026-07-28` известна, но `LATEST` равен `2025-11-25`; его MCP client path
  доказанно выполняет legacy `initialize`, доказательства `server/discover` нет.

Наличие modern enum в зависимости не доказывает modern negotiation. Modern-only
сегодня отрезал бы совместимость с уже закреплённым Codex runtime, а
безусловный fallback открыл бы silent downgrade — обе крайности неприемлемы.

## Решение

Принимается **временная dual-era policy**: modern-first negotiation с
разрешённым legacy-путём только по явному human-owned manifest сервера.

Неизменяемые ограничения:

1. Modern probing выполняется первым.
2. Допустимы только exact `2026-07-28` и exact `2025-11-25`; никаких диапазонов,
   `latest`-алиасов и вывода версии из ответа сервера.
3. Legacy разрешается исключительно human-owned manifest policy конкретного
   сервера; отсутствие явного разрешения означает отказ, а не понижение.
4. Authentication, authorization, network, timeout и 5xx **никогда** не являются
   сигналом для fallback — это отказ подключения.
5. Prior discovery verdict не сохраняется и не переиспользуется новым handle.
6. Negotiated era/version попадают только в code-owned audit event и никогда — в
   пользовательский вывод вместе с endpoint/token/raw descriptor.
7. Descriptor pin/hash, HookGate, result quarantine и budgets одинаковы для обеих
   эпох: era не расширяет полномочия.
8. Production binding SDK фиксирует exact version/integrity отдельным
   dependency/transport решением — после публикации final schema и прохождения
   conformance/negative tests.
9. Live activation transport выполняется отдельным cutover после тестов и явного
   подтверждения оператора; сам по себе этот ADR ничего не включает.

## Условие перехода на modern-only

Dual-era удаляется, когда одновременно выполнены три условия:

- опубликованы final specification и versioned final schema `2026-07-28`;
- официальный SDK binding закреплён exact version/integrity и прошёл
  conformance/negative tests;
- закреплённый Codex runtime доказанно использует `server/discover` и корректно
  завершает modern negotiation, либо требование совместимости с legacy Codex
  снято отдельным решением.

## Последствия

- **Положительные:** Aisy подключается к обеим эпохам без silent downgrade;
  совместимость с закреплённым Codex сохраняется; правила отказа типизированы и
  проверяемы негативными тестами.
- **Нейтральные:** появляется временная legacy-ветка в transport-слое и
  manifest-поле для human-owned разрешения; её удаление — отдельное изменение.
- **Отрицательные:** поддерживаются два wire-контракта; до публикации final
  schema production binding SDK остаётся незафиксированным, поэтому transport
  остаётся выключенным дольше, чем при modern-only.

## Рассмотренные альтернативы

**Modern-only сейчас.** Отклонено: final schema не опубликована, а закреплённый
Codex 0.144.5 доказанно открывает legacy lifecycle — политика сделала бы
интеграцию неработоспособной именно с тем runtime, который уже используется.

**Dual-era с автоматическим fallback по любой ошибке.** Отклонено: сетевые,
таймаутные и 5xx-ошибки не отличимы от подавления modern-пути атакующим, что
превращает fallback в downgrade-вектор.

**Отложить решение до релиза спецификации.** Отклонено: блокирует connect
gauntlet, transport policy и restart-семантику, которые можно реализовать и
протестировать в выключенном состоянии уже сейчас.

## Ссылки

- Предложение: [Protocol era для MCP](../reviews/2026-07-28-mcp-protocol-era-decision-proposal.md)
- Спецификации: [07-mcp.md](../specs/07-mcp.md), [22-production-mcp-gate.md](../specs/22-production-mcp-gate.md)
- [MCP specification releases](https://github.com/modelcontextprotocol/modelcontextprotocol/releases)
- [MCP schema tree](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/schema)
- [MCP TypeScript SDK releases](https://github.com/modelcontextprotocol/typescript-sdk/releases)
- [Migration guide: support 2026-07-28](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)
- [Codex release 0.144.5](https://github.com/openai/codex/releases/tag/rust-v0.144.5)
- [`rmcp 1.8.0` protocol versions](https://raw.githubusercontent.com/modelcontextprotocol/rust-sdk/rmcp-v1.8.0/crates/rmcp/src/model.rs)
