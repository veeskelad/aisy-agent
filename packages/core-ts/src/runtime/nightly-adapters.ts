// packages/core-ts/src/runtime/nightly-adapters.ts
// Nightly support adapters: file-based RunLock, deterministic Validators,
// and the nightly↔memory type bridge (Tier-4 B2).

import { randomUUID } from 'node:crypto'

import type { RunLock, LockToken, Validators, ValidatorResult, Fact, MemOp } from '../nightly/index.js'
import type { MemoryFact, MemoryOp } from '../memory/index.js'

// ---------------------------------------------------------------------------
// makeFileRunLock
// ---------------------------------------------------------------------------

export interface FileRunLockDeps {
  lockPath: string
  readFile(path: string): string
  writeFile(path: string, content: string): void
  exists(path: string): boolean
  removeFile(path: string): void
  pid: number
  bootId: string
  startTime: number
  now(): number
  maxHeldMs?: number
}

/**
 * File-based RunLock.
 * acquire(): if the lockfile does not exist → write token JSON, return {ok:true, token}.
 *            if it exists → parse; if stale (now - acquiredAt > maxHeldMs) → overwrite and take over.
 *            if corrupt (parse error) → treat as stale, take over.
 *            if live → return {ok:false, heldBy, heldForMs}.
 * release(token): if the lockfile exists AND its nonce matches → remove; otherwise no-op.
 */
export function makeFileRunLock(deps: FileRunLockDeps): RunLock {
  const maxHeldMs = deps.maxHeldMs ?? 7_200_000

  const readToken = (): LockToken | null => {
    if (!deps.exists(deps.lockPath)) return null
    try {
      return JSON.parse(deps.readFile(deps.lockPath)) as LockToken
    } catch {
      // Corrupt lockfile — treat as absent (stale takeover)
      return null
    }
  }

  const writeToken = (token: LockToken): void => {
    deps.writeFile(deps.lockPath, JSON.stringify(token))
  }

  return {
    acquire(): { ok: true; token: LockToken } | { ok: false; heldBy: LockToken; heldForMs: number } {
      const nowMs = deps.now()

      if (!deps.exists(deps.lockPath)) {
        const token: LockToken = {
          pid: deps.pid,
          bootId: deps.bootId,
          startTime: deps.startTime,
          nonce: randomUUID(),
          acquiredAt: nowMs,
        }
        writeToken(token)
        return { ok: true, token }
      }

      const existing = readToken()
      const heldForMs = existing ? nowMs - existing.acquiredAt : maxHeldMs + 1

      // Stale or corrupt: take over
      if (existing === null || heldForMs > maxHeldMs) {
        const token: LockToken = {
          pid: deps.pid,
          bootId: deps.bootId,
          startTime: deps.startTime,
          nonce: randomUUID(),
          acquiredAt: nowMs,
        }
        writeToken(token)
        return { ok: true, token }
      }

      return { ok: false, heldBy: existing, heldForMs }
    },

    release(token: LockToken): void {
      if (!deps.exists(deps.lockPath)) return
      const stored = readToken()
      if (stored === null) return
      if (stored.nonce !== token.nonce) return
      deps.removeFile(deps.lockPath)
    },
  }
}

// ---------------------------------------------------------------------------
// makeMemoryValidators
// ---------------------------------------------------------------------------

export interface MemoryValidatorsDeps {
  liveFactIds: Set<string>
}

/**
 * Deterministic Validators for nightly consolidation.
 * - MemOp UPDATE/DELETE with an unknown factId → fails refs_exist
 * - MemOp ADD with empty text → fails (no_conflicts as the "content" validator)
 * - SkillDraft (no kind field) → passes always
 * - Otherwise → passes
 */
export function makeMemoryValidators(deps: MemoryValidatorsDeps): Validators {
  return {
    check(candidate: MemOp | import('../nightly/index.js').SkillDraft): ValidatorResult {
      // SkillDraft has no `kind` field; MemOp always has one.
      if (!('kind' in candidate)) {
        return { ok: true }
      }

      const op = candidate as MemOp

      if (op.kind === 'UPDATE' || op.kind === 'DELETE') {
        if (!deps.liveFactIds.has(op.factId)) {
          return { ok: false, failed: ['refs_exist'] }
        }
      }

      if (op.kind === 'ADD') {
        if (op.text.trim() === '') {
          return { ok: false, failed: ['no_conflicts'] }
        }
      }

      return { ok: true }
    },
  }
}

// ---------------------------------------------------------------------------
// liveFactsForNightly — MemoryFact[] → nightly Fact[]
// ---------------------------------------------------------------------------

/**
 * Bridge mapper: converts Memory's MemoryFact shape to the nightly Fact shape.
 * Memory's factKey is a string hash; nightly's FactKey is {entity, relation, object}.
 * We map id→entity, 'memory'→relation, factKey→object as a stable bridge convention.
 */
export function liveFactsForNightly(facts: MemoryFact[]): Fact[] {
  return facts.map((f): Fact => ({
    id: f.id,
    text: f.text,
    factKey: { entity: f.id, relation: 'memory', object: f.factKey },
    invalidAt: f.invalidAt,
    isHumanConfirmed: f.isHumanConfirmed,
  }))
}

// ---------------------------------------------------------------------------
// memOpToMemoryOp — nightly MemOp → memory MemoryOp | null
// ---------------------------------------------------------------------------

/**
 * Bridge mapper: converts a nightly MemOp to a Memory MemoryOp for promotion.
 * NOOP → null (no commit needed).
 * DELETE never carries is_human_confirmed (per spec comment on MemOp);
 * promotion always uses humanConfirmed: false — human taps Approve separately.
 */
export function memOpToMemoryOp(op: MemOp): MemoryOp | null {
  switch (op.kind) {
    case 'ADD':
      return { op: 'ADD', text: op.text }
    case 'UPDATE':
      return { op: 'UPDATE', targetId: op.factId, text: op.text }
    case 'DELETE':
      return { op: 'DELETE', targetId: op.factId, humanConfirmed: false, reason: op.reason }
    case 'NOOP':
      return null
  }
}
