# Компонент 25: безопасное подключение credential облачной транскрипции

**Статус:** LIVE под supervisor; root-owned broker/worker lifecycle и rollback
приняты, operator TTY enrollment, consent и реальный Telegram voice/vendor call
остаются target gate
**Компонент:** 25
**Связанные ADR:** ADR-0058, ADR-0085, ADR-0087, ADR-0098
**Зависит от:** 02 Gateway, 05 Safety, 13 Onboarding, 16 Brain Connections

## 1. Назначение и границы

Компонент даёт paired Telegram-оператору production-путь подключения,
ротации и отзыва Deepgram API key на headless Linux, не помещая key в Telegram,
Aisy state, model context, argv, environment или plaintext-файл.

Компонент включает:

- one-use enrollment challenge через `/voice connect deepgram-cloud`;
- no-echo local TTY команду `aisy voice credential set --code=<code>`;
- root-owned control broker и host-encrypted systemd backend;
- непривилегированный credential-injecting worker с одним descriptor;
- readiness, rotation, revoke, restart и rollback evidence.

Компонент не выбирает transcription provider за оператора, не меняет
privacy-disclosure ADR-0085, не является общим HTTP proxy, не хранит API key в
legacy vault и не реализует внешний Vault/TPM backend. Первый срез поддерживает
только `deepgram-cloud` и основной host `api.deepgram.com`; EU endpoint требует
отдельного descriptor/revision и повторного consent.

## 2. Доверенные единицы

### 2.1 Aisy voice control client

User-owned runtime показывает code только exact allowlisted Telegram chat и
работает с публичными metadata. Он не принимает secret bytes.

```ts
interface VoiceCredentialControlPort {
  begin(input: {
    operatorId: string
    profileId: string
    providerId: 'deepgram-cloud'
  }): Promise<{ code: string; expiresAt: string }>
  inspect(input: VoiceCredentialBinding): Promise<
    | { state: 'unconfigured' | 'enrolling' | 'unavailable' }
    | { state: 'ready'; handle: OpaqueVoiceCredentialHandle; revision: number }
  >
  revoke(input: VoiceCredentialBinding, approval: ExactApproval): Promise<RevokeResult>
}
```

`begin` суперседит прежний active challenge для binding, но не меняет active
credential. `inspect` не возвращает key, key hash, length, vendor account или
project metadata. Handle не является bearer secret и бесполезен без exact peer,
installation, provider, slot и active revision.

### 2.2 TTY ingress client

CLI принимает только exact форму:

```text
aisy voice credential set --code=<one-use-code>
```

Code разрешён в argv и не является secret. API key читается только из
интерактивного controlling TTY без echo, mask, length или shell history. stdin,
pipe, redirect, environment option, дополнительный positional argument и
unknown flag закрываются до открытия control socket. Максимум secret — 8 KiB;
empty/control-character input отклоняется. CLI владеет `Uint8Array`, передаёт
его локальному socket client и зануляет на success, отказе, cancel и exception.
Terminal mode обязан быть доказанно восстановлен до отправки bytes; иначе
ingress прекращается.

### 2.3 Root-owned control broker/backend

System socket принимает только ожидаемый uid Aisy по kernel `SO_PEERCRED`.
Root process запускается `/usr/bin/python3` из canonical root-owned release
directory. Interpreter chain, module directory, script, unit, socket и parent
directories должны принадлежать root и не иметь group/world write. `PYTHONPATH`,
user site, cwd imports и environment-derived module loading выключены.

Broker хранит root-owned SQLite metadata:

```text
schema_version, installation_hash, operator_hash, profile_hash,
provider_id, slot_id, challenge_hash, phase, expires_at,
credential_revision, ciphertext_hash, created_at, updated_at
```

Raw code, key, handle, Telegram ids, upstream response и audio отсутствуют.
SQLite использует exact schema, private canonical directory, mode `0700/0600`,
`synchronous=FULL`, WAL bounds и exclusive writer transaction.

Challenge содержит не менее 128 random bits, живёт десять минут, хранится
только как domain-separated SHA-256 и atomically claim'ится один раз. Expired,
replayed, superseded, foreign-binding и concurrent claim завершаются до чтения
secret payload или vendor I/O.
Opaque claim consume возвращает backend'у binding hash и revision одной
broker-owned операцией; отдельный caller-supplied binding backend не принимает.

### 2.4 Host-encrypted backend

После claim broker проверяет credential фиксированным descriptor:

```text
deepgram.credential.validate.v1
GET https://api.deepgram.com/v1/projects
Authorization: Token <owned secret>
redirect: error
response policy: status-only
success: exact HTTP 200
```

DNS/IP policy запрещает loopback, link-local, private, multicast, unspecified и
reserved destinations; connect закрепляется за проверенным public address и
TLS hostname. Timeout, redirects, non-200, oversized response или cleanup drift
дают redacted stable code. Raw body/headers никогда не возвращаются.

После success broker запускает root-owned `/usr/bin/systemd-creds` без shell
через отдельный fork/exec boundary. Это единственное исключение из запрета
обычного stdin: broker создаёт внутренний `pipe2(O_CLOEXEC)`, child отображает
его read end только в fd 0, root-owned `O_EXCL` ciphertext temp — только в fd 1,
а bounded stderr pipe — в fd 2. До exec child закрывает все прочие fd через
`close_range`, устанавливает `cwd=/`, `umask=077`, `PR_SET_DUMPABLE=0`, bounded
rlimits и минимальный code-owned environment без user `PATH`, locale, Python и
loader variables. Argv фиксирован: exact executable, `encrypt`,
`--with-key=host`, credential name и stdin/stdout markers.

`PR_SET_DUMPABLE=0` проверяется как обязательный pre-exec шаг, но не считается
post-exec attestation: Linux может сбросить dumpable при `execve()` обычного
binary. После exec границу составляют root-only process uid, `RLIMIT_CORE=0`,
закрытый fd allowlist и отсутствие непривилегированного ptrace-доступа; защита
от другого root-процесса остаётся вне host-compromise threat boundary.

Parent немедленно закрывает чужие pipe ends, пишет owned secret с bounded
deadline, зануляет свой buffer и закрывает writer. Child никогда не наследует
control/data sockets или broker DB fd. Stderr ограничен 8 KiB, не журналируется
и проецируется только в stable code; stdout содержит только ciphertext. Timeout,
short write, unexpected exit или oversized stderr убивают отдельную process
group, дожидаются reap, закрывают все ends и удаляют unpublished ciphertext.
Kernel pipe buffer нельзя адресно занулить, поэтому контракт не обещает этого:
его размер ограничен, оба конца всегда закрываются, а lifetime завершается
reap/close. Plaintext temporary file запрещён.

Fsync ciphertext, atomic rename, fsync directory и повторная attestation
публикуют новую revision. Старый ciphertext остаётся active до verified publish.
Неоднозначность после rename фиксируется как `committing` и разрешается чтением
exact ciphertext hash, а не повторной vendor validation.

### 2.5 Media capability, dispatch permit и data proxy

Voice ingress создаёт genuine одноразовую media-inbox capability только после
проверки exact Telegram `update/message/voice`, paired chat и captured private
inbox identity `(root device, root inode, file device, file inode, file id,
size, SHA-256)`. Capability — code-owned closure/branded object: serializable
структура с теми же полями не является authority. Только production adapter,
получивший эту capability и durable spend reservation, может запросить dispatch
permit через приватный activation channel.

Bootstrap listener — root-owned `AF_UNIX/SOCK_SEQPACKET`, но secret или permit
по нему не передаются. Aisy устанавливает `PR_SET_DUMPABLE=0` до connect. Broker
сверяет kernel `SO_PEERCRED.pid` с exact `MainPID` настроенного Aisy systemd unit,
а также pid start-time, service cgroup, dumpable state, installation и release.
Только после этого broker создаёт private
`socketpair(AF_UNIX, SOCK_SEQPACKET|SOCK_CLOEXEC)`, включает `SO_PASSCRED`:
server end остаётся у broker, client end один раз передаётся exact main process
через `SCM_RIGHTS`.

Aisy получает fd через `recvmsg(MSG_CMSG_CLOEXEC)`, перепроверяет `FD_CLOEXEC` и
никогда не включает его в spawn/pass-fd allowlist. Broker держит session binding
к исходному pid/start-time/cgroup и закрывает server end при exit/restart unit.
Каждое сообщение обязано нести kernel `SCM_CREDENTIALS` с тем же exact MainPID;
fork-child имеет другой pid и закрывается до parse. Дополнительно request требует
монотонный session sequence и genuine in-process capability. Новый supervised
activation получает новую socketpair и sequence epoch. Произвольный процесс
того же uid вне exact pid/private fd не может mint или claim permit.

Production adapter сначала atomically consume'ит genuine capability и повторно
проверяет её Telegram/private-inbox binding; forged, foreign, stale и replay
закрываются до spend reservation. Затем adapter вызывает broker `stage-media` с
binding и открытым `O_RDONLY|O_NOFOLLOW` audio fd через `SCM_RIGHTS`. Обе стороны
используют `MSG_CMSG_CLOEXEC`; неожиданные или лишние fd закрываются. Broker
сверяет `fstat` до/после чтения, bounded-копирует audio в
`memfd_create(MFD_CLOEXEC|MFD_ALLOW_SEALING)`, проверяет exact size/hash,
накладывает `F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK|F_SEAL_SEAL` и закрывает
исходный fd. Source mutation/mismatch дают zero reservation и permit.

Успешный `stage-media` возвращает короткоживущий one-use `mediaTicket`, который
сам не разрешает credential resolve или dispatch и хранится только в памяти
broker вместе с sealed memfd. После этого adapter создаёт durable spend
reservation и вызывает `prepare(mediaTicket, reservationRecoveryKey)`. Failed
reservation/expiry закрывают memfd. Только `prepare` mint'ит непредсказуемый
`dispatchPermitId`, хранит его domain-separated hash и exact
media/reservation/credential-epoch binding. Memfd живёт только в broker process
и не является durable. Durable phases:

```text
prepared --atomic claim--> claimed --первый upstream byte--> attempted
         --local refusal--> terminal-none
attempted --typed/ambiguous settlement--> terminal-attempted
```

Permit живёт не более двух минут и не переживает смену broker или supervised
activation. Expiry/revoke отменяют только `prepared`; потерянный prepared memfd
становится `terminal-none` и освобождает reservation. `claimed` никогда не
возвращается в `prepared`. Restart не повторяет claim или HTTPS: non-terminal
`claimed|attempted` становится `terminal-attempted` и требует ambiguous spend
settlement с тем же recovery key. Client `requestId` отсутствует: root-issued
`dispatchPermitId` является единственным replay key.

`dispatch` приходит только по private session channel. Broker в одной SQLite
transaction atomically переводит permit `prepared → claimed` и пишет outbox;
только после commit он соединяется с root-only system data socket. Systemd
запускает one-request service отдельным uid
`aisy-voice-proxy` с `NoNewPrivileges`, private mount/tmp/devices, закрытыми
address families кроме Unix/IPv4/IPv6 и systemd egress policy. Он получает
active encrypted credential через `LoadCredentialEncrypted=`. Plaintext
существует только в private systemd credential directory и owned process
buffer. Aisy не соединяется с data socket. Broker relay передаёт worker один
framed claim envelope и sealed audio memfd через `SCM_RIGHTS`; worker принимает
fd с `MSG_CMSG_CLOEXEC` и видит в `SO_PEERCRED` exact root broker pid/uid, а не
Aisy uid:

```ts
interface DeepgramProxyRequestV1 {
  schemaVersion: 1
  descriptorId: 'deepgram.nova3.transcribe.v1'
  installationHash: string
  handle: OpaqueVoiceCredentialHandle
  dispatchPermitId: string
  audioSha256: string
  audioBytes: number
  contentType: 'audio/ogg' | 'audio/opus' | 'audio/webm'
}
// Audio передаётся единственным sealed memfd, максимум 20 MiB.
```

Клиент не передаёт URL, host, path, method, query, Authorization, slot,
redirect policy или response bounds. Worker проверяет exact broker peer,
framing, claim envelope, handle, active epoch, memfd seals, content type, length
и SHA-256 до чтения credential file и network I/O. Forged client request никогда
не активирует service; altered/unsealed memfd закрывается до credential read.
Он делает один POST на exact `/v1/listen` с code-owned Nova-3 parameters,
`redirect=error`, timeout 120 секунд и ответом не более 1 MiB. Retry, callback,
remote URL и provider fallback запрещены.

Ответ проецируется в закрытый union:

```ts
type DeepgramProxyResultV1 =
  | { ok: true; transcript: string; language?: string; durationMs: number }
  | { ok: false; code: VoiceProxyErrorCode; dispatch: 'none' | 'attempted' }
```

Transcript, language и duration имеют code-owned bounds. Raw JSON, headers,
vendor ids, account/project metadata, key detail и arbitrary error отсутствуют.
`attempted` никогда не повторяется автоматически. Spend reservation остаётся у
Aisy: reserve происходит до data socket dispatch, settlement использует typed
duration либо ambiguous outcome.

Worker ограничивает transcript 60 KiB UTF-8, language 35 байтами exact
BCP-47-like формы, duration диапазоном `0..24h`, а весь typed relay packet —
64 KiB. `mark-attempted` и terminal result используют отдельные exact ack frames
без fd; потеря либо malformed ack закрывает worker без повторного network write.

Перед первым upstream byte worker отправляет broker по relay
`mark-attempted(permitId)`; только durable `attempted` commit+ack разрешает write.
Terminal result также сначала commit'ится broker вместе с outbox, затем
acknowledgement возвращается worker и typed result — Aisy. Потеря relay после
claim даёт `terminal-attempted`/ambiguous, даже если worker не успел отправить
byte: безопасность запрещает retry ценой консервативного расхода. Все relay,
memfd и credential fd имеют `CLOEXEC`, exact allowlist и закрываются на каждом
terminal/fault path.

## 3. Telegram UX и consent

`/voice` показывает для каждого provider две независимые оси:

- credential: `не подключён | ожидает локального ввода | готов | недоступен`;
- privacy choice: `не выбран | выбран`.

`/voice connect deepgram-cloud` выдаёт code, expiry и точную локальную команду,
но не принимает reply с key. Повторная команда суперседит прошлый code. После
успешного TTY flow Telegram показывает только readiness при следующем `/voice`;
broker не отправляет секретные callbacks.

`/voice deepgram-cloud` остаётся единственным consent action. Оно сохраняет
exact disclosure revision «Аудио отправляется Deepgram через основной API».
Credential readiness без consent даёт zero audio egress. Consent без ready
credential даёт честный `voice unavailable`. Revoke credential имеет приоритет
над persisted consent.

## 4. Rotation, revoke и crash recovery

Rotation использует новый challenge и новую credential revision:

```text
active(N) → challenge(N+1) → claimed → validating → encrypted-stage
          → committing → active(N+1) → retire(N)
```

До `committing` data proxy продолжает использовать N. `committing` — короткий
fail-closed activation fence: old ciphertext сохраняется для recovery, но новые
permits временно не выдаются. Validation failure, expired code или pre-publish
crash сохраняет N. После publish ambiguity broker
сверяет exact ciphertext hash/revision и завершает commit один раз. Две active
revision недопустимы.

Revoke требует exact Telegram approval. Его linearization point — durable
переход credential epoch `active → revoking`: после commit запрещены новые
permits, все `prepared` permits этой epoch atomically становятся
`terminal-none`. `claimed|attempted` получают bounded drain; worker может
завершить ровно текущий upload, но не начать новый. Если worker/crash не даёт
доказать исход, permit становится `terminal-attempted`, spend — ambiguous, а
epoch остаётся `revoking` до подтверждённой остановки всех её workers. Только
после drain/fencing systemd activation и отсутствия процессов, способных
resolve эту epoch, broker удаляет encrypted credential и публикует `revoked`.
Timeout не удаляет ciphertext: он оставляет fail-closed `revoking` и заметный
operator action. Consent-файл не удаляется автоматически: это отдельное privacy
choice, но без credential он не создаёт authority.

Broker restart восстанавливает только metadata phases. Secret input и vendor
request не повторяются. Data process one-shot: crash после HTTPS dispatch
возвращает attempted/ambiguous и не вызывает второй upload.

## 5. Installation, update и rollback

Release строит self-contained proxy artifact и manifest с protocol version,
release commit и SHA-256 каждого файла. Manifest внутри bundle не является
trust root. Exact expected commit и top-level digest приходят из operator-owned
deployment input, проверенного release metadata либо предыдущего root-owned
helper `/usr/libexec/aisy-voice-install`; bootstrap helper устанавливается
отдельным явным root deployment step из уже проверенного package. Production
deployment никогда не запускает installer из user checkout и:

1. сверяет manifest, exact expected commit и внешний expected digest;
2. открывает source directory и файлы descriptor-relative с запретом symlink,
   mount escape и mutation; каждый файл копируется и хешируется из одного fd;
3. публикует только завершённое root-owned staging tree через atomic rename;
4. проверяет canonical owner/mode системного Python, systemd-creds, artifacts и
   unit files;
5. устанавливает socket/service units через atomic replace и daemon-reload;
6. запускает read-only self-check и protocol handshake;
7. только затем atomically переключает root-owned `current` symlink.

User-owned NVM, checkout, `.venv`, `PYTHONPATH` и symlink в home запрещены.
Rollback возвращает previous compatible proxy release и повторяет handshake.
Credential state не откатывается вместе с binary. Несовместимый schema/protocol
блокирует rollback до backup/compatibility verdict. Uninstall сначала revoke'ит
credential либо требует явного `--preserve-encrypted-credential`; silent orphan
запрещён.

## 6. Doctor и observability

Read-only doctor проверяет:

System broker атомарно публикует root-owned sanitised projection
`/run/aisy/voice-status.json` с exact schema
`{schemaVersion:1, backend, key, proxy, outbox}`. Каждое состояние принадлежит
множеству `ready | unconfigured | unavailable | corrupt`; файл не содержит
handle, hash, code, ciphertext, provider response или error detail. Doctor
проверяет canonical path/owner/mode, ограничивает файл 8 KiB, читает его один
раз с inode recheck и никогда не запускает repair/decrypt/network action.

- systemd 255+ и доступность host-key encryption;
- root-owned canonical artifact/interpreter/unit/socket;
- protocol/release compatibility;
- socket peer policy и broker DB integrity;
- enrollment/rotation/revoke phase без code/hash detail;
- active encrypted credential readiness;
- transcription consent revision отдельно от credential readiness.

Doctor не decrypt'ит credential, не вызывает Deepgram и не выполняет recovery.
Каждая credential/permit transition и outbox row с детерминированным event id
записываются одной broker SQLite transaction. Row проходит
`pending → acknowledged`; доставка повторяет тот же id, а code-owned audit sink
сначала durable-дедуплицирует id и только затем отвечает acknowledgement. Crash
между sink commit и broker ack повторяет delivery, но не публикует второе
событие. Doctor показывает pending age/count и fail-closed corrupt gap.

Audit payload содержит только event id, binding hashes, provider/slot, revision,
transition, stable code и timestamp. Enrollment code, handle, key/hash/length,
audio identity, transcript и upstream detail запрещены.

## 7. Threat model и отказоустойчивость

| Угроза/отказ | Детерминированная реакция |
|---|---|
| Key прислан в Telegram | обычный message никогда не маршрутизируется в ingress; оператор получает предупреждение |
| Secret в argv/env/обычном stdin | CLI parser закрывается до socket; разрешён controlling TTY, затем только внутренний anonymous pipe exact child fd 0 |
| Local process угадывает code | 128-bit code, TTL, hash-only store, one-use atomic claim и exact peer uid |
| Другой процесс того же uid вызывает proxy | нет activation channel/media capability/root permit; zero resolve/reservation/HTTPS |
| User подменяет root code | root-owned canonical release и system Python; user-writable chain запрещена |
| Arbitrary credential forwarding | один descriptor, exact host/path/method и no caller headers/URL |
| DNS rebinding/redirect | pinned public address, TLS hostname, redirect error, повторная IP policy |
| Crash после external dispatch | attempted/ambiguous, zero automatic retry |
| Crash во время rotation | old revision остаётся active либо exact committing recovery |
| Ciphertext скопирован на другой host | host-bound decrypt fail; требуется новая enrollment |
| Root/host полностью скомпрометирован | вне границы host-key backend; для усиления нужен TPM/external Vault |
| Backend/proxy недоступен | voice unavailable; legacy resolver и plaintext fallback запрещены |

## 8. Критерии приёмки

1. **AC-25-1** — `/voice connect deepgram-cloud` выдаёт один 128-bit+ code на
   exact binding, новый challenge суперседит старый, expiry/replay/concurrency
   допускают ровно один claim.
2. **AC-25-2** — Telegram update с key-like text не достигает credential ingress,
   state, model spans, journal, diagnostics или memory.
3. **AC-25-3** — CLI принимает только exact command, code в argv и secret из
   controlling no-echo TTY; env/pipe/redirect/extra args закрываются.
4. **AC-25-4** — Terminal mode восстанавливается до submit на success, cancel и
   fault; CLI buffer зануляется на всех путях.
5. **AC-25-5** — Broker проверяет `SO_PEERCRED`, installation и binding до claim;
   foreign uid, code или protocol дают zero secret read/vendor I/O.
6. **AC-25-6** — Validation использует только exact `GET /v1/projects`, status
   200, pinned HTTPS и redacted outcome; redirect/non-public IP/rich response
   закрываются.
7. **AC-25-7** — systemd-creds вызывается exact fork/exec с host key, без
   plaintext temp/argv/env; ciphertext publish проходит fsync/rename/fsync и
   restart.
8. **AC-25-8** — Internal pipe fault corpus доказывает `O_CLOEXEC`, child fd
   allowlist `0/1/2`, scrubbed env/cwd/rlimits, closure чужих ends, bounded
   stderr, timeout kill+reap и zero inherited socket/DB fd. Parent secret buffer
   зануляется, unpublished ciphertext удаляется; raw stderr/secret не выходит.
9. **AC-25-9** — Rotation сохраняет old active credential до verified new
   activation; crash на каждой phase не создаёт две active revision и не
   повторяет validation после attempted dispatch.
10. **AC-25-10** — Уже root-owned installer либо explicit bootstrap сверяет
   внешний expected digest/commit и копирует+хеширует source из тех же
   descriptor-relative no-symlink fd. Root process никогда не исполняет
   user-owned Python, checkout, NVM, venv, unit или import path; source swap,
   symlink/mount/mode/owner corpus даёт zero root execution/publish.
11. **AC-25-11** — Production voice adapter принимает только genuine одноразовую
    media-inbox capability с exact Telegram/private-inbox binding. Forged plain
    object, foreign/stale/replayed capability и altered root/file/size/hash дают
    zero permit, credential resolve, reservation и HTTPS.
12. **AC-25-12** — Bootstrap выдаёт private socketpair только exact
    `SO_PEERCRED` MainPID/cgroup/start-time/release с dumpable=0; каждый request
    повторно проверяет `SCM_CREDENTIALS`, sequence и `CLOEXEC`. Fork-child,
    same-uid process, fd replay и cross-activation дают zero prepare/claim.
13. **AC-25-13** — Broker принимает genuine `stage-media` fd и создаёт
    проверенный sealed memfd до spend reservation; one-use mediaTicket не имеет
    dispatch authority. Data worker активируется только root relay после
    `prepare` и durable claim, принимает ровно один `MSG_CMSG_CLOEXEC` memfd и
    exact envelope/handle. Forged/replayed permit, arbitrary URL/header/slot,
    altered/unsealed body и oversized input дают zero credential read/HTTPS.
14. **AC-25-14** — Один approved voice вызывает не более одного Deepgram POST;
    typed success bounded, crash/timeout после dispatch не повторяется.
15. **AC-25-15** — Aisy process/provider/logs не получают key, Authorization,
    raw vendor response или credential plaintext; buffer zeroization покрыта
    fault injection.
16. **AC-25-16** — Credential readiness не активирует egress без отдельного
    `/voice deepgram-cloud` consent; stale disclosure revision fail closed.
17. **AC-25-17** — Revoke linearization закрывает epoch и отменяет prepared;
    claimed/attempted drain либо terminal ambiguous, ciphertext удаляется только
    после fencing всех workers. Restart из `revoking` не воскрешает credential.
18. **AC-25-18** — Durable transition и redacted outbox row атомарны; crash до/
    после sink commit повторяет один event id, consumer dedupe даёт effective-once
    event, corrupt/missing sequence fail closed и видна doctor.
19. **AC-25-19** — Doctor read-only различает backend, proxy, credential и
    consent readiness без decrypt/network/recovery.
20. **AC-25-20** — Release install и rollback работают только с root-owned
    manifest-verified artifacts; incompatible protocol/schema fail closed.
21. **AC-25-21** — Real-systemd E2E на disposable Linux доказывает enrollment,
    validation, service credential delivery, one request, restart, rotation,
    revoke и rollback без plaintext artifacts.
22. **AC-25-22** — Целевой fr1 E2E: key вводится оператором через TTY, consent
    выбирается отдельно, реальное Telegram voice даёт один transcript/turn;
    restart сохраняет readiness, revoke возвращает text-only refusal.

## 9. Проверки и release gate

Обязательные test layers:

- pure protocol/parser/descriptor tests;
- CLI raw-TTY PTY corpus;
- root artifact/path attestation adversarial corpus;
- broker SQLite fault/restart/concurrency tests;
- fake-systemd-creds fork/exec tests с fd/env/process audit, buffer ownership и
  zeroization;
- controlled DNS/TLS/vendor fixture для validation и transcription proxy;
- real-process `SO_PEERCRED`/`SCM_CREDENTIALS`/`SCM_RIGHTS`, same-uid/fork-child,
  sealed-memfd relay, crash-after-dispatch и rotation corpus;
- opt-in disposable-systemd integration без реального key;
- fr1 manual secret entry и real voice E2E только после green release commit.

Workspace typecheck/build, Core/App/Telegram tests, Python ruff/pytest,
`git diff --check`, secret scan и private-reference scan обязательны до merge.
Production deploy сохраняет предыдущий binary/proxy rollback point; high/critical
doctor finding или protocol mismatch включает rollback до ввода real key.

### 9.1. Evidence AC-25-21

14 августа 2026 года code release commit
`05db94b21e40b88cff8febf38698f1cde715a621` прошёл real-systemd E2E в
одноразовой локальной Ubuntu 24.04 arm64 VM: systemd 255.4 и Python 3.12.3.
Из exact clean worktree собраны два manifest-verified bundle одного commit:

- A: release `ac25-21-05db94b-a`, manifest SHA-256
  `324b49d9e22f0e17e5811eb08f494a0ad395f1d47ee2c2054b7a4390d69c9b00`;
- B: release `ac25-21-05db94b-b`, manifest SHA-256
  `ec5a79fbafa52d9fe0283c58ba8b1e90f55ec5b66e7a2429f0ac9cdf04354fb3`.

Прогон использовал только синтетические 48-байтовые markers. Enrollment и
rotation прошли через production `VoiceCredentialBroker`,
`HostEncryptedCredentialBackend` и настоящий `systemd-creds --with-key=host`;
проверяемый validator не выполнял внешний запрос. Read-only control socket
подтвердил revision 1, затем revision 2. One-shot worker дважды получил
credential через настоящий `LoadCredentialEncrypted=` и принял один sealed
memfd request на каждую проверяемую revision. В сетевой политике VM request
завершился ожидаемым typed fail-closed
`TRANSCRIPTION_ADDRESS_REFUSED` после durable `attempted`; controlled DNS/TLS
corpus отдельно доказывает один фиксированный HTTPS POST без retry.

Cutover A → B сменил broker `MainPID` с 4606 на 4768 и `InvocationID`, сохранил
revision 1 readiness и оставил `NRestarts=0`. После rotation revision 2 снова
прошла service credential delivery. Revoke через непривилегированный control
socket остановил новые socket activations, доказал отсутствие activating,
running и deactivating worker units, удалил ciphertext и вернул worker socket в
`active`; readiness стала `unavailable`. Rollback вернул exact A того же commit,
сменил broker `MainPID` на 4969 и `InvocationID`, сохранил `NRestarts=0` и не
воскресил credential.

До и после rotation/revoke bounded scan не обнаружил synthetic plaintext в
broker state, runtime files, release artifacts, shipped units или journal.
Локальный release corpus: Ruff — green; Python — `112 passed, 35 skipped`
(platform-specific skips); workspace typecheck/build — green; Core —
`2294 passed, 1 skipped`; Telegram gateway — `187 passed`; App —
`2400 passed, 1 skipped`. App corpus повторён вне sandbox, потому что первая
попытка была ограничена `listen EPERM` для локальных Unix/loopback sockets.

AC-25-21 закрыт этим evidence. AC-25-22 остаётся отдельным post-merge gate на
fr1 с операторским TTY, отдельным consent и реальным Telegram voice; до него
никакой реальный credential не вводился.

## 10. Ссылки

- [ADR-0098](../decisions/2026-08-13-systemd-encrypted-voice-credential-proxy.md)
- [ADR-0087](../decisions/2026-07-29-opaque-secret-broker-backend-proxy.md)
- [ADR-0085](../decisions/2026-07-29-transcription-providers.md)
- [Компонент 02](./02-gateway-connectivity.md)
- [Компонент 16](./16-brain-connections-and-telegram-bootstrap.md)
- [systemd credentials](https://github.com/systemd/systemd/blob/main/docs/CREDENTIALS.md)
- [Deepgram authentication](https://developers.deepgram.com/reference/authentication)
- [Deepgram List Projects](https://developers.deepgram.com/reference/manage/projects/list)
