// Live-composition adapter for protected scoped memory (ADR-0074).
//
// The composition needs a narrow, familiar surface: search, commit, forget, list
// live facts and an integrity verdict. Scoped memory provides the first three
// through `ScopedMemoryRouter`; the last two come from the protected ledger
// itself, because the router deliberately exposes no bulk read.
//
// Every method takes a `TurnContextLease`: there is no ambient memory access
// after ADR-0074, not even for maintenance paths.

import { findDuplicateFact } from '@aisy/core'
import type {
  CommitResult,
  MemoryFact,
  MemoryOp,
  ScopedMemoryHit,
  ScopedMemoryRouter,
  TurnContextLease,
} from '@aisy/core'

/** Subset of a protected ledger record this adapter projects to `MemoryFact`. */
export interface ProtectedLedgerFact {
  id: string
  text: string
  factKey: string
  validAt: string
  invalidAt: null
  isHumanConfirmed: boolean
  sourceAuthority: number | null
  confidence: number | null
  provenance: string
  supersedes?: string
  contradicts?: string
  extends?: string
}

/** The protected runtime surface this adapter reads directly (bulk + integrity). */
export interface ProtectedLedgerReadPort {
  listLiveFacts(): Promise<ProtectedLedgerFact[]>
  integrityCheck(): { ok: boolean; detail?: string }
}

/**
 * A commit that was refused as a repeat (ADR-0078).
 *
 * Deliberately an edge-layer shape rather than a new `CommitResult` status:
 * nothing in Core needs to know that this composition deduplicates.
 */
export interface DuplicateCommitResult {
  status: 'DUPLICATE'
  /** The fact that already says this. */
  factId: string
}

export type LiveCommitResult = CommitResult | DuplicateCommitResult

export interface LiveMemoryView {
  search(lease: TurnContextLease, query: string, opts?: { limit?: number }): Promise<ScopedMemoryHit[]>
  /** Commits to the scope of the lease: Workspace leases write global, project leases write project. */
  commit(
    lease: TurnContextLease,
    op: MemoryOp,
    ctx: { withinSession: boolean; operationId?: string },
  ): Promise<LiveCommitResult>
  forget(lease: TurnContextLease, factId: string, reason: string, humanConfirmed: boolean): Promise<void>
  listLive(lease: TurnContextLease): Promise<MemoryFact[]>
  integrityCheck(lease: TurnContextLease): { ok: boolean; detail?: string }
}

export class ScopedMemoryUnavailableError extends Error {
  readonly code = 'SCOPED_MEMORY_UNAVAILABLE'
  constructor() {
    super('SCOPED_MEMORY_UNAVAILABLE')
    this.name = 'ScopedMemoryUnavailableError'
  }
}

function toMemoryFact(record: ProtectedLedgerFact): MemoryFact {
  const fact: MemoryFact = {
    id: record.id,
    text: record.text,
    factKey: record.factKey,
    validAt: record.validAt,
    invalidAt: record.invalidAt,
    isHumanConfirmed: record.isHumanConfirmed,
    sourceAuthority: record.sourceAuthority,
    confidence: record.confidence,
    provenance: record.provenance,
  }
  // Relationship edges are optional in both shapes; copy only what exists so the
  // projection never invents an edge the ledger does not hold.
  if (record.supersedes !== undefined) fact.supersedes = record.supersedes
  if (record.contradicts !== undefined) fact.contradicts = record.contradicts
  if (record.extends !== undefined) fact.extends = record.extends
  return fact
}

/**
 * Build the live memory view. `router` is null when protected memory is off —
 * every call then fails closed rather than silently falling back to a shared
 * store, which is exactly the second source of truth ADR-0074 removes.
 */
export function makeScopedMemoryLiveView(input: {
  router: ScopedMemoryRouter | null
  ledger: ProtectedLedgerReadPort | null
}): LiveMemoryView {
  const router = (): ScopedMemoryRouter => {
    if (input.router === null) throw new ScopedMemoryUnavailableError()
    return input.router
  }
  const ledger = (): ProtectedLedgerReadPort => {
    if (input.ledger === null) throw new ScopedMemoryUnavailableError()
    return input.ledger
  }

  return {
    async search(lease, query, opts) {
      const result = await router().searchAutomatic(lease, query, opts ?? {})
      // A degraded result is still a result: the caller sees the global hits it
      // could get, and the degradation is recorded by the router's own event.
      return result.hits
    },

    async commit(lease, op, ctx) {
      const target = router()

      // Deduplication (ADR-0078) runs before the guard and only for ADD: an
      // update or a delete is about a specific fact and always goes the full
      // way. Candidates come from search rather than a full scan — a repeat
      // shares its opening, so it is exactly what search returns.
      if (op.op === 'ADD') {
        const nearby = await target.searchAutomatic(lease, op.text, { limit: 10 })
        const repeat = findDuplicateFact(op.text, nearby.hits)
        if (repeat !== null && repeat.id !== ctx.operationId) {
          return { status: 'DUPLICATE', factId: repeat.id }
        }
      }

      return lease.projectKind === 'project'
        ? target.commitProject(lease, op, ctx)
        : target.commitGlobal(lease, op, ctx)
    },

    async forget(lease, factId, reason, humanConfirmed) {
      const target = router()
      await (lease.projectKind === 'project'
        ? target.forgetProject(lease, factId, reason, humanConfirmed)
        : target.forgetGlobal(lease, factId, reason, humanConfirmed))
    },

    async listLive(lease) {
      // The lease is required even though the ledger read needs no scope argument:
      // holding one is what proves this caller is allowed to read at all.
      if (typeof lease.leaseId !== 'string' || lease.leaseId === '') {
        throw new ScopedMemoryUnavailableError()
      }
      return (await ledger().listLiveFacts()).map(toMemoryFact)
    },

    integrityCheck(lease) {
      if (typeof lease.leaseId !== 'string' || lease.leaseId === '') {
        throw new ScopedMemoryUnavailableError()
      }
      return ledger().integrityCheck()
    },
  }
}
