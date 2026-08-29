import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeContextLeaseCoordinator,
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  makeProjectService,
  makeSessionTranscript,
  type ProjectRegistryStateV2,
  type SwitchAuthority,
} from '@aisy/core'

import {
  makeMemorySessionCreationStore,
  makeSessionCreationCoordinator,
} from './session-creation-coordinator.js'
import {
  assertExactSessionDeletionRestartIntent,
  makeMemorySessionDeletionPersistence,
  makeNodeSessionDeletionPersistence,
  makeSessionDeletionCoordinator,
  makeSessionDeletionJournal,
  repairSessionDeletionSelections,
  sessionDeletionOperationFromRestartReason,
} from './session-deletion.js'
import { makeMemorySessionLabelStore } from './session-label-store.js'
import {
  makeNodeSessionTranscriptMaintenance,
  makeNodeSessionTranscriptPersistence,
  type NodeSessionTranscriptMaintenance,
} from './session-transcript-store.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const POLICY = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: ['/Users/operator/.aisy'],
}
const HEAD = 'a'.repeat(64)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(input: {
  failDeletionSaveAt?: number
  activityError?: Error
  autoNameError?: Error
  attachmentError?: Error
  providerPreflightError?: Error
  failProviderPurgeOnce?: boolean
  failTranscriptPurgeOnce?: boolean
  failDeletionPhaseOnce?: string
  currentHead?: () => Promise<string>
  transcript?: NodeSessionTranscriptMaintenance
  restartError?: Error
} = {}) {
  let id = 0
  let durableRegistry: ProjectRegistryStateV2 = makeFreshProjectRegistryV2({
    ...OWNER,
    workspaceRoot: '/Users/operator/workspace',
    nowIso: () => '2026-08-29T20:00:00.000Z',
    newId: () => `bootstrap-${++id}`,
    policy: POLICY,
  })
  let deletionSaves = 0
  let deletionPhaseFailed = false
  const deletionPersistence = makeMemorySessionDeletionPersistence({
    save: (state) => {
      deletionSaves += 1
      if (deletionSaves === input.failDeletionSaveAt) {
        throw new Error('injected deletion journal crash')
      }
      if (!deletionPhaseFailed && input.failDeletionPhaseOnce !== undefined &&
        state.records.some((record) => record.phase === input.failDeletionPhaseOnce)) {
        deletionPhaseFailed = true
        throw new Error('injected deletion phase crash')
      }
    },
  })
  const journal = makeSessionDeletionJournal({ persistence: deletionPersistence })
  const registry = makeProjectRegistryV2({
    state: durableRegistry,
    policy: POLICY,
    nowIso: () => '2026-08-29T20:00:00.000Z',
    newId: () => `registry-${++id}`,
    persistence: { saveAtomic: (state) => { durableRegistry = state } },
    sessionFence: journal,
  })
  const service = makeProjectService({
    registry,
    authority: {} as SwitchAuthority,
    leases: makeContextLeaseCoordinator({ newId: () => `lease-${++id}` }),
  })
  const labels = makeMemorySessionLabelStore()
  const creation = makeSessionCreationCoordinator({
    registry,
    service,
    labels,
    store: makeMemorySessionCreationStore(),
  })
  const calls: string[] = []
  const removedAutoNames: string[] = []
  const purged = new Set<string>()
  const controlsRemoved = new Set<string>()
  const providerHandles: unknown[] = []
  let providerFailed = false
  let transcriptFailed = false
  const restartPrepared = new Set<string>()
  const makeCoordinator = () => makeSessionDeletionCoordinator({
    registry,
    service,
    journal,
    creation,
    labels,
    autoNames: {
      assertAvailable: () => {
        if (input.autoNameError !== undefined) throw input.autoNameError
      },
      removeSession: (sessionId) => { removedAutoNames.push(sessionId) },
    },
    activity: {
      assertIdle: () => {
        calls.push('activity.preflight')
        if (input.activityError !== undefined) throw input.activityError
      },
    },
    attachments: {
      assertIdle: () => {
        calls.push('attachments.preflight')
        if (input.attachmentError !== undefined) throw input.attachmentError
      },
      purgeSession: () => { calls.push('attachments.purge') },
    },
    provider: {
      preflight: () => {
        calls.push('provider.preflight')
        if (input.providerPreflightError !== undefined) throw input.providerPreflightError
        return { kind: 'none', adapterRevision: 'test-no-session-persistence-v1' }
      },
      purge: (_target, _handle, operationHash) => {
        calls.push('provider.purge')
        providerHandles.push(structuredClone(_handle))
        if (input.failProviderPurgeOnce === true && !providerFailed) {
          providerFailed = true
          throw new Error('provider purge ambiguous')
        }
        purged.add(operationHash)
      },
    },
    dependants: {
      settle: () => { calls.push('dependants.settle') },
    },
    transcript: input.transcript ?? {
      currentHead: input.currentHead ?? (async () => HEAD),
      describe: async () => ({ transcriptHead: HEAD, turns: 0 }),
      purgeSession: async (sessionId, afterRewrite) => {
        calls.push('transcript.purge')
        purged.add(sessionId)
        if (input.failTranscriptPurgeOnce === true && !transcriptFailed) {
          transcriptFailed = true
          throw new Error('transcript purge crash')
        }
        afterRewrite?.()
        return { removedRows: 1, retainedRows: 0 }
      },
      removeSessionControls: async (sessionId) => {
        calls.push('transcript.controls.remove')
        controlsRemoved.add(sessionId)
      },
    },
    restart: {
      assertAvailable: () => {
        calls.push('restart.preflight')
        if (input.restartError !== undefined) throw input.restartError
      },
      prepare: ({ operationHash, updateId }) => {
        const authority = `${operationHash}:${updateId}`
        if (restartPrepared.has(authority)) return
        restartPrepared.add(authority)
        calls.push(`restart:${authority}`)
      },
    },
    nowIso: () => '2026-08-29T20:00:00.000Z',
  })
  return {
    calls,
    controlsRemoved,
    creation,
    deletionSaves: () => deletionSaves,
    journal,
    labels,
    removedAutoNames,
    makeCoordinator,
    purged,
    providerHandles,
    registry,
    service,
  }
}

describe('Session deletion coordinator', () => {
  it('persists the external fence journal atomically with private permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-session-deletions-'))
    roots.push(root)
    const path = join(root, 'deletions.json')
    const orphan = `${path}.tmp-202-00000000-0000-4000-8000-000000000202`
    writeFileSync(orphan, '{"schemaVersion":1,"records":[]}\n', { mode: 0o600 })
    const persistence = makeNodeSessionDeletionPersistence(path)
    expect(existsSync(orphan)).toBe(false)

    persistence.save({ schemaVersion: 1, records: [] })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schemaVersion: 1, records: [] })
    expect(statSync(path).mode & 0o777).toBe(0o600)

    writeFileSync(path, '{"schemaVersion":1,"records":[],"extra":true}\n', { mode: 0o600 })
    expect(() => makeNodeSessionDeletionPersistence(path))
      .toThrow('SESSION_DELETION_STATE_CORRUPT')
  })

  it('physically deletes an inactive Session while durable agent data stays byte-identical', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'aisy-session-boundary-'))
    roots.push(stateRoot)
    const transcriptRoot = join(stateRoot, 'journal')
    const sentinels = [
      ['memory', '{"facts":["любит деньги"]}\n'],
      ['skills', '{"active":["reply-style"]}\n'],
      ['preferences', '{"gender":"masculine"}\n'],
      ['grants', '{"scope":"project"}\n'],
    ] as const
    for (const [name, bytes] of sentinels) {
      mkdirSync(join(stateRoot, name), { recursive: true, mode: 0o700 })
      writeFileSync(join(stateRoot, name, 'state.json'), bytes, { mode: 0o600 })
    }
    const beforeProtected = sentinels.map(([name]) =>
      readFileSync(join(stateRoot, name, 'state.json'), 'utf8'))
    const maintenance = makeNodeSessionTranscriptMaintenance({ root: transcriptRoot })
    const h = setup({ transcript: maintenance })
    const active = h.registry.getActive(OWNER)
    const target = h.creation.create({
      ...OWNER,
      projectId: active.projectId,
      expectedGeneration: active.generation,
      requestKey: 'create-inactive-target',
      name: 'Старый разговор',
    })
    const transcript = makeSessionTranscript({
      persistence: makeNodeSessionTranscriptPersistence({ root: transcriptRoot }),
      classifyLoadBearing: () => ({ loadBearing: false, classifierVersion: 'rules-v1' }),
    })
    const binding = {
      ...OWNER,
      projectId: active.projectId,
      sessionId: target.id,
    }
    const frozen = {
      prefixBytes: new TextEncoder().encode('constitution'),
      prefixHash: 'ignored',
      breakpoints: [],
      takenAt: '2026-08-29T19:59:00.000Z',
    }
    await transcript.createExactSession(binding, frozen, frozen.takenAt)
    const appended = await transcript.append({
      ...binding,
      eventId: 'target-turn-1',
      role: 'user',
      provenance: 'operator',
      content: 'удаляемый приватный диалог',
      ts: '2026-08-29T20:00:00.000Z',
    })

    const result = await h.makeCoordinator().deleteConfirmed({
      ...OWNER,
      projectId: active.projectId,
      sessionId: target.id,
      expectedGeneration: active.generation,
      sourceUpdateId: 100,
      transcriptHead: appended.row.rowHash,
    })

    expect(result.phase).toBe('terminal')
    expect(h.registry.getActive(OWNER)).toEqual(active)
    expect(h.registry.snapshot().sessions.some((session) => session.id === target.id)).toBe(false)
    expect(h.labels.get(target.id)).toBeNull()
    expect(h.removedAutoNames).toEqual([target.id])
    expect(existsSync(join(transcriptRoot, 'sessions', target.id))).toBe(false)
    expect(readFileSync(join(transcriptRoot, 'transcript-v2.jsonl'), 'utf8'))
      .not.toContain('удаляемый приватный диалог')
    expect(h.journal.isFenced({ ...OWNER, projectId: active.projectId, sessionId: target.id }))
      .toBe(true)
    expect(sentinels.map(([name]) =>
      readFileSync(join(stateRoot, name, 'state.json'), 'utf8'))).toEqual(beforeProtected)
    expect(result).toMatchObject({
      phase: 'terminal', restartRequired: false, purgeRevision: 1,
    })
    expect(result).not.toHaveProperty('transcriptHead')
    expect(result).not.toHaveProperty('sourceUpdateId')
    expect(result).not.toHaveProperty('restartUpdateId')
    expect(result).not.toHaveProperty('expectedGeneration')
    expect(result).not.toHaveProperty('providerPurge')
    expect(result).not.toHaveProperty('replacement')
    expect(h.calls).toEqual([
      'activity.preflight', 'attachments.preflight', 'provider.preflight',
      'dependants.settle', 'provider.purge', 'attachments.purge',
    ])
  })

  it('rejects stale transcript authority before the durable fence', async () => {
    const h = setup({ currentHead: async () => 'b'.repeat(64) })
    const active = h.registry.getActive(OWNER)

    await expect(h.makeCoordinator().deleteConfirmed({
      ...OWNER,
      projectId: active.projectId,
      sessionId: active.sessionId,
      expectedGeneration: active.generation,
      sourceUpdateId: 109,
      transcriptHead: HEAD,
    })).rejects.toThrow('SESSION_DELETION_AUTHORITY_STALE')

    expect(h.journal.snapshot().records).toEqual([])
    expect(h.registry.getActive(OWNER)).toEqual(active)
    expect(h.calls).toEqual([
      'activity.preflight', 'attachments.preflight', 'provider.preflight',
    ])
  })

  it('holds the owner lifecycle barrier while revalidating transcript authority', async () => {
    let releaseHead!: (head: string) => void
    const head = new Promise<string>((resolve) => { releaseHead = resolve })
    const h = setup({ currentHead: () => head })
    const active = h.registry.getActive(OWNER)
    const deletion = h.makeCoordinator().deleteConfirmed({
      ...OWNER,
      projectId: active.projectId,
      sessionId: active.sessionId,
      expectedGeneration: active.generation,
      sourceUpdateId: 110,
      transcriptHead: HEAD,
    })
    await Promise.resolve()

    expect(() => h.service.acquireTurnContext(OWNER))
      .toThrow('CONTEXT_TRANSITION_IN_PROGRESS')
    releaseHead(HEAD)
    await expect(deletion).resolves.toMatchObject({ phase: 'restart-requested' })
  })

  it('deletes the active Session, creates one temporary replacement and restarts once', async () => {
    const h = setup()
    const active = h.registry.getActive(OWNER)
    h.labels.markTemporary(active.sessionId)
    const coordinator = h.makeCoordinator()
    const request = {
      ...OWNER,
      projectId: active.projectId,
      sessionId: active.sessionId,
      expectedGeneration: active.generation,
      sourceUpdateId: 101,
      transcriptHead: HEAD,
    }

    const first = await coordinator.deleteConfirmed(request)
    const replay = await coordinator.deleteConfirmed(request)

    expect(first.phase).toBe('restart-requested')
    expect(first.restartUpdateId).toBe(101)
    expect(replay).toEqual(first)
    const selected = h.registry.getActive(OWNER)
    expect(selected.sessionId).not.toBe(active.sessionId)
    expect(h.labels.get(selected.sessionId)).toMatchObject({ kind: 'temporary' })
    expect(h.registry.snapshot().sessions.map((session) => session.id)).toEqual([selected.sessionId])
    expect(h.calls.filter((call) => call.startsWith('restart:'))).toHaveLength(1)
    expect(h.calls).toContain('restart.preflight')
    expect(coordinator.acknowledgeRestart(first.operationHash).phase)
      .toBe('restart-acknowledged')
  })

  it('refuses busy or unsupported deletion before publishing a fence', async () => {
    for (const failure of [
      { activityError: new Error('SESSION_BUSY') },
      { autoNameError: new Error('SESSION_AUTO_NAME_PURGE_UNAVAILABLE') },
      { attachmentError: new Error('ATTACHMENT_PURGE_UNAVAILABLE') },
      { providerPreflightError: new Error('PROVIDER_PURGE_UNSUPPORTED') },
      { restartError: new Error('SESSION_RESTART_UNAVAILABLE') },
    ]) {
      const h = setup(failure)
      const active = h.registry.getActive(OWNER)
      const beforeRegistry = h.registry.snapshot()
      const beforeJournal = h.journal.snapshot()

      await expect(h.makeCoordinator().deleteConfirmed({
        ...OWNER,
        projectId: active.projectId,
        sessionId: active.sessionId,
        expectedGeneration: active.generation,
        sourceUpdateId: 102,
        transcriptHead: HEAD,
      })).rejects.toThrow(
        failure.activityError?.message ?? failure.providerPreflightError?.message ??
        failure.autoNameError?.message ?? failure.attachmentError?.message ??
        failure.restartError?.message,
      )

      expect(h.registry.snapshot()).toEqual(beforeRegistry)
      expect(h.journal.snapshot()).toEqual(beforeJournal)
    }
  })

  it('refuses a target with an already acquired turn lease before the fence', async () => {
    const h = setup()
    const active = h.registry.getActive(OWNER)
    const lease = h.service.acquireTurnContext(OWNER)

    await expect(h.makeCoordinator().deleteConfirmed({
      ...OWNER,
      projectId: active.projectId,
      sessionId: active.sessionId,
      expectedGeneration: active.generation,
      sourceUpdateId: 112,
      transcriptHead: HEAD,
    })).rejects.toThrow('CONTEXT_BUSY')
    expect(h.journal.snapshot().records).toEqual([])
    await h.service.releaseTurnContext(lease)
  })

  it('repairs a crash after replacement selection without creating a second Session', async () => {
    const h = setup({ failDeletionSaveAt: 2 })
    const active = h.registry.getActive(OWNER)
    const coordinator = h.makeCoordinator()

    await expect(coordinator.deleteConfirmed({
      ...OWNER,
      projectId: active.projectId,
      sessionId: active.sessionId,
      expectedGeneration: active.generation,
      sourceUpdateId: 103,
      transcriptHead: HEAD,
    })).rejects.toThrow('injected deletion journal crash')

    expect(h.journal.snapshot().records).toMatchObject([{ phase: 'prepared-and-fenced' }])
    expect(h.registry.snapshot().sessions).toHaveLength(2)
    expect(await repairSessionDeletionSelections({
      registry: h.registry,
      service: h.service,
      journal: h.journal,
      creation: h.creation,
    })).toEqual({ recovered: 1 })
    expect(h.journal.snapshot().records).toMatchObject([{ phase: 'replacement-selected' }])
    expect(await coordinator.repair()).toEqual({ recovered: 1 })
    expect(h.registry.snapshot().sessions).toHaveLength(1)
    expect(h.journal.snapshot().records).toMatchObject([{ phase: 'restart-requested' }])
    const operationHash = h.journal.snapshot().records[0]!.operationHash
    expect(coordinator.acknowledgeRestart(operationHash).phase).toBe('restart-acknowledged')
  })

  it('rolls forward provider ambiguity and transcript crash without exposing the target', async () => {
    for (const fault of [
      { failProviderPurgeOnce: true, phase: 'provider-purge-pending' },
      { failTranscriptPurgeOnce: true, phase: 'transcript-rewrite-prepared' },
    ] as const) {
      const h = setup(fault)
      const active = h.registry.getActive(OWNER)
      const coordinator = h.makeCoordinator()

      await expect(coordinator.deleteConfirmed({
        ...OWNER,
        projectId: active.projectId,
        sessionId: active.sessionId,
        expectedGeneration: active.generation,
        sourceUpdateId: fault.failProviderPurgeOnce === true ? 104 : 105,
        transcriptHead: HEAD,
      })).rejects.toThrow()

      expect(h.journal.snapshot().records).toMatchObject([{ phase: fault.phase }])
      if (fault.phase === 'provider-purge-pending') {
        expect(h.journal.snapshot().records[0]).toMatchObject({
          providerPurge: {
            kind: 'none', adapterRevision: 'test-no-session-persistence-v1',
          },
        })
      }
      expect(() => h.registry.getSession({
        ...OWNER, projectId: active.projectId, sessionId: active.sessionId,
      })).toThrowError(expect.objectContaining({ code: 'SESSION_DELETED' }))
      expect(await coordinator.repair()).toEqual({ recovered: 1 })
      expect(h.registry.snapshot().sessions.some((session) => session.id === active.sessionId))
        .toBe(false)
      expect(h.providerHandles).toEqual(expect.arrayContaining([{
        kind: 'none', adapterRevision: 'test-no-session-persistence-v1',
      }]))
    }
  })

  it('repairs an active terminal tombstone into one restart request', async () => {
    const h = setup({ failDeletionPhaseOnce: 'restart-requested' })
    const active = h.registry.getActive(OWNER)
    await expect(h.makeCoordinator().deleteConfirmed({
      ...OWNER,
      projectId: active.projectId,
      sessionId: active.sessionId,
      expectedGeneration: active.generation,
      sourceUpdateId: 111,
      transcriptHead: HEAD,
    })).rejects.toThrow('injected deletion phase crash')
    expect(h.journal.snapshot().records).toMatchObject([{
      phase: 'terminal', restartRequired: true, restartUpdateId: 111,
    }])
    expect(h.journal.snapshot().records[0]).not.toHaveProperty('transcriptHead')

    await expect(h.makeCoordinator().repair()).resolves.toEqual({ recovered: 1 })
    expect(h.journal.snapshot().records).toMatchObject([{
      phase: 'restart-requested', restartRequired: true,
    }])
    expect(h.calls.filter((call) => call.startsWith('restart:'))).toHaveLength(1)
    const operationHash = h.journal.snapshot().records[0]!.operationHash
    await expect(h.makeCoordinator().repair()).resolves.toEqual({ recovered: 1 })
    expect(h.calls.filter((call) => call.startsWith('restart:'))).toHaveLength(1)
    expect(h.makeCoordinator().acknowledgeRestart(operationHash).phase)
      .toBe('restart-acknowledged')
  })

  it('extracts deletion authority only from the exact restart receipt reason', () => {
    const operationHash = 'f'.repeat(64)
    expect(sessionDeletionOperationFromRestartReason(
      `telegram-update:17 · session deletion ${operationHash}`,
    )).toBe(operationHash)
    expect(sessionDeletionOperationFromRestartReason(
      `telegram-update:17 · session deletion ${operationHash} trailing`,
    )).toBeNull()
    expect(sessionDeletionOperationFromRestartReason(
      `session deletion ${operationHash}`,
    )).toBeNull()
  })

  it('rejects a pre-existing restart intent for another purpose', () => {
    const expected = `telegram-update:77 · session deletion ${'a'.repeat(64)}`
    expect(() => assertExactSessionDeletionRestartIntent({
      reason: 'telegram-update:77 · manual restart', activeTurns: 0,
    }, expected)).toThrow('SESSION_DELETION_RESTART_IDENTITY_MISMATCH')
    expect(() => assertExactSessionDeletionRestartIntent({
      reason: expected, activeTurns: 1,
    }, expected)).toThrow('SESSION_DELETION_RESTART_IDENTITY_MISMATCH')
    expect(() => assertExactSessionDeletionRestartIntent({
      reason: expected, activeTurns: 0,
    }, expected)).not.toThrow()
  })
})
