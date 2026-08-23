import type { McpAllowlistConfig } from '@aisy/core'
import { describe, expect, it } from 'vitest'
import { makeConfiguredMcpMenuSource } from './mcp-menu-runtime.js'

function snapshot(): McpAllowlistConfig {
  return {
    servers: [{
      name: 'tracker',
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.test/rpc',
      pin: 'tracker@sha256:fixture',
      descriptorHash: 'a'.repeat(64),
      descriptors: [{
        name: 'search', description: 'RAW DESCRIPTOR MUST STAY OUT', inputSchema: {},
      }],
      tokenEnv: 'TRACKER_ACCESS_REFERENCE',
      tools: [{
        tool: 'search', tier: 0, outboundSink: false, riskClass: 'readOnly',
        summary: 'Поиск задач',
      }],
    }],
  }
}

describe('configured MCP menu source', () => {
  it('projects only policy fields and distinguishes configured from active', () => {
    const active = new Set<string>()
    const raw = snapshot()
    const source = makeConfiguredMcpMenuSource({ snapshot: raw, activeServerNames: () => active })
    raw.servers[0]!.tools[0]!.summary = 'mutated after composition'

    expect(source()).toEqual([{
      name: 'tracker.search', summary: 'Поиск задач', rw: 'read', tier: 0, active: false,
    }])
    active.add('tracker')
    expect(source()[0]).toMatchObject({ name: 'tracker.search', active: true })
    expect(JSON.stringify(source())).not.toMatch(/endpoint|descriptor|pin|token|RAW/i)
  })

  it('omits an absent human summary instead of exposing descriptor prose', () => {
    const raw = snapshot()
    raw.servers[0]!.tools[0]!.summary = null
    const source = makeConfiguredMcpMenuSource({ snapshot: raw, activeServerNames: () => [] })
    expect(source()).toEqual([{
      name: 'tracker.search', rw: 'read', tier: 0, active: false,
    }])
  })
})
