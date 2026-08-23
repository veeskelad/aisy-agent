// What the manager needs from these adapters is not that they fetch — it is
// that the pin it verifies, the descriptors it hashes and the call it makes all
// land on one process, and that the protocol era comes from the allowlist
// rather than from the server.

import type { McpAllowlistConfig, McpSdkClientPlan, McpServerEntry } from '@aisy/core'
import { describe, expect, it } from 'vitest'

import { makeMcpRuntime } from './mcp-runtime.js'
import type { McpStdioClientPort } from './mcp-stdio-client.js'

const MODERN = '2026-07-28'
const LEGACY = '2025-11-25'
const COMMAND = ['/usr/local/bin/tracker-mcp', '--stdio']

const TOOL = {
  name: 'read_issue',
  description: 'Read one issue',
  inputSchema: { type: 'object', properties: {} },
}

function entry(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    name: 'tracker',
    transport: 'stdio',
    command: [...COMMAND],
    pin: 'tracker-mcp@2.1.0',
    descriptorHash: 'hash',
    tokenEnv: null,
    tools: [{ tool: 'read_issue', tier: 1, outboundSink: false, riskClass: 'readOnly', summary: 'Read' }],
    ...overrides,
  }
}

const allowlist = (...servers: McpServerEntry[]): McpAllowlistConfig => ({ servers })

interface FakeClient extends McpStdioClientPort {
  readonly opened: { command: readonly string[]; env: Record<string, string>; plan: McpSdkClientPlan }[]
}

function fakeTransport(options: {
  era?: 'modern' | 'legacy'
  identity?: { name: string; version: string } | null
  callText?: string
  isError?: boolean
} = {}) {
  const opened: FakeClient['opened'] = []
  const instances: { closed: number; lists: number; calls: Array<{ name: string; args: unknown }> }[] = []
  const factory = (input: { command: readonly string[]; env?: Record<string, string> }) =>
    (plan: McpSdkClientPlan): McpStdioClientPort => {
      opened.push({ command: input.command, env: input.env ?? {}, plan })
      const state = { closed: 0, lists: 0, calls: [] as Array<{ name: string; args: unknown }> }
      instances.push(state)
      const era = options.era ?? 'modern'
      return {
        connect: async () => undefined,
        negotiatedProtocol: () => ({ era, version: era === 'modern' ? MODERN : LEGACY }),
        serverIdentity: () => options.identity === undefined
          ? { name: 'tracker-mcp', version: '2.1.0' }
          : options.identity,
        listTools: async () => {
          state.lists += 1
          return { resultType: 'complete', tools: [TOOL] }
        },
        callTool: async (call) => {
          state.calls.push({ name: call.name, args: call.arguments })
          return {
            resultType: 'complete',
            content: [{ type: 'text', text: options.callText ?? 'issue-42' }],
            ...(options.isError === true ? { isError: true } : {}),
          }
        },
        close: async () => { state.closed += 1 },
      }
    }
  return { factory: factory as never, opened, instances }
}

function runtime(config: McpAllowlistConfig | null, transport = fakeTransport()) {
  return {
    deps: makeMcpRuntime({ allowlist: () => config, createClient: transport.factory }),
    transport,
  }
}

describe('the manager’s I/O seams', () => {
  it('verifies and calls on one process, not three', async () => {
    const { deps, transport } = runtime(allowlist(entry()))
    const handle = deps.spawnProcess([...COMMAND], {})

    const pin = await deps.resolvePin(handle)
    const descriptors = await deps.fetchDescriptors(handle)
    const text = await deps.invokeTool(handle, {
      server: 'tracker', tool: 'read_issue', args: { id: 42 },
      outboundSink: false, tier: 1, riskClass: 'readOnly',
    })

    expect(pin).toBe('tracker-mcp@2.1.0')
    expect(descriptors.map(item => item.name)).toEqual(['read_issue'])
    expect(text).toBe('issue-42')
    expect(transport.opened).toHaveLength(1)
    expect(transport.instances[0]?.calls).toEqual([{ name: 'read_issue', args: { id: 42 } }])
  })

  it('offers only the modern era to a server whose entry never approved the old one', async () => {
    const { deps, transport } = runtime(allowlist(entry()))
    await deps.resolvePin(deps.spawnProcess([...COMMAND], {}))

    expect(transport.opened[0]?.plan.supportedProtocolVersions).toEqual([MODERN])
  })

  it('offers the legacy era only where a human approved it', async () => {
    const approved = entry({
      legacyProtocol: { approved: true, approvedBy: 'operator', approvedAt: '2026-08-01T00:00:00Z' },
    })
    const transport = fakeTransport({ era: 'legacy' })
    const { deps } = runtime(allowlist(approved), transport)

    await deps.resolvePin(deps.spawnProcess([...COMMAND], {}))

    expect(transport.opened[0]?.plan.supportedProtocolVersions).toEqual([MODERN, LEGACY])
  })

  it('treats a command that is in no entry as modern-only', async () => {
    const { deps, transport } = runtime(allowlist(entry({ command: ['/usr/local/bin/other'] })))

    await deps.resolvePin(deps.spawnProcess([...COMMAND], {}))

    expect(transport.opened[0]?.plan.supportedProtocolVersions).toEqual([MODERN])
  })

  it('passes only the token the manager resolved into the process', async () => {
    const { deps, transport } = runtime(allowlist(entry({ tokenEnv: 'TRACKER_TOKEN' })))

    await deps.resolvePin(deps.spawnProcess([...COMMAND], { TRACKER_TOKEN: 'secret' }))

    expect(transport.opened[0]?.env).toEqual({ TRACKER_TOKEN: 'secret' })
  })

  it('refuses to invent a pin for a server that will not say what it is', async () => {
    const { deps } = runtime(allowlist(entry()), fakeTransport({ identity: null }))

    await expect(deps.resolvePin(deps.spawnProcess([...COMMAND], {})))
      .rejects.toMatchObject({ reason: 'IDENTITY_MISSING' })
  })

  it('marks a failed tool result instead of passing it off as an answer', async () => {
    const { deps } = runtime(allowlist(entry()), fakeTransport({ callText: 'not found', isError: true }))
    const handle = deps.spawnProcess([...COMMAND], {})

    const text = await deps.invokeTool(handle, {
      server: 'tracker', tool: 'read_issue', args: {},
      outboundSink: false, tier: 1, riskClass: 'readOnly',
    })

    expect(text).toBe('[tool error] not found')
  })

  it('ends the process on terminate and refuses the handle afterwards', async () => {
    const { deps, transport } = runtime(allowlist(entry()))
    const handle = deps.spawnProcess([...COMMAND], {})
    await deps.resolvePin(handle)

    handle.terminate()

    expect(transport.instances[0]?.closed).toBe(1)
    await expect(deps.fetchDescriptors(handle)).rejects.toMatchObject({ reason: 'UNKNOWN_HANDLE' })
  })

  it('refuses an endpoint: this build speaks stdio only', () => {
    const { command: _stdio, ...rest } = entry()
    const { deps } = runtime(allowlist({
      ...rest, name: 'remote', transport: 'streamable-http', endpoint: 'https://mcp.example.com',
    }))

    expect(() => deps.spawnProcess(['https://mcp.example.com'], {}))
      .toThrowError(expect.objectContaining({ reason: 'TRANSPORT_UNSUPPORTED' }))
  })

  it('gives each spawn its own handle, so one server’s end is not another’s', async () => {
    const { deps, transport } = runtime(allowlist(entry()))
    const first = deps.spawnProcess([...COMMAND], {})
    const second = deps.spawnProcess([...COMMAND], {})
    await deps.resolvePin(first)
    await deps.resolvePin(second)

    first.terminate()

    expect(first.id).not.toBe(second.id)
    expect(transport.instances[1]?.closed).toBe(0)
    await expect(deps.fetchDescriptors(second)).resolves.toHaveLength(1)
  })
})
