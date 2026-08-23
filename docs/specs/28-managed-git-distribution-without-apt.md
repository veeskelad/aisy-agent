# Компонент 28: доставка без APT

**Статус:** реализован, смержен и принят на disposable Linux; публичный
bootstrap и controlled production cutover проходят отдельный release gate
**ADR:** [ADR-0106](../decisions/2026-08-22-managed-git-distribution-without-apt.md)
**Design:** [managed Git distribution](../superpowers/specs/2026-08-22-managed-git-distribution-without-apt-design.md)
**Заменяет:** [компонент 27](./27-signed-system-packages.md)

## 1. Назначение

Компонент владеет production install/update/rollback пользовательского Aisy из
managed Git и операторской доставкой privileged sidecar bundles по SSH. Он не
устанавливает системные prerequisites и не управляет runtime state.

## 2. Managed install

Default install root — `${XDG_DATA_HOME:-$HOME/.local/share}/aisy`, launcher —
`${XDG_BIN_HOME:-$HOME/.local/bin}/aisy`. Root содержит только managed bare
repository, detached release worktrees, immutable generation directories,
один atomic `active` link, exclusive lock и bounded canonical JSON journal.
Каждая generation содержит exact `current`; `previous` отсутствует только у
первой bootstrap generation и обязателен после первого update. `AISY_HOME`/`~/.aisy` не
создаётся, не читается и не меняется updater-ом, кроме read-only doctor нового
binary.

Bootstrap и update принимают только canonical origin
`https://github.com/veeskelad/aisy-agent.git`, branch `master` и commit,
полученный из fetched remote ref. Произвольные URL/ref, submodules, LFS pointer,
symlinked root/ancestor, чужой owner, group/world-writable managed paths и
запуск с effective uid 0 запрещены. Обычный update принимает только commit,
являющийся потомком current. Non-fast-forward rewrite master требует exact
`--allow-rewrite=<full SHA>`, который обязан совпасть с fetched remote head;
иначе возвращается `UPDATE_HISTORY_REFUSED`.
Все Git subprocess используют absolute executable и только заданный кодом
минимальный набор переменных: ambient `GIT_CONFIG_*`, transport/object/filter/
proxy overrides и `url.*.insteadOf` не получают authority над
clone/fetch/verification.
Если authorized rewrite exact совпадает с retained `previous`, updater не
пересобирает его in-place: повторно проверяет сохранённый integrity + doctor и
публикует обратную пару. Install/update/rollback/cleanup на Linux удерживают
kernel `flock` на одном стабильном `update.lock` в течение всей operation.
Lock path не удаляется при unlock, а PID, возраст файла и stale-unlink не дают
authority и не участвуют в recovery.

Каждый release создаётся до cutover и обязан пройти:

1. detached checkout exact full commit;
2. declared Node/pnpm compatibility;
3. `pnpm install --frozen-lockfile` без lockfile mutation;
4. workspace build;
5. новый binary `doctor --post-upgrade`. Для ещё не инициализированного
   bootstrap разрешён compatibility subset `mcp,migration,sandbox`, потому что
   env/memory создаёт последующий `aisy init`; update/rollback существующей
   установки обязаны пройти полный post-upgrade corpus.

Install принудительно materialize-ит зависимости с `package-import-method=copy`.
После build сохраняется canonical SHA-256 inventory workspace `dist`, root и
package-local `node_modules`, включая symlink graph. Inventory сверяется до и
после doctor и перед offline rollback; ignored runtime mutation отказана.
Любой Git blob с LFS pointer header запрещён до checkout.

Launcher содержит только canonical absolute переход к active/current binary, не
интерпретирует arguments и не читает shell profile.

Bootstrap entrypoint — `scripts/install.sh` из canonical raw HTTPS URL. Empty
root создаёт managed install; повтор над exact managed schema запускает тот же
update flow; непустой unmanaged root получает `UPDATE_NOT_MANAGED`. Параметры
`AISY_INSTALL_ROOT` и `AISY_BIN_DIR` принимают только canonical absolute
user-owned paths. Existing source checkout мигрируется только в соседний root и
не меняет unit/ExecStart автоматически.

Launcher создаётся atomic replace только если path отсутствует либо является
exact managed launcher этого install root. Regular file, произвольный symlink и
launcher другой managed установки получают `UPDATE_LAUNCHER_REFUSED` без
изменения path.

## 3. Update state machine

```text
IDLE -> FETCHED -> PREPARED -> VERIFIED -> SWITCHED -> IDLE
                   |            |
                   +-- failure --+--> active unchanged

active -> generation-1 {current=A, previous=P}
VERIFIED(B): generation-2 {current=B, previous=A}
rollback:    generation-3 {current=A, previous=B}
```

Один kernel-held exclusive `flock` на стабильном inode сериализует
install/update/rollback/cleanup и освобождается только закрытием descriptor.
Journal имеет schema version, operation, phase, old/new commit и не содержит
argv, env, hostname, usernames, paths или command output.
Unknown/future/non-canonical journal fail closed. Recovery никогда не выбирает
commit, которого нет в repository. `PREPARED` никогда не публикуется: recovery
может только очистить его либо повторить полную verification.

Новая immutable generation полностью строится под exact `.new-g-*`, fsync-ится,
atomic rename-ится в `g-*`, после чего `generations/` fsync-ится до cutover.
Затем temporary active symlink создаётся в install root, одним rename заменяет
`active`, после чего install root fsync-ится. Это одна атомарная публикация
согласованной пары. Journal очищается atomic write/rename только после durable
active. Updater не посылает signal, не вызывает systemctl и не перезапускает
Aisy.

`aisy update --rollback` не fetch-ит network и после read-only doctor previous
публикует новую immutable generation с обратной парой. Cleanup сохраняет оба
target active generation и очищает только unreferenced managed worktree. Перед
каждым обычным update/rollback та же очистка выполняется автоматически: в steady
state остаются current/previous, а между публикацией и следующим operation
допускается не более одного вытесненного release и одной старой generation.
Integrity record удаляется только вместе с соответствующим verified worktree.
Interrupted `.new-g-*`, inactive generation после atomic rename в `.gc-*` и
exact integrity temporary files дочищаются следующим operation. Перед release
GC Git registry проходит `worktree prune`; exact registered unreferenced
worktree удаляется с восстановлением после missing/partial path. Exact
`locked initializing` residue с matching path и exact/нулевым незавершённым
HEAD удаляется через double-force; иное locked состояние fail closed. Затем
удаляются orphan integrity records. LFS/submodule scan использует один tree
inventory и один bounded `cat-file --batch`, а не процесс на каждый blob.

## 4. SSH sidecar delivery

Поддерживаются `provider` и `voice`. Release receipt — canonical JSON с exact
keys `schemaVersion, component, commit, release, manifestSha256, files`;
`files` связывает каждый regular member с size, mode и SHA-256. Receipt и
manifest не содержат host, user, path или secrets.

Bundle строится дважды из clean exact commit; receipt/digests должны совпасть.
Operator передаёт bundle только через SSH: client проверяет exact host key, а
server принимает заранее закреплённый operator public key и bounded privileged
receiver command. Receiver создаёт unpredictable deployment id и root-owned
`O_EXCL` inbox, принимает отдельно expected receipt digest, bundle и receipt,
затем seal-ит их и записывает deployment id/digest в replay ledger. User-owned
drop рядом с receipt запрещён. Неверный key, reused id, concurrent writer,
post-upload mutation и подмена bundle+receipt fail closed до execution.
Receipt ограничен 32 MiB суммарно; global root-owned lock сериализует `begin` и
completion, а одновременно открыто не более восьми inbox. Receiving/sealed
inbox старше 24 часов и claimed inbox с мёртвым owner старше часа удаляются
перед новым `begin`. Claim содержит boot/process-start identity, а не только
PID. После успешной activation ledger проходит crash-convergent
`claimed → completing → completed`, inbox удаляется; сохраняются не более 256
последних compact completed replay tombstones. Housekeeping failure после уже
совершённой activation не меняет success на retryable install failure: остаток
дочищает следующий `begin`.

На первом host provisioning минимальный receiver устанавливается через
одноразовую administrative authority (golden image, cloud-init или configuration
management). Она заранее ставит host-owned verifier с закреплённым digest;
verifier не исполняется из проверяемого staging tree, stdin, runtime checkout,
home, `/tmp`, NVM или venv. После установки постоянного forced-command receiver
одноразовая authority отзывается. Staging находится на одном filesystem.
Неизвестный member, symlink, hardlink, device/mount escape, writable ancestor,
owner/mode/size/hash/commit drift и concurrent mutation fail closed.

Модель угроз не считает другой процесс с тем же effective UID более низкой
authority: такой процесс уже может менять managed binary и его integrity record.
Проверки owner/mode/symlink/device и повторная binding verification защищают от
lower-authority path substitution и случайного drift, но не заявляют изоляцию
от malicious same-UID процесса.

Root helper принимает bounded operator selectors `--runtime-user`,
`--runtime-unit`, `--aisy-home` и provider list. Затем он сам получает uid/gid
из NSS, exact active user-systemd unit и PID/cgroup из `/proc`, проверяет custom
home ownership, account-home mismatch и unit substitution, перепроверяет binding
до component call и запускает только `/usr/bin/python3.12 -I`.
Install/rollback/uninstall используют существующие component installers и
current/previous; transfer и status inert.
Provider list canonical и bounded. Credential, auth header, arbitrary URL,
secret path или plaintext не принимаются через argv/env/receipt.

## 5. Исключённая поверхность

В поддерживаемом tree отсутствуют package-manager repository, system package
builders/tests, archive keyring/fingerprint artifacts, signing scripts, package
descriptor/stage activation helpers и действующие инструкции прежнего канала.

ADR-0105, спецификация 27 и historical review evidence сохраняются с явным
статусом superseded и не считаются live runbook.

## 6. Стабильные отказы

- `UPDATE_NOT_MANAGED` — launcher/install metadata не принадлежат managed Aisy;
- `UPDATE_SOURCE_REFUSED` — origin/ref/commit/worktree/path/owner drift;
- `UPDATE_HISTORY_REFUSED` — downgrade/rewrite без exact explicit authority;
- `UPDATE_LAUNCHER_REFUSED` — launcher path уже принадлежит другому owner/root;
- `UPDATE_BUSY` — lock уже удерживается;
- `UPDATE_BUILD_FAILED` — frozen install/build не прошёл, active неизменен;
- `UPDATE_DOCTOR_FAILED` — новый/previous release не прошёл doctor;
- `UPDATE_STATE_REFUSED` — journal/current/previous malformed или расходятся;
- `BUNDLE_AUTHORITY_REFUSED` — SSH key/deployment id/replay authority;
- `BUNDLE_SOURCE_REFUSED` — root inbox/receipt/filesystem invariant;
- `BUNDLE_RELEASE_REFUSED` — component/commit/release/digest mismatch;
- `RUNTIME_BINDING_REFUSED` — NSS/systemd/PID/cgroup/home drift;
- существующие component refusal codes после передачи authority.

Диагностика не содержит absolute home/staging paths, uid/pid/cgroup, hashes,
remote output, environment, credential state или vendor detail.

## 7. Acceptance criteria

1. **AC-28-1** — Bootstrap non-root exact origin/master создаёт initial
   generation с current и без previous, active launcher и не меняет `AISY_HOME`;
   SIGKILL после каждой durable bootstrap operation восстанавливает valid empty
   или initial state. Повтор идемпотентен; непустой unmanaged root, regular
   launcher, arbitrary symlink и launcher другого managed root отказаны.
2. **AC-28-2** — Root, unexpected origin/ref, submodule, dirty managed worktree,
   symlink/path escape, writable ownership chain и ambient Git config/transport
   override отказаны до fetch/build; non-descendant master требует exact
   matching full-SHA override.
3. **AC-28-3** — Dependency step использует frozen lockfile и pinned package
   manager; lockfile mutation, install/build failure оставляют current exact A.
4. **AC-28-4** — Update A→B проходит build и staged post-upgrade doctor до одной
   замены active generation, затем пара равна current=B/previous=A; runtime
   restart/systemctl calls=0.
5. **AC-28-5** — Failed doctor B и SIGKILL после каждой journal write,
   generation fsync, active rename и directory fsync оставляют одну verified
   согласованную пару; PREPARED не публикуется, malformed/future journal закрыт.
6. **AC-28-6** — Offline rollback после A→B публикует одной заменой пару
   current=A/previous=B без fetch и отказывается, если previous отсутствует,
   изменён или не проходит doctor.
7. **AC-28-7** — Concurrent update получает `UPDATE_BUSY`; cleanup не затрагивает
   current/previous и очищает только exact unreferenced managed worktree.
8. **AC-28-8** — Два clean builds provider/voice exact commit дают одинаковые
   canonical receipts, manifest digests и file inventory.
9. **AC-28-9** — Privileged SSH receiver принимает только pinned operator key,
   новый deployment id и external expected digest в root-owned `O_EXCL` inbox;
   неверный key, replay, concurrent writer, подмена bundle+receipt после upload,
   symlink/hardlink/unknown member и TOCTOU отказаны до component execution.
10. **AC-28-10** — Root helper принимает только bounded runtime selectors и
    выводит binding из NSS + live user-systemd + `/proc`; custom home,
    account-home mismatch, unit substitution, inactive/foreign/PID-reuse/cgroup
    drift fail closed, secrets через argv/env/receipt не принимаются.
11. **AC-28-11** — Install A→B, failed B, rollback и explicit uninstall обоих
    sidecars сохраняют existing readiness/previous/encrypted-state semantics;
    transfer/status сами не меняют LIVE.
12. **AC-28-12** — Tracked production surface не содержит прежний system
    package repository, `.deb`, GPG archive key, signing/build/publish code или
    действующий старый runbook.
13. **AC-28-13** — Disposable Linux rehearsal доказывает managed install,
    update, offline rollback, SSH provider/voice install, restart и rollback.
14. **AC-28-14** — Controlled production cutover сохраняет старый ExecStart,
    подтверждает doctor/Telegram/provider/voice/restart и допускает возврат без
    изменения state или старых root releases.
15. **AC-28-15** — Targeted tests, package/workspace tests, typecheck/build,
    Python pytest/ruff, `git diff --check`, secret scan и private-reference scan
    зелёные либо baseline-отказы явно доказаны до diff.

## 8. Открытые вопросы

Независимая publisher signature, release tags/channels и автоматический service
restart отложены. Их добавление требует отдельного ADR и не должно возвращать
APT без нового решения оператора.
