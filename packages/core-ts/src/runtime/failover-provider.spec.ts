import { describe, it, expect, vi } from 'vitest'
import { makeFailoverProvider } from './failover-provider.js'
import type { ProviderAdapter, ModelRequest, ModelResponse, ProviderError } from '../agent-loop/types.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeRequest(): ModelRequest {
  return {
    sessionId: 'test-session',
    spans: [{ role: 'user', provenance: 'operator', text: 'hello' }],
    prefixBytes: new Uint8Array(0),
  }
}

function makeResponse(reply = 'ok'): ModelResponse {
  return { reply }
}

function okAdapter(reply = 'primary-ok'): ProviderAdapter & { calls: number } {
  const state = { calls: 0 }
  return {
    get calls() { return state.calls },
    complete: async (_req, _signal) => {
      state.calls++
      return makeResponse(reply)
    },
  }
}

class FakeProviderError extends Error implements ProviderError {
  readonly httpStatus?: number
  constructor(public readonly kind: ProviderError['kind'], message: string, httpStatus?: number) {
    super(message)
    this.name = 'ProviderError'
    if (httpStatus !== undefined) this.httpStatus = httpStatus
  }
}

function failingAdapter(kind: ProviderError['kind'], httpStatus?: number): ProviderAdapter & { calls: number } {
  const state = { calls: 0 }
  return {
    get calls() { return state.calls },
    complete: async (_req, _signal) => {
      state.calls++
      throw new FakeProviderError(kind, `${kind} error`, httpStatus)
    },
  }
}

function networkErrorAdapter(): ProviderAdapter & { calls: number } {
  const state = { calls: 0 }
  return {
    get calls() { return state.calls },
    complete: async (_req, _signal) => {
      state.calls++
      const err = new TypeError('Failed to fetch')
      throw err
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeFailoverProvider', () => {
  it('primary success — returns primary result, fallback is never called', async () => {
    const primary = okAdapter('primary-ok')
    const fallback = okAdapter('fallback-ok')
    const provider = makeFailoverProvider(primary, fallback)

    const result = await provider.complete(makeRequest())

    expect(result.reply).toBe('primary-ok')
    expect(primary.calls).toBe(1)
    expect(fallback.calls).toBe(0)
  })

  it('primary transient error (rate-limit) — fallback is used and its result returned', async () => {
    const primary = failingAdapter('rate-limit')
    const fallback = okAdapter('fallback-ok')
    const provider = makeFailoverProvider(primary, fallback)

    const result = await provider.complete(makeRequest())

    expect(result.reply).toBe('fallback-ok')
    expect(primary.calls).toBe(1)
    expect(fallback.calls).toBe(1)
  })

  it('primary transient error (server-error, 5xx) — fallback is used', async () => {
    const primary = failingAdapter('server-error', 503)
    const fallback = okAdapter('fallback-ok')
    const provider = makeFailoverProvider(primary, fallback)

    const result = await provider.complete(makeRequest())

    expect(result.reply).toBe('fallback-ok')
    expect(fallback.calls).toBe(1)
  })

  it('primary server-error WITHOUT an http status (network throw) — fallback is used', async () => {
    const primary = failingAdapter('server-error') // no httpStatus → treat as network-level
    const fallback = okAdapter('fallback-ok')
    const provider = makeFailoverProvider(primary, fallback)

    const result = await provider.complete(makeRequest())

    expect(result.reply).toBe('fallback-ok')
    expect(fallback.calls).toBe(1)
  })

  it('primary 4xx client error (server-error, httpStatus 400) — propagates, fallback NOT called', async () => {
    const primary = failingAdapter('server-error', 400)
    const fallback = okAdapter('fallback-ok')
    const provider = makeFailoverProvider(primary, fallback)

    await expect(provider.complete(makeRequest())).rejects.toThrow('server-error error')
    expect(primary.calls).toBe(1)
    expect(fallback.calls).toBe(0)
  })

  it('primary 401 unauthorized (server-error, httpStatus 401) — propagates, not masked by fallback', async () => {
    const primary = failingAdapter('server-error', 401)
    const fallback = okAdapter('fallback-ok')
    const provider = makeFailoverProvider(primary, fallback)

    await expect(provider.complete(makeRequest())).rejects.toThrow('server-error error')
    expect(fallback.calls).toBe(0)
  })

  it('primary transient error (timeout) — fallback is used', async () => {
    const primary = failingAdapter('timeout')
    const fallback = okAdapter('fallback-ok')
    const provider = makeFailoverProvider(primary, fallback)

    const result = await provider.complete(makeRequest())

    expect(result.reply).toBe('fallback-ok')
    expect(fallback.calls).toBe(1)
  })

  it('primary network error (TypeError) — fallback is used', async () => {
    const primary = networkErrorAdapter()
    const fallback = okAdapter('fallback-ok')
    const provider = makeFailoverProvider(primary, fallback)

    const result = await provider.complete(makeRequest())

    expect(result.reply).toBe('fallback-ok')
    expect(fallback.calls).toBe(1)
  })

  it('primary non-transient error — propagates, fallback NOT called', async () => {
    // kind 'all-exhausted' is not in the transient set.
    const primary = failingAdapter('all-exhausted')
    const fallback = okAdapter('fallback-ok')
    const provider = makeFailoverProvider(primary, fallback)

    await expect(provider.complete(makeRequest())).rejects.toThrow('all-exhausted error')
    expect(fallback.calls).toBe(0)
  })

  it('passes the signal to both primary and fallback', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const primary: ProviderAdapter = {
      complete: async (_req, signal) => {
        signals.push(signal)
        throw new FakeProviderError('rate-limit', 'rate limited')
      },
    }
    const fallback: ProviderAdapter = {
      complete: async (_req, signal) => {
        signals.push(signal)
        return makeResponse('done')
      },
    }
    const controller = new AbortController()
    const provider = makeFailoverProvider(primary, fallback)
    await provider.complete(makeRequest(), controller.signal)

    expect(signals).toHaveLength(2)
    expect(signals[0]).toBe(controller.signal)
    expect(signals[1]).toBe(controller.signal)
  })
})
