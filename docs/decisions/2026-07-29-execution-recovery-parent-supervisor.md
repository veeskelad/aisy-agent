# ADR-0071: Parent supervisor с подтверждённым IPC как authority восстановления

**Статус:** Принято
**Дата:** 2026-07-29
**Последнее уточнение:** 2026-08-28
**Теги:** telegram, runtime, durability

## Контекст

Durable execution checkpoint сохраняет сам `aisy run`, но после аварийного
завершения тот же процесс не может доказать двух вещей: что прежний runtime
действительно остановлен и что восстановленный opaque binding был захвачен до
начала исходного turn. PID, возраст файла, владелец checkpoint и обычный
lock-файл таких доказательств не дают. Обычный lock-файл вдобавок не
освобождается ядром при crash и порождает опасный stale-lock recovery.

Значит, authority и quiescence должен предоставлять более долгоживущий
code-owned компонент, который запускает runtime и не зависит от его state root.
Сами по себе systemd и launchd предотвращают одновременный запуск двух
экземпляров, но не знают exact binding конкретного Telegram turn; передача hash
через окружение нового процесса не подтверждает, что менеджер получил его до
checkpoint- и provider-работы.

## Решение

Единственный production-источник authority восстановления — **parent supervisor
с подтверждённым IPC**. Quiescence доказывают две независимые SQLite-транзакции,
которые блокирует и освобождает ядро ОС, а не записи с PID или временем.

1. Service unit запускает supervisor, а не `aisy run` напрямую.
2. Первый lease — **manager lease** в отдельной приватной SQLite DB на локальной
   файловой системе. Manager удерживает `BEGIN IMMEDIATE` всю жизнь процесса.
   Второй manager не ждёт и запускает ноль child. При `SIGKILL` транзакцию
   освобождает ядро, поэтому новый service-managed parent может автоматически
   получить manager lease без удаления файла, проверки PID, `mtime` или
   истечения срока.
3. Второй lease — **child/runtime-liveness fence** в другой приватной SQLite DB.
   Новый parent после manager lease получает этот fence **до любого чтения или
   repair durable state** и удерживает его во время подготовки crash recovery.
   Если прежний child ещё жив, parent ждёт фактического освобождения его
   SQLite-транзакции; только после этого разрешены recovery и новый spawn.
4. Parent освобождает runtime-liveness fence только непосредственно перед одним
   exact spawn и повторно захватывает после любого exit либо ошибки до
   protocol-v2 hello. Первым внешним эффектом каждого runtime — supervised child
   и прямого `aisy run` — становится захват того же fence через
   `BEGIN IMMEDIATE`. Runtime удерживает его до OS exit.
5. Direct `aisy run`, уже удерживая runtime fence, выполняет nonblocking probe
   manager DB. Если manager lease занят, direct немедленно освобождает fence и
   завершается с zero checkpoint/vault/provider/tool/Telegram I/O. Если probe
   успешен, direct освобождает только manager probe и продолжает удерживать
   runtime fence. Такой встречный порядок закрывает гонку direct-vs-supervisor
   без PID/временных эвристик.
6. После захвата runtime-liveness supervised child обязан пройти protocol-v2
   hello. До hello запрещены checkpoint, vault, provider, tool и Telegram I/O.
   Ошибка до hello и опоздавший orphan завершаются без этих эффектов; parent до
   следующей попытки снова захватывает fence. Startup descriptor child имеет
   exact shape `{version,path,dev,ino}` и удаляется из доступного
   runtime-окружения до сборки provider/tool adapters.
7. Supervisor держит не более одного runtime-child и создаёт замену только после
   подтверждённого `exit` и повторного захвата runtime-liveness fence.
8. До provider-, ingress- и Telegram-I/O child передаёт только lowercase SHA-256
   binding и ждёт bounded ACK `capture`. Затем он устойчиво публикует
   `prepared/pending` checkpoint и подтверждает его отдельным обменом
   `checkpoint-bound`; manager сначала сохраняет фазу, затем отвечает ACK.
   Отсутствие любого ACK закрывает turn кодом `EXECUTION_AUTHORITY_UNAVAILABLE`.
9. При restart supervisor выдаёт одноразовый recovery lease только замещающему
   child и передаёт последний подтверждённый opaque binding вместе с фазой
   `captured-unbound|checkpoint-bound`. Missing checkpoint безопасно освобождается
   только в первой фазе; bound/missing, corrupt и foreign состояния остаются
   закрытыми.
10. Child перепроверяет lease непосредственно до и после Telegram await,
   устойчиво фиксирует terminal delivery и дожидается ACK освобождения lease до
   long polling, планировщика и работы с provider.
11. Disconnect, дублирующий child, malformed frame, неизвестная версия
   протокола и timeout всегда закрывают recovery и новый turn. Смерть manager
   закрывает старый child, после чего service manager поднимает новый parent,
   который проходит оба kernel lease и recovery barrier заново.
12. IPC имеет exact versioned schema, длину кадра, request id, deadline и
   allowlist типов; raw-ошибки менеджера и child не попадают в Telegram, журнал
   и checkpoint.
13. Запланированный `/restart` получает отдельный одноразовый permit, связанный с
   текущими session, deadline и hash устойчивого intent. `exit(75)` без permit,
   с просроченным permit или после replay считается аварийным.
14. Restart loop имеет code-owned backoff и бюджет. Durable quarantine по
    исчерпанию бюджета, повреждённому state или недоказуемой authority сохраняет
    ноль child и не снимается автоматически. Только quarantine
    `RESTART_BUDGET_EXHAUSTED` может снять явная локальная operator-команда с
    точным acknowledgement причины. До чтения checksummed state команда обязана
    эксклюзивно получить manager lease и runtime-liveness fence; она сохраняет
    execution authority и release receipt, очищая только crash window, счётчик и
    quarantine, а `manager.cleanShutdown=true` фиксирует доказанную quiescence.
    Exact видимый post-rename результат при ошибке fsync повторно закрепляется
    следующей ревизией внутри того же запуска и привязан к exact checksum и
    revision. Уже очищенный state, missing/corrupt state, живой manager/runtime
    и любой другой quarantine дают zero-mutation отказ. Менеджер не интерпретирует
    вывод модели и не исполняет инструменты; в child argv/env, IPC и manager
    state он не передаёт и не сохраняет Telegram token, тексты сообщений,
    session id, turn id, байты checkpoint и credentials.
    Между unexpected exit и replacement child backoff-таймер остаётся
    referenced handle родительского Node-процесса. Supervisor не полагается на
    stdout, IPC, диагностический interval или service-manager restart для
    собственного времени ожидания: даже при отсутствии иных handles он обязан
    дождаться backoff и запустить ровно один replacement внутри того же manager
    epoch.
15. Каждая lease DB содержит единственную exact-schema строку
    `lease_meta.database_id` — 64 lowercase hex. Её identity закрепляет
    неизменяемый private anchor `<lease-db>.identity.json` с exact shape
    `{version:1,role,databaseId,dev,ino}`. Anchor, DB schema/role/databaseId и
    фактические device/inode должны совпадать; symlink и подмена закрывают запуск.
16. Первичная DB сначала полностью инициализируется в private `O_EXCL` temp,
    fsync-ится и публикуется atomic hardlink + directory fsync. Допустимое
    crash-состояние `nlink=2` завершается удалением только exact matching temp и
    повторным fsync. Уже валидная DB без anchor может восстановить anchor только
    как это ограниченное bootstrap crash-window recovery. Anchor при
    missing/empty/mismatch/corrupt DB всегда даёт fail-closed без reinit.
17. Private rollback `-journal` может быть восстановлен только после exact
    validation; WAL/SHM и любые unsafe companion-файлы закрывают запуск без
    mutation. Lease поддерживаются только на локальной файловой системе. NFS,
    SMB и иные сетевые/multi-host FS не поддерживаются; перед активацией
    обязателен process-level self-test взаимного исключения и crash-release на
    фактическом filesystem.
18. Rollback сохраняется структурно: прямой `aisy run` остаётся unsupervised
    rollback-путём без IPC recovery authority; supervisor-dependent
    `executionCheckpoint` в нём default-off. При этом direct обязан получить
    общий runtime-liveness fence и доказать отсутствие manager через probe.
    Этот ADR не является разрешением live-активации.
19. Одна установка имеет ровно один **верхнеуровневый durable execution lease**.
    Его identity включает exact `ResolvedWorkBinding`, session и turn; модель и
    Telegram payload не могут выбрать или заменить эти поля. Состояния
    `running`, `paused-awaiting-approval`, `resume-ready` и `cancelling`
    удерживают глобальную занятость. Новое сообщение из этой либо другой
    session не запускает второй parent turn и получает bounded busy-ответ.
    Bounded child scheduler внутри текущего turn сохраняет разрешённую
    параллельность write-disjoint делегаций.
20. **Единый startup recovery coordinator** получает один parent recovery lease
    после manager lease, runtime-liveness fence, protocol-v2 hello и capture
    exact binding. Этот lease охватывает весь envelope: Telegram terminal
    delivery, durable approval/stop state и delegation recovery. Coordinator не
    освобождает его между подсистемами и не открывает admission нового turn,
    пока обе стороны envelope не пришли к согласованному terminal/no-state или
    fail-closed состоянию. Порядок recovery фиксирован кодом, а не наличием
    отдельных файлов.
21. Direct `aisy run` не сканирует, не читает payload, не repair’ит и не
    возобновляет durable delegation. Единственное исключение — существующая
    legacy read-only проверка execution-card: direct может прочитать только
    минимальные метаданные, необходимые для стабильного отказа и указания
    запустить supervised service. Проверка не выдаёт lease, actor claim, approval
    authority или право продолжения и не изменяет state.
22. Успешные unit/in-process тесты supervisor или dormant adapter не дают права
    на статус LIVE. Активация разрешена только когда production import graph
    запускает durable adapter под `aisy supervise`, Linux/macOS service artifacts
    задают restart/stop policy, а real-process corpus проходит общий Telegram +
    delegation envelope и kill-points после `prepared`, external response,
    `settled`, verifier и terminal commit. До этого компоненты могут быть
    смержены только как dormant.

## Обязательные доказательства до активации

- реальные kill/restart child в состояниях `prepared`, `bound`,
  `terminal-pending` и `terminal-delivered`;
- дублирующий child и disconnect менеджера дают нулевой provider/Telegram I/O;
- timeout ACK захвата и освобождения, malformed и oversized кадр не раскрывают
  подробностей;
- restart storm останавливается по backoff и бюджету;
- real-process parent без stdout/IPC/diagnostic handles переживает unexpected
  child exit, дожидается code-owned backoff без `unsettled top-level await` и
  запускает один replacement без рестарта service manager;
- снятие restart-budget quarantine требует exact acknowledgement и двух
  kernel-owned lease; busy manager/runtime, corrupt/missing state и другой код
  quarantine сохраняют state без изменения;
- два manager-процесса не запускают два child: проигравший manager немедленно
  остаётся zero-child;
- real-process `SIGKILL` manager автоматически освобождает только manager lease;
  новый parent ждёт фактического завершения старого child по runtime-liveness
  fence, получает его до любого state read/repair, удерживает через crash
  preparation и только затем запускает recovery child без временного overlap;
- pre-hello crash и late orphan выполняют zero checkpoint/vault/provider/tool/
  Telegram I/O, а следующая попытка начинается лишь после повторного захвата
  runtime-liveness fence;
- direct `aisy run` сначала получает runtime fence, затем nonblocking probes
  manager DB: busy-manager даёт release и zero-I/O exit, свободный probe
  освобождается отдельно; direct и supervised child не могут работать
  одновременно;
- lease DB приватны, имеют exact identity и не symlink; child получает только
  `{version,path,dev,ino}`, который scrubbed до provider/tool composition;
  manager state root, payload, секреты и authority bytes ему не передаются;
- `lease_meta.database_id` имеет 64 lowercase hex, а private immutable
  `<lease-db>.identity.json` точно равен
  `{version:1,role,databaseId,dev,ino}` и совпадает с DB/device/inode;
- bootstrap публикует только полностью initialized private temp через atomic
  hardlink + fsync; `nlink=2` crash-state безопасно завершается, а valid DB без
  anchor восстанавливает anchor только в этом crash window;
- anchor + missing/empty/mismatch/corrupt DB даёт fail-closed без reinit и без
  изменения evidence;
- private rollback `-journal` восстанавливается только после exact validation;
  WAL/SHM и unsafe companions дают zero-mutation refusal;
- self-test на целевой локальной FS доказывает contention, release после
  `SIGKILL` и отказ от NFS/SMB; PID, `mtime`, stale unlink и time-based takeover
  не являются ни доказательством, ни recovery-механизмом;
- Linux service unit и macOS LaunchAgent проходят один и тот же protocol
  conformance corpus;
- service files явно задают пятнадцатисекундную остановку и сохраняют ownership
  соответствующей OS-группы процессов;
- rollback возвращает прежний default-off запуск без миграции данных;
- глобальный execution lease не допускает второй верхнеуровневый turn из той же
  или другой session во время running/pause/resume/cancelling, но child одного
  turn достигают code-owned concurrency ceiling;
- один parent recovery lease удерживается без разрыва через Telegram delivery,
  durable approval/stop и delegation recovery; crash на границе подсистем не
  открывает admission нового turn и не выдаёт два terminal результата;
- direct `aisy run` даёт zero delegation state read/repair/I/O; legacy
  execution-card exception остаётся read-only отказом и не может стать
  continuation authority;
- production import graph и service artifacts запускают `aisy supervise`, а
  real-process kill corpus подтверждает `prepared`/external response/`settled`/
  verifier/terminal boundaries до любого заявления LIVE.

Node-runtime срез реализован и доказан offline/process корпусом: targeted unit
79/79, real-process parent 10/10 и Telegram recovery 9/9. Полный workspace gate
прошёл `pnpm -r typecheck`, `pnpm -r build` и
`pnpm -r test -- --reporter=dot`: Core 2019 passed / 1 skipped, Telegram 146
passed, App 1013 passed / 1 skipped. Python sidecars: 52 passed / 1 skipped;
Ruff зелёный. После корпуса не осталось fixture-процессов.

Это evidence только для реализованного Node runtime slice и не является
LIVE-активацией. Оно не доказывает quiescence произвольных descendants/sidecars
и не закрывает recovery singleton writer transcript по ADR-0068; эти activation
gaps остаются обязательными.

Отдельный dormant POSIX primitive теперь различает exit leader и отсутствие
всей detached process group, требует отдельные `ESRCH` для PID и PGID и имеет
unit/real-process корпус. Он ещё не подключён к parent supervisor: numeric
PGID не является generation-bound handle, а вышедший через `setsid` descendant
не покрывается этим proof.

## Последствия

- **Положительные:** восстановление опирается на доказанную quiescence, а не на
  эвристики по PID и времени; authority переживает падение runtime и manager;
  появляется единый протокол для Linux и macOS; crash manager не оставляет
  неразрешимый stale manager lock.
- **Нейтральные:** в системе появляются отдельный локальный процесс-менеджер,
  две SQLite lease DB и версионированный IPC-протокол; service unit меняет цель
  запуска; прямой `aisy run` остаётся без recovery authority, но участвует в
  общей liveness-сериализации; Telegram delivery и delegation разделяют один
  startup recovery envelope.
- **Отрицательные:** добавляются точки отказа и код, который нужно сопровождать;
  отсутствие manager закрывает supervised turn, а не деградирует; NFS/SMB
  исключены; каждый целевой filesystem должен пройти обязательный self-test;
  до отдельного multi-session решения разные верхнеуровневые sessions
  сериализуются.

Runtime-liveness fence доказывает завершение Node runtime, но сам по себе не
доказывает quiescence произвольных оторванных descendants или внешних sidecar
effects. До activation нужны отдельные process-group/descendant tests и
доказательство, что sidecar lifecycle либо привязан к runtime, либо имеет свою
durable authority.

Для daemon-owned Docker resources эта authority предложена отдельно в
[ADR-0089](./2026-08-01-durable-external-sidecar-resource-recovery.md); до её
реализации данный activation gap не считается закрытым.

Manager и runtime-child пока работают под одним OS-пользователем. Текущий
контур детерминированно защищает от конкурентных запусков, crash/restart-гонок и
ошибок протокола, но не объявляется ACL-изоляцией от полностью
скомпрометированного same-UID процесса. Такая изоляция требует отдельного
activation-решения (выделенный UID либо контейнер) и не выводится из этого ADR.

Решение также не исправляет stale lock singleton writer полного transcript по
[ADR-0068](./2026-07-29-session-journal-singleton-writer.md). Для него остаётся
отдельный production gap и собственное доказательство recovery; успешный
manager restart нельзя выдавать за полное auto-recovery всей композиции.

## Рассмотренные альтернативы

**Постоянный Unix-socket broker рядом с systemd/launchd.** Даёт сильную
quiescence при строгом peer/lease-протоколе, но требует ACL сокета, фрейминга и
жизненного цикла двух сервисов — избыточно для single-user v1.

**Только systemd/launchd unit.** Доказывает отсутствие наложения экземпляров, но
не хранит exact turn authority и без отдельного канала подтверждения
недостаточен.

**PID, возраст файла или lock в `~/.aisy`.** Не доказывает отсутствие живого
процесса и создаёт stale-lock recovery — отклонено.

**Один SQLite lease для manager и child.** Не позволяет новому manager владеть
своей singleton-authority и одновременно ждать фактическое завершение старого
child. Два независимых lease сохраняют это различие и закрывают overlap.

**SQLite lease на NFS/SMB.** Корректность зависит от удалённой реализации
locking и не принимается как local kernel proof. Такая топология отклоняется до
активации.

## Ссылки

- Предложение: [Service manager для Telegram execution recovery](../reviews/2026-07-28-telegram-execution-service-manager-options.md)
- Спецификация: [02-gateway-connectivity.md](../specs/02-gateway-connectivity.md)
- Durable delegation: [спецификация 19](../specs/19-durable-subagent-resume.md)
- Связано: [ADR-0048](./2026-06-16-runtime-composition-and-app-package.md),
  [ADR-0052](./2026-06-19-live-subagent-runner-seam-and-safety.md),
  [ADR-0068](./2026-07-29-session-journal-singleton-writer.md),
  [ADR-0069](./2026-07-29-agent-card-lifecycle.md)
