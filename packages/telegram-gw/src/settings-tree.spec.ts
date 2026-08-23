import { describe, expect, it } from 'vitest'

import {
  decodeSettingsAction,
  LIMIT_PRESETS,
  MODE_TEXT,
  modeStatusLine,
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
  type SettingsButton,
} from './settings-tree.js'

const data = (rows: SettingsButton[][]): string[] => rows.flat().map((item) => item.data)

describe('settings tree', () => {
  it('gives every root button a decodable destination', () => {
    const view = renderSettingsRoot()
    const decoded = data(view.buttons).map(decodeSettingsAction)

    expect(decoded.every((action) => action !== null)).toBe(true)
    expect(decoded).toEqual([
      { kind: 'open', screen: 'connections' },
      { kind: 'open', screen: 'env' },
      { kind: 'open', screen: 'timers' },
      { kind: 'open', screen: 'goals' },
      { kind: 'open', screen: 'bots' },
      { kind: 'open', screen: 'limit' },
      { kind: 'open', screen: 'server' },
      { kind: 'open', screen: 'grants' },
      { kind: 'open', screen: 'system' },
    ])
  })

  it('refuses callback data it did not produce', () => {
    expect(decodeSettingsAction('project:switch:1')).toBeNull()
    expect(decodeSettingsAction('cfg:open:nowhere')).toBeNull()
    expect(decodeSettingsAction('cfg:mode:root')).toBeNull()
    expect(decodeSettingsAction('cfg:limit:abc')).toBeNull()
    expect(decodeSettingsAction('cfg:limit:10:extra')).toBeNull()
    expect(decodeSettingsAction('cfg:toggle:everything')).toBeNull()
    expect(decodeSettingsAction('cfg:svc:')).toBeNull()
    expect(decodeSettingsAction('cfg:carddraft:workspace')).toBeNull()
    expect(decodeSettingsAction('cfg:cardarchive')).toBeNull()
    expect(decodeSettingsAction('cfg:cardrollback')).toBeNull()
  })

  it('offers every spend preset and decodes it back to a number', () => {
    const view = renderLimitScreen({ currentUsd: 25, spentUsd: 3.5 })
    const limits = data(view.buttons)
      .map(decodeSettingsAction)
      .filter((action) => action?.kind === 'set-limit')
      .map((action) => (action as { dollars: number }).dollars)

    expect(limits).toEqual([...LIMIT_PRESETS])
    expect(view.text).toContain('$25')
    expect(view.text).toContain('3.50')
  })

  it('offers the unrestricted mode by name, with a warning icon', () => {
    const view = renderModeScreen({ mode: 'auto' })
    const bypass = view.buttons.flat().find((item) => item.data === 'cfg:mode:bypass')

    expect(bypass?.text).toBe('🚨 Без ограничений')
    expect(view.text).toContain('команды в терминале выполняю без разбора')
    expect(decodeSettingsAction('cfg:mode:bypass'))
      .toEqual({ kind: 'set-mode', mode: 'bypass' })
  })

  it('puts one mode per row and marks the current one', () => {
    const view = renderModeScreen({ mode: 'plan' })

    // Четыре в строку не помещались на телефоне — отсюда правило «один ряд».
    for (const row of view.buttons) expect(row).toHaveLength(1)
    expect(view.buttons.flat().find((item) => item.data === 'cfg:mode:plan')?.text)
      .toBe('▶ 📋 Сначала план')
    expect(view.text).toContain('Сейчас: <b>сначала план</b>')
  })

  it('says the same thing about a mode on its button and in its status line', () => {
    // Раньше кнопка обещала «Без спроса», а строка под ней говорила
    // «действовать без лишних вопросов; опасный host Bash ограничен».
    expect(modeStatusLine('auto')).toContain(MODE_TEXT.auto.status)
    expect(renderModeScreen({ mode: 'auto' }).text).toContain(MODE_TEXT.auto.hint)
    expect(renderAgentScreen({
      provider: 'anthropic', model: 'x', mode: 'auto', models: [],
    }).text).toContain(MODE_TEXT.auto.status)
  })

  it('keeps modes off the system screen — they live under the agent', () => {
    const system = renderSystemScreen({
      voice: [],
      showCostPerTurn: false,
      budgetEnabled: false,
      debug: false,
      timeZone: 'Europe/Moscow',
    })

    expect(data(system.buttons).some((entry) => entry.startsWith('cfg:mode:'))).toBe(false)
    expect(data(renderAgentScreen({
      provider: 'anthropic', model: 'x', mode: 'auto', models: [],
    }).buttons)).toContain('cfg:open:mode')
  })

  it('marks connected services and routes each to its own prompt', () => {
    const view = renderEnvScreen({
      services: [
        { id: 'deepgram', label: '🎙 Deepgram', purpose: 'голос', connected: true },
        { id: 'github', label: '🐙 GitHub', purpose: 'репозитории', connected: false },
      ],
    })

    // Список сервисов существует один раз — клавиатурой; текст его не повторяет.
    expect(view.buttons.flat().find((item) => item.data === 'cfg:svc:deepgram')?.text)
      .toBe('🎙 Deepgram ✅')
    expect(view.buttons.flat().find((item) => item.data === 'cfg:svc:github')?.text)
      .toBe('🐙 GitHub')
    expect(view.text).not.toContain('Deepgram')
    expect(data(view.buttons)).toContain('cfg:custom')
  })

  it('tells the operator where the key goes before asking for it', () => {
    const view = renderServicePrompt({
      label: '🎙 Deepgram',
      purpose: 'расшифровка голосовых',
      source: 'console.deepgram.com',
      envKey: 'AISY_DEEPGRAM_KEY',
    })

    expect(view.text).toContain('console.deepgram.com')
    expect(view.text).toContain('AISY_DEEPGRAM_KEY')
    expect(view.text).toContain('удалю сообщение')
    expect(data(view.buttons)).toEqual(['cfg:open:env'])
  })

  it('encodes models by index, since ids contain the callback separator', () => {
    const view = renderAgentScreen({
      provider: 'openrouter',
      model: 'openai/gpt-4o',
      mode: 'auto',
      models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4o'],
    })

    expect(data(view.buttons)).toContain('cfg:model:0')
    expect(data(view.buttons)).toContain('cfg:model:1')
    expect(view.buttons.flat().find((item) => item.data === 'cfg:model:1')?.text)
      .toBe('▶ openai/gpt-4o')
    expect(decodeSettingsAction('cfg:model:1')).toEqual({ kind: 'set-model', model: '1' })
  })

  it('keeps every callback inside Telegram’s 64-byte limit', () => {
    const views = [
      renderSettingsRoot(),
      renderConnectionsScreen({ provider: 'claude-subscription', model: 'default' }),
      renderLimitScreen({ currentUsd: 0, spentUsd: 0 }),
      renderSystemScreen({
        voice: [{ id: 'deepgram', label: 'Deepgram Nova-3', selected: true }],
        showCostPerTurn: true,
        budgetEnabled: false,
        debug: false,
        timeZone: 'Europe/Moscow',
      }),
      renderModeScreen({ mode: 'bypass' }),
      renderTimezoneScreen({ timeZone: 'Europe/Moscow', sample: () => '12:00' }),
      renderAgentScreen({
        provider: 'anthropic', model: 'x', mode: 'auto', models: ['a', 'b', 'c'], memory: true,
        agentCards: true,
      }),
      renderGrantsScreen({ body: '🗝 Разрешения' }),
      renderGrantsScreen({
        body: '🗝 Разрешения',
        learned: [{
          workflowKey: 'a'.repeat(32),
          title: 'читать example.com',
          version: 1,
          expires: '13 ноября',
          demonstrations: 7,
        }],
      }),
      renderBotsScreen({ body: 'Отвечает @aisy_bot' }),
      renderServerScreen({
        body: 'Диск 40 %',
        access: ['open-ssh', 'close-ssh', 'add-key', 'remove-key', 'tunnel'],
      }),
    ]
    for (const view of views) {
      for (const item of view.buttons.flat()) {
        expect(Buffer.byteLength(item.data, 'utf8')).toBeLessThanOrEqual(64)
        expect(decodeSettingsAction(item.data)).not.toBeNull()
      }
    }
  })

  it('hides the voice row when nothing can transcribe', () => {
    const view = renderSystemScreen({
      voice: [],
      showCostPerTurn: false,
      budgetEnabled: false,
      debug: false,
      timeZone: '',
    })

    expect(view.text).toContain('не подключена')
    expect(data(view.buttons).some((entry) => entry.startsWith('cfg:voice:'))).toBe(false)
  })

  it('gives every timer its own delete button', () => {
    const view = renderTimersScreen({
      timers: [
        { id: 'aaaa-1111', kind: 'schedule', prompt: 'утренняя сводка' },
        { id: 'bbbb-2222', kind: 'remind', prompt: 'позвонить' },
      ],
    })

    // A list you cannot act on is why /untrigger existed and nobody used it.
    expect(view.buttons.flat().map((item) => item.data))
      .toEqual(['cfg:untrig:aaaa-1111', 'cfg:untrig:bbbb-2222', 'cfg:open:root'])
    expect(decodeSettingsAction('cfg:untrig:aaaa-1111'))
      .toEqual({ kind: 'cancel-trigger', triggerId: 'aaaa-1111' })
    expect(view.text).toContain('утренняя сводка')
  })

  it('offers only the access operations this installation actually configured', () => {
    const view = renderServerScreen({ body: 'Диск 40 %', access: ['open-ssh', 'close-ssh'] })

    expect(data(view.buttons)).toEqual(['cfg:acc:open-ssh', 'cfg:acc:close-ssh', 'cfg:open:root'])
    expect(decodeSettingsAction('cfg:acc:open-ssh'))
      .toEqual({ kind: 'server-access', operation: 'open-ssh' })
    // An operation the runtime does not describe is not a door this view opens.
    expect(decodeSettingsAction('cfg:acc:format-disk')).toBeNull()
  })

  it('renders the server screen without access buttons when nothing is configured', () => {
    const view = renderServerScreen({ body: 'Диск 40 %' })

    expect(data(view.buttons)).toEqual(['cfg:open:root'])
    expect(view.text).not.toContain('Доступ открывается')
  })

  it('hides nightly memory buttons when the installation has no nightly work', () => {
    const withMemory = renderAgentScreen({
      provider: 'anthropic', model: 'x', mode: 'auto', models: [], memory: true,
    })
    const without = renderAgentScreen({
      provider: 'anthropic', model: 'x', mode: 'auto', models: [],
    })

    expect(data(withMemory.buttons)).toContain('cfg:nightly:staged')
    expect(data(withMemory.buttons)).toContain('cfg:nightly:run')
    expect(data(without.buttons).some((entry) => entry.startsWith('cfg:nightly:'))).toBe(false)
    expect(decodeSettingsAction('cfg:nightly:run')).toEqual({ kind: 'consolidate' })
    expect(decodeSettingsAction('cfg:nightly:staged')).toEqual({ kind: 'open-staging' })
    expect(decodeSettingsAction('cfg:nightly:whatever')).toBeNull()
  })

  it('shows a running goal as progress, and offers the one act that fits it', () => {
    const view = renderGoalsScreen({
      goal: {
        objective: 'Собрать проект без ошибок типов',
        mode: 'until',
        status: 'active',
        iterationsSpent: 3,
        maxIterations: 12,
        dollarsSpent: 0.418,
        dollarCeiling: 2,
        lastFeedback: 'осталось 2 ошибки в bot.ts',
      },
    })

    expect(view.text).toContain('Собрать проект без ошибок типов')
    expect(view.text).toContain('Итераций: 3 из 12')
    expect(view.text).toContain('$0.42 из $2.00')
    expect(view.text).toContain('осталось 2 ошибки')
    expect(data(view.buttons)).toEqual(['cfg:goalstop', 'cfg:open:root'])
    expect(decodeSettingsAction('cfg:goalstop')).toEqual({ kind: 'stop-goal' })
  })

  it('does not offer to stop a goal that already finished', () => {
    const finished = renderGoalsScreen({
      goal: {
        objective: 'x', mode: 'budget', status: 'halted',
        iterationsSpent: 12, maxIterations: 12, dollarsSpent: 2, dollarCeiling: 2,
        haltReason: 'исчерпан бюджет',
      },
    })

    expect(data(finished.buttons)).toEqual(['cfg:open:root'])
    expect(finished.text).toContain('исчерпан бюджет')
  })

  it('показывает выученные разрешения рядом с ручными (AC-24-13)', () => {
    const view = renderGrantsScreen({
      body: '🗝 <b>Разрешения</b>\n\n• bash · always',
      learned: [
        {
          workflowKey: 'a'.repeat(32),
          title: 'читать docs.example.com',
          version: 2,
          expires: '13 ноября',
          demonstrations: 7,
        },
        {
          workflowKey: 'b'.repeat(32),
          title: 'коммитить в проекте aisy',
          version: 1,
          expires: '1 декабря',
          demonstrations: 5,
        },
      ],
    })

    // Ручное на месте, выученное — своей секцией с версией, сроком и счётом.
    expect(view.text).toContain('bash · always')
    expect(view.text).toContain('🎓')
    expect(view.text).toContain('читать docs.example.com · до 13 ноября · показал 7 раз')
    // Отзыв поштучный, у каждого свой ключ, плюс общий сброс ручных.
    expect(data(view.buttons)).toEqual([
      `cfg:unlearn:${'a'.repeat(32)}`,
      `cfg:unlearn:${'b'.repeat(32)}`,
      'cfg:ungrant',
      'cfg:open:root',
    ])
    expect(decodeSettingsAction(`cfg:unlearn:${'a'.repeat(32)}`))
      .toEqual({ kind: 'revoke-learned', workflowKey: 'a'.repeat(32) })
  })

  it('без выученного экран остаётся прежним', () => {
    const view = renderGrantsScreen({ body: '🗝 Разрешения' })

    expect(view.text).toBe('🗝 Разрешения')
    expect(view.text).not.toContain('🎓')
    expect(data(view.buttons)).toEqual(['cfg:ungrant', 'cfg:open:root'])
  })

  it('отвергает callback отзыва с непохожим ключом', () => {
    // Строка приходит из Telegram; форма ключа проверяется, а не принимается.
    expect(decodeSettingsAction('cfg:unlearn:../../etc')).toBeNull()
    expect(decodeSettingsAction('cfg:unlearn:')).toBeNull()
    expect(decodeSettingsAction('cfg:unlearn')).toBeNull()
    expect(decodeSettingsAction(`cfg:unlearn:${'A'.repeat(32)}`)).toBeNull()
  })

  it('экранирует название процесса, пришедшее с разметкой', () => {
    const view = renderGrantsScreen({
      body: 'x',
      learned: [{
        workflowKey: 'c'.repeat(32),
        title: 'читать <b>чужой</b>',
        version: 1,
        expires: '1 января',
        demonstrations: 5,
      }],
    })

    expect(view.text).toContain('&lt;b&gt;')
  })

  it('shows a running research as a moving counter without buttons', () => {
    const active = renderResearchCard({
      question: 'чем LLM-harness отличается от <framework>',
      pages: 3,
      maxPages: 12,
      status: 'active',
    })

    expect(active.text).toContain('🔬')
    expect(active.text).toContain('страниц: 3 из 12')
    // The question may carry markup; it is quoted, never interpreted.
    expect(active.text).toContain('&lt;framework&gt;')
    // No buttons: the turn's own stop card already covers interruption.
    expect(active.buttons).toEqual([])
  })

  it('closes the research card with the reason it stopped early', () => {
    const done = renderResearchCard({
      question: 'вопрос',
      pages: 12,
      maxPages: 12,
      status: 'done',
      note: 'Исследование остановлено на лимите: 12 страниц.',
    })

    expect(done.text).toContain('✅ закончил · страниц: 12')
    expect(done.text).toContain('на лимите')
  })

  it('explains what a goal is when there is none, instead of showing an empty card', () => {
    const view = renderGoalsScreen({})

    expect(view.text).toContain('Активной цели нет')
    // The distinction nobody knows without reading the spec.
    expect(view.text).toContain('таймер')
    expect(data(view.buttons)).toEqual(['cfg:open:root'])
  })

  it('escapes an objective that carries markup', () => {
    const view = renderGoalsScreen({
      goal: {
        objective: '<b>подмена</b>', mode: 'until', status: 'active',
        iterationsSpent: 0, maxIterations: 5, dollarsSpent: 0, dollarCeiling: 1,
      },
    })

    expect(view.text).toContain('&lt;b&gt;подмена&lt;/b&gt;')
  })

  it('puts adding a bot on the bots screen instead of in a command hint', () => {
    const view = renderBotsScreen({ body: 'Отвечает @aisy_bot' })

    expect(data(view.buttons)).toEqual(['cfg:botadd', 'cfg:open:root'])
    expect(view.text).not.toContain('/bots')
    expect(decodeSettingsAction('cfg:botadd')).toEqual({ kind: 'add-bot' })
  })

  it('says where schedule time comes from when there is nothing to show', () => {
    expect(renderTimersScreen({ timers: [] }).text).toContain('часовому поясу')
  })

  it('picks a timezone by index and shows the local clock on the button', () => {
    const view = renderTimezoneScreen({ timeZone: 'Europe/Moscow', sample: () => '09:00' })

    // Кнопка называет город, а не путь в базе зон: «Europe/Moscow» — это адрес
    // данных, а оператор ищет глазами Москву.
    const moscow = view.buttons.flat().find((item) => item.text.includes('Москва'))!
    expect(moscow.text).toBe('▶ Москва 09:00')
    expect(decodeSettingsAction(moscow.data))
      .toEqual({ kind: 'set-timezone', timeZone: 'Europe/Moscow' })
    // An index outside the catalogue is not a zone.
    expect(decodeSettingsAction('cfg:tz:99')).toBeNull()
  })
})

describe('naming a model by hand', () => {
  it('offers the escape hatch even when the catalogue has a list', () => {
    const view = renderAgentScreen({
      provider: 'anthropic',
      model: 'claude-opus-5',
      mode: 'auto',
      models: ['claude-opus-5', 'claude-sonnet-5'],
    })

    expect(data(view.buttons)).toContain('cfg:model:custom')
  })

  it('points at the button instead of providers.json when there is no list', () => {
    const view = renderAgentScreen({
      provider: 'openrouter',
      model: 'anthropic/claude-opus-5',
      mode: 'auto',
      models: [],
    })

    expect(view.text).toContain('впиши название сам')
    expect(view.text).not.toContain('providers.json')
    expect(data(view.buttons)).toContain('cfg:model:custom')
  })

  it('decodes `custom` as its own action, not as a catalogue index', () => {
    expect(decodeSettingsAction('cfg:model:custom')).toEqual({ kind: 'custom-model' })
    expect(decodeSettingsAction('cfg:model:2')).toEqual({ kind: 'set-model', model: '2' })
  })
})
