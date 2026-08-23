// Settings and agent screens as a button tree.
//
// Every capability behind these buttons already existed — as a typed command
// (`/server`, `/mode`, `/bots`, `/restart`, `/voice`, `/triggers`). On a phone
// nobody types those, so the feature was effectively absent. This module is the
// pure view layer: screens, labels, callback codec. What each button does stays
// in the transport, which owns the live ports.

import { escapeHtml, plural } from './render.js'
import { fitLabel } from './ux-limits.js'

export type SettingsScreen =
  | 'root'
  | 'connections'
  | 'env'
  | 'bots'
  | 'timers'
  | 'limit'
  | 'server'
  | 'system'
  | 'agent'
  | 'agent-cards'
  | 'mode'
  | 'timezone'
  | 'grants'
  | 'goals'

/** Как оператор называет свободу агента. Четыре режима, одно имя у каждого. */
export type AgentMode = 'auto' | 'confirm' | 'plan' | 'bypass'

export type SettingsAction =
  | { kind: 'open'; screen: SettingsScreen }
  | { kind: 'reconnect-brain' }
  | { kind: 'pick-service'; serviceId: string }
  | { kind: 'custom-service' }
  | { kind: 'set-limit'; dollars: number }
  | { kind: 'set-mode'; mode: AgentMode }
  | { kind: 'set-model'; model: string }
  | { kind: 'custom-model' }
  | { kind: 'set-voice'; providerId: string }
  | { kind: 'set-timezone'; timeZone: string }
  | { kind: 'cancel-trigger'; triggerId: string }
  | { kind: 'restart' }
  | { kind: 'reset-grants' }
  | { kind: 'revoke-learned'; workflowKey: string }
  | { kind: 'consolidate' }
  | { kind: 'open-staging' }
  | { kind: 'stop-goal' }
  | { kind: 'add-bot' }
  | { kind: 'server-access'; operation: ServerAccessOperation }
  | { kind: 'toggle'; setting: 'showCostPerTurn' | 'budgetEnabled' | 'debug' }

/** The doors an installation may open on itself; the runtime decides which exist. */
export type ServerAccessOperation =
  | 'open-ssh'
  | 'close-ssh'
  | 'add-key'
  | 'remove-key'
  | 'tunnel'

export const SERVER_ACCESS_OPERATIONS: readonly ServerAccessOperation[] = Object.freeze([
  'open-ssh', 'close-ssh', 'add-key', 'remove-key', 'tunnel',
])

const ACCESS_LABEL: Readonly<Record<ServerAccessOperation, string>> = {
  'open-ssh': '🔓 Открыть SSH',
  'close-ssh': '🔒 Закрыть SSH',
  'add-key': '🗝 Добавить ключ',
  'remove-key': '🗑 Убрать ключ',
  tunnel: '🌐 Туннель',
}

export interface SettingsButton {
  text: string
  data: string
}

export interface SettingsView {
  text: string
  buttons: SettingsButton[][]
}

const PREFIX = 'cfg:'
const SCREENS: readonly SettingsScreen[] = [
  'root', 'connections', 'env', 'bots', 'timers', 'limit', 'server', 'system', 'agent',
  'agent-cards', 'mode', 'timezone', 'grants', 'goals',
]

/**
 * Один словарь режима на весь бот.
 *
 * Раньше их было четыре: подпись кнопки жила здесь, описание — в composition,
 * третий набор слов в MCP-меню, четвёртый в отказах Plan Mode. Ничто не мешало
 * им разойтись, и они разошлись: кнопка обещала «Без спроса», а строка под ней
 * говорила «действовать без лишних вопросов; опасный host Bash ограничен».
 */
export const MODE_TEXT: Readonly<Record<AgentMode, {
  /** Подпись кнопки. */
  button: string
  /** Как режим называется в предложении: «Режим: сначала план». */
  status: string
  /** Что он значит для оператора — одной строкой, без терминов. */
  hint: string
}>> = Object.freeze({
  auto: {
    button: '⚡️ Без спроса',
    status: 'без спроса',
    hint: 'работаю сам, останавливаюсь только перед необратимым',
  },
  confirm: {
    button: '✋ С подтверждением',
    status: 'с подтверждением',
    hint: 'жду ✔ перед каждой правкой файла',
  },
  plan: {
    button: '📋 Сначала план',
    status: 'сначала план',
    hint: 'изучу задачу, покажу шаги, начну после твоего ✔',
  },
  bypass: {
    button: '🚨 Без ограничений',
    status: 'без ограничений',
    hint: 'команды в терминале выполняю без разбора, пока сам не выключишь',
  },
})

/** Строка состояния режима для экранов и ответов на команду. */
export function modeStatusLine(mode: AgentMode): string {
  return `Режим: ${MODE_TEXT[mode].status} — ${MODE_TEXT[mode].hint}`
}

/**
 * Насколько инструмент опасен — теми же словами, что и режимы.
 *
 * Раньше это писалось как «T2» на одном экране и «с подтверждением» на другом,
 * а номер уровня не объяснялся нигде.
 */
export function askLevel(tier: number): string {
  if (tier >= 3) return 'с подтверждением и кодом'
  return tier >= 2 ? 'с подтверждением' : 'без спроса'
}

/**
 * Zones offered as buttons. Not a world list — the point is one tap for where
 * the operator actually is; anything else goes through AISY_TIMEZONE.
 */
export const TIMEZONE_PRESETS: readonly string[] = Object.freeze([
  'Europe/Moscow', 'Europe/Berlin', 'Europe/Kyiv', 'Europe/Lisbon',
  'Asia/Tbilisi', 'Asia/Almaty', 'Asia/Dubai', 'Asia/Bangkok',
  'America/New_York', 'America/Los_Angeles', 'UTC',
])

/**
 * Города по-русски. Значение зоны остаётся стандартным именем — оно уходит в
 * форматирование дат; латиницей называется только UTC, который так и читается.
 */
const TIMEZONE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'Europe/Moscow': 'Москва',
  'Europe/Berlin': 'Берлин',
  'Europe/Kyiv': 'Киев',
  'Europe/Lisbon': 'Лиссабон',
  'Asia/Tbilisi': 'Тбилиси',
  'Asia/Almaty': 'Алматы',
  'Asia/Dubai': 'Дубай',
  'Asia/Bangkok': 'Бангкок',
  'America/New_York': 'Нью-Йорк',
  'America/Los_Angeles': 'Лос-Анджелес',
  UTC: 'UTC',
})

/** Как зона называется в тексте: город, а не путь в базе зон. */
export function timeZoneLabel(zone: string): string {
  return TIMEZONE_LABEL[zone] ?? zone
}
const MODES = ['auto', 'confirm', 'plan', 'bypass'] as const
const TOGGLES = ['showCostPerTurn', 'budgetEnabled', 'debug'] as const

/** Daily API spend caps, matching the reference bot's presets. 0 = no cap. */
export const LIMIT_PRESETS: readonly number[] = Object.freeze([0, 10, 25, 50, 100, 200])

function button(text: string, suffix: string): SettingsButton {
  return { text, data: PREFIX + suffix }
}

function open(text: string, screen: SettingsScreen): SettingsButton {
  return button(text, `open:${screen}`)
}

const backRow = (screen: SettingsScreen = 'root'): SettingsButton[] => [
  open('← Назад', screen),
]

export function decodeSettingsAction(data: string): SettingsAction | null {
  if (!data.startsWith(PREFIX)) return null
  const [verb, argument, extra] = data.slice(PREFIX.length).split(':')
  if (extra !== undefined) return null
  switch (verb) {
    case 'open':
      return argument !== undefined && (SCREENS as readonly string[]).includes(argument)
        ? { kind: 'open', screen: argument as SettingsScreen }
        : null
    case 'reconnect':
      return argument === undefined ? { kind: 'reconnect-brain' } : null
    case 'restart':
      return argument === undefined ? { kind: 'restart' } : null
    case 'ungrant':
      return argument === undefined ? { kind: 'reset-grants' } : null
    case 'unlearn':
      // Ключ процесса — 32 hex-символа из workflowKey; ничего иного тут быть
      // не может, и проверка формы стоит дешевле доверия к callback-строке.
      return argument !== undefined && /^[0-9a-f]{32}$/.test(argument)
        ? { kind: 'revoke-learned', workflowKey: argument }
        : null
    case 'nightly':
      if (argument === 'run') return { kind: 'consolidate' }
      return argument === 'staged' ? { kind: 'open-staging' } : null
    case 'botadd':
      return argument === undefined ? { kind: 'add-bot' } : null
    case 'goalstop':
      return argument === undefined ? { kind: 'stop-goal' } : null
    case 'acc':
      return argument !== undefined &&
        (SERVER_ACCESS_OPERATIONS as readonly string[]).includes(argument)
        ? { kind: 'server-access', operation: argument as ServerAccessOperation }
        : null
    case 'custom':
      return argument === undefined ? { kind: 'custom-service' } : null
    case 'svc':
      return argument === undefined || argument.length === 0
        ? null
        : { kind: 'pick-service', serviceId: argument }
    case 'limit': {
      const dollars = Number(argument)
      return argument !== undefined && /^\d{1,4}$/.test(argument) && Number.isSafeInteger(dollars)
        ? { kind: 'set-limit', dollars }
        : null
    }
    case 'mode':
      return argument !== undefined && (MODES as readonly string[]).includes(argument)
        ? { kind: 'set-mode', mode: argument as AgentMode }
        : null
    case 'model':
      // Model ids carry `/` and `.`; they are re-encoded by index, not by name,
      // so anything arriving here is already a short catalogue token. The one
      // reserved token is `custom`: catalogues cannot list every model of every
      // OpenAI-compatible endpoint, so the operator may name one.
      if (argument === 'custom') return { kind: 'custom-model' }
      return argument === undefined || argument.length === 0
        ? null
        : { kind: 'set-model', model: argument }
    case 'untrig':
      return argument !== undefined && /^[A-Za-z0-9][A-Za-z0-9-]{0,47}$/.test(argument)
        ? { kind: 'cancel-trigger', triggerId: argument }
        : null
    case 'tz': {
      const index = Number(argument)
      return argument !== undefined && /^\d{1,2}$/.test(argument) &&
        index < TIMEZONE_PRESETS.length
        ? { kind: 'set-timezone', timeZone: TIMEZONE_PRESETS[index]! }
        : null
    }
    case 'voice':
      return argument === undefined || argument.length === 0
        ? null
        : { kind: 'set-voice', providerId: argument }
    case 'toggle':
      return argument !== undefined && (TOGGLES as readonly string[]).includes(argument)
        ? { kind: 'toggle', setting: argument as 'showCostPerTurn' | 'budgetEnabled' | 'debug' }
        : null
    default:
      return null
  }
}

export function renderSettingsRoot(): SettingsView {
  return {
    text: '⚙️ <b>Настройки</b>\n\nПульт управления: подключения, ключи, лимиты и состояние.',
    buttons: [
      [open('🔌 Подключения', 'connections'), open('🔑 Ключи сервисов', 'env')],
      // What runs without the operator sitting here, side by side.
      [open('⏳ Таймеры', 'timers'), open('🎯 Цели', 'goals')],
      [open('👾 Мои боты', 'bots'), open('💰 Лимит расходов', 'limit')],
      [open('🖥 Состояние сервера', 'server'), open('🗝 Разрешения', 'grants')],
      [open('🔧 Системные', 'system')],
    ],
  }
}

export function renderConnectionsScreen(input: {
  provider: string
  model: string
}): SettingsView {
  return {
    text:
      '🔌 <b>Подключения</b>\n\n' +
      `Сейчас мозг: <b>${input.provider}</b> · ${input.model}\n\n` +
      'Переподключение перезапустит Aisy в режиме настройки — там можно выбрать ' +
      'другую подписку или ключ. Память и проекты не трогаются.',
    buttons: [[button('🔄 Сменить мозг', 'reconnect')], backRow()],
  }
}

export function renderEnvScreen(input: {
  services: ReadonlyArray<{ id: string; label: string; purpose: string; connected: boolean }>
  /** Replaces the heading when the same list is offered during onboarding. */
  intro?: string
}): SettingsView {
  const rows: SettingsButton[][] = []
  for (let index = 0; index < input.services.length; index += 2) {
    rows.push(input.services.slice(index, index + 2).map((service) =>
      button(fitLabel(service.connected ? `${service.label} ✅` : service.label),
        `svc:${service.id}`)))
  }
  // Перечислять сервисы текстом и тут же клавиатурой — значит напечатать список
  // дважды. Галочка на кнопке говорит то же, что говорила галочка в строке.
  return {
    text:
      `${input.intro ?? '🔑 <b>Ключи сервисов</b>'}\n\n` +
      'Выбери сервис — я скажу, где взять ключ, и приму его сообщением. ' +
      'Галочка значит, что ключ уже на месте.',
    buttons: [...rows, [button('✍️ Свой ключ', 'custom')], backRow()],
  }
}

export function renderServicePrompt(input: {
  label: string
  purpose: string
  source: string
  envKey: string
}): SettingsView {
  return {
    text:
      `${input.label}\n\n${input.purpose}.\n\n` +
      `Где взять: ${input.source}\n` +
      `Ляжет в: <code>${input.envKey}</code>\n\n` +
      'Пришли ключ одним сообщением — я сохраню его и сразу удалю сообщение.',
    buttons: [backRow('env')],
  }
}

export function renderLimitScreen(input: { currentUsd: number; spentUsd: number }): SettingsView {
  const current = input.currentUsd <= 0 ? 'без лимита' : `$${input.currentUsd}`
  return {
    text:
      '💰 <b>Лимит расходов</b>\n\n' +
      `Сейчас: ${current}\nПотрачено сегодня: $${input.spentUsd.toFixed(2)}\n\n` +
      'На 80% предупрежу, на 100% остановлюсь до следующего дня. ' +
      'Считается только оплата по API — подписка сюда не входит.',
    buttons: [
      LIMIT_PRESETS.slice(0, 3).map((dollars) =>
        button(dollars === 0 ? 'Без лимита' : `$${dollars}`, `limit:${dollars}`)),
      LIMIT_PRESETS.slice(3).map((dollars) => button(`$${dollars}`, `limit:${dollars}`)),
      backRow(),
    ],
  }
}

/**
 * Служебное: голос, время, три переключателя, перезапуск.
 *
 * Режимы работы отсюда ушли на свой экран. Свобода агента — не системная
 * настройка вроде часового пояса, и оператор искал её не здесь.
 */
export function renderSystemScreen(input: {
  voice: ReadonlyArray<{ id: string; label: string; selected: boolean }>
  showCostPerTurn: boolean
  budgetEnabled: boolean
  debug: boolean
  /** Empty ⇒ the server's own zone, which is worth saying out loud. */
  timeZone: string
}): SettingsView {
  const mark = (value: boolean): string => (value ? '✅' : '❌')
  const voiceLine = input.voice.length === 0
    ? 'Расшифровка голоса: не подключена (нужен ключ Deepgram)'
    : `Расшифровка: ${input.voice.find((entry) => entry.selected)?.label ?? 'не выбрана'}`
  return {
    text: `🔧 <b>Системные</b>\n\n${voiceLine}\n` +
      `Часовой пояс: ${input.timeZone.length === 0
        ? 'как на сервере'
        : timeZoneLabel(input.timeZone)}`,
    buttons: [
      [open('🕐 Часовой пояс', 'timezone')],
      ...(input.voice.length === 0
        ? []
        : [input.voice.map((entry) =>
            button(`${entry.selected ? '▶ ' : ''}${entry.label}`, `voice:${entry.id}`))]),
      [button(`Стоимость за ход ${mark(input.showCostPerTurn)}`, 'toggle:showCostPerTurn')],
      [button(`Бюджет агентов ${mark(input.budgetEnabled)}`, 'toggle:budgetEnabled')],
      [button(`Отладка ${mark(input.debug)}`, 'toggle:debug')],
      [button('🔄 Перезапустить бота', 'restart')],
      backRow(),
    ],
  }
}

/**
 * Режимы работы: одна кнопка в ряд.
 *
 * Четыре в строку не помещались на телефоне — «✋ С подтверждением» обрезалось
 * до «✋ С подтв…», и выбор превращался в угадывание. Под кнопками сказано, что
 * каждый режим означает, потому что название режима — это ещё не объяснение.
 */
export function renderModeScreen(input: { mode: AgentMode }): SettingsView {
  return {
    text: [
      '🎛 <b>Режим работы</b>',
      '',
      `Сейчас: <b>${MODE_TEXT[input.mode].status}</b>`,
      '',
      ...MODES.map((mode) => `${MODE_TEXT[mode].button} — ${MODE_TEXT[mode].hint}`),
      '',
      'Режим — про работу с файлами и командами. Он запоминается и переключается на лету.',
    ].join('\n'),
    buttons: [
      ...MODES.map((mode) => [button(
        mode === input.mode ? `▶ ${MODE_TEXT[mode].button}` : MODE_TEXT[mode].button,
        `mode:${mode}`,
      )]),
      backRow('agent'),
    ],
  }
}

export function renderAgentScreen(input: {
  provider: string
  model: string
  mode: AgentMode
  models: readonly string[]
  /** Nightly memory work exists in this installation: offer it, else hide it. */
  memory?: boolean
  agentCards?: boolean
}): SettingsView {
  const rows: SettingsButton[][] = []
  for (let index = 0; index < input.models.length; index += 2) {
    rows.push(input.models.slice(index, index + 2).map((model, offset) =>
      // Encoded by catalogue index: a model id contains `/` and `.`, and the
      // callback payload is a fixed 64-byte budget with `:` as its separator.
      button(model === input.model ? `▶ ${fitLabel(model)}` : fitLabel(model),
        `model:${index + offset}`)))
  }
  return {
    text:
      `🧠 <b>Агент</b>\n\nМозг: <b>${input.provider}</b>\n` +
      // Модель видна маркером ▶ на кнопке — печатать её ещё и строкой значит
      // сказать одно и то же дважды. Когда списка нет, сказать больше негде.
      (input.models.length === 0
        ? `Модель: ${input.model}\nРежим: ${MODE_TEXT[input.mode].status}` +
          '\n\nГотового списка моделей для этого провайдера нет — впиши название сам.'
        : `Режим: ${MODE_TEXT[input.mode].status}` +
          '\n\nСмена модели перезапускает бота на несколько секунд. Диалог и память остаются.'),
    buttons: [
      ...rows,
      [button('✍️ Другая модель', 'model:custom')],
      [open('🎛 Режим работы', 'mode')],
      // Memory work was reachable only as /consolidate and /staging — two
      // commands nobody types on a phone, guarding the one thing the operator
      // must see before it lands: what the agent decided to remember.
      ...(input.memory === true
        ? [[button('📥 Правки памяти', 'nightly:staged'),
            button('🌙 Разобрать за ночь', 'nightly:run')]]
        : []),
      ...(input.agentCards === true ? [[open('🧬 Личности', 'agent-cards')]] : []),
      backRow(),
    ],
  }
}

/**
 * What the agent may do without asking again. The list itself is built by the
 * transport (only it holds the grant store); this adds the one action that
 * belongs on the screen — taking all of it back.
 */
/** Выученный грант в том виде, в каком его читает оператор (спека 24). */
export interface LearnedGrantView {
  workflowKey: string
  /** Рабочий процесс словами: «читать example.com». */
  title: string
  version: number
  /** Когда истечёт, как оператор прочитает дату. */
  expires: string
  /** Сколько демонстраций стоит за этим грантом. */
  demonstrations: number
}

/**
 * Один экран на оба вида разрешений. Ручное и выученное различаются тем, как
 * появились, а не тем, что разрешают, — поэтому оператор видит их рядом и
 * снимает одинаково. Выученное отзывается поштучно: сбросить всё, потеряв
 * доверие, набранное неделями демонстраций, — не то же самое, что снять одно.
 */
export function renderGrantsScreen(input: {
  body: string
  learned?: readonly LearnedGrantView[]
}): SettingsView {
  const learned = input.learned ?? []
  const text = learned.length === 0
    ? input.body
    : [
      input.body,
      '',
      '🎓 <b>Выученное</b>',
      ...learned.map((g) =>
        `• ${escapeHtml(g.title)} · до ${escapeHtml(g.expires)}` +
        ` · показал ${g.demonstrations} ${plural(g.demonstrations, 'раз', 'раза', 'раз')}`),
      '',
      'Это я делал под твоим подтверждением и перестал спрашивать. ' +
      'Любая твоя правка снимает автономию сама.',
    ].join('\n')
  return {
    text,
    buttons: [
      // Поштучный отзыв идёт первым: он адресный, а сброс — тупой инструмент.
      ...learned.map((g) => [button(fitLabel(`🎓✖ ${g.title}`), `unlearn:${g.workflowKey}`)]),
      [button('🗑 Снять все', 'ungrant')],
      backRow(),
    ],
  }
}

export function renderTimezoneScreen(input: {
  timeZone: string
  /** The same instant as the operator would read it, per preset. */
  sample: (timeZone: string) => string
}): SettingsView {
  const rows: SettingsButton[][] = []
  for (let index = 0; index < TIMEZONE_PRESETS.length; index += 2) {
    rows.push(TIMEZONE_PRESETS.slice(index, index + 2).map((zone, offset) =>
      button(`${zone === input.timeZone ? '▶ ' : ''}${timeZoneLabel(zone)} ${input.sample(zone)}`,
        `tz:${index + offset}`)))
  }
  // Выбранная зона отмечена маркером ▶ — строка «Сейчас: …» повторяла бы её.
  return {
    text:
      '🕐 <b>Часовой пояс</b>\n\n' +
      (input.timeZone.length === 0 ? 'Сейчас время берётся с сервера.\n\n' : '') +
      'От пояса зависят расписания: «каждое утро в 9» — это девять здесь. ' +
      'Записи в журнале и метки времени остаются в UTC.',
    buttons: [...rows, backRow('system')],
  }
}

export function renderTimersScreen(input: {
  timers: ReadonlyArray<{ id: string; kind: string; prompt: string }>
}): SettingsView {
  if (input.timers.length === 0) {
    return {
      text: '⏳ <b>Таймеры</b>\n\nТаймеров нет.\n\n' +
        'Новый — просто скажи словами: «каждое утро в 9 — сводка». ' +
        'Я покажу карточку, включится он с твоего подтверждения. ' +
        'Время считается по часовому поясу из 🔧 Системных.',
      buttons: [backRow()],
    }
  }
  // Вид таймера — это `remind` / `schedule` / `watch` в коде; оператору важно,
  // случится оно один раз, по расписанию или по событию.
  const kindWord: Readonly<Record<string, string>> = {
    remind: 'один раз', schedule: 'по расписанию', watch: 'по событию',
  }
  const lines = input.timers.map((timer, index) =>
    `${index + 1}. ${kindWord[timer.kind] ?? timer.kind} · ${timer.prompt}`)
  return {
    text: `⏳ <b>Таймеры</b>\n\n${lines.join('\n')}\n\n` +
      'Время считается по часовому поясу из 🔧 Системных.',
    buttons: [
      // One button per timer: a list whose items cannot be removed from the
      // phone is why /untrigger existed and nobody used it.
      ...input.timers.map((timer, index) =>
        [button(`🗑 ${index + 1}`, `untrig:${timer.id}`)]),
      backRow(),
    ],
  }
}

/** What the operator sees about the one goal that can be running. */
export interface GoalScreenView {
  objective: string
  /** Как цель заканчивается: результатом, расписанием или деньгами. */
  mode: 'until' | 'every' | 'budget'
  status: 'active' | 'completed' | 'halted' | 'stopped'
  iterationsSpent: number
  maxIterations: number
  dollarsSpent: number
  dollarCeiling: number
  /** Последняя проверка результата — единственное, что видно снаружи цикла. */
  lastFeedback?: string
  haltReason?: string
}

const GOAL_MODE: Readonly<Record<GoalScreenView['mode'], string>> = {
  until: 'до результата',
  every: 'по расписанию',
  budget: 'пока хватает бюджета',
}
const GOAL_STATUS: Readonly<Record<GoalScreenView['status'], string>> = {
  active: '⚙️ работаю',
  completed: '✅ достигнута',
  halted: '⚠️ остановился сам',
  stopped: '⏹ остановлена',
}

/**
 * A goal is the one thing here that keeps working while nobody is watching, so
 * the screen answers the two questions that come with that: how far it has got,
 * and how to stop it. Setting one stays a conversation — the objective is a
 * sentence, not a button.
 */
export function renderGoalsScreen(input: { goal?: GoalScreenView }): SettingsView {
  const goal = input.goal
  if (goal === undefined) {
    return {
      text: '🎯 <b>Цели</b>\n\nАктивной цели нет.\n\n' +
        'Цель — это работа до результата: я повторяю попытки и сам проверяю, ' +
        'получилось ли, пока не выйдет или пока не упрусь в потолок — итерации, ' +
        'токены, деньги. Задача — просто напоминание сделать; таймер — расписание.\n\n' +
        'Скажи словами: «добейся, чтобы …». Покажу карточку — запущу с подтверждения.',
      buttons: [backRow()],
    }
  }
  const lines = [
    '🎯 <b>Цели</b>',
    '',
    escapeHtml(goal.objective),
    '',
    `${GOAL_STATUS[goal.status]} · ${GOAL_MODE[goal.mode]}`,
    `Итераций: ${goal.iterationsSpent} из ${goal.maxIterations}`,
    `Потрачено: $${goal.dollarsSpent.toFixed(2)} из $${goal.dollarCeiling.toFixed(2)}`,
  ]
  if (goal.haltReason !== undefined) lines.push(`Почему встал: ${escapeHtml(goal.haltReason)}`)
  if (goal.lastFeedback !== undefined) {
    lines.push('', `Последняя проверка: ${escapeHtml(goal.lastFeedback)}`)
  }
  return {
    text: lines.join('\n'),
    buttons: [
      // Only a goal that is still running can be stopped; a finished one is a
      // report, and a button that does nothing is worse than no button.
      ...(goal.status === 'active' ? [[button('⏹ Остановить цель', 'goalstop')]] : []),
      backRow(),
    ],
  }
}

/** What the operator sees while a deep research runs — and when it ends. */
export interface ResearchCardView {
  question: string
  /** Страниц прочитано; растёт по ходу, оператор видит движение. */
  pages: number
  maxPages: number
  status: 'active' | 'done'
  /** Почему чтение закончилось раньше полного лимита, если закончилось. */
  note?: string
}

/**
 * A research runs for minutes with nothing arriving in the chat, and silence
 * reads as a hung agent. One post, edited in place: the question, the page
 * counter moving, and the final line when it is over. The report itself comes
 * as an ordinary message — this card is the heartbeat, not the result.
 */
export function renderResearchCard(view: ResearchCardView): SettingsView {
  const lines = [
    '🔬 <b>Глубокий поиск</b>',
    '',
    escapeHtml(view.question),
    '',
    view.status === 'active'
      ? `⚙️ читаю · страниц: ${view.pages} из ${view.maxPages}`
      : `✅ закончил · страниц: ${view.pages}`,
  ]
  if (view.note !== undefined) lines.push(escapeHtml(view.note))
  // No buttons: the turn's own ⏹ stop card already covers interruption, and a
  // second stop that raced it would be two answers to one question.
  return { text: lines.join('\n'), buttons: [] }
}

/** Plain-list screens: timers, anything with nothing to act on. */
export function renderListScreen(input: {
  title: string
  body: string
  hint?: string
}): SettingsView {
  return {
    text: `${input.title}\n\n${input.body}` + (input.hint === undefined ? '' : `\n\n${input.hint}`),
    buttons: [backRow()],
  }
}

/**
 * Server status, plus the doors this installation knows how to open. Which
 * operations exist is decided by the runtime config, so an installation with no
 * access section renders exactly as before: status and a back button.
 */
export function renderServerScreen(input: {
  body: string
  access?: readonly ServerAccessOperation[]
}): SettingsView {
  const access = input.access ?? []
  const rows: SettingsButton[][] = []
  for (let index = 0; index < access.length; index += 2) {
    rows.push(access.slice(index, index + 2)
      .map((operation) => button(ACCESS_LABEL[operation], `acc:${operation}`)))
  }
  return {
    text: `🖥 <b>Состояние сервера</b>\n\n${input.body}` +
      (access.length === 0
        ? ''
        : '\n\nДоступ открывается на срок и закрывается сам. Каждое действие — ' +
          'отдельный тап, журнал пишется всегда.'),
    buttons: [...rows, backRow()],
  }
}

/** The registry of bots this installation knows, and the way to add one. */
export function renderBotsScreen(input: { body: string }): SettingsView {
  return {
    text: `👾 <b>Мои боты</b>\n\n${input.body}\n\n` +
      'Какой бот отвечает — решает запуск: токен берётся из переменной окружения, ' +
      'сам токен реестр не хранит.',
    buttons: [[button('➕ Добавить бота', 'botadd')], backRow()],
  }
}
