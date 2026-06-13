// Component 14 — Triggers & Proactivity. Pure types, no implementation.
// See docs/specs/14-triggers-and-proactivity.md §3 and ADR-0038.
// Implementation scheduled for v0.2; the skeleton keeps interfaces honest now.

import type { Clock, ContextSpan, VerificationTrace } from '../agent-loop/types.js'

export type { Clock, ContextSpan, VerificationTrace }

export type TriggerKind = 'remind' | 'schedule' | 'watch'

export interface TriggerBudget {
  tokenCeiling: number
  dollarCeiling: number
  tokensSpent: number
  dollarsSpent: number
}

export interface TriggerSpec {
  id: string
  kind: TriggerKind
  /** Agent-created triggers require an operator card confirm before firing (ADR-0029). */
  createdBy: 'operator' | 'agent'
  /** Writable ONLY via the approval path — never by register() for agent-created. */
  confirmed: boolean
  /** What the woken phase-2 turn is asked to do. */
  prompt: string
  /** remind: one-shot due time (ISO-8601). */
  fireAt?: string
  /** schedule: cron expression (constrained dialect, see spec §10). */
  cron?: string
  /** watch: phase-1 predicate — the ADR-0017 probe set, 0 model tokens. */
  probe?: VerificationTrace
  /** watch: how often phase 1 runs. */
  intervalMs?: number
  budget: TriggerBudget
  expiresAt?: string
  enabled: boolean
}

export type Phase1Outcome = 'due' | 'condition-met' | 'no-change' | 'budget-paused' | 'skipped'

export interface TriggerFiring {
  triggerId: string
  firedAt: string
  phase1: Phase1Outcome
  /** True only when phase 2 actually woke an agent turn. */
  turnStarted: boolean
}

export interface TriggerStore {
  load(): Promise<TriggerSpec[]>
  save(spec: TriggerSpec): Promise<void>
  remove(id: string): Promise<void>
}

export interface TriggerEngineDeps {
  clock: Clock
  /** Shared with agent-loop (ADR-0017); phase 1 never calls a model. */
  probeRunner(trace: VerificationTrace): Promise<boolean> | boolean
  /** Wakes ONE minimal-context agent turn under the trigger's budget. */
  startTurn(input: {
    triggerId: string
    prompt: string
    spans: ContextSpan[]
    budget: TriggerBudget
  }): Promise<void>
  store: TriggerStore
  emitEvent(event: string, payload: unknown): void
  /** Shared cap across ALL background firings (anti-heartbeat-drain, ADR-0038). */
  globalBackgroundBudget: TriggerBudget
  /** Fetch the watched content for the woken turn; stamped untrusted by code. */
  observe?(trace: VerificationTrace): Promise<string>
}

export interface TriggerEngine {
  /** Operator-created → active; agent-created → pending confirmation. */
  register(spec: Omit<TriggerSpec, 'confirmed' | 'enabled'>): Promise<TriggerSpec>
  /** The ONLY activation path for agent-created triggers (approval handler calls it). */
  confirm(triggerId: string): Promise<void>
  cancel(triggerId: string): Promise<void>
  list(): Promise<TriggerSpec[]>
  /** One deterministic scan driven by the injected Clock. */
  tick(): Promise<TriggerFiring[]>
}
