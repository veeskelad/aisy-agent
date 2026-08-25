# План реализации проверяемого подтверждения памяти

**Связано:** [design](../specs/2026-08-24-natural-memory-acknowledgement-design.md),
[компонент 1](../../specs/01-agent-loop.md),
[компонент 3](../../specs/03-memory.md), ADR-0017 и ADR-0102.

## 1. Typed receipt в Core

- Расширить `packages/core-ts/src/runtime/execute-tool.ts` и публичные типы
  результата инструмента закрытым receipt `memory.remember/v1`.
- Remember принимает ровно одно из `fact` или временного alias `text`, до
  mutation проверяет строку и после `COMMITTED` рендерит byte-exact
  `Запомнил, что <fact>`.
- Связать `operationId`, `receiptId`, `turnId` и exact `fact`; retry/replay
  возвращает тот же receipt без второго effect.
- Тестами Core доказать one-of, bounded validation, пунктуацию, blocked/failed/
  ambiguous ветки и отсутствие ложного «Запомнил».

## 2. LIVE Project runtime и протокол плана

- Обновить `packages/app/src/interactive-turn-runtime.ts`: canonical `fact`,
  legacy `text`, exact receipt и существующую owner/profile/Project изоляцию.
- В `packages/app/src/plan-tool-protocol.ts` разрешить только закрытую exact
  форму `mutationReceipt`; extras, accessors, proxies и symbols продолжают
  отклоняться.
- Обновить targeted corpus в `interactive-turn-runtime.spec.ts`,
  `plan-tool-protocol.spec.ts` и Project-memory integration tests.

## 3. Code-owned terminal reply

- Передать подтверждённый receipt через Agent Loop, не доверяя synthesis model
  формулировку факта или сам факт mutation.
- При составном ходе сохранить остальные полезные результаты, но гарантировать
  ровно одно byte-exact подтверждение committed memory; replay terminal turn не
  выпускает второй reply.
- Добавить adversarial tests: модель скрывает, меняет или дважды повторяет
  acknowledgement; код возвращает один canonical fragment.

## 4. Интеграция и delivery gate

- Обновить Telegram/Project fixtures, включая второе лицо и безличный факт.
- Запустить targeted Core/App/Telegram tests, затронутые package tests,
  workspace typecheck/build, `git diff --check` и scan приватных/secret данных.
- Зафиксировать memory slice отдельным commit. Production smoke должен показать
  точную естественную фразу, retrieval в том же owner scope и отсутствие
  duplicate reply после restart/replay; rollback возвращает предыдущий commit.

## Не-цели

Срез не меняет memory schema, retrieval ranking, forgetting и не вводит
модельную морфологическую обработку. Отдельного acknowledgement-поля нет.
