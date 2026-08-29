import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeContextLeaseCoordinator,
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  makeProjectService,
  makeSessionRotationAuthority,
  makeSwitchAuthority,
  type ProjectRegistryStateV2,
  type SwitchAuthorityNonceRecord,
} from '@aisy/core'

import {
  makeDailySessionRotation,
  makeNodeDailySessionRotationStore,
  type DailySessionRotationRecord,
  type DailySessionRotationStore,
} from './daily-session-rotation.js'
import {
  makeMemorySessionCreationStore,
  makeSessionCreationCoordinator,
} from './session-creation-coordinator.js'
import { makeMemorySessionLabelStore } from './session-label-store.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const POLICY = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: ['/Users/operator/.aisy'],
}

function nonceStore() {
  const records = new Map<string, SwitchAuthorityNonceRecord>()
  return {
    issue: (record: SwitchAuthorityNonceRecord) => { records.set(record.receiptId, record) },
    has: (id: string, mac: string) => records.get(id)?.mac === mac,
    consume: (id: string, mac: string) => {
      if (records.get(id)?.mac !== mac) return false
      records.delete(id)
      return true
    },
  }
}

function setup(storeOverride?: DailySessionRotationStore) {
  let id = 0
  let durable: ProjectRegistryStateV2 = makeFreshProjectRegistryV2({
    ...OWNER,
    workspaceRoot: '/Users/operator/workspace',
    nowIso: () => '2026-08-28T03:30:00.000Z',
    newId: () => `bootstrap-${++id}`,
    policy: POLICY,
  })
  const registry = makeProjectRegistryV2({
    state: durable,
    policy: POLICY,
    nowIso: () => '2026-08-28T03:30:00.000Z',
    newId: () => `registry-${++id}`,
    persistence: { saveAtomic: state => { durable = state } },
  })
  const switchAuthority = makeSwitchAuthority({
    secret: Buffer.alloc(32, 1),
    nowMs: () => Date.parse('2026-08-28T03:30:00.000Z'),
    newId: () => `switch-${++id}`,
    nonces: nonceStore(),
  })
  const rotationAuthority = makeSessionRotationAuthority({
    secret: Buffer.alloc(32, 2),
    nowMs: () => Date.parse('2026-08-28T03:30:00.000Z'),
    newId: () => `rotation-${++id}`,
    nonces: nonceStore(),
  })
  const service = makeProjectService({
    registry,
    leases: makeContextLeaseCoordinator({ newId: () => `lease-${++id}` }),
    authority: switchAuthority,
    rotationAuthority,
  })
  const labels = makeMemorySessionLabelStore()
  const creation = makeSessionCreationCoordinator({
    registry,
    service,
    labels,
    store: makeMemorySessionCreationStore(),
  })
  let record: DailySessionRotationRecord | null = null
  const store = storeOverride ?? {
    load: () => record === null ? null : structuredClone(record),
    save: (next: DailySessionRotationRecord) => { record = structuredClone(next) },
  }
  const make = () => makeDailySessionRotation({
    botId: 'bot-main',
    ...OWNER,
    registry,
    service,
    authority: rotationAuthority,
    store,
    creation,
  })
  return {
    make,
    registry,
    record: () => record,
    setRecord: (next: DailySessionRotationRecord) => { record = next },
    labels,
  }
}

describe('daily Session rotation', () => {
  it('persists a deterministic intent and switches to one new Session', async () => {
    const h = setup()
    const before = h.registry.getActive(OWNER)
    const coordinator = h.make()

    await coordinator.rotate('2026-08-28', { kind: 'session-only' })

    const after = h.registry.getActive(OWNER)
    expect(after.sessionId).not.toBe(before.sessionId)
    expect(after.generation).toBe(before.generation + 1)
    expect(coordinator.current()).toMatchObject({
      sourceSessionId: before.sessionId,
      newSessionId: after.sessionId,
      phase: 'switched',
      notice: { kind: 'session-only', sessionReset: true },
    })
    expect(h.labels.get(after.sessionId)).toMatchObject({ kind: 'temporary' })
    await coordinator.rotate('2026-08-28', { kind: 'session-only' })
    expect(h.registry.snapshot().sessions.filter(item => item.createKeyHash !== undefined))
      .toHaveLength(1)
  })

  it('recovers a crash after the registry switch without creating a duplicate', async () => {
    let record: DailySessionRotationRecord | null = null
    let failSwitchedSave = true
    const store: DailySessionRotationStore = {
      load: () => record,
      save: next => {
        if (next.phase === 'switched' && failSwitchedSave) {
          failSwitchedSave = false
          throw new Error('injected crash')
        }
        record = structuredClone(next)
      },
    }
    const h = setup(store)
    await expect(h.make().rotate('2026-08-28', { kind: 'complete-zero' }))
      .rejects.toThrow('injected crash')
    expect((store.load() as DailySessionRotationRecord | null)?.phase).toBe('preparing')
    expect(h.registry.snapshot().sessions.filter(item => item.createKeyHash !== undefined))
      .toHaveLength(1)

    const restarted = h.make()
    await restarted.rotate('2026-08-28', { kind: 'complete-zero' })

    expect(restarted.current()?.phase).toBe('switched')
    expect(h.registry.snapshot().sessions.filter(item => item.createKeyHash !== undefined))
      .toHaveLength(1)
  })

  it('dispatches the startup notice at most once and never retries ambiguity', async () => {
    const h = setup()
    const coordinator = h.make()
    await coordinator.rotate('2026-08-28', { kind: 'complete-n', pending: 2 })
    coordinator.markRestartRequested('2026-08-28')
    const send = vi.fn(async () => undefined)

    expect(await coordinator.recoverNotification(send)).toBe('delivered')
    expect(await h.make().recoverNotification(send)).toBe('none')
    expect(send).toHaveBeenCalledOnce()

    const delivered = coordinator.current()!
    h.setRecord({ ...delivered, localDate: '2026-08-29', phase: 'dispatching' })
    const afterCrash = h.make()
    expect(await afterCrash.recoverNotification(send)).toBe('ambiguous')
    expect(send).toHaveBeenCalledOnce()
    expect(afterCrash.current()?.phase).toBe('ambiguous')
  })

  it('fails closed on a corrupt durable record instead of rotating again', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-daily-session-state-'))
    roots.push(root)
    const path = join(root, 'rotation.json')
    writeFileSync(path, '{"schemaVersion":1,"phase":"switched"}\n', { mode: 0o600 })

    expect(() => makeNodeDailySessionRotationStore(path).load())
      .toThrow('DAILY_SESSION_ROTATION_STATE_CORRUPT')
  })
})
