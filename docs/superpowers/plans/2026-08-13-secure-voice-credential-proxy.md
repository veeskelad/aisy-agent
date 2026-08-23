# План защищённого voice credential proxy

**Дата:** 2026-08-13  
**Статус:** срезы A–G реализованы; release gates AC-25-21/22 ещё не закрыты
**ADR:** `docs/decisions/2026-08-13-systemd-encrypted-voice-credential-proxy.md`  
**Спецификация:** `docs/specs/25-secure-voice-credential-proxy.md`

## 1. Проверяемый результат

На production Linux Aisy принимает Deepgram key только через локальный no-echo
TTY, валидирует и хранит его как host-encrypted systemd credential. Telegram не
видит key; runtime/provider не получает key или Authorization. Один genuine
Telegram voice capability создаёт не более одного root-issued dispatch permit и
одного HTTPS upload через отдельный непривилегированный worker. Consent,
credential readiness и spend authority остаются независимыми fail-closed gates.

Готовность доказывают AC-25-1…22, полный App/Python corpus, disposable-systemd
integration, rollback и один реальный fr1 Telegram voice turn после ручного
ввода key оператором.

## 2. Зафиксированная production topology

```text
systemd user unit MainPID: aisy supervise (Node)
  ├─ root-owned N-API bridge загружен в MainPID
  ├─ authenticated Node IPC
  └─ aisy run child: Telegram capability + consent + spend

system units:
  aisy-voice-broker.service (root control-plane, Python 3.12)
  aisy-voice-worker.socket  (root-only relay socket)
  aisy-voice-worker@.service (User=aisy-voice-proxy, one request)
```

MainPID bridge выполняет bootstrap `SO_PEERCRED`/`SCM_CREDENTIALS`, принимает
private socketpair через `SCM_RIGHTS` и никогда не экспортирует его runtime-child.
Child отправляет capability-bound descriptor по существующему authenticated IPC.
Parent открывает exact inbox file с `O_NOFOLLOW`; bridge передаёт fd broker.
Broker копирует его в sealed memfd до spend reservation/credential resolve.

Direct unsupervised `aisy run`, macOS и Linux без аттестованного root artifact
возвращают `voice unavailable`; legacy `vault.json` resolver не используется и
не является fallback.

## 3. Карта срезов

### Срез A — genuine media capability и proxy provider

Файлы:

- `packages/app/src/telegram-voice-media-capability.ts` и тест;
- `packages/app/src/telegram-voice-ingress.ts` и тест;
- `packages/app/src/transcription-contract.ts`;
- `packages/app/src/deepgram-proxy-provider.ts` и тест;
- `packages/app/src/deepgram-runtime.ts` и spend tests.

Шаги:

1. Issuer хранит capability в private `WeakMap`, связывает exact Telegram
   attachment, work binding и inbox identity, допускает один consume.
2. Voice ingress mint'ит capability только после durable ingest и exact binding
   verification; structural copy/foreign/stale/replay отклоняются до reserve.
3. Proxy provider делает `stageMedia → reserve → prepare → dispatch → settle`.
   Любой fault до dispatch освобождает reservation; после claim — ambiguous.
4. Typed proxy result проецируется в существующий untrusted voice transcript.

Проверки: forged object, wrong update/file/root/hash, double consume, abort между
каждой фазой, settled/ambiguous/released spend, zero direct HTTPS/key resolver.

### Срез B — authenticated child/parent voice RPC и Linux bridge

Файлы:

- `packages/app/src/execution-supervisor-ipc.ts` и тест;
- `packages/app/src/execution-parent-supervisor.ts` и тест/integration;
- `packages/app/src/voice-supervisor-client.ts` и тест;
- `packages/app/src/voice-broker-native.ts` и тест;
- `packages/app/native/aisy_voice_broker_bridge.c`;
- `scripts/build-voice-broker-bridge.sh`.

Шаги:

1. Добавить bounded frames `voice-stage`, `voice-stage-ack`, `voice-prepare`,
   `voice-dispatch`, typed terminal/refusal; каждый связан с supervisor session,
   request id, deadline и exact media hash.
2. Parent обрабатывает voice RPC только после successful child handshake и
   только при held native broker session; concurrent request один.
3. N-API bridge устанавливает `PR_SET_DUMPABLE=0`, создаёт Linux seqpacket
   bootstrap, проверяет `MSG_CMSG_CLOEXEC`, `FD_CLOEXEC`, `SO_PASSCRED`,
   `SCM_CREDENTIALS`, передаёт media fd через `SCM_RIGHTS` и bounds JSON frames.
4. Child никогда не получает broker fd/key и не может обойти parent relay.

Проверки: malformed/oversized frames, wrong session/deadline/hash, fork-child,
same-uid peer, inherited-fd scan, parent/child crash, bridge unavailable.

### Срез C — root broker metadata, challenge и effective-once audit

Файлы:

- `packages/sidecars-py/aisy_sidecars/voice_credential_broker.py`;
- `packages/sidecars-py/aisy_sidecars/voice_protocol.py`;
- `packages/sidecars-py/tests/test_voice_credential_broker.py`;
- `packages/sidecars-py/tests/test_voice_broker_process.py`.

Шаги:

1. Private SQLite schema хранит installation/binding hashes, credential epoch,
   challenge hash, permit lifecycle и outbox; raw ids/code/key/audio отсутствуют.
2. Challenge 128-bit+, TTL десять минут, exact provider/binding, atomic one-use
   claim и concurrent/superseded/replay refusal.
3. Credential/permit transition и outbox row записываются одной transaction.
   Sink durable-дедуплицирует event id до ack; restart повторяет тот же id.
4. Bootstrap сверяет peer uid, configured cgroup, oldest/MainPID start time,
   release и dumpable state до выдачи private socketpair.

Проверки: SQLite corruption/schema drift, crash на каждой transaction boundary,
outbox ack window, wrong uid/cgroup/pid/start time, broker restart.

### Срез D — validation, host encryption, rotation и revoke

Файлы:

- `packages/sidecars-py/aisy_sidecars/voice_credential_backend.py`;
- `packages/sidecars-py/tests/test_voice_credential_backend.py`;
- `packages/sidecars-py/tests/fixtures/fake_systemd_creds.py`.

Шаги:

1. Fixed Deepgram validation соединяется только с verified public IP, TLS SNI
   `api.deepgram.com`, `GET /v1/projects`, redirect error, status-only bounds.
2. `systemd-creds` fork/exec использует pipe2, exact fd 0/1/2 allowlist,
   scrubbed env/cwd/rlimits, bounded stderr, timeout process-group kill+reap.
3. Ciphertext publish: O_EXCL stage, fsync, rename, directory fsync, hash
   attestation, committing recovery; plaintext file/argv/env отсутствуют.
4. Rotation сохраняет old epoch до verified activation. Revoke fence-ит new
   permits, terminalizes prepared, drains/marks ambiguous claimed work и удаляет
   ciphertext только после worker fencing.

Проверки: DNS/redirect/private-IP faults, short pipe write, inherited fd,
oversized stderr, kill/reap, rename ambiguity, failed rotation, revoke races.

### Срез E — one-shot transcription worker

Файлы:

- `packages/sidecars-py/aisy_sidecars/voice_transcription_worker.py`;
- `packages/sidecars-py/tests/test_voice_transcription_worker.py`.

Шаги:

1. Worker принимает только root broker peer и один sealed memfd claim envelope.
2. До credential read проверяет schema/handle/epoch/seals/size/hash/content type.
3. Перед первым upstream byte требует durable `mark-attempted` ack.
4. Выполняет один fixed Nova-3 POST, bounded response, no redirect/retry/proxy,
   возвращает только typed result и закрывает/зануляет owned buffers/fd.

Проверки: unsealed/foreign/replayed fd, lost mark-attempted ack, TLS/HTTP/body
faults, crash до/после first byte, typed bounds и отсутствие raw detail.

### Срез F — CLI, Telegram, doctor и LIVE composition

Файлы:

- `packages/app/src/voice-credential-control.ts` и тест;
- `packages/app/src/voice-credential-tty.ts` и PTY test;
- `packages/app/src/bot.ts` и voice command tests;
- `packages/app/src/bin/aisy.ts`;
- `packages/app/src/doctor-runtime-probes.ts` и тест;
- удалить production use `makeVaultSecretResolver` для Deepgram.

Шаги:

1. `aisy voice credential set --code=…` принимает exact argv, требует controlling
   TTY, читает raw no-echo bytes, восстанавливает terminal до submit и zeroizes.
2. `/voice connect deepgram-cloud` выдаёт code/expiry/локальную команду;
   `/voice deepgram-cloud` остаётся отдельным consent; revoke проходит existing
   exact approval card.
3. `/voice` показывает две оси readiness/consent без secret metadata.
4. `aisy supervise` создаёт native broker session и обслуживает child voice RPC;
   child registry получает только proxy provider. Direct resolver/HTTPS удалены.
5. Doctor read-only различает artifact, backend, credential, proxy, outbox и
   consent без decrypt/vendor/recovery.

Проверки: grammY command/replay/wrong chat, raw PTY cancel/fault, source import
graph zero legacy resolver, restart readiness, honest unavailable states.

### Срез G — root installer, systemd units и rollback

Файлы:

- `packages/sidecars-py/aisy_sidecars/voice_proxy_install.py`;
- `packages/sidecars-py/aisy_sidecars/voice_proxy_service.py`;
- `packages/sidecars-py/voice_proxy_install.py`;
- `packages/sidecars-py/voice_proxy_service.py`;
- `packages/sidecars-py/systemd/aisy-voice-broker.service`;
- `packages/sidecars-py/systemd/aisy-voice-worker.socket`;
- `packages/sidecars-py/systemd/aisy-voice-worker@.service`;
- `packages/sidecars-py/tests/test_voice_proxy_install.py`;
- `packages/sidecars-py/tests/test_voice_proxy_service.py`;
- `packages/sidecars-py/tests/test_voice_proxy_service_process.py`;
- `packages/sidecars-py/tests/systemd_worker_probe.py`;
- `scripts/build-voice-proxy-release.py`;
- `docs/guides/deployment.md`.

Шаги:

1. Release manifest содержит protocol, commit и file hashes; expected top digest
   приходит отдельно от bundle.
2. Root helper читает source descriptor-relative без symlink/mount escape,
   копирует и хеширует из того же fd, атомарно публикует root-owned tree.
3. Units используют system Python, dedicated uid, `LoadCredentialEncrypted`,
   root-only sockets и systemd sandbox. Handshake предшествует current cutover.
4. Rollback переключает только compatible code release; credential DB/ciphertext
   не откатываются. Uninstall не оставляет silent orphan.

Проверки: source-swap/symlink/mode/owner/mount corpus, incompatible manifest,
unit sandbox assertions, atomic current/previous, rollback handshake.

## 4. Порядок коммитов и merge

1. `feat(voice): выдать genuine media capability proxy provider`
2. `feat(voice): провести proxy через supervisor authority`
3. `feat(voice): добавить root credential broker`
4. `feat(voice): зашифровать и ротировать Deepgram credential`
5. `feat(voice): добавить one-shot Deepgram worker`
6. `feat(voice): подключить CLI Telegram и doctor`
7. `feat(voice): поставить systemd credential proxy`
8. `docs(release): подтвердить voice credential proxy`

Каждый коммит должен быть рабочим для своего declared status. LIVE importer
появляется только в шестом коммите после зелёных A–E. Merge в `master` — после
полного gate; deploy — exact green merge commit с сохранённым rollback point.

## 5. Multi-angle release gate

- **Outcome:** AC-25-1…22 имеют именованные deterministic tests и traceability.
- **Scope:** только `deepgram-cloud`/primary endpoint; EU, TPM и внешний Vault не
  входят; brain/service-key legacy flows не рефакторятся.
- **Architecture:** supervisor остаётся единственным production parent;
  registry/consent/spend contracts сохраняются, direct resolver удаляется.
- **Security/privacy:** zero secret в Telegram/argv/env/files/logs/model; same-uid,
  forged capability, fd inheritance, SSRF/DNS/redirect и crash corpus fail closed.
- **Operations:** doctor read-only, pending outbox видим, rotation/revoke
  restart-safe, compatible rollback проверен до реального key.
- **Quality:** targeted suites, App/Core/Telegram tests, Python pytest/ruff,
  workspace typecheck/build, `git diff --check`, secret/private-reference scan.
- **Delivery:** disposable-systemd E2E предшествует fr1; реальный key вводит
  оператор через TTY только на green release; один Telegram voice, restart,
  revoke и rollback дают финальное evidence.
