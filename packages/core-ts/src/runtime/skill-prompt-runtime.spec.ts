import { describe, expect, it, vi } from 'vitest'
import { makeSkillPromptRuntime } from './skill-prompt-runtime.js'

describe('makeSkillPromptRuntime', () => {
  it('keeps only sorted menu lines in the frozen prefix', () => {
    const runtime = makeSkillPromptRuntime({
      menu: () => [
        { name: 'zeta', description: 'Z' },
        { name: 'alpha', description: 'A' },
      ],
      matchTriggers: () => [],
      loadBody: async () => '',
    })
    const text = new TextDecoder().decode(runtime.prefixExtension())
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('zeta'))
    expect(text).not.toContain('secret body')
  })

  it('loads only deterministically matched bodies into working context', async () => {
    const loadBody = vi.fn(async (name: string) => `${name} body`)
    const runtime = makeSkillPromptRuntime({
      menu: () => [{ name: 'deploy', description: 'Deploy' }],
      matchTriggers: request => request.includes('deploy') ? ['deploy'] : [],
      loadBody,
    })
    expect(await runtime.augmentTurn({
      sessionId: 's1',
      spans: [{ role: 'user', provenance: 'operator', text: 'just answer' }],
    })).toEqual([])
    expect(loadBody).not.toHaveBeenCalled()

    const spans = await runtime.augmentTurn({
      sessionId: 's1',
      spans: [{ role: 'user', provenance: 'operator', text: 'deploy it' }],
    })
    expect(spans).toEqual([{ role: 'system', provenance: 'operator', text: '[Навык: deploy]\ndeploy body' }])
  })
})
