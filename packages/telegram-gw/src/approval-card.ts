// Approval cards (plan §6, spec §5.3).
//
// A card is one Telegram message bound to exactly one PendingAction. The inline
// keyboard's callback_data is the size-bounded {cardId, nonce, verb} tuple
// (Telegram caps callback_data at 64 bytes). The full actionHash is held by the
// adapter keyed by cardId and echoed to Gateway.handleCardTap as
// presentedActionHash — the deterministic confirmer in core does the real work.

import type { PendingAction } from '@aisy/core'
import { escapeHtml } from './render.js'
import { TOOL_LABEL } from './execution-view.js'
import type { BotMessage, InlineButton } from './types.js'

export const CALLBACK_PREFIX = 'atap'
export const CALLBACK_MAX_BYTES = 64
const DELIM = '|'

// confirm = approve once; session/always = approve + remember only the
// code-derived similar action (ADR-0093); reject = decline; info = show details.
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
  /** ⚠️ Risk note (tier 2+). */
  risk?: string
  /** 🎯 Зачем агент это делает — его словами, если ему есть что сказать. */
  motivation?: string
  /** 🚫 Block reason (tier 3). */
  blockReason?: string
  /** ⏳ Informational countdown, e.g. "2:14" — never expires the card. */
  waiting?: string
}

function header(tier: PendingAction['tier']): string {
  switch (tier) {
    case 3:
      return '🚨 <b>Опасное действие</b>'
    case 2:
      return '⚠️ <b>Нужно твоё решение</b>'
    default:
      return '✅ <b>Нужно твоё решение</b>'
  }
}

/**
 * Действие словами вместо сигнатуры вызова.
 *
 * Ядро складывает `summary` из имени инструмента и его аргументов — `bash(cmd)`,
 * `write_file(path, content)`. Это точное описание вызова и никакое описание
 * происходящего: оператор, которого спрашивают, должен прочитать, что сейчас
 * случится с его файлами, а не как называется функция.
 *
 * Незнакомая форма возвращается как есть: показать техническую строку лучше,
 * чем не показать ничего.
 */
export function actionPhrase(summary: string): string {
  const parsed = /^([a-z_][a-z0-9_]*)\((.*)\)$/is.exec(summary.trim())
  if (parsed === null) return escapeHtml(summary)
  const [, tool = '', argument = ''] = parsed
  const label = TOOL_LABEL[tool]?.will
  if (label === undefined) return escapeHtml(summary)
  // Список имён аргументов («path, content») говорит не больше имени функции;
  // одно значение — говорит всё.
  const detail = argument.includes(',') || argument.length === 0
    ? ''
    : `: <code>${escapeHtml(argument)}</code>`
  return `${label}${detail}`
}

/**
 * Build the inline keyboard with real callback_data for an issued card.
 *
 * Две кнопки, всегда одни и те же слова. Четыре («Один раз» / «Похожие на
 * сессию» / «Похожие навсегда» / «Отменить») требовали от оператора знать, что
 * система считает похожим, — на телефоне, посреди чужой задачи. Длящееся
 * разрешение теперь набирается демонстрациями, а не выбирается кнопкой.
 *
 * Tier-3 показывает те же две кнопки: тап оператора в его приватном канале и
 * есть подтверждение (ADR-0104). Прежде «Разрешить» там появлялась «только
 * после второго фактора», которого негде было ввести, — то есть карточку тира 3
 * нельзя было подтвердить вообще ничем.
 */
export function makeCardButtons(
  action: PendingAction,
  cardId: string,
  nonce: string,
): InlineButton[][] {
  const btn = (text: string, verb: CardVerb): InlineButton => ({
    text,
    data: encodeCallback({ cardId, nonce, verb }),
  })

  return [[btn('✅ Разрешить', 'confirm'), btn('❌ Отменить', 'reject')]]
}

/** Render the tier-colored approval card body. Buttons are added by the issuer. */
export function renderCard(action: PendingAction, ctx: CardContext): BotMessage {
  const lines: string[] = [header(action.tier), '', actionPhrase(action.summary), '']

  if (action.tier === 3 && ctx.blockReason) {
    lines.push(`🚫 Почему это опасно: ${escapeHtml(ctx.blockReason)}`, '')
  }
  if (ctx.risk) {
    lines.push(`⚠️ Риск: ${escapeHtml(ctx.risk)}`, '')
  }
  // Причину показываем, только когда есть что сказать: одна и та же фраза под
  // каждым действием — это шум, который учит не читать карточку.
  if (ctx.motivation) {
    lines.push(`🎯 Зачем: ${escapeHtml(ctx.motivation)}`, '')
  }
  if (ctx.waiting) lines.push(`⏳ Жду: ${escapeHtml(ctx.waiting)}`)
  if (action.tier === 2 && action.canRememberSimilar === true) {
    lines.push(
      '',
      'После подтверждения похожее действие в этом контексте выполню без нового вопроса. ' +
        'Правило можно отозвать через /grants.',
    )
  }

  // Идентификаторы сессии и действия оператору не нужны — он смотрит в телефон,
  // а не в журнал. В журнале они остаются.
  return { html: lines.join('\n').replace(/\n+$/, '') }
}

/** Render the card body after a decision; the keyboard is removed by the caller. */
export function renderResolved(
  action: PendingAction,
  decision: 'confirmed' | 'rejected',
  at: string,
  /** Почему решение получилось таким, если это была не воля оператора. */
  reason?: ResolutionReason,
): string {
  const head = decision === 'confirmed' ? `✅ Разрешено · ${at}` : `❌ Отменено · ${at}`
  const why = reason === undefined ? '' : `\n${RESOLUTION_REASON[reason]}`
  return `${head}\n${actionPhrase(action.summary)}${why}`
}

/** Почему карточка закрылась отказом, если оператор её не отклонял. */
export type ResolutionReason = 'expired' | 'replay' | 'hash-mismatch' | 'step-up-failed'

/**
 * Отказ без причины читается как поломка агента.
 *
 * Раньше все четыре исхода печатались одинаково — «❌ Отклонено», — и оператор,
 * который ничего не нажимал, видел то же самое, что оператор, нажавший отмену.
 */
const RESOLUTION_REASON: Readonly<Record<ResolutionReason, string>> = Object.freeze({
  expired: 'Карточка устарела — попроси действие заново.',
  replay: 'Эта кнопка уже сработала один раз.',
  'hash-mismatch': 'Действие изменилось с момента показа — начинаю заново.',
  'step-up-failed': 'Код не подошёл.',
})
