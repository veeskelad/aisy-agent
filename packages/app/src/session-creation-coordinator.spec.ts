import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeContextLeaseCoordinator,
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  makeProjectService,
  type ProjectRegistryStateV2,
  type SwitchAuthority,
} from '@aisy/core'

import {
  makeMemorySessionCreationStore,
  makeNodeSessionCreationStore,
  makeSessionCreationCoordinator,
  type SessionCreationStateV1,
} from './session-creation-coordinator.js'
import { makeMemorySessionLabelStore } from './session-label-store.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const POLICY = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: ['/Users/operator/.aisy'],
}
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(input: {
  creationState?: SessionCreationStateV1
  failCreationSaveAt?: number
} = {}) {
  let id = 0
  let durableRegistry: ProjectRegistryStateV2 = makeFreshProjectRegistryV2({
    ...OWNER,
    workspaceRoot: '/Users/operator/workspace',
    nowIso: () => '2026-08-29T10:00:00.000Z',
    newId: () => `bootstrap-${++id}`,
    policy: POLICY,
  })
  const registry = makeProjectRegistryV2({
    state: durableRegistry,
    policy: POLICY,
    nowIso: () => '2026-08-29T10:00:00.000Z',
    newId: () => `registry-${++id}`,
    persistence: { saveAtomic: (state) => { durableRegistry = state } },
  })
  const service = makeProjectService({
    registry,
    authority: {} as SwitchAuthority,
    leases: makeContextLeaseCoordinator({ newId: () => `lease-${++id}` }),
  })
  let durableCreation = structuredClone(input.creationState ?? {
    schemaVersion: 1 as const,
    records: [],
  })
  let saves = 0
  const store = makeMemorySessionCreationStore({
    initial: durableCreation,
    save: (state) => {
      saves += 1
      if (saves === input.failCreationSaveAt) throw new Error('injected creation WAL crash')
      durableCreation = structuredClone(state)
    },
  })
  const labels = makeMemorySessionLabelStore()
  const make = () => makeSessionCreationCoordinator({ registry, service, labels, store })
  return { registry, service, labels, make, creationState: () => durableCreation }
}

describe('session creation coordinator', () => {
  it('publishes one deterministic Session and temporary label', () => {
    const h = setup()
    const active = h.registry.getActive(OWNER)
    const coordinator = h.make()

    const first = coordinator.create({
      ...OWNER,
      projectId: active.projectId,
      expectedGeneration: active.generation,
      requestKey: 'telegram-update:10',
    })
    h.registry.switchContext({
      ...OWNER,
      projectId: active.projectId,
      sessionId: first.id,
      expectedGeneration: active.generation,
    })
    const afterSwitch = h.registry.getActive(OWNER)
    const replay = coordinator.create({
      ...OWNER,
      projectId: active.projectId,
      expectedGeneration: afterSwitch.generation,
      requestKey: 'telegram-update:10',
    })

    expect(replay.id).toBe(first.id)
    expect(first.name).toBe('Новая сессия')
    expect(h.labels.get(first.id)).toMatchObject({ kind: 'temporary', revision: 1 })
    expect(h.service.searchSessions({ ...OWNER, projectId: active.projectId, query: '' })
      .filter((session) => session.id === first.id)).toHaveLength(1)
    expect(h.creationState().records).toMatchObject([{ phase: 'terminal' }])
  })

  it('marks an operator-provided creation name explicit', () => {
    const h = setup()
    const active = h.registry.getActive(OWNER)
    const created = h.make().create({
      ...OWNER,
      projectId: active.projectId,
      expectedGeneration: active.generation,
      requestKey: 'telegram-update:11',
      name: 'Разбор почты',
    })

    expect(created.name).toBe('Разбор почты')
    expect(h.labels.get(created.id)).toMatchObject({ kind: 'explicit', revision: 1 })
  })

  it('accepts exactly 64 astral Unicode symbols through WAL and registry', () => {
    const h = setup()
    const active = h.registry.getActive(OWNER)
    const name = '😀'.repeat(64)
    const created = h.make().create({
      ...OWNER,
      projectId: active.projectId,
      expectedGeneration: active.generation,
      requestKey: 'telegram-update:astral-name',
      name,
    })

    expect(created.name).toBe(name)
    expect(h.labels.get(created.id)).toMatchObject({ kind: 'explicit' })
  })

  it('rejects unsafe or overlong names before publishing creation state', () => {
    const h = setup()
    const active = h.registry.getActive(OWNER)
    const coordinator = h.make()

    expect(() => coordinator.create({
      ...OWNER,
      projectId: active.projectId,
      expectedGeneration: active.generation,
      requestKey: 'telegram-update:unsafe-name',
      name: '<b>Скрытая разметка</b>',
    })).toThrow('SESSION_NAME_INVALID')
    expect(() => coordinator.create({
      ...OWNER,
      projectId: active.projectId,
      expectedGeneration: active.generation,
      requestKey: 'telegram-update:long-name',
      name: 'я'.repeat(65),
    })).toThrow('SESSION_NAME_INVALID')
    expect(() => coordinator.create({
      ...OWNER,
      projectId: active.projectId,
      expectedGeneration: active.generation,
      requestKey: 'telegram-update:control-name',
      name: 'Два\tслова',
    })).toThrow('SESSION_NAME_INVALID')
    expect(coordinator.snapshot().records).toEqual([])
  })

  it('rejects replaying one creation identity with different semantics', () => {
    const h = setup()
    const active = h.registry.getActive(OWNER)
    const coordinator = h.make()
    coordinator.create({
      ...OWNER,
      projectId: active.projectId,
      expectedGeneration: active.generation,
      requestKey: 'telegram-update:conflict',
      name: 'Первая тема',
    })

    expect(() => coordinator.create({
      ...OWNER,
      projectId: active.projectId,
      expectedGeneration: active.generation,
      requestKey: 'telegram-update:conflict',
      name: 'Другая тема',
    })).toThrow('SESSION_CREATION_IDENTITY_CONFLICT')
    expect(h.service.searchSessions({ ...OWNER, projectId: active.projectId, query: '' })
      .filter((session) => session.name === 'Первая тема')).toHaveLength(1)
  })

  it('repairs a crash after registry publication without creating a duplicate', () => {
    const h = setup({ failCreationSaveAt: 2 })
    const active = h.registry.getActive(OWNER)
    expect(() => h.make().create({
      ...OWNER,
      projectId: active.projectId,
      expectedGeneration: active.generation,
      requestKey: 'telegram-update:12',
    })).toThrow('injected creation WAL crash')

    const published = h.service.searchSessions({
      ...OWNER, projectId: active.projectId, query: 'Новая сессия',
    })
    expect(published).toHaveLength(1)
    expect(h.labels.get(published[0]!.id)).toBeNull()

    const restarted = makeSessionCreationCoordinator({
      registry: h.registry,
      service: h.service,
      labels: h.labels,
      store: makeMemorySessionCreationStore({ initial: h.creationState() }),
    })
    expect(restarted.repair()).toEqual({ repaired: 1, cancelled: 0 })
    expect(h.labels.get(published[0]!.id)).toMatchObject({ kind: 'temporary' })
    expect(h.service.searchSessions({ ...OWNER, projectId: active.projectId, query: 'Новая сессия' }))
      .toHaveLength(1)
  })

  it('cancels a prepared record when no registry row was ever published', () => {
    const h = setup()
    const active = h.registry.getActive(OWNER)
    const coordinator = h.make()
    coordinator.prepareExternal({
      ...OWNER,
      projectId: active.projectId,
      expectedGeneration: active.generation,
      sessionId: 'session-never-published',
      createKeyHash: 'b'.repeat(64),
      name: 'Новая сессия',
      labelKind: 'temporary',
    })

    expect(coordinator.repair()).toEqual({ repaired: 0, cancelled: 1 })
    expect(h.labels.get('session-never-published')).toBeNull()
    expect(h.creationState().records).toMatchObject([{ phase: 'cancelled' }])
  })

  it('persists private atomic JSON and fails closed on corrupt bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-session-creations-'))
    roots.push(root)
    const path = join(root, 'creations.json')
    const store = makeNodeSessionCreationStore(path)

    store.save({ schemaVersion: 1, records: [] })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schemaVersion: 1, records: [] })

    writeFileSync(path, '{"schemaVersion":1,"records":[],"unexpected":true}\n', { mode: 0o600 })
    expect(() => makeNodeSessionCreationStore(path)).toThrow('SESSION_CREATION_STATE_CORRUPT')
  })
})
