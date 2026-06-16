// Loop guardian (runtime) — agent-loop LoopGuardian shape.
//
// Detects repeating tool-call cycles so a stuck agent halts instead of looping
// forever. observe() is called on every dispatch; it trips when the recent
// signature stream shows a period-1/2/3 pattern repeated `repeats` times (e.g.
// the same call 3× in a row, or an A,B,A,B,A,B oscillation). note('replan')
// resets the window — a fresh plan is a fresh execution context (§5.3).

import type { LoopGuardian, ToolCall } from '../agent-loop/types.js'

export interface GuardianDeps {
  /** How many consecutive repeats of a period trip the guardian. Default 3. */
  repeats?: number
  /** Largest cycle period to detect (1..3). Default 3. */
  maxPeriod?: 1 | 2 | 3
}

function sig(call: ToolCall): string {
  return `${call.name}:${JSON.stringify(call.args)}`
}

export function makeGuardian(deps: GuardianDeps = {}): LoopGuardian {
  const repeats = deps.repeats ?? 3
  const maxPeriod = deps.maxPeriod ?? 3
  let window: string[] = []

  /** True if the tail is `period`-pattern repeated `repeats` times. */
  const isCycle = (period: number): boolean => {
    const need = period * repeats
    if (window.length < need) return false
    const tail = window.slice(window.length - need)
    for (let i = period; i < tail.length; i++) {
      if (tail[i] !== tail[i - period]) return false
    }
    return true
  }

  return {
    observe(call: ToolCall): { trip: boolean; period?: 1 | 2 | 3 } {
      window.push(sig(call))
      for (let p = 1 as 1 | 2 | 3; p <= maxPeriod; p = (p + 1) as 1 | 2 | 3) {
        if (isCycle(p)) return { trip: true, period: p }
      }
      return { trip: false }
    },

    note(_event: 'replan'): void {
      window = []
    },
  }
}
