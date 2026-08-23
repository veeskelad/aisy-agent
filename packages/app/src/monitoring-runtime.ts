import {
  makeGitHubMonitoringCollector,
  makeMonitoringEngine,
  makeMonitoringStore,
  makeRssMonitoringCollector,
  makeTelegramMonitoringCollector,
  makeWebMonitoringCollector,
  makeYouTubeMonitoringCollector,
  type MonitoringEngine,
  type MonitoringDigest,
  type MonitoringEvent,
  type MonitoringHttpPort,
  type MonitoringScorer,
  type MonitoringStore,
  type ResolvedWorkBinding,
} from '@aisy/core'
import { randomUUID } from 'node:crypto'
import { makeMonitoringExactDomainHttpPort } from './monitoring-exact-domain-egress.js'

export interface NodeMonitoringRuntime {
  store: MonitoringStore
  engine: MonitoringEngine
}

export interface MonitoringDigestDeliveryPort {
  deliver(input: {
    digest: MonitoringDigest
    /** Stable adapter-side idempotency key for retry-safe delivery. */
    idempotencyKey: string
  }): Promise<string | null | undefined>
}

export interface MonitoringDeliveryTickResult {
  due: number
  attempted: number
  delivered: number
  noReceipt: number
  failed: number
  skipped: number
}

export interface MonitoringDeliveryCoordinator {
  tick(maxDigests: number): Promise<MonitoringDeliveryTickResult>
}

const MAX_DELIVERY_BATCH = 100

/**
 * Executes an explicitly scheduled delivery tick. The coordinator has no
 * timer and no concrete transport, so constructing it cannot activate I/O.
 */
export function makeMonitoringDeliveryCoordinator(input: {
  engine: MonitoringEngine
  delivery: MonitoringDigestDeliveryPort
  nowIso?: () => string
}): MonitoringDeliveryCoordinator {
  const nowIso = input.nowIso ?? (() => new Date().toISOString())

  return {
    async tick(maxDigests) {
      if (!Number.isSafeInteger(maxDigests) || maxDigests <= 0 || maxDigests > MAX_DELIVERY_BATCH) {
        throw new RangeError('maxDigests must be an integer between 1 and 100')
      }

      const now = nowIso()
      const candidates = input.engine.listDueDigests(now).slice(0, maxDigests)
      const result: MonitoringDeliveryTickResult = {
        due: candidates.length,
        attempted: 0,
        delivered: 0,
        noReceipt: 0,
        failed: 0,
        skipped: 0,
      }

      for (const candidate of candidates) {
        // Re-resolve the persisted exact binding immediately before adapter I/O.
        const digest = input.engine.listDueDigests(now).find((item) => item.id === candidate.id)
        if (digest === undefined) {
          result.skipped += 1
          continue
        }

        result.attempted += 1
        try {
          const rawReceipt = await input.delivery.deliver({
            digest,
            idempotencyKey: digest.id,
          })
          const receipt = typeof rawReceipt === 'string' ? rawReceipt.trim() : ''
          if (receipt.length === 0) {
            result.noReceipt += 1
            continue
          }
          input.engine.markDelivered(digest.id, receipt)
          result.delivered += 1
        } catch {
          // Delivery remains retryable; adapter errors are deliberately redacted.
          result.failed += 1
        }
      }

      return result
    },
  }
}

/**
 * Production composition seam. It creates the local store and all initial
 * deterministic connector families, but performs no poll/delivery by itself.
 */
export function makeNodeMonitoringRuntime(input: {
  dbPath: string
  resolveBinding(binding: ResolvedWorkBinding): void
  scorer?: MonitoringScorer
  /** Test/embedding override; default is the exact-source-domain pinned HTTPS port. */
  http?: MonitoringHttpPort
  /** Operator-wide digest criteria; per-source criteria narrow it (ADR-0084). */
  globalCriteria?: () => string | null
  nowIso?: () => string
  newId?: () => string
  emit?: (event: MonitoringEvent) => void
}): NodeMonitoringRuntime {
  const store = makeMonitoringStore({ dbPath: input.dbPath })
  const http = input.http ?? makeMonitoringExactDomainHttpPort({ authority: store })
  const engine = makeMonitoringEngine({
    store,
    collectors: {
      telegram: makeTelegramMonitoringCollector(http),
      rss: makeRssMonitoringCollector(http),
      youtube: makeYouTubeMonitoringCollector(http),
      github: makeGitHubMonitoringCollector(http),
      web: makeWebMonitoringCollector(http),
    },
    ...(input.scorer === undefined ? {} : { scorer: input.scorer }),
    ...(input.globalCriteria === undefined ? {} : { globalCriteria: input.globalCriteria }),
    resolveBinding: input.resolveBinding,
    nowIso: input.nowIso ?? (() => new Date().toISOString()),
    newId: input.newId ?? randomUUID,
    ...(input.emit === undefined ? {} : { emit: input.emit }),
  })
  return { store, engine }
}
