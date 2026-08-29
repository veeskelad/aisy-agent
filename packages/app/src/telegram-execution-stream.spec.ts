import { describe, expect, it, vi } from 'vitest'

import {
  makeJsonTelegramExecutionCheckpointStore,
  makeTelegramExecutionBindingHash,
} from './telegram-execution-checkpoint.js'
import { makeTelegramExecutionStream } from './telegram-execution-stream.js'

function harness(debug = false) {
  const calls: string[] = []
  let now = 100
  const abort = new AbortController()
  const stream = makeTelegramExecutionStream({
    sessionId: 'session-a',
    signal: abort.signal,
    editIntervalMs: 0,
    debug,
    nowMs: () => now,
    output: {
      async sendText(html) { calls.push(`send:${html}`); return 9 },
      async editText(id, html) { calls.push(`edit:${id}:${html}`) },
    },
  })
  return { stream, calls, abort, advance: (ms: number) => { now += ms } }
}

describe('Telegram execution stream', () => {
  it('shows technical lifecycle only in explicit debug mode', async () => {
    const h = harness(true)
    await h.stream.handle({ type: 'outbound-lockout', locked: false })
    await h.stream.handle({ type: 'turn-started' })
    await h.stream.handle({
      type: 'tool-started', sequence: 1, name: 'read_file', category: 'tool', arg: 'src/app.ts',
    })

    const visible = h.calls.join('\n')
    expect(visible).toContain('[отладка]')
    expect(visible).toContain('▶️ читаю файл: <code>src/app.ts</code>')
  })

  it('does not churn the Telegram card just to show a clock', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      await h.stream.handle({ type: 'outbound-lockout', locked: false })
      await h.stream.handle({ type: 'turn-started' })
      const before = h.calls.length

      // A long silent think: no events at all, only time passing.
      h.advance(2_000)
      await vi.advanceTimersByTimeAsync(2_000)
      h.advance(2_000)
      await vi.advanceTimersByTimeAsync(2_000)

      expect(h.calls).toHaveLength(before)
      expect(h.calls.at(-1)).toBe('send:Работаю…')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows only a human activity label without command or history', async () => {
    const h = harness()
    await h.stream.handle({ type: 'outbound-lockout', locked: false })
    await h.stream.handle({ type: 'turn-started' })
    await h.stream.handle({
      type: 'tool-started', sequence: 1, name: 'bash', category: 'tool', arg: 'pytest -q',
    })
    h.advance(1_000)
    await h.stream.handle({
      type: 'tool-completed', sequence: 1, name: 'bash', category: 'tool', arg: 'pytest -q',
    })
    await h.stream.handle({
      type: 'tool-started', sequence: 2, name: 'read_file', category: 'tool', arg: 'src/app.ts',
    })

    const last = h.calls.at(-1) ?? ''
    expect(last).toBe('edit:9:Работаю…\nЧитаю файл…')
    expect(h.calls.join('\n')).not.toContain('pytest -q')
    expect(h.calls.join('\n')).not.toContain('src/app.ts')
  })

  it('renders code-owned tool lifecycle and a terminal status in one message', async () => {
    const h = harness()
    await h.stream.handle({ type: 'outbound-lockout', locked: false })
    await h.stream.handle({ type: 'turn-started' })
    await h.stream.handle({ type: 'tool-pending', sequence: 1, name: 'read_file', category: 'tool' })
    await h.stream.handle({ type: 'tool-started', sequence: 1, name: 'read_file', category: 'tool' })
    h.advance(1250)
    await h.stream.handle({ type: 'tool-completed', sequence: 1, name: 'read_file', category: 'tool' })
    await h.stream.complete({ state: 'ok', reply: 'done', narrowed: false })

    expect(h.calls[0]).toBe('send:Работаю…')
    expect(h.calls).toContain('edit:9:Работаю…\nЧитаю файл…')
    expect(h.calls.join('\n')).not.toContain('▶️')
    expect(h.calls.join('\n')).not.toContain('✅ читаю файл')
    expect(h.calls.at(-1)).toBe('edit:9:Готово.')
  })

  it('renders bridge calls of a subscription brain with their elapsed time', async () => {
    const h = harness()
    await h.stream.handle({ type: 'outbound-lockout', locked: false })
    await h.stream.handle({ type: 'turn-started' })
    // A subscription brain owns its loop, so Aisy sees provider-owned events.
    await h.stream.handle({
      type: 'tool-requested', toolCallId: 'mcp-1', name: 'list_dir', args: { path: '.' },
    })
    h.advance(2000)
    await h.stream.handle({ type: 'tool-result', toolCallId: 'mcp-1', result: 'notes.md' })
    await h.stream.complete({ state: 'ok', reply: 'готово', narrowed: false })

    expect(h.calls).toContain('edit:9:Работаю…\nСмотрю папку…')
    expect(h.calls.join('\n')).not.toContain('▶️')
    expect(h.calls.join('\n')).not.toContain('2,0 с')
    // Arguments and results stay out of the card, exactly as for native tools.
    expect(h.calls.some(call => call.includes('notes.md'))).toBe(false)
  })

  it('hides bridge calls of a locked turn like any other capability', async () => {
    const h = harness()
    await h.stream.handle({ type: 'turn-started' })
    await h.stream.handle({ type: 'outbound-lockout', locked: true })
    await h.stream.handle({
      type: 'tool-requested', toolCallId: 'mcp-1', name: 'search_memory', args: { query: 'x' },
    })

    expect(h.calls.some(call => call.includes('ищу в памяти'))).toBe(false)
  })

  it('renders subagent lifecycle without arguments or results', async () => {
    const h = harness()
    await h.stream.handle({ type: 'outbound-lockout', locked: false })
    await h.stream.handle({ type: 'turn-started' })
    await h.stream.handle({
      type: 'tool-started', sequence: 1, name: 'spawn_subagent', category: 'subagent',
    })
    await h.stream.handle({
      type: 'tool-completed', sequence: 1, name: 'spawn_subagent', category: 'subagent',
    })

    expect(h.calls).toContain('edit:9:Работаю…\nДелегирую…')
    expect(h.calls.join('\n')).not.toContain('spawn_subagent')
  })

  it('renders only the code-owned cumulative usage event', async () => {
    const h = harness()
    await h.stream.handle({ type: 'outbound-lockout', locked: false })
    await h.stream.handle({ type: 'turn-started' })
    await h.stream.handle({
      type: 'usage', inputTokens: 999, outputTokens: 999, dollars: 999,
    })
    await h.stream.handle({
      type: 'turn-usage', inputTokens: 12, outputTokens: 3, dollars: 0.05,
    })

    // The provider's own usage claim is ignored; only the code-owned total is
    // kept — and it is not shown to the operator at all, only in debug.
    expect(h.calls.join('\n')).not.toContain('999')
    expect(h.calls.join('\n')).not.toContain('Токены')
  })

  it('keeps action recovery and verification in the private checkpoint', async () => {
    const h = harness()
    await h.stream.handle({ type: 'outbound-lockout', locked: false })
    await h.stream.handle({ type: 'turn-started' })
    await h.stream.handle({ type: 'action-contract', kind: 'inspect-required' })
    await h.stream.handle({
      type: 'action-recovery', kind: 'inspect-required', missing: 'observation',
    })

    expect(h.calls.at(-1)).toBe('send:Работаю…')
    expect(h.calls.join('\n')).not.toContain('доказательства')
    expect(h.calls.join('\n')).not.toContain('Осталось:')

    await h.stream.complete({
      state: 'ok',
      reply: 'done',
      narrowed: false,
      actionContractKind: 'inspect-required',
      actionStatus: 'verified',
    })
    expect(h.calls.at(-1)).toBe('edit:9:Готово.')
    expect(h.calls.at(-1)).not.toContain('Нужно:')
  })

  it('hides capability identity for a locked turn', async () => {
    const h = harness()
    await h.stream.handle({ type: 'outbound-lockout', locked: true })
    await h.stream.handle({ type: 'turn-started' })
    await h.stream.handle({
      type: 'tool-started', sequence: 1, name: 'provider_supplied_tool', category: 'tool',
    })
    await h.stream.handle({ type: 'action-contract', kind: 'mutate-required' })
    await h.stream.complete({
      state: 'ok',
      reply: 'held',
      narrowed: true,
      actionContractKind: 'mutate-required',
      actionStatus: 'unverified',
    })

    expect(h.calls.join('\n')).not.toContain('provider_supplied_tool')
    expect(h.calls.join('\n')).not.toContain('Изменение')
    expect(h.calls.join('\n')).not.toContain('не подтверждён')
    expect(h.calls.at(-1)).toBe('edit:9:Не получилось ответить. Попробовать ещё раз?')
    expect(h.calls.at(-1)).not.toContain('Готово')
  })

  it('drops later events after cancellation', async () => {
    const h = harness()
    await h.stream.handle({ type: 'outbound-lockout', locked: false })
    await h.stream.handle({ type: 'turn-started' })
    h.abort.abort()
    await h.stream.stop()
    const before = h.calls.length
    await h.stream.handle({
      type: 'tool-started', sequence: 1, name: 'read_file', category: 'tool',
    })
    expect(h.calls).toHaveLength(before)
  })

  it('checkpoints before Telegram I/O and leaves a redacted terminal restart record', async () => {
    let content: string | undefined
    const store = makeJsonTelegramExecutionCheckpointStore({
      exists: () => content !== undefined,
      read: () => content ?? '',
      saveAtomic: (next) => { content = next },
    })
    const calls: string[] = []
    const stream = makeTelegramExecutionStream({
      sessionId: 'session-a',
      signal: new AbortController().signal,
      editIntervalMs: 0,
      checkpoint: {
        store,
        bindingHash: makeTelegramExecutionBindingHash({
          chatId: 42,
          sessionId: 'session-a',
          turnId: 'telegram:42:turn-a',
        }),
        ownerId: 'runtime-a',
        nowIso: () => '2026-07-28T06:00:00.000Z',
      },
      output: {
        async sendText(html) {
          expect(store.load()).toMatchObject({
            status: 'ready',
            checkpoint: { phase: 'prepared', delivery: 'pending' },
          })
          calls.push(html)
          return 9
        },
        async editText(_messageId, html) {
          expect(store.load()).toMatchObject({
            status: 'ready',
            checkpoint: { delivery: 'pending' },
          })
          calls.push(html)
        },
      },
    })

    await stream.start()
    await stream.handle({ type: 'outbound-lockout', locked: false })
    await stream.handle({
      type: 'tool-started', sequence: 1, name: 'read_file', category: 'tool',
    })
    await stream.handle({ type: 'action-contract', kind: 'inspect-required' })
    await stream.complete({
      state: 'ok',
      reply: 'not persisted in execution checkpoint',
      narrowed: false,
      actionContractKind: 'inspect-required',
      actionStatus: 'verified',
    })

    expect(store.load()).toMatchObject({
      status: 'ready',
      checkpoint: {
        phase: 'terminal',
        delivery: 'delivered',
        messageId: 9,
        state: {
          status: 'completed',
          thinking: false,
          action: { kind: 'inspect-required', status: 'verified' },
        },
      },
    })
    expect(content).not.toContain('not persisted in execution checkpoint')
    expect(content).not.toContain('arg')
    expect(content).not.toContain('result')
    expect(calls.at(-1)).toBe('Готово.')
  })

  it('adopts the exact active checkpoint under recovery instead of beginning a second turn', async () => {
    let content: string | undefined
    const store = makeJsonTelegramExecutionCheckpointStore({
      exists: () => content !== undefined,
      read: () => content ?? '',
      saveAtomic: (next) => { content = next },
    })
    const bindingHash = makeTelegramExecutionBindingHash({
      chatId: 42,
      sessionId: 'session-a',
      turnId: 'telegram:42:recover-a',
    })
    const first = makeTelegramExecutionStream({
      sessionId: 'session-a',
      signal: new AbortController().signal,
      editIntervalMs: 0,
      checkpoint: {
        store,
        bindingHash,
        ownerId: 'runtime-a',
        nowIso: () => '2026-07-28T06:00:00.000Z',
      },
      output: {
        async sendText() { return 9 },
        async editText() {},
      },
    })
    await first.prepare()
    await first.start()
    await first.stop()
    const loaded = store.load()
    if (loaded.status !== 'ready') throw new Error('checkpoint missing')
    const calls: string[] = []
    const replacement = makeTelegramExecutionStream({
      sessionId: 'session-a',
      signal: new AbortController().signal,
      editIntervalMs: 0,
      checkpoint: {
        store,
        bindingHash,
        ownerId: loaded.checkpoint.ownerId,
        resume: loaded.checkpoint,
        nowIso: () => '2026-07-28T06:01:00.000Z',
      },
      output: {
        async sendText() { throw new Error('must edit the existing card') },
        async editText(messageId) { calls.push(`edit:${messageId}`) },
      },
    })

    await replacement.prepare()
    await replacement.start()
    await replacement.complete({ state: 'ok', reply: 'done', narrowed: false })

    expect(calls).toEqual(['edit:9', 'edit:9'])
    expect(store.load()).toMatchObject({
      status: 'ready',
      checkpoint: {
        ownerId: 'runtime-a',
        bindingHash,
        phase: 'terminal',
        delivery: 'delivered',
        messageId: 9,
      },
    })
  })

  it('publishes prepared/pending without Telegram I/O before authority bind', async () => {
    let content: string | undefined
    const store = makeJsonTelegramExecutionCheckpointStore({
      exists: () => content !== undefined,
      read: () => content ?? '',
      saveAtomic: (next) => { content = next },
    })
    const output = { sendText: vi.fn(async () => 9), editText: vi.fn() }
    const stream = makeTelegramExecutionStream({
      sessionId: 'session-a',
      signal: new AbortController().signal,
      checkpoint: {
        store,
        bindingHash: makeTelegramExecutionBindingHash({
          chatId: 42, sessionId: 'session-a', turnId: 'telegram:42:turn-a',
        }),
        ownerId: 'runtime-a',
      },
      output,
    })

    await stream.prepare()

    expect(store.load()).toMatchObject({
      status: 'ready', checkpoint: { phase: 'prepared', delivery: 'pending' },
    })
    expect(output.sendText).not.toHaveBeenCalled()
    expect(output.editText).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'fail'] as const)(
    'closes a prepared turn through %s without Telegram I/O',
    async (terminalAction) => {
      let content: string | undefined
      const store = makeJsonTelegramExecutionCheckpointStore({
        exists: () => content !== undefined,
        read: () => content ?? '',
        saveAtomic: (next) => { content = next },
      })
      const output = { sendText: vi.fn(async () => 9), editText: vi.fn() }
      const stream = makeTelegramExecutionStream({
        sessionId: 'session-a',
        signal: new AbortController().signal,
        checkpoint: {
          store,
          bindingHash: makeTelegramExecutionBindingHash({
            chatId: 42, sessionId: 'session-a', turnId: 'telegram:42:turn-a',
          }),
          ownerId: 'runtime-a',
        },
        output,
      })

      await stream.prepare()
      await stream[terminalAction]()

      expect(store.load()).toMatchObject({
        status: 'ready',
        checkpoint: { phase: 'terminal', delivery: 'delivered', state: { status: terminalAction === 'fail' ? 'failed' : 'stopped' } },
      })
      expect(store.load()).not.toMatchObject({ checkpoint: { messageId: expect.anything() } })
      expect(output.sendText).not.toHaveBeenCalled()
      expect(output.editText).not.toHaveBeenCalled()
    },
  )

  it('rechecks authority after Telegram await before publishing delivered', async () => {
    let content: string | undefined
    const store = makeJsonTelegramExecutionCheckpointStore({
      exists: () => content !== undefined,
      read: () => content ?? '',
      saveAtomic: (next) => { content = next },
    })
    const held = [true, true, true, false]
    const sendText = vi.fn(async () => 9)
    const stream = makeTelegramExecutionStream({
      sessionId: 'session-a',
      signal: new AbortController().signal,
      checkpoint: {
        store,
        bindingHash: makeTelegramExecutionBindingHash({
          chatId: 42, sessionId: 'session-a', turnId: 'telegram:42:turn-a',
        }),
        ownerId: 'runtime-a',
        assertAuthorityHeld: () => held.shift() ?? false,
      },
      output: { sendText, async editText() {} },
    })
    await stream.prepare()

    await expect(stream.start()).rejects.toThrow('EXECUTION_AUTHORITY_UNAVAILABLE')
    expect(sendText).toHaveBeenCalledOnce()
    expect(store.load()).toMatchObject({
      status: 'ready', checkpoint: { phase: 'prepared', delivery: 'pending' },
    })
  })

  it('rejects terminal completion while its delivered checkpoint is unproven', async () => {
    let content: string | undefined
    const store = makeJsonTelegramExecutionCheckpointStore({
      exists: () => content !== undefined,
      read: () => content ?? '',
      saveAtomic: (next) => { content = next },
    })
    const stream = makeTelegramExecutionStream({
      sessionId: 'session-a',
      signal: new AbortController().signal,
      editIntervalMs: 0,
      checkpoint: {
        store,
        bindingHash: makeTelegramExecutionBindingHash({
          chatId: 42,
          sessionId: 'session-a',
          turnId: 'telegram:42:turn-a',
        }),
        ownerId: 'runtime-a',
      },
      output: {
        async sendText() { return 9 },
        async editText() { throw new Error('private transport failure') },
      },
    })
    await stream.start()

    await expect(stream.complete({ state: 'ok', reply: 'done', narrowed: false }))
      .rejects.toThrow('private transport failure')
    expect(store.load()).toMatchObject({
      status: 'ready',
      checkpoint: { phase: 'terminal', delivery: 'pending' },
    })
  })
})
