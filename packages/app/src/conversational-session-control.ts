import { randomUUID } from 'node:crypto'

import type { ProjectRegistryV2Owner, ToolExecutionContext } from '@aisy/core'
import type { NodeProjectServiceRuntime } from './project-service-runtime.js'
import { normalizeSessionName } from './session-creation-coordinator.js'
import type { SessionAutoNameStore } from './session-auto-name-store.js'
import type { SessionLabelStore } from './session-label-store.js'
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
    | {
        ok: true
        output: string
        outcome: 'session-renamed' | 'session-delete-preview' | 'session-name-proposed'
      }
    | { ok: false; output: string }
  >
  takeView(context: Pick<ToolExecutionContext, 'sessionId' | 'turnId'>): TelegramSessionView | null
  observeAuthenticatedTurn(input: Readonly<{
    text: string
    sessionId: string
    turnId: string
  }>): void
  confirmReplyDelivered(input: Readonly<{ sessionId: string; turnId: string }>): boolean
  recoverPendingAutoNames(): number
}

interface EligibleAutoNameTurn extends HandleRecord {
  labelRevision: number
}

export function isEligibleSessionAutoNameText(text: string): boolean {
  const normalized = text.normalize('NFKC').trim()
  if (normalized.length === 0 || normalized.startsWith('/') || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    return false
  }
  const words = normalized.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
  return words >= 3 || Array.from(normalized).length >= 12
}

export function makeConversationalSessionControl(input: {
  runtime: Pick<NodeProjectServiceRuntime, 'registry' | 'service'>
  owner: ProjectRegistryV2Owner
  controls: {
    rename(sessionId: string, name: string): ReturnType<TelegramSessionControls['rename']>
    requestDeletePreview(sessionId: string, expectedGeneration: number): Promise<TelegramSessionView>
  }
  autoName?: {
    labels: Pick<SessionLabelStore, 'get'>
    proposals: SessionAutoNameStore
    nowIso?: () => string
  }
  newHandle?: () => string
  maxSessions?: number
}): ConversationalSessionControl {
  const handles = new Map<string, HandleRecord>()
  const pendingViews = new Map<string, { sessionId: string; view: TelegramSessionView }>()
  const eligibleAutoNameTurns = new Map<string, EligibleAutoNameTurn>()
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
      if (request.operation === 'session.propose-name') {
        const turnId = contextTurn(context)
        const eligible = turnId === null ? undefined : eligibleAutoNameTurns.get(turnId)
        eligibleAutoNameTurns.delete(turnId ?? '')
        if (input.autoName === undefined || turnId === null || request.target !== 'current' ||
          eligible === undefined || eligible.sessionId !== target.sessionId ||
          eligible.projectId !== target.projectId || eligible.generation !== target.generation) {
          return { ok: false, output: 'Автоматическое название сейчас не требуется.' }
        }
        let name: string
        try {
          name = normalizeSessionName(request.value ?? '')
        } catch {
          return { ok: false, output: 'Предложи короткое название без разметки.' }
        }
        const label = input.autoName.labels.get(target.sessionId)
        if (label?.kind !== 'temporary' || label.revision !== eligible.labelRevision) {
          return { ok: false, output: 'У этой сессии уже есть название.' }
        }
        try {
          input.autoName.proposals.put({
            schemaVersion: 1,
            projectId: target.projectId,
            sessionId: target.sessionId,
            turnId,
            expectedGeneration: target.generation,
            expectedLabelRevision: label.revision,
            name,
            state: 'pending-delivery',
            createdAt: (input.autoName.nowIso ?? (() => new Date().toISOString()))(),
          })
        } catch {
          return { ok: false, output: 'Не удалось сохранить название. Продолжу без него.' }
        }
        return {
          ok: true,
          output: 'Название будет применено после доставки ответа.',
          outcome: 'session-name-proposed',
        }
      }
      return {
        ok: false,
        output: 'Эта настройка недоступна.',
      }
    },

    takeView(context) {
      if (context.turnId === undefined) return null
      const pending = pendingViews.get(context.turnId)
      if (pending === undefined || pending.sessionId !== context.sessionId) return null
      pendingViews.delete(context.turnId)
      return pending.view
    },

    observeAuthenticatedTurn(observed) {
      if (input.autoName === undefined || !isEligibleSessionAutoNameText(observed.text)) return
      const selection = active()
      if (selection.sessionId !== observed.sessionId) return
      const label = input.autoName.labels.get(observed.sessionId)
      if (label?.kind !== 'temporary') return
      if (eligibleAutoNameTurns.size >= 1_000) eligibleAutoNameTurns.clear()
      eligibleAutoNameTurns.set(observed.turnId, {
        turnId: observed.turnId,
        projectId: selection.projectId,
        sessionId: selection.sessionId,
        generation: selection.generation,
        labelRevision: label.revision,
      })
    },

    confirmReplyDelivered(delivered) {
      const proposals = input.autoName?.proposals
      if (proposals === undefined) return false
      const proposal = proposals.get(delivered.sessionId, delivered.turnId)
      if (proposal === null) return false
      const selection = active()
      const label = input.autoName!.labels.get(proposal.sessionId)
      if (selection.projectId !== proposal.projectId ||
        selection.sessionId !== proposal.sessionId ||
        selection.generation !== proposal.expectedGeneration ||
        label?.kind !== 'temporary' || label.revision !== proposal.expectedLabelRevision) {
        proposals.remove(proposal.sessionId, proposal.turnId)
        return false
      }
      try {
        const outcome = input.controls.rename(proposal.sessionId, proposal.name)
        if (outcome.kind !== 'renamed') return false
        proposals.remove(proposal.sessionId, proposal.turnId)
        return true
      } catch {
        // If the explicit fence reached disk but the registry rename did not,
        // retire the proposal. Replaying it could overwrite a later user name.
        if (input.autoName!.labels.get(proposal.sessionId)?.kind === 'explicit') {
          proposals.remove(proposal.sessionId, proposal.turnId)
        }
        return false
      }
    },

    recoverPendingAutoNames() {
      eligibleAutoNameTurns.clear()
      return input.autoName?.proposals.clearPending() ?? 0
    },
  })
}
