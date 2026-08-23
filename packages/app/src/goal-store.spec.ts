import { describe, it, expect } from 'vitest'
import { makeGoalStore } from './goal-store.js'
import type { GoalSpec } from '@aisy/core'

const BINDING = {
  operatorId: 'operator-1',
  profileId: 'default',
  projectId: 'project-1',
  sessionId: 'system-session-1',
  scope: 'project' as const,
}

function makeMemoryDeps(initial?: string) {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set('/test/goal.json', initial)
  return {
    path: '/test/goal.json',
    readFile: (p: string) => {
      const v = store.get(p)
      if (v === undefined) throw new Error(`not found: ${p}`)
      return v
    },
    writeFile: (p: string, c: string) => { store.set(p, c) },
    exists: (p: string) => store.has(p),
    removeFile: (p: string) => { store.delete(p) },
  }
}

function makeSpec(extra?: Partial<GoalSpec>): GoalSpec {
  return {
    id: 'goal-1',
    objective: 'Keep inbox at zero',
    mode: { kind: 'until' },
    backstop: { maxIterations: 10, tokenCeiling: 50_000, dollarCeiling: 1 },
    grantedScope: [],
    status: 'active',
    iterationsSpent: 0,
    usageSpent: { inputTokens: 0, outputTokens: 0, dollars: 0 },
    createdAt: '2026-06-23T00:00:00.000Z',
    updatedAt: '2026-06-23T00:00:00.000Z',
    ...extra,
    schemaVersion: 2,
    binding: extra?.binding ?? BINDING,
  }
}

describe('makeGoalStore', () => {
  it('save then load returns the spec when status is active', async () => {
    const deps = makeMemoryDeps()
    const gs = makeGoalStore(deps)
    const spec = makeSpec()
    await gs.save(spec)
    const loaded = await gs.load()
    expect(loaded).toEqual(spec)
  })

  it('load returns null when file is absent', async () => {
    const deps = makeMemoryDeps()
    const gs = makeGoalStore(deps)
    expect(await gs.load()).toBeNull()
  })

  it('load returns null when stored spec has status !== active (completed)', async () => {
    const deps = makeMemoryDeps()
    const gs = makeGoalStore(deps)
    await gs.save(makeSpec({ status: 'completed' }))
    expect(await gs.load()).toBeNull()
  })

  it('load returns null when stored spec has status !== active (halted)', async () => {
    const deps = makeMemoryDeps()
    const gs = makeGoalStore(deps)
    await gs.save(makeSpec({ status: 'halted' }))
    expect(await gs.load()).toBeNull()
  })

  it('clear via removeFile → subsequent load is null', async () => {
    const deps = makeMemoryDeps()
    const gs = makeGoalStore(deps)
    await gs.save(makeSpec())
    expect(await gs.load()).not.toBeNull()
    await gs.clear()
    expect(await gs.load()).toBeNull()
  })

  it('clear without removeFile writes null → subsequent load is null', async () => {
    const { removeFile: _removed, ...deps } = makeMemoryDeps()
    const gs = makeGoalStore(deps)
    await gs.save(makeSpec())
    await gs.clear()
    expect(await gs.load()).toBeNull()
  })

  it('mode.kind==="until" + probe round-trips', async () => {
    const deps = makeMemoryDeps()
    const gs = makeGoalStore(deps)
    const spec = makeSpec({
      mode: {
        kind: 'until',
        probe: { kind: 'exit', argv: ['pnpm', 'test'], expectCode: 0 },
      },
    })
    await gs.save(spec)
    const loaded = await gs.load()
    expect(loaded?.mode).toEqual(spec.mode)
  })

  it('mode.kind==="budget" round-trips', async () => {
    const deps = makeMemoryDeps()
    const gs = makeGoalStore(deps)
    const spec = makeSpec({
      mode: { kind: 'budget', tokenCeiling: 10_000, dollarCeiling: 0.5 },
    })
    await gs.save(spec)
    const loaded = await gs.load()
    expect(loaded?.mode).toEqual(spec.mode)
  })

  it('quarantines an active legacy goal without binding instead of executing or deleting it', async () => {
    const legacy = {
      id: 'legacy-goal',
      objective: 'legacy objective',
      mode: { kind: 'until' },
      backstop: { maxIterations: 1, tokenCeiling: 100, dollarCeiling: 1 },
      grantedScope: [],
      status: 'active',
      iterationsSpent: 0,
      usageSpent: { inputTokens: 0, outputTokens: 0, dollars: 0 },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const deps = makeMemoryDeps(JSON.stringify(legacy))
    const store = makeGoalStore(deps)

    expect(await store.load()).toBeNull()
    expect(await store.loadQuarantined()).toMatchObject({
      id: 'legacy-goal',
      status: 'paused',
      haltReason: 'unbound-context',
      quarantineReason: 'missing-or-invalid-work-binding',
    })
  })

  it('rejects a new schema-v2 goal whose binding is unresolved', async () => {
    const deps = makeMemoryDeps()
    const store = makeGoalStore(deps)
    const invalid = {
      ...makeSpec(),
      binding: { ...BINDING, sessionId: undefined },
    } as unknown as GoalSpec

    await expect(store.save(invalid)).rejects.toThrow('INVALID_GOAL_SPEC')
  })
})
