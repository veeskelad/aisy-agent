import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'

import {
  makeAgentRunner,
  makeGrantStore,
  resolveChildAgentCapabilityMatrix,
  runtimeProviderTools,
  runtimeToolMinimumTiers,
  type AgentCard,
  type LoopGuardian,
  type MemoryPort,
  type ModelResponse,
  type ResolvedWorkBinding,
  type SessionLog,
  type ToolCall,
  type ToolExecutionContext,
} from '@aisy/core'

import { makeProductionDurableDelegationDispatcher } from '../src/durable-delegation-production.ts'
import { makeNodeDurableDelegationRunRegistry } from '../src/durable-delegation-run-registry.ts'
import { makeDurableDelegationOperationResolutionAuthorityV1 } from '../src/durable-delegation-operation-control.ts'
import { makeDurableDelegationStartupRecoveryPortV1 } from '../src/durable-delegation-startup-recovery.ts'
import {
  authenticateExecutionSupervisorChild,
  encodeExecutionSupervisorFrame,
  makeExecutionSupervisorRecoveryContextV1,
  makeExecutionSupervisorSessionProof,
  type ExecutionSupervisorChannel,
  type ExecutionSupervisorFrame,
  type ExecutionSupervisorLease,
} from '../src/execution-supervisor-ipc.ts'

const stateRoot = required('AISY_DURABLE_CRASH_STATE_ROOT')
const tracePath = required('AISY_DURABLE_CRASH_TRACE')
const stopPhase = process.env['AISY_DURABLE_CRASH_STOP_PHASE'] ?? 'none'
const recovery = process.env['AISY_DURABLE_CRASH_RECOVERY'] === '1'
const resolution = process.env['AISY_DURABLE_CRASH_RESOLUTION'] ?? 'none'

const BINDING_HASH = 'a'.repeat(64)
const LIVENESS = 'b'.repeat(64)
const PARENT = 'p'.repeat(43)
const CHILD = 'c'.repeat(43)
const SESSION = 's'.repeat(43)
const LEASE = 'l'.repeat(43)

const BINDING: ResolvedWorkBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
}
const CARD: AgentCard = {
  name: 'reviewer',
  instructions: 'Verify exact state.',
  skills: [],
  mcpAllowlist: [],
  toolTiers: {},
  maxIterations: 3,
  contextStrategy: 'compact',
  provenance: 'builtin',
}
const PLAN = {
  nodes: [{
    taskId: 'review',
    intent: 'review exact state',
    assignedTo: CARD.name,
    dependsOn: [],
    scope: { owns: [], doNotTouch: [], taskClass: 'reasoning' as const },
    budgetSlice: { iterations: 3, spendUsd: 0.3 },
    outputContract: 'verified summary',
    retryPolicy: { maxReplans: 0, maxIterations: 3 },
  }],
  edges: [],
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name}_MISSING`)
  return value
}

function trace(line: string): void {
  appendFileSync(tracePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
}

function frame(value: ExecutionSupervisorFrame): string {
  return encodeExecutionSupervisorFrame(value)
}

async function leaseForRun(): Promise<ExecutionSupervisorLease> {
  const first = [
    frame({
      version: 3,
      type: 'hello-challenge',
      requestId: 'hello-1',
      deadlineAtMs: 3_000,
      parentNonce: PARENT,
    }),
    frame({
      version: 3,
      type: 'hello-ack',
      requestId: 'hello-1',
      deadlineAtMs: 3_000,
      sessionId: SESSION,
      sessionProof: makeExecutionSupervisorSessionProof({
        requestId: 'hello-1',
        parentNonce: PARENT,
        childNonce: CHILD,
        sessionId: SESSION,
        livenessDescriptorHash: LIVENESS,
      }),
    }),
  ]
  const replies = recovery
    ? [...first, frame({
        version: 3,
        type: 'recovery-lease',
        requestId: 'recovery-1',
        deadlineAtMs: 3_000,
        sessionId: SESSION,
        bindingHash: BINDING_HASH,
        leaseId: LEASE,
        authorityPhase: 'checkpoint-bound',
        releaseReceipt: null,
      })]
    : [...first, frame({
        version: 3,
        type: 'capture-ack',
        requestId: 'capture-1',
        deadlineAtMs: 3_000,
        sessionId: SESSION,
        bindingHash: BINDING_HASH,
        leaseId: LEASE,
      })]
  const channel: ExecutionSupervisorChannel = {
    send: () => {},
    receive: async () => {
      const reply = replies.shift()
      if (reply === undefined) throw new Error('disconnected')
      return reply
    },
    onDisconnect: () => () => {},
    close: () => {},
  }
  const session = await authenticateExecutionSupervisorChild({
    channel,
    newRequestId: () => recovery ? 'recovery-1' : 'capture-1',
    randomNonce: () => CHILD,
    nowMs: () => 1_000,
    livenessDescriptorHash: LIVENESS,
  })
  if (!recovery) return session.captureTurn(BINDING_HASH)
  const state = await session.requestRecoveryState()
  if (state.kind !== 'lease') throw new Error('RECOVERY_LEASE_MISSING')
  return state.lease
}

const memory: MemoryPort = {
  snapshot: async () => ({
    prefixBytes: new Uint8Array(),
    prefixHash: 'prefix',
    breakpoints: [],
    takenAt: '2026-08-12T00:00:00.000Z',
  }),
  forget: async () => {},
}
const guardian: LoopGuardian = { observe: () => ({ trip: false }), note: () => {} }
const sessionLog: SessionLog = { append: () => {}, resume: () => null }

async function genuineContext(call: ToolCall): Promise<ToolExecutionContext> {
  let captured: ToolExecutionContext | undefined
  let count = 0
  const runner = makeAgentRunner({
    provider: {
      complete: async (): Promise<ModelResponse> => {
        count += 1
        return count === 1 ? { reply: '', toolCalls: [call] } : { reply: 'done' }
      },
    },
    memory,
    grants: makeGrantStore(),
    grantBinding: BINDING,
    executeTool: async (_call, context) => {
      captured = context
      return { ok: true, output: 'captured' }
    },
    approve: async () => ({ decision: 'confirmed' }),
    guardian,
    sessionLog,
  })
  await runner.handle({
    sessionId: BINDING.sessionId,
    turnId: 'telegram-update-1',
    spans: [{ role: 'user', provenance: 'operator', text: 'delegate this' }],
  })
  if (captured === undefined) throw new Error('CONTEXT_MISSING')
  return captured
}

let stopped = false
function emit(event: Readonly<{ phase: string; taskId: string }>): void {
  trace(`phase ${event.phase} ${event.taskId}`)
  if (!stopped && event.phase === stopPhase) {
    stopped = true
    trace(`stop ${event.phase}`)
    process.kill(process.pid, 'SIGSTOP')
  }
}

try {
  const lease = await leaseForRun()
  const registry = makeNodeDurableDelegationRunRegistry({ stateRoot })
  if (recovery) {
    const context = makeExecutionSupervisorRecoveryContextV1(lease)
    if (context === null) throw new Error('RECOVERY_CONTEXT_MISSING')
    const result = await makeDurableDelegationStartupRecoveryPortV1({
      registry,
      resolveCard: name => name === CARD.name ? CARD : undefined,
      skillTouchedPaths: () => [],
      mcpWritable: () => false,
      isBindingActive: binding => binding.sessionId === BINDING.sessionId,
    }).recover(context as never)
    trace(`recovery ${result.kind}`)
  }
  const context = await genuineContext({ name: 'spawn_subagent', args: { plan: '{}' } })
  const dispatch = makeProductionDurableDelegationDispatcher({
    stateRoot,
    executionAuthority: lease,
    binding: BINDING,
    defaultCardName: CARD.name,
    registry,
    installationHash: '1'.repeat(64),
    policyRevision: 'production-crash-v1',
    dailyEpoch: '2026-08-12',
    maximumDailySpendUsd: 10,
    maxConcurrency: 2,
    emit,
    resolveCard: name => name === CARD.name ? CARD : undefined,
    skillTouchedPaths: () => [],
    mcpWritable: () => false,
    isBindingActive: binding => binding.sessionId === BINDING.sessionId,
    onAmbiguity: request => {
      trace(`paused ${request.phase} ${request.ordinal} ${request.attempt} ${request.retryClass}`)
    },
    resolveAmbiguity: request => {
      trace(`ambiguity ${request.phase} ${request.ordinal} ${request.attempt}`)
      if (resolution !== 'retry-once' && resolution !== 'cancel') return undefined
      const resolutionHash = createHash('sha256')
        .update('aisy.fixture.durable-resolution.v1\0', 'utf8')
        .update(JSON.stringify([request, resolution]), 'utf8')
        .digest('hex')
      return makeDurableDelegationOperationResolutionAuthorityV1({
        runRootHash: request.runRootHash,
        taskId: request.taskId,
        logicalSlotHash: request.controlLogicalSlotHash,
        ambiguousAttempt: request.attempt,
        decision: resolution,
        resolutionHash,
      })
    },
    resolveCapabilities: handle => resolveChildAgentCapabilityMatrix({
      card: handle.card,
      toolCatalog: runtimeProviderTools(),
      activeSkills: new Set(),
      activeMcpServers: new Set(),
      minimumToolTiers: runtimeToolMinimumTiers(),
    }),
    createChild: () => ({
      providerIdentityHash: '2'.repeat(64),
      provider: {
        complete: async () => {
          trace('provider-call')
          return {
            reply: 'verified answer',
            usage: { inputTokens: 10, outputTokens: 4, dollars: 0.01 },
          }
        },
      },
      executeTool: async () => ({ ok: true, output: 'unused' }),
      run: async ({ provider, signal, childSessionId }) => {
        const response = await provider.complete({
          sessionId: childSessionId,
          turnId: childSessionId,
          prefixBytes: new Uint8Array(),
          spans: [{ role: 'user', provenance: 'operator', text: 'review' }],
        }, signal)
        return {
          reply: response.reply,
          state: 'ok' as const,
          ...(response.usage === undefined ? {} : { usage: response.usage }),
        }
      },
    }),
  })
  const observations = await dispatch(JSON.stringify(PLAN), context)
  trace(`done ${observations[0]?.status ?? 'missing'}`)
} catch (error) {
  trace(`error ${error instanceof Error ? error.message : 'unknown'}`)
  process.exitCode = 2
}
