import { describe, expect, it, vi } from 'vitest'
import {
  makeContextLeaseCoordinator,
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  makeProjectService,
  type SwitchAuthority,
  type ToolExecutionContext,
} from '@aisy/core'
import type { NodeProjectServiceRuntime } from './project-service-runtime.js'
import {
  isEligibleSessionAutoNameText,
  makeConversationalSessionControl,
} from './conversational-session-control.js'
import { makeMemorySessionAutoNameStore } from './session-auto-name-store.js'
import { makeMemorySessionLabelStore } from './session-label-store.js'

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
      nowIso: () => '2026-08-29T12:00:00.000Z',
      newId: () => `bootstrap-${++id}`,
      policy: POLICY,
    }),
    policy: POLICY,
    nowIso: () => `2026-08-29T12:00:${String(++id).padStart(2, '0')}.000Z`,
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
  const selection = registry.getActive(OWNER)
  service.createSession({ ...OWNER, projectId: selection.projectId, name: 'Старая работа' })
  const labels = makeMemorySessionLabelStore()
  labels.markTemporary(selection.sessionId)
  const proposals = makeMemorySessionAutoNameStore()
  const rename = vi.fn((sessionId: string, name: string) => ({
    kind: 'renamed' as const,
    text: `Переименовал сессию в «${name}».`,
    session: (() => {
      const label = labels.get(sessionId)
      labels.markExplicit(sessionId, label?.revision)
      const current = registry.getActive(OWNER)
      return registry.renameSession({
        ...OWNER, projectId: current.projectId, sessionId, name,
        expectedGeneration: current.generation,
      })
    })(),
  }))
  const requestDeletePreview = vi.fn(async (sessionId: string, generation: number) => ({
    text: 'Удалить эту сессию?', projectId: selection.projectId, generation,
    sessions: [registry.getSession({ ...OWNER, projectId: selection.projectId, sessionId })],
    buttons: [[{ text: 'Удалить', data: 'session:code-owned' }]],
  }))
  const handles = ['opaque-a', 'opaque-b']
  const control = makeConversationalSessionControl({
    runtime: { registry, service } as Pick<NodeProjectServiceRuntime, 'registry' | 'service'>,
    owner: OWNER,
    controls: { rename, requestDeletePreview },
    autoName: {
      labels,
      proposals,
      nowIso: () => '2026-08-29T12:30:00.000Z',
    },
    newHandle: () => handles.shift() ?? 'opaque-z',
  })
  const context: ToolExecutionContext = Object.freeze({
    sessionId: selection.sessionId, turnId: 'turn-1', ordinal: 1,
  })
  return {
    control, registry, service, selection, context, rename, requestDeletePreview,
    labels, proposals,
  }
}

describe('makeConversationalSessionControl', () => {
  it('lists names through one-turn opaque handles and never exposes ids', () => {
    const h = setup()
    const text = h.control.list(h.context)

    expect(text).toContain('current')
    expect(text).toContain('opaque-a')
    expect(text).toContain('Старая работа')
    expect(text).not.toContain(h.selection.sessionId)
    expect(text).not.toContain(h.selection.projectId)
  })

  it('renames only the exact current turn target and rejects a stale handle', async () => {
    const h = setup()
    h.control.list(h.context)

    await expect(h.control.configure({
      operation: 'session.rename', target: 'opaque-a', value: 'Архив сделки',
    }, h.context)).resolves.toEqual({
      ok: true,
      output: 'Переименовал сессию в «Архив сделки».',
      outcome: 'session-renamed',
    })
    expect(h.rename).toHaveBeenCalledOnce()

    await expect(h.control.configure({
      operation: 'session.rename', target: 'opaque-a', value: 'Повтор',
    }, h.context)).resolves.toEqual(expect.objectContaining({
      ok: false, output: expect.stringContaining('Список сессий изменился'),
    }))
    expect(h.rename).toHaveBeenCalledOnce()
  })

  it('opens the code-owned delete card but cannot delete by model text', async () => {
    const h = setup()
    h.control.list(h.context)

    await expect(h.control.configure({
      operation: 'session.request-delete', target: 'opaque-a',
    }, h.context)).resolves.toEqual({
      ok: true,
      output: 'Карточка удаления подготовлена.',
      outcome: 'session-delete-preview',
    })
    expect(h.requestDeletePreview).toHaveBeenCalledOnce()
    expect(h.control.takeView(h.context)).toMatchObject({
      text: 'Удалить эту сессию?',
      buttons: [[{ data: 'session:code-owned' }]],
    })
    expect(h.control.takeView(h.context)).toBeNull()
    expect(h.registry.searchSessions({
      ...OWNER, projectId: h.selection.projectId, query: '',
    })).toHaveLength(2)
  })

  it('does not accept handles from another turn', async () => {
    const h = setup()
    h.control.list(h.context)
    const next = { ...h.context, turnId: 'turn-2', ordinal: 2 }

    await expect(h.control.configure({
      operation: 'session.rename', target: 'opaque-a', value: 'Чужая',
    }, next)).resolves.toEqual(expect.objectContaining({
      ok: false, output: expect.stringContaining('Список сессий изменился'),
    }))
    expect(h.rename).not.toHaveBeenCalled()
  })

  it('proposes a name only for the exact eligible authenticated turn and commits after delivery', async () => {
    const h = setup()
    h.control.observeAuthenticatedTurn({
      text: 'Помоги спланировать запуск продукта',
      sessionId: h.selection.sessionId,
      turnId: h.context.turnId!,
    })

    await expect(h.control.configure({
      operation: 'session.propose-name', target: 'current', value: 'Запуск продукта',
    }, h.context)).resolves.toEqual({
      ok: true,
      output: 'Название будет применено после доставки ответа.',
      outcome: 'session-name-proposed',
    })
    expect(h.rename).not.toHaveBeenCalled()
    expect(h.proposals.get(h.selection.sessionId, h.context.turnId!)).toMatchObject({
      name: 'Запуск продукта', state: 'pending-delivery', expectedLabelRevision: 1,
    })
    await expect(h.control.configure({
      operation: 'session.propose-name', target: 'current', value: 'Подмена',
    }, h.context)).resolves.toMatchObject({ ok: false })
    expect(h.proposals.get(h.selection.sessionId, h.context.turnId!)).toMatchObject({
      name: 'Запуск продукта',
    })
    expect(h.control.confirmReplyDelivered({
      sessionId: h.selection.sessionId,
      turnId: 'wrong-turn',
    })).toBe(false)
    expect(h.control.confirmReplyDelivered({
      sessionId: 'wrong-session',
      turnId: h.context.turnId!,
    })).toBe(false)
    expect(h.proposals.snapshot().proposals).toHaveLength(1)

    expect(h.control.confirmReplyDelivered({
      sessionId: h.selection.sessionId,
      turnId: h.context.turnId!,
    })).toBe(true)
    expect(h.rename).toHaveBeenCalledWith(h.selection.sessionId, 'Запуск продукта')
    expect(h.proposals.snapshot().proposals).toEqual([])
    expect(h.control.confirmReplyDelivered({
      sessionId: h.selection.sessionId,
      turnId: h.context.turnId!,
    })).toBe(false)
  })

  it('keeps the temporary name without exact delivery and lets an explicit rename win', async () => {
    const h = setup()
    h.control.observeAuthenticatedTurn({
      text: 'Разбери архитектуру нового сервиса',
      sessionId: h.selection.sessionId,
      turnId: h.context.turnId!,
    })
    await h.control.configure({
      operation: 'session.propose-name', target: 'current', value: 'Архитектура сервиса',
    }, h.context)
    expect(h.registry.getSession({
      ...OWNER, projectId: h.selection.projectId, sessionId: h.selection.sessionId,
    }).name).not.toBe('Архитектура сервиса')

    h.labels.markExplicit(h.selection.sessionId, 1)
    expect(h.control.confirmReplyDelivered({
      sessionId: h.selection.sessionId,
      turnId: h.context.turnId!,
    })).toBe(false)
    expect(h.rename).not.toHaveBeenCalled()
    expect(h.proposals.snapshot().proposals).toEqual([])
  })

  it('drops a proposal when the active selection generation changed before delivery', async () => {
    const h = setup()
    h.control.observeAuthenticatedTurn({
      text: 'Сравни варианты новой архитектуры',
      sessionId: h.selection.sessionId,
      turnId: h.context.turnId!,
    })
    await h.control.configure({
      operation: 'session.propose-name', target: 'current', value: 'Варианты архитектуры',
    }, h.context)
    const other = h.registry.searchSessions({
      ...OWNER, projectId: h.selection.projectId, query: '',
    }).find((session) => session.id !== h.selection.sessionId)!
    h.registry.switchContext({
      ...OWNER,
      projectId: h.selection.projectId,
      sessionId: other.id,
      expectedGeneration: h.selection.generation,
    })
    const away = h.registry.getActive(OWNER)
    h.registry.switchContext({
      ...OWNER,
      projectId: h.selection.projectId,
      sessionId: h.selection.sessionId,
      expectedGeneration: away.generation,
    })

    expect(h.control.confirmReplyDelivered({
      sessionId: h.selection.sessionId,
      turnId: h.context.turnId!,
    })).toBe(false)
    expect(h.rename).not.toHaveBeenCalled()
    expect(h.proposals.snapshot().proposals).toEqual([])
  })

  it('rejects short, command, wrong-session, stale-turn and replayed proposals', async () => {
    const h = setup()
    h.control.observeAuthenticatedTurn({
      text: '/resume', sessionId: h.selection.sessionId, turnId: h.context.turnId!,
    })
    await expect(h.control.configure({
      operation: 'session.propose-name', target: 'current', value: 'Возврат',
    }, h.context)).resolves.toMatchObject({ ok: false })

    h.control.observeAuthenticatedTurn({
      text: 'Составь подробный рабочий план', sessionId: 'wrong-session', turnId: 'turn-2',
    })
    await expect(h.control.configure({
      operation: 'session.propose-name', target: 'current', value: 'Рабочий план',
    }, { ...h.context, turnId: 'turn-2' })).resolves.toMatchObject({ ok: false })

    expect(isEligibleSessionAutoNameText('эй')).toBe(false)
    expect(isEligibleSessionAutoNameText('как идут дела')).toBe(true)
    expect(isEligibleSessionAutoNameText('длиннаязадача')).toBe(true)
  })

  it('clears ambiguous pending proposals on startup instead of guessing delivery', async () => {
    const h = setup()
    h.control.observeAuthenticatedTurn({
      text: 'Подготовь анализ конкурентов',
      sessionId: h.selection.sessionId,
      turnId: h.context.turnId!,
    })
    await h.control.configure({
      operation: 'session.propose-name', target: 'current', value: 'Анализ конкурентов',
    }, h.context)

    expect(h.control.recoverPendingAutoNames()).toBe(1)
    expect(h.proposals.snapshot().proposals).toEqual([])
    expect(h.rename).not.toHaveBeenCalled()
  })
})
