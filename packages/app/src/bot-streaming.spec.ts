import { describe, expect, it, vi } from 'vitest'
import type { Update, UserFromGetMe } from 'grammy/types'

import { makeGateway, type AgentRunner } from '@aisy/core'
import { makeTelegramBot, type TelegramBotDeps } from './bot.js'
import {
  authenticateExecutionSupervisorChild,
  encodeExecutionSupervisorFrame,
  makeExecutionSupervisorSessionProof,
  type ExecutionSupervisorChannel,
  type ExecutionSupervisorFrame,
} from './execution-supervisor-ipc.js'
import {
  makeJsonTelegramExecutionCheckpointStore,
  makeTelegramExecutionCheckpoint,
  type TelegramExecutionCheckpointStore,
} from './telegram-execution-checkpoint.js'
import type { TelegramExecutionAuthorityPublisher } from './telegram-execution-startup-recovery.js'

const BOT_INFO: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: 'Aisy',
  username: 'aisy_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}

function textUpdate(updateId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: updateId,
      chat: { id: 42, type: 'private', first_name: 'Operator' },
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      text,
      ...(text.startsWith('/')
        ? { entities: [{ type: 'bot_command' as const, offset: 0, length: text.length }] }
        : {}),
    },
  }
}

function tapUpdate(updateId: number, data: string, messageId: number): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: messageId,
        date: 0,
        chat: { id: 42, type: 'private', first_name: 'Operator' },
        text: 'карточка',
      },
    },
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Telegram call not observed')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function harness(
  runner: AgentRunner,
  durableExecution = false,
  authority?: TelegramExecutionAuthorityPublisher,
  checkpointStoreOverride?: TelegramExecutionCheckpointStore,
  buildExecutionRunner?: TelegramBotDeps['buildExecutionRunner'],
  durableTurnControl?: TelegramBotDeps['durableTurnControl'],
  afterReplyDelivered?: TelegramBotDeps['afterReplyDelivered'],
  failFinalEdit = false,
  extraDeps: Pick<
    TelegramBotDeps,
    'getStaging' | 'grammaticalGender' | 'observeAuthenticatedOperatorText'
  > = {},
) {
  let untrustedContext = false
  let messageId = 100
  const gateway = makeGateway({
    getAllowedChatId: async () => 42,
    getBotToken: async () => 'unused',
    isReady: () => true,
    transcribeVoice: async () => '',
    // The live composition wires this to a constant false (ADR-0095); the
    // gateway keeps the capability, so the harness keeps it wired too.
    isOutboundLocked: () => false,
    isSafetyAvailable: () => true,
  })
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  let checkpointContent: string | undefined
  const checkpointStore = checkpointStoreOverride ?? makeJsonTelegramExecutionCheckpointStore({
    exists: () => checkpointContent !== undefined,
    read: () => checkpointContent ?? '',
    saveAtomic: (content) => { checkpointContent = content },
  })
  const runtime = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => ({ sessionId: 'session-a', runner }),
    ...(buildExecutionRunner === undefined ? {} : { buildExecutionRunner }),
    ...(durableTurnControl === undefined ? {} : { durableTurnControl }),
    ...(afterReplyDelivered === undefined ? {} : { afterReplyDelivered }),
    setUntrustedContext: (untrusted: boolean) => { untrustedContext = untrusted },
    model: 'test-model',
    grammaticalGender: () => 'masculine',
    debounceMs: 1,
    streamEditIntervalMs: 0,
    registerCommands: false,
    ...extraDeps,
    ...(durableExecution
      ? {
          executionCheckpoint: {
            store: checkpointStore,
            newOwnerId: () => 'bot-runtime-a',
            nowIso: () => '2026-07-28T06:00:00.000Z',
            ...(authority === undefined ? {} : { authority }),
          },
        }
      : {}),
  })
  const { bot } = runtime
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    if (failFinalEdit && method === 'editMessageText') throw new Error('ambiguous edit')
    if (method === 'sendMessage') {
      return {
        ok: true,
        result: {
          message_id: ++messageId,
          date: 0,
          chat: { id: 42, type: 'private' },
          text: String((payload as { text?: unknown }).text ?? ''),
        },
      } as never
    }
    return { ok: true, result: true } as never
  })
  return {
    bot, calls, checkpointStore,
    sendProactive: runtime.sendProactive,
    sendNightlyNotice: runtime.sendNightlyNotice,
    resumeDurableTurn: runtime.resumeDurableTurn,
    checkpointContent: () => checkpointContent,
    untrustedContext: () => untrustedContext,
  }
}

const LIVENESS = 'b'.repeat(64)
const PARENT_NONCE = 'p'.repeat(43)
const CHILD_NONCE = 'c'.repeat(43)
const SUPERVISOR_SESSION = 's'.repeat(43)
const LEASE_ID = 'l'.repeat(43)

function frame(value: ExecutionSupervisorFrame): string {
  return encodeExecutionSupervisorFrame(value)
}

interface AuthorityControl {
  disconnect: () => void
}

function genuineAuthorityPublisher(
  order: string[],
  control?: AuthorityControl,
): TelegramExecutionAuthorityPublisher {
  return {
    async captureTurn(bindingHash) {
      const replies = [
        frame({
          version: 3,
          type: 'hello-challenge',
          requestId: 'hello-1',
          deadlineAtMs: 3_000,
          parentNonce: PARENT_NONCE,
        }),
        frame({
          version: 3,
          type: 'hello-ack',
          requestId: 'hello-1',
          deadlineAtMs: 3_000,
          sessionId: SUPERVISOR_SESSION,
          sessionProof: makeExecutionSupervisorSessionProof({
            requestId: 'hello-1',
            parentNonce: PARENT_NONCE,
            childNonce: CHILD_NONCE,
            sessionId: SUPERVISOR_SESSION,
            livenessDescriptorHash: LIVENESS,
          }),
        }),
      ]
      let disconnectListener = (): void => {}
      const channel: ExecutionSupervisorChannel = {
        send(line) {
          const sent = JSON.parse(line) as ExecutionSupervisorFrame
          if (sent.type === 'capture') {
            order.push('capture')
            replies.push(frame({
              version: 3,
              type: 'capture-ack',
              requestId: sent.requestId,
              deadlineAtMs: sent.deadlineAtMs,
              sessionId: SUPERVISOR_SESSION,
              bindingHash,
              leaseId: LEASE_ID,
            }))
          } else if (sent.type === 'checkpoint-bound') {
            order.push('bind')
            replies.push(frame({
              version: 3,
              type: 'checkpoint-bound-ack',
              requestId: sent.requestId,
              deadlineAtMs: sent.deadlineAtMs,
              sessionId: SUPERVISOR_SESSION,
              bindingHash,
              leaseId: LEASE_ID,
            }))
          } else if (sent.type === 'release') {
            order.push('release')
            replies.push(frame({
              version: 3,
              type: 'release-ack',
              requestId: sent.requestId,
              deadlineAtMs: sent.deadlineAtMs,
              sessionId: SUPERVISOR_SESSION,
              bindingHash,
              leaseId: LEASE_ID,
            }))
          }
        },
        async receive() {
          const next = replies.shift()
          if (next === undefined) throw new Error('disconnected')
          return next
        },
        onDisconnect(listener) {
          disconnectListener = listener
          if (control !== undefined) control.disconnect = () => disconnectListener()
          return () => { disconnectListener = () => {} }
        },
        close: () => {},
      }
      const ids = ['capture-1', 'bind-1', 'release-1']
      const session = await authenticateExecutionSupervisorChild({
        channel,
        newRequestId: () => ids.shift() ?? 'unexpected-id',
        randomNonce: () => CHILD_NONCE,
        nowMs: () => 1_000,
        livenessDescriptorHash: LIVENESS,
      })
      return session.captureTurn(bindingHash)
    },
  }
}

function genuineRecoveryAuthorityPublisher(
  order: string[],
  prepareCheckpoint: (bindingHash: string) => void,
): TelegramExecutionAuthorityPublisher {
  return {
    async captureTurn(bindingHash) {
      prepareCheckpoint(bindingHash)
      order.push('adopt')
      const replies = [
        frame({
          version: 3,
          type: 'hello-challenge',
          requestId: 'hello-1',
          deadlineAtMs: 3_000,
          parentNonce: PARENT_NONCE,
        }),
        frame({
          version: 3,
          type: 'hello-ack',
          requestId: 'hello-1',
          deadlineAtMs: 3_000,
          sessionId: SUPERVISOR_SESSION,
          sessionProof: makeExecutionSupervisorSessionProof({
            requestId: 'hello-1',
            parentNonce: PARENT_NONCE,
            childNonce: CHILD_NONCE,
            sessionId: SUPERVISOR_SESSION,
            livenessDescriptorHash: LIVENESS,
          }),
        }),
        frame({
          version: 3,
          type: 'recovery-lease',
          requestId: 'recovery-1',
          deadlineAtMs: 3_000,
          sessionId: SUPERVISOR_SESSION,
          bindingHash,
          leaseId: LEASE_ID,
          authorityPhase: 'checkpoint-bound',
          releaseReceipt: null,
        }),
      ]
      const channel: ExecutionSupervisorChannel = {
        send(line) {
          const sent = JSON.parse(line) as ExecutionSupervisorFrame
          if (sent.type === 'release') {
            order.push('release')
            replies.push(frame({
              version: 3,
              type: 'release-ack',
              requestId: sent.requestId,
              deadlineAtMs: sent.deadlineAtMs,
              sessionId: SUPERVISOR_SESSION,
              bindingHash,
              leaseId: LEASE_ID,
            }))
          }
        },
        async receive() {
          const next = replies.shift()
          if (next === undefined) throw new Error('disconnected')
          return next
        },
        onDisconnect: () => () => {},
        close: () => {},
      }
      const ids = ['recovery-1', 'release-1']
      const session = await authenticateExecutionSupervisorChild({
        channel,
        newRequestId: () => ids.shift() ?? 'unexpected-id',
        randomNonce: () => CHILD_NONCE,
        nowMs: () => 1_000,
        livenessDescriptorHash: LIVENESS,
      })
      const state = await session.requestRecoveryState()
      if (state.kind !== 'lease') throw new Error('recovery lease unavailable')
      return state.lease
    },
  }
}

describe('Telegram structured reply streaming', () => {
  it('replays exact persisted spans without recomposing the parent turn', async () => {
    let content: string | undefined
    const store = makeJsonTelegramExecutionCheckpointStore({
      exists: () => content !== undefined,
      read: () => content ?? '',
      saveAtomic: (next) => { content = next },
    })
    const order: string[] = []
    const authority = genuineRecoveryAuthorityPublisher(order, bindingHash => {
      if (store.load().status !== 'missing') return
      store.begin(makeTelegramExecutionCheckpoint({
        bindingHash,
        ownerId: 'old-runtime',
        revision: 1,
        phase: 'prepared',
        delivery: 'pending',
        locked: true,
        state: { steps: [], thinking: true, status: 'running' },
        updatedAt: '2026-07-28T06:00:00.000Z',
      }))
      store.replace(makeTelegramExecutionCheckpoint({
        bindingHash,
        ownerId: 'old-runtime',
        revision: 2,
        phase: 'bound',
        delivery: 'delivered',
        messageId: 77,
        locked: true,
        state: { steps: [], thinking: true, status: 'running' },
        updatedAt: '2026-07-28T06:00:01.000Z',
      }), { ownerId: 'old-runtime', revision: 1, bindingHash })
    })
    const exact = Object.freeze({
      turnId: 'telegram:42:' + 'a'.repeat(64),
      turnTs: '2026-07-28T06:00:00.000Z',
      spans: Object.freeze([
        Object.freeze({ role: 'system' as const, provenance: 'operator' as const, text: 'exact-system' }),
        Object.freeze({ role: 'user' as const, provenance: 'operator' as const, text: 'exact-user' }),
      ]),
    })
    const seen: unknown[] = []
    const h = harness({
      async handle() { throw new Error('legacy-must-not-run') },
    }, true, authority, store, (_approve, _lease, turn) => {
      seen.push(turn)
      return {
        async handle(input) {
          seen.push(input.spans)
          return { state: 'ok', reply: 'recovered', narrowed: false }
        },
      }
    })

    await expect(h.resumeDurableTurn(exact)).resolves.toBe(true)

    expect(order).toEqual(['adopt', 'release'])
    expect(seen).toEqual([exact, exact.spans])
  })

  it('adopts a checkpoint-bound recovery lease and the exact existing execution card', async () => {
    let content: string | undefined
    const store = makeJsonTelegramExecutionCheckpointStore({
      exists: () => content !== undefined,
      read: () => content ?? '',
      saveAtomic: (next) => { content = next },
    })
    const order: string[] = []
    const authority = genuineRecoveryAuthorityPublisher(order, bindingHash => {
      if (store.load().status !== 'missing') return
      const prepared = makeTelegramExecutionCheckpoint({
        bindingHash,
        ownerId: 'old-runtime',
        revision: 1,
        phase: 'prepared',
        delivery: 'pending',
        locked: true,
        state: { steps: [], thinking: true, status: 'running' },
        updatedAt: '2026-07-28T06:00:00.000Z',
      })
      store.begin(prepared)
      store.replace(makeTelegramExecutionCheckpoint({
        bindingHash,
        ownerId: 'old-runtime',
        revision: 2,
        phase: 'bound',
        delivery: 'delivered',
        messageId: 77,
        locked: true,
        state: { steps: [], thinking: true, status: 'running' },
        updatedAt: '2026-07-28T06:00:01.000Z',
      }), { ownerId: 'old-runtime', revision: 1, bindingHash })
    })
    const h = harness({
      async handle(input) {
        await input.onProgress?.({ type: 'outbound-lockout', locked: false })
        await input.onProgress?.({ type: 'turn-started' })
        return { state: 'ok', reply: 'recovered', narrowed: false }
      },
    }, true, authority, store, (_approve, lease) => {
      expect(lease.authorityPhase).toBe('checkpoint-bound')
      return {
        async handle(input) {
          await input.onProgress?.({ type: 'outbound-lockout', locked: false })
          await input.onProgress?.({ type: 'turn-started' })
          return { state: 'ok', reply: 'recovered', narrowed: false }
        },
      }
    })

    await h.bot.handleUpdate(textUpdate(1, 'Продолжи'))
    await waitFor(() => order.includes('release'))

    expect(order).toEqual(['adopt', 'release'])
    expect(h.calls.some(call => call.method === 'editMessageText' &&
      call.payload['message_id'] === 77)).toBe(true)
    expect(store.load()).toMatchObject({
      status: 'ready',
      checkpoint: {
        ownerId: 'old-runtime',
        phase: 'terminal',
        delivery: 'delivered',
        messageId: 77,
      },
    })
  })

  it('edits one guarded message from Core/provider deltas', async () => {
    const h = harness({
      async handle(input) {
        await input.onProgress?.({ type: 'outbound-lockout', locked: false })
        await input.onProgress?.({ type: 'turn-started' })
        await input.onProgress?.({ type: 'started' })
        await input.onProgress?.({ type: 'text-delta', text: 'Привет' })
        await input.onProgress?.({ type: 'text-delta', text: ' мир' })
        return { state: 'ok', reply: 'Привет мир', narrowed: false }
      },
    })

    await h.bot.handleUpdate(textUpdate(1, 'Ответь'))
    await waitFor(() => h.calls.some(call => call.method === 'editMessageText' &&
      call.payload['text'] === 'Привет мир'))

    const streamedSends = h.calls.filter(call => call.method === 'sendMessage' &&
      call.payload['text'] === 'Привет')
    expect(streamedSends).toHaveLength(1)
    expect(h.calls.some(call => call.method === 'editMessageText' &&
      call.payload['text'] === 'Привет мир')).toBe(true)
    expect(h.checkpointContent()).toBeUndefined()
  })

  it('starts background learning only after the terminal reply was delivered', async () => {
    let h!: ReturnType<typeof harness>
    const observed: string[] = []
    h = harness({
      async handle() {
        return { state: 'ok', reply: 'Основной ответ', narrowed: false }
      },
    }, false, undefined, undefined, undefined, undefined, ({ result }) => {
      const delivered = h.calls.some(call => call.method === 'sendMessage' &&
        call.payload['text'] === 'Основной ответ')
      observed.push(`${delivered}:${result.reply}`)
    })

    await h.bot.handleUpdate(textUpdate(1, 'Ответь'))
    await waitFor(() => observed.length === 1)

    expect(observed).toEqual(['true:Основной ответ'])
  })

  it('does not confirm learning when the final Telegram edit is delivery-uncertain', async () => {
    const afterReplyDelivered = vi.fn()
    const h = harness({
      async handle(input) {
        await input.onProgress?.({ type: 'outbound-lockout', locked: false })
        await input.onProgress?.({ type: 'text-delta', text: 'черновик' })
        return { state: 'ok', reply: 'точный финал', narrowed: false }
      },
    }, false, undefined, undefined, undefined, undefined, afterReplyDelivered, true)

    await h.bot.handleUpdate(textUpdate(1, 'Ответь'))
    await waitFor(() => h.calls.some(call => call.method === 'editMessageText'))

    expect(afterReplyDelivered).not.toHaveBeenCalled()
  })

  it('delivers the answer of a narrowed turn instead of holding it for a tap', async () => {
    // ADR-0095: the only recipient of a reply is the operator, so an approval
    // card in front of it protected nobody and taught a reflex tap. The verdict
    // still travels — Core keeps refusing tool calls built from untrusted text.
    const h = harness({
      async handle(input) {
        await input.onProgress?.({ type: 'outbound-lockout', locked: true })
        await input.onProgress?.({ type: 'turn-started' })
        await input.onProgress?.({ type: 'text-delta', text: 'ответ по непроверенному тексту' })
        return { state: 'ok', reply: 'ответ по непроверенному тексту', narrowed: true }
      },
    })

    await h.bot.handleUpdate(textUpdate(1, 'Прочитай вложение'))
    await waitFor(() => h.calls.some(call =>
      (call.method === 'sendMessage' || call.method === 'editMessageText') &&
      String(call.payload['text'] ?? '').includes('ответ по непроверенному тексту')))

    expect(h.calls.some(call => String(call.payload['text'] ?? '')
      .includes('Исходящее заблокировано'))).toBe(false)
    expect(h.untrustedContext()).toBe(true)
  })

  it('/stop aborts the turn and prevents later edits', async () => {
    const h = harness({
      async handle(input) {
        await input.onProgress?.({ type: 'outbound-lockout', locked: false })
        await input.onProgress?.({ type: 'turn-started' })
        await input.onProgress?.({ type: 'text-delta', text: 'начало' })
        await new Promise<void>(resolve => {
          if (input.signal?.aborted) resolve()
          else input.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        await input.onProgress?.({ type: 'text-delta', text: ' после stop' })
        return { state: 'halted', haltReason: 'stopped', reply: '', narrowed: false }
      },
    })

    await h.bot.handleUpdate(textUpdate(1, 'Начинай'))
    await waitFor(() => h.calls.some(call => call.method === 'sendMessage' &&
      call.payload['text'] === 'начало'))
    await h.bot.handleUpdate(textUpdate(2, '/stop'))
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(h.calls.filter(call => call.method === 'sendMessage')
      .map(call => call.payload['text'])).toContain('⏹ Остановлено.')

    expect(h.calls.some(call => call.method === 'editMessageText' &&
      String(call.payload['text'] ?? '').includes('после stop'))).toBe(false)
  })

  it('/stop terminalizes a paused durable actor before requesting supervisor restart', async () => {
    const order: string[] = []
    const h = harness({
      async handle() {
        throw new Error('provider must not run')
      },
    }, false, undefined, undefined, undefined, {
      isRecoverableInterruption: () => false,
      pendingCard: () => null,
      markCardDelivered: () => undefined,
      recordCardDecision: () => ({ kind: 'stale' }),
      retireTurn: () => undefined,
      requestStop() {
        order.push('durable-stop')
        return { kind: 'cancelled', receiptHash: 'a'.repeat(64) }
      },
      requestResume() { order.push('restart') },
    })

    await h.bot.handleUpdate(textUpdate(1, '/stop'))

    expect(order).toEqual(['durable-stop', 'restart'])
    expect(h.calls.filter(call => call.method === 'sendMessage')
      .map(call => call.payload['text'])).toContain('⏹ Остановлено.')
  })

  it('stops the turn from the button on the execution card', async () => {
    // Stopping used to require typing /stop while watching a card that had no
    // buttons at all — on a phone that is the one control that must be a tap.
    const h = harness({
      async handle(input) {
        await input.onProgress?.({ type: 'turn-started' })
        await input.onProgress?.({
          type: 'tool-started', sequence: 1, name: 'bash', category: 'tool',
        })
        await new Promise<void>(resolve => {
          if (input.signal?.aborted) resolve()
          else input.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return { state: 'halted', haltReason: 'stopped', reply: '', narrowed: false }
      },
    })

    await h.bot.handleUpdate(textUpdate(1, 'Собери проект'))
    await waitFor(() => h.calls.some(call => call.method === 'sendMessage' &&
      JSON.stringify(call.payload['reply_markup'] ?? {}).includes('turn:stop')))
    const card = h.calls.find(call => call.method === 'sendMessage' &&
      JSON.stringify(call.payload['reply_markup'] ?? {}).includes('turn:stop'))!
    expect(String(card.payload['text'] ?? '')).toContain('Работаю')

    await h.bot.handleUpdate(tapUpdate(2, 'turn:stop', 101))
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(h.calls.filter(call => call.method === 'sendMessage')
      .map(call => call.payload['text'])).toContain('⏹ Остановлено.')
    // The card outlives a stopped turn, so its button must not: there is
    // nothing left to stop.
    expect(h.calls.some(call => call.method === 'editMessageReplyMarkup')).toBe(true)
  })

  it('renders tool and subagent lifecycle without arguments or results', async () => {
    const h = harness({
      async handle(input) {
        await input.onProgress?.({ type: 'outbound-lockout', locked: false })
        await input.onProgress?.({ type: 'turn-started' })
        await input.onProgress?.({
          type: 'tool-pending', sequence: 1, name: 'spawn_subagent', category: 'subagent',
        })
        await input.onProgress?.({
          type: 'tool-started', sequence: 1, name: 'spawn_subagent', category: 'subagent',
        })
        await input.onProgress?.({
          type: 'tool-completed', sequence: 1, name: 'spawn_subagent', category: 'subagent',
        })
        return { state: 'ok', reply: 'готово', narrowed: false }
      },
    })

    await h.bot.handleUpdate(textUpdate(1, 'Делегируй'))
    await waitFor(() => h.calls.some(call => call.method === 'editMessageText' &&
      String(call.payload['text'] ?? '').includes('делегирую: spawn_subagent')))

    const status = h.calls.filter(call => call.method === 'editMessageText')
      .map(call => String(call.payload['text'] ?? '')).join('\n')
    expect(status).toContain('✅ делегирую: spawn_subagent')
    expect(status).not.toContain('args')
    expect(status).not.toContain('result')
  })

  it('renders cumulative Core usage and ignores direct provider usage', async () => {
    const h = harness({
      async handle(input) {
        await input.onProgress?.({ type: 'outbound-lockout', locked: false })
        await input.onProgress?.({ type: 'turn-started' })
        await input.onProgress?.({
          type: 'usage', inputTokens: 999, outputTokens: 999, dollars: 999,
        })
        await input.onProgress?.({
          type: 'turn-usage', inputTokens: 20, outputTokens: 5, dollars: 0.1,
        })
        return {
          state: 'ok',
          reply: 'готово',
          narrowed: false,
          usage: { inputTokens: 20, outputTokens: 5, dollars: 0.1 },
        }
      },
    })

    await h.bot.handleUpdate(textUpdate(1, 'Покажи расход'))
    await waitFor(() => h.calls.some(call => call.method === 'editMessageText'))

    // The provider's own usage claim never reaches the card, and the code-owned
    // total is not shown to the operator either — a price tag under every
    // answer is noise, and it lives in debug for whoever wants it.
    const status = h.calls.filter(call => call.method === 'editMessageText')
      .map(call => String(call.payload['text'] ?? '')).join('\n')
    expect(status).not.toContain('Токены')
    expect(status).not.toContain('999')
  })

  it('announces an ordinary daily Session reset without claiming a memory review', async () => {
    const h = harness({ handle: vi.fn<AgentRunner['handle']>() })

    await h.sendNightlyNotice({ kind: 'session-only', sessionReset: true })

    expect(h.calls.some(call => call.method === 'sendMessage' &&
      call.payload['text'] === '🌅 Начал новую сессию. Память и незавершённая работа сохранены. ' +
        '/resume — вернуться к прошлому разговору.')).toBe(true)
  })

  it.each([
    { kind: 'complete-zero' as const, sessionReset: true },
    { kind: 'complete-n' as const, sessionReset: true, pending: 2 },
    { kind: 'partial-failure' as const, sessionReset: true, pending: 1, failedProjects: 1 },
  ])('keeps the code-owned reset prefix masculine for $kind', async (notice) => {
    const h = harness({ handle: vi.fn<AgentRunner['handle']>() })

    await h.sendNightlyNotice(notice)

    const sent = h.calls.find(call => call.method === 'sendMessage')
    expect(sent?.payload['text']).toMatch(/^🌅 Начал новую сессию\./u)
    expect(sent?.payload['text']).not.toContain('Начала новую сессию')
  })

  it.each([
    { gender: 'masculine' as const, prefix: '🌅 Начал новую сессию.' },
    { gender: 'feminine' as const, prefix: '🌅 Начала новую сессию.' },
    { gender: 'neutral' as const, prefix: '🌅 Новая сессия начата.' },
  ])('uses the selected $gender gender in code-owned reset notices', async ({ gender, prefix }) => {
    const h = harness(
      { handle: vi.fn<AgentRunner['handle']>() },
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { grammaticalGender: () => gender },
    )

    await h.sendNightlyNotice({ kind: 'session-only', sessionReset: true })

    const sent = h.calls.find(call => call.method === 'sendMessage')
    expect(String(sent?.payload['text'] ?? '').startsWith(prefix)).toBe(true)
  })

  it('observes authenticated ordinary wording for the typed preference overlay', async () => {
    const observe = vi.fn()
    const h = harness(
      { handle: vi.fn<AgentRunner['handle']>().mockResolvedValue({
        state: 'ok', reply: 'Хорошо.', narrowed: false,
      }) },
      false, undefined, undefined, undefined, undefined, undefined, false,
      { observeAuthenticatedOperatorText: observe },
    )

    await h.bot.handleUpdate(textUpdate(17, 'Говори короче'))
    await waitFor(() => observe.mock.calls.length === 1)

    expect(observe).toHaveBeenCalledWith({
      text: 'Говори короче',
      sessionId: '42',
      updateId: 17,
    })
  })

  it('opens available staged memory edits for a bare natural «Покажи» without running the agent', async () => {
    const handle = vi.fn<AgentRunner['handle']>()
    const h = harness(
      { handle }, false, undefined, undefined, undefined, undefined, undefined, false,
      {
        getStaging: async () => [{ id: 'edit-1', preview: 'Уточнить предпочтение', judged: true }],
      },
    )

    await h.sendNightlyNotice({ kind: 'complete-n', sessionReset: true, pending: 1 })
    await h.bot.handleUpdate(textUpdate(1, 'Покажи'))

    expect(handle).not.toHaveBeenCalled()
    const stagingCard = h.calls.find(call => call.method === 'sendMessage' &&
      String(call.payload['text'] ?? '').includes('Правки памяти ждут решения'))
    expect(stagingCard).toBeDefined()
    expect(JSON.stringify(stagingCard?.payload['reply_markup'])).toContain('Уточнить предпочтение')
  })

  it('does not let stale staging hijack an unarmed bare «Покажи»', async () => {
    const result = {
      state: 'ok' as const,
      reply: 'Что показать?',
      narrowed: false,
    }
    const getStaging = vi.fn(async () => [
      { id: 'edit-1', preview: 'Уточнить предпочтение', judged: true },
    ])
    const handle = vi.fn<AgentRunner['handle']>().mockResolvedValue(result)
    const h = harness(
      { handle }, false, undefined, undefined, undefined, undefined, undefined, false,
      { getStaging },
    )

    await h.bot.handleUpdate(textUpdate(1, 'Покажи'))
    await waitFor(() => handle.mock.calls.length === 1)
    expect(handle).toHaveBeenCalledOnce()
    expect(getStaging).not.toHaveBeenCalled()
  })

  it('answers zero staging without provider and does not hijack a concrete object', async () => {
    const result = {
      state: 'ok' as const,
      reply: 'Что показать?',
      narrowed: false,
    }
    const emptyHandle = vi.fn<AgentRunner['handle']>().mockResolvedValue(result)
    const empty = harness(
      { handle: emptyHandle }, false, undefined, undefined, undefined, undefined, undefined, false,
      { getStaging: async () => [] },
    )
    await empty.sendNightlyNotice({ kind: 'complete-zero', sessionReset: true })

    await empty.bot.handleUpdate(textUpdate(1, 'Покажи'))
    expect(emptyHandle).not.toHaveBeenCalled()
    expect(empty.calls.some(call => call.method === 'sendMessage' &&
      call.payload['text'] === 'Новых правок нет.')).toBe(true)

    const getStaging = vi.fn(async () => [
      { id: 'edit-1', preview: 'Уточнить предпочтение', judged: true },
    ])
    const concreteHandle = vi.fn<AgentRunner['handle']>().mockResolvedValue(result)
    const concrete = harness(
      { handle: concreteHandle }, false, undefined, undefined, undefined, undefined, undefined, false,
      { getStaging },
    )
    await concrete.sendNightlyNotice({ kind: 'complete-n', sessionReset: false, pending: 1 })

    await concrete.bot.handleUpdate(textUpdate(2, 'Покажи файл'))
    await waitFor(() => concreteHandle.mock.calls.length === 1)
    expect(concreteHandle).toHaveBeenCalledOnce()
    expect(getStaging).not.toHaveBeenCalled()
  })

  it('keeps steering precedence over an armed staging shortcut during an active turn', async () => {
    let finish!: (value: Awaited<ReturnType<AgentRunner['handle']>>) => void
    const pending = new Promise<Awaited<ReturnType<AgentRunner['handle']>>>(resolve => {
      finish = resolve
    })
    const handle = vi.fn<AgentRunner['handle']>(() => pending)
    const getStaging = vi.fn(async () => [
      { id: 'edit-1', preview: 'Уточнить предпочтение', judged: true },
    ])
    const h = harness(
      { handle }, false, undefined, undefined, undefined, undefined, undefined, false,
      { getStaging },
    )

    await h.bot.handleUpdate(textUpdate(1, 'Начни долгий ответ'))
    await waitFor(() => handle.mock.calls.length === 1)
    await h.sendNightlyNotice({ kind: 'complete-n', sessionReset: false, pending: 1 })
    const messagesBeforeSteer = h.calls.filter(call => call.method === 'sendMessage').length
    await h.bot.handleUpdate(textUpdate(2, 'Покажи'))
    const messagesAfterSteer = h.calls.filter(call => call.method === 'sendMessage').length
    finish({ state: 'ok', reply: 'Готово', narrowed: false })

    expect(getStaging).not.toHaveBeenCalled()
    expect(messagesAfterSteer).toBe(messagesBeforeSteer + 1)
  })

  it('does not arm a shortcut from ordinary proactive text that resembles an old notice', async () => {
    const handle = vi.fn<AgentRunner['handle']>().mockResolvedValue({
      state: 'ok', reply: 'Что показать?', narrowed: false,
    })
    const getStaging = vi.fn(async () => [
      { id: 'edit-1', preview: 'Уточнить предпочтение', judged: true },
    ])
    const h = harness(
      { handle }, false, undefined, undefined, undefined, undefined, undefined, false,
      { getStaging },
    )
    await h.sendProactive(
      '🌅 Разобрала память за 2026-08-27: 1 правок ждут решения. Открой карточку — покажу каждую.',
    )

    await h.bot.handleUpdate(textUpdate(3, 'Покажи'))
    await waitFor(() => handle.mock.calls.length === 1)

    expect(getStaging).not.toHaveBeenCalled()
  })

  it('reports a partial empty result deterministically and consumes it once', async () => {
    const handle = vi.fn<AgentRunner['handle']>().mockResolvedValue({
      state: 'ok', reply: 'Что показать?', narrowed: false,
    })
    const h = harness({ handle })
    await h.sendNightlyNotice({
      kind: 'partial-failure', sessionReset: false, pending: 0, failedProjects: 1,
    })

    await h.bot.handleUpdate(textUpdate(4, 'Покажи'))
    expect(handle).not.toHaveBeenCalled()
    expect(h.calls.some(call => call.method === 'sendMessage' &&
      call.payload['text'] === 'Доступных правок нет; часть проектов не проверена.')).toBe(true)

    await h.bot.handleUpdate(textUpdate(5, 'Покажи'))
    await waitFor(() => handle.mock.calls.length === 1)
  })

  it('renders action recovery and the authoritative unverified result', async () => {
    const h = harness({
      async handle(input) {
        await input.onProgress?.({ type: 'outbound-lockout', locked: false })
        await input.onProgress?.({ type: 'turn-started' })
        await input.onProgress?.({ type: 'action-contract', kind: 'mutate-required' })
        await input.onProgress?.({
          type: 'action-recovery', kind: 'mutate-required', missing: 'postcondition',
        })
        return {
          state: 'ok',
          reply: 'Не удалось подтвердить выполнение.',
          narrowed: false,
          actionContractKind: 'mutate-required',
          actionStatus: 'unverified',
        }
      },
    })

    await h.bot.handleUpdate(textUpdate(1, 'Исправь файл'))
    await waitFor(() => h.calls.some(call => call.method === 'editMessageText' &&
      String(call.payload['text'] ?? '').includes('⚠️ Результат не подтверждён')))

    const status = h.calls.filter(call => call.method === 'editMessageText')
      .map(call => String(call.payload['text'] ?? '')).join('\n')
    expect(status).toContain('🎯 Действие: Изменение')
    expect(status).not.toContain('postcondition')
  })

  it('starts a durable redacted execution checkpoint before provider work', async () => {
    let checkpointWasReady = false
    let h!: ReturnType<typeof harness>
    const runner: AgentRunner = {
      async handle(input) {
        checkpointWasReady = h.checkpointStore.load().status === 'ready'
        await input.onProgress?.({ type: 'outbound-lockout', locked: false })
        await input.onProgress?.({ type: 'turn-started' })
        await input.onProgress?.({
          type: 'tool-started', sequence: 1, name: 'read_file', category: 'tool',
        })
        return { state: 'ok', reply: 'operator reply body', narrowed: false }
      },
    }
    h = harness(runner, true)

    await h.bot.handleUpdate(textUpdate(1, 'Проверь файл'))
    await waitFor(() => h.checkpointStore.load().status === 'ready' &&
      h.checkpointContent()?.includes('"phase": "terminal"') === true)

    expect(checkpointWasReady).toBe(true)
    expect(h.checkpointStore.load()).toMatchObject({
      status: 'ready',
      checkpoint: {
        phase: 'terminal',
        delivery: 'delivered',
        state: { status: 'completed', thinking: false },
      },
    })
    expect(h.checkpointContent()).not.toContain('operator reply body')
    expect(h.checkpointContent()).not.toContain('Проверь файл')
  })

  it('captures opaque service-manager authority before checkpoint and provider work', async () => {
    let providerCalls = 0
    let h!: ReturnType<typeof harness>
    const captured: string[] = []
    h = harness({
      async handle() {
        providerCalls += 1
        return { state: 'ok', reply: 'must-not-run', narrowed: false }
      },
    }, true, {
      captureTurn(bindingHash) {
        expect(h.checkpointStore.load()).toEqual({ status: 'missing' })
        captured.push(bindingHash)
        throw new Error('private service-manager detail')
      },
    })

    await h.bot.handleUpdate(textUpdate(1, 'Проверь файл'))
    await waitFor(() => captured.length === 1)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(providerCalls).toBe(0)
    expect(h.checkpointStore.load()).toEqual({ status: 'missing' })
    expect(h.calls).toEqual([])
    expect(JSON.stringify(h.calls)).not.toContain('private service-manager detail')
  })

  it('builds the supervised runner only from a genuine bound per-turn lease', async () => {
    const order: string[] = []
    let legacyCalls = 0
    let h!: ReturnType<typeof harness>
    h = harness({
      async handle() {
        legacyCalls += 1
        return { state: 'ok', reply: 'legacy-must-not-run', narrowed: false }
      },
    }, true, genuineAuthorityPublisher(order), undefined, (_approve, lease) => {
      expect(lease.isHeld()).toBe(true)
      expect(lease.authorityPhase).toBe('checkpoint-bound')
      expect(h.checkpointStore.load()).toMatchObject({
        status: 'ready', checkpoint: { phase: 'bound', delivery: 'delivered' },
      })
      order.push('builder')
      return {
        async handle() {
          order.push('provider')
          return { state: 'ok', reply: 'supervised', narrowed: false }
        },
      }
    })

    await h.bot.handleUpdate(textUpdate(1, 'Проверь файл'))
    await waitFor(() => order.includes('release'))

    expect(order).toEqual(['capture', 'bind', 'builder', 'provider', 'release'])
    expect(legacyCalls).toBe(0)
  })

  it('rejects a structural authority copy before runner construction or provider I/O', async () => {
    let providerCalls = 0
    let builderCalls = 0
    let failClosedCalls = 0
    const h = harness({
      async handle() {
        providerCalls += 1
        return { state: 'ok', reply: 'must-not-run', narrowed: false }
      },
    }, true, {
      async captureTurn(bindingHash) {
        return {
          bindingHash,
          authorityPhase: 'captured-unbound' as const,
          isHeld: () => true,
          async bindCheckpoint() {},
          async release() {},
          failClosed(): never {
            failClosedCalls += 1
            throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
          },
        }
      },
    }, undefined, () => {
      builderCalls += 1
      throw new Error('must-not-build')
    })

    await h.bot.handleUpdate(textUpdate(1, 'Проверь файл'))
    await waitFor(() => failClosedCalls === 1)

    expect(builderCalls).toBe(0)
    expect(providerCalls).toBe(0)
    expect(JSON.stringify(h.calls)).not.toContain('must-not-run')
    expect(JSON.stringify(h.calls)).not.toContain('Ход прерван ошибкой')
    expect(h.checkpointStore.load()).toMatchObject({
      status: 'ready', checkpoint: { phase: 'bound', delivery: 'delivered' },
    })
  })

  it('does not fall back when genuine authority is lost during runner construction', async () => {
    const order: string[] = []
    let legacyCalls = 0
    let builderCalls = 0
    const h = harness({
      async handle() {
        legacyCalls += 1
        return { state: 'ok', reply: 'must-not-run', narrowed: false }
      },
    }, true, genuineAuthorityPublisher(order), undefined, (_approve, lease) => {
      builderCalls += 1
      return lease.failClosed()
    })

    await h.bot.handleUpdate(textUpdate(1, 'Проверь файл'))
    await waitFor(() => builderCalls === 1)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(order).toEqual(['capture', 'bind'])
    expect(legacyCalls).toBe(0)
    expect(JSON.stringify(h.calls)).not.toContain('must-not-run')
    expect(JSON.stringify(h.calls)).not.toContain('Ход прерван ошибкой')
    expect(h.checkpointStore.load()).toMatchObject({
      status: 'ready', checkpoint: { phase: 'bound', delivery: 'delivered' },
    })
  })

  it('rechecks genuine authority after composition and immediately before provider', async () => {
    const order: string[] = []
    const control: AuthorityControl = { disconnect: () => {} }
    let providerCalls = 0
    const h = harness({
      async handle() {
        throw new Error('legacy-must-not-run')
      },
    }, true, genuineAuthorityPublisher(order, control), undefined, () => {
      order.push('builder')
      queueMicrotask(() => control.disconnect())
      return {
        async handle() {
          providerCalls += 1
          return { state: 'ok', reply: 'must-not-run', narrowed: false }
        },
      }
    })

    await h.bot.handleUpdate(textUpdate(1, 'Проверь файл'))
    await waitFor(() => order.includes('builder'))
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(order).toEqual(['capture', 'bind', 'builder'])
    expect(providerCalls).toBe(0)
    expect(JSON.stringify(h.calls)).not.toContain('must-not-run')
    expect(JSON.stringify(h.calls)).not.toContain('Ход прерван ошибкой')
  })

  it('fails the supervisor session when prepared publication is durably ambiguous', async () => {
    let providerCalls = 0
    let failClosedCalls = 0
    let content: string | undefined
    const underlying = makeJsonTelegramExecutionCheckpointStore({
      exists: () => content !== undefined,
      read: () => content ?? '',
      saveAtomic: (next) => { content = next },
    })
    const ambiguous: TelegramExecutionCheckpointStore = {
      load: () => underlying.load(),
      begin(checkpoint) {
        underlying.begin(checkpoint)
        throw new Error('ambiguous checkpoint publish')
      },
      replace: (checkpoint, expected) => underlying.replace(checkpoint, expected),
    }
    const h = harness({
      async handle() {
        providerCalls += 1
        return { state: 'ok', reply: 'must-not-run', narrowed: false }
      },
    }, true, {
      async captureTurn(bindingHash) {
        return {
          bindingHash,
          authorityPhase: 'captured-unbound' as const,
          isHeld: () => true,
          async bindCheckpoint() {},
          async release() {},
          failClosed(): never {
            failClosedCalls += 1
            throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
          },
        }
      },
    }, ambiguous)

    await h.bot.handleUpdate(textUpdate(1, 'Проверь файл'))
    await waitFor(() => failClosedCalls === 1)

    expect(providerCalls).toBe(0)
    expect(h.calls).toEqual([])
    expect(h.checkpointStore.load()).toMatchObject({
      status: 'ready', checkpoint: { phase: 'prepared', delivery: 'pending' },
    })
  })

  it('keeps prepared state and performs zero Telegram/provider I/O when bind fails', async () => {
    let providerCalls = 0
    let held = true
    const h = harness({
      async handle() {
        providerCalls += 1
        return { state: 'ok', reply: 'must-not-run', narrowed: false }
      },
    }, true, {
      async captureTurn(bindingHash) {
        return {
          bindingHash,
          authorityPhase: 'captured-unbound' as const,
          isHeld: () => held,
          async bindCheckpoint() {
            held = false
            throw new Error('private bind failure')
          },
          async release() {},
          failClosed(): never { throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE') },
        }
      },
    })

    await h.bot.handleUpdate(textUpdate(1, 'Проверь файл'))
    await waitFor(() => h.checkpointStore.load().status === 'ready')
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(held).toBe(false)
    expect(providerCalls).toBe(0)
    expect(h.calls).toEqual([])
    expect(h.checkpointStore.load()).toMatchObject({
      status: 'ready', checkpoint: { phase: 'prepared', delivery: 'pending' },
    })
  })

  it('forces replacement if authority is lost after bind ACK and before provider', async () => {
    let providerCalls = 0
    let held = true
    let failClosedCalls = 0
    const h = harness({
      async handle() {
        providerCalls += 1
        return { state: 'ok', reply: 'must-not-run', narrowed: false }
      },
    }, true, {
      async captureTurn(bindingHash) {
        return {
          bindingHash,
          authorityPhase: 'captured-unbound' as const,
          isHeld: () => held,
          async bindCheckpoint() { held = false },
          async release() {},
          failClosed(): never {
            failClosedCalls += 1
            throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
          },
        }
      },
    })

    await h.bot.handleUpdate(textUpdate(1, 'Проверь файл'))
    await waitFor(() => failClosedCalls === 1)

    expect(providerCalls).toBe(0)
    expect(h.calls).toEqual([])
    expect(h.checkpointStore.load()).toMatchObject({
      status: 'ready', checkpoint: { phase: 'prepared', delivery: 'pending' },
    })
  })

  it('awaits authority capture before provider work and releases only after terminal delivery', async () => {
    const order: string[] = []
    let h!: ReturnType<typeof harness>
    h = harness({
      async handle() {
        order.push('provider')
        return { state: 'ok', reply: 'done', narrowed: false }
      },
    }, true, {
      async captureTurn(bindingHash) {
        expect(bindingHash).toMatch(/^[a-f0-9]{64}$/)
        expect(h.checkpointStore.load()).toEqual({ status: 'missing' })
        order.push('capture')
        let held = true
        return {
          bindingHash,
          authorityPhase: 'captured-unbound' as const,
          isHeld: () => held,
          async bindCheckpoint() { order.push('bind') },
          async release() {
            expect(h.checkpointStore.load()).toMatchObject({
              status: 'ready',
              checkpoint: { phase: 'terminal', delivery: 'delivered' },
            })
            order.push('release')
            held = false
          },
          failClosed(): never { throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE') },
        }
      },
    })

    await h.bot.handleUpdate(textUpdate(1, 'Проверь файл'))
    await waitFor(() => order.includes('release'))

    expect(order).toEqual(['capture', 'bind', 'provider', 'release'])
  })

  it('AC-19-44 retires a non-ambiguous failed parent turn before releasing authority', async () => {
    const order: string[] = []
    const control: NonNullable<TelegramBotDeps['durableTurnControl']> = {
      isRecoverableInterruption: () => false,
      pendingCard: () => null,
      markCardDelivered: () => undefined,
      recordCardDecision: () => ({ kind: 'recorded' }),
      retireTurn: () => undefined,
      retireFailedTurn: () => { order.push('retire-failed') },
      requestStop: () => null,
      requestResume: () => undefined,
    }
    const h = harness({
      async handle() {
        throw new Error('legacy-must-not-run')
      },
    }, true, genuineAuthorityPublisher(order), undefined, () => ({
      async handle() {
        order.push('provider')
        throw new Error('provider failed')
      },
    }), control)

    await h.bot.handleUpdate(textUpdate(1, 'эй'))
    await waitFor(() => order.includes('release'))

    expect(order).toEqual(['capture', 'bind', 'provider', 'retire-failed', 'release'])
    expect(h.checkpointStore.load()).toMatchObject({
      status: 'ready', checkpoint: { phase: 'terminal', delivery: 'delivered' },
    })
  })

  it('does no corrective Telegram I/O when authority release fails', async () => {
    let h!: ReturnType<typeof harness>
    let releaseAttempted = false
    h = harness({
      async handle() {
        return { state: 'ok', reply: 'must-not-be-sent', narrowed: false }
      },
    }, true, {
      async captureTurn(bindingHash) {
        return {
          bindingHash,
          authorityPhase: 'captured-unbound' as const,
          isHeld: () => true,
          async bindCheckpoint() {},
          async release() {
            releaseAttempted = true
            throw new Error('private release failure')
          },
          failClosed(): never { throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE') },
        }
      },
    })

    await h.bot.handleUpdate(textUpdate(1, 'Проверь файл'))
    await waitFor(() => {
      const loaded = h.checkpointStore.load()
      return releaseAttempted && loaded.status === 'ready' && loaded.checkpoint.phase === 'terminal'
    })

    expect(h.checkpointStore.load()).toMatchObject({
      status: 'ready',
      checkpoint: { phase: 'terminal', delivery: 'delivered' },
    })
    expect(h.calls.some((call) => String(call.payload['text'] ?? '').includes('must-not-be-sent')))
      .toBe(false)
    expect(JSON.stringify(h.calls)).not.toContain('private release failure')
    expect(JSON.stringify(h.calls)).not.toContain('Ход прерван ошибкой')
  })
})
