// Execution stream (plan §4). Renders the single "live" post that is edited in
// place as a turn progresses. The grammY editMessageText call lives in bot.ts;
// here we build the HTML body from accumulated run state.

import { escapeHtml, plural } from './render.js'
import type { BotMessage } from './types.js'

export type StepStatus = 'done' | 'active' | 'pending'

export interface StepView {
  index: number
  title: string
  status: StepStatus
  /** Debug-only technical tail, e.g. "tool.result · 120ms". */
  detail?: string
}

export interface ToolView {
  name: string
  kind?: 'tool' | 'subagent'
  status?: 'pending' | 'running' | 'completed' | 'denied' | 'failed'
  arg?: string
  elapsedMs?: number
}

export interface ActionView {
  kind: 'inspect-required' | 'mutate-required' | 'delegate-required'
  status: 'required' | 'recovering' | 'verified' | 'unverified'
  missing?: 'observation' | 'mutation' | 'postcondition' | 'delegation'
}

export type ExecutionStatus =
  | 'running'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'awaiting'
  | 'interrupted'

export interface ExecutionState {
  /** Where the work happens: a project name, or the shared workspace. */
  scope?: string
  steps: StepView[]
  tool?: ToolView
  /** What already ran this turn, oldest first. The operator watches this. */
  history?: ToolView[]
  action?: ActionView
  usage?: { inputTokens: number; outputTokens: number; dollars: number }
  /** Whole-turn stopwatch, milliseconds since the operator's message. */
  elapsedMs?: number
  /** How long the current phase has been going: thinking, or one tool. */
  phaseMs?: number
  /** Transient note, e.g. the steer acknowledgement line. */
  note?: string
  /** True while the model is composing rather than running a tool. */
  thinking?: boolean
  status?: ExecutionStatus
}

const ICON: Record<StepStatus, string> = { done: '✅', active: '⏳', pending: '⬜' }
const TITLE: Record<ExecutionStatus, string> = {
  running: '⚙️ Работаю',
  completed: '✅ Готово',
  stopped: '⏹ Остановлено',
  failed: '❌ Прервано ошибкой',
  awaiting: '⏸ Жду решения',
  interrupted: '⚠️ Прервано перезапуском',
}
const ACTION_KIND: Record<ActionView['kind'], string> = {
  'inspect-required': 'Проверка',
  'mutate-required': 'Изменение',
  'delegate-required': 'Передача помощнику',
}
const ACTION_STATUS: Record<ActionView['status'], string> = {
  required: '⏳ Довожу до проверяемого результата',
  recovering: '🔄 Не хватило доказательства — переспрашиваю',
  verified: '✅ Результат подтверждён',
  unverified: '⚠️ Результат не подтверждён',
}
const MISSING_EVIDENCE: Record<NonNullable<ActionView['missing']>, string> = {
  observation: 'увидеть результат',
  mutation: 'подтвердить, что изменение произошло',
  postcondition: 'проверить состояние после изменения',
  delegation: 'дождаться помощника',
}

function seconds(ms: number): string {
  // Русская «с», а не латинская «s»: секунды здесь читает человек, а не консоль.
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} с`
  return `${Math.floor(ms / 60_000)} мин ${Math.round((ms % 60_000) / 1000)} с`
}

const ACTIVITY_ICON: Record<NonNullable<ToolView['status']>, string> = {
  pending: '⏳', running: '▶️', completed: '✅', denied: '⛔', failed: '❌',
}

/**
 * Что оператор читает вместо имени инструмента. `read_file` — это имя функции,
 * а человек, смотрящий в телефон, хочет знать, что происходит с его задачей.
 *
 * Две формы, потому что инструмент называют в двух местах и в разное время:
 * на живой карточке он уже выполняется («читаю файл»), а в карточке
 * подтверждения ещё только собирается («прочитаю файл»).
 *
 * Неизвестное имя печатается как есть: новый инструмент должен быть видимым и
 * безымянным, а не невидимым.
 */
export const TOOL_LABEL: Readonly<Record<string, { now: string; will: string }>> = Object.freeze({
  read_file: { now: 'читаю файл', will: 'Прочитаю файл' },
  write_file: { now: 'пишу файл', will: 'Запишу файл' },
  edit_file: { now: 'правлю файл', will: 'Изменю файл' },
  list_dir: { now: 'смотрю папку', will: 'Посмотрю папку' },
  search_memory: { now: 'ищу в памяти', will: 'Поищу в памяти' },
  remember: { now: 'запоминаю', will: 'Запомню' },
  read_journal: { now: 'смотрю журнал', will: 'Посмотрю журнал' },
  track_task: { now: 'веду задачи', will: 'Отмечу в задачах' },
  bash: { now: 'выполняю команду', will: 'Выполню команду' },
  web_search: { now: 'ищу в интернете', will: 'Поищу в интернете' },
  fetch_url: { now: 'читаю страницу', will: 'Прочитаю страницу' },
  deep_research: { now: 'исследую', will: 'Исследую тему' },
  spawn_subagent: { now: 'делегирую', will: 'Передам работу помощнику' },
  set_trigger: { now: 'ставлю таймер', will: 'Поставлю таймер' },
  set_goal: { now: 'ставлю цель', will: 'Поставлю цель' },
  goal_done: { now: 'проверяю цель', will: 'Проверю цель' },
  call_mcp: { now: 'внешний инструмент', will: 'Обращусь к внешнему инструменту' },
})

/**
 * One line of "what the agent is doing".
 *
 * Without a stopwatch of its own: the turn clock lives in the header, and the
 * same seconds printed twice — once for the turn, once for the step that resets
 * after every tool — read as a number that jumps around for no reason.
 */
function activityLine(tool: ToolView): string {
  const icon = ACTIVITY_ICON[tool.status ?? 'running']
  const label = TOOL_LABEL[tool.name]?.now ?? tool.name
  const name = tool.kind === 'subagent' ? `делегирую: ${tool.name}` : label
  const arg = tool.arg === undefined ? '' : `: <code>${escapeHtml(tool.arg)}</code>`
  return `${icon} ${escapeHtml(name)}${arg}`
}

/** Build the live execution post. `debugTail` (if given) is appended verbatim. */
export function renderExecution(
  state: ExecutionState,
  opts?: { debug?: boolean; debugTail?: string },
): BotMessage {
  const debug = opts?.debug === true
  const lines: string[] = []

  // A session uuid told the operator nothing. Where the work happens does.
  const scope = state.scope === undefined || state.scope.length === 0
    ? 'общая папка'
    : state.scope
  const clock = typeof state.elapsedMs === 'number' ? ` · ${seconds(state.elapsedMs)}` : ''
  lines.push(`${TITLE[state.status ?? 'running']}${clock} · ${escapeHtml(scope)}` +
    (debug ? '  [отладка]' : ''))
  lines.push('')

  if (state.steps.length > 0) {
    const word = plural(state.steps.length, 'шаг', 'шага', 'шагов')
    lines.push(`📋 План: ${state.steps.length} ${word}`)
    for (const s of state.steps) {
      const marker = s.status === 'active' ? '  ← текущий' : ''
      const tail = debug && s.detail ? `  [${escapeHtml(s.detail)}]` : ''
      lines.push(`  ${ICON[s.status]} ${s.index}. ${escapeHtml(s.title)}${marker}${tail}`)
    }
    lines.push('')
  }

  // Everything that already ran, then what is running now. This is the part an
  // operator actually watches: which command, against what, for how long.
  for (const done of state.history ?? []) lines.push(activityLine(done))
  if (state.tool) lines.push(activityLine(state.tool))
  else if (state.thinking && (state.status ?? 'running') === 'running') {
    lines.push('🧠 Думаю')
  }
  if ((state.history?.length ?? 0) > 0 || state.tool || state.thinking) lines.push('')

  if (state.action) {
    lines.push(`🎯 Действие: ${ACTION_KIND[state.action.kind]}`)
    lines.push(`   ${ACTION_STATUS[state.action.status]}`)
    if (state.action.missing) {
      lines.push(`   Осталось: ${MISSING_EVIDENCE[state.action.missing]}`)
    }
    lines.push('')
  }

  // Token counts are an engineer's number, not an operator's: they belong in
  // debug, where someone is looking for them, rather than under every answer.
  if (state.usage && debug) {
    lines.push(`📊 Токены: ${state.usage.inputTokens} вход · ${state.usage.outputTokens} выход`)
    lines.push(`   💵 $${state.usage.dollars.toFixed(4)}`)
    lines.push('')
  }

  if (state.note) lines.push(escapeHtml(state.note), '')

  if (opts?.debugTail) {
    lines.push('', opts.debugTail)
  }

  return { html: lines.join('\n').replace(/\n+$/, '') }
}

/** The acknowledgement line shown in the live post when steer input arrives mid-turn. */
export const STEER_ACK = '↪️ Принял новое сообщение, учту на следующем шаге.'
