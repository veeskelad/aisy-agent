import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { makeMemoryRememberReceipt } from '@aisy/core'
import type { ModelToolRuntimeContext, ToolCall, ToolResult } from '@aisy/core'

import {
  makePlanExecutionStateController,
  type PlanExecutionIdentityV1,
  type PlanExecutionPersistedStateV1,
  type PlanExecutionPersistencePort,
  type PlanExecutionToolEffect,
} from './plan-execution-state.js'
import {
  makePlanToolProtocol,
  PLAN_SUBMIT_TOOL_DEFINITION,
  type PlanReviewDecision,
  type PlanReviewView,
} from './plan-tool-protocol.js'

const WORK_BINDING_HASH = 'a'.repeat(64)
const POLICY_REVISION = 'policy-1'
const context: ModelToolRuntimeContext = Object.freeze({ sessionId: 'session-a', turnId: 'turn-a' })
const identity: PlanExecutionIdentityV1 = Object.freeze({
  version: 1,
  sessionId: 'session-a',
  turnId: 'turn-a',
  workBindingHash: WORK_BINDING_HASH,
  policyRevision: POLICY_REVISION,
})
const readCall: ToolCall = Object.freeze({
  name: 'read_file', args: Object.freeze({ path: 'src/index.ts' }),
})
const writeCall: ToolCall = Object.freeze({
  name: 'write_file', args: Object.freeze({ path: 'src/index.ts', content: 'next' }),
})

function effect(name: string): PlanExecutionToolEffect | null {
  if (name === 'read_file') return 'read'
  if (name === 'write_file') return 'write'
  if (name === 'bash') return 'execute'
  return null
}

function plan(call: ToolCall = writeCall): string {
  return JSON.stringify({
    version: 1,
    steps: [{ intent: 'Внести исследованное изменение', call: { name: call.name, args: call.args } }],
  })
}

function submission(value = plan()): ToolCall {
  return Object.freeze({ name: 'submit_plan', args: Object.freeze({ plan: value }) })
}

function memory(input?: {
  initial?: unknown
  onSave?(state: PlanExecutionPersistedStateV1): void
}): { port: PlanExecutionPersistencePort; current(): unknown } {
  let state = input?.initial
  return {
    port: Object.freeze({
      load: () => state,
      save: (next: PlanExecutionPersistedStateV1) => {
        input?.onSave?.(next)
        state = structuredClone(next)
      },
    }),
    current: () => state,
  }
}

function fixture(input?: {
  mode?: string
  store?: ReturnType<typeof memory>
  execute?: (call: ToolCall, context: ModelToolRuntimeContext) => Promise<ToolResult> | ToolResult
  /** Решение оператора по плану; по умолчанию — одобрение. */
  review?: (view: PlanReviewView) => Promise<PlanReviewDecision> | PlanReviewDecision
}) {
  const store = input?.store ?? memory()
  const state = makePlanExecutionStateController({
    persistence: store.port,
    toolEffect: effect,
    nowMs: () => 1_800_000_000_000,
  })
  const calls: ToolCall[] = []
  const execute = input?.execute ?? (async (call: ToolCall): Promise<ToolResult> => {
    calls.push(call)
    return { ok: true, output: `${call.name}: ok` }
  })
  const reviewed: PlanReviewView[] = []
  const protocol = makePlanToolProtocol({
    state,
    mode: () => input?.mode ?? 'plan',
    toolEffect: effect,
    execute,
    reviewPlan: (view) => {
      reviewed.push(view)
      return input?.review === undefined ? 'approved' : input.review(view)
    },
    workBindingHash: WORK_BINDING_HASH,
    policyRevision: POLICY_REVISION,
  })
  return { protocol, state, store, calls, reviewed }
}

describe('provider-neutral Plan Mode tool protocol (ADR-0092)', () => {
  it('publishes one bounded internal submission tool', () => {
    expect(PLAN_SUBMIT_TOOL_DEFINITION).toMatchObject({
      name: 'submit_plan',
      input_schema: { additionalProperties: false, required: ['plan'] },
    })
    expect(Object.isFrozen(PLAN_SUBMIT_TOOL_DEFINITION)).toBe(true)
    expect(Object.isFrozen(PLAN_SUBMIT_TOOL_DEFINITION.input_schema)).toBe(true)
  })

  it('passes ordinary tools through outside plan mode, unchanged and uncopied', async () => {
    const seen: ToolCall[] = []
    const { protocol, calls } = fixture({
      mode: 'auto',
      execute: async (call) => { seen.push(call); return { ok: true, output: `${call.name}: ok` } },
    })
    const large: ToolCall = { name: 'write_file', args: { path: 'large.txt', content: 'x'.repeat(70_000) } }

    await expect(protocol.invoke(readCall, context)).resolves.toEqual({ ok: true, output: 'read_file: ok' })
    await expect(protocol.invoke(large, context)).resolves.toEqual({ ok: true, output: 'write_file: ok' })
    // submit_plan вне режима — добровольное согласование, а не отказ.
    await expect(protocol.invoke(submission(), context)).resolves.toMatchObject({ ok: true })
    expect(calls).toHaveLength(0)
    expect(seen).toEqual([readCall, large])
    expect(seen[1]).toBe(large)
  })

  it('preserves a code-owned mutation receipt outside plan mode', async () => {
    const mutationReceipt = makeMemoryRememberReceipt(
      { fact: 'ты любишь получать деньги' },
      { sessionId: 'session-a', turnId: 'turn-a', ordinal: 1 },
    )!
    const { protocol } = fixture({
      mode: 'auto',
      execute: async () => ({
        ok: true,
        output: 'Запомнил, что ты любишь получать деньги',
        verified: true,
        mutationReceipt,
      }),
    })

    await expect(protocol.invoke(writeCall, context)).resolves.toEqual({
      ok: true,
      output: 'Запомнил, что ты любишь получать деньги',
      verified: true,
      mutationReceipt,
    })
  })

  it('rejects non-literal or extended mutation receipts', async () => {
    let accessorReads = 0
    const accessor = { ok: true, output: 'Запомнил.' }
    Object.defineProperty(accessor, 'verified', {
      enumerable: true,
      get() { accessorReads++; return true },
    })
    let proxyTraps = 0
    const proxy = new Proxy({ ok: true, output: 'Запомнил.', verified: true }, {
      getPrototypeOf(target) { proxyTraps++; return Reflect.getPrototypeOf(target) },
    })
    const symbol = { ok: true, output: 'Запомнил.', verified: true }
    Object.defineProperty(symbol, Symbol('receipt'), { value: true })
    const mutationReceipt = makeMemoryRememberReceipt(
      { fact: 'ты любишь получать деньги' },
      { sessionId: 'session-a', turnId: 'turn-a', ordinal: 1 },
    )!
    const forgedReceipt = { ...mutationReceipt, fact: 'другой факт' }
    for (const terminal of [
      { ok: true, output: 'Запомнил.', verified: 'yes' },
      { ok: true, output: 'Запомнил.', verified: true, injected: true },
      {
        ok: true,
        output: 'Запомнил, что ты любишь получать деньги',
        verified: true,
        mutationReceipt: forgedReceipt,
      },
      accessor,
      proxy,
      symbol,
    ]) {
      const { protocol } = fixture({
        mode: 'auto',
        execute: async () => terminal as unknown as ToolResult,
      })
      await expect(protocol.invoke(writeCall, context)).resolves.toEqual({
        ok: false,
        output: 'PLAN_EXECUTOR_RESULT_INVALID',
      })
    }
    expect(accessorReads).toBe(0)
    expect(proxyTraps).toBe(0)
  })

  it('allows research reads but refuses acting tools before a submitted plan', async () => {
    const { protocol, state, calls } = fixture()

    await expect(protocol.invoke(writeCall, context)).resolves.toEqual({
      ok: false, output: expect.stringContaining('доступно только чтение'),
    })
    expect(calls).toHaveLength(0)

    await expect(protocol.invoke(readCall, context)).resolves.toEqual({ ok: true, output: 'read_file: ok' })
    expect(state.status(identity)).toMatchObject({ phase: 'research', researchObservations: 1 })
  })

  it('counts research only after the filtered result was actually returned to the model', async () => {
    const { protocol, state } = fixture()
    const gate = await protocol.preflight(readCall, context)
    expect(gate.kind).toBe('continue')
    if (gate.kind !== 'continue') throw new Error('unexpected intercept')

    const raw = await protocol.executeAfterGate(gate.call, context)
    expect(raw).toEqual({ ok: true, output: 'read_file: ok' })
    expect(state.status(identity)).toBeNull()

    protocol.observeAfterGate(gate.call, context, {
      ok: false, output: 'tool result withheld (redaction or filter unavailable)',
    })
    expect(state.status(identity)).toBeNull()
    protocol.observeAfterGate(gate.call, context, raw)
    expect(state.status(identity)).toMatchObject({ phase: 'research', researchObservations: 1 })
  })

  it('executes the plan the operator approved, without asking again to start', async () => {
    const { protocol, state, calls, reviewed } = fixture()
    await protocol.invoke(readCall, context)

    const submitted = await protocol.invoke(submission(), context)
    expect(submitted.ok).toBe(true)
    expect(submitted.output).toContain('одобрил')
    // Оператор увидел шаги словами, а не имена функций.
    expect(reviewed).toHaveLength(1)
    expect(reviewed[0]?.steps[0]?.intent).toBe('Внести исследованное изменение')
    expect(reviewed[0]?.steps[0]?.tool).toBe('write_file')
    expect(state.status(identity)).toMatchObject({ phase: 'approved', nextStep: 0, totalSteps: 1 })
    await expect(protocol.invoke(writeCall, context)).resolves.toEqual({ ok: true, output: 'write_file: ok' })
    expect(calls.map(call => call.name)).toEqual(['read_file', 'write_file'])
    expect(state.status(identity)).toMatchObject({ phase: 'completed', nextStep: 1 })
  })

  it('в режиме «без спроса» агент может согласовать план сам', async () => {
    const { protocol, reviewed, calls } = fixture({ mode: 'auto' })

    const answer = await protocol.invoke(submission(), context)

    expect(answer.ok).toBe(true)
    expect(answer.output).toContain('одобрил')
    expect(reviewed[0]?.steps[0]?.intent).toBe('Внести исследованное изменение')
    // Добровольное согласование не заводит контракт шагов: режим выбирает
    // оператор, и «без спроса» не должен тихо стать «сначала планом».
    await expect(protocol.invoke(writeCall, context))
      .resolves.toEqual({ ok: true, output: 'write_file: ok' })
    expect(calls.map(call => call.name)).toEqual(['write_file'])
  })

  it('добровольный отказ — это ответ человека, а не ошибка', async () => {
    const { protocol, state } = fixture({ mode: 'auto', review: () => 'rejected' })

    const answer = await protocol.invoke(submission(), context)

    expect(answer.ok).toBe(true)
    expect(answer.output).toContain('отклонил')
    // Состояние плана в этом режиме не заводится вовсе.
    expect(state.status(identity)).toBeNull()
  })

  it('исследование вне режима плана не требуется и ничего не пишет', async () => {
    const { protocol, state, reviewed } = fixture({ mode: 'auto' })

    // Ни одного чтения до подачи — карточка всё равно показывается.
    await protocol.invoke(submission(), context)

    expect(reviewed).toHaveLength(1)
    expect(state.status(identity)).toBeNull()
  })

  it('не выполняет отклонённый план и говорит модели ждать оператора', async () => {
    const { protocol, state, calls } = fixture({ review: () => 'rejected' })
    await protocol.invoke(readCall, context)

    const answer = await protocol.invoke(submission(), context)

    expect(answer.output).toContain('отклонил')
    // Задача вернулась к исследованию: исполнять нечего.
    expect(state.status(identity)).toMatchObject({ phase: 'research', totalSteps: 0 })
    await expect(protocol.invoke(writeCall, context))
      .resolves.toMatchObject({ ok: false, output: expect.stringContaining('доступно только чтение') })
    expect(calls.map(call => call.name)).toEqual(['read_file'])
  })

  it('сломанная карточка означает отказ, а не молчаливое согласие', async () => {
    const { protocol, state, calls } = fixture({
      review: () => { throw new Error('чат недоступен') },
    })
    await protocol.invoke(readCall, context)

    await expect(protocol.invoke(submission(), context))
      .resolves.toMatchObject({ ok: false, output: expect.stringContaining('Не удалось показать план') })
    // План не остаётся «поданным» в ожидании ответа, которого не будет.
    expect(state.status(identity)).toMatchObject({ phase: 'research' })
    expect(calls.map(call => call.name)).toEqual(['read_file'])
  })

  it('любой ответ кроме одобрения считается отказом', async () => {
    const { protocol, state } = fixture({
      review: () => 'что-то ещё' as unknown as PlanReviewDecision,
    })
    await protocol.invoke(readCall, context)

    await protocol.invoke(submission(), context)

    expect(state.status(identity)).toMatchObject({ phase: 'research' })
  })

  it('одобрение спрашивают один раз на план, а не на каждый шаг', async () => {
    const { protocol, reviewed, calls } = fixture()
    await protocol.invoke(readCall, context)
    await protocol.invoke(submission(), context)

    // Повторная подача того же плана не поднимает карточку второй раз.
    const again = await protocol.invoke(submission(), context)

    expect(again.output).toContain('одобрил')
    expect(reviewed).toHaveLength(1)
    await protocol.invoke(writeCall, context)
    expect(calls.map(call => call.name)).toEqual(['read_file', 'write_file'])
    expect(reviewed).toHaveLength(1)
  })

  it('карточка несёт хэш именно того плана, что показан', async () => {
    const { protocol, reviewed, state } = fixture()
    await protocol.invoke(readCall, context)
    await protocol.invoke(submission(), context)

    expect(reviewed[0]?.planHash).toMatch(/^[a-f0-9]{64}$/)
    expect(state.status(identity)).toMatchObject({ phase: 'approved' })
  })

  it('checks the exact planned action before approval and marks attempted only after the gate', async () => {
    const { protocol, state, calls } = fixture()
    await protocol.invoke(readCall, context)
    await protocol.invoke(submission(), context)

    const accepted = await protocol.preflight(writeCall, context)
    expect(accepted).toMatchObject({ kind: 'continue', call: writeCall })
    expect(state.status(identity)).toMatchObject({ phase: 'approved', nextStep: 0 })
    expect(calls.map(call => call.name)).toEqual(['read_file'])

    await expect(accepted.kind === 'continue'
      ? protocol.executeAfterGate(accepted.call, context)
      : Promise.resolve(accepted.result)).resolves.toEqual({ ok: true, output: 'write_file: ok' })
    expect(state.status(identity)).toMatchObject({ phase: 'completed', nextStep: 1 })
  })

  it('rejects plan drift before the real executor and returns to research', async () => {
    const { protocol, state, calls } = fixture()
    await protocol.invoke(readCall, context)
    await protocol.invoke(submission(), context)
    const changed: ToolCall = Object.freeze({
      name: 'write_file', args: Object.freeze({ path: 'src/other.ts', content: 'next' }),
    })

    await expect(protocol.invoke(changed, context)).resolves.toEqual({
      ok: false, output: expect.stringContaining('не совпадает с одобренным планом'),
    })
    expect(calls.map(call => call.name)).toEqual(['read_file'])
    expect(state.status(identity)).toMatchObject({ phase: 'research', revision: 2 })
  })

  it('uses a detached call snapshot even if caller data changes during durable admission', async () => {
    const mutableArgs = { path: 'src/index.ts', content: 'next' }
    const mutableCall: ToolCall = { name: 'write_file', args: mutableArgs }
    let mutateOnAttempt = false
    const store = memory({
      onSave: (saved) => {
        if (mutateOnAttempt && saved.tasks[0]?.phase === 'attempted') {
          mutableArgs.path = 'src/other.ts'
          mutableArgs.content = 'tampered'
        }
      },
    })
    const seen: ToolCall[] = []
    const { protocol } = fixture({
      store,
      execute: async (call) => { seen.push(call); return { ok: true, output: 'ok' } },
    })
    await protocol.invoke(readCall, context)
    await protocol.invoke(submission(plan(mutableCall)), context)
    mutateOnAttempt = true

    await expect(protocol.invoke(mutableCall, context)).resolves.toEqual({ ok: true, output: 'ok' })
    expect(seen[1]).toEqual(writeCall)
    expect(seen[1]).not.toBe(mutableCall)
  })

  it('leaves a thrown or malformed executor result attempted and restart makes it ambiguous', async () => {
    for (const [kind, execute] of [
      ['throw', async (call: ToolCall): Promise<ToolResult> => {
        if (call.name === 'read_file') return { ok: true, output: 'read' }
        throw new Error('lost connection')
      }],
      ['malformed', async (call: ToolCall) => call.name === 'read_file'
        ? { ok: true, output: 'read' }
        : ({ ok: true } as unknown as ToolResult)],
    ] as const) {
      const store = memory()
      const current = fixture({ store, execute })
      await current.protocol.invoke(readCall, context)
      await current.protocol.invoke(submission(), context)
      if (kind === 'throw') {
        await expect(current.protocol.invoke(writeCall, context))
          .rejects.toThrow('PLAN_EXECUTION_ACTION_AMBIGUOUS')
      } else {
        await expect(current.protocol.invoke(writeCall, context)).resolves.toEqual({
          ok: false, output: 'PLAN_EXECUTOR_RESULT_INVALID',
        })
      }
      expect(current.state.status(identity)).toMatchObject({ phase: 'attempted' })
      const restarted = fixture({ store })
      expect(restarted.state.status(identity)).toMatchObject({ phase: 'ambiguous' })
    }
  })

  it('requires the transport-owned turn id and performs zero I/O without it', async () => {
    const { protocol, calls } = fixture()

    await expect(protocol.invoke(readCall, { sessionId: 'session-a' })).resolves.toEqual({
      ok: false, output: 'PLAN_EXECUTION_IDENTITY_REQUIRED',
    })
    expect(calls).toHaveLength(0)
  })

  it('counts only successful research and requires fresh research after a known failed step', async () => {
    let fail = true
    const { protocol, state } = fixture({
      execute: async (call) => call.name === 'read_file' && fail
        ? { ok: false, output: 'not found' }
        : call.name === 'write_file'
          ? { ok: false, output: 'write rejected' }
          : { ok: true, output: 'ok' },
    })
    await protocol.invoke(readCall, context)
    expect(state.status(identity)).toBeNull()
    fail = false
    await protocol.invoke(readCall, context)
    await protocol.invoke(submission(), context)

    await expect(protocol.invoke(writeCall, context)).resolves.toEqual({ ok: false, output: 'write rejected' })
    expect(state.status(identity)).toMatchObject({ phase: 'research', revision: 2, researchObservations: 0 })
  })

  it('rejects accessor/Proxy calls and mutable dependency replacement without invoking traps', async () => {
    const base = memory()
    const state = makePlanExecutionStateController({ persistence: base.port, toolEffect: effect })
    let executions = 0
    const deps = {
      state,
      mode: () => 'plan',
      toolEffect: effect,
      execute: async (): Promise<ToolResult> => { executions++; return { ok: true, output: 'ok' } },
      reviewPlan: (): PlanReviewDecision => 'approved',
      workBindingHash: WORK_BINDING_HASH,
      policyRevision: POLICY_REVISION,
    }
    const protocol = makePlanToolProtocol(deps)
    deps.execute = async () => { throw new Error('mutated') }
    let getters = 0
    const accessor = Object.defineProperty({ name: 'read_file' }, 'args', {
      enumerable: true,
      get: () => { getters++; return {} },
    }) as ToolCall

    await expect(protocol.invoke(accessor, context)).resolves.toEqual({
      ok: false, output: 'PLAN_PROTOCOL_INPUT_INVALID',
    })
    await expect(protocol.invoke(new Proxy(readCall, {}), context)).resolves.toEqual({
      ok: false, output: 'PLAN_PROTOCOL_INPUT_INVALID',
    })
    await protocol.invoke(readCall, context)
    expect(getters).toBe(0)
    expect(executions).toBe(1)

    expect(() => makePlanToolProtocol({ ...deps, execute: new Proxy(deps.execute, {}) }))
      .toThrow('PLAN_PROTOCOL_INPUT_INVALID')
  })

  it('is installed on native and subscription production paths as one live protocol', () => {
    const live = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')
    expect(live).toContain('PLAN_SUBMIT_TOOL_DEFINITION')
    expect(live).toContain('mainPlanProtocol.preflight')
    expect(live).toContain('mainPlanProtocol.executeAfterGate')
    expect(live).toContain('mainPlanProtocol.observeAfterGate')
    expect(live).toContain('subscriptionPlanProtocol.preflight')
    expect(live).toContain('subscriptionPlanProtocol.executeAfterGate')
    expect(live).toContain('subscriptionPlanProtocol.observeAfterGate')
    expect(live).toContain("policyRevision: 'plan-live-v1'")
  })
})
