import { describe, it, expect } from 'vitest'
import { renderExecution, STEER_ACK, type ExecutionState } from './execution-view.js'

function state(overrides?: Partial<ExecutionState>): ExecutionState {
  return {
    scope: 'проект «Aisy»',
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

  it('names where the work happens, not the session uuid', () => {
    expect(renderExecution(state()).html).toContain('проект «Aisy»')
    const { scope: _named, ...global } = state()
    expect(renderExecution(global).html).toContain('общая папка')
  })

  it('runs one stopwatch for the whole turn, and none per step', () => {
    // Двое часов на экране — это одно и то же время, показанное дважды, причём
    // фазовые обнуляются после каждого инструмента и выглядят как сбой.
    const { html } = renderExecution(state({ elapsedMs: 12_400, thinking: true, phaseMs: 3_100 }))
    // Секунды по-русски: «с», а не «s» — это читает человек, а не консоль.
    expect(html).toContain('12,4 с')
    expect(html).toContain('🧠 Думаю')
    expect(html).not.toContain('3,1 с')
  })

  it('keeps what already ran on screen, in order', () => {
    const { html } = renderExecution(state({
      history: [
        { name: 'read_file', status: 'completed', arg: 'src/app.ts', elapsedMs: 400 },
        { name: 'bash', status: 'failed', arg: 'pytest -q', elapsedMs: 2_000 },
      ],
      tool: { name: 'bash', status: 'running', arg: 'python build.py' },
      phaseMs: 1_500,
    }))
    // Инструменты названы по-человечески, время — только в заголовке.
    expect(html).toContain('✅ читаю файл: <code>src/app.ts</code>')
    expect(html).toContain('❌ выполняю команду: <code>pytest -q</code>')
    expect(html).toContain('▶️ выполняю команду: <code>python build.py</code>')
    expect(html).not.toContain('0.4s')
    expect(html.indexOf('src/app.ts')).toBeLessThan(html.indexOf('python build.py'))
  })

  it('shows the command being run, not just the tool name', () => {
    // Незнакомый инструмент печатается своим именем: новый инструмент должен
    // быть видимым, а не безымянным.
    const { html } = renderExecution(state({ tool: {
      name: 'bash_exec', status: 'running', arg: 'lint x', elapsedMs: 4200,
    } }))
    expect(html).toContain('▶️ bash_exec: <code>lint x</code>')
  })

  it('renders a subagent lifecycle', () => {
    const { html } = renderExecution(state({
      tool: { name: 'spawn_subagent', kind: 'subagent', status: 'completed' },
    }))
    expect(html).toContain('✅ делегирую: spawn_subagent')
  })

  it('keeps token counts out of the operator’s way, and in debug', () => {
    const usage = state({ usage: { inputTokens: 120, outputTokens: 30, dollars: 0.125 } })
    expect(renderExecution(usage).html).not.toContain('Токены')
    expect(renderExecution(usage, { debug: true }).html).toContain('📊 Токены: 120 вход · 30 выход')
  })

  it('renders action recovery and authoritative verification status', () => {
    const recovering = renderExecution(state({
      action: {
        kind: 'mutate-required',
        status: 'recovering',
        missing: 'postcondition',
      },
    })).html
    expect(recovering).toContain('🎯 Действие: Изменение')
    expect(recovering).toContain('🔄 Не хватило доказательства — переспрашиваю')
    expect(recovering).toContain('Осталось: проверить состояние после изменения')

    const verified = renderExecution(state({
      action: { kind: 'delegate-required', status: 'verified' },
    })).html
    expect(verified).toContain('🎯 Действие: Передача помощнику')
    expect(verified).toContain('✅ Результат подтверждён')
  })

  it.each([
    ['completed', '✅ Готово'],
    ['stopped', '⏹ Остановлено'],
    ['failed', '❌ Прервано ошибкой'],
    ['awaiting', '⏸ Жду решения'],
    ['interrupted', '⚠️ Прервано перезапуском'],
  ] as const)('renders terminal status %s', (status, expected) => {
    expect(renderExecution(state({ status, thinking: true })).html).toContain(expected)
    expect(renderExecution(state({ status, thinking: true })).html).not.toContain('Агент работает')
  })

  it('renders the steer acknowledgement note', () => {
    expect(renderExecution(state({ note: STEER_ACK })).html).toContain(STEER_ACK)
  })

  it('says what it is doing instead of that it is working', () => {
    const html = renderExecution(state({ thinking: true })).html
    expect(html).not.toContain('Агент работает')
    expect(html).toContain('🧠 Думаю')
  })

  it('escapes dynamic content', () => {
    const { html } = renderExecution(state({ steps: [{ index: 1, title: '<b>x</b>', status: 'done' }] }))
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  it('shows the debug marker and step details only in debug mode', () => {
    const s = state({ steps: [{ index: 1, title: 't', status: 'active', detail: 'tool.call · seq:5' }] })
    expect(renderExecution(s, { debug: false }).html).not.toContain('[отладка]')
    expect(renderExecution(s, { debug: false }).html).not.toContain('seq:5')
    const dbg = renderExecution(s, { debug: true, debugTail: '💾 Журнал: 8 событий' }).html
    expect(dbg).toContain('[отладка]')
    expect(dbg).toContain('[tool.call · seq:5]')
    expect(dbg).toContain('💾 Журнал: 8 событий')
  })
})
