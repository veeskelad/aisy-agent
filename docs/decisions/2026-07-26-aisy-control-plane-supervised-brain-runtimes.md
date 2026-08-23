# ADR-0057: Aisy как единая плоскость управления supervised runtime «мозга»

**Статус:** принято  
**Дата:** 2026-07-26  
**Теги:** architecture, providers, runtime

## Контекст

Aisy владеет детерминированной безопасностью, памятью, бюджетами, scope
проектов, approvals и verification. Прямые API adapters подходят owned agent
loop, потому что возвращают структурированный model output и tool calls.
Доступ по подписке устроен иначе: Claude Pro/Max и Codex через ChatGPT доступны
через официальные agent runtimes, а не как общие API credentials. Если считать
такие runtimes reply-only CLI providers, Aisy теряет tool events, approvals и
наблюдаемый прогресс. Если разрешить непрозрачный второй loop, он сможет обойти
control plane Aisy.

Оператор выбрал Aisy долговечным ядром и при этом хочет перенять полезные UX- и
workflow-паттерны референсных ассистентов.

## Решение

Aisy является единой control plane и поддерживает два явных класса brain driver:

1. **Native API drivers** выполняются внутри owned agent loop Aisy и возвращают
   структурированные model/tool responses.
2. **Supervised subscription runtime drivers** подключаются к официальным Claude
   Code или Codex runtime через structured event protocols. Они работают как
   scoped workers под политиками project, sandbox, approval, budget, memory и
   verification, которыми владеет Aisy.

Subscription runtime обязан предоставлять lifecycle, authentication state,
streamed events, cancellation, approval requests, usage и final result. Его
инструменты должны быть либо Aisy-owned capabilities через typed bridge/MCP,
либо confined native capabilities, последствия которых Aisy может ограничить и
проверить. Reply-only subprocess не допускается для action-required turns.

Референсные ассистенты остаются эталонами UX и workflows. Они не становятся
конкурирующими control plane внутри Aisy.

## Последствия

- **Положительное:** subscription- и API-доступ сосуществуют без ослабления
  invariants безопасности, памяти и verification Aisy.
- **Положительное:** structured events позволяют Telegram streaming, tool cards,
  approvals, cancellation и точные traces.
- **Нейтральное:** выбор provider теперь учитывает runtime type и capability
  metadata, а не только provider/model.
- **Отрицательное:** Aisy поддерживает две integration shapes и отслеживает
  изменения upstream runtime protocol/authentication.
- **Отрицательное:** native runtime features без надёжного scope/verification
  приходится отключать или оборачивать.

## Рассмотренные альтернативы

**Использовать subscription credentials как API keys.** Отклонено: подписка и
API billing — разные продукты аутентификации; runtime credential не является
универсальным provider API contract.

**Оставить reply-only CLI providers.** Отклонено для action turns: Aisy не может
наблюдать и контролировать tool execution, а сухие ответы остаются возможными.

**Сделать Hermes, Claude Code или Codex основным harness.** Отклонено: это
разделило бы владение memory, policy, projects и verification и отбросило бы
более сильное детерминированное ядро Aisy.

## Ссылки

- [ADR-0005 — Own Agent Loop](./2026-06-11-own-agent-loop.md)
- [ADR-0048 — Runtime Composition](./2026-06-16-runtime-composition-and-app-package.md)
- [ADR-0050 — Multi-Provider Catalog](./2026-06-16-multi-provider-catalog-and-per-agent-budget.md)
- официальная документация OpenAI Codex по authentication и app-server;
- официальная документация Anthropic Claude Code по setup и CLI.
