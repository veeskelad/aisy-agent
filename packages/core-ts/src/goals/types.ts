// Component — Goal-driven loop. Pure types, no implementation.
// See docs/specs/tier7-goal-driven-loop.md and the Phase A brief.
// Implementation: goal store in packages/app.

import type { VerificationTrace } from '../agent-loop/types.js'

export type { VerificationTrace }

export type GoalMode =
  | { kind: 'until'; probe?: VerificationTrace }
  | { kind: 'every'; cron?: string; intervalMs?: number }
  | { kind: 'budget'; tokenCeiling?: number; dollarCeiling?: number }

export interface GoalBackstop {
  maxIterations: number
  tokenCeiling: number
  dollarCeiling: number
}

export interface GoalUsage {
  inputTokens: number
  outputTokens: number
  dollars: number
}

export type GoalStatus = 'active' | 'completed' | 'halted' | 'stopped'

export interface GoalSpec {
  id: string
  objective: string
  mode: GoalMode
  backstop: GoalBackstop
  /** Tool names pre-authorized — suppresses Tier-2 approval prompts. */
  grantedScope: string[]
  status: GoalStatus
  iterationsSpent: number
  usageSpent: GoalUsage
  lastFeedback?: string
  haltReason?: string
  createdAt: string
  updatedAt: string
}

export interface GoalStore {
  /** Returns the single active goal, or null when none exists (v1: one active goal). */
  load(): Promise<GoalSpec | null>
  save(spec: GoalSpec): Promise<void>
  clear(): Promise<void>
}
