# Component 02: Gateway / Connectivity — Specification

**Status:** Draft
**Component:** 02 / 17
**Related ADRs:** ADR-0003, ADR-0011, ADR-0014, ADR-0027, ADR-0028, ADR-0029, ADR-0071, ADR-0089
**Depends on:** Core / Agent Loop (01), Safety (05), Personality (08)

> The Gateway is the only ingress/egress edge of the harness: it authenticates the
> single operator on Telegram, ingests text, voice, files, and forwarded posts as
> provenance-tagged spans, transcribes voice through a pluggable local or external provider,
> streams replies and approval cards back, and runs the deterministic approval handler
> that is the sole confirmer of pending actions.

## 1. Purpose

The Gateway is the harness's network boundary. Everything the world sends to Aisy and
everything Aisy sends to the world crosses this component. In the OS-around-the-model
thesis it is almost entirely **deterministic code (100%)**: who is allowed to talk to
the agent, what provenance every inbound span carries, whether an inbound message is
treated as a command or as untrusted data, and whether a tap on an approval card
actually confirms an action — none of these are model decisions. The model never
authenticates a caller, never sets provenance, and never confirms its own irreversible
action.

The only place the Gateway defers to the model (~70%) is the *content* of an outbound
reply — the words Aisy streams back, shaped by Personality (08). The Gateway owns the
transport and the trust labels; the model owns the prose inside an already-authorized
send.

Concretely, the Gateway exists to do four deterministic jobs that must never be left to
the model: (1) enforce single-user authn/authz at the edge, (2) stamp provenance on
every inbound span so capability narrowing ([ADR-0027](../decisions/2026-06-11-capability-narrowing-untrusted-context.md))
and default-quarantine ([ADR-0028](../decisions/2026-06-11-default-quarantine-external-input.md))
have a trustworthy input, (3) constrain the selected transcription provider so voice
ingestion cannot become a host-level foothold, and (4) bind every approval-card tap to
exactly one pending, hash-pinned action ([ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md)).

## 2. Responsibilities

What the Gateway **owns**:

- **Telegram transport** (grammY long-poll / webhook): receive updates, send messages,
  edit messages for streaming, render and dispatch interactive cards.
- **Edge authn/authz**: a single-user allowlist on `chat_id` plus bot identity. Every
  inbound update is authorized before any other component sees it.
- **Provenance stamping at ingestion**: each inbound span is tagged `operator` or
  `untrusted` by Gateway code, per [ADR-0028](../decisions/2026-06-11-default-quarantine-external-input.md).
  The model never sets provenance.
- **Voice ingestion**: hand audio to the selected `Transcriber` under
  [ADR-0085](../decisions/2026-07-29-transcription-providers.md) and treat the
  returned transcript as `untrusted` text. Локальный Whisper, специализированный
  cloud STT и model-native audio adapter используют один контракт; внешний
  adapter требует отдельного disclosure и durable consent.
- **File / forwarded / edited message intake**: accept attachments and forwarded or
  edited posts as `untrusted` content, never as operator commands.
- **Inbound rate-limiting** and inbound replay/flood defense at the edge.
- **Outbound streaming**: stream model output back as it is produced, subject to the
  outbound lockout state owned by Safety (05).
- **Approval-card lifecycle**: mint cards with a single-use nonce + action-hash, and run
  the **deterministic approval handler** that is the only thing that confirms a pending
  action ([ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md)).
- **Step-up challenge transport** for Tier-3 / money / memory-permanence approvals
  ([ADR-0011](../decisions/2026-06-11-autonomy-gradient.md), [ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md)).
- **Operator slash-command dispatch**: recognizing the operator commands
  `/status`, `/usage`, `/context`, `/doctor`, `/consolidate` and routing them to the
  Onboarding & Operations handler ([spec 13](13-onboarding-and-operations.md)); these are
  operator commands, never untrusted content. The Gateway also renders BOOTSTRAP/config
  cards reusing the existing card lifecycle.
- Treating the bot token and `chat_id` as **vault secrets** with rotation.

What the Gateway **does not** do (boundary → owner):

- It does **not** classify content for prompt injection or compute the quarantine
  verdict — that is **Safety (05)** ([ADR-0028](../decisions/2026-06-11-default-quarantine-external-input.md)).
  The Gateway only stamps provenance; Safety escalates.
- It does **not** decide a tool call's tier, run HARD_DENY, or compute the outbound
  lockout — that is **Safety (05)** ([ADR-0011](../decisions/2026-06-11-autonomy-gradient.md),
  [ADR-0027](../decisions/2026-06-11-capability-narrowing-untrusted-context.md)). The
  Gateway is told *whether* outbound is locked; it enforces transport, not policy.
- It does **not** resolve or persist sessions — that is the **Session Manager** inside
  **Core / Agent Loop (01)**.
- It does **not** author reply text or apply tone/mode — that is **Personality (08)**.
- It does **not** decide *which* action an approval card is for — Core/Safety produce the
  pending action; the Gateway only binds a tap to it and confirms.

## 3. Interfaces

Conceptual API surface (illustrative TypeScript signatures; this is a spec, not code).
Inbound spans honor the narrow-waist principle ([ADR-0014](../decisions/2026-06-11-narrow-waist-tool-set.md)):
the Gateway emits one normalized `InboundSpan` shape regardless of channel.

```ts
// illustrative, not binding

type Provenance = "operator" | "untrusted"

type Channel =
  | "text"          // typed Telegram message from the operator
  | "voice"         // Whisper transcript (always untrusted)
  | "file"          // attachment contents (always untrusted)
  | "forwarded"     // forwarded post (always untrusted)
  | "edited"        // edited message (always untrusted)

interface InboundSpan {
  spanId: string
  chatId: number
  channel: Channel
  provenance: Provenance        // set by Gateway code only
  text: string                  // post-Whisper for voice; raw for text
  sourceRef?: string            // forwarder, file name, message id
  receivedAt: string            // ISO-8601, code clock
}

export interface Gateway {
  // Ingress: authorize -> stamp provenance -> normalize. Throws AuthzRejected
  // before any downstream component is invoked.
  onUpdate(update: TelegramUpdate): Promise<InboundSpan>
    // errors: AuthzRejected, RateLimited, VoiceUnavailable, IngestTooLarge

  // Egress: stream model output. No-ops to the user (returns OutboundBlocked)
  // if Safety reports outbound lockout for the active context.
  streamReply(chatId: number, tokens: AsyncIterable<string>): Promise<void>
    // errors: OutboundBlocked, TransportError

  // Mint an approval card bound to exactly one pending action.
  issueCard(action: PendingAction): Promise<CardId>

  // The ONLY confirmer of a pending action. Deterministic; never a model call.
  handleCardTap(tap: CardTap): Promise<ApprovalResult>
    // errors: NonceReplay, NonceStale, ActionHashMismatch, StepUpRequired,
    //         StepUpFailed, NoSuchPendingAction
}

interface PendingAction {
  actionId: string
  actionHash: string            // hash over canonical serialization of the action
  tier: 0 | 1 | 2 | 3
  requiresStepUp: boolean       // true for Tier-3, money, memory-permanence
  summary: string               // human-readable diff/summary for the card
}

interface CardTap {
  cardId: CardId
  nonce: string                 // single-use, issued with the card
  presentedActionHash: string   // echoed from the card payload
  chatId: number
  stepUpProof?: string          // passphrase/TOTP/retyped text when required
}

type ApprovalResult =
  | { decision: "confirmed"; actionId: string }
  | { decision: "rejected"; reason: string }
```

Events emitted: `inbound.span` (to Session Manager / Core), `approval.confirmed`,
`approval.rejected`, `voice.degraded`, `authz.rejected`, `rate.limited`. Events consumed:
`outbound.lockout.set` / `outbound.lockout.cleared` (from Safety, [ADR-0027](../decisions/2026-06-11-capability-narrowing-untrusted-context.md)),
`pending.action.created` (from Core/Safety), `card.dispatch` (outbound card render).

## 4. Data structures

Types and on-disk/at-rest formats the Gateway owns.

**`InboundSpan`** (see §3) — the single normalized ingress record. `provenance` is the
load-bearing field: it is written exactly once, by Gateway code, at ingestion, and is
immutable thereafter. Downstream components read it but never rewrite it.

**Provenance assignment table** (deterministic, code-fixed — not configurable, not
model-driven):

| Inbound kind | Provenance | Rationale |
|---|---|---|
| Operator-typed text message | `operator` | The user's own typed turn |
| Voice note → Whisper transcript | `untrusted` | Transcript is content, not a command ([ADR-0028](../decisions/2026-06-11-default-quarantine-external-input.md)) |
| Forwarded post | `untrusted` | Authored by a third party |
| Edited message | `untrusted` | Edits can rewrite a command after the fact |
| File / attachment contents | `untrusted` | Arbitrary external content |

**`PendingActionRecord`** (at-rest, in the approval store): `actionId`, `actionHash`,
`tier`, `requiresStepUp`, `nonce`, `nonceState` (`issued` | `consumed` | `expired`),
`issuedAt`, `expiresAt`, `summary`. The `actionHash` is computed by Core/Safety over the
*canonical, byte-stable serialization* of the action; the Gateway re-verifies it on tap.
This hash must be byte-stable for the same logical action — a non-deterministic
serialization would make a legitimate tap fail the hash check. The hash is the binding,
so its input encoding is frozen.

**`CardPayload`** (the Telegram inline-keyboard callback data): `cardId`, `nonce`,
`actionHash`. Telegram callback data is size-bounded, so the payload carries identifiers
only; the full action lives server-side in the `PendingActionRecord`. The card never
carries authority — it carries a claim that the handler verifies.

**Secrets (vault-held, never in context or env-as-plaintext):** `bot_token`, the
allowlisted `chat_id`, and any step-up secret material. These are referenced by handle,
rotated on schedule and on suspected compromise.

## 5. Behavior & control flow

### 5.1 Ingress pipeline (deterministic)

Every update runs the same fixed pipeline. Steps 1–5 are deterministic code; the only
model involvement is downstream of the Gateway entirely.

```
TelegramUpdate
  |
  v
[1] Authz: chat_id ∈ allowlist AND bot identity matches?   -- code, fail-closed
  |  no  -> AuthzRejected (drop, log, no downstream call)
  | yes
  v
[2] Inbound rate-limit / flood check                       -- code
  |  over -> RateLimited (drop, log)
  | ok
  v
[3] Classify inbound kind (text/voice/file/forwarded/edited)
  |
  +-- voice -> [3a] Whisper sidecar (sandboxed, resource-bound)
  |              ok -> transcript; down -> §5.4 degrade
  |
  v
[4] Stamp provenance per §4 table                          -- code, write-once
  |     operator  (only: operator-typed text)
  |     untrusted (voice transcript, file, forwarded, edited)
  v
[5] Normalize -> InboundSpan -> emit inbound.span          -- to Session Manager (01)
```

Provenance is assigned **before** any reasoning. An edited or forwarded message can never
acquire `operator` provenance, so a "command" that arrives via an edit or forward is
structurally data, not an instruction — this is enforced in step 4, not hoped for in a
prompt.

An operator-typed message beginning with a recognized slash command (`/status`,
`/usage`, `/context`, `/doctor`, `/consolidate`) is dispatched to the Onboarding &
Operations handler ([spec 13](13-onboarding-and-operations.md)) as an operator command;
it is never stamped `untrusted` or treated as data. The same recognition runs only on
`operator`-provenance text, so a slash command arriving via an edit or forward stays data.

### 5.2 Egress / streaming

When Core produces tokens, the Gateway streams them by editing a Telegram message in
place. Before the first token and on each lockout event, the Gateway checks the outbound
lockout state owned by Safety ([ADR-0027](../decisions/2026-06-11-capability-narrowing-untrusted-context.md)).
While any `untrusted` span is in the active context, outbound is locked: the Gateway does
not send, it surfaces a proactive approval card instead (the §1 "second operator turn"
cost). The Gateway enforces the lockout as a transport gate; it does not compute it.

Реализация начинает каждый Telegram-поток в закрытом состоянии. Agent loop
публикует code-owned событие `outbound-lockout` до первого вызова provider;
provider может публиковать `text-delta`, но не может сформировать или изменить
lockout verdict. Разрешённые дельты объединяются с ограниченной частотой и
редактируют одно сообщение. Непосредственно перед каждым `sendMessage`,
`editMessageText` и финальным документом transport повторно вызывает
`Gateway.streamReply`; ошибка Safety/lockout не превращается в незащищённую
отправку. `/stop` прерывает provider signal, очищает отложенный edit и запрещает
последующие дельты.

Параллельно с answer stream Telegram ведёт одно code-owned execution-сообщение.
Оно показывает общий lifecycle, фактически разрешённый tool или
`spawn_subagent` и terminal status, но никогда не включает args, result,
reasoning или raw error. Approval остаётся отдельной nonce/action-hash карточкой
и не подтверждается execution view. В locked turn карточка скрывает даже имя
capability и показывает только общий lifecycle. Частые события объединяются,
`/stop` блокирует дальнейшие edits, terminal status публикуется best-effort.
Накопительный расход появляется только из code-owned `turn-usage`, который Core
публикует после принятого model response. Прямое provider-событие `usage`
execution view игнорирует; оно не может подменить операторскую телеметрию.
Для action-required turn та же карточка показывает code-owned тип действия,
фазу единственной recovery-попытки и authoritative итог
`verified/unverified` из `TurnResult`. В locked turn action details скрываются.
Эта карточка остаётся наблюдением: она не подтверждает approval и не выдаёт grant.

Offline production seam поддерживает durable checkpoint этой наблюдающей
проекции. Он хранится отдельно от full-fidelity transcript и approval store:
chat/session/turn связываются только SHA-256 binding, а strict schema допускает
лишь bounded session label, общий lifecycle, безопасное имя capability,
action status и накопительный code-owned usage. Steps, args, results, reply,
reasoning, raw errors и произвольные UI-поля не принимаются даже с корректно
пересчитанным checksum.

Перед каждым Telegram I/O checkpoint сначала переходит в `pending`, после
подтверждённого ответа transport — в `delivered`. Фазы `prepared → bound →
terminal`, монотонная revision и owner id позволяют восстановить exact
`message_id` и блокируют поздний edit прежнего owner. Файл публикуется через
private temp, file fsync, atomic rename и directory fsync; unsafe permissions,
symlink, oversized, malformed, unknown-field и checksum mismatch дают quarantine.

Restart recovery допускает network I/O только при exact binding и доказанной
внешним service manager quiescence. Bound card редактируется в terminal
`interrupted`; `pending` terminal edit повторяется идемпотентно. Для
`prepared` Telegram не даёт доказать, был ли `sendMessage` принят до возврата
`message_id`, поэтому Aisy честно отправляет отдельную replacement recovery-card
и не утверждает, что возможное старое сообщение отредактировано. Corrupt,
foreign или non-quiescent state выполняет zero Telegram I/O. Optional bot seam
сначала создаёт durable `prepared` checkpoint и только затем допускает provider
work для turn с transport-owned Telegram authority. Proactive turn без
устойчивого external turn id остаётся на rollback-пути без checkpoint. По
умолчанию seam отсутствует только у прямого `aisy run`; `aisy supervise` и
установленные systemd/launchd units включают его явно.

Production startup coordinator получает не boolean «процесс остановлен», а
lease от parent supervisor по [ADR-0071](../decisions/2026-07-29-execution-recovery-parent-supervisor.md).
До state/provider/Telegram supervisor-child проходит direct inherited IPC
barrier. Новый turn выполняет `capture → durable prepared/pending →
checkpoint-bound ACK`; лишь после этого разрешены voice/download/transcription,
Telegram и provider. Фаза authority сохраняется manager-ом до ACK, поэтому
crash между capture и первым checkpoint различается от исчезнувшего bound
checkpoint: `captured-unbound + missing` можно безопасно освободить, а
`checkpoint-bound + missing` остаётся fail-closed.

Process-liveness доказывается двумя отдельными SQLite lease DB на локальной
файловой системе. Manager удерживает `BEGIN IMMEDIATE` в manager DB всю жизнь;
конкурентный manager немедленно остаётся zero-child. После `SIGKILL` lease
освобождает ядро. Новый parent получает manager lease, затем ждёт и захватывает
runtime-liveness fence **до любого чтения или repair durable state** и
удерживает его через подготовку crash recovery. Ни PID, ни `mtime`, ни stale
unlink, ни ожидание заданного времени не дают права на takeover.

Parent освобождает runtime-liveness fence только непосредственно перед exact
spawn и повторно захватывает после любого exit либо ошибки до hello. Первым
внешним эффектом каждого `aisy run`, включая прямой unsupervised rollback-путь,
является `BEGIN IMMEDIATE` в той же runtime-liveness DB; runtime удерживает его
до OS exit. Supervised child после этого обязан пройти protocol-v2 hello и
только затем получает recovery authority. Ошибка до hello или late orphan дают
zero checkpoint/vault/provider/tool/Telegram I/O.

Direct `aisy run`, уже удерживая runtime fence, выполняет nonblocking probe
manager DB. Busy manager означает немедленный release и zero-I/O exit. При
свободном manager lease direct освобождает probe и продолжает держать только
runtime fence. Поэтому direct и supervised runtime не перекрываются и видят
одно общее доказательство жизни.

При восстановлении lease повторно проверяется до и после Telegram await.
`terminal-delivered` публикуется до release-запроса, а polling, scheduler,
forward resume и goal resume начинаются только после release ACK. Missing,
corrupt, foreign, delivery-pending и потерянный lease не освобождают authority;
raw transport/manager errors сворачиваются в стабильные коды. Startup
descriptor child имеет exact shape `{version,path,dev,ino}` и удаляется из
доступного процесса окружения до сборки provider/tool adapters. Manager root,
checkpoint payload, Telegram token и credentials через него не передаются.

Каждая lease DB обязана иметь private owner/mode, exact device/inode identity и
единственную exact-schema строку `lease_meta.database_id` из 64 lowercase hex.
Неизменяемый private `<lease-db>.identity.json` имеет только
`{version:1,role,databaseId,dev,ino}` и обязан совпасть с DB, ролью и фактическим
inode/device. Symlink, подмена, anchor + missing/empty/mismatch/corrupt DB дают
fail-closed без reinit и без изменения evidence.

Bootstrap полностью инициализирует private `O_EXCL` temp до публикации, затем
использует atomic hardlink и directory fsync. После crash состояние `nlink=2`
завершается только для exact matching temp. Валидная DB без anchor допускает
создание anchor исключительно как recovery этого bootstrap crash window, а не
как общий repair. Private rollback `-journal` допускает recovery только после
exact validation; WAL/SHM и unsafe companion-файлы дают zero-mutation refusal.
NFS, SMB и другие сетевые/multi-host FS не поддерживаются. До service activation
process-level self-test на фактическом filesystem должен доказать mutual
exclusion, release после `SIGKILL` и отсутствие child overlap. Неуспешный
self-test блокирует активацию; durable quarantine по-прежнему запускает ноль
child.

Lifecycle-команды сервиса в single-user v1 выполняются оператором
последовательно. `start`, `restart`, `stop` и `uninstall` не активируют и не
удаляют файл только по фиксированному имени: присутствующий unit/plist должен
иметь private mode `0600` и byte-for-byte совпадать с текущим code-owned
генератором Aisy. Файловый CAS закрывает подмену между проверкой и удалением;
interleaving двух одновременных systemd/launchd команд отдельным lock пока не
сериализуется и остаётся неподдерживаемым операторским сценарием. Повторные
`stop/uninstall` идемпотентны, а каталог данных `AISY_HOME` эти команды не
удаляют.

Generated service policy явно задаёт пятнадцатисекундную остановку и сохраняет
ownership соответствующей OS-группы процессов; platform defaults не считаются
доказательством.

Эта гарантия относится к входящим Telegram turn с устойчивым external turn id и
execution-card checkpoint. Proactive/goal/forward-batch используют собственные
durable authority-контуры и не объявляются покрытыми Telegram checkpoint.
Manager и child пока принадлежат одному OS-пользователю; hostile same-UID
изоляция остаётся отдельным activation-решением. Варианты manager сравнены в
[отдельном предложении](../reviews/2026-07-28-telegram-execution-service-manager-options.md).

Прямой `aisy run` остаётся rollback-путём без IPC recovery authority:
supervisor-dependent `executionCheckpoint` в нём default-off, но общий
runtime-liveness fence и manager probe обязательны до
checkpoint/vault/provider/Telegram. Этот контракт не означает, что service
composition уже активирована в LIVE. Он также
не устраняет stale lock singleton writer полного transcript по
[ADR-0068](../decisions/2026-07-29-session-journal-singleton-writer.md); это
отдельный следующий production gap.

Runtime fence доказывает quiescence Node runtime, но не произвольных оторванных
descendants и не внешних sidecar effects. Перед activation обязательны
process-group/descendant evidence и отдельная проверка lifecycle/authority всех
sidecars.

Для daemon-owned Docker resources выбран отдельный proposed-контракт ADR-0089:
durable operation ledger и exact reconcile до следующего spawn. Dormant core
реализует private SQLite ledger, recovery/active supervisor epoch,
ledger-owned monotonic operation binding, фазы `prepared/attempted/bound`,
quarantine неоднозначного create и immutable-ID reconcile без растущей истории
terminal tombstones. Dormant operation-scoped coordinator, ограниченный Docker
CLI semantic adapter и code-owned expected projection builders также
реализованы. Добавлен отдельный dormant Engine HTTP transport с exact `v1.54`,
typed HTTP `404`, bounded/deep-frozen inspect и удалением контейнера/сети только
по immutable 64-символьному ID. Поверх него реализована отдельная branded
one-shot `DockerEnginePinnedSession`: exact descriptor snapshots входа,
канонический Unix socket anchor без symlink/world-write, минимум Docker Engine
29.5.2, один физический socket и строгая последовательность
`v1.54/version → info → container/network inspect`. Она не reconnect/retry,
ограничивает headers/trailers/body/JSON и fail-closed обрабатывает abort,
timeout, truncation, `Connection: close`, смену inode и daemon identity. Сессия
read-only и dormant.

Для следующего evidence-слоя pinned session умеет one-shot image inspect только
по digest-qualified reference. Exact wire — `v1.54/version → info →
images/<digest>/json` на одном socket; 200 выпускает genuine frozen evidence с
endpoint identity, 404 возвращает только typed not-found. Options/signal
проверяются descriptor-only до one-shot admission.

Genuine image evidence нормализуется отдельной dormant factory в
`DockerImageRuntimeManifestV1`. Структурный объект evidence не принимается.
Manifest фиксирует exact endpoint identity, запрошенный RepoDigest, отдельный
image config ID, `linux`, `amd64|arm64` и полный разрешённый runtime Config API
v1.54. Верхний image response остаётся open для совместимых metadata, но Config
имеет exact allowlist; неизвестные поля, accessor/Proxy/symbol, inherited
`com.aisy.*` labels и environment names вне code-owned allowlist запрещены.
Missing defaults нормализуются явно, результат deep-frozen, а Config/manifest
hash считаются manual scalar-only canonicalizer в разных доменах. Cumulative
UTF-8 и canonical form ограничены 256 KiB, граф — 16 384 узлами и depth 32.
Это read-only proof: projection sealing, ledger prepare, create/use и LIVE им
не реализованы.

Отдельный dormant parent-only recovery broker реализует atomic `removeExact`.
Он принимает только настоящий recovery ledger и exact bound resource, фиксирует
endpoint identity + recovery epoch и удерживает ledger dispatch barrier на всём
пути `version → info → inspect ID → DELETE ID → post-inspect 404` в
одной socket generation. Пустой/чужой ledger, `prepared`/`attempted`, любое
расхождение ownership/projection/object ID и непустая network дают zero DELETE.
После возможной mutation неоднозначность никогда не retry. Broker не меняет
ledger и не имеет production importer. Отдельные CLI subprocess запрещены для
mutations из-за TOCTOU.
Raw container/network Engine inspect теперь проходит общий bounded normalizer:
тот же canonical projection hash и exact ownership labels использует dormant
CLI adapter, поэтому CLI/Engine proof не расходятся. До подключения
sidecars/parent добавлен отдельный dormant code-owned semantic-plan слой.
Whisper, lease-bound Bash и restricted clone получают exact resource roster,
create order, безопасный use graph и перечень обязательных evidence manifests.
Factory принимает только точную per-sidecar commitment-схему, делает
descriptor-only bounded snapshot и WeakSet-brand, а ручной canonical hash не
вызывает унаследованный `toJSON`. Raw clone hostname/IP, аудио, instruction,
filesystem locator и Docker request в draft не входят. Whisper не может
опуститься ниже baseline ADR-0072 3 GiB/2000m/64 PID без отдельного нового
measurement evidence.

Restricted clone фиксирует порядок `attest network/gateway/worker → attach →
membership → start/wait gateway → start/wait/terminal worker → archive`.
Archive имеет конечные stream/extracted/entry/count bounds; IPAM и membership
пока только названы обязательными evidence, а не выданы за доказанные.
Semantic draft не содержит `prepareInput`, финальный projection/policy hash,
sealing или mutation authority и не импортируется production composition.
По-прежнему нужны pinned atomic create/use, Engine/IPAM/membership/archive
manifests, финальные create/inspect проекции,
authenticated current-child authority, real-Docker fault corpus и platform
evidence. Поэтому AC-02-80 и LIVE activation остаются открытыми.

Legacy child/direct Docker bypass закрыт отдельным fail-closed gate. Docker
activation variables не передаются supervised child; parent дополнительно
санитизирует окружение непосредственно перед spawn. `aisy run` и
`aisy supervise` с legacy activation возвращают только
`OWNED_DOCKER_PARENT_BROKER_REQUIRED` до создания runtime state или внешнего
I/O. Main/subagent/trigger Bash и локальный Whisper не имеют child-owned Docker
composition до подключения parent broker. Non-Docker direct run и read-only
`doctor` сохранены.

Bound-container use остаётся parent-only и dormant. Coordinator выдаёт
одноразовый genuine permit только после exact inspect durable `bound` row;
permit связан с active epoch, exact endpoint, operation, role, immutable ID и обеими
projection. Pinned Engine broker на одной socket generation выполняет только
`version → info → inspect ID → start → wait → terminal inspect → bounded logs`.
До `start` требуется состояние `created`, после `wait` — exact `exited` и тот же
exit code без OOM/error. Docker raw multiplex logs ограничены по байтам,
разделяются на stdout/stderr и проверяются как UTF-8.

После возможного `POST start` никакой отказ не разрешает повторный start:
результат остаётся `EXECUTION_UNRESOLVED`, а ledger — `bound` для restart
cleanup. Ошибка logs после доказанного terminal состояния даёт отдельный
`OUTPUT_UNRESOLVED`. Структурный/скопированный/Proxy/replayed permit, drift
ownership/projection, endpoint replacement и второй socket дают zero mutation
до start либо code-only unresolved после него. Этот слой ещё не выполняет
active cleanup и не является LIVE без parent IPC/current-child authority,
real-Docker fault corpus и production importer. При LIVE-активации wall/output
limits выводятся только из code-owned execution plan с тем же `policyHash`, а не
из model/tool input.

Parent recovery для одно-контейнерной operation очищает ledger только по genuine
cleanup outcome. Ledger permit связан с recovery epoch, exact endpoint,
operation, worker role, immutable ID и обеими projection. Pinned broker на одной
socket generation выполняет `version → info → inspect ID → DELETE? → ID-404 →
empty installation containers → empty installation networks`; DELETE не больше
одного и только по immutable ID. Final list фильтруется exact installation label,
`containers` обязательно включает stopped objects (`all=1`).

Crash после DELETE до FULL-sync clear безопасно повторяется: row остаётся
`bound`, новый проход видит absence, не повторяет DELETE, снова доказывает
installation-wide zero и очищает operation. Непустой/невалидный list,
forged/copy/Proxy/replay outcome, endpoint/epoch drift и concurrent destructive
dispatch не очищают ledger. Этот dormant критерий покрывает только operation с
одним worker-контейнером и сам по себе не включает parent IPC, restricted-clone
multi-resource cleanup, real Docker или LIVE `bash`.

Targeted recovery gate — 32/32; recovery broker + ledger coordinator — 84/84;
workspace typecheck/build и полный серийный App regression — 1652 passed / 17
skipped. Это fake Unix Engine/SQLite evidence без LIVE activation.

Recovery activation теперь имеет отдельную genuine authority. Legacy
структурный reconciler завершает только cleanup и не умеет активировать ledger.
Caller передаёт ledger genuine WeakSet-branded pinned broker, но не получает
одноразовый permit: ledger выпускает его внутренне и держит exclusive activation
barrier. Broker на одной socket generation выполняет `version → info → empty
installation containers(all=1) → empty installation networks`; непосредственно
после валидации последнего ответа, до любого внешнего await, он выпускает genuine
outcome и вызывает синхронный ledger-owned commit. Commit повторно проверяет
endpoint/epoch/zero operations и атомарно переводит manager в следующий active
epoch. Structural broker copy, forged/replay/cross-ledger, endpoint drift,
abort, non-empty/malformed list и concurrent reconcile/close оставляют recovery
fail-closed.

Targeted gate этого слоя — recovery broker 43/43, вместе с ledger coordinator
95/95; полный затронутый Docker/ledger gate 187/187; workspace typecheck/build
и полный последовательный App regression — 1663 passed / 17 skipped. Слой не
импортирован в `bin/aisy.ts`: legacy semantic command port в возвращённом epoch
остаётся только compatibility seam. До LIVE всё ещё нужны parent
manager/runtime fence, authenticated current-child IPC, genuine active
inspect/cleanup composition и real-Docker fault rehearsal.
Parent LIVE-gate дополнительно доказывает единственность canonical
installation+endpoint ledger/manager lease между процессами; локальный barrier
одного ledger не считается cross-process lock.

Parent recovery manager связывает этот recovery graph с уже
аутентифицированным parent supervisor ADR-0071. Supervisor вызывает genuine
branded manager только после захвата manager lease и child-liveness fence и до
первого child spawn. Сначала manager выполняет read-only pinned endpoint
preflight (`version → info → bounded inspect`) и дожидается drain; только после
этого он сужает active ledger в recovery. Сам этот переход не является Docker
mutation authority. Manager поддерживает только single-worker-container:
полностью `prepared` operation отменяется без Docker mutation, `attempted`
проходит genuine pinned exact discovery, `bound` — genuine pinned cleanup, а
после пустого ledger выполняется genuine pinned installation-zero activation.
Каждая Engine операция получает новый one-shot broker; CLI и структурный port
не используются как authority.

Успех остаётся внутри parent: active epoch, ledger и endpoint наружу не
возвращаются, child не получает Docker IPC. `not-yet-visible`, неизвестный или
multi-resource graph, endpoint drift, abort, malformed response и lost manager
authority дают quarantine и zero child spawn. Manager удерживает active ledger
до terminal close supervisor; ошибка close не публикуется как успешный stop.
Production adapter создаёт manager только для `aisy supervise` после явного
`aisy docker enroll` и exact opt-in. Enrollment отдельно инициализирует private
v4 ledger; runtime лишь read-only загружает существующую activation, поэтому
missing/partial state не bootstrap'ится внутри supervisor. Direct `aisy run`
отказывает до state/I/O, а child не наследует Docker config. Это делает LIVE
только startup recovery barrier и не включает LIVE sidecar, create/use, active
cleanup, restricted-clone recovery или real-Docker evidence.

Service manager передаёт ровно пять code-owned полей:
`AISY_OWNED_DOCKER_RECOVERY=1`, абсолютный
`AISY_OWNED_DOCKER_SOCKET`, один раз сгенерированный 64-hex
`AISY_OWNED_DOCKER_INSTALLATION_ID`, exact `AISY_OWNED_DOCKER_SERVER_ID` и
`AISY_OWNED_DOCKER_SERVER_VERSION`. Они не являются секретами, но не читаются
из runtime `.env`: parent обязан получить их из собственного service
environment и удалить на child boundary. Смена любого identity требует нового
offline enrollment; автоматического trust-on-first-use нет.

Production activation gate: targeted ledger/adapter/policy/manager/supervisor/
CLI doctor 101/101, Core onboarding/doctor 93/93; полный Core 2333 passed / 1
skipped, полный App 2400 passed / 18 contract-defined skipped,
typecheck/build зелёные. Полный App-корпус использует канонический forks pool 1–4:
это сохраняет real-process timing и не допускает потери worker RPC на длинном
10 000-operation coordinator fixture.

Targeted parent-manager/supervisor/recovery/IPC gate — 205/205; workspace
typecheck/build зелёные; полный последовательный App regression — 1778 passed /
18 skipped. Один timing timeout старого orphan-child fixture из первого полного
прогона не повторился: isolated case, весь real-process файл 10/10 и повторный
полный regression зелёные.

Последний targeted gate ledger/coordinator/CLI/Engine: 70/70; App
typecheck/build зелёные; полный App regression — 1136 passed / 1 skipped.
Targeted gate child-denial policy/CLI/IPC/parent: 69/69; App typecheck/build
зелёные; полный App regression — 1141 passed / 17 skipped, fixture process
leak не обнаружен.
Targeted pinned session/Engine transport gate: 55/55; App typecheck/build
зелёные; полный App regression — 1182 passed / 17 skipped, fixture process
leak не обнаружен; независимый dormant review — P0=0, P1=0.
Shared normalization/CLI/coordinator gate: 43/43; App typecheck/build зелёные;
полный App regression — 1189 passed / 17 skipped, fixture process leak не
обнаружен; независимый review — P0=0, P1=0.
Dormant parent-only `removeExact`: broker 27/27, объединённый
broker/pinned/normalizer/Engine/ledger/coordinator gate 131/131; App
typecheck/build и полный App regression 1216 passed / 17 skipped зелёные;
diff-check чистый, fixture process leak не обнаружен; независимый review —
P0=0, P1=0. Это unit/fake-daemon evidence, не real-Docker и не LIVE.
Semantic plans: три новых корпуса 29/29; вместе с существующими
Whisper/restricted-clone supervisor checks — 49/49; App typecheck/build и
diff-check зелёные; полный App regression — 1245 passed / 17 skipped (141 test
files passed / 5 skipped). Это code-contract evidence без Engine I/O, sealing и LIVE.
Перед sealing shared projection normalizer дополнительно переведён с
`JSON.stringify` целого объекта на ручную scalar-only канонизацию: inherited
`Object/Array.prototype.toJSON` не вызывается, а frozen golden hashes сохраняют
совместимость с ledger. Targeted normalizer/CLI — 22/22, полный App — 1246
passed / 17 skipped; независимый review P0=0, P1=0.
Pinned image evidence: 55/55 собственных, 104/104 объединённых Docker tests;
App typecheck/build и полный regression 1260 passed / 17 skipped зелёные.
Image-runtime manifest: 13/13 собственных, 117/117 объединённых Docker security
tests; workspace typecheck/build и полный App regression 1273 passed / 17
skipped зелёные. Это fake Unix Engine proof без sealing, ledger publication,
create/use и LIVE.
Container projection дополнительно обязана включать top-level inspect `Image`
как `sha256` image config ID, независимо от `Config.Image` create reference.
Expected, Engine и CLI paths хешируют оба значения через общий normalizer;
missing/malformed ID отказывает. Exact CLI envelope расширен с пяти до шести
полей. Gate: normalization/CLI/recovery 50/50, объединённый Docker security
132/132, workspace typecheck/build и полный App regression 1274 passed / 17
skipped; независимый review P0=0, P1=0.

Полная V1 projection применяется только после появления объекта: Docker daemon
добавляет к `Config/HostConfig/Mounts` значения, которых нет в исходном
create request. Pre-create prediction такой структуры запрещён. Отдельная
dormant selected projection V2 фиксирует только явно задаваемые и
security-relevant поля direct Engine request; post-inspect normalizer выбирает
те же поля и обязан получить тот же domain-separated hash. V1 не
переинтерпретируется, ledger schema/prepare не меняются.

V2 покрывает image ID/reference, kind/role, user/env/entrypoint/cmd/workdir,
stdin/TTY, labels без ownership, disabled healthcheck, network/runtime,
read-only rootfs, capabilities/security/userns/cgroup, IPC/PID/UTS,
memory/swap/CPU/PID, restart/log/tmpfs/ulimit, devices/ports/OOM/shm/init и exact
bind mount. Exact masked/readonly proc/sys paths, пустые sysctls и supplementary
groups обязательны; любое ослабление confinement fail closed. Только
daemon-generated `Hostname` и не влияющие на безопасность accounting fields не
входят в hash.
Observed result содержит только opaque hash и identity. Код не делает Engine
I/O, не публикует ledger и не подключён к parent/child или LIVE.
Gate: V2 8/8, объединённый Docker contract 67/67, workspace typecheck/build и
полный App regression 1282 passed / 17 skipped; fixture process leak равен
нулю, независимый review P0=0, P1=0.

Dormant create-plan layer для Whisper/Bash принимает только genuine semantic
draft, pinned image manifest и Node filesystem evidence с exact canonical
root/device/inode. Для Bash raw instruction обязан совпасть с draft SHA-256 и
byte length; для Whisper совпадают root/relative hashes. Runtime выводится
только из genuine evidence одноразовой pinned Engine session: `/info` обязан
доказать builtin seccomp и `userns`/`rootless`, наличие `runsc` даёт `full`, а
только `runc` — явный `degraded-no-gvisor`. Bash draft дополнительно связывает
exact isolation-profile hash. Inherited image volumes/ports/OnBuild запрещены.
Direct Engine request template и raw path/command остаются в private WeakMap-хранилищах,
наружу выходят endpoint/image identities, runtime/security level и
domain-separated hashes.

Plan пока нельзя consume: projection-only inspect verifier не подтверждает
будущие ownership labels и не является seal. Identity root проверяется повторно,
но не удерживается file descriptor. Engine I/O, ledger prepare, ownership
injection, create/start и LIVE отсутствуют.
Gate среза: create-plan + pinned runtime 63/63, объединённый Docker
security/contract 130/130, workspace typecheck/build и полный App regression
1290 passed / 17 skipped; независимый review P0=0, P1=0.

Ledger schema/API v4 foundation реализован. Prepared resource
хранит explicit `createProjectionContract=container-selected-v2` и
`createProjectionHash`; полный `boundProjectionHashV1` отсутствует до create и
публикуется только атомарно с object ID. Container observation вычисляет оба
hash независимо. Legacy v3 `projectionHash` не переинтерпретируется и не
мигрируется автоматически. До отдельного clone/network contract v4 prepare
принимает только Whisper/Bash worker container и отказывает clone до ledger
sequence/row mutation.
Gate: шесть интегрированных корпусов 160/160; весь Docker-oriented corpus 282
passed / 1 opt-in live smoke skipped; workspace typecheck/build; полный App
regression 1301 passed / 17 skipped; fixture leak 0; независимый review
P0=0/P1=0. Следующий слой — capability-bound one-shot seal без LIVE activation.
Предыдущий полный workspace evidence: Core 2039 passed / 1 skipped, Telegram
146 passed.
После исправления отдельной гонки test-marker полный App дважды прошёл без
failures: 1105 passed / 1 skipped и 1104 passed / 2 skipped. Python sidecars
52 passed / 1 skipped, Ruff зелёный. Это unit/fake-port proof, а не real-Docker
evidence.

Dormant POSIX primitive отдельно доказывает exit leader и отсутствие detached
process group через PID/PGID `ESRCH`; operational denial даёт code-only отказ,
а не ложный proof. Parent wiring, защита от group escape и platform self-test ещё не
готовы, поэтому этот foundation не меняет статус AC-02-80.

Статус реализации Node-runtime среза: targeted unit 79/79, real-process parent
10/10 и Telegram recovery 9/9. Полный workspace gate: `pnpm -r typecheck`,
`pnpm -r build`, `pnpm -r test -- --reporter=dot` — Core 2019 passed / 1
skipped, Telegram 146 passed, App 1013 passed / 1 skipped. Python sidecars: 52
passed / 1 skipped; Ruff зелёный. После тестов не осталось fixture-процессов.
Это offline/process evidence, не LIVE activation и не доказательство
quiescence произвольных descendants/sidecars или recovery transcript writer.

### 5.3 Approval-card lifecycle (deterministic — the only confirmer)

```
Core/Safety: pending action A, actionHash = H(canonical(A)), tier, requiresStepUp
  |
  v
[issueCard] mint nonce N (single-use), persist PendingActionRecord{nonce:issued}
  |  render card with callback data {cardId, N, H}; Tier-3 card is the red variant
  v
... human taps ...
  |
  v
[handleCardTap]  -- DETERMINISTIC HANDLER, never a model call
  | 1. nonce N exists AND state == issued ?      no -> NonceReplay / NonceStale
  | 2. presentedActionHash == stored actionHash? no -> ActionHashMismatch (abort+review)
  | 3. action still pending (not expired)?       no -> NonceStale
  | 4. requiresStepUp ?
  |       yes -> validate stepUpProof           fail -> StepUpFailed
  |                                              missing -> StepUpRequired (re-challenge)
  | 5. mark nonce consumed (atomically)          -> prevents replay of this tap
  | 6. emit approval.confirmed{actionId}         -> Core/Safety executes the action
  v
ApprovalResult: confirmed | rejected
```

Key invariants, all in code:

- A tap confirms **exactly one** action — the one whose `actionHash` it echoes. A stale
  card left in the chat scroll cannot confirm a *different* later action, because its
  hash will not match and its nonce is single-use.
- The handler is the **only** writer of "confirmed". The model can propose a `PendingAction`
  but can never produce an `ApprovalResult` ([ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md)).
- Nonce consumption is atomic and idempotent: a double-tap or a replayed callback after
  the first success is rejected as `NonceReplay`.
- An approval card not confirmed within the configured timeout transitions to `expired`
  (default-deny): the `nonceState` moves to `expired`, so a later tap returns `NonceStale`
  and confirms nothing ([ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md)).

### 5.4 Voice path и registry провайдеров

Audio передаётся выбранному `Transcriber`. Локальный Whisper работает как
process-isolated resource-bounded sidecar без сети
([ADR-0003](../decisions/2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md)); внешний
STT или model-native audio adapter проходит через disclosure/consent и egress
boundary ADR-0085. Adapter может называться model-native только когда фактически
вызываемый API принимает audio input; наличие voice UI у пользовательского
приложения этого не доказывает. Любой transcript получает `untrusted` в шаге 4.
Когда provider отсутствует или изолирован, Gateway применяет фиксированную
политику reject/queue/text-only и сообщает об этом, не выдумывает transcript и
не повышает его до `operator`. Такая деградация не блокирует text, memory, tools
или lifecycle основного harness.

Live Telegram transport сейчас использует durable media inbox как общий LIVE
capture boundary и реализует безопасный `reject/text-only` fallback: если inbox
не открылся либо provider не выбран, голос и прочие вложения получают явный
русский ответ, а отсутствующий provider не вызывает model/vendor turn. Inbox
handler покрывает document/audio/photo/video/voice/animation и сохраняет каждый
элемент album под одним captured work binding; acknowledgement объединяется в
одну bounded summary-card, максимум десять элементов. Наличие LIVE inbox/ingress
не активирует само по себе ни локальный Whisper, ни внешний provider.

### 5.5 Production-preview Whisper worker (2026-07-28)

Реализован выключенный one-shot путь транскрибации с offline Telegram
composition tests, но без подключения к `aisy run`:

1. Node adapter принимает только canonical private audio root, относительный
   path, exact SHA-256, exact size, composition-owned max bytes и optional
   language hint.
2. Для каждого запроса создаётся новый container из exact image digest. Policy
   обязана содержать `network=none`, read-only rootfs, non-root user,
   `cap-drop=ALL`, `no-new-privileges`, seccomp, `ipc=none`, PID/RAM/CPU/time
   limits, bounded tmpfs и единственный read-only bind audio root.
3. Перед запуском worker adapter проверяет фактический Docker inspect. Ослабление
   network/mount/user/capabilities/limits блокируется до передачи stdin.
4. Python worker открывает audio descriptor-relative без symlink, hardlink,
   special node или cross-device перехода и повторно проверяет digest/size до
   model call.
5. Production backend использует только локальную модель `/models/whisper` из
   закреплённого image; сеть контейнера отсутствует. Missing model возвращает
   `MODEL_UNAVAILABLE`, а не запускает download.
6. stdout — строгий versioned JSON envelope; stderr, timeout, OOM, overflow,
   malformed response и backend exceptions превращаются в code-only ошибки.
   Transcript ограничен 1 MiB и возвращается только с
   `provenance=untrusted`, `channel=voice`.
7. После любого созданного container выполняется cleanup. Неоднозначный
   `docker create` сначала проверяется по exact image/labels/policy: только
   подтверждённо свой container удаляется; неизвестная collision не удаляется
   и даёт `CLEANUP_FAILED`.
8. Offline coordinator связывает exact captured `ResolvedWorkBinding` с
   Telegram voice record, private `objects/<fileId>` и worker request. Он
   повторно проверяет record authority, size, transcript и детерминированную
   identity текущих Telegram update/message/voice, сохраняет binding в
   successful outcome и поддерживает только явные `text-only|reject` policies.
   Temporary sidecar failure не создаёт fabricated span; integrity failure не
   маскируется деградацией. Повтор после restart переиспользует durable object
   без второго Telegram download.
9. Docker adapter допускает только один resource-heavy container одновременно;
   конкурентный запрос получает `QUOTA_EXCEEDED` и проходит обычную degradation
   policy.
10. Optional bot seam обрабатывает voice внутри общего turn lifecycle: один
    captured binding передаётся coordinator-у и затем exact
    `acquireBackgroundRuntime(binding)`. Transcript входит в AgentRunner только
    как bounded `untrusted` span с transport-owned turn authority. Подмена
    outcome binding блокируется до runtime acquisition; `/stop` отменяет
    transcription тем же AbortSignal. Active или buffered text turn блокирует
    voice до download, чтобы debounce timer не создал второй concurrent turn.
11. Production composition обязана создавать inbox только через process-lifetime
    singleton writer wrapper. Владение приобретается атомарным созданием
    приватного `.writer.lock`, подтверждается exact owner token перед каждым
    ingest и завершается только тем же token после завершения всех операций.
    Возраст lock и PID не дают права на takeover: аварийно оставленный или
    повреждённый lock блокирует новый writer до отдельного doctor recovery.
12. Read-only `aisy doctor` проверяет active writer lock и число private audit
    archives, но никогда не выполняет recovery через `--fix`. Отдельный recovery
    adapter требует approval, связанный с exact owner fingerprint, и code-owned
    exclusive quiescence lease. Он атомарно переносит abandoned lock в
    `.writer-lock-recovery/recovery-<id>`, не удаляет owner evidence, fences
    прежний runtime и поддерживает exact restore без перезаписи нового writer.

Этот срез доказывает worker/isolation boundary, но не означает LIVE локальный
Whisper: image build/publish и регистрация local provider в production registry
остаются отдельным activation этапом. Provider-neutral singleton media inbox,
выбор live degrade policy и voice ingress уже подключены в `aisy.ts`; они не
дают локальному worker authority до явной регистрации provider.

### 5.5.1 LIVE Deepgram composition с переходным credential resolver

Облачный provider реализует тот же общий transcription contract, но сам не
создаёт сетевой клиент и не читает process environment. Композиция обязана
передать ему resolver имени `DEEPGRAM_API_KEY`, exact HTTPS request port и
fail-closed spend authority. Текущая production composition импортирует
Deepgram adapter, registry, media inbox и voice ingress в `aisy run`, но provider
не preselected, на целевом хосте key отсутствует, а resolver ещё читает legacy
`vault.json`. Это LIVE wiring, но не принятый production credential backend:
новая enrollment должна пройти через ADR-0098, после cutover legacy resolver
удаляется без fallback.

Registry один раз снимает immutable snapshot provider и своих dependencies.
Duplicate provider id, Proxy и accessor означают invalid registry целиком: local
safe-default не может позднее разрешиться в внешний provider с тем же id. Consent
state читается только по absolute normalized path из canonical non-symlink
directory текущего uid с mode `0700`; файл обязан быть regular, `nlink=1`, того же
device и uid, с mode `0600` и bounded size. Эти свойства и identity каталога
перепроверяются вокруг atomic publish. Privacy-narrowing выбор локального provider
немедленно закрывает текущий egress до записи state; ошибка persistence может быть
показана оператору, но не возвращает runtime в облако.

Перед egress adapter повторно открывает единственный файл private inbox с
`O_NOFOLLOW`, проверяет regular file, `nlink=1`, device, exact size и SHA-256 из
captured record. Только после этого spend authority резервирует заранее
согласованный maximum billable duration; цена и тариф не зашиваются в adapter.
Отказ или повреждение authority означает zero egress.

Структурный request ещё не является правом на внешний egress. Production
composition обязана передать genuine media-inbox capability, связанную с
exact Telegram voice/update, captured binding и закреплёнными root/device/inode
private inbox. Произвольный root, foreign record, устаревшая или повторно
использованная capability должны завершаться до resolver секрета, reservation и
HTTPS. До доказательства этого adversarial composition-тестами и cutover на
ADR-0098 wiring не считается release-ready облачной транскрипцией.

Разрешён один прямой upload bytes на exact выбранный Deepgram HTTPS host и
`/v1/listen`: без redirect, callback, remote URL, proxy-derived endpoint,
retry или provider fallback. Запрос фиксирует модель и параметры приватности;
API key существует только в `Authorization` header. Timeout, abort и response
имеют code-owned bounds, provider JSON проецируется только в bounded transcript,
language и duration. Raw body/error/secret не выходят в event или исключение.
Request port получает тот же exact response-byte limit, возвращает только уже
собранный `Uint8Array` и завершает promise лишь после signal-aware cleanup своих
upload/download/network ресурсов. Adapter ждёт это завершение без `Promise.race`.
Secret resolver и spend authority следуют тому же правилу; если reservation уже
durably создана до abort, authority возвращает handle, чтобы adapter её освободил.
HTTP response и reservation немедленно превращаются в строгие owned snapshots;
Proxy, accessor, лишние поля, SharedArrayBuffer и поздняя подмена caller-owned
bytes/function отклоняются или не влияют на обработку. Settlement является
idempotent first-terminal операцией: reject означает zero terminal commit, а
authority продолжает владеть durable pending reservation и recovery key до
успешного terminal outcome. Restart recovery genuine authority — обязательный
LIVE gate, но не часть dormant adapter.

Успех закрывает reservation фактической длительностью. Любая неопределённость
после передачи запроса закрывается как ambiguous и не возвращает reservation.
429/5xx/timeout проходят существующую `reject|text-only` деградацию без второго
запроса; 401/403, нарушение файла и protocol corruption остаются hard refusal.

External choice хранит exact `privacyRevision` и показывает, что аудио
отправляется именно Deepgram и через какой региональный endpoint. Stale revision
не активирует provider, а ошибка atomic persistence не создаёт даже временного
in-memory consent. Локальный Whisper остаётся безопасным default, но не является
автоматическим runtime fallback после ошибки Deepgram.
Best-effort `onSelect` служит только observability: consent authority — durable
state, callback не является activation boundary или обязательной audit receipt.
Обязательный audit receipt остаётся отдельным будущим архитектурным решением.

### 5.6 Пачка пересланных сообщений

Live Telegram transport отличает пересланное сообщение только по transport-
metadata. Основной признак текущего Bot API — `Message.forward_origin`;
legacy `forward_from`/`forward_from_chat` принимаются лишь для совместимости.
Имя отправителя, текст и команды внутри пересылки никогда не определяют
provenance: каждый элемент получает `untrusted` до модели. Официальный
[Telegram Bot API](https://core.telegram.org/bots/api#message) описывает
`forward_origin` как `MessageOrigin` (`user|hidden_user|chat|channel`).

Первый forwarded update атомарно создаёт private durable batch и захватывает
exact `ResolvedWorkBinding`. Каждый следующий update немедленно записывается с
`update_id`, `message_id`, исходным `message.date`, порядком и bounded text;
одинаковый retry идемпотентен, а тот же `update_id` с другими байтами или смена
Project/Session переводят batch в quarantine до model/runtime I/O. Пределы:
50 forwarded items, 2 MiB UTF-8 на всю пачку и не более десяти дополнительных
operator-инструкций. Единый журнал порядка включает оба типа элементов, поэтому
последовательность `forward → instruction → forward` не перегруппировывается
перед model turn.

Transport отправляет одну карточку `📨 Получаю сообщения (N)…` и редактирует
счётчик после каждого durable append. Quiet window равен двум секундам от
последнего принятого элемента или инструкции, а не от первого. Обычный текст,
набранный пока batch открыт, связывается с этой пачкой как `operator`-
инструкция и не может одновременно сработать как меню, Project switch либо
Session command. Если инструкции нет, код добавляет безопасную задачу по
краткому разбору; forwarded spans при этом остаются отдельными `untrusted`
данными.

После тишины весь ordered batch создаёт ровно один content-independent Telegram
turn authority и один model turn. Перед dispatch durable FSM переходит из
`collecting` в `dispatching`. Fresh process восстанавливает `collecting` и
продолжает таймер; `dispatching` после crash никогда не replay-ится автоматически,
а становится `quarantined`. После завершённого turn consumed archive сохраняет
точный fingerprint каждого forwarded item и каждой инструкции, поэтому поздний
retry любого участника не вызывает provider повторно, а изменённые байты
отклоняются. Quarantine после доставленного recovery notice архивируется отдельно
и не помечает updates как consumed: оператор может переслать ту же пачку ещё раз.
Raw provider/transport ошибки в state и Telegram не сохраняются.

Forwarded media post, включая voice, также входит в счётчик: caption сохраняется
как `untrusted`, а пост без caption получает code-owned placeholder. Один update
не передаётся параллельно в voice transcription или attachment inbox: это
исключает двойной model turn и вторую независимую запись. Анализ самих media
bytes остаётся отдельной будущей возможностью и не имитируется анализом caption.

Production composition `aisy run` подключает private atomic Node store
`telegram/forward-batch.json` (directory `0700`, state `0600`, checksum, CAS,
fsync+rename) и вызывает restart recovery до начала polling. Все mutations
защищены межпроцессным exclusive lock; занятый либо оставшийся после crash lock
останавливает запись до явного recovery, а не разрешается по возрасту файла.
Это live wiring функции batching; оно не активирует Whisper/media inbox или
остальные отложенные capabilities.

Рекомендуемый contract воспроизводимого CPU/multi-arch image, exact
dependency/model manifests и supply-chain gates вынесен в
[review proposal](../reviews/2026-07-28-whisper-image-supply-decision-proposal.md).
Он не является ADR и не разрешает build publish либо live activation.

Уточнение: singleton writer уже реализован и проверен offline; до activation
остаются operator-visible doctor recovery, image supply, live degrade policy и
composition в `aisy.ts`.

Дополнение: read-only finding подключён к настоящему `aisy doctor`, а recovery
adapter доказан offline. Его mutating CLI composition остаётся выключенной до
подключения service-manager quiescence lease и существующего approval/grant
контура.

## 6. Dependencies

Internal:

- **Core / Agent Loop (01)** — receives `InboundSpan`s via the Session Manager; produces
  the token stream the Gateway streams out and the `PendingAction`s the Gateway cards.
- **Safety (05)** — owns the injection classifier / default-quarantine verdict
  ([ADR-0028](../decisions/2026-06-11-default-quarantine-external-input.md)), the tier
  classifier and outbound lockout ([ADR-0011](../decisions/2026-06-11-autonomy-gradient.md),
  [ADR-0027](../decisions/2026-06-11-capability-narrowing-untrusted-context.md)). The
  Gateway feeds it provenance-tagged spans and obeys the lockout it computes.
- **Personality (08)** — shapes the *content* of outbound replies and the wording of
  cards; the Gateway carries that content over the transport.

External:

- **Telegram Bot API** via grammY — the sole transport. Governed by edge authz in this
  spec; no ADR mandates Telegram specifically, but [ADR-0011](../decisions/2026-06-11-autonomy-gradient.md)
  fixes the red Tier-3 confirmation card as a Telegram surface.
- **Whisper sidecar (Python)** — voice transcription, process-isolated per
  [ADR-0003](../decisions/2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md).
- **Vault** (owned by Safety) — holds `bot_token`, `chat_id`, step-up material.

## 7. Failure & degraded modes (mandatory)

| Failure | Trigger | Detection | Behavior | User sees | Recovery |
|---|---|---|---|---|---|
| **Cold start** | Process restart; no warm session | Startup self-check; no `chat_id`/token resolvable | **Fail-closed**: accept no updates, send nothing until vault secrets load and allowlist is set | Nothing until ready; first allowed message after start gets a normal reply | Vault resolves token + `chat_id`; allowlist loads; Gateway begins accepting updates |
| **Whisper sidecar down (Eng-7)** | Sidecar crashed / not started / timed out / OOM | Health probe + bounded-timeout call returns `VoiceUnavailable` | **Degrade** per configured policy: `reject` (tell user voice is off) / `queue` (hold audio, retry, bounded) / `text-only` (ask user to type). Never drop silently; never emit a transcript | "Voice is temporarily unavailable — please type" (or queued notice) | Sidecar restarts; queued audio (if `queue`) transcribed; otherwise user retypes |
| **Telegram API unreachable** | Network/API outage | Send/poll errors, retries exhausted | **Degrade + retry with backoff**; inbound buffered by Telegram's own retry; outbound retried | Delayed delivery; no data loss of inbound updates | API recovers; backlog drains |
| **Safety unavailable (no provenance/lockout consumer)** | Safety component down | Event bus / call to Safety errors | **Fail-closed on egress**: do not stream outbound (cannot confirm lockout); still stamp provenance and persist inbound | Reply delayed; "processing" state | Safety recovers; lockout state re-resolved; egress resumes |
| **Vault unavailable** | Vault down at start or rotation | Secret fetch error | **Fail-closed**: cannot operate without `bot_token`/`chat_id`; refuse to start/serve | Bot appears offline | Vault recovers; secrets re-fetched |
| **Unauthorized chat_id (CSO-H2)** | Message from non-allowlisted chat | Authz step 1 mismatch | **Fail-closed**: drop, log, no downstream call, no reply that confirms bot identity | Stranger gets no useful response | n/a (intended deny) |
| **Inbound flood / spam (CSO-H2)** | Burst exceeds rate limit | Rate-limit counter | **Throttle**: reject/queue over-limit updates, log | "Slow down" / silent throttle | Rate window resets |
| **Replayed / stale card tap (CSO-H2, ADR-0029)** | Tapping an old card, or replayed callback | Nonce state != `issued`, or expired | **Reject**: `NonceReplay` / `NonceStale`, no action taken | "This approval has expired — request a fresh card" | Core re-issues a fresh card with a new nonce |
| **Action-hash mismatch (ADR-0029)** | Tap echoes a hash != the pending action's | `presentedActionHash` != stored hash | **Reject + route to human review**: abort confirmation | "This card no longer matches a pending action" | Operator re-issues; mismatch logged for investigation |
| **Step-up missing/failed (CSO-H2, ADR-0029)** | Tier-3/money/memory-permanence tapped with no/invalid second factor | `requiresStepUp` and proof absent/invalid | **Fail-closed**: `StepUpRequired` re-challenge, then `StepUpFailed`; no confirmation | Second-factor challenge; rejection on failure | User supplies valid second factor |
| **Edited/forwarded message treated as command (CSO-H2)** | Inbound edit/forward carries imperative text | Provenance step 4 stamps `untrusted` unconditionally | **Quarantine semantics**: never `operator`, never auto-acts | Treated as data; agent may ask before acting | Operator confirms via a fresh operator turn |
| **Voice/forwarded injection vector (CSO-H5)** | Injection inside transcript/attachment | Provenance `untrusted` + downstream lockout ([ADR-0027](../decisions/2026-06-11-capability-narrowing-untrusted-context.md)) | **Degrade capability**: untrusted span never unlocks outbound, never operator-trust | Agent reasons over content but cannot send/exfiltrate | Operator turn to act on it |

## 8. Security & threat model

This component is security-relevant: it is the trust boundary. Threats below use
STRIDE / OWASP-LLM; each mitigation states what is enforced by **code** vs the model.

| Threat | Vector | Deterministic mitigation (code) | ADR |
|---|---|---|---|
| **Spoofing the operator** (STRIDE-S) | Message from an attacker chat | Single-user allowlist on `chat_id` + bot identity; authz runs before any downstream call; fail-closed | [ADR-0011](../decisions/2026-06-11-autonomy-gradient.md) |
| **Approval replay / stale tap** (STRIDE-S/T) | Replaying or re-tapping an old card to confirm something | Single-use **nonce** + **action-hash** binding each tap to one pending action; consumed atomically; mismatch/replay rejected | [ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md) |
| **Approval TOCTOU / card-for-wrong-action** (STRIDE-T) | Action swapped between card issue and tap | Tap must echo the action-hash of the *exact* pending action; mismatch aborts to human review | [ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md) |
| **Model self-confirmation** (OWASP-LLM Excessive Agency) | Model emits an `ApprovalResult` / trust flag | Only the deterministic handler writes "confirmed"; any model-set confirmation/trust field is ignored | [ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md) |
| **Click-fatigue on irreversible ops** (STRIDE-E) | One muscle-memory tap confirms a Tier-3/money/permanence op | **Step-up second factor** (passphrase/TOTP/retype) required; a plain tap is insufficient for permanence | [ADR-0011](../decisions/2026-06-11-autonomy-gradient.md), [ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md) |
| **Indirect prompt injection via voice/forward/file** (OWASP-LLM01) | Whisper transcript or forwarded/attached content carries instructions on the trusted user channel | Provenance stamped `untrusted` at ingestion regardless of channel; never `operator`, never unlocks outbound; downstream capability narrowing applies | [ADR-0027](../decisions/2026-06-11-capability-narrowing-untrusted-context.md), [ADR-0028](../decisions/2026-06-11-default-quarantine-external-input.md) |
| **Edited-message command injection** (STRIDE-T) | Editing a benign message into a command after the fact | Edited messages stamped `untrusted` unconditionally; never re-elevated to `operator` | [ADR-0028](../decisions/2026-06-11-default-quarantine-external-input.md) |
| **Sidecar compromise / resource exhaustion** (STRIDE-D/E) | Malicious audio drives the Whisper sidecar to escape or hang | Sidecar process-isolated, no network, bounded CPU/mem/time; output is untrusted text only | [ADR-0003](../decisions/2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md) |
| **Secret theft** (STRIDE-I) | Stealing the bot token / `chat_id` to impersonate or hijack | `bot_token` + `chat_id` held in vault as secrets, referenced by handle, rotated; never in plaintext context | (vault, Safety 05) |
| **Inbound flood / DoS** (STRIDE-D) | Message burst exhausts the agent | Deterministic inbound rate-limit at the edge; over-limit dropped/queued + logged | — |

What the model owns here: only outbound reply *wording* (within an already-authorized
send) and *proposing* a `PendingAction`. Authn, provenance, lockout enforcement, nonce/hash
verification, step-up, and confirmation are 100% code.

## 9. Acceptance criteria (mandatory)

Each is a single objectively verifiable assertion a Phase-3 test can check.

1. **AC-02-1** — A text message from a `chat_id` on the allowlist produces an
   `InboundSpan` with `provenance == "operator"` and `channel == "text"`.
2. **AC-02-2** — A message from a `chat_id` *not* on the allowlist produces an
   `AuthzRejected` outcome, emits no `inbound.span` event, and triggers zero downstream
   component calls (assert Session Manager mock received nothing).
3. **AC-02-3** — A voice note is transcribed via the Whisper sidecar and the resulting
   `InboundSpan` has `provenance == "untrusted"` and `channel == "voice"` (transcript is
   never stamped `operator`). *(CSO-H5)*
4. **AC-02-4** — A forwarded post and an attached file each produce an `InboundSpan` with
   `provenance == "untrusted"` (`channel == "forwarded"` / `"file"`). *(CSO-H5)*
5. **AC-02-5** — An *edited* message produces an `InboundSpan` with
   `provenance == "untrusted"` even when its text is imperative (e.g. "delete all logs");
   it is never stamped `operator`. *(CSO-H2)*
6. **AC-02-6** — When Safety reports outbound lockout, `streamReply` returns
   `OutboundBlocked` and zero tokens are sent to Telegram. Порт сохраняется, но живая
   композиция сообщает `false` всегда: ответ адресован единственному получателю —
   оператору, и подтверждать его нечем (ADR-0095). Сужение хода остаётся тем, что
   запрещает исполнять инструмент с аргументом из непроверенного текста. *(CSO-H5)*
7. **AC-02-7** — A valid first tap on an approval card whose `presentedActionHash` matches
   the pending action returns `decision == "confirmed"`, and the nonce transitions to
   `consumed`.
8. **AC-02-8** — A second tap on the same card (replay) after AC-02-7 returns `NonceReplay`
   and emits no `approval.confirmed`. *(CSO-H2, ADR-0029)*
9. **AC-02-9** — A tap on a card whose nonce has expired returns `NonceStale` and confirms
   nothing. *(CSO-H2, ADR-0029)*
10. **AC-02-10** — A tap whose `presentedActionHash` does not equal the stored pending
    action's `actionHash` returns `ActionHashMismatch`, takes no action, and logs a
    review event. *(ADR-0029)*
11. **AC-02-11** — Второй фактор действует ровно тогда, когда установка передала
    шлюзу `verifyStepUp`. Передала: для действия с `requiresStepUp == true`
    (Tier-3 / деньги / вечная память) тап без `stepUpProof` даёт
    `StepUpRequired`, неверный proof — `StepUpFailed`, ни один из них не
    порождает `approval.confirmed`; верный proof даёт `confirmed`. Не передала:
    тап оператора подтверждает карточку сам, и `proof.stepUpVerified` остаётся
    `true` — вторым фактором служит тап в приватном канале одного оператора.
    Встроенного проверяющего у шлюза нет. *(CSO-H2, ADR-0029, ADR-0104)*
12. **AC-02-12** — A `PendingAction` carrying a model-set confirmation/trust field (e.g.
    `is_human_confirmed: true`) is stripped before carding, and the only path that produces
    `approval.confirmed` is `handleCardTap`. *(ADR-0029)*
13. **AC-02-13** — Inbound updates exceeding the configured rate limit return `RateLimited`
    and are not normalized into `InboundSpan`s. *(CSO-H2)*
14. **AC-02-14** — On cold start, before vault secrets resolve, the Gateway sends no
    outbound message and emits no `inbound.span`; after `bot_token` + `chat_id` + allowlist
    load, the next allowlisted message is processed normally. *(§7 cold start)*
15. **AC-02-15** — When the Whisper sidecar is unavailable, `onUpdate` for a voice note
    follows the configured degrade policy (`reject` returns `VoiceUnavailable` with a user
    notice / `queue` persists the audio for bounded retry / `text-only` prompts the user)
    and never emits an `InboundSpan` with a fabricated transcript. *(Eng-7)*
16. **AC-02-16** — The Whisper sidecar process runs with no network access and a bounded
    time/memory limit; a transcription exceeding the limit is killed and reported as
    `VoiceUnavailable` rather than hanging the Gateway. *(CSO-H5, Eng-7)*
17. **AC-02-17** — `bot_token` and `chat_id` are read only via vault handles; a scan of the
    process environment and the assembled model context contains neither value in
    plaintext. *(CSO-H2)*
18. **AC-02-18** — A Tier-3 approval card is rendered as the distinct red variant and is
    structurally separate from any Tier 0–2 prompt, so it cannot be confirmed by the same
    callback path as a non-Tier-3 card. *(ADR-0011, ADR-0029)*
19. **AC-02-19** — When Safety is unavailable, `streamReply` fails closed (no tokens sent)
    rather than streaming without a resolvable lockout state. *(§7 Safety unavailable)*
20. **AC-02-20** — The same logical pending action serialized twice yields a byte-identical
    `actionHash`, so a legitimate matching tap passes the hash check deterministically.
    *(ADR-0029)*
21. **AC-02-21** — an operator slash command is dispatched to the Onboarding command handler
    (spec 13) and is never stamped `untrusted` or treated as data. *(spec 13)*
22. **AC-02-22** — an approval card not confirmed within the configured timeout transitions
    to `expired` (default-deny); a later tap returns `NonceStale` and confirms nothing.
    *(ADR-0029)*
23. **AC-02-23** — До первого code-owned `outbound-lockout{locked:false}` ни одна
    provider delta не сохраняется для последующей отправки и не достигает Telegram.
24. **AC-02-24** — Разрешённые `text-delta` редактируют одно Telegram-сообщение;
    `/stop` запрещает все последующие edits, а authoritative final reply заменяет
    накопленный текст без создания второго обычного ответа.
25. **AC-02-25** — Tool/subagent lifecycle редактирует одно отдельное execution-
    сообщение; args, result, reasoning и raw error не появляются в его HTML.
26. **AC-02-26** — Locked turn показывает только общий execution lifecycle без
    имени capability; `/stop` не допускает более поздний tool/subagent edit.
27. **AC-02-27** — Execution-card показывает накопительные tokens/dollars только
    после code-owned `turn-usage`; прямое provider `usage` не меняет карточку.
28. **AC-02-28** — Action-card показывает required/recovering и terminal
    verified/unverified из code-owned lifecycle/`TurnResult`; locked turn скрывает
    action kind, а карточка никогда не подтверждает approval.
29. **AC-02-29** — При отключённом media ingress document/photo/video/audio/
    animation/voice не теряются молча: transport не скачивает bytes и отвечает
    явной redacted деградацией; optional handler сохраняет каждый album item под
    captured exact binding.
30. **AC-02-30** — Album использует один binding, последовательно сохраняет не
    более десяти items и отправляет один success/partial verdict после bounded
    debounce; internal failure detail в verdict не попадает.
31. **AC-02-31** — Whisper worker до model call отклоняет path escape,
    symlink/hardlink, size/hash mismatch и duplicate JSON keys.
32. **AC-02-32** — Docker inspect подтверждает exact image, `network=none`,
    read-only/non-root/cap-drop/no-new-privileges и PID/RAM/CPU/mount limits до
    worker stdin; ослабление блокируется.
33. **AC-02-33** — timeout, OOM, malformed response, missing model и backend
    failure дают только stable code; raw stderr/exception не выходит наружу.
34. **AC-02-34** — любой успешный результат adapter имеет
    `provenance=untrusted`, `channel=voice`; transcript bounded и не может быть
    повышен caller-ом до operator.
35. **AC-02-35** — one-shot retry повторно проверяет file/hash и создаёт новый
    container; ambiguous create очищается только после exact policy inspect,
    cleanup uncertainty блокирует результат.
36. **AC-02-36** — private inbox → Whisper coordinator передаёт worker только
    code-owned object root/fileId и hash/size из exact record, доказанно
    связанного с текущими Telegram update/message/voice; successful outcome
    сохраняет captured binding и bounded `untrusted/voice` span.
37. **AC-02-37** — restart/retry того же Telegram update не скачивает bytes
    повторно, но заново запускает transcription verification.
38. **AC-02-38** — `text-only` и `reject` выбираются явно; временный sidecar
    отказ возвращает только фиксированный notice без span/raw detail, а
    integrity failure остаётся hard refusal.
39. **AC-02-39** — cancellation до ingest не выполняет download; cancellation
    после durable ingest сохраняет object для точного retry и не создаёт span.
40. **AC-02-40** — caller mutation не меняет snapshot binding, forged inbox
    authority/oversize/forged transcript блокируются до model-facing turn, а
    одновременно работает не более одного Whisper container.
41. **AC-02-41** — bot передаёт verified transcript только в runtime, полученный
    по тому же captured binding; substituted outcome не приобретает runtime и
    не создаёт model turn.
42. **AC-02-42** — `/stop` во время transcription отменяет coordinator/sidecar и
    не запускает provider; restart повторяет exact turn через durable object без
    повторного Telegram download.
43. **AC-02-43** — отсутствие optional `voiceIngress` сохраняет прежний
    fail-closed rollback: fixed text-only notice, zero download и zero model
    turn.
44. **AC-02-44** — voice при active либо buffered text turn получает fixed busy
    notice и не вызывает inbox, sidecar или runtime; один `/stop` controller не
    может быть перезаписан вторым turn.

45. **AC-02-45** — атомарный singleton writer lock допускает ровно один inbox
    writer; конкурентный процесс получает `WRITER_LOCK_HELD` до network I/O.
46. **AC-02-46** — штатная остановка завершает владение только по exact owner
    token, после чего restart переиспользует durable object без повторного
    Telegram download.
47. **AC-02-47** — срок существования записи и номер процесса не разрешают
    takeover abandoned lock; повреждённый или подменённый owner блокирует ingest.
    Отдельный случай — **оборванный захват**: директория lock есть, владельца в
    ней нет, потому что процесс убили между `mkdir` и записью владельца. Он
    отличается от повреждённого состояния (`abandoned`, не `corrupt`) и
    убирается `discardAbandoned()` без approval — отбирать не у кого, писать в
    inbox такой процесс не начинал. Тишина рантайма проверяется и здесь, а
    состояние перепроверяется под lease. Захват с владельцем этим путём не
    убирается никогда.
48. **AC-02-48** — writer lock нельзя завершить во время активного ingest;
    операция возвращает code-only `WRITER_BUSY`, а владение сохраняется.
49. **AC-02-49** — `aisy doctor` не показывает nonce/path/fingerprint и не
    предлагает `--fix` ни в одном состоянии: absent даёт pass с bounded числом
    audit archives, corrupt — high-severity fail, held и abandoned —
    предупреждение (первое нормально при работающем `aisy run`, второе
    убирается следующим запуском агента без участия человека).
50. **AC-02-50** — recovery без exact fingerprint-bound approval либо без
    exclusive quiescence lease выполняет zero filesystem mutation.
51. **AC-02-51** — approved recovery повторно проверяет owner и lease перед
    atomic rename, сохраняет exact private owner в audit archive и fences старый
    runtime до следующего download.
52. **AC-02-52** — restore создаёт active lock только при его отсутствии и exact
    archived fingerprint; новый writer никогда не перезаписывается.
53. **AC-02-53** — corrupt archive, changed owner, collision и incomplete fsync
    дают только стабильный code, raw path/owner/exception не выходит наружу.
54. **AC-02-54** — durable execution checkpoint содержит только строгую
    redacted projection и SHA-256 binding; args/result/reply/reasoning/raw error,
    raw chat id и raw turn id не записываются.
55. **AC-02-55** — stream сохраняет `pending` до каждого `sendMessage`/edit и
    `delivered` после ответа Telegram; terminal checkpoint переживает реальный
    Node restart с private permissions и valid checksum.
56. **AC-02-56** — recovery bound-card требует exact binding и quiescence,
    сначала меняет owner/revision, затем редактирует exact `message_id` в
    `interrupted`; поздняя запись прежнего owner отклоняется до network I/O.
57. **AC-02-57** — corrupt/foreign/non-quiescent checkpoint выполняет zero
    Telegram I/O, failed terminal edit остаётся `pending` и повторяется после
    restart без raw transport detail.
58. **AC-02-58** — `prepared` без `message_id` трактуется как неоднозначная
    первая доставка: recovery отправляет отдельную terminal replacement-card и
    не выдаёт её за edit недоказанного старого сообщения.
59. **AC-02-59** — `aisy doctor` читает execution checkpoint без создания
    directory/файла: absent/clean дают pass, pending/corrupt — high fail;
    `--fix` не выполняет recovery, а отчёт не содержит binding/owner/path.
60. **AC-02-60** — bot передаёт service manager только opaque SHA-256 binding
    до checkpoint/provider work; отказ capture блокирует model turn и не
    раскрывает raw service-manager error.
61. **AC-02-61** — startup recovery требует одного lease, который одновременно
    подтверждает quiescence и exact binding; потеря lease перед Telegram I/O
    выполняет zero network I/O, а release вызывается на каждом исходе.
62. **AC-02-62** — после принудительной остановки отдельного Node process fresh
    composition корректно обрабатывает `prepared-pending`, `bound-delivered`,
    `terminal-pending` и clean `terminal-delivered`: replacement/edit/retry/no-op
    выполняются по exact state без raw turn id.
63. **AC-02-63** — пять ordered updates с `forward_origin`, пришедшие быстрее
    quiet window, создают один turn с пятью `untrusted` spans в исходном порядке
    и одной code-owned/operator задачей; не возникает пяти provider calls.
64. **AC-02-64** — progress-card отправляется один раз как
    `📨 Получаю сообщения (1)…`, затем редактируется до `(5)`; Telegram edit/send
    failure не отменяет durable timer и не теряет batch.
65. **AC-02-65** — operator text во время открытой пачки входит в тот же exact
    turn как `operator` instruction, но не выполняется параллельно как menu,
    Project/Session lifecycle command.
66. **AC-02-66** — exact retry `update_id` не увеличивает счётчик; изменённые
    bytes того же update, duplicate между forward/instruction и binding switch
    дают quarantine до runtime I/O, а consumed update любого участника после
    terminal archive не создаёт второй provider turn.
67. **AC-02-67** — restart восстанавливает `collecting` с тем же binding,
    membership/order/quiet deadline; `dispatching` после crash не replay-ится и
    требует delivered recovery notice перед освобождением новой пачки.
68. **AC-02-68** — persisted state использует checksum, revision CAS, private
    permissions, межпроцессный mutation lock и bounded UTF-8;
    corruption/oversize/unsafe path/занятый lock возвращают только stable error
    без forwarded content.
69. **AC-02-69** — текущий `forward_origin` и legacy forward metadata получают
    `channel=forwarded`/`provenance=untrusted`; caption forwarded media также
    остаётся `untrusted`, forwarded voice не вызывает transcription/attachment
    как второе действие, а forwarded slash-like text не становится командой.
70. **AC-02-70** — live `aisy run` создаёт store без I/O на construction,
    вызывает recovery до polling и передаёт exact batch authority/binding в
    runtime; rollback функции — убрать `forwardBatch` dependency без изменения
    остальных text/media handlers.
71. **AC-02-71** — отдельный manager SQLite lease удерживается через
    `BEGIN IMMEDIATE` всю жизнь parent; второй manager немедленно запускает ноль
    child, не применяя PID, `mtime`, stale unlink или time-based takeover.
72. **AC-02-72** — после real-process `SIGKILL` manager новый parent
    автоматически захватывает manager lease, ждёт фактического unlock прежнего
    runtime в отдельной runtime-liveness DB и не начинает recovery/spawn раньше.
73. **AC-02-73** — parent получает runtime-liveness fence до любого state
    read/repair, удерживает через crash preparation и освобождает только перед
    exact spawn; первым внешним эффектом child является захват того же fence до
    обязательного protocol-v2 hello, а release происходит только при OS exit.
74. **AC-02-74** — pre-hello failure и late orphan выполняют zero checkpoint,
    vault, provider, tool и Telegram I/O; после любого exit и перед retry parent
    повторно получает runtime fence, поэтому ни одно окно не допускает двух
    runtime.
75. **AC-02-75** — прямой `aisy run` сначала захватывает тот же runtime-liveness
    fence, затем nonblocking probes manager DB; busy manager даёт release и
    zero-I/O exit, свободный probe освобождается отдельно. Direct и supervised
    runtime взаимно закрываются без overlap, хотя IPC recovery authority
    остаётся только у supervised child.
76. **AC-02-76** — startup descriptor child имеет exact shape
    `{version,path,dev,ino}` и scrubbed до provider/tool composition; manager
    root, checkpoint payload, identifiers сообщений и credentials отсутствуют
    во всех child startup-параметрах и IPC.
77. **AC-02-77** — обе lease DB имеют private owner/mode, exact identity и одну
    exact-schema строку `lease_meta.database_id` из 64 lowercase hex; immutable
    private `<lease-db>.identity.json` точно равен
    `{version:1,role,databaseId,dev,ino}` и совпадает с DB/device/inode.
    Symlink, inode replacement и unsafe permissions закрывают запуск stable
    code-only ошибкой.
78. **AC-02-78** — обязательный process-level activation self-test на целевой
    filesystem доказывает взаимное исключение и release после `SIGKILL`; NFS,
    SMB и иные неподдерживаемые FS блокируют service activation.
79. **AC-02-79** — restart budget/corrupt durable state сохраняют zero-child
    quarantine, а rollback отключает supervisor-dependent checkpoint без
    миграции данных; acceptance этого критерия не является доказательством
    LIVE-активации или recovery transcript writer из ADR-0068.
80. **AC-02-80** — real-process corpus отдельно доказывает завершение всей
    process group либо code-owned lifecycle каждого descendant/sidecar;
    runtime-liveness lease одного Node process не используется как косвенное
    доказательство отсутствия произвольных orphan effects.
81. **AC-02-81** — bootstrap публикует полностью initialized private `O_EXCL`
    temp через atomic hardlink + fsync; exact `nlink=2` crash-state завершается
    безопасно. Valid DB без anchor восстанавливает anchor только в этом crash
    window; anchor + missing/empty/mismatch/corrupt DB всегда отказывает без
    reinit и mutation. Private rollback `-journal` проходит только exact
    validation, а WAL/SHM и unsafe companions дают zero-mutation refusal.
82. **AC-02-82** — внешний transcription provider без bounded disclosure и
    `privacyRevision` не регистрируется; stale revision не восстанавливает
    external choice, а ошибка до atomic publish оставляет его невыбранным.
    Duplicate id, Proxy/accessor и mutation исходных provider/dependencies не
    меняют frozen registry snapshot. Unsafe path, parent ownership/mode или state
    file ownership/mode/link/device не восстанавливают external consent. Local
    revocation немедленно fence-ит текущий egress даже при ошибке durable overwrite;
    `onSelect` остаётся необязательной observability, а не consent authority.
83. **AC-02-83** — Deepgram adapter до HTTPS и spend reservation повторно
    отклоняет path escape, symlink/hardlink, non-regular file, cross-device,
    size/hash mismatch; missing secret и denied/corrupt spend authority дают
    zero network request.
84. **AC-02-84** — единственный разрешённый Deepgram request передаёт exact
    verified bytes на закреплённый HTTPS host с `redirect=error`, fixed model,
    explicit language, privacy opt-out и bounded timeout; callback, remote URL,
    retry и fallback отсутствуют. Verified file читается abort-aware chunks, а
    absolute monotonic deadline проверяется после read/secret/reserve и прямо
    перед egress.
85. **AC-02-85** — успешный bounded response возвращает только
    `untrusted/voice` transcript и закрывает reservation фактической duration;
    timeout, lost response, malformed/oversized body и HTTP refusal выполняют
    не более одного запроса и сохраняют расход ambiguous. Request port получает
    exact response cap, возвращает только collected bytes и завершает promise
    после cleanup; поздняя reservation не остаётся orphan после abort. Strict
    response/reservation snapshots не вызывают getters и не принимают Proxy,
    stream, SharedArrayBuffer или caller mutation. Settlement завершается до
    результата adapter; rejected success-settlement получает awaited ambiguous
    attempt, а authority сохраняет recovery ownership до terminal commit.
86. **AC-02-86** — API key не появляется в provider/registry state, disclosure,
    event, transcript, code-only error или JSON-сериализации публичных объектов.
87. **AC-02-87** — `bin/aisy.ts` импортирует Deepgram provider, registry, media
    inbox и voice ingress, но не preselect'ит внешний provider. На production
    target без credential/consent выполняется zero Deepgram request; legacy
    resolver является переходным wiring и после ADR-0098 cutover удаляется без
    fallback.
88. **AC-02-88** — LIVE Deepgram принимает только genuine одноразовую media-inbox
    capability, связанную с exact Telegram voice/update и закреплённым private
    inbox; arbitrary root, foreign record, stale/replay дают zero secret,
    reservation и HTTPS.
89. **AC-02-89** — bound Docker container запускается только по genuine
    одноразовому permit, связанному с exact ledger/endpoint/immutable-ID, и на
    одной socket generation проходит `version → info → inspect → start → wait →
    terminal inspect → bounded multiplex logs`. Forged/copy/Proxy/replay,
    pre-start drift и не-`created` state дают zero `POST start`; после возможного
    start abort/timeout/disconnect/mismatch не retry и сохраняют durable `bound`
    cleanup intent. Успех возвращает только bounded UTF-8 stdout/stderr и exact
    exit code; сам критерий не доказывает active cleanup, parent wiring,
    real-Docker faults или LIVE activation.
90. **AC-02-90** — parent recovery очищает single-worker-container operation из
    ledger только после genuine permit и на одной pinned socket доказывает exact
    immutable-ID ownership, не более одного DELETE, ID-404 и installation-wide
    empty containers/networks. Crash после DELETE до clear повторяется без второго
    DELETE; forged outcome, non-empty/malformed final list, endpoint/epoch drift и
    concurrent cleanup сохраняют `bound` intent и блокируют activation. Критерий
    не считается LIVE parent wiring или multi-resource cleanup.
91. **AC-02-91** — recovery→active допускается только когда ledger сам проверил
    genuine pinned broker, внутренне выдал ему одноразовый permit и получил
    genuine outcome после exact empty containers (`all=1`) и networks на одной
    pinned socket generation. Caller permit не получает; legacy structural
    reconcile остаётся в recovery. Ledger commit выполняется синхронно внутри
    continuation финального zero-proof, повторно проверяет endpoint/epoch/empty
    operations и атомарно увеличивает active generation. Structural broker
    copy, forged/replay/cross-ledger, abort, endpoint drift, non-empty/malformed
    response и concurrent reconcile/close оставляют manager в recovery. Сам
    критерий не является parent IPC, genuine active command composition или
    LIVE Docker.
92. **AC-02-92** — genuine parent recovery manager запускается после удержания
    manager lease и child-liveness fence, но до первого child spawn. Для exact
    endpoint сначала выполняется read-only pinned preflight с полным drain;
    только затем ledger сужается в recovery, и этот переход сам не является
    mutation authority. Для single-worker-container manager детерминированно
    обрабатывает `prepared → clear`,
    `attempted → exact pinned discovery`, `bound → exact pinned cleanup` и затем
    genuine installation-zero activation; каждый Engine broker одноразовый.
    `not-yet-visible`, multi-resource/unknown graph, structural manager copy,
    endpoint/authority drift, abort и transport ambiguity дают zero child spawn
    и сохраняют recovery intent. Active epoch/ledger/endpoint не выдаются child,
    manager закрывается до освобождения parent fences, а close failure не
    маскируется успешным stop. Production construction разрешён только
    отдельным AC-02-95 и не заменяет current-child IPC, active use/cleanup или
    real-Docker rehearsal.
93. **AC-02-93** — Карточка подтверждения предлагает ровно два выбора —
    «✅ Разрешить» и «❌ Отменить» — одними и теми же словами на всех тирах
    (ADR-0101). Кнопок длящегося разрешения на карточке нет: даже когда
    code-owned Safety передал safe similarity projection, набор кнопок не
    меняется. На Tier-3 те же две кнопки, и в установке без `verifyStepUp`
    «Разрешить» подтверждает действие сразу (ADR-0104); карточка не обещает
    второго шага. Remembered scope Tier-3 не возвращает никогда. Там, где второй
    фактор включён, сообщение с кодом удаляется из чата — и когда код подошёл, и
    когда нет.

94. **AC-02-94** — JSON-путь закреплённого egress проходит тот же гантлет, что
    и текстовый: не-https, порт, credentials в URL, хост вне списка, приватный
    адрес после DNS, превышение размера и таймаут дают стабильный отказ.
    Собственные границы пути: заголовки только из списка
    (`authorization`, `x-api-key`, `content-type`, `accept`), значение с CR/LF
    не доходит до сокета, тело ≤ 32 КБ и только с `POST` с явным
    `content-length` в байтах, ответ обязан быть `application/json`, редирект
    не отслеживается. Учётные данные в query отвергаются тем же детектором
    секретоподобных строк, что стоит на поисковом запросе (ADR-0096).
95. **AC-02-95** — `aisy docker enroll` по explicit exact config создаёт private
    v4 ledger отдельно от supervisor и без Docker mutation/child spawn.
    `aisy supervise` не выполняет bootstrap: он read-only загружает exact
    installation + daemon + Unix-socket activation, передаёт genuine manager
    parent supervisor и завершает recovery до первого child. Disabled config
    выполняет zero filesystem/Docker I/O; partial config, missing enrollment,
    endpoint drift и direct `aisy run` дают code-only отказ до runtime state.
    Все `AISY_OWNED_DOCKER_*` и `DOCKER_*` удаляются из child env. Этот критерий
    `aisy doctor --only=sidecars` read-only проверяет exact config, enrolled
    ledger и pinned daemon identity без enrollment/repair/writer lease/mutation.
    Этот критерий активирует только recovery barrier: child не получает active
    epoch, create/use/active cleanup и multi-resource sidecar остаются dormant.
96. **AC-02-96** — Ответ агента доходит до оператора отформатированным: жирный,
    курсив, зачёркнутый, спойлер, код, блок кода с подсветкой по языку, ссылка,
    цитата (длиннее порога — сворачиваемая). Заголовок становится жирной
    строкой, список — точками, таблица — строками через разделитель: этих
    сущностей у Telegram нет. На выходе не бывает тега вне списка Bot API, а
    незакрытая конструкция остаётся экранированным текстом — стрим отдаёт ответ
    по мере набора, и незакрытый тег означал бы 400 на каждом втором ходу.
    Ссылка принимается только с http(s); адрес экранируется вместе с кавычкой.
97. **AC-02-97** — Карточка работы несёт **одни** часы — в заголовке, за весь
    ход. Строки действий печатаются без собственного счётчика и человеческими
    подписями (`✅ читаю файл`, `▶️ выполняю команду`); имя неизвестного
    инструмента показывается как есть. Строка размышления — `🧠 Думаю` без
    времени. Секунды печатаются по-русски: `12,4 с`.
98. **AC-02-98** — Карточка подтверждения называет действие словами из того же
    словаря, что и карточка работы: `bash(git push origin main)` показывается
    как «Выполню команду: `git push origin main`». Незнакомая форма печатается
    как есть. Причина и риск выводятся только когда заполнены; идентификаторы
    сессии и действия на карточке не печатаются. Исход, который выбрал не
    оператор — истёкшая карточка, повторный тап, изменившееся действие,
    неподошедший код — называет свою причину, а не общее «Отклонено» (ADR-0101).
99. **AC-02-99** — Интерфейс говорит по-русски. В тексте любого экрана и в
    подписи любой кнопки нет латиницы, кроме имён собственных из закрытого
    списка (Telegram, MCP, SSH, Deepgram, Claude, OpenRouter, RSS, HTTPS, UTC и
    подобных), адресов, путей и имён переменных окружения. Подпись кнопки
    не длиннее `BUTTON_LABEL_MAX` символов — иначе телефон сжимает её в
    нечитаемую полоску. Проверяется по выходу рендереров, а не по намерению.
100. **AC-02-100** — Один смысл назван одним словом. Режим работы описан
    единственным словарём (`MODE_TEXT`) — подпись кнопки, строка состояния и
    пояснение берутся оттуда же, поэтому кнопка и текст под ней не могут
    разойтись. Устаревший экран и неподключённый раздел отвечают каждый одной
    фразой на весь бот. Список сервисов, сессий и MCP-серверов существует на
    экране один раз — клавиатурой, а не текстом и клавиатурой сразу.
101. **AC-02-101** — явное снятие `RESTART_BUDGET_EXHAUSTED` требует exact
    operator acknowledgement, эксклюзивных manager lease и runtime-liveness
    fence до чтения checksummed state. Команда сохраняет authority/release
    receipt, очищает crash window, счётчик и quarantine и фиксирует доказанную
    quiescence через `manager.cleanShutdown=true`. Только внутри того же запуска
    exact видимый post-rename результат, связанный checksum/revision, закрепляется
    следующей ревизией. Уже очищенный state, missing/corrupt state, busy
    manager/runtime и любой другой quarantine дают zero-mutation code-only отказ.
102. **AC-02-102** — Необработанная runtime-ошибка оставляет в обычном Telegram
    ровно одну execution-card «Не получилось ответить» с рабочей одноразовой
    кнопкой «Повторить». В ней нет exception message/class/schema, таймера,
    workspace, tool history или verification/recovery wording; server-side
    checkpoint сохраняет content-redacted фазу для диагностики. Если
    существующую карточку технически
    нельзя переиспользовать, fallback-сообщение содержит только «Не получилось
    ответить · Попробуй ещё раз.» и ту же кнопку, без внутренней detail.
103. **AC-02-103** — После unexpected exit дочернего runtime code-owned backoff
    удерживает referenced timer родительского процесса. Real-process parent без
    вспомогательных interval/stdout/IPC handles не завершается с Node exit 13
    (`unsettled top-level await`), не перекладывает обычный child restart на
    service manager и после задержки запускает ровно один replacement child.

## 10. Open questions

- **Step-up factor selection.** Which concrete second factor (passphrase vs TOTP vs
  retype-the-action) is the day-one default, and how it is recovered if lost, is deferred
  to Safety (05) / SECURITY policy per [ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md).
- **Voice degrade default.** Whether `reject`, `queue`, or `text-only` is the shipped
  default for Eng-7 (and the queue bound) is a configuration decision left to the roadmap;
  the spec requires only that one fixed policy be enforced and surfaced.
- **Multi-surface ingress.** This spec covers Telegram only. An IDE or web ingress would
  reuse the same provenance and approval-handler invariants; that extension is out of scope
  for this milestone.

## 11. References

- ADRs:
  - [ADR-0003 — Monorepo (pnpm) with TS core + Python sidecars](../decisions/2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md)
  - [ADR-0011 — Autonomy gradient (tiers 0–3)](../decisions/2026-06-11-autonomy-gradient.md)
  - [ADR-0027 — Capability narrowing when untrusted content is in context](../decisions/2026-06-11-capability-narrowing-untrusted-context.md)
  - [ADR-0028 — Default-quarantine for external input](../decisions/2026-06-11-default-quarantine-external-input.md)
  - [ADR-0029 — Human-confirmation provenance and approval integrity](../decisions/2026-06-11-human-confirmation-provenance-binding.md)
  - [ADR-0014 — Narrow-waist tool set](../decisions/2026-06-11-narrow-waist-tool-set.md) (normalized ingress shape)
  - [ADR-0071 — Parent supervisor](../decisions/2026-07-29-execution-recovery-parent-supervisor.md)
  - [ADR-0089 — Восстановление внешних ресурсов sidecar](../decisions/2026-08-01-durable-external-sidecar-resource-recovery.md)
- Concept docs:
  - [Safety Layer](../concepts/safety-layer.md)
