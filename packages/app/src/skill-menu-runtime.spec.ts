import { describe, expect, it } from 'vitest'
import { makeConfiguredSkillMenuSource, makeTelemetrySkillBodyLoader } from './skill-menu-runtime.js'

describe('configured Skill menu source', () => {
  it('freezes the active AgentCard intersection at composition', () => {
    const allowed = new Set(['inspect'])
    const entries = [
      { name: 'inspect', description: 'Проверить артефакты' },
      { name: 'write-report', description: 'Собрать отчёт' },
    ]
    const source = makeConfiguredSkillMenuSource({ entries, allowedSkillNames: allowed })
    entries[0]!.description = 'mutated after composition'
    allowed.add('write-report')

    expect(source()).toEqual([{
      name: 'inspect', summary: 'Проверить артефакты',
    }])
  })

  it('projects every active entry when no main AgentCard narrows the catalog', () => {
    const entries = [{
      name: 'inspect', description: 'Проверить артефакты', body: 'PRIVATE BODY',
    }]
    const source = makeConfiguredSkillMenuSource({
      entries,
      allowedSkillNames: null,
    })

    expect(source()).toEqual([{ name: 'inspect', summary: 'Проверить артефакты' }])
    expect(JSON.stringify(source())).not.toContain('PRIVATE BODY')
  })

  it('returns the exact body when telemetry fails and records successful loads out-of-band', async () => {
    const recorded: string[] = []
    const body = 'EXACT\r\nBODY'
    const loader = makeTelemetrySkillBodyLoader({
      loadBody: async () => body,
      telemetry: { recordLoad: name => { recorded.push(name) } },
      nowIso: () => '2026-07-28T00:00:00.000Z',
    })
    expect(await loader('inspect')).toBe(body)
    expect(recorded).toEqual(['inspect'])

    const failOpen = makeTelemetrySkillBodyLoader({
      loadBody: async () => body,
      telemetry: { recordLoad: () => { throw new Error('sidecar down') } },
    })
    expect(await failOpen('inspect')).toBe(body)
  })
})
