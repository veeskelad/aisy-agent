// Telegram transport (grammY) — the live wiring of the pure UX layer to a real
// bot. It owns the approval round-trip (the `approve` port issues a card, waits
// for the tap, resolves the promise the HookGate awaits), Hermes-style debounce
// coalescing of rapid messages, a steer queue for mid-turn input, and Tier-3
// step-up code capture.
//
// Not yet wired (need a core source, see ADR-0048): outbound-lockout enforcement
// via streamReply and the event-bridge alert stream (budget/cost/narrowed) —
// those require Safety's narrowed/cost state surfaced to the transport.

import { Bot, InlineKeyboard, Keyboard, InputFile } from 'grammy'
import type {
  AgentRunner,
  ApprovalDecision,
  Gateway,
  GrantScope,
  PendingAction,
  Provenance,
  TelegramUpdate,
} from '@aisy/core'
import {
  MAIN_MENU,
  MENU_GREETING,
  STEER_ACK,
  SteerQueue,
  renderCard,
  makeCardButtons,
  decodeCallback,
  renderResolved,
  resolveTap,
  renderEvent,
  fitBody,
  type CardCallback,
  type CardContext,
  type InlineButton,
  type TapOutcome,
} from '@aisy/telegram-gw'

export interface TelegramBotDeps {
  token: string
  allowedChatId: number
  gateway: Gateway
  /** Build the runner given the bot-owned approval port (closes the loop). */
  buildRunner: (approve: (action: PendingAction) => Promise<ApprovalDecision>) => AgentRunner
  /** Model id shown in the cost summary. */
  model: string
  /** Session budget (USD) for the cost bar; 0 ⇒ no bar fill. */
  budgetUsd?: number
  now?: () => string
  /** Debounce window for coalescing a rapid message burst. Default 1200ms. */
  debounceMs?: number
  debug?: boolean
}

interface PendingCard {
  resolve: (decision: ApprovalDecision) => void
  action: PendingAction
  chatId: number
  messageId: number
}

function toInlineKeyboard(rows: InlineButton[][]): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const row of rows) {
    for (const b of row) kb.text(b.text, b.data)
    kb.row()
  }
  return kb
}

function mainMenuKeyboard(): Keyboard {
  const kb = new Keyboard()
  for (const row of MAIN_MENU) {
    for (const b of row) kb.text(b.label)
    kb.row()
  }
  return kb.resized().persistent()
}

export function makeTelegramBot(deps: TelegramBotDeps): Bot {
  const now = deps.now ?? ((): string => new Date().toISOString())
  const debounceMs = deps.debounceMs ?? 1200
  const sessionId = String(deps.allowedChatId)
  const bot = new Bot(deps.token)
  const pending = new Map<string, PendingCard>()

  // --- turn-flow state (Hermes coalescing + steering) ---
  let agentState: 'idle' | 'running' = 'idle'
  let buffered: { text: string; provenance: Provenance }[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const steer = new SteerQueue()
  // A Tier-3 card awaiting a step-up code typed as the next message.
  let pendingStepUp: { cb: CardCallback; card: PendingCard } | null = null
  // A reply held by the outbound lockout, awaiting an allow/block tap.
  let pendingOutbound: { reply: string; messageId: number } | null = null

  // Single-operator allowlist: silently drop anything off the allowed chat.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.id !== deps.allowedChatId) return
    await next()
  })

  const approve = (action: PendingAction): Promise<ApprovalDecision> =>
    new Promise<ApprovalDecision>((resolve) => {
      const ctxCard: CardContext = {
        sessionId,
        reason: 'Инструмент запрашивает действие в рамках задачи.',
      }
      void (async () => {
        try {
          const cardId = await deps.gateway.issueCard(action)
          const view = deps.gateway.getIssuedCard(cardId)
          if (!view) {
            resolve({ decision: 'rejected' })
            return
          }
          const body = renderCard(action, ctxCard)
          const kb = toInlineKeyboard(makeCardButtons(action, cardId, view.nonce))
          const sent = await bot.api.sendMessage(deps.allowedChatId, body.html, {
            parse_mode: 'HTML',
            reply_markup: kb,
          })
          pending.set(cardId, { resolve, action, chatId: deps.allowedChatId, messageId: sent.message_id })
        } catch {
          resolve({ decision: 'rejected' })
        }
      })()
    })

  const runner = deps.buildRunner(approve)

  const sendReply = async (text: string): Promise<void> => {
    const fitted = fitBody(text.length > 0 ? text : '(пустой ответ)')
    await bot.api.sendMessage(deps.allowedChatId, fitted.text, { parse_mode: 'HTML' })
    if (fitted.document) {
      await bot.api.sendDocument(
        deps.allowedChatId,
        new InputFile(Buffer.from(fitted.document.content, 'utf8'), fitted.document.filename),
      )
    }
  }

  const sendCostSummary = async (usage: { inputTokens: number; outputTokens: number; dollars: number }): Promise<void> => {
    const msg = renderEvent({
      kind: 'cost.summary',
      sessionId,
      tokensIn: usage.inputTokens,
      tokensOut: usage.outputTokens,
      dollars: usage.dollars,
      limitUsd: deps.budgetUsd ?? 0,
      model: deps.model,
    })
    if (msg) await bot.api.sendMessage(deps.allowedChatId, msg.html, { parse_mode: 'HTML' })
  }

  // Outbound lockout: the turn ran with untrusted context, so the reply is held
  // until the operator allows it (ADR-0048; tool-level narrowing already applied).
  const presentOutboundLockout = async (reply: string): Promise<void> => {
    const msg = renderEvent({
      kind: 'outbound.locked',
      sources: ['untrusted-контент в контексте задачи'],
      preview: reply.slice(0, 200),
    })
    if (!msg) {
      await sendReply(reply)
      return
    }
    const sent = await bot.api.sendMessage(deps.allowedChatId, msg.html, {
      parse_mode: 'HTML',
      ...(msg.buttons ? { reply_markup: toInlineKeyboard(msg.buttons) } : {}),
    })
    pendingOutbound = { reply, messageId: sent.message_id }
  }

  const runTurn = async (spans: { text: string; provenance: Provenance }[]): Promise<void> => {
    agentState = 'running'
    try {
      const result = await runner.handle({
        sessionId,
        spans: spans.map((s) => ({ role: 'user', provenance: s.provenance, text: s.text })),
      })
      if (result.narrowed === true) {
        await presentOutboundLockout(result.reply)
      } else {
        await sendReply(result.reply)
      }
      if (result.usage) await sendCostSummary(result.usage)
    } finally {
      agentState = 'idle'
      // Drain mid-turn steer input (newest-first) and run it as the next turn.
      if (!steer.isEmpty) {
        const texts = steer.drain().flatMap((i) => i.texts)
        await runTurn(texts.map((t) => ({ text: t, provenance: 'operator' as const })))
      }
    }
  }

  const flushNow = (): void => {
    flushTimer = null
    if (buffered.length === 0) return
    const batch = buffered
    buffered = []
    void runTurn(batch)
  }

  const scheduleFlush = (): void => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(flushNow, debounceMs)
  }

  const applyOutcome = async (outcome: TapOutcome, cb: CardCallback, card: PendingCard): Promise<void> => {
    if (outcome.kind === 'info') return
    if (outcome.kind === 'stepup_required') {
      pendingStepUp = { cb, card }
      await bot.api.sendMessage(card.chatId, '⛔ Введи код подтверждения (TOTP/кодовое слово):')
      return
    }
    if (outcome.kind === 'confirmed') {
      await bot.api.editMessageText(card.chatId, card.messageId, outcome.footer, { parse_mode: 'HTML' })
      pending.delete(cb.cardId)
      const scope: GrantScope | undefined = outcome.scope
      card.resolve(scope ? { decision: 'confirmed', scope } : { decision: 'confirmed' })
      return
    }
    // rejected / expired / replay / hash_mismatch / stepup_failed → decline
    const footer = 'footer' in outcome ? outcome.footer : renderResolved(card.action, 'rejected', now())
    await bot.api.editMessageText(card.chatId, card.messageId, footer, { parse_mode: 'HTML' })
    pending.delete(cb.cardId)
    card.resolve({ decision: 'rejected' })
  }

  // --- menu + commands ---
  bot.command(['start', 'menu'], async (ctx) => {
    await ctx.reply(MENU_GREETING, { reply_markup: mainMenuKeyboard() })
  })

  // TODO: /stop should hard-kill the in-flight turn (needs a runner abort seam).
  bot.command('stop', async (ctx) => {
    buffered = []
    if (flushTimer) clearTimeout(flushTimer)
    await ctx.reply('⏹ Остановлено.')
  })

  // --- approval card taps ---
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data
    await ctx.answerCallbackQuery()

    // Outbound lockout decision (event-bridge callback, not a card).
    if (data === 'outbound:allow' || data === 'outbound:block') {
      const held = pendingOutbound
      pendingOutbound = null
      if (!held) return
      const verdict = data === 'outbound:allow' ? '✅ Вывод разрешён' : '❌ Вывод заблокирован'
      await bot.api.editMessageText(deps.allowedChatId, held.messageId, verdict)
      if (data === 'outbound:allow') await sendReply(held.reply)
      return
    }

    const cb = decodeCallback(data)
    if (!cb) return
    const card = pending.get(cb.cardId)
    if (!card) return
    const outcome = await resolveTap(cb, card.chatId, card.action, { gateway: deps.gateway, now })
    await applyOutcome(outcome, cb, card)
  })

  // --- messages: step-up code capture, else Hermes coalesce / steer ---
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    if (text.startsWith('/')) return // commands are handled by bot.command

    if (pendingStepUp) {
      const ps = pendingStepUp
      pendingStepUp = null
      const outcome = await resolveTap(ps.cb, ps.card.chatId, ps.card.action, { gateway: deps.gateway, now }, { stepUpProof: text })
      await applyOutcome(outcome, ps.cb, ps.card)
      return
    }

    let span
    try {
      span = await deps.gateway.onUpdate(ctx.update as unknown as TelegramUpdate)
    } catch {
      await ctx.reply('❌ Сообщение отклонено (authz/transport).')
      return
    }

    if (agentState === 'running') {
      steer.enqueue([span.text], Date.now())
      await ctx.reply(STEER_ACK)
      return
    }
    buffered.push({ text: span.text, provenance: span.provenance })
    scheduleFlush()
  })

  return bot
}
