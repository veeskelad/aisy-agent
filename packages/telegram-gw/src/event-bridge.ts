// Event bridge (plan §7, §9, §11, §13).
//
// telegram-gw renders presentation-level UI events, decoupled from core's
// internal event unions. The wiring layer (bot assembler) adapts core's
// injected event sinks into these UiEvents; this module turns a UiEvent into a
// BotMessage (or null when an event produces no user-facing alert).

import { escapeHtml, bar } from './render.js'
import type { BotMessage, InlineButton } from './types.js'

export type UiEvent =
  | {
      kind: 'budget.capped'
      limitUsd: number
      spentUsd: number
      stepsDone: number
      stepsTotal: number
    }
  | {
      kind: 'cost.summary'
      sessionId: string
      tokensIn: number
      tokensOut: number
      dollars: number
      limitUsd: number
      model: string
    }
  | { kind: 'outbound.locked'; sources: string[]; preview?: string }
  | { kind: 'narrowed'; restrictions: string[]; reason: string }
  | { kind: 'error'; what: string; detail: string }
  | {
      kind: 'spend.report'
      rows: { model: string; tokensIn: number; tokensOut: number; dollars: number }[]
      totalUsd: number
      perAgent?: { agentId: string; dollars: number }[]
    }
  | { kind: 'settings.panel'; showCostPerTurn: boolean; budgetEnabled: boolean; debug: boolean }

function btn(text: string, data: string): InlineButton {
  return { text, data }
}

export function renderEvent(ev: UiEvent): BotMessage | null {
  switch (ev.kind) {
    case 'budget.capped': {
      const lines = [
        '⛔ <b>Бюджет исчерпан</b>',
        '',
        `Агент остановлен — достигнут лимит $${ev.limitUsd.toFixed(2)} (потрачено $${ev.spentUsd.toFixed(2)}).`,
      ]
      // The steps line only applies to a mid-turn halt; a pre-turn refusal
      // (stepsTotal 0) omits it.
      if (ev.stepsTotal > 0) lines.push(`Выполнено: ${ev.stepsDone} из ${ev.stepsTotal} шагов.`)
      return {
        html: lines.join('\n'),
        buttons: [[btn('📊 Детали', 'budget:details'), btn('▶️ Продолжить', 'budget:resume')]],
      }
    }

    case 'cost.summary': {
      const frac = ev.limitUsd > 0 ? ev.dollars / ev.limitUsd : 0
      const isTiered = ev.model === 'mixed (per-tier)'
      const modelLine = isTiered
        ? `   Токены: ${ev.tokensIn} in / ${ev.tokensOut} out · $${ev.dollars.toFixed(3)} (тарифицировано по тирам — разбивка по моделям в 📡 Монитор)`
        : `   Токены: ${ev.tokensIn} in / ${ev.tokensOut} out · ${escapeHtml(ev.model)}`
      return {
        html: [
          `💰 <b>Сессия ${escapeHtml(ev.sessionId)}</b>`,
          modelLine,
          `   Стоимость: $${ev.dollars.toFixed(3)} / $${ev.limitUsd.toFixed(2)} (${(frac * 100).toFixed(1)}%)`,
          `   ${bar(frac)}`,
        ].join('\n'),
      }
    }

    case 'outbound.locked': {
      const lines = ['🔒 <b>Исходящее заблокировано</b>', '', 'Untrusted источник в контексте:']
      for (const s of ev.sources) lines.push(`• ${escapeHtml(s)}`)
      if (ev.preview) {
        lines.push('', '📤 Агент хочет отправить:', `   ${escapeHtml(ev.preview)}`)
      }
      return {
        html: lines.join('\n'),
        buttons: [
          [btn('✅ Разрешить вывод', 'outbound:allow'), btn('❌ Заблокировать', 'outbound:block')],
        ],
      }
    }

    case 'narrowed': {
      const lines = ['⚠️ <b>Агент в ограниченном режиме</b>', '']
      for (const r of ev.restrictions) lines.push(`• ${escapeHtml(r)}`)
      lines.push('', `Причина: ${escapeHtml(ev.reason)}`)
      return {
        html: lines.join('\n'),
        buttons: [[btn('ℹ️ Подробнее', 'narrowed:info'), btn('🔄 Очистить контекст', 'narrowed:clear')]],
      }
    }

    case 'error':
      return {
        html: `❌ ${escapeHtml(ev.what)} · ${escapeHtml(ev.detail)}`,
        buttons: [[btn('🔄 Повторить', 'error:retry')]],
      }

    case 'spend.report': {
      const lines = ['📡 <b>Расход по моделям</b>', '']
      if (ev.rows.length === 0) {
        lines.push('Пока ничего не потрачено.')
      } else {
        for (const r of ev.rows) {
          lines.push(`• <b>${escapeHtml(r.model)}</b> — $${r.dollars.toFixed(3)} (${r.tokensIn} in / ${r.tokensOut} out)`)
        }
        lines.push('', `Итого: $${ev.totalUsd.toFixed(3)}`)
      }
      if (ev.perAgent && ev.perAgent.length > 0) {
        lines.push('', '<b>По агентам</b>')
        for (const a of ev.perAgent) lines.push(`• ${escapeHtml(a.agentId)} — $${a.dollars.toFixed(3)}`)
      }
      return { html: lines.join('\n'), buttons: [[btn('🔄 Обновить', 'spend:refresh')]] }
    }

    case 'settings.panel': {
      const onOff = (v: boolean): string => (v ? '✅ вкл' : '❌ выкл')
      return {
        html: [
          '⚙️ <b>Настройки</b>',
          '',
          `Стоимость за ход: ${onOff(ev.showCostPerTurn)}`,
          `Бюджет агентов: ${onOff(ev.budgetEnabled)}`,
          `🔧 Отладка: ${onOff(ev.debug)}`,
        ].join('\n'),
        buttons: [
          [btn(`Стоимость за ход: ${ev.showCostPerTurn ? '✅' : '❌'}`, 'set:showCostPerTurn')],
          [btn(`Бюджет агентов: ${ev.budgetEnabled ? '✅' : '❌'}`, 'set:budgetEnabled')],
          [btn(`🔧 Отладка: ${ev.debug ? '✅' : '❌'}`, 'set:debug')],
        ],
      }
    }
  }
}
