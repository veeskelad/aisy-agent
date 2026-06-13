# Component 02: Gateway / Connectivity — Specification

**Status:** Draft
**Component:** 02 / 12
**Related ADRs:** ADR-0003, ADR-0011, ADR-0014, ADR-0027, ADR-0028, ADR-0029
**Depends on:** Core / Agent Loop (01), Safety (05), Personality (08)

> The Gateway is the only ingress/egress edge of the harness: it authenticates the
> single operator on Telegram, ingests text, voice, files, and forwarded posts as
> provenance-tagged spans, transcribes voice through a sandboxed Whisper sidecar,
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
have a trustworthy input, (3) sandbox and resource-bound the Whisper sidecar so voice
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
- **Voice ingestion**: hand audio to the sandboxed Whisper sidecar
  ([ADR-0003](../decisions/2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md)) and treat
  the returned transcript as `untrusted` text.
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

### 5.4 Voice path and Whisper sidecar

Audio is handed to the Whisper sidecar as a process-isolated, resource-bounded call
([ADR-0003](../decisions/2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md)). The sidecar
runs with no network, bounded CPU/memory/time, and produces **untrusted text only** — its
output is stamped `untrusted` in step 4 exactly like any other external content. When the
sidecar is unavailable (§7, Eng-7), the Gateway degrades per a fixed, configured policy
(reject / queue / text-only fallback) and tells the user; it never silently drops the
voice note and never promotes a transcript to `operator`.

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
6. **AC-02-6** — When any `untrusted` span is in the active context and Safety reports
   outbound lockout, `streamReply` returns `OutboundBlocked` and zero tokens are sent to
   Telegram. *(CSO-H5)*
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
11. **AC-02-11** — For a pending action with `requiresStepUp == true` (Tier-3 / money /
    memory-permanence), a tap with no `stepUpProof` returns `StepUpRequired` and an invalid
    proof returns `StepUpFailed`; neither emits `approval.confirmed`. A valid proof returns
    `confirmed`. *(CSO-H2, ADR-0029)*
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
- Concept docs:
  - [Safety Layer](../concepts/safety-layer.md)
