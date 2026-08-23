# ADR-0093: Code-derived правила «похожие действия навсегда»

**Статус:** Принято  
**Дата:** 2026-08-09  
**Теги:** safety, approvals, ux

## Контекст

ADR-0047 сохранял подтверждение на уровне имени инструмента. Это удобно, но
слишком широко: подтверждение записи одного файла могло подавить вопросы для
любой следующей записи через `write_file`, а подтверждение одной Bash-команды —
для всего `bash`. Plan Mode из ADR-0092 поэтому намеренно игнорировал такие
legacy grants.

Оператору нужен понятный вариант: один раз подтвердить действие и больше не
получать вопросы для действительно похожей рутины в том же проекте. При этом
модель не должна сама описывать, что считать похожим, а предельно разрушительные
действия не должны наследовать сохранённое разрешение.

## Решение

1. Кнопка `♾️ Похожие навсегда` создаёт durable grant schema v3. Кнопка
   `🔄 Похожие на сессию` создаёт тот же matcher только в памяти процесса.
2. Matcher строит код из `tool + operation + resourceHash + WorkBinding +
   riskCeiling + policyRevision`. Модель не передаёт matcher и не видит
   capability для его создания.
3. В state сохраняются имя tool, безопасное имя operation, SHA-256 resource
   projection, risk ceiling, policy revision, binding и timestamp. Raw path,
   command operands, content, prompt, secret или MCP payload не сохраняются.
4. Для `write_file` и `write_knowledge` ресурсом является exact нормализованный
   относительный path; содержимое не входит в matcher. Для `remember` ресурс —
   topic. Для простого Bash без shell composition операция — executable и
   subcommand, а остальные operands входят в resource hash. `&&`, pipe,
   redirection, substitution и другие составные shell-выражения не получают
   remember-кнопок. `spawn_subagent` также не получает broad matcher. Generic и
   MCP операции используют консервативный exact hash bounded аргументов.
5. Grant подавляет только Tier-2 `ask` и проверяется после всех HARD_DENY,
   taint, narrowing, sandbox и egress запретов. Tier-3, step-up и иной
   extreme-destructive impact никогда не читают и не создают similar grants.
6. Gateway запоминает, разрешил ли code-owned Safety слой matcher для exact
   карточки. Fabricated `approvalScope=always/session` без этого флага
   подтверждает только один вызов и не возвращает remembered scope.
7. `plan` использует schema-v3 similar grants, но продолжает игнорировать
   legacy tool-wide grants. `confirm` игнорирует оба вида. Явный `bypass`
   остаётся отдельным режимом полного host Bash и не создаётся из grant.
8. Durable правило ограничено исходным operator/profile/project и scope,
   переживает restart и действует до `/grants → Сбросить гранты`. Смена code
   policy revision делает старое правило неактивным без автоматического
   расширения.
9. Schema v1 остаётся в карантине. Schema-v2 tool-wide grants сохраняются для
   совместимости `auto`, но не мигрируют в v3 и не получают силу в Plan Mode.

## Последствия

- Повторная правка того же файла или повтор той же простой команды больше не
  создаёт карточку после явного выбора оператора.
- Другой файл, другая operation, другие operands, другой проект или повышенный
  risk снова требуют подтверждение.
- Некоторые сложные Bash/MCP вызовы будут спрашивать каждый раз. Это принятая
  цена за отсутствие широкого фонового разрешения.
- `/grants` показывает, является правило старым широким или новым похожим, и
  позволяет сбросить оба вида.

## Рассмотренные альтернативы

**Оставить per-tool `Навсегда`.** Отклонено: blast radius особенно велик для
`bash`, `write_file` и MCP wrapper.

**Разрешить модели написать glob/regex.** Отклонено: свободный matcher становится
скрытым способом расширить полномочия.

**Использовать exact action hash.** Безопасно, но изменение содержимого файла
или нормального результата команды делало бы правило почти бесполезным.

**Разрешать Tier-3 после одного подтверждения.** Отклонено: это отменяет смысл
красной карточки и step-up.

## Ссылки

- [ADR-0047 — Scoped Approval Grants](./2026-06-16-scoped-approval-grants.md)
- [ADR-0083 — Режимы исполнения](./2026-07-29-execution-modes.md)
- [ADR-0091 — Полный host Bash bypass](./2026-08-08-explicit-host-bash-bypass.md)
- [ADR-0092 — Plan Mode](./2026-08-09-plan-mode-research-then-execute.md)
