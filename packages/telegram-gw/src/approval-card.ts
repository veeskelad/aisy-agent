// Approval cards (plan §6, spec §5.3).
//
// A card is one Telegram message bound to exactly one PendingAction. The inline
// keyboard's callback_data is the size-bounded {cardId, nonce, verb} tuple
// (Telegram caps callback_data at 64 bytes). The full actionHash is held by the
// adapter keyed by cardId and echoed to Gateway.handleCardTap as
// presentedActionHash — the deterministic confirmer in core does the real work.

import type { PendingAction } from '@aisy/core'
import { escapeHtml } from './render.js'
import type { BotMessage, InlineButton } from './types.js'

export const CALLBACK_PREFIX = 'atap'
export const CALLBACK_MAX_BYTES = 64
const DELIM = '|'

// confirm = approve once; session/always = approve + remember the grant for the
// tool (ADR-0047); reject = decline; info = show details.
export type CardVerb = 'confirm' | 'session' | 'always' | 'reject' | 'info'

const VERB_CODE: Record<CardVerb, string> = {
  confirm: 'y',
  session: 's',
  always: 'a',
  reject: 'n',
  info: 'i',
}
const CODE_VERB: Record<string, CardVerb> = {
  y: 'confirm',
  s: 'session',
  a: 'always',
  n: 'reject',
  i: 'info',
}

export interface CardCallback {
  cardId: string
  nonce: string
  verb: CardVerb
}

/** Encode a tap into Telegram callback_data. Throws if it would be unsafe. */
export function encodeCallback(cb: CardCallback): string {
  if (cb.cardId.includes(DELIM) || cb.nonce.includes(DELIM)) {
    throw new Error('callback field contains the reserved delimiter')
  }
  const data = [CALLBACK_PREFIX, VERB_CODE[cb.verb], cb.cardId, cb.nonce].join(DELIM)
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_MAX_BYTES) {
    throw new Error(`callback_data exceeds ${CALLBACK_MAX_BYTES} bytes`)
  }
  return data
}

/** Decode callback_data back into a tap, or null if it is not ours / malformed. */
export function decodeCallback(data: string): CardCallback | null {
  const parts = data.split(DELIM)
  if (parts.length !== 4 || parts[0] !== CALLBACK_PREFIX) return null
  const verb = CODE_VERB[parts[1]!]
  if (!verb || !parts[2] || !parts[3]) return null
  return { cardId: parts[2], nonce: parts[3], verb }
}

export interface CardContext {
  sessionId: string
  /** 🎯 Why the tool is requesting this (always shown). */
  reason: string
  /** ⚠️ Risk note (tier 2+). */
  risk?: string
  /** 🎯 Why the agent is doing it (tier 2/3). */
  motivation?: string
  /** 🚫 Block reason (tier 3). */
  blockReason?: string
  /** ⏳ Informational countdown, e.g. "2:14" — never expires the card. */
  waiting?: string
  /** Tier 3 only: show the confirm button once step-up succeeded. */
  stepUpReady?: boolean
}

function header(tier: PendingAction['tier']): string {
  switch (tier) {
    case 3:
      return '🚨 <b>КРИТИЧЕСКОЕ ДЕЙСТВИЕ</b>'
    case 2:
      return '⚠️ <b>Требуется подтверждение</b>'
    default:
      return '✅ <b>Подтверждение действия</b>'
  }
}

/**
 * Build the inline keyboard with real callback_data for an issued card.
 *
 * - Tier-2: 4 buttons (2×2) — Подтвердить / На сессию / Навсегда / Отменить.
 *   "session"/"always" remember the grant (ADR-0047).
 * - Tier-3: only Подтвердить / Отменить, and Подтвердить appears solely after
 *   step-up — a step-up action is NEVER remembered.
 * - Tier-0/1: Подтвердить / Отменить (defensive; these tiers do not card).
 */
export function makeCardButtons(
  action: PendingAction,
  cardId: string,
  nonce: string,
  opts?: { stepUpReady?: boolean },
): InlineButton[][] {
  const btn = (text: string, verb: CardVerb): InlineButton => ({
    text,
    data: encodeCallback({ cardId, nonce, verb }),
  })

  if (action.tier === 2) {
    return [
      [btn('✅ Подтвердить', 'confirm'), btn('🔄 На сессию', 'session')],
      [btn('♾️ Навсегда', 'always'), btn('❌ Отменить', 'reject')],
    ]
  }

  if (action.tier === 3) {
    return opts?.stepUpReady === true
      ? [[btn('✅ Подтвердить', 'confirm'), btn('❌ Отклонить', 'reject')]]
      : [[btn('❌ Отклонить', 'reject')]]
  }

  return [[btn('✅ Подтвердить', 'confirm'), btn('❌ Отклонить', 'reject')]]
}

/** Render the tier-colored approval card body. Buttons are added by the issuer. */
export function renderCard(action: PendingAction, ctx: CardContext): BotMessage {
  const lines: string[] = [header(action.tier), '']

  lines.push('📋 <b>Что произойдёт:</b>', '   ' + escapeHtml(action.summary), '')

  if (action.tier === 3 && ctx.blockReason) {
    lines.push('🚫 <b>Причина блокировки:</b>', '   ' + escapeHtml(ctx.blockReason), '')
  }
  if (ctx.risk) {
    lines.push('⚠️ <b>Риск:</b>', '   ' + escapeHtml(ctx.risk), '')
  }
  lines.push('🎯 <b>Причина запроса:</b>', '   ' + escapeHtml(ctx.reason), '')
  if (ctx.motivation) {
    lines.push('🎯 <b>Почему агент это делает:</b>', '   ' + escapeHtml(ctx.motivation), '')
  }
  if (action.tier === 3 && !ctx.stepUpReady) {
    lines.push('⛔ Требуется второй фактор. Введи код (TOTP/кодовое слово):', '')
  }

  lines.push(
    `Сессия: ${escapeHtml(ctx.sessionId)} · Действие: ${escapeHtml(action.actionId)}`,
  )
  if (ctx.waiting) lines.push(`⏳ Ожидает: ${escapeHtml(ctx.waiting)}`)

  // Body only; the inline keyboard is built by makeCardButtons once the card is
  // issued with its single-use nonce.
  return { html: lines.join('\n') }
}

/** Render the card body after a decision; the keyboard is removed by the caller. */
export function renderResolved(
  action: PendingAction,
  decision: 'confirmed' | 'rejected',
  at: string,
): string {
  const head = decision === 'confirmed' ? `✅ Подтверждено · ${at}` : `❌ Отклонено · ${at}`
  return `${head}\n📋 ${escapeHtml(action.summary)}`
}
