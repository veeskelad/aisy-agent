# Развёртывание

Aisy рассчитана на одного пользователя и самостоятельный хостинг.
Multi-tenant/SaaS режим не поддерживается (см. non-goals в `VISION.md`).

> **Статус:** Node-runtime service-managed composition по ADR-0071 развёрнута и
> прошла автоматическую target-приёмку. Docker startup recovery barrier по
> ADR-0089 доступен только через exact opt-in parent и пока требует отдельной
> service-manager/real-Docker репетиции; Docker sidecar create/use выключены.
> При наличии legacy writer directory по-прежнему нужен отдельный ручной
> cutover после доказанной quiescence. Текущий release verdict находится в
> [production-матрице](../reviews/2026-08-23-production-readiness-matrix.md).

## Варианты запуска

| Вариант | Назначение | Примечания |
|---|---|---|
| **Managed Git** | основной production-канал | exact HTTPS origin/master; atomic generations; offline rollback |
| **npm** (`npm i -g @aisy/app`) | простой локальный запуск | опциональный канал; Node 22; `aisy init` → прямой `aisy run` |
| **systemd/launchd service** | устойчивый production-запуск после activation gate | unit/plist запускает `aisy supervise`; systemd использует `Restart=always`, launchd — `KeepAlive` |
| **Из исходников** | цикл разработки | frozen workspace install/build; Node 22 + pnpm ≥9 |

Прямой `aisy run` — rollback-путь без IPC recovery authority и с
supervisor-dependent `executionCheckpoint`, выключенным по умолчанию. При этом
он, как и supervised child, обязан первым внешним эффектом захватить общий
runtime-liveness SQLite lease через `BEGIN IMMEDIATE` до checkpoint, vault,
provider, tool и Telegram
I/O. Затем direct nonblocking probes manager DB: при busy-manager освобождает
runtime lease и завершается без I/O, при свободном manager lease освобождает
только probe и продолжает. Одновременные direct и supervised runtime запрещены.

## Предварительные требования

- **Git, Node 22 LTS и Corepack** для managed install; **pnpm ≥9** через
  Corepack для запуска из исходников.
- Для service-managed режима — локальная файловая система для двух приватных
  SQLite lease DB. NFS, SMB и другие сетевые/multi-host FS не поддерживаются.
  Перед активацией обязателен process-level self-test взаимного исключения,
  release после `SIGKILL` и exact identity на фактическом filesystem.
- Для включённого полного журнала — локальная файловая система для отдельной
  writer-lease DB и её immutable anchor. Она проходит собственный process-level
  self-test на фактическом journal root; успешная проверка manager/runtime DB не
  заменяет эту проверку.
- Опционально **Docker Engine ≥29.5.2** только для parent startup recovery
  barrier. Legacy `AISY_SANDBOX_IMAGE`, `AISY_WHISPER_IMAGE` и child-owned
  restricted clone запрещены fail-closed; текущий opt-in не включает sidecar
  create/use.
- **gVisor (`runsc`)** остаётся требованием будущего усиленного sidecar-пути по
  ADR-0012, но текущий recovery-only opt-in не запускает контейнеры.
- Облачный voice path использует отдельный root-owned broker и требует one-use
  TTY enrollment, явного consent и выбранного descriptor; без них он fail closed.

## Supervisor и восстановление

Service unit запускает `aisy supervise`, а не runtime напрямую. Manager и
runtime-liveness используют разные SQLite DB и удерживают `BEGIN IMMEDIATE`:

- второй manager немедленно остаётся zero-child;
- после `SIGKILL` manager lease освобождает ядро, и service manager может поднять
  новый parent;
- новый parent ждёт фактического освобождения runtime-liveness lease прежним
  runtime, получает fence до любого state read/repair, удерживает через crash
  preparation и только затем запускает recovery child;
- parent освобождает runtime fence только непосредственно перед exact spawn и
  повторно получает после любого exit или pre-hello failure;
- child захватывает runtime lease до обязательного protocol-v2 hello и держит
  его до OS exit;
- PID, `mtime`, удаление «устаревшего» lock-файла и ожидание тайм-аута не
  считаются доказательством остановки;
- restart budget и повреждённый durable state по-прежнему переводят service в
  zero-child quarantine.

При exact Docker opt-in parent после manager/runtime-liveness fences read-only
загружает заранее enrolled v4 ledger, закрепляет canonical socket + daemon
identity и завершает recovery до первого child spawn. Supervisor не создаёт
missing ledger автоматически, direct `aisy run` отказывает, а child не получает
`AISY_OWNED_DOCKER_*` или `DOCKER_*`. Enrollment и rollback описаны в
[операционном runbook](operations-runbook.md#parent-docker-recovery-barrier);
после enrollment `aisy doctor --only=sidecars` проверяет config, ledger и pinned
daemon только read-only.

Startup descriptor child имеет exact shape `{version,path,dev,ino}` и удаляется
до сборки provider/tool adapters. Manager state root и содержимое checkpoint
через него не передаются.

Каждая lease DB содержит `lease_meta.database_id` из 64 lowercase hex. Его
закрепляет immutable private `<lease-db>.identity.json` с exact shape
`{version:1,role,databaseId,dev,ino}`. Bootstrap полностью инициализирует private
temp, затем публикует его atomic hardlink + fsync; exact `nlink=2` crash-state
завершается безопасно. Valid DB без anchor восстанавливает anchor только как
bootstrap crash-window recovery. Anchor при missing/empty/mismatch/corrupt DB
всегда закрывает запуск без reinit. Private rollback `-journal`
восстанавливается только после exact validation; WAL/SHM и unsafe
companion-файлы закрывают запуск без mutation. Изоляция от hostile same-UID
процесса этим не заявляется.
Lease доказывает завершение Node runtime, но не произвольных orphan descendants
или внешних sidecar effects: до activation нужны отдельные process-group и
sidecar-lifecycle evidence.

Исторический evidence ADR-0089: targeted unit 79/79, real-process parent 10/10, Telegram
recovery 9/9. Полный workspace gate прошёл `pnpm -r typecheck`,
`pnpm -r build`, `pnpm -r test -- --reporter=dot`: Core 2019 passed / 1
skipped, Telegram 146, App 1013 passed / 1 skipped. Python sidecars: 52 passed /
1 skipped; Ruff зелёный; fixture process leak — ноль. Это не доказательство
LIVE-активации или quiescence произвольных descendants/sidecars; актуальный
combined corpus и target gates вынесены в production-матрицу. Evidence
уточнённого transcript writer приведено отдельно ниже.

## Singleton writer полного журнала

Уточнённый [ADR-0068](../decisions/2026-07-29-session-journal-singleton-writer.md)
заменяет steady-state directory lock на kernel-released local-FS SQLite lease:

- writer удерживает `BEGIN IMMEDIATE` весь lifetime процесса;
- exact layout: `${journalRoot}/.transcript-writer-lease/` mode `0700`, внутри
  `transcript-writer-lease.sqlite3` и
  `transcript-writer-lease.sqlite3.identity.json` mode `0600`; DB role —
  `transcript-writer`, anchor exact
  `{version:1,role:'transcript-writer',databaseId,dev,ino}`;
- unsafe permissions, symlink, corrupt bytes, identity drift, WAL/SHM или
  небезопасный companion закрывают запуск без mutation;
- bootstrap публикует полностью initialized private temp через atomic hardlink
  и fsync; восстановим только exact доказанный bootstrap crash window;
- `${journalRoot}/.transcript-writer.lock` после cutover остаётся permanent
  regular compatibility barrier mode `0600` с exact
  `{version:1,kind:'transcript-writer-sqlite-v1',databaseId,dev,ino}`, чтобы
  старый directory-lock binary всегда получал `EEXIST`;
- acquisition автоматически завершает только exact crash boundary публикации
  barrier: `nlink=2` и ровно один same-inode private temp
  `..transcript-writer.lock.compat.<32-lowercase-hex>.tmp`; любой иной
  hardlink/residue остаётся fail-closed, doctor его не исправляет;
- существующий legacy directory/residue не удаляется и не преобразуется
  автоматически. Cutover возможен только отдельной ручной процедурой после
  доказанной quiescence всех writer;
- PID, `mtime`, stale unlink и ожидание времени не используются ни для
  acquisition, ни для recovery.

Публичные отказы ограничены `held-by-another-process`, `legacy-residue`,
`lease-unsafe`, `lease-corrupt`, `lease-unavailable` и `lease-lost`.

При включённом journal busy/corrupt/unsafe/legacy отказ останавливает весь full
runtime `aisy run` до provider/tool/Telegram I/O. Setup-only Telegram не пишет
transcript и остаётся вне этого gate. Продолжить full runtime «без журнала»
после ошибки нельзя. Явный rollback текущего binary — только exact
`AISY_SESSION_JOURNAL=0`; он не открывает и не изменяет DB, anchor, barrier или
transcript. Permanent barrier при этом сохраняется, поэтому запуск старого
binary не является rollback.

`aisy doctor` инспектирует состояние read-only и ничего не восстанавливает даже
с `--fix`. Перед LIVE отдельный self-test должен доказать на целевой Linux/macOS
filesystem: A удерживает lease, B получает busy, после `SIGKILL` процесса A
процесс B автоматически получает тот же DB inode. NFS/SMB запрещены.

Evidence текущего среза: transcript-тесты на реальных процессах — 12/12;
объединённая process-матрица — 31/31; полный App gate — 132 файла тестов
успешно / 1 пропущен, 1031 тест пройден / 1 пропущен; typecheck App и
upstream-сборка зелёные. Self-test на целевой FS, ручной legacy cutover и
LIVE-активация этим не заявляются.

## Docker recovery barrier и socket

Текущий production opt-in использует host Docker engine только из parent для
startup recovery; обычный `bash` остаётся host tool, а Docker Bash/Whisper/clone
не активированы. Доступ к Docker socket эквивалентен root authority на хосте:

- выдавайте его только на полностью доверенном хосте и не открывайте socket или
  harness для недоверенного ingress;
- конфигурация самого harness доступна только для чтения вне agent namespace;
- не передавайте socket, `DOCKER_*` или `AISY_OWNED_DOCKER_*` в child;
- для rollback снимите exact parent opt-in и сохраните ledger, не удаляя его.

## Секреты и резервное копирование

- Секреты хранятся в игнорируемых git локальных источниках и runtime vault; они
  не должны попадать в image или историю git.
- Память — markdown + SQLite в `AISY_MEMORY_ROOT`, с git-резервированием. Ночная
  консолидация выполняет только fast-forward push и сообщает результат в
  утренней карточке. Remote задаётся оператором отдельно.
- Для восстановления повторно получите backup в `AISY_MEMORY_ROOT`, затем
  `aisy doctor` перестроит SQLite-индекс и снова применит forget invariant.

## Обновления

`aisy doctor --post-upgrade` повторно проверяет контракты, склонные к drift:
схему конфигурации, MCP descriptor-hash pins и model IDs provider-а. Ошибка
post-upgrade check блокирует обслуживание до исправления.

### Root voice proxy для Deepgram

Этот компонент поддерживается только на Linux с systemd 255+, системным
`/usr/bin/python3.12` и host-key encryption через `systemd-creds`. Он не
запускается из checkout, NVM или `.venv`. Первый
`/usr/libexec/aisy-voice-install` устанавливается reviewed SSH-bootstrap-ом;
последующие обновления выполняет root-owned helper текущего release.

Release собирают без ключа на Linux:

```bash
scripts/build-voice-broker-bridge.sh
python3 scripts/build-voice-proxy-release.py \
  --output=/tmp/aisy-voice-release \
  --commit=<полный-git-commit> \
  --release=<версия> \
  --native-addon=packages/app/native/build/aisy_voice_broker_bridge.node
```

Команда печатает SHA-256 `manifest.json`. Для bundle строится canonical receipt,
после чего receipt и каждый member передаются pinned SSH receiver-у в
root-owned one-shot inbox. Запуск installer из checkout или user-owned staging
запрещён. После seal explicit helper повторно проверяет receipt, bundle и live
runtime binding:

```bash
sudo /usr/libexec/aisy-voice-install install \
  --deployment-id=<one-shot-id> \
  --runtime-user=<system-account-Aisy> \
  --runtime-unit=aisy.service \
  --aisy-home=<absolute-aisy-home>
```

Helper descriptor-relative проверяет manifest и каждый файл, выполняет
pre-cutover self-check, атомарно меняет `current/previous`, ставит sandboxed
units и требует active broker/socket. Ошибка после переключения возвращает
совместимый `previous`; SQLite и зашифрованное состояние при этом не
откатываются.

Rollback использует те же runtime binding параметры:

```bash
sudo /usr/libexec/aisy-voice-install rollback \
  --runtime-user=<system-account-Aisy> \
  --runtime-unit=aisy.service \
  --aisy-home=<absolute-aisy-home>
```

Обычный uninstall сначала выполняет подтверждённый revoke через Aisy. Если
машина снимается с эксплуатации и удалить зашифрованное состояние сейчас
нельзя, единственный разрешённый обход должен быть явным:

```bash
sudo /usr/libexec/aisy-voice-install uninstall \
  --runtime-user=<system-account-Aisy> \
  --runtime-unit=aisy.service \
  --aisy-home=<absolute-aisy-home> \
  --preserve-encrypted-credential=yes
```

Эта команда удаляет code/units, но намеренно сохраняет `/var/lib/aisy/voice`;
оператор обязан учесть его как оставшийся зашифрованный backup. Helper никогда
не принимает plaintext, provider key, произвольный URL или unit через argv/env.

### Root provider broker для native API

Provider broker использует те же manifest и rollback-инварианты, что voice
proxy, но собирается отдельным exact bundle без пользовательских данных:

```bash
python3 scripts/build-provider-broker-release.py \
  --output=/tmp/aisy-provider-release \
  --commit=<полный-git-commit> \
  --release=<версия>
```

Команда печатает внешний SHA-256 `manifest.json`. Bundle содержит только exact
Python import closure и пять provider systemd units; installer отклоняет
неизвестные файлы, symlink, mode/size/hash drift и несовпадающий commit. До
переноса на хост release должен пройти `verify_bundle` и isolated
`provider_proxy_service.py self-check`.

Bundle helper принимает system account, active user-systemd unit, absolute
Aisy home и отсортированный список поддержанных provider ids. Exact uid/gid,
PID/cgroup и installation hash он выводит сам через NSS, systemd и `/proc`.
Значения material, auth headers и произвольные URL через helper не передаются.
После install сначала выполняют read-only doctor/readiness, затем одноразовый
operator TTY enrollment; rollback не меняет revision и не восстанавливает
отозванный slot. Полный bootstrap/delivery/rollback runbook находится в
[managed-git-and-ssh.md](./managed-git-and-ssh.md).

До первого enrollment системный trust root инициализирует host key отдельно от
Aisy и до запуска hardened broker namespace:

```bash
sudo systemd-creds setup
```

Команду выполняют один раз на целевом host; предупреждение о незашифрованном
носителе требует отдельного решения оператора (disk encryption, TPM или отказ от
маршрута). Aisy installer намеренно не создаёт host key и при его отсутствии
оставляет provider route закрытым.

## Соответствие требованиям

Карта обязательств EU AI Act находится в
[eu-ai-act.md](../compliance/eu-ai-act.md).
