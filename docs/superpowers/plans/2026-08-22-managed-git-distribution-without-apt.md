# План реализации доставки Aisy без APT

**Связано:** [ADR-0106](../../decisions/2026-08-22-managed-git-distribution-without-apt.md),
[компонент 28](../../specs/28-managed-git-distribution-without-apt.md),
[design](../specs/2026-08-22-managed-git-distribution-without-apt-design.md).

## 1. Managed Git state machine

- Добавить App-модуль с injectable Git/build/doctor ports, строгим parser-ом
  managed layout/journal и стабильными refusal codes.
- Реализовать bootstrap generation, descendant-only update, explicit
  full-SHA rewrite authority, single-active generation switch и offline
  rollback.
- Покрыть path/owner/symlink/launcher collision, lock, malformed journal,
  failed build/doctor и fault points до/после каждой durable операции.

## 2. CLI и bootstrap

- Подключить `aisy update`, `aisy update --rollback` и exact rewrite option до
  runtime composition.
- Переделать `scripts/install.sh` в non-root one-liner bootstrap exact HTTPS
  origin/master с frozen pnpm и managed launcher.
- Проверить first install, idempotent reinstall и adjacent migration без
  изменения `AISY_HOME`/service.

## 3. Privileged SSH bundles

- Ввести canonical release receipt и deterministic archive для существующих
  provider/voice builders.
- Добавить root-only receiver: pinned forced-command contract, one-shot
  deployment id, `O_EXCL` inbox, external digest, replay ledger и seal.
- Первичный verifier заранее ставить host-owned через одноразовую
  image/cloud-init/config-management authority; staging/stdin до verification
  не исполнять, authority после provisioning отзывать.
- Перенести runtime binding в bundle helper с bounded operator selectors;
  сохранить existing install/rollback/uninstall lifecycle.
- Покрыть wrong authority, replay, bundle+receipt substitution, traversal,
  symlink/hardlink, mutation и binding drift.

## 4. Удаление старого канала

- Удалить APT repository/signing, `.deb` builders, keyring и package descriptor
  activation layer вместе с их точечными тестами/launchers.
- Сохранить component installers и provider uninstall, не затрагивать активные
  root releases или runtime state.
- Обновить README, quick start, deployment guide, reviews и absence gate.

## 5. Verification и доставка

- Targeted App/Python tests, package tests, workspace typecheck/build/tests,
  pytest/ruff, `git diff --check`, secret/private-reference scans.
- Disposable managed update/rollback и Linux SSH bundle rehearsal.
- Commit/push в PR #18, independent code review, merge, controlled production
  cutover с сохранённым старым ExecStart и rollback evidence.
