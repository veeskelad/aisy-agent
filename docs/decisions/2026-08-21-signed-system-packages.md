# ADR-0105: Подписанные системные пакеты как root trust root

**Статус:** Заменено [ADR-0106](./2026-08-22-managed-git-distribution-without-apt.md)
**Дата:** 2026-08-21
**Теги:** packaging, supply-chain, systemd

> Историческое решение не является действующим release channel. Оператор
> отказался от APT, `.deb` и GPG delivery; актуальная схема — managed Git для
> пользовательского CLI и SSH manifest bundles для root sidecars.

## Контекст

Provider broker и voice proxy уже имеют manifest-verified installers,
root-owned immutable releases, atomic current/previous и rollback. Первый
privileged install при этом не может запускать installer из пользовательского
checkout: manifest внутри такого bundle не доказывает собственную подлинность,
а user-writable Python import chain даёт локальное повышение привилегий.

Нужен повторяемый trust root для текущего и будущих Ubuntu-хостов. GitHub
Actions временно не является рабочим release channel, но оператор разрешил
ручную публикацию в том же публичном GitHub repository.

## Решение

Публиковать статический APT-репозиторий из `gh-pages` и подписывать его
отдельным archive key Aisy. Первый scope — Ubuntu 24.04 LTS, systemd 255,
Python 3.12, `amd64` и `arm64`.

1. `aisy-archive-keyring` доставляет только публичные archive keys;
   `aisy-bootstrap` устанавливает root-owned helpers и минимальную verification
   closure. `aisy-provider-release` и `aisy-voice-release` доставляют только
   inert root-owned staging bundles и package descriptors.
2. `apt install` не активирует services, не создаёт host key, credentials,
   runtime state или service users. Maintainer activation scripts запрещены.
3. Explicit helper сверяет APT-delivered descriptor, exact commit, внешний
   manifest digest, root ownership/modes и runtime systemd binding, после чего
   вызывает существующий root-owned component installer.
4. Active/previous releases остаются вне владения `dpkg`. Package upgrade
   только заменяет staging; activation и rollback сохраняют существующие
   atomic lifecycle и handshake.
5. Первый archive public key ставится вручную после out-of-band проверки
   полного fingerprint, затем закрепляется per-source через `Signed-By`.
   Последующая ротация доставляет новый public keyring через уже доверенную
   цепочку до смены подписи. Private key не хранится в GitHub, CI или production
   host. Insecure/trusted APT overrides запрещены.
6. Release собирается воспроизводимо из exact clean commit, подписывается только
   после двух совпавших builds и публикуется вручную, пока CI release не
   восстановлен.
7. Package removal не называется runtime uninstall. Explicit uninstall обязан
   остановить units и обработать encrypted state по component policy.

## Последствия

- **Положительное:** первый privileged install получает независимый от bundle
  trust root, а root никогда не исполняет user-owned checkout/NVM/venv.
- **Положительное:** APT проверяет одну подписанную цепочку от `InRelease` до
  exact `.deb`, а `Signed-By` ограничивает authority ключа одним source.
- **Положительное:** package upgrade не меняет LIVE runtime без явной операции;
  неудачная активация сохраняет предыдущий release.
- **Нейтральное:** npm остаётся primary distribution пользовательского CLI;
  APT packages обслуживают только privileged Linux-компоненты.
- **Нейтральное:** initial release поддерживает Ubuntu 24.04; расширение OS/
  Python/systemd matrix требует отдельного evidence, но не нового trust model.
- **Отрицательное:** операторская машина становится release-signing boundary;
  key backup, expiry и rotation требуют отдельной дисциплины.
- **Отрицательное:** ручной release имеет больше шагов до восстановления
  проверенного CI publish pipeline.

## Рассмотренные альтернативы

**Standalone `.deb` с detached signature в GitHub Release.** Проще публикация,
но initial verifier/key bootstrap и обновления менее стандартны; установленный
на целевом хосте `debsig-verify` нельзя считать базовой зависимостью.

**Одноразовый SSH/bootstrap только для текущего хоста.** Закрывает одну машину,
но не создаёт повторяемый trust root и сохраняет ручную передачу внешнего
digest для каждого нового хоста.

**Один пакет, который сразу активирует provider и voice.** Уменьшает число
команд, но связывает независимые release cadence, расширяет root trusted code и
делает обычный package upgrade скрытой production mutation.

## Ссылки

- [ADR-0056 — npm package distribution](./2026-06-24-npm-package-distribution.md)
- [ADR-0098 — secure voice credential proxy](./2026-08-13-systemd-encrypted-voice-credential-proxy.md)
- [ADR-0099 — systemd provider broker](./2026-08-14-systemd-provider-broker.md)
- [Спецификация 27](../specs/27-signed-system-packages.md)
- [apt-secure](https://manpages.debian.org/apt-secure.8)
- [sources.list Signed-By](https://manpages.debian.org/sources.list.5)
