// Input handling — Hermes-style coalescing & steering (plan §1).
//
// A debounce window after the first message naturally coalesces a burst of
// rapid messages into one turn. Commands bypass the buffer entirely; `/stop`
// gets its own immediate path. Routing of buffered messages depends on whether
// the agent is idle (dispatch a fresh turn) or busy (enqueue as steering input,
// where new context takes priority but prior work is preserved).

import type { AgentState } from './types.js'

export const DEFAULT_DEBOUNCE_MS = 1500

export type Incoming =
  | { kind: 'command'; command: string; raw: string }
  | { kind: 'message'; text: string }

/** Classify a raw Telegram text payload. Leading `/word` is a command. */
export function classify(text: string): Incoming {
  const trimmed = text.trim()
  const m = /^\/([a-z][a-z0-9_]*)/i.exec(trimmed)
  if (m) return { kind: 'command', command: m[1]!.toLowerCase(), raw: trimmed }
  return { kind: 'message', text }
}

export type RouteDecision =
  | { action: 'stop' }
  | { action: 'command'; command: string }
  | { action: 'dispatch'; texts: string[] }
  | { action: 'enqueue'; texts: string[] }

/** Returned by accept() when a message was buffered awaiting the debounce flush. */
export interface Buffered {
  buffered: true
  /** Wall-clock ms at which the driver should call flush(). */
  flushAt: number
}

export interface RouterDeps {
  now(): number
  debounceMs?: number
}

export class InputRouter {
  private buffer: string[] = []
  private firstAt: number | null = null

  constructor(private readonly deps: RouterDeps) {}

  /**
   * Ingest a raw text update. Commands resolve immediately; messages are
   * buffered and the caller is told when to flush. The debounce window is fixed
   * from the first buffered message, so a burst coalesces into one flush.
   */
  accept(text: string): RouteDecision | Buffered {
    const c = classify(text)
    if (c.kind === 'command') {
      if (c.command === 'stop') return { action: 'stop' }
      return { action: 'command', command: c.command }
    }
    if (this.firstAt === null) this.firstAt = this.deps.now()
    this.buffer.push(c.text)
    return {
      buffered: true,
      flushAt: this.firstAt + (this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS),
    }
  }

  /**
   * Drain the buffer when the debounce window elapses. Idle → dispatch a fresh
   * turn with all coalesced texts; busy/paused → enqueue them as steering input.
   * Returns null when there is nothing buffered.
   */
  flush(agentState: AgentState): RouteDecision | null {
    if (this.buffer.length === 0) return null
    const texts = this.buffer.slice()
    this.buffer = []
    this.firstAt = null
    return agentState === 'idle'
      ? { action: 'dispatch', texts }
      : { action: 'enqueue', texts }
  }

  get pending(): number {
    return this.buffer.length
  }
}
