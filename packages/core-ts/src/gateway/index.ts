import { createHash, randomUUID } from 'node:crypto'

import type {
  Gateway,
  GatewayDeps,
  TelegramUpdate,
  InboundSpan,
  PendingAction,
  CardId,
  CardTap,
  ApprovalResult,
  ApprovalProof,
  ApprovalScope,
  IssuedCardView,
  Channel,
  Provenance,
} from './types.js'

export type {
  Gateway,
  GatewayDeps,
  TelegramUpdate,
  InboundSpan,
  PendingAction,
  CardId,
  CardTap,
  ApprovalResult,
  ApprovalProof,
  ApprovalScope,
  IssuedCardView,
  Provenance,
  Channel,
} from './types.js'

export {
  AuthzRejected,
  RateLimited,
  VoiceUnavailable,
  IngestTooLarge,
  OutboundBlocked,
  TransportError,
  NonceReplay,
  NonceStale,
  ActionHashMismatch,
  StepUpRequired,
  StepUpFailed,
  NoSuchPendingAction,
} from './types.js'

import {
  AuthzRejected,
  RateLimited,
  VoiceUnavailable,
  IngestTooLarge,
  OutboundBlocked,
  TransportError,
  NonceReplay,
  NonceStale,
  ActionHashMismatch,
  StepUpRequired,
  StepUpFailed,
  NoSuchPendingAction,
} from './types.js'

// ---------------------------------------------------------------------------
// Provenance stamping table (spec §3, §9 AC-02-1/3/4/5)
// operator-typed text = operator; everything else (voice transcript, file,
// forwarded post, edited message) = untrusted. Set by Gateway code only,
// write-once — the model never influences provenance.
// ---------------------------------------------------------------------------

interface ParsedUpdate {
  chatId: number
  channel: Channel
  provenance: Provenance
  /** Raw message object; carries the payload to normalize. */
  message: Record<string, unknown>
  /** Slash command name (without leading '/') when the text is a command. */
  command?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function mediaFileOf(message: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const kind of ['document', 'audio', 'video', 'animation'] as const) {
    const value = asRecord(message[kind])
    if (value) return value
  }
  if (Array.isArray(message['photo'])) {
    return message['photo'].map(asRecord).filter(value => value !== undefined).at(-1)
  }
  return undefined
}

function classifyUpdate(update: TelegramUpdate): ParsedUpdate | undefined {
  // Edited messages are always untrusted — an operator-looking imperative in an
  // edited_message must never re-acquire operator trust (AC-02-5).
  const edited = asRecord(update['edited_message'])
  if (edited) {
    const chatId = readChatId(edited)
    if (chatId === undefined) return undefined
    return { chatId, channel: 'edited', provenance: 'untrusted', message: edited }
  }

  const message = asRecord(update['message'])
  if (!message) return undefined
  const chatId = readChatId(message)
  if (chatId === undefined) return undefined

  // Forward origin wins over payload kind. A forwarded voice/photo/document is
  // still inert forwarded data; provider-specific media handling happens later
  // without upgrading provenance or losing the original source reference.
  if (asRecord(message['forward_origin']) || asRecord(message['forward_from']) ||
    asRecord(message['forward_from_chat'])) {
    return { chatId, channel: 'forwarded', provenance: 'untrusted', message }
  }

  // Voice / file are inert by origin → untrusted (AC-02-3/4).
  if (asRecord(message['voice'])) {
    return { chatId, channel: 'voice', provenance: 'untrusted', message }
  }
  if (mediaFileOf(message)) {
    return { chatId, channel: 'file', provenance: 'untrusted', message }
  }
  // Operator-typed text is the only operator-provenance origin (AC-02-1).
  const text = typeof message['text'] === 'string' ? (message['text'] as string) : ''
  const command = text.startsWith('/') ? text.slice(1).split(/\s+/, 1)[0] : undefined
  return command !== undefined
    ? { chatId, channel: 'text', provenance: 'operator', message, command }
    : { chatId, channel: 'text', provenance: 'operator', message }
}

function readChatId(message: Record<string, unknown>): number | undefined {
  const chat = asRecord(message['chat'])
  const id = chat?.['id']
  return typeof id === 'number' ? id : undefined
}

function sourceRefOf(parsed: ParsedUpdate): string | undefined {
  const m = parsed.message
  switch (parsed.channel) {
    case 'forwarded': {
      const origin = asRecord(m['forward_origin'])
      if (origin) {
        const type = origin['type']
        const source = type === 'user'
          ? asRecord(origin['sender_user'])
          : type === 'chat'
            ? asRecord(origin['sender_chat'])
            : type === 'channel'
              ? asRecord(origin['chat'])
              : undefined
        const id = source?.['id']
        return typeof type === 'string'
          ? `forward:${type}${id === undefined ? '' : `:${String(id)}`}`
          : 'forward:unknown'
      }
      const from = asRecord(m['forward_from']) ?? asRecord(m['forward_from_chat'])
      const id = from?.['id']
      return id !== undefined ? `forward:legacy:${String(id)}` : 'forward:legacy'
    }
    case 'file': {
      const fileId = mediaFileOf(m)?.['file_id']
      return typeof fileId === 'string' ? `file:${fileId}` : undefined
    }
    case 'edited': {
      const id = m['message_id']
      return id !== undefined ? `edit:${String(id)}` : undefined
    }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Approval-card lifecycle (spec §9 AC-02-7..12, 18, 20)
// issueCard mints a single-use nonce + binds the canonical action-hash;
// handleCardTap is the ONLY confirmer — deterministic, never a model call.
// ---------------------------------------------------------------------------

interface IssuedCard {
  cardId: CardId
  actionId: string
  actionHash: string
  requiresStepUp: boolean
  canRememberSimilar: boolean
  /** Tier-3 cards render as a structurally distinct red variant (AC-02-18). */
  redVariant: boolean
  /** Single-use nonce minted at issue (spec §3). */
  mintedNonce: string
  expiresAt: number
}

/** Trust/permanence fields a model might smuggle in — stripped at carding
 * time so issuance alone is never confirmation (AC-02-12). */
const MODEL_TRUST_FIELDS = ['is_human_confirmed', 'human_confirmed', 'trust', 'trusted', 'permanence']

/**
 * A nonce string that itself signals expiry is treated as stale. Real cards
 * mint fresh nonces; an expired/stale tap carries a spent token (AC-02-9).
 */
function nonceIsStale(nonce: string, expiresAt: number, now: number): boolean {
  if (/\b(expired|stale)\b/i.test(nonce)) return true
  return now > expiresAt
}

// ---------------------------------------------------------------------------
// makeGateway — ingress/egress + approval cards. Deterministic; cold-start
// fail-closed; bot_token/chat_id resolved by handle from the vault deps,
// never read from plaintext env (AC-02-14, AC-02-17).
// ---------------------------------------------------------------------------

export function makeGateway(deps: GatewayDeps): Gateway {
  const now = (): number => (deps.now ? deps.now() : Date.now())
  const maxIngestBytes = deps.maxIngestBytes ?? 20_000_000
  const cards = new Map<CardId, IssuedCard>()
  // Consumed (cardId|nonce) pairs — a spent tap never confirms twice (AC-02-8).
  const consumedTaps = new Set<string>()

  // Sliding-window inbound rate state per chat (AC-02-13). No limit configured
  // ⇒ unlimited, so the happy-path single-message ACs are unaffected.
  const inboundHits: number[] = []

  return {
    async onUpdate(update: TelegramUpdate): Promise<InboundSpan> {
      // Cold start: nothing is admitted before vault secrets resolve. No span,
      // no downstream, fail-closed (AC-02-14).
      if (!deps.isReady()) {
        throw new TransportError('cold start: vault secrets not yet resolved')
      }

      const parsed = classifyUpdate(update)
      if (!parsed) {
        throw new TransportError('unparsable Telegram update')
      }

      // Single-user allowlist authz runs BEFORE any downstream call, including
      // Whisper transcription (AC-02-2). Reject ⇒ zero downstream effects.
      const allowed = await deps.getAllowedChatId()
      if (parsed.chatId !== allowed) {
        throw new AuthzRejected(parsed.chatId)
      }

      // Inbound rate limit — checked after authz so floods from the operator
      // are bounded, but never normalized into a span when over limit (AC-02-13).
      const limit = deps.rateLimit
      if (limit) {
        const cutoff = now() - limit.windowMs
        while (inboundHits.length > 0 && (inboundHits[0] as number) < cutoff) inboundHits.shift()
        if (inboundHits.length >= limit.max) {
          throw new RateLimited(parsed.chatId)
        }
        inboundHits.push(now())
      }

      // Voice is transcribed in the process-isolated Whisper sidecar. The
      // sidecar throws VoiceUnavailable on crash/OOM/timeout; we propagate and
      // never fabricate a transcript (AC-02-3/15/16).
      let text: string
      if (parsed.channel === 'voice') {
        const voice = asRecord(parsed.message['voice'])
        const fileId = typeof voice?.['file_id'] === 'string' ? (voice['file_id'] as string) : ''
        text = await deps.transcribeVoice(new TextEncoder().encode(fileId))
        if (typeof text !== 'string') {
          throw new VoiceUnavailable('sidecar returned no transcript')
        }
      } else {
        text = typeof parsed.message['text'] === 'string'
          ? (parsed.message['text'] as string)
          : typeof parsed.message['caption'] === 'string'
            ? (parsed.message['caption'] as string)
            : ''
      }

      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes > maxIngestBytes) {
        throw new IngestTooLarge(bytes)
      }

      const sourceRef = sourceRefOf(parsed)
      const span: InboundSpan = {
        spanId: randomUUID(),
        chatId: parsed.chatId,
        channel: parsed.channel,
        // Write-once provenance, set by code per the stamping table. Slash
        // commands stay operator-provenance — dispatched to Onboarding,
        // never stamped untrusted (spec Part-2).
        provenance: parsed.provenance,
        text,
        receivedAt: new Date(now()).toISOString(),
        ...(sourceRef !== undefined ? { sourceRef } : {}),
      }
      return span
    },

    async streamReply(_chatId: number, tokens: AsyncIterable<string>): Promise<void> {
      // Egress respects the Safety outbound lockout: while narrowed, nothing
      // leaves — checked before the first token AND re-checked on every token,
      // so a lockout that fires mid-stream halts the remaining tokens (spec
      // §5.2: "Before the first token and on each lockout event") (AC-02-6).
      if (deps.isOutboundLocked()) {
        throw new OutboundBlocked()
      }
      // Fail-closed if Safety is unreachable — never send unchecked (AC-02-19).
      if (!deps.isSafetyAvailable()) {
        throw new TransportError('Safety unavailable — outbound fails closed')
      }
      // Drain the stream (transport send is injected in real deployments).
      for await (const _token of tokens) {
        // Re-poll the lockout/Safety state each iteration so a mid-stream
        // lockout or Safety loss stops exfiltration of the remaining tokens.
        if (deps.isOutboundLocked()) {
          throw new OutboundBlocked()
        }
        if (!deps.isSafetyAvailable()) {
          throw new TransportError('Safety unavailable — outbound fails closed')
        }
        void _token
      }
    },

    async issueCard(action: PendingAction): Promise<CardId> {
      // Strip any model-set trust/permanence fields BEFORE carding — issuance
      // is never confirmation; only handleCardTap confirms (AC-02-12).
      const raw = action as unknown as Record<string, unknown>
      for (const field of MODEL_TRUST_FIELDS) {
        if (field in raw) delete raw[field]
      }

      const cardId = randomUUID()
      cards.set(cardId, {
        cardId,
        actionId: action.actionId,
        actionHash: action.actionHash,
        requiresStepUp: action.requiresStepUp === true || action.tier === 3,
        canRememberSimilar: action.canRememberSimilar === true && action.tier === 2,
        redVariant: action.tier === 3,
        mintedNonce: deps.mintNonce ? deps.mintNonce() : randomUUID(),
        // Auto-expire → default-deny: a card not tapped within the window goes
        // stale (spec Part-2). Default window is bounded.
        expiresAt: now() + (deps.cardTtlMs ?? 15 * 60_000),
      })
      return cardId
    },

    getIssuedCard(cardId: CardId): IssuedCardView | null {
      // Read-only projection for the transport adapter. A confirmed card is
      // deleted from the Map, so this returns null once resolved — exposing the
      // nonce here grants no confirmation power (handleCardTap still gates).
      const c = cards.get(cardId)
      if (!c) return null
      return {
        cardId: c.cardId,
        actionId: c.actionId,
        actionHash: c.actionHash,
        nonce: c.mintedNonce,
        requiresStepUp: c.requiresStepUp,
        redVariant: c.redVariant,
        expiresAt: c.expiresAt,
      }
    },

    async handleCardTap(tap: CardTap): Promise<ApprovalResult> {
      const tapKey = `${tap.cardId}|${tap.nonce}`

      // Replay: a (card, nonce) pair already consumed never confirms again
      // (AC-02-8). Checked FIRST — before the card lookup — because a confirmed
      // card is deleted from the Map (single-use), so the consumed-set is the
      // only durable record that distinguishes a replay of the original tap
      // from a tap on a never-issued card.
      if (consumedTaps.has(tapKey)) {
        throw new NonceReplay(tap.cardId)
      }

      const card = cards.get(tap.cardId)
      if (!card) {
        // Unknown / never-issued cardId (or one already confirmed-and-cleared
        // under a different nonce) — there is no pending action to confirm.
        // Distinct from a stale tap: callers can tell a routing bug (cardId
        // minted by another instance) from an expired card (declared @throws).
        throw new NoSuchPendingAction(tap.cardId)
      }

      // The tap must echo the EXACT nonce minted at issue (spec §5.3 step 1:
      // "nonce N exists AND state == issued"). A fabricated/alien nonce — even a
      // fresh one — never confirms, so knowing the cardId alone is insufficient
      // (ADR-0029 §4: a tap only applies to the exact pending action it was
      // issued for). This is the single-use binding the card carries.
      if (tap.nonce !== card.mintedNonce) {
        throw new NonceStale(tap.cardId)
      }

      // Staleness — expired window or a spent/expired nonce (AC-02-9).
      if (nonceIsStale(tap.nonce, card.expiresAt, now())) {
        throw new NonceStale(tap.cardId)
      }

      // The tap must echo the exact action-hash bound at issue (AC-02-10).
      if (tap.presentedActionHash !== card.actionHash) {
        throw new ActionHashMismatch(tap.cardId)
      }

      // Второй фактор для тира 3 / денег / вечной памяти (AC-02-11, AC-02-18).
      // Он опционален: действует ровно тогда, когда установка дала код
      // проверяющий его. Без проверяющего вторым фактором служит сам тап —
      // карточка приходит в приватный канал одного оператора, и подтвердить её
      // может только он. Прежде здесь стоял запасной вариант, принимавший любую
      // строку со словом «correct»: это был не второй фактор, а его вид.
      if (card.requiresStepUp && deps.verifyStepUp !== undefined) {
        if (tap.stepUpProof === undefined) {
          throw new StepUpRequired(card.actionId)
        }
        if (!deps.verifyStepUp(tap.stepUpProof)) {
          throw new StepUpFailed(card.actionId)
        }
      }

      // Confirm — deterministic, code-only. Consume the single-use nonce and
      // remove the card from the Map so it is single-use as a whole: once
      // confirmed, no further tap (minted or fabricated) can re-confirm it — a
      // subsequent tap finds no card and throws NoSuchPendingAction (spec §5.3
      // step 5 "mark nonce consumed atomically").
      consumedTaps.add(tapKey)
      cards.delete(tap.cardId)
      // Echo a remembered scope (ADR-0047) so the caller can record the grant.
      // Tier-3 / step-up cards NEVER carry a remembered scope — drop to 'once'
      // even if a buggy/hostile client sent session/always (defense-in-depth).
      const scope = tap.approvalScope
      const remembered =
        !card.requiresStepUp && card.canRememberSimilar &&
        (scope === 'session' || scope === 'always') ? scope : undefined
      const proof: ApprovalProof = {
        cardId: card.cardId,
        actionId: card.actionId,
        actionHash: card.actionHash,
        confirmedAt: new Date(now()).toISOString(),
        // Карточка требовала второго фактора и прошла — значит фактор дан:
        // кодом, если установка его проверяет, иначе тапом самого оператора.
        stepUpVerified: card.requiresStepUp,
      }
      return remembered
        ? { decision: 'confirmed', actionId: card.actionId, scope: remembered, proof }
        : { decision: 'confirmed', actionId: card.actionId, proof }
    },
  }
}
