import { createHash } from 'node:crypto'
import { linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  makeDeepgramTranscriptionProvider,
  type DeepgramHttpsRequestPort,
  type DeepgramHttpsResponse,
  type DeepgramSpendAuthority,
  type DeepgramSpendOutcome,
  type DeepgramSpendReservation,
} from './deepgram-transcription-provider.js'
import { TranscriptionError } from './transcription-contract.js'
import { makeTranscriptionRegistry } from './transcription-registry.js'

const roots: string[] = []
const AUDIO = Buffer.from('OggS\0dormant deepgram fixture')

function fixture(name = 'audio.ogg', audio = AUDIO) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-deepgram-')))
  roots.push(root)
  writeFileSync(join(root, name), audio)
  return {
    root,
    name,
    request: {
      audioRoot: root,
      relativePath: name,
      expectedSha256: createHash('sha256').update(audio).digest('hex'),
      expectedSizeBytes: audio.byteLength,
      maxBytes: Math.max(1024, audio.byteLength),
      language: 'ru-RU',
    },
  }
}

function body(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(value)))
}

function okResponse(over: Record<string, unknown> = {}): DeepgramHttpsResponse {
  return {
    status: 200,
    body: body({
      metadata: { duration: 1.25 },
      results: {
        channels: [{
          detected_language: 'ru',
          alternatives: [{ transcript: 'Привет из Deepgram' }],
        }],
      },
      ...over,
    }),
  }
}

function harness(over: Readonly<{
  response?: DeepgramHttpsResponse
  request?: DeepgramHttpsRequestPort['request']
  secret?: string | null
  reserve?: boolean
  reserveImpl?: DeepgramSpendAuthority['reserve']
  onReserve?: () => void
  monotonicNow?: () => number
}> = {}) {
  const requests: Parameters<DeepgramHttpsRequestPort['request']>[0][] = []
  const reservations: Parameters<DeepgramSpendAuthority['reserve']>[0][] = []
  const outcomes: DeepgramSpendOutcome[] = []
  const http: DeepgramHttpsRequestPort = {
    async request(input) {
      requests.push(input)
      if (over.request !== undefined) return over.request(input)
      return over.response ?? okResponse()
    },
  }
  const spend: DeepgramSpendAuthority = {
    async reserve(input) {
      reservations.push(input)
      over.onReserve?.()
      if (over.reserveImpl !== undefined) return over.reserveImpl(input)
      if (over.reserve === false) return null
      return { async settle(outcome) { outcomes.push(outcome) } }
    },
  }
  const provider = makeDeepgramTranscriptionProvider({
    endpointHost: 'api.deepgram.com',
    timeoutMs: 1_000,
    maxResponseBytes: 64 * 1024,
    maximumBillableDurationMs: 60_000,
    resolveSecret: async () => over.secret === undefined ? 'test-deepgram-key' : over.secret,
    http,
    spend,
    ...(over.monotonicNow === undefined ? {} : { monotonicNow: over.monotonicNow }),
  })
  return { provider, http, spend, requests, reservations, outcomes }
}

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('dormant Deepgram transcription provider', () => {
  it('sends exact verified bytes through the injected HTTPS port and settles measured duration', async () => {
    const audio = fixture()
    const h = harness()

    await expect(h.provider.transcribe(audio.request)).resolves.toEqual({
      text: 'Привет из Deepgram',
      provenance: 'untrusted',
      channel: 'voice',
      language: 'ru',
      durationMs: 1250,
    })

    expect(h.provider).toMatchObject({
      id: 'deepgram-cloud',
      audioLeavesHost: true,
      privacyDisclosure: 'Аудио отправляется Deepgram через основной API.',
      privacyRevision: 'deepgram-cloud-direct-bytes-mip-opt-out-v1',
    })
    expect(JSON.stringify(h.provider)).not.toContain('test-deepgram-key')
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.deepgram.com/v1/listen?model=nova-3&language=ru&smart_format=true&mip_opt_out=true',
      redirect: 'error',
      maxResponseBytes: 64 * 1024,
      headers: {
        accept: 'application/json',
        authorization: 'Token test-deepgram-key',
        'content-type': 'audio/ogg',
      },
    })
    expect(Buffer.from(h.requests[0]!.body)).toEqual(AUDIO)
    expect(h.reservations).toEqual([expect.objectContaining({
      providerId: 'deepgram-cloud',
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      maximumBillableDurationMs: 60_000,
    })])
    expect(h.outcomes).toEqual([{ kind: 'settled', billableDurationMs: 1250 }])
  })

  it('integrates with the registry while preserving explicit external consent', async () => {
    const audio = fixture()
    const h = harness()
    const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-deepgram-choice-')))
    roots.push(stateRoot)
    const registry = makeTranscriptionRegistry({
      providers: [h.provider],
      path: join(stateRoot, 'transcription.json'),
    })

    expect(registry.selected()).toBeNull()
    registry.select('deepgram-cloud')
    await expect(registry.transcribe(audio.request)).resolves.toMatchObject({
      provenance: 'untrusted', channel: 'voice', text: 'Привет из Deepgram',
    })
  })

  it('uses frozen HTTP and spend method snapshots after caller mutation', async () => {
    const audio = fixture()
    const h = harness()
    h.http.request = async () => { throw new Error('mutated HTTP method') }
    h.spend.reserve = async () => null

    await expect(h.provider.transcribe(audio.request)).resolves.toMatchObject({
      text: 'Привет из Deepgram',
    })
    expect(h.requests).toHaveLength(1)
    expect(h.outcomes).toEqual([{ kind: 'settled', billableDurationMs: 1250 }])
  })

  it('rejects proxy or accessor ports without invoking caller getters', () => {
    let getterCalls = 0
    const accessorHttp = {}
    Object.defineProperty(accessorHttp, 'request', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return async () => okResponse()
      },
    })
    const validSpend: DeepgramSpendAuthority = {
      async reserve() { return { async settle() {} } },
    }
    const build = (http: unknown, spend: unknown) => () => makeDeepgramTranscriptionProvider({
      endpointHost: 'api.deepgram.com',
      timeoutMs: 1_000,
      maxResponseBytes: 64 * 1024,
      maximumBillableDurationMs: 60_000,
      resolveSecret: async () => 'test-deepgram-key',
      http: http as DeepgramHttpsRequestPort,
      spend: spend as DeepgramSpendAuthority,
    })

    expect(build(accessorHttp, validSpend)).toThrowError(new TranscriptionError('INVALID_REQUEST'))
    expect(build({ async request() { return okResponse() } }, new Proxy(validSpend, {})))
      .toThrowError(new TranscriptionError('INVALID_REQUEST'))
    expect(build({ request: new Proxy(async () => okResponse(), {}) }, validSpend))
      .toThrowError(new TranscriptionError('INVALID_REQUEST'))
    expect(build(
      { async request() { return okResponse() } },
      { reserve: new Proxy(validSpend.reserve, {}) },
    )).toThrowError(new TranscriptionError('INVALID_REQUEST'))
    expect(getterCalls).toBe(0)
  })

  it.each([
    ['missing secret', { secret: null }, 'MODEL_UNAVAILABLE'],
    ['denied reservation', { reserve: false }, 'QUOTA_EXCEEDED'],
  ] as const)('%s fails before network egress', async (_name, options, code) => {
    const audio = fixture()
    const h = harness(options)

    await expect(h.provider.transcribe(audio.request)).rejects.toEqual(new TranscriptionError(code))
    expect(h.requests).toEqual([])
    expect(h.outcomes).toEqual([])
  })

  it('rejects a substituted file by hash before budget reservation or egress', async () => {
    const audio = fixture()
    const h = harness()
    writeFileSync(join(audio.root, audio.name), Buffer.alloc(AUDIO.byteLength, 1))

    await expect(h.provider.transcribe(audio.request)).rejects.toEqual(
      new TranscriptionError('HASH_MISMATCH'),
    )
    expect(h.reservations).toEqual([])
    expect(h.requests).toEqual([])
  })

  it('honors abort during multi-chunk verification before reservation or egress', async () => {
    const audio = fixture('large.ogg', Buffer.alloc(2 * 1024 * 1024, 1))
    const h = harness()
    const controller = new AbortController()

    const pending = h.provider.transcribe({ ...audio.request, signal: controller.signal })
    const rejected = expect(pending).rejects.toEqual(new TranscriptionError('ABORTED'))
    setImmediate(() => controller.abort())

    await rejected
    expect(h.reservations).toEqual([])
    expect(h.requests).toEqual([])
  })

  it('rejects symlinks and hardlinks before budget reservation or egress', async () => {
    const symlinked = fixture('target.ogg')
    symlinkSync(join(symlinked.root, 'target.ogg'), join(symlinked.root, 'voice.ogg'))
    const symlinkRequest = { ...symlinked.request, relativePath: 'voice.ogg' }
    const first = harness()
    await expect(first.provider.transcribe(symlinkRequest)).rejects.toMatchObject({
      code: 'SYMLINK_DENIED',
    })

    const linked = fixture('original.ogg')
    linkSync(join(linked.root, 'original.ogg'), join(linked.root, 'voice.ogg'))
    const linkRequest = { ...linked.request, relativePath: 'voice.ogg' }
    const second = harness()
    await expect(second.provider.transcribe(linkRequest)).rejects.toMatchObject({
      code: 'HARDLINK_DENIED',
    })
    expect(first.requests).toEqual([])
    expect(second.requests).toEqual([])
  })

  it('rejects proxy or accessor reservations before HTTP without invoking getters', async () => {
    const audio = fixture()
    let getterCalls = 0
    const accessorReservation = {}
    Object.defineProperty(accessorReservation, 'settle', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return async () => {}
      },
    })

    for (const reservation of [
      new Proxy({ async settle() {} }, {}),
      accessorReservation,
      { settle: new Proxy(async () => {}, {}) },
    ]) {
      const h = harness({ reserveImpl: async () => reservation as DeepgramSpendReservation })
      await expect(h.provider.transcribe(audio.request)).rejects.toEqual(
        new TranscriptionError('QUOTA_EXCEEDED'),
      )
      expect(h.requests).toEqual([])
    }
    expect(getterCalls).toBe(0)
  })

  it('uses the captured reservation settlement after caller mutation', async () => {
    const audio = fixture()
    const original = vi.fn(async (_outcome: DeepgramSpendOutcome) => {})
    const replacement = vi.fn(async (_outcome: DeepgramSpendOutcome) => {})
    const reservation = { settle: original }
    const h = harness({
      reserveImpl: async () => reservation,
      request: async () => {
        reservation.settle = replacement
        return okResponse()
      },
    })

    await expect(h.provider.transcribe(audio.request)).resolves.toMatchObject({
      text: 'Привет из Deepgram',
    })
    expect(original).toHaveBeenCalledWith({ kind: 'settled', billableDurationMs: 1250 })
    expect(replacement).not.toHaveBeenCalled()
  })

  it('snapshots a strict owned response without invoking getters or accepting proxies', async () => {
    const audio = fixture()
    let getterCalls = 0
    class ForgedBytes extends Uint8Array {
      override get byteLength(): number {
        getterCalls += 1
        return 1
      }

      override get buffer(): ArrayBuffer {
        getterCalls += 1
        return new ArrayBuffer(1)
      }
    }
    const accessorResponse = { status: 200 }
    Object.defineProperty(accessorResponse, 'body', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return body({ private: 'must not be read' })
      },
    })

    for (const response of [
      new Proxy(okResponse(), {}),
      accessorResponse,
      { status: 200, body: new Proxy(body({ private: 'proxy bytes' }), {}) },
      { status: 200, body: new ForgedBytes(1) },
    ]) {
      const h = harness({ response: response as DeepgramHttpsResponse })
      await expect(h.provider.transcribe(audio.request)).rejects.toEqual(
        new TranscriptionError('PROTOCOL_ERROR'),
      )
      expect(h.outcomes).toEqual([{ kind: 'ambiguous' }])
    }
    expect(getterCalls).toBe(0)
  })

  it('copies the bounded response before caller mutation can swap its body', async () => {
    const audio = fixture()
    const response = { ...okResponse() }
    const h = harness({
      response,
      reserveImpl: async () => ({
        async settle() { response.body = new Uint8Array(2 * 1024 * 1024).fill(1) },
      }),
    })

    await expect(h.provider.transcribe(audio.request)).resolves.toMatchObject({
      text: 'Привет из Deepgram',
    })
    expect(response.body!.byteLength).toBe(2 * 1024 * 1024)
  })

  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [429, 'QUOTA_EXCEEDED'],
    [503, 'MODEL_UNAVAILABLE'],
  ] as const)('maps HTTP %s to a code-only error without retry', async (status, code) => {
    const audio = fixture()
    const h = harness({ response: { status, body: body({ private: 'ignored' }) } })

    await expect(h.provider.transcribe(audio.request)).rejects.toEqual(new TranscriptionError(code))
    expect(h.requests).toHaveLength(1)
    expect(h.outcomes).toEqual([{ kind: 'ambiguous' }])
  })

  it('keeps the spend reservation ambiguous on a timeout and never retries', async () => {
    vi.useFakeTimers()
    const audio = fixture()
    let closed = false
    const h = harness({
      request: async input => await new Promise<DeepgramHttpsResponse>((_resolve, reject) => {
        input.signal.addEventListener('abort', () => queueMicrotask(() => {
          closed = true
          reject(new Error('private timeout'))
        }), { once: true })
      }),
    })

    const pending = h.provider.transcribe(audio.request)
    const rejected = expect(pending).rejects.toEqual(new TranscriptionError('TIMEOUT'))
    await vi.advanceTimersByTimeAsync(1_000)

    await rejected
    expect(h.requests).toHaveLength(1)
    expect(closed).toBe(true)
    expect(h.outcomes).toEqual([{ kind: 'ambiguous' }])
  })

  it('awaits spend cancellation cleanup without leaving an orphan reservation', async () => {
    const audio = fixture()
    const controller = new AbortController()
    let pendingAuthority = 0
    const h = harness({
      reserveImpl: async input => {
        pendingAuthority += 1
        await new Promise<void>(resolve => input.signal.addEventListener('abort', () => {
          setImmediate(() => {
            pendingAuthority -= 1
            resolve()
          })
        }, { once: true }))
        return null
      },
    })

    const pending = h.provider.transcribe({ ...audio.request, signal: controller.signal })
    await vi.waitFor(() => expect(h.reservations).toHaveLength(1))
    controller.abort()

    await expect(pending).rejects.toEqual(new TranscriptionError('ABORTED'))
    expect(pendingAuthority).toBe(0)
    expect(h.requests).toEqual([])
    expect(h.outcomes).toEqual([])
  })

  it('releases a reservation committed just before abort instead of orphaning it', async () => {
    const audio = fixture()
    const controller = new AbortController()
    let outstanding = 0
    const outcomes: DeepgramSpendOutcome[] = []
    const h = harness({
      reserveImpl: async input => {
        outstanding += 1
        await new Promise<void>(resolve => input.signal.addEventListener('abort', () => {
          setImmediate(resolve)
        }, { once: true }))
        return {
          async settle(outcome) {
            outcomes.push(outcome)
            outstanding -= 1
          },
        }
      },
    })

    const pending = h.provider.transcribe({ ...audio.request, signal: controller.signal })
    await vi.waitFor(() => expect(outstanding).toBe(1))
    controller.abort()

    await expect(pending).rejects.toEqual(new TranscriptionError('ABORTED'))
    expect(outstanding).toBe(0)
    expect(h.requests).toEqual([])
    expect(outcomes).toEqual([{ kind: 'released' }])
  })

  it('retries a rejected success settlement with an ambiguous terminal outcome', async () => {
    const audio = fixture()
    let outstanding = 1
    const attempts: DeepgramSpendOutcome[] = []
    const h = harness({
      reserveImpl: async () => ({
        async settle(outcome) {
          attempts.push(outcome)
          if (outcome.kind === 'settled') throw new Error('zero commit')
          outstanding -= 1
        },
      }),
    })

    await expect(h.provider.transcribe(audio.request)).rejects.toEqual(
      new TranscriptionError('PROCESS_FAILED'),
    )
    expect(attempts).toEqual([
      { kind: 'settled', billableDurationMs: 1250 },
      { kind: 'ambiguous' },
    ])
    expect(outstanding).toBe(0)
  })

  it('awaits terminal settlement cleanup and checks the deadline before success', async () => {
    const audio = fixture()
    let now = 0
    let closed = false
    const h = harness({
      monotonicNow: () => now,
      reserveImpl: async () => ({
        async settle() {
          await new Promise<void>(resolve => setImmediate(resolve))
          closed = true
          now = 1_001
        },
      }),
    })

    await expect(h.provider.transcribe(audio.request)).rejects.toEqual(
      new TranscriptionError('TIMEOUT'),
    )
    expect(closed).toBe(true)
    expect(h.requests).toHaveLength(1)
  })

  it('awaits failure settlement cleanup before returning the code-only error', async () => {
    const audio = fixture()
    let closed = false
    const outcomes: DeepgramSpendOutcome[] = []
    const h = harness({
      response: { status: 503, body: body({ private: 'ignored' }) },
      reserveImpl: async () => ({
        async settle(outcome) {
          await new Promise<void>(resolve => setImmediate(resolve))
          outcomes.push(outcome)
          closed = true
        },
      }),
    })

    await expect(h.provider.transcribe(audio.request)).rejects.toEqual(
      new TranscriptionError('MODEL_UNAVAILABLE'),
    )
    expect(closed).toBe(true)
    expect(outcomes).toEqual([{ kind: 'ambiguous' }])
  })

  it('checks the absolute deadline after reservation and performs zero HTTP when elapsed', async () => {
    const audio = fixture()
    let now = 0
    const h = harness({
      monotonicNow: () => now,
      onReserve: () => { now = 1_001 },
    })

    await expect(h.provider.transcribe(audio.request)).rejects.toEqual(
      new TranscriptionError('TIMEOUT'),
    )
    expect(h.requests).toEqual([])
    expect(h.outcomes).toEqual([{ kind: 'released' }])
  })

  it('rejects an iterable body without starting background response consumption', async () => {
    const audio = fixture()
    let pulls = 0
    const unsafeBody = (async function* () {
      pulls += 1
      yield body({ private: 'must not be consumed' })
    })()
    const h = harness({ response: { status: 200, body: unsafeBody as never } })

    await expect(h.provider.transcribe(audio.request)).rejects.toEqual(
      new TranscriptionError('PROTOCOL_ERROR'),
    )
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(pulls).toBe(0)
    expect(h.outcomes).toEqual([{ kind: 'ambiguous' }])
  })

  it('fails closed on malformed or oversized provider responses', async () => {
    const audio = fixture()
    const malformed = harness({ response: { status: 200, body: body({ results: {} }) } })
    await expect(malformed.provider.transcribe(audio.request)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    expect(malformed.outcomes).toEqual([{ kind: 'ambiguous' }])

    const oversized = harness({
      response: {
        status: 200,
        body: new Uint8Array(64 * 1024 + 1).fill(1),
      },
    })
    await expect(oversized.provider.transcribe(audio.request)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    expect(oversized.outcomes).toEqual([{ kind: 'ambiguous' }])

    const highCardinality = harness({ response: okResponse({ padding: Array(4_097).fill(0) }) })
    await expect(highCardinality.provider.transcribe(audio.request)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    expect(highCardinality.outcomes).toEqual([{ kind: 'ambiguous' }])
  })

  it('cancels before reservation and admits only one in-flight request', async () => {
    const audio = fixture()
    const cancelled = harness()
    const controller = new AbortController()
    controller.abort()
    await expect(cancelled.provider.transcribe({ ...audio.request, signal: controller.signal }))
      .rejects.toEqual(new TranscriptionError('ABORTED'))
    expect(cancelled.reservations).toEqual([])

    let release!: (response: DeepgramHttpsResponse) => void
    const concurrent = harness({
      request: async () => await new Promise<DeepgramHttpsResponse>(resolve => { release = resolve }),
    })
    const first = concurrent.provider.transcribe(audio.request)
    await vi.waitFor(() => expect(concurrent.requests).toHaveLength(1))
    await expect(concurrent.provider.transcribe(audio.request)).rejects.toEqual(
      new TranscriptionError('QUOTA_EXCEEDED'),
    )
    release(okResponse())
    await expect(first).resolves.toMatchObject({ text: 'Привет из Deepgram' })
    expect(concurrent.requests).toHaveLength(1)
  })
})
