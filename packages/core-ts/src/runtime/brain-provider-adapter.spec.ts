import { describe, expect, it, vi } from 'vitest'

import type { BrainDriver, BrainEvent } from '../onboarding/brain-connections.js'
import type { ModelRequest } from '../agent-loop/types.js'
import {
  makeAisyCapabilityBrainProviderAdapter,
  makeReadOnlyBrainProviderAdapter,
} from './brain-provider-adapter.js'

const REQUEST: ModelRequest = {
  sessionId: 'session-a',
  prefixBytes: new Uint8Array(),
  spans: [{ role: 'user', provenance: 'operator', text: 'hello' }],
}

function driver(events: readonly BrainEvent[]): BrainDriver {
  return {
    runtime: 'codex-app-server',
    detect: async () => ({ installed: true }),
    install: async () => ({ installed: true, safeDetail: 'ready' }),
    beginAuth: async () => ({
      kind: 'browser', authorizationUri: 'https://example.test/auth', safeInstructions: 'Continue.',
    }),
    validate: async () => ({ ok: true, safeDetail: 'ready' }),
    async *run() { for (const event of events) yield structuredClone(event) },
  }
}

describe('read-only brain provider adapter', () => {
  it('forwards structured progress and returns the authoritative completion', async () => {
    const progress: BrainEvent[] = []
    const adapter = makeReadOnlyBrainProviderAdapter({
      projectId: 'project-a',
      driver: driver([
        { type: 'started' },
        { type: 'thinking', safeSummary: 'Inspecting.' },
        { type: 'text-delta', text: 'hel' },
        { type: 'text-delta', text: 'lo' },
        { type: 'usage', inputTokens: 4, outputTokens: 2, dollars: 0 },
        { type: 'completed', reply: 'hello' },
      ]),
    })

    await expect(adapter.complete(REQUEST, undefined, event => { progress.push(event) }))
      .resolves.toEqual({
        reply: 'hello',
        usage: { inputTokens: 4, outputTokens: 2, dollars: 0 },
      })
    expect(progress).toEqual([
      { type: 'started' },
      { type: 'thinking', safeSummary: 'Inspecting.' },
      { type: 'text-delta', text: 'hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'usage', inputTokens: 4, outputTokens: 2, dollars: 0 },
    ])
  })

  it('rejects native capability events on the read-only seam', async () => {
    const adapter = makeReadOnlyBrainProviderAdapter({
      projectId: 'project-a',
      driver: driver([
        { type: 'tool-requested', toolCallId: 'call-1', name: 'shell', args: {} },
      ]),
    })
    await expect(adapter.complete(REQUEST)).rejects.toMatchObject({
      kind: 'server-error', message: 'BRAIN_NATIVE_CAPABILITY_REJECTED',
    })
  })

  it('forwards Aisy bridge tool progress while still rejecting approvals', async () => {
    const progress: BrainEvent[] = []
    const adapter = makeAisyCapabilityBrainProviderAdapter({
      projectId: 'project-a',
      driver: driver([
        { type: 'started' },
        { type: 'tool-requested', toolCallId: 'call-1', name: 'read_file', args: { path: 'a' } },
        { type: 'tool-result', toolCallId: 'call-1', result: 'CAPABILITY_COMPLETED' },
        { type: 'completed', reply: 'done' },
      ]),
    })
    await expect(adapter.complete(REQUEST, undefined, event => { progress.push(event) }))
      .resolves.toMatchObject({ reply: 'done' })
    expect(progress).toEqual([
      { type: 'started' },
      { type: 'tool-requested', toolCallId: 'call-1', name: 'read_file', args: { path: 'a' } },
      { type: 'tool-result', toolCallId: 'call-1', result: 'CAPABILITY_COMPLETED' },
    ])

    const approval = makeAisyCapabilityBrainProviderAdapter({
      projectId: 'project-a',
      driver: driver([{ type: 'started' }, {
        type: 'approval-required', approvalId: 'approval-1', summary: 'confirm', tier: 2,
      }]),
    })
    await expect(approval.complete(REQUEST)).rejects.toMatchObject({
      message: 'BRAIN_NATIVE_CAPABILITY_REJECTED',
    })
  })

  it('preserves a stable preflight failure before the model turn starts', async () => {
    const adapter = makeReadOnlyBrainProviderAdapter({
      projectId: 'project-a',
      driver: driver([{
        type: 'failed', errorCode: 'CODEX_AUTH_NOT_READY', safeDetail: 'Not authenticated.',
      }]),
    })
    await expect(adapter.complete(REQUEST)).rejects.toMatchObject({
      message: 'CODEX_AUTH_NOT_READY',
    })
  })

  it('rejects a stream without a terminal completion', async () => {
    const adapter = makeReadOnlyBrainProviderAdapter({
      projectId: 'project-a',
      driver: driver([{ type: 'started' }, { type: 'text-delta', text: 'partial' }]),
    })
    await expect(adapter.complete(REQUEST)).rejects.toMatchObject({
      kind: 'server-error', message: 'BRAIN_STREAM_ENDED',
    })
  })

  it('never exposes an invalid driver error string', async () => {
    const adapter = makeReadOnlyBrainProviderAdapter({
      projectId: 'project-a',
      driver: driver([
        { type: 'started' },
        { type: 'failed', errorCode: 'raw token-shaped provider detail', safeDetail: 'failed' },
      ]),
    })
    await expect(adapter.complete(REQUEST)).rejects.toMatchObject({
      kind: 'server-error', message: 'BRAIN_TURN_FAILED',
    })
  })

  it('maps a throwing driver iterator to a stable error and requests iterator cleanup', async () => {
    const cleanup = vi.fn(async (): Promise<IteratorResult<BrainEvent>> => ({ done: true, value: undefined }))
    const throwingDriver: BrainDriver = {
      ...driver([]),
      run: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async (): Promise<IteratorResult<BrainEvent>> => {
              throw new Error('private driver path and account detail')
            },
            return: cleanup,
          }
        },
      }),
    }
    const adapter = makeReadOnlyBrainProviderAdapter({
      projectId: 'project-a',
      driver: throwingDriver,
    })

    const error = await adapter.complete(REQUEST).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ kind: 'server-error', message: 'BRAIN_DRIVER_FAILED' })
    expect(String(error)).not.toContain('private driver path')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('maps a synchronous driver.run exception to a stable error', async () => {
    const throwingDriver: BrainDriver = {
      ...driver([]),
      run() { throw new Error('private synchronous driver detail') },
    }
    const adapter = makeReadOnlyBrainProviderAdapter({
      projectId: 'project-a',
      driver: throwingDriver,
    })
    const error = await adapter.complete(REQUEST).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ kind: 'server-error', message: 'BRAIN_DRIVER_FAILED' })
    expect(String(error)).not.toContain('private synchronous')
  })

  it('bounds terminal EOF waiting and calls iterator.return when the stream never closes', async () => {
    const cleanup = vi.fn(async (): Promise<IteratorResult<BrainEvent>> => ({ done: true, value: undefined }))
    let call = 0
    const neverClosingDriver: BrainDriver = {
      ...driver([]),
      run: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async (): Promise<IteratorResult<BrainEvent>> => {
              call++
              if (call === 1) return { done: false, value: { type: 'started' } }
              if (call === 2) return { done: false, value: { type: 'completed', reply: 'done' } }
              return new Promise<IteratorResult<BrainEvent>>(() => {})
            },
            return: cleanup,
          }
        },
      }),
    }
    const adapter = makeReadOnlyBrainProviderAdapter({
      projectId: 'project-a',
      driver: neverClosingDriver,
      terminalCloseTimeoutMs: 5,
    })

    await expect(adapter.complete(REQUEST)).rejects.toMatchObject({
      kind: 'server-error', message: 'BRAIN_EVENT_STREAM_NOT_CLOSED',
    })
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it.each<readonly [string, readonly BrainEvent[]]>([
    ['event before started', [{ type: 'text-delta', text: 'early' }]],
    ['duplicate started', [{ type: 'started' }, { type: 'started' }]],
    ['duplicate usage', [
      { type: 'started' },
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'usage', inputTokens: 2, outputTokens: 1 },
    ]],
    ['terminal before started', [{ type: 'completed', reply: 'early' }]],
    ['duplicate terminal', [
      { type: 'started' },
      { type: 'completed', reply: 'first' },
      { type: 'completed', reply: 'second' },
    ]],
  ])('rejects %s in the driver event sequence', async (_name, events) => {
    const adapter = makeReadOnlyBrainProviderAdapter({
      projectId: 'project-a',
      driver: driver(events),
    })
    await expect(adapter.complete(REQUEST)).rejects.toMatchObject({
      kind: 'server-error', message: 'BRAIN_EVENT_SEQUENCE_REJECTED',
    })
  })
})
