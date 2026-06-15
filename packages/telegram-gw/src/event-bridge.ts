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

function btn(text: string, data: string): InlineButton {
  return { text, data }
}

export function renderEvent(ev: UiEvent): BotMessage | null {
  switch (ev.kind) {
    case 'budget.capped':
      return {
        html: [
          '⛔ <b>Бюджет исчерпан</b>',
          '',
          `Агент остановлен — достигнут лимит $${ev.limitUsd.toFixed(2)}.`,
          `Выполнено: ${ev.stepsDone} из ${ev.stepsTotal} шагов.`,
        ].join('\n'),
        buttons: [[btn('📊 Детали', 'budget:details'), btn('▶️ Продолжить', 'budget:resume')]],
      }

    case 'cost.summary': {
      const frac = ev.limitUsd > 0 ? ev.dollars / ev.limitUsd : 0
      return {
        html: [
          `💰 <b>Сессия ${escapeHtml(ev.sessionId)}</b>`,
          `   Токены: ${ev.tokensIn} in / ${ev.tokensOut} out · ${escapeHtml(ev.model)}`,
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
  }
}
