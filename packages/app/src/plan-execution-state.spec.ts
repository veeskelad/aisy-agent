import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  makeNodePlanExecutionPersistence,
  makePlanExecutionStateController,
  PlanExecutionStateError,
  type PlanExecutionCallV1,
  type PlanExecutionIdentityV1,
  type PlanExecutionPersistedStateV1,
  type PlanExecutionPersistencePort,
  type PlanExecutionPermitV1,
  type PlanExecutionToolEffect,
} from './plan-execution-state.js'

const roots: string[] = []

const identity: PlanExecutionIdentityV1 = Object.freeze({
  version: 1,
  sessionId: 'session-secret-name',
  turnId: 'turn-secret-name',
  workBindingHash: 'a'.repeat(64),
  policyRevision: 'policy-1',
})

const readCall: PlanExecutionCallV1 = Object.freeze({
  name: 'read_file',
  args: Object.freeze({ path: '/workspace/src/index.ts' }),
})

const writeCall: PlanExecutionCallV1 = Object.freeze({
  name: 'write_file',
  args: Object.freeze({ path: '/workspace/src/index.ts', content: 'secret-value' }),
})

function plan(...calls: PlanExecutionCallV1[]): string {
  return JSON.stringify({
    version: 1,
    steps: calls.map((call, index) => ({ intent: `Шаг ${index + 1}`, call })),
  })
}

function effect(name: string): PlanExecutionToolEffect | null {
  if (name === 'read_file') return 'read'
  if (name === 'write_file') return 'write'
  if (name === 'bash') return 'execute'
  return null
}

function memory(initial?: unknown): {
  port: PlanExecutionPersistencePort
  saved: PlanExecutionPersistedStateV1[]
  current(): unknown
  failNextSave(): void
} {
  let state = initial
  let shouldFail = false
  const saved: PlanExecutionPersistedStateV1[] = []
  return {
    port: Object.freeze({
      load: () => state,
      save: (next: PlanExecutionPersistedStateV1) => {
        if (shouldFail) {
          shouldFail = false
          throw new Error('disk unavailable')
        }
        state = structuredClone(next)
        saved.push(structuredClone(next))
      },
    }),
    saved,
    current: () => state,
    failNextSave: () => { shouldFail = true },
  }
}

function controller(store = memory()) {
  return {
    store,
    value: makePlanExecutionStateController({
      persistence: store.port,
      toolEffect: effect,
      nowMs: () => 1_800_000_000_000,
    }),
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected an error')
  } catch (error) {
    expect(error).toBeInstanceOf(PlanExecutionStateError)
    expect((error as PlanExecutionStateError).code).toBe(code)
    expect((error as Error).message).toBe(code)
  }
}

function statePath(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-plan-execution-')))
  roots.push(root)
  return join(root, 'plan-execution.json')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('plan execution state (ADR-0092)', () => {
  it('requires successful research before accepting a plan', () => {
    const { value, store } = controller()

    expectCode(() => value.submitPlan(identity, plan(writeCall)), 'PLAN_EXECUTION_RESEARCH_REQUIRED')
    expect(value.observeResearch(identity, writeCall, true)).toEqual({ kind: 'ignored', observations: 0 })
    expect(value.observeResearch(identity, readCall, false)).toEqual({ kind: 'ignored', observations: 0 })
    expect(store.saved).toHaveLength(0)

    expect(value.observeResearch(identity, readCall, true)).toEqual({ kind: 'recorded', observations: 1 })
    expect(value.submitPlan(identity, plan(writeCall))).toMatchObject({ kind: 'accepted', totalSteps: 1 })
  })

  /** Подать план и одобрить его: сценарии ниже проверяют не согласие, а шаги. */
  function submitApproved(
    value: ReturnType<typeof controller>['value'],
    planJson: string,
  ): void {
    const { planHash } = value.submitPlan(identity, planJson)
    value.approvePlan(identity, planHash)
  }

  it('stores hashes rather than task identity, intents or raw tool arguments', () => {
    const { value, store } = controller()
    value.observeResearch(identity, readCall, true)
    submitApproved(value, plan(writeCall))

    const encoded = JSON.stringify(store.current())
    expect(encoded).not.toContain('session-secret-name')
    expect(encoded).not.toContain('turn-secret-name')
    expect(encoded).not.toContain('secret-value')
    expect(encoded).not.toContain('/workspace/src/index.ts')
    expect(encoded).not.toContain('Шаг 1')
    expect(encoded).toContain('write_file')
  })

  it('persists attempted before issuing a one-shot permit, then advances automatically', () => {
    const { value, store } = controller()
    value.observeResearch(identity, readCall, true)
    submitApproved(value, plan(writeCall, readCall))

    expect(value.preflightPlannedCall(identity, writeCall)).toEqual({
      kind: 'matched', nextStep: 0, totalSteps: 2,
    })
    expect(value.status(identity)).toMatchObject({ phase: 'approved', nextStep: 0 })
    expect(store.saved.at(-1)?.tasks[0]?.phase).toBe('approved')

    const first = value.admitPlannedCall(identity, writeCall)
    expect(value.status(identity)).toMatchObject({ phase: 'attempted', nextStep: 0, totalSteps: 2 })
    expect(store.saved.at(-1)?.tasks[0]?.phase).toBe('attempted')
    expect(value.settlePlannedCall(first, { succeeded: true })).toEqual({ kind: 'advanced', nextStep: 1 })
    expect(value.status(identity)).toMatchObject({ phase: 'approved', nextStep: 1 })

    const second = value.admitPlannedCall(identity, readCall)
    expect(value.settlePlannedCall(second, { succeeded: true })).toEqual({ kind: 'completed', nextStep: 2 })
    expect(value.status(identity)).toMatchObject({ phase: 'completed', nextStep: 2 })
  })

  it('returns to research before I/O when the real call differs from the plan', () => {
    const { value } = controller()
    value.observeResearch(identity, readCall, true)
    submitApproved(value, plan(writeCall))

    const changed = Object.freeze({ ...writeCall, args: Object.freeze({ ...writeCall.args, content: 'changed' }) })
    expectCode(() => value.preflightPlannedCall(identity, changed), 'PLAN_EXECUTION_PLAN_DRIFT')
    expect(value.status(identity)).toEqual({
      phase: 'research', revision: 2, researchObservations: 0, nextStep: 0, totalSteps: 0,
    })
  })

  it('does not blindly retry an action interrupted by restart', () => {
    const store = memory()
    const first = controller(store).value
    first.observeResearch(identity, readCall, true)
    submitApproved(first, plan(writeCall))
    first.admitPlannedCall(identity, writeCall)

    const restarted = controller(store).value
    expect(restarted.status(identity)).toMatchObject({ phase: 'ambiguous', nextStep: 0 })
    expectCode(() => restarted.admitPlannedCall(identity, writeCall), 'PLAN_EXECUTION_ACTION_AMBIGUOUS')
    expectCode(() => restarted.submitPlan(identity, plan(writeCall)), 'PLAN_EXECUTION_ACTION_AMBIGUOUS')
  })

  it('keeps a completed side effect ambiguous when terminal persistence fails', () => {
    const store = memory()
    const first = controller(store).value
    first.observeResearch(identity, readCall, true)
    submitApproved(first, plan(writeCall))
    const permit = first.admitPlannedCall(identity, writeCall)
    store.failNextSave()

    expectCode(
      () => first.settlePlannedCall(permit, { succeeded: true }),
      'PLAN_EXECUTION_STATE_UNAVAILABLE',
    )
    expect(first.status(identity)).toMatchObject({ phase: 'attempted' })
    expect(controller(store).value.status(identity)).toMatchObject({ phase: 'ambiguous' })
  })

  it('makes identical plan submission idempotent and never reopens completed work', () => {
    const { value } = controller()
    const submitted = plan(writeCall)
    value.observeResearch(identity, readCall, true)

    const accepted = value.submitPlan(identity, submitted)
    expect(accepted.kind).toBe('accepted')
    expect(value.submitPlan(identity, submitted).kind).toBe('already-accepted')
    value.approvePlan(identity, accepted.planHash)
    const permit = value.admitPlannedCall(identity, writeCall)
    value.settlePlannedCall(permit, { succeeded: true })
    expect(value.submitPlan(identity, submitted).kind).toBe('already-completed')
    expectCode(() => value.admitPlannedCall(identity, writeCall), 'PLAN_EXECUTION_ALREADY_COMPLETED')
  })

  it('не начинает шаг, пока план не одобрен', () => {
    const { value } = controller()
    value.observeResearch(identity, readCall, true)
    value.submitPlan(identity, plan(writeCall))

    // Показанный план — ещё не разрешённый.
    expectCode(() => value.preflightPlannedCall(identity, writeCall), 'PLAN_EXECUTION_APPROVAL_REQUIRED')
    expectCode(() => value.admitPlannedCall(identity, writeCall), 'PLAN_EXECUTION_APPROVAL_REQUIRED')
    expect(value.status(identity)).toMatchObject({ phase: 'submitted' })
  })

  it('одобрение относится к прочитанному плану, а не к следующему', () => {
    const { value } = controller()
    value.observeResearch(identity, readCall, true)
    value.submitPlan(identity, plan(writeCall))

    // Чужой хэш — это согласие на план, которого оператор не видел.
    expectCode(() => value.approvePlan(identity, 'f'.repeat(64)), 'PLAN_EXECUTION_PLAN_DRIFT')
    expectCode(() => value.approvePlan(identity, 'не хэш'), 'PLAN_EXECUTION_INPUT_INVALID')
    expect(value.status(identity)).toMatchObject({ phase: 'submitted' })
  })

  it('повторное одобрение идемпотентно', () => {
    const { value } = controller()
    value.observeResearch(identity, readCall, true)
    const { planHash } = value.submitPlan(identity, plan(writeCall))

    expect(value.approvePlan(identity, planHash)).toEqual({ kind: 'approved', totalSteps: 1 })
    expect(value.approvePlan(identity, planHash)).toEqual({ kind: 'already-approved', totalSteps: 1 })
  })

  it('нельзя одобрить план, которого нет', () => {
    const { value } = controller()
    value.observeResearch(identity, readCall, true)

    expectCode(() => value.approvePlan(identity, 'a'.repeat(64)), 'PLAN_EXECUTION_RESEARCH_REQUIRED')
  })

  it('отказ возвращает задачу к исследованию и забывает план', () => {
    const { value } = controller()
    value.observeResearch(identity, readCall, true)
    value.submitPlan(identity, plan(writeCall))

    expect(value.rejectPlan(identity)).toEqual({ kind: 'rejected' })
    expect(value.status(identity)).toMatchObject({
      phase: 'research', revision: 2, researchObservations: 0, totalSteps: 0,
    })
    // После отказа исполнять нечего — даже тот же вызов начинается заново.
    expectCode(() => value.admitPlannedCall(identity, writeCall), 'PLAN_EXECUTION_RESEARCH_REQUIRED')
  })

  it('отказ по уже одобренному плану тоже останавливает работу', () => {
    const { value } = controller()
    value.observeResearch(identity, readCall, true)
    submitApproved(value, plan(writeCall))

    expect(value.rejectPlan(identity)).toEqual({ kind: 'rejected' })
    expect(value.status(identity)).toMatchObject({ phase: 'research' })
  })

  it('отказывать нечего, пока плана не подавали', () => {
    const { value } = controller()
    value.observeResearch(identity, readCall, true)

    expect(value.rejectPlan(identity)).toEqual({ kind: 'nothing-to-reject' })
  })

  it('начатое действие нельзя ни одобрить заново, ни отменить', () => {
    const { value } = controller()
    value.observeResearch(identity, readCall, true)
    const { planHash } = value.submitPlan(identity, plan(writeCall))
    value.approvePlan(identity, planHash)
    value.admitPlannedCall(identity, writeCall)

    // Мир мог измениться: отменять и переодобрять нечего.
    expectCode(() => value.approvePlan(identity, planHash), 'PLAN_EXECUTION_ACTION_AMBIGUOUS')
    expectCode(() => value.rejectPlan(identity), 'PLAN_EXECUTION_ACTION_AMBIGUOUS')
  })

  it('одобрение переживает рестарт', () => {
    const path = statePath()
    const first = makePlanExecutionStateController({
      persistence: makeNodePlanExecutionPersistence({ path }), toolEffect: effect,
    })
    first.observeResearch(identity, readCall, true)
    const { planHash } = first.submitPlan(identity, plan(writeCall))
    first.approvePlan(identity, planHash)

    const restarted = makePlanExecutionStateController({
      persistence: makeNodePlanExecutionPersistence({ path }), toolEffect: effect,
    })

    // Оператор уже согласился — после перезапуска его не спрашивают снова.
    expect(restarted.status(identity)).toMatchObject({ phase: 'approved' })
    expect(restarted.preflightPlannedCall(identity, writeCall)).toMatchObject({ kind: 'matched' })
  })

  it('returns to research after a failed planned action', () => {
    const { value } = controller()
    value.observeResearch(identity, readCall, true)
    submitApproved(value, plan(writeCall))
    const permit = value.admitPlannedCall(identity, writeCall)

    expect(value.settlePlannedCall(permit, { succeeded: false })).toEqual({
      kind: 'research-required', nextStep: 0,
    })
    expect(value.status(identity)).toMatchObject({ phase: 'research', revision: 2, researchObservations: 0 })
  })

  it('rejects forged, replayed and cross-controller permits', () => {
    const first = controller().value
    const second = controller().value
    for (const value of [first, second]) {
      value.observeResearch(identity, readCall, true)
      submitApproved(value, plan(writeCall))
    }
    const permit = first.admitPlannedCall(identity, writeCall)
    const forged = { ...permit } as PlanExecutionPermitV1

    expectCode(() => first.settlePlannedCall(forged, { succeeded: true }), 'PLAN_EXECUTION_PERMIT_INVALID')
    expectCode(() => second.settlePlannedCall(permit, { succeeded: true }), 'PLAN_EXECUTION_PERMIT_INVALID')
    expect(first.settlePlannedCall(permit, { succeeded: true }).kind).toBe('completed')
    expectCode(() => first.settlePlannedCall(permit, { succeeded: true }), 'PLAN_EXECUTION_PERMIT_INVALID')
  })

  it('does not issue a permit if attempted state cannot be persisted', () => {
    const { value, store } = controller()
    value.observeResearch(identity, readCall, true)
    submitApproved(value, plan(writeCall))
    store.failNextSave()

    expectCode(() => value.admitPlannedCall(identity, writeCall), 'PLAN_EXECUTION_STATE_UNAVAILABLE')
    expect(value.status(identity)).toMatchObject({ phase: 'approved', nextStep: 0 })
  })

  it('recycles the oldest abandoned research turn instead of permanently filling live capacity', () => {
    const { value, store } = controller()
    const identities = Array.from({ length: 65 }, (_, index): PlanExecutionIdentityV1 => Object.freeze({
      ...identity,
      turnId: `turn-${index}`,
    }))
    for (const item of identities) value.observeResearch(item, readCall, true)

    expect(value.status(identities[0]!)).toBeNull()
    expect(value.status(identities.at(-1)!)).toMatchObject({ phase: 'research' })
    expect((store.current() as PlanExecutionPersistedStateV1).tasks).toHaveLength(64)
  })

  it('fails closed on corrupt or future persisted state', () => {
    const validStore = memory()
    const valid = controller(validStore).value
    valid.observeResearch(identity, readCall, true)
    submitApproved(valid, plan(writeCall))
    const noResearch = structuredClone(validStore.current()) as PlanExecutionPersistedStateV1
    ;(noResearch.tasks[0] as { researchObservations: number }).researchObservations = 0
    const wrongPlanHash = structuredClone(validStore.current()) as PlanExecutionPersistedStateV1
    ;(wrongPlanHash.tasks[0] as { planHash: string }).planHash = 'b'.repeat(64)
    let coercions = 0
    const hostilePhase = structuredClone(validStore.current()) as PlanExecutionPersistedStateV1
    ;(hostilePhase.tasks[0] as { phase: unknown }).phase = {
      [Symbol.toPrimitive]: () => { coercions++; return 'submitted' },
    }

    for (const state of [
      { schemaVersion: 2, tasks: [] },
      { schemaVersion: 1, tasks: [{ taskBindingHash: 'bad' }] },
      noResearch,
      wrongPlanHash,
      hostilePhase,
    ]) {
      expectCode(
        () => makePlanExecutionStateController({ persistence: memory(state).port, toolEffect: effect }),
        'PLAN_EXECUTION_STATE_CORRUPT',
      )
    }
    expect(coercions).toBe(0)
  })

  it('rejects accessor and Proxy arguments without invoking user code', () => {
    const { value } = controller()
    let getters = 0
    const accessor = Object.defineProperty({}, 'path', {
      enumerable: true,
      get: () => { getters++; return '/workspace' },
    })
    const proxy = new Proxy({ path: '/workspace' }, {})

    expectCode(
      () => value.observeResearch(identity, { name: 'read_file', args: accessor }, true),
      'PLAN_EXECUTION_PLAN_INVALID',
    )
    expectCode(
      () => value.observeResearch(identity, { name: 'read_file', args: proxy }, true),
      'PLAN_EXECUTION_PLAN_INVALID',
    )
    expect(getters).toBe(0)
  })

  it('never invokes a caller-owned array iterator while hashing arguments', () => {
    const { value } = controller()
    let iterations = 0
    class CallerArray extends Array<unknown> {
      override [Symbol.iterator](): ArrayIterator<unknown> {
        iterations++
        return super[Symbol.iterator]()
      }
    }
    const args = { values: new CallerArray('unexpected') }

    expectCode(
      () => value.observeResearch(identity, { name: 'read_file', args }, true),
      'PLAN_EXECUTION_PLAN_INVALID',
    )
    expect(iterations).toBe(0)
  })

  it('captures persistence and policy functions once and rejects function proxies', () => {
    const store = memory()
    let originalSaves = 0
    const source = {
      load: store.port.load,
      save(state: PlanExecutionPersistedStateV1) {
        originalSaves++
        store.port.save(state)
      },
    }
    const policy = { classify: effect }
    const value = makePlanExecutionStateController({
      persistence: source,
      toolEffect: policy.classify,
      nowMs: () => 1_800_000_000_000,
    })
    source.save = () => { throw new Error('mutated save') }
    policy.classify = () => null

    expect(value.observeResearch(identity, readCall, true).kind).toBe('recorded')
    expect(originalSaves).toBe(1)

    const proxied = new Proxy(effect, {})
    expectCode(
      () => makePlanExecutionStateController({ persistence: memory().port, toolEffect: proxied }),
      'PLAN_EXECUTION_INPUT_INVALID',
    )
  })

  it('persists a private 0600 file and restores a submitted plan', () => {
    const path = statePath()
    const first = makePlanExecutionStateController({
      persistence: makeNodePlanExecutionPersistence({ path }), toolEffect: effect,
    })
    first.observeResearch(identity, readCall, true)
    submitApproved(first, plan(writeCall))

    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).not.toContain('secret-value')
    const restarted = makePlanExecutionStateController({
      persistence: makeNodePlanExecutionPersistence({ path }), toolEffect: effect,
    })
    expect(restarted.status(identity)).toMatchObject({ phase: 'approved', nextStep: 0 })
  })

  it('does not serialize hostile caller state through the Node persistence port', () => {
    const persistence = makeNodePlanExecutionPersistence({ path: statePath() })
    let getters = 0
    const hostile = Object.defineProperty({}, 'schemaVersion', {
      enumerable: true,
      get: () => { getters++; return 1 },
    }) as PlanExecutionPersistedStateV1

    expectCode(() => persistence.save(hostile), 'PLAN_EXECUTION_STATE_CORRUPT')
    expect(getters).toBe(0)
  })

  it('refuses symlink and broadly readable state files', () => {
    const broad = statePath()
    writeFileSync(broad, JSON.stringify({ schemaVersion: 1, tasks: [] }), { mode: 0o600 })
    chmodSync(broad, 0o644)
    expectCode(() => makeNodePlanExecutionPersistence({ path: broad }).load(), 'PLAN_EXECUTION_STATE_UNAVAILABLE')

    const link = statePath()
    const target = `${link}.target`
    writeFileSync(target, JSON.stringify({ schemaVersion: 1, tasks: [] }), { mode: 0o600 })
    symlinkSync(target, link)
    expectCode(() => makeNodePlanExecutionPersistence({ path: link }).load(), 'PLAN_EXECUTION_STATE_UNAVAILABLE')
  })

  it('refuses a state directory replaced after the persistence port was created', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-plan-parent-')))
    roots.push(base)
    const parent = join(base, 'state')
    const displaced = join(base, 'state-old')
    mkdirSync(parent, { mode: 0o700 })
    const persistence = makeNodePlanExecutionPersistence({ path: join(parent, 'plan.json') })
    renameSync(parent, displaced)
    mkdirSync(parent, { mode: 0o700 })

    expectCode(() => persistence.load(), 'PLAN_EXECUTION_STATE_UNAVAILABLE')
    expectCode(
      () => persistence.save({ schemaVersion: 1, tasks: [] }),
      'PLAN_EXECUTION_STATE_UNAVAILABLE',
    )
  })

  it('uses the private durable state from the production Plan Mode composition', () => {
    const source = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')
    expect(source).toContain('makeNodePlanExecutionPersistence')
    expect(source).toContain("join(base, 'plan-execution.json')")
    expect(source).toContain('makePlanExecutionStateController')
  })
})
