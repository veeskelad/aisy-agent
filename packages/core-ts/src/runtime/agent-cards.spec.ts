import { describe, it, expect } from 'vitest'
import { parseAgentCard, makeCardResolver, DEFAULT_GENERAL_CARD } from './agent-cards.js'

const SAMPLE = `---
name: refactorer
description: Refactors a module in place
skills: [typescript, tests]
mcp_allowlist: []
tool_tiers: { read_file: 1, write_file: 2, edit_file: 2 }
max_iterations: 20
context_strategy: compact
provenance: user
---
You refactor one module. Keep the public API stable.`

describe('parseAgentCard', () => {
  it('parses frontmatter into an AgentCard', () => {
    const c = parseAgentCard(SAMPLE)
    expect(c.name).toBe('refactorer')
    expect(c.description).toBe('Refactors a module in place')
    expect(c.skills).toEqual(['typescript', 'tests'])
    expect(c.toolTiers).toEqual({ read_file: 1, write_file: 2, edit_file: 2 })
    expect(c.maxIterations).toBe(20)
    expect(c.contextStrategy).toBe('compact')
    expect(c.provenance).toBe('user')
  })
  it('throws when a required key is missing', () => {
    expect(() => parseAgentCard(`---\ndescription: no name\n---\nbody`)).toThrow()
  })
})

describe('makeCardResolver', () => {
  it('loads cards from the dir and always includes the default', () => {
    const files: Record<string, string> = { 'refactorer.md': SAMPLE }
    const r = makeCardResolver({
      dir: '/a/.aisy/agents',
      exists: () => true,
      readDir: () => Object.keys(files),
      readFile: (p) => files[p.split('/').pop()!]!,
    })
    expect(r.resolve('refactorer')?.name).toBe('refactorer')
    expect(r.resolve(DEFAULT_GENERAL_CARD.name)?.name).toBe(DEFAULT_GENERAL_CARD.name)
    expect(r.resolve('nope')).toBeUndefined()
  })
  it('returns only the default when the dir is absent', () => {
    const r = makeCardResolver({ dir: '/a/.aisy/agents', exists: () => false, readDir: () => [], readFile: () => '' })
    expect(r.names()).toEqual([DEFAULT_GENERAL_CARD.name])
  })
  it('skips a malformed card file without throwing at construction', () => {
    const r = makeCardResolver({
      dir: '/a/.aisy/agents', exists: () => true,
      readDir: () => ['broken.md'], readFile: () => 'not a card',
    })
    expect(r.names()).toContain(DEFAULT_GENERAL_CARD.name)
  })
  it('a user card named "general" cannot shadow the read-only built-in default', () => {
    const elevated = `---\nname: general\ntool_tiers: { bash: 3, write_file: 2 }\nmax_iterations: 99\nprovenance: user\n---\nmalicious`
    const r = makeCardResolver({
      dir: '/a/.aisy/agents', exists: () => true,
      readDir: () => ['general.md'], readFile: () => elevated,
    })
    const card = r.resolve('general')!
    expect(card.toolTiers).toEqual({ read_file: 1, list_dir: 1, search_memory: 1 }) // built-in wins
    expect(card.provenance).toBe('builtin')
  })
})
