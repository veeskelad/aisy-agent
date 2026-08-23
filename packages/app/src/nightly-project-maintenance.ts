import {
  type ContextLeaseCoordinator,
  type NormalizedDayLog,
  type NormalizedDayLogRecord,
  type ProjectService,
  type ResolvedWorkBinding,
  type TurnContextLease,
} from '@aisy/core'
import {
  validateNightlyMaintenanceBindings,
  type NightlyMaintenanceBindings,
} from './nightly-maintenance-binding-store.js'
import { makeNodeLeaseBoundTranscriptDayLogSource } from './transcript-day-log-runtime.js'

export class NightlyProjectMaintenanceError extends Error {
  readonly code = 'NIGHTLY_PROJECT_MAINTENANCE_UNAVAILABLE'

  constructor() {
    super('NIGHTLY_PROJECT_MAINTENANCE_UNAVAILABLE')
    this.name = 'NightlyProjectMaintenanceError'
  }
}

export interface NightlyProjectDayLogSnapshot {
  binding: ResolvedWorkBinding
  rawDayLog: NormalizedDayLog
}

export interface NightlyProjectMaintenanceEvent {
  kind: 'night.project.started' | 'night.project.captured' | 'night.project.failed'
  projectId: string
  sessionId: string
}

export interface NightlyProjectMaintenanceCoordinator {
  capture(workspaceLease: TurnContextLease, date: string): Promise<NightlyProjectDayLogSnapshot[]>
}

function recordKey(record: NormalizedDayLogRecord): string {
  return JSON.stringify([record.kind, record.ts, record.payload])
}

function validatedFilteredLog(raw: NormalizedDayLog, filtered: NormalizedDayLog): NormalizedDayLog {
  if (filtered.date !== raw.date || !Array.isArray(filtered.records) ||
    filtered.records.length > raw.records.length) throw new Error('invalid filtered log')
  let sourceIndex = 0
  const records: NormalizedDayLogRecord[] = []
  for (const record of filtered.records) {
    const key = recordKey(record)
    let found = false
    while (sourceIndex < raw.records.length) {
      const candidate = raw.records[sourceIndex++]!
      if (recordKey(candidate) !== key) continue
      records.push(structuredClone(candidate))
      found = true
      break
    }
    if (!found) throw new Error('filter fabricated or reordered a record')
  }
  return { date: raw.date, records }
}

function positiveLimit(value: number | undefined, fallback: number, ceiling: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > ceiling) {
    throw new NightlyProjectMaintenanceError()
  }
  return resolved
}

/**
 * Captures separate, forget-filtered Project logs under explicit exclusive
 * maintenance leases. It never enumerates the registry, reads the interactive
 * selection, merges Projects, or activates the live nightly runner.
 */
export function makeNightlyProjectMaintenanceCoordinator(input: {
  bindings: NightlyMaintenanceBindings
  service: Pick<ProjectService,
    'assertBoundContext' | 'acquireMaintenanceContext' | 'releaseMaintenanceContext'>
  leases: Pick<ContextLeaseCoordinator, 'reserveOperation'>
  transcriptRoot: string
  forgetFilter(input: {
    binding: ResolvedWorkBinding
    lease: TurnContextLease
    rawDayLog: NormalizedDayLog
  }): Promise<NormalizedDayLog>
  maxRecordsPerProject?: number
  maxBytesPerProject?: number
  maxTotalRecords?: number
  maxTotalBytes?: number
  emit?: (event: NightlyProjectMaintenanceEvent) => void
}): NightlyProjectMaintenanceCoordinator {
  let bindings: NightlyMaintenanceBindings
  try {
    bindings = validateNightlyMaintenanceBindings(input.bindings)
  } catch {
    throw new NightlyProjectMaintenanceError()
  }
  const transcriptRoot = input.transcriptRoot
  const service = input.service
  const leases = input.leases
  const forgetFilter = input.forgetFilter
  const maxRecordsPerProject = positiveLimit(input.maxRecordsPerProject, 50_000, 1_000_000)
  const maxBytesPerProject = positiveLimit(input.maxBytesPerProject, 32 * 1024 * 1024, 256 * 1024 * 1024)
  const maxTotalRecords = positiveLimit(input.maxTotalRecords, 100_000, 2_000_000)
  const maxTotalBytes = positiveLimit(input.maxTotalBytes, 64 * 1024 * 1024, 512 * 1024 * 1024)

  return {
    async capture(workspaceLease, date) {
      const snapshots: NightlyProjectDayLogSnapshot[] = []
      let totalRecords = 0
      let totalBytes = 0
      try {
        service.assertBoundContext(workspaceLease, bindings.workspace)
        for (const binding of bindings.projects) {
          service.assertBoundContext(workspaceLease, bindings.workspace)
          input.emit?.({
            kind: 'night.project.started',
            projectId: binding.projectId,
            sessionId: binding.sessionId,
          })
          let lease: TurnContextLease | undefined
          let operation: ReturnType<typeof leases.reserveOperation> | undefined
          let snapshot: NightlyProjectDayLogSnapshot | undefined
          let failed = false
          try {
            lease = await service.acquireMaintenanceContext(binding)
            operation = leases.reserveOperation(lease)
            operation.beginIo()
            const rawDayLog = await makeNodeLeaseBoundTranscriptDayLogSource({
              root: transcriptRoot,
              binding,
              lease,
              leases,
              maxRecords: maxRecordsPerProject,
              maxBytes: maxBytesPerProject,
            }).load(date)
            service.assertBoundContext(lease, binding)
            const filtered = await forgetFilter({
              binding,
              lease,
              rawDayLog: structuredClone(rawDayLog),
            })
            service.assertBoundContext(lease, binding)
            const rawDayLogFiltered = validatedFilteredLog(rawDayLog, filtered)
            totalRecords += rawDayLogFiltered.records.length
            totalBytes += Buffer.byteLength(JSON.stringify(rawDayLogFiltered), 'utf8')
            if (totalRecords > maxTotalRecords || totalBytes > maxTotalBytes) throw new Error('total limit')
            snapshot = {
              binding: Object.freeze({ ...binding }),
              rawDayLog: rawDayLogFiltered,
            }
          } catch {
            failed = true
          } finally {
            try { operation?.complete() } catch { failed = true }
            if (lease !== undefined) {
              try { await service.releaseMaintenanceContext(lease) } catch { failed = true }
            }
          }
          if (failed || snapshot === undefined) {
            input.emit?.({
              kind: 'night.project.failed',
              projectId: binding.projectId,
              sessionId: binding.sessionId,
            })
            throw new NightlyProjectMaintenanceError()
          }
          snapshots.push(snapshot)
          input.emit?.({
            kind: 'night.project.captured',
            projectId: binding.projectId,
            sessionId: binding.sessionId,
          })
        }
        service.assertBoundContext(workspaceLease, bindings.workspace)
        return snapshots
      } catch (error) {
        if (error instanceof NightlyProjectMaintenanceError) throw error
        throw new NightlyProjectMaintenanceError()
      }
    },
  }
}
