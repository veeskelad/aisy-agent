// Telegram transport (grammY) — the live wiring of the pure UX layer to a real
// bot. It owns the approval round-trip (the `approve` port issues a card, waits
// for the tap, resolves the promise the HookGate awaits), Hermes-style debounce
// coalescing of rapid messages, a steer queue for mid-turn input, and Tier-3
// step-up code capture.
//
// Outbound lockout is live: a turn that ran with untrusted context returns
// narrowed=true; the reply is held here behind an allow/block tap
// (presentOutboundLockout, ADR-0048) AND the narrowed verdict is mirrored to the
// gateway's egress guard via setOutboundLocked, so streamReply fails closed while
// narrowed (ADR-0051). Still deferred: streaming partial replies and a push-style
// alert stream for budget/cost events.

import { Bot, InlineKeyboard, Keyboard, InputFile } from 'grammy'
import type {
  AgentRunner,
  ApprovalDecision,
  BudgetTracker,
  Gateway,
  GrantScope,
  PendingAction,
  Provenance,
  SettingsStore,
  SpendStore,
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
  resolveMenu,
  fitBody,
  type CardCallback,
  type CardContext,
  type InlineButton,
  type MenuAction,
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
  /** Operator settings — gates the per-turn cost summary (ADR-0050 Phase 2). */
  settings?: SettingsStore
  /** Spend ledger — fed from each turn's usage; viewed on demand in 📡 Монитор. */
  spend?: SpendStore
  /** Per-agent budget tracker; when settings.budgetEnabled, a turn is refused
   *  once the main agent is over its cap (ADR-0050 Phase 3). */
  budget?: BudgetTracker
  /** Mirror the loop's narrowed state to the gateway egress guard (ADR-0051). */
  setOutboundLocked?: (locked: boolean) => void
  now?: () => string
  /** Debounce window for coalescing a rapid message burst. Default 1200ms. */
  debounceMs?: number
  debug?: boolean
  /** Trigger an immediate nightly consolidation run (Tier-4 C2). */
  onConsolidate?: () => Promise<void>
  /** Return the current staging area — decoupled shape, no nightly types (Tier-4 C2). */
  getStaging?: () => Promise<{ id: string; preview: string; judged: boolean }[]>
  /** Promote a staged memory patch by id (Tier-4 C2). */
  onApproveNightly?: (stagedItemId: string) => Promise<void>
  /** Register a new trigger — decoupled shape, no trigger types (Tier-4 D2). */
  onRegisterTrigger?: (input: {
    kind: 'remind' | 'schedule' | 'watch'
    prompt: string
    when?: string
    cron?: string
    probe?: string
  }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
  /** List active triggers — decoupled shape (Tier-4 D2). */
  onListTriggers?: () => Promise<{ id: string; kind: string; prompt: string }[]>
  /** Cancel a trigger by id — returns true if found (Tier-4 D2). */
  onCancelTrigger?: (id: string) => Promise<boolean>
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

export function makeTelegramBot(deps: TelegramBotDeps) {
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
  // The in-flight turn's abort controller; /stop fires it for a hard-kill.
  let currentAbort: AbortController | null = null

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

  const sendPanel = async (
    msg: { html: string; buttons?: InlineButton[][] } | null,
  ): Promise<void> => {
    if (!msg) return
    await bot.api.sendMessage(deps.allowedChatId, msg.html, {
      parse_mode: 'HTML',
      ...(msg.buttons ? { reply_markup: toInlineKeyboard(msg.buttons) } : {}),
    })
  }

  const settingsPanel = (): { html: string; buttons?: InlineButton[][] } | null => {
    const st = deps.settings?.get() ?? { showCostPerTurn: false, budgetEnabled: false }
    return renderEvent({ kind: 'settings.panel', showCostPerTurn: st.showCostPerTurn, budgetEnabled: st.budgetEnabled })
  }

  const sendSpendReport = async (): Promise<void> => {
    const rows = (deps.spend?.byModel() ?? []).map((r) => ({
      model: r.model,
      tokensIn: r.inputTokens,
      tokensOut: r.outputTokens,
      dollars: r.dollars,
    }))
    const totalUsd = deps.spend?.total().dollars ?? 0
    const perAgent = (deps.spend?.byAgent() ?? []).map((a) => ({ agentId: a.agentId, dollars: a.dollars }))
    await sendPanel(renderEvent({ kind: 'spend.report', rows, totalUsd, ...(perAgent.length > 0 ? { perAgent } : {}) }))
  }

  const handleMenu = async (action: MenuAction): Promise<void> => {
    if (action === 'settings') {
      await sendPanel(settingsPanel())
    } else if (action === 'monitor') {
      await sendSpendReport()
    } else {
      await bot.api.sendMessage(deps.allowedChatId, 'Раздел в разработке.')
    }
  }

  const runTurn = async (spans: { text: string; provenance: Provenance }[]): Promise<void> => {
    // Budget gate (ADR-0050 Phase 3): refuse a new turn when enforcement is on
    // and the main agent is over its cap. Turn-level; mid-turn enforcement lands
    // with the delegation runtime.
    if (deps.settings?.get().budgetEnabled === true && deps.budget?.over('main') === true) {
      await sendPanel(
        renderEvent({
          kind: 'budget.capped',
          limitUsd: deps.budget.capFor('main'),
          spentUsd: deps.budget.spentFor('main'),
          stepsDone: 0,
          stepsTotal: 0,
        }),
      )
      return
    }
    agentState = 'running'
    const abort = new AbortController()
    currentAbort = abort
    try {
      const result = await runner.handle({
        sessionId,
        spans: spans.map((s) => ({ role: 'user', provenance: s.provenance, text: s.text })),
        signal: abort.signal,
      })
      // Keep the gateway egress lockout truthful: this turn's narrowed verdict
      // is the live outbound-lockout state (self-clears on a clean operator turn).
      deps.setOutboundLocked?.(result.narrowed === true)
      if (result.state === 'halted' && result.haltReason === 'stopped') {
        // Operator /stop already acked ("⏹ Остановлено."); stay silent.
      } else if (result.state === 'halted' && result.haltReason === 'budget-capped') {
        await sendPanel(
          renderEvent({
            kind: 'budget.capped',
            limitUsd: deps.budget?.capFor('main') ?? 0,
            spentUsd: deps.budget?.spentFor('main') ?? 0,
            stepsDone: 0,
            stepsTotal: 0,
          }),
        )
      } else if (result.narrowed === true) {
        await presentOutboundLockout(result.reply)
      } else {
        await sendReply(result.reply)
      }
      if (result.usage) {
        // Record spend always (viewed on demand in 📡 Монитор); only echo a
        // per-turn cost card when the operator opted in (default off — ADR-0050).
        deps.spend?.record({ model: deps.model, usage: result.usage })
        if (deps.settings?.get().showCostPerTurn === true) await sendCostSummary(result.usage)
      }
    } catch (err) {
      // A turn that throws — an executor/provider error not mapped to a loop
      // Halt — must not become an unhandled rejection (silent hang / crash).
      // Surface it so the operator can retry; the finally still resets state.
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 200)
      const msg = renderEvent({ kind: 'error', what: 'Ход прерван ошибкой', detail })
      if (msg) {
        await bot.api
          .sendMessage(deps.allowedChatId, msg.html, {
            parse_mode: 'HTML',
            ...(msg.buttons ? { reply_markup: toInlineKeyboard(msg.buttons) } : {}),
          })
          .catch(() => {})
      }
    } finally {
      agentState = 'idle'
      currentAbort = null
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

  bot.command('stop', async (ctx) => {
    buffered = []
    if (flushTimer) clearTimeout(flushTimer)
    currentAbort?.abort()
    await ctx.reply('⏹ Остановлено.')
  })

  bot.command('consolidate', async (ctx) => {
    await ctx.reply('🌙 Запускаю консолидацию в staging…')
    await deps.onConsolidate?.()
  })

  bot.command('staging', async (ctx) => {
    const items = (await deps.getStaging?.()) ?? []
    if (items.length === 0) {
      await ctx.reply('Staging пуст.')
      return
    }
    const rows = items.map((it) => [{ text: `${it.judged ? '✅' : '⏳'} ${it.preview}`, data: it.judged ? `nightly:approve:${it.id}` : 'nightly:unjudged' }])
    await bot.api.sendMessage(deps.allowedChatId, 'Staged правки памяти (tap = одобрить):', { reply_markup: toInlineKeyboard(rows) })
  })

  // --- trigger commands (Tier-4 D2) ---
  bot.command('remind', async (ctx) => {
    const args = (ctx.match ?? '').trim().split(/\s+/)
    const when = args[0]
    const prompt = args.slice(1).join(' ')
    if (!when || !prompt) {
      await ctx.reply('Использование: /remind <30m|2h|ISO> <текст>')
      return
    }
    const res = await deps.onRegisterTrigger?.({ kind: 'remind', prompt, when })
    if (!res) { await ctx.reply('❌ Триггеры не настроены.'); return }
    await ctx.reply(res.ok ? `✅ Напоминание создано (id ${res.id})` : `❌ ${res.error}`)
  })

  bot.command('schedule', async (ctx) => {
    const args = (ctx.match ?? '').trim().split(/\s+/)
    const cron = args[0]
    const prompt = args.slice(1).join(' ')
    if (!cron || !prompt) {
      await ctx.reply('Использование: /schedule <@daily|@hourly|HH:MM> <текст>')
      return
    }
    const res = await deps.onRegisterTrigger?.({ kind: 'schedule', prompt, cron })
    if (!res) { await ctx.reply('❌ Триггеры не настроены.'); return }
    await ctx.reply(res.ok ? `✅ Расписание создано (id ${res.id})` : `❌ ${res.error}`)
  })

  bot.command('watch', async (ctx) => {
    const args = (ctx.match ?? '').trim().split(/\s+/)
    const probe = args[0]
    const prompt = args.slice(1).join(' ')
    if (!probe || !prompt) {
      await ctx.reply('Использование: /watch <file:PATH|http:URL> <текст>')
      return
    }
    const res = await deps.onRegisterTrigger?.({ kind: 'watch', prompt, probe })
    if (!res) { await ctx.reply('❌ Триггеры не настроены.'); return }
    await ctx.reply(res.ok ? `✅ Наблюдение создано (id ${res.id})` : `❌ ${res.error}`)
  })

  bot.command('triggers', async (ctx) => {
    const list = (await deps.onListTriggers?.()) ?? []
    if (list.length === 0) {
      await ctx.reply('Триггеров нет.')
      return
    }
    const text = list.map((t, i) => `${i + 1}. ${t.id} · ${t.kind} · ${t.prompt}`).join('\n')
    await ctx.reply(text)
  })

  bot.command('untrigger', async (ctx) => {
    const id = (ctx.match ?? '').trim()
    if (!id) {
      await ctx.reply('Использование: /untrigger <id>')
      return
    }
    const ok = await deps.onCancelTrigger?.(id)
    await ctx.reply(ok === true ? '✅ Снят' : '❌ Не найден')
  })

  // --- approval card taps ---
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data
    await ctx.answerCallbackQuery()

    // Settings toggle (event-bridge callback) — flip + re-render the panel.
    if (data.startsWith('set:')) {
      const key = data.slice(4)
      if (deps.settings && (key === 'showCostPerTurn' || key === 'budgetEnabled')) {
        deps.settings.toggle(key)
        const msg = settingsPanel()
        if (msg) {
          await ctx.editMessageText(msg.html, {
            parse_mode: 'HTML',
            ...(msg.buttons ? { reply_markup: toInlineKeyboard(msg.buttons) } : {}),
          })
        }
      }
      return
    }
    if (data === 'spend:refresh') {
      await sendSpendReport()
      return
    }
    // Budget alert actions: details → spend report; resume → lift enforcement.
    if (data === 'budget:details') {
      await sendSpendReport()
      return
    }
    if (data === 'budget:resume') {
      deps.settings?.set('budgetEnabled', false)
      await bot.api.sendMessage(deps.allowedChatId, '▶️ Бюджет-гейт снят. Снова включить — в ⚙️ Настройках.')
      return
    }

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

    // Nightly staging approval (Tier-4 C2). ctx.answerCallbackQuery() was already
    // called at the top of this handler; the unjudged branch re-answers with a toast
    // via a separate call (Telegram accepts the second answer when text differs).
    if (data.startsWith('nightly:approve:')) {
      const id = data.slice('nightly:approve:'.length)
      try {
        await deps.onApproveNightly?.(id)
        await ctx.reply('✅ Правка применена в память.')
      } catch {
        await ctx.reply('❌ Не удалось применить (возможно, изменилась с момента staging).')
      }
      return
    }
    if (data === 'nightly:unjudged') {
      // Override the silent top-level answer with a toast explaining why.
      await bot.api.answerCallbackQuery(ctx.callbackQuery.id, { text: 'Ещё не проверено судьёй' })
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

    // Reply-keyboard menu taps arrive as plain text — route them to panels
    // instead of feeding the label to the agent as a task.
    const menuAction = resolveMenu(text)
    if (menuAction) {
      await handleMenu(menuAction)
      return
    }

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

  return {
    bot,
    runProactiveTurn: (prompt: string, opts?: { provenance?: Provenance }): Promise<void> =>
      runTurn([{ text: prompt, provenance: opts?.provenance ?? 'operator' }]),
    sendProactive: (text: string): Promise<void> => sendReply(text),
  }
}
