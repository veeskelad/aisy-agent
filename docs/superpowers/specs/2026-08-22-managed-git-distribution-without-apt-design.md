# Доставка Aisy без APT: managed Git и SSH-bundles

**Статус:** направление одобрено оператором 2026-08-22
**Заменяет:** [signed system packages](./2026-08-21-signed-system-packages-design.md)
**ADR:** [ADR-0106](../../decisions/2026-08-22-managed-git-distribution-without-apt.md)

## Результат

Aisy больше не строит и не публикует APT repository, `.deb` или GPG archive
key. Пользовательский CLI устанавливается и обновляется из управляемого Git
checkout по модели Hermes: одна bootstrap-команда, locked dependencies и
`aisy update`. Привилегированные provider/voice sidecars остаются отдельными
manifest-verified bundles и доставляются оператором по SSH.

## Границы

В этот срез входят bootstrap пользовательской установки без root, атомарные
current/previous releases, `aisy update` и rollback, удаление package-signing
surface, SSH runbook для sidecar bundles и миграция production evidence.

Не входят системные prerequisites, автоматическая установка Node/Git/pnpm/flock,
автоматический restart production runtime, новый secrets backend и новый
release-signing механизм. npm может остаться дополнительным developer/release
каналом, но больше не является каноническим production install Aisy.

## Пользовательская установка

По умолчанию installer использует:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/aisy/
  repository.git/       bare Git repository, managed только Aisy
  releases/<commit>/    detached worktree + locked dependencies + build
  generations/<id>/     immutable current + optional bootstrap previous
  active -> generations/<id>
  update-state.json     bounded recovery journal без секретов

${XDG_BIN_HOME:-$HOME/.local/bin}/aisy
  launcher только в active/current/packages/app/dist/bin/aisy.js
```

Runtime state не смешивается с кодом: `AISY_HOME` и существующий `~/.aisy`
остаются без изменений. Installer отказывается работать от root, в непустом
unmanaged install root, при неожиданном origin, submodule или изменённом
managed worktree.

Bootstrap доверяет exact HTTPS repository
`https://github.com/veeskelad/aisy-agent.git` и ветке `master`, получает target
commit через Git, создаёт detached release, выполняет `pnpm install
--frozen-lockfile --config.package-import-method=copy`, workspace build и
post-upgrade doctor. Runtime closure (`dist` и root/package `node_modules`)
получает canonical inventory, проверяемый до/после doctor и при rollback. До первого
`aisy init` doctor ограничен compatibility domains `mcp,migration,sandbox`;
update и rollback проходят полный post-upgrade corpus. `packageManager` и
lockfile задают tool/dependency graph. GPG, detached signatures и независимый
от GitHub trust root намеренно отсутствуют; это принятый trade-off выбранной
Hermes-подобной схемы.
Git запускается по absolute system path только с заданным кодом минимальным
набором переменных; ambient config count/key/value, transport/object/filter/
proxy overrides и `insteadOf` не наследуются.

Публичный bootstrap entrypoint:

```bash
curl -fsSL https://raw.githubusercontent.com/veeskelad/aisy-agent/master/scripts/install.sh | bash
```

Первый запуск принимает только пустой install root. Повторный запуск над exact
managed schema эквивалентен update; непустой unmanaged root всегда получает
стабильный отказ. `AISY_INSTALL_ROOT` и `AISY_BIN_DIR` могут переопределить
только абсолютные безопасные user-owned paths. Миграция существующего checkout
выполняется рядом и не меняет его либо production unit автоматически.
Первая generation содержит current без previous. Launcher создаётся только в
отсутствующем path либо заменяет exact launcher этого же managed root; regular
file, произвольный symlink или launcher другой установки не перезаписываются.

## Обновление и откат

`aisy update` доступен только из managed install:

1. Берёт kernel-held `flock` на стабильном `update.lock` на всю operation и
   проверяет schema, paths, origin и active generation. Lock path не удаляется,
   PID и время не используются для takeover.
2. Fetch-ит только канонический `origin/master`, без пользовательского URL/ref.
   Обычный target обязан быть потомком current. History rewrite принимается
   только с явным `--allow-rewrite=<full SHA>`, совпадающим с fetched master.
3. Создаёт новый detached worktree по exact commit. Active не меняется.
4. Ставит зависимости с frozen lockfile, собирает workspace и запускает новый
   binary с `doctor --post-upgrade`.
5. После зелёных gates строит generation `{current: new, previous: old}` под
   exact `.new-g-*`, fsync-ит её, rename-ит в immutable `g-*` и fsync-ит
   `generations/`; затем одним rename заменяет symlink `active` и fsync-ит
   install root. Записывает commit и phase без путей/секретов.
6. Не перезапускает Aisy автоматически. Следующий CLI process или отдельный
   operator-controlled restart использует новый current.

Сбой до единственного переключения оставляет active неизменным. `PREPARED`
никогда не является authority: recovery только очищает его либо заново проводит
verification. После переключения active generation является source of truth.
Journal write, generation directory и active rename имеют явный fsync ordering;
crash после любой durable операции оставляет одну согласованную пару.
`aisy update --rollback` не делает network fetch: проверяет previous, создаёт
новую generation `{current: old, previous: new}` и тем же одним rename меняет
active. Release очищается только когда на него не ссылается active generation.
Перед каждым update/rollback updater удаляет прежние unreferenced generations,
worktrees и их integrity records; retention ограничен current/previous и одним
только что вытесненным release до следующей operation.
Следующий operation удаляет interrupted `.new-g-*`; inactive generation сначала
переименовывается в `.gc-*`. Cleanup восстанавливает Git worktree registry через
`worktree prune`, дочищает exact missing/partial registered worktree, exact
integrity temporary files и orphan integrity records. Exact interrupted
`locked initializing` с matching path и exact/нулевым HEAD удаляется
double-force; иное locked состояние отказано. Retained previous при authorized
rewrite только перепроверяется, но никогда не build-ится in-place.

## Root-owned sidecars по SSH

Provider и voice release builders сохраняются. Они собирают exact bundle и
печатают SHA-256 canonical `manifest.json`; component installer повторно
проверяет commit, manifest, каждый file hash/mode/size, выполняет self-check и
сохраняет current/previous rollback.

Новый trust root — не пользовательский checkout и не self-signature bundle.
Им является привилегированный SSH receiver channel: оператор проверяет exact
host key, а host допускает только заранее закреплённый operator public key и
разрешённый receiver command.

1. На доверенной operator machine два clean builds exact commit должны дать
   одинаковые manifest/file digests.
2. В authenticated privileged session root-owned receiver создаёт одноразовый
   unpredictable deployment id и `O_EXCL` inbox, сразу принадлежащий root.
3. Bundle, receipt и отдельно переданный expected receipt digest записываются
   receiver-ом прямо в этот inbox. User-owned drop рядом с receipt запрещён.
   Receipt не содержит hostname, username или секреты.
4. Receiver seal-ит inbox, записывает deployment id + digest в root-owned
   replay ledger и отклоняет повтор, concurrent writer или любую последующую
   mutation bundle/receipt.
5. На первом provisioning host-owned verifier заранее устанавливает одноразовая
   image/cloud-init/config-management authority; digest verifier закреплён в
   host config, а staging/stdin не исполняются. После provisioning
   root-owned helper сверяет expected digest, receipt и bundle до component
   installer, принимает bounded `--runtime-user`, `--runtime-unit`,
   `--aisy-home` и provider list, затем сам выводит uid/gid и live binding из
   NSS + user systemd + `/proc` и вызывает installer через
   `/usr/bin/python3.12 -I`.
6. Explicit install, rollback и uninstall сохраняют существующие fail-closed
   lifecycle и encrypted-state правила. Передача сама по себе inert.

Двусторонняя SSH-аутентификация защищает transport bytes и authority оператора;
expected digest связывает exact release с root activation, а одноразовый inbox
закрывает локальную подмену и replay. Эта схема не заявляет независимую
криптографическую подпись publisher-а и не разрешает скачивать bundle из
произвольного URL прямо под root.

Global root-owned `flock` сериализует begin/completion. Открыты максимум восемь
inbox по 32 MiB; receiving/sealed старше 24 часов и claimed с мёртвым PID старше
часа очищаются, а completed ledger ограничен 256 replay tombstones. Same-UID
процесс считается той же authority; заявленная граница — lower-authority path
substitution, transport/release drift и concurrency, а не malicious same-UID.
Bundle claim связывается с boot/process-start identity, поэтому PID reuse не
выдаёт authority новому процессу. Managed operation lock независимо удерживает
ядро через `flock`. После activation housekeeping идёт через durable
`completing`; его сбой не превращает совершённый effect в повод повторить
install.

## Миграция production

Миграция выполняется без остановки текущего fr1 runtime:

1. Подготовить managed install рядом с текущим checkout и пройти doctor.
2. Сохранить старый `ExecStart` и проверить новый launcher вручную.
3. Одной отдельной операцией изменить user unit, daemon-reload и restart.
4. Проверить Telegram, provider/voice readiness и restart recovery.
5. При ошибке вернуть старый `ExecStart`; managed previous не удалять.

Package artifacts удаляются из Git до rollout и не публикуются. Уже
существующие активные root releases не удаляются миграцией: меняется только
будущий delivery path.

## Проверка

- unit corpus для install layout, path/origin/ref validation, frozen install,
  atomic switch, rollback и crash phases;
- adversarial tests на symlink/path escape, dirty worktree, concurrent update,
  failed install/build/doctor и malformed journal;
- Python corpus для SSH receipt/root staging/runtime binding и обоих component
  installers;
- assertion, что tracked production surface не содержит APT, `.deb`, GPG key
  или archive signing scripts;
- workspace typecheck/build/tests, sidecar pytest/ruff, `git diff --check`,
  secret scan и private-reference scan;
- disposable-host rehearsal и controlled fr1 rollout с rollback point.
