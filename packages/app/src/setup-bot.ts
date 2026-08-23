import { Bot, InlineKeyboard } from 'grammy'
import type {
  AuthChallenge,
  BrainBootstrap,
  BrainBootstrapCoordinator,
  BrainBootstrapState,
} from '@aisy/core'
import {
  decodeBrainBootstrapAction,
  renderBrainAuthChallenge,
  renderBrainBootstrap,
  renderBrainVendor,
  type BootstrapButton,
} from '@aisy/telegram-gw'
import type { ClaudeTokenSetup } from './claude-subscription-setup.js'

export interface SetupTelegramBotDeps {
  token: string
  allowedChatId: number
  bootstrap: BrainBootstrap
  /** Driver orchestration seam; omitted by live setup until activation is approved. */
  coordinator?: BrainBootstrapCoordinator
  /** `claude setup-token` intake for the Claude subscription. */
  claudeToken?: ClaudeTokenSetup
  /**
   * Called once the operator leaves BRAIN_READY. Setup mode and the full agent
   * are different compositions chosen at boot, so the honest way to hand over
   * is to end this process and let the service manager start the agent.
   */
  onBrainReady?: () => void
  onError?: (code: 'setup_update_failed') => void
  /** Test seam; production registers commands by default. */
  registerCommands?: boolean
}

const INTRO_HANDOVER = [
  'brain-ready-acknowledged',
  'agent-intro-completed',
  'operator-intro-completed',
  'first-project-completed',
  'initial-autonomy-completed',
] as const

const CREDENTIAL_ERRORS: Record<string, string> = {
  CREDENTIAL_EMPTY: 'Пустое сообщение — пришли сам ключ.',
  UNSUPPORTED_PROVIDER: 'Этот провайдер не поддерживает вход по ключу.',
  AUTH_REJECTED: 'Провайдер отклонил ключ. Проверь, что скопирован целиком.',
  VALIDATION_RATE_LIMITED: 'Провайдер временно ограничил проверки. Повтори через минуту.',
  VALIDATION_UNAVAILABLE: 'Не удалось достучаться до провайдера. Повтори попытку.',
  VAULT_CORRUPT: 'Хранилище секретов повреждено — ключ не сохранён.',
  CONFIG_CORRUPT: 'Файл с настройками мозга повреждён — ключ не сохранён.',
  PERSISTENCE_FAILED: 'Не удалось сохранить ключ на диск.',
  TOKEN_EMPTY: 'Пустое сообщение — пришли сам токен.',
  TOKEN_MALFORMED: 'Это не похоже на токен `claude setup-token`. Нужна строка вида sk-ant-… без лишнего текста.',
  CLAUDE_NOT_INSTALLED: 'Claude Code не установлен на сервере — вернись назад и нажми «Повторить».',
  TOKEN_REJECTED: 'Claude не принял токен. Проверь, что подписка активна, и получи токен заново.',
}

function toInlineKeyboard(rows: BootstrapButton[][]): InlineKeyboard | undefined {
  if (rows.length === 0) return undefined
  const keyboard = new InlineKeyboard()
  for (const [index, row] of rows.entries()) {
    if (index > 0) keyboard.row()
    for (const button of row) keyboard.text(button.text, button.data)
  }
  return keyboard
}

export function makeSetupTelegramBot(deps: SetupTelegramBotDeps): { bot: Bot } {
  const bot = new Bot(deps.token)

  bot.use(async (ctx, next) => {
    if (ctx.chat?.id !== deps.allowedChatId) return
    await next()
  })

  if (deps.registerCommands !== false) {
    // Same reasoning as the agent bot: clear the narrower scopes first, or a
    // list left behind by a previous owner of this token stays on screen.
    void (async () => {
      for (const scope of [
        { type: 'all_private_chats' } as const,
        { type: 'chat' as const, chat_id: deps.allowedChatId },
      ]) {
        await bot.api.deleteMyCommands({ scope }).catch(() => {})
      }
      await bot.api.setMyCommands([
        { command: 'start', description: 'Продолжить настройку' },
        { command: 'menu', description: 'Продолжить настройку' },
      ])
    })().catch(() => {})
  }

  const pairedState = async (): Promise<BrainBootstrapState> => {
    const current = await deps.bootstrap.state()
    const paired = current.phase === 'NO_BRAIN'
      ? deps.bootstrap.dispatch({ type: 'telegram-paired' })
      : current
    const state = await paired
    if (deps.coordinator && state.phase === 'VALIDATING_AUTH') {
      return (await deps.coordinator.resume(state.revision)).state
    }
    return state
  }

  const sendCurrent = async (): Promise<void> => {
    const view = renderBrainBootstrap(await pairedState())
    const keyboard = toInlineKeyboard(view.buttons)
    await bot.api.sendMessage(deps.allowedChatId, view.text, {
      ...(keyboard ? { reply_markup: keyboard } : {}),
    })
  }

  bot.command(['start', 'menu'], async () => {
    await sendCurrent()
  })

  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery()
    const action = decodeBrainBootstrapAction(ctx.callbackQuery.data)
    if (!action) return

    try {
      const durable = await deps.bootstrap.state()
      if (durable.revision !== action.expectedRevision) throw new Error('stale setup card')
      let next: BrainBootstrapState
      let challenge: AuthChallenge | undefined
      let detail: string | undefined
      let handOver = false
      if (action.kind === 'vendor' || action.kind === 'vendors') {
        // Choosing a vendor changes nothing durable — it only opens the second
        // level of the same question, so no phase moves and no revision burns.
        const current = await deps.bootstrap.state()
        const view = action.kind === 'vendor'
          ? renderBrainVendor(current, action.vendorId)
          : renderBrainBootstrap(current)
        const keyboard = toInlineKeyboard(view.buttons)
        await ctx.editMessageText(view.text, {
          ...(keyboard ? { reply_markup: keyboard } : {}),
        })
        return
      }
      if (action.kind === 'reset') {
        next = await deps.bootstrap.dispatch({ type: 'reset-brain' })
      } else if (action.kind === 'select') {
        // Key-based brains have no runtime to detect and no login to drive, so
        // they go straight to AWAITING_AUTH and the key arrives as a message.
        if (deps.coordinator && action.event.authMode !== 'api-key') {
          // The install happens inside selectAndPrepare and can take a minute.
          // Say so before the await: silence for a minute reads as a dead tap.
          await ctx.editMessageText(
            'Проверяю движок на сервере и при необходимости ставлю его. До минуты…',
          ).catch(() => {})
          const prepared = await deps.coordinator.selectAndPrepare(
            action.event, action.expectedRevision,
          )
          next = prepared.state
          detail = prepared.safeDetail
        } else {
          next = await deps.bootstrap.dispatch(action.event)
        }
      } else if (action.operation === 'start-intro') {
        // Setup ends here: the brain is wired and from this point the agent
        // itself runs the introduction as a conversation, so the remaining
        // intro phases have no card left to render. How far that conversation
        // has got is tracked by `onboarding-progress.json`, not by these phases
        // — they are walked through only to leave the machine in COMPLETE.
        for (const type of INTRO_HANDOVER) next = await deps.bootstrap.dispatch({ type })
        next = await deps.bootstrap.state()
        handOver = true
      } else {
        if (!deps.coordinator) throw new Error('setup coordinator unavailable')
        const result = action.operation === 'retry-install'
          ? await deps.coordinator.retryInstallation(action.expectedRevision)
          : action.operation === 'begin-auth'
            ? await deps.coordinator.beginAuth(action.expectedRevision)
            : await deps.coordinator.completeAuth(action.expectedRevision)
        next = result.state
        challenge = result.challenge
        detail = result.safeDetail
      }
      const view = challenge
        ? renderBrainAuthChallenge(next, challenge)
        : renderBrainBootstrap(next, detail)
      const keyboard = toInlineKeyboard(view.buttons)
      await ctx.editMessageText(view.text, {
        ...(keyboard ? { reply_markup: keyboard } : {}),
      })
      // Only after the operator has seen the card: the hand-over ends this
      // process, and a card the operator never saw is a silent restart.
      if (handOver) deps.onBrainReady?.()
    } catch {
      // Stale/replayed buttons and persistence failures never advance setup.
      // Re-render the durable state without leaking exception/provider details.
      await sendCurrent().catch(() => {})
    }
  })

  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return
    const state = await deps.bootstrap.state()
    const selected = state.selectedBrain
    if (state.phase === 'AWAITING_AUTH' && selected?.authMode === 'api-key') {
      // AC-16-34: ordinary Telegram is not a credential ingress. Delete a
      // mistakenly sent value best-effort, but never validate, persist, echo or
      // advance the state machine from its bytes.
      let deleted = true
      try {
        await ctx.deleteMessage()
      } catch {
        deleted = false
      }
      await ctx.reply(
      'Ввод API-ключа в Telegram отключён. Защищённое системное хранилище и посредник ещё не подключены; ' +
        'выбери мозг по подписке или вернись назад.' +
        (deleted ? '' : '\n\n⚠️ Удали отправленный ключ вручную и отзови его у провайдера.'),
      )
      return
    }
    // Claude `setup-token` remains the subscription vendor's explicit
    // bootstrap flow; native API credentials never enter this transport.
    const intake = state.phase !== 'AWAITING_AUTH' || selected === undefined
      ? null
      : selected.connectionId === 'claude-subscription' && deps.claudeToken
        ? {
            run: async (secret: string) => {
              const result = await deps.claudeToken!.validateAndStore(secret)
              return result.ok ? { ok: true as const, detail: undefined } : result
            },
            accepted: 'Токен принят, подписка Claude отвечает.',
            noun: 'токен',
          }
        : null
    if (intake === null) {
      await ctx.reply(
        'Сейчас подключаем первый мозг. Используй кнопки в карточке или /menu.',
        { reply_markup: { remove_keyboard: true } },
      )
      return
    }

    // Delete first: from here on the secret exists on Telegram's servers for as
    // little as we can manage, and every later step can fail without leaving
    // it sitting in the chat history.
    const secret = ctx.message.text
    let deleted = true
    try {
      await ctx.deleteMessage()
    } catch {
      deleted = false
    }

    const result = await intake.run(secret)
    if (!result.ok) {
      await deps.bootstrap.dispatch({ type: 'auth-failed', errorCode: result.errorCode })
      const hint = CREDENTIAL_ERRORS[result.errorCode] ?? `${intake.noun} не принят.`
      await ctx.reply(
        `❌ ${hint}${deleted ? '' : `\n\n⚠️ Удали сообщение с ${intake.noun}ом вручную.`}`,
      )
      await sendCurrent().catch(() => {})
      return
    }

    await deps.bootstrap.dispatch({ type: 'auth-completed' })
    const ready = await deps.bootstrap.dispatch({ type: 'validation-succeeded' })
    if (!deleted) {
      await ctx.reply(`⚠️ Не смог удалить сообщение с ${intake.noun}ом — удали его вручную.`)
    }
    await ctx.reply(`✅ ${intake.accepted}${result.detail === undefined ? '' : ` ${result.detail}`}`)
    const view = renderBrainBootstrap(ready)
    const keyboard = toInlineKeyboard(view.buttons)
    await ctx.reply(view.text, { ...(keyboard ? { reply_markup: keyboard } : {}) })
  })

  bot.catch(() => {
    deps.onError?.('setup_update_failed')
  })

  return { bot }
}
