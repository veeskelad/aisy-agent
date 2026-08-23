import { canonicalDescriptorHash, makeActiveMcpAllowlist, type RawDescriptor } from '@aisy/core'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeNodeMcpAllowlistPersistence } from './mcp-allowlist-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const descriptor: RawDescriptor = {
  name: 'search',
  description: 'Search',
  inputSchema: { type: 'object' },
  rwClassInputs: {},
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-mcp-'))
  roots.push(value)
  mkdirSync(value, { recursive: true })
  return value
}

function manifest() {
  return {
    schemaVersion: 1,
    servers: [{
      name: 'tracker', transport: 'stdio', command: ['/opt/aisy/bin/tracker-mcp'],
      pin: '1.0.0@sha256:abc', descriptorHash: canonicalDescriptorHash([descriptor]),
      descriptors: [descriptor], tokenEnv: 'TRACKER_TOKEN', status: 'active',
      tools: [{
        tool: 'search', tier: 0, outboundSink: false,
        riskClass: 'readOnly', summary: 'Искать',
      }],
    }],
  }
}

describe('Node MCP allowlist persistence', () => {
  it('loads a valid manifest and persists descriptor quarantine across restart', () => {
    const dir = root()
    const state = manifest()
    writeFileSync(join(dir, 'mcp-allowlist.json'), JSON.stringify(state))
    const port = makeNodeMcpAllowlistPersistence({
      root: dir,
      nowIso: () => '2026-07-27T00:00:00.000Z',
    })
    expect(makeActiveMcpAllowlist(port).names()).toEqual(['tracker'])

    state.servers[0]!.descriptors[0]!.description = 'tampered'
    writeFileSync(join(dir, 'mcp-allowlist.json'), JSON.stringify(state))
    expect(makeActiveMcpAllowlist(port).names()).toEqual([])
    const quarantinePath = join(dir, 'mcp-quarantine.json')
    expect(JSON.parse(readFileSync(quarantinePath, 'utf8')).records.tracker.reason)
      .toBe('descriptor-hash-mismatch')
    expect(statSync(quarantinePath).mode & 0o777).toBe(0o600)

    writeFileSync(join(dir, 'mcp-allowlist.json'), JSON.stringify(manifest()))
    expect(makeActiveMcpAllowlist(makeNodeMcpAllowlistPersistence({ root: dir })).names()).toEqual([])
  })

  it('quarantines corrupt and oversized manifests without partial activation', () => {
    const dir = root()
    writeFileSync(join(dir, 'mcp-allowlist.json'), '{broken')
    expect(makeActiveMcpAllowlist(makeNodeMcpAllowlistPersistence({ root: dir })).names()).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'mcp-quarantine.json'), 'utf8')).records.__manifest__.reason)
      .toBe('invalid-manifest')

    const oversized = root()
    writeFileSync(join(oversized, 'mcp-allowlist.json'), 'x'.repeat(1024 * 1024 + 1))
    expect(makeActiveMcpAllowlist(makeNodeMcpAllowlistPersistence({ root: oversized })).names()).toEqual([])
    expect(JSON.parse(readFileSync(join(oversized, 'mcp-quarantine.json'), 'utf8')).records.__manifest__.reason)
      .toBe('invalid-manifest')
  })

  it('rejects unsafe quarantine keys before filesystem state changes', () => {
    const dir = root()
    const port = makeNodeMcpAllowlistPersistence({ root: dir })
    expect(() => port.quarantine('../outside', 'invalid-server')).toThrow(/unsafe MCP server name/)
    expect(() => statSync(join(dir, 'mcp-quarantine.json'))).toThrow()
  })
})

