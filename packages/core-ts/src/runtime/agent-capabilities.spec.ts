import { describe, expect, it } from 'vitest'
import type { AgentCard, DelegationTask } from '../orchestration/index.js'
import {
  AgentCapabilityError,
  DelegationAuthorityError,
  resolveAgentCapabilityMatrix,
  resolveChildAgentCapabilityMatrix,
  resolveDelegationExecutionAuthority,
  type DelegationAuthorityHandle,
} from './agent-capabilities.js'
import { runtimeProviderTools } from './tool-catalog.js'

const tools = runtimeProviderTools().filter(tool =>
  ['read_file', 'write_file', 'bash'].includes(tool.name))

function card(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'reviewer',
    instructions: 'Review the delegated change.',
    skills: ['review-code'],
    mcpAllowlist: ['tracker'],
    toolTiers: { read_file: 0 },
    maxIterations: 10,
    contextStrategy: 'compact',
    provenance: 'user',
    ...overrides,
  }
}

describe('resolveAgentCapabilityMatrix', () => {
  it('advertises exactly the card tools and resolved Skills/MCP references', () => {
    const matrix = resolveAgentCapabilityMatrix({
      card: card(),
      toolCatalog: tools,
      activeSkills: new Set(['review-code']),
      activeMcpServers: new Set(['tracker']),
    })
    expect(matrix.tools.map(tool => tool.name)).toEqual(['read_file'])
    expect(matrix.toolTiers).toEqual({ read_file: 0 })
    expect(matrix.skills).toEqual(['review-code'])
    expect(matrix.mcpServers).toEqual(['tracker'])
  })

  it('AgentCard may tighten a global tier but can never lower it', () => {
    const lowered = resolveAgentCapabilityMatrix({
      card: card({ toolTiers: { write_file: 0 }, skills: [], mcpAllowlist: [] }),
      toolCatalog: tools,
      activeSkills: new Set(),
      activeMcpServers: new Set(),
      minimumToolTiers: { write_file: 2 },
    })
    const tightened = resolveAgentCapabilityMatrix({
      card: card({ toolTiers: { read_file: 3 }, skills: [], mcpAllowlist: [] }),
      toolCatalog: tools,
      activeSkills: new Set(),
      activeMcpServers: new Set(),
      minimumToolTiers: { read_file: 0 },
    })
    expect(lowered.toolTiers).toEqual({ write_file: 2 })
    expect(tightened.toolTiers).toEqual({ read_file: 3 })
  })

  it('child matrix advertises only the scoped executor executable subset', () => {
    const matrix = resolveChildAgentCapabilityMatrix({
      card: card({
        skills: [], mcpAllowlist: [],
        toolTiers: { read_file: 0, write_file: 2, bash: 2, remember: 2, spawn_subagent: 2 },
      }),
      toolCatalog: runtimeProviderTools(),
      activeSkills: new Set(),
      activeMcpServers: new Set(),
    })
    expect(matrix.tools.map(tool => tool.name)).toEqual(['read_file', 'write_file'])
    expect(matrix.toolTiers).toEqual({ read_file: 0, write_file: 2 })
  })

  it.each([
    ['UNKNOWN_TOOL', card({ toolTiers: { root_shell: 3 } }), new Set(['review-code']), new Set(['tracker'])],
    ['UNAVAILABLE_SKILL', card({ skills: ['missing'] }), new Set<string>(), new Set(['tracker'])],
    ['UNAVAILABLE_MCP', card({ mcpAllowlist: ['missing'] }), new Set(['review-code']), new Set<string>()],
  ] as const)('fails closed with %s before a provider can receive the card', (code, value, activeSkills, activeMcpServers) => {
    expect(() => resolveAgentCapabilityMatrix({
      card: value,
      toolCatalog: tools,
      activeSkills,
      activeMcpServers,
    })).toThrow(expect.objectContaining<Partial<AgentCapabilityError>>({ code }))
  })

  it('rejects duplicate provider schemas instead of resolving an ambiguous tool', () => {
    expect(() => resolveAgentCapabilityMatrix({
      card: card(),
      toolCatalog: [...tools, tools[0]!],
      activeSkills: new Set(['review-code']),
      activeMcpServers: new Set(['tracker']),
    })).toThrow(expect.objectContaining<Partial<AgentCapabilityError>>({
      code: 'DUPLICATE_TOOL_SCHEMA',
    }))
  })

  it('deep-clones and deep-freezes schemas and all matrix collections', () => {
    const catalog = [{
      name: 'read_file',
      description: 'read',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    }]
    const value = resolveAgentCapabilityMatrix({
      card: card({ skills: [], mcpAllowlist: [] }),
      toolCatalog: catalog,
      activeSkills: new Set(),
      activeMcpServers: new Set(),
    })

    ;(catalog[0]!.input_schema['properties'] as Record<string, unknown>)['path'] = { type: 'number' }
    expect(value.tools[0]!.input_schema).toEqual({
      type: 'object', properties: { path: { type: 'string' } },
    })
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.tools)).toBe(true)
    expect(Object.isFrozen(value.tools[0])).toBe(true)
    expect(Object.isFrozen(value.tools[0]!.input_schema['properties'])).toBe(true)
    expect(Object.isFrozen(value.skills)).toBe(true)
    expect(Object.isFrozen(value.mcpServers)).toBe(true)
  })
})

const binding = {
  operatorId: 'operator-1',
  profileId: 'default',
  projectId: 'project-1',
  sessionId: 'session-1',
  scope: 'session' as const,
}

function task(overrides: Partial<DelegationTask> = {}): DelegationTask {
  return {
    taskId: 'review',
    intent: 'review',
    assignedTo: 'reviewer',
    dependsOn: [],
    scope: { owns: ['src/**'], doNotTouch: ['src/private/**'], taskClass: 'critique' },
    budgetSlice: { iterations: 8, spendUsd: 0.25 },
    outputContract: 'evidence',
    retryPolicy: { maxReplans: 2, maxIterations: 6 },
    ...overrides,
  }
}

function authorityHandle(value: AgentCard): DelegationAuthorityHandle {
  return {
    delegationId: 'd-review',
    taskId: 'review',
    binding,
    card: value,
    owns: ['src/**'],
    writableMcp: ['tracker'],
    permitsTool: name => name === 'read_file',
    permitsMcp: name => name === 'tracker',
  }
}

describe('resolveDelegationExecutionAuthority', () => {
  it('seals and restores the exact executable child subset', () => {
    const value = card({ toolTiers: { read_file: 0, bash: 2 } })
    const matrix = resolveChildAgentCapabilityMatrix({
      card: value,
      toolCatalog: runtimeProviderTools(),
      activeSkills: new Set(['review-code']),
      activeMcpServers: new Set(['tracker']),
    })
    const authority = resolveDelegationExecutionAuthority({
      handle: authorityHandle(value), task: task(), matrix, maxConcurrency: 1,
    })
    expect(authority.capabilities.tools.map(tool => tool.name)).toEqual(['read_file'])
    expect(authority.capabilities.toolTiers).toEqual({ read_file: 0 })
  })

  it('rejects an unfiltered child matrix containing an always-denied tool', () => {
    const value = card({ toolTiers: { read_file: 0, bash: 2 } })
    const matrix = resolveAgentCapabilityMatrix({
      card: value,
      toolCatalog: runtimeProviderTools(),
      activeSkills: new Set(['review-code']),
      activeMcpServers: new Set(['tracker']),
    })
    expect(() => resolveDelegationExecutionAuthority({
      handle: { ...authorityHandle(value), permitsTool: () => true },
      task: task(), matrix, maxConcurrency: 1,
    })).toThrow(expect.objectContaining({ code: 'CAPABILITY_MISMATCH' }))
  })

  it('freezes exact identity, DNA, capabilities and minimum limits with deterministic hashes', () => {
    const value = card({ maxIterations: 10 })
    const matrix = resolveAgentCapabilityMatrix({
      card: value,
      toolCatalog: tools,
      activeSkills: new Set(['review-code']),
      activeMcpServers: new Set(['tracker']),
    })
    const first = resolveDelegationExecutionAuthority({
      handle: authorityHandle(value), task: task(), matrix, maxConcurrency: 3,
    })
    const second = resolveDelegationExecutionAuthority({
      handle: authorityHandle(value), task: task(), matrix, maxConcurrency: 3,
    })

    expect(first.identity).toEqual({
      delegationId: 'd-review', taskId: 'review', childSessionId: 'd-review', binding,
    })
    expect(first.limits).toEqual({
      depth: 1, maxDepth: 1, maxConcurrency: 3, maxIterations: 6,
      maxReplans: 2, spendUsd: 0.25,
    })
    expect(first.authorityHash).toMatch(/^[a-f0-9]{64}$/)
    expect(first.authorityHash).toBe(second.authorityHash)
    expect(first.dna.sha256).toBe(second.dna.sha256)
    expect(first.capabilityHash).toBe(second.capabilityHash)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.identity.binding)).toBe(true)
    expect(Object.isFrozen(first.capabilities.tools[0]?.input_schema)).toBe(true)

    value.instructions = 'mutated later'
    value.toolTiers = { bash: 3 }
    expect(first.dna.body).toBe('Review the delegated change.')
    expect(first.capabilities.tools.map(tool => tool.name)).toEqual(['read_file'])
  })

  it.each([0, 65, 1.5])('rejects invalid maxConcurrency %s', maxConcurrency => {
    const value = card()
    const matrix = resolveAgentCapabilityMatrix({
      card: value, toolCatalog: tools,
      activeSkills: new Set(['review-code']), activeMcpServers: new Set(['tracker']),
    })
    expect(() => resolveDelegationExecutionAuthority({
      handle: authorityHandle(value), task: task(), matrix, maxConcurrency,
    })).toThrow(expect.objectContaining<Partial<DelegationAuthorityError>>({
      code: 'CONCURRENCY_INVALID',
    }))
  })

  it('rejects identity, capability and budget drift before an authority is returned', () => {
    const value = card()
    const matrix = resolveAgentCapabilityMatrix({
      card: value, toolCatalog: tools,
      activeSkills: new Set(['review-code']), activeMcpServers: new Set(['tracker']),
    })
    expect(() => resolveDelegationExecutionAuthority({
      handle: { ...authorityHandle(value), taskId: 'other' },
      task: task(), matrix, maxConcurrency: 1,
    })).toThrow(expect.objectContaining({ code: 'IDENTITY_MISMATCH' }))
    expect(() => resolveDelegationExecutionAuthority({
      handle: { ...authorityHandle(value), owns: ['other/**'] },
      task: task(), matrix, maxConcurrency: 1,
    })).toThrow(expect.objectContaining({ code: 'CAPABILITY_MISMATCH' }))
    expect(() => resolveDelegationExecutionAuthority({
      handle: authorityHandle(value),
      task: task({ retryPolicy: { maxReplans: -1, maxIterations: 1 } }),
      matrix, maxConcurrency: 1,
    })).toThrow(expect.objectContaining({ code: 'BUDGET_INVALID' }))
  })

  it('rejects provider-schema rollback at the child authority boundary', () => {
    const value = card()
    const matrix = resolveAgentCapabilityMatrix({
      card: value,
      toolCatalog: tools,
      activeSkills: new Set(['review-code']),
      activeMcpServers: new Set(['tracker']),
    })
    const rolledBack = {
      ...matrix,
      tools: matrix.tools.map(tool => ({ ...tool, input_schema: {} })),
    }
    expect(() => resolveDelegationExecutionAuthority({
      handle: authorityHandle(value),
      task: task(),
      matrix: rolledBack,
      maxConcurrency: 1,
    })).toThrow(expect.objectContaining({ code: 'CAPABILITY_MISMATCH' }))
  })
})
