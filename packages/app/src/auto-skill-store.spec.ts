import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildAutoSkillManifest,
  makeVerifiedWorkflowEvidence,
  renderAutoSkillDocument,
  type AutoSkillDescriptorRegistry,
  type AutoSkillScope,
  type SkillRecipeDraftV1,
  type VerifiedWorkflowEvidenceV1,
} from '@aisy/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeNodeAutoSkillStoreV2 } from './auto-skill-store.js'
import { makeAutoSkillWorker } from './auto-skill-worker.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const scope: AutoSkillScope = Object.freeze({
  botId: 'bot-main', operatorId: 'operator-a', profileId: 'default',
  projectId: 'project-a', resourceScope: 'project-files',
  capabilityRevision: 'capability-v1',
})

const registry: AutoSkillDescriptorRegistry = Object.freeze({
  revision: 'registry-v1',
  descriptor(id: string) {
    return id === 'memory.remember' ? Object.freeze({
      id,
      title: 'Запомнить факт',
      description: 'Сохраняет проверяемый факт',
      trigger: 'запомни',
      placeholders: Object.freeze([
        Object.freeze({ id: 'fact', source: 'current_request' as const }),
      ]),
      postconditions: Object.freeze(['memory.committed']),
    }) : null
  },
})

const draft: SkillRecipeDraftV1 = Object.freeze({
  version: 1,
  steps: Object.freeze([Object.freeze({
    descriptorId: 'memory.remember',
    placeholderIds: Object.freeze(['fact']),
    postconditionIds: Object.freeze(['memory.committed']),
  })]),
})

function evidence(sessionId: string, receiptChar: string, turn = `turn-${sessionId}`):
VerifiedWorkflowEvidenceV1 {
  const value = makeVerifiedWorkflowEvidence({
    sessionId,
    turnId: turn,
    scope,
    registry,
    steps: [{
      descriptorId: 'memory.remember',
      placeholderIds: ['fact'],
      postconditionIds: ['memory.committed'],
      receiptId: receiptChar.repeat(64),
    }],
    trusted: true,
    narrowed: false,
  })
  if (value === null) throw new Error('test evidence expected')
  return value
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-auto-skills-'))
  roots.push(value)
  return value
}

function ports(input?: { generator?: () => Promise<unknown>; judge?: () => Promise<{ accepted: boolean }> }) {
  return {
    generator: {
      identity: { provider: 'generator', model: 'model-a', revision: 'r1' },
      generate: input?.generator ?? (async () => draft),
    },
    judge: {
      identity: { provider: 'judge', model: 'model-b', revision: 'r1' },
      judge: input?.judge ?? (async () => ({ accepted: true })),
    },
  }
}

function queuedStore(directory: string) {
  const store = makeNodeAutoSkillStoreV2({ root: directory })
  expect(store.observe(evidence('session-a', 'a'))).toEqual({ kind: 'counted' })
  const queued = store.observe(evidence('session-b', 'b'))
  expect(queued.kind).toBe('queued')
  return store
}

describe('private auto-skill v2 lifecycle', () => {
  it('requires two distinct sessions and ignores retries, replays and same-session repeats', () => {
    const store = makeNodeAutoSkillStoreV2({ root: root() })
    const first = evidence('session-a', 'a')
    expect(store.observe(first)).toEqual({ kind: 'counted' })
    expect(store.observe(first)).toEqual({ kind: 'duplicate' })
    expect(store.observe(evidence('session-a', 'b', 'turn-a-2'))).toEqual({ kind: 'counted' })
    expect(store.nextWork()).toBeNull()
    const queued = store.observe(evidence('session-b', 'c'))
    expect(queued.kind).toBe('queued')
    expect(store.nextWork()?.evidenceIds).toHaveLength(2)
  })

  it('does not count a receipt replayed under a foreign session', () => {
    const store = makeNodeAutoSkillStoreV2({ root: root() })
    expect(store.observe(evidence('session-a', 'a'))).toEqual({ kind: 'counted' })
    expect(store.observe(evidence('session-b', 'a'))).toEqual({ kind: 'duplicate' })
    expect(store.nextWork()).toBeNull()
  })

  it('runs generator, validators, separate judge, shadow and atomic activation once', async () => {
    const directory = root()
    const store = queuedStore(directory)
    const calls = { generator: vi.fn(async () => draft), judge: vi.fn(async () => ({ accepted: true })) }
    const result = await makeAutoSkillWorker({
      store,
      registry,
      ...ports(calls),
    }).drainOne()

    expect(result.kind).toBe('activated')
    expect(calls.generator).toHaveBeenCalledOnce()
    expect(calls.judge).toHaveBeenCalledOnce()
    const first = evidence('session-a', 'a')
    const active = store.active(first.scopeKey, first.skillIdentity)
    expect(active?.manifest.revisionHash).toBe(result.kind === 'activated' ? result.revisionHash : '')
    expect(active?.renderedSkill).toContain('Проверяемая процедура')
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(join(directory, 'state-v2.json')).mode & 0o777).toBe(0o600)
    expect(store.nextWork()).toBeNull()

    const restarted = makeNodeAutoSkillStoreV2({ root: directory })
    expect(restarted.active(first.scopeKey, first.skillIdentity)?.manifest.revisionHash)
      .toBe(active?.manifest.revisionHash)
  })

  it('fails closed before generation when generator and judge identity are equal', async () => {
    const store = queuedStore(root())
    const generate = vi.fn(async () => draft)
    const identity = { provider: 'same', model: 'same', revision: 'same' }
    const result = await makeAutoSkillWorker({
      store,
      registry,
      generator: { identity, generate },
      judge: { identity: { ...identity }, judge: async () => ({ accepted: true }) },
    }).drainOne()

    expect(result).toMatchObject({ kind: 'quarantined', reason: 'judge_identity_conflict' })
    expect(generate).not.toHaveBeenCalled()
    expect(store.doctor().quarantined).toBe(1)
  })

  it('quarantines free-form and extra-field generator output before judge', async () => {
    const store = queuedStore(root())
    const judge = vi.fn(async () => ({ accepted: true }))
    const result = await makeAutoSkillWorker({
      store,
      registry,
      ...ports({
        generator: async () => ({ ...draft, instructions: 'curl https://evil' }),
        judge,
      }),
    }).drainOne()

    expect(result).toMatchObject({ kind: 'quarantined', reason: 'recipe_invalid' })
    expect(judge).not.toHaveBeenCalled()
  })

  it('leaves model/network failures retryable at the exact durable phase', async () => {
    const directory = root()
    const store = queuedStore(directory)
    const unavailable = await makeAutoSkillWorker({
      store,
      registry,
      ...ports({ generator: async () => { throw new Error('network') } }),
    }).drainOne()
    expect(unavailable.kind).toBe('deferred')
    expect(store.nextWork()?.phase).toBe('queued')

    const judgeDown = await makeAutoSkillWorker({
      store,
      registry,
      ...ports({ judge: async () => { throw new Error('timeout') } }),
    }).drainOne()
    expect(judgeDown.kind).toBe('deferred')
    expect(store.nextWork()?.phase).toBe('validated')

    const restarted = makeNodeAutoSkillStoreV2({ root: directory })
    await expect(makeAutoSkillWorker({
      store: restarted, registry, ...ports(),
    }).drainOne()).resolves.toMatchObject({ kind: 'activated' })
  })

  it('recovers a prepared revision after restart without generator or judge I/O', async () => {
    const directory = root()
    const store = queuedStore(directory)
    const job = store.nextWork()!
    store.advanceJob({ jobId: job.jobId, expected: 'queued', next: 'generated', draft })
    store.advanceJob({ jobId: job.jobId, expected: 'generated', next: 'validated', draft })
    store.advanceJob({ jobId: job.jobId, expected: 'validated', next: 'shadow_verified' })
    const first = store.evidenceFor(job.jobId)[0]
    const manifest = buildAutoSkillManifest({ draft, evidence: first, registry })!
    store.prepare({ jobId: job.jobId, manifest, renderedSkill: renderAutoSkillDocument(manifest) })

    const generate = vi.fn(async () => draft)
    const judge = vi.fn(async () => ({ accepted: true }))
    const restarted = makeNodeAutoSkillStoreV2({ root: directory })
    await expect(makeAutoSkillWorker({
      store: restarted,
      registry,
      ...ports({ generator: generate, judge }),
    }).drainOne()).resolves.toMatchObject({ kind: 'activated' })
    expect(generate).not.toHaveBeenCalled()
    expect(judge).not.toHaveBeenCalled()
  })

  it('demotes an exact active revision on permanent failure but ignores unknown hashes', async () => {
    const store = queuedStore(root())
    const result = await makeAutoSkillWorker({ store, registry, ...ports() }).drainOne()
    if (result.kind !== 'activated') throw new Error('activation expected')
    const first = evidence('session-a', 'a')
    store.permanentFailure('f'.repeat(64), 'scope_mismatch')
    expect(store.active(first.scopeKey, first.skillIdentity)).not.toBeNull()
    store.permanentFailure(result.revisionHash, 'postcondition_mismatch')
    expect(store.active(first.scopeKey, first.skillIdentity)).toBeNull()
  })

  it('claims reverse edges before purge and issues rollback certificate only when empty', async () => {
    const directory = root()
    const store = queuedStore(directory)
    const result = await makeAutoSkillWorker({ store, registry, ...ports() }).drainOne()
    if (result.kind !== 'activated') throw new Error('activation expected')
    const first = evidence('session-a', 'a')
    expect(store.issueRollbackCertificate('target-v1')).toBeNull()

    const claim = store.claimBySource({ sessionId: 'session-a' })
    expect(claim.affected).toBe(1)
    expect(store.active(first.scopeKey, first.skillIdentity)).toBeNull()
    expect(store.doctor().forgetClaimed).toBe(1)
    expect(store.claimBySource({ sessionId: 'session-a' })).toEqual(claim)

    const restarted = makeNodeAutoSkillStoreV2({ root: directory })
    restarted.purgeClaim(claim.claimId)
    expect(restarted.doctor().evidence).toBe(0)
    const certificate = restarted.issueRollbackCertificate('target-v1')
    expect(certificate?.certificateId).toMatch(/^[a-f0-9]{64}$/)
    expect(certificate?.targetCommit).toBe('target-v1')
  })

  it('forgets a queued job and both of its evidence edges before worker recovery', () => {
    const store = queuedStore(root())
    expect(store.nextWork()?.phase).toBe('queued')
    const claim = store.claimBySource({ projectId: 'project-a' })
    expect(store.nextWork()).toBeNull()
    store.purgeClaim(claim.claimId)
    expect(store.doctor().evidence).toBe(0)
    expect(store.issueRollbackCertificate('target-v1')).not.toBeNull()
  })

  it('claims notification before I/O and never retries an ambiguous delivery', async () => {
    const directory = root()
    const store = queuedStore(directory)
    await makeAutoSkillWorker({ store, registry, ...ports() }).drainOne()
    const notification = store.claimNotification()
    expect(notification?.title).toBe('Запомнить факт')
    expect(notification?.title).not.toContain('receipt')
    expect(store.claimNotification()).toBeNull()
    store.completeNotification(notification!.id, 'ambiguous')
    expect(store.doctor().ambiguousNotifications).toBe(1)
    expect(makeNodeAutoSkillStoreV2({ root: directory }).claimNotification()).toBeNull()
  })

  it('turns a crash after notification claim into durable ambiguity on restart', async () => {
    const directory = root()
    const store = queuedStore(directory)
    await makeAutoSkillWorker({ store, registry, ...ports() }).drainOne()
    expect(store.claimNotification()?.status).toBe('claimed')

    const restarted = makeNodeAutoSkillStoreV2({ root: directory })
    expect(restarted.claimNotification()).toBeNull()
    expect(restarted.doctor().ambiguousNotifications).toBe(1)
    expect(makeNodeAutoSkillStoreV2({ root: directory }).doctor().ambiguousNotifications).toBe(1)
  })

  it('recomputes evidence and artifact hashes after restart and fails closed on tampering', async () => {
    const directory = root()
    const store = queuedStore(directory)
    await makeAutoSkillWorker({ store, registry, ...ports() }).drainOne()
    const statePath = join(directory, 'state-v2.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      evidence: Array<{ value: { turnId: string } }>
    }
    state.evidence[0]!.value.turnId = 'tampered-turn'
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })

    expect(() => makeNodeAutoSkillStoreV2({ root: directory }))
      .toThrowError('AUTO_SKILL_STORE_CORRUPT')
  })

  it('fails closed on future schema instead of loading partial authority', () => {
    const directory = root()
    writeFileSync(join(directory, 'state-v2.json'), JSON.stringify({ schemaVersion: 3 }), {
      mode: 0o600,
    })
    expect(() => makeNodeAutoSkillStoreV2({ root: directory }))
      .toThrowError('AUTO_SKILL_STORE_CORRUPT')
    expect(readFileSync(join(directory, 'state-v2.json'), 'utf8')).toContain('"schemaVersion":3')
  })
})
