// Types for Component 02: Gateway / Connectivity
// Extracted from spec §3. Pure interfaces — no implementation.

export type Provenance = 'operator' | 'untrusted'

export type Channel =
  | 'text'       // typed Telegram message from the operator
  | 'voice'      // Whisper transcript (always untrusted)
  | 'file'       // attachment contents (always untrusted)
  | 'forwarded'  // forwarded post (always untrusted)
  | 'edited'     // edited message (always untrusted)

export interface InboundSpan {
  spanId: string
  chatId: number
  channel: Channel
  provenance: Provenance       // set by Gateway code only
  text: string                 // post-Whisper for voice; raw for text
  sourceRef?: string           // forwarder, file name, message id
  receivedAt: string           // ISO-8601, code clock
}

/**
 * Opaque identifier returned by issueCard and echoed in CardTap.
 */
export type CardId = string

export interface PendingAction {
  actionId: string
  actionHash: string           // hash over canonical serialization of the action
  tier: 0 | 1 | 2 | 3
  requiresStepUp: boolean      // true for Tier-3, money, memory-permanence
  summary: string              // human-readable diff/summary for the card
}

export interface CardTap {
  cardId: CardId
  nonce: string                // single-use, issued with the card
  presentedActionHash: string  // echoed from the card payload
  chatId: number
  stepUpProof?: string         // passphrase/TOTP/retyped text when required
}

export type ApprovalResult =
  | { decision: 'confirmed'; actionId: string }
  | { decision: 'rejected'; reason: string }

/**
 * Read-only projection of an issued card, for the transport adapter to render
 * the approval message and build its callback_data. Exposes the minted nonce
 * and bound action-hash to in-process trusted code only; it confers no
 * confirmation power (handleCardTap remains the sole confirmer).
 */
export interface IssuedCardView {
  cardId: CardId
  actionId: string
  actionHash: string
  nonce: string                // the single-use nonce minted at issue
  requiresStepUp: boolean
  redVariant: boolean          // Tier-3 renders as the distinct red card
  expiresAt: number            // epoch ms; informational countdown / liveness
}

/**
 * Opaque raw Telegram update. The Gateway is the sole consumer; downstream
 * components never see this type.
 */
export type TelegramUpdate = Record<string, unknown>

// ---- Named errors ----

export class AuthzRejected extends Error {
  override readonly name = 'AuthzRejected'
  constructor(public readonly chatId: number) {
    super(`AuthzRejected: chat_id ${chatId} not on allowlist`)
  }
}

export class RateLimited extends Error {
  override readonly name = 'RateLimited'
  constructor(public readonly chatId: number) {
    super(`RateLimited: chat_id ${chatId} exceeded inbound rate limit`)
  }
}

export class VoiceUnavailable extends Error {
  override readonly name = 'VoiceUnavailable'
  constructor(message = 'Whisper sidecar unavailable') {
    super(message)
  }
}

export class IngestTooLarge extends Error {
  override readonly name = 'IngestTooLarge'
  constructor(public readonly bytes: number) {
    super(`IngestTooLarge: payload is ${bytes} bytes`)
  }
}

export class OutboundBlocked extends Error {
  override readonly name = 'OutboundBlocked'
  constructor(message = 'Outbound locked — untrusted span in active context') {
    super(message)
  }
}

export class TransportError extends Error {
  override readonly name = 'TransportError'
  constructor(message: string) {
    super(message)
  }
}

export class NonceReplay extends Error {
  override readonly name = 'NonceReplay'
  constructor(public readonly cardId: CardId) {
    super(`NonceReplay: nonce for card ${cardId} already consumed`)
  }
}

export class NonceStale extends Error {
  override readonly name = 'NonceStale'
  constructor(public readonly cardId: CardId) {
    super(`NonceStale: nonce for card ${cardId} has expired`)
  }
}

export class ActionHashMismatch extends Error {
  override readonly name = 'ActionHashMismatch'
  constructor(public readonly cardId: CardId) {
    super(`ActionHashMismatch: presented hash does not match pending action for card ${cardId}`)
  }
}

export class StepUpRequired extends Error {
  override readonly name = 'StepUpRequired'
  constructor(public readonly actionId: string) {
    super(`StepUpRequired: second-factor proof missing for action ${actionId}`)
  }
}

export class StepUpFailed extends Error {
  override readonly name = 'StepUpFailed'
  constructor(public readonly actionId: string) {
    super(`StepUpFailed: second-factor proof invalid for action ${actionId}`)
  }
}

export class NoSuchPendingAction extends Error {
  override readonly name = 'NoSuchPendingAction'
  constructor(public readonly actionId: string) {
    super(`NoSuchPendingAction: no pending action found with id ${actionId}`)
  }
}

// ---- Dependencies injected into the Gateway ----

export interface GatewayDeps {
  /** Allowlisted operator chat_id. Read from vault; never plaintext env. */
  getAllowedChatId(): Promise<number>
  /** Telegram bot identity token. Read from vault; never plaintext env. */
  getBotToken(): Promise<string>
  /** Returns true if vault secrets are fully resolved (ready to serve). */
  isReady(): boolean
  /** Transcribe audio bytes. Throws VoiceUnavailable when sidecar is down. */
  transcribeVoice(audio: Uint8Array): Promise<string>
  /** Returns current outbound lockout state from Safety (05). */
  isOutboundLocked(): boolean
  /** Returns true if Safety component is reachable. */
  isSafetyAvailable(): boolean

  // ---- Optional DI seams (deterministic clock + bounds; injected in tests) ----

  /** Code clock. Default: Date.now. Lets tests pin time for nonce expiry. */
  now?(): number
  /** Max post-normalization span size before IngestTooLarge. Default 20 MB. */
  maxIngestBytes?: number
  /** Sliding-window inbound rate limit. Absent ⇒ unlimited. */
  rateLimit?: { max: number; windowMs: number }
  /** Approval-card TTL before auto-expire→default-deny. Default 15 min. */
  cardTtlMs?: number
  /** Step-up second-factor verifier (TOTP/passphrase). Injected for Tier-3. */
  verifyStepUp?(proof: string): boolean
  /** Single-use nonce minter. Default: randomUUID. Lets tests pin the minted
   *  nonce so a tap can echo the exact value bound at issue (spec §5.3). */
  mintNonce?(): string
}

// ---- Main Gateway interface ----

export interface Gateway {
  /**
   * Ingress: authorize → stamp provenance → normalize.
   * Throws AuthzRejected before any downstream component is invoked.
   *
   * @throws AuthzRejected
   * @throws RateLimited
   * @throws VoiceUnavailable
   * @throws IngestTooLarge
   */
  onUpdate(update: TelegramUpdate): Promise<InboundSpan>

  /**
   * Egress: stream model output. No-ops to the user (throws OutboundBlocked)
   * if Safety reports outbound lockout for the active context.
   *
   * @throws OutboundBlocked
   * @throws TransportError
   */
  streamReply(chatId: number, tokens: AsyncIterable<string>): Promise<void>

  /**
   * Mint an approval card bound to exactly one pending action.
   */
  issueCard(action: PendingAction): Promise<CardId>

  /**
   * Read-only view of an issued, not-yet-resolved card — the transport adapter
   * uses it to render the approval message and embed the nonce in callback_data.
   * Returns null for an unknown card or one already confirmed/cleared. Never
   * confirms anything; handleCardTap stays the sole confirmer.
   */
  getIssuedCard(cardId: CardId): IssuedCardView | null

  /**
   * The ONLY confirmer of a pending action. Deterministic; never a model call.
   *
   * @throws NonceReplay
   * @throws NonceStale
   * @throws ActionHashMismatch
   * @throws StepUpRequired
   * @throws StepUpFailed
   * @throws NoSuchPendingAction
   */
  handleCardTap(tap: CardTap): Promise<ApprovalResult>
}
