import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

import {
  inspectNodeAutoSkillStoreV2,
  makeNodeAutoSkillStoreV2,
  prepareNodeAutoSkillRollback,
  resumeNodeAutoSkillWritesAfterRollForward,
  verifyNodeAutoSkillRollback,
} from './auto-skill-store.js'
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
  expect(confirm(store, evidence('session-a', 'a'))).toEqual({ kind: 'counted' })
  const queued = confirm(store, evidence('session-b', 'b'))
  expect(queued.kind).toBe('queued')
  return store
}

function confirm(
  store: ReturnType<typeof makeNodeAutoSkillStoreV2>,
  value: VerifiedWorkflowEvidenceV1,
) {
  const staged = store.stage(value)
  return staged.kind === 'duplicate'
    ? staged
    : store.confirmReply({
        evidenceId: value.evidenceId,
        sessionId: value.sessionId,
        turnId: value.turnId,
      })
}

describe('private auto-skill v2 lifecycle', () => {
  it('keeps every ordinary writer blocked after rollback certification', () => {
    const directory = root()
    const runningStore = makeNodeAutoSkillStoreV2({ root: directory })
    const authorization = prepareNodeAutoSkillRollback({
      root: directory,
      targetCommit: 'target-v1',
    })

    expect(verifyNodeAutoSkillRollback({ root: directory, authorization })).toBe(true)
    expect(inspectNodeAutoSkillStoreV2({ root: directory, enabled: true })).toMatchObject({
      state: 'degraded', rollbackBarrier: true,
    })
    expect(() => runningStore.stage(evidence('session-a', 'a')))
      .toThrowError('AUTO_SKILL_ROLLBACK_BARRIER')
    expect(() => makeNodeAutoSkillStoreV2({ root: directory }))
      .toThrowError('AUTO_SKILL_ROLLBACK_BARRIER')
    expect(verifyNodeAutoSkillRollback({ root: directory, authorization })).toBe(true)
    expect(() => resumeNodeAutoSkillWritesAfterRollForward({
      root: directory,
      currentCommit: 'target-v1',
    })).toThrowError('AUTO_SKILL_ROLLFORWARD_REFUSED')
    expect(resumeNodeAutoSkillWritesAfterRollForward({
      root: directory,
      currentCommit: 'target-v2',
    })).toBe(true)
    expect(inspectNodeAutoSkillStoreV2({ root: directory, enabled: true })).toMatchObject({
      state: 'ready', rollbackBarrier: false,
    })
    expect(() => runningStore.stage(evidence('session-b', 'b')))
      .toThrowError('AUTO_SKILL_STORE_POISONED')
    expect(makeNodeAutoSkillStoreV2({ root: directory }).doctor())
      .toMatchObject({ active: 0, evidence: 0, pendingReply: 0 })
  })

  it('fences an idle store opened before rollback even when it never observed the barrier', () => {
    const directory = root()
    const stale = makeNodeAutoSkillStoreV2({ root: directory })
    prepareNodeAutoSkillRollback({ root: directory, targetCommit: 'target-v1' })
    expect(resumeNodeAutoSkillWritesAfterRollForward({
      root: directory,
      currentCommit: 'target-v2',
    })).toBe(true)

    expect(() => stale.stage(evidence('session-a', 'a')))
      .toThrowError('AUTO_SKILL_STORE_FENCED')
    expect(makeNodeAutoSkillStoreV2({ root: directory }).stage(evidence('session-a', 'a')))
      .toEqual({ kind: 'staged' })
  })

  it('finishes a crash-left preparing rollback barrier idempotently', () => {
    const directory = root()
    makeNodeAutoSkillStoreV2({ root: directory })
    writeFileSync(join(directory, 'rollback-barrier-v1.json'), `${JSON.stringify({
      schemaVersion: 1,
      phase: 'preparing',
      targetCommit: 'target-v1',
    })}\n`, { mode: 0o600 })

    const authorization = prepareNodeAutoSkillRollback({
      root: directory,
      targetCommit: 'target-v1',
    })

    expect(verifyNodeAutoSkillRollback({ root: directory, authorization })).toBe(true)
  })

  it('refuses certification while an ordinary mutation marker is in flight', () => {
    const directory = root()
    makeNodeAutoSkillStoreV2({ root: directory })
    const marker = join(directory, `.mutation-inflight-${process.pid}-${randomUUID()}`)
    writeFileSync(marker, '', { mode: 0o600 })

    expect(() => prepareNodeAutoSkillRollback({
      root: directory,
      targetCommit: 'target-v1',
    })).toThrowError('AUTO_SKILL_MUTATION_IN_FLIGHT')
    expect(existsSync(join(directory, 'rollback-barrier-v1.json'))).toBe(false)
    rmSync(marker)
    expect(makeNodeAutoSkillStoreV2({ root: directory }).doctor().active).toBe(0)
  })

  it('reports a valid in-flight mutation marker as degraded without recovering it', () => {
    const directory = root()
    makeNodeAutoSkillStoreV2({ root: directory })
    const markerId = randomUUID()
    const temporaryName = `.state-${process.pid}-${markerId}.tmp`
    const marker = join(directory, `.mutation-inflight-${process.pid}-${markerId}`)
    writeFileSync(marker, `${JSON.stringify({
      schemaVersion: 2,
      ownerPid: process.pid,
      kind: 'state',
      temporaryName,
    })}\n`, { mode: 0o600 })
    writeFileSync(join(directory, temporaryName), 'pending private state\n', { mode: 0o600 })

    expect(inspectNodeAutoSkillStoreV2({ root: directory, enabled: true }).state)
      .toBe('degraded')
    expect(existsSync(marker)).toBe(true)
    expect(existsSync(join(directory, temporaryName))).toBe(true)
  })

  it('reports an unattributed strict mutation temporary as corrupt', () => {
    const directory = root()
    makeNodeAutoSkillStoreV2({ root: directory })
    const temporaryName = `.revision-${randomUUID()}.tmp`
    mkdirSync(join(directory, 'revisions', temporaryName), { mode: 0o700 })
    writeFileSync(
      join(directory, 'revisions', temporaryName, 'SKILL.md'),
      'unattributed private artifact\n',
      { mode: 0o600 },
    )

    expect(inspectNodeAutoSkillStoreV2({ root: directory, enabled: true }).state)
      .toBe('corrupt')
    expect(() => makeNodeAutoSkillStoreV2({ root: directory }))
      .toThrowError('AUTO_SKILL_MUTATION_IN_FLIGHT')
  })

  it('reports a bound temporary with the wrong artifact type as corrupt without mutation', () => {
    const directory = root()
    makeNodeAutoSkillStoreV2({ root: directory })
    const markerId = randomUUID()
    const temporaryName = `.revision-${markerId}.tmp`
    const temporary = join(directory, 'revisions', temporaryName)
    writeFileSync(
      join(directory, `.mutation-inflight-${process.pid}-${markerId}`),
      `${JSON.stringify({
        schemaVersion: 2,
        ownerPid: process.pid,
        kind: 'artifact',
        revisionHash: 'c'.repeat(64),
        temporaryName,
      })}\n`,
      { mode: 0o600 },
    )
    writeFileSync(temporary, 'not a private directory\n', { mode: 0o600 })

    expect(inspectNodeAutoSkillStoreV2({ root: directory, enabled: true }).state)
      .toBe('corrupt')
    expect(readFileSync(temporary, 'utf8')).toBe('not a private directory\n')
  })

  it('reconciles a crash-left mutation marker only after its owner is dead', async () => {
    const directory = root()
    makeNodeAutoSkillStoreV2({ root: directory })
    const child = spawn(process.execPath, ['-e', [
      "const { randomUUID } = require('node:crypto')",
      "const { writeFileSync } = require('node:fs')",
      "const { join } = require('node:path')",
      "const root = process.argv[1]",
      "writeFileSync(join(root, `.mutation-inflight-${process.pid}-${randomUUID()}`), '', { flag: 'wx', mode: 0o600 })",
      "process.stdout.write('ready\\n')",
      'setInterval(() => undefined, 1000)',
    ].join(';'), directory], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>((resolveReady, rejectReady) => {
      child.once('error', rejectReady)
      child.stdout.once('data', () => resolveReady())
    })
    child.kill('SIGKILL')
    await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))

    const authorization = prepareNodeAutoSkillRollback({
      root: directory,
      targetCommit: 'target-v1',
    })
    expect(verifyNodeAutoSkillRollback({ root: directory, authorization })).toBe(true)
  })

  it('removes a SIGKILL orphan artifact only when its exact marker owner is dead', async () => {
    const directory = root()
    makeNodeAutoSkillStoreV2({ root: directory })
    const revisionHash = 'd'.repeat(64)
    const child = spawn(process.execPath, ['-e', [
      "const { randomUUID } = require('node:crypto')",
      "const { mkdirSync, writeFileSync } = require('node:fs')",
      "const { join } = require('node:path')",
      "const root = process.argv[1]",
      "const revisionHash = process.argv[2]",
      "mkdirSync(join(root, 'revisions', revisionHash), { mode: 0o700 })",
      "writeFileSync(join(root, 'revisions', revisionHash, 'manifest.json'), '{}\\n', { mode: 0o600 })",
      "writeFileSync(join(root, 'revisions', revisionHash, 'SKILL.md'), 'orphan\\n', { mode: 0o600 })",
      "writeFileSync(join(root, `.mutation-inflight-${process.pid}-${randomUUID()}`), JSON.stringify({ schemaVersion: 1, ownerPid: process.pid, kind: 'artifact', revisionHash }) + '\\n', { flag: 'wx', mode: 0o600 })",
      "process.stdout.write('ready\\n')",
      'setInterval(() => undefined, 1000)',
    ].join(';'), directory, revisionHash], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>((resolveReady, rejectReady) => {
      child.once('error', rejectReady)
      child.stdout.once('data', () => resolveReady())
    })
    expect(existsSync(join(directory, 'revisions', revisionHash))).toBe(true)
    child.kill('SIGKILL')
    await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))

    const restarted = makeNodeAutoSkillStoreV2({ root: directory })
    expect(existsSync(join(directory, 'revisions', revisionHash))).toBe(false)
    expect(restarted.issueRollbackCertificate('target-v1')).not.toBeNull()
  })

  it('removes exact dead-owner state and artifact temporaries before rollback certification', async () => {
    const directory = root()
    makeNodeAutoSkillStoreV2({ root: directory })
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
    const ownerPid = child.pid!
    const stateMarkerId = randomUUID()
    const artifactMarkerId = randomUUID()
    const stateTemporaryName = `.state-${ownerPid}-${stateMarkerId}.tmp`
    const artifactTemporaryName = `.revision-${artifactMarkerId}.tmp`
    writeFileSync(join(directory, stateTemporaryName), 'private pending state\n', { mode: 0o600 })
    mkdirSync(join(directory, 'revisions', artifactTemporaryName), { mode: 0o700 })
    writeFileSync(
      join(directory, 'revisions', artifactTemporaryName, 'SKILL.md'),
      'private pending artifact\n',
      { mode: 0o600 },
    )
    writeFileSync(
      join(directory, `.mutation-inflight-${ownerPid}-${stateMarkerId}`),
      `${JSON.stringify({
        schemaVersion: 2,
        ownerPid,
        kind: 'state',
        temporaryName: stateTemporaryName,
      })}\n`,
      { mode: 0o600 },
    )
    writeFileSync(
      join(directory, `.mutation-inflight-${ownerPid}-${artifactMarkerId}`),
      `${JSON.stringify({
        schemaVersion: 2,
        ownerPid,
        kind: 'artifact',
        revisionHash: 'e'.repeat(64),
        temporaryName: artifactTemporaryName,
      })}\n`,
      { mode: 0o600 },
    )

    const authorization = prepareNodeAutoSkillRollback({
      root: directory,
      targetCommit: 'target-v1',
    })
    expect(existsSync(join(directory, stateTemporaryName))).toBe(false)
    expect(existsSync(join(directory, 'revisions', artifactTemporaryName))).toBe(false)
    expect(readdirSync(directory).some(name => name.startsWith('.mutation-inflight-'))).toBe(false)
    expect(verifyNodeAutoSkillRollback({ root: directory, authorization })).toBe(true)
  })

  it('defers dead same-revision cleanup while any marker owner remains live', async () => {
    const directory = root()
    makeNodeAutoSkillStoreV2({ root: directory })
    const revisionHash = 'f'.repeat(64)
    mkdirSync(join(directory, 'revisions', revisionHash), { mode: 0o700 })
    writeFileSync(join(directory, 'revisions', revisionHash, 'manifest.json'), '{}\n', { mode: 0o600 })
    writeFileSync(join(directory, 'revisions', revisionHash, 'SKILL.md'), 'live writer\n', { mode: 0o600 })
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'])
    await new Promise<void>((resolveExit) => dead.once('exit', () => resolveExit()))
    const live = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'])
    const writeMarker = (ownerPid: number) => {
      const markerId = randomUUID()
      const temporaryName = `.revision-${markerId}.tmp`
      writeFileSync(
        join(directory, `.mutation-inflight-${ownerPid}-${markerId}`),
        `${JSON.stringify({
          schemaVersion: 2,
          ownerPid,
          kind: 'artifact',
          revisionHash,
          temporaryName,
        })}\n`,
        { mode: 0o600 },
      )
    }
    writeMarker(dead.pid!)
    writeMarker(live.pid!)

    expect(() => makeNodeAutoSkillStoreV2({ root: directory }))
      .toThrowError('AUTO_SKILL_MUTATION_IN_FLIGHT')
    expect(existsSync(join(directory, 'revisions', revisionHash))).toBe(true)
    live.kill('SIGKILL')
    await new Promise<void>((resolveExit) => live.once('exit', () => resolveExit()))

    const restarted = makeNodeAutoSkillStoreV2({ root: directory })
    expect(existsSync(join(directory, 'revisions', revisionHash))).toBe(false)
    expect(restarted.issueRollbackCertificate('target-v1')).not.toBeNull()
  })

  it('doctor remains read-only when the canary root is absent', () => {
    const directory = join(root(), 'absent-auto-skills')
    expect(inspectNodeAutoSkillStoreV2({ root: directory, enabled: false }).state).toBe('disabled')
    expect(inspectNodeAutoSkillStoreV2({ root: directory, enabled: true })).toMatchObject({
      state: 'ready', active: 0, queued: 0,
    })
    expect(existsSync(directory)).toBe(false)
  })

  it('requires two distinct sessions and ignores retries, replays and same-session repeats', () => {
    const store = makeNodeAutoSkillStoreV2({ root: root() })
    const first = evidence('session-a', 'a')
    expect(confirm(store, first)).toEqual({ kind: 'counted' })
    expect(store.stage(first)).toEqual({ kind: 'duplicate' })
    expect(confirm(store, evidence('session-a', 'b', 'turn-a-2'))).toEqual({ kind: 'counted' })
    expect(store.nextWork()).toBeNull()
    const queued = confirm(store, evidence('session-b', 'c'))
    expect(queued.kind).toBe('queued')
    expect(store.nextWork()?.evidenceIds).toHaveLength(2)
  })

  it('does not count staged evidence until the exact terminal reply is delivered', () => {
    const directory = root()
    const store = makeNodeAutoSkillStoreV2({ root: directory })
    const first = evidence('session-a', 'a')
    const second = evidence('session-b', 'b')
    expect(store.stage(first)).toEqual({ kind: 'staged' })
    expect(store.stage(second)).toEqual({ kind: 'staged' })
    expect(store.doctor()).toMatchObject({ evidence: 0, pendingReply: 2, queued: 0 })
    expect(store.confirmReply({
      evidenceId: first.evidenceId,
      sessionId: 'session-a',
      turnId: 'wrong-turn',
    }))
      .toEqual({ kind: 'duplicate' })
    expect(store.nextWork()).toBeNull()

    const restarted = makeNodeAutoSkillStoreV2({ root: directory })
    expect(restarted.confirmReply({
      evidenceId: first.evidenceId,
      sessionId: first.sessionId,
      turnId: first.turnId,
    }))
      .toEqual({ kind: 'counted' })
    expect(restarted.nextWork()).toBeNull()
    expect(restarted.confirmReply({
      evidenceId: second.evidenceId,
      sessionId: second.sessionId,
      turnId: second.turnId,
    }).kind)
      .toBe('queued')
    expect(restarted.doctor()).toMatchObject({ evidence: 2, pendingReply: 0, queued: 1 })
  })

  it('binds delivery to the exact pending evidence instead of only session and turn', () => {
    const store = makeNodeAutoSkillStoreV2({ root: root() })
    const stale = evidence('session-a', 'a', 'shared-turn')
    const delivered = evidence('session-a', 'b', 'shared-turn')
    expect(store.stage(stale)).toEqual({ kind: 'staged' })
    expect(store.stage(delivered)).toEqual({ kind: 'staged' })

    expect(store.confirmReply({
      evidenceId: delivered.evidenceId,
      sessionId: delivered.sessionId,
      turnId: delivered.turnId,
    })).toEqual({ kind: 'counted' })
    expect(store.doctor()).toMatchObject({ evidence: 1, pendingReply: 1, queued: 0 })
    expect(store.confirmReply({
      evidenceId: delivered.evidenceId,
      sessionId: delivered.sessionId,
      turnId: delivered.turnId,
    })).toEqual({ kind: 'duplicate' })
    expect(store.doctor()).toMatchObject({ evidence: 1, pendingReply: 1, queued: 0 })
  })

  it.each(['session', 'project'] as const)(
    'keeps a reopened %s source fenced after its durable forget claim',
    (sourceKind) => {
      const directory = root()
      const store = queuedStore(directory)
      const claim = sourceKind === 'session'
        ? store.claimBySource({ sessionId: 'session-a' })
        : store.claimBySource({ projectId: scope.projectId })
      const late = sourceKind === 'session'
        ? evidence('session-a', 'c', 'turn-after-claim')
        : evidence('session-c', 'c', 'turn-after-claim')

      expect(store.stage(late)).toEqual({ kind: 'duplicate' })
      const restarted = makeNodeAutoSkillStoreV2({ root: directory })
      expect(restarted.stage(late)).toEqual({ kind: 'duplicate' })
      const retry = sourceKind === 'session'
        ? restarted.claimBySource({ sessionId: 'session-a' })
        : restarted.claimBySource({ projectId: scope.projectId })
      expect(retry.claimId).toBe(claim.claimId)
      restarted.purgeClaim(retry.claimId)
      expect(restarted.doctor()).toMatchObject({ evidence: 0, active: 0 })
    },
  )

  it('does not count a receipt replayed under a foreign session', () => {
    const store = makeNodeAutoSkillStoreV2({ root: root() })
    expect(confirm(store, evidence('session-a', 'a'))).toEqual({ kind: 'counted' })
    expect(store.stage(evidence('session-b', 'a'))).toEqual({ kind: 'duplicate' })
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
    expect(store.activeForScope(first.scopeKey)).toEqual([active])
    expect(store.activeForScope('f'.repeat(64))).toEqual([])
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

  it('retains an artifact when state publication becomes ambiguous after rename', async () => {
    const directory = root()
    const store = queuedStore(directory)
    const job = store.nextWork()!
    store.advanceJob({ jobId: job.jobId, expected: 'queued', next: 'generated', draft })
    store.advanceJob({ jobId: job.jobId, expected: 'generated', next: 'validated', draft })
    store.advanceJob({ jobId: job.jobId, expected: 'validated', next: 'shadow_verified' })
    const first = store.evidenceFor(job.jobId)[0]
    const manifest = buildAutoSkillManifest({ draft, evidence: first, registry })!
    const ambiguous = makeNodeAutoSkillStoreV2({
      root: directory,
      fault: point => {
        if (point === 'persist:after-state-rename') throw new Error('injected fsync failure')
      },
    })

    expect(() => ambiguous.prepare({
      jobId: job.jobId,
      manifest,
      renderedSkill: renderAutoSkillDocument(manifest),
    })).toThrow('injected fsync failure')

    const restarted = makeNodeAutoSkillStoreV2({ root: directory })
    expect(restarted.nextWork()).toMatchObject({ phase: 'prepared', revisionHash: manifest.revisionHash })
    await expect(makeAutoSkillWorker({
      store: restarted,
      registry,
      ...ports(),
    }).drainOne()).resolves.toMatchObject({ kind: 'activated', revisionHash: manifest.revisionHash })
  })

  it('removes a newly published artifact after a definite pre-rename state failure', async () => {
    const directory = root()
    const store = queuedStore(directory)
    const job = store.nextWork()!
    store.advanceJob({ jobId: job.jobId, expected: 'queued', next: 'generated', draft })
    store.advanceJob({ jobId: job.jobId, expected: 'generated', next: 'validated', draft })
    store.advanceJob({ jobId: job.jobId, expected: 'validated', next: 'shadow_verified' })
    const first = store.evidenceFor(job.jobId)[0]
    const manifest = buildAutoSkillManifest({ draft, evidence: first, registry })!
    const failing = makeNodeAutoSkillStoreV2({
      root: directory,
      fault: point => {
        if (point === 'persist:before-state-rename') throw new Error('injected pre-rename failure')
      },
    })

    expect(() => failing.prepare({
      jobId: job.jobId,
      manifest,
      renderedSkill: renderAutoSkillDocument(manifest),
    })).toThrow('injected pre-rename failure')
    expect(existsSync(join(directory, 'revisions', manifest.revisionHash))).toBe(false)

    const restarted = makeNodeAutoSkillStoreV2({ root: directory })
    expect(restarted.nextWork()).toMatchObject({ phase: 'shadow_verified' })
    await expect(makeAutoSkillWorker({
      store: restarted,
      registry,
      ...ports(),
    }).drainOne()).resolves.toMatchObject({ kind: 'activated', revisionHash: manifest.revisionHash })
  })

  it('never exposes a pre-rename activation from a poisoned in-memory handle', () => {
    const directory = root()
    const store = queuedStore(directory)
    const job = store.nextWork()!
    store.advanceJob({ jobId: job.jobId, expected: 'queued', next: 'generated', draft })
    store.advanceJob({ jobId: job.jobId, expected: 'generated', next: 'validated', draft })
    store.advanceJob({ jobId: job.jobId, expected: 'validated', next: 'shadow_verified' })
    const manifest = buildAutoSkillManifest({
      draft, evidence: store.evidenceFor(job.jobId)[0], registry,
    })!
    store.prepare({
      jobId: job.jobId,
      manifest,
      renderedSkill: renderAutoSkillDocument(manifest),
    })
    const failing = makeNodeAutoSkillStoreV2({
      root: directory,
      fault: point => {
        if (point === 'persist:before-state-rename') throw new Error('activation pre-rename')
      },
    })

    expect(() => failing.activate(job.jobId, manifest.revisionHash))
      .toThrowError('activation pre-rename')
    expect(() => failing.activeForScope(manifest.scopeKey))
      .toThrowError('AUTO_SKILL_STORE_POISONED')
    expect(() => failing.active(manifest.scopeKey, manifest.skillIdentity))
      .toThrowError('AUTO_SKILL_STORE_POISONED')

    const restarted = makeNodeAutoSkillStoreV2({ root: directory })
    expect(restarted.activeForScope(manifest.scopeKey)).toEqual([])
    expect(restarted.nextWork()).toMatchObject({
      phase: 'prepared', revisionHash: manifest.revisionHash,
    })
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

  it('keeps a durable previous pointer and rolls a failed newer recipe revision back', async () => {
    const store = queuedStore(root())
    const firstActivation = await makeAutoSkillWorker({ store, registry, ...ports() }).drainOne()
    if (firstActivation.kind !== 'activated') throw new Error('first activation expected')

    const registryV2: AutoSkillDescriptorRegistry = Object.freeze({
      revision: 'registry-v2',
      descriptor(id: string) {
        return id === 'memory.remember' ? Object.freeze({
          id,
          title: 'Запомнить факт',
          description: 'Сохраняет проверяемый факт',
          trigger: 'запомни',
          placeholders: Object.freeze([
            Object.freeze({ id: 'fact', source: 'current_request' as const }),
          ]),
          postconditions: Object.freeze(['memory.persisted']),
        }) : null
      },
    })
    const draftV2: SkillRecipeDraftV1 = Object.freeze({
      version: 1,
      steps: Object.freeze([Object.freeze({
        descriptorId: 'memory.remember', placeholderIds: Object.freeze(['fact']),
        postconditionIds: Object.freeze(['memory.persisted']),
      })]),
    })
    const revisedEvidence = (sessionId: string, receipt: string) => {
      const value = makeVerifiedWorkflowEvidence({
        sessionId, turnId: `turn-${sessionId}`, scope, registry: registryV2,
        steps: [{
          descriptorId: 'memory.remember', placeholderIds: ['fact'],
          postconditionIds: ['memory.persisted'], receiptId: receipt.repeat(64),
        }],
        trusted: true, narrowed: false,
      })
      if (value === null) throw new Error('revised evidence expected')
      return value
    }
    const revisedA = revisedEvidence('session-c', 'c')
    const original = evidence('session-a', 'a')
    expect(revisedA.skillIdentity).toBe(original.skillIdentity)
    expect(revisedA.workflowFingerprint).not.toBe(original.workflowFingerprint)
    expect(confirm(store, revisedA).kind).toBe('counted')
    expect(confirm(store, revisedEvidence('session-d', 'd')).kind).toBe('queued')

    const secondActivation = await makeAutoSkillWorker({
      store,
      registry: registryV2,
      generator: {
        identity: { provider: 'generator', model: 'model-a', revision: 'r1' },
        generate: async () => draftV2,
      },
      judge: {
        identity: { provider: 'judge', model: 'model-b', revision: 'r1' },
        judge: async () => ({ accepted: true }),
      },
    }).drainOne()
    if (secondActivation.kind !== 'activated') throw new Error('second activation expected')
    expect(secondActivation.revisionHash).not.toBe(firstActivation.revisionHash)
    expect(store.active(original.scopeKey, original.skillIdentity)?.manifest.revisionHash)
      .toBe(secondActivation.revisionHash)

    store.permanentFailure(secondActivation.revisionHash, 'postcondition_mismatch')
    expect(store.active(original.scopeKey, original.skillIdentity)?.manifest.revisionHash)
      .toBe(firstActivation.revisionHash)
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
    expect(store.claimNotification()).toBeNull()
    expect(store.doctor().forgetClaimed).toBe(1)
    expect(store.claimBySource({ sessionId: 'session-a' })).toEqual(claim)

    const restarted = makeNodeAutoSkillStoreV2({ root: directory })
    restarted.purgeClaim(claim.claimId)
    expect(restarted.doctor().evidence).toBe(0)
    expect(restarted.stage(first)).toEqual({ kind: 'duplicate' })
    expect(restarted.stage(evidence('session-a', 'e', 'turn-session-a-new')))
      .toEqual({ kind: 'staged' })
    const certificate = restarted.issueRollbackCertificate('target-v1')
    expect(certificate).toBeNull()
    const freshClaim = restarted.claimBySource({ sessionId: 'session-a' })
    restarted.purgeClaim(freshClaim.claimId)
    const afterSecondRestart = makeNodeAutoSkillStoreV2({ root: directory })
    const tombstonedState = readFileSync(join(directory, 'state-v2.json'), 'utf8')
    expect(tombstonedState).not.toContain('session-a')
    expect(tombstonedState).not.toContain('project-a')
    const cleanCertificate = afterSecondRestart.issueRollbackCertificate('target-v1')
    expect(cleanCertificate?.certificateId).toMatch(/^[a-f0-9]{64}$/)
    expect(cleanCertificate?.targetCommit).toBe('target-v1')
    expect(afterSecondRestart.verifyRollbackCertificate(
      cleanCertificate!.certificateId, 'target-v1',
    )).toBe(true)
    expect(afterSecondRestart.verifyRollbackCertificate(
      cleanCertificate!.certificateId, 'another-target',
    )).toBe(false)
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

  it('recovers a crash after source claim without restoring the learned pointer', async () => {
    const directory = root()
    const store = queuedStore(directory)
    await makeAutoSkillWorker({ store, registry, ...ports() }).drainOne()
    const first = evidence('session-a', 'a')
    store.claimBySource({ sessionId: 'session-a' })

    const restarted = makeNodeAutoSkillStoreV2({ root: directory })
    expect(restarted.active(first.scopeKey, first.skillIdentity)).toBeNull()
    expect(restarted.doctor().forgetClaimed).toBe(1)
    expect(restarted.recoverForgetClaims(() => false)).toBe(0)
    expect(restarted.doctor().forgetClaimed).toBe(1)
    expect(restarted.recoverForgetClaims(source =>
      source.kind === 'session' && source.id === 'session-a')).toBe(1)

    const converged = makeNodeAutoSkillStoreV2({ root: directory })
    expect(converged.doctor()).toMatchObject({ evidence: 0, active: 0, forgetClaimed: 0 })
    expect(converged.recoverForgetClaims()).toBe(0)
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

    expect(inspectNodeAutoSkillStoreV2({ root: directory, enabled: true }).state).toBe('corrupt')
    expect(inspectNodeAutoSkillStoreV2({ root: directory, enabled: false }).state).toBe('corrupt')
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
