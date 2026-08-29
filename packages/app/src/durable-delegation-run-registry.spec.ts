import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlanDAG, ResolvedWorkBinding } from '@aisy/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DurableDelegationRunRegistryError,
  makeNodeDurableDelegationRunRegistry,
} from './durable-delegation-run-registry.js'

const roots: string[] = []
const BINDING_HASH = 'a'.repeat(64)

const BINDING: ResolvedWorkBinding = {
  botId: 'bot-a',
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
}

const PLAN: PlanDAG = {
  nodes: [{
    taskId: 'review',
    intent: 'review exact state',
    assignedTo: 'reviewer',
    dependsOn: [],
    scope: { owns: ['src/**'], doNotTouch: [], taskClass: 'reasoning' },
    budgetSlice: { iterations: 5, spendUsd: 0.5 },
    outputContract: 'verified summary',
    retryPolicy: { maxReplans: 0, maxIterations: 5 },
  }],
  edges: [],
}

function stateRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-delegation-registry-')))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('durable delegation run registry', () => {
  it('registers before the run root exists, activates durably, and reopens exactly', () => {
    const root = stateRoot()
    const runRoot = join(root, `inv-${'1'.repeat(64)}`)
    const registry = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
    const registration = registry.register({
      runRoot,
      bindingHash: BINDING_HASH,
      binding: BINDING,
      plan: PLAN,
    })

    expect(registration.runRoot).toBe(runRoot)
    expect(registry.listExact(BINDING_HASH)).toEqual([expect.objectContaining({
      runId: `inv-${'1'.repeat(64)}`,
      bindingHash: BINDING_HASH,
      binding: BINDING,
      plan: PLAN,
      phase: 'registered',
    })])

    registration.activate()
    registration.activate()
    const reopened = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
    expect(reopened.list()).toEqual([expect.objectContaining({ binding: BINDING })])
    expect(reopened.listExact(BINDING_HASH)).toEqual([expect.objectContaining({
      phase: 'active',
    })])
    const record = reopened.listExact(BINDING_HASH)[0]!
    expect(reopened.runRoot(record)).toBe(runRoot)
    expect(Object.isFrozen(record.plan)).toBe(true)
    expect(Object.isFrozen(record.plan.nodes)).toBe(true)
    expect(Object.isFrozen(record.plan.nodes[0]?.scope.owns)).toBe(true)
  })

  it('is idempotent for one exact run and rejects a conflicting identity', () => {
    const root = stateRoot()
    const runRoot = join(root, `inv-${'2'.repeat(64)}`)
    const registry = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
    registry.register({ runRoot, bindingHash: BINDING_HASH, binding: BINDING, plan: PLAN })
    registry.register({ runRoot, bindingHash: BINDING_HASH, binding: BINDING, plan: PLAN })

    expect(registry.listExact(BINDING_HASH)).toHaveLength(1)
    expect(() => registry.register({
      runRoot,
      bindingHash: 'b'.repeat(64),
      binding: BINDING,
      plan: PLAN,
    })).toThrow(new DurableDelegationRunRegistryError('DELEGATION_RUN_REGISTRY_CONFLICT'))
  })

  it('retires only an activated exact record and keeps retirement idempotent', () => {
    const root = stateRoot()
    const runRoot = join(root, `inv-${'7'.repeat(64)}`)
    const registry = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
    const registration = registry.register({
      runRoot,
      bindingHash: BINDING_HASH,
      binding: BINDING,
      plan: PLAN,
    })

    expect(() => registration.retire()).toThrow(
      new DurableDelegationRunRegistryError('DELEGATION_RUN_REGISTRY_CONFLICT'),
    )
    registration.activate()
    mkdirSync(runRoot, { mode: 0o700 })
    writeFileSync(join(runRoot, 'private-output.json'), 'raw private result', { mode: 0o600 })
    registration.retire()
    registration.retire()

    expect(registry.listExact(BINDING_HASH)).toEqual([])
    expect(registry.retiredExact(BINDING)).toEqual([expect.objectContaining({
      runId: `inv-${'7'.repeat(64)}`,
      binding: BINDING,
    })])
    expect(registry.purgeRetiredExact(BINDING)).toEqual([`inv-${'7'.repeat(64)}`])
    expect(existsSync(runRoot)).toBe(false)
    expect(registry.purgeRetiredExact(BINDING)).toEqual([`inv-${'7'.repeat(64)}`])
    expect(registry.retiredExact(BINDING)).toHaveLength(1)
    expect(() => registration.activate()).toThrow(
      new DurableDelegationRunRegistryError('DELEGATION_RUN_REGISTRY_CONFLICT'),
    )
  })

  it('never discovers an unregistered directory and filters only exact binding authority', () => {
    const root = stateRoot()
    const registry = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
    const first = join(root, `inv-${'3'.repeat(64)}`)
    const foreign = join(root, `inv-${'4'.repeat(64)}`)
    registry.register({ runRoot: first, bindingHash: BINDING_HASH, binding: BINDING, plan: PLAN })
    registry.register({
      runRoot: foreign,
      bindingHash: 'f'.repeat(64),
      binding: BINDING,
      plan: PLAN,
    })

    expect(registry.listExact(BINDING_HASH).map(record => record.runId)).toEqual([
      `inv-${'3'.repeat(64)}`,
    ])
    expect(registry.listExact('e'.repeat(64))).toEqual([])
  })

  it('fails closed on checksum corruption and public registry bytes', () => {
    const root = stateRoot()
    const runRoot = join(root, `inv-${'5'.repeat(64)}`)
    const registry = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
    registry.register({ runRoot, bindingHash: BINDING_HASH, binding: BINDING, plan: PLAN })
    const path = join(root, '.run-registry-v1.json')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<{ phase: string }>
    }
    parsed.records[0]!.phase = 'active'
    writeFileSync(path, JSON.stringify(parsed), { mode: 0o600 })
    expect(() => registry.listExact(BINDING_HASH)).toThrow(
      new DurableDelegationRunRegistryError('DELEGATION_RUN_REGISTRY_STATE_INVALID'),
    )

    chmodSync(path, 0o644)
    expect(() => registry.listExact(BINDING_HASH)).toThrow(
      new DurableDelegationRunRegistryError('DELEGATION_RUN_REGISTRY_STATE_INVALID'),
    )
  })

  it('rejects a malformed plan before publishing registry authority', () => {
    const root = stateRoot()
    const registry = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
    expect(() => registry.register({
      runRoot: join(root, `inv-${'6'.repeat(64)}`),
      bindingHash: BINDING_HASH,
      binding: BINDING,
      plan: { nodes: [null], edges: [] } as never,
    })).toThrow(
      new DurableDelegationRunRegistryError('DELEGATION_RUN_REGISTRY_STATE_INVALID'),
    )
    expect(registry.listExact(BINDING_HASH)).toEqual([])
  })

  it('purges dead-writer registry temps with raw target data and preserves foreign canonical state', () => {
    const root = stateRoot()
    const targetRoot = join(root, `inv-${'8'.repeat(64)}`)
    const foreignRoot = join(root, `inv-${'9'.repeat(64)}`)
    const registry = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
    const target = registry.register({
      runRoot: targetRoot,
      bindingHash: BINDING_HASH,
      binding: BINDING,
      plan: PLAN,
    })
    target.activate()
    mkdirSync(targetRoot, { mode: 0o700 })
    writeFileSync(join(targetRoot, 'private-output.json'), 'target private output', { mode: 0o600 })
    target.retire()
    registry.register({
      runRoot: foreignRoot,
      bindingHash: 'f'.repeat(64),
      binding: { ...BINDING, sessionId: 'session-b' },
      plan: PLAN,
    })
    const orphan = join(
      root,
      '.run-registry-v1.json.tmp-202-00000000-0000-4000-8000-000000000202',
    )
    writeFileSync(orphan, JSON.stringify({ binding: BINDING, plan: PLAN }), { mode: 0o600 })

    const recovered = makeNodeDurableDelegationRunRegistry({
      stateRoot: root,
      pid: 101,
      processAlive: () => false,
    })
    expect(recovered.purgeRetiredExact(BINDING)).toEqual([`inv-${'8'.repeat(64)}`])
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(targetRoot)).toBe(false)
    expect(recovered.list()).toEqual([expect.objectContaining({
      runId: `inv-${'9'.repeat(64)}`,
      binding: expect.objectContaining({ sessionId: 'session-b' }),
    })])
  })
})
