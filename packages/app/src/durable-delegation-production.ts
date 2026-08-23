import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'

import {
  resolveDelegationExecutionAuthority,
  runtimeToolDefinition,
  type AgentCapabilityMatrix,
  type AgentCard,
  type DelegationTask,
  type IterationCost,
  type ModelProgressSink,
  type ModelRequest,
  type ModelResponse,
  type PlanDAG,
  type ProviderAdapter,
  type ResolvedWorkBinding,
  type TaskObservation,
  type ToolCall,
  type ToolExecutionContext,
  type TurnResult,
} from '@aisy/core'

import {
  makeDurableDelegationAmbiguousAckV1,
  makeDurableDelegationLiveAdapterV2,
  makeDurableDelegationStoppedAckV1,
  type DurableDelegationCancellationReceiptV1,
  type DurableDelegationOwnedOperationV1,
  type DurableDelegationProviderFinalizedV1,
  type DurableDelegationResolutionRequestV2,
  type DurableDelegationToolFinalizedV1,
} from './durable-delegation-live-adapter.js'
import { makeDurableDelegationInvocationDispatcher } from './durable-delegation-invocation.js'
import {
  deriveDurableDelegationOperationControlScopeHashesV1,
  makeNodeDurableDelegationOperationControlV1,
  type DurableDelegationBudgetCeilingV1,
  type DurableDelegationOperationResolutionAuthorityV1,
} from './durable-delegation-operation-control.js'
import { makeNodeDurableDelegationOperationJournalV2 } from './durable-delegation-operation-journal.js'
import {
  makeNodeDurableDelegationRuntime,
  type DurableDelegationExecutionHandle,
  type DurableDelegationOperation,
  type DurableDelegationRuntime,
} from './durable-delegation-runtime.js'
import type { DurableDelegationRunRegistryV1 } from './durable-delegation-run-registry.js'
import type { ExecutionSupervisorLease } from './execution-supervisor-ipc.js'

const HASH = /^[a-f0-9]{64}$/
const POLICY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const BINDING_DOMAIN = 'aisy.durable-delegation.operation-binding.v1\0'
const EVIDENCE_DOMAIN = 'aisy.durable-delegation.production-evidence.v1\0'

export interface DurableDelegationProductionChildV1 {
  readonly providerIdentityHash: string
  readonly provider: ProviderAdapter
  executeTool(call: ToolCall, context?: ToolExecutionContext): Promise<{ ok: boolean; output: string }>
  run(input: Readonly<{
    provider: ProviderAdapter
    executeTool(call: ToolCall, context?: ToolExecutionContext): Promise<{ ok: boolean; output: string }>
    signal: AbortSignal
    childSessionId: string
  }>): Promise<TurnResult>
}

export type DurableDelegationProductionPhaseV1 =
  | 'provider-dispatch'
  | 'provider-response'
  | 'tool-dispatch'
  | 'tool-response'
  | 'child-settled'
  | 'verifier-settled'
  | 'terminal-committed'

export interface DurableDelegationProductionEventV1 {
  readonly kind: 'durable-delegation.phase'
  readonly phase: DurableDelegationProductionPhaseV1
  readonly taskId: string
}

export interface DurableDelegationProductionDepsV1 {
  readonly stateRoot: string
  readonly executionAuthority: ExecutionSupervisorLease
  readonly binding: ResolvedWorkBinding
  readonly defaultCardName: string
  readonly registry: Pick<DurableDelegationRunRegistryV1, 'register'>
  readonly installationHash: string
  readonly policyRevision: string
  readonly dailyEpoch: string
  readonly maximumDailySpendUsd: number
  readonly maxConcurrency: number
  resolveCard(name: string): AgentCard | undefined
  skillTouchedPaths(skill: string): string[]
  mcpWritable(server: string): boolean
  isBindingActive(binding: ResolvedWorkBinding): boolean
  resolveCapabilities(
    handle: DurableDelegationExecutionHandle,
    task: DelegationTask,
  ): AgentCapabilityMatrix
  createChild(input: Readonly<{
    handle: DurableDelegationExecutionHandle
    task: DelegationTask
    authority: ReturnType<typeof resolveDelegationExecutionAuthority>
  }>): DurableDelegationProductionChildV1
  /**
   * Durable actor seam. The first pass observes the exact request and returns
   * undefined; only a later manager-owned replay may return a genuine
   * module-issued one-shot authority.
   */
  resolveAmbiguity?(
    request: DurableDelegationResolutionRequestV2,
  ): DurableDelegationOperationResolutionAuthorityV1 | undefined
  onAmbiguity?(request: DurableDelegationResolutionRequestV2): void
  onResolutionApplied?(
    request: DurableDelegationResolutionRequestV2,
    decision: 'retry-once' | 'cancel',
  ): void
  /** Bounded code-only observability; failures never change execution semantics. */
  emit?(event: DurableDelegationProductionEventV1): void
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(domain: string, value: unknown): string {
  return createHash('sha256').update(domain, 'utf8').update(canonicalJson(value), 'utf8').digest('hex')
}

function spendNanos(value: number): number {
  const nanos = Math.round(value * 1_000_000_000)
  if (!Number.isSafeInteger(nanos) || nanos < 0) throw new Error('DURABLE_DELEGATION_COST_INVALID')
  return nanos
}

function cancellationReceipt(
  startedAt: number,
  usage?: Readonly<{ dollars: number; inputTokens: number; outputTokens: number }>,
): DurableDelegationCancellationReceiptV1 {
  return Object.freeze({
    spendUsdNanos: spendNanos(usage?.dollars ?? 0),
    wallMs: Math.max(0, Date.now() - startedAt),
    ...(usage === undefined ? {} : {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    }),
  })
}

function safeEmit(
  emit: DurableDelegationProductionDepsV1['emit'],
  phase: DurableDelegationProductionPhaseV1,
  taskId: string,
): void {
  try { emit?.(Object.freeze({ kind: 'durable-delegation.phase', phase, taskId })) } catch {
    // Observability is intentionally non-load-bearing.
  }
}

function providerOperation(
  provider: ProviderAdapter,
  request: ModelRequest,
  taskId: string,
  emit: DurableDelegationProductionDepsV1['emit'],
  signal?: AbortSignal,
  onProgress?: ModelProgressSink,
): DurableDelegationOwnedOperationV1<DurableDelegationProviderFinalizedV1> {
  const startedAt = Date.now()
  const abort = new AbortController()
  const linked = signal === undefined ? abort.signal : AbortSignal.any([signal, abort.signal])
  let usage: ModelResponse['usage'] | undefined
  safeEmit(emit, 'provider-dispatch', taskId)
  const result = provider.complete(request, linked, onProgress).then(output => {
    safeEmit(emit, 'provider-response', taskId)
    usage = output.usage
    return Object.freeze({
      output,
      receipt: Object.freeze({
        spendUsdNanos: spendNanos(output.usage?.dollars ?? 0),
        wallMs: Math.max(0, Date.now() - startedAt),
        inputTokens: output.usage?.inputTokens ?? 0,
        outputTokens: output.usage?.outputTokens ?? 0,
      }),
    })
  })
  const settled = result.then(() => true, () => true)
  return Object.freeze({
    result,
    async cancel() {
      abort.abort()
      try {
        await settled
        return makeDurableDelegationStoppedAckV1(cancellationReceipt(startedAt, usage))
      } catch {
        return makeDurableDelegationAmbiguousAckV1()
      }
    },
  })
}

function toolEffect(call: ToolCall): 'none' | 'read' | 'mutation' {
  const effect = runtimeToolDefinition(call.name)?.effect
  if (effect === 'read') return 'read'
  if (effect === 'write' || effect === 'execute' || effect === 'delegate') return 'mutation'
  return 'none'
}

function toolOperation(
  executeTool: DurableDelegationProductionChildV1['executeTool'],
  call: ToolCall,
  context: ToolExecutionContext,
  taskId: string,
  emit: DurableDelegationProductionDepsV1['emit'],
): DurableDelegationOwnedOperationV1<DurableDelegationToolFinalizedV1> {
  const startedAt = Date.now()
  const abort = new AbortController()
  const linked = context.signal === undefined
    ? abort.signal
    : AbortSignal.any([context.signal, abort.signal])
  const ownedContext = Object.freeze({ ...context, signal: linked })
  safeEmit(emit, 'tool-dispatch', taskId)
  const result = executeTool(call, ownedContext).then(output => {
    safeEmit(emit, 'tool-response', taskId)
    const effect = toolEffect(call)
    return Object.freeze({
      output,
      receipt: Object.freeze({
        spendUsdNanos: 0,
        wallMs: Math.max(0, Date.now() - startedAt),
        effect,
        evidenceHash: sha256(EVIDENCE_DOMAIN, { call: call.name, output }),
        // Mutation proof belongs to the agent-loop action contract and its
        // postcondition probe; mere successful dispatch is not proof.
        actionStatus: effect === 'mutation' ? 'unverified' as const : 'verified' as const,
      }),
    })
  })
  const settled = result.then(() => true, () => true)
  return Object.freeze({
    result,
    async cancel() {
      abort.abort()
      try {
        await settled
        return makeDurableDelegationStoppedAckV1(cancellationReceipt(startedAt))
      } catch {
        return makeDurableDelegationAmbiguousAckV1()
      }
    },
  })
}

function runtimeOperation<T>(result: Promise<T>): DurableDelegationOperation<T> {
  const settled = result.then(() => undefined, () => undefined)
  return Object.freeze({ result, cancel: async () => settled })
}

function ceiling(
  scopeHash: string,
  maximumIterations: number | null,
  maximumSpendUsdNanos: number | null,
  dailyEpoch?: string,
): DurableDelegationBudgetCeilingV1 {
  return Object.freeze({
    scopeHash,
    maximumIterations,
    maximumSpendUsdNanos,
    ...(dailyEpoch === undefined ? {} : { dailyEpoch }),
  })
}

/**
 * Production importer for durable depth-1 delegation. It is deliberately
 * impossible to construct without a genuine held supervisor lease; direct
 * `aisy run` keeps the legacy rollback path.
 */
export function makeProductionDurableDelegationDispatcher(
  deps: DurableDelegationProductionDepsV1,
): (planJson: string, context?: ToolExecutionContext) => Promise<TaskObservation[]> {
  if (!HASH.test(deps.installationHash) || !POLICY.test(deps.policyRevision) ||
    !DAY.test(deps.dailyEpoch) || !Number.isFinite(deps.maximumDailySpendUsd) ||
    deps.maximumDailySpendUsd < 0 || !Number.isInteger(deps.maxConcurrency) ||
    deps.maxConcurrency < 1 || deps.maxConcurrency > 64 ||
    (deps.resolveAmbiguity !== undefined && typeof deps.resolveAmbiguity !== 'function') ||
    (deps.onAmbiguity !== undefined && typeof deps.onAmbiguity !== 'function') ||
    (deps.onResolutionApplied !== undefined && typeof deps.onResolutionApplied !== 'function')) {
    throw new Error('DURABLE_DELEGATION_PRODUCTION_CONFIG_INVALID')
  }
  mkdirSync(deps.stateRoot, { recursive: true, mode: 0o700 })
  const resolveAmbiguity = deps.resolveAmbiguity ?? (() => undefined)
  const onAmbiguity = deps.onAmbiguity ?? (() => {})

  return makeDurableDelegationInvocationDispatcher({
    stateRoot: deps.stateRoot,
    executionAuthority: deps.executionAuthority,
    binding: deps.binding,
    defaultCardName: deps.defaultCardName,
    registry: deps.registry,
    createRuntime: ({ runRoot, binding, plan }): DurableDelegationRuntime => {
      mkdirSync(runRoot, { recursive: true, mode: 0o700 })
      const journal = makeNodeDurableDelegationOperationJournalV2({ runRoot })
      let control: ReturnType<typeof makeNodeDurableDelegationOperationControlV1> | undefined
      const adapters = new Map<string, ReturnType<typeof makeDurableDelegationLiveAdapterV2>>()
      const dailySpendNanos = spendNanos(deps.maximumDailySpendUsd)
      const runSpendNanos = spendNanos(plan.nodes.reduce((sum, task) => sum + task.budgetSlice.spendUsd, 0))
      const runIterations = plan.nodes.reduce((sum, task) => sum + task.budgetSlice.iterations, 0)

      const runtime = makeNodeDurableDelegationRuntime({
        runRoot,
        recoveryPolicy: 'resume-active-replay-terminal',
        maxConcurrency: deps.maxConcurrency,
        binding,
        plan,
        resolveCard: deps.resolveCard,
        skillTouchedPaths: deps.skillTouchedPaths,
        mcpWritable: deps.mcpWritable,
        isBindingActive: deps.isBindingActive,
        runTask: (handle, task, signal) => {
          const matrix = deps.resolveCapabilities(handle, task)
          const authority = resolveDelegationExecutionAuthority({
            handle,
            task,
            matrix,
            maxConcurrency: deps.maxConcurrency,
          })
          const shard = handle.authorityJournal.shard()
          if (shard.length === 0) handle.authorityJournal.appendAuthoritySeal(authority.authorityHash)
          control ??= makeNodeDurableDelegationOperationControlV1({
            root: deps.stateRoot,
            installationHash: deps.installationHash,
            policyRevision: deps.policyRevision,
            dailyEpoch: deps.dailyEpoch,
          })
          const bindingHash = createHash('sha256')
            .update(BINDING_DOMAIN, 'utf8')
            .update(canonicalJson(authority.identity.binding), 'utf8')
            .digest('hex')
          const scopes = deriveDurableDelegationOperationControlScopeHashesV1({
            installationHash: deps.installationHash,
            runRootHash: journal.runRootHash,
            bindingHash,
            taskId: task.taskId,
            dailyEpoch: deps.dailyEpoch,
          })
          const taskSpendNanos = spendNanos(task.budgetSlice.spendUsd)
          const bound = control.bindTask({
            schemaVersion: 1,
            runRootHash: journal.runRootHash,
            bindingHash,
            delegationId: authority.identity.delegationId,
            taskId: authority.identity.taskId,
            authorityHash: authority.authorityHash,
            policyRevision: deps.policyRevision,
            ceilings: Object.freeze({
              task: ceiling(scopes.task, task.budgetSlice.iterations, taskSpendNanos),
              run: ceiling(scopes.run, runIterations, runSpendNanos),
              global: ceiling(scopes.global, null, dailySpendNanos),
              daily: ceiling(scopes.daily, null, dailySpendNanos, deps.dailyEpoch),
            }),
          })
          const child = deps.createChild({ handle, task, authority })
          if (!HASH.test(child.providerIdentityHash)) {
            throw new Error('DURABLE_DELEGATION_PROVIDER_IDENTITY_INVALID')
          }
          const perCallSpend = task.budgetSlice.iterations === 0
            ? 0
            : Math.floor(taskSpendNanos / task.budgetSlice.iterations)
          const adapter = makeDurableDelegationLiveAdapterV2({
            journal,
            control: bound,
            controlAttestation: control.attestBoundTask(bound),
            authority,
            authorityJournal: handle.authorityJournal,
            childTurnId: authority.identity.childSessionId,
            providerIdentityHash: child.providerIdentityHash,
            policyRevision: deps.policyRevision,
            provider: Object.freeze({
              start: (
                request: ModelRequest,
                providerSignal?: AbortSignal,
                onProgress?: ModelProgressSink,
              ) =>
                providerOperation(
                  child.provider,
                  request,
                  task.taskId,
                  deps.emit,
                  providerSignal,
                  onProgress,
                ),
            }),
            tool: Object.freeze({
              start: (call: ToolCall, context: ToolExecutionContext) =>
                toolOperation(child.executeTool, call, context, task.taskId, deps.emit),
            }),
            quotes: Object.freeze({
              provider: () => ({
                iterations: 1,
                spendUsdNanos: perCallSpend,
                retryClass: 'retry-once' as const,
              }),
              tool: (call: ToolCall) => ({
                iterations: 0,
                spendUsdNanos: 0,
                retryClass: toolEffect(call) === 'mutation'
                  ? 'new-task-only' as const
                  : 'retry-once' as const,
              }),
            }),
            onAmbiguity,
            ...(deps.onResolutionApplied === undefined
              ? {}
              : { onResolutionApplied: deps.onResolutionApplied }),
            // The first pass still returns undefined and pauses. A retry is
            // possible only on actor replay with a genuine one-shot authority.
            resolveAmbiguity,
            verifier: async input => {
              const candidate = input.candidate as Partial<TurnResult>
              if (candidate.state !== 'ok' ||
                (candidate.actionContractKind !== undefined && candidate.actionStatus !== 'verified')) {
                return { verified: false, reasonCode: 'POSTCONDITION_FAILED' }
              }
              const summary = typeof candidate.reply === 'string' ? candidate.reply : ''
              if (summary.trim().length === 0) {
                return { verified: false, reasonCode: 'EVIDENCE_MISSING' }
              }
              return {
                verified: true,
                evidenceId: sha256(EVIDENCE_DOMAIN, {
                  candidateHash: input.candidateHash,
                  operations: input.operations,
                }),
                summary,
                result: candidate,
              }
            },
          })
          adapters.set(task.taskId, adapter)
          return runtimeOperation(child.run({
            provider: adapter.provider,
            executeTool: adapter.executeTool,
            signal,
            childSessionId: authority.identity.childSessionId,
          }).then(result => {
            if (result.state === 'halted') throw new Error(result.haltReason ?? 'CHILD_HALTED')
            safeEmit(deps.emit, 'child-settled', task.taskId)
            return { summary: result.reply, result }
          }))
        },
        verify: ({ task, candidate, signal }) => {
          const adapter = adapters.get(task.taskId)
          if (adapter === undefined) throw new Error('DURABLE_DELEGATION_ADAPTER_UNAVAILABLE')
          return runtimeOperation(adapter.verify(candidate.result, signal).then(result => {
            safeEmit(deps.emit, 'verifier-settled', task.taskId)
            return result
          }))
        },
        readCost: async ({ task }): Promise<IterationCost> => {
          const adapter = adapters.get(task.taskId)
          if (adapter === undefined) throw new Error('DURABLE_DELEGATION_METER_UNAVAILABLE')
          return adapter.readCost()
        },
      })
      return Object.freeze({
        execute: async (signal?: AbortSignal) => {
          try {
            const observations = await runtime.execute(signal)
            for (const task of plan.nodes) {
              safeEmit(deps.emit, 'terminal-committed', task.taskId)
            }
            return observations
          } finally { control?.close() }
        },
        cancel: () => runtime.cancel(),
      })
    },
  })
}
