import { createHash, randomUUID } from 'node:crypto'
import type {
  ProjectRecordV2,
  ProjectRegistryV2Owner,
  ProjectSelectionV2,
} from '@aisy/core'
import type { NodeProjectServiceRuntime } from './project-service-runtime.js'
import { fitLabel } from '@aisy/telegram-gw'

export interface TelegramProjectButton {
  text: string
  data: string
}

export interface TelegramProjectView {
  text: string
  buttons: TelegramProjectButton[][]
}

export type TelegramProjectControlOutcome =
  | { kind: 'view'; view: TelegramProjectView }
  | { kind: 'switched'; text: string; selection: ProjectSelectionV2 }
  | { kind: 'unavailable'; text: string }
  /** Open the session list for the current project. */
  | { kind: 'sessions' }
  /** Ask the operator to name a new project. */
  | { kind: 'create-prompt' }
  | { kind: 'stale'; view: TelegramProjectView }

export interface TelegramProjectControls {
  open(): Promise<TelegramProjectView>
  handle(data: string): Promise<TelegramProjectControlOutcome>
  /** Accept only the exact Telegram message already authenticated by Gateway. */
  handleAuthenticatedText(input: {
    text: string
    chatId: number
    updateId: number
  }): Promise<TelegramProjectControlOutcome | null>
}

export class TelegramProjectControlsError extends Error {
  constructor(public readonly code:
    | 'INVALID_CONFIGURATION'
    | 'TOKEN_COLLISION'
    | 'TOKEN_SPACE_EXHAUSTED'
    | 'AUTHENTICATION_MISMATCH') {
    super(code)
    this.name = 'TelegramProjectControlsError'
  }
}

type PendingAction =
  | { kind: 'switch'; targetProjectId: string; expectedGeneration: number }
  | { kind: 'page'; page: number; expectedGeneration: number }
  | { kind: 'noop'; page: number; expectedGeneration: number }
  | { kind: 'sessions'; expectedGeneration: number }
  | { kind: 'create'; expectedGeneration: number }
  | { kind: 'unavailable'; expectedGeneration: number }

const CALLBACK_PREFIX = 'project:'
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/
const DEFAULT_PAGE_SIZE = 8
const MAX_CONTEXTS = 1_000
const MAX_ISSUED_TOKENS = 100_000

function sourceMessageHash(input: {
  authorityRef: string
  owner: ProjectRegistryV2Owner
  targetProjectId: string
  expectedGeneration: number
}): string {
  return createHash('sha256').update(JSON.stringify([
    'aisy.telegram-project-switch.v1',
    input.authorityRef,
    input.owner.operatorId,
    input.owner.profileId,
    input.targetProjectId,
    input.expectedGeneration,
  ])).digest('hex')
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
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

function selectionTarget(text: string): string | null {
  const normalized = text.normalize('NFKC').trim()
  const match = /^(?:работаем\s+над|переключись\s+на|выбери\s+проект|work\s+on|switch\s+to|select\s+project)\s+(.+)$/iu
    .exec(normalized)
  return match?.[1] === undefined ? null : unquote(match[1])
}

function sortedContexts(contexts: ProjectRecordV2[]): ProjectRecordV2[] {
  return contexts.slice().sort((left, right) =>
    (left.kind === right.kind ? 0 : left.kind === 'workspace' ? -1 : 1) ||
    Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8')) ||
    Buffer.compare(Buffer.from(left.id, 'utf8'), Buffer.from(right.id, 'utf8')),
  )
}

export function makeTelegramProjectControls(input: {
  runtime: Pick<NodeProjectServiceRuntime, 'registry' | 'authority' | 'service'>
  owner: ProjectRegistryV2Owner
  newTokenId?: () => string
  pageSize?: number
  receiptTtlMs?: number
  displayRoot?: (root: string) => string
}): TelegramProjectControls {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE
  const receiptTtlMs = input.receiptTtlMs ?? 60_000
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 20 ||
    !Number.isSafeInteger(receiptTtlMs) || receiptTtlMs < 1 || receiptTtlMs > 300_000 ||
    input.owner.operatorId.trim().length === 0 || input.owner.profileId.trim().length === 0) {
    throw new TelegramProjectControlsError('INVALID_CONFIGURATION')
  }
  const newTokenId = input.newTokenId ?? randomUUID
  const displayRoot = input.displayRoot ?? ((root: string) => root)
  const pending = new Map<string, PendingAction>()
  const issued = new Set<string>()
  const processEpoch = createHash('sha256').update(randomUUID()).digest('base64url').slice(0, 8)

  const mint = (action: PendingAction): string => {
    if (issued.size >= MAX_ISSUED_TOKENS) {
      throw new TelegramProjectControlsError('TOKEN_SPACE_EXHAUSTED')
    }
    const generated = newTokenId()
    if (!TOKEN.test(generated)) {
      throw new TelegramProjectControlsError('TOKEN_COLLISION')
    }
    const token = `${processEpoch}.${generated}`
    if (issued.has(token)) throw new TelegramProjectControlsError('TOKEN_COLLISION')
    issued.add(token)
    pending.set(token, action)
    return CALLBACK_PREFIX + token
  }

  const renderChoices = (
    contexts: ProjectRecordV2[],
    expectedGeneration: number,
  ): TelegramProjectView => {
    pending.clear()
    return {
      text: 'Найдено несколько контекстов с таким именем. Выбери точный:',
      buttons: sortedContexts(contexts).map((context) => [{
        text: fitLabel(`${context.kind === 'workspace' ? '🏠' : '📁'} ${context.name}`),
        data: mint({ kind: 'switch', targetProjectId: context.id, expectedGeneration }),
      }]),
    }
  }

  const render = (requestedPage: number): TelegramProjectView => {
    pending.clear()
    const active = input.runtime.registry.getActive(input.owner)
    const contexts = sortedContexts(input.runtime.registry.listContexts(input.owner))
    if (contexts.length > MAX_CONTEXTS) {
      throw new TelegramProjectControlsError('INVALID_CONFIGURATION')
    }
    const pageCount = Math.max(1, Math.ceil(contexts.length / pageSize))
    const page = Math.min(Math.max(0, requestedPage), pageCount - 1)
    const buttons: TelegramProjectButton[][] = contexts
      .slice(page * pageSize, (page + 1) * pageSize)
      .map((context) => [{
        text: fitLabel(`${context.id === active.projectId ? '✅' : context.kind === 'workspace' ? '🏠' : '📁'} ${context.name}`),
        data: mint(context.id === active.projectId
          ? { kind: 'noop', page, expectedGeneration: active.generation }
          : {
            kind: 'switch',
            targetProjectId: context.id,
            expectedGeneration: active.generation,
          }),
      }])
    if (pageCount > 1) {
      buttons.push([
        ...(page > 0 ? [{
          text: '◀️',
          data: mint({ kind: 'page', page: page - 1, expectedGeneration: active.generation }),
        }] : []),
        { text: `${page + 1}/${pageCount}`, data: mint({
          kind: 'noop', page, expectedGeneration: active.generation,
        }) },
        ...(page + 1 < pageCount ? [{
          text: '▶️',
          data: mint({ kind: 'page', page: page + 1, expectedGeneration: active.generation }),
        }] : []),
      ])
    }
    buttons.push([
      { text: '➕ Новый проект', data: mint({ kind: 'create', expectedGeneration: active.generation }) },
      { text: '🗂 Сессии', data: mint({ kind: 'sessions', expectedGeneration: active.generation }) },
    ])
    return {
      text: `Где я работаю · поколение ${active.generation}\nВыбери общую папку или проект:`,
      buttons,
    }
  }

  const switchTarget = async (
    context: ProjectRecordV2,
    expectedGeneration: number,
    authorityRef: string,
  ): Promise<TelegramProjectControlOutcome> => {
    const hash = sourceMessageHash({
      authorityRef,
      owner: input.owner,
      targetProjectId: context.id,
      expectedGeneration,
    })
    try {
      const receipt = input.runtime.authority.issue({
        ...input.owner,
        targetProjectId: context.id,
        expectedGeneration,
        sourceMessageHash: hash,
      }, receiptTtlMs)
      const switched = await input.runtime.service.switchContext({
        ...input.owner,
        targetProjectId: context.id,
        receipt,
        sourceMessageHash: hash,
      })
      const session = input.runtime.registry.getSession({
        ...input.owner,
        projectId: switched.selection.projectId,
        sessionId: switched.selection.sessionId,
      })
      return {
        kind: 'switched',
        selection: switched.selection,
        text: `✅ Контекст: ${context.name}\nСессия: ${session.name}\nКорень: ${displayRoot(context.root)}`,
      }
    } catch {
      return { kind: 'stale', view: render(0) }
    }
  }

  return Object.freeze<TelegramProjectControls>({
    async open() {
      return render(0)
    },

    async handle(data) {
      if (!data.startsWith(CALLBACK_PREFIX)) return { kind: 'stale', view: render(0) }
      const token = data.slice(CALLBACK_PREFIX.length)
      const action = pending.get(token)
      if (!action) return { kind: 'stale', view: render(0) }
      pending.delete(token)
      const active = input.runtime.registry.getActive(input.owner)
      if (active.generation !== action.expectedGeneration) {
        return { kind: 'stale', view: render(0) }
      }
      if (action.kind === 'page') return { kind: 'view', view: render(action.page) }
      if (action.kind === 'noop') return { kind: 'view', view: render(action.page) }
      if (action.kind === 'sessions') return { kind: 'sessions' }
      if (action.kind === 'create') return { kind: 'create-prompt' }
      if (action.kind === 'unavailable') {
        return { kind: 'unavailable', text: 'Действие ещё не подключено.' }
      }

      const context = input.runtime.registry.listContexts(input.owner)
        .find((candidate) => candidate.id === action.targetProjectId)
      if (!context) return { kind: 'stale', view: render(0) }
      return switchTarget(context, action.expectedGeneration, `callback:${token}`)
    },

    async handleAuthenticatedText(authenticated) {
      if (!Number.isSafeInteger(authenticated.chatId) ||
        !Number.isSafeInteger(authenticated.updateId) || authenticated.updateId < 0 ||
        input.owner.operatorId !== `telegram:${authenticated.chatId}`) {
        throw new TelegramProjectControlsError('AUTHENTICATION_MISMATCH')
      }
      const rawTarget = selectionTarget(authenticated.text)
      if (rawTarget === null) return null
      const target = normalizedName(rawTarget)
      if (target.length === 0) {
        return { kind: 'unavailable', text: 'Укажи точное имя общей папки или проекта.' }
      }
      const active = input.runtime.registry.getActive(input.owner)
      const contexts = input.runtime.registry.listContexts(input.owner)
      const workspaceAliases = new Set(['workspace', 'рабочее пространство', 'воркспейс'])
      const matches = contexts.filter((context) =>
        normalizedName(context.name) === target ||
        (context.slug !== undefined && normalizedName(context.slug) === target) ||
        (context.kind === 'workspace' && workspaceAliases.has(target)),
      )
      if (matches.length === 0) {
        return {
          kind: 'unavailable',
          text: `Не нашёл контекст «${rawTarget}». Открой «📁 Проекты» и выбери точное имя.`,
        }
      }
      if (matches.length > 1) return { kind: 'view', view: renderChoices(matches, active.generation) }
      const context = matches[0]!
      if (context.id === active.projectId) {
        return { kind: 'unavailable', text: `Контекст «${context.name}» уже активен.` }
      }
      return switchTarget(
        context,
        active.generation,
        `authenticated-text:${authenticated.chatId}:${authenticated.updateId}:${sha256Text(authenticated.text)}`,
      )
    },
  })
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value.normalize('NFKC')).digest('hex')
}
