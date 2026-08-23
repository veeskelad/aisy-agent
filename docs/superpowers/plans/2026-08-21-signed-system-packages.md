# План реализации подписанных системных пакетов

> **Исторический план.** Заменён [ADR-0106](../../decisions/2026-08-22-managed-git-distribution-without-apt.md)
> и [компонентом 28](../../specs/28-managed-git-distribution-without-apt.md);
> не является действующим планом или runbook.

> Связан с [ADR-0105](../../decisions/2026-08-21-signed-system-packages.md),
> [компонентом 27](../../specs/27-signed-system-packages.md) и
> [утверждённым дизайном](../specs/2026-08-21-signed-system-packages-design.md).

**Цель:** доставить provider/voice root trust root через подписанный статический
APT-репозиторий, доказать inert package install, explicit activation,
restart/rollback/uninstall и развернуть merged release на целевом production-хосте.

## Инварианты исполнения

- Работа только в isolated worktree `codex/apt-package` от актуального master.
- Private archive key никогда не попадает в repository, build args/output,
  production host или тестовые fixtures; тесты используют ephemeral keys.
- `apt install/remove` не вызывает systemd, не создаёт users/state/credentials.
- Root helper не import/exec user-owned code ни при каких аргументах.
- Exact список файлов staging/commit; никаких несвязанных refactor.
- Каждый AC-27 получает прямое evidence, а не косвенный green test.

## Task 1. Root-owned package verifier и runtime binding

**Файлы:**

- создать `packages/sidecars-py/aisy_sidecars/system_package_install.py`;
- создать `packages/sidecars-py/tests/test_system_package_install.py`;
- при необходимости добавить тонкие package entrypoints в `packages/sidecars-py/`.

**Шаги:**

1. Сначала тесты canonical descriptor: exact keys, duplicate/unknown, bounds,
   component/architecture/version/source grammar.
2. Реализовать descriptor-relative `O_NOFOLLOW` read с root ownership,
   ancestor/device/nlink/mutation checks и стабильными redacted отказами.
3. Добавить injectable NSS/systemd/proc ports; тесты inactive unit, PID reuse,
   foreign uid, cgroup drift, unsafe FragmentPath и home.
4. Реализовать domain-separated installation hash с byte parity production TS.
5. Добавить `status/install/rollback/uninstall` dispatch, который вызывает только
   exact `/usr/bin/python3.12 -I <verified root-owned entrypoint>` и передаёт
   derived binding + descriptor digest/commit.
6. Проверить `pytest` и `ruff` для новых файлов.

**Закрывает:** AC-27-3..6.

## Task 2. Симметричный provider uninstall

**Файлы:**

- изменить `packages/sidecars-py/aisy_sidecars/provider_proxy_install.py`;
- изменить `packages/sidecars-py/tests/test_provider_proxy_install.py`.

**Шаги:**

1. Зафиксировать тестами refusal без explicit preservation/lifecycle verdict.
2. Реализовать stop/disable units, worker fencing и root-owned safe removal;
   ambiguous encrypted state не удалять автоматически.
3. Crash/partial cleanup оставляет fail-closed observable state; повторная
   операция идемпотентно завершает cleanup.
4. Перепроверить существующие 18 installer tests и новый uninstall corpus.

**Закрывает:** AC-27-9 и gap спецификации 26.

## Task 3. Детерминированные Debian packages

**Файлы:**

- создать `scripts/build-system-packages.py`;
- создать `packages/sidecars-py/tests/test_system_package_builder.py`;
- при необходимости создать versioned package templates под `packaging/debian/`.

**Шаги:**

1. Builder требует clean exact commit, package version, architecture,
   `SOURCE_DATE_EPOCH`, public keyring/fingerprint и готовые component bundles.
2. Сформировать четыре package roots/control metadata без maintainer scripts.
3. Нормализовать paths, owner/group/mode/mtime/order; запретить symlink,
   hardlink, unknown member и size escape.
4. Запустить `dpkg-deb --root-owner-group` через exact tool path и isolated env.
5. Собрать два раза и сравнить exact SHA-256; mismatch удаляет output и fail closed.
6. Тестами распаковать control/data и доказать exact contents и inert metadata.

**Закрывает:** AC-27-1, AC-27-2, AC-27-8.

## Task 4. Статический APT repository и подпись

**Файлы:**

- создать `scripts/build-apt-repository.py`;
- создать `scripts/sign-apt-release.sh`;
- создать `packages/sidecars-py/tests/test_apt_repository_builder.py`;
- создать `docs/guides/signed-system-packages.md`.

**Шаги:**

1. Builder создаёт canonical `pool/main`, `Packages(.gz)`, `Release` с bounded
   `Valid-Until` для `all/amd64/arm64` через exact `apt-ftparchive`.
2. Signing script принимает только public fingerprint/key id; private key
   остаётся внутри GPG home/agent, stdin/env/output не используются.
3. Создать `InRelease` и detached `Release.gpg`, затем проверить обе подписи
   against exported public keyring до публикации.
4. Negative corpus: unsigned, wrong key, tampered package/index, stale Release,
   wrong suite/component/architecture.
5. Guide описывает initial two-source fingerprint verification, deb822
   `Signed-By`, manual publish/rollback и key rotation overlap.

**Закрывает:** AC-27-10, AC-27-11.

## Task 5. Disposable Ubuntu 24.04 E2E

**Среда:** disposable systemd 255 Ubuntu 24.04 `amd64`; `arm64` package
проверяется существующим native builder evidence либо отдельной disposable VM.

**Шаги:**

1. Из clean commit собрать provider/voice bundles, включая native voice bridge.
2. Дважды собрать `.deb`, сравнить bytes, сформировать repository и подписать
   ephemeral test archive key.
3. Поднять fresh APT root/VM, добавить только scoped keyring/source, выполнить
   install/upgrade/remove/reinstall и snapshot всех system/runtime roots.
4. Доказать нулевую mutation до explicit activation.
5. Активировать release A, затем B; инъецировать failed B, проверить automatic
   rollback, explicit rollback, restart и read-only status.
6. Выполнить voice/provider uninstall без real vendor credential и доказать
   остановку authority/units.

**Закрывает:** AC-27-7, AC-27-12.

## Task 6. Release gates и независимый review

1. Перечитать каждый изменённый файл; для трёх и более файлов выполнить второй
   independent review-pass против ADR/spec/AC matrix.
2. Запустить targeted Python tests, весь sidecars pytest/ruff.
3. Запустить Core/App/Telegram tests, workspace typecheck/build.
4. Запустить `git diff --check`, conflict marker scan, tracked sensitive-data
   scan и private-reference scan без чтения private values/materials.
5. Обновить секцию evidence спецификации 27 только public/redacted фактами.
6. Commit exact files, push, PR, проверить mergeability/checks; при сломанных
   Actions использовать доказанный local corpus, затем merge по разрешению.

**Закрывает:** AC-27-14 и project release gate.

## Task 7. Production publish и deploy

1. Создать dedicated archive key на операторской машине, экспортировать только
   public key/fingerprint в tracked artifacts; проверить отсутствие private key.
2. После merge заново собрать packages из exact merged master и подтвердить
   reproducibility/digests.
3. Подписать repository snapshot, проверить локально, опубликовать новым commit
   в `gh-pages` без force-push.
4. На production host сохранить rollback ref, установить pinned key/source и
   packages; до activation сравнить system/runtime snapshots.
5. Активировать provider/voice без real credential, выполнить doctor, Aisy
   restart и rollback rehearsal; затем вернуть desired release.
6. Реальный credential enrollment/vendor call не выполнять без отдельного
   privacy action оператора. Обновить production matrix фактическим LIVE/dormant
   verdict.

**Закрывает:** AC-27-13 и исходную production goal.
