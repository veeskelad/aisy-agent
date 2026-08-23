import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  makeContextLeaseCoordinator,
  makeFreshProjectRegistryV2,
  makeProjectLifecycleAuthority,
  makeProjectRegistryV2,
  makeProjectService,
  type ProjectLifecycleAuthorityBinding,
  type ProjectLifecycleAuthorityIssuer,
  type ProjectLifecycleAuthorityNonceRecord,
  type SwitchAuthority,
} from '@aisy/core'

import type { NodeProjectServiceRuntime } from './project-service-runtime.js'
import {
  makeTelegramProjectLifecycleControls,
  TelegramProjectLifecycleControlsError,
} from './telegram-project-lifecycle-controls.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const START = Date.parse('2026-07-28T12:00:00.000Z')

function setup(options: { duplicateNames?: boolean } = {}) {
  let now = START
  let id = 0
  const policy = {
    homeRoot: '/Users/operator',
    projectsRoot: '/Users/operator/projects',
    protectedRoots: ['/Users/operator/.aisy'],
  }
  const registry = makeProjectRegistryV2({
    state: makeFreshProjectRegistryV2({
      ...OWNER,
      workspaceRoot: '/Users/operator/workspace',
      nowIso: () => new Date(now).toISOString(),
      newId: () => `bootstrap-${++id}`,
      policy,
    }),
    policy,
    nowIso: () => new Date(now).toISOString(),
    newId: () => `record-${++id}`,
    persistence: { saveAtomic: () => undefined },
  })
  const selected = registry.createProject({
    ...OWNER,
    name: 'Project A',
    slug: 'project-a',
    root: join(policy.projectsRoot, 'project-a'),
    origin: 'created',
  })
  if (options.duplicateNames) {
    registry.createProject({
      ...OWNER,
      name: 'PROJECT A',
      slug: 'project-a-second',
      root: join(policy.projectsRoot, 'project-a-second'),
      origin: 'created',
    })
  }
  const nonces = new Map<string, ProjectLifecycleAuthorityNonceRecord>()
  const issued: ProjectLifecycleAuthorityBinding[] = []
  const baseAuthority = makeProjectLifecycleAuthority({
    secret: Buffer.alloc(32, 7),
    nowMs: () => now,
    newId: () => `lifecycle-${++id}`,
    nonces: {
      issue(record) {
        nonces.set(record.receiptId, record)
      },
      consume(receiptId, mac) {
        const record = nonces.get(receiptId)
        if (record?.mac !== mac) return false
        nonces.delete(receiptId)
        return true
      },
    },
  })
  const authority: ProjectLifecycleAuthorityIssuer = {
    issue(binding, ttlMs) {
      issued.push(structuredClone(binding))
      return baseAuthority.issue(binding, ttlMs)
    },
    consume(receipt, expected) {
      baseAuthority.consume(receipt, expected)
    },
  }
  const switchAuthority = {
    issue: () => { throw new Error('not used') },
    validate: () => { throw new Error('not used') },
    isIssued: () => false,
    markConsumed: () => false,
    consume: () => { throw new Error('not used') },
  } as SwitchAuthority
  const service = makeProjectService({
    registry,
    authority: switchAuthority,
    leases: makeContextLeaseCoordinator({ newId: () => `lease-${++id}` }),
    lifecycle: { authority, validateRestorableRoot: () => undefined },
  })
  const runtime = { registry, service } as Pick<NodeProjectServiceRuntime, 'registry' | 'service'>
  let token = 0
  const controls = makeTelegramProjectLifecycleControls({
    runtime,
    authority,
    owner: OWNER,
    nowMs: () => now,
    newTokenId: () => `token-${String(++token).padStart(16, '0')}`,
  })
  return {
    authority,
    controls,
    issued,
    registry,
    runtime,
    selected,
    advance: (milliseconds: number) => { now += milliseconds },
  }
}

function button(
  outcome: Awaited<ReturnType<ReturnType<typeof makeTelegramProjectLifecycleControls>['handleAuthenticatedText']>>,
  decision: 'confirm' | 'cancel',
): string {
  if (outcome?.kind !== 'confirmation') throw new Error('confirmation expected')
  const candidate = outcome.view.buttons.flat().find((item) => item.data.includes(`:${decision}:`))
  if (candidate === undefined) throw new Error(`${decision} button expected`)
  return candidate.data
}

describe('Telegram Project lifecycle confirmation controls', () => {
  it('archives a Project only after exact RU confirmation and binds complete provenance', async () => {
    const { controls, issued, registry, selected } = setup()
    const text = 'архивируй текущий проект'
    const before = registry.snapshot()

    const requested = await controls.handleAuthenticatedText({ text, chatId: 42, updateId: 10 })

    expect(requested).toMatchObject({
      kind: 'confirmation',
      action: 'project.archive',
      projectId: selected.projectId,
    })
    expect(issued).toEqual([])
    expect(registry.snapshot()).toEqual(before)
    const confirmData = button(requested, 'confirm')
    expect(Buffer.byteLength(confirmData, 'utf8')).toBeLessThanOrEqual(64)

    const archived = await controls.handleAuthenticatedCallback({
      data: confirmData,
      chatId: 42,
      updateId: 11,
    })

    expect(archived).toMatchObject({
      kind: 'archived',
      action: 'project.archive',
      projectId: selected.projectId,
      generation: selected.generation + 1,
    })
    expect(issued).toHaveLength(1)
    const opaque = confirmData.slice('project-lifecycle:v1:confirm:'.length)
    const identityHash = createHash('sha256').update(JSON.stringify([
      'aisy.telegram-project-lifecycle.target-identity.v1',
      'project',
      selected.projectId,
      null,
      'Project A',
    ])).digest('hex')
    const expectedSourceHash = createHash('sha256').update(JSON.stringify([
      'aisy.telegram-project-lifecycle.v1',
      OWNER.operatorId,
      OWNER.profileId,
      42,
      10,
      createHash('sha256').update(text.normalize('NFKC')).digest('hex'),
      42,
      11,
      'project.archive',
      selected.projectId,
      null,
      selected.generation,
      identityHash,
      opaque,
    ])).digest('hex')
    expect(issued[0]).toEqual({
      ...OWNER,
      action: 'project.archive',
      projectId: selected.projectId,
      expectedGeneration: selected.generation,
      sourceMessageHash: expectedSourceHash,
    })
    expect(registry.listContexts(OWNER, true)
      .find((item) => item.id === selected.projectId)?.archivedAt).toBeDefined()
    expect(registry.listContexts(OWNER)
      .find((item) => item.id === registry.getActive(OWNER).projectId)?.kind).toBe('workspace')
  })

  it('archives the current Session through the same EN two-step flow and replaces selection', async () => {
    const { controls, issued, registry, selected } = setup()
    const requested = await controls.handleAuthenticatedText({
      text: 'archive current session', chatId: 42, updateId: 20,
    })
    expect(requested).toMatchObject({
      kind: 'confirmation',
      action: 'session.archive',
      projectId: selected.projectId,
      sessionId: selected.sessionId,
    })
    expect(issued).toEqual([])

    const archived = await controls.handleAuthenticatedCallback({
      data: button(requested, 'confirm'), chatId: 42, updateId: 21,
    })

    expect(archived).toMatchObject({ kind: 'archived', action: 'session.archive' })
    expect(registry.getActive(OWNER)).toMatchObject({
      projectId: selected.projectId,
      generation: selected.generation + 1,
    })
    expect(registry.getActive(OWNER).sessionId).not.toBe(selected.sessionId)
    expect(() => registry.getSession({
      ...OWNER, projectId: selected.projectId, sessionId: selected.sessionId,
    })).toThrowError(expect.objectContaining({ code: 'SESSION_ARCHIVED' }))
  })

  it('makes cancel, replay and expiry one-use without issuing archive authority', async () => {
    const { advance, controls, issued, registry } = setup()
    const before = registry.snapshot()
    const first = await controls.handleAuthenticatedText({
      text: 'archive project project-a', chatId: 42, updateId: 30,
    })
    const confirmData = button(first, 'confirm')
    await expect(controls.handleAuthenticatedCallback({
      data: button(first, 'cancel'), chatId: 42, updateId: 31,
    })).resolves.toMatchObject({ kind: 'cancelled' })
    await expect(controls.handleAuthenticatedCallback({
      data: confirmData, chatId: 42, updateId: 32,
    })).resolves.toMatchObject({ kind: 'stale' })

    const expiring = await controls.handleAuthenticatedText({
      text: 'архивируй проект Project A', chatId: 42, updateId: 33,
    })
    advance(120_000)
    await expect(controls.handleAuthenticatedCallback({
      data: button(expiring, 'confirm'), chatId: 42, updateId: 34,
    })).resolves.toMatchObject({ kind: 'stale' })
    expect(issued).toEqual([])
    expect(registry.snapshot()).toEqual(before)
  })

  it('fails closed on rename identity drift and generation drift before authority issue', async () => {
    const first = setup()
    const renameRequest = await first.controls.handleAuthenticatedText({
      text: 'archive current session', chatId: 42, updateId: 40,
    })
    first.runtime.service.renameSession({
      ...OWNER,
      projectId: first.selected.projectId,
      sessionId: first.selected.sessionId,
      name: 'Renamed after request',
      expectedGeneration: first.selected.generation,
    })
    await expect(first.controls.handleAuthenticatedCallback({
      data: button(renameRequest, 'confirm'), chatId: 42, updateId: 41,
    })).resolves.toMatchObject({ kind: 'stale' })
    expect(first.issued).toEqual([])

    const second = setup()
    const generationRequest = await second.controls.handleAuthenticatedText({
      text: 'archive current session', chatId: 42, updateId: 42,
    })
    const created = second.registry.createSession({
      ...OWNER, projectId: second.selected.projectId, name: 'Concurrent',
    })
    second.registry.switchContext({
      ...OWNER,
      projectId: second.selected.projectId,
      sessionId: created.id,
      expectedGeneration: second.selected.generation,
    })
    await expect(second.controls.handleAuthenticatedCallback({
      data: button(generationRequest, 'confirm'), chatId: 42, updateId: 43,
    })).resolves.toMatchObject({ kind: 'stale' })
    expect(second.issued).toEqual([])
  })

  it('rejects ambiguity, Workspace, ordinary dialogue, foreign identity and malformed callbacks', async () => {
    const { controls, issued, registry } = setup({ duplicateNames: true })
    await expect(controls.handleAuthenticatedText({
      text: 'archive project Project A', chatId: 42, updateId: 50,
    })).resolves.toMatchObject({ kind: 'unavailable' })
    await expect(controls.handleAuthenticatedText({
      text: 'архивируй проект Workspace', chatId: 42, updateId: 51,
    })).resolves.toMatchObject({ kind: 'unavailable' })
    await expect(controls.handleAuthenticatedText({
      text: 'объясни, как устроен архив', chatId: 42, updateId: 52,
    })).resolves.toBeNull()
    await expect(controls.handleAuthenticatedText({
      text: 'archive current project', chatId: 777, updateId: 53,
    })).rejects.toThrowError(new TelegramProjectLifecycleControlsError('AUTHENTICATION_MISMATCH'))
    await expect(controls.handleAuthenticatedCallback({
      data: 'project-lifecycle:v1:confirm:forged', chatId: 42, updateId: 54,
    })).resolves.toMatchObject({ kind: 'stale' })
    await expect(controls.handleAuthenticatedCallback({
      data: 'xproject-lifecycle:v1:confirm:12345678.token-1', chatId: 42, updateId: 55,
    })).resolves.toMatchObject({ kind: 'stale' })
    expect(issued).toEqual([])
    expect(registry.listContexts(OWNER, true).every((item) => item.archivedAt === undefined)).toBe(true)
  })

  it('binds request and confirmation updates, and does not let a foreign callback retire the token', async () => {
    const { controls, issued } = setup()
    const requested = await controls.handleAuthenticatedText({
      text: 'archive current project', chatId: 42, updateId: 60,
    })
    const confirmData = button(requested, 'confirm')
    await expect(controls.handleAuthenticatedCallback({
      data: confirmData, chatId: 777, updateId: 61,
    })).rejects.toThrowError(new TelegramProjectLifecycleControlsError('AUTHENTICATION_MISMATCH'))
    await expect(controls.handleAuthenticatedCallback({
      data: confirmData, chatId: 42, updateId: 60,
    })).resolves.toMatchObject({ kind: 'stale' })
    expect(issued).toEqual([])
    await expect(controls.handleAuthenticatedCallback({
      data: confirmData, chatId: 42, updateId: 61,
    })).resolves.toMatchObject({ kind: 'archived' })
  })

  it('uses one replay domain across text commands and callbacks', async () => {
    const { controls, issued } = setup()
    const requested = await controls.handleAuthenticatedText({
      text: 'archive current project', chatId: 42, updateId: 62,
    })
    const confirmData = button(requested, 'confirm')
    await expect(controls.handleAuthenticatedText({
      text: 'archive project Workspace', chatId: 42, updateId: 63,
    })).resolves.toMatchObject({ kind: 'unavailable' })

    await expect(controls.handleAuthenticatedCallback({
      data: confirmData, chatId: 42, updateId: 63,
    })).resolves.toMatchObject({ kind: 'stale' })
    expect(issued).toEqual([])
    await expect(controls.handleAuthenticatedCallback({
      data: confirmData, chatId: 42, updateId: 64,
    })).resolves.toMatchObject({ kind: 'archived' })
  })

  it('spends an authenticated request update before unavailable target resolution', async () => {
    const { controls, issued, registry } = setup({ duplicateNames: true })
    const initial = registry.getActive(OWNER)
    const duplicate = registry.listContexts(OWNER)
      .find((item) => item.kind === 'project' && item.id !== initial.projectId)!

    await expect(controls.handleAuthenticatedText({
      text: 'archive project Project A', chatId: 42, updateId: 65,
    })).resolves.toMatchObject({ kind: 'unavailable' })
    registry.archiveProject({
      ...OWNER,
      projectId: duplicate.id,
      expectedGeneration: initial.generation,
    })

    await expect(controls.handleAuthenticatedText({
      text: 'archive project Project A', chatId: 42, updateId: 65,
    })).resolves.toMatchObject({ kind: 'stale' })
    expect(issued).toEqual([])
    expect(registry.listContexts(OWNER, true)
      .find((item) => item.id === initial.projectId)?.archivedAt).toBeUndefined()
  })

  it('spends an authenticated callback update before payload parsing', async () => {
    const { controls, issued } = setup()
    const requested = await controls.handleAuthenticatedText({
      text: 'archive current project', chatId: 42, updateId: 66,
    })
    const confirmData = button(requested, 'confirm')

    await expect(controls.handleAuthenticatedCallback({
      data: 'malformed', chatId: 42, updateId: 67,
    })).resolves.toMatchObject({ kind: 'stale' })
    await expect(controls.handleAuthenticatedCallback({
      data: confirmData, chatId: 42, updateId: 67,
    })).resolves.toMatchObject({ kind: 'stale' })
    expect(issued).toEqual([])
    await expect(controls.handleAuthenticatedCallback({
      data: confirmData, chatId: 42, updateId: 68,
    })).resolves.toMatchObject({ kind: 'archived' })
  })

  it('redacts registry and service lookup failures before authority issue', async () => {
    const registryFailure = setup()
    const registryControls = makeTelegramProjectLifecycleControls({
      runtime: {
        registry: {
          ...registryFailure.registry,
          listContexts: () => { throw new Error('/private/operator/registry') },
        },
        service: registryFailure.runtime.service,
      },
      authority: registryFailure.authority,
      owner: OWNER,
      nowMs: () => START,
      newTokenId: () => 'registry-token-1234',
    })
    await expect(registryControls.handleAuthenticatedText({
      text: 'archive current project', chatId: 42, updateId: 69,
    })).resolves.toMatchObject({ kind: 'unavailable' })
    expect(registryFailure.issued).toEqual([])

    const serviceFailure = setup()
    const serviceControls = makeTelegramProjectLifecycleControls({
      runtime: {
        registry: serviceFailure.registry,
        service: {
          ...serviceFailure.runtime.service,
          searchSessions: () => { throw new Error('/private/operator/sessions') },
        },
      },
      authority: serviceFailure.authority,
      owner: OWNER,
      nowMs: () => START,
      newTokenId: () => 'service-token-12345',
    })
    await expect(serviceControls.handleAuthenticatedText({
      text: 'archive current session', chatId: 42, updateId: 70,
    })).resolves.toMatchObject({ kind: 'unavailable' })
    expect(serviceFailure.issued).toEqual([])

    const callbackFailure = setup()
    let rejectLookup = false
    const callbackControls = makeTelegramProjectLifecycleControls({
      runtime: {
        registry: {
          ...callbackFailure.registry,
          getActive(owner) {
            if (rejectLookup) throw new Error('/private/operator/selection')
            return callbackFailure.registry.getActive(owner)
          },
        },
        service: callbackFailure.runtime.service,
      },
      authority: callbackFailure.authority,
      owner: OWNER,
      nowMs: () => START,
      newTokenId: () => 'callback-token-1234',
    })
    const requested = await callbackControls.handleAuthenticatedText({
      text: 'archive current project', chatId: 42, updateId: 71,
    })
    rejectLookup = true
    await expect(callbackControls.handleAuthenticatedCallback({
      data: button(requested, 'confirm'), chatId: 42, updateId: 72,
    })).resolves.toMatchObject({ kind: 'stale' })
    expect(callbackFailure.issued).toEqual([])
  })

  it('rejects token collisions and keeps a failed confirmed action one-use', async () => {
    const first = setup()
    const collision = makeTelegramProjectLifecycleControls({
      runtime: first.runtime,
      authority: first.authority,
      owner: OWNER,
      nowMs: () => START,
      newTokenId: () => 'same-token-123456',
    })
    await collision.handleAuthenticatedText({
      text: 'archive current project', chatId: 42, updateId: 70,
    })
    await expect(collision.handleAuthenticatedText({
      text: 'archive current session', chatId: 42, updateId: 71,
    })).rejects.toThrowError(new TelegramProjectLifecycleControlsError('TOKEN_COLLISION'))

    const second = setup()
    const failing = makeTelegramProjectLifecycleControls({
      runtime: {
        registry: second.registry,
        service: {
          ...second.runtime.service,
          archiveProject: async () => { throw new Error('simulated service failure') },
        },
      },
      authority: second.authority,
      owner: OWNER,
      nowMs: () => START,
      newTokenId: () => 'failure-token-1234',
    })
    const requested = await failing.handleAuthenticatedText({
      text: 'archive current project', chatId: 42, updateId: 72,
    })
    const confirmData = button(requested, 'confirm')
    await expect(failing.handleAuthenticatedCallback({
      data: confirmData, chatId: 42, updateId: 73,
    })).resolves.toMatchObject({ kind: 'stale' })
    expect(second.issued).toHaveLength(1)
    await expect(failing.handleAuthenticatedCallback({
      data: confirmData, chatId: 42, updateId: 74,
    })).resolves.toMatchObject({ kind: 'stale' })
    expect(second.issued).toHaveLength(1)
  })

  it('validates bounded TTL configuration', () => {
    const { authority, runtime } = setup()
    expect(() => makeTelegramProjectLifecycleControls({
      runtime, authority, owner: OWNER, confirmationTtlMs: 300_001,
    })).toThrowError(new TelegramProjectLifecycleControlsError('INVALID_CONFIGURATION'))
    expect(() => makeTelegramProjectLifecycleControls({
      runtime, authority, owner: OWNER, receiptTtlMs: 0,
    })).toThrowError(new TelegramProjectLifecycleControlsError('INVALID_CONFIGURATION'))
  })

  it('rejects generated callback tokens shorter than sixteen characters', async () => {
    const { authority, runtime } = setup()
    const controls = makeTelegramProjectLifecycleControls({
      runtime,
      authority,
      owner: OWNER,
      nowMs: () => START,
      newTokenId: () => 'short-token',
    })
    await expect(controls.handleAuthenticatedText({
      text: 'archive current project', chatId: 42, updateId: 80,
    })).rejects.toThrowError(new TelegramProjectLifecycleControlsError('TOKEN_COLLISION'))
  })
})
