import type { TriggerEngine, TriggerEngineDeps } from './types.js'

export type {
  TriggerKind,
  TriggerBudget,
  TriggerSpec,
  Phase1Outcome,
  TriggerFiring,
  TriggerStore,
  TriggerEngineDeps,
  TriggerEngine,
} from './types.js'

// ---------------------------------------------------------------------------
// Stub factory — component 14 is spec'd (ADR-0038) and scheduled for v0.2.
// The tests in triggers.spec.ts carry the real contract under describe.skip;
// unskip them when implementing — they become genuine red immediately.
// ---------------------------------------------------------------------------

export function makeTriggerEngine(_deps: TriggerEngineDeps): TriggerEngine {
  return {
    register: async (_spec) => { throw new Error('not implemented') },
    confirm: async (_id) => { throw new Error('not implemented') },
    cancel: async (_id) => { throw new Error('not implemented') },
    list: async () => { throw new Error('not implemented') },
    tick: async () => { throw new Error('not implemented') },
  }
}
