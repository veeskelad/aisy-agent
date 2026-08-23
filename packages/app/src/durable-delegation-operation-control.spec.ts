import { chmodSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import {
  DurableDelegationOperationControlError,
  assertDurableDelegationBoundOperationControlAttestationV1,
  deriveDurableDelegationOperationControlScopeHashesV1,
  makeDurableDelegationOperationResolutionAuthorityV1,
  makeNodeDurableDelegationOperationControlV1,
  type DurableDelegationLogicalOperationV2,
  type DurableDelegationOperationControlBindingV1,
  type DurableDelegationOperationControlV1,
  type DurableDelegationOperationReceiptEvidenceV1,
} from './durable-delegation-operation-control.js'

const hash = (character: string): string => character.repeat(64)
const INSTALLATION = hash('a')
const AUTHORITY = hash('b')
const POLICY = 'policy-2026-08-10'
const DAILY_EPOCH = '2026-08-10'
const PREPARED = hash('c')

const roots: string[] = []
const controls: DurableDelegationOperationControlV1[] = []

function privateRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aisy-operation-control-')))
  chmodSync(root, 0o700)
  roots.push(root)
  return root
}

function control(root = privateRoot()): DurableDelegationOperationControlV1 {
  const instance = makeNodeDurableDelegationOperationControlV1({
    root,
    installationHash: INSTALLATION,
    policyRevision: POLICY,
    dailyEpoch: DAILY_EPOCH,
  })
  controls.push(instance)
  return instance
}

type Scope = 'task' | 'run' | 'global' | 'daily'

function binding(input: Readonly<{
  taskId?: string
  delegationId?: string
  runRootHash?: string
  bindingHash?: string
  scopeHashes?: Partial<Record<Scope, string>>
  limits?: Partial<Record<Scope, Readonly<{ iterations: number | null; spend: number | null }>>>
}> = {}): DurableDelegationOperationControlBindingV1 {
  const runRootHash = input.runRootHash ?? hash('1')
  const bindingHash = input.bindingHash ?? hash('2')
  const taskId = input.taskId ?? 'task-1'
  const canonicalScopes = deriveDurableDelegationOperationControlScopeHashesV1({
    installationHash: INSTALLATION,
    runRootHash,
    bindingHash,
    taskId,
    dailyEpoch: DAILY_EPOCH,
  })
  const limit = (scope: Scope) => input.limits?.[scope] ?? { iterations: 100, spend: 1_000 }
  return {
    schemaVersion: 1,
    runRootHash,
    bindingHash,
    delegationId: input.delegationId ?? 'delegation-1',
    taskId,
    authorityHash: AUTHORITY,
    policyRevision: POLICY,
    ceilings: {
      task: {
        scopeHash: input.scopeHashes?.task ?? canonicalScopes.task,
        maximumIterations: limit('task').iterations,
        maximumSpendUsdNanos: limit('task').spend,
      },
      run: {
        scopeHash: input.scopeHashes?.run ?? canonicalScopes.run,
        maximumIterations: limit('run').iterations,
        maximumSpendUsdNanos: limit('run').spend,
      },
      global: {
        scopeHash: input.scopeHashes?.global ?? canonicalScopes.global,
        maximumIterations: limit('global').iterations,
        maximumSpendUsdNanos: limit('global').spend,
      },
      daily: {
        scopeHash: input.scopeHashes?.daily ?? canonicalScopes.daily,
        maximumIterations: limit('daily').iterations,
        maximumSpendUsdNanos: limit('daily').spend,
        dailyEpoch: DAILY_EPOCH,
      },
    },
  }
}

function operation(input: Readonly<{
  sequence?: number
  phase?: 'provider' | 'tool'
  ordinal?: number
  requestHash?: string
  iterations?: number
  spend?: number
  retryClass?: 'retry-once' | 'new-task-only'
}> = {}): DurableDelegationLogicalOperationV2 {
  return {
    schemaVersion: 2,
    sequence: input.sequence ?? 1,
    phase: input.phase ?? 'provider',
    ordinal: input.ordinal ?? 1,
    canonicalRequestHash: input.requestHash ?? hash('7'),
    authorityHash: AUTHORITY,
    policyRevision: POLICY,
    retryClass: input.retryClass ?? 'retry-once',
    maximumCharge: {
      iterations: input.iterations ?? 6,
      spendUsdNanos: input.spend ?? 60,
    },
  }
}

function receipt(input: Partial<DurableDelegationOperationReceiptEvidenceV1> = {}):
DurableDelegationOperationReceiptEvidenceV1 {
  return {
    receiptHash: input.receiptHash ?? hash('8'),
    resultHash: input.resultHash ?? hash('9'),
    iterations: input.iterations ?? 4,
    spendUsdNanos: input.spendUsdNanos ?? 40,
    wallMs: input.wallMs ?? 50,
    effect: input.effect ?? 'read',
    ...(input.evidenceHash === undefined ? {} : { evidenceHash: input.evidenceHash }),
    ...(input.actionStatus === undefined ? {} : { actionStatus: input.actionStatus }),
    outcome: input.outcome ?? 'completed',
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(DurableDelegationOperationControlError)
    expect((error as DurableDelegationOperationControlError).code).toBe(code)
  }
}

afterEach(() => {
  for (const instance of controls.splice(0)) instance.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('durable delegation operation control', () => {
  it('attests the exact bound task and rejects copies, proxies, and controller drift', () => {
    const manager = control()
    const taskBinding = binding()
    const first = manager.bindTask(taskBinding)
    const attestation = manager.attestBoundTask(first)
    const captured = assertDurableDelegationBoundOperationControlAttestationV1(
      first,
      attestation,
    )

    expect(captured).toEqual(taskBinding)
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(captured.ceilings)).toBe(true)
    for (const scope of ['task', 'run', 'global', 'daily'] as const) {
      expect(Object.isFrozen(captured.ceilings[scope])).toBe(true)
    }
    expectCode(() => assertDurableDelegationBoundOperationControlAttestationV1(
      { ...first } as never,
      attestation,
    ), 'DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
    expectCode(() => assertDurableDelegationBoundOperationControlAttestationV1(
      new Proxy(first, {}) as never,
      attestation,
    ), 'DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
    expectCode(() => assertDurableDelegationBoundOperationControlAttestationV1(
      first,
      { ...attestation } as never,
    ), 'DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')

    const second = manager.bindTask(binding({
      taskId: 'task-2',
      delegationId: 'delegation-2',
      bindingHash: hash('d'),
    }))
    expectCode(() => assertDurableDelegationBoundOperationControlAttestationV1(
      second,
      attestation,
    ), 'DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')

    const otherManager = control()
    const otherBound = otherManager.bindTask(taskBinding)
    expectCode(() => manager.attestBoundTask(otherBound),
      'DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
    expectCode(() => assertDurableDelegationBoundOperationControlAttestationV1(
      otherBound,
      attestation,
    ), 'DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
  })

  it('invalidates bound-control attestations when their controller closes', () => {
    const manager = control()
    const bound = manager.bindTask(binding())
    const attestation = manager.attestBoundTask(bound)
    manager.close()
    controls.splice(controls.indexOf(manager), 1)

    expectCode(() => assertDurableDelegationBoundOperationControlAttestationV1(
      bound,
      attestation,
    ), 'DELEGATION_OPERATION_CONTROL_STATE_UNAVAILABLE')
    expectCode(() => manager.attestBoundTask(bound),
      'DELEGATION_OPERATION_CONTROL_STATE_UNAVAILABLE')
  })

  it('owns an exact ordered inventory and replays the same logical request', () => {
    const task = control().bindTask(binding())
    const first = task.expect(operation())
    const replay = task.expect(operation())

    expect(first.disposition).toBe('created')
    expect(replay.disposition).toBe('replayed')
    expect(replay.slot.logicalSlotHash).toBe(first.slot.logicalSlotHash)
    expect(replay.attempt.attemptKeyHash).toBe(first.attempt.attemptKeyHash)
    expect(task.snapshot()).toMatchObject({ state: 'open', sequenceLength: 1 })
    expect(task.readCost()).toEqual({ iterations: 6, spendUsdNanos: 60, wallMs: 0 })
    expect(Object.isFrozen(task.snapshot().slots)).toBe(true)
  })

  it.each<Scope>(['task', 'run', 'global', 'daily'])(
    'denies the next hold at the exact %s ceiling before creating a slot',
    scope => {
      const limits = { [scope]: { iterations: 10, spend: 100 } }
      const task = control().bindTask(binding({ limits }))
      task.expect(operation())

      expectCode(() => task.expect(operation({
        sequence: 2,
        ordinal: 2,
        requestHash: hash('d'),
      })), 'DELEGATION_OPERATION_CONTROL_BUDGET_DENIED')
      expect(task.snapshot().sequenceLength).toBe(1)
    },
  )

  it('enforces shared global and daily ceilings atomically across tasks', () => {
    const manager = control()
    const limits = {
      global: { iterations: 10, spend: 100 },
      daily: { iterations: 10, spend: 100 },
    }
    const first = manager.bindTask(binding({ limits }))
    const second = manager.bindTask(binding({
      taskId: 'task-2',
      delegationId: 'delegation-2',
      runRootHash: hash('d'),
      bindingHash: hash('e'),
      limits,
    }))
    first.expect(operation())

    expectCode(
      () => second.expect(operation()),
      'DELEGATION_OPERATION_CONTROL_BUDGET_DENIED',
    )
    expect(second.snapshot().sequenceLength).toBe(0)
  })

  it('replaces a hold with charged cost and admits the exact remaining budget', () => {
    const task = control().bindTask(binding({
      limits: { task: { iterations: 10, spend: 100 } },
    }))
    const first = task.expect(operation())
    task.markPrepared({
      logicalSlotHash: first.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    task.reconcileSettled({
      logicalSlotHash: first.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
      receipt: receipt(),
    })
    expect(task.expect(operation({
      sequence: 2,
      ordinal: 2,
      requestHash: hash('d'),
    })).disposition).toBe('created')
    expect(task.readCost()).toEqual({ iterations: 10, spendUsdNanos: 100, wallMs: 50 })
    expectCode(() => task.expect(operation({
      sequence: 3,
      ordinal: 3,
      requestHash: hash('e'),
      iterations: 1,
      spend: 1,
    })), 'DELEGATION_OPERATION_CONTROL_BUDGET_DENIED')
  })

  it('fails closed on sequence, ordinal, request, policy, and v1 operation drift', () => {
    const task = control().bindTask(binding())
    task.expect(operation())

    expectCode(() => task.expect(operation({ requestHash: hash('d') })),
      'DELEGATION_OPERATION_CONTROL_SEQUENCE_DRIFT')
    expectCode(() => task.expect(operation({ iterations: 7 })),
      'DELEGATION_OPERATION_CONTROL_SEQUENCE_DRIFT')
    expectCode(() => task.expect(operation({ sequence: 3, ordinal: 2, requestHash: hash('d') })),
      'DELEGATION_OPERATION_CONTROL_SEQUENCE_DRIFT')
    expectCode(() => task.expect({ ...operation({ sequence: 2, ordinal: 3 }), schemaVersion: 1 } as never),
      'DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
    expectCode(() => task.expect(new Proxy(operation({ sequence: 2, ordinal: 2 }), {}) as never),
      'DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
  })

  it('survives restart with the active hold and marks a prepared crash ambiguous', () => {
    const root = privateRoot()
    const firstControl = control(root)
    const task = firstControl.bindTask(binding())
    const expected = task.expect(operation())
    task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    firstControl.close()
    controls.splice(controls.indexOf(firstControl), 1)

    const resumed = control(root).bindTask(binding())
    const snapshot = resumed.snapshot()
    expect(snapshot.state).toBe('open')
    expect(snapshot.slots[0]?.attempts[0]).toMatchObject({
      budgetState: 'held',
      preparedHash: PREPARED,
      ambiguous: true,
    })
    expect(resumed.readCost()).toEqual({ iterations: 6, spendUsdNanos: 60, wallMs: 0 })
  })

  it('opens read-only and recovers interrupted state only after the exact task binds', () => {
    const root = privateRoot()
    const taskBinding = binding()
    const first = control(root)
    const task = first.bindTask(taskBinding)
    const expected = task.expect(operation())
    task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    first.close()
    controls.splice(controls.indexOf(first), 1)

    const wrong = control(root)
    expectCode(() => wrong.bindTask({ ...taskBinding, authorityHash: hash('d') }),
      'DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
    wrong.close()
    controls.splice(controls.indexOf(wrong), 1)
    const database = new Database(join(root, 'durable-delegation-operation-control.sqlite3'), {
      readonly: true,
    })
    expect(database.prepare('SELECT ambiguous FROM operation_attempts').pluck().get()).toBe(0)
    database.close()

    const resumed = control(root).bindTask(taskBinding)
    expect(resumed.snapshot().slots[0]?.attempts[0]?.ambiguous).toBe(true)
  })

  it('requires one durable pre-dispatch intent and refuses structural receipt shortcuts', () => {
    const task = control().bindTask(binding())
    const expected = task.expect(operation())
    expectCode(() => task.reconcileSettled({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
      receipt: receipt(),
    }), 'DELEGATION_OPERATION_CONTROL_ATTEMPT_DENIED')
    task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    expectCode(() => task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    }), 'DELEGATION_OPERATION_CONTROL_ATTEMPT_DENIED')
  })

  it('reconciles a receipt exactly once and persists charged actual cost', () => {
    const root = privateRoot()
    const firstControl = control(root)
    const task = firstControl.bindTask(binding())
    const expected = task.expect(operation())
    task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    const settled = task.reconcileSettled({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
      receipt: receipt(),
    })
    expect(settled.budgetState).toBe('charged')
    expect(task.readCost()).toEqual({ iterations: 4, spendUsdNanos: 40, wallMs: 50 })
    expect(task.reconcileSettled({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
      receipt: receipt(),
    })).toEqual(settled)
    firstControl.close()
    controls.splice(controls.indexOf(firstControl), 1)

    const resumed = control(root).bindTask(binding())
    expect(resumed.readCost()).toEqual({ iterations: 4, spendUsdNanos: 40, wallMs: 50 })
    expectCode(() => resumed.reconcileSettled({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
      receipt: receipt({ receiptHash: hash('d') }),
    }), 'DELEGATION_OPERATION_CONTROL_ATTEMPT_DENIED')
  })

  it('keeps overrun evidence and refuses to seal it as a successful task', () => {
    const task = control().bindTask(binding())
    const expected = task.expect(operation())
    task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    expect(task.reconcileSettled({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
      receipt: receipt({ iterations: 7, spendUsdNanos: 61 }),
    }).budgetState).toBe('overrun')
    expect(task.readCost()).toEqual({ iterations: 7, spendUsdNanos: 61, wallMs: 50 })
    expectCode(() => task.seal({ expectedLength: 1, candidateHash: hash('d') }),
      'DELEGATION_OPERATION_CONTROL_SEAL_DENIED')
  })

  it('uses a genuine one-shot resolution authority for a single retry', () => {
    const taskBinding = binding()
    const task = control().bindTask(taskBinding)
    const expected = task.expect(operation())
    task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    task.markAmbiguous({ logicalSlotHash: expected.slot.logicalSlotHash, attempt: 1 })
    const authority = makeDurableDelegationOperationResolutionAuthorityV1({
      runRootHash: taskBinding.runRootHash,
      taskId: taskBinding.taskId,
      logicalSlotHash: expected.slot.logicalSlotHash,
      ambiguousAttempt: 1,
      decision: 'retry-once',
      resolutionHash: hash('d'),
    })
    const resolved = task.resolve(authority)
    expect(resolved.attempt).toMatchObject({ attempt: 2, budgetState: 'held' })
    expect(task.readCost()).toEqual({ iterations: 12, spendUsdNanos: 120, wallMs: 0 })
    expectCode(() => task.resolve(authority), 'DELEGATION_OPERATION_CONTROL_RESOLUTION_DENIED')
    expectCode(() => task.resolve({ ...authority } as never),
      'DELEGATION_OPERATION_CONTROL_RESOLUTION_DENIED')

    task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 2,
      preparedHash: hash('e'),
    })
    expect(task.snapshot().slots[0]?.resolution?.consumed).toBe(true)
    task.markAmbiguous({ logicalSlotHash: expected.slot.logicalSlotHash, attempt: 2 })
    const thirdAttempt = makeDurableDelegationOperationResolutionAuthorityV1({
      runRootHash: taskBinding.runRootHash,
      taskId: taskBinding.taskId,
      logicalSlotHash: expected.slot.logicalSlotHash,
      ambiguousAttempt: 2,
      decision: 'retry-once',
      resolutionHash: hash('f'),
    })
    expectCode(() => task.resolve(thirdAttempt),
      'DELEGATION_OPERATION_CONTROL_RESOLUTION_DENIED')
  })

  it('does not consume resolution authority when retry budget admission fails', () => {
    const taskBinding = binding({
      limits: { task: { iterations: 10, spend: 100 } },
    })
    const task = control().bindTask(taskBinding)
    const expected = task.expect(operation())
    task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    task.markAmbiguous({ logicalSlotHash: expected.slot.logicalSlotHash, attempt: 1 })
    const authority = makeDurableDelegationOperationResolutionAuthorityV1({
      runRootHash: taskBinding.runRootHash,
      taskId: taskBinding.taskId,
      logicalSlotHash: expected.slot.logicalSlotHash,
      ambiguousAttempt: 1,
      decision: 'retry-once',
      resolutionHash: hash('d'),
    })

    expectCode(() => task.resolve(authority), 'DELEGATION_OPERATION_CONTROL_BUDGET_DENIED')
    expectCode(() => task.resolve(authority), 'DELEGATION_OPERATION_CONTROL_BUDGET_DENIED')
    expect(task.snapshot().slots[0]?.attempts).toHaveLength(1)
  })

  it('recovers an interrupted second attempt without granting attempt three', () => {
    const root = privateRoot()
    const taskBinding = binding()
    const firstControl = control(root)
    const task = firstControl.bindTask(taskBinding)
    const expected = task.expect(operation())
    task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    task.markAmbiguous({ logicalSlotHash: expected.slot.logicalSlotHash, attempt: 1 })
    task.resolve(makeDurableDelegationOperationResolutionAuthorityV1({
      runRootHash: taskBinding.runRootHash,
      taskId: taskBinding.taskId,
      logicalSlotHash: expected.slot.logicalSlotHash,
      ambiguousAttempt: 1,
      decision: 'retry-once',
      resolutionHash: hash('d'),
    }))
    task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 2,
      preparedHash: hash('e'),
    })
    firstControl.close()
    controls.splice(controls.indexOf(firstControl), 1)

    const resumed = control(root).bindTask(taskBinding)
    expect(resumed.snapshot().slots[0]).toMatchObject({
      resolution: { decision: 'retry-once', consumed: true },
      attempts: [
        { attempt: 1, ambiguous: true, budgetState: 'held' },
        { attempt: 2, ambiguous: true, budgetState: 'held' },
      ],
    })
    const thirdAttempt = makeDurableDelegationOperationResolutionAuthorityV1({
      runRootHash: taskBinding.runRootHash,
      taskId: taskBinding.taskId,
      logicalSlotHash: expected.slot.logicalSlotHash,
      ambiguousAttempt: 2,
      decision: 'retry-once',
      resolutionHash: hash('f'),
    })
    expectCode(() => resumed.resolve(thirdAttempt),
      'DELEGATION_OPERATION_CONTROL_RESOLUTION_DENIED')
    const cancelled = resumed.resolve(makeDurableDelegationOperationResolutionAuthorityV1({
      runRootHash: taskBinding.runRootHash,
      taskId: taskBinding.taskId,
      logicalSlotHash: expected.slot.logicalSlotHash,
      ambiguousAttempt: 2,
      decision: 'cancel',
      resolutionHash: hash('1'),
    }))
    expect(cancelled.attempt).toMatchObject({ attempt: 2, budgetState: 'conservative' })
    expect(resumed.snapshot().slots[0]).toMatchObject({
      resolution: { decision: 'cancel', resolutionHash: hash('1'), consumed: true },
      attempts: [
        { attempt: 1, resolutionHash: hash('0') },
        { attempt: 2, resolutionHash: hash('d') },
      ],
    })
  })

  it('keeps a sealed retry immutable when a late first-attempt receipt arrives', () => {
    const root = privateRoot()
    const taskBinding = binding()
    const first = control(root)
    const task = first.bindTask(taskBinding)
    const expected = task.expect(operation())
    task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    task.markAmbiguous({ logicalSlotHash: expected.slot.logicalSlotHash, attempt: 1 })
    task.resolve(makeDurableDelegationOperationResolutionAuthorityV1({
      runRootHash: taskBinding.runRootHash,
      taskId: taskBinding.taskId,
      logicalSlotHash: expected.slot.logicalSlotHash,
      ambiguousAttempt: 1,
      decision: 'retry-once',
      resolutionHash: hash('d'),
    }))
    task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 2,
      preparedHash: hash('e'),
    })
    task.reconcileSettled({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 2,
      preparedHash: hash('e'),
      receipt: receipt(),
    })
    const sealed = task.seal({ expectedLength: 1, candidateHash: hash('f') })
    const cost = task.readCost()

    expectCode(() => task.reconcileSettled({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
      receipt: receipt({ receiptHash: hash('d'), iterations: 1, spendUsdNanos: 1 }),
    }), 'DELEGATION_OPERATION_CONTROL_SEAL_DENIED')
    expect(task.snapshot()).toEqual(sealed)
    expect(task.readCost()).toEqual(cost)
    first.close()
    controls.splice(controls.indexOf(first), 1)
    const resumed = control(root).bindTask(taskBinding)
    expect(resumed.snapshot()).toEqual(sealed)
    expect(resumed.readCost()).toEqual(cost)
  })

  it('converts a cancelled ambiguous attempt into a permanent conservative charge', () => {
    const taskBinding = binding()
    const task = control().bindTask(taskBinding)
    const expected = task.expect(operation())
    task.markPrepared({
      logicalSlotHash: expected.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    task.markAmbiguous({ logicalSlotHash: expected.slot.logicalSlotHash, attempt: 1 })
    const cancelled = task.resolve(makeDurableDelegationOperationResolutionAuthorityV1({
      runRootHash: taskBinding.runRootHash,
      taskId: taskBinding.taskId,
      logicalSlotHash: expected.slot.logicalSlotHash,
      ambiguousAttempt: 1,
      decision: 'cancel',
      resolutionHash: hash('d'),
    }))

    expect(cancelled.attempt.budgetState).toBe('conservative')
    expect(task.readCost()).toEqual({ iterations: 6, spendUsdNanos: 60, wallMs: 0 })
    expectCode(() => task.seal({ expectedLength: 1, candidateHash: hash('e') }),
      'DELEGATION_OPERATION_CONTROL_SEAL_DENIED')
  })

  it('seals only completed evidence and verified tool mutations', () => {
    const task = control().bindTask(binding())
    const provider = task.expect(operation())
    task.markPrepared({
      logicalSlotHash: provider.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    task.reconcileSettled({
      logicalSlotHash: provider.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
      receipt: receipt(),
    })
    const tool = task.expect(operation({
      sequence: 2,
      phase: 'tool',
      ordinal: 7,
      requestHash: hash('d'),
    }))
    task.markPrepared({
      logicalSlotHash: tool.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: hash('e'),
    })
    task.reconcileSettled({
      logicalSlotHash: tool.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: hash('e'),
      receipt: receipt({
        receiptHash: hash('f'),
        resultHash: hash('0'),
        effect: 'mutation',
        evidenceHash: hash('1'),
        actionStatus: 'verified',
      }),
    })
    const sealed = task.seal({ expectedLength: 2, candidateHash: hash('2') })
    expect(sealed).toMatchObject({ state: 'sealed', candidateHash: hash('2') })
    expect(task.evidence()).toHaveLength(2)
    expectCode(() => task.expect(operation({ sequence: 3, ordinal: 2 })),
      'DELEGATION_OPERATION_CONTROL_SEQUENCE_DRIFT')
  })

  it('refuses unverified or evidence-free tool completion', () => {
    const task = control().bindTask(binding())
    const tool = task.expect(operation({ phase: 'tool', ordinal: 10 }))
    task.markPrepared({
      logicalSlotHash: tool.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    task.reconcileSettled({
      logicalSlotHash: tool.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
      receipt: receipt({ effect: 'mutation', actionStatus: 'unverified' }),
    })
    expectCode(() => task.seal({ expectedLength: 1, candidateHash: hash('d') }),
      'DELEGATION_OPERATION_CONTROL_SEAL_DENIED')
  })

  it('does not seal an empty or tool-only inventory', () => {
    const manager = control()
    const empty = manager.bindTask(binding())
    expectCode(() => empty.seal({ expectedLength: 0, candidateHash: hash('d') }),
      'DELEGATION_OPERATION_CONTROL_SEAL_DENIED')

    const toolOnly = manager.bindTask(binding({
      taskId: 'task-2',
      delegationId: 'delegation-2',
      runRootHash: hash('d'),
      bindingHash: hash('e'),
    }))
    const tool = toolOnly.expect(operation({ phase: 'tool' }))
    toolOnly.markPrepared({
      logicalSlotHash: tool.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
    })
    toolOnly.reconcileSettled({
      logicalSlotHash: tool.slot.logicalSlotHash,
      attempt: 1,
      preparedHash: PREPARED,
      receipt: receipt({ actionStatus: 'verified' }),
    })
    expectCode(() => toolOnly.seal({ expectedLength: 1, candidateHash: hash('1') }),
      'DELEGATION_OPERATION_CONTROL_SEAL_DENIED')
  })

  it('holds a singleton writer lease and rejects unsafe roots and binding drift', () => {
    const root = privateRoot()
    const first = control(root)
    expectCode(() => makeNodeDurableDelegationOperationControlV1({
      root,
      installationHash: INSTALLATION,
      policyRevision: POLICY,
      dailyEpoch: DAILY_EPOCH,
    }), 'DELEGATION_OPERATION_CONTROL_WRITER_BUSY')
    first.bindTask(binding())
    expectCode(() => first.bindTask({ ...binding(), bindingHash: hash('d') }),
      'DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')

    const unsafe = privateRoot()
    chmodSync(unsafe, 0o755)
    expectCode(() => makeNodeDurableDelegationOperationControlV1({
      root: unsafe,
      installationHash: INSTALLATION,
      policyRevision: POLICY,
      dailyEpoch: DAILY_EPOCH,
    }), 'DELEGATION_OPERATION_CONTROL_ROOT_UNSAFE')
  })

  it('derives scope identities and denies caller-controlled budget resets', () => {
    const manager = control()
    manager.bindTask(binding())
    expectCode(() => manager.bindTask(binding({
      taskId: 'task-2',
      delegationId: 'delegation-2',
      bindingHash: hash('d'),
      scopeHashes: { global: hash('f') },
    })), 'DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')

    const nextDay = '2026-08-11'
    const nextDayScopes = deriveDurableDelegationOperationControlScopeHashesV1({
      installationHash: INSTALLATION,
      runRootHash: hash('1'),
      bindingHash: hash('e'),
      taskId: 'task-3',
      dailyEpoch: nextDay,
    })
    const rotated = binding({
      taskId: 'task-3',
      delegationId: 'delegation-3',
      bindingHash: hash('e'),
    })
    expectCode(() => manager.bindTask({
      ...rotated,
      ceilings: {
        ...rotated.ceilings,
        daily: {
          ...rotated.ceilings.daily,
          scopeHash: nextDayScopes.daily,
          dailyEpoch: nextDay,
        },
      },
    }), 'DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
  })

  it('fails closed when persisted rows are modified outside the ledger', () => {
    const root = privateRoot()
    const first = control(root)
    first.bindTask(binding()).expect(operation())
    first.close()
    controls.splice(controls.indexOf(first), 1)

    const database = new Database(join(root, 'durable-delegation-operation-control.sqlite3'))
    database.prepare('UPDATE operation_attempts SET maximum_iterations = 5').run()
    database.close()

    expectCode(() => makeNodeDurableDelegationOperationControlV1({
      root,
      installationHash: INSTALLATION,
      policyRevision: POLICY,
      dailyEpoch: DAILY_EPOCH,
    }), 'DELEGATION_OPERATION_CONTROL_STATE_CORRUPT')
  })

  it('rejects unsafe SQLite sidecars and extra schema objects', () => {
    const sidecarRoot = privateRoot()
    const sidecar = control(sidecarRoot)
    sidecar.close()
    controls.splice(controls.indexOf(sidecar), 1)
    const sidecarPath = join(
      sidecarRoot,
      'durable-delegation-operation-control.sqlite3-wal',
    )
    writeFileSync(sidecarPath, '', { mode: 0o600 })
    expectCode(() => makeNodeDurableDelegationOperationControlV1({
      root: sidecarRoot,
      installationHash: INSTALLATION,
      policyRevision: POLICY,
      dailyEpoch: DAILY_EPOCH,
    }), 'DELEGATION_OPERATION_CONTROL_STATE_CORRUPT')
    unlinkSync(sidecarPath)

    const schemaRoot = privateRoot()
    const schema = control(schemaRoot)
    schema.close()
    controls.splice(controls.indexOf(schema), 1)
    const database = new Database(join(schemaRoot, 'durable-delegation-operation-control.sqlite3'))
    database.exec('CREATE TABLE unexpected_store(value TEXT)')
    database.close()
    expectCode(() => makeNodeDurableDelegationOperationControlV1({
      root: schemaRoot,
      installationHash: INSTALLATION,
      policyRevision: POLICY,
      dailyEpoch: DAILY_EPOCH,
    }), 'DELEGATION_OPERATION_CONTROL_STATE_CORRUPT')
  })
})
