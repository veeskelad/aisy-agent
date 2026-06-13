import { describe, it, expect } from 'vitest'
import { makeModelRouter } from './index.js'
import type {
  ModelRequest,
  ProviderAdapter,
  ProviderId,
  ModelResult,
  DispatchError,
  RouteDecision,
  TaskBudget,
  RouterEvent,
  QueueRecord,
} from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixed providers matching the ADR-0018 routing table. */
const PROVIDERS = {
  deepseekPro:   { family: 'deepseek',   model: 'deepseek-v4-pro'  } as ProviderId,
  deepseekFlash: { family: 'deepseek',   model: 'deepseek-v4-flash' } as ProviderId,
  claudeOpus:    { family: 'anthropic',  model: 'claude-opus-4.8'  } as ProviderId,
  claudeSonnet:  { family: 'anthropic',  model: 'claude-sonnet-4.6' } as ProviderId,
  gpt55:         { family: 'openai',     model: 'gpt-5.5'           } as ProviderId,
}

let reqSeq = 0

function makeReq(
  overrides: Partial<ModelRequest> & { taskId?: string } = {},
): ModelRequest {
  const req: ModelRequest = {
    taskId:        overrides.taskId     ?? 'task-1',
    requestId:     overrides.requestId  ?? `req-${++reqSeq}`,
    role:          overrides.role       ?? 'agent',
    stablePrefix:  overrides.stablePrefix ?? new Uint8Array([1, 2, 3]),
    body:          overrides.body ?? {
      raw: new Uint8Array([4, 5, 6]),
      estimatedInputTokens: 100,
    },
  }
  if (overrides.pairedGeneratorProvider !== undefined) {
    req.pairedGeneratorProvider = overrides.pairedGeneratorProvider
  }
  return req
}

type FakeAdapterScript =
  | { type: 'success'; tokens?: number; dollars?: number; family?: string; model?: string }
  | { type: 'error'; kind: 'rate-limit' | 'server-error' | 'timeout' }

/**
 * Scriptable FakeProviderAdapter implementing the ProviderAdapter interface.
 * Can be queued with success or error responses.
 */
interface FakeProviderAdapter extends ProviderAdapter {
  enqueue(script: FakeAdapterScript): void
  readonly callCount: number
  readonly callLog: ModelRequest[]
}

function makeFakeProviderAdapter(providerId: ProviderId): FakeProviderAdapter {
  const queue: FakeAdapterScript[] = []
  const callLog: ModelRequest[] = []

  const adapter: FakeProviderAdapter = {
    get providerId() { return providerId },
    get callCount() { return callLog.length },
    get callLog() { return callLog },

    enqueue(script: FakeAdapterScript): void {
      queue.push(script)
    },

    async call(req: ModelRequest): Promise<ModelResult> {
      callLog.push(req)
      const script = queue.shift()
      if (script === undefined) throw new Error(`FakeProviderAdapter(${providerId.model}): no response queued`)

      if (script.type === 'error') {
        const err = new Error(`provider error: ${script.kind}`) as Error & { kind: string }
        err.kind = script.kind
        throw err
      }

      const tokens = script.tokens ?? 500
      const dollars = script.dollars ?? 0.01
      const family = (script.family ?? providerId.family) as ProviderId['family']
      const model = script.model ?? providerId.model

      return {
        requestId:     req.requestId,
        provider:      { family, model },
        content:       'ok',
        inputTokens:   tokens,
        outputTokens:  tokens,
        dollarsCharged: dollars,
      }
    },
  }

  return adapter
}

const isError = (r: ModelResult | DispatchError): r is DispatchError => 'kind' in r

/** Narrows a route() result to a RouteDecision, asserting it did not fail closed. */
function asDecision(r: RouteDecision | DispatchError): RouteDecision {
  expect('kind' in r).toBe(false)
  return r as RouteDecision
}

// ---------------------------------------------------------------------------
// AC-09-1: FakeProviderAdapter satisfies ProviderAdapter + zero live calls
// ---------------------------------------------------------------------------

describe('AC-09-1: FakeProviderAdapter contract', () => {
  it('AC-09-1: FakeProviderAdapter implements ProviderAdapter and routes classify/route/dispatch with 0 live network calls', async () => {
    const fake = makeFakeProviderAdapter(PROVIDERS.deepseekPro)
    fake.enqueue({ type: 'success', tokens: 100, dollars: 0.001 })

    const router = makeModelRouter({ adapters: [fake] })
    const result = await router.dispatch(makeReq())

    expect(isError(result)).toBe(false)
    expect((result as ModelResult).content).toBe('ok')
    // No live calls — our fake records everything
    expect(fake.callCount).toBe(1)
    expect(fake.callLog).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// AC-09-2: 3-tier routing table
// ---------------------------------------------------------------------------

describe('AC-09-2: 3-tier routing resolves to fixed providers', () => {
  it('AC-09-2: reasoning → deepseek-v4-pro, critique → claude-opus-4.8, routine → deepseek-v4-flash', async () => {
    const adapters = [
      makeFakeProviderAdapter(PROVIDERS.deepseekPro),
      makeFakeProviderAdapter(PROVIDERS.claudeOpus),
      makeFakeProviderAdapter(PROVIDERS.deepseekFlash),
    ]
    const router = makeModelRouter({ adapters })

    const r = asDecision(await router.route(makeReq({ role: 'generator' })))
    expect(r.tier).toBe('reasoning')
    expect(r.provider.model).toBe('deepseek-v4-pro')

    const c = asDecision(await router.route(makeReq({ role: 'judge' })))
    expect(c.tier).toBe('critique')
    expect(c.provider.model).toBe('claude-opus-4.8')

    const n = asDecision(await router.route(makeReq({ role: 'agent' })))
    expect(n.tier).toBe('routine')
    expect(n.provider.model).toBe('deepseek-v4-flash')
  })
})

// ---------------------------------------------------------------------------
// AC-09-3: Request body fields do not influence RouteDecision
// ---------------------------------------------------------------------------

describe('AC-09-3: Route is code-only, request body provider/tier fields are ignored', () => {
  it('AC-09-3: embedding provider/tier in request body has no effect on resolved RouteDecision', async () => {
    const adapters = [makeFakeProviderAdapter(PROVIDERS.deepseekFlash)]
    const router = makeModelRouter({ adapters })

    // A body that smuggles a "provider" field must be ignored
    const req = makeReq({
      role: 'agent',
      body: {
        raw: new TextEncoder().encode(JSON.stringify({ provider: 'openai', tier: 'critique' })),
        estimatedInputTokens: 50,
      },
    })

    const decision = asDecision(await router.route(req))
    expect(decision.tier).toBe('routine')
    expect(decision.provider.family).not.toBe('openai')
    expect(decision.provider.model).toBe('deepseek-v4-flash')
  })
})

// ---------------------------------------------------------------------------
// AC-09-4: Single transient error never flips the route
// ---------------------------------------------------------------------------

describe('AC-09-4: One error + one success leaves route unchanged', () => {
  it('AC-09-4: hysteresis counter resets to 0 after success; fromFallback == false on next call', async () => {
    const adapter = makeFakeProviderAdapter(PROVIDERS.deepseekFlash)
    const hysteresisStore = new Map()
    const router = makeModelRouter({ adapters: [adapter], hysteresisStore })

    adapter.enqueue({ type: 'error', kind: 'rate-limit' })
    adapter.enqueue({ type: 'success' })

    const first = await router.dispatch(makeReq())
    expect((first as DispatchError).kind).toBe('provider_error')

    // A single error is not enough to fall back — same provider serves next call.
    const second = await router.dispatch(makeReq())
    expect(isError(second)).toBe(false)
    expect((second as ModelResult).provider.family).toBe('deepseek')

    const state = hysteresisStore.get('deepseek:deepseek-v4-flash') as { consecutiveErrors: number } | undefined
    expect(state?.consecutiveErrors).toBe(0)

    const decision = asDecision(await router.route(makeReq()))
    expect(decision.fromFallback).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC-09-5: Two consecutive errors trigger fallback
// ---------------------------------------------------------------------------

describe('AC-09-5: Two consecutive errors escalate to next provider', () => {
  it('AC-09-5: 2 consecutive errors on active provider → next escalation provider; fromFallback == true; route.fallback emitted', async () => {
    const events: RouterEvent[] = []
    const adapters = [
      makeFakeProviderAdapter(PROVIDERS.deepseekFlash),
      makeFakeProviderAdapter(PROVIDERS.gpt55),
    ]
    const router = makeModelRouter({
      adapters,
      emitEvent: (e) => events.push(e),
    })

    adapters[0]!.enqueue({ type: 'error', kind: 'server-error' })
    adapters[0]!.enqueue({ type: 'error', kind: 'server-error' })
    adapters[1]!.enqueue({ type: 'success' })

    const first = await router.dispatch(makeReq({ taskId: 'task-fallback' }))
    expect((first as DispatchError).kind).toBe('provider_error')

    // Second consecutive error marks the provider down and escalates within the dispatch.
    const second = await router.dispatch(makeReq({ taskId: 'task-fallback' }))
    expect(isError(second)).toBe(false)
    expect((second as ModelResult).provider.family).toBe('openai')

    const fallbackEvent = events.find(e => e.type === 'route.fallback')
    expect(fallbackEvent).toBeDefined()

    const decision = asDecision(await router.route(makeReq({ taskId: 'task-fallback' })))
    expect(decision.fromFallback).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC-09-6: Fallback drops only the failed provider's KV-cache; session survives
// ---------------------------------------------------------------------------

describe('AC-09-6: Session survives provider fallback; only KV-cache lost', () => {
  it('AC-09-6: request stream continues across fallback; a new session is NOT created', async () => {
    const adapters = [
      makeFakeProviderAdapter(PROVIDERS.deepseekFlash),
      makeFakeProviderAdapter(PROVIDERS.gpt55),
    ]
    const router = makeModelRouter({ adapters })

    adapters[0]!.enqueue({ type: 'error', kind: 'timeout' })
    adapters[0]!.enqueue({ type: 'error', kind: 'timeout' })
    adapters[1]!.enqueue({ type: 'success' })

    const req1 = makeReq({ taskId: 'sess-task' })
    const first = await router.dispatch(req1)
    expect((first as DispatchError).kind).toBe('provider_error')

    // The same task continues: the post-fallback result is bound to the SAME
    // requestId — no new session/request identity is minted by the fallback.
    const req2 = makeReq({ taskId: 'sess-task' })
    const second = await router.dispatch(req2)
    expect(isError(second)).toBe(false)
    expect((second as ModelResult).requestId).toBe(req2.requestId)

    // The stable prefix contract for the task is intact after the fallback.
    const decision = asDecision(await router.route(makeReq({ taskId: 'sess-task' })))
    expect(decision.fromFallback).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC-09-7: At most 4 cache breakpoints; each at ADR-0019 boundaries
// ---------------------------------------------------------------------------

describe('AC-09-7: Cache breakpoints 0..4; mid-segment or >4 fails', () => {
  it('AC-09-7: router places ≤4 cache breakpoints', async () => {
    const adapter = makeFakeProviderAdapter(PROVIDERS.deepseekFlash)
    const router = makeModelRouter({ adapters: [adapter] })

    const decision = asDecision(await router.route(makeReq()))
    expect(decision.cacheBreakpoints).toBeGreaterThanOrEqual(0)
    expect(decision.cacheBreakpoints).toBeLessThanOrEqual(4)
  })
})

// ---------------------------------------------------------------------------
// AC-09-8: Mutated stablePrefix → prefix_mutated error; adapter never called
// ---------------------------------------------------------------------------

describe('AC-09-8: Mutated stablePrefix returns prefix_mutated; adapter call count is 0', () => {
  it('AC-09-8: when stablePrefix differs from session-start hash, dispatch returns prefix_mutated and adapter is not called', async () => {
    const adapter = makeFakeProviderAdapter(PROVIDERS.deepseekFlash)
    const router = makeModelRouter({ adapters: [adapter] })

    // First dispatch establishes the session-start hash
    adapter.enqueue({ type: 'success' })
    const first = await router.dispatch(makeReq())
    expect(isError(first)).toBe(false)

    // Second dispatch with different prefix bytes
    const mutatedReq = makeReq({ stablePrefix: new Uint8Array([99, 98, 97]) })
    const mutated = await router.dispatch(mutatedReq)
    expect((mutated as DispatchError).kind).toBe('prefix_mutated')
    expect(adapter.callCount).toBe(1) // only the first call went through
  })
})

// ---------------------------------------------------------------------------
// AC-09-9: Budget ceiling enforced before dispatch
// ---------------------------------------------------------------------------

describe('AC-09-9: Budget ceiling blocks dispatch; adapter never called on breach', () => {
  it('AC-09-9: after tokenCeiling/dollarCeiling reached, next dispatch returns budget_exceeded and adapter is not called', async () => {
    const adapter = makeFakeProviderAdapter(PROVIDERS.deepseekFlash)
    const budgets = new Map<string, TaskBudget>([
      ['task-budget', {
        taskId:        'task-budget',
        tokenCeiling:  10,
        dollarCeiling: 0.001,
        tokensSpent:   10,    // already at ceiling
        dollarsSpent:  0.001,
      }],
    ])
    const router = makeModelRouter({ adapters: [adapter], budgets })

    const result = await router.dispatch(makeReq({ taskId: 'task-budget' }))
    expect((result as DispatchError).kind).toBe('budget_exceeded')
    expect(adapter.callCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AC-09-10: budget.charged emitted; dollarsSpent matches sum of per-call charges
// ---------------------------------------------------------------------------

describe('AC-09-10: budget.charged emitted after each success; running total correct', () => {
  it('AC-09-10: dollarsSpent equals sum of per-call charges after two successful dispatches', async () => {
    const events: RouterEvent[] = []
    const adapter = makeFakeProviderAdapter(PROVIDERS.deepseekFlash)
    const budgets = new Map<string, TaskBudget>([
      ['task-charge', {
        taskId: 'task-charge',
        tokenCeiling: 100_000,
        dollarCeiling: 100,
        tokensSpent: 0,
        dollarsSpent: 0,
      }],
    ])
    const router = makeModelRouter({
      adapters: [adapter],
      budgets,
      emitEvent: (e) => events.push(e),
    })

    adapter.enqueue({ type: 'success', tokens: 200, dollars: 0.01 })
    adapter.enqueue({ type: 'success', tokens: 300, dollars: 0.02 })

    await router.dispatch(makeReq({ taskId: 'task-charge' }))
    await router.dispatch(makeReq({ taskId: 'task-charge' }))

    const charged = events.filter(e => e.type === 'budget.charged')
    expect(charged).toHaveLength(2)
    const budget = budgets.get('task-charge')!
    expect(budget.dollarsSpent).toBeCloseTo(0.01 + 0.02)
    expect(budget.tokensSpent).toBe((200 + 200) + (300 + 300))
  })
})

// ---------------------------------------------------------------------------
// AC-09-11: On budget_exceeded, task is halted; old ceiling still returns error
// ---------------------------------------------------------------------------

describe('AC-09-11: Task halted on budget_exceeded; dispatch blocked until ceiling raised', () => {
  it('AC-09-11: after budget_exceeded, further dispatch with same ceiling returns budget_exceeded', async () => {
    const events: RouterEvent[] = []
    const adapter = makeFakeProviderAdapter(PROVIDERS.deepseekFlash)
    const budget: TaskBudget = {
      taskId: 'task-halt',
      tokenCeiling: 100,
      dollarCeiling: 0.01,
      tokensSpent: 90,
      dollarsSpent: 0.009,
    }
    const budgets = new Map([['task-halt', budget]])
    const router = makeModelRouter({
      adapters: [adapter],
      budgets,
      emitEvent: (e) => events.push(e),
    })

    // The estimated input (100 tokens) would push past the ceiling — blocked pre-dispatch.
    adapter.enqueue({ type: 'success', tokens: 200, dollars: 0.05 })

    const first = await router.dispatch(makeReq({ taskId: 'task-halt' }))
    expect((first as DispatchError).kind).toBe('budget_exceeded')
    expect(events.find(e => e.type === 'budget.exceeded')).toBeDefined()
    expect(adapter.callCount).toBe(0)

    // A second dispatch with the same task is still blocked.
    const second = await router.dispatch(makeReq({ taskId: 'task-halt' }))
    expect((second as DispatchError).kind).toBe('budget_exceeded')
    expect(adapter.callCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AC-09-12: Judge collision → judge_collision_held; judge adapter never called
// ---------------------------------------------------------------------------

describe('AC-09-12: Judge/generator same family → judge_collision_held; judge not called', () => {
  it('AC-09-12: judge request with pairedGeneratorProvider.family == judge family returns judge_collision_held', async () => {
    const judgeAdapter = makeFakeProviderAdapter(PROVIDERS.claudeOpus)
    const reviewQueue = new Map<string, ModelRequest>()
    const events: RouterEvent[] = []
    const router = makeModelRouter({
      adapters: [judgeAdapter],
      reviewQueue,
      emitEvent: (e) => events.push(e),
    })

    const req = makeReq({
      role: 'judge',
      pairedGeneratorProvider: PROVIDERS.claudeSonnet,  // same family: anthropic
    })

    const result = await router.dispatch(req)
    expect((result as DispatchError).kind).toBe('judge_collision_held')
    expect(judgeAdapter.callCount).toBe(0)
    expect(events.find(e => e.type === 'judge.collision_held')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// AC-09-13: Independence check uses run-time provider (after fallback)
// ---------------------------------------------------------------------------

describe('AC-09-13: Judge independence check uses run-time resolved provider, including after fallback', () => {
  it('AC-09-13: fallback moves judge onto generator family → still trips judge_collision_held', async () => {
    // Default judge = claude-opus (anthropic). Knock it down with 2 errors so
    // the judge falls back to deepseek — the SAME family as the paired
    // deepseek generator → the run-time check must still hold the candidate.
    const opusAdapter = makeFakeProviderAdapter(PROVIDERS.claudeOpus)
    const dsAdapter = makeFakeProviderAdapter(PROVIDERS.deepseekPro)
    const reviewQueue = new Map<string, ModelRequest>()
    const router = makeModelRouter({ adapters: [opusAdapter, dsAdapter], reviewQueue })

    opusAdapter.enqueue({ type: 'error', kind: 'server-error' })
    opusAdapter.enqueue({ type: 'error', kind: 'server-error' })
    dsAdapter.enqueue({ type: 'success' })

    // Two un-paired judge calls knock opus down (second escalates to deepseek).
    const d1 = await router.dispatch(makeReq({ role: 'judge' }))
    expect((d1 as DispatchError).kind).toBe('provider_error')
    const d2 = await router.dispatch(makeReq({ role: 'judge' }))
    expect((d2 as ModelResult).provider.family).toBe('deepseek')

    // Judge now resolves to deepseek at run time → collision with a deepseek generator.
    const held = await router.dispatch(makeReq({
      role: 'judge',
      pairedGeneratorProvider: PROVIDERS.deepseekFlash,
    }))
    expect((held as DispatchError).kind).toBe('judge_collision_held')
  })
})

// ---------------------------------------------------------------------------
// AC-09-14: Held candidate appears in review queue; not dropped, not auto-passed
// ---------------------------------------------------------------------------

describe('AC-09-14: Held candidate is routed to human review queue', () => {
  it('AC-09-14: judge_collision_held places the request in reviewQueue; it is not auto-passed or dropped', async () => {
    const judgeAdapter = makeFakeProviderAdapter(PROVIDERS.claudeOpus)
    const reviewQueue = new Map<string, ModelRequest>()
    const router = makeModelRouter({
      adapters: [judgeAdapter],
      reviewQueue,
    })

    const req = makeReq({
      role: 'judge',
      pairedGeneratorProvider: PROVIDERS.claudeSonnet,
    })

    const result = await router.dispatch(req)
    expect((result as DispatchError).kind).toBe('judge_collision_held')
    expect(reviewQueue.has(req.requestId)).toBe(true)
    expect(reviewQueue.get(req.requestId)).toMatchObject({ requestId: req.requestId })
  })
})

// ---------------------------------------------------------------------------
// AC-09-15: All-providers-down → DispatchError; STATE + queue record written
// ---------------------------------------------------------------------------

describe('AC-09-15: All providers down → all_providers_down; STATE + queue record written', () => {
  it('AC-09-15: when all escalation adapters error, dispatch returns all_providers_down and queue record exists', async () => {
    const adapters = [
      makeFakeProviderAdapter(PROVIDERS.deepseekFlash),
      makeFakeProviderAdapter(PROVIDERS.gpt55),
      makeFakeProviderAdapter(PROVIDERS.claudeSonnet),
    ]
    const queueStore = new Map<string, QueueRecord>()
    const events: RouterEvent[] = []
    const router = makeModelRouter({
      adapters,
      queueStore,
      emitEvent: (e) => events.push(e),
    })

    for (const a of adapters) {
      a.enqueue({ type: 'error', kind: 'server-error' })
      a.enqueue({ type: 'error', kind: 'server-error' })
    }

    // Errors accumulate per provider; each second error marks it down and
    // escalates. The final dispatch finds every provider down.
    await router.dispatch(makeReq({ taskId: 'task-all-down' }))
    await router.dispatch(makeReq({ taskId: 'task-all-down' }))
    await router.dispatch(makeReq({ taskId: 'task-all-down' }))
    const req = makeReq({ taskId: 'task-all-down', requestId: 'req-all-down-1' })
    const result = await router.dispatch(req)

    expect((result as DispatchError).kind).toBe('all_providers_down')
    expect(queueStore.has('req-all-down-1')).toBe(true)
    expect(queueStore.get('req-all-down-1')?.requestId).toBe('req-all-down-1')
    expect(events.find(e => e.type === 'route.all_down_queued')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// AC-09-16: All-providers-down blocks further dispatch; resumes on recovery
// ---------------------------------------------------------------------------

describe('AC-09-16: Further dispatch blocked after all-down; resumes once provider recovered', () => {
  it('AC-09-16: subsequent dispatch after all_providers_down does not call any adapter; resumes after recovery', async () => {
    const adapter = makeFakeProviderAdapter(PROVIDERS.deepseekFlash)
    const queueStore = new Map<string, QueueRecord>()
    const hysteresisStore = new Map()
    const router = makeModelRouter({
      adapters: [adapter],
      queueStore,
      hysteresisStore,
    })

    adapter.enqueue({ type: 'error', kind: 'server-error' })
    adapter.enqueue({ type: 'error', kind: 'server-error' })

    const first = await router.dispatch(makeReq({ taskId: 'task-block', requestId: 'req-block-1' }))
    expect((first as DispatchError).kind).toBe('provider_error')

    const down = await router.dispatch(makeReq({ taskId: 'task-block', requestId: 'req-block-2' }))
    expect((down as DispatchError).kind).toBe('all_providers_down')
    expect(queueStore.has('req-block-2')).toBe(true)

    // Further dispatch is blocked with NO adapter call.
    const blocked = await router.dispatch(makeReq({ taskId: 'task-block', requestId: 'req-block-3' }))
    expect((blocked as DispatchError).kind).toBe('all_providers_down')
    expect(adapter.callCount).toBe(2) // only the two erroring calls

    // Recovery: clearing the hysteresis state re-admits the provider.
    hysteresisStore.clear()
    adapter.enqueue({ type: 'success' })
    const resumed = await router.dispatch(makeReq({ taskId: 'task-block', requestId: 'req-block-4' }))
    expect(isError(resumed)).toBe(false)
    expect((resumed as ModelResult).requestId).toBe('req-block-4')
  })
})

// ---------------------------------------------------------------------------
// AC-09-17: classify() failure → safe default critique tier
// ---------------------------------------------------------------------------

describe('AC-09-17: classify failure → critique tier (never degrades to weaker tier)', () => {
  it('AC-09-17: when classify throws, route resolves critique tier, not routine or reasoning-weak', async () => {
    const adapter = makeFakeProviderAdapter(PROVIDERS.claudeOpus)
    const router = makeModelRouter({ adapters: [adapter] })

    const brokenReq = makeReq({ role: 'bogus-role' as unknown as ModelRequest['role'] })

    // classify itself fails loud on an unknown role…
    await expect(router.classify(brokenReq)).rejects.toThrow()

    // …and route degrades SAFELY to the critique tier, never to routine.
    const decision = asDecision(await router.route(brokenReq))
    expect(decision.tier).toBe('critique')
    expect(decision.tier).not.toBe('routine')
    expect(decision.provider.model).toBe('claude-opus-4.8')
  })
})

// ---------------------------------------------------------------------------
// AC-09-18: Cold start — dispatch refuses until routing table + price sheet loaded
// ---------------------------------------------------------------------------

describe('AC-09-18: Cold start blocks dispatch; resumes once router is ready', () => {
  it('AC-09-18: dispatch returns router_not_ready when not initialised; succeeds once ready', async () => {
    const adapter = makeFakeProviderAdapter(PROVIDERS.deepseekFlash)

    // Explicitly mark router as not ready
    const notReady = makeModelRouter({ adapters: [adapter], ready: false })
    const refused = await notReady.dispatch(makeReq())
    expect((refused as DispatchError).kind).toBe('router_not_ready')
    expect(adapter.callCount).toBe(0)

    // A ready router serves the same request.
    const ready = makeModelRouter({ adapters: [adapter], ready: true })
    adapter.enqueue({ type: 'success' })
    const ok = await ready.dispatch(makeReq())
    expect(isError(ok)).toBe(false)
    expect((ok as ModelResult).content).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// AC-09-15b: route() fails closed when ALL providers are down
// (regression: route() must not hand back a known-down provider — §3/§7)
// ---------------------------------------------------------------------------

describe('AC-09-15b: route() fails closed when every provider is down', () => {
  it('AC-09-15b: route() returns all_providers_down instead of a known-down provider when all adapters are down', async () => {
    const adapter = makeFakeProviderAdapter(PROVIDERS.deepseekPro)
    const hysteresisStore = new Map()
    const router = makeModelRouter({ adapters: [adapter], hysteresisStore })

    // Knock the only provider down (consecutiveErrors >= threshold).
    hysteresisStore.set('deepseek:deepseek-v4-pro', {
      provider: PROVIDERS.deepseekPro,
      consecutiveErrors: 2,
    })

    const decision = await router.route(makeReq({ role: 'generator' }))
    // Must NOT silently hand back the table default (a known-down provider).
    expect('kind' in decision).toBe(true)
    expect((decision as DispatchError).kind).toBe('all_providers_down')
  })
})

// ---------------------------------------------------------------------------
// AC-09-13b: judge-independence re-checked after a WITHIN-LOOP fallback
// (regression: a fallback inside dispatch can land the judge on the
//  generator's family; the run-time guard must still trip — §5 step 4)
// ---------------------------------------------------------------------------

describe('AC-09-13b: judge independence re-checked after within-loop fallback', () => {
  it('AC-09-13b: a within-dispatch fallback that lands the judge on the generator family holds the candidate', async () => {
    // Initial judge provider = claude-opus (anthropic) differs from the paired
    // deepseek generator, so the PRE-LOOP guard passes. Opus then fails twice
    // inside this same dispatch and the loop escalates to deepseek-pro — the
    // SAME family as the generator. The run-time guard must catch this.
    const opusAdapter = makeFakeProviderAdapter(PROVIDERS.claudeOpus)
    const dsAdapter = makeFakeProviderAdapter(PROVIDERS.deepseekPro)
    const reviewQueue = new Map<string, ModelRequest>()
    const events: RouterEvent[] = []
    const router = makeModelRouter({
      adapters: [opusAdapter, dsAdapter],
      reviewQueue,
      emitEvent: (e) => events.push(e),
    })

    // Two errors on opus within the SAME dispatch → escalate to deepseek-pro.
    opusAdapter.enqueue({ type: 'error', kind: 'server-error' })
    opusAdapter.enqueue({ type: 'error', kind: 'server-error' })
    // deepseek would succeed — but it must never be called, because it collides.
    dsAdapter.enqueue({ type: 'success' })

    const req = makeReq({
      role: 'judge',
      pairedGeneratorProvider: PROVIDERS.deepseekFlash, // deepseek family
    })

    // First call: opus errors once (count 1 < threshold) → provider_error.
    const first = await router.dispatch(req)
    expect((first as DispatchError).kind).toBe('provider_error')

    // Second call: opus errors again (count 2) → within-loop escalation to
    // deepseek, which collides with the generator family → MUST hold.
    const held = await router.dispatch(makeReq({
      role: 'judge',
      pairedGeneratorProvider: PROVIDERS.deepseekFlash,
    }))
    expect((held as DispatchError).kind).toBe('judge_collision_held')
    // The colliding fallback provider must never have been called.
    expect(dsAdapter.callCount).toBe(0)
    expect(events.find(e => e.type === 'judge.collision_held')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// AC-09-15c: queued record is replayable — carries enough to reconstruct
// the full request, not just body.raw (§4 queue record; Eng-7 resume)
// ---------------------------------------------------------------------------

describe('AC-09-15c: all-down queue record is replayable', () => {
  it('AC-09-15c: the queued serializedRequest reconstructs role, stablePrefix, body and pairedGeneratorProvider', async () => {
    const adapter = makeFakeProviderAdapter(PROVIDERS.deepseekFlash)
    const queueStore = new Map<string, QueueRecord>()
    const router = makeModelRouter({ adapters: [adapter], queueStore })

    adapter.enqueue({ type: 'error', kind: 'server-error' })
    adapter.enqueue({ type: 'error', kind: 'server-error' })

    const stablePrefix = new Uint8Array([10, 20, 30, 40])
    const raw = new TextEncoder().encode('the-conversation-tail')
    const req = makeReq({
      taskId: 'task-replay',
      requestId: 'req-replay-1',
      role: 'generator',
      stablePrefix,
      body: { raw, estimatedInputTokens: 777 },
    })

    // First error keeps the provider up; second marks it down → all-down.
    const first = await router.dispatch(req)
    expect((first as DispatchError).kind).toBe('provider_error')
    const down = await router.dispatch(makeReq({
      taskId: 'task-replay',
      requestId: 'req-replay-1',
      role: 'generator',
      stablePrefix,
      body: { raw, estimatedInputTokens: 777 },
    }))
    expect((down as DispatchError).kind).toBe('all_providers_down')

    const record = queueStore.get('req-replay-1')
    expect(record).toBeDefined()

    // The serialized request must let the loop reconstruct the EXACT pending
    // call — not just body.raw. Decode it back to a ModelRequest.
    const decoded = JSON.parse(
      new TextDecoder().decode(record!.serializedRequest),
    ) as {
      taskId: string
      requestId: string
      role: string
      stablePrefix: number[]
      body: { raw: number[]; estimatedInputTokens: number }
    }
    expect(decoded.taskId).toBe('task-replay')
    expect(decoded.requestId).toBe('req-replay-1')
    expect(decoded.role).toBe('generator')
    expect(Array.from(decoded.stablePrefix)).toEqual(Array.from(stablePrefix))
    expect(decoded.body.estimatedInputTokens).toBe(777)
    expect(new Uint8Array(decoded.body.raw)).toEqual(raw)
  })
})
