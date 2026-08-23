import type { AgentCardBinding, AgentCardTarget } from '@aisy/core'
import type { AgentCardCallbackVerb } from '@aisy/telegram-gw'

const TOKEN = /^[A-Za-z0-9_-]{16,24}$/
const MAX_INTENTS = 64
const MAX_ISSUED_TOKENS = 100_000
const TOKEN_TTL_MS = 5 * 60_000
const FORM_TTL_MS = 5 * 60_000

export type AgentCardPrincipal = Readonly<{ chatId: number; userId: number }>

export type AgentCardIntent =
  | Readonly<{ kind: 'catalog'; workspacePage: number; projectPage: number }>
  | Readonly<{ kind: 'page'; workspacePage: number; projectPage: number }>
  | Readonly<{ kind: 'select'; target: AgentCardTarget }>
  | Readonly<{ kind: 'create'; binding: AgentCardBinding }>
  | Readonly<{ kind: 'import'; binding: AgentCardBinding }>
  | Readonly<{ kind: 'publish'; target: AgentCardTarget }>
  | Readonly<{ kind: 'archive'; target: AgentCardTarget }>
  | Readonly<{ kind: 'rollback'; target: AgentCardTarget }>

export type AgentCardPendingForm = Readonly<{
  formId: string
  principal: AgentCardPrincipal
  operation: 'create' | 'publish' | 'import-legacy'
  binding: AgentCardBinding
  target: AgentCardTarget | null
  createdAtMs: number
  expiresAtMs: number
}>

export interface PreparedGeneration {
  readonly callbacks: readonly Readonly<{ verb: AgentCardCallbackVerb; token: string }>[]
  bind(messageId: number): void
  discard(): void
}

export interface TelegramAgentCardState {
  prepare(input: { principal: AgentCardPrincipal; intents: readonly AgentCardIntent[] }): PreparedGeneration
  claimCallback(input: {
    principal: AgentCardPrincipal
    messageId: number
    verb: AgentCardCallbackVerb
    token: string
  }): AgentCardIntent | null
  openForm(input: Omit<AgentCardPendingForm, 'formId' | 'createdAtMs' | 'expiresAtMs'>): AgentCardPendingForm
  claimForm(principal: AgentCardPrincipal):
    | Readonly<{ kind: 'claimed'; form: AgentCardPendingForm; finish(): void }>
    | Readonly<{ kind: 'busy' }>
    | Readonly<{ kind: 'foreign' }>
    | Readonly<{ kind: 'none' }>
  invalidate(principal: AgentCardPrincipal): void
}

export type TelegramAgentCardStateErrorCode =
  | 'INVALID_INPUT'
  | 'TOKEN_SOURCE_INVALID'
  | 'TOKEN_REUSED'
  | 'TOKEN_SPACE_EXHAUSTED'
  | 'TOO_MANY_INTENTS'
  | 'GENERATION_STATE_INVALID'

export class TelegramAgentCardStateError extends Error {
  constructor(readonly code: TelegramAgentCardStateErrorCode) {
    super(code)
    this.name = 'TelegramAgentCardStateError'
  }
}

type StoredCallback = Readonly<{
  verb: AgentCardCallbackVerb
  token: string
  intent: AgentCardIntent
}>

type Generation = {
  readonly principal: AgentCardPrincipal
  readonly callbacks: readonly StoredCallback[]
  readonly expiresAtMs: number
  messageId: number | null
  discarded: boolean
}

function principalSnapshot(value: AgentCardPrincipal): AgentCardPrincipal {
  if (!Number.isSafeInteger(value.chatId) || value.chatId === 0 ||
    !Number.isSafeInteger(value.userId) || value.userId < 1) {
    throw new TelegramAgentCardStateError('INVALID_INPUT')
  }
  return Object.freeze({ chatId: value.chatId, userId: value.userId })
}

function principalKey(value: AgentCardPrincipal): string {
  return `${value.chatId}\u0000${value.userId}`
}

function bindingSnapshot(value: AgentCardBinding): AgentCardBinding {
  if (value.scope === 'workspace' && Object.keys(value).length === 1) {
    return Object.freeze({ scope: 'workspace' })
  }
  if (value.scope === 'project' && Object.keys(value).length === 2 &&
    typeof value.projectId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.projectId)) {
    return Object.freeze({ scope: 'project', projectId: value.projectId })
  }
  throw new TelegramAgentCardStateError('INVALID_INPUT')
}

function targetSnapshot(value: AgentCardTarget): AgentCardTarget {
  if (Object.keys(value).length !== 2 || typeof value.name !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.name)) {
    throw new TelegramAgentCardStateError('INVALID_INPUT')
  }
  return Object.freeze({ binding: bindingSnapshot(value.binding), name: value.name })
}

function intentSnapshot(value: AgentCardIntent): AgentCardIntent {
  switch (value.kind) {
    case 'catalog':
    case 'page':
      if (!Number.isSafeInteger(value.workspacePage) || value.workspacePage < 0 ||
        !Number.isSafeInteger(value.projectPage) || value.projectPage < 0) {
        throw new TelegramAgentCardStateError('INVALID_INPUT')
      }
      return Object.freeze({
        kind: value.kind, workspacePage: value.workspacePage, projectPage: value.projectPage,
      })
    case 'select':
      return Object.freeze({ kind: 'select', target: targetSnapshot(value.target) })
    case 'create':
    case 'import':
      return Object.freeze({ kind: value.kind, binding: bindingSnapshot(value.binding) })
    case 'publish':
    case 'archive':
    case 'rollback':
      return Object.freeze({ kind: value.kind, target: targetSnapshot(value.target) })
  }
}

function verbFor(intent: AgentCardIntent): AgentCardCallbackVerb {
  return intent.kind
}

export function makeTelegramAgentCardState(input: {
  nowMs: () => number
  newToken: () => string
}): TelegramAgentCardState {
  const generations = new Map<string, Generation>()
  const forms = new Map<string, AgentCardPendingForm>()
  const inFlight = new Map<string, Readonly<{ formId: string; expiresAtMs: number }>>()
  const issuedTokens = new Set<string>()

  const now = (): number => {
    const value = input.nowMs()
    if (!Number.isSafeInteger(value) || value < 0) throw new TelegramAgentCardStateError('INVALID_INPUT')
    return value
  }

  const issue = (): string => {
    if (issuedTokens.size >= MAX_ISSUED_TOKENS) {
      throw new TelegramAgentCardStateError('TOKEN_SPACE_EXHAUSTED')
    }
    let token: string
    try { token = input.newToken() } catch {
      throw new TelegramAgentCardStateError('TOKEN_SOURCE_INVALID')
    }
    if (typeof token !== 'string' || !TOKEN.test(token)) {
      throw new TelegramAgentCardStateError('TOKEN_SOURCE_INVALID')
    }
    if (issuedTokens.has(token)) throw new TelegramAgentCardStateError('TOKEN_REUSED')
    issuedTokens.add(token)
    return token
  }

  const removeExpiredForm = (key: string, timestamp: number): AgentCardPendingForm | null => {
    const form = forms.get(key)
    if (!form) return null
    if (timestamp >= form.expiresAtMs) {
      forms.delete(key)
      return null
    }
    return form
  }

  const state: TelegramAgentCardState = {
    prepare({ principal: rawPrincipal, intents }) {
      const principal = principalSnapshot(rawPrincipal)
      if (!Array.isArray(intents) || intents.length < 1) {
        throw new TelegramAgentCardStateError('INVALID_INPUT')
      }
      if (intents.length > MAX_INTENTS) throw new TelegramAgentCardStateError('TOO_MANY_INTENTS')
      const key = principalKey(principal)
      generations.delete(key)
      const timestamp = now()
      const callbacks = Object.freeze(intents.map(rawIntent => {
        const intent = intentSnapshot(rawIntent)
        return Object.freeze({ verb: verbFor(intent), token: issue(), intent })
      }))
      const generation: Generation = {
        principal,
        callbacks,
        expiresAtMs: timestamp + TOKEN_TTL_MS,
        messageId: null,
        discarded: false,
      }
      generations.set(key, generation)
      return Object.freeze({
        callbacks: Object.freeze(callbacks.map(({ verb, token }) => Object.freeze({ verb, token }))),
        bind(messageId: number) {
          if (generation.discarded || generation.messageId !== null || generations.get(key) !== generation ||
            !Number.isSafeInteger(messageId) || messageId < 1) {
            throw new TelegramAgentCardStateError('GENERATION_STATE_INVALID')
          }
          generation.messageId = messageId
        },
        discard() {
          if (generations.get(key) === generation) generations.delete(key)
          generation.discarded = true
        },
      })
    },

    claimCallback({ principal: rawPrincipal, messageId, verb, token }) {
      let principal: AgentCardPrincipal
      try { principal = principalSnapshot(rawPrincipal) } catch { return null }
      if (!Number.isSafeInteger(messageId) || messageId < 1 || !TOKEN.test(token)) return null
      const key = principalKey(principal)
      const generation = generations.get(key)
      if (!generation || generation.discarded || generation.messageId !== messageId) return null
      if (now() >= generation.expiresAtMs) {
        generations.delete(key)
        return null
      }
      const callback = generation.callbacks.find(item => item.token === token && item.verb === verb)
      if (!callback) return null
      generations.delete(key)
      generation.discarded = true
      return callback.intent
    },

    openForm(raw) {
      const principal = principalSnapshot(raw.principal)
      const binding = bindingSnapshot(raw.binding)
      const target = raw.target === null ? null : targetSnapshot(raw.target)
      if (!['create', 'publish', 'import-legacy'].includes(raw.operation) ||
        (raw.operation === 'publish' ? target === null : target !== null)) {
        throw new TelegramAgentCardStateError('INVALID_INPUT')
      }
      if (target !== null &&
        (target.binding.scope !== binding.scope ||
          (target.binding.scope === 'project' && binding.scope === 'project' &&
            target.binding.projectId !== binding.projectId))) {
        throw new TelegramAgentCardStateError('INVALID_INPUT')
      }
      const timestamp = now()
      const form = Object.freeze({
        formId: issue(),
        principal,
        operation: raw.operation,
        binding,
        target,
        createdAtMs: timestamp,
        expiresAtMs: timestamp + FORM_TTL_MS,
      })
      const key = principalKey(principal)
      forms.set(key, form)
      inFlight.delete(key)
      return form
    },

    claimForm(rawPrincipal) {
      let principal: AgentCardPrincipal
      try { principal = principalSnapshot(rawPrincipal) } catch { return Object.freeze({ kind: 'none' as const }) }
      const key = principalKey(principal)
      const timestamp = now()
      const exactInFlight = inFlight.get(key)
      if (exactInFlight && timestamp < exactInFlight.expiresAtMs) {
        return Object.freeze({ kind: 'busy' as const })
      }
      if (exactInFlight) inFlight.delete(key)
      const form = removeExpiredForm(key, timestamp)
      if (form) {
        forms.delete(key)
        inFlight.set(key, Object.freeze({ formId: form.formId, expiresAtMs: form.expiresAtMs }))
        let finished = false
        return Object.freeze({
          kind: 'claimed' as const,
          form,
          finish() {
            if (finished) return
            finished = true
            if (inFlight.get(key)?.formId === form.formId) inFlight.delete(key)
          },
        })
      }
      for (const [otherKey, otherForm] of forms) {
        if (timestamp >= otherForm.expiresAtMs) {
          forms.delete(otherKey)
          continue
        }
        if (otherForm.principal.chatId === principal.chatId && otherForm.principal.userId !== principal.userId) {
          return Object.freeze({ kind: 'foreign' as const })
        }
      }
      for (const [otherKey, other] of inFlight) {
        if (timestamp >= other.expiresAtMs) {
          inFlight.delete(otherKey)
          continue
        }
        const [chatId, userId] = otherKey.split('\u0000').map(Number)
        if (chatId === principal.chatId && userId !== principal.userId) {
          return Object.freeze({ kind: 'foreign' as const })
        }
      }
      return Object.freeze({ kind: 'none' as const })
    },

    invalidate(rawPrincipal) {
      const principal = principalSnapshot(rawPrincipal)
      const key = principalKey(principal)
      generations.delete(key)
      forms.delete(key)
      inFlight.delete(key)
    },
  }
  return Object.freeze(state)
}
