import { describe, expect, it } from 'vitest'
import {
  makeContextLeaseCoordinator,
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  makeProjectService,
  type SwitchAuthority,
} from '@aisy/core'
import type { NodeProjectServiceRuntime } from './project-service-runtime.js'
import {
  makeTelegramSessionControls,
  TelegramSessionControlsError,
} from './telegram-session-controls.js'
import {
  makeMemorySessionCreationStore,
  makeSessionCreationCoordinator,
} from './session-creation-coordinator.js'
import { makeMemorySessionLabelStore } from './session-label-store.js'
import type { SessionDeletionCoordinator, SessionDeletionRecordV1 } from './session-deletion.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const POLICY = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: ['/Users/operator/.aisy'],
}

function setup(input: {
  labelSave?: () => void
  deletion?: Pick<SessionDeletionCoordinator, 'deleteConfirmed'>
  transcript?: { describe(sessionId: string): Promise<{ transcriptHead: string; turns: number }> }
} = {}) {
  let id = 0
  const registry = makeProjectRegistryV2({
    state: makeFreshProjectRegistryV2({
      ...OWNER,
      workspaceRoot: '/Users/operator/workspace',
      nowIso: () => '2026-07-27T12:00:00.000Z',
      newId: () => `bootstrap-${++id}`,
      policy: POLICY,
    }),
    policy: POLICY,
    nowIso: () => `2026-07-27T12:00:${String(++id).padStart(2, '0')}.000Z`,
    newId: () => `session-${++id}`,
    persistence: { saveAtomic: () => undefined },
  })
  const authority = {
    issue: () => { throw new Error('not used') },
    validate: () => { throw new Error('not used') },
    isIssued: () => false,
    markConsumed: () => false,
    consume: () => { throw new Error('not used') },
  } as SwitchAuthority
  const service = makeProjectService({
    registry,
    authority,
    leases: makeContextLeaseCoordinator({ newId: () => `lease-${++id}` }),
  })
  const runtime = { registry, service } as Pick<NodeProjectServiceRuntime, 'registry' | 'service'>
  const labels = makeMemorySessionLabelStore(
    input.labelSave === undefined ? {} : { save: input.labelSave },
  )
  const creation = makeSessionCreationCoordinator({
    registry,
    service,
    labels,
    store: makeMemorySessionCreationStore(),
  })
  return {
    controls: makeTelegramSessionControls({
      runtime,
      owner: OWNER,
      creation,
      labels,
      ...(input.deletion === undefined ? {} : { deletion: input.deletion }),
      ...(input.transcript === undefined ? {} : { transcript: input.transcript }),
    }),
    registry,
    runtime,
    labels,
    creation,
  }
}

describe('makeTelegramSessionControls', () => {
  it('lists, creates, renames and searches through ProjectService without switching session', () => {
    const { controls, registry, labels } = setup()
    const before = registry.getActive(OWNER)

    const created = controls.handleAuthenticatedText({
      text: 'создай сессию «MCP проверка»', chatId: 42, updateId: 1,
    })
    expect(created).toMatchObject({ kind: 'created', session: { name: 'MCP проверка' } })
    expect(registry.getActive(OWNER)).toEqual(before)

    const renamed = controls.handleAuthenticatedText({
      text: 'rename current session to Main work', chatId: 42, updateId: 2,
    })
    expect(renamed).toMatchObject({ kind: 'renamed', session: { id: before.sessionId, name: 'Main work' } })
    expect(labels.get(before.sessionId)).toMatchObject({ kind: 'explicit', revision: 1 })

    const found = controls.handleAuthenticatedText({
      text: 'найди сессии mcp', chatId: 42, updateId: 3,
    })
    expect(found).toMatchObject({
      kind: 'view',
      view: { sessions: [{ name: 'MCP проверка' }], generation: before.generation },
    })
  })

  it('rejects a foreign transport identity before any mutation', () => {
    const { controls, registry } = setup()
    const before = registry.snapshot()

    expect(() => controls.handleAuthenticatedText({
      text: 'create session Foreign', chatId: 777, updateId: 4,
    })).toThrowError(new TelegramSessionControlsError('AUTHENTICATION_MISMATCH'))
    expect(registry.snapshot()).toEqual(before)
  })

  it('validates before publishing an explicit-name fence', () => {
    const { controls, registry, labels } = setup()
    const before = registry.getActive(OWNER)
    const original = registry.getSession({ ...OWNER, ...before })
    labels.markTemporary(before.sessionId)

    expect(() => controls.rename(before.sessionId, '<b>Новое имя</b>'))
      .toThrow('SESSION_NAME_INVALID')
    expect(registry.getSession({ ...OWNER, ...before }).name).toBe(original.name)
    expect(labels.get(before.sessionId)).toMatchObject({ kind: 'temporary', revision: 1 })
  })

  it('renames to exactly 64 astral symbols without stranding the explicit fence', () => {
    const { controls, registry, labels } = setup()
    const before = registry.getActive(OWNER)
    const name = '😀'.repeat(64)
    labels.markTemporary(before.sessionId)

    expect(controls.rename(before.sessionId, name)).toMatchObject({
      kind: 'renamed', session: { name },
    })
    expect(labels.get(before.sessionId)).toMatchObject({ kind: 'explicit', revision: 2 })
  })

  it('does not rename the registry when the explicit-name fence is not durable', () => {
    const { controls, registry } = setup({
      labelSave: () => { throw new Error('injected label persistence failure') },
    })
    const before = registry.getActive(OWNER)
    const original = registry.getSession({ ...OWNER, ...before })

    expect(() => controls.rename(before.sessionId, 'Новое имя'))
      .toThrow('injected label persistence failure')
    expect(registry.getSession({ ...OWNER, ...before }).name).toBe(original.name)
  })

  it('does not consume ordinary dialogue and supports the default session name', () => {
    const { controls } = setup()

    expect(controls.handleAuthenticatedText({
      text: 'расскажи про текущую сессию', chatId: 42, updateId: 5,
    })).toBeNull()
    expect(controls.handleAuthenticatedText({
      text: 'новая сессия', chatId: 42, updateId: 6,
    })).toMatchObject({ kind: 'created', session: { name: 'Новая сессия' } })
  })

  it('fails closed when selection generation changes after command capture', () => {
    const { registry, runtime } = setup()
    const original = runtime.service
    let raced = false
    const controls = makeTelegramSessionControls({
      owner: OWNER,
      runtime: {
        registry,
        service: {
          ...original,
          createSession(input) {
            if (!raced) {
              raced = true
              registry.createProject({
                ...OWNER,
                name: 'Concurrent switch',
                slug: 'concurrent-switch',
                root: '/Users/operator/projects/concurrent-switch',
                origin: 'created',
              })
            }
            return original.createSession(input)
          },
        },
      },
      creation: makeSessionCreationCoordinator({
        registry,
        service: {
          ...original,
          createSession(input) {
            if (!raced) {
              raced = true
              registry.createProject({
                ...OWNER,
                name: 'Concurrent switch',
                slug: 'concurrent-switch',
                root: '/Users/operator/projects/concurrent-switch',
                origin: 'created',
              })
            }
            return original.createSession(input)
          },
        },
        labels: makeMemorySessionLabelStore(),
        store: makeMemorySessionCreationStore(),
      }),
      labels: makeMemorySessionLabelStore(),
    })

    expect(() => controls.create('Must not land in the stale context')).toThrowError(
      expect.objectContaining({ code: 'STALE_GENERATION' }),
    )
    expect(runtime.service.searchSessions({
      ...OWNER,
      projectId: registry.listContexts(OWNER).find((item) => item.kind === 'workspace')!.id,
      query: 'stale',
    })).toEqual([])
  })

  it('validates owner configuration', () => {
    const { registry } = setup()
    expect(() => makeTelegramSessionControls({
      runtime: { registry, service: {} as NodeProjectServiceRuntime['service'] },
      owner: { operatorId: '', profileId: 'default' },
      creation: {} as never,
      labels: {} as never,
    })).toThrowError(new TelegramSessionControlsError('INVALID_CONFIGURATION'))
  })
})

describe('session buttons', () => {
  function withSessions(count: number) {
    const ctx = setup()
    for (let index = 1; index <= count; index += 1) ctx.controls.create(`Разговор ${index}`)
    return ctx
  }

  it('gives every listed session a button that opens its detail card', async () => {
    const { controls, registry } = withSessions(2)
    const view = controls.open()

    const target = view.sessions.find((session) => session.name === 'Разговор 1')!
    const button = view.buttons.flat().find((item) => item.text.includes('Разговор 1'))!
    expect(button.data.startsWith('session:')).toBe(true)

    const tap = await controls.handle({ data: button.data, chatId: 42, updateId: 201 })
    expect(tap).toMatchObject({ kind: 'view', view: { sessions: [{ id: target.id }] } })
    // Resolving a tap must not switch anything by itself — the caller owns the
    // switch authority.
    expect(registry.getActive(OWNER).sessionId).not.toBe(target.id)
  })

  it('marks the session the operator is already in', () => {
    const { controls, registry } = withSessions(1)
    const active = registry.getActive(OWNER)
    const view = controls.open()

    const current = view.sessions.find((session) => session.id === active.sessionId)!
    expect(view.buttons.flat().find((item) => item.text.includes(current.name))?.text)
      .toContain('✅')
  })

  it('resolves only a unique id prefix inside the active Project', () => {
    const { controls, registry } = withSessions(2)
    const view = controls.open()
    const target = view.sessions.find((session) =>
      session.id !== registry.getActive(OWNER).sessionId)!

    expect(controls.resolvePrefix(target.id)).toEqual({
      kind: 'resume', sessionId: target.id, name: target.name,
    })
    expect(controls.resolvePrefix(registry.getActive(OWNER).sessionId)).toMatchObject({
      kind: 'current', sessionId: registry.getActive(OWNER).sessionId,
    })
    expect(controls.resolvePrefix('missing')).toEqual({ kind: 'unknown' })
    expect(controls.resolvePrefix('session-')).toEqual({ kind: 'ambiguous' })
  })

  it('pages instead of pouring twenty buttons onto the screen', async () => {
    const { controls } = withSessions(11)
    const first = controls.open()

    expect(first.buttons.flat().filter((item) => item.text.includes('Разговор'))).toHaveLength(8)
    const next = first.buttons.flat().find((item) => item.text === '▶️')!
    const tap = await controls.handle({ data: next.data, chatId: 42, updateId: 202 })

    expect(tap.kind).toBe('view')
    if (tap.kind !== 'view') throw new Error('expected a view')
    expect(tap.view.buttons.flat().some((item) => item.text === '◀️')).toBe(true)
  })

  it('treats a token from a previous render as stale', async () => {
    const { controls } = withSessions(2)
    const stale = controls.open().buttons.flat()[0]!.data

    controls.open() // re-render invalidates the previous tokens

    await expect(controls.handle({ data: stale, chatId: 42, updateId: 203 }))
      .resolves.toMatchObject({ kind: 'stale' })
    await expect(controls.handle({ data: 'session:not-a-token', chatId: 42, updateId: 204 }))
      .resolves.toMatchObject({ kind: 'stale' })
    await expect(controls.handle({ data: 'project:something', chatId: 42, updateId: 205 }))
      .resolves.toMatchObject({ kind: 'stale' })
  })

  it('offers a new session even when the list is empty', async () => {
    const { controls, runtime, creation, labels } = setup()
    const empty = makeTelegramSessionControls({
      owner: OWNER,
      runtime: { ...runtime, service: { ...runtime.service, searchSessions: () => [] } },
      creation,
      labels,
    })
    void controls

    const view = empty.open()
    expect(view.buttons.flat()).toHaveLength(1)
    await expect(empty.handle({
      data: view.buttons.flat()[0]!.data, chatId: 42, updateId: 206,
    })).resolves.toEqual({ kind: 'new' })
  })

  it('opens a human detail card and renames the exact Session through one message', async () => {
    const { controls } = withSessions(1)
    const list = controls.open()
    const row = list.buttons.flat().find((button) => button.text.includes('Разговор 1'))!
    const opened = await controls.handle({ data: row.data, chatId: 42, updateId: 301 })
    expect(opened).toMatchObject({ kind: 'view' })
    if (opened.kind !== 'view') throw new Error('expected detail')
    expect(opened.view.text).toContain('Сессия «Разговор 1»')
    expect(opened.view.text).not.toMatch(/session-|#[a-z0-9]/iu)
    expect(opened.view.buttons.flat().map((button) => button.text))
      .toEqual(['Продолжить', 'Переименовать', 'Назад'])

    const rename = opened.view.buttons.flat().find((button) => button.text === 'Переименовать')!
    await expect(controls.handle({ data: rename.data, chatId: 42, updateId: 302 }))
      .resolves.toEqual({ kind: 'notice', text: 'Как назвать эту сессию? Отправь новое название.' })
    expect(controls.handleAuthenticatedText({
      text: 'Деньги и стратегия', chatId: 42, updateId: 303,
    })).toMatchObject({ kind: 'renamed', session: { name: 'Деньги и стратегия' } })
  })

  it('binds one delete preview to fresh transcript authority and consumes confirmation once', async () => {
    const calls: unknown[] = []
    const head = 'c'.repeat(64)
    const record: SessionDeletionRecordV1 = {
      schemaVersion: 1,
      operationHash: 'd'.repeat(64),
      ...OWNER,
      projectId: 'placeholder',
      sessionId: 'placeholder',
      deletedAt: '2026-08-29T20:00:00.000Z',
      restartRequired: false,
      purgeRevision: 1,
      purgedAt: '2026-08-29T20:00:01.000Z',
      phase: 'terminal',
    }
    const h = setup({
      transcript: { describe: async () => ({ transcriptHead: head, turns: 7 }) },
      deletion: {
        deleteConfirmed: async (input) => {
          calls.push(input)
          return { ...record, projectId: input.projectId, sessionId: input.sessionId }
        },
      },
    })
    h.controls.create('Удаляемый разговор')
    const list = h.controls.open()
    const row = list.buttons[list.sessions.findIndex((session) =>
      session.name === 'Удаляемый разговор')]![0]!
    const opened = await h.controls.handle({ data: row.data, chatId: 42, updateId: 311 })
    if (opened.kind !== 'view') throw new Error('expected detail')
    expect(opened.view.text).toContain('7 ходов')
    const remove = opened.view.buttons.flat().find((button) => button.text === 'Удалить')!
    const preview = await h.controls.handle({ data: remove.data, chatId: 42, updateId: 312 })
    if (preview.kind !== 'view') throw new Error('expected preview')
    expect(preview.view.text).toBe(
      'Удалить сессию «Удаляемый разговор»? В Aisy её нельзя будет восстановить.\n' +
      'Память о тебе, навыки и разрешения останутся.',
    )
    const confirm = preview.view.buttons.flat().find((button) => button.text === 'Удалить')!
    await expect(h.controls.handle({ data: confirm.data, chatId: 42, updateId: 313 }))
      .resolves.toMatchObject({ kind: 'deleted', text: 'Сессия удалена.' })
    expect(calls).toMatchObject([{
      ...OWNER,
      sourceUpdateId: 313,
      transcriptHead: head,
    }])
    await expect(h.controls.handle({ data: confirm.data, chatId: 42, updateId: 314 }))
      .resolves.toMatchObject({ kind: 'stale' })
    expect(calls).toHaveLength(1)
  })

  it('refuses deletion while the exact Session still owns a retry card', async () => {
    const calls: unknown[] = []
    const h = setup({
      transcript: { describe: async () => ({ transcriptHead: 'f'.repeat(64), turns: 1 }) },
      deletion: {
        deleteConfirmed: async (input) => {
          calls.push(input)
          throw new Error('must not run')
        },
      },
    })
    h.controls.create('Ожидает повтор')
    const list = h.controls.open()
    const row = list.buttons[list.sessions.findIndex((session) =>
      session.name === 'Ожидает повтор')]![0]!
    const opened = await h.controls.handle({ data: row.data, chatId: 42, updateId: 315 })
    if (opened.kind !== 'view') throw new Error('expected detail')
    const remove = opened.view.buttons.flat().find((button) => button.text === 'Удалить')!
    const preview = await h.controls.handle({ data: remove.data, chatId: 42, updateId: 316 })
    if (preview.kind !== 'view') throw new Error('expected preview')
    const target = preview.view.sessions[0]!
    const confirm = preview.view.buttons.flat().find((button) => button.text === 'Удалить')!

    await expect(h.controls.handle({
      data: confirm.data,
      chatId: 42,
      updateId: 317,
      busySessionId: target.id,
    })).resolves.toEqual({
      kind: 'notice', text: 'Сессия ещё занята. Попробуй после завершения работы.',
    })
    expect(calls).toEqual([])
  })

  it('makes a stale delete confirmation byte-safe before the deletion service', async () => {
    const calls: unknown[] = []
    const h = setup({
      transcript: { describe: async () => ({ transcriptHead: 'e'.repeat(64), turns: 0 }) },
      deletion: {
        deleteConfirmed: async (input) => {
          calls.push(input)
          throw new Error('must not run')
        },
      },
    })
    h.controls.create('Старая карточка')
    const list = h.controls.open()
    const row = list.buttons[list.sessions.findIndex((session) =>
      session.name === 'Старая карточка')]![0]!
    const opened = await h.controls.handle({ data: row.data, chatId: 42, updateId: 321 })
    if (opened.kind !== 'view') throw new Error('expected detail')
    const remove = opened.view.buttons.flat().find((button) => button.text === 'Удалить')!
    const preview = await h.controls.handle({ data: remove.data, chatId: 42, updateId: 322 })
    if (preview.kind !== 'view') throw new Error('expected preview')
    const confirm = preview.view.buttons.flat().find((button) => button.text === 'Удалить')!
    h.registry.createProject({
      ...OWNER,
      name: 'Другой проект',
      slug: 'other-project',
      root: '/Users/operator/projects/other-project',
      origin: 'created',
    })

    await expect(h.controls.handle({ data: confirm.data, chatId: 42, updateId: 323 }))
      .resolves.toMatchObject({ kind: 'stale' })
    expect(calls).toEqual([])
  })
})
