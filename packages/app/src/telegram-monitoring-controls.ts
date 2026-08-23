import { randomUUID } from 'node:crypto'
import type {
  MonitoringEngine,
  MonitoringSource,
  MonitoringStore,
  ResolvedWorkBinding,
} from '@aisy/core'

export interface TelegramMonitoringPrincipal {
  chatId: number
  userId: number
}

export interface TelegramMonitoringButton {
  text: string
  data: string
}

export interface TelegramMonitoringView {
  text: string
  buttons: TelegramMonitoringButton[][]
}

export type TelegramMonitoringOutcome =
  | { kind: 'view'; messageId: number; view: TelegramMonitoringView }
  | { kind: 'prompt'; messageId: number; text: string }
  | { kind: 'notice'; text: string }
  | { kind: 'stale'; text: string }

export interface TelegramMonitoringControls {
  open(input: {
    principal: TelegramMonitoringPrincipal
    messageId: number
  }): TelegramMonitoringView
  handle(input: {
    data: string
    principal: TelegramMonitoringPrincipal
    messageId: number
  }): TelegramMonitoringOutcome
  handleText(input: {
    text: string
    principal: TelegramMonitoringPrincipal
  }): TelegramMonitoringOutcome | null
  /** Walking to another screen must not let a forgotten form eat later text. */
  cancelForm(): void
}

type SourceKind = 'rss' | 'web'

type PendingAction =
  | { kind: 'page'; page: number }
  | { kind: 'source'; sourceId: string; page: number }
  | { kind: 'add'; sourceKind: SourceKind; page: number }
  | { kind: 'toggle'; sourceId: string; active: boolean; page: number }
  | { kind: 'confirm-remove'; sourceId: string; page: number }
  | { kind: 'remove'; sourceId: string; page: number }

interface PendingToken {
  principal: TelegramMonitoringPrincipal
  messageId: number
  action: PendingAction
}

interface PendingForm {
  principal: TelegramMonitoringPrincipal
  messageId: number
  sourceKind: SourceKind
  page: number
  expiresAtMs: number
}

const CALLBACK_PREFIX = 'monitoring:v1:'
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DEFAULT_PAGE_SIZE = 8
const DEFAULT_FORM_TTL_MS = 5 * 60_000
const MAX_ISSUED_TOKENS = 100_000
const POLL_INTERVAL_MS: Readonly<Record<SourceKind, number>> = Object.freeze({
  rss: 15 * 60_000,
  web: 60 * 60_000,
})

function samePrincipal(left: TelegramMonitoringPrincipal, right: TelegramMonitoringPrincipal): boolean {
  return left.chatId === right.chatId && left.userId === right.userId
}

function hostname(locator: string): string {
  try { return new URL(locator).hostname.toLowerCase() } catch { return 'invalid' }
}

function intervalLabel(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000} ч`
  return `${Math.ceil(milliseconds / 60_000)} мин`
}

function parseSourceText(text: string): { locator: string; criteria: string } | null {
  const normalized = text.normalize('NFKC').replaceAll('\r\n', '\n').trim()
  if (normalized.length === 0 || normalized.length > 12_100) return null
  const [first = '', ...rest] = normalized.split('\n')
  const locator = first.trim()
  const criteria = rest.join('\n').trim()
  if (locator.length === 0 || locator.length > 2_048 || criteria.length > 10_000) return null
  return { locator, criteria }
}

export function makeTelegramMonitoringControls(input: {
  engine: Pick<MonitoringEngine, 'registerSource' | 'pauseSource' | 'resumeSource' | 'removeSource'>
  store: Pick<MonitoringStore, 'listSources' | 'getSource' | 'getSourceEgressDomain'>
  binding: ResolvedWorkBinding
  resolveBinding(binding: ResolvedWorkBinding): void
  newTokenId?: () => string
  newSourceId?: () => string
  nowMs?: () => number
  pageSize?: number
  formTtlMs?: number
}): TelegramMonitoringControls {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE
  const formTtlMs = input.formTtlMs ?? DEFAULT_FORM_TTL_MS
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 20 ||
    !Number.isSafeInteger(formTtlMs) || formTtlMs < 1 || formTtlMs > 30 * 60_000) {
    throw new RangeError('invalid monitoring controls bounds')
  }
  const newTokenId = input.newTokenId ?? randomUUID
  const newSourceId = input.newSourceId ?? randomUUID
  const nowMs = input.nowMs ?? Date.now
  const pending = new Map<string, PendingToken>()
  const issued = new Set<string>()
  let pendingForm: PendingForm | null = null

  const mint = (
    principal: TelegramMonitoringPrincipal,
    messageId: number,
    action: PendingAction,
  ): string => {
    if (issued.size >= MAX_ISSUED_TOKENS) throw new Error('monitoring token space exhausted')
    const token = newTokenId()
    if (!TOKEN.test(token) || issued.has(token)) throw new Error('invalid monitoring token')
    issued.add(token)
    pending.set(token, { principal: { ...principal }, messageId, action })
    return CALLBACK_PREFIX + token
  }

  const sources = (): MonitoringSource[] => {
    input.resolveBinding(input.binding)
    return input.store.listSources(input.binding)
      .filter((source) => source.kind === 'rss' || source.kind === 'web')
  }

  const exactSource = (sourceId: string): MonitoringSource | null =>
    sources().find((source) => source.id === sourceId) ?? null

  const renderList = (
    principal: TelegramMonitoringPrincipal,
    messageId: number,
    requestedPage: number,
    notice?: string,
  ): TelegramMonitoringView => {
    pending.clear()
    const all = sources()
    const pageCount = Math.max(1, Math.ceil(all.length / pageSize))
    const page = Math.min(Math.max(0, requestedPage), pageCount - 1)
    const buttons: TelegramMonitoringButton[][] = all
      .slice(page * pageSize, (page + 1) * pageSize)
      .map((source) => [{
        text: `${source.status === 'active' ? '✅' : source.status === 'paused' ? '⏸' : '⚠️'} ` +
          `${source.kind.toUpperCase()} · ${hostname(source.locator)}`,
        data: mint(principal, messageId, { kind: 'source', sourceId: source.id, page }),
      }])
    if (pageCount > 1) {
      buttons.push([
        ...(page > 0 ? [{
          text: '◀️', data: mint(principal, messageId, { kind: 'page', page: page - 1 }),
        }] : []),
        { text: `${page + 1}/${pageCount}`, data: mint(principal, messageId, { kind: 'page', page }) },
        ...(page + 1 < pageCount ? [{
          text: '▶️', data: mint(principal, messageId, { kind: 'page', page: page + 1 }),
        }] : []),
      ])
    }
    buttons.push([
      { text: '➕ RSS', data: mint(principal, messageId, { kind: 'add', sourceKind: 'rss', page }) },
      { text: '➕ Web', data: mint(principal, messageId, { kind: 'add', sourceKind: 'web', page }) },
    ])
    return {
      text: `${notice === undefined ? '' : `${notice}\n\n`}🔭 Источники · ${all.length}\n` +
        (all.length === 0
          ? 'Пока пусто. Добавь RSS или обычную HTTPS-страницу.'
          : 'В карточке видны только домен, состояние и период. Содержимое хранится локально.'),
      buttons,
    }
  }

  const renderSource = (
    principal: TelegramMonitoringPrincipal,
    messageId: number,
    source: MonitoringSource,
    page: number,
  ): TelegramMonitoringView => {
    pending.clear()
    const grant = input.store.getSourceEgressDomain(source.id)
    const readGrant = grant === null ? 'снято' : `HTTPS ${grant}:443`
    const active = source.status === 'active'
    return {
      text: `🔭 ${source.kind.toUpperCase()} · ${hostname(source.locator)}\n` +
        `Состояние: ${active ? 'активен' : source.status === 'paused' ? 'на паузе' : 'карантин'}\n` +
        `Проверка: раз в ${intervalLabel(source.pollIntervalMs)}\n` +
        `Разрешено только читать: ${readGrant}`,
      buttons: [
        ...(source.status === 'quarantined' ? [] : [[{
          text: active ? '⏸ Пауза' : '▶️ Возобновить',
          data: mint(principal, messageId, {
            kind: 'toggle', sourceId: source.id, active: !active, page,
          }),
        }]]),
        [{
          text: '🗑 Удалить',
          data: mint(principal, messageId, { kind: 'confirm-remove', sourceId: source.id, page }),
        }],
        [{ text: '⬅️ К списку', data: mint(principal, messageId, { kind: 'page', page }) }],
      ],
    }
  }

  const renderRemove = (
    principal: TelegramMonitoringPrincipal,
    messageId: number,
    source: MonitoringSource,
    page: number,
  ): TelegramMonitoringView => {
    pending.clear()
    return {
      text: `🗑 Удалить ${source.kind.toUpperCase()} · ${hostname(source.locator)}?\n` +
        'Сбор остановится, разрешение на этот адрес снимется. Уже собранное и сводки останутся.',
      buttons: [[
        {
          text: '🗑 Да, удалить',
          data: mint(principal, messageId, { kind: 'remove', sourceId: source.id, page }),
        },
        {
          text: '⬅️ Отмена',
          data: mint(principal, messageId, { kind: 'source', sourceId: source.id, page }),
        },
      ]],
    }
  }

  return Object.freeze<TelegramMonitoringControls>({
    open({ principal, messageId }) {
      pendingForm = null
      return renderList(principal, messageId, 0)
    },

    handle({ data, principal, messageId }) {
      if (!data.startsWith(CALLBACK_PREFIX)) return { kind: 'stale', text: 'Экран устарел.' }
      const token = data.slice(CALLBACK_PREFIX.length)
      const found = pending.get(token)
      if (!found || found.messageId !== messageId || !samePrincipal(found.principal, principal)) {
        return { kind: 'stale', text: 'Экран устарел.' }
      }
      // Spend before any authority check or mutation: concurrent/replayed taps
      // cannot execute the same source operation twice.
      pending.delete(token)
      try {
        input.resolveBinding(input.binding)
        const action = found.action
        if (action.kind !== 'add') pendingForm = null
        if (action.kind === 'page') {
          return { kind: 'view', messageId, view: renderList(principal, messageId, action.page) }
        }
        if (action.kind === 'add') {
          pendingForm = {
            principal: { ...principal }, messageId, sourceKind: action.sourceKind,
            page: action.page, expiresAtMs: nowMs() + formTtlMs,
          }
          return {
            kind: 'prompt',
            messageId,
            text: `Пришли HTTPS URL для ${action.sourceKind.toUpperCase()} первой строкой. ` +
              'Со второй строки можно добавить, что именно отбирать. Сообщение удалю сразу.',
          }
        }
        const source = exactSource(action.sourceId)
        if (source === null) return { kind: 'stale', text: 'Источник уже изменён или удалён.' }
        if (action.kind === 'source') {
          return { kind: 'view', messageId, view: renderSource(principal, messageId, source, action.page) }
        }
        if (action.kind === 'confirm-remove') {
          return { kind: 'view', messageId, view: renderRemove(principal, messageId, source, action.page) }
        }
        if (action.kind === 'toggle') {
          const changed = action.active
            ? input.engine.resumeSource(source.id, input.binding)
            : input.engine.pauseSource(source.id, input.binding)
          return { kind: 'view', messageId, view: renderSource(principal, messageId, changed, action.page) }
        }
        input.engine.removeSource(source.id, input.binding)
        return {
          kind: 'view', messageId,
          view: renderList(principal, messageId, action.page, '✅ Источник удалён, разрешение снято.'),
        }
      } catch {
        return { kind: 'notice', text: '❌ Не удалось безопасно изменить источник.' }
      }
    },

    handleText({ text, principal }) {
      const form = pendingForm
      if (form === null) return null
      if (form.expiresAtMs < nowMs()) {
        pendingForm = null
        return null
      }
      if (!samePrincipal(form.principal, principal)) return null
      pendingForm = null
      const parsed = parseSourceText(text)
      if (parsed === null) return { kind: 'notice', text: '❌ Первой строкой нужен адрес на HTTPS.' }
      try {
        const source = input.engine.registerSource({
          id: newSourceId(),
          kind: form.sourceKind,
          locator: parsed.locator,
          binding: input.binding,
          criteria: parsed.criteria,
          pollIntervalMs: POLL_INTERVAL_MS[form.sourceKind],
        })
        return {
          kind: 'view',
          messageId: form.messageId,
          view: renderSource(principal, form.messageId, source, form.page),
        }
      } catch {
        return {
          kind: 'notice',
          text: '❌ Источник не добавлен. Нужен обычный публичный адрес на HTTPS — без ключей, логина, цифрового адреса и нестандартного порта.',
        }
      }
    },

    cancelForm() {
      pendingForm = null
    },
  })
}
