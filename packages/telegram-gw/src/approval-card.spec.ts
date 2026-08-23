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
    for (const verb of ['confirm', 'session', 'always', 'reject', 'info'] as const) {
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
  it('says the same two words on every tier', () => {
    // Раньше отказ подписывался то «Отменить», то «Отклонить» — в одном файле,
    // для одного и того же действия.
    for (const tier of [0, 1, 2] as const) {
      const rows = makeCardButtons(action({ tier }), 'c', 'n')
      expect(rows.map((r) => r.map((b) => b.text))).toEqual([['✅ Разрешить', '❌ Отменить']])
    }
  })

  it('offers no lasting-permission buttons, whatever the matcher says', () => {
    const rows = makeCardButtons(action({ tier: 2, canRememberSimilar: true }), 'c', 'n')

    expect(rows.flat().map((button) => button.text)).toEqual(['✅ Разрешить', '❌ Отменить'])
    expect(rows.flat().map((button) => decodeCallback(button.data)?.verb))
      .toEqual(['confirm', 'reject'])
  })

  it('tier 3 can be approved at all — the tap starts the code prompt', () => {
    // Прежде до второго фактора показывалась одна кнопка «Отменить», а ввести
    // код было негде: подтвердить опасное действие было нельзя ничем.
    const rows = makeCardButtons(action({ tier: 3, requiresStepUp: true }), 'c', 'n')
    expect(rows[0]!.map((b) => b.text)).toEqual(['✅ Разрешить', '❌ Отменить'])
  })
})

describe('renderCard', () => {
  it('says what will happen in words, not as a call signature', () => {
    const msg = renderCard(action({ tier: 2, summary: 'bash(git push origin main)' }), {
      sessionId: 'abc123',
    })

    expect(msg.html).toContain('⚠️ <b>Нужно твоё решение</b>')
    expect(msg.html).toContain('Выполню команду: <code>git push origin main</code>')
    // Идентификаторы — для журнала, не для телефона.
    expect(msg.html).not.toContain('abc123')
    expect(msg.buttons).toBeUndefined()
  })

  it('keeps an unknown call visible rather than hiding it', () => {
    const msg = renderCard(action({ summary: 'weird_tool(a, b)' }), { sessionId: 's' })
    expect(msg.html).toContain('weird_tool(a, b)')
  })

  it('stays silent when the agent has nothing to add', () => {
    const msg = renderCard(action({ tier: 2 }), { sessionId: 's' })

    // Одна и та же фраза под каждым действием учит не читать карточку.
    expect(msg.html).not.toContain('Зачем')
    expect(msg.html).not.toContain('Риск')
  })

  it('tier 3 shows why it is dangerous and asks for nothing beyond the tap', () => {
    const msg = renderCard(action({ tier: 3, requiresStepUp: true }), {
      sessionId: 's',
      blockReason: 'Исходящий вызов к внешнему сервису.',
    })
    expect(msg.html).toContain('🚨 <b>Опасное действие</b>')
    expect(msg.html).toContain('🚫 Почему это опасно: Исходящий вызов')
  // Второго шага нет: тап оператора и есть подтверждение (ADR-0104).
    expect(msg.html).not.toContain('код')
  })

  it('escapes the action summary', () => {
    const msg = renderCard(action({ summary: 'echo <script> & done' }), { sessionId: 's' })
    expect(msg.html).toContain('echo &lt;script&gt; &amp; done')
    expect(msg.html).not.toContain('<script>')
  })

  it('escapes a command that only looks like a known call', () => {
    const msg = renderCard(action({ summary: 'bash(<script>alert(1)</script>)' }), {
      sessionId: 's',
    })
    expect(msg.html).toContain('&lt;script&gt;')
    expect(msg.html).not.toContain('<script>')
  })

  it('shows the informational countdown when provided', () => {
    const msg = renderCard(action({ tier: 2 }), { sessionId: 's', waiting: '2:14' })
    expect(msg.html).toContain('⏳ Жду: 2:14')
  })
})

describe('renderResolved', () => {
  it('renders a confirmed footer', () => {
    expect(renderResolved(action(), 'confirmed', '14:32:01')).toContain('✅ Разрешено · 14:32:01')
  })

  it('renders a rejected footer', () => {
    expect(renderResolved(action(), 'rejected', '14:33:00')).toContain('❌ Отменено')
  })

  it('says why it closed when the operator did not decide', () => {
    // Отказ без причины читается как поломка: оператор ничего не нажимал.
    expect(renderResolved(action(), 'rejected', '14:33:00', 'expired'))
      .toContain('Карточка устарела')
    expect(renderResolved(action(), 'rejected', '14:33:00', 'step-up-failed'))
      .toContain('Код не подошёл')
  })
})
