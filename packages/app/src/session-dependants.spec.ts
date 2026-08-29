import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeNodeSessionDependants } from './session-dependants.js'

const roots: string[] = []
const TARGET = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
}
const BINDING = { ...TARGET, scope: 'project' as const }
const NOW = '2026-08-29T20:00:00.000Z'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(input: {
  live?: number
  continuations?: typeof BINDING[]
  delegations?: typeof BINDING[]
  terminalDelegations?: string[]
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aisy-session-dependants-'))
  roots.push(root)
  const paths = {
    statePath: join(root, 'session-dependants-v1.json'),
    goalPath: join(root, 'goal.json'),
    triggersPath: join(root, 'triggers.json'),
  }
  return {
    root,
    paths,
    dependants: makeNodeSessionDependants({
      ...paths,
      nowIso: () => NOW,
      liveTurns: () => input.live ?? 0,
      continuationBindings: () => input.continuations ?? [],
      delegationBindings: () => input.delegations ?? [],
      purgeTerminalDelegations: () => input.terminalDelegations ?? [],
      disableBackgroundBindings: () => ['nightly'],
    }),
  }
}

describe('Session dependant settlement', () => {
  it.each([
    { live: 1 },
    { continuations: [BINDING] },
    { delegations: [BINDING] },
  ])('refuses a nonterminal exact Session binding before mutation', (busy) => {
    const h = setup(busy)
    expect(() => h.dependants.assertIdle(TARGET)).toThrow('SESSION_BUSY')
    expect(existsSync(h.paths.statePath)).toBe(false)
  })

  it('halts the exact goal, disables exact triggers and records one redacted reason', () => {
    const h = setup({ terminalDelegations: ['inv-' + '1'.repeat(64)] })
    writeFileSync(h.paths.goalPath, JSON.stringify({
      schemaVersion: 2,
      id: 'goal-a',
      binding: BINDING,
      status: 'active',
      objective: 'old context work',
      updatedAt: '2026-08-29T19:00:00.000Z',
    }, null, 2) + '\n')
    writeFileSync(h.paths.triggersPath, JSON.stringify([
      { id: 'trigger-a', binding: BINDING, enabled: true, prompt: 'private prompt' },
      {
        id: 'trigger-b',
        binding: { ...BINDING, sessionId: 'session-b' },
        enabled: true,
        prompt: 'survives',
      },
    ], null, 2) + '\n')
    const operationHash = 'a'.repeat(64)

    h.dependants.settle(TARGET, operationHash)
    h.dependants.settle(TARGET, operationHash)

    expect(JSON.parse(readFileSync(h.paths.goalPath, 'utf8'))).toMatchObject({
      id: 'goal-a', status: 'halted', haltReason: 'context-deleted', updatedAt: NOW,
    })
    expect(JSON.parse(readFileSync(h.paths.triggersPath, 'utf8'))).toMatchObject([
      { id: 'trigger-a', enabled: false },
      { id: 'trigger-b', enabled: true },
    ])
    const sidecar = JSON.parse(readFileSync(h.paths.statePath, 'utf8'))
    expect(sidecar).toMatchObject({
      schemaVersion: 1,
      records: [{
        operationHash,
        ...TARGET,
        goalChanged: true,
        triggerIds: ['trigger-a'],
        backgroundBindings: ['nightly'],
        terminalDelegationRunIds: ['inv-' + '1'.repeat(64)],
      }],
    })
    expect(JSON.stringify(sidecar)).not.toContain('old context work')
    expect(JSON.stringify(sidecar)).not.toContain('private prompt')
  })

  it('fails closed on a corrupt durable sidecar', () => {
    const h = setup()
    writeFileSync(h.paths.statePath, '{"schemaVersion":1,"records":"wrong"}\n')
    expect(() => makeNodeSessionDependants({
      ...h.paths,
      nowIso: () => NOW,
      liveTurns: () => 0,
      continuationBindings: () => [],
      delegationBindings: () => [],
      disableBackgroundBindings: () => [],
    })).toThrow('SESSION_DEPENDANTS_STATE_CORRUPT')
  })

  it('discards an uncommitted sidecar temp before loading durable state', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-session-dependants-'))
    roots.push(root)
    const paths = {
      statePath: join(root, 'session-dependants-v1.json'),
      goalPath: join(root, 'goal.json'),
      triggersPath: join(root, 'triggers.json'),
    }
    const orphan = `${paths.statePath}.tmp-202-00000000-0000-4000-8000-000000000202`
    writeFileSync(orphan, '{"uncommitted":"private"}\n', { mode: 0o600 })

    const dependants = makeNodeSessionDependants({
      ...paths,
      nowIso: () => NOW,
      liveTurns: () => 0,
      continuationBindings: () => [],
      delegationBindings: () => [],
    })
    expect(existsSync(orphan)).toBe(false)
    expect(() => dependants.assertIdle(TARGET)).not.toThrow()
  })
})
