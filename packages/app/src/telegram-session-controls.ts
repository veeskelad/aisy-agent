import { randomUUID } from 'node:crypto'

import type {
  ProjectRegistryV2Owner,
  ProjectSessionRecord,
} from '@aisy/core'
import type { NodeProjectServiceRuntime } from './project-service-runtime.js'
import { fitLabel } from '@aisy/telegram-gw'
import {
  normalizeSessionName,
  type SessionCreationCoordinator,
} from './session-creation-coordinator.js'
import type { SessionLabelStore } from './session-label-store.js'
import type {
  SessionDeletionCoordinator,
  SessionDeletionRecordV1,
} from './session-deletion.js'

export interface TelegramSessionButton {
  text: string
  data: string
}

export interface TelegramSessionView {
  text: string
  projectId: string
  generation: number
  sessions: ProjectSessionRecord[]
  /** One button per listed session, plus paging. Empty when there is nothing to show. */
  buttons: TelegramSessionButton[][]
}

export type TelegramSessionControlOutcome =
  | { kind: 'view'; view: TelegramSessionView }
  | { kind: 'created'; text: string; session: ProjectSessionRecord }
  | { kind: 'renamed'; text: string; session: ProjectSessionRecord }
  | { kind: 'notice'; text: string }

/** What a tap resolved to. `resume` is executed by the caller, which owns the
 *  switch authority and the restart that follows it. */
export type TelegramSessionTap =
  | { kind: 'view'; view: TelegramSessionView }
  | { kind: 'resume'; sessionId: string; name: string }
  | { kind: 'deleted'; text: string; record: SessionDeletionRecordV1 }
  | { kind: 'notice'; text: string }
  | { kind: 'new' }
  | { kind: 'stale'; view: TelegramSessionView }

export type TelegramSessionPrefixResolution =
  | { kind: 'resume'; sessionId: string; name: string }
  | { kind: 'current'; sessionId: string; name: string }
  | { kind: 'ambiguous' }
  | { kind: 'unknown' }

export interface TelegramSessionControls {
  open(query?: string): TelegramSessionView
  /** Resolve a user-typed id prefix inside the active Project only. */
  resolvePrefix(prefix: string): TelegramSessionPrefixResolution
  /** Resolves a `session:` callback minted by `open`. */
  handle(input: {
    data: string
    chatId: number
    updateId: number
    /** Exact Session with a transport retry that has not reached terminal state. */
    busySessionId?: string
  }): Promise<TelegramSessionTap>
  create(name?: string, requestKey?: string): TelegramSessionControlOutcome
  rename(sessionId: string, name: string): TelegramSessionControlOutcome
  /** Build the same code-owned destructive preview used by a Telegram tap. */
  requestDeletePreview(sessionId: string, expectedGeneration: number): Promise<TelegramSessionView>
  handleAuthenticatedText(input: {
    text: string
    chatId: number
    updateId: number
  }): TelegramSessionControlOutcome | null
}

export class TelegramSessionControlsError extends Error {
  constructor(public readonly code:
    | 'INVALID_CONFIGURATION'
    | 'AUTHENTICATION_MISMATCH') {
    super(code)
    this.name = 'TelegramSessionControlsError'
  }
}

const MAX_RENDERED_SESSIONS = 20
const PAGE_SIZE = 8
const CALLBACK_PREFIX = 'session:'
const MAX_ISSUED_TOKENS = 100_000

type PendingTap =
  | { kind: 'page'; page: number; query: string }
  | { kind: 'detail'; projectId: string; sessionId: string; expectedGeneration: number }
  | { kind: 'resume'; projectId: string; sessionId: string; expectedGeneration: number }
  | { kind: 'rename'; projectId: string; sessionId: string; expectedGeneration: number }
  | { kind: 'request-delete'; projectId: string; sessionId: string; expectedGeneration: number }
  | {
      kind: 'confirm-delete'
      projectId: string
      sessionId: string
      expectedGeneration: number
      transcriptHead: string
    }
  | { kind: 'cancel-delete'; projectId: string; sessionId: string; expectedGeneration: number }
  | { kind: 'back' }
  | { kind: 'new' }

interface PendingRename {
  projectId: string
  sessionId: string
  expectedGeneration: number
}

function unquote(value: string): string {
  const trimmed = value.trim()
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['«', '»'], ['"', '"'], ["'", "'"],
  ]
  for (const [left, right] of pairs) {
    if (trimmed.startsWith(left) && trimmed.endsWith(right) && trimmed.length > 2) {
      return trimmed.slice(left.length, -right.length).trim()
    }
  }
  return trimmed
}

function createName(text: string): string | null | undefined {
  const match = /^(?:создай\s+сессию|новая\s+сессия|create\s+(?:a\s+)?session)(?:\s+(.+))?$/iu
    .exec(text.normalize('NFKC').trim())
  if (!match) return undefined
  return match[1] === undefined ? null : unquote(match[1])
}

function renameCurrentName(text: string): string | undefined {
  const match = /^(?:переименуй\s+текущую\s+сессию\s+в|rename\s+(?:the\s+)?current\s+session\s+to)\s+(.+)$/iu
    .exec(text.normalize('NFKC').trim())
  return match?.[1] === undefined ? undefined : unquote(match[1])
}

function searchQuery(text: string): string | undefined {
  const match = /^(?:найди\s+сессии|поиск\s+сессий|find\s+sessions|search\s+sessions)(?:\s+(.+))?$/iu
    .exec(text.normalize('NFKC').trim())
  return match === null ? undefined : unquote(match[1] ?? '')
}

export function makeTelegramSessionControls(input: {
  runtime: Pick<NodeProjectServiceRuntime, 'registry' | 'service'>
  owner: ProjectRegistryV2Owner
  creation: Pick<SessionCreationCoordinator, 'create'>
  labels: Pick<SessionLabelStore, 'get' | 'markExplicit'>
  deletion?: Pick<SessionDeletionCoordinator, 'deleteConfirmed'>
  transcript?: {
    describe(sessionId: string): Promise<{ transcriptHead: string; turns: number }>
  }
  newTokenId?: () => string
}): TelegramSessionControls {
  if (input.owner.operatorId.trim().length === 0 || input.owner.profileId.trim().length === 0) {
    throw new TelegramSessionControlsError('INVALID_CONFIGURATION')
  }

  const active = () => input.runtime.registry.getActive(input.owner)

  const newTokenId = input.newTokenId ?? (() => randomUUID())
  const pending = new Map<string, PendingTap>()
  const issued = new Set<string>()
  let pendingRename: PendingRename | null = null

  // Session names are operator text, so a callback carries a minted token and
  // never the name or the id. Tokens are per-render, which also turns a tap on
  // a card from before a switch into "stale" instead of a wrong resume.
  const mint = (tap: PendingTap): string => {
    if (issued.size >= MAX_ISSUED_TOKENS) issued.clear()
    const token = newTokenId()
    issued.add(token)
    pending.set(token, tap)
    return CALLBACK_PREFIX + token
  }

  const render = (query = '', requestedPage = 0): TelegramSessionView => {
    const selection = active()
    const sessions = input.runtime.service.searchSessions({
      ...input.owner,
      projectId: selection.projectId,
      query,
    })
    const visible = sessions.slice(0, MAX_RENDERED_SESSIONS)
    const suffix = sessions.length > visible.length
      ? `\n…ещё ${sessions.length - visible.length}`
      : ''
    pending.clear()
    if (visible.length === 0) {
      return {
        text: 'Сессии не найдены.',
        projectId: selection.projectId,
        generation: selection.generation,
        sessions: visible,
        buttons: [[{ text: '🆕 Новая сессия', data: mint({ kind: 'new' }) }]],
      }
    }
    const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
    const page = Math.min(Math.max(0, requestedPage), pageCount - 1)
    const buttons: TelegramSessionButton[][] = visible
      .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      .map((session) => [{
        text: fitLabel(`${session.id === selection.sessionId ? '✅' : '↩️'} ${session.name}`),
        data: mint({
          kind: 'detail',
          projectId: selection.projectId,
          sessionId: session.id,
          expectedGeneration: selection.generation,
        }),
      }])
    if (pageCount > 1) {
      buttons.push([
        ...(page > 0 ? [{ text: '◀️', data: mint({ kind: 'page', page: page - 1, query }) }] : []),
        { text: `${page + 1}/${pageCount}`, data: mint({ kind: 'page', page, query }) },
        ...(page + 1 < pageCount
          ? [{ text: '▶️', data: mint({ kind: 'page', page: page + 1, query }) }]
          : []),
      ])
    }
    buttons.push([{ text: '🆕 Новая сессия', data: mint({ kind: 'new' }) }])
    const lines = visible.map((session) =>
      `${session.id === selection.sessionId ? '✅' : '•'} ${session.name}`,
    )
    return {
      text: `Сессии текущего контекста:\n${lines.join('\n')}${suffix}\n\n` +
        'Выбери разговор, чтобы открыть его.',
      projectId: selection.projectId,
      generation: selection.generation,
      sessions: visible,
      buttons,
    }
  }

  const exactSession = (tap: {
    projectId: string
    sessionId: string
    expectedGeneration: number
  }): { selection: ReturnType<typeof active>; session: ProjectSessionRecord } => {
    const selection = active()
    if (selection.projectId !== tap.projectId || selection.generation !== tap.expectedGeneration) {
      throw new Error('SESSION_CONTROL_STALE')
    }
    return {
      selection,
      session: input.runtime.registry.getSession({
        ...input.owner,
        projectId: tap.projectId,
        sessionId: tap.sessionId,
      }),
    }
  }

  const detail = async (tap: {
    projectId: string
    sessionId: string
    expectedGeneration: number
  }): Promise<TelegramSessionView> => {
    const { selection, session } = exactSession(tap)
    const description = input.transcript === undefined
      ? null
      : await input.transcript.describe(session.id)
    pending.clear()
    const isCurrent = session.id === selection.sessionId
    const updated = session.updatedAt.slice(0, 10)
    const buttons: TelegramSessionButton[][] = []
    if (!isCurrent) {
      buttons.push([{ text: 'Продолжить', data: mint({
        kind: 'resume',
        projectId: selection.projectId,
        sessionId: session.id,
        expectedGeneration: selection.generation,
      }) }])
    }
    buttons.push([{ text: 'Переименовать', data: mint({
      kind: 'rename',
      projectId: selection.projectId,
      sessionId: session.id,
      expectedGeneration: selection.generation,
    }) }])
    if (input.deletion !== undefined && input.transcript !== undefined) {
      buttons.push([{ text: 'Удалить', data: mint({
        kind: 'request-delete',
        projectId: selection.projectId,
        sessionId: session.id,
        expectedGeneration: selection.generation,
      }) }])
    }
    buttons.push([{ text: 'Назад', data: mint({ kind: 'back' }) }])
    return {
      text: `${isCurrent ? 'Текущая сессия' : 'Сессия'} «${session.name}»\n` +
        `${updated}${description === null ? '' : ` · ${description.turns} ходов`}`,
      projectId: selection.projectId,
      generation: selection.generation,
      sessions: [session],
      buttons,
    }
  }

  const deletionPreview = async (
    tap: Extract<PendingTap, { kind: 'request-delete' }>,
  ): Promise<TelegramSessionView> => {
    if (input.deletion === undefined || input.transcript === undefined) {
      throw new Error('SESSION_DELETION_NOT_CONFIGURED')
    }
    const { selection, session } = exactSession(tap)
    const description = await input.transcript.describe(session.id)
    pending.clear()
    return {
      text: `Удалить сессию «${session.name}»? В Aisy её нельзя будет восстановить.\n` +
        'Память о тебе, навыки и разрешения останутся.',
      projectId: selection.projectId,
      generation: selection.generation,
      sessions: [session],
      buttons: [
        [{ text: 'Удалить', data: mint({
          kind: 'confirm-delete',
          projectId: selection.projectId,
          sessionId: session.id,
          expectedGeneration: selection.generation,
          transcriptHead: description.transcriptHead,
        }) }],
        [{ text: 'Отмена', data: mint({
          kind: 'cancel-delete',
          projectId: selection.projectId,
          sessionId: session.id,
          expectedGeneration: selection.generation,
        }) }],
      ],
    }
  }

  const create = (name?: string, requestKey?: string): TelegramSessionControlOutcome => {
    const selection = active()
    const session = input.creation.create({
      ...input.owner,
      projectId: selection.projectId,
      requestKey: requestKey ?? `direct:${newTokenId()}`,
      ...(name === undefined ? {} : { name }),
      expectedGeneration: selection.generation,
    })
    return {
      kind: 'created',
      text: `Создал сессию «${session.name}».`,
      session,
    }
  }

  const renameAtSelection = (
    selection: ReturnType<typeof active>,
    sessionId: string,
    name: string,
  ): TelegramSessionControlOutcome => {
    const normalizedName = normalizeSessionName(name)
    // Publish the explicit-name fence before the registry rename. A crash must
    // never leave an operator-authored name eligible for a later auto-rename.
    input.runtime.registry.getSession({
      ...input.owner,
      projectId: selection.projectId,
      sessionId,
    })
    const label = input.labels.get(sessionId)
    input.labels.markExplicit(sessionId, label?.revision)
    const session = input.runtime.service.renameSession({
      ...input.owner,
      projectId: selection.projectId,
      sessionId,
      name: normalizedName,
      expectedGeneration: selection.generation,
    })
    return { kind: 'renamed', text: `Переименовал сессию в «${session.name}».`, session }
  }

  const rename = (sessionId: string, name: string): TelegramSessionControlOutcome =>
    renameAtSelection(active(), sessionId, name)

  const assertAuthenticated = (chatId: number, updateId: number): void => {
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(updateId) || updateId < 0 ||
      input.owner.operatorId !== `telegram:${chatId}`) {
      throw new TelegramSessionControlsError('AUTHENTICATION_MISMATCH')
    }
  }

  return Object.freeze<TelegramSessionControls>({
    open: (query) => render(query),
    resolvePrefix(rawPrefix) {
      const prefix = rawPrefix.normalize('NFKC').trim().toLocaleLowerCase('ru-RU')
      if (prefix.length === 0 || prefix.length > 128 || /[\p{Cc}\p{Cf}]/u.test(prefix)) {
        return { kind: 'unknown' }
      }
      const selection = active()
      const matches = input.runtime.service.searchSessions({
        ...input.owner,
        projectId: selection.projectId,
        query: '',
      }).filter((session) => session.id.startsWith(prefix) ||
        session.name.normalize('NFKC').toLocaleLowerCase('ru-RU').startsWith(prefix))
      if (matches.length === 0) return { kind: 'unknown' }
      if (matches.length > 1) return { kind: 'ambiguous' }
      const session = matches[0]!
      return session.id === selection.sessionId
        ? { kind: 'current', sessionId: session.id, name: session.name }
        : { kind: 'resume', sessionId: session.id, name: session.name }
    },
    async handle(authenticated) {
      assertAuthenticated(authenticated.chatId, authenticated.updateId)
      if (!authenticated.data.startsWith(CALLBACK_PREFIX)) {
        return { kind: 'stale', view: render() }
      }
      const token = authenticated.data.slice(CALLBACK_PREFIX.length)
      const tap = pending.get(token)
      if (!tap) return { kind: 'stale', view: render() }
      pending.delete(token)
      try {
        if (tap.kind === 'page') return { kind: 'view', view: render(tap.query, tap.page) }
        if (tap.kind === 'new') return { kind: 'new' }
        if (tap.kind === 'back') return { kind: 'view', view: render() }
        if (tap.kind === 'detail' || tap.kind === 'cancel-delete') {
          return { kind: 'view', view: await detail(tap) }
        }
        if (tap.kind === 'resume') {
          const { session } = exactSession(tap)
          return { kind: 'resume', sessionId: session.id, name: session.name }
        }
        if (tap.kind === 'rename') {
          const { selection, session } = exactSession(tap)
          pendingRename = {
            projectId: selection.projectId,
            sessionId: session.id,
            expectedGeneration: selection.generation,
          }
          return { kind: 'notice', text: 'Как назвать эту сессию? Отправь новое название.' }
        }
        if (tap.kind === 'request-delete') {
          return { kind: 'view', view: await deletionPreview(tap) }
        }
        if (input.deletion === undefined) throw new Error('SESSION_DELETION_NOT_CONFIGURED')
        if (authenticated.busySessionId === tap.sessionId) throw new Error('SESSION_BUSY')
        exactSession(tap)
        const record = await input.deletion.deleteConfirmed({
          ...input.owner,
          projectId: tap.projectId,
          sessionId: tap.sessionId,
          expectedGeneration: tap.expectedGeneration,
          sourceUpdateId: authenticated.updateId,
          transcriptHead: tap.transcriptHead,
        })
        return { kind: 'deleted', text: 'Сессия удалена.', record }
      } catch (error) {
        const code = (error as { code?: unknown; message?: unknown }).code
        const message = (error as { message?: unknown }).message
        if (code === 'CONTEXT_BUSY' || message === 'SESSION_BUSY') {
          return { kind: 'notice', text: 'Сессия ещё занята. Попробуй после завершения работы.' }
        }
        return { kind: 'stale', view: render() }
      }
    },
    create,
    rename,
    requestDeletePreview(sessionId, expectedGeneration) {
      const selection = active()
      return deletionPreview({
        kind: 'request-delete',
        projectId: selection.projectId,
        sessionId,
        expectedGeneration,
      })
    },
    handleAuthenticatedText(authenticated) {
      assertAuthenticated(authenticated.chatId, authenticated.updateId)
      if (pendingRename !== null) {
        const form = pendingRename
        pendingRename = null
        if (/^\/?(?:отмена|cancel)$/iu.test(authenticated.text.trim())) {
          return { kind: 'notice', text: 'Переименование отменено.' }
        }
        const selection = active()
        if (selection.projectId !== form.projectId ||
          selection.generation !== form.expectedGeneration) {
          return { kind: 'notice', text: 'Сессия уже изменилась. Открой список ещё раз.' }
        }
        return renameAtSelection(selection, form.sessionId, authenticated.text)
      }
      const requestedCreateName = createName(authenticated.text)
      if (requestedCreateName !== undefined) {
        return create(
          requestedCreateName === null ? undefined : requestedCreateName,
          `telegram-update:${authenticated.updateId}`,
        )
      }
      const requestedRenameName = renameCurrentName(authenticated.text)
      if (requestedRenameName !== undefined) {
        const selection = active()
        return renameAtSelection(selection, selection.sessionId, requestedRenameName)
      }
      const requestedSearchQuery = searchQuery(authenticated.text)
      if (requestedSearchQuery !== undefined) {
        return { kind: 'view', view: render(requestedSearchQuery) }
      }
      return null
    },
  })
}
