import { describe, it, expect } from 'vitest'
import { SteerQueue } from './steer-queue.js'

describe('SteerQueue', () => {
  it('starts empty', () => {
    const q = new SteerQueue()
    expect(q.isEmpty).toBe(true)
    expect(q.size).toBe(0)
    expect(q.drain()).toEqual([])
  })

  it('ignores empty enqueues', () => {
    const q = new SteerQueue()
    q.enqueue([], 1)
    expect(q.isEmpty).toBe(true)
  })

  it('drains newest-first so new context has priority', () => {
    const q = new SteerQueue()
    q.enqueue(['first'], 100)
    q.enqueue(['second'], 200)
    const drained = q.drain()
    expect(drained.map((i) => i.texts[0])).toEqual(['second', 'first'])
  })

  it('preserves all items — nothing is dropped', () => {
    const q = new SteerQueue()
    q.enqueue(['a'], 1)
    q.enqueue(['b', 'c'], 2)
    const drained = q.drain()
    expect(drained.flatMap((i) => i.texts)).toEqual(['b', 'c', 'a'])
  })

  it('empties after drain', () => {
    const q = new SteerQueue()
    q.enqueue(['x'], 1)
    q.drain()
    expect(q.isEmpty).toBe(true)
    expect(q.drain()).toEqual([])
  })
})
