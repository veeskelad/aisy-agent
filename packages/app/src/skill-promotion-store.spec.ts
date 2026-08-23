import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  computePromotionActionHash,
  inspectNodeSkillPromotionStore,
  makeJsonSkillPromotionStore,
  makeNodeSkillPromotionStore,
  SkillPromotionStoreError,
  type JsonSkillPromotionStoreDeps,
  type SkillPromotionStageInput,
} from './skill-promotion-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const TEXT = `---
name: inspect
description: Inspect safely
version: 1
provenance: agent-authored
triggers:
  - inspect
---
## verification
Record evidence.`

function stage(): SkillPromotionStageInput {
  const bytes = Buffer.from(TEXT, 'utf8')
  const artifactHash = createHash('sha256').update(bytes).digest('hex')
  const computedDiff = `--- base\n+++ candidate\n${TEXT.split('\n').map(line => `+${line}`).join('\n')}`
  return {
    stageId: 'stage-one', name: 'inspect', baseVersion: null, baseArtifactHash: null,
    candidateVersion: 1, candidateProvenance: 'agent-authored',
    artifactHash, artifactBase64: bytes.toString('base64'), computedDiff,
    computedDiffHash: createHash('sha256').update(computedDiff).digest('hex'),
    triggerContext: { request: 'inspect it', sessionId: 'session-one' },
    traceEvidence: {
      evidenceId: 'trace-one', skillName: 'inspect', artifactHash, revision: 1,
      verifiedAt: '2026-07-28T00:00:00.000Z',
    },
    riskProof: {
      proofId: 'risk-one', artifactHash, classification: 'reversible',
      classifiedAt: '2026-07-28T00:00:00.000Z',
    },
    authorityProof: {
      proofId: 'authority-one', skillName: 'inspect', artifactHash, trustSource: 'user', touchedPaths: [],
      authorizedAt: '2026-07-28T00:00:00.000Z',
    },
  }
}

function memoryStore(initial?: string): { deps: JsonSkillPromotionStoreDeps; read: () => string | undefined } {
  let content = initial
  return {
    deps: {
      exists: () => content !== undefined,
      read: () => content ?? '',
      saveAtomic: value => { content = value },
    },
    read: () => content,
  }
}

describe('skill promotion store', () => {
  it('pins canonical action identity and persists pending state across restart', () => {
    const fs = memoryStore()
    const first = makeJsonSkillPromotionStore(fs.deps)
    const record = first.putPending(stage())
    expect(record.actionHash).toBe(computePromotionActionHash(record))
    expect(record.state).toBe('pending')

    const restarted = makeJsonSkillPromotionStore(memoryStore(fs.read()).deps)
    expect(restarted.snapshot().stages).toEqual([record])
  })

  it('binds base, diff, trace, risk and path authority into the action hash', () => {
    const value = stage()
    const baseline = computePromotionActionHash(value)
    const variants = [
      { ...value, baseVersion: 1, baseArtifactHash: '1'.repeat(64), candidateVersion: 2 },
      { ...value, computedDiffHash: '2'.repeat(64) },
      { ...value, traceEvidence: { ...value.traceEvidence, evidenceId: 'trace-two' } },
      { ...value, candidateProvenance: 'human' as const },
      { ...value, riskProof: { ...value.riskProof, classification: 'irreversible' as const } },
      { ...value, authorityProof: { ...value.authorityProof, touchedPaths: ['skills/inspect/SKILL.md'] } },
    ]
    expect(new Set([baseline, ...variants.map(computePromotionActionHash)]).size).toBe(variants.length + 1)
  })

  it('rejects a half-null base revision identity', () => {
    const store = makeJsonSkillPromotionStore(memoryStore().deps)
    expect(() => store.putPending({ ...stage(), baseVersion: 1, baseArtifactHash: null, candidateVersion: 2 }))
      .toThrowError(new SkillPromotionStoreError('INVALID_SKILL_STAGE'))
  })

  it('persists pending→committing→promoted with the exact tap audit atomically', () => {
    const fs = memoryStore()
    const store = makeJsonSkillPromotionStore(fs.deps)
    const pending = store.putPending(stage())
    const claim = {
      claimId: 'claim-one', actionHash: pending.actionHash, humanTapAuditId: 'tap-one',
      approvedAt: '2026-07-28T00:01:00.000Z', stepUpSatisfied: true,
    }
    expect(store.claim(pending.stageId, claim)).toBe(true)
    expect(store.recordExternalCommit(pending.stageId, claim.claimId, {
      idempotencyKey: pending.actionHash, commit: 'commit-one', recordedAt: '2026-07-28T00:02:00.000Z',
    })).toBe(true)
    expect(store.markPromoted(pending.stageId, claim.claimId, 'commit-one')).toBe(true)

    const restarted = makeJsonSkillPromotionStore(memoryStore(fs.read()).deps).snapshot()
    expect(restarted.stages[0]).toMatchObject({
      state: 'promoted', externalCommit: { commit: 'commit-one', idempotencyKey: pending.actionHash }, claim,
    })
    expect(restarted.audits).toEqual([{
      stageId: pending.stageId, actionHash: pending.actionHash, artifactHash: pending.artifactHash,
      version: 1, commit: 'commit-one', humanTapAuditId: 'tap-one',
      approvedAt: '2026-07-28T00:01:00.000Z',
    }])
  })

  it('supports recoverable release, explicit rollback and quarantine without deleting artifacts', () => {
    const store = makeJsonSkillPromotionStore(memoryStore().deps)
    const pending = store.putPending(stage())
    const claim = {
      claimId: 'claim-one', actionHash: pending.actionHash, humanTapAuditId: 'tap-one',
      approvedAt: '2026-07-28T00:01:00.000Z', stepUpSatisfied: true,
    }
    expect(store.claim(pending.stageId, claim)).toBe(true)
    expect(store.release(pending.stageId, claim.claimId)).toBe(true)
    expect(store.claim(pending.stageId, { ...claim, claimId: 'claim-two' })).toBe(true)
    expect(store.rollback(pending.stageId, 'claim-two', 'activation-failed')).toBe(true)
    expect(store.snapshot().stages[0]).toMatchObject({
      state: 'rolled_back', quarantineReason: 'activation-failed', artifactBase64: pending.artifactBase64,
    })
  })

  it('never releases or rolls back after an external commit receipt is durable', () => {
    const store = makeJsonSkillPromotionStore(memoryStore().deps)
    const pending = store.putPending(stage())
    const claim = {
      claimId: 'claim-one', actionHash: pending.actionHash, humanTapAuditId: 'tap-one',
      approvedAt: '2026-07-28T00:01:00.000Z', stepUpSatisfied: true,
    }
    expect(store.claim(pending.stageId, claim)).toBe(true)
    expect(store.recordExternalCommit(pending.stageId, claim.claimId, {
      idempotencyKey: pending.actionHash, commit: 'commit-one', recordedAt: '2026-07-28T00:02:00.000Z',
    })).toBe(true)
    expect(store.release(pending.stageId, claim.claimId)).toBe(false)
    expect(store.rollback(pending.stageId, claim.claimId, 'must-not-rewind')).toBe(false)
    expect(store.snapshot().stages[0]).toMatchObject({ state: 'committing', externalCommit: { commit: 'commit-one' } })
  })

  it('rejects a persisted audit whose approval time differs from the exact claim', () => {
    const fs = memoryStore()
    const store = makeJsonSkillPromotionStore(fs.deps)
    const pending = store.putPending(stage())
    const claim = {
      claimId: 'claim-one', actionHash: pending.actionHash, humanTapAuditId: 'tap-one',
      approvedAt: '2026-07-28T00:01:00.000Z', stepUpSatisfied: true,
    }
    store.claim(pending.stageId, claim)
    store.recordExternalCommit(pending.stageId, claim.claimId, {
      idempotencyKey: pending.actionHash, commit: 'commit-one', recordedAt: '2026-07-28T00:02:00.000Z',
    })
    store.markPromoted(pending.stageId, claim.claimId, 'commit-one')
    const parsed = JSON.parse(fs.read()!)
    parsed.audits[0].approvedAt = '2026-07-28T00:03:00.000Z'
    expect(() => makeJsonSkillPromotionStore(memoryStore(JSON.stringify(parsed)).deps)).toThrowError(
      new SkillPromotionStoreError('CORRUPT_SKILL_PROMOTION_STORE'),
    )
  })

  it('fails closed on tampered persisted artifact bytes', () => {
    const fs = memoryStore()
    makeJsonSkillPromotionStore(fs.deps).putPending(stage())
    const parsed = JSON.parse(fs.read()!)
    parsed.stages[0].artifactBase64 = Buffer.from(TEXT + 'tampered').toString('base64')
    expect(() => makeJsonSkillPromotionStore(memoryStore(JSON.stringify(parsed)).deps)).toThrowError(
      new SkillPromotionStoreError('CORRUPT_SKILL_PROMOTION_STORE'),
    )
  })

  it('rejects unknown persisted authority fields instead of silently dropping them', () => {
    const fs = memoryStore()
    makeJsonSkillPromotionStore(fs.deps).putPending(stage())
    const parsed = JSON.parse(fs.read()!)
    parsed.stages[0].approved = true
    expect(() => makeJsonSkillPromotionStore(memoryStore(JSON.stringify(parsed)).deps)).toThrowError(
      new SkillPromotionStoreError('CORRUPT_SKILL_PROMOTION_STORE'),
    )
  })

  it('uses a private atomic Node file and exposes a read-only inspection', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-skill-promotion-'))
    roots.push(root)
    const path = join(root, 'private', 'promotion.json')
    const store = makeNodeSkillPromotionStore({ path })
    store.putPending(stage())

    expect(statSync(join(root, 'private')).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(inspectNodeSkillPromotionStore(path)).toEqual({
      status: 'ready', pending: 1, committing: 0, promoted: 0, quarantined: 0,
    })
    expect(JSON.parse(readFileSync(path, 'utf8')).stages).toHaveLength(1)
  })
})
