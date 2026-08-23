import { describe, expect, it, vi } from 'vitest'

import {
  bindCodexCapabilityBridge,
  CodexCapabilityBridgeError,
  type CodexCapabilityBridgeEvent,
} from './codex-capability-bridge.js'

const binding = {
  operatorId: 'operator-a', profileId: 'profile-a', projectId: 'project-a',
  sessionId: 'session-a', scope: 'project' as const,
}

function request(overrides: Partial<{
  threadId: string; turnId: string; itemId: string; tool: string;
  arguments: Record<string, unknown>
}> = {}) {
  return {
    threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a', tool: 'read_file',
    arguments: { path: 'README.md' }, ...overrides,
  }
}

function bridge(overrides: Partial<Parameters<typeof bindCodexCapabilityBridge>[0]> = {}) {
  const execute = vi.fn(async () => ({ ok: true, output: 'done' }))
  const events: CodexCapabilityBridgeEvent[] = []
  return {
    execute,
    events,
    value: bindCodexCapabilityBridge({
      binding, threadId: 'thread-a', turnId: 'turn-a',
      context: { provenance: 'operator', narrowed: false },
      allowedTools: new Set(['read_file']),
      isBindingActive: () => true,
      execute,
      onEvent: event => { events.push(event) },
      ...overrides,
    }),
  }
}

describe('Codex transport-independent capability bridge', () => {
  it('passes exact binding and code-owned provenance to the Aisy executor', async () => {
    const h = bridge()
    await expect(h.value.invoke(request())).resolves.toEqual({ ok: true, output: 'done' })
    expect(h.execute).toHaveBeenCalledWith(
      binding,
      { name: 'read_file', args: { path: 'README.md' }, sourceSpanProvenance: 'operator' },
      { provenance: 'operator', narrowed: false },
      expect.any(AbortSignal),
    )
    expect(h.events.map(event => event.type)).toEqual(['started', 'completed'])
    expect(JSON.stringify(h.events)).not.toContain('README.md')
  })

  it('rejects foreign thread/turn, unknown tools and inactive bindings before execution', async () => {
    const h = bridge({ isBindingActive: () => false })
    await expect(h.value.invoke(request({ threadId: 'foreign' }))).rejects.toEqual(
      new CodexCapabilityBridgeError('INVALID_CAPABILITY_CALL'),
    )
    await expect(h.value.invoke(request({ itemId: 'item-b', tool: 'bash' }))).rejects.toEqual(
      new CodexCapabilityBridgeError('CAPABILITY_NOT_ALLOWED'),
    )
    await expect(h.value.invoke(request({ itemId: 'item-c' }))).rejects.toEqual(
      new CodexCapabilityBridgeError('CAPABILITY_CONTEXT_INACTIVE'),
    )
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('deduplicates an identical concurrent retry and rejects an altered replay', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const h = bridge({ execute: async () => { await pending; return { ok: true, output: 'once' } } })
    const first = h.value.invoke(request())
    const retry = h.value.invoke(request())
    finish()
    await expect(Promise.all([first, retry])).resolves.toEqual([
      { ok: true, output: 'once' }, { ok: true, output: 'once' },
    ])
    await expect(h.value.invoke(request({ arguments: { path: 'other' } }))).rejects.toEqual(
      new CodexCapabilityBridgeError('CAPABILITY_REPLAY_MISMATCH'),
    )
  })

  it('charges dispatch attempts and closes at the configured call budget', async () => {
    const h = bridge({ maxCalls: 1 })
    await h.value.invoke(request())
    await expect(h.value.invoke(request({ itemId: 'item-b' }))).rejects.toEqual(
      new CodexCapabilityBridgeError('CAPABILITY_BUDGET_EXCEEDED'),
    )
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('rejects unsafe/deep/oversized arguments and redacts executor failures', async () => {
    const h = bridge({ execute: async () => { throw new Error('private executor detail') } })
    const unsafe = Object.create(null) as Record<string, unknown>
    unsafe['constructor'] = 'pollute'
    await expect(h.value.invoke(request({ arguments: unsafe }))).rejects.toEqual(
      new CodexCapabilityBridgeError('INVALID_CAPABILITY_CALL'),
    )
    await expect(h.value.invoke(request({ itemId: 'item-b', arguments: { text: 'x'.repeat(300_000) } })))
      .rejects.toEqual(new CodexCapabilityBridgeError('INVALID_CAPABILITY_CALL'))
    const result = await h.value.invoke(request({ itemId: 'item-c' }))
    expect(result).toEqual({ ok: false, output: 'CAPABILITY_EXECUTION_FAILED' })
    expect(JSON.stringify(result)).not.toContain('private executor detail')
  })

  it('fails closed after close or abort and validates bridge configuration', async () => {
    const h = bridge()
    h.value.close()
    await expect(h.value.invoke(request())).rejects.toEqual(
      new CodexCapabilityBridgeError('CAPABILITY_BRIDGE_CLOSED'),
    )
    expect(() => bindCodexCapabilityBridge({
      binding, threadId: 'thread-a', turnId: 'turn-a',
      context: { provenance: 'operator', narrowed: false }, allowedTools: new Set(),
      isBindingActive: () => true, execute: async () => ({ ok: true, output: '' }),
    })).toThrow(new CodexCapabilityBridgeError('INVALID_BRIDGE_CONFIG'))
  })

  it('aborts an in-flight executor when the bridge closes', async () => {
    let began!: () => void
    const beganPromise = new Promise<void>(resolve => { began = resolve })
    const h = bridge({
      execute: async (_binding, _call, _context, signal) => {
        began()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
        return { ok: true, output: 'must not complete' }
      },
    })
    const invocation = h.value.invoke(request())
    await beganPromise
    h.value.close()
    await expect(invocation).rejects.toEqual(
      new CodexCapabilityBridgeError('CAPABILITY_BRIDGE_CLOSED'),
    )
  })
})
