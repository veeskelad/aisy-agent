import { describe, it, expect } from 'vitest'
import { renderExecution, STEER_ACK, type ExecutionState } from './execution-view.js'

function state(overrides?: Partial<ExecutionState>): ExecutionState {
  return {
    sessionId: 'abc123',
    steps: [
      { index: 1, title: 'Прочитать конфиг', status: 'done' },
      { index: 2, title: 'Запустить линтер', status: 'active' },
      { index: 3, title: 'Записать результат', status: 'pending' },
    ],
    ...overrides,
  }
}

describe('renderExecution', () => {
  it('renders step icons and marks the active step', () => {
    const { html } = renderExecution(state())
    expect(html).toContain('✅ 1. Прочитать конфиг')
    expect(html).toContain('⏳ 2. Запустить линтер  ← текущий')
    expect(html).toContain('⬜ 3. Записать результат')
  })

  it('includes the session id', () => {
    expect(renderExecution(state()).html).toContain('сессия abc123')
  })

  it('renders the current tool with elapsed time', () => {
    const { html } = renderExecution(state({ tool: { name: 'bash_exec', arg: 'lint x', elapsedMs: 4200 } }))
    expect(html).toContain('🔧 Инструмент: bash_exec')
    expect(html).toContain('→ lint x')
    expect(html).toContain('⏱ 4.2s')
  })

  it('renders the steer acknowledgement note', () => {
    expect(renderExecution(state({ note: STEER_ACK })).html).toContain(STEER_ACK)
  })

  it('shows the thinking footer when working', () => {
    expect(renderExecution(state({ thinking: true })).html).toContain('💬 Агент работает…')
  })

  it('escapes dynamic content', () => {
    const { html } = renderExecution(state({ steps: [{ index: 1, title: '<b>x</b>', status: 'done' }] }))
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  it('shows the DEBUG marker and step details only in debug mode', () => {
    const s = state({ steps: [{ index: 1, title: 't', status: 'active', detail: 'tool.call · seq:5' }] })
    expect(renderExecution(s, { debug: false }).html).not.toContain('[DEBUG]')
    expect(renderExecution(s, { debug: false }).html).not.toContain('seq:5')
    const dbg = renderExecution(s, { debug: true, debugTail: '💾 Журнал: 8 событий' }).html
    expect(dbg).toContain('[DEBUG]')
    expect(dbg).toContain('[tool.call · seq:5]')
    expect(dbg).toContain('💾 Журнал: 8 событий')
  })
})
