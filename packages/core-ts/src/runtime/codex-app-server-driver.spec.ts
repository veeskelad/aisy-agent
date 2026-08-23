import { describe, expect, it, vi } from 'vitest'

import type { BrainEvent, BrainTurn } from '../onboarding/brain-connections.js'
import type { CodexSubscriptionAuth } from './codex-auth.js'
import {
  CODEX_APP_SERVER_CAPABILITY_PROTOCOL_PROFILE,
  CODEX_APP_SERVER_PROTOCOL_PROFILE,
  makeCodexAppServerCapabilityDriver,
  makeCodexAppServerReadOnlyDriver,
  type CodexAppServerCapabilityBridge,
  type CodexAppServerSession,
  type CodexAppServerThreadRecord,
} from './codex-app-server-driver.js'

const THREAD_ID = 'thread-1'
const TURN_ID = 'turn-1'

const auth: CodexSubscriptionAuth = {
  detect: async () => ({ installed: true, version: 'codex-cli 0.144.5' }),
  beginAuth: async () => ({
    kind: 'device-code',
    verificationUri: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-1234',
  }),
  validate: async () => ({ ok: true, safeDetail: 'ready' }),
  revoke: async () => ({ ok: true, safeDetail: 'revoked' }),
}

function brainTurn(): BrainTurn {
  return {
    projectId: 'project-a',
    sessionId: 'session-a',
    request: {
      sessionId: 'session-a',
      prefixBytes: new TextEncoder().encode('immutable prefix'),
      spans: [
        { role: 'system', provenance: 'operator', text: 'agent DNA' },
        { role: 'user', provenance: 'operator', text: 'inspect this' },
      ],
    },
  }
}

function setup(input: {
  events?: unknown[]
  prior?: CodexAppServerThreadRecord | null
  auth?: CodexSubscriptionAuth
  requestOverride?: (method: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>
} = {}) {
  const saved: CodexAppServerThreadRecord[] = []
  const requests: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = []
  let closed = 0
  let opened = 0
  let loaded = 0
  const session: CodexAppServerSession = {
    async request(method, params) {
      requests.push({ method, params })
      if (input.requestOverride) return input.requestOverride(method, params)
      if (method === 'initialize') return { userAgent: 'codex' }
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: THREAD_ID } }
      if (method === 'turn/start') return { turn: { id: TURN_ID, status: 'inProgress' } }
      if (method === 'turn/interrupt') return {}
      throw new Error('unexpected request')
    },
    async notify() {},
    async *events() {
      for (const event of input.events ?? []) yield structuredClone(event)
    },
    async close() { closed++ },
  }
  const driver = makeCodexAppServerReadOnlyDriver({
    auth: input.auth ?? auth,
    sessions: { open: async () => { opened++; return session } },
    threads: {
      load: async () => { loaded++; return input.prior ?? null },
      saveNew: async record => { saved.push(structuredClone(record)) },
    },
    model: 'gpt-5.4',
    projectRoot: projectId => projectId === 'project-a' ? '/workspace/project-a' : null,
  })
  return {
    driver,
    requests,
    saved,
    get closed() { return closed },
    get opened() { return opened },
    get loaded() { return loaded },
  }
}

async function collect(driver: ReturnType<typeof setup>['driver'], signal = new AbortController().signal) {
  return collectTurn(driver, brainTurn(), signal)
}

async function collectTurn(
  driver: ReturnType<typeof setup>['driver'],
  turn: BrainTurn,
  signal = new AbortController().signal,
) {
  const result: BrainEvent[] = []
  for await (const event of driver.run(turn, signal)) result.push(event)
  return result
}

describe('Codex app-server read-only driver', () => {
  it('starts an exact read-only stable thread and streams a completed reply', async () => {
    const h = setup({ events: [
      { method: 'item/agentMessage/delta', params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'item-1', delta: 'hello' } },
      { method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', items: [] } } },
    ] })
    await expect(collect(h.driver)).resolves.toEqual([
      { type: 'started' },
      { type: 'text-delta', text: 'hello' },
      { type: 'completed', reply: 'hello' },
    ])
    expect(h.requests.map(item => item.method)).toEqual(['initialize', 'thread/start', 'turn/start'])
    expect(h.requests[1]?.params).toEqual({
      model: 'gpt-5.4',
      cwd: '/workspace/project-a',
      developerInstructions: 'immutable prefix\n\nagent DNA',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
    })
    expect(h.saved).toEqual([{
      projectId: 'project-a', sessionId: 'session-a', threadId: THREAD_ID,
      protocolProfile: CODEX_APP_SERVER_PROTOCOL_PROFILE,
    }])
    expect(h.closed).toBe(1)
  })

  it('accepts the pinned lifecycle sequence and keeps user, plan, and reasoning content out of the reply', async () => {
    const h = setup({ events: [
      { method: 'thread/started', params: { thread: { id: THREAD_ID, status: 'idle' } } },
      {
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress', items: [] } },
      },
      {
        method: 'item/started',
        params: {
          threadId: THREAD_ID, turnId: TURN_ID,
          item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'private user input' }] },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: THREAD_ID, turnId: TURN_ID,
          item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'private user input' }] },
        },
      },
      {
        method: 'item/started',
        params: {
          threadId: THREAD_ID, turnId: TURN_ID,
          item: { id: 'reasoning-1', type: 'reasoning', summary: [], content: [] },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: THREAD_ID, turnId: TURN_ID,
          item: { id: 'reasoning-1', type: 'reasoning', summary: ['private reasoning'], content: [] },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: THREAD_ID, turnId: TURN_ID,
          item: { id: 'plan-1', type: 'plan', text: 'private plan' },
        },
      },
      {
        method: 'item/started',
        params: {
          threadId: THREAD_ID, turnId: TURN_ID,
          item: { id: 'agent-1', type: 'agentMessage', text: '' },
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'agent-1', delta: 'answer' },
      },
      {
        method: 'item/completed',
        params: {
          threadId: THREAD_ID, turnId: TURN_ID,
          item: { id: 'agent-1', type: 'agentMessage', text: 'answer' },
        },
      },
      {
        method: 'turn/completed',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', items: [] } },
      },
    ] })

    const events = await collect(h.driver)
    expect(events).toEqual([
      { type: 'started' },
      { type: 'thinking' },
      { type: 'text-delta', text: 'answer' },
      { type: 'completed', reply: 'answer' },
    ])
    expect(JSON.stringify(events)).not.toContain('private user input')
    expect(JSON.stringify(events)).not.toContain('private reasoning')
    expect(JSON.stringify(events)).not.toContain('private plan')
    expect(h.requests[0]).toEqual({
      method: 'initialize',
      params: {
        clientInfo: { name: 'aisy', title: 'Aisy', version: '0.1.14' },
        capabilities: { optOutNotificationMethods: [
          'thread/tokenUsage/updated',
          'item/plan/delta',
          'item/reasoning/summaryTextDelta',
          'item/reasoning/summaryPartAdded',
          'item/reasoning/textDelta',
        ] },
      },
    })
  })

  it.each([
    ['thread/started', { thread: { id: 'foreign-thread', status: 'idle' } }],
    ['turn/started', {
      threadId: 'foreign-thread', turn: { id: TURN_ID, status: 'inProgress', items: [] },
    }],
  ])('rejects a foreign binding in %s before exposing lifecycle content', async (method, params) => {
    const h = setup({ events: [{ method, params }] })
    await expect(collect(h.driver)).resolves.toEqual([
      { type: 'started' },
      { type: 'failed', errorCode: 'CODEX_EVENT_BINDING_MISMATCH', safeDetail: 'Codex event binding was rejected.' },
    ])
    expect(h.requests.at(-1)?.method).toBe('turn/interrupt')
  })

  it('ignores an exact-bound retryable error and completes without exposing raw detail', async () => {
    const h = setup({ events: [
      {
        method: 'error',
        params: {
          threadId: THREAD_ID, turnId: TURN_ID, willRetry: true,
          error: { message: 'private transient upstream detail' },
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'agent-1', delta: 'recovered' },
      },
      {
        method: 'turn/completed',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', items: [] } },
      },
    ] })
    const events = await collect(h.driver)
    expect(events).toEqual([
      { type: 'started' },
      { type: 'text-delta', text: 'recovered' },
      { type: 'completed', reply: 'recovered' },
    ])
    expect(JSON.stringify(events)).not.toContain('private transient')
    expect(h.requests.some(item => item.method === 'turn/interrupt')).toBe(false)
  })

  it('turns an exact-bound non-retryable error into a stable interrupted failure', async () => {
    const h = setup({ events: [{
      method: 'error',
      params: {
        threadId: THREAD_ID, turnId: TURN_ID, willRetry: false,
        error: { message: 'private upstream path and account detail' },
      },
    }] })
    const events = await collect(h.driver)
    expect(events).toEqual([
      { type: 'started' },
      { type: 'failed', errorCode: 'CODEX_TURN_FAILED', safeDetail: 'Codex turn failed.' },
    ])
    expect(JSON.stringify(events)).not.toContain('private upstream')
    expect(h.requests.at(-1)?.method).toBe('turn/interrupt')
  })

  it.each([undefined, 'yes', 1])(
    'rejects malformed error willRetry %s as a protocol failure',
    async willRetry => {
      const params: Record<string, unknown> = {
        threadId: THREAD_ID, turnId: TURN_ID,
        error: { message: 'private malformed upstream detail' },
      }
      if (willRetry !== undefined) params.willRetry = willRetry
      const h = setup({ events: [{ method: 'error', params }] })
      const events = await collect(h.driver)
      expect(events).toEqual([
        { type: 'started' },
        { type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.' },
      ])
      expect(JSON.stringify(events)).not.toContain('private malformed')
      expect(h.requests.at(-1)?.method).toBe('turn/interrupt')
    },
  )

  it('resumes the exact persisted thread after restart', async () => {
    const h = setup({
      prior: {
        projectId: 'project-a', sessionId: 'session-a', threadId: THREAD_ID,
        protocolProfile: CODEX_APP_SERVER_PROTOCOL_PROFILE,
      },
      events: [{ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', items: [] } } }],
    })
    await collect(h.driver)
    expect(h.requests.map(item => item.method)).toEqual(['initialize', 'thread/resume', 'turn/start'])
    expect(h.saved).toEqual([])
  })

  it('revalidates authentication on restart and blocks a revoked account before resume I/O', async () => {
    const prior: CodexAppServerThreadRecord = {
      projectId: 'project-a', sessionId: 'session-a', threadId: THREAD_ID,
      protocolProfile: CODEX_APP_SERVER_PROTOCOL_PROFILE,
    }
    const validate = vi.fn(async () => ({ ok: true, safeDetail: 'ready' }))
    const ready = setup({
      prior,
      auth: { ...auth, validate },
      events: [{
        method: 'turn/completed',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', items: [] } },
      }],
    })
    await collect(ready.driver)
    expect(validate).toHaveBeenCalledTimes(1)
    expect(ready.requests.map(item => item.method)).toEqual(['initialize', 'thread/resume', 'turn/start'])

    const revoked = setup({
      prior,
      auth: {
        ...auth,
        validate: async () => ({
          ok: false,
          safeDetail: 'raw account detail must not escape',
          errorCode: 'UPSTREAM_ACCOUNT_REVOKED',
        }),
      },
    })
    const events = await collect(revoked.driver)
    expect(events).toEqual([{
      type: 'failed', errorCode: 'CODEX_AUTH_NOT_READY',
      safeDetail: 'Codex authentication is not ready.',
    }])
    expect(JSON.stringify(events)).not.toContain('raw account detail')
    expect(revoked.opened).toBe(0)
    expect(revoked.loaded).toBe(0)
    expect(revoked.saved).toEqual([])
  })

  it('redacts an authentication validation exception before app-server I/O', async () => {
    const h = setup({
      auth: {
        ...auth,
        validate: async () => { throw new Error('raw credential and account detail') },
      },
    })
    const events = await collect(h.driver)
    expect(events).toEqual([{
      type: 'failed', errorCode: 'CODEX_AUTH_NOT_READY',
      safeDetail: 'Codex authentication is not ready.',
    }])
    expect(JSON.stringify(events)).not.toContain('raw credential')
    expect(h.opened).toBe(0)
    expect(h.loaded).toBe(0)
    expect(h.saved).toEqual([])
  })

  it('interrupts a cross-thread event before exposing its content', async () => {
    const h = setup({ events: [{
      method: 'item/agentMessage/delta',
      params: { threadId: 'foreign-thread', turnId: TURN_ID, itemId: 'item-1', delta: 'foreign-private-output' },
    }] })
    const events = await collect(h.driver)
    expect(events).toEqual([
      { type: 'started' },
      { type: 'failed', errorCode: 'CODEX_EVENT_BINDING_MISMATCH', safeDetail: 'Codex event binding was rejected.' },
    ])
    expect(JSON.stringify(events)).not.toContain('foreign-private-output')
    expect(h.requests.at(-1)?.method).toBe('turn/interrupt')
  })

  it('interrupts a supported event with missing binding fields', async () => {
    const h = setup({ events: [{
      method: 'item/agentMessage/delta', params: { itemId: 'item-1', delta: 'unbound' },
    }] })
    expect((await collect(h.driver)).at(-1)).toMatchObject({
      type: 'failed', errorCode: 'CODEX_EVENT_BINDING_MISMATCH',
    })
    expect(h.requests.at(-1)?.method).toBe('turn/interrupt')
  })

  it.each(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'])(
    'interrupts disabled %s items without emitting raw action data',
    async type => {
      const h = setup({ events: [{
        method: 'item/started',
        params: {
          threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1,
          item: { id: 'item-1', type, command: 'print-private-value', status: 'inProgress' },
        },
      }] })
      const events = await collect(h.driver)
      expect(events.at(-1)).toEqual({
        type: 'failed',
        errorCode: 'CODEX_TOOL_POLICY_VIOLATION',
        safeDetail: 'Codex attempted a disabled capability.',
      })
      expect(JSON.stringify(events)).not.toContain('print-private-value')
      expect(h.requests.at(-1)?.method).toBe('turn/interrupt')
    },
  )

  it('interrupts every server-initiated request instead of auto-approving it', async () => {
    const h = setup({ events: [{
      id: 44,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'item-1', command: 'dangerous' },
    }] })
    await expect(collect(h.driver)).resolves.toEqual([
      { type: 'started' },
      { type: 'failed', errorCode: 'CODEX_UNSUPPORTED_SERVER_REQUEST', safeDetail: 'Codex requested a disabled capability.' },
    ])
    expect(h.requests.at(-1)?.method).toBe('turn/interrupt')
  })

  it.each<readonly [string, unknown]>([
    ['unknown notification', {
      method: 'thread/privateMetadata/changed',
      params: { threadId: THREAD_ID, turnId: TURN_ID, detail: 'raw-private-detail' },
    }],
    ['unknown item type', {
      method: 'item/started',
      params: {
        threadId: THREAD_ID, turnId: TURN_ID,
        item: { id: 'item-1', type: 'futureCapability', detail: 'raw-private-detail' },
      },
    }],
    ['malformed allowed item', {
      method: 'item/completed',
      params: {
        threadId: THREAD_ID, turnId: TURN_ID,
        item: { id: 'item-1', type: 'agentMessage', detail: 'raw-private-detail' },
      },
    }],
    ['unknown terminal status', {
      method: 'turn/completed',
      params: {
        threadId: THREAD_ID,
        turn: { id: TURN_ID, status: 'futureStatus', detail: 'raw-private-detail' },
      },
    }],
  ])('interrupts once and closes on %s without exposing raw detail', async (_name, raw) => {
    const h = setup({ events: [raw] })
    const events = await collect(h.driver)
    expect(events.at(-1)).toEqual({
      type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.',
    })
    expect(JSON.stringify(events)).not.toContain('raw-private-detail')
    expect(h.requests.filter(item => item.method === 'turn/interrupt')).toHaveLength(1)
    expect(h.closed).toBe(1)
  })

  it('fails closed on corrupt persisted binding and raw protocol errors', async () => {
    const h = setup({ prior: {
      projectId: 'project-b', sessionId: 'session-a', threadId: THREAD_ID,
      protocolProfile: CODEX_APP_SERVER_PROTOCOL_PROFILE,
    } })
    await expect(collect(h.driver)).resolves.toEqual([{
      type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.',
    }])
    expect(h.requests.map(item => item.method)).toEqual(['initialize'])
    expect(h.closed).toBe(1)
  })

  it('rejects oversized model output and sends interrupt', async () => {
    const h = setup({ events: [{
      method: 'item/agentMessage/delta',
      params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'item-1', delta: 'x'.repeat(4 * 1024 * 1024 + 1) },
    }] })
    expect((await collect(h.driver)).at(-1)).toMatchObject({
      type: 'failed', errorCode: 'CODEX_OUTPUT_REJECTED',
    })
    expect(h.requests.at(-1)?.method).toBe('turn/interrupt')
  })

  it('interrupts once when the event stream ends without a terminal event', async () => {
    const h = setup({ events: [] })
    await expect(collect(h.driver)).resolves.toEqual([
      { type: 'started' },
      { type: 'failed', errorCode: 'CODEX_STREAM_ENDED', safeDetail: 'Codex event stream ended unexpectedly.' },
    ])
    expect(h.requests.filter(item => item.method === 'turn/interrupt')).toHaveLength(1)
    expect(h.closed).toBe(1)
  })

  it('rejects an already-aborted turn before opening app-server', async () => {
    const h = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(collect(h.driver, controller.signal)).resolves.toEqual([{
      type: 'failed', errorCode: 'CODEX_TURN_REJECTED', safeDetail: 'Codex turn was rejected.',
    }])
    expect(h.requests).toEqual([])
  })

  it('rejects an invalid project root before auth or app-server I/O', async () => {
    const detect = vi.fn(auth.detect)
    const validate = vi.fn(auth.validate)
    const open = vi.fn()
    const driver = makeCodexAppServerReadOnlyDriver({
      auth: { ...auth, detect, validate },
      sessions: { open },
      threads: { load: async () => null, saveNew: async () => {} },
      model: 'gpt-5.4',
      projectRoot: () => { throw new Error('raw project adapter detail') },
    })
    const events = await collect(driver)
    expect(events).toEqual([{
      type: 'failed', errorCode: 'CODEX_TURN_REJECTED', safeDetail: 'Codex turn was rejected.',
    }])
    expect(JSON.stringify(events)).not.toContain('raw project adapter detail')
    expect(detect).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects a request/session binding mismatch before auth or app-server I/O', async () => {
    const detect = vi.fn(auth.detect)
    const validate = vi.fn(auth.validate)
    const h = setup({ auth: { ...auth, detect, validate } })
    const turn = brainTurn()
    turn.request.sessionId = 'session-b'
    await expect(collectTurn(h.driver, turn)).resolves.toEqual([{
      type: 'failed', errorCode: 'CODEX_TURN_REJECTED', safeDetail: 'Codex turn was rejected.',
    }])
    expect(detect).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
    expect(h.opened).toBe(0)
    expect(h.loaded).toBe(0)
  })

  it('interrupts and closes a running stream when the signal aborts', async () => {
    const controller = new AbortController()
    const h = setup({ events: [] })
    const originalOpen = h.driver.run
    const sessionDriver = makeCodexAppServerReadOnlyDriver({
      auth,
      sessions: {
        open: async () => ({
          request: async method => {
            if (method === 'initialize' || method === 'turn/interrupt') return {}
            if (method === 'thread/start') return { thread: { id: THREAD_ID } }
            if (method === 'turn/start') return { turn: { id: TURN_ID } }
            throw new Error('unexpected')
          },
          notify: async () => {},
          async *events() { controller.abort() },
          close: async () => {},
        }),
      },
      threads: { load: async () => null, saveNew: async () => {} },
      model: 'gpt-5.4',
      projectRoot: () => '/workspace/project-a',
    })
    expect(originalOpen).toBeTypeOf('function')
    expect((await collect(sessionDriver, controller.signal)).at(-1)).toMatchObject({
      type: 'failed', errorCode: 'CODEX_TURN_INTERRUPTED',
    })
  })

  it('uses auth lifecycle without exposing auth output', async () => {
    const h = setup()
    await expect(h.driver.detect()).resolves.toMatchObject({ installed: true })
    await expect(h.driver.install()).resolves.toMatchObject({ installed: true })
    await expect(h.driver.validate()).resolves.toMatchObject({ ok: true })
    await expect(h.driver.beginAuth()).resolves.toMatchObject({ kind: 'device-code' })
  })

  it('rejects an unpinned Codex version before opening app-server', async () => {
    const open = vi.fn()
    const unsupportedAuth: CodexSubscriptionAuth = {
      ...auth,
      detect: async () => ({ installed: true, version: 'codex-cli 0.145.0' }),
    }
    const driver = makeCodexAppServerReadOnlyDriver({
      auth: unsupportedAuth,
      sessions: { open },
      threads: { load: async () => null, saveNew: async () => {} },
      model: 'gpt-5.4',
      projectRoot: () => '/workspace/project-a',
    })
    await expect(collect(driver)).resolves.toEqual([{
      type: 'failed', errorCode: 'CODEX_PROTOCOL_UNSUPPORTED',
      safeDetail: 'Codex app-server protocol version is not supported.',
    }])
    await expect(driver.validate()).resolves.toMatchObject({
      ok: false, errorCode: 'CODEX_PROTOCOL_UNSUPPORTED',
    })
    expect(open).not.toHaveBeenCalled()
  })
})

function capabilitySetup(input: {
  events: unknown[]
  prior?: CodexAppServerThreadRecord | null
  openBridge?: () => Promise<CodexAppServerCapabilityBridge>
}) {
  const requests: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = []
  const saved: CodexAppServerThreadRecord[] = []
  const bound: string[] = []
  let bridgeClosed = 0
  const bridge = Object.freeze<CodexAppServerCapabilityBridge>({
    url: 'http://127.0.0.1:43123/mcp',
    token: 'a'.repeat(64),
    serverName: 'aisy',
    toolNames: Object.freeze(['read_file', 'bash']),
    bindTurn: (threadId, turnId) => { bound.push(`${threadId}:${turnId}`) },
    close: async () => { bridgeClosed++ },
  })
  const session: CodexAppServerSession = {
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'initialize' || method === 'turn/interrupt') return {}
      if (method === 'thread/start' || method === 'thread/resume') {
        return { thread: { id: THREAD_ID } }
      }
      if (method === 'turn/start') return { turn: { id: TURN_ID } }
      throw new Error('unexpected request')
    },
    notify: async () => {},
    async *events() { for (const event of input.events) yield structuredClone(event) },
    close: async () => {},
  }
  const driver = makeCodexAppServerCapabilityDriver({
    auth,
    sessions: { open: async () => session },
    threads: {
      load: async () => input.prior ?? null,
      saveNew: async record => { saved.push(structuredClone(record)) },
    },
    projectRoot: () => '/workspace/project-a',
    capabilityBridges: { open: input.openBridge ?? (async () => bridge) },
  })
  return {
    driver, requests, saved, bound,
    get bridgeClosed() { return bridgeClosed },
  }
}

describe('Codex app-server Aisy capability driver', () => {
  it('starts with only the exact Aisy MCP catalogue and binds the bridge to the turn', async () => {
    const argumentsValue = { path: 'README.md' }
    const h = capabilitySetup({ events: [
      {
        method: 'item/started',
        params: {
          threadId: THREAD_ID, turnId: TURN_ID,
          item: {
            id: 'tool-1', type: 'mcpToolCall', server: 'aisy', tool: 'read_file',
            arguments: argumentsValue, status: 'inProgress',
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: THREAD_ID, turnId: TURN_ID,
          item: {
            id: 'tool-1', type: 'mcpToolCall', server: 'aisy', tool: 'read_file',
            arguments: argumentsValue, status: 'completed',
          },
        },
      },
      {
        method: 'turn/completed',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed' } },
      },
    ] })

    await expect(collect(h.driver)).resolves.toEqual([
      { type: 'started' },
      { type: 'tool-requested', toolCallId: 'tool-1', name: 'read_file', args: argumentsValue },
      { type: 'tool-result', toolCallId: 'tool-1', result: 'CAPABILITY_COMPLETED' },
      { type: 'completed', reply: '' },
    ])
    expect(h.bound).toEqual([`${THREAD_ID}:${TURN_ID}`])
    const config = h.requests.find(request => request.method === 'thread/start')?.params.config
    expect(config).toMatchObject({
      web_search: 'disabled',
      project_doc_max_bytes: 0,
      features: {
        shell_tool: false,
        unified_exec: false,
        apps: false,
        plugins: false,
      },
      mcp_servers: {
        aisy: {
          url: 'http://127.0.0.1:43123/mcp',
          http_headers: { authorization: `Bearer ${'a'.repeat(64)}` },
          enabled_tools: ['read_file', 'bash'],
          supports_parallel_tool_calls: false,
        },
      },
    })
    expect(Object.keys((config as { features: Record<string, unknown> }).features).sort())
      .toEqual([
        'apply_patch_freeform', 'apps', 'auth_elicitation', 'browser_use',
        'browser_use_external', 'browser_use_full_cdp_access', 'code_mode',
        'code_mode_host', 'computer_use', 'enable_fanout', 'enable_mcp_apps', 'goals',
        'hooks', 'image_generation', 'in_app_browser', 'memories', 'multi_agent',
        'multi_agent_v2', 'plugin_sharing', 'plugins', 'remote_plugin',
        'request_permissions_tool', 'shell_snapshot', 'shell_tool',
        'skill_mcp_dependency_install', 'standalone_web_search', 'tool_call_mcp_elicitation',
        'tool_suggest', 'unified_exec', 'web_search_cached', 'web_search_request',
        'workspace_dependencies',
      ])
    expect(h.saved).toEqual([{
      projectId: 'project-a', sessionId: 'session-a', threadId: THREAD_ID,
      protocolProfile: CODEX_APP_SERVER_CAPABILITY_PROTOCOL_PROFILE,
    }])
    expect(h.bridgeClosed).toBe(1)
  })

  it.each([
    ['native Bash', { id: 'native-1', type: 'commandExecution', command: 'pwd' }],
    ['foreign MCP', {
      id: 'tool-1', type: 'mcpToolCall', server: 'foreign', tool: 'read_file',
      arguments: {}, status: 'inProgress',
    }],
  ])('interrupts %s instead of allowing a second action path', async (_name, item) => {
    const h = capabilitySetup({ events: [{
      method: 'item/started',
      params: { threadId: THREAD_ID, turnId: TURN_ID, item },
    }] })
    const events = await collect(h.driver)
    expect(events.at(-1)).toMatchObject({
      type: 'failed', errorCode: 'CODEX_TOOL_POLICY_VIOLATION',
    })
    expect(h.requests.at(-1)?.method).toBe('turn/interrupt')
    expect(h.bridgeClosed).toBe(1)
  })

  it('rejects a replayed or unfinished MCP item and never reports a successful turn', async () => {
    const item = {
      id: 'tool-1', type: 'mcpToolCall', server: 'aisy', tool: 'read_file',
      arguments: { path: 'a' }, status: 'inProgress',
    }
    const h = capabilitySetup({ events: [
      { method: 'item/started', params: { threadId: THREAD_ID, turnId: TURN_ID, item } },
      { method: 'item/started', params: { threadId: THREAD_ID, turnId: TURN_ID, item } },
    ] })
    const events = await collect(h.driver)
    expect(events.at(-1)).toMatchObject({ type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED' })
    expect(events.some(event => event.type === 'completed')).toBe(false)
  })

  it('refuses a read-only persisted thread and closes an invalid bridge without app-server I/O', async () => {
    const profileMismatch = capabilitySetup({
      prior: {
        projectId: 'project-a', sessionId: 'session-a', threadId: THREAD_ID,
        protocolProfile: CODEX_APP_SERVER_PROTOCOL_PROFILE,
      },
      events: [],
    })
    await expect(collect(profileMismatch.driver)).resolves.toEqual([{
      type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.',
    }])

    let closed = 0
    const rejected = capabilitySetup({
      events: [],
      openBridge: async () => ({
        url: 'http://0.0.0.0:1/mcp', token: 'private-token', serverName: 'aisy',
        toolNames: [], bindTurn: () => {}, close: async () => { closed++ },
      }),
    })
    await expect(collect(rejected.driver)).resolves.toEqual([{
      type: 'failed', errorCode: 'CODEX_CAPABILITY_BRIDGE_REJECTED',
      safeDetail: 'Codex tools were rejected.',
    }])
    expect(rejected.requests).toEqual([])
    expect(closed).toBe(1)
  })
})
