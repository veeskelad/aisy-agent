# План LIVE-восстановления агентных команд

**Дата:** 2026-08-09  
**Статус:** в реализации; безопасный dormant-фундамент завершён, LIVE-гейты
остаются открытыми
**Дизайн:** `docs/superpowers/specs/2026-08-09-live-durable-subagent-resume-design.md`

## 1. Проверяемый результат

После среза обычный `spawn_subagent` в supervised production Aisy:

- переживает restart без повторного provider/tool effect для уже доказанно
  завершённых операций;
- останавливает неоднозначную операцию и предлагает только точный одноразовый
  повтор или отмену;
- сохраняет ожидание решения, решение пользователя, стоимость и состояние
  отмены независимо от процесса;
- продолжает exact Telegram turn только после parent recovery admission;
- ограничивает число одновременно работающих child code-owned значением;
- возвращает родителю только проверенное компактное наблюдение.

Пользовательская приёмка: дать Aisy задачу с анализом и реализацией, аварийно
перезапустить процесс в нескольких контрольных точках, подтвердить точный повтор
одного неоднозначного действия, проверить `/stop` и получить один итог без
дублирования выполненного шага или стоимости.

## 2. Зафиксированные границы

- В установке одновременно выполняется одна верхнеуровневая Telegram-задача.
  Она связана с exact session; сообщения из других sessions получают bounded
  busy-ответ. Внутри задачи child могут работать параллельно.
- Parent supervisor выдаёт право recovery и доказывает отсутствие старого
  runtime, но не читает план и не выполняет tools.
- Direct `aisy run` не восстанавливает durable delegation. Допускается только
  существующая read-only проверка старой Telegram execution-card, которая не
  читает delegation payload и не даёт authority продолжения.
- MCP composition, новые кнопки, onboarding и compaction остаются за
  параллельной сессией Claude; их файлы не меняются в независимых срезах.
- Вложенность child остаётся глубиной один. Docker isolation child и
  multi-session authority index не входят.
- Неоднозначный Tier-3 effect нельзя повторить внутри прежнего run: нужна новая
  явная задача и обычное step-up подтверждение.

## 3. Архитектурные контракты

### 3.1. Core runner seam

Владелец: отдельный Core-срез.

Файлы:

- `packages/core-ts/src/runtime/sub-agent-runner.ts`;
- `packages/core-ts/src/runtime/scoped-tool-executor.ts`;
- их тесты;
- минимальная проверка abort непосредственно перед tool dispatch в agent loop —
  только после синхронизации с актуальным изменением Claude.

Изменения:

1. Provider получает исходные `AbortSignal` и progress callback.
2. Tool wrapper получает genuine `ToolExecutionContext`, включая ordinal и
   signal.
3. Manager, а не child, получает отдельный узкий authority-journal для seal и
   проверки shard chain; child `append` не разрешает `runtime.*`.
4. Вызов tool повторно проверяет abort после approval и перед внешним dispatch.

Проверки: propagation context/signal/progress, abort-after-approval даёт zero
tool I/O, forged context не принимается, child не пишет reserved records.

### 3.2. Durable operation journal и dormant adapter

Владелец: отдельный App-срез без `bot.ts`, `bin/aisy.ts` и supervisor.

Реализованные файлы:

- новые `durable-delegation-operation-journal.ts` и тест;
- новые `durable-delegation-live-adapter.ts` и тест;
- `durable-delegation-runtime.ts`, `delegation-persistence.ts`,
  `durable-delegation-invocation.ts` и их тесты.

Adapter остаётся dormant: production importer отсутствует, а injected ports в
тестах доказывают контракт, но не подлинность реального SDK/tool transport.

Изменения:

1. Code-owned operation key связывает run, binding, delegation, task, phase,
   ordinal, canonical request hash, authority hash и policy revision.
2. `prepared` fsync-ится до I/O; `settled` хранит bounded private result и
   receipt. Settled replay не вызывает внешний port.
3. `prepared` без `settled` становится durable ambiguity, а не retry.
4. Provider/tool wrappers используют точный context, signal и operation key.
5. Dormant V2 adapter выводит стоимость только из durable receipts, требует
   bounded quote и резервирует conservative hold до `start`. Формула
   `settled + held + retry reservation <= task slice`, затем run/global/daily,
   проверяется operation-control до внешнего I/O.
6. Cancellation различает доказанно остановленную операцию и ambiguous effect.
7. Verifier принимает sealed authority, shard, exact cost и effect evidence и
   отклоняет unresolved operations.
8. Fresh run использует существующий `runBoundedDelegation`, а не legacy
   unbounded driver.

Проверки: provider/tool settled replay ровно один раз, prepared crash без
авторетря, request drift до I/O, receipts-only accounting, signal/cancel
propagation, unresolved verifier refusal, ceiling и serialisation пересекающихся
scopes. Для LIVE остаётся заменить injected ports конкретными SDK/executor
wrappers, не меняя доказанный admission-контракт.

### 3.3. Durable approval и execution actor

Dormant App-срез завершён; Telegram/supervisor wiring остаётся отдельным шагом.

Реализованные компоненты:

- `durable-turn-actor.ts` как private SQLite approval store/controller;
- callback decision controller;
- one-shot claim, step-up и cancellation authorities;
- durable stop/claim CAS и подтверждённая cancellation terminalization.

Не реализованы в этом срезе: supervisor-owned execution loop, Telegram adapter
и unified startup recovery coordinator.

Состояния: `idle -> running -> paused-awaiting-approval -> resume-ready ->
running -> terminal`, с переходом в `cancelling` из любого активного состояния.

Правила:

1. Pause и nonce persist-ятся до отправки карточки.
2. Callback только проверяет operator/chat/action и устойчиво пишет решение; он
   не вызывает provider/tool.
3. Actor claims решение под parent lease, повторно проверяет binding, authority,
   policy и budget непосредственно перед I/O.
4. `/stop` одной транзакцией выигрывает или проигрывает actor claim,
   инвалидирует карточку и не публикует ложный `CANCELLED`.
5. Startup coordinator удерживает один parent recovery lease на всё
   восстановление Telegram delivery и delegation, затем освобождает его только
   в безопасном terminal/no-state состоянии.

Проверки: crash до/после card send, tap, decision, actor claim, new `prepared`;
replay старого callback; `/stop` против tap/actor; restart каждого состояния;
new turn из любой session получает busy; zero state read/I/O без parent lease.

### 3.4. Production composition

Последний небольшой diff после повторной синхронизации с Claude:

1. `bin/aisy.ts` получает durable adapter только в supervised composition.
2. `bot.ts` использует durable controller facade вместо in-memory promise для
   ambiguity; внешний вид существующей approval card не меняется.
3. Legacy ephemeral dispatcher доступен только явной аварийной настройкой для
   новых вызовов и не читает/удаляет durable runs.
4. Doctor/status показывает только безопасные счётчики без payload.
5. Service artifacts запускают `aisy supervise`, задают restart policy и
   проверяются на целевой файловой системе до заявления production-ready.

Перед этим diff обязательны fresh sync, проверка пересекающихся файлов и
перенос только совместимых изменений Claude. Merge conflict не разрешается
выбором одной стороны целиком.

## 4. ADR и спецификация

1. ADR-0052: durable LIVE adapter, operation receipts, bounded scheduler,
   verifier и cancellation ambiguity.
2. ADR-0071: единый global-one-active execution envelope, startup recovery
   coordinator и direct-mode boundary.
3. ADR-0069: durable card nonce/decision/claim/stop lifecycle без изменения
   визуального вида кнопок.
4. `docs/specs/19-durable-subagent-resume.md`: один исполнимый контракт и
   acceptance criteria для каждой crash boundary.
5. Production matrix: различать merged dormant core, LIVE composition и
   deployment activation.

Новый ADR не нужен, пока эти уточнения остаются развитием уже принятых решений.
Если потребуется multi-session authority index или автоматический fallback,
это отдельное решение до кода.

## 5. Порядок поставки и рабочие коммиты

1. **Завершено — Core propagation contract.** Context/signal/progress и узкий
   manager authority journal; targeted и полный Core corpus зелёные.
2. **Завершено — operation journal.** Offline corruption/replay/fsync/fault
   corpus зелёный; реальный provider/tool transport остаётся LIVE-гейтом.
3. **Завершено dormant — bounded durable adapter и operation control.** Bounded
   scheduler, exact group recovery, terminal replay, Journal V2 inventory,
   task/run/global/daily budget holds, one-shot retry authority, единый
   USD-nanos ledger, exact V2 bridge, settled replay и genuine ambiguity pause
   реализованы и протестированы. До LIVE нужны реальные provider/tool
   quote/receipt/evidence ports и manager-owned issuance resolution authority.
4. **Завершено dormant — approval state machine и actor.** Durable pause/card,
   callback/step-up admission, rejection, claim, stop/cancellation CAS,
   restart, expiry и race tests реализованы без реальной сети. Dormant recovery
   adapter подключён; production supervisor/Telegram UX wiring отсутствует.
5. **Частично завершено dormant — supervisor recovery envelope.** Genuine IPC
   lease, fixed-order coordinator, Telegram delivery adapter и approval/stop
   adapter протестированы. Core и production-preview runtime имеют pure full-run
   preflight без handle/state/event side effects; App inspector работает только
   с уже существующим exact run root и не принимает child/verifier ports.
   Private bounded checksummed registry регистрирует exact run до runtime,
   принимает binding только из genuine held IPC lease, двухфазно активирует run
   перед execute и не сканирует каталоги; concrete delegation port принимает
   только genuine coordinator context и exact binding. Stale run lock после
   реального `SIGKILL` удаляется только как supervisor-authorized exact private
   token; malformed/public/symlink corpus даёт zero unlink.
   Telegram имеет dormant per-turn runner seam: он вызывается только после
   checkpoint-bound ACK из genuine held IPC lease и запрещает fallback в
   legacy runner при structural/lost authority. Не готовы реальные
   provider/tool ports, registry retirement, production composition и
   cross-subsystem real-process kill corpus.
6. **Не начато — production importer и service artifacts.** Только после fresh
   sync с Claude-owned composition.
7. **Не начато — real-process corpus и финальная документация.** Kill-point
   сценарии и полный gate.

Каждый пункт заканчивается рабочим commit и push своей ветки. В `master`
попадают только зелёные независимые срезы в порядке зависимостей.

## 6. Риски, rollback и данные

- При неясной операции Aisy останавливается; автоматический retry запрещён.
- Durable payload остаётся только в защищённом run root с существующими
  0700/0600, no-follow/link и size/depth проверками.
- Общая наблюдаемость содержит только IDs, hashes, policy revision, статусы и
  bounded cost counters; команды, пути, prompts и результаты внешних вызовов
  не публикуются.
- Corrupt/drift state переводится в quarantine или code-only refusal.
- Rollback выключает durable recovery только для новых задач, не стирает и не
  преобразует старые run roots.
- Parent-owned state лежит вне writable mounts child.

## 7. Финальная проверка

До подключения production importer обязательны targeted suites каждого среза,
полные tests пакетов Core, App и Telegram, а также workspace typecheck и build.
Real-process corpus аварийно завершает процесс после `prepared`, external
response, `settled`, verifier и terminal commit.

Дополнительно проверяются production import graph, артефакты службы,
форматирование diff, tracked-файлы и независимый review кода и документов.

Если хотя бы один пункт не доказан, срез можно смержить как dormant, но нельзя
объявлять LIVE или production-ready.
