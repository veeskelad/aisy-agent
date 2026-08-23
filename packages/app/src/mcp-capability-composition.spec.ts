// The question here is only ever "does the model get this tool, and on whose
// authority" — a server that cannot prove it is the one the operator approved
// must leave the agent with nothing, not with a tool that fails at call time.

import { canonicalDescriptorHash, makeInputGuard, type McpProcessHandle, type RawDescriptor } from '@aisy/core'
import { describe, expect, it, vi } from 'vitest'

import { connectMcpCapability } from './mcp-capability-composition.js'
import type { McpRuntimeDeps } from './mcp-runtime.js'

const PIN = 'v1.2.3@sha256:abc123'

const SEARCH: RawDescriptor = {
  name: 'search',
  description: 'Найти задачу по тексту',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  annotations: { readOnlyHint: true },
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    name: 'tracker',
    transport: 'stdio' as const,
    command: ['/usr/bin/tracker-server'],
    pin: PIN,
    descriptorHash: canonicalDescriptorHash([SEARCH]),
    tokenEnv: null,
    tools: [{
      tool: 'search', tier: 1 as const, outboundSink: false,
      riskClass: 'readOnly' as const, summary: 'Найти задачу по тексту',
    }],
    ...overrides,
  }
}

function harness(options: {
  entries?: ReturnType<typeof entry>[]
  descriptors?: RawDescriptor[]
  pin?: string
  invoke?: McpRuntimeDeps['invokeTool']
} = {}) {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = []
  const quarantined: Array<{ name: string; reason: string }> = []
  const servers = options.entries ?? [entry()]
  const handle: McpProcessHandle = { id: 'p1', env: {}, terminate: () => {} }
  const runtime: McpRuntimeDeps = {
    spawnProcess: () => handle,
    resolvePin: async () => options.pin ?? PIN,
    fetchDescriptors: async () => options.descriptors ?? [SEARCH],
    invokeTool: options.invoke ?? (async () => 'ничего не найдено'),
  }
  return {
    events,
    quarantined,
    connect: () => connectMcpCapability({
      allowlist: {
        names: () => servers.map((item) => item.name),
        snapshot: () => ({ servers: servers as never }),
      } as never,
      runtime,
      inputGuard: makeInputGuard(),
      resolveToken: () => null,
      quarantine: (name, reason) => { quarantined.push({ name, reason }) },
      emit: (event, payload) => { events.push({ event, payload }) },
    }),
  }
}

describe('connecting approved MCP servers', () => {
  it('publishes the capability with the operator-approved summary as the menu line', async () => {
    const h = harness()

    const connected = await h.connect()

    expect(connected?.servers).toEqual(['tracker'])
    expect(connected?.capability.menu()).toEqual([
      { name: 'tracker.search', summary: 'Найти задачу по тексту', rw: 'read', tier: 1 },
    ])
    // The prefix carries the menu, not the schema or the endpoint.
    const prefix = new TextDecoder().decode(connected!.capability.prefixExtension())
    expect(prefix).toContain('tracker.search')
    expect(prefix).not.toContain('/usr/bin/tracker-server')
  })

  it('gives the model nothing when nothing is configured', async () => {
    const h = harness({ entries: [] })

    expect(await h.connect()).toBeNull()
  })

  it('gives the model nothing when the server is not the one that was approved', async () => {
    const h = harness({ pin: 'v9.9.9@sha256:different' })

    expect(await h.connect()).toBeNull()
    expect(h.quarantined).toEqual([{ name: 'tracker', reason: 'live-pin-mismatch' }])
  })

  it('gives the model nothing when the approved tool is not in the menu', async () => {
    // The operator approved `search`; the server offers only something else.
    const h = harness({
      descriptors: [{ ...SEARCH, name: 'delete_everything', description: 'Удалить всё' }],
    })

    expect(await h.connect()).toBeNull()
  })

  it('drops a tool the operator approved without a description', async () => {
    const h = harness({
      entries: [entry({
        tools: [{
          tool: 'search', tier: 1, outboundSink: false, riskClass: 'readOnly', summary: null,
        }],
      })],
    })

    // No summary means no menu line, and no menu line means no capability at
    // all — the model may not name a tool it was never shown.
    expect(await h.connect()).toBeNull()
    expect(h.events.some((item) => item.event === 'mcp.summary_quarantined')).toBe(true)
  })

  it('survives a server that cannot be started at all', async () => {
    const events: Array<{ event: string }> = []
    const result = await connectMcpCapability({
      allowlist: {
        names: () => ['tracker'],
        snapshot: () => ({ servers: [entry()] as never }),
      } as never,
      runtime: {
        spawnProcess: () => { throw new Error('ENOENT') },
        resolvePin: async () => PIN,
        fetchDescriptors: async () => [SEARCH],
        invokeTool: async () => '',
      },
      inputGuard: makeInputGuard(),
      resolveToken: () => null,
      quarantine: () => {},
      emit: (event) => { events.push({ event }) },
    })

    expect(result).toBeNull()
  })

  it('carries an approved call to the server and quarantines the answer as untrusted', async () => {
    const invoke = vi.fn(async () => 'найдено 2 задачи')
    const h = harness({ invoke })
    const connected = await h.connect()
    const capability = connected!.capability
    const call = { name: 'call_mcp', args: { tool: 'tracker.search', args: { q: 'bug' } } }

    // Exactly the sequence the hook gate runs: resolve → Safety → complete →
    // execute. The tier and the outbound flag come from the approved policy,
    // not from the wrapper.
    const safetyCall = capability.resolveSafetyCall(call, { provenance: 'operator' } as never)
    expect(safetyCall).toMatchObject({ tool: 'mcp:read:tracker.search', policyTier: 1, outboundSink: false })
    capability.completeSafetyCall(call, safetyCall, true)

    await expect(capability.execute(call)).resolves.toEqual({ ok: true, output: 'найдено 2 задачи' })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('refuses a call the safety round-trip never approved', async () => {
    const invoke = vi.fn(async () => 'найдено 2 задачи')
    const h = harness({ invoke })
    const connected = await h.connect()
    const call = { name: 'call_mcp', args: { tool: 'tracker.search', args: { q: 'bug' } } }

    // No resolve/complete pair: the model cannot reach a server by calling the
    // executor directly, whatever the loop does around it.
    await expect(connected!.capability.execute(call))
      .resolves.toEqual({ ok: false, output: 'MCP_CALL_NOT_APPROVED' })
    expect(invoke).not.toHaveBeenCalled()
  })
})
