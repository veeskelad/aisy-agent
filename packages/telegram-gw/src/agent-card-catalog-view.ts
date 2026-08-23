import { escapeHtml } from './render.js'
import { fitLabel } from './ux-limits.js'
import type { SettingsButton, SettingsView } from './settings-tree.js'

export type AgentCardCallbackVerb =
  | 'select' | 'page' | 'create' | 'import' | 'publish'
  | 'archive' | 'rollback' | 'catalog'

export type AgentCardCallback = Readonly<{
  verb: AgentCardCallbackVerb
  token: string
}>

export type TokenizedAgentCardEntry = Readonly<{
  name: string
  activeRevision: number | null
  latestRevision: number
  latestHashPrefix: string
  latestStatus: 'active' | 'superseded' | 'archived'
  selectToken: string
}>

export type TokenizedAgentCardPage = Readonly<{
  page: number
  totalPages: number
  entries: readonly TokenizedAgentCardEntry[]
  previousToken?: string
  nextToken?: string
}>

export interface TokenizedAgentCardCatalog {
  readonly configuredName: string
  readonly cutoverActive: boolean
  readonly workspace: TokenizedAgentCardPage
  readonly project?: TokenizedAgentCardPage
  readonly createWorkspaceToken: string
  readonly importWorkspaceToken?: string
  readonly createProjectToken?: string
  readonly importProjectToken?: string
}

export interface TokenizedAgentCardDetail {
  readonly name: string
  readonly scopeLabel: 'Общая папка' | 'Текущий проект'
  readonly active: null | Readonly<{ revision: number; hashPrefix: string }>
  readonly history: readonly Readonly<{
    revision: number
    status: 'active' | 'superseded' | 'archived'
    hashPrefix: string
  }>[]
  readonly catalogToken: string
  readonly publishToken?: string
  readonly archiveToken?: string
  readonly rollbackToken?: string
}

const PREFIX = 'ac:v1:'
const TOKEN = /^[A-Za-z0-9_-]{16,24}$/
const VERBS = new Set<AgentCardCallbackVerb>([
  'select', 'page', 'create', 'import', 'publish', 'archive', 'rollback', 'catalog',
])

export function encodeAgentCardCallback(value: AgentCardCallback): string {
  if (!VERBS.has(value.verb) || !TOKEN.test(value.token)) {
    throw new TypeError('invalid AgentCard callback')
  }
  const encoded = `${PREFIX}${value.verb}:${value.token}`
  if (Buffer.byteLength(encoded, 'utf8') > 64) throw new TypeError('invalid AgentCard callback')
  return encoded
}

export function decodeAgentCardCallback(data: string): AgentCardCallback | null {
  if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 64 || !data.startsWith(PREFIX)) return null
  const parts = data.slice(PREFIX.length).split(':')
  if (parts.length !== 2) return null
  const [verb, token] = parts
  if (!verb || !token || !VERBS.has(verb as AgentCardCallbackVerb) || !TOKEN.test(token)) return null
  return Object.freeze({ verb: verb as AgentCardCallbackVerb, token })
}

const statusLabel = (status: TokenizedAgentCardEntry['latestStatus']): string =>
  status === 'active' ? 'в работе' : status === 'archived' ? 'в архиве' : 'заменена'

function callbackButton(text: string, verb: AgentCardCallbackVerb, token: string): SettingsButton {
  return { text, data: encodeAgentCardCallback({ verb, token }) }
}

function pageLines(title: string, page: TokenizedAgentCardPage): string[] {
  const lines = [`<b>${title} · ${page.page}/${Math.max(1, page.totalPages)}</b>`]
  if (page.entries.length === 0) return [...lines, 'Пока пусто.']
  for (const entry of page.entries.slice(0, 8)) {
    const active = entry.activeRevision === null
      ? 'ни одна не в работе'
      : `в работе версия ${entry.activeRevision}`
    lines.push(
      `• ${escapeHtml(entry.name)} · ${active} · последняя ${entry.latestRevision} ` +
      `· ${statusLabel(entry.latestStatus)} · ${escapeHtml(entry.latestHashPrefix)}`,
    )
  }
  return lines
}

function pageButtons(page: TokenizedAgentCardPage): SettingsButton[][] {
  const rows = page.entries.slice(0, 8).map(entry => [
    callbackButton(fitLabel(`Открыть ${entry.name}`), 'select', entry.selectToken),
  ])
  const navigation: SettingsButton[] = []
  if (page.previousToken) navigation.push(callbackButton('←', 'page', page.previousToken))
  if (page.nextToken) navigation.push(callbackButton('→', 'page', page.nextToken))
  if (navigation.length > 0) rows.push(navigation)
  return rows
}

export function renderAgentCardCatalog(input: TokenizedAgentCardCatalog): SettingsView {
  const lines = [
    '🧬 <b>Личности</b>',
    '',
    `Выбрана при запуске: ${escapeHtml(input.configuredName || 'не выбрана')}`,
    `Новые версии применяются: ${input.cutoverActive ? 'да' : 'нет'}`,
    '',
    ...pageLines('Общая папка', input.workspace),
  ]
  if (input.project) lines.push('', ...pageLines('Текущий проект', input.project))
  lines.push(
    '',
    'Выбор здесь не меняет личность, с которой я запускаюсь.',
    'Новая версия начнёт работать только после отдельного переключения и перезапуска.',
  )

  const buttons: SettingsButton[][] = [
    ...pageButtons(input.workspace),
    ...(input.project ? pageButtons(input.project) : []),
    [callbackButton('➕ Создать в общей', 'create', input.createWorkspaceToken)],
    ...(input.importWorkspaceToken
      ? [[callbackButton('⬇️ Импорт в общую', 'import', input.importWorkspaceToken)]]
      : []),
    ...(input.createProjectToken
      ? [[callbackButton('➕ Создать в проекте', 'create', input.createProjectToken)]]
      : []),
    ...(input.importProjectToken
      ? [[callbackButton('⬇️ Импорт в проект', 'import', input.importProjectToken)]]
      : []),
    [{ text: '← Назад', data: 'cfg:open:agent' }],
  ]
  return { text: lines.join('\n'), buttons }
}

export function renderAgentCardDetail(input: TokenizedAgentCardDetail): SettingsView {
  const lines = [
    `🧬 <b>${escapeHtml(input.name)}</b>`,
    `Где лежит: ${input.scopeLabel}`,
    input.active === null
      ? 'Ни одна версия не в работе.'
      : `В работе версия ${input.active.revision} · ${escapeHtml(input.active.hashPrefix)}`,
  ]
  const history = input.history.slice(-8)
  if (history.length > 0) {
    lines.push('', 'Последние версии:', ...history.map(item =>
      `• ${item.revision} · ${statusLabel(item.status)} · ${escapeHtml(item.hashPrefix)}`))
  }
  lines.push('', 'Каждое изменение спрашивает одноразовый код; откат создаёт новую версию.')

  const buttons: SettingsButton[][] = [
    ...(input.publishToken
      ? [[callbackButton('✏️ Новая версия', 'publish', input.publishToken)]]
      : []),
    ...(input.archiveToken
      ? [[callbackButton('🗄 В архив', 'archive', input.archiveToken)]]
      : []),
    ...(input.rollbackToken
      ? [[callbackButton('↩️ Откатить', 'rollback', input.rollbackToken)]]
      : []),
    [callbackButton('← К каталогу', 'catalog', input.catalogToken)],
  ]
  return { text: lines.join('\n'), buttons }
}
