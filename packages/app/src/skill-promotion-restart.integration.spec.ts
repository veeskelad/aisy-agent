import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeActiveSkillCatalog } from '@aisy/core'
import { makeNodeActiveSkillPersistence } from './active-skill-store.js'
import {
  makeSkillPromotionRuntime,
  type SkillPromotionCandidateInput,
  type SkillPromotionGitPort,
} from './skill-promotion-runtime.js'
import { makeNodeSkillPromotionStore } from './skill-promotion-store.js'

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

function stageInput(): SkillPromotionCandidateInput {
  const bytes = Buffer.from(TEXT)
  const hash = createHash('sha256').update(bytes).digest('hex')
  return {
    stageId: 'stage-restart', name: 'inspect', candidateVersion: 1,
    artifactHash: hash, artifactBase64: bytes.toString('base64'),
    triggerContext: { request: 'inspect', sessionId: 'session-restart' },
    traceEvidence: {
      evidenceId: 'trace-restart', skillName: 'inspect', artifactHash: hash, revision: 1,
      verifiedAt: '2026-07-28T00:00:00.000Z',
    },
  }
}

function proofs() {
  return {
    risk: { classify: (value: { artifactHash: string }) => ({
      proofId: 'risk-restart', artifactHash: value.artifactHash, classification: 'reversible' as const,
      classifiedAt: '2026-07-28T00:00:00.000Z',
    }) },
    authority: { authorize: (value: { name: string; artifactHash: string }) => ({
      proofId: 'authority-restart', skillName: value.name, artifactHash: value.artifactHash,
      trustSource: 'user' as const, touchedPaths: [], authorizedAt: '2026-07-28T00:00:00.000Z',
    }) },
    nowIso: () => '2026-07-28T00:02:00.000Z',
  }
}

function approval(stage: ReturnType<ReturnType<typeof makeNodeSkillPromotionStore>['putPending']>) {
  return {
    stageId: stage.stageId, artifactHash: stage.artifactHash, actionHash: stage.actionHash,
    traceEvidenceId: stage.traceEvidence.evidenceId, nonce: 'nonce-restart', stepUpSatisfied: true,
    humanTapAuditId: 'tap-restart', approvedAt: '2026-07-28T00:01:00.000Z',
  }
}

describe('skill promotion restart recovery', () => {
  it('converges an externally committed promotion after a crash at the activation boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-skill-restart-'))
    roots.push(root)
    const promotionPath = join(root, 'private', 'promotion.json')
    const commits = new Map<string, string>()
    let commitCalls = 0
    let inspectCalls = 0
    const git: SkillPromotionGitPort = {
      async commit(value) { commitCalls += 1; commits.set(value.idempotencyKey, 'commit-restart'); return 'commit-restart' },
      async inspect(key) {
        inspectCalls += 1
        const commit = commits.get(key)
        return commit ? { status: 'committed', commit } : { status: 'absent' }
      },
    }
    const firstStore = makeNodeSkillPromotionStore({ path: promotionPath })
    const crashingActive = makeNodeActiveSkillPersistence({
      root,
      onActivationPhase: phase => { if (phase === 'manifest-written') throw new Error('crash') },
    })
    const first = makeSkillPromotionRuntime({
      store: firstStore, git, activation: crashingActive,
      nonces: { consume: () => true }, trace: { verify: async () => true }, claimId: () => 'claim-restart',
      ...proofs(),
    })
    const staged = first.stage(stageInput())
    if (!staged.ok) throw new Error(staged.reason)
    expect(await first.promote(staged.stage.stageId, approval(staged.stage)))
      .toEqual({ ok: false, reason: 'recovery_required' })
    expect(firstStore.snapshot().stages[0]?.state).toBe('committing')

    const restartedActive = makeNodeActiveSkillPersistence({ root })
    const restartedStore = makeNodeSkillPromotionStore({ path: promotionPath })
    const restarted = makeSkillPromotionRuntime({
      store: restartedStore, git, activation: restartedActive,
      nonces: { consume: () => false }, trace: { verify: async () => true }, claimId: () => 'unused',
      ...proofs(),
    })
    expect(await restarted.recover()).toEqual([{
      ok: true, commit: 'commit-restart', version: 1, recovered: true,
    }])
    expect(restartedStore.snapshot()).toMatchObject({
      stages: [{ state: 'promoted', externalCommit: { commit: 'commit-restart' } }],
      audits: [{ humanTapAuditId: 'tap-restart', commit: 'commit-restart' }],
    })
    expect(makeActiveSkillCatalog(restartedActive).names()).toEqual(['inspect'])
    expect(commitCalls).toBe(1)
    expect(inspectCalls).toBe(0)
  })

  it('detects a user edit after staging before git and never overwrites it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-skill-stale-base-'))
    roots.push(root)
    const store = makeNodeSkillPromotionStore({ path: join(root, 'private', 'promotion.json') })
    let commitCalls = 0
    const runtime = makeSkillPromotionRuntime({
      store,
      git: {
        commit: async () => { commitCalls += 1; return 'must-not-commit' },
        inspect: async () => ({ status: 'absent' }),
      },
      activation: makeNodeActiveSkillPersistence({ root }),
      nonces: { consume: () => true }, trace: { verify: async () => true }, claimId: () => 'claim-stale',
      ...proofs(),
    })
    const staged = runtime.stage(stageInput())
    if (!staged.ok) throw new Error(staged.reason)
    const target = join(root, 'skills', 'inspect', 'SKILL.md')
    mkdirSync(join(root, 'skills', 'inspect'), { recursive: true })
    writeFileSync(target, 'user-owned edit')

    expect(await runtime.promote(staged.stage.stageId, approval(staged.stage)))
      .toEqual({ ok: false, reason: 'revision_conflict' })
    expect(commitCalls).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('user-owned edit')
    expect(store.snapshot().stages[0]).toMatchObject({ state: 'quarantined', quarantineReason: 'revision-conflict' })
  })

  it('persists ambiguity quarantine across restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-skill-ambiguous-'))
    roots.push(root)
    const promotionPath = join(root, 'private', 'promotion.json')
    const store = makeNodeSkillPromotionStore({ path: promotionPath })
    const active = makeNodeActiveSkillPersistence({ root })
    const runtime = makeSkillPromotionRuntime({
      store,
      git: {
        commit: async () => { throw new Error('timeout') },
        inspect: async () => ({ status: 'unknown' }),
      },
      activation: active,
      nonces: { consume: () => true }, trace: { verify: async () => true }, claimId: () => 'claim-ambiguous',
      ...proofs(),
    })
    const staged = runtime.stage(stageInput())
    if (!staged.ok) throw new Error(staged.reason)
    expect(await runtime.promote(staged.stage.stageId, approval(staged.stage)))
      .toEqual({ ok: false, reason: 'quarantined' })

    expect(makeNodeSkillPromotionStore({ path: promotionPath }).snapshot().stages[0]).toMatchObject({
      state: 'quarantined', quarantineReason: 'ambiguous-external-commit',
    })
    const candidate = stageInput()
    expect(active.prepare({
      operationId: 'independent-activation', name: candidate.name, version: candidate.candidateVersion,
      sha256: candidate.artifactHash, trustSource: 'user', touchedPaths: [],
      skillText: Buffer.from(candidate.artifactBase64, 'base64').toString('utf8'),
      baseVersion: null, baseHash: null,
    })).toBe('prepared')
  })
})
