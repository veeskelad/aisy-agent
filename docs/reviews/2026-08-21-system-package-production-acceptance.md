# Production-приёмка системных пакетов Aisy

> Текущий release verdict после отказа от APT находится в
> [production-матрице от 2026-08-23](./2026-08-23-production-readiness-matrix.md).

> **Историческое evidence.** Приёмка подтверждает состояние среза 2026-08-21,
> но package delivery заменён [ADR-0106](../decisions/2026-08-22-managed-git-distribution-without-apt.md)
> и [компонентом 28](../specs/28-managed-git-distribution-without-apt.md). Документ
> не является текущим release gate или production runbook.

**Дата:** 2026-08-21  
**Exact source:** rewritten `master@2830130f989fe5cb99ef1c9b3079a584ce82d3f8`

**Версия пакетов:** `0.1.14-4`

## Область и границы

Проверка относится к root-owned доставке provider/voice, activation helpers,
native voice bridge, restart и rollback. Она не вводит vendor credentials, не
выполняет внешний provider/transcription call и не считает наличие пакета
эквивалентом пользовательскому E2E.

Private archive key не копировался в build output, Git, disposable VM или на
production-хост. Публичный keyring имеет primary fingerprint
`7CCD2D76D5B15351012DE7F0EED984FF342C59AA`.

## Найденные production-дефекты

Первый запуск `0.1.14-1` выявил два независимых fail-closed отказа:

1. systemd `UMask=0077` делал публичные PID/status projections недоступными
   runtime UID, потому что atomic publisher полагался только на mode при
   `open(2)`;
2. Python broker отправлял канонический bootstrap discriminator `A`, а native
   bridge принимал только `1` и отклонял корректно переданный `SCM_RIGHTS` FD.

PR #16 исправил оба дефекта в rewritten merge `2830130`: atomic publisher явно
вызывает `fchmod(0644)`, а bridge принимает тот же discriminator, который
закреплён Linux kernel-тестом broker-а. Regression сначала воспроизвёл
несовместимость, после минимального исправления прошёл.

## Воспроизводимая сборка

`amd64` и `arm64` собраны в отдельных Ubuntu environments дважды из clean
detached checkout exact commit с `SOURCE_DATE_EPOCH=1787304597`. Для каждой
архитектуры две package directories byte-identical. Общие `all` packages
совпадают между архитектурами.

| Package | SHA-256 |
|---|---|
| `aisy-archive-keyring_0.1.14-4_all.deb` | `0620317adbaed51d33fcde48c6e7872558d102b68151f1df83d00474aa3eeab1` |
| `aisy-bootstrap_0.1.14-4_all.deb` | `f52fd75a2411d1f2ef3cdfc86676316d5c9f7b5bb0393ef84bd405be92edad3d` |
| `aisy-provider-release_0.1.14-4_all.deb` | `0aded0a854c6aa8775b3ca538e99e952f80d6e19f8fc19f8674a667299031cd7` |
| `aisy-voice-release_0.1.14-4_amd64.deb` | `e8d285b5299ea47125206bcbe30c5ab34d232b6acaa11102455600721f4e91c9` |
| `aisy-voice-release_0.1.14-4_arm64.deb` | `8ee581282a5446ea2c62c56e0e5bb302457775fd1e55ed440885f5a5e51c6a72` |

Unsigned repository snapshot также собран дважды byte-identical. Canonical
`dists/noble/Release` имеет SHA-256
`9dfe51844a6d828dd8df770430d34f26364bc89eddacbe665f93bc7d55674373`.

## Автоматические проверки

- `@aisy/app`: `2500 passed`, `1 skipped` в локальной среде с разрешёнными
  Unix/loopback sockets;
- `@aisy/core`: `2352 passed`, `1 skipped`;
- `@aisy/telegram-gw`: `255 passed`;
- Python sidecars: `191 passed`, `39` platform-skipped;
- packaging-targeted corpus: `42 passed`;
- workspace typecheck и build: pass;
- Ruff и `git diff --check`: pass; workspace packages не объявляют отдельный
  `lint` script;
- Gitleaks 8.30.1: fresh remote mirror просканировал `709` commits во всех
  heads, tags и GitHub PR refs и не нашёл findings. Все `42` управляемых
  heads/tags дополнительно имеют `0` совпадений точного имени приватного
  эталона в refs, paths, blobs, commits и annotated tags;
  Три allowlist-записи одновременно ограничены exact rule, exact path и exact
  line context; отдельный negative corpus в тех же путях обнаружил `3/3`
  намеренно внесённых synthetic leaks;
- disposable Ubuntu 24.04 принял inert upgrade четырёх пакетов
  `0.1.14-3→0.1.14-4`; после upgrade Aisy units и account отсутствуют,
  `/run/aisy` не создан;
- isolated real `apt-get update` отклонил unsigned snapshot с exit `100` и
  `repository ... is not signed`.

## Текущее production-состояние fr1

Четыре inert packages установлены локально как emergency exact build после
того, как `0.1.14-1` выключил supervisor fail-closed. До штатной activation
runtime был восстановлен обратимым hot-load: исправленный addon загрузился в
новый процесс, исходный on-disk addon был немедленно возвращён и проверен по
исходному digest. Это позволило helpers получить genuine active binding без
ручного изменения state или credentials.

После atomic history rewrite и explicit activation:

- provider: package/active `0.1.14-4`, previous `0.1.14-2`, `binding=ready`;
- voice: package/active `0.1.14-4-amd64`, previous `0.1.14-2-amd64`,
  `binding=ready`;
- `/run/aisy/voice-broker.pid` и `voice-status.json`: root-owned `0644`;
- provider/voice manifests: exact commit `2830130`, releases
  `provider-0.1.14-4` и `voice-0.1.14-4-amd64`;
- application checkout обновлён через verified complete bundle до exact
  `2830130`; его tree побитно равен прежнему `f389061`. Frozen offline install,
  workspace typecheck/build и clean-tree check прошли;
- supervisor restart: stable MainPID `140327`, `NRestarts=0`;
- post-upgrade doctor: `6 passed`, `2` contract-defined sandbox warnings,
  `0 failed`;
- provider rollback `-4→-2` и roll-forward `-2→-4`: pass, MainPID не менялся;
- voice rollback `-4→-2` и roll-forward `-2→-4`: pass, MainPID не менялся;
- rollback Git ref `codex/rollback-fr1-pre-rewrite-20260821-f389061` сохраняет
  предыдущий production commit. Known-bad `0.1.14-1` больше не является
  runtime previous и не используется.

## Открытые gates

1. GitHub хранит read-only старые `refs/pull/1..16/head`. Управляемые heads/tags
   чисты, PR #17 указывает на rewritten head; для полного server-side purge
   старых PR refs/cache нужен GitHub Support. First changed commit:
   `2d00846b6751a18ebc97cca1f0b13ff97bc180b9`.
2. Подписать snapshot production archive key, проверить `InRelease` и
   `Release.gpg` только публичным keyring и exact primary fingerprint.
3. Опубликовать byte-identical snapshot в публичный `veeskelad/aisy-apt`,
   включить GitHub Pages и повторить authenticated `apt-get update/install`.
4. Прогнать real-client wrong-key, stale, tampered и wrong-suite corpus уже
   против подписанного snapshot.
5. Отдельно выполнить operator TTY enrollment, consent, bounded vendor calls и
   revoke; до этого provider/voice vendor E2E остаётся открытым.
