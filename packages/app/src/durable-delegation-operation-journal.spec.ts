import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DurableDelegationOperationJournalError,
  hashDurableDelegationOperationLogicalSlotV2,
  hashDurableDelegationOperationRequestV1,
  hashDurableDelegationOperationRequestV2,
  makeNodeDurableDelegationOperationJournalV1,
  makeNodeDurableDelegationOperationJournalV2,
  type DurableDelegationOperationJournalV1,
  type DurableDelegationOperationJournalV2,
  type DurableDelegationOperationKeyV1,
  type DurableDelegationOperationKeyV2,
  type DurableDelegationOperationReceiptInputV1,
  type DurableDelegationOperationSettlementPermitV1,
  type DurableDelegationOperationSettlementPermitV2,
} from './durable-delegation-operation-journal.js'

const durabilityTrace = vi.hoisted(() => ({
  events: [] as string[],
  pathsByDescriptor: new Map<number, string>(),
  directoryReads: new Map<string, number>(),
  fault: null as null | {
    operation: 'write' | 'fsync' | 'rename'
    pathIncludes?: string
    pathEquals?: string
  },
  beforeExclusiveStateOpen: null as null | (() => void),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const faultMatches = (operation: 'write' | 'fsync' | 'rename', path: string): boolean => {
    const fault = durabilityTrace.fault
    return fault !== null && fault.operation === operation &&
      (fault.pathEquals === undefined
        ? fault.pathIncludes !== undefined && path.includes(fault.pathIncludes)
        : path === fault.pathEquals)
  }
  const openSync = ((path: Parameters<typeof actual.openSync>[0], ...args: unknown[]) => {
    const flags = args[0]
    if (typeof flags === 'number' && (flags & actual.constants.O_EXCL) !== 0 &&
      String(path).endsWith('.json') && durabilityTrace.beforeExclusiveStateOpen !== null) {
      const hook = durabilityTrace.beforeExclusiveStateOpen
      durabilityTrace.beforeExclusiveStateOpen = null
      hook()
    }
    const descriptor = Reflect.apply(actual.openSync, actual, [path, ...args]) as number
    durabilityTrace.pathsByDescriptor.set(descriptor, String(path))
    return descriptor
  }) as typeof actual.openSync
  const closeSync = ((descriptor: number) => {
    try { return actual.closeSync(descriptor) } finally {
      durabilityTrace.pathsByDescriptor.delete(descriptor)
    }
  }) as typeof actual.closeSync
  const fsyncSync = ((descriptor: number) => {
    const path = durabilityTrace.pathsByDescriptor.get(descriptor) ?? 'unknown'
    durabilityTrace.events.push(`fsync:${path}`)
    const result = actual.fsyncSync(descriptor)
    if (faultMatches('fsync', path)) {
      durabilityTrace.fault = null
      throw new Error('injected fsync fault after syscall')
    }
    return result
  }) as typeof actual.fsyncSync
  const writeFileSync = ((target: Parameters<typeof actual.writeFileSync>[0], ...args: unknown[]) => {
    const path = typeof target === 'number'
      ? durabilityTrace.pathsByDescriptor.get(target) ?? 'unknown'
      : String(target)
    durabilityTrace.events.push(`write:${path}`)
    const result = Reflect.apply(actual.writeFileSync, actual, [target, ...args])
    if (faultMatches('write', path)) {
      durabilityTrace.fault = null
      throw new Error('injected write fault after syscall')
    }
    return result
  }) as typeof actual.writeFileSync
  const renameSync = ((source: Parameters<typeof actual.renameSync>[0],
    destination: Parameters<typeof actual.renameSync>[1]) => {
    const result = actual.renameSync(source, destination)
    durabilityTrace.events.push(`rename:${String(source)}->${String(destination)}`)
    if (faultMatches('rename', String(destination))) {
      durabilityTrace.fault = null
      throw new Error('injected rename fault after syscall')
    }
    return result
  }) as typeof actual.renameSync
  const opendirSync = ((path: Parameters<typeof actual.opendirSync>[0], ...args: unknown[]) => {
    const directory = Reflect.apply(actual.opendirSync, actual, [path, ...args]) as ReturnType<
      typeof actual.opendirSync
    >
    const capturedPath = String(path)
    return new Proxy(directory, {
      get(target, property) {
        if (property === 'readSync') {
          return () => {
            durabilityTrace.directoryReads.set(
              capturedPath,
              (durabilityTrace.directoryReads.get(capturedPath) ?? 0) + 1,
            )
            return target.readSync()
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }) as typeof actual.opendirSync
  return { ...actual, openSync, closeSync, fsyncSync, writeFileSync, renameSync, opendirSync }
})

const roots: string[] = []
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)

afterEach(() => {
  durabilityTrace.fault = null
  durabilityTrace.beforeExclusiveStateOpen = null
  durabilityTrace.directoryReads.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix = 'aisy-operation-journal-'): string {
  const holder = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  chmodSync(holder, 0o700)
  const root = join(holder, 'run')
  mkdirSync(root, { mode: 0o700 })
  roots.push(holder)
  return realpathSync(root)
}

function key(
  journal: DurableDelegationOperationJournalV1,
  overrides: Partial<DurableDelegationOperationKeyV1> = {},
): DurableDelegationOperationKeyV1 {
  return {
    runRootHash: journal.runRootHash,
    bindingHash: HASH_A,
    delegationId: 'delegation-1',
    taskId: 'task-1',
    phase: 'provider',
    ordinal: 1,
    canonicalRequestHash: HASH_B,
    authorityHash: HASH_C,
    policyRevision: 'durable-operation-v1',
    ...overrides,
  }
}

function receipt(
  overrides: Partial<DurableDelegationOperationReceiptInputV1> = {},
): DurableDelegationOperationReceiptInputV1 {
  return {
    spendUsd: 0.25,
    wallMs: 120,
    effect: 'read',
    inputTokens: 10,
    outputTokens: 20,
    ...overrides,
  }
}

function keyV2(
  journal: DurableDelegationOperationJournalV2,
  overrides: Partial<DurableDelegationOperationKeyV2> = {},
): DurableDelegationOperationKeyV2 {
  const slot = {
    delegationId: overrides.delegationId ?? 'delegation-1',
    taskId: overrides.taskId ?? 'task-1',
    phase: overrides.phase ?? 'provider',
    ordinal: overrides.ordinal ?? 1,
  } as const
  return {
    runRootHash: journal.runRootHash,
    bindingHash: HASH_A,
    ...slot,
    canonicalRequestHash: HASH_B,
    authorityHash: HASH_C,
    policyRevision: 'durable-operation-v2',
    logicalSlotHash: hashDurableDelegationOperationLogicalSlotV2(slot),
    attempt: 1,
    resolutionHash: HASH_D,
    ...overrides,
  }
}

function createdPermitV2(
  journal: DurableDelegationOperationJournalV2,
  operationKey: DurableDelegationOperationKeyV2,
): DurableDelegationOperationSettlementPermitV2 {
  const prepared = journal.prepare(operationKey)
  expect(prepared).toMatchObject({ state: 'prepared', disposition: 'created' })
  if (prepared.state !== 'prepared' || prepared.disposition !== 'created') {
    throw new Error('expected a newly prepared V2 operation')
  }
  return prepared.permit
}

function operationStatePathsV2(root: string): string[] {
  return readdirSync(join(root, 'operations-v2'))
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => join(root, 'operations-v2', name))
}

function createdPermit(
  journal: DurableDelegationOperationJournalV1,
  operationKey: DurableDelegationOperationKeyV1,
): DurableDelegationOperationSettlementPermitV1 {
  const prepared = journal.prepare(operationKey)
  expect(prepared).toMatchObject({ state: 'prepared', disposition: 'created' })
  if (prepared.state !== 'prepared' || prepared.disposition !== 'created') {
    throw new Error('expected a newly prepared operation')
  }
  return prepared.permit
}

function operationStatePath(root: string): string {
  const files = readdirSync(join(root, 'operations')).filter(name => name.endsWith('.json'))
  expect(files).toHaveLength(1)
  return join(root, 'operations', files[0]!)
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected operation journal error')
  } catch (error) {
    expect(error).toBeInstanceOf(DurableDelegationOperationJournalError)
    expect((error as DurableDelegationOperationJournalError).code).toBe(code)
  }
}

function reparentOperationsUnderReplacementRoot(root: string): void {
  const displacedRoot = join(dirname(root), 'run-displaced')
  renameSync(root, displacedRoot)
  mkdirSync(root, { mode: 0o700 })
  renameSync(join(displacedRoot, 'operations'), join(root, 'operations'))
}

describe('durable delegation operation journal', () => {
  it('fsyncs operations, run root and its parent before a prepare permit exists', () => {
    durabilityTrace.events.splice(0)
    const root = tempRoot()
    const runParent = join(root, '..')
    const operationRoot = join(root, 'operations')
    const journal = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    const prepared = journal.prepare(key(journal))
    expect(prepared).toMatchObject({ state: 'prepared', disposition: 'created' })

    const statePath = operationStatePath(root)
    const firstOperationDirectorySync = durabilityTrace.events.indexOf(`fsync:${operationRoot}`)
    const runRootSync = durabilityTrace.events.indexOf(`fsync:${root}`)
    const parentSync = durabilityTrace.events.indexOf(`fsync:${runParent}`)
    const stateWrite = durabilityTrace.events.indexOf(`write:${statePath}`)
    const stateSync = durabilityTrace.events.indexOf(`fsync:${statePath}`)
    const finalOperationDirectorySync = durabilityTrace.events.lastIndexOf(`fsync:${operationRoot}`)
    expect(firstOperationDirectorySync).toBeGreaterThanOrEqual(0)
    expect(runRootSync).toBeGreaterThan(firstOperationDirectorySync)
    expect(parentSync).toBeGreaterThan(runRootSync)
    expect(stateWrite).toBeGreaterThan(parentSync)
    expect(stateSync).toBeGreaterThan(stateWrite)
    expect(finalOperationDirectorySync).toBeGreaterThan(stateSync)
  })

  it.each([
    ['prepared write', 'write'],
    ['prepared file fsync', 'fsync'],
  ] as const)('fails closed after an injected %s fault that occurs after the real syscall', (_label, operation) => {
    durabilityTrace.events.splice(0)
    const root = tempRoot(`aisy-operation-${operation}-prepare-fault-`)
    const journal = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    const operationKey = key(journal)
    durabilityTrace.fault = { operation, pathIncludes: '.json' }
    expectCode(
      () => journal.prepare(operationKey),
      'DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE',
    )
    expect(durabilityTrace.fault).toBeNull()

    const restarted = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    const recovered = restarted.prepare(key(restarted))
    expect(['ambiguous', 'drift']).toContain(recovered.state)
    expect(recovered.state).not.toBe('absent')
    expect(recovered.state).not.toBe('prepared')
    expect('permit' in recovered).toBe(false)
  })

  it.each([
    ['settled temp write', 'write', '.operation.tmp', 'ambiguous'],
    ['settled temp fsync', 'fsync', '.operation.tmp', 'ambiguous'],
    ['settled rename', 'rename', '.json', 'settled'],
    ['settled directory fsync', 'fsync', '<operation-root>', 'settled'],
  ] as const)(
    'fails closed after an injected %s fault and never returns a replacement permit',
    (_label, operation, pathIncludes, expectedState) => {
      durabilityTrace.events.splice(0)
      const root = tempRoot(`aisy-operation-${operation}-settle-fault-`)
      const journal = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
      const operationKey = key(journal)
      const permit = createdPermit(journal, operationKey)
      durabilityTrace.fault = pathIncludes === '<operation-root>'
        ? { operation, pathEquals: join(root, 'operations') }
        : { operation, pathIncludes }
      expectCode(
        () => journal.settle(permit, { payload: { result: 'owned' }, receipt: receipt() }),
        'DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE',
      )
      expect(durabilityTrace.fault).toBeNull()
      expectCode(
        () => journal.settle(permit, { payload: { result: 'again' }, receipt: receipt() }),
        'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
      )

      const restarted = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
      const recovered = restarted.prepare(key(restarted))
      expect(recovered.state).toBe(expectedState)
      expect(recovered.state).not.toBe('absent')
      expect(recovered.state).not.toBe('prepared')
      expect('permit' in recovered).toBe(false)
    },
  )

  it('persists prepared before returning and treats restart as ambiguity without a permit', () => {
    const root = tempRoot()
    const first = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    const operationKey = key(first)
    expect(first.inspect(operationKey)).toEqual({ state: 'absent' })

    let externalCalls = 0
    const prepared = first.prepare(operationKey)
    expect(prepared).toMatchObject({ state: 'prepared', disposition: 'created' })
    expect(statSync(operationStatePath(root)).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'operations')).mode & 0o777).toBe(0o700)
    // A wrapper may cross the external boundary only after prepare returned.
    externalCalls += 1

    const restarted = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    const recovered = restarted.prepare(key(restarted))
    expect(recovered).toMatchObject({ state: 'ambiguous' })
    expect('permit' in recovered).toBe(false)
    expect(first.inspect(operationKey)).toMatchObject({ state: 'ambiguous' })
    expect(first.prepare(operationKey)).toMatchObject({ state: 'ambiguous' })
    expect(externalCalls).toBe(1)

    if (prepared.state !== 'prepared' || prepared.disposition !== 'created') {
      throw new Error('expected prepare permit')
    }
    expectCode(
      () => restarted.settle(prepared.permit, { payload: 'late', receipt: receipt() }),
      'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
    )
  })

  it('gives exactly one permit to two same-root prepare contenders', () => {
    const root = tempRoot()
    const first = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    const second = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    let secondResult: ReturnType<typeof second.prepare> | undefined
    durabilityTrace.beforeExclusiveStateOpen = () => {
      secondResult = second.prepare(key(second))
    }

    const firstResult = first.prepare(key(first))
    expect(firstResult).toMatchObject({ state: 'ambiguous' })
    expect(secondResult).toMatchObject({ state: 'prepared', disposition: 'created' })
    expect('permit' in firstResult).toBe(false)
    if (secondResult?.state !== 'prepared' || secondResult.disposition !== 'created') {
      throw new Error('expected the reentrant contender to own the only permit')
    }
    const winningPermit = secondResult.permit
    expectCode(
      () => first.settle(winningPermit, { payload: 'cross-controller', receipt: receipt() }),
      'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
    )
    expect(second.settle(winningPermit, {
      payload: 'winner',
      receipt: receipt(),
    }).state).toBe('settled')
  })

  it.each([
    ['provider', 'runtime.provider-receipt'],
    ['tool', 'runtime.tool-receipt'],
  ] as const)('replays an exact settled %s result without another external call', (phase, kind) => {
    const root = tempRoot()
    const first = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    const operationKey = key(first, { phase })
    const permit = createdPermit(first, operationKey)
    let externalCalls = 1
    const payload = { z: [1, 2], a: 'exact response' }
    const ownedReceipt = receipt(phase === 'tool'
      ? { effect: 'mutation', evidenceHash: HASH_D }
      : {}) as { -readonly [K in keyof DurableDelegationOperationReceiptInputV1]: DurableDelegationOperationReceiptInputV1[K] }
    const settled = first.settle(permit, {
      payload,
      receipt: ownedReceipt,
    })
    payload.a = 'mutated after settle'
    ownedReceipt.spendUsd = 999
    expect(settled.receipt).toMatchObject({ receiptVersion: 1, kind })

    const restarted = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    const replay = restarted.prepare(key(restarted, { phase }))
    if (replay.state === 'settled') {
      // The future wrapper returns this branch and does not call its port.
      expect(replay.payload).toEqual({ a: 'exact response', z: [1, 2] })
      expect(replay.receipt.kind).toBe(kind)
      expect(replay.receipt.spendUsd).toBe(0.25)
    } else {
      externalCalls += 1
    }
    expect(replay.state).toBe('settled')
    expect(externalCalls).toBe(1)
  })

  it.each([
    ['binding hash', { bindingHash: HASH_D }],
    ['request hash', { canonicalRequestHash: HASH_D }],
    ['authority hash', { authorityHash: HASH_D }],
    ['policy revision', { policyRevision: 'durable-operation-v2' }],
  ] as const)('reports exact-key drift for changed %s before a new prepare', (_label, change) => {
    const root = tempRoot()
    const journal = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    journal.prepare(key(journal))
    expect(journal.prepare(key(journal, change))).toEqual({
      state: 'drift',
      reason: 'key-mismatch',
    })
    expect(readdirSync(join(root, 'operations')).filter(name => name.endsWith('.json'))).toHaveLength(1)
  })

  it('reports run-root drift without reading or creating another operation file', () => {
    const root = tempRoot()
    const journal = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    const operationKey = key(journal, { runRootHash: HASH_D })
    expect(journal.prepare(operationKey)).toEqual({ state: 'drift', reason: 'key-mismatch' })
    expect(readdirSync(join(root, 'operations'))).toEqual([])
  })

  it('turns tampered or truncated state into code-only drift', () => {
    const root = tempRoot()
    const journal = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    const operationKey = key(journal)
    journal.prepare(operationKey)
    const statePath = operationStatePath(root)
    const original = readFileSync(statePath, 'utf8')
    writeFileSync(statePath, original.replace('operation.prepared', 'operation.corrupt'), {
      mode: 0o600,
    })

    const restarted = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    expect(restarted.inspect(key(restarted))).toEqual({
      state: 'drift',
      reason: 'corrupt-or-unsafe-state',
    })
    expect(restarted.prepare(key(restarted))).toEqual({
      state: 'drift',
      reason: 'corrupt-or-unsafe-state',
    })
  })

  it('rejects hard-linked and symlinked operation state without following it', () => {
    const hardRoot = tempRoot('aisy-operation-hardlink-')
    const hardJournal = makeNodeDurableDelegationOperationJournalV1({ runRoot: hardRoot })
    hardJournal.prepare(key(hardJournal))
    const hardState = operationStatePath(hardRoot)
    linkSync(hardState, `${hardState}.linked`)
    expect(hardJournal.inspect(key(hardJournal))).toEqual({
      state: 'drift',
      reason: 'corrupt-or-unsafe-state',
    })

    const linkRoot = tempRoot('aisy-operation-symlink-')
    const linkJournal = makeNodeDurableDelegationOperationJournalV1({ runRoot: linkRoot })
    linkJournal.prepare(key(linkJournal))
    const linkedState = operationStatePath(linkRoot)
    renameSync(linkedState, `${linkedState}.original`)
    symlinkSync(`${linkedState}.original`, linkedState)
    expect(linkJournal.inspect(key(linkJournal))).toEqual({
      state: 'drift',
      reason: 'corrupt-or-unsafe-state',
    })
  })

  it('rejects a public, symlinked, or foreign operations root at construction', () => {
    const publicRoot = tempRoot('aisy-operation-public-')
    chmodSync(publicRoot, 0o755)
    expectCode(
      () => makeNodeDurableDelegationOperationJournalV1({ runRoot: publicRoot }),
      'DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE',
    )

    const holder = tempRoot('aisy-operation-holder-')
    const target = tempRoot('aisy-operation-target-')
    const linkedRoot = join(holder, 'linked')
    symlinkSync(target, linkedRoot, 'dir')
    expectCode(
      () => makeNodeDurableDelegationOperationJournalV1({ runRoot: linkedRoot }),
      'DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE',
    )

    const operationsTarget = tempRoot('aisy-operation-foreign-')
    const operationRoot = tempRoot('aisy-operation-parent-')
    symlinkSync(operationsTarget, join(operationRoot, 'operations'), 'dir')
    expectCode(
      () => makeNodeDurableDelegationOperationJournalV1({ runRoot: operationRoot }),
      'DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE',
    )
  })

  it('detects replacement run-root identity even when the original operations inode is reparented', () => {
    const prepareRoot = tempRoot('aisy-operation-prepare-swap-')
    const prepareJournal = makeNodeDurableDelegationOperationJournalV1({ runRoot: prepareRoot })
    const prepareKey = key(prepareJournal)
    reparentOperationsUnderReplacementRoot(prepareRoot)
    const refusedPrepare = prepareJournal.prepare(prepareKey)
    expect(refusedPrepare).toEqual({ state: 'drift', reason: 'corrupt-or-unsafe-state' })
    expect('permit' in refusedPrepare).toBe(false)
    expect(readdirSync(join(prepareRoot, 'operations'))).toEqual([])

    const settleRoot = tempRoot('aisy-operation-settle-swap-')
    const settleJournal = makeNodeDurableDelegationOperationJournalV1({ runRoot: settleRoot })
    const settleKey = key(settleJournal)
    const permit = createdPermit(settleJournal, settleKey)
    reparentOperationsUnderReplacementRoot(settleRoot)
    expectCode(
      () => settleJournal.settle(permit, { payload: 'must not succeed', receipt: receipt() }),
      'DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE',
    )
    expect(settleJournal.inspect(settleKey)).toEqual({
      state: 'drift',
      reason: 'corrupt-or-unsafe-state',
    })
    expectCode(
      () => settleJournal.settle(permit, { payload: 'must stay consumed', receipt: receipt() }),
      'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
    )
    const replacementController = makeNodeDurableDelegationOperationJournalV1({ runRoot: settleRoot })
    const recovered = replacementController.prepare(key(replacementController))
    expect(recovered).toMatchObject({ state: 'ambiguous' })
    expect('permit' in recovered).toBe(false)
  })

  it('keeps the prepare ambiguous when payload or receipt is unbounded/forged', () => {
    const root = tempRoot()
    const journal = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    const operationKey = key(journal, { phase: 'tool' })
    const permit = createdPermit(journal, operationKey)
    expectCode(
      () => journal.settle(permit, {
        payload: 'x'.repeat(70 * 1024),
        receipt: receipt(),
      }),
      'DELEGATION_OPERATION_JOURNAL_INPUT_INVALID',
    )
    expect(journal.inspect(operationKey).state).toBe('ambiguous')

    expectCode(
      () => journal.settle(permit, {
        payload: { ok: true },
        receipt: { ...receipt(), kind: 'runtime.tool-receipt' } as unknown as
          DurableDelegationOperationReceiptInputV1,
      }),
      'DELEGATION_OPERATION_JOURNAL_INPUT_INVALID',
    )
    expect(journal.inspect(operationKey).state).toBe('ambiguous')

    expect(journal.settle(permit, {
      payload: { ok: true },
      receipt: receipt({ effect: 'mutation' }),
    }).state).toBe('settled')
  })

  it('makes settlement permits controller-bound, copy-resistant, and one-shot', () => {
    const firstRoot = tempRoot('aisy-operation-first-')
    const first = makeNodeDurableDelegationOperationJournalV1({ runRoot: firstRoot })
    const permit = createdPermit(first, key(first))
    const structuralCopy = { ...permit } as DurableDelegationOperationSettlementPermitV1
    expectCode(
      () => first.settle(structuralCopy, { payload: 'forged', receipt: receipt() }),
      'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
    )

    const secondRoot = tempRoot('aisy-operation-second-')
    const second = makeNodeDurableDelegationOperationJournalV1({ runRoot: secondRoot })
    expectCode(
      () => second.settle(permit, { payload: 'wrong controller', receipt: receipt() }),
      'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
    )

    first.settle(permit, { payload: 'owned', receipt: receipt() })
    expectCode(
      () => first.settle(permit, { payload: 'again', receipt: receipt() }),
      'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
    )
  })

  it('derives reserved receipt kinds itself and rejects impossible provider mutation', () => {
    const root = tempRoot()
    const journal = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    const operationKey = key(journal)
    const permit = createdPermit(journal, operationKey)
    expectCode(
      () => journal.settle(permit, {
        payload: { impossible: true },
        receipt: receipt({ effect: 'mutation' }),
      }),
      'DELEGATION_OPERATION_JOURNAL_INPUT_INVALID',
    )
    expect('append' in journal).toBe(false)
    expect(journal.inspect(operationKey).state).toBe('ambiguous')
  })

  it('canonicalizes request object ordering and rejects proxy/accessor input without reading it', () => {
    expect(hashDurableDelegationOperationRequestV1({ b: 2, a: [1, true] })).toBe(
      hashDurableDelegationOperationRequestV1({ a: [1, true], b: 2 }),
    )
    expectCode(
      () => hashDurableDelegationOperationRequestV1(new Proxy({}, {})),
      'DELEGATION_OPERATION_JOURNAL_INPUT_INVALID',
    )
    expectCode(
      () => hashDurableDelegationOperationRequestV1({ nested: new Proxy({}, {}) }),
      'DELEGATION_OPERATION_JOURNAL_INPUT_INVALID',
    )
    let getterCalls = 0
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() { getterCalls += 1; return 'not-read' },
    })
    expectCode(
      () => hashDurableDelegationOperationRequestV1(accessor),
      'DELEGATION_OPERATION_JOURNAL_INPUT_INVALID',
    )
    const nestedAccessor = { nested: accessor }
    expectCode(
      () => hashDurableDelegationOperationRequestV1(nestedAccessor),
      'DELEGATION_OPERATION_JOURNAL_INPUT_INVALID',
    )
    expect(getterCalls).toBe(0)
  })

  it('captures the exact key before mutation and rejects accessor keys', () => {
    const root = tempRoot()
    const journal = makeNodeDurableDelegationOperationJournalV1({ runRoot: root })
    const mutable = key(journal) as { -readonly [K in keyof DurableDelegationOperationKeyV1]: DurableDelegationOperationKeyV1[K] }
    journal.prepare(mutable)
    mutable.policyRevision = 'changed-after-prepare'
    expect(journal.inspect(key(journal)).state).toBe('ambiguous')

    const accessor = { ...key(journal, { ordinal: 2 }) }
    let getterCalls = 0
    Object.defineProperty(accessor, 'policyRevision', {
      enumerable: true,
      get() { getterCalls += 1; return 'not-read' },
    })
    expectCode(
      () => journal.inspect(accessor),
      'DELEGATION_OPERATION_JOURNAL_INPUT_INVALID',
    )
    expect(getterCalls).toBe(0)
  })
})

describe('durable delegation operation journal V2 cohort', () => {
  it('keeps a separate cohort and returns an exact bounded inventory in logical-attempt order', () => {
    const root = tempRoot('aisy-operation-v2-inventory-')
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const secondLogical = keyV2(journal, { taskId: 'task-z', ordinal: 2 })
    const firstLogical = keyV2(journal, { taskId: 'task-a', ordinal: 1 })
    journal.prepare(secondLogical)
    journal.prepare(firstLogical)
    const retry = keyV2(journal, {
      ...firstLogical,
      attempt: 2,
      resolutionHash: HASH_A,
    })
    journal.prepare(retry)

    const inventory = journal.scan()
    expect(inventory).toMatchObject({ cohortVersion: 2, runRootHash: journal.runRootHash })
    expect(Object.isFrozen(inventory)).toBe(true)
    expect(Object.isFrozen(inventory.entries)).toBe(true)
    expect(inventory.entries).toHaveLength(3)
    expect(inventory.entries.map(entry => [entry.key.logicalSlotHash, entry.key.attempt])).toEqual(
      [...inventory.entries]
        .sort((left, right) => left.key.logicalSlotHash.localeCompare(right.key.logicalSlotHash) ||
          left.key.attempt - right.key.attempt)
        .map(entry => [entry.key.logicalSlotHash, entry.key.attempt]),
    )
    const pair = inventory.entries.filter(entry =>
      entry.key.logicalSlotHash === firstLogical.logicalSlotHash)
    expect(pair.map(entry => entry.key.attempt)).toEqual([1, 2])
    expect(statSync(join(root, 'operations')).isFile()).toBe(true)
    expect(operationStatePathsV2(root)).toHaveLength(3)
  })

  it('replays a settled result and never reissues a settlement permit after restart', () => {
    const root = tempRoot('aisy-operation-v2-replay-')
    const first = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const operationKey = keyV2(first, { phase: 'tool' })
    const permit = createdPermitV2(first, operationKey)
    const settled = first.settle(permit, {
      payload: { answer: 'exact' },
      receipt: receipt({ effect: 'mutation', evidenceHash: HASH_A }),
    })
    expect(settled).toMatchObject({
      state: 'settled',
      payload: { answer: 'exact' },
      receipt: { kind: 'runtime.tool-receipt', resultHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    })

    const restarted = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const replay = restarted.prepare(keyV2(restarted, { phase: 'tool' }))
    expect(replay).toMatchObject({ state: 'settled', payload: { answer: 'exact' } })
    expect('permit' in replay).toBe(false)
    expect(restarted.scan().entries).toHaveLength(1)
  })

  it('allows only one exact retry after an ambiguous first attempt', () => {
    const root = tempRoot('aisy-operation-v2-attempts-')
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const first = keyV2(journal)

    const orphan = keyV2(journal, { ...first, attempt: 2, resolutionHash: HASH_A })
    expect(journal.prepare(orphan)).toEqual({
      state: 'drift',
      reason: 'attempt-sequence-invalid',
    })
    expect(operationStatePathsV2(root)).toEqual([])

    journal.prepare(first)
    const retry = keyV2(journal, { ...first, attempt: 2, resolutionHash: HASH_A })
    expect(journal.prepare(retry)).toMatchObject({ state: 'prepared', disposition: 'created' })
    expect(journal.prepare(retry)).toMatchObject({ state: 'ambiguous' })
    expect(journal.scan().entries.map(entry => entry.key.attempt)).toEqual([1, 2])
  })

  it.each([
    ['binding', { bindingHash: HASH_D }],
    ['request', { canonicalRequestHash: HASH_D }],
    ['authority', { authorityHash: HASH_D }],
    ['policy', { policyRevision: 'durable-operation-v2-changed' }],
  ] as const)('refuses attempt-two %s drift before another state file exists', (_label, drift) => {
    const root = tempRoot('aisy-operation-v2-retry-drift-')
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const first = keyV2(journal)
    journal.prepare(first)
    const changed = keyV2(journal, {
      ...first,
      ...drift,
      attempt: 2,
      resolutionHash: HASH_A,
    })
    expect(journal.prepare(changed)).toEqual({
      state: 'drift',
      reason: 'attempt-sequence-invalid',
    })
    expect(operationStatePathsV2(root)).toHaveLength(1)
  })

  it('refuses a retry after the first attempt settled', () => {
    const root = tempRoot('aisy-operation-v2-settled-no-retry-')
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const first = keyV2(journal)
    const permit = createdPermitV2(journal, first)
    journal.settle(permit, { payload: 'done', receipt: receipt() })
    expect(journal.prepare(keyV2(journal, {
      ...first,
      attempt: 2,
      resolutionHash: HASH_A,
    }))).toEqual({
      state: 'drift',
      reason: 'attempt-sequence-invalid',
    })
    expect(operationStatePathsV2(root)).toHaveLength(1)
  })

  it('refuses a late first-attempt settlement after retry preparation', () => {
    const root = tempRoot('aisy-operation-v2-late-settle-')
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const first = keyV2(journal)
    const firstPermit = createdPermitV2(journal, first)
    journal.prepare(keyV2(journal, { ...first, attempt: 2, resolutionHash: HASH_A }))
    expectCode(
      () => journal.settle(firstPermit, { payload: 'late', receipt: receipt() }),
      'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
    )
    expect(journal.scan().entries.map(entry => entry.state)).toEqual(['ambiguous', 'ambiguous'])
  })

  it('detects either mixed-cohort order without migrating or deleting records', () => {
    const legacyFirstRoot = tempRoot('aisy-operation-v2-mixed-legacy-first-')
    const legacy = makeNodeDurableDelegationOperationJournalV1({ runRoot: legacyFirstRoot })
    legacy.prepare(key(legacy))
    expectCode(
      () => makeNodeDurableDelegationOperationJournalV2({ runRoot: legacyFirstRoot }),
      'DELEGATION_OPERATION_JOURNAL_COHORT_MIXED',
    )
    expect(existsSync(join(legacyFirstRoot, 'operations-v2'))).toBe(false)
    expect(operationStatePath(legacyFirstRoot)).toBeTruthy()

    const emptyLegacyRoot = tempRoot('aisy-operation-v2-empty-legacy-first-')
    makeNodeDurableDelegationOperationJournalV1({ runRoot: emptyLegacyRoot })
    expectCode(
      () => makeNodeDurableDelegationOperationJournalV2({ runRoot: emptyLegacyRoot }),
      'DELEGATION_OPERATION_JOURNAL_COHORT_MIXED',
    )
    expect(existsSync(join(emptyLegacyRoot, 'operations-v2'))).toBe(false)

    const modernFirstRoot = tempRoot('aisy-operation-v2-mixed-modern-first-')
    const modern = makeNodeDurableDelegationOperationJournalV2({ runRoot: modernFirstRoot })
    modern.prepare(keyV2(modern))
    expectCode(
      () => makeNodeDurableDelegationOperationJournalV1({ runRoot: modernFirstRoot }),
      'DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE',
    )
    expect(operationStatePathsV2(modernFirstRoot)).toHaveLength(1)
    expect(modern.scan().entries).toHaveLength(1)
  })

  it.each([
    ['prepared write', 'write'],
    ['prepared file fsync', 'fsync'],
  ] as const)('keeps a crash-torn V2 %s fail-closed without a permit', (_label, operation) => {
    const root = tempRoot(`aisy-operation-v2-${operation}-prepare-fault-`)
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    durabilityTrace.fault = { operation, pathIncludes: '.json' }
    expectCode(
      () => journal.prepare(keyV2(journal)),
      'DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE',
    )
    expect(durabilityTrace.fault).toBeNull()
    const restarted = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    expect(restarted.scan().entries).toMatchObject([{ state: 'ambiguous' }])
    const recovered = restarted.prepare(keyV2(restarted))
    expect(recovered).toMatchObject({ state: 'ambiguous' })
    expect('permit' in recovered).toBe(false)
  })

  it.each([
    ['settled temp write', 'write', '.operation-v2.tmp', 'ambiguous'],
    ['settled temp fsync', 'fsync', '.operation-v2.tmp', 'ambiguous'],
    ['settled rename', 'rename', '.json', 'settled'],
    ['settled directory fsync', 'fsync', '<operation-root>', 'settled'],
  ] as const)(
    'consumes the permit after a V2 %s fault and recovers the exact durable side',
    (_label, operation, pathIncludes, expectedState) => {
      const root = tempRoot(`aisy-operation-v2-${operation}-settle-fault-`)
      const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
      const operationKey = keyV2(journal)
      const permit = createdPermitV2(journal, operationKey)
      durabilityTrace.fault = pathIncludes === '<operation-root>'
        ? { operation, pathEquals: join(root, 'operations-v2') }
        : { operation, pathIncludes }
      expectCode(
        () => journal.settle(permit, { payload: { result: 'owned' }, receipt: receipt() }),
        'DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE',
      )
      expectCode(
        () => journal.settle(permit, { payload: { result: 'again' }, receipt: receipt() }),
        'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
      )
      const restarted = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
      expect(restarted.inspect(keyV2(restarted)).state).toBe(expectedState)
      expect(restarted.scan().entries).toHaveLength(1)
    },
  )

  it('refuses orphan, corrupt, wrong-name and unknown inventory entries', () => {
    const orphanRoot = tempRoot('aisy-operation-v2-orphan-')
    const orphan = makeNodeDurableDelegationOperationJournalV2({ runRoot: orphanRoot })
    const first = keyV2(orphan)
    orphan.prepare(first)
    orphan.prepare(keyV2(orphan, { ...first, attempt: 2, resolutionHash: HASH_A }))
    const [attemptOne] = orphan.scan().entries
    const attemptOnePath = operationStatePathsV2(orphanRoot).find(path => {
      const raw = readFileSync(path, 'utf8')
      return raw.includes(`\"attempt\":${attemptOne?.key.attempt ?? 1}`)
    })
    expect(attemptOnePath).toBeDefined()
    unlinkSync(attemptOnePath!)
    expectCode(() => orphan.scan(), 'DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')

    const corruptRoot = tempRoot('aisy-operation-v2-corrupt-')
    const corrupt = makeNodeDurableDelegationOperationJournalV2({ runRoot: corruptRoot })
    corrupt.prepare(keyV2(corrupt))
    const corruptPath = operationStatePathsV2(corruptRoot)[0]!
    writeFileSync(corruptPath, readFileSync(corruptPath, 'utf8')
      .replace('operation-v2.prepared', 'operation-v2.corrupt'), { mode: 0o600 })
    expectCode(() => corrupt.scan(), 'DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')

    const wrongNameRoot = tempRoot('aisy-operation-v2-wrong-name-')
    const wrongName = makeNodeDurableDelegationOperationJournalV2({ runRoot: wrongNameRoot })
    wrongName.prepare(keyV2(wrongName))
    const statePath = operationStatePathsV2(wrongNameRoot)[0]!
    renameSync(statePath, join(dirname(statePath), `${HASH_A}.json`))
    expectCode(() => wrongName.scan(), 'DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')

    const unknownRoot = tempRoot('aisy-operation-v2-unknown-')
    const unknown = makeNodeDurableDelegationOperationJournalV2({ runRoot: unknownRoot })
    writeFileSync(join(unknownRoot, 'operations-v2', '.orphan.operation-v2.tmp'), 'orphan', {
      mode: 0o600,
    })
    expectCode(() => unknown.scan(), 'DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')
  })

  it('bounds inventory before parsing entries', () => {
    const root = tempRoot('aisy-operation-v2-bounded-')
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const directory = join(root, 'operations-v2')
    for (let index = 0; index < 5_000; index++) {
      writeFileSync(join(directory, `${index.toString(16).padStart(64, '0')}.json`), '', {
        mode: 0o600,
      })
    }
    expectCode(() => journal.scan(), 'DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')
    expect(durabilityTrace.directoryReads.get(directory)).toBe(4_097)
  })

  it('gives exactly one V2 permit to same-slot contenders', () => {
    const root = tempRoot('aisy-operation-v2-contenders-')
    const first = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const second = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    let contenderError: unknown
    durabilityTrace.beforeExclusiveStateOpen = () => {
      try { second.prepare(keyV2(second)) } catch (error) { contenderError = error }
    }
    const firstResult = first.prepare(keyV2(first))
    expect(firstResult).toMatchObject({ state: 'prepared', disposition: 'created' })
    expect(contenderError).toBeInstanceOf(DurableDelegationOperationJournalError)
    expect((contenderError as DurableDelegationOperationJournalError).code)
      .toBe('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
    if (firstResult.state !== 'prepared') throw new Error('expected contender permit')
    const contenderPermit = firstResult.permit
    expectCode(
      () => second.settle(contenderPermit, { payload: 'cross', receipt: receipt() }),
      'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
    )
    expect(first.settle(contenderPermit, { payload: 'winner', receipt: receipt() }).state)
      .toBe('settled')
  })

  it('serializes retry preparation against a late first-attempt settlement', () => {
    const root = tempRoot('aisy-operation-v2-cross-attempt-contenders-')
    const firstController = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const retryController = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const firstKey = keyV2(firstController)
    const firstPermit = createdPermitV2(firstController, firstKey)
    let settlementError: unknown
    durabilityTrace.beforeExclusiveStateOpen = () => {
      try {
        firstController.settle(firstPermit, { payload: 'late', receipt: receipt() })
      } catch (error) {
        settlementError = error
      }
    }

    const retry = retryController.prepare(keyV2(retryController, {
      ...firstKey,
      runRootHash: retryController.runRootHash,
      attempt: 2,
      resolutionHash: HASH_A,
    }))
    expect(retry).toMatchObject({ state: 'prepared', disposition: 'created' })
    expect(settlementError).toBeInstanceOf(DurableDelegationOperationJournalError)
    expect((settlementError as DurableDelegationOperationJournalError).code)
      .toBe('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
    expectCode(
      () => firstController.settle(firstPermit, { payload: 'again', receipt: receipt() }),
      'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
    )
    const inventory = retryController.scan()
    expect(inventory.entries.map(entry => [entry.key.attempt, entry.state])).toEqual([
      [1, 'ambiguous'],
      [2, 'ambiguous'],
    ])
  })

  it('keeps a crash-left family lock visible as manual recovery without corrupting inventory', () => {
    const root = tempRoot('aisy-operation-v2-stale-family-lock-')
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const operationKey = keyV2(journal)
    const lockPath = join(root, 'operations-v2-locks', `${operationKey.logicalSlotHash}.lock`)
    writeFileSync(lockPath, 'crash-left-lock', { mode: 0o600 })

    expect(journal.scan().entries).toEqual([])
    expectCode(
      () => journal.prepare(operationKey),
      'DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE',
    )
    expect(journal.scan().entries).toEqual([])

    // Recovery is intentionally explicit: the journal never guesses that an
    // owner is dead. A manager-owned recovery actor may remove the sealed lock.
    unlinkSync(lockPath)
    expect(journal.prepare(operationKey)).toMatchObject({
      state: 'prepared',
      disposition: 'created',
    })
  })

  it('keeps V2 permits controller-bound, copy-resistant and one-shot', () => {
    const firstRoot = tempRoot('aisy-operation-v2-first-controller-')
    const first = makeNodeDurableDelegationOperationJournalV2({ runRoot: firstRoot })
    const permit = createdPermitV2(first, keyV2(first))
    const copy = { ...permit } as DurableDelegationOperationSettlementPermitV2
    expectCode(
      () => first.settle(copy, { payload: 'forged', receipt: receipt() }),
      'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
    )
    const secondRoot = tempRoot('aisy-operation-v2-second-controller-')
    const second = makeNodeDurableDelegationOperationJournalV2({ runRoot: secondRoot })
    expectCode(
      () => second.settle(permit, { payload: 'foreign', receipt: receipt() }),
      'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
    )
    first.settle(permit, { payload: 'owned', receipt: receipt() })
    expectCode(
      () => first.settle(permit, { payload: 'again', receipt: receipt() }),
      'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED',
    )
  })

  it('rejects Proxy/accessor keys and snapshots mutable V2 input before publication', () => {
    expect(hashDurableDelegationOperationRequestV2({ b: 2, a: [1, true] })).toBe(
      hashDurableDelegationOperationRequestV2({ a: [1, true], b: 2 }),
    )
    expect(hashDurableDelegationOperationRequestV2({ a: 1 }))
      .not.toBe(hashDurableDelegationOperationRequestV1({ a: 1 }))
    expectCode(
      () => hashDurableDelegationOperationRequestV2(new Proxy({}, {})),
      'DELEGATION_OPERATION_JOURNAL_INPUT_INVALID',
    )
    expectCode(
      () => hashDurableDelegationOperationLogicalSlotV2(new Proxy({}, {}) as never),
      'DELEGATION_OPERATION_JOURNAL_INPUT_INVALID',
    )

    const root = tempRoot('aisy-operation-v2-inputs-')
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const mutable = keyV2(journal) as {
      -readonly [K in keyof DurableDelegationOperationKeyV2]: DurableDelegationOperationKeyV2[K]
    }
    journal.prepare(mutable)
    mutable.policyRevision = 'changed-after-prepare'
    expect(journal.scan().entries[0]?.key.policyRevision).toBe('durable-operation-v2')

    const accessor = { ...keyV2(journal, { taskId: 'task-2', ordinal: 2 }) }
    let getterCalls = 0
    Object.defineProperty(accessor, 'resolutionHash', {
      enumerable: true,
      get() { getterCalls += 1; return HASH_A },
    })
    expectCode(
      () => journal.inspect(accessor),
      'DELEGATION_OPERATION_JOURNAL_INPUT_INVALID',
    )
    expect(getterCalls).toBe(0)
  })
})
