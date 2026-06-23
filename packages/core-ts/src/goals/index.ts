import type { GoalBackstop, GoalMode, GoalSpec } from './types.js'

export type {
  GoalMode,
  GoalBackstop,
  GoalUsage,
  GoalStatus,
  GoalSpec,
  GoalStore,
} from './types.js'

// ---------------------------------------------------------------------------
// makeGoalSpec — convenience factory that fills in zero-value runtime fields.
// Callers supply the identity + policy; the helper stamps status/counters/times.
// Optional fields (lastFeedback, haltReason) are deliberately omitted so that
// exactOptionalPropertyTypes is never violated by an undefined assignment.
// ---------------------------------------------------------------------------

export function makeGoalSpec(input: {
  id: string
  objective: string
  mode: GoalMode
  backstop: GoalBackstop
  grantedScope: string[]
  nowIso: string
}): GoalSpec {
  return {
    id: input.id,
    objective: input.objective,
    mode: input.mode,
    backstop: input.backstop,
    grantedScope: input.grantedScope,
    status: 'active',
    iterationsSpent: 0,
    usageSpent: { inputTokens: 0, outputTokens: 0, dollars: 0 },
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  }
}
