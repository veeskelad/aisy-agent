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
    const { html } = renderExecution(state(), { debug: true })
    expect(html).toContain('✅ 1. Прочитать конфиг')
    expect(html).toContain('⏳ 2. Запустить линтер  ← текущий')
    expect(html).toContain('⬜ 3. Записать результат')
  })

  it('names where the work happens, not the session uuid', () => {
    expect(renderExecution(state(), { debug: true }).html).toContain('проект «Aisy»')
    const { scope: _named, ...global } = state()
    expect(renderExecution(global, { debug: true }).html).toContain('общая папка')
  })

  it('runs one stopwatch for the whole turn, and none per step', () => {
    // Двое часов на экране — это одно и то же время, показанное дважды, причём
    // фазовые обнуляются после каждого инструмента и выглядят как сбой.
    const { html } = renderExecution(
      state({ elapsedMs: 12_400, thinking: true, phaseMs: 3_100 }),
      { debug: true },
    )
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
    }), { debug: true })
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
    } }), { debug: true })
    expect(html).toContain('▶️ bash_exec: <code>lint x</code>')
  })

  it('renders a subagent lifecycle', () => {
    const { html } = renderExecution(state({
      tool: { name: 'spawn_subagent', kind: 'subagent', status: 'completed' },
    }), { debug: true })
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
    }), { debug: true }).html
    expect(recovering).toContain('🎯 Действие: Изменение')
    expect(recovering).toContain('🔄 Не хватило доказательства — переспрашиваю')
    expect(recovering).toContain('Осталось: проверить состояние после изменения')

    const verified = renderExecution(state({
      action: { kind: 'delegate-required', status: 'verified' },
    }), { debug: true }).html
    expect(verified).toContain('🎯 Действие: Передача помощнику')
    expect(verified).toContain('✅ Результат подтверждён')
  })

  it.each([
    ['completed', 'Готово.'],
    ['stopped', 'Остановился.'],
    ['failed', 'Не получилось ответить. Попробовать ещё раз?'],
    ['awaiting', 'Жду решения.'],
    ['interrupted', 'Снова на связи.'],
  ] as const)('renders terminal status %s', (status, expected) => {
    expect(renderExecution(state({ status, thinking: true })).html).toContain(expected)
    expect(renderExecution(state({ status, thinking: true })).html).not.toContain('Агент работает')
  })

  it('AC-02-102 keeps a failed non-debug card free of runtime internals', () => {
    const html = renderExecution(state({
      status: 'failed',
      elapsedMs: 120,
      scope: 'общая папка',
      tool: { name: 'bash', status: 'failed', arg: 'private command' },
      action: { kind: 'inspect-required', status: 'recovering', missing: 'observation' },
    })).html

    expect(html).toBe('Не получилось ответить. Попробовать ещё раз?')
    expect(html).not.toContain('0,1 с')
    expect(html).not.toContain('общая папка')
    expect(html).not.toContain('private command')
    expect(html).not.toContain('провер')
  })

  it('keeps an interrupted non-debug card free of restart internals', () => {
    const html = renderExecution(state({
      status: 'interrupted',
      elapsedMs: 120,
      scope: 'общая папка',
      tool: { name: 'bash', status: 'running', arg: 'private command' },
    })).html

    expect(html).toBe('Снова на связи.')
    expect(html).not.toContain('0,1 с')
    expect(html).not.toContain('общая папка')
    expect(html).not.toContain('private command')
    expect(html).not.toContain('Напиши ещё раз')
  })

  it('renders the steer acknowledgement note', () => {
    expect(renderExecution(state({ note: STEER_ACK })).html).toContain(STEER_ACK)
  })

  it('does not narrate hidden thinking in ordinary chat', () => {
    const html = renderExecution(state({ thinking: true })).html
    expect(html).not.toContain('Агент работает')
    expect(html).toBe('Работаю…')
    expect(html).not.toContain('Думаю')
  })

  it('keeps ordinary progress free of runtime diagnostics', () => {
    const html = renderExecution(state({
      elapsedMs: 12_400,
      thinking: true,
      tool: { name: 'read_file', status: 'running', arg: '/private/source' },
      action: { kind: 'inspect-required', status: 'recovering', missing: 'observation' },
    })).html
    expect(html).toBe('Работаю…\nЧитаю файл…')
    for (const forbidden of [
      '12,4', 'общая папка', 'проект «Aisy»', 'Думаю', 'доказатель',
      'проверяем', '/private/source', 'read_file', 'Действие:',
    ]) expect(html).not.toContain(forbidden)
  })

  it('does not claim success for an unverified action', () => {
    const html = renderExecution(state({
      status: 'completed',
      action: { kind: 'mutate-required', status: 'unverified' },
    })).html
    expect(html).toBe('Не уверен, что всё получилось.')
    expect(html).not.toContain('Готово')
  })

  it('escapes dynamic content', () => {
    const { html } = renderExecution(
      state({ steps: [{ index: 1, title: '<b>x</b>', status: 'done' }] }),
      { debug: true },
    )
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
