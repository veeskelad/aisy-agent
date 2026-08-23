// The three adapters the Deepgram provider needs to run for real: an HTTPS
// transport pinned to the endpoint, a durable daily spend ledger, and a key
// resolver over the vault.
//
// The provider is written against ports precisely so none of this lives inside
// it; what matters here is that each adapter keeps the promise the port makes —
// the transport never follows a redirect or returns an unbounded body, and the
// ledger never loses a reservation across a crash.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type {
  DeepgramEndpointHost,
  DeepgramHttpsRequestPort,
  DeepgramHttpsResponse,
  DeepgramSpendAuthority,
  DeepgramSpendOutcome,
  DeepgramSpendReservation,
} from './deepgram-transcription-provider.js'
import type {
  DeepgramProxySpendAuthority,
  DeepgramProxySpendOutcome,
  DeepgramProxySpendReservation,
} from './deepgram-proxy-provider.js'

/** Aisy's own name for the key; the provider asks for the vendor's. */
export const DEEPGRAM_VAULT_KEY = 'AISY_DEEPGRAM_KEY'

/** An hour of audio a day is far past ordinary use and still cheap to cap. */
export const DEFAULT_VOICE_DAILY_MS = 60 * 60 * 1000

export function makeNodeDeepgramHttpsRequestPort(input: {
  endpointHost: DeepgramEndpointHost
  fetchImpl?: typeof fetch
}): DeepgramHttpsRequestPort {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  return Object.freeze<DeepgramHttpsRequestPort>({
    async request(request): Promise<DeepgramHttpsResponse> {
      // The port promises an exact destination. Checking it here means a
      // mistake upstream cannot turn into audio sent to another host.
      const url = new URL(request.url)
      if (url.protocol !== 'https:' || url.host !== input.endpointHost) {
        throw new Error('DEEPGRAM_ENDPOINT_MISMATCH')
      }
      const response = await fetchImpl(url, {
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        redirect: request.redirect,
        signal: request.signal,
      })
      const body = response.body === null
        ? null
        : await readBounded(response.body, request.maxResponseBytes)
      return Object.freeze({ status: response.status, body })
    },
  })
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      // Stop reading rather than buffer whatever the other side decided to send.
      if (total > maxBytes) throw new Error('DEEPGRAM_RESPONSE_TOO_LARGE')
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
    await stream.cancel().catch(() => undefined)
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

interface VoiceSpendStateV1 {
  schemaVersion: 1
  day: string
  spentMs: number
  /** Reservations that were created but not yet settled — durable on purpose. */
  open: Record<string, { reservedMs: number; openedAt: string }>
}

function emptyState(day: string): VoiceSpendStateV1 {
  return { schemaVersion: 1, day, spentMs: 0, open: {} }
}

function saveAtomic(path: string, content: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const descriptor = openSync(temporary, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  renameSync(temporary, path)
}

/**
 * Durable daily cap on billable audio.
 *
 * An open reservation survives a crash on purpose: a request that was dispatched
 * and never settled has to keep costing until something says otherwise, or a
 * loop that dies mid-flight would spend without limit. Recovery is by day
 * rollover, which is also what the cap is measured in.
 */
export function makeNodeDeepgramSpendAuthority(input: {
  path: string
  dailyLimitMs?: number
  nowIso?: () => string
}): DeepgramSpendAuthority {
  const dailyLimitMs = input.dailyLimitMs ?? DEFAULT_VOICE_DAILY_MS
  const nowIso = input.nowIso ?? (() => new Date().toISOString())

  const load = (): VoiceSpendStateV1 => {
    const today = nowIso().slice(0, 10)
    if (!existsSync(input.path)) return emptyState(today)
    try {
      const value = JSON.parse(readFileSync(input.path, 'utf8')) as VoiceSpendStateV1
      if (value.schemaVersion !== 1 || typeof value.day !== 'string' ||
        !Number.isFinite(value.spentMs) || typeof value.open !== 'object' || value.open === null) {
        return emptyState(today)
      }
      return value.day === today ? value : emptyState(today)
    } catch {
      // An unreadable ledger must not become an unlimited one.
      return emptyState(today)
    }
  }

  const save = (state: VoiceSpendStateV1): void => {
    saveAtomic(input.path, JSON.stringify(state, null, 2) + '\n')
  }

  const committed = (state: VoiceSpendStateV1): number =>
    state.spentMs + Object.values(state.open).reduce((sum, entry) => sum + entry.reservedMs, 0)

  return Object.freeze<DeepgramSpendAuthority>({
    async reserve(request) {
      if (request.signal.aborted) return null
      const state = load()
      if (committed(state) + request.maximumBillableDurationMs > dailyLimitMs) return null
      const id = createHash('sha256')
        .update(`${request.providerId}\0${request.requestHash}\0${randomUUID()}`)
        .digest('hex')
        .slice(0, 32)
      state.open[id] = { reservedMs: request.maximumBillableDurationMs, openedAt: nowIso() }
      save(state)

      let settled = false
      return Object.freeze<DeepgramSpendReservation>({
        async settle(outcome: DeepgramSpendOutcome) {
          if (settled) return
          const current = load()
          const held = current.open[id]
          // A day rollover dropped the reservation; charging it to the new day
          // would move spend across the very boundary the cap is drawn on.
          if (held === undefined) { settled = true; return }
          delete current.open[id]
          if (outcome.kind === 'settled') {
            current.spentMs += Math.min(Math.max(0, outcome.billableDurationMs), held.reservedMs)
          } else if (outcome.kind === 'ambiguous') {
            // The request went out and we never learned the cost. Charge the
            // maximum: undercounting an unknown is how a cap gets bypassed.
            current.spentMs += held.reservedMs
          }
          save(current)
          settled = true
        },
      })
    },
  })
}

/** Durable proxy spend holds expose only an opaque recovery key to the root broker. */
export function makeNodeDeepgramProxySpendAuthority(input: {
  path: string
  dailyLimitMs?: number
  nowIso?: () => string
}): DeepgramProxySpendAuthority {
  const dailyLimitMs = input.dailyLimitMs ?? DEFAULT_VOICE_DAILY_MS
  const nowIso = input.nowIso ?? (() => new Date().toISOString())

  const load = (): VoiceSpendStateV1 | null => {
    const today = nowIso().slice(0, 10)
    if (!existsSync(input.path)) return emptyState(today)
    try {
      const value = JSON.parse(readFileSync(input.path, 'utf8')) as VoiceSpendStateV1
      if (value.schemaVersion !== 1 || typeof value.day !== 'string' ||
        !Number.isFinite(value.spentMs) || value.spentMs < 0 ||
        typeof value.open !== 'object' || value.open === null || Array.isArray(value.open) ||
        Object.entries(value.open).some(([key, entry]) =>
          !/^[A-Za-z0-9_-]{32,128}$/.test(key) || entry === null || typeof entry !== 'object' ||
          !Number.isFinite(entry.reservedMs) || entry.reservedMs < 0 ||
          typeof entry.openedAt !== 'string')) {
        return null
      }
      return value.day === today ? value : emptyState(today)
    } catch {
      return null
    }
  }

  const save = (state: VoiceSpendStateV1): void => {
    saveAtomic(input.path, JSON.stringify(state, null, 2) + '\n')
  }
  const committed = (state: VoiceSpendStateV1): number =>
    state.spentMs + Object.values(state.open).reduce((sum, entry) => sum + entry.reservedMs, 0)

  const handle = (
    recoveryKey: string,
    reservedMs: number,
  ): DeepgramProxySpendReservation => {
    let settled = false
    return Object.freeze({
      recoveryKey,
      async settle(outcome: DeepgramProxySpendOutcome) {
        if (settled) return
        const current = load()
        if (current === null) throw new Error('VOICE_SPEND_CORRUPT')
        const held = current.open[recoveryKey]
        if (held === undefined) { settled = true; return }
        delete current.open[recoveryKey]
        if (outcome.kind === 'settled') {
          current.spentMs += Math.min(
            Math.max(0, outcome.billableDurationMs),
            Math.min(held.reservedMs, reservedMs),
          )
        } else if (outcome.kind === 'ambiguous') {
          current.spentMs += held.reservedMs
        }
        save(current)
        settled = true
      },
    })
  }

  return Object.freeze({
    async reserve(request: Parameters<DeepgramProxySpendAuthority['reserve']>[0]) {
      if (request.signal.aborted) return null
      const state = load()
      if (state === null ||
        committed(state) + request.maximumBillableDurationMs > dailyLimitMs) return null
      const recoveryKey = randomBytes(32).toString('base64url')
      state.open[recoveryKey] = {
        reservedMs: request.maximumBillableDurationMs,
        openedAt: nowIso(),
      }
      save(state)
      return handle(recoveryKey, request.maximumBillableDurationMs)
    },
    async recover(recoveryKey: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(recoveryKey)) return null
      const state = load()
      if (state === null) return null
      const held = state.open[recoveryKey]
      return held === undefined ? null : handle(recoveryKey, held.reservedMs)
    },
  })
}

/** Reads the vault fresh so a key added from the phone works without a restart. */
export function makeVaultSecretResolver(input: {
  vaultPath: string
  /** Vendor name asked for by the provider → the name Aisy stores it under. */
  mapping: Readonly<Record<string, string>>
}): (name: string) => Promise<string | null> {
  return async (name) => {
    const vaultKey = input.mapping[name]
    if (vaultKey === undefined || !existsSync(input.vaultPath)) return null
    try {
      const vault = JSON.parse(readFileSync(input.vaultPath, 'utf8')) as Record<string, unknown>
      const value = vault[vaultKey]
      return typeof value === 'string' && value.length > 0 ? value : null
    } catch {
      return null
    }
  }
}
