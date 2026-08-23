import { describe, it, expect } from 'vitest'
import { classify, InputRouter, DEFAULT_DEBOUNCE_MS } from './input-router.js'

describe('classify', () => {
  it('detects commands', () => {
    expect(classify('/stop')).toEqual({ kind: 'command', command: 'stop', raw: '/stop' })
    expect(classify('  /Menu now ')).toEqual({
      kind: 'command',
      command: 'menu',
      raw: '/Menu now',
    })
  })

  it('treats plain text as a message', () => {
    expect(classify('run the linter')).toEqual({
      kind: 'message',
      text: 'run the linter',
    })
  })

  it('does not treat a mid-text slash as a command', () => {
    expect(classify('cd path/to/dir').kind).toBe('message')
  })
})

describe('InputRouter', () => {
  function makeRouter(start = 1000) {
    let t = start
    const router = new InputRouter({ now: () => t })
    return { router, advance: (ms: number) => (t += ms), set: (v: number) => (t = v) }
  }

  it('routes /stop immediately, bypassing the buffer', () => {
    const { router } = makeRouter()
    expect(router.accept('/stop')).toEqual({ action: 'stop' })
    expect(router.pending).toBe(0)
  })

  it('routes other commands immediately', () => {
    const { router } = makeRouter()
    expect(router.accept('/debug')).toEqual({ action: 'command', command: 'debug' })
  })

  it('buffers a burst and fixes the flush window from the first message', () => {
    const { router, advance } = makeRouter(1000)
    const first = router.accept('part one')
    expect(first).toEqual({ buffered: true, flushAt: 1000 + DEFAULT_DEBOUNCE_MS })
    advance(300)
    const second = router.accept('part two')
    // window stays anchored to the first message
    expect(second).toEqual({ buffered: true, flushAt: 1000 + DEFAULT_DEBOUNCE_MS })
    expect(router.pending).toBe(2)
  })

  it('coalesces buffered messages into one dispatch when idle', () => {
    const { router } = makeRouter()
    router.accept('a')
    router.accept('b')
    expect(router.flush('idle')).toEqual({ action: 'dispatch', texts: ['a', 'b'] })
    expect(router.pending).toBe(0)
  })

  it('enqueues buffered messages when the agent is busy', () => {
    const { router } = makeRouter()
    router.accept('steer me')
    expect(router.flush('running')).toEqual({ action: 'enqueue', texts: ['steer me'] })
  })

  it('enqueues when paused too', () => {
    const { router } = makeRouter()
    router.accept('x')
    expect(router.flush('paused')).toEqual({ action: 'enqueue', texts: ['x'] })
  })

  it('returns null when flushing an empty buffer', () => {
    const { router } = makeRouter()
    expect(router.flush('idle')).toBeNull()
  })

  it('resets the window after a flush', () => {
    const { router, set } = makeRouter(1000)
    router.accept('a')
    router.flush('idle')
    set(5000)
    expect(router.accept('b')).toEqual({ buffered: true, flushAt: 5000 + DEFAULT_DEBOUNCE_MS })
  })
})
