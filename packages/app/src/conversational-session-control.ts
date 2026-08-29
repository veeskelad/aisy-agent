import { randomUUID } from 'node:crypto'

import type { ProjectRegistryV2Owner, ToolExecutionContext } from '@aisy/core'
import type { NodeProjectServiceRuntime } from './project-service-runtime.js'
import type {
  TelegramSessionControls,
  TelegramSessionView,
} from './telegram-session-controls.js'

interface HandleRecord {
  turnId: string
  projectId: string
  sessionId: string
  generation: number
}

export interface ConversationalSessionControl {
  list(context: ToolExecutionContext): string
  configure(input: {
    operation: string
    target: string
    value?: string
  }, context: ToolExecutionContext): Promise<
    | { ok: true; output: string; outcome: 'session-renamed' | 'session-delete-preview' }
    | { ok: false; output: string }
  >
  takeView(context: Pick<ToolExecutionContext, 'sessionId' | 'turnId'>): TelegramSessionView | null
}

export function makeConversationalSessionControl(input: {
  runtime: Pick<NodeProjectServiceRuntime, 'registry' | 'service'>
  owner: ProjectRegistryV2Owner
  controls: {
    rename(sessionId: string, name: string): ReturnType<TelegramSessionControls['rename']>
    requestDeletePreview(sessionId: string, expectedGeneration: number): Promise<TelegramSessionView>
  }
  newHandle?: () => string
  maxSessions?: number
}): ConversationalSessionControl {
  const handles = new Map<string, HandleRecord>()
  const pendingViews = new Map<string, { sessionId: string; view: TelegramSessionView }>()
  const maxSessions = Math.min(Math.max(input.maxSessions ?? 12, 1), 20)
  const newHandle = input.newHandle ?? (() => randomUUID())

  const contextTurn = (context: ToolExecutionContext): string | null =>
    typeof context.turnId === 'string' && context.turnId.length > 0 ? context.turnId : null

  const active = () => input.runtime.registry.getActive(input.owner)

  const assertCurrentTurn = (context: ToolExecutionContext): ReturnType<typeof active> | null => {
    const turnId = contextTurn(context)
    const selection = active()
    if (turnId === null || context.sessionId !== selection.sessionId) return null
    return selection
  }

  const resolveTarget = (
    target: string,
    context: ToolExecutionContext,
  ): HandleRecord | null => {
    const selection = assertCurrentTurn(context)
    const turnId = contextTurn(context)
    if (selection === null || turnId === null) return null
    if (target === 'current') {
      return {
        turnId,
        projectId: selection.projectId,
        sessionId: selection.sessionId,
        generation: selection.generation,
      }
    }
    const record = handles.get(target)
    handles.delete(target)
    if (record === undefined || record.turnId !== turnId ||
      record.projectId !== selection.projectId || record.generation !== selection.generation) {
      return null
    }
    return record
  }

  return Object.freeze<ConversationalSessionControl>({
    list(context) {
      const selection = assertCurrentTurn(context)
      const turnId = contextTurn(context)
      if (selection === null || turnId === null) return 'Не удалось открыть сессии этого разговора.'
      handles.clear()
      const sessions = input.runtime.service.searchSessions({
        ...input.owner,
        projectId: selection.projectId,
        query: '',
      }).slice(0, maxSessions)
      const lines = sessions.map((session) => {
        if (session.id === selection.sessionId) return `• current — ${session.name} (текущая)`
        const handle = newHandle()
        handles.set(handle, {
          turnId,
          projectId: selection.projectId,
          sessionId: session.id,
          generation: selection.generation,
        })
        return `• ${handle} — ${session.name}`
      })
      return lines.length === 0 ? 'Сессий пока нет.' : lines.join('\n')
    },

    async configure(request, context) {
      const target = resolveTarget(request.target, context)
      if (target === null) {
        return { ok: false, output: 'Список сессий изменился. Сначала снова открой его.' }
      }
      if (request.operation === 'session.rename') {
        const name = request.value?.trim() ?? ''
        if (name.length === 0) return { ok: false, output: 'Скажи, как назвать сессию.' }
        try {
          const outcome = input.controls.rename(target.sessionId, name)
          return outcome.kind === 'renamed'
            ? { ok: true, output: outcome.text, outcome: 'session-renamed' }
            : { ok: false, output: 'Не удалось переименовать сессию. Открой список и попробуй ещё раз.' }
        } catch {
          return { ok: false, output: 'Не удалось переименовать сессию. Открой список и попробуй ещё раз.' }
        }
      }
      if (request.operation === 'session.request-delete') {
        try {
          const view = await input.controls.requestDeletePreview(
            target.sessionId,
            target.generation,
          )
          const turnId = contextTurn(context)
          if (turnId === null) return { ok: false, output: 'Не удалось открыть карточку удаления.' }
          pendingViews.set(turnId, { sessionId: context.sessionId, view })
          return {
            ok: true,
            output: 'Карточка удаления подготовлена.',
            outcome: 'session-delete-preview',
          }
        } catch {
          return { ok: false, output: 'Не удалось открыть карточку удаления. Открой список и попробуй ещё раз.' }
        }
      }
      return {
        ok: false,
        output: 'Эта настройка недоступна. Я могу переименовать сессию или открыть карточку удаления.',
      }
    },

    takeView(context) {
      if (context.turnId === undefined) return null
      const pending = pendingViews.get(context.turnId)
      if (pending === undefined || pending.sessionId !== context.sessionId) return null
      pendingViews.delete(context.turnId)
      return pending.view
    },
  })
}
