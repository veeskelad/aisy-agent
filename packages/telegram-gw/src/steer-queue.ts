// Steering queue (plan §1, §2).
//
// When a message arrives mid-turn it is enqueued here. At the next step
// boundary the agent drains the queue: newest context takes priority, but
// nothing is discarded — older steering input is still surfaced so prior work
// is not lost (the agent folds it into the current or next reply).

export interface SteerItem {
  texts: string[]
  enqueuedAt: number
}

export class SteerQueue {
  private items: SteerItem[] = []

  enqueue(texts: string[], at: number): void {
    if (texts.length === 0) return
    this.items.push({ texts, enqueuedAt: at })
  }

  /**
   * Drain all pending steering input, newest-first (priority order). The queue
   * is emptied. Returns [] when nothing is pending.
   */
  drain(): SteerItem[] {
    const out = this.items.slice().reverse()
    this.items = []
    return out
  }

  get size(): number {
    return this.items.length
  }

  get isEmpty(): boolean {
    return this.items.length === 0
  }
}
