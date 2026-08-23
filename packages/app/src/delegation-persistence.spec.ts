import {
  makeDelegationManager,
  type AgentCard,
  type DelegationDeps,
  type DelegationTask,
  type PlanDAG,
} from '@aisy/core'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeNodeDelegationPersistence } from './delegation-persistence.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-delegation-')))
  roots.push(root)
  return root
}

const card: AgentCard = {
  name: 'analyst',
  instructions: 'Inspect and report.',
  skills: [],
  mcpAllowlist: [],
  toolTiers: { read_file: 0 },
  maxIterations: 10,
  contextStrategy: 'compact',
  provenance: 'builtin',
}

const task: DelegationTask = {
  taskId: 'analysis',
  intent: 'inspect state',
  assignedTo: 'analyst',
  dependsOn: [],
  scope: { owns: ['src/**'], doNotTouch: [], taskClass: 'reasoning' },
  budgetSlice: { iterations: 10, spendUsd: 1 },
  outputContract: 'summary',
  retryPolicy: { maxReplans: 1, maxIterations: 10 },
}

const plan: PlanDAG = { nodes: [task], edges: [] }

function deps(runRoot: string, active = true): DelegationDeps {
  return {
    binding: {
      operatorId: 'operator-1',
      profileId: 'default',
      projectId: 'project-a',
      sessionId: 'session-a',
      scope: 'session',
    },
    resolveCard: name => name === 'analyst' ? card : undefined,
    skillTouchedPaths: () => [],
    mcpWritable: () => false,
    emit: () => {},
    persistence: makeNodeDelegationPersistence({
      runRoot,
      nowIso: () => '2026-07-27T00:00:00.000Z',
    }),
    isBindingActive: () => active,
  }
}

describe('Node delegation persistence', () => {
  it('writes ADR-0039 layout durably and resumes after a fresh process composition', () => {
    const root = tempRoot()
    const first = makeDelegationManager(plan, deps(root))
    const handle = first.spawn('analysis')
    handle.append('reasoning', { note: 'one' })
    handle.fail('restart', { iterations: 2, spendUsd: 0.2, wallMs: 50 })

    const shard = join(root, 'delegations', `${handle.delegationId}.jsonl`)
    const runState = join(root, 'run-state.json')
    const checkpoint = join(root, 'delegations', handle.delegationId, 'checkpoint.json')
    const manifest = join(root, 'delegations', handle.delegationId, 'manifest.json')
    expect(readFileSync(shard, 'utf8')).toContain('reasoning')
    expect(JSON.parse(readFileSync(checkpoint, 'utf8')).lastSeq).toBe(1)
    expect(JSON.parse(readFileSync(manifest, 'utf8')).storageSchemaVersion).toBe(1)
    expect(JSON.parse(readFileSync(runState, 'utf8')).runBudget.iterations).toBe(2)
    expect(statSync(shard).mode & 0o777).toBe(0o600)
    expect(statSync(checkpoint).mode & 0o777).toBe(0o600)
    expect(statSync(manifest).mode & 0o777).toBe(0o600)
    expect(statSync(runState).mode & 0o777).toBe(0o600)
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, 'delegations', handle.delegationId)).mode & 0o777).toBe(0o700)

    const restarted = makeDelegationManager(plan, deps(root))
    const resumed = restarted.resume(handle.delegationId)
    expect(resumed.append('reasoning', { note: 'two' }).seq).toBe(2)
    expect(restarted.runBudgetSpent()).toEqual({ iterations: 2, spendUsd: 0.2, wallMs: 50 })
  })

  it('replays a completed compact observation after a fresh process composition', () => {
    const root = tempRoot()
    const first = makeDelegationManager(plan, deps(root))
    const handle = first.spawn('analysis')
    const completed = handle.complete(
      'verified result',
      { evidenceId: 'evidence-1' },
      { iterations: 1, spendUsd: 0.1, wallMs: 10 },
    )

    const restarted = makeDelegationManager(plan, deps(root))
    expect(restarted.recover(handle.delegationId)).toEqual({
      status: 'terminal', observation: completed,
    })
    expect(() => restarted.resume(handle.delegationId)).toThrow(/already completed/)
    expect(restarted.terminalObservation(handle.delegationId)).toEqual(completed)
  })

  it('detects a torn/tampered multi-file snapshot and writes a recoverable quarantine marker', () => {
    const root = tempRoot()
    const first = makeDelegationManager(plan, deps(root))
    const handle = first.spawn('analysis')
    handle.append('reasoning', { note: 'original' })
    handle.fail('restart', { iterations: 1, spendUsd: 0, wallMs: 1 })

    const shard = join(root, 'delegations', `${handle.delegationId}.jsonl`)
    chmodSync(shard, 0o600)
    writeFileSync(shard, readFileSync(shard, 'utf8').replace('original', 'tampered'))

    const restarted = makeDelegationManager(plan, deps(root))
    expect(() => restarted.resume(handle.delegationId)).toThrow(/legacy-or-invalid-state/)
    const quarantine = join(root, 'delegations', handle.delegationId, 'quarantine.json')
    expect(JSON.parse(readFileSync(quarantine, 'utf8'))).toMatchObject({
      delegationId: handle.delegationId,
      reason: 'legacy-or-invalid-state',
    })
    expect(readFileSync(shard, 'utf8')).toContain('tampered')
  })

  it('rejects path traversal in delegation ids', () => {
    const store = makeNodeDelegationPersistence({ runRoot: tempRoot() })
    expect(() => store.load('../outside')).toThrow(/unsafe delegation id/)
  })

  it('rejects a symlinked run root without chmod or filesystem writes to its target', () => {
    const holder = tempRoot()
    const outside = tempRoot()
    const linked = join(holder, 'linked-run')
    symlinkSync(outside, linked, 'dir')
    const modeBefore = statSync(outside).mode & 0o777

    expect(() => makeNodeDelegationPersistence({ runRoot: linked })).toThrow(/private and canonical/)
    expect(statSync(outside).mode & 0o777).toBe(modeBefore)
  })

  it('does not create a missing run root during recovery inspection', () => {
    const runRoot = join(tempRoot(), 'missing-run')
    expect(() => makeNodeDelegationPersistence({
      runRoot,
      createIfMissing: false,
    })).toThrow(/root missing/)
    expect(existsSync(runRoot)).toBe(false)
  })
})
