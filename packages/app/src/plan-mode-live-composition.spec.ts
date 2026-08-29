import {
  makeAgentRunner,
  makeGrantStore,
  makeGuardian,
  type MemoryPort,
  type ModelResponse,
  type ProviderAdapter,
  type SessionLog,
  type ToolCall,
  type ToolExecutionContext,
} from '@aisy/core'
import { describe, expect, it } from 'vitest'

import {
  makePlanExecutionStateController,
  type PlanExecutionIdentityV1,
  type PlanExecutionPersistedStateV1,
  type PlanExecutionPersistencePort,
  type PlanExecutionToolEffect,
} from './plan-execution-state.js'
import { makePlanToolProtocol } from './plan-tool-protocol.js'

const readCall = Object.freeze({
  name: 'read_file', args: Object.freeze({ path: 'src/index.ts' }),
})
const writeCall = Object.freeze({
  name: 'write_file', args: Object.freeze({ path: 'src/index.ts', content: 'next' }),
})
const identity: PlanExecutionIdentityV1 = Object.freeze({
  version: 1,
  sessionId: 'session-a',
  turnId: 'telegram-turn-a',
  workBindingHash: 'a'.repeat(64),
  policyRevision: 'plan-live-v1',
})

function effect(name: string): PlanExecutionToolEffect | null {
  if (name === 'read_file') return 'read'
  if (name === 'write_file') return 'write'
  return null
}

function memoryState(): PlanExecutionPersistencePort {
  let current: PlanExecutionPersistedStateV1 | undefined
  return Object.freeze({
    load: () => current,
    save: (state: PlanExecutionPersistedStateV1) => { current = structuredClone(state) },
  })
}

function scripted(responses: readonly ModelResponse[]): ProviderAdapter {
  let index = 0
  return Object.freeze({
    complete: async () => responses[Math.min(index++, responses.length - 1)]!,
  })
}

describe('LIVE Plan Mode composition', () => {
  it('исследует, показывает план, ждёт оператора и только потом действует', async () => {
    const events: string[] = []
    const state = makePlanExecutionStateController({
      persistence: memoryState(), toolEffect: effect, nowMs: () => 1_800_000_000_000,
    })
    const protocol = makePlanToolProtocol({
      state,
      mode: () => 'plan',
      toolEffect: effect,
      execute: async (call) => {
        events.push(`execute:${call.name}`)
        return { ok: true, output: `${call.name}: ok` }
      },
      reviewPlan: (view) => {
        // Оператор читает шаги словами и тапает «выполнять».
        events.push(`review:${view.steps.map((step) => step.intent).join('|')}`)
        return 'approved'
      },
      workBindingHash: identity.workBindingHash,
      policyRevision: identity.policyRevision,
    })
    const plan = JSON.stringify({
      version: 1,
      steps: [
        { intent: 'Обновить исследованный файл', call: writeCall },
        { intent: 'Проверить результат чтением', call: readCall },
      ],
    })
    const provider = scripted([
      // An adversarial premature write is a model observation, not an approval.
      { reply: '', toolCalls: [writeCall] },
      { reply: '', toolCalls: [readCall] },
      {
        reply: 'План: обновить исследованный файл.',
        toolCalls: [{ name: 'submit_plan', args: { plan } }],
      },
      { reply: '', toolCalls: [writeCall] },
      { reply: '', toolCalls: [readCall] },
      { reply: 'Готово.', toolCalls: [] },
    ])
    const memory: MemoryPort = Object.freeze({
      snapshot: async () => ({
        prefixBytes: new Uint8Array(), prefixHash: 'hash', breakpoints: [], takenAt: 'now',
      }),
      forget: async () => {},
    })
    const sessionLog: SessionLog = Object.freeze({ append: () => {}, resume: () => null })
    const projected = (context: ToolExecutionContext) => Object.freeze({
      sessionId: context.sessionId,
      ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
      ordinal: context.ordinal,
    })
    const runner = makeAgentRunner({
      provider,
      memory,
      grants: makeGrantStore(),
      grantBinding: {
        operatorId: 'operator', profileId: 'default', projectId: 'project',
        sessionId: 'session-a', scope: 'project',
      },
      preToolDispatch: (call, context) => protocol.preflight(call, projected(context)),
      executeTool: (call, context) => protocol.executeAfterGate(call, projected(context)),
      postToolDispatch: (call, context, result) =>
        protocol.observeAfterGate(call, projected(context), result),
      approve: async () => {
        events.push('approve:write_file')
        return { decision: 'confirmed' as const }
      },
      guardian: makeGuardian(),
      sessionLog,
      postToolUse: { secretValues: () => [] },
    })

    const result = await runner.handle({
      sessionId: 'session-a',
      turnId: 'telegram-turn-a',
      spans: [{ role: 'user', provenance: 'operator', text: 'Измени src/index.ts' }],
    })

    // Порядок несущий: исследование → показ плана оператору → и только после
    // его тапа первое изменение. Между review и execute ничего не происходит.
    expect(events).toEqual([
      'execute:read_file',
      'review:Обновить исследованный файл|Проверить результат чтением',
      'approve:write_file',
      'execute:write_file',
      'execute:read_file',
    ])
    expect(state.status(identity)).toMatchObject({ phase: 'completed', nextStep: 2 })
    expect(result).toMatchObject({ state: 'ok', reply: 'Готово.', actionStatus: 'verified' })
  })
})
