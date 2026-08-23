# Security review: durable delegation production-preview runtime

**Дата:** 2026-07-27  
**Область:** terminal replay, recovery, cancellation, verifier boundary,
budget accounting, Node persistence и process ownership  
**Результат:** `DONE_WITH_CONCERNS`; preview не подключён live, activation этим
review не разрешена.

## Метод

После завершения реализации изменения были заморожены и проверены отдельно по
трём направлениям: Core lifecycle/budget, cancellation/result leakage и Node
filesystem/restart. Каждая потенциальная находка перепроверена независимым
read-only проходом; исправления начались только после фиксации результатов.

## Подтверждённые и исправленные находки

### F-1 — повторная terminal transition и старые handles

`append()/complete()/fail()` не проверяли status/поколение handle. Повторный
`complete()` дважды списывал бюджет, `complete()→fail()` создавал противоречивые
terminal sets, а старый handle мог менять shard после результата. Добавлены
одноразовая terminal transition, handle epoch и отзыв tool/MCP/append/guardian
authority после terminal/resume.

### F-2 — невалидная и self-reported стоимость

Core принимал negative/NaN cost, а preview использовал cost из child candidate и
не учитывал verifier/failure/cancel. Core теперь принимает только finite
non-negative integer counters. Preview требует отдельный code-owned cumulative
meter, проверяет budget до verifier и после него и сохраняет фактическую стоимость
для denied/cancelled результата.

### F-3 — ложное подтверждение cancellation

`Promise.race` прекращал ожидание, но не доказывал остановку child/verifier I/O.
Операции теперь обязаны вернуть `cancel()`-ack; `CANCELLED` фиксируется только
после его успеха. Не подтверждённая остановка возвращает стабильный runtime error
и оставляет shard non-terminal. Capability append отзывается сразу после
candidate, поэтому поздняя фоновая запись закрыта.

### F-4 — нестрогий verifier и raw driver failures

Truthy `verified: "false"` мог пройти положительную ветку, а generic driver мог
сохранить raw adapter error как observation. Verdict теперь проверяется как exact
boolean с закрытым reason-code enum. Production-preview включает fail-closed
driver mode: adapter/persistence failure не превращается в child result.

### F-5 — concurrent recovery одного run

Atomic rename защищал файлы, но не всю последовательность recovery → external
effect → terminal commit. Добавлен exclusive per-run owner lock, удерживаемый до
terminal commit или подтверждённой cancellation. Competing runtime блокируется до
child I/O; lock удаляется только при byte-matching ownership.

### F-6 — symlink/permission filesystem boundary

Adapter следовал symlink и делал `chmod` существующего target. Теперь runRoot и
каталоги должны быть canonical/private/owned; symlink и public path отклоняются.
Чтение использует `O_NOFOLLOW` + `fstat`, требует regular private single-link
file. Temp publication использует exclusive no-follow descriptor, fsync, rename
и post-publication check.

### F-7 — невалидный DAG и ранний memory amplification

Duplicate/cyclic/unknown/colliding task ids могли породить два исполнения или
конфликт `<id>.jsonl` с каталогом другого id. Полный structural DAG check теперь
идёт до filesystem construction и ограничивает граф 256 задачами, 2048 рёбрами
и 64 зависимостями на задачу. Shard entry получает один MiB pre-hash quota и
предел глубины 128; cycle/function/special-object/oversize отклоняются до clone,
hash и state mutation.

### F-8 — opaque mutators обходили exact owns

Общий sub-agent scope wrapper считал mutating только `write_file/edit_file`.
Теперь действует положительная классификация: разрешены только известные
read-only операции и path-scoped `write_file/edit_file`; `bash`, clone и любая
неизвестная операция запрещены без отдельного scope-aware sub-agent adapter.

### F-9 — исчезновение active shard и несогласованный run ledger

Run ledger хранил terminal sets, но не идентичность уже начатых задач. Потерянный
active snapshot мог выглядеть как ещё не запущенная задача и привести к повтору
child effect. Ledger теперь хранит active task IDs; отсутствие или противоречие
их snapshot блокирует recovery до I/O. Terminal replay дополнительно проверяет,
что сумма восстановленных observation costs не превышает authoritative run
ledger.

## Остаточные блокеры live activation

- SHA-256 shard/manifest — tamper evidence, не MAC. `runtime.verified-result`
  нельзя считать защищённым от процесса с прямой записью в state-root. Live
  composition должна держать control root вне child mounts/writable scope и
  выбрать parent-only journal или MAC/signing key в отдельном ADR.
- Crash внутри двухфайлового terminal commit (child manifest уже опубликован,
  run ledger ещё нет) остаётся fail-closed quarantine. Автоматический repair
  потребует WAL/commit generation и отдельного решения о recovery semantics.
- Stale owner lock намеренно не крадётся автоматически. До live нужен операторский
  recovery flow с fencing, а не удаление lock по PID/mtime.
- `cancel()`-ack является контрактом adapter. Реальные bash/container/provider
  adapters должны доказать interrupt/kill + wait/inspect тестами; обещание adapter
  без такого evidence недостаточно.
- Custom mutators требуют code-owned effect catalog и отдельных scoped adapters;
  текущая положительная классификация блокирует их по умолчанию.
- Raw shard хранится локально для post-mortem без encryption/retention policy.

## Доказательства на момент review

- targeted Core: 66 тестов;
- targeted App persistence/runtime: 17 тестов;
- full regression: Core 1585 passed / 1 opt-in skip, App 407 passed / 1 Docker
  opt-in skip, Telegram 123 passed, Python sidecar 46 passed / 1 platform skip;
- workspace typecheck/build и Ruff зелёные;
- live `aisy.ts`, Telegram cards, run-id scan/cutover и реальные child/provider
  adapters не изменялись и не активировались.

Этот review снижает риск текущего preview, но не заменяет профессиональный аудит
безопасности и не является разрешением на production activation.
