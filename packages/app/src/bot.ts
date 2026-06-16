// Telegram transport (grammY) — the live wiring of the pure UX layer to a real
// bot. It owns the approval round-trip: the `approve` port it builds issues a
// card, waits for the tap, and resolves the promise the HookGate is awaiting.
//
// MVP scope: menu, text turn -> runner -> reply (HTML, >4096 -> document),
// approval cards (confirm/session/always/reject), /stop. Marked TODOs:
// Hermes debounce coalescing, Tier-3 step-up code capture, outbound-lockout via
// streamReply, and the event-bridge alert stream.

import { Bot, InlineKeyboard, Keyboard, InputFile } from 'grammy'
import type {
  AgentRunner,
  ApprovalDecision,
  Gateway,
  GrantScope,
  PendingAction,
  TelegramUpdate,
} from '@aisy/core'
import {
  MAIN_MENU,
  MENU_GREETING,
  renderCard,
  makeCardButtons,
  decodeCallback,
  renderResolved,
  resolveTap,
  fitBody,
  type CardContext,
  type InlineButton,
} from '@aisy/telegram-gw'

export interface TelegramBotDeps {
  token: string
  allowedChatId: number
  gateway: Gateway
  /** Build the runner given the bot-owned approval port (closes the loop). */
  buildRunner: (approve: (action: PendingAction) => Promise<ApprovalDecision>) => AgentRunner
  /** ISO clock for resolved-card footers. Default: system clock. */
  now?: () => string
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
  const bot = new Bot(deps.token)
  const pending = new Map<string, PendingCard>()

  // Single-operator allowlist: silently drop anything off the allowed chat.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.id !== deps.allowedChatId) return
    await next()
  })

  // The approval port the HookGate awaits: issue a card, park the resolver.
  const approve = (action: PendingAction): Promise<ApprovalDecision> =>
    new Promise<ApprovalDecision>((resolve) => {
      const ctxCard: CardContext = {
        sessionId: String(deps.allowedChatId),
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

  const greet = async (chatId: number): Promise<void> => {
    await bot.api.sendMessage(chatId, MENU_GREETING, { reply_markup: mainMenuKeyboard() })
  }

  bot.command(['start', 'menu'], async (ctx) => {
    await greet(ctx.chat.id)
  })

  // TODO: /stop should hard-kill the in-flight turn (needs a runner abort seam).
  bot.command('stop', async (ctx) => {
    await ctx.reply('⏹ Остановлено.')
  })

  bot.on('callback_query:data', async (ctx) => {
    const cb = decodeCallback(ctx.callbackQuery.data)
    if (!cb) {
      await ctx.answerCallbackQuery()
      return
    }
    const card = pending.get(cb.cardId)
    if (!card) {
      await ctx.answerCallbackQuery({ text: 'Карточка устарела.' })
      return
    }
    // TODO: Tier-3 step-up — capture a TOTP/passphrase text before confirm.
    const outcome = await resolveTap(cb, card.chatId, card.action, { gateway: deps.gateway, now })
    await ctx.answerCallbackQuery()

    if (outcome.kind === 'info') return
    if (outcome.kind === 'confirmed') {
      await ctx.editMessageText(outcome.footer, { parse_mode: 'HTML' })
      const scope: GrantScope | undefined = outcome.scope
      pending.delete(cb.cardId)
      card.resolve(scope ? { decision: 'confirmed', scope } : { decision: 'confirmed' })
      return
    }
    // rejected / expired / replay / hash_mismatch / stepup_* → decline
    const footer = 'footer' in outcome ? outcome.footer : renderResolved(card.action, 'rejected', now())
    await ctx.editMessageText(footer, { parse_mode: 'HTML' })
    pending.delete(cb.cardId)
    card.resolve({ decision: 'rejected' })
  })

  // TODO: Hermes-style debounce coalescing (InputRouter) — MVP handles one msg.
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    const update: TelegramUpdate = { message: { chat: { id: ctx.chat.id }, text } }
    let span
    try {
      span = await deps.gateway.onUpdate(update)
    } catch {
      await ctx.reply('❌ Сообщение отклонено (authz/transport).')
      return
    }
    const result = await runner.handle({
      sessionId: String(span.chatId),
      spans: [{ role: 'user', provenance: span.provenance, text: span.text }],
    })
    const fitted = fitBody(result.reply.length > 0 ? result.reply : '(пустой ответ)')
    await ctx.reply(fitted.text, { parse_mode: 'HTML' })
    if (fitted.document) {
      await ctx.replyWithDocument(
        new InputFile(Buffer.from(fitted.document.content, 'utf8'), fitted.document.filename),
      )
    }
  })

  return bot
}
