import { describe, expect, it, vi } from 'vitest'
import type { McpAllowlistConfig, McpManager, ResolvedMcpCall } from '../mcp/index.js'
import { connectActiveMcpCatalog } from './active-mcp-catalog.js'
import type { ActiveMcpAllowlist, ActiveMcpQuarantineReason } from './active-mcp-allowlist.js'

function allowlist(): ActiveMcpAllowlist {
  const snapshot: McpAllowlistConfig = { servers: [] }
  return {
    names: () => ['zeta', 'alpha', 'pinbad', 'blocked'],
    snapshot: () => snapshot,
  }
}

function manager(): McpManager {
  return {
    verifyHash: () => true,
    connect: vi.fn(async (name) => {
      if (name === 'blocked') return {
        kind: 'disabled' as const,
        reason: 'hash-mismatch' as const,
        diffCard: {
          server: name, oldHash: '0'.repeat(64), newHash: '1'.repeat(64),
          descriptorDiff: { previous: [], live: [] },
        },
      }
      if (name === 'pinbad') return { kind: 'refused' as const, reason: 'pin-mismatch' as const }
      return {
        kind: 'connected' as const,
        menu: [{ name: `${name}.read`, summary: `Read ${name}`, rw: 'read' as const, tier: 0 as const }],
      }
    }),
    resolve: vi.fn((namespaced, args): ResolvedMcpCall => {
      const split = namespaced.lastIndexOf('.')
      return {
        server: namespaced.slice(0, split),
        tool: namespaced.slice(split + 1),
        args: args as Record<string, unknown>,
        outboundSink: false,
        tier: 0,
        riskClass: 'readOnly',
      }
    }),
    call: vi.fn(async (namespaced) => ({ provenance: 'untrusted' as const, text: namespaced, server: namespaced.split('.')[0]! })),
  }
}

describe('active MCP startup catalog', () => {
  it('freezes only gauntlet-connected servers and sorts a defensive menu', async () => {
    const quarantined: Array<{ name: string; reason: ActiveMcpQuarantineReason }> = []
    const mcp = manager()
    const catalog = await connectActiveMcpCatalog({
      allowlist: allowlist(),
      makeManager: () => mcp,
      quarantine: (name, reason) => { quarantined.push({ name, reason }) },
    })
    expect(catalog.names()).toEqual(['alpha', 'zeta'])
    expect(catalog.menu().map(item => item.name)).toEqual(['alpha.read', 'zeta.read'])
    expect(catalog.ownerOf('alpha.read')).toBe('alpha')
    expect(catalog.ownerOf('alpha.hidden')).toBeNull()
    expect(quarantined).toEqual([
      { name: 'pinbad', reason: 'live-pin-mismatch' },
      { name: 'blocked', reason: 'descriptor-hash-mismatch' },
    ])

    const first = catalog.menu()
    first[0]!.summary = 'mutated'
    expect(catalog.menu()[0]!.summary).toBe('Read alpha')
  })

  it('quarantines a connected server whose menu claims another server or duplicates a tool', async () => {
    const mcp = manager()
    vi.mocked(mcp.connect).mockImplementation(async (name) => {
      if (name === 'alpha') return {
        kind: 'connected',
        menu: [
          { name: 'zeta.read', summary: 'wrong owner', rw: 'read', tier: 0 },
          { name: 'zeta.read', summary: 'duplicate', rw: 'read', tier: 0 },
        ],
      }
      return { kind: 'refused', reason: 'token-unresolved' }
    })
    const quarantine = vi.fn()
    const catalog = await connectActiveMcpCatalog({
      allowlist: allowlist(), makeManager: () => mcp, quarantine,
    })
    expect(catalog.names()).toEqual([])
    expect(catalog.menu()).toEqual([])
    expect(quarantine).toHaveBeenCalledWith('alpha', 'invalid-policy')
  })

  it('re-validates exact frozen ownership on resolve and call', async () => {
    const mcp = manager()
    const catalog = await connectActiveMcpCatalog({
      allowlist: allowlist(), makeManager: () => mcp, quarantine: () => {},
    })
    vi.mocked(mcp.resolve).mockReturnValue({
      server: 'zeta', tool: 'read', args: {}, outboundSink: false, tier: 0, riskClass: 'readOnly',
    })
    expect(() => catalog.resolve('alpha.read', {})).toThrow(/changed ownership/i)
    await expect(catalog.call('alpha.read', {})).rejects.toThrow(/changed ownership/i)
    expect(mcp.call).not.toHaveBeenCalled()
  })

  it('allows only tools exposed by the frozen connected menu', async () => {
    const mcp = manager()
    const catalog = await connectActiveMcpCatalog({
      allowlist: allowlist(),
      makeManager: () => mcp,
      quarantine: () => {},
    })
    await expect(catalog.call('alpha.read', { q: 'x' }))
      .resolves.toMatchObject({ provenance: 'untrusted', text: 'alpha.read' })
    await expect(catalog.call('blocked.read', {})).rejects.toThrow(/not active/i)
    await expect(catalog.call('alpha.hidden', {})).rejects.toThrow(/not active/i)
    expect(mcp.call).toHaveBeenCalledTimes(1)
  })

  it('keeps transient connect failures inactive without durable quarantine', async () => {
    const mcp = manager()
    vi.mocked(mcp.connect).mockImplementation(async (name) => {
      if (name === 'alpha') throw new Error('temporarily down')
      return { kind: 'refused', reason: 'token-unresolved' }
    })
    const quarantine = vi.fn()
    const catalog = await connectActiveMcpCatalog({
      allowlist: allowlist(), makeManager: () => mcp, quarantine,
    })
    expect(catalog.names()).toEqual([])
    expect(quarantine).not.toHaveBeenCalled()
  })
})
