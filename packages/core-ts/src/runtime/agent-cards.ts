// AgentCard loader (runtime, ADR-0039/0052).
//
// Loads sub-agent capability cards from .aisy/agents/*.md (YAML frontmatter +
// Markdown body) and always offers a bundled read-only general card so
// delegation works out of the box. The card is the SOLE capability authority —
// the model cannot widen tools/skills/MCP beyond what its card declares.

import type { AgentCard } from '../orchestration/index.js'

export interface CardResolver {
  resolve(name: string): AgentCard | undefined
  names(): string[]
}

export const DEFAULT_GENERAL_CARD: AgentCard = {
  name: 'general',
  description: 'Read-only general worker (search, read, list).',
  skills: [],
  mcpAllowlist: [],
  toolTiers: { read_file: 1, list_dir: 1, search_memory: 1 },
  maxIterations: 12,
  contextStrategy: 'compact',
  provenance: 'builtin',
}

function stripQuotes(s: string): string {
  const t = s.trim()
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t
}

function parseList(v: string): string[] {
  const inner = v.trim().replace(/^\[/, '').replace(/\]$/, '').trim()
  if (inner.length === 0) return []
  return inner.split(',').map((x) => stripQuotes(x)).filter((x) => x.length > 0)
}

function parseRecord(v: string): Record<string, number> {
  const inner = v.trim().replace(/^\{/, '').replace(/\}$/, '').trim()
  const out: Record<string, number> = {}
  if (inner.length === 0) return out
  for (const pair of inner.split(',')) {
    const [k, val] = pair.split(':')
    if (k && val !== undefined) out[stripQuotes(k)] = Number(val.trim())
  }
  return out
}

export function parseAgentCard(text: string): AgentCard {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!m || !m[1]) throw new Error('agent card: missing YAML frontmatter')
  const fm: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  const name = fm['name'] ? stripQuotes(fm['name']) : ''
  if (name.length === 0) throw new Error('agent card: name is required')
  const ctx = fm['context_strategy'] ? stripQuotes(fm['context_strategy']) : 'compact'
  const prov = fm['provenance'] ? stripQuotes(fm['provenance']) : 'user'
  const card: AgentCard = {
    name,
    ...(fm['description'] ? { description: stripQuotes(fm['description']) } : {}),
    skills: fm['skills'] ? parseList(fm['skills']) : [],
    mcpAllowlist: fm['mcp_allowlist'] ? parseList(fm['mcp_allowlist']) : [],
    toolTiers: fm['tool_tiers'] ? parseRecord(fm['tool_tiers']) : {},
    maxIterations: fm['max_iterations'] ? Number(fm['max_iterations']) : 12,
    contextStrategy: ctx === 'full' ? 'full' : 'compact',
    provenance: prov === 'builtin' ? 'builtin' : prov === 'community' ? 'community' : 'user',
  }
  return card
}

export function makeCardResolver(deps: {
  dir: string
  exists: (path: string) => boolean
  readDir: (dir: string) => string[]
  readFile: (path: string) => string
}): CardResolver {
  const cards = new Map<string, AgentCard>([[DEFAULT_GENERAL_CARD.name, DEFAULT_GENERAL_CARD]])
  if (deps.exists(deps.dir)) {
    for (const f of deps.readDir(deps.dir)) {
      if (!f.endsWith('.md')) continue
      try {
        const card = parseAgentCard(deps.readFile(`${deps.dir}/${f}`))
        cards.set(card.name, card)
      } catch {
        // skip malformed card; the default remains available
      }
    }
  }
  return {
    resolve: (name) => cards.get(name),
    names: () => [...cards.keys()],
  }
}
