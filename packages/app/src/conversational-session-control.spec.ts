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
import { makeConversationalSessionControl } from './conversational-session-control.js'

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
  const rename = vi.fn((sessionId: string, name: string) => ({
    kind: 'renamed' as const,
    text: `Переименовал сессию в «${name}».`,
    session: registry.renameSession({
      ...OWNER, projectId: selection.projectId, sessionId, name,
    }),
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
    newHandle: () => handles.shift() ?? 'opaque-z',
  })
  const context: ToolExecutionContext = Object.freeze({
    sessionId: selection.sessionId, turnId: 'turn-1', ordinal: 1,
  })
  return { control, registry, selection, context, rename, requestDeletePreview }
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
})
