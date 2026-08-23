import {
  assertLeaseMatchesBinding,
  deriveDeterministicMemoryFactKey,
  type ContextLeaseCoordinator,
  type NormalizedDayLog,
  type NormalizedDayLogRecord,
  type ProjectService,
  type ProtectedMemoryForgetCandidate,
  type ProtectedMemoryForgetVerdict,
  type ProtectedMemoryRecoveryGate,
  type ProtectedMemoryScope,
  type ResolvedWorkBinding,
  type TurnContextLease,
} from '@aisy/core'
import type { NightlyMaintenanceBindings } from './nightly-maintenance-binding-store.js'
import {
  makeNightlyProjectMaintenanceCoordinator,
  type NightlyProjectMaintenanceCoordinator,
  type NightlyProjectMaintenanceEvent,
} from './nightly-project-maintenance.js'

export class NightlyProtectedMemoryForgetFilterError extends Error {
  readonly code = 'NIGHTLY_FORGET_FILTER_UNAVAILABLE'

  constructor() {
    super('NIGHTLY_FORGET_FILTER_UNAVAILABLE')
    this.name = 'NightlyProtectedMemoryForgetFilterError'
  }
}

export interface NightlyProtectedMemoryForgetFilterEvent {
  kind: 'night.forget_filter.completed' | 'night.forget_filter.failed'
  projectId: string
  sessionId: string
  droppedExact: number
  droppedReview: number
  kept: number
}

export interface NightlyProtectedMemoryScopeRuntime {
  scope: ProtectedMemoryScope
  recovery: Pick<ProtectedMemoryRecoveryGate, 'assertScopeRecovered'>
  store: {
    classifyForgetCandidates(
      candidates: readonly ProtectedMemoryForgetCandidate[],
    ): ProtectedMemoryForgetVerdict
  }
  withScopeExclusive<T>(lease: TurnContextLease, run: () => Promise<T>): Promise<T>
}

export type NightlyProtectedMemoryForgetFilter = (input: {
  binding: ResolvedWorkBinding
  lease: TurnContextLease
  rawDayLog: NormalizedDayLog
}) => Promise<NormalizedDayLog>

const RECORD_KEYS = new Set(['kind', 'ts', 'payload'])
const UTTERANCE_KEYS = new Set(['role', 'provenance', 'content'])
const TOOL_RESULT_KEYS = new Set(['provenance', 'content'])
const MAX_CONTENT_BYTES = 1024 * 1024
const MAX_RECORDS = 50_000

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every(key => expected.has(key))
}

function validIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function textForRecord(value: NormalizedDayLogRecord): string {
  if (!record(value) || !exactKeys(value, RECORD_KEYS) || !validIso(value.ts) ||
    !record(value.payload)) throw new NightlyProtectedMemoryForgetFilterError()
  const payload = value.payload
  if (value.kind === 'utterance') {
    if (!exactKeys(payload, UTTERANCE_KEYS) ||
      (payload['role'] !== 'user' && payload['role'] !== 'assistant') ||
      (payload['provenance'] !== 'operator' && payload['provenance'] !== 'untrusted') ||
      typeof payload['content'] !== 'string') {
      throw new NightlyProtectedMemoryForgetFilterError()
    }
  } else if (value.kind === 'tool-result') {
    if (!exactKeys(payload, TOOL_RESULT_KEYS) ||
      (payload['provenance'] !== 'operator' && payload['provenance'] !== 'untrusted') ||
      typeof payload['content'] !== 'string') {
      throw new NightlyProtectedMemoryForgetFilterError()
    }
  } else {
    // Structured tool-call / decision-journal schemas require a separate
    // versioned source. Unknown shapes must never bypass the forget boundary.
    throw new NightlyProtectedMemoryForgetFilterError()
  }
  const content = payload['content'] as string
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new NightlyProtectedMemoryForgetFilterError()
  }
  return content
}

function candidatesFor(text: string): ProtectedMemoryForgetCandidate[] {
  const normalized = deriveDeterministicMemoryFactKey(text)
  const candidates: ProtectedMemoryForgetCandidate[] = []
  if (normalized.keyTokens.length > 0) {
    candidates.push({ factKey: normalized.factKey, keyTokens: [...normalized.keyTokens] })
  }
  if (normalized.legacyKeyTokens.length > 0 &&
    normalized.legacyFactKey !== normalized.factKey) {
    candidates.push({
      factKey: normalized.legacyFactKey,
      keyTokens: [...normalized.legacyKeyTokens],
    })
  }
  return candidates
}

function exactRuntime(
  runtime: NightlyProtectedMemoryScopeRuntime | null,
  scope: ProtectedMemoryScope,
): NightlyProtectedMemoryScopeRuntime {
  if (!runtime || runtime.scope.kind !== scope.kind || runtime.scope.scopeId !== scope.scopeId ||
    (scope.kind === 'project' &&
      (runtime.scope.kind !== 'project' || runtime.scope.projectId !== scope.projectId))) {
    throw new NightlyProtectedMemoryForgetFilterError()
  }
  return runtime
}

/**
 * Builds the mandatory nightly ingestion filter from the integrity-protected
 * global and exact-Project forget lists. It emits counts only, never content,
 * tokens, fact keys, reasons or persistence locators.
 */
export function makeNightlyProtectedMemoryForgetFilter(input: {
  leases: Pick<ContextLeaseCoordinator, 'reserveOperation'>
  globalRuntime(): NightlyProtectedMemoryScopeRuntime | null
  projectRuntime(projectId: string): NightlyProtectedMemoryScopeRuntime | null
  emit?: (event: NightlyProtectedMemoryForgetFilterEvent) => void
}): NightlyProtectedMemoryForgetFilter {
  return async ({ binding, lease, rawDayLog }) => {
    let droppedExact = 0
    let droppedReview = 0
    let kept = 0
    try {
      const exactBinding = assertLeaseMatchesBinding(lease, binding)
      if (exactBinding.scope !== 'project' || lease.projectKind !== 'project' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(rawDayLog.date) ||
        !Array.isArray(rawDayLog.records) || rawDayLog.records.length > MAX_RECORDS) {
        throw new NightlyProtectedMemoryForgetFilterError()
      }
      const operation = input.leases.reserveOperation(lease)
      try {
        operation.beginIo()
        const globalScope: ProtectedMemoryScope = { kind: 'global', scopeId: 'global' }
        const projectScope: ProtectedMemoryScope = {
          kind: 'project',
          scopeId: `project:${binding.projectId}`,
          projectId: binding.projectId,
        }
        const global = exactRuntime(input.globalRuntime(), globalScope)
        const project = exactRuntime(input.projectRuntime(binding.projectId), projectScope)
        await global.recovery.assertScopeRecovered(lease, globalScope)
        await project.recovery.assertScopeRecovered(lease, projectScope)
        const records = await global.withScopeExclusive(lease, () =>
          project.withScopeExclusive(lease, async () => {
            const filtered: NormalizedDayLogRecord[] = []
            for (const dayRecord of rawDayLog.records) {
              const candidates = candidatesFor(textForRecord(dayRecord))
              if (candidates.length === 0) {
                filtered.push(structuredClone(dayRecord))
                kept += 1
                continue
              }
              const globalVerdict = global.store.classifyForgetCandidates(candidates)
              const projectVerdict = project.store.classifyForgetCandidates(candidates)
              if (globalVerdict === 'FORGOTTEN' || projectVerdict === 'FORGOTTEN') {
                droppedExact += 1
              } else if (globalVerdict === 'REVIEW' || projectVerdict === 'REVIEW') {
                droppedReview += 1
              } else {
                filtered.push(structuredClone(dayRecord))
                kept += 1
              }
            }
            return filtered
          }))
        const result = { date: rawDayLog.date, records }
        input.emit?.({
          kind: 'night.forget_filter.completed',
          projectId: binding.projectId,
          sessionId: binding.sessionId,
          droppedExact,
          droppedReview,
          kept,
        })
        return result
      } finally {
        operation.complete()
      }
    } catch {
      input.emit?.({
        kind: 'night.forget_filter.failed',
        projectId: binding.projectId,
        sessionId: binding.sessionId,
        droppedExact,
        droppedReview,
        kept,
      })
      throw new NightlyProtectedMemoryForgetFilterError()
    }
  }
}

/** Offline production composition seam; no scheduler or live routing is enabled. */
export function makeNodeProtectedMemoryNightlyProjectMaintenanceCoordinator(input: {
  bindings: NightlyMaintenanceBindings
  service: Pick<ProjectService,
    'assertBoundContext' | 'acquireMaintenanceContext' | 'releaseMaintenanceContext'>
  leases: Pick<ContextLeaseCoordinator, 'reserveOperation'>
  transcriptRoot: string
  globalRuntime(): NightlyProtectedMemoryScopeRuntime | null
  projectRuntime(projectId: string): NightlyProtectedMemoryScopeRuntime | null
  maxRecordsPerProject?: number
  maxBytesPerProject?: number
  maxTotalRecords?: number
  maxTotalBytes?: number
  emitMaintenance?: (event: NightlyProjectMaintenanceEvent) => void
  emitForgetFilter?: (event: NightlyProtectedMemoryForgetFilterEvent) => void
}): NightlyProjectMaintenanceCoordinator {
  const forgetFilter = makeNightlyProtectedMemoryForgetFilter({
    leases: input.leases,
    globalRuntime: input.globalRuntime,
    projectRuntime: input.projectRuntime,
    ...(input.emitForgetFilter === undefined ? {} : { emit: input.emitForgetFilter }),
  })
  return makeNightlyProjectMaintenanceCoordinator({
    bindings: input.bindings,
    service: input.service,
    leases: input.leases,
    transcriptRoot: input.transcriptRoot,
    forgetFilter,
    ...(input.maxRecordsPerProject === undefined
      ? {}
      : { maxRecordsPerProject: input.maxRecordsPerProject }),
    ...(input.maxBytesPerProject === undefined
      ? {}
      : { maxBytesPerProject: input.maxBytesPerProject }),
    ...(input.maxTotalRecords === undefined ? {} : { maxTotalRecords: input.maxTotalRecords }),
    ...(input.maxTotalBytes === undefined ? {} : { maxTotalBytes: input.maxTotalBytes }),
    ...(input.emitMaintenance === undefined ? {} : { emit: input.emitMaintenance }),
  })
}
