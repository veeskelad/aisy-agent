import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SkillActivationPort } from './active-skill-store.js'
import {
  makeSkillPromotionRuntime,
  type SkillPromotionApproval,
  type SkillPromotionCandidateInput,
  type SkillPromotionGitPort,
} from './skill-promotion-runtime.js'
import { makeJsonSkillPromotionStore } from './skill-promotion-store.js'

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

function input(overrides: Partial<SkillPromotionCandidateInput> = {}): SkillPromotionCandidateInput {
  const bytes = Buffer.from(TEXT)
  const hash = createHash('sha256').update(bytes).digest('hex')
  return {
    stageId: 'stage-one', name: 'inspect', candidateVersion: 1,
    artifactHash: hash, artifactBase64: bytes.toString('base64'),
    triggerContext: { request: 'inspect', sessionId: 'session-one' },
    traceEvidence: {
      evidenceId: 'trace-one', skillName: 'inspect', artifactHash: hash, revision: 1,
      verifiedAt: '2026-07-28T00:00:00.000Z',
    },
    ...overrides,
  }
}

function memoryStore() {
  let content: string | undefined
  return makeJsonSkillPromotionStore({
    exists: () => content !== undefined,
    read: () => content ?? '',
    saveAtomic: value => { content = value },
  })
}

function activation(): SkillActivationPort & { activated: string[]; rolledBack: string[] } {
  const activated: string[] = []
  const rolledBack: string[] = []
  return {
    activated, rolledBack,
    current: () => null,
    prepare: () => 'prepared',
    activate: value => { activated.push(value.operationId) },
    rollback: value => { rolledBack.push(value); return true },
  }
}

function git(overrides: Partial<SkillPromotionGitPort> = {}): SkillPromotionGitPort & { commits: string[] } {
  const commits: string[] = []
  return {
    commits,
    commit: overrides.commit ?? (async value => { commits.push(value.idempotencyKey); return 'commit-one' }),
    inspect: overrides.inspect ?? (async () => ({ status: 'absent' as const })),
  }
}

function approval(stage: ReturnType<ReturnType<typeof memoryStore>['putPending']>): SkillPromotionApproval {
  return {
    stageId: stage.stageId, artifactHash: stage.artifactHash, actionHash: stage.actionHash,
    traceEvidenceId: stage.traceEvidence.evidenceId, nonce: 'nonce-one', stepUpSatisfied: true,
    humanTapAuditId: 'tap-one', approvedAt: '2026-07-28T00:01:00.000Z',
  }
}

function harness(options: {
  store?: ReturnType<typeof memoryStore>
  git?: SkillPromotionGitPort
  activation?: SkillActivationPort
  nonce?: (nonce: string, actionHash: string) => boolean
  trace?: () => Promise<boolean>
  risk?: 'reversible' | 'irreversible' | null
  authority?: { trustSource: 'builtin' | 'trusted-repo' | 'community' | 'user'; touchedPaths: string[] } | null
} = {}) {
  const store = options.store ?? memoryStore()
  const gitPort = options.git ?? git()
  const activationPort = options.activation ?? activation()
  const runtime = makeSkillPromotionRuntime({
    store, git: gitPort, activation: activationPort,
    nonces: { consume: options.nonce ?? (() => true) },
    trace: { verify: options.trace ?? (async () => true) },
    risk: { classify: value => options.risk === null ? null : ({
      proofId: 'risk-one', artifactHash: value.artifactHash,
      classification: options.risk ?? 'reversible', classifiedAt: '2026-07-28T00:00:00.000Z',
    }) },
    authority: { authorize: value => options.authority === null ? null : ({
      proofId: 'authority-one', skillName: value.name, artifactHash: value.artifactHash,
      trustSource: options.authority?.trustSource ?? 'user',
      touchedPaths: options.authority?.touchedPaths ?? [], authorizedAt: '2026-07-28T00:00:00.000Z',
    }) },
    claimId: () => 'claim-one',
    nowIso: () => '2026-07-28T00:02:00.000Z',
  })
  const staged = runtime.stage(input())
  if (!staged.ok) throw new Error(staged.reason)
  return { runtime, store, gitPort, activationPort, stage: staged.stage }
}

describe('offline skill promotion runtime', () => {
  it('rejects artifact bytes whose frontmatter identity does not match the pinned stage', () => {
    const store = memoryStore()
    const runtime = makeSkillPromotionRuntime({
      store, git: git(), activation: activation(), nonces: { consume: () => true },
      trace: { verify: async () => true },
      risk: { classify: () => null }, authority: { authorize: () => null },
    })
    const wrongText = TEXT.replace('name: inspect', 'name: other')
    const bytes = Buffer.from(wrongText)
    const staged = runtime.stage(input({
      artifactHash: createHash('sha256').update(bytes).digest('hex'),
      artifactBase64: bytes.toString('base64'),
    }))
    expect(staged).toEqual({ ok: false, reason: 'invalid_stage' })
    expect(store.snapshot().stages).toEqual([])
  })

  it.each(['trusted', 'approved', 'is_human_confirmed', 'is-human-confirmed', 'permanence'])(
    'rejects prohibited or unknown authority frontmatter bytes: %s',
    field => {
      const h = harness()
      const text = TEXT.replace('version: 1', `version: 1\n${field}: true`)
      const bytes = Buffer.from(text)
      const artifactHash = createHash('sha256').update(bytes).digest('hex')
      expect(h.runtime.stage(input({
        stageId: `stage-${field.replaceAll('_', '-')}`,
        artifactHash,
        artifactBase64: bytes.toString('base64'),
        traceEvidence: { ...input().traceEvidence, artifactHash },
      }))).toEqual({ ok: false, reason: 'invalid_stage' })
    },
  )

  it('rejects an empty or whitespace-only trigger from the exact candidate bytes', () => {
    const h = harness()
    const text = TEXT.replace('  - inspect', '  -   ')
    const bytes = Buffer.from(text)
    const artifactHash = createHash('sha256').update(bytes).digest('hex')
    expect(h.runtime.stage(input({
      stageId: 'stage-empty-trigger', artifactHash, artifactBase64: bytes.toString('base64'),
      traceEvidence: { ...input().traceEvidence, artifactHash },
    }))).toEqual({ ok: false, reason: 'invalid_stage' })
  })

  it('fails closed when code-owned risk or authority proof is unavailable', () => {
    const noRisk = memoryStore()
    expect(() => harness({ store: noRisk, risk: null })).toThrow('invalid_stage')
    expect(noRisk.snapshot().stages).toEqual([])
    const noAuthority = memoryStore()
    expect(() => harness({ store: noAuthority, authority: null })).toThrow('invalid_stage')
    expect(noAuthority.snapshot().stages).toEqual([])
  })

  it('binds code-owned trust and touched-path authority into distinct action hashes', () => {
    const user = harness({ authority: { trustSource: 'user', touchedPaths: [] } }).stage
    const repository = harness({
      authority: { trustSource: 'trusted-repo', touchedPaths: ['skills/inspect/SKILL.md'] },
    }).stage
    expect(user.actionHash).not.toBe(repository.actionHash)
  })

  it('promotes an exact pinned stage and durably binds tap→action→commit', async () => {
    const h = harness()
    expect(await h.runtime.promote(h.stage.stageId, approval(h.stage))).toEqual({
      ok: true, commit: 'commit-one', version: 1,
    })
    expect(h.store.snapshot()).toMatchObject({
      stages: [{ state: 'promoted', externalCommit: { commit: 'commit-one' } }],
      audits: [{
        stageId: 'stage-one', actionHash: h.stage.actionHash, artifactHash: h.stage.artifactHash,
        commit: 'commit-one', humanTapAuditId: 'tap-one', version: 1,
        approvedAt: '2026-07-28T00:01:00.000Z',
      }],
    })
  })

  it.each([
    ['stage id', (a: SkillPromotionApproval) => ({ ...a, stageId: 'stage-other' }), 'approval_mismatch'],
    ['action hash', (a: SkillPromotionApproval) => ({ ...a, actionHash: '0'.repeat(64) }), 'approval_mismatch'],
    ['artifact hash', (a: SkillPromotionApproval) => ({ ...a, artifactHash: '0'.repeat(64) }), 'hash_mismatch'],
    ['trace evidence', (a: SkillPromotionApproval) => ({ ...a, traceEvidenceId: 'trace-old' }), 'trace_evidence_mismatch'],
  ] as const)('rejects mismatched %s before nonce or git', async (_label, mutate, reason) => {
    let nonceCalls = 0
    const gitPort = git()
    const h = harness({ git: gitPort, nonce: () => { nonceCalls += 1; return true } })
    expect(await h.runtime.promote(h.stage.stageId, mutate(approval(h.stage)))).toEqual({ ok: false, reason })
    expect(nonceCalls).toBe(0)
    expect(gitPort.commits).toHaveLength(0)
  })

  it('checks step-up before claiming an irreversible stage', async () => {
    const h = harness({ risk: 'irreversible' })
    expect(await h.runtime.promote(h.stage.stageId, { ...approval(h.stage), stepUpSatisfied: false }))
      .toEqual({ ok: false, reason: 'stepup_missing' })
    expect(h.store.snapshot().stages[0]?.state).toBe('pending')
  })

  it('does not let caller bytes downgrade code-classified irreversible risk', async () => {
    const text = TEXT.replace('Record evidence.', 'Perform the classified operation, then record evidence.')
    const bytes = Buffer.from(text)
    const artifactHash = createHash('sha256').update(bytes).digest('hex')
    const h = harness({ risk: 'irreversible' })
    const staged = h.runtime.stage(input({
      stageId: 'stage-destructive', artifactHash, artifactBase64: bytes.toString('base64'),
      traceEvidence: { ...input().traceEvidence, evidenceId: 'trace-destructive', artifactHash },
    }))
    if (!staged.ok) throw new Error(staged.reason)
    expect(await h.runtime.promote(staged.stage.stageId, {
      ...approval(staged.stage), nonce: 'nonce-destructive', stepUpSatisfied: false,
    })).toEqual({ ok: false, reason: 'stepup_missing' })
  })

  it('rejects an undeclared caller risk flag before persistence', () => {
    const h = harness({ risk: 'irreversible' })
    expect(h.runtime.stage({
      ...input({ stageId: 'stage-caller-risk' }),
      irreversible: false,
    } as SkillPromotionCandidateInput)).toEqual({ ok: false, reason: 'invalid_stage' })
    expect(h.store.snapshot().stages).toHaveLength(1)
  })

  it('quarantines a stale base revision before git publication', async () => {
    const gitPort = git()
    const staleActivation = { ...activation(), prepare: () => 'revision_conflict' as const }
    const h = harness({ git: gitPort, activation: staleActivation })
    expect(await h.runtime.promote(h.stage.stageId, approval(h.stage)))
      .toEqual({ ok: false, reason: 'revision_conflict' })
    expect(gitPort.commits).toHaveLength(0)
    expect(h.store.snapshot().stages[0]).toMatchObject({
      state: 'quarantined', quarantineReason: 'revision-conflict',
    })
  })

  it('requires the injected trace authority to verify the exact pinned evidence', async () => {
    let nonceCalls = 0
    const h = harness({ trace: async () => false, nonce: () => { nonceCalls += 1; return true } })
    expect(await h.runtime.promote(h.stage.stageId, approval(h.stage)))
      .toEqual({ ok: false, reason: 'not_trace_verified' })
    expect(nonceCalls).toBe(0)
    expect(h.store.snapshot().stages[0]?.state).toBe('pending')
  })

  it('releases a claim when git proves the failed commit is absent', async () => {
    const h = harness({ git: git({
      commit: async () => { throw new Error('offline') },
      inspect: async () => ({ status: 'absent' }),
    }) })
    expect(await h.runtime.promote(h.stage.stageId, approval(h.stage))).toEqual({ ok: false, reason: 'commit_failed' })
    expect(h.store.snapshot().stages[0]?.state).toBe('pending')
  })

  it('quarantines an ambiguous external commit instead of guessing', async () => {
    const active = activation()
    const h = harness({ activation: active, git: git({
      commit: async () => { throw new Error('timeout') },
      inspect: async () => ({ status: 'unknown' }),
    }) })
    expect(await h.runtime.promote(h.stage.stageId, approval(h.stage))).toEqual({ ok: false, reason: 'quarantined' })
    expect(h.store.snapshot().stages[0]).toMatchObject({
      state: 'quarantined', quarantineReason: 'ambiguous-external-commit',
    })
    expect(active.rolledBack).toEqual([h.stage.actionHash])
  })

  it('quarantines an invalid commit receipt and releases only its own reservation', async () => {
    const active = activation()
    const h = harness({ activation: active, git: git({ commit: async () => 'invalid commit value' }) })
    expect(await h.runtime.promote(h.stage.stageId, approval(h.stage)))
      .toEqual({ ok: false, reason: 'quarantined' })
    expect(active.rolledBack).toEqual([h.stage.actionHash])
    expect(h.store.snapshot().stages[0]).toMatchObject({
      state: 'quarantined', quarantineReason: 'invalid-external-commit', externalCommit: null,
    })
  })

  it('does not quarantine or touch a foreign reservation it cannot release', async () => {
    const active = activation()
    active.rollback = () => false
    const h = harness({ activation: active, git: git({
      commit: async () => { throw new Error('timeout') },
      inspect: async () => ({ status: 'unknown' }),
    }) })
    expect(await h.runtime.promote(h.stage.stageId, approval(h.stage)))
      .toEqual({ ok: false, reason: 'recovery_required' })
    expect(h.store.snapshot().stages[0]).toMatchObject({ state: 'committing', quarantineReason: null })
  })

  it('allows at most one concurrent promote for the same stage', async () => {
    let commits = 0
    const h = harness({ git: git({ commit: async () => { commits += 1; await Promise.resolve(); return 'commit-one' } }) })
    const [left, right] = await Promise.all([
      h.runtime.promote(h.stage.stageId, approval(h.stage)),
      h.runtime.promote(h.stage.stageId, { ...approval(h.stage), nonce: 'nonce-two' }),
    ])
    expect([left, right].filter(result => result.ok)).toHaveLength(1)
    expect(commits).toBe(1)
  })

  it('recovers audit finalization forward after git success without rollback or duplicate commit', async () => {
    const base = memoryStore()
    let failAudit = true
    const failing = { ...base, markPromoted: (...args: Parameters<typeof base.markPromoted>) => {
      if (failAudit) throw new Error('disk full')
      return base.markPromoted(...args)
    } }
    const active = activation()
    const gitPort = git()
    const h = harness({ store: failing, activation: active, git: gitPort })
    expect(await h.runtime.promote(h.stage.stageId, approval(h.stage))).toEqual({ ok: false, reason: 'audit_failed' })
    expect(active.rolledBack).toEqual([])
    expect(base.snapshot().stages[0]).toMatchObject({ state: 'committing', externalCommit: { commit: 'commit-one' } })
    failAudit = false
    expect(await h.runtime.recover()).toEqual([{ ok: true, commit: 'commit-one', version: 1, recovered: true }])
    expect(gitPort.commits).toHaveLength(1)
  })
})
