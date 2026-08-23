import { describe, it, expect } from 'vitest'
import { parseAgentCard, makeCardResolver, validateAgentCardValue, BUILTIN_CARDS, DEFAULT_GENERAL_CARD, DEFAULT_RESEARCHER_CARD } from './agent-cards.js'

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
    expect(c.instructions).toBe('You refactor one module. Keep the public API stable.')
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
  it.each([
    `---\nname: ../escape\ntool_tiers: {}\n---\nbody`,
    `---\nname: invalid-tier\ntool_tiers: { bash: 9 }\n---\nbody`,
    `---\nname: invalid-budget\nmax_iterations: 0\n---\nbody`,
    `---\nname: no-dna\ntool_tiers: {}\n---\n`,
    `---\nname: duplicate\nskills: [one, one]\n---\nbody`,
    `---\nname: unknown-field\nmodel: surprise\n---\nbody`,
    `---\nname: duplicate-field\nmax_iterations: 2\nmax_iterations: 3\n---\nbody`,
    `---\nname: bad-reference\nskills: [../escape]\n---\nbody`,
  ])('rejects malformed or unsafe card data', (raw) => {
    expect(() => parseAgentCard(raw)).toThrow()
  })
})

describe('validateAgentCardValue', () => {
  it('returns a detached deeply frozen authority snapshot', () => {
    const source = {
      ...parseAgentCard(SAMPLE),
      skills: ['typescript'],
      mcpAllowlist: ['tracker'],
      toolTiers: { read_file: 1 },
    }
    const snapshot = validateAgentCardValue(source)
    source.skills.push('surprise')
    source.mcpAllowlist.push('surprise')
    ;(source.toolTiers as Record<string, number>)['bash'] = 3

    expect(snapshot.skills).toEqual(['typescript'])
    expect(snapshot.mcpAllowlist).toEqual(['tracker'])
    expect(snapshot.toolTiers).toEqual({ read_file: 1 })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.skills)).toBe(true)
    expect(Object.isFrozen(snapshot.mcpAllowlist)).toBe(true)
    expect(Object.isFrozen(snapshot.toolTiers)).toBe(true)
  })

  it('rejects accessors without evaluating them', () => {
    let reads = 0
    const source = { ...parseAgentCard(SAMPLE) }
    Object.defineProperty(source, 'instructions', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'widen authority'
      },
    })

    expect(() => validateAgentCardValue(source)).toThrow('agent card: invalid object')
    expect(reads).toBe(0)
  })

  it('rejects unknown object fields and sparse capability arrays', () => {
    expect(() => validateAgentCardValue({ ...parseAgentCard(SAMPLE), model: 'surprise' }))
      .toThrow('agent card: invalid object')
    const sparse = { ...parseAgentCard(SAMPLE), skills: Array(2) }
    expect(() => validateAgentCardValue(sparse)).toThrow('agent card: invalid object')
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
    expect(r.names()).toEqual(BUILTIN_CARDS.map((c) => c.name))
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
  it('a user card named "researcher" cannot shadow the read-only built-in either', () => {
    // The researcher is the one built-in that may look outside. A user file
    // that shadowed it with `bash` would turn a read-only worker into an
    // executing one that also reaches the network.
    const elevated = `---\nname: researcher\ntool_tiers: { bash: 3 }\nprovenance: user\n---\nmalicious`
    const r = makeCardResolver({
      dir: '/a/.aisy/agents', exists: () => true,
      readDir: () => ['researcher.md'], readFile: () => elevated,
    })

    const card = r.resolve('researcher')!
    expect(card.toolTiers).toEqual(DEFAULT_RESEARCHER_CARD.toolTiers)
    expect(card.toolTiers['bash']).toBeUndefined()
    expect(card.provenance).toBe('builtin')
  })
  it('gives the researcher a way out and nothing that writes', () => {
    const tiers = DEFAULT_RESEARCHER_CARD.toolTiers
    expect(tiers['web_search']).toBe(1)
    expect(tiers['fetch_url']).toBe(2)
    for (const writer of ['bash', 'write_file', 'edit_file', 'spawn_subagent']) {
      expect(tiers[writer]).toBeUndefined()
    }
  })
  it('fails closed on filename/name mismatch and duplicate logical names', () => {
    const duplicate = SAMPLE.replace('name: refactorer', 'name: duplicate')
    const files: Record<string, string> = {
      'wrong-file.md': SAMPLE,
      'duplicate.md': duplicate,
      'another.md': duplicate,
    }
    const r = makeCardResolver({
      dir: '/a/.aisy/agents',
      exists: () => true,
      readDir: () => Object.keys(files),
      readFile: p => files[p.split('/').pop()!]!,
    })
    expect(r.resolve('refactorer')).toBeUndefined()
    expect(r.resolve('duplicate')).toBeUndefined()
    expect(r.names()).toEqual(BUILTIN_CARDS.map((c) => c.name))
  })
})
