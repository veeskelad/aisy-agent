# Предложение решения: protocol era для MCP

**Дата проверки:** 2026-07-28, 18:20 MSK

**Статус:** рекомендация для согласования; это не принятый ADR

**Live activation:** запрещена в рамках этого изменения

## Контекст

На момент среза финальный release MCP specification `2026-07-28` и versioned
final schema ещё не опубликованы. В официальном списке релизов верхним остаётся
pre-release tag `2026-07-28-RC` (`9d700ed`), а `2025-11-25` помечен как
`Latest`. В каталоге `schema/` versioned directories заканчиваются на
`2025-11-25`; современная schema доступна только по пути `schema/draft/`.
Обещанная дата публикации не считается доказательством состоявшегося релиза.

Split-пакеты официального TypeScript SDK v2 уже опубликованы как stable
`2.0.0`: release titles и README называют v2 stable release line, а npm
dist-tag `latest` пакетов `@modelcontextprotocol/client`,
`@modelcontextprotocol/server` и `@modelcontextprotocol/core` указывает на
`2.0.0`. При этом записи релиза, собранные из changesets, всё ещё содержат
устаревшую фразу `First beta release of SDK v2`. Это рассинхронизация текста
release notes, а не доказательство beta-статуса опубликованных пакетов.

Modern lifecycle в SDK v2 не включается одним фактом установки `2.0.0`.
Ручной `Client.connect()` по умолчанию выполняет legacy `initialize`; modern
требует явного `versionNegotiation`: `mode: 'auto'` для probe
`server/discover` с legacy fallback либо exact pin `2026-07-28` без fallback.

Наблюдаемые факты для закреплённого Aisy Codex runtime:

- локальный binary и официальный release имеют версию `codex-cli 0.144.5`;
- официальный tag `rust-v0.144.5` фиксирует зависимость `rmcp = 1.8.0`;
- `rmcp 1.8.0` знает константу `2026-07-28`, но его `LATEST` равен
  `2025-11-25`;
- Codex MCP client path явно выполняет legacy `initialize` и получает
  `InitializeResult`; доказанного `server/discover` path в этом runtime нет.

Вывод: наличие modern enum в зависимости не доказывает modern negotiation.
Поскольку закреплённый Codex 0.144.5 открывает legacy lifecycle, modern-only
сейчас не удовлетворяет требованию совместимости Aisy с этим runtime.

## Варианты

| Критерий | Modern-only | Dual-era |
|---|---|---|
| Протокол | только exact `2026-07-28` | exact `2026-07-28` или `2025-11-25` |
| Текущий Codex 0.144.5 | несовместим по доказанному client path | совместим через explicit legacy evidence |
| Риск silent downgrade | минимальный | закрывается строгой policy и typed failure rules |
| Готовность сегодня | блокируется отсутствием final schema и runtime proof | пригоден как выключенный compatibility layer по опубликованному SDK v2 contract |
| Миграция после обновления Codex | не нужна | удалить legacy branch отдельным изменением |

## Рекомендация

Принять **dual-era** как временную архитектурную policy со следующими
неизменяемыми ограничениями:

1. modern probing идёт первым;
2. допустимы только exact `2026-07-28` и exact `2025-11-25`;
3. legacy разрешается только human-owned manifest policy конкретного сервера;
4. authentication, authorization, network, timeout и 5xx никогда не являются
   сигналом для fallback;
5. prior discovery verdict не сохраняется и не переиспользуется новым handle;
6. negotiated era/version попадают только в code-owned audit event;
7. descriptor pin/hash, HookGate, result quarantine и budgets одинаковы для
   обеих эпох;
8. stable SDK packages `2.0.0` уже доступны, но production binding фиксирует
   exact version/integrity только в dependency/transport ADR после публикации
   final schema и прохождения conformance/negative tests;
9. live activation выполняется отдельным cutover после тестов и явного
   подтверждения оператора.

## Условие перехода на modern-only

Dual-era удаляется, когда одновременно выполнены три условия:

- опубликованы final specification и versioned final schema 2026-07-28;
- официальный SDK binding закреплён exact version/integrity и прошёл
  conformance/negative tests;
- закреплённый Codex runtime доказанно использует `server/discover` и корректно
  завершает modern negotiation либо требование совместимости с legacy Codex
  снято отдельным решением.

## Запрашиваемое решение

Согласовать либо отклонить временную policy **dual-era**. После согласования
следует создать MADR 3.0 ADR и строку в `docs/decisions/INDEX.md`; до этого данный
документ остаётся только review proposal.

## Официальные источники

- [MCP specification releases](https://github.com/modelcontextprotocol/modelcontextprotocol/releases)
- [MCP schema tree](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/schema)
- [Текущая draft schema](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/draft/schema.json)
- [MCP TypeScript SDK releases](https://github.com/modelcontextprotocol/typescript-sdk/releases)
- [MCP TypeScript SDK README](https://github.com/modelcontextprotocol/typescript-sdk)
- [Migration guide: support 2026-07-28](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)
- [Codex release 0.144.5](https://github.com/openai/codex/releases/tag/rust-v0.144.5)
- [Codex 0.144.5 workspace dependencies](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/Cargo.toml)
- [Codex 0.144.5 MCP client](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/rmcp-client/src/rmcp_client.rs)
- [`rmcp 1.8.0` protocol versions](https://raw.githubusercontent.com/modelcontextprotocol/rust-sdk/rmcp-v1.8.0/crates/rmcp/src/model.rs)
