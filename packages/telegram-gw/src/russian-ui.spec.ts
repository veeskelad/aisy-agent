// Страж русского интерфейса.
//
// Оператор прошёл по боту руками и нашёл то, что не ловил ни один тест: «Режим:
// действовать без лишних вопросов; опасный host Bash ограничен», «🚨 Полный
// Bash», «Staged правки памяти (tap = одобрить)», «⬇️ Импортировать legacy в
// Workspace» — подпись в 35 символов, которую телефон сжимает в полоску.
//
// Ручная вычитка это не удержит: экранов больше двадцати, и каждый новый
// приносит свои слова. Поэтому проверяется результат рендереров, а не исходник:
// латиница вне списка имён собственных и подпись длиннее потолка роняют сборку.

import { describe, expect, it } from 'vitest'

import {
  renderAgentCardCatalog,
  renderAgentCardDetail,
} from './agent-card-catalog-view.js'
import { makeCardButtons, renderCard, renderResolved } from './approval-card.js'
import { renderExecution } from './execution-view.js'
import { renderEvent } from './event-bridge.js'
import { MAIN_MENU, renderMenuTour } from './menu.js'
import { renderMcpCatalog } from './mcp-catalog-view.js'
import { renderSkillCatalog } from './skill-catalog-view.js'
import {
  renderAgentScreen,
  renderBotsScreen,
  renderConnectionsScreen,
  renderEnvScreen,
  renderGoalsScreen,
  renderGrantsScreen,
  renderLimitScreen,
  renderModeScreen,
  renderResearchCard,
  renderServerScreen,
  renderServicePrompt,
  renderSettingsRoot,
  renderSystemScreen,
  renderTimersScreen,
  renderTimezoneScreen,
  type SettingsView,
} from './settings-tree.js'
import { BUTTON_LABEL_MAX } from './ux-limits.js'

/**
 * Латиница, которая остаётся: имена собственные и то, что по-русски не пишут.
 *
 * Список закрытый намеренно. Новое английское слово в интерфейсе — это либо имя
 * сервиса, и тогда его добавляют сюда осознанно, либо жаргон, просочившийся из
 * кода, и тогда тест обязан упасть.
 */
const PROPER_NAMES = new Set([
  'Aisy', 'Telegram', 'MCP', 'SSH', 'RSS', 'HTTPS', 'HTTP', 'URL', 'UTC', 'API',
  'Deepgram', 'Claude', 'Codex', 'ChatGPT', 'OpenAI', 'OpenRouter', 'Anthropic',
  'GitHub', 'Serper', 'Supadata', 'Apify', 'Whisper', 'Nova',
  // Идентификаторы моделей и часовых поясов приходят фикстурами как данные.
  'sonnet', 'opus', 'haiku', 'claude', 'anthropic', 'openai', 'gpt', 'Europe',
  'Moscow', 'Berlin', 'Kyiv', 'Lisbon', 'Asia', 'Tbilisi', 'Almaty', 'Dubai',
  'Bangkok', 'America', 'New', 'York', 'Los', 'Angeles', 'md', 'ts', 'py',
  'filesystem', 'git', 'tracker', 'reviewer', 'inspect', 'abcdef', 'example',
  'com', 'org', 'ru', 'src', 'app', 'notes', 'main', 'origin', 'push', 'bash',
  'x', 'a', 'b', 'c',
])

/** Слова латиницей, встреченные в тексте, кроме заведомо допустимых. */
function foreignWords(text: string): string[] {
  // Внутри <code> лежат команды и пути — это данные оператора, не наш текст.
  const withoutCode = text.replace(/<code>[\s\S]*?<\/code>/g, ' ')
  // Теги разметки — наш HTML, а не слова интерфейса.
  const withoutTags = withoutCode.replace(/<\/?[a-z][^>]*>/gi, ' ')
  // Адреса и имена переменных окружения — данные, которые оператор сам вводит
  // и сам читает; переводить их некуда.
  const withoutData = withoutTags
    .replace(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, ' ')
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, ' ')
  return [...withoutData.matchAll(/[A-Za-z]+/g)]
    .map((match) => match[0])
    .filter((word) => !PROPER_NAMES.has(word) && !PROPER_NAMES.has(word.toLowerCase()))
}

const TIMERS = [{ id: 'a1', kind: 'schedule', prompt: 'утренняя сводка' }]
const SERVICES = [
  { id: 'deepgram', label: '🎙 Deepgram', purpose: 'расшифровка голоса', connected: true },
  { id: 'github', label: '🐙 GitHub', purpose: 'репозитории', connected: false },
]
const VOICE = [{ id: 'deepgram', label: 'Deepgram Nova-3', selected: true }]
const CARD_TOKEN = (n: number): string => `tok${String(n).padStart(13, '0')}`

const catalog = {
  configuredName: 'reviewer',
  cutoverActive: false,
  workspace: {
    page: 1,
    totalPages: 1,
    entries: [{
      name: 'reviewer',
      activeRevision: 1,
      latestRevision: 2,
      latestHashPrefix: 'abcdef012345',
      latestStatus: 'active' as const,
      selectToken: CARD_TOKEN(1),
    }],
  },
  createWorkspaceToken: CARD_TOKEN(2),
  importWorkspaceToken: CARD_TOKEN(3),
  createProjectToken: CARD_TOKEN(4),
  importProjectToken: CARD_TOKEN(5),
}

/** Каждый экран, который оператор может увидеть, с непустым содержимым. */
const SCREENS: Array<[string, SettingsView]> = [
  ['настройки', renderSettingsRoot()],
  ['подключения', renderConnectionsScreen({ provider: 'anthropic', model: 'opus' })],
  ['ключи', renderEnvScreen({ services: SERVICES })],
  ['ключ сервиса', renderServicePrompt({
    label: '🎙 Deepgram', purpose: 'расшифровка голоса',
    source: 'console.deepgram.com', envKey: 'AISY_DEEPGRAM_KEY',
  })],
  ['лимит', renderLimitScreen({ currentUsd: 25, spentUsd: 3.5 })],
  ['системные', renderSystemScreen({
    voice: VOICE, showCostPerTurn: true, budgetEnabled: false, debug: false,
    timeZone: 'Europe/Moscow',
  })],
  ['режим работы', renderModeScreen({ mode: 'plan' })],
  ['агент', renderAgentScreen({
    provider: 'anthropic', model: 'opus', mode: 'confirm', models: ['opus', 'sonnet'],
    memory: true, agentCards: true,
  })],
  ['часовой пояс', renderTimezoneScreen({ timeZone: 'Europe/Moscow', sample: () => '09:00' })],
  ['таймеры', renderTimersScreen({ timers: TIMERS })],
  ['таймеры пустые', renderTimersScreen({ timers: [] })],
  ['цели пустые', renderGoalsScreen({})],
  ['цель', renderGoalsScreen({
    goal: {
      objective: 'добиться зелёной сборки', mode: 'until', status: 'active',
      iterationsSpent: 2, maxIterations: 10, dollarsSpent: 0.4, dollarCeiling: 5,
      lastFeedback: 'тесты ещё падают',
    },
  })],
  ['разрешения', renderGrantsScreen({
    body: '🗝 <b>Разрешения</b>\n\nПостоянных разрешений нет.',
    learned: [{
      workflowKey: 'a'.repeat(32), title: 'читать example.com', version: 1,
      expires: '13 ноября', demonstrations: 7,
    }],
  })],
  ['сервер', renderServerScreen({
    body: 'Диск 40 %', access: ['open-ssh', 'close-ssh', 'add-key', 'remove-key', 'tunnel'],
  })],
  ['боты', renderBotsScreen({ body: 'Отвечает один бот.' })],
  ['глубокий поиск', renderResearchCard({
    question: 'как устроены харнессы', pages: 3, maxPages: 10, status: 'active',
  })],
  ['личности', renderAgentCardCatalog(catalog)],
  ['личность', renderAgentCardDetail({
    name: 'reviewer',
    scopeLabel: 'Текущий проект',
    active: { revision: 2, hashPrefix: 'abcdef012345' },
    history: [{ revision: 1, status: 'superseded', hashPrefix: 'abcdef012345' }],
    catalogToken: CARD_TOKEN(6),
    publishToken: CARD_TOKEN(7),
    archiveToken: CARD_TOKEN(8),
    rollbackToken: CARD_TOKEN(9),
  })],
]

/** Экраны, которые рисуются одной строкой без кнопок. */
const TEXTS: Array<[string, string]> = [
  ['каталог MCP', renderMcpCatalog([
    { name: 'tracker', rw: 'read', tier: 2, active: true, summary: 'трекер задач' },
  ])],
  ['каталог MCP пустой', renderMcpCatalog([])],
  ['каталог навыков', renderSkillCatalog([{ name: 'inspect', summary: 'разбор кода' }])],
]

describe('интерфейс говорит по-русски', () => {
  it.each(SCREENS)('на экране «%s» нет чужих слов', (_name, view) => {
    expect(foreignWords(view.text)).toEqual([])
    for (const button of view.buttons.flat()) expect(foreignWords(button.text)).toEqual([])
  })

  it.each(TEXTS)('на экране «%s» нет чужих слов', (_name, text) => {
    expect(foreignWords(text)).toEqual([])
  })

  it.each(SCREENS)('на экране «%s» каждая подпись помещается', (_name, view) => {
    for (const button of view.buttons.flat()) {
      expect([...button.text].length).toBeLessThanOrEqual(BUTTON_LABEL_MAX)
    }
  })

  it('карточка работы и подтверждения тоже', () => {
    const работа = renderExecution({
      scope: 'общая папка',
      steps: [{ index: 1, title: 'проверить сборку', status: 'active' }],
      history: [{ name: 'read_file', status: 'completed', arg: 'src/app.ts' }],
      tool: { name: 'bash', status: 'running', arg: 'pnpm test' },
      action: { kind: 'mutate-required', status: 'recovering', missing: 'postcondition' },
      elapsedMs: 12_400,
    }).html
    expect(foreignWords(работа)).toEqual([])

    const действие = {
      actionId: 'act-1', actionHash: 'deadbeef', tier: 2 as const,
      requiresStepUp: false, summary: 'write_file(notes.md)',
    }
    expect(foreignWords(renderCard(действие, { sessionId: 's' }).html)).toEqual([])
    expect(foreignWords(renderResolved(действие, 'rejected', '14:00', 'expired'))).toEqual([])
    for (const button of makeCardButtons(действие, 'c', 'n').flat()) {
      expect(foreignWords(button.text)).toEqual([])
      expect([...button.text].length).toBeLessThanOrEqual(BUTTON_LABEL_MAX)
    }
  })

  it('главное меню и события тоже', () => {
    for (const button of MAIN_MENU.flat()) {
      expect(foreignWords(button.label)).toEqual([])
      expect([...button.label].length).toBeLessThanOrEqual(BUTTON_LABEL_MAX)
    }
    expect(foreignWords(renderMenuTour())).toEqual([])

    const панель = renderEvent({
      kind: 'settings.panel', showCostPerTurn: true, budgetEnabled: false, debug: false,
    })!
    expect(foreignWords(панель.html)).toEqual([])
    for (const button of панель.buttons?.flat() ?? []) {
      expect(foreignWords(button.text)).toEqual([])
      expect([...button.text].length).toBeLessThanOrEqual(BUTTON_LABEL_MAX)
    }
  })

  it('секунды считаются по-русски', () => {
    const html = renderExecution({ steps: [], elapsedMs: 4_000 }, { debug: true }).html
    expect(html).toContain('4,0 с')
    expect(html).not.toMatch(/\d+\.\ds/)
    expect(renderExecution({ steps: [], elapsedMs: 4_000 }).html).not.toContain('4,0 с')
  })
})
