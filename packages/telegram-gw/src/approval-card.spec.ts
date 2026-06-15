import { describe, it, expect } from 'vitest'
import type { PendingAction } from '@aisy/core'
import {
  encodeCallback,
  decodeCallback,
  makeCardButtons,
  renderCard,
  renderResolved,
  CALLBACK_MAX_BYTES,
} from './approval-card.js'

function action(overrides?: Partial<PendingAction>): PendingAction {
  return {
    actionId: 'act_7f2c',
    actionHash: 'deadbeef',
    tier: 1,
    requiresStepUp: false,
    summary: 'bash_exec: rm -rf dist/',
    ...overrides,
  }
}

describe('callback encoding', () => {
  it('round-trips', () => {
    const cb = { cardId: 'c123', nonce: 'n456', verb: 'confirm' as const }
    expect(decodeCallback(encodeCallback(cb))).toEqual(cb)
  })

  it('round-trips every verb', () => {
    for (const verb of ['confirm', 'reject', 'info'] as const) {
      const data = encodeCallback({ cardId: 'c', nonce: 'n', verb })
      expect(decodeCallback(data)?.verb).toBe(verb)
    }
  })

  it('rejects foreign or malformed payloads', () => {
    expect(decodeCallback('something:else')).toBeNull()
    expect(decodeCallback('atap|y|only-three')).toBeNull()
    expect(decodeCallback('atap|z|c|n')).toBeNull() // unknown verb
    expect(decodeCallback('atap|y||n')).toBeNull() // empty cardId
  })

  it('throws on the reserved delimiter in fields', () => {
    expect(() => encodeCallback({ cardId: 'a|b', nonce: 'n', verb: 'reject' })).toThrow()
  })

  it('throws when callback_data would exceed the Telegram byte cap', () => {
    expect(() =>
      encodeCallback({ cardId: 'x'.repeat(40), nonce: 'y'.repeat(40), verb: 'confirm' }),
    ).toThrow()
  })

  it('stays within the byte cap for realistic ids', () => {
    const data = encodeCallback({
      cardId: 'a1b2c3d4',
      nonce: 'Zm9vYmFyYmF6cXV4',
      verb: 'confirm',
    })
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(CALLBACK_MAX_BYTES)
  })
})

describe('makeCardButtons', () => {
  it('tier 1: confirm + reject', () => {
    const rows = makeCardButtons(action({ tier: 1 }), 'c', 'n')
    expect(rows[0]!.map((b) => b.text)).toEqual(['✅ Подтвердить', '❌ Отклонить'])
  })

  it('tier 2: adds an info button', () => {
    const rows = makeCardButtons(action({ tier: 2 }), 'c', 'n')
    expect(rows[0]!.map((b) => b.text)).toEqual([
      '✅ Подтвердить',
      '❌ Отклонить',
      'ℹ️ Подробнее',
    ])
  })

  it('tier 3 without step-up: reject only', () => {
    const rows = makeCardButtons(action({ tier: 3, requiresStepUp: true }), 'c', 'n')
    expect(rows[0]!.map((b) => b.text)).toEqual(['❌ Отклонить'])
  })

  it('tier 3 with step-up ready: confirm appears', () => {
    const rows = makeCardButtons(action({ tier: 3, requiresStepUp: true }), 'c', 'n', {
      stepUpReady: true,
    })
    expect(rows[0]!.map((b) => b.text)).toEqual(['✅ Подтвердить', '❌ Отклонить'])
  })
})

describe('renderCard', () => {
  it('tier 1 is the green confirmation header with reason', () => {
    const msg = renderCard(action({ tier: 1 }), {
      sessionId: 'abc123',
      reason: 'Инструмент запрашивает shell-команду.',
    })
    expect(msg.html).toContain('✅ <b>Подтверждение действия</b>')
    expect(msg.html).toContain('🎯 <b>Причина запроса:</b>')
    expect(msg.html).toContain('abc123')
    expect(msg.buttons).toBeUndefined()
  })

  it('tier 3 shows block reason and the step-up prompt before step-up', () => {
    const msg = renderCard(action({ tier: 3, requiresStepUp: true }), {
      sessionId: 's',
      reason: 'r',
      blockReason: 'Исходящий вызов к внешнему API.',
    })
    expect(msg.html).toContain('🚨 <b>КРИТИЧЕСКОЕ ДЕЙСТВИЕ</b>')
    expect(msg.html).toContain('🚫 <b>Причина блокировки:</b>')
    expect(msg.html).toContain('Требуется второй фактор')
  })

  it('tier 3 with step-up ready drops the step-up prompt', () => {
    const msg = renderCard(action({ tier: 3, requiresStepUp: true }), {
      sessionId: 's',
      reason: 'r',
      stepUpReady: true,
    })
    expect(msg.html).not.toContain('Требуется второй фактор')
  })

  it('escapes the action summary', () => {
    const msg = renderCard(action({ summary: 'echo <script> & done' }), {
      sessionId: 's',
      reason: 'r',
    })
    expect(msg.html).toContain('echo &lt;script&gt; &amp; done')
    expect(msg.html).not.toContain('<script>')
  })

  it('shows the informational countdown when provided', () => {
    const msg = renderCard(action({ tier: 2 }), {
      sessionId: 's',
      reason: 'r',
      waiting: '2:14',
    })
    expect(msg.html).toContain('⏳ Ожидает: 2:14')
  })
})

describe('renderResolved', () => {
  it('renders a confirmed footer', () => {
    expect(renderResolved(action(), 'confirmed', '14:32:01')).toContain(
      '✅ Подтверждено · 14:32:01',
    )
  })

  it('renders a rejected footer', () => {
    expect(renderResolved(action(), 'rejected', '14:33:00')).toContain('❌ Отклонено')
  })
})
