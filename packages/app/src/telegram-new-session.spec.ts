import { describe, expect, it } from 'vitest'
import {
  makeContextLeaseCoordinator,
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  makeProjectService,
  makeSwitchAuthority,
} from '@aisy/core'

import { makeNewSessionRunner, makeResumeSessionRunner } from './telegram-new-session.js'
import type { NodeProjectServiceRuntime } from './project-service-runtime.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const POLICY = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: ['/Users/operator/.aisy'],
}

function setup() {
  let id = 0
  const registry = makeProjectRegistryV2({
    state: makeFreshProjectRegistryV2({
      ...OWNER,
      workspaceRoot: '/Users/operator/workspace',
      nowIso: () => '2026-08-07T12:00:00.000Z',
      newId: () => `bootstrap-${++id}`,
      policy: POLICY,
    }),
    policy: POLICY,
    nowIso: () => `2026-08-07T12:00:${String(++id).padStart(2, '0')}.000Z`,
    newId: () => `id-${++id}`,
    persistence: { saveAtomic: () => undefined },
  })
  const issued = new Map<string, string>()
  const authority = makeSwitchAuthority({
    secret: new Uint8Array(32).fill(7),
    nowMs: () => 1_700_000_000_000,
    newId: () => `receipt-${++id}`,
    nonces: {
      issue: (record) => { issued.set(record.receiptId, record.mac) },
      has: (receiptId, mac) => issued.get(receiptId) === mac,
      consume: (receiptId, mac) => {
        if (issued.get(receiptId) !== mac) return false
        issued.delete(receiptId)
        return true
      },
    },
  })
  const service = makeProjectService({
    registry,
    authority,
    leases: makeContextLeaseCoordinator({ newId: () => `lease-${++id}` }),
  })
  const runtime = { registry, authority, service } as Pick<
    NodeProjectServiceRuntime, 'registry' | 'authority' | 'service'
  >
  let request = 0
  return {
    registry,
    run: makeNewSessionRunner({
      runtime,
      owner: OWNER,
      newRequestId: () => `request-${++request}`,
    }),
    resume: makeResumeSessionRunner({
      runtime,
      owner: OWNER,
      newRequestId: () => `request-${++request}`,
    }),
    service,
  }
}

describe('new session', () => {
  it('creates a session and makes it the active context', async () => {
    const h = setup()
    const before = h.registry.getActive(OWNER)

    const result = await h.run()

    expect(result.ok).toBe(true)
    const active = h.registry.getActive(OWNER)
    // Creating alone was never enough: the operator kept talking into the old
    // session while the new one sat unused.
    expect(active.sessionId).not.toBe(before.sessionId)
    if (result.ok) expect(active.sessionId).toBe(result.session.id)
    expect(active.projectId).toBe(before.projectId)
    expect(active.generation).toBe(before.generation + 1)
  })

  it('keeps the operator’s name for the session', async () => {
    const h = setup()

    const result = await h.run('  Разбор почты  ')

    expect(result.ok && result.session.name).toBe('Разбор почты')
  })

  it('mints a distinct receipt per tap, so one cannot be replayed', async () => {
    const h = setup()

    const first = await h.run()
    const second = await h.run()

    expect(first.ok && second.ok).toBe(true)
    expect(h.registry.getActive(OWNER).generation).toBe(3)
  })

  it('reports a stable code instead of registry internals', async () => {
    const h = setup()
    const broken = makeNewSessionRunner({
      runtime: {
        registry: h.registry,
        authority: { issue: () => { throw new Error('boom') } },
        service: { createSession: () => { throw Object.assign(new Error('x'), { code: 'NO' }) } },
      } as never,
      owner: OWNER,
      newRequestId: () => 'request-x',
    })

    await expect(broken()).resolves.toEqual({ ok: false, errorCode: 'NO' })
  })
})

describe('resuming a session', () => {
  it('enters a session the operator left earlier', async () => {
    const h = setup()
    const first = h.registry.getActive(OWNER)
    await h.run('Второй разговор')
    const second = h.registry.getActive(OWNER)
    expect(second.sessionId).not.toBe(first.sessionId)

    const result = await h.resume(first.sessionId)

    expect(result.ok).toBe(true)
    expect(h.registry.getActive(OWNER).sessionId).toBe(first.sessionId)
  })

  it('does not create anything — the session count stays put', async () => {
    const h = setup()
    const first = h.registry.getActive(OWNER)
    await h.run('Второй разговор')
    const before = h.service.searchSessions({
      ...OWNER, projectId: first.projectId, query: '',
    }).length

    await h.resume(first.sessionId)

    expect(h.service.searchSessions({ ...OWNER, projectId: first.projectId, query: '' }))
      .toHaveLength(before)
  })

  it('refuses to re-enter the session already open', async () => {
    const h = setup()
    const active = h.registry.getActive(OWNER)

    await expect(h.resume(active.sessionId)).resolves.toEqual({
      ok: false, errorCode: 'ALREADY_ACTIVE',
    })
  })

  it('refuses an unknown session instead of switching somewhere', async () => {
    const h = setup()
    const before = h.registry.getActive(OWNER)

    const result = await h.resume('session-that-never-existed')

    expect(result.ok).toBe(false)
    expect(h.registry.getActive(OWNER)).toEqual(before)
  })
})
