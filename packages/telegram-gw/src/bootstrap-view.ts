import type {
  AuthChallenge,
  BrainBootstrapEvent,
  BrainBootstrapPhase,
  BrainBootstrapState,
} from '@aisy/core'

export type BrainChoiceId =
  | 'claude-subscription'
  | 'codex-subscription'
  | 'anthropic-api'
  | 'openai-api'
  | 'openrouter-api'

export type BrainSelectedEvent = Extract<BrainBootstrapEvent, { type: 'brain-selected' }>

export interface BrainChoice {
  id: BrainChoiceId
  label: string
  event: BrainSelectedEvent
}

export interface BootstrapButton {
  text: string
  data: string
}

export interface BrainBootstrapView {
  text: string
  buttons: BootstrapButton[][]
}

/**
 * A vendor is what the operator recognises; subscription-versus-key is a
 * question about the same vendor, so it belongs inside, not next to it.
 */
export type BrainVendorId = 'claude' | 'codex' | 'openrouter'

export interface BrainVendor {
  id: BrainVendorId
  label: string
  /** Connection ids offered inside, in display order. */
  options: readonly { connectionId: BrainChoiceId; label: string }[]
}

export const BRAIN_VENDORS: readonly BrainVendor[] = [
  {
    id: 'claude',
    label: 'Claude',
    options: [
      { connectionId: 'claude-subscription', label: 'Подписка Pro / Max' },
      { connectionId: 'anthropic-api', label: 'API-ключ' },
    ],
  },
  {
    id: 'codex',
    label: 'ChatGPT / Codex',
    options: [
      { connectionId: 'codex-subscription', label: 'Подписка ChatGPT' },
      { connectionId: 'openai-api', label: 'API-ключ' },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    options: [{ connectionId: 'openrouter-api', label: 'API-ключ' }],
  },
]

export type BrainBootstrapAction =
  | { kind: 'select'; event: BrainSelectedEvent; expectedRevision: number }
  | { kind: 'vendor'; vendorId: BrainVendorId; expectedRevision: number }
  | { kind: 'vendors'; expectedRevision: number }
  | { kind: 'reset'; expectedRevision: number }
  | {
      kind: 'advance'
      operation: 'retry-install' | 'begin-auth' | 'complete-auth' | 'start-intro'
      expectedRevision: number
    }

const CALLBACK_PREFIX = 'bootstrap:brain:'
const VENDOR_PREFIX = 'bootstrap:vendor:'
const VENDOR_LIST_PREFIX = 'bootstrap:vendors:'
export const BRAIN_RESET_CALLBACK_PREFIX = 'bootstrap:reset:'
const ADVANCE_PREFIX = 'bootstrap:advance:'

export const BRAIN_CHOICES: readonly BrainChoice[] = [
  {
    id: 'claude-subscription',
    label: 'Claude Pro / Max',
    event: {
      type: 'brain-selected',
      connectionId: 'claude-subscription',
      provider: 'anthropic',
      authMode: 'subscription',
      runtime: 'claude-code',
      requiresInstall: true,
    },
  },
  {
    id: 'codex-subscription',
    label: 'Codex / ChatGPT',
    event: {
      type: 'brain-selected',
      connectionId: 'codex-subscription',
      provider: 'openai',
      authMode: 'subscription',
      runtime: 'codex-app-server',
      requiresInstall: true,
    },
  },
  {
    id: 'anthropic-api',
    label: 'Anthropic API',
    event: {
      type: 'brain-selected',
      connectionId: 'anthropic-api',
      provider: 'anthropic',
      authMode: 'api-key',
      runtime: 'native-api',
      requiresInstall: false,
    },
  },
  {
    id: 'openai-api',
    label: 'OpenAI API',
    event: {
      type: 'brain-selected',
      connectionId: 'openai-api',
      provider: 'openai',
      authMode: 'api-key',
      runtime: 'native-api',
      requiresInstall: false,
    },
  },
  {
    id: 'openrouter-api',
    label: 'OpenRouter',
    event: {
      type: 'brain-selected',
      connectionId: 'openrouter-api',
      provider: 'openrouter',
      authMode: 'api-key',
      runtime: 'native-api',
      requiresInstall: false,
    },
  },
]

function vendorRows(revision: number): BootstrapButton[][] {
  return BRAIN_VENDORS.map((vendor) => [{
    text: vendor.label,
    data: `${VENDOR_PREFIX}${vendor.id}:${revision}`,
  }])
}

function resetButton(revision: number): BootstrapButton {
  return { text: '← Другой мозг', data: BRAIN_RESET_CALLBACK_PREFIX + revision }
}

function advanceButton(
  text: string,
  operation: Extract<BrainBootstrapAction, { kind: 'advance' }>['operation'],
  revision: number,
): BootstrapButton {
  return { text, data: `${ADVANCE_PREFIX}${operation}:${revision}` }
}

function resetRow(revision: number): BootstrapButton[][] {
  return [[resetButton(revision)]]
}

function phaseTitle(phase: BrainBootstrapPhase): string {
  return phase.replaceAll('_', ' ')
}

export function decodeBrainBootstrapAction(data: string): BrainBootstrapAction | null {
  const parseRevision = (value: string): number | null => {
    if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) return null
    const revision = Number(value)
    return Number.isSafeInteger(revision) ? revision : null
  }
  if (data.startsWith(VENDOR_LIST_PREFIX)) {
    const revision = parseRevision(data.slice(VENDOR_LIST_PREFIX.length))
    return revision === null ? null : { kind: 'vendors', expectedRevision: revision }
  }
  if (data.startsWith(VENDOR_PREFIX)) {
    const [id, rawRevision, extra] = data.slice(VENDOR_PREFIX.length).split(':')
    const revision = rawRevision === undefined ? null : parseRevision(rawRevision)
    if (extra !== undefined || revision === null) return null
    const vendor = BRAIN_VENDORS.find((candidate) => candidate.id === id)
    return vendor === undefined
      ? null
      : { kind: 'vendor', vendorId: vendor.id, expectedRevision: revision }
  }
  if (data.startsWith(BRAIN_RESET_CALLBACK_PREFIX)) {
    const revision = parseRevision(data.slice(BRAIN_RESET_CALLBACK_PREFIX.length))
    return revision === null ? null : { kind: 'reset', expectedRevision: revision }
  }
  if (data.startsWith(ADVANCE_PREFIX)) {
    const [operation, rawRevision, extra] = data.slice(ADVANCE_PREFIX.length).split(':')
    const revision = rawRevision === undefined ? null : parseRevision(rawRevision)
    if (extra !== undefined || revision === null ||
      (operation !== 'retry-install' && operation !== 'begin-auth' &&
        operation !== 'complete-auth' && operation !== 'start-intro')) {
      return null
    }
    return { kind: 'advance', operation, expectedRevision: revision }
  }
  if (!data.startsWith(CALLBACK_PREFIX)) return null
  const [id, rawRevision, extra] = data.slice(CALLBACK_PREFIX.length).split(':')
  const revision = rawRevision === undefined ? null : parseRevision(rawRevision)
  if (extra !== undefined || revision === null) return null
  const choice = BRAIN_CHOICES.find((candidate) => candidate.id === id)
  return choice
    ? { kind: 'select', event: { ...choice.event }, expectedRevision: revision }
    : null
}

const VENDOR_HINT: Record<BrainVendorId, string> = {
  claude:
    'Подписка — фиксированная цена, вход один раз с ноутбука.\n' +
    'API-ключ — оплата за запросы, ключ берётся в консоли Anthropic.',
  codex:
    'Подписка — фиксированная цена, вход с телефона по коду.\n' +
    'API-ключ — оплата за запросы, ключ берётся в консоли OpenAI.',
  openrouter:
    'Один ключ открывает каталог моделей разных вендоров, оплата за запросы.',
}

/** Second level of the choice: how this vendor is paid for. */
export function renderBrainVendor(
  state: BrainBootstrapState,
  vendorId: BrainVendorId,
): BrainBootstrapView {
  const vendor = BRAIN_VENDORS.find((candidate) => candidate.id === vendorId)
  if (!vendor) return renderBrainBootstrap(state)
  return {
    text: `${vendor.label}\n\n${VENDOR_HINT[vendorId]}`,
    buttons: [
      vendor.options.map((option) => ({
        text: option.label,
        data: `${CALLBACK_PREFIX}${option.connectionId}:${state.revision}`,
      })),
      [{ text: '← Назад', data: VENDOR_LIST_PREFIX + state.revision }],
    ],
  }
}

/**
 * `detail` is the driver's own safe explanation for the failure in `state`
 * (npm's tail, the provider's refusal). It is deliberately not part of the
 * durable state: it is one render long, and it must never be persisted.
 */
export function renderBrainBootstrap(
  state: BrainBootstrapState,
  detail?: string,
): BrainBootstrapView {
  if (state.phase === 'NO_BRAIN' || state.phase === 'CHOOSE_BRAIN') {
    return {
      text:
        'Aisy установлена. Подключим первый мозг.\n\n' +
        'Сначала выбери, чьей моделью думать. Платить подпиской или ключом — ' +
        'следующий шаг. До проверки подключения агент не получит доступ к сообщениям.',
      buttons: vendorRows(state.revision),
    }
  }

  const selected = state.selectedBrain
  const label = BRAIN_CHOICES.find((choice) => choice.id === selected?.connectionId)?.label
    ?? selected?.provider
    ?? 'выбранный мозг'

  // Installing is not a step the operator takes — the coordinator detects and
  // installs while handling the selection, and a successful run never stops
  // here. Reaching this phase means it failed, or the process died mid-install.
  if (state.phase === 'INSTALLING_RUNTIME') {
    const command = selected?.runtime === 'codex-app-server'
      ? 'npm i -g @openai/codex'
      : 'npm i -g @anthropic-ai/claude-code'
    return {
      text: state.lastErrorCode === undefined
        ? `Установка ${label} прервалась и не завершилась. Можно повторить.`
        : '❌ Не удалось поставить движок на сервере.\n\n' +
          `${detail ?? `Код: ${state.lastErrorCode}.`}\n\n` +
          `Если не встанет и со второго раза — выполни на хосте агента: \`${command}\``,
      buttons: [[
        advanceButton('Повторить', 'retry-install', state.revision),
      ], [resetButton(state.revision)]],
    }
  }

  if (state.phase === 'AWAITING_AUTH') {
    if (selected?.authMode === 'api-key') {
      return {
        text:
          `Выбран: ${label}.\n\n` +
          'Ввод API-ключа в Telegram отключён. Защищённый терминальный канал и ' +
          'production secret backend/proxy ещё не подключены, поэтому это соединение ' +
          'нельзя объявить готовым. Выбери мозг по подписке или вернись назад.\n\n' +
          'Не отправляй секреты обычным сообщением.',
        buttons: [[resetButton(state.revision)]],
      }
    }
    // Claude Code owns its own login and opens a browser for it — which the
    // agent's server does not have. `claude setup-token` is the vendor's answer
    // to exactly that: the operator authorises once on their own machine and
    // the token authenticates the CLI here.
    if (selected?.connectionId === 'claude-subscription') {
      const failure = state.lastErrorCode === undefined
        ? ''
        : `\n\n❌ Прошлый токен не подошёл (${state.lastErrorCode}). Пришли новый.`
      return {
        text:
          `Выбран: ${label}.\n\n` +
          'Нужен ноутбук — один раз. В терминале:\n' +
          '`claude setup-token`\n\n' +
          'Откроется браузер: войди в аккаунт с оплаченной подпиской и нажми Authorize. ' +
          'В терминале появится токен `sk-ant-…` — пришли его сюда одним сообщением.\n\n' +
          'Я проверю его настоящим запросом, сохраню и сразу удалю твоё сообщение. ' +
          'Ключ пройдёт через серверы Telegram — если это неприемлемо, положи его в ' +
          '~/.aisy/vault.json на сервере сам.' +
          failure,
        buttons: [[resetButton(state.revision)]],
      }
    }
    return {
      text:
        `Выбран: ${label}.\n\nДальше Aisy запустит официальный вход по подписке. ` +
        'Секреты в обычный чат пока не отправляй.',
      buttons: [[
        advanceButton('🔑 Войти', 'begin-auth', state.revision),
        advanceButton('Проверить', 'complete-auth', state.revision),
      ], [resetButton(state.revision)]],
    }
  }

  if (state.phase === 'VALIDATING_AUTH') {
    return {
      text: `Проверяю подключение: ${label}. Скажу «готово» только после живой проверки.`,
      buttons: resetRow(state.revision),
    }
  }

  if (state.phase === 'BRAIN_READY') {
    return {
      text:
        `✅ ${label} подключён и проверен.\n\n` +
        'Дальше — знакомство. Нажми кнопку: Aisy перезапустится уже с мозгом и ' +
        'через полминуты напишет сам.',
      buttons: [[advanceButton('Познакомиться', 'start-intro', state.revision)]],
    }
  }

  if (state.phase === 'COMPLETE') {
    return {
      text: '✅ Первичная настройка завершена. Перезапускаюсь с мозгом — ' +
        'через полминуты напишу сам и начнём знакомство.',
      buttons: [],
    }
  }

  return {
    text:
      `Подключение готово. Этап знакомства: ${phaseTitle(state.phase)}.\n` +
      'Настройки меняются только после явного подтверждения.',
    buttons: [],
  }
}

export function renderBrainAuthChallenge(
  state: BrainBootstrapState,
  challenge: AuthChallenge,
): BrainBootstrapView {
  const controls = [[
    advanceButton('Проверить', 'complete-auth', state.revision),
  ], [resetButton(state.revision)]]
  if (challenge.kind === 'device-code') {
    return {
      text:
        `Открой официальный адрес:\n${challenge.verificationUri}\n\n` +
        `Код: ${challenge.userCode}\n\nПосле завершения входа нажми «Проверить подключение».`,
      buttons: controls,
    }
  }
  if (challenge.kind === 'browser') {
    return {
      text: `${challenge.safeInstructions}\n\nПосле завершения входа нажми «Проверить подключение».`,
      buttons: controls,
    }
  }
  const entryStatus = challenge.secureEntryAvailable
    ? 'После безопасного ввода в терминале нажми «Проверить подключение».'
    : 'Защищённый локальный канал пока недоступен.'
  return {
    text:
      `${challenge.safeInstructions}\n\n` +
      'Обычный чат в Telegram не шифруется от края до края. Ввод ключа здесь отключён; ' +
      `используй одноразовый локальный/SSH/Tailscale канал.\n\n${entryStatus}`,
    buttons: challenge.secureEntryAvailable ? controls : [[resetButton(state.revision)]],
  }
}
