// Execution stream (plan §4). Renders the single "live" post that is edited in
// place as a turn progresses. The grammY editMessageText call lives in bot.ts;
// here we build the HTML body from accumulated run state.

import { escapeHtml } from './render.js'
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
  arg?: string
  elapsedMs?: number
}

export interface ExecutionState {
  sessionId: string
  steps: StepView[]
  tool?: ToolView
  /** Transient note, e.g. the steer acknowledgement line. */
  note?: string
  /** When true, render the "agent is working" footer. */
  thinking?: boolean
}

const ICON: Record<StepStatus, string> = { done: '✅', active: '⏳', pending: '⬜' }

/** Build the live execution post. `debugTail` (if given) is appended verbatim. */
export function renderExecution(
  state: ExecutionState,
  opts?: { debug?: boolean; debugTail?: string },
): BotMessage {
  const debug = opts?.debug === true
  const lines: string[] = []

  lines.push(`⚙️ Выполнение...  [сессия ${escapeHtml(state.sessionId)}]${debug ? '  [DEBUG]' : ''}`)
  lines.push('')

  if (state.steps.length > 0) {
    lines.push(`📋 План: ${state.steps.length} шага`)
    for (const s of state.steps) {
      const marker = s.status === 'active' ? '  ← текущий' : ''
      const tail = debug && s.detail ? `  [${escapeHtml(s.detail)}]` : ''
      lines.push(`  ${ICON[s.status]} ${s.index}. ${escapeHtml(s.title)}${marker}${tail}`)
    }
    lines.push('')
  }

  if (state.tool) {
    lines.push(`🔧 Инструмент: ${escapeHtml(state.tool.name)}`)
    if (state.tool.arg) lines.push(`   → ${escapeHtml(state.tool.arg)}`)
    if (typeof state.tool.elapsedMs === 'number') {
      lines.push(`   ⏱ ${(state.tool.elapsedMs / 1000).toFixed(1)}s`)
    }
    lines.push('')
  }

  if (state.note) lines.push(escapeHtml(state.note), '')
  if (state.thinking) lines.push('💬 Агент работает…')

  if (opts?.debugTail) {
    lines.push('', opts.debugTail)
  }

  return { html: lines.join('\n').replace(/\n+$/, '') }
}

/** The acknowledgement line shown in the live post when steer input arrives mid-turn. */
export const STEER_ACK = '↪️ Принял новое сообщение, учту на следующем шаге.'
