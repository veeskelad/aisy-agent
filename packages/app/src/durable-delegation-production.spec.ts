import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
import { afterEach, describe, expect, it } from 'vitest'

import { makeProductionDurableDelegationDispatcher } from './durable-delegation-production.js'
import { makeNodeDurableDelegationRunRegistry } from './durable-delegation-run-registry.js'
import {
  authenticateExecutionSupervisorChild,
  encodeExecutionSupervisorFrame,
  makeExecutionSupervisorSessionProof,
  type ExecutionSupervisorChannel,
  type ExecutionSupervisorFrame,
  type ExecutionSupervisorLease,
} from './execution-supervisor-ipc.js'

const roots: string[] = []
afterEach(() => {
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
  name: 'reviewer',
  instructions: 'Verify the assigned result.',
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
    scope: { owns: [], doNotTouch: [], taskClass: 'reasoning' },
    budgetSlice: { iterations: 3, spendUsd: 0.3 },
    outputContract: 'verified summary',
    retryPolicy: { maxReplans: 0, maxIterations: 3 },
  }],
  edges: [],
}
const BINDING_HASH = 'a'.repeat(64)
const LIVENESS = 'b'.repeat(64)
const PARENT = 'p'.repeat(43)
const CHILD = 'c'.repeat(43)
const SESSION = 's'.repeat(43)
const LEASE = 'l'.repeat(43)

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

function frame(value: ExecutionSupervisorFrame): string {
  return encodeExecutionSupervisorFrame(value)
}

async function genuineLease(): Promise<ExecutionSupervisorLease> {
  const replies = [
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
    frame({
      version: 3,
      type: 'capture-ack',
      requestId: 'capture-1',
      deadlineAtMs: 3_000,
      sessionId: SESSION,
      bindingHash: BINDING_HASH,
      leaseId: LEASE,
    }),
  ]
  const channel: ExecutionSupervisorChannel = {
    send: () => {},
    receive: async () => {
      const next = replies.shift()
      if (next === undefined) throw new Error('disconnected')
      return next
    },
    onDisconnect: () => () => {},
    close: () => {},
  }
  const session = await authenticateExecutionSupervisorChild({
    channel,
    newRequestId: () => 'capture-1',
    randomNonce: () => CHILD,
    nowMs: () => 1_000,
    livenessDescriptorHash: LIVENESS,
  })
  return session.captureTurn(BINDING_HASH)
}

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
  if (captured === undefined) throw new Error('context unavailable')
  return captured
}

describe('production durable delegation composition', () => {
  it('executes once and replays the terminal observation for the same parent position', async () => {
    const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-production-delegation-')))
    roots.push(stateRoot)
    const lease = await genuineLease()
    const registry = makeNodeDurableDelegationRunRegistry({ stateRoot })
    const context = await genuineContext({ name: 'spawn_subagent', args: { plan: '{}' } })
    let providerCalls = 0
    const phases: string[] = []
    const dispatch = makeProductionDurableDelegationDispatcher({
      stateRoot,
      executionAuthority: lease,
      binding: BINDING,
      defaultCardName: CARD.name,
      registry,
      installationHash: '1'.repeat(64),
      policyRevision: 'production-test-v1',
      dailyEpoch: '2026-08-12',
      maximumDailySpendUsd: 10,
      maxConcurrency: 2,
      emit: event => { phases.push(event.phase) },
      resolveCard: name => name === CARD.name ? CARD : undefined,
      skillTouchedPaths: () => [],
      mcpWritable: () => false,
      isBindingActive: binding => binding.sessionId === BINDING.sessionId,
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
            providerCalls += 1
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
            state: 'ok',
            ...(response.usage === undefined ? {} : { usage: response.usage }),
          }
        },
      }),
    })

    const first = await dispatch(JSON.stringify(PLAN), context)
    const replay = await dispatch(JSON.stringify(PLAN), context)

    expect(first).toEqual(replay)
    expect(first).toMatchObject([{ status: 'completed', summary: 'verified answer' }])
    expect(providerCalls).toBe(1)
    expect(phases).toEqual([
      'provider-dispatch',
      'provider-response',
      'child-settled',
      'verifier-settled',
      'terminal-committed',
      'terminal-committed',
    ])
    expect(registry.listExact(BINDING_HASH)).toEqual([])
  })

  it('refuses production construction after supervisor authority is lost', async () => {
    const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-production-delegation-')))
    roots.push(stateRoot)
    const lease = await genuineLease()
    expect(() => lease.failClosed()).toThrow()
    expect(() => makeProductionDurableDelegationDispatcher({
      stateRoot,
      executionAuthority: lease,
      binding: BINDING,
      defaultCardName: CARD.name,
      registry: makeNodeDurableDelegationRunRegistry({ stateRoot }),
      installationHash: '1'.repeat(64),
      policyRevision: 'production-test-v1',
      dailyEpoch: '2026-08-12',
      maximumDailySpendUsd: 10,
      maxConcurrency: 1,
      resolveCard: () => CARD,
      skillTouchedPaths: () => [],
      mcpWritable: () => false,
      isBindingActive: () => true,
      resolveCapabilities: () => { throw new Error('must not run') },
      createChild: () => { throw new Error('must not run') },
    })).toThrow('DURABLE_DELEGATION_CONFIG_INVALID')
  })
})
