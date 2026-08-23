# Проверка безопасности управления Project-контекстом в Telegram

Дата: 2026-07-27  
Область: WP-34…WP-37, `makeTelegramProjectControls`, grammY transport и единый
двухпроектный restart E2E

## Проверенные границы

- Inline callback не несёт `projectId`, root, session или owner. Он содержит
  только непрозрачный token длиной не более 48 символов; полная action binding
  хранится в code-owned памяти процесса.
- Action привязана к exact owner, target и ожидаемому selection generation.
  Перед мутацией адаптер выдаёт одноразовый HMAC receipt через
  `SwitchAuthority`, а `ProjectService` потребляет его на общей switch-границе.
- Token удаляется до выдачи receipt. Process epoch меняется после restart, а
  lifetime-set запрещает повторную выдачу retired token в одном процессе.
  Bounded token space исчерпывается fail-closed. Replay, неизвестный token,
  предыдущий render и изменившееся generation не мутируют selection.
- Foreign chat отбрасывается allowlist middleware до callback adapter и до
  Telegram API action. Контроллер не принимает owner из callback payload.
- Natural-language route выполняется только после успешного `Gateway.onUpdate`.
  Контроллер повторно связывает `chatId` с `operatorId=telegram:<chatId>` и
  включает exact `chatId + updateId + text hash + target + generation` в
  source-message hash receipt. Несовпадение блокируется до authority issue.
- Русские и английские точные формы, а также меню вызывают один
  `ProjectService`; параллельного состояния или model-owned switch нет.
- Exact duplicate name показывает owner-bound choice card. До выбора состояние
  registry и generation не меняются. Неизвестная/низкоуверенная цель не создаёт
  Project и не запускает model turn.
- Результат switch раскрывает только имя контекста, имя сессии и root через
  composition-owned formatter. В callback data root и имена отсутствуют.
- Общий конвертер inline-клавиатуры исправлен: пустая последняя строка больше не
  публикуется в Telegram payload.

## Доказательства

- `telegram-project-controls.spec.ts`: generation binding, one-use/replay,
  stale state, pagination, token collision/ABA denial, RU/EN parity, ambiguous
  no-mutation, ordinary-text pass-through и foreign transport identity denial.
- `bot-project-controls.spec.ts`: explicit menu, opaque callback, stale redraw,
  unavailable action, foreign-chat drop и Gateway-before-text-router.
- `telegram-project-runtime.integration.spec.ts`: реальный grammY handler,
  persisted registry/selection, `ProjectService`, exact Sessions, protected
  scoped memory, manifest-aware files, attachment Python sidecar и restart.
  Project A → русская команда → Project B → inline menu → Workspace → restart →
  английская команда → Project A; negative recall/file isolation проверены.

## Остаточные ограничения

- `aisy.ts` ещё не получает новый Project/attachment/memory seam: это намеренная
  граница до явного согласования live activation и migration cutover.
- `➕ Новый проект` и `🗂 Сессии` пока возвращают code-owned unavailable;
  lifecycle UI должен получить отдельные owner-bound action contracts.
- Pending callbacks намеренно process-local. После restart карточки устаревают;
  это fail-closed поведение, а не гарантия восстановления UI.
- Непредсказуемые составные формулировки должны идти через строго типизированные
  structured tools с тем же `ProjectService`; текущий deterministic pre-router
  обрабатывает только точные высокочастотные формы.

## Вывод

Для preview production seam не найдено пути, позволяющего stale, replayed,
foreign-owner, неоднозначному или model-injected вводу изменить контекст в обход
`SwitchAuthority` и `ProjectService`. Live activation этим review не разрешена.
