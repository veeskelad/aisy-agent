import type { ActiveMcpAllowlist } from '@aisy/core'
import { describe, expect, it, vi } from 'vitest'
import { makeMcpProductionPreviewDoctor } from './mcp-connect-gauntlet.js'

function allowlist(names: () => string[]): Pick<ActiveMcpAllowlist, 'names'> {
  return { names }
}

describe('MCP production-preview offline configured-name projection', () => {
  it('freezes a sorted configured-name projection without claiming readiness', () => {
    const source = ['zeta', 'alpha']
    const doctor = makeMcpProductionPreviewDoctor({ allowlist: allowlist(() => source) })
    source.splice(0, source.length, 'changed-after-composition')

    const verdict = doctor.inspect()
    expect(verdict).toEqual({
      code: 'MCP_OFFLINE_NAMES_AVAILABLE',
      readyForTransportDecision: false,
      configuredServerCount: 2,
      activeServerCount: 0,
      frozenConfiguredNames: ['alpha', 'zeta'],
      transportActive: false,
    })
    expect(Object.isFrozen(verdict)).toBe(true)
    expect(Object.isFrozen(verdict.frozenConfiguredNames)).toBe(true)
    expect(doctor.inspect()).toBe(verdict)
  })

  it('sorts punctuation by exact UTF-8 bytes instead of process locale', () => {
    const verdict = makeMcpProductionPreviewDoctor({
      allowlist: allowlist(() => ['a_', 'a.', 'a-', 'a']),
    }).inspect()
    expect(verdict.frozenConfiguredNames).toEqual(['a', 'a-', 'a.', 'a_'])
  })

  it('emits only code and counts and ignores an observability failure', () => {
    const emitted: unknown[] = []
    const doctor = makeMcpProductionPreviewDoctor({
      allowlist: allowlist(() => ['tracker']),
      emit: (event) => {
        emitted.push(event)
        throw new Error('journal unavailable')
      },
    })

    expect(doctor.inspect().code).toBe('MCP_OFFLINE_NAMES_AVAILABLE')
    expect(emitted).toEqual([{
      type: 'mcp.production_preview.offline_names_projection',
      code: 'MCP_OFFLINE_NAMES_AVAILABLE',
      configuredServerCount: 1,
      activeServerCount: 0,
      transportActive: false,
    }])
    expect(JSON.stringify(emitted)).not.toMatch(/tracker|endpoint|pin|hash|token|descriptor|result/i)
  })

  it('distinguishes an empty names view from an unavailable names view', () => {
    expect(makeMcpProductionPreviewDoctor({
      allowlist: allowlist(() => []),
    }).inspect()).toMatchObject({
      code: 'MCP_OFFLINE_NAMES_EMPTY',
      readyForTransportDecision: false,
      configuredServerCount: 0,
    })

    expect(makeMcpProductionPreviewDoctor({
      allowlist: allowlist(() => { throw new Error('unavailable') }),
    }).inspect()).toMatchObject({
      code: 'MCP_OFFLINE_NAMES_UNAVAILABLE',
      readyForTransportDecision: false,
      configuredServerCount: 0,
      frozenConfiguredNames: [],
    })
  })

  it.each([
    ['non-array', () => 'tracker'],
    ['duplicate', () => ['tracker', 'tracker']],
    ['unsafe name', () => ['../tracker']],
    ['too many', () => Array.from({ length: 65 }, (_, index) => `mcp-${index}`)],
  ])('fails closed for %s names without retaining a partial projection', (_case, names) => {
    const doctor = makeMcpProductionPreviewDoctor({
      allowlist: { names: names as unknown as () => string[] },
    })
    expect(doctor.inspect()).toMatchObject({
      code: 'MCP_OFFLINE_NAMES_UNAVAILABLE',
      readyForTransportDecision: false,
      configuredServerCount: 0,
      activeServerCount: 0,
      frozenConfiguredNames: [],
      transportActive: false,
    })
  })

  it('reconstructs byte-identical state from the same names view', () => {
    const first = makeMcpProductionPreviewDoctor({
      allowlist: allowlist(() => ['healthy']),
    }).inspect()
    const reconstructed = makeMcpProductionPreviewDoctor({
      allowlist: allowlist(() => ['healthy']),
    }).inspect()
    expect(JSON.stringify(reconstructed)).toBe(JSON.stringify(first))
  })

  it.each(['index', 'iterator'] as const)(
    'maps a Proxy throwing from %s access to unavailable without leaking the exception',
    (failure) => {
      const source = new Proxy(['alpha'], {
        get(target, property, receiver) {
          if ((failure === 'index' && property === '0') ||
            (failure === 'iterator' && property === Symbol.iterator)) {
            throw new Error(`private ${failure} failure`)
          }
          return Reflect.get(target, property, receiver)
        },
      })
      const emitted: unknown[] = []
      const verdict = makeMcpProductionPreviewDoctor({
        allowlist: allowlist(() => source),
        emit: event => { emitted.push(event) },
      }).inspect()
      expect(verdict).toMatchObject({
        code: 'MCP_OFFLINE_NAMES_UNAVAILABLE',
        readyForTransportDecision: false,
        configuredServerCount: 0,
        frozenConfiguredNames: [],
      })
      expect(JSON.stringify(emitted)).not.toContain('private')
    },
  )

  it('depends only on names and exposes no transport or persistence operation', () => {
    const names = vi.fn(() => ['tracker'])
    const forbidden = {
      snapshot: vi.fn(), quarantine: vi.fn(), connect: vi.fn(),
      spawn: vi.fn(), call: vi.fn(), invoke: vi.fn(),
    }
    const doctor = makeMcpProductionPreviewDoctor({
      allowlist: { names, ...forbidden } as Pick<ActiveMcpAllowlist, 'names'>,
    })

    expect(doctor.inspect().transportActive).toBe(false)
    expect(names).toHaveBeenCalledTimes(1)
    for (const spy of Object.values(forbidden)) expect(spy).not.toHaveBeenCalled()
    expect(Object.keys(doctor)).toEqual(['inspect'])
  })
})
