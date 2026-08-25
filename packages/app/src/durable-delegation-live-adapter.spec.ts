import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeAgentRunner,
  makeDelegationManager,
  makeGrantStore,
  resolveChildAgentCapabilityMatrix,
  resolveDelegationExecutionAuthority,
  runtimeProviderTools,
  type AgentCard,
  type DelegationAuthorityJournal,
  type DelegationDeps,
  type DelegationExecutionAuthorityV1,
  type DelegationTask,
  type LoopGuardian,
  type MemoryPort,
  type ModelProgressSink,
  type ModelRequest,
  type ModelResponse,
  type PlanDAG,
  type ResolvedWorkBinding,
  type SessionLog,
  type ShardEntry,
  type ToolCall,
  type ToolExecutionContext,
  type ToolResult,
} from '@aisy/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DurableDelegationLiveAdapterError,
  makeDurableDelegationAmbiguousAckV1,
  makeDurableDelegationLiveAdapterV1,
  makeDurableDelegationLiveAdapterV2,
  makeDurableDelegationStoppedAckV1,
  type DurableDelegationLiveAdapterInputV1,
  type DurableDelegationLiveAdapterInputV2,
  type DurableDelegationOwnedOperationV1,
  type DurableDelegationProviderFinalizedV1,
  type DurableDelegationResolutionRequestV2,
  type DurableDelegationToolFinalizedV1,
  type DurableDelegationVerifierInputV1,
} from './durable-delegation-live-adapter.js'
import {
  makeNodeDurableDelegationOperationJournalV1,
  makeNodeDurableDelegationOperationJournalV2,
  type DurableDelegationOperationJournalV2,
} from './durable-delegation-operation-journal.js'
import {
  deriveDurableDelegationOperationControlScopeHashesV1,
  makeDurableDelegationOperationResolutionAuthorityV1,
  makeNodeDurableDelegationOperationControlV1,
  type DurableDelegationBoundOperationControlV1,
  type DurableDelegationBoundOperationControlAttestationV1,
  type DurableDelegationOperationControlBindingV1,
  type DurableDelegationOperationControlV1,
} from './durable-delegation-operation-control.js'
import {
  makeNodeDurableDelegationRuntime,
  type DurableDelegationOperation,
} from './durable-delegation-runtime.js'
import { makeNodeDelegationPersistence } from './delegation-persistence.js'

const roots: string[] = []
const operationControls: DurableDelegationOperationControlV1[] = []

afterEach(() => {
  for (const control of operationControls.splice(0)) control.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const BINDING: ResolvedWorkBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
}

const CARD: AgentCard = {
  name: 'worker',
  instructions: 'Perform the exact delegated task.',
  skills: [],
  mcpAllowlist: [],
  toolTiers: { read_file: 0, write_file: 2 },
  maxIterations: 5,
  contextStrategy: 'compact',
  provenance: 'builtin',
}

const TASK: DelegationTask = {
  taskId: 'worker',
  intent: 'inspect and update one owned file',
  assignedTo: CARD.name,
  dependsOn: [],
  scope: { owns: ['src/**'], doNotTouch: [], taskClass: 'routine' },
  budgetSlice: { iterations: 5, spendUsd: 0.5 },
  outputContract: 'verified result',
  retryPolicy: { maxReplans: 0, maxIterations: 5 },
}
const PLAN: PlanDAG = { nodes: [TASK], edges: [] }

function authority(binding: ResolvedWorkBinding = BINDING): DelegationExecutionAuthorityV1 {
  const tools = runtimeProviderTools().filter(tool => tool.name === 'read_file' || tool.name === 'write_file')
  const matrix = resolveChildAgentCapabilityMatrix({
    card: CARD,
    toolCatalog: tools,
    activeSkills: new Set(),
    activeMcpServers: new Set(),
  })
  return resolveDelegationExecutionAuthority({
    handle: {
      delegationId: 'd-worker',
      taskId: TASK.taskId,
      binding,
      card: CARD,
      owns: [...TASK.scope.owns],
      writableMcp: [],
      permitsTool: name => name === 'read_file' || name === 'write_file',
      permitsMcp: () => false,
    },
    task: TASK,
    matrix,
    maxConcurrency: 2,
  })
}

function runRoot(): string {
  const holder = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-durable-live-adapter-')))
  chmodSync(holder, 0o700)
  const root = join(holder, 'run')
  mkdirSync(root, { mode: 0o700 })
  roots.push(holder)
  return realpathSync(root)
}

function authorityJournal(value: DelegationExecutionAuthorityV1): DelegationAuthorityJournal {
  const entries: ShardEntry[] = [{
    delegationId: value.identity.delegationId,
    seq: 1,
    prevHash: '0'.repeat(64),
    hash: '1'.repeat(64),
    kind: 'runtime.agent-authority.v1',
    payload: { schemaVersion: 1, authorityHash: value.authorityHash },
    ts: '2026-08-10T00:00:00.000Z',
  }]
  return Object.freeze({
    appendAuthoritySeal: () => { throw new Error('adapter must not receive append authority') },
    shard: () => structuredClone(entries),
    verifyShardChain: () => true,
  })
}

function managerDeps(root: string): DelegationDeps {
  return {
    binding: BINDING,
    resolveCard: name => name === CARD.name ? CARD : undefined,
    skillTouchedPaths: () => [],
    mcpWritable: () => false,
    emit: () => {},
    persistence: makeNodeDelegationPersistence({ runRoot: root }),
    isBindingActive: () => true,
  }
}

function runtimeOperation<T>(result: Promise<T> | T): DurableDelegationOperation<T> {
  return { result: Promise.resolve(result), cancel: async () => {} }
}

function operation<T>(
  result: Promise<T> | T,
  cancel = async () => makeDurableDelegationAmbiguousAckV1(),
): DurableDelegationOwnedOperationV1<T> {
  return Object.freeze({ result: Promise.resolve(result), cancel })
}

function providerFinalized(
  output: ModelResponse,
  receipt: Partial<DurableDelegationProviderFinalizedV1['receipt']> = {},
): DurableDelegationProviderFinalizedV1 {
  return {
    output,
    receipt: {
      spendUsdNanos: 0,
      wallMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      ...receipt,
    },
  }
}

function toolFinalized(
  output: ToolResult,
  receipt: Partial<DurableDelegationToolFinalizedV1['receipt']> = {},
): DurableDelegationToolFinalizedV1 {
  return {
    output,
    receipt: {
      spendUsdNanos: 0,
      wallMs: 0,
      effect: 'read',
      actionStatus: 'verified',
      ...receipt,
    },
  }
}

function request(text = 'work'): ModelRequest {
  return {
    sessionId: 'd-worker',
    turnId: 'child-turn-1',
    prefixBytes: new Uint8Array([1, 2, 3]),
    spans: [{ role: 'user', provenance: 'operator', text }],
  }
}

function deps(input: {
  root: string
  authority?: DelegationExecutionAuthorityV1
  journalAuthority?: DelegationExecutionAuthorityV1
  childTurnId?: string
  providerIdentityHash?: string
  policyRevision?: string
  providerStart?: (
    request: ModelRequest,
    signal?: AbortSignal,
    onProgress?: ModelProgressSink,
  ) => DurableDelegationOwnedOperationV1<DurableDelegationProviderFinalizedV1>
  toolStart?: (
    call: ToolCall,
    context: ToolExecutionContext,
  ) => DurableDelegationOwnedOperationV1<DurableDelegationToolFinalizedV1>
  verifier?: (
    input: DurableDelegationVerifierInputV1,
    signal?: AbortSignal,
  ) => Promise<{ verified: false; reasonCode: 'EVIDENCE_MISSING' }>
}): DurableDelegationLiveAdapterInputV1 {
  const resolvedAuthority = input.authority ?? authority()
  return {
    journal: makeNodeDurableDelegationOperationJournalV1({ runRoot: input.root }),
    authority: resolvedAuthority,
    authorityJournal: authorityJournal(input.journalAuthority ?? resolvedAuthority),
    childTurnId: input.childTurnId ?? 'child-turn-1',
    providerIdentityHash: input.providerIdentityHash ?? 'f'.repeat(64),
    policyRevision: input.policyRevision ?? 'durable-live-adapter-v1',
    provider: Object.freeze({
      start: input.providerStart ?? (() => operation(providerFinalized({ reply: 'provider result' }))),
    }),
    tool: Object.freeze({
      start: input.toolStart ?? (() => operation(toolFinalized({ ok: true, output: 'tool result' }))),
    }),
    verifier: input.verifier ?? (async () => ({ verified: false, reasonCode: 'EVIDENCE_MISSING' })),
  }
}

const CONTROL_INSTALLATION = 'a'.repeat(64)
const CONTROL_POLICY = 'durable-live-adapter-v2'
const CONTROL_DAY = '2026-08-10'

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key =>
      `${JSON.stringify(key)}:${sortedJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function v2BindingHash(value: DelegationExecutionAuthorityV1): string {
  return createHash('sha256')
    .update('aisy.durable-delegation.operation-binding.v1\0', 'utf8')
    .update(sortedJson(value.identity.binding), 'utf8')
    .digest('hex')
}

function v2ControlBinding(
  journal: DurableDelegationOperationJournalV2,
  value: DelegationExecutionAuthorityV1,
  limits: Readonly<{ iterations: number; spendUsdNanos: number }> = {
    iterations: 100,
    spendUsdNanos: 1_000,
  },
): DurableDelegationOperationControlBindingV1 {
  const bindingHash = v2BindingHash(value)
  const scopes = deriveDurableDelegationOperationControlScopeHashesV1({
    installationHash: CONTROL_INSTALLATION,
    runRootHash: journal.runRootHash,
    bindingHash,
    taskId: value.identity.taskId,
    dailyEpoch: CONTROL_DAY,
  })
  const ceiling = (scopeHash: string, dailyEpoch?: string) => ({
    scopeHash,
    maximumIterations: limits.iterations,
    maximumSpendUsdNanos: limits.spendUsdNanos,
    ...(dailyEpoch === undefined ? {} : { dailyEpoch }),
  })
  return {
    schemaVersion: 1,
    runRootHash: journal.runRootHash,
    bindingHash,
    delegationId: value.identity.delegationId,
    taskId: value.identity.taskId,
    authorityHash: value.authorityHash,
    policyRevision: CONTROL_POLICY,
    ceilings: {
      task: ceiling(scopes.task),
      run: ceiling(scopes.run),
      global: ceiling(scopes.global),
      daily: ceiling(scopes.daily, CONTROL_DAY),
    },
  }
}

function v2Control(
  root: string,
  journal: DurableDelegationOperationJournalV2,
  value: DelegationExecutionAuthorityV1,
  limits?: Readonly<{ iterations: number; spendUsdNanos: number }>,
): Readonly<{
  owner: DurableDelegationOperationControlV1
  bound: DurableDelegationBoundOperationControlV1
  attestation: DurableDelegationBoundOperationControlAttestationV1
}> {
  const owner = makeNodeDurableDelegationOperationControlV1({
    root,
    installationHash: CONTROL_INSTALLATION,
    policyRevision: CONTROL_POLICY,
    dailyEpoch: CONTROL_DAY,
  })
  operationControls.push(owner)
  const bound = owner.bindTask(v2ControlBinding(journal, value, limits))
  return Object.freeze({ owner, bound, attestation: owner.attestBoundTask(bound) })
}

function v2Deps(input: Readonly<{
  root: string
  authority?: DelegationExecutionAuthorityV1
  journal?: DurableDelegationOperationJournalV2
  control?: DurableDelegationBoundOperationControlV1
  controlAttestation?: DurableDelegationBoundOperationControlAttestationV1
  limits?: Readonly<{ iterations: number; spendUsdNanos: number }>
  providerStart?: DurableDelegationLiveAdapterInputV2['provider']['start']
  toolStart?: DurableDelegationLiveAdapterInputV2['tool']['start']
  providerQuote?: DurableDelegationLiveAdapterInputV2['quotes']['provider']
  toolQuote?: DurableDelegationLiveAdapterInputV2['quotes']['tool']
  onAmbiguity?: DurableDelegationLiveAdapterInputV2['onAmbiguity']
  resolveAmbiguity?: DurableDelegationLiveAdapterInputV2['resolveAmbiguity']
  verifier?: DurableDelegationLiveAdapterInputV2['verifier']
}>): DurableDelegationLiveAdapterInputV2 {
  const resolvedAuthority = input.authority ?? authority()
  const journal = input.journal ?? makeNodeDurableDelegationOperationJournalV2({
    runRoot: input.root,
  })
  const createdControl = input.control === undefined
    ? v2Control(input.root, journal, resolvedAuthority, input.limits)
    : undefined
  const bound = input.control ?? createdControl!.bound
  const attestation = input.controlAttestation ?? createdControl?.attestation
  if (attestation === undefined) throw new Error('V2 control attestation is required by the test')
  return {
    journal,
    control: bound,
    controlAttestation: attestation,
    authority: resolvedAuthority,
    authorityJournal: authorityJournal(resolvedAuthority),
    childTurnId: 'child-turn-1',
    providerIdentityHash: 'f'.repeat(64),
    policyRevision: CONTROL_POLICY,
    provider: Object.freeze({
      start: input.providerStart ?? (() => operation(providerFinalized(
        { reply: 'provider v2' },
        { spendUsdNanos: 40, inputTokens: 2, outputTokens: 3 },
      ))),
    }),
    tool: Object.freeze({
      start: input.toolStart ?? (() => operation(toolFinalized(
        { ok: true, output: 'tool v2' },
        { spendUsdNanos: 10 },
      ))),
    }),
    quotes: Object.freeze({
      provider: input.providerQuote ?? (() => ({ iterations: 1, spendUsdNanos: 100 })),
      tool: input.toolQuote ?? (() => ({ iterations: 0, spendUsdNanos: 100 })),
    }),
    onAmbiguity: input.onAmbiguity ?? (() => {}),
    resolveAmbiguity: input.resolveAmbiguity ?? (() => undefined),
    verifier: input.verifier ?? (async () => ({ verified: false, reasonCode: 'EVIDENCE_MISSING' })),
  }
}

const memory: MemoryPort = {
  snapshot: async () => ({
    prefixBytes: new Uint8Array(),
    prefixHash: 'prefix',
    breakpoints: [],
    takenAt: '2026-08-10T00:00:00.000Z',
  }),
  forget: async () => {},
}
const guardian: LoopGuardian = { observe: () => ({ trip: false }), note: () => {} }
const sessionLog: SessionLog = { append: () => {}, resume: () => null }

async function genuineContext(
  call: ToolCall,
  signal?: AbortSignal,
  turnId: string | null = 'child-turn-1',
): Promise<ToolExecutionContext> {
  let seen: ToolExecutionContext | undefined
  let modelCall = 0
  const runner = makeAgentRunner({
    provider: {
      complete: async () => {
        modelCall += 1
        return modelCall === 1
          ? { reply: '', toolCalls: [call] }
          : { reply: 'done', toolCalls: [] }
      },
    },
    memory,
    grants: makeGrantStore(),
    grantBinding: BINDING,
    executeTool: async (_call, context) => {
      seen = context
      return { ok: true, output: 'captured' }
    },
    approve: async () => ({ decision: 'confirmed' }),
    guardian,
    sessionLog,
  })
  await runner.handle({
    sessionId: 'd-worker',
    ...(turnId === null ? {} : { turnId }),
    spans: [{ role: 'user', provenance: 'operator', text: 'use tool' }],
    ...(signal === undefined ? {} : { signal }),
  })
  if (seen === undefined) throw new Error('context was not captured')
  return seen
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toEqual(new DurableDelegationLiveAdapterError(code as never))
}

async function expectAmbiguous(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    kind: 'durable-delegation-recoverable-interruption',
    code: 'DELEGATION_OPERATION_AMBIGUOUS',
  })
}

describe('dormant durable delegation provider/tool adapter', () => {
  it('replays one settled provider result across a fresh controller without a second call', async () => {
    const root = runRoot()
    let externalCalls = 0
    const progress = vi.fn()
    const signal = new AbortController().signal
    let seenSignal: AbortSignal | undefined
    let seenProgress: ModelProgressSink | undefined
    const first = makeDurableDelegationLiveAdapterV1(deps({
      root,
      providerStart: (_request, actualSignal, actualProgress) => {
        externalCalls += 1
        seenSignal = actualSignal
        seenProgress = actualProgress
        return operation(providerFinalized({
          reply: 'private provider response',
          usage: { inputTokens: 999, outputTokens: 999, dollars: 999 },
        }, {
          spendUsdNanos: 300_000_000,
          wallMs: 7,
          inputTokens: 10,
          outputTokens: 4,
        }))
      },
    }))

    const completed = await first.provider.complete(request(), signal, progress)
    expect(completed.reply).toBe('private provider response')
    expect(completed.usage).toEqual({ inputTokens: 10, outputTokens: 4, dollars: 0.3 })
    expect(seenSignal).toBe(signal)
    expect(seenProgress).toBe(progress)
    expect(first.readCost()).toEqual({ iterations: 1, spendUsd: 0.3, wallMs: 7 })

    const restarted = makeDurableDelegationLiveAdapterV1(deps({
      root,
      providerStart: () => {
        externalCalls += 1
        throw new Error('must not call provider on replay')
      },
    }))
    await expect(restarted.provider.complete(request())).resolves.toEqual(completed)
    expect(restarted.readCost()).toEqual({ iterations: 1, spendUsd: 0.3, wallMs: 7 })
    expect(externalCalls).toBe(1)
  })

  it('replays a tool result and forwards the genuine Core context unchanged', async () => {
    const root = runRoot()
    const call: ToolCall = { name: 'read_file', args: { path: 'src/a.ts' } }
    const context = await genuineContext(call)
    let seenContext: ToolExecutionContext | undefined
    let externalCalls = 0
    const first = makeDurableDelegationLiveAdapterV1(deps({
      root,
      toolStart: (_call, actualContext) => {
        externalCalls += 1
        seenContext = actualContext
        return operation(toolFinalized({ ok: true, output: 'private file body' }))
      },
    }))
    await expect(first.executeTool(call, context)).resolves.toEqual({
      ok: true,
      output: 'private file body',
    })
    expect(seenContext).toBe(context)

    const restarted = makeDurableDelegationLiveAdapterV1(deps({
      root,
      toolStart: () => {
        externalCalls += 1
        throw new Error('must not execute tool on replay')
      },
    }))
    await expect(restarted.executeTool(call, context)).resolves.toEqual({
      ok: true,
      output: 'private file body',
    })
    expect(externalCalls).toBe(1)
  })

  it.each<{
    name: string
    request?: ModelRequest
    policyRevision?: string
    providerIdentityHash?: string
  }>([
    { name: 'request', request: request('changed request') },
    { name: 'policy', policyRevision: 'changed-policy-v2' },
    { name: 'provider identity', providerIdentityHash: 'd'.repeat(64) },
  ])('rejects $name drift at the same operation slot before external I/O', async changed => {
    const root = runRoot()
    const first = makeDurableDelegationLiveAdapterV1(deps({ root }))
    await first.provider.complete(request())
    let externalCalls = 0
    const restarted = makeDurableDelegationLiveAdapterV1(deps({
      root,
      ...(changed.policyRevision === undefined ? {} : { policyRevision: changed.policyRevision }),
      ...(changed.providerIdentityHash === undefined
        ? {}
        : { providerIdentityHash: changed.providerIdentityHash }),
      providerStart: () => {
        externalCalls += 1
        return operation(providerFinalized({ reply: 'must not run' }))
      },
    }))
    await expectCode(
      restarted.provider.complete(changed.request ?? request()),
      'DURABLE_DELEGATION_LIVE_OPERATION_DRIFT',
    )
    expect(externalCalls).toBe(0)
  })

  it('rejects binding and authority drift against the sealed shard before external I/O', async () => {
    const root = runRoot()
    const original = authority()
    const first = makeDurableDelegationLiveAdapterV1(deps({ root, authority: original }))
    await first.provider.complete(request())
    const foreign = authority({ ...BINDING, projectId: 'project-b' })
    let externalCalls = 0
    const restarted = makeDurableDelegationLiveAdapterV1(deps({
      root,
      authority: foreign,
      journalAuthority: original,
      providerStart: () => {
        externalCalls += 1
        return operation(providerFinalized({ reply: 'must not run' }))
      },
    }))
    await expectCode(
      restarted.provider.complete(request()),
      'DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID',
    )
    expect(externalCalls).toBe(0)
  })

  it('requires the exact child session/turn for provider and genuine tool contexts before prepare', async () => {
    const root = runRoot()
    let externalCalls = 0
    const adapter = makeDurableDelegationLiveAdapterV1(deps({
      root,
      providerStart: () => {
        externalCalls += 1
        return operation(providerFinalized({ reply: 'must not run' }))
      },
      toolStart: () => {
        externalCalls += 1
        return operation(toolFinalized({ ok: true, output: 'must not run' }))
      },
    }))
    const completeRequest = request()
    const missingTurn: ModelRequest = {
      sessionId: completeRequest.sessionId,
      prefixBytes: completeRequest.prefixBytes,
      spans: completeRequest.spans,
    }
    await expectCode(
      adapter.provider.complete(missingTurn),
      'DURABLE_DELEGATION_LIVE_CONTEXT_INVALID',
    )
    await expectCode(
      adapter.provider.complete({ ...request(), turnId: 'foreign-turn' }),
      'DURABLE_DELEGATION_LIVE_CONTEXT_INVALID',
    )
    await expectCode(
      adapter.provider.complete({ ...request(), sessionId: 'foreign-child' }),
      'DURABLE_DELEGATION_LIVE_CONTEXT_INVALID',
    )

    const call: ToolCall = { name: 'read_file', args: { path: 'src/a.ts' } }
    const missingToolTurn = await genuineContext(call, undefined, null)
    const wrongToolTurn = await genuineContext(call, undefined, 'foreign-turn')
    await expectCode(
      adapter.executeTool(call, missingToolTurn),
      'DURABLE_DELEGATION_LIVE_CONTEXT_INVALID',
    )
    await expectCode(
      adapter.executeTool(call, wrongToolTurn),
      'DURABLE_DELEGATION_LIVE_CONTEXT_INVALID',
    )
    expect(externalCalls).toBe(0)
    expect(readdirSync(join(root, 'operations'))).toEqual([])
  })

  it('turns a crash-left prepared provider call into stable ambiguity without retry', async () => {
    const root = runRoot()
    let calls = 0
    const first = makeDurableDelegationLiveAdapterV1(deps({
      root,
      providerStart: () => {
        calls += 1
        return operation(Promise.reject(new Error('process lost response')))
      },
    }))
    await expectAmbiguous(first.provider.complete(request()))
    const restarted = makeDurableDelegationLiveAdapterV1(deps({
      root,
      providerStart: () => {
        calls += 1
        return operation(providerFinalized({ reply: 'must not retry' }))
      },
    }))
    await expectAmbiguous(restarted.provider.complete(request()))
    expect(calls).toBe(1)
  })

  it('never treats a provider output without a separate code-owned receipt as zero cost', async () => {
    const root = runRoot()
    let calls = 0
    const adapter = makeDurableDelegationLiveAdapterV1(deps({
      root,
      providerStart: () => {
        calls += 1
        return operation({ output: { reply: 'missing receipt' } } as never)
      },
    }))
    await expectAmbiguous(adapter.provider.complete(request()))
    expect(adapter.readCost()).toEqual({ iterations: 0, spendUsd: 0, wallMs: 0 })
    const restarted = makeDurableDelegationLiveAdapterV1(deps({
      root,
      providerStart: () => {
        calls += 1
        return operation(providerFinalized({ reply: 'must not retry' }))
      },
    }))
    await expectAmbiguous(restarted.provider.complete(request()))
    expect(calls).toBe(1)
  })

  it('waits for cleanup on abort but conservatively leaves a dispatched call ambiguous', async () => {
    const root = runRoot()
    const controller = new AbortController()
    let cleanupFinished = false
    let releaseCancel: (() => void) | undefined
    const cancelFinished = new Promise<void>(resolve => { releaseCancel = resolve })
    const pending = new Promise<DurableDelegationProviderFinalizedV1>(() => {})
    const adapter = makeDurableDelegationLiveAdapterV1(deps({
      root,
      providerStart: (_request, signal) => {
        expect(signal).toBe(controller.signal)
        queueMicrotask(() => controller.abort())
        return operation(pending, async () => {
          await cancelFinished
          cleanupFinished = true
          return makeDurableDelegationStoppedAckV1({ spendUsdNanos: 0, wallMs: 3 })
        })
      },
    }))
    const completion = adapter.provider.complete(request(), controller.signal)
    await Promise.resolve()
    expect(cleanupFinished).toBe(false)
    releaseCancel?.()
    await expectAmbiguous(completion)
    expect(cleanupFinished).toBe(true)
  })

  it('distinguishes an already stopped pre-dispatch call and performs no external I/O', async () => {
    const root = runRoot()
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const adapter = makeDurableDelegationLiveAdapterV1(deps({
      root,
      providerStart: () => {
        calls += 1
        return operation(providerFinalized({ reply: 'must not run' }))
      },
    }))
    await expectCode(
      adapter.provider.complete(request(), controller.signal),
      'DURABLE_DELEGATION_LIVE_OPERATION_STOPPED',
    )
    expect(calls).toBe(0)
  })

  it('keeps a late-aborted external result settled and replays its real receipt', async () => {
    const root = runRoot()
    const controller = new AbortController()
    let externalCalls = 0
    const base = deps({
      root,
      providerStart: () => {
        externalCalls += 1
        return operation(providerFinalized({ reply: 'effect completed' }, {
          spendUsdNanos: 125_000_000,
          wallMs: 9,
          inputTokens: 2,
          outputTokens: 1,
        }))
      },
    })
    const journal = base.journal
    const settle = journal.settle
    const abortAfterSettle = Object.freeze({
      runRootHash: journal.runRootHash,
      inspect: journal.inspect,
      prepare: journal.prepare,
      settle(permit: Parameters<typeof settle>[0], outcome: Parameters<typeof settle>[1]) {
        const result = settle(permit, outcome)
        controller.abort()
        return result
      },
    })
    const first = makeDurableDelegationLiveAdapterV1({ ...base, journal: abortAfterSettle })
    await expect(first.provider.complete(request(), controller.signal)).resolves.toMatchObject({
      reply: 'effect completed',
      usage: { inputTokens: 2, outputTokens: 1, dollars: 0.125 },
    })
    expect(first.readCost()).toEqual({ iterations: 1, spendUsd: 0.125, wallMs: 9 })

    const restarted = makeDurableDelegationLiveAdapterV1(deps({
      root,
      providerStart: () => {
        externalCalls += 1
        return operation(providerFinalized({ reply: 'must not repeat' }))
      },
    }))
    await expect(restarted.provider.complete(request())).resolves.toMatchObject({
      reply: 'effect completed',
      usage: { inputTokens: 2, outputTokens: 1, dollars: 0.125 },
    })
    expect(restarted.readCost()).toEqual({ iterations: 1, spendUsd: 0.125, wallMs: 9 })
    expect(externalCalls).toBe(1)
  })

  it('feeds the verifier only sealed hash/cost/effect evidence and refuses unresolved state', async () => {
    const root = runRoot()
    const call: ToolCall = { name: 'write_file', args: { path: 'src/a.ts', content: 'secret-value' } }
    const context = await genuineContext(call)
    let verifierInput: DurableDelegationVerifierInputV1 | undefined
    const adapter = makeDurableDelegationLiveAdapterV1(deps({
      root,
      providerStart: () => operation(providerFinalized({
        reply: 'private-provider-body',
      }, {
        spendUsdNanos: 750_000_000,
        inputTokens: 3,
        outputTokens: 2,
      })),
      toolStart: () => operation(toolFinalized(
        { ok: true, output: 'private-tool-body' },
        { effect: 'mutation', actionStatus: 'verified', evidenceHash: 'a'.repeat(64) },
      )),
      verifier: async input => {
        verifierInput = input
        return { verified: false, reasonCode: 'EVIDENCE_MISSING' }
      },
    }))
    await adapter.provider.complete(request())
    await adapter.executeTool(call, context)
    await adapter.verify({ summary: 'bounded candidate' })
    expect(verifierInput).toBeDefined()
    expect(verifierInput?.authorityHash).toBe(authority().authorityHash)
    expect(verifierInput?.shard[0]?.kind).toBe('runtime.agent-authority.v1')
    expect(Object.isFrozen(verifierInput?.shard)).toBe(true)
    expect(verifierInput?.cost).toEqual({ iterations: 1, spendUsd: 0.75, wallMs: 0 })
    expect(verifierInput?.operations.map(item => item.effect)).toEqual(['read', 'mutation'])
    const publicEvidence = JSON.stringify(verifierInput?.operations)
    expect(publicEvidence).not.toContain('private-provider-body')
    expect(publicEvidence).not.toContain('private-tool-body')
    expect(publicEvidence).not.toContain('secret-value')

    const unverifiedRoot = runRoot()
    let unverifiedVerifierCalls = 0
    const unverified = makeDurableDelegationLiveAdapterV1(deps({
      root: unverifiedRoot,
      toolStart: () => operation(toolFinalized(
        { ok: true, output: 'mutation result is private' },
        {
          effect: 'mutation',
          actionStatus: 'unverified',
        },
      )),
      verifier: async () => {
        unverifiedVerifierCalls += 1
        return { verified: false, reasonCode: 'EVIDENCE_MISSING' }
      },
    }))
    await unverified.executeTool(call, context)
    await expectCode(
      unverified.verify({ summary: 'must not pass' }),
      'DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED',
    )
    expect(unverifiedVerifierCalls).toBe(0)

    const ambiguousRoot = runRoot()
    let verifierCalls = 0
    const ambiguous = makeDurableDelegationLiveAdapterV1(deps({
      root: ambiguousRoot,
      providerStart: () => operation(Promise.reject(new Error('raw secret error'))),
      verifier: async () => {
        verifierCalls += 1
        return { verified: false, reasonCode: 'EVIDENCE_MISSING' }
      },
    }))
    await expectAmbiguous(ambiguous.provider.complete(request('raw secret request')))
    await expectCode(
      ambiguous.verify({ raw: 'candidate' }),
      'DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED',
    )
    expect(verifierCalls).toBe(0)
  })

  it('snapshots captured dependency methods and rejects structural copies, Proxy inputs and mutable calls', async () => {
    const root = runRoot()
    let originalCalls = 0
    let replacementCalls = 0
    const provider = {
      start: () => {
        originalCalls += 1
        return operation(providerFinalized({ reply: 'captured method' }))
      },
    }
    const input = { ...deps({ root }), provider }
    const adapter = makeDurableDelegationLiveAdapterV1(input)
    provider.start = () => {
      replacementCalls += 1
      return operation(providerFinalized({ reply: 'replacement' }))
    }
    await expect(adapter.provider.complete(request())).resolves.toMatchObject({ reply: 'captured method' })
    expect(originalCalls).toBe(1)
    expect(replacementCalls).toBe(0)

    expect(() => makeDurableDelegationLiveAdapterV1(new Proxy(deps({ root: runRoot() }), {})))
      .toThrowError(expect.objectContaining({ code: 'DURABLE_DELEGATION_LIVE_CONFIG_INVALID' }))
    const call: ToolCall = { name: 'read_file', args: { path: 'src/a.ts' } }
    const context = await genuineContext(call)
    const copy = { ...context }
    await expectCode(
      adapter.executeTool(call, copy),
      'DURABLE_DELEGATION_LIVE_CONTEXT_INVALID',
    )
    expect(() => makeDurableDelegationLiveAdapterV1({
      ...deps({ root: runRoot() }),
      authority: new Proxy(authority(), {}),
    })).toThrowError(expect.objectContaining({ code: 'DURABLE_DELEGATION_LIVE_CONFIG_INVALID' }))

    const proxyResultRoot = runRoot()
    let proxyResultCalls = 0
    const proxyResult = makeDurableDelegationLiveAdapterV1(deps({
      root: proxyResultRoot,
      providerStart: () => {
        proxyResultCalls += 1
        return Object.freeze({
          result: new Proxy(Promise.resolve(providerFinalized({ reply: 'must not escape' })), {}),
          cancel: async () => makeDurableDelegationAmbiguousAckV1(),
        })
      },
    }))
    await expectAmbiguous(proxyResult.provider.complete(request()))
    expect(proxyResultCalls).toBe(1)
  })

  it('keeps a preseeded ambiguous operation active across repeated runtime recovery', async () => {
    const root = runRoot()
    const manager = makeDelegationManager(PLAN, managerDeps(root))
    const handle = manager.spawn(TASK.taskId)
    const exactAuthority = authority()
    handle.append('runtime.agent-authority.v1', {
      schemaVersion: 1,
      authorityHash: exactAuthority.authorityHash,
    })
    const persistedAuthorityJournal = Object.freeze<DelegationAuthorityJournal>({
      appendAuthoritySeal: () => { throw new Error('already sealed') },
      shard: () => handle.shard(),
      verifyShardChain: () => manager.verifyShardChain(handle.delegationId),
    })
    const preseed = makeDurableDelegationLiveAdapterV1({
      ...deps({ root, authority: exactAuthority }),
      authorityJournal: persistedAuthorityJournal,
      provider: Object.freeze({
        start: () => operation(Promise.reject(new Error('crash after prepare'))),
      }),
    })
    await expectAmbiguous(preseed.provider.complete(request()))

    let providerCalls = 0
    let verifierCalls = 0
    let terminalMeterCalls = 0
    const makeRuntime = () => makeNodeDurableDelegationRuntime({
      runRoot: root,
      recoveryPolicy: 'resume-active-replay-terminal',
      maxConcurrency: 2,
      binding: BINDING,
      plan: PLAN,
      resolveCard: name => name === CARD.name ? CARD : undefined,
      skillTouchedPaths: () => [],
      mcpWritable: () => false,
      isBindingActive: () => true,
      runTask: (executionHandle, _task, signal) => {
        const adapter = makeDurableDelegationLiveAdapterV1({
          ...deps({ root, authority: exactAuthority }),
          authorityJournal: executionHandle.authorityJournal,
          provider: Object.freeze({
            start: () => {
              providerCalls += 1
              return operation(providerFinalized({ reply: 'must not dispatch' }))
            },
          }),
        })
        return runtimeOperation(adapter.provider.complete(request(), signal).then(response => ({
          summary: response.reply,
          result: response,
        })))
      },
      verify: () => {
        verifierCalls += 1
        return runtimeOperation({ verified: false, reasonCode: 'EVIDENCE_MISSING' as const })
      },
      readCost: async ({ phase }) => {
        if (phase === 'terminal') terminalMeterCalls += 1
        return { iterations: 0, spendUsd: 0, wallMs: 0 }
      },
    })

    await expect(makeRuntime().execute()).rejects.toMatchObject({
      code: 'DELEGATION_OPERATION_AMBIGUOUS',
    })
    expect(providerCalls).toBe(0)
    expect(verifierCalls).toBe(0)
    expect(terminalMeterCalls).toBe(0)
    const firstState = makeNodeDelegationPersistence({ runRoot: root }).loadRun() as {
      activeTaskIds: string[]
      completedTaskIds: string[]
      failedTaskIds: string[]
    }
    expect(firstState.activeTaskIds).toEqual([TASK.taskId])
    expect(firstState.completedTaskIds).toEqual([])
    expect(firstState.failedTaskIds).toEqual([])

    await expect(makeRuntime().execute()).rejects.toMatchObject({
      code: 'DELEGATION_OPERATION_AMBIGUOUS',
    })
    expect(providerCalls).toBe(0)
    expect(verifierCalls).toBe(0)
    expect(terminalMeterCalls).toBe(0)
    const restartedState = makeNodeDelegationPersistence({ runRoot: root }).loadRun() as {
      activeTaskIds: string[]
      completedTaskIds: string[]
      failedTaskIds: string[]
    }
    expect(restartedState.activeTaskIds).toEqual([TASK.taskId])
    expect(restartedState.completedTaskIds).toEqual([])
    expect(restartedState.failedTaskIds).toEqual([])
  })

  it('is absent from production importers and emits code-only errors', async () => {
    const packageRoot = realpathSync(join(import.meta.dirname, '..'))
    for (const relative of ['src/bin/aisy.ts', 'src/bot.ts']) {
      expect(readFileSync(join(packageRoot, relative), 'utf8'))
        .not.toContain('durable-delegation-live-adapter')
    }
    const root = runRoot()
    const adapter = makeDurableDelegationLiveAdapterV1(deps({
      root,
      providerStart: () => operation(Promise.reject(new Error('credential=private-value'))),
    }))
    try {
      await adapter.provider.complete(request('operator secret'))
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toMatchObject({
        kind: 'durable-delegation-recoverable-interruption',
        code: 'DELEGATION_OPERATION_AMBIGUOUS',
      })
      expect(String(error)).not.toContain('credential=private-value')
      expect(String(error)).not.toContain('operator secret')
    }
  })
})

describe('dormant durable delegation provider/tool adapter V2', () => {
  it('keeps AgentLoop ordinal state hashable while reattaching pre-effect authority only to dispatch', async () => {
    const root = runRoot()
    const attempts: number[] = []
    const modelRequest: ModelRequest = { ...request(), toolOrdinalBase: 7 }
    Object.defineProperty(modelRequest, 'markToolAttempt', {
      value: async (ordinal: number) => { attempts.push(ordinal) },
      enumerable: false,
    })
    const adapter = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      providerQuote: quoted => {
        expect(quoted.toolOrdinalBase).toBe(7)
        expect(Object.hasOwn(quoted, 'markToolAttempt')).toBe(false)
        return { iterations: 1, spendUsdNanos: 100 }
      },
      providerStart: dispatched => {
        expect(dispatched.toolOrdinalBase).toBe(7)
        expect(Object.getOwnPropertyDescriptor(dispatched, 'markToolAttempt'))
          .toMatchObject({ enumerable: false })
        return operation((async () => {
          await dispatched.markToolAttempt?.(8)
          return providerFinalized({ reply: 'provider-owned tool completed' })
        })())
      },
    }))

    await expect(adapter.provider.complete(modelRequest)).resolves.toMatchObject({
      reply: 'provider-owned tool completed',
    })
    expect(attempts).toEqual([8])
  })

  it('holds budget and persists prepared intent before the first external call', async () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const { bound, attestation } = v2Control(root, journal, resolvedAuthority)
    let externalCalls = 0
    const adapter = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: bound,
      controlAttestation: attestation,
      providerStart: () => {
        externalCalls += 1
        expect(bound.snapshot().slots[0]?.attempts[0]).toMatchObject({
          budgetState: 'held',
          preparedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        })
        expect(journal.scan().entries).toMatchObject([{ state: 'ambiguous' }])
        return operation(providerFinalized(
          { reply: 'ordered' },
          { spendUsdNanos: 40, inputTokens: 2, outputTokens: 3 },
        ))
      },
    }))

    await expect(adapter.provider.complete(request())).resolves.toMatchObject({ reply: 'ordered' })
    expect(externalCalls).toBe(1)
    expect(bound.snapshot().slots[0]?.attempts[0]).toMatchObject({
      budgetState: 'charged',
      ambiguous: false,
      receipt: { iterations: 1, spendUsdNanos: 40 },
    })
    expect(adapter.readCost()).toMatchObject({ iterations: 1, wallMs: 0 })
  })

  it('refuses a missing quote and a denied hold before touching the provider port', async () => {
    const missingRoot = runRoot()
    let missingCalls = 0
    const missing = makeDurableDelegationLiveAdapterV2(v2Deps({
      root: missingRoot,
      providerQuote: () => undefined,
      providerStart: () => {
        missingCalls += 1
        return operation(providerFinalized({ reply: 'must not run' }))
      },
    }))
    await expectCode(
      missing.provider.complete(request()),
      'DURABLE_DELEGATION_LIVE_QUOTE_REQUIRED',
    )
    expect(missingCalls).toBe(0)

    const deniedRoot = runRoot()
    let deniedCalls = 0
    const denied = makeDurableDelegationLiveAdapterV2(v2Deps({
      root: deniedRoot,
      limits: { iterations: 0, spendUsdNanos: 0 },
      providerStart: () => {
        deniedCalls += 1
        return operation(providerFinalized({ reply: 'must not run' }))
      },
    }))
    await expect(denied.provider.complete(request())).rejects.toMatchObject({
      code: 'DELEGATION_OPERATION_CONTROL_BUDGET_DENIED',
    })
    expect(deniedCalls).toBe(0)
  })

  it('hydrates a journal settlement after a crash before control reconciliation', async () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const firstControl = v2Control(root, journal, resolvedAuthority)
    let firstCalls = 0
    const crashing = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: firstControl.bound,
      controlAttestation: firstControl.attestation,
      providerStart: () => {
        firstCalls += 1
        return operation(Promise.resolve(providerFinalized(
          { reply: 'durable result' },
          { spendUsdNanos: 40, inputTokens: 1, outputTokens: 1 },
        )).then(value => {
          firstControl.owner.close()
          operationControls.splice(operationControls.indexOf(firstControl.owner), 1)
          return value
        }))
      },
    }))
    await expectAmbiguous(crashing.provider.complete(request()))
    expect(firstCalls).toBe(1)
    expect(journal.scan().entries).toMatchObject([{ state: 'settled' }])

    const resumedControl = v2Control(root, journal, resolvedAuthority)
    let resumedCalls = 0
    const resumed = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: resumedControl.bound,
      controlAttestation: resumedControl.attestation,
      providerStart: () => {
        resumedCalls += 1
        return operation(providerFinalized({ reply: 'duplicate' }))
      },
    }))
    await expect(resumed.provider.complete(request())).resolves.toMatchObject({
      reply: 'durable result',
    })
    expect(resumedCalls).toBe(0)
    expect(resumedControl.bound.readCost()).toEqual({
      iterations: 1,
      spendUsdNanos: 40,
      wallMs: 0,
    })
  })

  it('resumes the exact attempt-one pre-permit crash without inventing a retry', async () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const firstControl = v2Control(root, journal, resolvedAuthority)
    let firstPorts = 0
    const prePermitCrashJournal: DurableDelegationOperationJournalV2 = Object.freeze({
      runRootHash: journal.runRootHash,
      scan: () => journal.scan(),
      inspect: (key: Parameters<DurableDelegationOperationJournalV2['inspect']>[0]) =>
        journal.inspect(key),
      prepare: () => { throw new Error('crash before journal permit') },
      settle: (
        permit: Parameters<DurableDelegationOperationJournalV2['settle']>[0],
        outcome: Parameters<DurableDelegationOperationJournalV2['settle']>[1],
      ) => journal.settle(permit, outcome),
    })
    const crashing = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal: prePermitCrashJournal,
      control: firstControl.bound,
      controlAttestation: firstControl.attestation,
      providerStart: () => {
        firstPorts += 1
        return operation(providerFinalized({ reply: 'must not run' }))
      },
    }))
    await expectAmbiguous(crashing.provider.complete(request()))
    expect(firstPorts).toBe(0)
    expect(journal.scan().entries).toHaveLength(0)
    expect(firstControl.bound.snapshot().slots[0]?.attempts[0]).toMatchObject({
      attempt: 1,
      budgetState: 'held',
      ambiguous: false,
      preparedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })

    firstControl.owner.close()
    operationControls.splice(operationControls.indexOf(firstControl.owner), 1)
    const resumedControl = v2Control(root, journal, resolvedAuthority)
    expect(resumedControl.bound.snapshot().slots[0]?.attempts[0]).toMatchObject({
      attempt: 1,
      budgetState: 'held',
      ambiguous: true,
    })
    let resumedPorts = 0
    let verifierCalls = 0
    const resumed = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: resumedControl.bound,
      controlAttestation: resumedControl.attestation,
      verifier: async () => {
        verifierCalls += 1
        return { verified: false, reasonCode: 'EVIDENCE_MISSING' }
      },
      providerStart: () => {
        resumedPorts += 1
        return operation(providerFinalized(
          { reply: 'safe attempt one' },
          { spendUsdNanos: 20 },
        ))
      },
    }))
    await expect(resumed.provider.complete(request())).resolves.toMatchObject({
      reply: 'safe attempt one',
    })
    expect(resumedPorts).toBe(1)
    expect(verifierCalls).toBe(0)
    expect(journal.scan().entries.map(entry => entry.key.attempt)).toEqual([1])
    expect(resumedControl.bound.snapshot().slots[0]?.attempts).toMatchObject([{
      attempt: 1,
      budgetState: 'charged',
      ambiguous: false,
    }])
  })

  it('resumes an exact attempt-two pre-permit crash only behind its consumed retry', async () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const firstControl = v2Control(root, journal, resolvedAuthority)
    let firstAttemptPorts = 0
    const first = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: firstControl.bound,
      controlAttestation: firstControl.attestation,
      providerStart: () => {
        firstAttemptPorts += 1
        return operation(Promise.reject(new Error('ambiguous first attempt')))
      },
    }))
    await expectAmbiguous(first.provider.complete(request()))
    expect(firstAttemptPorts).toBe(1)
    expect(journal.scan().entries.map(entry => entry.key.attempt)).toEqual([1])

    const retryCrashJournal: DurableDelegationOperationJournalV2 = Object.freeze({
      runRootHash: journal.runRootHash,
      scan: () => journal.scan(),
      inspect: (key: Parameters<DurableDelegationOperationJournalV2['inspect']>[0]) =>
        journal.inspect(key),
      prepare: (key: Parameters<DurableDelegationOperationJournalV2['prepare']>[0]) => {
        if (key.attempt === 2) throw new Error('crash before attempt-two journal permit')
        return journal.prepare(key)
      },
      settle: (
        permit: Parameters<DurableDelegationOperationJournalV2['settle']>[0],
        outcome: Parameters<DurableDelegationOperationJournalV2['settle']>[1],
      ) => journal.settle(permit, outcome),
    })
    let retryPortsBeforeCrash = 0
    const retrying = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal: retryCrashJournal,
      control: firstControl.bound,
      controlAttestation: firstControl.attestation,
      resolveAmbiguity: resolution =>
        makeDurableDelegationOperationResolutionAuthorityV1({
          runRootHash: resolution.runRootHash,
          taskId: resolution.taskId,
          logicalSlotHash: resolution.controlLogicalSlotHash,
          ambiguousAttempt: 1,
          decision: 'retry-once',
          resolutionHash: 'c'.repeat(64),
        }),
      providerStart: () => {
        retryPortsBeforeCrash += 1
        return operation(providerFinalized({ reply: 'must not run before permit' }))
      },
    }))
    await expectAmbiguous(retrying.provider.complete(request()))
    expect(retryPortsBeforeCrash).toBe(0)
    expect(journal.scan().entries.map(entry => entry.key.attempt)).toEqual([1])

    firstControl.owner.close()
    operationControls.splice(operationControls.indexOf(firstControl.owner), 1)
    const resumedControl = v2Control(root, journal, resolvedAuthority)
    expect(resumedControl.bound.snapshot().slots[0]).toMatchObject({
      resolution: { decision: 'retry-once', consumed: true, resolutionHash: 'c'.repeat(64) },
      attempts: [
        { attempt: 1, ambiguous: true },
        { attempt: 2, budgetState: 'held', ambiguous: true },
      ],
    })
    let resumedPorts = 0
    const resumed = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: resumedControl.bound,
      controlAttestation: resumedControl.attestation,
      providerStart: () => {
        resumedPorts += 1
        return operation(providerFinalized(
          { reply: 'safe attempt two' },
          { spendUsdNanos: 20 },
        ))
      },
    }))
    await expect(resumed.provider.complete(request())).resolves.toMatchObject({
      reply: 'safe attempt two',
    })
    expect(resumedPorts).toBe(1)
    expect(journal.scan().entries.map(entry => entry.key.attempt)).toEqual([1, 2])
    expect(resumedControl.bound.snapshot().slots[0]?.attempts).toHaveLength(2)
  })

  it('pauses an ambiguous attempt, consumes one manager retry, and never creates attempt three', async () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const controlState = v2Control(root, journal, resolvedAuthority)
    let calls = 0
    const first = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      providerStart: () => {
        calls += 1
        return operation(Promise.reject(new Error('crash after dispatch')))
      },
    }))
    await expectAmbiguous(first.provider.complete(request()))

    const retried = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      resolveAmbiguity: resolution =>
        makeDurableDelegationOperationResolutionAuthorityV1({
          runRootHash: resolution.runRootHash,
          taskId: resolution.taskId,
          logicalSlotHash: resolution.controlLogicalSlotHash,
          ambiguousAttempt: resolution.attempt,
          decision: 'retry-once',
          resolutionHash: 'd'.repeat(64),
        }),
      providerStart: () => {
        calls += 1
        return operation(providerFinalized(
          { reply: 'second attempt' },
          { spendUsdNanos: 30, inputTokens: 1, outputTokens: 1 },
        ))
      },
    }))
    await expect(retried.provider.complete(request())).resolves.toMatchObject({
      reply: 'second attempt',
    })
    expect(calls).toBe(2)
    expect(journal.scan().entries.map(entry => entry.key.attempt)).toEqual([1, 2])
    expect(controlState.bound.snapshot().slots[0]?.attempts).toHaveLength(2)
  })

  it('requires a new explicit task for an ambiguous mutation tool', async () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const controlState = v2Control(root, journal, resolvedAuthority)
    const call: ToolCall = { name: 'write_file', args: { path: 'result.txt', content: 'exact' } }
    const context = await genuineContext(call)
    let toolCalls = 0
    const pauses: DurableDelegationResolutionRequestV2[] = []
    const first = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      toolQuote: () => ({
        iterations: 0,
        spendUsdNanos: 0,
        retryClass: 'new-task-only',
      }),
      onAmbiguity: request => { pauses.push(request) },
      toolStart: () => {
        toolCalls += 1
        return operation(Promise.reject(new Error('mutation result lost')))
      },
    }))
    await expect(first.executeTool(call, context)).rejects.toMatchObject({
      kind: 'durable-delegation-recoverable-interruption',
      code: 'DELEGATION_MANUAL_RECOVERY_REQUIRED',
    })

    let resolutionCalls = 0
    const resumed = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      toolQuote: () => ({
        iterations: 0,
        spendUsdNanos: 0,
        retryClass: 'new-task-only',
      }),
      resolveAmbiguity: () => {
        resolutionCalls += 1
        return undefined
      },
      toolStart: () => {
        toolCalls += 1
        return operation(toolFinalized({ ok: true, output: 'must not repeat' }))
      },
    }))
    await expect(resumed.executeTool(call, context)).rejects.toMatchObject({
      kind: 'durable-delegation-recoverable-interruption',
      code: 'DELEGATION_MANUAL_RECOVERY_REQUIRED',
    })
    expect(controlState.bound.snapshot().slots[0]).toMatchObject({
      retryClass: 'new-task-only',
      attempts: [{ attempt: 1, ambiguous: true }],
    })
    expect(resolutionCalls).toBe(0)
    expect(toolCalls).toBe(1)
    expect(pauses).toEqual([expect.objectContaining({
      phase: 'tool', ordinal: 1, attempt: 1, retryClass: 'new-task-only',
    })])
  })

  it('denies an ambiguity retry whose second hold would exceed the exact ceiling', async () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const controlState = v2Control(root, journal, resolvedAuthority, {
      iterations: 1,
      spendUsdNanos: 100,
    })
    let calls = 0
    const first = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      providerStart: () => {
        calls += 1
        return operation(Promise.reject(new Error('ambiguous first attempt')))
      },
    }))
    await expectAmbiguous(first.provider.complete(request()))

    const denied = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      resolveAmbiguity: resolution =>
        makeDurableDelegationOperationResolutionAuthorityV1({
          runRootHash: resolution.runRootHash,
          taskId: resolution.taskId,
          logicalSlotHash: resolution.controlLogicalSlotHash,
          ambiguousAttempt: 1,
          decision: 'retry-once',
          resolutionHash: 'b'.repeat(64),
        }),
      providerStart: () => {
        calls += 1
        return operation(providerFinalized({ reply: 'must not run' }))
      },
    }))
    await expect(denied.provider.complete(request())).rejects.toMatchObject({
      code: 'DELEGATION_OPERATION_CONTROL_BUDGET_DENIED',
    })
    expect(calls).toBe(1)
    expect(journal.scan().entries.map(entry => entry.key.attempt)).toEqual([1])
    expect(controlState.bound.snapshot().slots[0]?.attempts).toHaveLength(1)
  })

  it('turns manager cancellation into a conservative hold without another port call', async () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const controlState = v2Control(root, journal, resolvedAuthority)
    let calls = 0
    const first = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      providerStart: () => {
        calls += 1
        return operation(Promise.reject(new Error('ambiguous')))
      },
    }))
    await expectAmbiguous(first.provider.complete(request()))

    const cancelled = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      resolveAmbiguity: resolution =>
        makeDurableDelegationOperationResolutionAuthorityV1({
          runRootHash: resolution.runRootHash,
          taskId: resolution.taskId,
          logicalSlotHash: resolution.controlLogicalSlotHash,
          ambiguousAttempt: resolution.attempt,
          decision: 'cancel',
          resolutionHash: 'e'.repeat(64),
        }),
      providerStart: () => {
        calls += 1
        return operation(providerFinalized({ reply: 'must not run' }))
      },
    }))
    await expectCode(
      cancelled.provider.complete(request()),
      'DURABLE_DELEGATION_LIVE_OPERATION_STOPPED',
    )
    expect(calls).toBe(1)
    expect(controlState.bound.snapshot().slots[0]?.attempts[0]?.budgetState)
      .toBe('conservative')

    let repeatedResolutionCalls = 0
    const restarted = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      resolveAmbiguity: () => {
        repeatedResolutionCalls += 1
        return undefined
      },
      providerStart: () => {
        calls += 1
        return operation(providerFinalized({ reply: 'must still not run' }))
      },
    }))
    await expectCode(
      restarted.provider.complete(request()),
      'DURABLE_DELEGATION_LIVE_OPERATION_STOPPED',
    )
    expect(repeatedResolutionCalls).toBe(0)
    expect(calls).toBe(1)
  })

  it('rejects tool ordinal drift and seals exact inventory before verification', async () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const controlState = v2Control(root, journal, resolvedAuthority)
    let verifierCalls = 0
    const adapter = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      verifier: async input => {
        verifierCalls += 1
        expect(input.schemaVersion).toBe(2)
        expect(input.operations).toHaveLength(1)
        expect(controlState.bound.snapshot().state).toBe('open')
        return {
          verified: true,
          evidenceId: 'evidence-v2',
          summary: 'verified',
          result: { ok: true },
        }
      },
    }))
    await adapter.provider.complete(request())
    await adapter.verify({ answer: 'candidate' })
    expect(verifierCalls).toBe(1)
    expect(controlState.bound.snapshot().state).toBe('sealed')

    const toolRoot = runRoot()
    let toolCalls = 0
    const toolAdapter = makeDurableDelegationLiveAdapterV2(v2Deps({
      root: toolRoot,
      toolStart: () => {
        toolCalls += 1
        return operation(toolFinalized({ ok: true, output: 'read' }))
      },
    }))
    const firstCall: ToolCall = { name: 'read_file', args: { path: 'src/a.ts' } }
    const context = await genuineContext(firstCall)
    await toolAdapter.executeTool(firstCall, context)
    await expect(toolAdapter.executeTool({
      name: 'read_file',
      args: { path: 'src/b.ts' },
    }, context)).rejects.toMatchObject({
      code: 'DELEGATION_OPERATION_CONTROL_SEQUENCE_DRIFT',
    })
    expect(toolCalls).toBe(1)
  })

  it('replays duplicate request hashes strictly from sequence one after restart', async () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const controlState = v2Control(root, journal, resolvedAuthority)
    let calls = 0
    const first = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      providerStart: () => {
        calls += 1
        return operation(providerFinalized(
          { reply: `result-${calls}` },
          { spendUsdNanos: 10 },
        ))
      },
    }))
    await expect(first.provider.complete(request('same'))).resolves.toMatchObject({
      reply: 'result-1',
    })
    await expect(first.provider.complete(request('same'))).resolves.toMatchObject({
      reply: 'result-2',
    })

    const restarted = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      providerStart: () => {
        calls += 1
        return operation(providerFinalized({ reply: 'duplicate I/O' }))
      },
    }))
    await expect(restarted.provider.complete(request('same'))).resolves.toMatchObject({
      reply: 'result-1',
    })
    await expect(restarted.provider.complete(request('same'))).resolves.toMatchObject({
      reply: 'result-2',
    })
    expect(calls).toBe(2)
    expect(controlState.bound.snapshot().slots.map(slot => slot.ordinal)).toEqual([1, 2])

    let reorderedCalls = 0
    const reorderedJournal: DurableDelegationOperationJournalV2 = Object.freeze({
      runRootHash: journal.runRootHash,
      scan: () => {
        const inventory = journal.scan()
        return Object.freeze({
          ...inventory,
          entries: Object.freeze([...inventory.entries].reverse()),
        })
      },
      inspect: (key: Parameters<DurableDelegationOperationJournalV2['inspect']>[0]) =>
        journal.inspect(key),
      prepare: (key: Parameters<DurableDelegationOperationJournalV2['prepare']>[0]) =>
        journal.prepare(key),
      settle: (
        permit: Parameters<DurableDelegationOperationJournalV2['settle']>[0],
        outcome: Parameters<DurableDelegationOperationJournalV2['settle']>[1],
      ) => journal.settle(permit, outcome),
    })
    const reordered = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal: reorderedJournal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      providerStart: () => {
        reorderedCalls += 1
        return operation(providerFinalized({ reply: 'must not run' }))
      },
    }))
    await expectCode(
      reordered.provider.complete(request('same')),
      'DURABLE_DELEGATION_LIVE_OPERATION_DRIFT',
    )
    expect(reorderedCalls).toBe(0)
  })

  it('keeps a concurrent same-slot caller out of recovery while its owner is active', async () => {
    const root = runRoot()
    let calls = 0
    let release: ((value: DurableDelegationProviderFinalizedV1) => void) | undefined
    let started: (() => void) | undefined
    const didStart = new Promise<void>(resolve => { started = resolve })
    const pending = new Promise<DurableDelegationProviderFinalizedV1>(resolve => {
      release = resolve
    })
    let recoveryCalls = 0
    const adapter = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      resolveAmbiguity: () => {
        recoveryCalls += 1
        return undefined
      },
      providerStart: () => {
        calls += 1
        started?.()
        return operation(pending)
      },
    }))
    const first = adapter.provider.complete(request())
    await didStart
    await expectAmbiguous(adapter.provider.complete(request()))
    expect(calls).toBe(1)
    expect(recoveryCalls).toBe(0)
    release?.(providerFinalized({ reply: 'first owner' }, { spendUsdNanos: 10 }))
    await expect(first).resolves.toMatchObject({ reply: 'first owner' })
  })

  it('records a genuine stopped acknowledgement with exact cost and replays STOPPED', async () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const controlState = v2Control(root, journal, resolvedAuthority)
    const controller = new AbortController()
    let calls = 0
    let resolutionCalls = 0
    const pending = new Promise<DurableDelegationProviderFinalizedV1>(() => {})
    const adapter = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      resolveAmbiguity: () => {
        resolutionCalls += 1
        return undefined
      },
      providerStart: () => {
        calls += 1
        queueMicrotask(() => controller.abort())
        return operation(pending, async () => makeDurableDelegationStoppedAckV1({
          spendUsdNanos: 30,
          wallMs: 4,
          inputTokens: 2,
          outputTokens: 1,
        }))
      },
    }))
    await expectCode(
      adapter.provider.complete(request(), controller.signal),
      'DURABLE_DELEGATION_LIVE_OPERATION_STOPPED',
    )
    expect(resolutionCalls).toBe(0)
    expect(journal.scan().entries).toMatchObject([{
      state: 'settled',
      payload: { kind: 'runtime.operation-stopped' },
      receipt: { spendUsd: 3e-8, wallMs: 4, effect: 'none' },
    }])
    expect(controlState.bound.snapshot().slots[0]?.attempts[0]).toMatchObject({
      budgetState: 'charged',
      receipt: { outcome: 'stopped', spendUsdNanos: 30, effect: 'none' },
    })

    const restarted = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      resolveAmbiguity: () => {
        resolutionCalls += 1
        return undefined
      },
      providerStart: () => {
        calls += 1
        return operation(providerFinalized({ reply: 'must not run' }))
      },
    }))
    await expectCode(
      restarted.provider.complete(request()),
      'DURABLE_DELEGATION_LIVE_OPERATION_STOPPED',
    )
    expect(calls).toBe(1)
    expect(resolutionCalls).toBe(0)
  })

  it('pauses an ambiguous cancellation acknowledgement without invoking recovery inline', async () => {
    const root = runRoot()
    const controller = new AbortController()
    let resolutionCalls = 0
    const pending = new Promise<DurableDelegationProviderFinalizedV1>(() => {})
    const adapterInput = v2Deps({
      root,
      resolveAmbiguity: () => {
        resolutionCalls += 1
        return undefined
      },
      providerStart: () => {
        queueMicrotask(() => controller.abort())
        return operation(pending, async () => makeDurableDelegationAmbiguousAckV1())
      },
    })
    const adapter = makeDurableDelegationLiveAdapterV2(adapterInput)
    await expectAmbiguous(adapter.provider.complete(request(), controller.signal))
    expect(resolutionCalls).toBe(0)
    expect(adapterInput.control.snapshot().slots[0]?.attempts[0]).toMatchObject({
      budgetState: 'held',
      ambiguous: true,
    })
  })

  it('never returns a settled output whose receipt overruns its quoted charge', async () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const controlState = v2Control(root, journal, resolvedAuthority)
    let calls = 0
    const first = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      providerQuote: () => ({ iterations: 1, spendUsdNanos: 10 }),
      providerStart: () => {
        calls += 1
        return operation(providerFinalized(
          { reply: 'must not escape' },
          { spendUsdNanos: 20 },
        ))
      },
    }))
    await expectCode(
      first.provider.complete(request()),
      'DURABLE_DELEGATION_LIVE_COST_EXCEEDED',
    )
    const restarted = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      providerQuote: () => ({ iterations: 1, spendUsdNanos: 10 }),
      providerStart: () => {
        calls += 1
        return operation(providerFinalized({ reply: 'duplicate' }))
      },
    }))
    await expectCode(
      restarted.provider.complete(request()),
      'DURABLE_DELEGATION_LIVE_COST_EXCEEDED',
    )
    expect(calls).toBe(1)
    expect(controlState.bound.snapshot().slots[0]?.attempts[0]?.budgetState).toBe('overrun')
  })

  it('does not create a slot for a pre-aborted invocation', async () => {
    const root = runRoot()
    const input = v2Deps({ root })
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const adapter = makeDurableDelegationLiveAdapterV2({
      ...input,
      provider: Object.freeze({
        start: () => {
          calls += 1
          return operation(providerFinalized({ reply: 'must not run' }))
        },
      }),
    })
    await expectCode(
      adapter.provider.complete(request(), controller.signal),
      'DURABLE_DELEGATION_LIVE_OPERATION_STOPPED',
    )
    expect(calls).toBe(0)
    expect(input.control.snapshot().slots).toHaveLength(0)
  })

  it('runs verification before sealing, honors abort, and re-verifies an exact sealed candidate', async () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const controlState = v2Control(root, journal, resolvedAuthority)
    let mode: 'false' | 'throw' | 'invalid' | 'abort' | 'valid' = 'false'
    let verifierCalls = 0
    let abortController: AbortController | undefined
    const verifier: DurableDelegationLiveAdapterInputV2['verifier'] = async () => {
      verifierCalls += 1
      if (mode === 'throw') throw new Error('verifier unavailable')
      if (mode === 'false') return { verified: false, reasonCode: 'EVIDENCE_MISSING' }
      if (mode === 'invalid') {
        return { verified: true, evidenceId: 'invalid/id', summary: 'verified', result: {} }
      }
      if (mode === 'abort') abortController?.abort()
      return {
        verified: true,
        evidenceId: 'evidence:v2',
        summary: ' verified with runtime whitespace semantics ',
        result: { ok: true },
      }
    }
    const adapter = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      verifier,
    }))
    await adapter.provider.complete(request())
    await expect(adapter.verify({ answer: 'candidate' })).resolves.toEqual({
      verified: false,
      reasonCode: 'EVIDENCE_MISSING',
    })
    expect(controlState.bound.snapshot().state).toBe('open')

    mode = 'throw'
    await expectCode(
      adapter.verify({ answer: 'candidate' }),
      'DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED',
    )
    expect(controlState.bound.snapshot().state).toBe('open')

    mode = 'invalid'
    await expectCode(
      adapter.verify({ answer: 'candidate' }),
      'DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED',
    )
    expect(controlState.bound.snapshot().state).toBe('open')

    mode = 'abort'
    abortController = new AbortController()
    await expectCode(
      adapter.verify({ answer: 'candidate' }, abortController.signal),
      'DURABLE_DELEGATION_LIVE_OPERATION_STOPPED',
    )
    expect(controlState.bound.snapshot().state).toBe('open')

    mode = 'valid'
    await expect(adapter.verify({ answer: 'candidate' })).resolves.toMatchObject({
      verified: true,
      evidenceId: 'evidence:v2',
    })
    expect(controlState.bound.snapshot().state).toBe('sealed')

    const sealedFailure = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      verifier: async () => ({ verified: false, reasonCode: 'POSTCONDITION_FAILED' }),
      providerStart: () => operation(providerFinalized({ reply: 'must replay' })),
    }))
    await sealedFailure.provider.complete(request())
    await expect(sealedFailure.verify({ answer: 'candidate' })).rejects.toMatchObject({
      kind: 'durable-delegation-recoverable-interruption',
      code: 'DELEGATION_MANUAL_RECOVERY_REQUIRED',
    })
    expect(controlState.bound.snapshot()).toMatchObject({ state: 'sealed' })

    let restartedProviderCalls = 0
    const restarted = makeDurableDelegationLiveAdapterV2(v2Deps({
      root,
      authority: resolvedAuthority,
      journal,
      control: controlState.bound,
      controlAttestation: controlState.attestation,
      verifier,
      providerStart: () => {
        restartedProviderCalls += 1
        return operation(providerFinalized({ reply: 'duplicate' }))
      },
    }))
    await restarted.provider.complete(request())
    mode = 'valid'
    await expect(restarted.verify({ answer: 'candidate' })).resolves.toMatchObject({
      verified: true,
      evidenceId: 'evidence:v2',
    })
    const beforeWrongCandidate = verifierCalls
    await expectCode(
      restarted.verify({ answer: 'different' }),
      'DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED',
    )
    expect(verifierCalls).toBe(beforeWrongCandidate)
    expect(restartedProviderCalls).toBe(0)
  })

  it('rejects copied, cross-task, and closed control attestations before journal scan or I/O', () => {
    const root = runRoot()
    const resolvedAuthority = authority()
    const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot: root })
    const controlState = v2Control(root, journal, resolvedAuthority)
    let scans = 0
    let ports = 0
    const countingJournal: DurableDelegationOperationJournalV2 = Object.freeze({
      runRootHash: journal.runRootHash,
      scan: () => {
        scans += 1
        return journal.scan()
      },
      inspect: (key: Parameters<DurableDelegationOperationJournalV2['inspect']>[0]) =>
        journal.inspect(key),
      prepare: (key: Parameters<DurableDelegationOperationJournalV2['prepare']>[0]) =>
        journal.prepare(key),
      settle: (
        permit: Parameters<DurableDelegationOperationJournalV2['settle']>[0],
        outcome: Parameters<DurableDelegationOperationJournalV2['settle']>[1],
      ) => journal.settle(permit, outcome),
    })
    const common = {
      root,
      authority: resolvedAuthority,
      journal: countingJournal,
      control: controlState.bound,
      providerStart: () => {
        ports += 1
        return operation(providerFinalized({ reply: 'must not run' }))
      },
    } as const
    expect(() => makeDurableDelegationLiveAdapterV2(v2Deps({
      ...common,
      controlAttestation: structuredClone(controlState.attestation),
    }))).toThrowError(expect.objectContaining({
      code: 'DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID',
    }))

    const crossRoot = runRoot()
    const crossJournal = makeNodeDurableDelegationOperationJournalV2({ runRoot: crossRoot })
    const crossControl = v2Control(crossRoot, crossJournal, resolvedAuthority)
    expect(() => makeDurableDelegationLiveAdapterV2(v2Deps({
      ...common,
      controlAttestation: crossControl.attestation,
    }))).toThrowError(expect.objectContaining({
      code: 'DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID',
    }))

    controlState.owner.close()
    expect(() => makeDurableDelegationLiveAdapterV2(v2Deps({
      ...common,
      controlAttestation: controlState.attestation,
    }))).toThrowError(expect.objectContaining({
      code: 'DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID',
    }))
    expect(scans).toBe(0)
    expect(ports).toBe(0)
  })
})
