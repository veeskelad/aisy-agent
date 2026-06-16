import { describe, it, expect } from 'vitest'
import { renderEvent, type UiEvent } from './event-bridge.js'

describe('renderEvent', () => {
  it('budget.capped is an alert with details + resume buttons', () => {
    const msg = renderEvent({
      kind: 'budget.capped',
      limitUsd: 1,
      spentUsd: 1,
      stepsDone: 2,
      stepsTotal: 3,
    })!
    expect(msg.html).toContain('⛔ <b>Бюджет исчерпан</b>')
    expect(msg.html).toContain('$1.00')
    expect(msg.html).toContain('2 из 3')
    expect(msg.buttons?.[0]?.map((b) => b.data)).toEqual(['budget:details', 'budget:resume'])
  })

  it('budget.capped omits the steps line for a pre-turn refusal (stepsTotal 0)', () => {
    const msg = renderEvent({ kind: 'budget.capped', limitUsd: 2, spentUsd: 2.5, stepsDone: 0, stepsTotal: 0 })!
    expect(msg.html).toContain('потрачено $2.50')
    expect(msg.html).not.toContain('шагов')
  })

  it('cost.summary renders a progress bar and percentage', () => {
    const msg = renderEvent({
      kind: 'cost.summary',
      sessionId: 'abc123',
      tokensIn: 14200,
      tokensOut: 3800,
      dollars: 0.043,
      limitUsd: 1,
      model: 'anthropic/claude-sonnet-4-6',
    })!
    expect(msg.html).toContain('💰 <b>Сессия abc123</b>')
    expect(msg.html).toContain('$0.043 / $1.00 (4.3%)')
    expect(msg.html).toMatch(/[█░]{20}/)
  })

  it('outbound.locked lists sources, preview, and allow/block buttons', () => {
    const msg = renderEvent({
      kind: 'outbound.locked',
      sources: ['Пересланное сообщение от @someone'],
      preview: 'secret text',
    })!
    expect(msg.html).toContain('🔒 <b>Исходящее заблокировано</b>')
    expect(msg.html).toContain('• Пересланное сообщение от @someone')
    expect(msg.html).toContain('📤 Агент хочет отправить:')
    expect(msg.buttons?.[0]?.map((b) => b.data)).toEqual(['outbound:allow', 'outbound:block'])
  })

  it('outbound.locked omits the preview block when absent', () => {
    const msg = renderEvent({ kind: 'outbound.locked', sources: ['x'] })!
    expect(msg.html).not.toContain('📤')
  })

  it('narrowed lists restrictions and reason', () => {
    const msg = renderEvent({
      kind: 'narrowed',
      restrictions: ['Заблокированы сетевые вызовы'],
      reason: 'untrusted-контент',
    })!
    expect(msg.html).toContain('⚠️ <b>Агент в ограниченном режиме</b>')
    expect(msg.html).toContain('• Заблокированы сетевые вызовы')
    expect(msg.html).toContain('Причина: untrusted-контент')
  })

  it('error renders a retry button', () => {
    const msg = renderEvent({ kind: 'error', what: 'Провайдер недоступен', detail: 'timeout' })!
    expect(msg.html).toContain('❌ Провайдер недоступен · timeout')
    expect(msg.buttons?.[0]?.[0]?.data).toBe('error:retry')
  })

  it('escapes dynamic content (no HTML injection)', () => {
    const ev: UiEvent = { kind: 'error', what: '<img src=x>', detail: '&lt;' }
    const msg = renderEvent(ev)!
    expect(msg.html).toContain('&lt;img src=x&gt;')
    expect(msg.html).not.toContain('<img')
  })

  it('spend.report lists per-model rows + total, with a refresh button', () => {
    const msg = renderEvent({
      kind: 'spend.report',
      rows: [
        { model: 'opus', tokensIn: 100, tokensOut: 40, dollars: 0.5 },
        { model: 'haiku', tokensIn: 20, tokensOut: 8, dollars: 0.02 },
      ],
      totalUsd: 0.52,
    })!
    expect(msg.html).toContain('📡 <b>Расход по моделям</b>')
    expect(msg.html).toContain('<b>opus</b> — $0.500')
    expect(msg.html).toContain('Итого: $0.520')
    expect(msg.buttons?.[0]?.[0]?.data).toBe('spend:refresh')
  })

  it('spend.report handles the empty state', () => {
    const msg = renderEvent({ kind: 'spend.report', rows: [], totalUsd: 0 })!
    expect(msg.html).toContain('Пока ничего не потрачено.')
  })

  it('settings.panel shows toggles with set: callbacks', () => {
    const msg = renderEvent({ kind: 'settings.panel', showCostPerTurn: true, budgetEnabled: false })!
    expect(msg.html).toContain('⚙️ <b>Настройки</b>')
    expect(msg.html).toContain('Стоимость за ход: ✅ вкл')
    expect(msg.html).toContain('Бюджет агентов: ❌ выкл')
    const datas = msg.buttons?.flat().map((b) => b.data)
    expect(datas).toEqual(['set:showCostPerTurn', 'set:budgetEnabled'])
  })
})
