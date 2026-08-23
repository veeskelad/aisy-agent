# Компонент 27: подписанные системные пакеты

**Статус:** заменён [компонентом 28](./28-managed-git-distribution-without-apt.md)
**ADR:** [ADR-0105](../decisions/2026-08-21-signed-system-packages.md)  
**Design:** [signed system packages](../superpowers/specs/2026-08-21-signed-system-packages-design.md)

> Историческая спецификация сохранена как evidence прежнего решения. APT,
> `.deb` и GPG delivery больше не входят в поддерживаемую production surface.

## 1. Назначение

Компонент создаёт reusable root trust root для первого install, update,
rollback и uninstall privileged provider/voice sidecars. Он не заменяет npm
CLI distribution и не выдаёт package presence за LIVE activation.

Поддерживаемая матрица v1: Ubuntu 24.04 LTS, systemd >=255, Python 3.12,
`amd64|arm64`.

## 2. Артефакты и владение

`aisy-archive-keyring` устанавливает:

- `/usr/share/keyrings/aisy-archive-keyring.gpg`, root:root `0644`;
- `/usr/share/doc/aisy-archive-keyring/fingerprints`, root:root `0644`.

`aisy-bootstrap` устанавливает:

- `/usr/libexec/aisy-provider-install`, root:root `0755`;
- `/usr/libexec/aisy-voice-install`, root:root `0755`;
- `/usr/lib/aisy/bootstrap/**`, root:root, directories `0755`, modules `0644`.

Release packages устанавливают:

- `/usr/lib/aisy/package-stage/<component>/<package-version>/**`;
- `/usr/share/aisy/releases/<component>.json`.

Bundle files сохраняют modes из component manifest. Descriptor — regular
root:root `0644`, без symlink/hardlink, не более 16 KiB. Source root и каждый
ancestor до `/usr` — canonical root-owned и не group/world writable.

Пакеты не содержат `preinst`, `postinst`, `prerm`, `postrm`, triggers или
systemd presets. Их установка и удаление не вызывают `systemctl`, useradd,
`systemd-creds` и не изменяют `/etc/aisy`, `/var/lib/aisy`, `/run/aisy`.

## 3. Package descriptor

Canonical UTF-8 JSON имеет schemaVersion 1 и exact keys:

`architecture, commit, component, manifestSha256, packageVersion, release,
schemaVersion, source`.

Parser отклоняет duplicate/unknown/missing keys, non-canonical serialization,
NUL, invalid UTF-8, неподдерживаемую architecture, traversal, относительный или
неcanonical source, digest/commit/release/packageVersion вне allowlist grammar.
Host architecture должна совпасть с `all` либо descriptor architecture.

Descriptor читается один раз через no-follow fd; до и после parse сверяются
device/inode/size/mtime/ctime. Source и его members открываются только
descriptor-relative. Проверка запрещает symlink, hardlink (`nlink != 1`),
device/mount escape, writable owner chain и mutation между verify/copy.

## 4. Runtime binding

Helper CLI принимает component operation и только operator choices:

- `--runtime-user=<system account>`;
- `--runtime-unit=<user service ending .service>`;
- `--aisy-home=<absolute path>`;
- provider install дополнительно exact sorted provider allowlist.

Root-owned helper сам получает UID/GID из NSS и через
`systemctl --user --machine=<user>@.host show` читает MainPID, ControlGroup,
FragmentPath и active state. Затем он сверяет живой `/proc/<pid>` uid/cgroup и
запрещает PID 0, inactive/failed unit, foreign uid, cgroup drift, symlinked unit
fragment или unit вне exact user's systemd root.

Voice/provider installation hash вычисляется по production domain separator и
точным bytes `aisy-home`. Home должен быть absolute, существующим canonical
directory exact runtime uid, не group/world writable. Helper не читает runtime
state или `.env` и не запускает код из home.

## 5. Operations

### 5.1 Status

`status` read-only проверяет package descriptor, stage, active/previous release,
manifest/protocol compatibility и runtime binding. Он не делает repair,
daemon-reload, network, decrypt или state write.

### 5.2 Install/update

1. Проверить host, package descriptor и root-owned stage.
2. Получить и перепроверить runtime binding.
3. Вызвать root-owned package entrypoint через `/usr/bin/python3.12 -I` с
   descriptor source, external manifest digest/commit и derived binding.
4. Component installer повторно verify/copy/hash bundle, делает self-check,
   atomically публикует current/previous, units/config и только затем restart.
5. После restart helper требует active units и compatible read-only readiness.

Повторный install exact release идемпотентен либо возвращает стабильный
`already-active` без cutover. Package stage никогда не становится runtime
import path.

### 5.3 Rollback

Rollback не использует package stage: existing component installer проверяет
root-owned `previous`, protocol/schema и handshake, atomically меняет
current/previous, восстанавливает units/config и проверяет readiness.
Credential revision/state автоматически не откатываются.

### 5.4 Uninstall

APT removal означает только удаление inert stage. Runtime uninstall — explicit
helper operation с live binding. Voice сначала завершает revoke либо требует
`--preserve-encrypted-credential`; provider закрывает epoch, отменяет prepared,
drain/fence claimed workers, останавливает и disables units, удаляет units и
runtime release, но не удаляет ambiguous credential state без policy verdict.
Partial uninstall остаётся fail-closed и видим status/doctor.

## 6. APT repository и release

Layout: `pool/main` и `dists/noble/main/binary-{all,amd64,arm64}`. `Packages`
содержит SHA-256 каждого `.deb`; `Release` содержит SHA-256 всех индексов;
`InRelease` — clearsigned canonical Release. `Valid-Until` bounded и обязателен.

Первый keyring скачивается как обычный unprivileged файл и копируется в
`/etc/apt/keyrings` только после проверки полного fingerprint по двум
operator-owned источникам. После первой authenticated установки пакет
`aisy-archive-keyring` владеет canonical keyring в `/usr/share/keyrings` и
доставляет ротацию до смены repository signer.

Client source — deb822 `.sources` с exact HTTPS URI, `Suites: noble`,
`Components: main`, explicit architectures и `Signed-By` отдельного Aisy
keyring. Полный primary fingerprint документирован и проверяется до root copy.
`apt-key`, `trusted=yes`, `allow-insecure` и downgrade-to-insecure запрещены.

Build принимает exact clean commit, package version, architecture и
`SOURCE_DATE_EPOCH`; нормализует owner/group/mode/mtime/order и отклоняет dirty
tree, symlink members, unknown output и source size > bounds. Два build-прогона
обязаны дать identical bytes. Signing и `gh-pages` publication происходят
только после всех gates; private key path/content не передаются build scripts,
logs или Git.

Rollback repository publication — вернуть предыдущий полностью подписанный
snapshot новым commit ветки `gh-pages`; не переписывать историю и не публиковать
старый `InRelease` с истёкшим `Valid-Until`.

## 7. Стабильные отказы

- `PACKAGE_DESCRIPTOR_REFUSED` — descriptor schema/path/owner/mode;
- `PACKAGE_SOURCE_REFUSED` — stage/member/TOCTOU/mount/mode;
- `PACKAGE_RELEASE_REFUSED` — digest/commit/protocol/architecture;
- `RUNTIME_BINDING_REFUSED` — account/unit/PID/cgroup/home;
- `PACKAGE_OPERATION_REFUSED` — operation/arguments/lifecycle;
- component-specific existing refusal codes после передачи authority.

Ошибки не содержат home paths, uid/pid/cgroup, hashes, package bytes,
credential state или vendor detail.

## 8. Acceptance criteria

1. **AC-27-1** — Два build-прогона exact commit/version/epoch дают byte-identical
   `.deb`; contents/owner/group/mode/mtime/order соответствуют manifest.
2. **AC-27-2** — Bootstrap и release packages не имеют maintainer scripts и
   install/upgrade/remove/reinstall не меняют systemd, users, host key или
   runtime/state roots.
3. **AC-27-3** — Descriptor parser отклоняет duplicate/unknown/missing keys,
   non-canonical JSON, traversal, wrong component/architecture/digest/commit.
4. **AC-27-4** — Symlink, hardlink, writable ancestor, bind/device escape,
   member replacement и concurrent mutation завершаются до component execution.
5. **AC-27-5** — Root helper никогда не import/exec user checkout, NVM, venv,
   `PYTHONPATH`, runtime home или package stage до полной root verification.
6. **AC-27-6** — Runtime binding выводится из NSS + live user-systemd + `/proc`;
   inactive/foreign/PID-reuse/cgroup-drift/home mismatch fail closed.
7. **AC-27-7** — Install A затем B сохраняет previous; failed B возвращает A;
   explicit rollback восстанавливает A и compatible readiness.
8. **AC-27-8** — Package upgrade/remove не удаляет active/previous runtime и не
   меняет LIVE до explicit helper operation.
9. **AC-27-9** — Voice/provider explicit uninstall останавливает authority и
   units; encrypted/ambiguous state обрабатывается только явной policy.
10. **AC-27-10** — APT принимает correct `InRelease`/Signed-By chain и отклоняет
    unsigned, wrong-key, stale, wrong-suite/component/architecture и tampering.
11. **AC-27-11** — Dedicated archive private key отсутствует в Git, build output,
    production hosts, logs и diagnostics; initial fingerprint проверяется до
    root copy, а keyring rotation проходит authenticated overlap.
12. **AC-27-12** — Disposable Ubuntu 24.04 systemd E2E доказывает inert package
    install, provider/voice activation, restart, update, rollback и uninstall.
13. **AC-27-13** — Целевой production-хост принимает package chain из merged
    commit, doctor зелёный, Aisy restart сохраняет readiness, а rollback point
    проверен до privacy action.
14. **AC-27-14** — Workspace tests/typecheck/build, Python pytest/ruff,
    `git diff --check`, secret scan и private-reference scan зелёные.

## 9. Release evidence

Предрелизный acceptance выполнен для commit `19c2154`:

- Ubuntu 24.04, systemd 255 и Python 3.12 на native `amd64` и `arm64` собрали
  package sets дважды; три пакета `Architecture: all` совпали byte-for-byte
  между независимыми builders, native voice packages получили свои индексы;
- Ruff зелёный; Python sidecars после расширения adversarial corpus: 189 passed,
  39 platform-skipped; descriptor/runtime targeted corpus: 33 passed;
- workspace typecheck и build зелёные; Core: 2352 passed, 1 skipped; Telegram:
  255 passed; первый параллельный App run: 2496 passed, 1 skipped и три
  нагрузочных flake, exact два затронутых файла затем дали 40/40 passed
  изолированно; полный App corpus с одним worker подтвердил 2499 passed,
  1 skipped без flake;
- ephemeral disposable signer подтвердил `InRelease` и `Release.gpg` точным
  primary fingerprint; APT принял scoped chain и отказал unsigned, wrong-key,
  stale, tampered-index, tampered-package, wrong-suite, wrong-component и
  wrong-architecture вариантам;
- package install не создал users, units, host key, runtime или state; remove и
  reinstall release packages не изменили активные provider/voice services;
- explicit activation A, package upgrade к B без cutover, activation B,
  restart, rollback B→A и rehearsal A→B сохранили readiness и exact
  active/previous; explicit uninstall остановил authority/units, сохранил state
  и оставил package stage inert.

Перед production publication остаются обязательными merge commit rebuild,
persistent operator archive key с независимо проверенным fingerprint, новый
`gh-pages` commit и redacted production deploy evidence.
Hostnames, usernames, private paths, private keys, credentials и материалы
приватного эталона в публичное evidence не попадают.
