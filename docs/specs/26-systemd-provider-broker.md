# Компонент 26: systemd provider broker для native API

**Статус:** LIVE под supervisor для семи fixed providers; broker/worker/
validator lifecycle и rollback приняты, operator TTY enrollment, bounded vendor
call, restart и revoke с реальным slot остаются target gate
**Компонент:** 26
**Связанные ADR:** ADR-0050, ADR-0087, ADR-0096, ADR-0099
**Зависит от:** 01 Core Agent Loop, 05 Safety, 09 Provider Routing, 13 Onboarding

## 1. Назначение и границы

Компонент подключает, ротирует, отзывает и использует API credentials нативных
LLM-провайдеров на headless Linux без раскрытия ключа процессу Aisy, модели,
Telegram, user-owned state или логам.

Первый LIVE-срез поддерживает только статические descriptors для `openai`,
`anthropic`, `openrouter`, `deepseek`, `qwen`, `glm` и `gemini`. Пользовательский
`openai-compatible` base URL, subscription/CLI providers, voice credentials и
произвольный HTTP egress не входят в компонент и обязаны fail closed.

## 2. Доверенные единицы

### 2.1 Control client и TTY ingress

User-owned runtime может запросить challenge и прочитать только redacted readiness:

```ts
interface ProviderCredentialControlPort {
  begin(input: { operatorId: string; profileId: string; providerId: NativeProviderId }):
    Promise<{ code: string; expiresAt: string }>
  inspect(input: ProviderCredentialBinding): Promise<
    | { state: 'unconfigured' | 'enrolling' | 'unavailable' }
    | { state: 'ready'; handle: OpaqueProviderCredentialHandle; revision: number }
  >
  revoke(input: ProviderCredentialBinding, approval: ExactApproval): Promise<RevokeResult>
}
```

Control plane слушает отдельный root-owned `/run/aisy/provider/admin.sock`;
streaming data plane остаётся на `/run/aisy/provider/control.sock`. Оба protocol
namespace независимы от voice broker. `begin`, `inspect` и `revoke` требуют exact
Aisy peer attestation, а `submit` — тот же runtime uid и уже atomically claimed code.

Credential вводится только командой:

```text
aisy provider credential set --code=<one-use-code>
```

CLI требует controlling TTY, отключает echo, не показывает mask/length, отклоняет
pipe/redirect, process parameter option, positional key и unknown flags. Размер ключа
— 1..8 KiB без NUL/control characters. Owned buffer зануляется после send, cancel и
exception; terminal mode восстанавливается до сетевого вызова.

Challenge содержит не менее 128 random bits, живёт не более десяти минут, связан с
exact installation/operator/profile/provider и хранится только как domain-separated
hash. Claim одноразовый и transactional; expired, replayed, superseded и foreign
challenge завершаются до чтения credential payload и vendor I/O.

### 2.2 Root-owned control broker и backend

Broker — отдельный system service и protocol namespace. Он проверяет kernel
`SO_PEERCRED`, expected Aisy uid, exact `MainPID`, `/proc/<pid>/stat` start time,
cgroup, installation hash и release digest. Проверка выполняется до challenge claim,
permit issue, credential resolve и HTTPS.

Root-owned SQLite хранит только:

```text
schema_version, installation_hash, operator_hash, profile_hash, provider_id,
slot_id, challenge_hash, phase, credential_revision, active_slot,
ciphertext_hash, release_digest, created_at, updated_at
```

Raw code, key, key hash/length, auth headers, request/response body и vendor account
metadata не сохраняются. Каталог и DB имеют canonical root-owned path, `0700/0600`,
`synchronous=FULL`, bounded WAL и единственного writer.

После claim ключ проверяется code-owned descriptor. Redirect запрещён; DNS/IP policy
отклоняет loopback, link-local, private, multicast, unspecified и reserved адреса;
TLS hostname фиксирован. Ответ validation bounded и status-only. Успех определяется
exact allowlist статусов descriptor, всё остальное проецируется в stable redacted code.

Backend запускает exact
`/usr/bin/systemd-creds encrypt --with-key=host --name=aisy-provider - -` без shell.
Открытые bytes поступают только через внутренний `pipe2(O_CLOEXEC)` в child fd 0;
ciphertext temp — через root-owned `O_EXCL` fd 1; bounded stderr — fd 2. Child получает
`cwd=/`, `umask=077`, `RLIMIT_CORE=0`, `PR_SET_DUMPABLE=0`, минимальный code-owned
набор параметров и закрывает остальные fd. Timeout или ошибка убивает process group,
reap'ит child, закрывает pipe ends, зануляет owned buffers и удаляет unpublished
ciphertext.

Успешная rotation пишет inactive A/B slot, выполняет file fsync, atomic rename,
directory fsync, повторную hash/mode/owner attestation и одной DB transaction меняет
active revision. Старый slot удаляется только после commit и worker drain.

### 2.3 Provider activation и streaming worker

Aisy отправляет broker только:

```ts
interface ProviderDispatchV1 {
  protocol: 'aisy.provider-dispatch.v1'
  requestId: string
  descriptorId: ProviderDescriptorId
  method: 'POST'
  pathId: 'responses' | 'chat-completions' | 'messages'
  contentType: 'application/json'
  bodyLength: number
  bodySha256: string
  deadlineAt: string
}
```

Caller не передаёт URL, host, port, DNS result, auth scheme/header, credential slot,
redirect policy или response limit. Broker выдаёт one-use permit, связанный с exact
peer/release/provider/descriptor/revision/request digest/deadline. Состояния permit:
`prepared → claimed → attempted → terminal|ambiguous`; повторный claim запрещён.

Socket-activated worker работает отдельным uid `aisy-provider-proxy`, получает ровно
один active encrypted credential через `LoadCredentialEncrypted=` и обслуживает один
permit. Root broker relay — единственный допустимый peer worker. Worker повторно
сверяет descriptor и request digest, читает credential из systemd credential directory
через owned bounded buffer, требует exact `$CREDENTIALS_DIRECTORY/aisy-provider` и
root-owned regular delivery `0440`, добавляет единственный vendor auth header и
выполняет HTTPS на статический origin. Systemd namespace при этом оставляет файл
доступным непривилегированному unit user; owner metadata не подменяется uid worker.

Worker принимает request body потоково с backpressure. Максимальный request body,
response body, header bytes, connect/first-byte/overall timeout и concurrency задаются
descriptor и global quotas. Client cancel закрывает upstream; downstream stall
останавливает чтение. Redirect, protocol downgrade, proxy settings, hop-by-hop headers,
compression bomb, invalid framing и превышение bounds завершаются stable code.

В Aisy возвращаются только status, allowlisted content headers и body stream. Upstream
request headers, auth header, response cookies, proxy-auth, raw TLS/DNS diagnostics и
неallowlisted headers не возвращаются и не логируются. Body считается provider data,
а не credential, но следует retention и redaction текущего model runtime.

После момента `attempted` broker не делает скрытый retry: transport failure считается
неоднозначным, потому что upstream мог принять запрос и списать средства. Решение о
повторе принадлежит существующему provider/router lifecycle и получает явный attempt id.

### 2.4 Статические descriptors

Каждый descriptor — code-owned immutable запись:

| Provider | Origin | Path family | Auth |
|---|---|---|---|
| OpenAI | `https://api.openai.com` | `/v1/responses`, `/v1/chat/completions` | `Authorization: Bearer` |
| Anthropic | `https://api.anthropic.com` | `/v1/messages` | `x-api-key` + fixed API revision |
| OpenRouter | `https://openrouter.ai` | `/api/v1/chat/completions` | `Authorization: Bearer` |
| DeepSeek | `https://api.deepseek.com` | `/v1/chat/completions` | `Authorization: Bearer` |
| Qwen | `https://dashscope.aliyuncs.com` | `/compatible-mode/v1/chat/completions` | `Authorization: Bearer` |
| GLM | `https://open.bigmodel.cn` | `/api/paas/v4/chat/completions` | `Authorization: Bearer` |
| Gemini | `https://generativelanguage.googleapis.com` | `/v1beta/openai/chat/completions` | `Authorization: Bearer` |

Descriptor также фиксирует validation request, TLS/DNS policy, allowed content types,
stream framing expectation и quotas. Изменение host/path/auth/validation является
новой descriptor revision и требует compatibility/release review.

| Provider | Validation | Exact success projection |
|---|---|---|
| OpenAI | `GET /v1/models` | `200` |
| Anthropic | `GET /v1/models` | `200` |
| OpenRouter | `GET /api/v1/key` | `200` |
| DeepSeek | `GET /models` | `200` |
| Gemini | `GET /v1beta/openai/models` | `200` |
| Qwen | `POST /compatible-mode/v1/chat/completions` с code-owned несуществующей model | `400`, `402`, `404`, `422`, `429` |
| GLM | `POST /api/paas/v4/chat/completions` с code-owned несуществующей model | `400`, `402`, `404`, `422`, `429` |

Для Qwen и GLM эти статусы доказывают прохождение authentication до model/quota
validation и не публикуют body либо account metadata. `401`, `403`, redirect и любой
неallowlisted статус всегда означают отказ; broker получает только stable status class.

## 3. Lifecycle

### Enrollment и rotation

1. Paired operator просит подключить или заменить exact provider.
2. Aisy возвращает публичный one-use code и команду для локального TTY.
3. Broker claim'ит code, validation проверяет owned credential bytes.
4. Backend encrypt'ит inactive slot, attests ciphertext и атомарно активирует revision.
5. Readiness становится `ready`; ключ и account metadata не возвращаются.

### Dispatch

1. Provider adapter сериализует request и вычисляет digest до permit request.
2. Broker attests exact Aisy peer/release и active credential revision.
3. Permit claim и worker activation происходят до credential resolve.
4. Worker inject'ит credential, ставит `attempted` перед первым upstream byte и
   проксирует response с backpressure.
5. Terminal audit содержит только hashes/ids, status class, byte counts и timings.

### Revoke

1. Exact approval закрывает active epoch и запрещает новые permits.
2. Prepared permits отменяются; claimed work drain'ится до bounded deadline.
3. Ambiguous work не переигрывается; workers останавливаются.
4. Оба ciphertext slots и совместимые stale metadata удаляются с fsync evidence.
5. Readiness становится `unconfigured`; legacy source не подхватывается.

### Restart и rollback

Restart проверяет schema, installation/release binding, ciphertext hash, owner/mode и
permit journal. `committing` завершается только по доказательству exact published hash;
`attempted` восстанавливается как `ambiguous`, без retry. Несовместимый release
останавливает broker fail closed. Rollback допускается только на manifest-verified
совместимый release и не меняет credential revision автоматически.

## 4. Установка, hardening и doctor

Installer принимает root-owned staging tree и внешний expected manifest digest,
открывает source descriptor-relative без symlink traversal, хеширует bytes из того же
fd и публикует immutable release. User checkout, NVM, writable cwd и изменяемые
оператором import paths не являются execution source.

`scripts/build-provider-broker-release.py` формирует exact import closure и пять
systemd units в детерминированный bundle, фиксирует commit/release/mode/size/SHA-256
каждого файла и печатает внешний SHA-256 `manifest.json`. Bundle обязан проходить
`verify_bundle` и `provider_proxy_service.py self-check` под isolated Python до
передачи root installer; неизвестный, отсутствующий или symlink-member отклоняется.

Units используют отдельные uid/socket/state directories и минимум:
`NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, `ProtectSystem=strict`,
`ProtectHome=yes`, `ProtectKernelTunables`, `ProtectKernelModules`,
`ProtectControlGroups`, `RestrictNamespaces`, `LockPersonality`,
`MemoryDenyWriteExecute`, пустые capabilities для worker и network deny-by-default с
явной descriptor-controlled egress границей.
Lifetime общего `/run/aisy` равен lifetime загрузки host, а socket units сами
создают parent directories `0755`; смена release обязана сохранять доступные
filesystem entries всех active socket units.
Все `PathLike`-адреса AF_UNIX нормализуются в строку до вызова Python socket API;
real-process проверка на Python 3.12 обязана поднять broker и выполнить worker/
validator connect, а не ограничиваться fake socket.

`aisy doctor` только читает и проверяет version/systemd capability, unit/socket state,
MainPID binding, release manifest, owners/modes, DB schema, ciphertext presence/hash,
active slot и отсутствие legacy authority. Doctor не расшифровывает credential, не
делает vendor request, не создаёт challenge/permit и не исправляет состояние.

## 5. Acceptance criteria

1. **AC-26-1** — Telegram принимает только control intent; credential возможен только
   из no-echo controlling TTY, а pipe/process-parameter paths закрываются тестами.
2. **AC-26-2** — Challenge одноразовый, bounded, exact-bound; expiry/replay/race и
   foreign binding завершаются до credential read/vendor I/O.
3. **AC-26-3** — Broker проверяет kernel peer, MainPID/start-time/cgroup,
   installation и release до любого credential lifecycle action.
4. **AC-26-4** — Validation использует exact descriptor, pinned public destination,
   redirect error и bounded status-only projection.
5. **AC-26-5** — `systemd-creds` вызывается exact fork/exec с host key и fd allowlist;
   открытый ключ отсутствует в process parameters/temp/state/log, owned buffers zeroized.
6. **AC-26-6** — A/B rotation crash-safe: failed/ambiguous stage не меняет active
   revision; fsync/rename/restart corpus доказывает convergence.
7. **AC-26-7** — Provider protocol не принимает arbitrary URL/host/auth/slot/header;
   unknown provider/path/descriptor revision fail closed.
8. **AC-26-8** — Permit one-use и exact-bound; replay, stale revision/release,
   same-uid foreign process и fork-child rejected до decrypt/HTTPS.
9. **AC-26-9** — Реальный worker получает credential через
   `LoadCredentialEncrypted=`, работает не-root и не возвращает key/header Aisy.
10. **AC-26-10** — Request/response streaming сохраняет backpressure, cancel и
    deadlines; oversized/framing/stall corpus заканчивается bounded stable errors.
11. **AC-26-11** — После `attempted` transport ambiguity не вызывает автоматический
    replay; provider runtime видит distinct attempt id и typed ambiguous outcome.
12. **AC-26-12** — Revoke закрывает epoch, drain'ит workers, удаляет оба ciphertext
    slots и после restart не восстанавливает credential из legacy source.
13. **AC-26-13** — Root-owned manifest install/upgrade/rollback отклоняет symlink,
    owner/mode/hash drift и user-writable executable/import chain.
14. **AC-26-14** — Doctor полностью read-only, redacted и детерминированно отличает
    ready, unconfigured, unsupported, drifted и incompatible release.
15. **AC-26-15** — Unit, Python/TS, protocol/fault tests и disposable real-systemd
    test подтверждают decrypt, один streaming request, cancel, restart и revoke без
    synthetic plaintext credential artifacts.
16. **AC-26-16** — Production composition импортирует только доказанно ready broker;
    systemd-less host, custom base URL и broker drift оставляют native API route
    fail closed без legacy runtime fallback.

## 6. Проверки релиза

- unit/property tests protocol, descriptors, bounds, zeroization и lifecycle;
- real-process Unix peer/replay/cancel/backpressure tests;
- fake-upstream TLS tests без real vendor credential;
- disposable systemd 255+ test с настоящими host-encrypted test credentials;
- package tests, workspace typecheck/build и `git diff --check`;
- независимый security review всех изменённых файлов;
- целевой smoke только после operator TTY enrollment: readiness, один bounded model
  call, restart, rotation, revoke и rollback evidence без вывода credential.
