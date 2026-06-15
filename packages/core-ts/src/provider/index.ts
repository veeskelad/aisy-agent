import { createHash } from 'node:crypto'

import type {
  DispatchError,
  HysteresisState,
  ModelRequest,
  ModelResult,
  ModelRouter,
  ModelRouterDeps,
  ProviderAdapter,
  ProviderErrorKind,
  ProviderId,
  QueueRecord,
  RouteDecision,
  RouterEvent,
  RouteTier,
  TaskBudget,
} from './types.js'

export type {
  DispatchError,
  HysteresisState,
  ModelRequest,
  ModelResult,
  ModelRouter,
  ModelRouterDeps,
  PrefixContract,
  ProviderId,
  ProviderAdapter,
  ProviderFamily,
  QueueRecord,
  RequestBody,
  RouteDecision,
  RouterEvent,
  RouteTier,
  RoutingPolicy,
  TaskBudget,
} from './types.js'

// ---------------------------------------------------------------------------
// Fixed routing policy (ADR-0018)
// ---------------------------------------------------------------------------

const TABLE: Readonly<Record<RouteTier, ProviderId>> = {
  reasoning: { family: 'deepseek', model: 'deepseek-v4-pro' },
  critique: { family: 'anthropic', model: 'claude-opus-4.8' },
  routine: { family: 'deepseek', model: 'deepseek-v4-flash' },
}

/** Fallback fires when consecutiveErrors reaches exactly this (ADR-0018). */
const HYSTERESIS_THRESHOLD = 2
/** Frozen cache-breakpoint layout (ADR-0019). */
const MAX_CACHE_BREAKPOINTS = 4

const keyOf = (p: ProviderId): string => `${p.family}:${p.model}`

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const classifyRole = (req: ModelRequest): RouteTier => {
  switch (req.role) {
    case 'generator': return 'reasoning'
    case 'judge': return 'critique'
    case 'agent':
    case 'classifier': return 'routine'
    default:
      throw new Error(`classify: unknown role '${String(req.role)}'`)
  }
}

// ---------------------------------------------------------------------------
// makeModelRouter
// ---------------------------------------------------------------------------

export function makeModelRouter(deps: ModelRouterDeps): ModelRouter {
  const adapters = new Map<string, ProviderAdapter>(deps.adapters.map(a => [keyOf(a.providerId), a]))
  const hysteresis = deps.hysteresisStore ?? new Map<string, HysteresisState>()
  const budgets = deps.budgets ?? new Map<string, TaskBudget>()
  const queueStore = deps.queueStore ?? new Map<string, QueueRecord>()
  const reviewQueue = deps.reviewQueue ?? new Map<string, ModelRequest>()
  /** Per-task session-start prefix hash — the stable-prefix contract (ADR-0019). */
  const prefixHashes = new Map<string, string>()

  const emit = (event: RouterEvent): void => { deps.emitEvent?.(event) }

  const errorCount = (p: ProviderId): number => hysteresis.get(keyOf(p))?.consecutiveErrors ?? 0
  const isDown = (p: ProviderId): boolean => errorCount(p) >= HYSTERESIS_THRESHOLD

  const recordError = (p: ProviderId): number => {
    const next = errorCount(p) + 1
    hysteresis.set(keyOf(p), { provider: p, consecutiveErrors: next })
    return next
  }

  const recordSuccess = (p: ProviderId): void => {
    hysteresis.set(keyOf(p), { provider: p, consecutiveErrors: 0 })
  }

  /** Escalation order for a tier: the table default first, then the policy order. */
  const orderFor = (tier: RouteTier): ProviderId[] => {
    const rest = deps.escalationOrder ?? deps.adapters.map(a => a.providerId)
    const ordered: ProviderId[] = [TABLE[tier], ...rest]
    const seen = new Set<string>()
    return ordered.filter(p => {
      const k = keyOf(p)
      if (seen.has(k) || !adapters.has(k)) return false
      seen.add(k)
      return true
    })
  }

  /** First not-down provider in escalation order; null when all are down. */
  const resolveProvider = (tier: RouteTier): ProviderId | null =>
    orderFor(tier).find(p => !isDown(p)) ?? null

  const classifySafe = (req: ModelRequest): RouteTier => {
    try {
      return classifyRole(req)
    } catch {
      // Fail SAFE: an unclassifiable request gets the critique tier — never a
      // weaker one (spec 09, Eng). Surface the safe-default classification with
      // the fallback flag so Observability sees the downgrade-avoidance (spec
      // 09 §7 "Classifier call fails or times out" → route.classified(fallback=true)).
      const tier: RouteTier = 'critique'
      emit({ type: 'route.classified', taskId: req.taskId, tier, fallback: true })
      return tier
    }
  }

  // Serialize the WHOLE request so the queued record is replayable — body.raw
  // alone drops role, the stable prefix, the token estimate, and the paired
  // generator, none of which can be reconstructed on resume (spec 09 §4, Eng-7).
  const serializeRequest = (req: ModelRequest): Uint8Array => {
    const payload = {
      taskId: req.taskId,
      requestId: req.requestId,
      role: req.role,
      stablePrefix: Array.from(req.stablePrefix),
      body: {
        raw: Array.from(req.body.raw),
        estimatedInputTokens: req.body.estimatedInputTokens,
      },
      ...(req.pairedGeneratorProvider ? { pairedGeneratorProvider: req.pairedGeneratorProvider } : {}),
    }
    return new TextEncoder().encode(JSON.stringify(payload))
  }

  const allDown = (req: ModelRequest): DispatchError => {
    queueStore.set(req.requestId, {
      taskId: req.taskId,
      requestId: req.requestId,
      serializedRequest: serializeRequest(req),
      queuedAt: Date.now(),
    })
    emit({ type: 'route.all_down_queued', taskId: req.taskId, requestId: req.requestId })
    return { kind: 'all_providers_down', queuedRequestId: req.requestId }
  }

  return {
    async classify(req: ModelRequest): Promise<RouteTier> {
      const tier = classifyRole(req)
      emit({ type: 'route.classified', taskId: req.taskId, tier, fallback: false })
      return tier
    },

    // Route is code-only: nothing inside body.raw can influence the decision —
    // the router never inspects the opaque request body (spec 09 §2).
    async route(req: ModelRequest): Promise<RouteDecision | DispatchError> {
      const tier = classifySafe(req)
      // Fail closed when every provider is down — never hand back a known-down
      // provider as a non-error decision (spec 09 §3/§7, Eng-7 terminal policy).
      const provider = resolveProvider(tier)
      if (!provider) return allDown(req)
      const decision: RouteDecision = {
        provider,
        tier,
        fromFallback: keyOf(provider) !== keyOf(TABLE[tier]),
        cacheBreakpoints: MAX_CACHE_BREAKPOINTS,
      }
      emit({ type: 'route.resolved', taskId: req.taskId, decision })
      return decision
    },

    async dispatch(req: ModelRequest): Promise<ModelResult | DispatchError> {
      // Cold-start guard: refuse until the routing table / price sheet loads.
      if (deps.ready === false) return { kind: 'router_not_ready' }

      // Stable-prefix contract (ADR-0019): the prefix is byte-stable per task;
      // a mutated prefix is refused before any adapter call.
      const actualHash = sha256(req.stablePrefix)
      const expectedHash = prefixHashes.get(req.taskId)
      if (expectedHash === undefined) {
        prefixHashes.set(req.taskId, actualHash)
      } else if (expectedHash !== actualHash) {
        emit({ type: 'cache.prefix_mismatch', taskId: req.taskId, expectedHash, actualHash })
        return { kind: 'prefix_mutated', expectedHash, actualHash }
      }

      const tier = classifySafe(req)
      let provider = resolveProvider(tier)
      if (!provider) return allDown(req)

      // Judge-independence (Eng): the RUN-TIME resolved provider (including
      // after fallback) must differ in family from the paired generator. The
      // check runs both before the call AND after any within-loop fallback,
      // because a fallback can land the judge on the generator's family
      // (spec 09 §5 step 4 — "after the provider is resolved … including any
      // fallback").
      const judgeCollision = (p: ProviderId): DispatchError | null => {
        if (req.role === 'judge' && req.pairedGeneratorProvider &&
            p.family === req.pairedGeneratorProvider.family) {
          reviewQueue.set(req.requestId, req)
          emit({ type: 'judge.collision_held', taskId: req.taskId, candidateId: req.requestId })
          return { kind: 'judge_collision_held', candidateId: req.requestId }
        }
        return null
      }

      const preCollision = judgeCollision(provider)
      if (preCollision) return preCollision

      // Budget ceiling enforced in code BEFORE dispatch (Eng-12).
      const budget = budgets.get(req.taskId)
      if (budget) {
        // Both ceilings guard the SAME thing — the PROJECTED (post-call) total
        // — so a call that *would* cross either ceiling is refused before it
        // runs (spec 09 §4). The dollar side has no per-call dollar estimate, so
        // it projects this call's cost from the realized rate ($/token so far)
        // applied to the estimated input tokens, mirroring the token check.
        const projectedTokens = budget.tokensSpent + req.body.estimatedInputTokens
        const pricePerToken = budget.tokensSpent > 0 ? budget.dollarsSpent / budget.tokensSpent : 0
        const projectedDollars = budget.dollarsSpent + req.body.estimatedInputTokens * pricePerToken
        if (projectedTokens > budget.tokenCeiling || projectedDollars > budget.dollarCeiling) {
          emit({ type: 'budget.exceeded', taskId: req.taskId, budget })
          return { kind: 'budget_exceeded', budget }
        }
      }

      // Single attempt per dispatch; the second consecutive error marks the
      // provider down and escalates within this dispatch (hysteresis, ADR-0018).
      for (;;) {
        const adapter = adapters.get(keyOf(provider))!
        try {
          const result = await adapter.call(req)
          recordSuccess(provider)
          // Cost telemetry (ADR-0036): on EVERY successful dispatch, emit the
          // per-call charge for the RESOLVED provider (after any fallback) —
          // independent of whether a TaskBudget is configured (spec 09 §5,
          // AC-09-19).
          emit({
            type: 'provider.cost.charged',
            taskId: req.taskId,
            requestId: req.requestId,
            tier,
            tokens: result.inputTokens + result.outputTokens,
            dollars: result.dollarsCharged,
          })
          if (budget) {
            budget.tokensSpent += result.inputTokens + result.outputTokens
            budget.dollarsSpent += result.dollarsCharged
            emit({
              type: 'budget.charged',
              taskId: req.taskId,
              requestId: req.requestId,
              dollars: result.dollarsCharged,
              tokens: result.inputTokens + result.outputTokens,
            })
          }
          return result
        } catch (err) {
          const errorKind = ((err as { kind?: ProviderErrorKind }).kind ?? 'server-error') as ProviderErrorKind
          const count = recordError(provider)
          if (count < HYSTERESIS_THRESHOLD) {
            // A single transient error never flips the route.
            return { kind: 'provider_error', providerId: provider, errorKind }
          }
          // Provider is down — escalate to the next available one.
          const next = resolveProvider(tier)
          if (!next) return allDown(req)
          emit({ type: 'route.fallback', taskId: req.taskId, from: provider, to: next })
          provider = next
          // Re-run the run-time independence guard: the fallback may have landed
          // the judge on the generator's family — hold instead of self-judging.
          const postCollision = judgeCollision(provider)
          if (postCollision) return postCollision
        }
      }
    },
  }
}
