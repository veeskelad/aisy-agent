# Дизайн подписанных системных пакетов Aisy

**Дата:** 2026-08-21  
**Статус:** исторический; заменён [ADR-0106](../../decisions/2026-08-22-managed-git-distribution-without-apt.md)

> Не является действующим дизайном или release channel. Актуальная схема
> описана в [дизайне без APT](./2026-08-22-managed-git-distribution-without-apt-design.md).

## 1. Результат и границы

Нужно закрыть первый production install для root-owned provider broker и voice
proxy, не исполняя код из пользовательского checkout. Решение должно подходить
текущему и новым поддерживаемым Linux-хостам.

Первый release поддерживает Ubuntu 24.04 LTS с systemd 255 и Python 3.12:
`amd64` и `arm64`. npm остаётся способом доставки пользовательского CLI;
системные пакеты отвечают только за root trust root и privileged sidecars.

Не входят в этот срез:

- автоматическое создание systemd host key;
- ввод или перенос реальных credentials;
- автоматическая активация, restart или удаление runtime из maintainer scripts;
- публичная CI/CD-подпись: пока GitHub Actions не работает, release выполняется
  вручную из чистого commit.

## 2. Выбранная архитектура

Статический APT-репозиторий публикуется из ветки `gh-pages`. Его `InRelease`
подписывает отдельный archive key Aisy. Закрытая часть ключа существует только
на операторской машине; в Git и на production-хосты попадает только публичный
keyring и его полный fingerprint. APT source использует отдельный `Signed-By`,
поэтому ключ не получает authority над другими репозиториями.

Пакетное семейство состоит из четырёх пакетов:

1. `aisy-archive-keyring` (`Architecture: all`) — только публичные archive
   keys и fingerprint metadata; первый key ставится вручную после out-of-band
   проверки fingerprint, последующие keys доставляются через уже доверенную
   APT-цепочку до переключения подписи.
2. `aisy-bootstrap` (`Architecture: all`) — root-owned launchers и минимальная
   стандартно-библиотечная Python closure, которая проверяет package descriptor,
   source tree и runtime binding, затем вызывает component installer.
3. `aisy-provider-release` (`Architecture: all`) — inert root-owned staging
   bundle provider broker и descriptor с exact commit/manifest digest.
4. `aisy-voice-release` (`Architecture: amd64|arm64`) — inert root-owned staging
   bundle voice proxy, включая native bridge, и такой же descriptor.

`apt install` только распаковывает эти файлы. У пакетов нет activation postinst,
они не создают service users, state, units, host key или credentials и не
запускают `systemctl`.

## 3. Trust chain и данные

Цепочка доверия:

```text
operator-pinned archive fingerprint
  -> signed InRelease
  -> SHA-256 Packages index
  -> SHA-256 .deb
  -> root-owned package descriptor
  -> external manifest digest + exact Git commit
  -> descriptor-relative bundle verification
  -> root-owned component installer
  -> current/previous runtime release
```

Package descriptor — canonical JSON с закрытым набором полей:

```json
{
  "schemaVersion": 1,
  "component": "provider|voice",
  "packageVersion": "...",
  "architecture": "all|amd64|arm64",
  "release": "...",
  "commit": "40-64 lowercase hex",
  "manifestSha256": "64 lowercase hex",
  "source": "/usr/lib/aisy/package-stage/<component>/<package-version>"
}
```

Descriptor и source обязаны быть обычными root-owned файлами/каталогами без
group/world write и без symlink в canonical root. Helper открывает их
descriptor-relative с `O_NOFOLLOW`, запрещает mount-device escape и проверяет
стабильность inode/size/mtime/ctime. Затем существующий component installer
повторно проверяет manifest и каждый файл из того же fd до публикации.

## 4. Activation, update и rollback

Оператор запускает один из root-owned helpers:

```text
/usr/libexec/aisy-provider-install install ...runtime binding...
/usr/libexec/aisy-voice-install install ...runtime binding...
```

Helper принимает только `runtime-user`, `runtime-unit`, `aisy-home` и
provider-specific selection. UID/GID он получает из системной учётной записи,
а MainPID/ControlGroup — из user systemd manager. `installationHash` вычисляется
тем же доменно-разделённым алгоритмом, что production composition. Missing,
inactive, ambiguous или несовпадающий binding завершает операцию до mutation.

Package upgrade заменяет только inert staging source. Уже активированный
runtime живёт в существующих `/usr/lib/aisy/{provider-broker,voice-proxy}` и не
принадлежит `dpkg`; поэтому обновление package не удаляет `current` или
`previous`. Новая версия становится LIVE только после explicit install и
handshake. Ошибка автоматически возвращает предыдущий совместимый release.

`apt remove aisy-*-release` удаляет только staging bundle и не выдаётся за
runtime uninstall. Runtime uninstall — отдельная helper operation. Voice
сначала требует revoke либо явный `--preserve-encrypted-credential`; provider
получает эквивалентный explicit lifecycle и никогда не оставляет включённые
units после успешного uninstall. Удаление `aisy-bootstrap` блокируется
dependencies, пока release packages установлены; активный runtime без staging
остаётся видим doctor как managed runtime, а не как отсутствующий пакет.

## 5. Репозиторий и ключи

Репозиторий имеет Debian-layout `pool/` + `dists/noble/main`, индексы для
`all`, `amd64`, `arm64`, canonical `Release` и clearsigned `InRelease`.
Unsigned repository, expired metadata, wrong suite/component/architecture,
unknown key или fingerprint mismatch fail closed. `trusted=yes`,
`allow-insecure` и global `apt-key` запрещены.

Сборка воспроизводима: clean exact commit, `SOURCE_DATE_EPOCH`, фиксированные
owner/group/mode, отсортированные entries и два независимых build-прогона с
одинаковым SHA-256. Signing выполняется после reproducibility verdict. Ветвь
`gh-pages` получает только уже подписанный snapshot; private key и build temp
никогда не staged.

Ротация ключа выполняется заранее: текущий подписанный репозиторий доставляет
новую версию `aisy-archive-keyring`, затем оператор проверяет exact fingerprint,
и только после доказанного overlap repository переключается на новый archive
key. `Signed-By` остаётся ограничен exact keyring path и fingerprint set.

## 6. Ошибки и наблюдаемость

Публичные ошибки стабильны и не содержат путей из home, fingerprints binding,
package content или credential metadata. Основные классы:

- `PACKAGE_DESCRIPTOR_REFUSED`;
- `PACKAGE_SOURCE_REFUSED`;
- `PACKAGE_RELEASE_REFUSED`;
- `RUNTIME_BINDING_REFUSED`;
- существующие `*_REFUSED` component installers.

`status` полностью read-only: показывает package version, component release,
commit prefix, staging/active/previous и binding verdict. Он не запускает
daemon-reload, decrypt, network, repair или activation.

## 7. Проверка

Детерминированные тесты покрывают:

- exact package contents, owner/group/mode, absence maintainer scripts и
  воспроизводимый SHA-256;
- descriptor duplicate/unknown fields, traversal, symlink, hardlink, device
  escape, mutable source и digest/commit mismatch;
- inactive/foreign unit, PID reuse, cgroup drift, wrong user/home;
- package install/upgrade/remove/reinstall без systemd/state mutation;
- activation A, activation B, failed B rollback, explicit rollback и uninstall;
- unsigned/wrong-key/stale APT repository refusal;
- real `dpkg`/APT на disposable Ubuntu 24.04 для `amd64` и artifact inspection
  для `arm64`;
- full workspace gates, privacy scan и отсутствие материалов приватного
  эталона.

Production gate на целевом хосте: установить pinned source, stage packages,
убедиться в нулевой mutation после `apt install`, активировать provider и voice
без real credential, выполнить doctor/restart/rollback. Реальный credential
ввод и vendor E2E остаются отдельным операторским privacy action.
