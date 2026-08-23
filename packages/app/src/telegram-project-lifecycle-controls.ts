import { createHash, randomBytes } from 'node:crypto'
import type {
  ProjectLifecycleAction,
  ProjectLifecycleAuthorityIssuer,
  ProjectRegistryV2Owner,
} from '@aisy/core'

import type { NodeProjectServiceRuntime } from './project-service-runtime.js'

export interface TelegramProjectLifecycleButton {
  text: string
  data: string
}

export interface TelegramProjectLifecycleConfirmationView {
  text: string
  buttons: TelegramProjectLifecycleButton[][]
}

export type TelegramProjectLifecycleOutcome =
  | {
    kind: 'confirmation'
    view: TelegramProjectLifecycleConfirmationView
    action: ProjectLifecycleAction
    projectId: string
    sessionId?: string
    expiresAt: string
  }
  | {
    kind: 'archived'
    text: string
    action: ProjectLifecycleAction
    projectId: string
    sessionId?: string
    generation: number
  }
  | { kind: 'cancelled'; text: string }
  | { kind: 'stale'; text: string }
  | { kind: 'unavailable'; text: string }

export interface TelegramProjectLifecycleControls {
  handleAuthenticatedText(input: {
    text: string
    chatId: number
    updateId: number
  }): Promise<TelegramProjectLifecycleOutcome | null>
  handleAuthenticatedCallback(input: {
    data: string
    chatId: number
    updateId: number
  }): Promise<TelegramProjectLifecycleOutcome>
}

export class TelegramProjectLifecycleControlsError extends Error {
  constructor(public readonly code:
    | 'INVALID_CONFIGURATION'
    | 'AUTHENTICATION_MISMATCH'
    | 'TOKEN_COLLISION'
    | 'TOKEN_SPACE_EXHAUSTED',
  ) {
    super(code)
    this.name = 'TelegramProjectLifecycleControlsError'
  }
}

type ParsedCommand = {
  action: ProjectLifecycleAction
  current: boolean
  target?: string
}

type ResolvedTarget = {
  action: ProjectLifecycleAction
  projectId: string
  sessionId?: string
  name: string
}

type PendingConfirmation = Omit<ResolvedTarget, 'name'> & {
  expectedGeneration: number
  requestChatId: number
  requestUpdateId: number
  originalTextHash: string
  targetIdentityHash: string
  expiresAtMs: number
}

const CALLBACK_PREFIX = 'project-lifecycle:v1:'
const CALLBACK = /^project-lifecycle:v1:(confirm|cancel):([A-Za-z0-9_-]{8}\.[A-Za-z0-9][A-Za-z0-9._-]{15,24})$/
const GENERATED_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{15,24}$/
const DEFAULT_CONFIRMATION_TTL_MS = 120_000
const DEFAULT_RECEIPT_TTL_MS = 60_000
const MAX_PENDING = 1_024
const MAX_REPLAY_KEYS = 100_000
const MAX_TEXT_LENGTH = 4_096
const MAX_DATE_MS = 8_640_000_000_000_000

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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

function parseCommand(text: string): ParsedCommand | null {
  const normalized = text.normalize('NFKC').trim()
  if (/^(?:архивируй\s+текущий\s+проект|archive\s+(?:the\s+)?current\s+project)$/iu.test(normalized)) {
    return { action: 'project.archive', current: true }
  }
  if (/^(?:архивируй\s+текущую\s+сессию|archive\s+(?:the\s+)?current\s+session)$/iu.test(normalized)) {
    return { action: 'session.archive', current: true }
  }
  const moveProject = /^перемести\s+проект\s+(.+?)\s+в\s+архив$/iu.exec(normalized)
  if (moveProject?.[1] !== undefined) {
    return { action: 'project.archive', current: false, target: unquote(moveProject[1]) }
  }
  const project = /^(?:архивируй\s+проект|archive\s+project)\s+(.+)$/iu.exec(normalized)
  if (project?.[1] !== undefined) {
    return { action: 'project.archive', current: false, target: unquote(project[1]) }
  }
  const session = /^(?:архивируй\s+сессию|archive\s+session)\s+(.+)$/iu.exec(normalized)
  if (session?.[1] !== undefined) {
    return { action: 'session.archive', current: false, target: unquote(session[1]) }
  }
  return null
}

function targetIdentityHash(target: ResolvedTarget): string {
  return sha256(JSON.stringify([
    'aisy.telegram-project-lifecycle.target-identity.v1',
    target.action === 'project.archive' ? 'project' : 'session',
    target.projectId,
    target.sessionId ?? null,
    target.name,
  ]))
}

function provenanceHash(input: PendingConfirmation & {
  owner: ProjectRegistryV2Owner
  confirmChatId: number
  confirmUpdateId: number
  token: string
}): string {
  return sha256(JSON.stringify([
    'aisy.telegram-project-lifecycle.v1',
    input.owner.operatorId,
    input.owner.profileId,
    input.requestChatId,
    input.requestUpdateId,
    input.originalTextHash,
    input.confirmChatId,
    input.confirmUpdateId,
    input.action,
    input.projectId,
    input.sessionId ?? null,
    input.expectedGeneration,
    input.targetIdentityHash,
    input.token,
  ]))
}

function unavailable(text: string): TelegramProjectLifecycleOutcome {
  return { kind: 'unavailable', text }
}

function stale(): TelegramProjectLifecycleOutcome {
  return { kind: 'stale', text: 'Экран устарел — открой раздел заново.' }
}

export function makeTelegramProjectLifecycleControls(input: {
  runtime: Pick<NodeProjectServiceRuntime, 'registry' | 'service'>
  authority: ProjectLifecycleAuthorityIssuer
  owner: ProjectRegistryV2Owner
  nowMs?: () => number
  newTokenId?: () => string
  confirmationTtlMs?: number
  receiptTtlMs?: number
}): TelegramProjectLifecycleControls {
  const nowMs = input.nowMs ?? Date.now
  const newTokenId = input.newTokenId ?? (() => randomBytes(15).toString('base64url'))
  const confirmationTtlMs = input.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS
  const receiptTtlMs = input.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS
  if (input.owner.operatorId.trim().length === 0 || input.owner.profileId.trim().length === 0 ||
    !Number.isSafeInteger(confirmationTtlMs) || confirmationTtlMs < 1 ||
    confirmationTtlMs > 300_000 || !Number.isSafeInteger(receiptTtlMs) ||
    receiptTtlMs < 1 || receiptTtlMs > 300_000) {
    throw new TelegramProjectLifecycleControlsError('INVALID_CONFIGURATION')
  }

  const processEpoch = randomBytes(6).toString('base64url')
  const pending = new Map<string, PendingConfirmation>()
  const issuedTokens = new Set<string>()
  const globalUpdateKeys = new Set<string>()

  const currentTime = (): number => {
    const value = nowMs()
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
      throw new TelegramProjectLifecycleControlsError('INVALID_CONFIGURATION')
    }
    return value
  }

  const authenticate = (chatId: number, updateId: number): void => {
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(updateId) || updateId < 0 ||
      input.owner.operatorId !== `telegram:${chatId}`) {
      throw new TelegramProjectLifecycleControlsError('AUTHENTICATION_MISMATCH')
    }
  }

  const updateKey = (chatId: number, updateId: number): string => `${chatId}:${updateId}`

  const addReplayKey = (set: Set<string>, key: string): boolean => {
    if (set.has(key)) return false
    if (set.size >= MAX_REPLAY_KEYS) {
      throw new TelegramProjectLifecycleControlsError('TOKEN_SPACE_EXHAUSTED')
    }
    set.add(key)
    return true
  }

  const resolveTarget = (command: ParsedCommand): ResolvedTarget | undefined => {
    const selection = input.runtime.registry.getActive(input.owner)
    if (command.action === 'project.archive') {
      const contexts = input.runtime.registry.listContexts(input.owner)
      const matches = command.current
        ? contexts.filter((candidate) => candidate.id === selection.projectId && candidate.kind === 'project')
        : contexts.filter((candidate) => candidate.kind === 'project' && command.target !== undefined && (
          candidate.id === command.target || normalizedName(candidate.name) === normalizedName(command.target) ||
          (candidate.slug !== undefined && normalizedName(candidate.slug) === normalizedName(command.target))
        ))
      if (matches.length !== 1) return undefined
      const target = matches[0]!
      return { action: command.action, projectId: target.id, name: target.name }
    }

    const project = input.runtime.registry.listContexts(input.owner)
      .find((candidate) => candidate.id === selection.projectId)
    if (project === undefined) return undefined
    const sessions = input.runtime.service.searchSessions({
      ...input.owner,
      projectId: project.id,
      query: '',
    })
    const matches = command.current
      ? sessions.filter((candidate) => candidate.id === selection.sessionId)
      : sessions.filter((candidate) => command.target !== undefined && (
        candidate.id === command.target || normalizedName(candidate.name) === normalizedName(command.target)
      ))
    if (matches.length !== 1) return undefined
    const target = matches[0]!
    return {
      action: command.action,
      projectId: project.id,
      sessionId: target.id,
      name: target.name,
    }
  }

  const rereadTarget = (record: PendingConfirmation): ResolvedTarget | undefined => {
    try {
      if (record.action === 'project.archive') {
        const project = input.runtime.registry.listContexts(input.owner)
          .find((candidate) => candidate.id === record.projectId && candidate.kind === 'project')
        return project === undefined
          ? undefined
          : { action: record.action, projectId: project.id, name: project.name }
      }
      if (record.sessionId === undefined) return undefined
      const project = input.runtime.registry.listContexts(input.owner)
        .find((candidate) => candidate.id === record.projectId)
      if (project === undefined) return undefined
      const session = input.runtime.registry.getSession({
        ...input.owner,
        projectId: record.projectId,
        sessionId: record.sessionId,
      })
      return {
        action: record.action,
        projectId: record.projectId,
        sessionId: session.id,
        name: session.name,
      }
    } catch {
      return undefined
    }
  }

  const mint = (record: PendingConfirmation): string => {
    for (const [token, candidate] of pending) {
      if (candidate.expiresAtMs <= currentTime()) pending.delete(token)
    }
    if (pending.size >= MAX_PENDING || issuedTokens.size >= MAX_REPLAY_KEYS) {
      throw new TelegramProjectLifecycleControlsError('TOKEN_SPACE_EXHAUSTED')
    }
    const generated = newTokenId()
    if (!GENERATED_TOKEN.test(generated)) {
      throw new TelegramProjectLifecycleControlsError('TOKEN_COLLISION')
    }
    const token = `${processEpoch}.${generated}`
    if (issuedTokens.has(token)) {
      throw new TelegramProjectLifecycleControlsError('TOKEN_COLLISION')
    }
    issuedTokens.add(token)
    pending.set(token, Object.freeze({ ...record }))
    return token
  }

  return Object.freeze<TelegramProjectLifecycleControls>({
    async handleAuthenticatedText(authenticated) {
      authenticate(authenticated.chatId, authenticated.updateId)
      if (typeof authenticated.text !== 'string' || authenticated.text.length > MAX_TEXT_LENGTH) {
        return unavailable('Команда слишком длинная или некорректная.')
      }
      const command = parseCommand(authenticated.text)
      if (command === null) return null
      const key = updateKey(authenticated.chatId, authenticated.updateId)
      if (!addReplayKey(globalUpdateKeys, key)) return stale()
      let target: ResolvedTarget | undefined
      let expectedGeneration: number
      try {
        target = resolveTarget(command)
        expectedGeneration = input.runtime.registry.getActive(input.owner).generation
      } catch {
        return unavailable('Не удалось безопасно проверить выбранный контекст.')
      }
      if (target === undefined) {
        return unavailable(command.action === 'project.archive'
          ? 'Не нашёл единственный доступный проект. Общую папку архивировать нельзя.'
          : 'Не нашёл единственную активную сессию в текущем проекте.')
      }
      const now = currentTime()
      if (now + confirmationTtlMs > MAX_DATE_MS) {
        throw new TelegramProjectLifecycleControlsError('INVALID_CONFIGURATION')
      }
      const identityHash = targetIdentityHash(target)
      const record: PendingConfirmation = {
        action: target.action,
        projectId: target.projectId,
        ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }),
        expectedGeneration,
        requestChatId: authenticated.chatId,
        requestUpdateId: authenticated.updateId,
        originalTextHash: sha256(authenticated.text.normalize('NFKC')),
        targetIdentityHash: identityHash,
        expiresAtMs: now + confirmationTtlMs,
      }
      const token = mint(record)
      const object = target.action === 'project.archive' ? 'Project' : 'Session'
      return {
        kind: 'confirmation',
        view: {
          text: `Архивировать ${object} «${target.name}»? Данные не удаляются.`,
          buttons: [[
            { text: '✅ Архивировать', data: `${CALLBACK_PREFIX}confirm:${token}` },
            { text: 'Отмена', data: `${CALLBACK_PREFIX}cancel:${token}` },
          ]],
        },
        action: target.action,
        projectId: target.projectId,
        ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }),
        expiresAt: new Date(record.expiresAtMs).toISOString(),
      }
    },

    async handleAuthenticatedCallback(authenticated) {
      authenticate(authenticated.chatId, authenticated.updateId)
      const callbackKey = updateKey(authenticated.chatId, authenticated.updateId)
      if (!addReplayKey(globalUpdateKeys, callbackKey)) return stale()
      if (typeof authenticated.data !== 'string') return stale()
      const match = CALLBACK.exec(authenticated.data)
      if (match?.[1] === undefined || match[2] === undefined) return stale()
      const decision = match[1]
      const token = match[2]
      const record = pending.get(token)
      if (record === undefined || authenticated.chatId !== record.requestChatId ||
        authenticated.updateId <= record.requestUpdateId) return stale()

      // Retire before expiry, identity validation, authority issue, or mutation.
      // Any failure therefore needs a fresh authenticated confirmation.
      pending.delete(token)
      if (currentTime() >= record.expiresAtMs) return stale()
      if (decision === 'cancel') {
        return { kind: 'cancelled', text: 'Архивирование отменено.' }
      }

      let selection: ReturnType<typeof input.runtime.registry.getActive>
      let currentTarget: ResolvedTarget | undefined
      try {
        selection = input.runtime.registry.getActive(input.owner)
        currentTarget = rereadTarget(record)
      } catch {
        return stale()
      }
      if (selection.generation !== record.expectedGeneration) return stale()
      if (currentTarget === undefined ||
        targetIdentityHash(currentTarget) !== record.targetIdentityHash) return stale()

      const sourceMessageHash = provenanceHash({
        ...record,
        owner: input.owner,
        confirmChatId: authenticated.chatId,
        confirmUpdateId: authenticated.updateId,
        token,
      })
      try {
        const receipt = input.authority.issue({
          ...input.owner,
          action: record.action,
          projectId: record.projectId,
          ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
          expectedGeneration: record.expectedGeneration,
          sourceMessageHash,
        }, receiptTtlMs)
        const result = record.action === 'project.archive'
          ? await input.runtime.service.archiveProject({
            ...input.owner,
            projectId: record.projectId,
            receipt,
            sourceMessageHash,
          })
          : await input.runtime.service.archiveSession({
            ...input.owner,
            projectId: record.projectId,
            sessionId: record.sessionId!,
            receipt,
            sourceMessageHash,
          })
        return {
          kind: 'archived',
          text: record.action === 'project.archive'
            ? `✅ Проект «${currentTarget.name}» перемещён в архив.`
            : `✅ Сессия «${currentTarget.name}» перемещена в архив.`,
          action: record.action,
          projectId: record.projectId,
          ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
          generation: result.selection.generation,
        }
      } catch {
        return stale()
      }
    },
  })
}
