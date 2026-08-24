// Provider-neutral dormant protocol for ADR-0092. It sits after ordinary
// Safety/approval and immediately before the real executor. API providers and
// subscription MCP bridges can therefore share one Plan Mode state machine.

import { types as utilTypes } from 'node:util'

import type {
  AnthropicTool,
  ModelToolRuntimeContext,
  ToolCall,
  ToolResult,
} from '@aisy/core'

import {
  PlanExecutionStateError,
  snapshotPlanExecutionCallV1,
  type PlanExecutionIdentityV1,
  type PlanExecutionStateController,
  type PlanExecutionToolEffect,
} from './plan-execution-state.js'

const HASH = /^[a-f0-9]{64}$/
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const PLAN_TOOL_NAME = 'submit_plan'

export const PLAN_SUBMIT_TOOL_DEFINITION: AnthropicTool = Object.freeze({
  name: PLAN_TOOL_NAME,
  description: 'Finish Plan Mode research and show the operator what you intend to do. ' +
    'Arg `plan` is exact JSON: ' +
    '{"version":1,"steps":[{"intent":"...","call":{"name":"tool","args":{...}}}]}. ' +
    'Each `intent` is one plain sentence the operator reads — write what changes for them, ' +
    'not which function you call. The tool blocks until they tap: on approval, call those ' +
    'tools in the same order; on refusal, stop and wait for what they say next. ' +
    'Never ask for permission in prose — this tool is the ask. ' +
    'Outside Plan Mode the tool still works and review is voluntary: reach for it when a ' +
    'task is broad enough that the operator would rather correct the plan once than be ' +
    'interrupted at every step. A single obvious action does not need it.',
  input_schema: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      plan: Object.freeze({ type: 'string' }),
    }),
    required: Object.freeze(['plan']),
    additionalProperties: false,
  }),
})

/** Шаг плана в том виде, в каком его читает оператор. */
export interface PlanReviewStep {
  /** Одно предложение о том, что изменится. Пишет модель, читает человек. */
  readonly intent: string
  /** Имя инструмента — для тех, кто хочет точности. */
  readonly tool: string
}

export interface PlanReviewView {
  readonly planHash: string
  readonly steps: readonly PlanReviewStep[]
}

export type PlanReviewDecision = 'approved' | 'rejected'

export interface PlanToolProtocol {
  preflight(call: ToolCall, context: ModelToolRuntimeContext): Promise<PlanToolPreflightResult>
  executeAfterGate(call: ToolCall, context: ModelToolRuntimeContext): Promise<ToolResult>
  observeAfterGate(call: ToolCall, context: ModelToolRuntimeContext, result: unknown): void
  invoke(call: ToolCall, context: ModelToolRuntimeContext): Promise<ToolResult>
}

export type PlanToolPreflightResult =
  | Readonly<{ kind: 'continue'; call: ToolCall }>
  | Readonly<{ kind: 'intercept'; result: ToolResult }>

interface CapturedDeps {
  state: PlanExecutionStateController
  mode(): string
  toolEffect(name: string): PlanExecutionToolEffect | null
  execute(call: ToolCall, context: ModelToolRuntimeContext): Promise<ToolResult>
  reviewPlan(view: PlanReviewView): Promise<PlanReviewDecision>
  workBindingHash: string
  policyRevision: string
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) throw new Error('PLAN_PROTOCOL_INPUT_INVALID')
  const descriptors = Object.getOwnPropertyDescriptors(value as object) as Record<string, PropertyDescriptor>
  const own = Object.keys(descriptors)
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) {
    throw new Error('PLAN_PROTOCOL_INPUT_INVALID')
  }
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error('PLAN_PROTOCOL_INPUT_INVALID')
    }
    result[key] = descriptor.value
  }
  return result
}

function strictFunction(value: unknown): (...args: unknown[]) => unknown {
  if (typeof value !== 'function' || utilTypes.isProxy(value)) {
    throw new Error('PLAN_PROTOCOL_INPUT_INVALID')
  }
  return value as (...args: unknown[]) => unknown
}

function captureDeps(value: unknown): CapturedDeps {
  const input = exactRecord(value, [
    'state', 'mode', 'toolEffect', 'execute', 'reviewPlan', 'workBindingHash', 'policyRevision',
  ])
  const stateSource = input['state']
  const state = exactRecord(stateSource, [
    'observeResearch', 'submitPlan', 'approvePlan', 'rejectPlan', 'preflightPlannedCall',
    'admitPlannedCall', 'settlePlannedCall', 'status',
  ])
  const observeResearch = strictFunction(state['observeResearch'])
  const submitPlan = strictFunction(state['submitPlan'])
  const approvePlan = strictFunction(state['approvePlan'])
  const rejectPlan = strictFunction(state['rejectPlan'])
  const preflightPlannedCall = strictFunction(state['preflightPlannedCall'])
  const admitPlannedCall = strictFunction(state['admitPlannedCall'])
  const settlePlannedCall = strictFunction(state['settlePlannedCall'])
  const status = strictFunction(state['status'])
  const mode = strictFunction(input['mode'])
  const toolEffect = strictFunction(input['toolEffect'])
  const execute = strictFunction(input['execute'])
  const reviewPlan = strictFunction(input['reviewPlan'])
  if (typeof input['workBindingHash'] !== 'string' || !HASH.test(input['workBindingHash']) ||
    typeof input['policyRevision'] !== 'string' || !SAFE_REVISION.test(input['policyRevision'])) {
    throw new Error('PLAN_PROTOCOL_INPUT_INVALID')
  }
  return Object.freeze({
    state: Object.freeze({
      observeResearch: (...args: Parameters<PlanExecutionStateController['observeResearch']>) =>
        Reflect.apply(observeResearch, stateSource, args) as ReturnType<PlanExecutionStateController['observeResearch']>,
      submitPlan: (...args: Parameters<PlanExecutionStateController['submitPlan']>) =>
        Reflect.apply(submitPlan, stateSource, args) as ReturnType<PlanExecutionStateController['submitPlan']>,
      approvePlan: (...args: Parameters<PlanExecutionStateController['approvePlan']>) =>
        Reflect.apply(approvePlan, stateSource, args) as ReturnType<PlanExecutionStateController['approvePlan']>,
      rejectPlan: (...args: Parameters<PlanExecutionStateController['rejectPlan']>) =>
        Reflect.apply(rejectPlan, stateSource, args) as ReturnType<PlanExecutionStateController['rejectPlan']>,
      preflightPlannedCall: (...args: Parameters<PlanExecutionStateController['preflightPlannedCall']>) =>
        Reflect.apply(preflightPlannedCall, stateSource, args) as ReturnType<PlanExecutionStateController['preflightPlannedCall']>,
      admitPlannedCall: (...args: Parameters<PlanExecutionStateController['admitPlannedCall']>) =>
        Reflect.apply(admitPlannedCall, stateSource, args) as ReturnType<PlanExecutionStateController['admitPlannedCall']>,
      settlePlannedCall: (...args: Parameters<PlanExecutionStateController['settlePlannedCall']>) =>
        Reflect.apply(settlePlannedCall, stateSource, args) as ReturnType<PlanExecutionStateController['settlePlannedCall']>,
      status: (...args: Parameters<PlanExecutionStateController['status']>) =>
        Reflect.apply(status, stateSource, args) as ReturnType<PlanExecutionStateController['status']>,
    }),
    mode: (): string => {
      const result = Reflect.apply(mode, undefined, [])
      if (typeof result !== 'string') throw new Error('PLAN_PROTOCOL_UNAVAILABLE')
      return result
    },
    toolEffect: (name: string): PlanExecutionToolEffect | null => {
      const result = Reflect.apply(toolEffect, undefined, [name])
      if (result === null) return null
      if (typeof result !== 'string' || !['read', 'write', 'execute', 'delegate'].includes(result)) {
        throw new Error('PLAN_PROTOCOL_UNAVAILABLE')
      }
      return result as PlanExecutionToolEffect
    },
    execute: (call: ToolCall, context: ModelToolRuntimeContext): Promise<ToolResult> =>
      Promise.resolve(Reflect.apply(execute, undefined, [call, context]) as ToolResult | Promise<ToolResult>),
    reviewPlan: async (view: PlanReviewView): Promise<PlanReviewDecision> => {
      const decision = await Promise.resolve(
        Reflect.apply(reviewPlan, undefined, [view]) as PlanReviewDecision | Promise<PlanReviewDecision>)
      // Всё, что не внятное «одобрено», означает отказ: молчание транспорта не
      // может стать согласием человека.
      return decision === 'approved' ? 'approved' : 'rejected'
    },
    workBindingHash: input['workBindingHash'],
    policyRevision: input['policyRevision'],
  })
}

function identity(deps: CapturedDeps, value: unknown): PlanExecutionIdentityV1 {
  let input: Record<string, unknown>
  try {
    if (typeof value !== 'object' || value === null || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
      throw new Error('invalid')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value as object) as Record<string, PropertyDescriptor>
    const keys = Object.keys(descriptors)
    if (!keys.includes('sessionId') || keys.some(key => !['sessionId', 'turnId'].includes(key))) {
      throw new Error('invalid')
    }
    input = exactRecord(value, keys)
  } catch {
    throw new Error('PLAN_EXECUTION_IDENTITY_REQUIRED')
  }
  if (typeof input['sessionId'] !== 'string' || input['sessionId'].length === 0 ||
    typeof input['turnId'] !== 'string' || input['turnId'].length === 0) {
    throw new Error('PLAN_EXECUTION_IDENTITY_REQUIRED')
  }
  return Object.freeze({
    version: 1,
    sessionId: input['sessionId'],
    turnId: input['turnId'],
    workBindingHash: deps.workBindingHash,
    policyRevision: deps.policyRevision,
  })
}

function snapshotToolCall(call: unknown): ToolCall {
  if (typeof call !== 'object' || call === null || utilTypes.isProxy(call) ||
    Object.getPrototypeOf(call) !== Object.prototype ||
    Object.getOwnPropertySymbols(call).length !== 0) throw new Error('PLAN_PROTOCOL_INPUT_INVALID')
  const descriptors = Object.getOwnPropertyDescriptors(call as object) as Record<string, PropertyDescriptor>
  const keys = Object.keys(descriptors)
  if (!keys.includes('name') || !keys.includes('args') ||
    keys.some(key => !['name', 'args', 'sourceSpanProvenance'].includes(key))) {
    throw new Error('PLAN_PROTOCOL_INPUT_INVALID')
  }
  for (const key of keys) {
    const descriptor = descriptors[key]!
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
      descriptor.set !== undefined) throw new Error('PLAN_PROTOCOL_INPUT_INVALID')
  }
  const rawName = descriptors['name']!.value
  let captured: { name: string; args: Readonly<Record<string, unknown>> }
  if (rawName === PLAN_TOOL_NAME) {
    const plan = submitJson(Object.freeze({ name: rawName, args: descriptors['args']!.value }))
    captured = Object.freeze({ name: PLAN_TOOL_NAME, args: Object.freeze({ plan }) })
  } else {
    captured = snapshotPlanExecutionCallV1(Object.freeze({
      name: rawName,
      args: descriptors['args']!.value,
    }))
  }
  const provenance = descriptors['sourceSpanProvenance']?.value
  if (provenance !== undefined && provenance !== 'operator' && provenance !== 'untrusted') {
    throw new Error('PLAN_PROTOCOL_INPUT_INVALID')
  }
  return Object.freeze({
    name: captured.name,
    args: captured.args,
    ...(provenance === undefined ? {} : { sourceSpanProvenance: provenance }),
  })
}

function submitJson(call: ToolCall): string {
  let args: Record<string, unknown>
  try { args = exactRecord(call.args, ['plan']) } catch {
    throw new Error('PLAN_EXECUTION_PLAN_INVALID')
  }
  if (typeof args['plan'] !== 'string') throw new Error('PLAN_EXECUTION_PLAN_INVALID')
  return args['plan']
}

function result(value: unknown): ToolResult | null {
  try {
    let captured: Record<string, unknown>
    try {
      captured = exactRecord(value, ['ok', 'output'])
    } catch {
      captured = exactRecord(value, ['ok', 'output', 'verified'])
    }
    if (typeof captured['ok'] !== 'boolean' || typeof captured['output'] !== 'string') return null
    if (Object.hasOwn(captured, 'verified') && captured['verified'] !== true) return null
    return Object.freeze({
      ok: captured['ok'],
      output: captured['output'],
      ...(captured['verified'] === true ? { verified: true as const } : {}),
    })
  } catch {
    return null
  }
}

function code(error: unknown): string {
  if (error instanceof PlanExecutionStateError) return error.code
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)) return error.message
  return 'PLAN_PROTOCOL_UNAVAILABLE'
}

function refused(output: string): ToolResult {
  return Object.freeze({ ok: false, output: REFUSAL[output] ?? output })
}

/**
 * Отказы, которые читает модель — а через её пересказ и оператор.
 *
 * Код состояния ничего не объясняет ни тому, ни другому: живой агент однажды
 * ответил «Инструменты недоступны (PLAN_PROTOCOL_UNAVAILABLE)», потому что сам
 * не понял, что находится в режиме планирования. Здесь — что происходит и что
 * делать дальше; технический код остаётся в журнале.
 */
const REFUSAL: Readonly<Record<string, string>> = Object.freeze({
  PLAN_EXECUTION_RESEARCH_REQUIRED:
    'Сейчас режим «сначала план»: пока идёт исследование, доступно только чтение. ' +
    'Собери нужное и подай план через submit_plan — оператор его подтвердит.',
  PLAN_EXECUTION_APPROVAL_REQUIRED:
    'План показан оператору и ждёт его решения. Не выполняй шаги, пока он не ответил.',
  PLAN_APPROVAL_UNAVAILABLE:
    'Не удалось показать план оператору, поэтому выполнять его нельзя. ' +
    'Скажи об этом словами и предложи повторить.',
  PLAN_EXECUTION_PLAN_DRIFT:
    'Этот вызов не совпадает с одобренным планом. Работа остановлена: ' +
    'подай новый план на подтверждение.',
  PLAN_EXECUTION_ACTION_AMBIGUOUS:
    'Предыдущее действие прервалось, и неизвестно, успело ли оно выполниться. ' +
    'Не повторяй его вслепую — сначала проверь фактическое состояние.',
  PLAN_EXECUTION_ALREADY_COMPLETED: 'Этот план уже выполнен целиком.',
  PLAN_EXECUTION_TOOL_UNKNOWN: 'Такого инструмента нет в каталоге, планировать его нельзя.',
  PLAN_MODE_INACTIVE: 'Режим «сначала план» выключен — submit_plan сейчас не нужен, действуй.',
})

/** Что читает модель после тапа «выполнять»: инструкция, а не код состояния. */
function approvedResult(): ToolResult {
  return Object.freeze({
    ok: true,
    output: 'Оператор одобрил план. Выполняй шаги в том же порядке, ' +
      'без дополнительных вопросов о начале работы.',
  })
}

export function makePlanToolProtocol(input: {
  state: PlanExecutionStateController
  mode(): string
  toolEffect(name: string): PlanExecutionToolEffect | null
  execute(call: ToolCall, context: ModelToolRuntimeContext): Promise<ToolResult> | ToolResult
  /**
 * Показать план оператору и дождаться решения (ADR-0100). Порт обязателен:
   * режим, в котором план показать некому, не может исполнять план — иначе
   * «сначала согласуй» тихо превращается в «делай сразу».
   */
  reviewPlan(view: PlanReviewView): Promise<PlanReviewDecision> | PlanReviewDecision
  workBindingHash: string
  policyRevision: string
}): PlanToolProtocol {
  const deps = captureDeps(input)

  /**
   * Разбирает поданный план для показа человеку.
   *
   * `intent` берётся из подачи, а не из durable-состояния: там намеренно лежат
   * только имена и хэши (ADR-0092), и карточке нужен текст, который написала
   * модель именно сейчас.
   */
  const reviewView = (planJson: string, planHash: string): PlanReviewView => {
    const steps: PlanReviewStep[] = []
    try {
      const parsed = JSON.parse(planJson) as { steps?: unknown }
      const raw = Array.isArray(parsed.steps) ? parsed.steps : []
      for (const item of raw.slice(0, 32)) {
        if (typeof item !== 'object' || item === null) continue
        const step = item as { intent?: unknown; call?: unknown }
        const call = typeof step.call === 'object' && step.call !== null
          ? (step.call as { name?: unknown })
          : {}
        steps.push(Object.freeze({
          intent: typeof step.intent === 'string' ? step.intent.slice(0, 300) : '',
          tool: typeof call.name === 'string' ? call.name : 'неизвестный шаг',
        }))
      }
    } catch { /* состояние уже приняло план; карточка покажет то, что смогла */ }
    return Object.freeze({ planHash, steps: Object.freeze(steps) })
  }

  /**
   * Добровольное согласование вне режима «сначала план».
   *
   * Durable-контракта шагов здесь нет намеренно: иначе «без спроса» тихо стал
   * бы «сначала план», а режим выбирает оператор, а не модель. Остаётся ровно
   * то, за чем агент сюда пришёл, — показать замысел и получить ответ.
   */
  const voluntaryReview = async (call: ToolCall): Promise<PlanToolPreflightResult> => {
    let planJson: string
    try {
      planJson = submitJson(snapshotToolCall(call))
    } catch (error) {
      return Object.freeze({ kind: 'intercept', result: refused(code(error)) })
    }
    let decision: PlanReviewDecision
    try {
      // Хэша плана здесь нет: он живёт вместе с durable-контрактом, которого в
      // этом режиме нет. Карточке достаточно самих шагов.
      decision = await deps.reviewPlan(reviewView(planJson, ''))
    } catch {
      return Object.freeze({ kind: 'intercept', result: refused('PLAN_APPROVAL_UNAVAILABLE') })
    }
    return Object.freeze({
      kind: 'intercept',
      result: Object.freeze(decision === 'approved'
        ? {
          ok: true,
          output: 'Оператор одобрил план. Выполняй его; отдельного разрешения на ' +
            'начало не нужно.',
        }
        : {
          ok: true,
          output: 'Оператор отклонил план. Не выполняй его шаги и дождись, ' +
            'что он скажет дальше.',
        }),
    })
  }

  /**
   * Подать план и дождаться человека. Между этими двумя событиями агент не
   * делает ничего — в этом весь режим.
   */
  const submitAndReview = async (
    capturedCall: ReturnType<typeof snapshotToolCall>,
    task: PlanExecutionIdentityV1,
  ): Promise<PlanToolPreflightResult> => {
    let planJson: string
    let submitted: ReturnType<PlanExecutionStateController['submitPlan']>
    try {
      planJson = submitJson(capturedCall)
      submitted = deps.state.submitPlan(task, planJson)
    } catch (error) {
      return Object.freeze({ kind: 'intercept', result: refused(code(error)) })
    }
    if (submitted.kind === 'already-completed') {
      return Object.freeze({ kind: 'intercept', result: refused('PLAN_EXECUTION_ALREADY_COMPLETED') })
    }
    // Повторная подача уже одобренного плана не поднимает карточку второй раз:
    // человек ответил, и переспрашивать — значит не верить его ответу.
    if (deps.state.status(task)?.phase === 'approved') {
      return Object.freeze({ kind: 'intercept', result: approvedResult() })
    }

    let decision: PlanReviewDecision
    try {
      decision = await deps.reviewPlan(reviewView(planJson, submitted.planHash))
    } catch {
      // Карточку не удалось показать — значит согласия нет. План отзывается,
      // иначе он остался бы «поданным» и ждал бы одобрения, которого не будет.
      try { deps.state.rejectPlan(task) } catch { /* сужение прав — best effort */ }
      return Object.freeze({ kind: 'intercept', result: refused('PLAN_APPROVAL_UNAVAILABLE') })
    }

    try {
      if (decision === 'approved') {
        deps.state.approvePlan(task, submitted.planHash)
        return Object.freeze({ kind: 'intercept', result: approvedResult() })
      }
      deps.state.rejectPlan(task)
    } catch (error) {
      return Object.freeze({ kind: 'intercept', result: refused(code(error)) })
    }
    return Object.freeze({
      kind: 'intercept',
      result: Object.freeze({
        ok: true,
        output: 'Оператор отклонил план. Не выполняй его шаги. Дождись, что он скажет ' +
          'дальше, и учти правку в новом плане.',
      }),
    })
  }

  const preflight = async (
    call: ToolCall,
    context: ModelToolRuntimeContext,
  ): Promise<PlanToolPreflightResult> => {
    let currentMode: string
    try { currentMode = deps.mode() } catch (error) {
      return Object.freeze({ kind: 'intercept', result: refused(code(error)) })
    }
    if (currentMode !== 'plan') {
      // Обычные инструменты этот гейт не трогает и аргументы не копирует.
      if (call.name !== PLAN_TOOL_NAME) return Object.freeze({ kind: 'continue', call })
      // Вне режима «сначала план» согласование добровольное: агент сам решил,
      // что задача крупная, и спрашивает. Отказ здесь ничего не блокирует —
      // инструменты в этом режиме и так открыты, — но остаётся ответом
      // человека, и модель обязана его услышать.
      return voluntaryReview(call)
    }

    let capturedCall: ReturnType<typeof snapshotToolCall>
    let task: PlanExecutionIdentityV1
    try {
      capturedCall = snapshotToolCall(call)
      task = identity(deps, context)
    } catch (error) {
      return Object.freeze({ kind: 'intercept', result: refused(code(error)) })
    }

    if (capturedCall.name === PLAN_TOOL_NAME) {
      return submitAndReview(capturedCall, task)
    }

    let phase: ReturnType<PlanExecutionStateController['status']>
    let effect: PlanExecutionToolEffect | null
    try {
      phase = deps.state.status(task)
      effect = deps.toolEffect(capturedCall.name)
    } catch (error) {
      return Object.freeze({ kind: 'intercept', result: refused(code(error)) })
    }
    if (effect === null) {
      return Object.freeze({ kind: 'intercept', result: refused('PLAN_EXECUTION_TOOL_UNKNOWN') })
    }
    if (phase === null || phase.phase === 'research') {
      return effect === 'read'
        ? Object.freeze({ kind: 'continue', call: capturedCall })
        : Object.freeze({ kind: 'intercept', result: refused('PLAN_EXECUTION_RESEARCH_REQUIRED') })
    }
    if (phase.phase === 'attempted' || phase.phase === 'ambiguous') {
      return Object.freeze({ kind: 'intercept', result: refused('PLAN_EXECUTION_ACTION_AMBIGUOUS') })
    }
    if (phase.phase === 'completed') {
      return Object.freeze({ kind: 'intercept', result: refused('PLAN_EXECUTION_ALREADY_COMPLETED') })
    }
    try {
      deps.state.preflightPlannedCall(task, capturedCall)
      return Object.freeze({ kind: 'continue', call: capturedCall })
    } catch (error) {
      return Object.freeze({ kind: 'intercept', result: refused(code(error)) })
    }
  }

  const executeAfterGate = async (
    call: ToolCall,
    context: ModelToolRuntimeContext,
  ): Promise<ToolResult> => {
    let currentMode: string
    try { currentMode = deps.mode() } catch (error) { return refused(code(error)) }
    if (currentMode !== 'plan') {
      if (call.name === PLAN_TOOL_NAME) return refused('PLAN_MODE_INACTIVE')
      const passthrough = await deps.execute(call, context)
      return result(passthrough) ?? refused('PLAN_EXECUTOR_RESULT_INVALID')
    }

    let capturedCall: ReturnType<typeof snapshotToolCall>
    let task: PlanExecutionIdentityV1
    try {
      capturedCall = snapshotToolCall(call)
      task = identity(deps, context)
    } catch (error) {
      return refused(code(error))
    }
    if (capturedCall.name === PLAN_TOOL_NAME) return refused('PLAN_PROTOCOL_ORDER_INVALID')

    let phase: ReturnType<PlanExecutionStateController['status']>
    let effect: PlanExecutionToolEffect | null
    try {
      phase = deps.state.status(task)
      effect = deps.toolEffect(capturedCall.name)
    } catch (error) {
      return refused(code(error))
    }
    if (effect === null) return refused('PLAN_EXECUTION_TOOL_UNKNOWN')

    if (phase === null || phase.phase === 'research') {
      if (effect !== 'read') return refused('PLAN_EXECUTION_RESEARCH_REQUIRED')
      let observed: ToolResult
      try {
        const raw = await deps.execute(capturedCall, context)
        const captured = result(raw)
        if (captured === null) return refused('PLAN_EXECUTOR_RESULT_INVALID')
        observed = captured
      } catch {
        return refused('PLAN_EXECUTION_READ_FAILED')
      }
      return observed
    }

    if (phase.phase === 'attempted' || phase.phase === 'ambiguous') {
      return refused('PLAN_EXECUTION_ACTION_AMBIGUOUS')
    }
    if (phase.phase === 'completed') return refused('PLAN_EXECUTION_ALREADY_COMPLETED')

    let permit
    try { permit = deps.state.admitPlannedCall(task, capturedCall) } catch (error) {
      return refused(code(error))
    }
    // Once admitted, a thrown or malformed executor result deliberately
    // leaves durable `attempted`; restart recovers it as `ambiguous`.
    let raw: ToolResult
    try { raw = await deps.execute(capturedCall, context) } catch {
      throw new Error('PLAN_EXECUTION_ACTION_AMBIGUOUS')
    }
    const terminal = result(raw)
    if (terminal === null) return refused('PLAN_EXECUTOR_RESULT_INVALID')
    try { deps.state.settlePlannedCall(permit, { succeeded: terminal.ok }) } catch (error) {
      return refused(code(error))
    }
    return terminal
  }

  const observeAfterGate = (
    call: ToolCall,
    context: ModelToolRuntimeContext,
    observedResult: unknown,
  ): void => {
    if (deps.mode() !== 'plan') return
    const capturedCall = snapshotToolCall(call)
    if (capturedCall.name === PLAN_TOOL_NAME || deps.toolEffect(capturedCall.name) !== 'read') return
    const task = identity(deps, context)
    const phase = deps.state.status(task)
    if (phase !== null && phase.phase !== 'research') return
    const observed = result(observedResult)
    if (observed?.ok === true) deps.state.observeResearch(task, capturedCall, true)
  }

  return Object.freeze({
    preflight,
    executeAfterGate,
    observeAfterGate,
    async invoke(call: ToolCall, context: ModelToolRuntimeContext): Promise<ToolResult> {
      const decision = await preflight(call, context)
      if (decision.kind === 'intercept') return decision.result
      const terminal = await executeAfterGate(decision.call, context)
      observeAfterGate(decision.call, context, terminal)
      return terminal
    },
  })
}
