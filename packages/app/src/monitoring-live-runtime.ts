import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  wallClockIso,
  resolvedWorkBinding,
  type DigestBuildConfig,
  type MonitoringDigest,
  type MonitoringEngine,
  type MonitoringPollResult,
  type MonitoringStore,
  type ResolvedWorkBinding,
} from '@aisy/core'
import type {
  MonitoringDeliveryCoordinator,
  MonitoringDeliveryTickResult,
} from './monitoring-runtime.js'

export interface MonitoringDigestWindow {
  bindingHash: string
  localDate: string
  windowStart: string
  windowEnd: string
  status: 'claimed' | 'evaluated'
}

export interface MonitoringWindowStore {
  claim(input: {
    binding: ResolvedWorkBinding
    localDate: string
    windowStart: string
    windowEnd: string
  }): MonitoringDigestWindow
  complete(input: MonitoringDigestWindow): MonitoringDigestWindow
}

interface MonitoringWindowState {
  schemaVersion: 1
  windows: MonitoringDigestWindow[]
}

export interface MonitoringLiveTickResult {
  skipped: boolean
  collection: MonitoringPollResult[]
  digest: 'not-due' | 'empty' | 'created' | 'existing'
  delivery: MonitoringDeliveryTickResult | null
}

export interface MonitoringLiveCoordinator {
  tick(): Promise<MonitoringLiveTickResult>
}

export interface MonitoringLiveConfig {
  digestAt: string
  maxSources: number
  maxCollectedItems: number
  maxScoringCalls: number
  maxDeliveryDigests: number
  windowHours: number
  digestTtlHours: number
  maxDigestItems: number
  maxPerSource: number
  maxPerAuthor: number
  halfLifeHours: number
}

export const DEFAULT_MONITORING_LIVE_CONFIG: Readonly<MonitoringLiveConfig> = Object.freeze({
  digestAt: '08:00',
  maxSources: 3,
  maxCollectedItems: 20,
  maxScoringCalls: 8,
  maxDeliveryDigests: 10,
  windowHours: 24,
  digestTtlHours: 48,
  maxDigestItems: 10,
  maxPerSource: 3,
  maxPerAuthor: 2,
  halfLifeHours: 24,
})

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const HASH = /^[a-f0-9]{64}$/
const MAX_WINDOWS = 400

function exactBindingHash(binding: ResolvedWorkBinding): string {
  const clean = resolvedWorkBinding(binding)
  return createHash('sha256').update(JSON.stringify([
    'aisy.monitoring-window.v1',
    clean.operatorId,
    clean.profileId,
    clean.projectId,
    clean.sessionId,
    clean.scope,
  ])).digest('hex')
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function parseState(raw: string): MonitoringWindowState {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('MONITORING_WINDOW_STATE_INVALID') }
  if (typeof value !== 'object' || value === null) throw new Error('MONITORING_WINDOW_STATE_INVALID')
  const state = value as Record<string, unknown>
  if (Object.keys(state).sort().join(',') !== 'schemaVersion,windows' ||
    state['schemaVersion'] !== 1 || !Array.isArray(state['windows']) ||
    state['windows'].length > MAX_WINDOWS) {
    throw new Error('MONITORING_WINDOW_STATE_INVALID')
  }
  const windows: MonitoringDigestWindow[] = []
  const keys = new Set<string>()
  for (const rawWindow of state['windows']) {
    if (typeof rawWindow !== 'object' || rawWindow === null) throw new Error('MONITORING_WINDOW_STATE_INVALID')
    const item = rawWindow as Record<string, unknown>
    if (Object.keys(item).sort().join(',') !== 'bindingHash,localDate,status,windowEnd,windowStart' ||
      typeof item['bindingHash'] !== 'string' || !HASH.test(item['bindingHash']) ||
      typeof item['localDate'] !== 'string' || !DATE.test(item['localDate']) ||
      !validIso(item['windowStart']) || !validIso(item['windowEnd']) ||
      (item['status'] !== 'claimed' && item['status'] !== 'evaluated') ||
      Date.parse(item['windowStart']) > Date.parse(item['windowEnd'])) {
      throw new Error('MONITORING_WINDOW_STATE_INVALID')
    }
    const key = `${item['bindingHash']}:${item['localDate']}`
    if (keys.has(key)) throw new Error('MONITORING_WINDOW_STATE_INVALID')
    keys.add(key)
    windows.push({
      bindingHash: item['bindingHash'],
      localDate: item['localDate'],
      windowStart: item['windowStart'],
      windowEnd: item['windowEnd'],
      status: item['status'],
    })
  }
  return { schemaVersion: 1, windows }
}

/** Atomic 0600 state; contains only binding hashes and digest window timestamps. */
export function makeNodeMonitoringWindowStore(input: {
  path: string
  newTempId?: () => string
}): MonitoringWindowStore {
  const newTempId = input.newTempId ?? randomUUID
  mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 })
  const load = (): MonitoringWindowState => {
    if (!existsSync(input.path)) return { schemaVersion: 1, windows: [] }
    const state = parseState(readFileSync(input.path, 'utf8'))
    chmodSync(input.path, 0o600)
    return state
  }
  let state = load()

  const save = (candidate: MonitoringWindowState): void => {
    const temporary = `${input.path}.${newTempId()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(candidate, null, 2) + '\n', {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      })
      renameSync(temporary, input.path)
      chmodSync(input.path, 0o600)
      state = candidate
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* absent or already renamed */ }
      throw error
    }
  }

  return Object.freeze<MonitoringWindowStore>({
    claim({ binding, localDate, windowStart, windowEnd }) {
      if (!DATE.test(localDate) || !validIso(windowStart) || !validIso(windowEnd) ||
        Date.parse(windowStart) > Date.parse(windowEnd)) {
        throw new Error('MONITORING_WINDOW_INVALID')
      }
      const bindingHash = exactBindingHash(binding)
      const existing = state.windows.find((item) =>
        item.bindingHash === bindingHash && item.localDate === localDate)
      if (existing !== undefined) return Object.freeze({ ...existing })
      const created: MonitoringDigestWindow = {
        bindingHash, localDate, windowStart, windowEnd, status: 'claimed',
      }
      const evaluated = state.windows
        .filter((item) => item.status === 'evaluated')
        .sort((left, right) => left.localDate.localeCompare(right.localDate))
      const claimed = state.windows.filter((item) => item.status === 'claimed')
      if (claimed.length >= MAX_WINDOWS) throw new Error('MONITORING_WINDOW_STATE_FULL')
      const keepEvaluated = evaluated.slice(Math.max(0, evaluated.length - (MAX_WINDOWS - claimed.length - 1)))
      save({ schemaVersion: 1, windows: [...claimed, ...keepEvaluated, created] })
      return Object.freeze({ ...created })
    },

    complete(window) {
      const index = state.windows.findIndex((item) =>
        item.bindingHash === window.bindingHash && item.localDate === window.localDate &&
        item.windowStart === window.windowStart && item.windowEnd === window.windowEnd)
      if (index < 0) throw new Error('MONITORING_WINDOW_NOT_FOUND')
      const completed: MonitoringDigestWindow = { ...state.windows[index]!, status: 'evaluated' }
      const windows = state.windows.slice()
      windows[index] = completed
      save({ schemaVersion: 1, windows })
      return Object.freeze({ ...completed })
    },
  })
}

function validateConfig(config: MonitoringLiveConfig): void {
  const integers: Array<[number, number]> = [
    [config.maxSources, 100],
    [config.maxCollectedItems, 1_000],
    [config.maxScoringCalls, 100],
    [config.maxDeliveryDigests, 100],
    [config.windowHours, 24 * 30],
    [config.digestTtlHours, 24 * 30],
    [config.maxDigestItems, 100],
    [config.maxPerSource, 100],
    [config.maxPerAuthor, 100],
  ]
  if (!TIME.test(config.digestAt) || integers.some(([value, max]) =>
    !Number.isSafeInteger(value) || value <= 0 || value > max) ||
    !Number.isFinite(config.halfLifeHours) || config.halfLifeHours <= 0 || config.halfLifeHours > 24 * 30) {
    throw new RangeError('invalid monitoring live config')
  }
}

/** One bounded, concurrency-safe collection → digest → delivery cycle. */
export function makeMonitoringLiveCoordinator(input: {
  engine: MonitoringEngine
  store: Pick<MonitoringStore, 'candidates' | 'getDigestForWindow'>
  delivery: MonitoringDeliveryCoordinator
  windows: MonitoringWindowStore
  binding: ResolvedWorkBinding
  config?: MonitoringLiveConfig
  nowIso?: () => string
  timeZone?: () => string | undefined
}): MonitoringLiveCoordinator {
  const config = input.config ?? DEFAULT_MONITORING_LIVE_CONFIG
  validateConfig(config)
  const nowIso = input.nowIso ?? (() => new Date().toISOString())
  let running = false

  return Object.freeze<MonitoringLiveCoordinator>({
    async tick() {
      if (running) return { skipped: true, collection: [], digest: 'not-due', delivery: null }
      running = true
      try {
        const collection = await input.engine.tick({
          maxSources: config.maxSources,
          maxCollectedItems: config.maxCollectedItems,
          maxScoringCalls: config.maxScoringCalls,
        })
        const now = nowIso()
        const local = wallClockIso(now, input.timeZone?.())
        let digest: MonitoringLiveTickResult['digest'] = 'not-due'
        if (local.slice(11, 16) >= config.digestAt) {
          const window = input.windows.claim({
            binding: input.binding,
            localDate: local.slice(0, 10),
            windowStart: new Date(Date.parse(now) - config.windowHours * 3_600_000).toISOString(),
            windowEnd: now,
          })
          if (window.status === 'evaluated') {
            digest = input.store.getDigestForWindow(
              input.binding, window.windowStart, window.windowEnd,
            ) === null ? 'empty' : 'existing'
          } else {
            const existing = input.store.getDigestForWindow(
              input.binding, window.windowStart, window.windowEnd,
            )
            if (existing !== null) {
              digest = 'existing'
            } else {
              const hasDigestItem = input.store
                .candidates(input.binding, window.windowStart, window.windowEnd)
                .some((item) => item.category !== undefined && item.category !== 'noise')
              if (hasDigestItem) {
                const digestConfig: DigestBuildConfig = {
                  windowStart: window.windowStart,
                  windowEnd: window.windowEnd,
                  notBefore: window.windowEnd,
                  expiresAt: new Date(
                    Date.parse(window.windowEnd) + config.digestTtlHours * 3_600_000,
                  ).toISOString(),
                  maxItems: config.maxDigestItems,
                  maxPerSource: config.maxPerSource,
                  maxPerAuthor: config.maxPerAuthor,
                  halfLifeHours: config.halfLifeHours,
                }
                const built: MonitoringDigest = input.engine.buildDigest(input.binding, digestConfig)
                digest = built.items.length === 0 ? 'empty' : 'created'
              } else {
                digest = 'empty'
              }
            }
            input.windows.complete(window)
          }
        }
        const delivery = await input.delivery.tick(config.maxDeliveryDigests)
        return { skipped: false, collection, digest, delivery }
      } finally {
        running = false
      }
    },
  })
}
