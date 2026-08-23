import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const production = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')

describe('AgentCard catalog production composition', () => {
  it('wires one registry to main selection, subagent selection and lifecycle catalog', () => {
    expect(production.match(/makeAgentCardRegistry\(\{/g)).toHaveLength(1)
    expect(production.match(/registry: agentCardRegistry/g)).toHaveLength(3)
    expect(production).toContain('legacy: agentCardLegacyImport')
    expect(production).toContain("root: join(base, 'agents')")
  })

  it('enables legacy import only through the source-checkout confinement worker', () => {
    expect(production).toContain("new URL('../../../sidecars-py/', import.meta.url)")
    expect(production).toContain("join(sidecarsRoot, '.venv', 'bin', 'python')")
    expect(production).toContain("join(sidecarsRoot, 'aisy_sidecars', 'confinement_worker.py')")
    expect(production).toContain('makeNodeConfinementProcessPort({')
    expect(production).not.toMatch(/agentCardLegacyImport[\s\S]{0,500}(readFileSync|makeCardResolver)/)
  })

  it('does not let Telegram composition write selection or cutover environment', () => {
    expect(production).not.toMatch(/process\.env\[['\"]AISY_MAIN_AGENT_CARD['\"]\]\s*=(?!=)/)
    expect(production).not.toMatch(/process\.env\[['\"]AISY_AGENT_CARD_REGISTRY['\"]\]\s*=(?!=)/)
  })
})
