import { describe, expect, it } from 'vitest'
import type { BrainBootstrapState } from '@aisy/core'
import {
  BRAIN_CHOICES,
  BRAIN_RESET_CALLBACK_PREFIX,
  decodeBrainBootstrapAction,
  renderBrainAuthChallenge,
  renderBrainBootstrap,
  renderBrainVendor,
} from './bootstrap-view.js'

function state(
  phase: BrainBootstrapState['phase'],
  selectedBrain?: BrainBootstrapState['selectedBrain'],
): BrainBootstrapState {
  return {
    version: 1,
    phase,
    revision: 0,
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...(selectedBrain ? { selectedBrain } : {}),
  }
}

describe('brain bootstrap Telegram view', () => {
  it('offers both subscriptions and three API connections without credentials', () => {
    expect(BRAIN_CHOICES.map((choice) => choice.label)).toEqual([
      'Claude Pro / Max',
      'Codex / ChatGPT',
      'Anthropic API',
      'OpenAI API',
      'OpenRouter',
    ])
    expect(JSON.stringify(BRAIN_CHOICES)).not.toMatch(/secret|token|credential/i)
  })

  it('decodes only allowlisted callbacks', () => {
    const action = decodeBrainBootstrapAction('bootstrap:brain:codex-subscription:7')
    expect(action).toEqual({
      kind: 'select',
      event: {
        type: 'brain-selected',
        connectionId: 'codex-subscription',
        provider: 'openai',
        authMode: 'subscription',
        runtime: 'codex-app-server',
        requiresInstall: true,
      },
      expectedRevision: 7,
    })
    expect(decodeBrainBootstrapAction('bootstrap:brain:unknown:7')).toBeNull()
    expect(decodeBrainBootstrapAction('bootstrap:brain:codex-subscription')).toBeNull()
    expect(decodeBrainBootstrapAction('set:debug')).toBeNull()
  })

  it('decodes the reversible reset action', () => {
    expect(decodeBrainBootstrapAction(BRAIN_RESET_CALLBACK_PREFIX + '9')).toEqual({
      kind: 'reset', expectedRevision: 9,
    })
    expect(decodeBrainBootstrapAction('bootstrap:advance:begin-auth:9')).toEqual({
      kind: 'advance', operation: 'begin-auth', expectedRevision: 9,
    })
    expect(decodeBrainBootstrapAction('bootstrap:advance:unknown:9')).toBeNull()
  })

  it('asks which vendor first, not how it is paid for', () => {
    const fresh = renderBrainBootstrap(state('NO_BRAIN'))
    const paired = renderBrainBootstrap(state('CHOOSE_BRAIN'))
    expect(fresh).toEqual(paired)
    expect(fresh.buttons.flat().map((button) => button.text))
      .toEqual(['Claude', 'ChatGPT / Codex', 'OpenRouter'])
    expect(fresh.text).toContain('не получит доступ к сообщениям')
  })

  it('offers subscription and key inside the vendor, and back out of it', () => {
    const view = renderBrainVendor(state('CHOOSE_BRAIN'), 'claude')

    expect(view.buttons.flat().map((button) => button.data)).toEqual([
      'bootstrap:brain:claude-subscription:0',
      'bootstrap:brain:anthropic-api:0',
      'bootstrap:vendors:0',
    ])
    // Back must not dispatch reset-brain: nothing is selected yet at
    // CHOOSE_BRAIN, and the reducer refuses that transition.
    expect(decodeBrainBootstrapAction('bootstrap:vendors:0'))
      .toEqual({ kind: 'vendors', expectedRevision: 0 })
    expect(decodeBrainBootstrapAction('bootstrap:vendor:claude:0'))
      .toEqual({ kind: 'vendor', vendorId: 'claude', expectedRevision: 0 })
    expect(decodeBrainBootstrapAction('bootstrap:vendor:nobody:0')).toBeNull()
  })

  it('keeps OpenRouter a single step — there is no subscription to choose', () => {
    const view = renderBrainVendor(state('CHOOSE_BRAIN'), 'openrouter')

    expect(view.buttons[0]?.map((button) => button.data))
      .toEqual(['bootstrap:brain:openrouter-api:0'])
  })

  it('keeps native setup fail closed while its protected channel is unavailable', () => {
    // Ordinary chat remains outside the protected credential boundary.
    const view = renderBrainBootstrap(state('AWAITING_AUTH', {
      connectionId: 'openai-api',
      provider: 'openai',
      authMode: 'api-key',
      runtime: 'native-api',
      status: 'auth-required',
    }))
    expect(view.text).toContain('Ввод API-ключа в Telegram отключён')
    expect(view.text).toContain('production secret backend/proxy ещё не подключены')
    expect(view.text).toContain('Не отправляй секреты обычным сообщением')
    // No validation action exists until a genuine protected challenge exists.
    expect(view.buttons.flat().map((button) => button.data)).toEqual([
      BRAIN_RESET_CALLBACK_PREFIX + '0',
    ])
  })

  it('asks for a claude setup-token, because the server has no browser', () => {
    const view = renderBrainBootstrap(state('AWAITING_AUTH', {
      connectionId: 'claude-subscription',
      provider: 'anthropic',
      authMode: 'subscription',
      runtime: 'claude-code',
      status: 'auth-required',
    }))
    expect(view.text).toContain('claude setup-token')
    expect(view.text).toContain('sk-ant-')
    // No begin-auth: that would open a browser login on a headless host.
    expect(view.buttons.flat().map((button) => button.data)).toEqual([
      BRAIN_RESET_CALLBACK_PREFIX + '0',
    ])
  })

  it('still refuses secrets for the device-code subscription', () => {
    const view = renderBrainBootstrap(state('AWAITING_AUTH', {
      connectionId: 'codex-subscription',
      provider: 'openai',
      authMode: 'subscription',
      runtime: 'codex-app-server',
      status: 'auth-required',
    }))
    expect(view.text).toContain('Секреты в обычный чат пока не отправляй')
    expect(view.buttons.flat().map((button) => button.data)).toEqual([
      'bootstrap:advance:begin-auth:0',
      'bootstrap:advance:complete-auth:0',
      BRAIN_RESET_CALLBACK_PREFIX + '0',
    ])
  })

  it('offers the way out of BRAIN_READY instead of dead-ending', () => {
    const view = renderBrainBootstrap(state('BRAIN_READY', {
      connectionId: 'openrouter-api',
      provider: 'openrouter',
      authMode: 'api-key',
      runtime: 'native-api',
      status: 'ready',
    }))
    expect(view.buttons.flat().map((button) => button.data))
      .toEqual(['bootstrap:advance:start-intro:0'])
  })

  it('keeps validation explicit, and an interrupted install honest', () => {
    const selected = {
      connectionId: 'claude-subscription',
      provider: 'anthropic',
      authMode: 'subscription' as const,
      runtime: 'claude-code' as const,
      status: 'installing' as const,
    }
    // No error code: the process died mid-install rather than npm refusing.
    const interrupted = renderBrainBootstrap(state('INSTALLING_RUNTIME', selected))
    expect(interrupted.text).toContain('прервалась')
    expect(interrupted.buttons.flat()[0]?.text).toBe('Повторить')
    expect(renderBrainBootstrap(state('VALIDATING_AUTH', { ...selected, status: 'validating' })).text)
      .toContain('живой проверки')
  })

  it('treats a reached install screen as a failure, not a step', () => {
    // The coordinator installs while handling the selection, so a successful
    // run never stops here. What the operator needs is the reason, not an
    // invitation to press a button they were never meant to see.
    const failed = renderBrainBootstrap({
      ...state('INSTALLING_RUNTIME', {
        connectionId: 'codex-subscription',
        provider: 'openai',
        authMode: 'subscription',
        runtime: 'codex-app-server',
        status: 'installing',
      }),
      lastErrorCode: 'RUNTIME_INSTALL_FAILED',
    }, 'npm вернул код 1. env: node: No such file or directory')

    expect(failed.text).toContain('Не удалось поставить движок')
    expect(failed.text).toContain('env: node: No such file or directory')
    expect(failed.text).toContain('npm i -g @openai/codex')
    expect(failed.text).not.toContain('поставит его сама')
    expect(failed.buttons.flat()[0]?.text).toBe('Повторить')
  })

  it('renders only allowlisted safe auth challenge fields', () => {
    const selected = {
      connectionId: 'codex-subscription', provider: 'openai',
      authMode: 'subscription' as const, runtime: 'codex-app-server' as const,
      status: 'auth-required' as const,
    }
    const view = renderBrainAuthChallenge(state('AWAITING_AUTH', selected), {
      kind: 'device-code',
      verificationUri: 'https://auth.example/activate',
      userCode: 'ABCD-1234',
    })
    expect(view.text).toContain('https://auth.example/activate')
    expect(view.text).toContain('ABCD-1234')
    expect(view.buttons.flat()[0]?.data).toBe('bootstrap:advance:complete-auth:0')
  })

  it('shows API validation only when the protected terminal entry channel is available', () => {
    const selected = {
      connectionId: 'openai-api', provider: 'openai',
      authMode: 'api-key' as const, runtime: 'native-api' as const,
      status: 'auth-required' as const,
    }
    const available = renderBrainAuthChallenge(state('AWAITING_AUTH', selected), {
      kind: 'secret-input',
      provider: 'openai',
      secretKind: 'api-key',
      safeInstructions:
        'В терминале хоста Aisy запусти: aisy brain credential set --code=PublicEntryCode_123456',
      secureEntryAvailable: true,
    })
    expect(available.text).toContain('Ввод ключа здесь отключён')
    expect(available.buttons.flat()[0]?.data).toBe('bootstrap:advance:complete-auth:0')

    const unavailable = renderBrainAuthChallenge(state('AWAITING_AUTH', selected), {
      kind: 'secret-input',
      provider: 'openai',
      secretKind: 'api-key',
      safeInstructions: 'Используй защищённый терминал.',
      secureEntryAvailable: false,
    })
    expect(unavailable.buttons.flat().map((button) => button.data)).toEqual([
      BRAIN_RESET_CALLBACK_PREFIX + '0',
    ])
  })
})
