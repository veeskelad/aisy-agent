# ADR-0106: Managed Git и SSH-bundles вместо APT

**Статус:** Принято
**Дата:** 2026-08-22
**Теги:** packaging, supply-chain, git, ssh

**Заменяет:** [ADR-0105](./2026-08-21-signed-system-packages.md); частично [ADR-0056](./2026-06-24-npm-package-distribution.md)

## Контекст

ADR-0105 выбрал подписанный APT repository как первый root trust root для
provider/voice sidecars. Его production publication потребовала отдельного GPG
archive key и операторского процесса подписи. Оператор отказался от APT, `.deb`
и GPG delivery и выбрал пользовательский workflow, похожий на Hermes.

Aisy при этом должна сохранить две разные границы: пользовательский CLI не
нуждается в root, а provider/voice installers меняют root-owned systemd runtime
и не могут исполняться из пользовательского checkout.

## Решение

Канонический production install пользовательского Aisy — managed Git checkout
из exact HTTPS repository и ветки `master`, locked pnpm dependencies и команда
`aisy update` с одним атомарным `active` указателем на immutable generation
`{current, previous}`. Normal update допускает только descendant current;
rewrite master требует explicit exact full-SHA authority. Installer и updater
никогда не используют root и не изменяют runtime state.

Privileged provider/voice components доставляются как существующие
manifest-verified bundles через двусторонне аутентифицированный privileged SSH
receiver channel: client закрепляет host key, server — operator public key.
Receiver создаёт одноразовый root-owned inbox и связывает external expected
digest с deployment id до записи bundle. Затем helper проверяет receipt,
manifest, exact commit, files и live runtime binding и только после этого
вызывает component installer. Transfer не активирует service.

Первичное создание этой границы выполняет отдельная одноразовая administrative
authority — golden image, cloud-init или configuration management. Она заранее
ставит root-owned verifier с закреплённым SHA-256; staging и stdin не являются
исполняемым verifier. После установки постоянного forced-command receiver
одноразовая authority обязательно отзывается.

Retention является частью протокола: managed update автоматически ограничивает
поколения current/previous плюс одним вытесненным release, bundle delivery —
восемью открытыми inbox по 32 MiB и 256 compact replay tombstones. Same-UID
процесс считается той же authority; отдельная sandbox-граница от него здесь не
заявляется.
Cleanup является crash-convergent: managed generation публикуется через
`.new-* → rename → fsync`, удаляется через `.gc-*`, а bundle ledger использует
durable `completing → completed`. Managed operation сериализуется kernel-held
`flock` на стабильном inode без PID-файла и stale-unlink; bundle claim связывает
PID с boot/process-start identity. Уже завершённая privileged activation не
переобъявляется failure только из-за отложенной очистки inbox.

APT repository, `.deb`, archive keyring, GPG signing и package descriptor layer
исключаются из поддерживаемой production surface. Существующие активные root
releases сохраняются и продолжают использовать прежние atomic lifecycle и
rollback semantics.

## Последствия

- **Положительное:** пользователь получает одну команду обновления без
  системного package manager и отдельного signing key.
- **Положительное:** build происходит до одной атомарной замены active
  generation; current и previous дают локальный rollback без download.
- **Положительное:** root не исполняет checkout или user-owned staging;
  pinned client/server keys, one-shot inbox и expected digest задают operator
  trust boundary.
- **Нейтральное:** GitHub HTTPS, одноразовая provisioning authority и operator
  SSH credentials становятся trust roots. Manifest digest доказывает exact
  bytes, но не является независимой publisher signature.
- **Нейтральное:** npm остаётся дополнительным каналом, но ADR-0056 больше не
  задаёт канонический production install.
- **Отрицательное:** Aisy не получает независимую offline подпись release и
  стандартный package-manager inventory/upgrade.
- **Отрицательное:** prerequisites и root sidecar transfer остаются
  операторскими обязанностями; отзыв provisioning authority является отдельным
  обязательным gate.

## Рассмотренные альтернативы

Подписанный системный repository даёт стандартную authenticated chain, но
противоречит требованию «без APT» и возвращает GPG key lifecycle.

Standalone signed archives исключают package manager, но сохраняют отдельный
signing secret и его ротацию.

Исполнение installer из Git checkout с повышенными правами проще, но
пользовательская запись в checkout превращается в локальное повышение
привилегий и нарушает root boundary.

Только доставка через npm registry не покрывает точный source rollback и
root-owned Python/systemd sidecars; этот путь зависит от отдельного publish.

## Ссылки

- [Design: доставка без APT](../superpowers/specs/2026-08-22-managed-git-distribution-without-apt-design.md)
- [Спецификация 28](../specs/28-managed-git-distribution-without-apt.md)
- [ADR-0098 — secure voice credential proxy](./2026-08-13-systemd-encrypted-voice-credential-proxy.md)
- [ADR-0099 — systemd provider broker](./2026-08-14-systemd-provider-broker.md)
