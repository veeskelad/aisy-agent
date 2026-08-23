import { describe, expect, it } from 'vitest'
import { canonicalDescriptorHash, type RawDescriptor } from '../mcp/index.js'
import {
  makeActiveMcpAllowlist,
  type ActiveMcpManifestV1,
  type ActiveMcpQuarantineReason,
} from './active-mcp-allowlist.js'

const DESCRIPTOR: RawDescriptor = {
  name: 'search',
  description: 'Untrusted live descriptor text',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  rwClassInputs: {},
}

function manifest(overrides: Record<string, unknown> = {}): ActiveMcpManifestV1 {
  return {
    schemaVersion: 1,
    servers: [{
      name: 'tracker',
      transport: 'stdio',
      command: ['/opt/aisy/bin/tracker-mcp'],
      pin: '1.2.3@sha256:abc123',
      descriptorHash: canonicalDescriptorHash([DESCRIPTOR]),
      descriptors: [DESCRIPTOR],
      tokenEnv: 'TRACKER_MCP_TOKEN',
      tools: [{
        tool: 'search', tier: 0, outboundSink: false,
        riskClass: 'readOnly', summary: 'Искать задачи',
      }],
      status: 'active',
      ...overrides,
    }],
  }
}

function load(state: unknown) {
  const quarantined: Array<{ name: string; reason: ActiveMcpQuarantineReason }> = []
  const allowlist = makeActiveMcpAllowlist({
    loadManifest: () => state,
    quarantine: (name, reason) => { quarantined.push({ name, reason }) },
  })
  return { allowlist, quarantined }
}

describe('production MCP allowlist', () => {
  it('accepts an exact, hash-pinned stdio server and returns defensive snapshots', () => {
    const { allowlist, quarantined } = load(manifest())
    expect(allowlist.names()).toEqual(['tracker'])
    expect(quarantined).toEqual([])
    const first = allowlist.snapshot()
    first.servers[0]!.name = 'mutated'
    expect(allowlist.snapshot().servers[0]!.name).toBe('tracker')
  })

  it('carries a well-formed human-owned legacy approval through to the entry (ADR-0067)', () => {
    const approval = { approved: true, approvedBy: 'operator', approvedAt: '2026-07-29T10:00:00Z' }
    const { allowlist, quarantined } = load(manifest({ legacyProtocol: approval }))

    expect(quarantined).toEqual([])
    expect(allowlist.names()).toEqual(['tracker'])
    expect(allowlist.snapshot().servers[0]!.legacyProtocol).toEqual(approval)
  })

  it('quarantines a malformed legacy approval with its own reason', () => {
    for (const broken of [
      { approved: false, approvedBy: 'operator', approvedAt: '2026-07-29T10:00:00Z' },
      { approved: true, approvedBy: '', approvedAt: '2026-07-29T10:00:00Z' },
      { approved: true, approvedBy: 'operator', approvedAt: 'yesterday' },
      { approved: true, approvedBy: 'operator', approvedAt: '2026-07-29T10:00:00Z', scope: 'all' },
      'approved',
    ]) {
      const { allowlist, quarantined } = load(manifest({ legacyProtocol: broken }))
      expect(allowlist.names()).toEqual([])
      expect(quarantined).toEqual([{ name: 'tracker', reason: 'invalid-era-approval' }])
    }
  })

  it('accepts and pins the complete normalized 2026 descriptor surface', () => {
    const descriptor: RawDescriptor = {
      ...DESCRIPTOR,
      title: 'Поиск',
      outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
      annotations: { readOnlyHint: true },
      execution: { taskSupport: 'forbidden' },
      icons: [{ src: 'data:image/svg+xml;base64,AA==' }],
      _meta: { vendor: { revision: 1 } },
    }
    const state = manifest({
      descriptors: [descriptor],
      descriptorHash: canonicalDescriptorHash([descriptor]),
    })

    const { allowlist, quarantined } = load(state)
    expect(allowlist.names()).toEqual(['tracker'])
    expect(quarantined).toEqual([])
    expect(allowlist.snapshot().servers[0]!.descriptors).toEqual([descriptor])
    expect(canonicalDescriptorHash([{ ...descriptor, execution: { taskSupport: 'optional' } }]))
      .not.toBe(canonicalDescriptorHash([descriptor]))
  })

  it('accepts only credential-free HTTPS endpoints for remote transport', () => {
    const state = manifest({
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.test/v1',
      command: undefined,
    })
    expect(load(state).allowlist.names()).toEqual(['tracker'])
  })

  it.each([
    ['relative stdio executable', { command: ['tracker-mcp'] }, 'invalid-transport'],
    ['plain HTTP endpoint', { transport: 'streamable-http', endpoint: 'http://mcp.example.test', command: undefined }, 'invalid-transport'],
    ['endpoint credentials', { transport: 'streamable-http', endpoint: 'https://u:p@mcp.example.test', command: undefined }, 'invalid-transport'],
    ['floating pin', { pin: 'latest' }, 'invalid-pin'],
    ['pin without an exact identity separator', { pin: '1.2.3' }, 'invalid-pin'],
    ['uppercase hash', { descriptorHash: 'A'.repeat(64) }, 'invalid-hash'],
    ['unsafe token ref', { tokenEnv: '../TOKEN' }, 'invalid-server'],
    ['multiline menu summary', { tools: [{ tool: 'search', tier: 0, outboundSink: false, riskClass: 'readOnly', summary: 'safe\ninject' }] }, 'invalid-policy'],
    ['read-only sink', { tools: [{ tool: 'search', tier: 0, outboundSink: true, riskClass: 'readOnly', summary: 'Search' }] }, 'invalid-policy'],
    ['unknown policy tool', { tools: [{ tool: 'write', tier: 2, outboundSink: true, riskClass: 'destructive', summary: 'Write' }] }, 'invalid-policy'],
    ['invalid execution hint', { descriptors: [{ ...DESCRIPTOR, execution: { taskSupport: 'always' } }] }, 'invalid-descriptor'],
  ] as const)('quarantines %s', (_label, overrides, reason) => {
    const { allowlist, quarantined } = load(manifest(overrides))
    expect(allowlist.names()).toEqual([])
    expect(quarantined).toContainEqual({ name: 'tracker', reason })
  })

  it('quarantines an approved-descriptor hash mismatch', () => {
    const { allowlist, quarantined } = load(manifest({ descriptorHash: '0'.repeat(64) }))
    expect(allowlist.names()).toEqual([])
    expect(quarantined).toContainEqual({ name: 'tracker', reason: 'descriptor-hash-mismatch' })
  })

  it('keeps archived servers recoverable but inactive', () => {
    const { allowlist, quarantined } = load(manifest({ status: 'archived' }))
    expect(allowlist.names()).toEqual([])
    expect(quarantined).toEqual([])
  })

  it('rejects duplicate server identities and ambiguous namespaced tools', () => {
    const duplicate = manifest()
    duplicate.servers.push({ ...duplicate.servers[0]! })
    expect(load(duplicate).quarantined).toContainEqual({ name: 'tracker', reason: 'duplicate-identity' })

    const ambiguous = manifest()
    ambiguous.servers.push({
      ...ambiguous.servers[0]!,
      name: 'tracker.search',
      command: ['/opt/aisy/bin/other-mcp'],
      descriptors: [{ ...DESCRIPTOR, name: 'run' }],
      descriptorHash: canonicalDescriptorHash([{ ...DESCRIPTOR, name: 'run' }]),
      tools: [{ tool: 'run', tier: 0, outboundSink: false, riskClass: 'readOnly', summary: 'Run' }],
    })
    ambiguous.servers[0]!.tools = [{
      tool: 'search.run', tier: 0, outboundSink: false,
      riskClass: 'readOnly', summary: 'Ambiguous',
    }]
    ambiguous.servers[0]!.descriptors = [{ ...DESCRIPTOR, name: 'search.run' }]
    ambiguous.servers[0]!.descriptorHash = canonicalDescriptorHash(ambiguous.servers[0]!.descriptors)
    const result = load(ambiguous)
    expect(result.allowlist.names()).toEqual([])
    expect(result.quarantined.filter(item => item.reason === 'duplicate-identity')).toHaveLength(2)
  })

  it('quarantines unknown manifest fields instead of guessing', () => {
    const state = { ...manifest(), typo: true }
    const { allowlist, quarantined } = load(state)
    expect(allowlist.names()).toEqual([])
    expect(quarantined).toContainEqual({ name: '__manifest__', reason: 'invalid-manifest' })
  })
})
