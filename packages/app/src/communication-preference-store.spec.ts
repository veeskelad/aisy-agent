import { describe, expect, it } from 'vitest'

import {
  makeCommunicationPreferenceStore,
  type CommunicationPreferenceFamily,
} from './communication-preference-store.js'

const SCOPE = { botId: 'bot-main', operatorId: 'telegram:42', profileId: 'default' }

function persistence(initial: Partial<Record<CommunicationPreferenceFamily, unknown>> = {}) {
  const values = new Map(Object.entries(initial) as Array<[CommunicationPreferenceFamily, unknown]>)
  let failFamily: CommunicationPreferenceFamily | null = null
  return {
    port: {
      load: (family: CommunicationPreferenceFamily) => values.get(family) ?? null,
      save: (family: CommunicationPreferenceFamily, state: unknown) => {
        if (failFamily === family) throw new Error('injected save failure')
        values.set(family, structuredClone(state))
      },
    },
    fail: (family: CommunicationPreferenceFamily | null) => { failFamily = family },
  }
}

describe('communication preference store', () => {
  it('activates explicit independent families without retaining raw dialogue', () => {
    const p = persistence()
    const store = makeCommunicationPreferenceStore({
      scope: SCOPE,
      persistence: p.port,
      nowIso: () => '2026-08-28T12:00:00.000Z',
    })
    const text = 'Говори короче и не показывай служебные id — пиши живее.'

    expect(store.observeExplicit({ text, sessionId: 's1', evidenceId: `update:1:${text}` }))
      .toBe(3)
    expect(store.overlay()).toContain('Отвечай кратко')
    expect(store.overlay()).toContain('Не показывай служебные id')
    expect(store.overlay()).toContain('живым естественным русским')
    expect(JSON.stringify([...(['verbosity', 'internal-detail', 'tone'] as const)
      .map(family => p.port.load(family))])).not.toContain(text)
  })

  it('requires inferred evidence from two different Sessions', () => {
    const p = persistence()
    const store = makeCommunicationPreferenceStore({ scope: SCOPE, persistence: p.port })

    expect(store.observeInferred({
      descriptor: 'concise', sessionId: 's1', evidenceId: 'delivery-1',
    })).toBe(false)
    expect(store.observeInferred({
      descriptor: 'concise', sessionId: 's1', evidenceId: 'delivery-retry',
    })).toBe(false)
    expect(store.active()).toEqual([])
    expect(store.observeInferred({
      descriptor: 'concise', sessionId: 's2', evidenceId: 'delivery-2',
    })).toBe(true)
    expect(store.active()[0]).toMatchObject({ descriptor: 'concise', source: 'inferred' })
  })

  it('recognizes feedback about excessive checks as an internal-detail preference', () => {
    const p = persistence()
    const store = makeCommunicationPreferenceStore({ scope: SCOPE, persistence: p.port })

    expect(store.observeExplicit({
      text: 'Не переборщи с проверками, сейчас слишком много контроля',
      sessionId: 's1',
      evidenceId: 'update-7',
    })).toBe(1)
    expect(store.active()[0]).toMatchObject({
      family: 'internal-detail', descriptor: 'hide-internals', source: 'explicit',
    })
  })

  it('activates an explicit grammatical gender and applies it on the next overlay', () => {
    const p = persistence()
    const store = makeCommunicationPreferenceStore({ scope: SCOPE, persistence: p.port })

    expect(store.observeExplicit({
      text: 'Агент отвечает в женском роде, не надо так, пусть отвечает в мужском роде',
      sessionId: 's1',
      evidenceId: 'update-gender-1',
    })).toBe(1)
    expect(store.active()).toContainEqual(expect.objectContaining({
      family: 'grammatical-gender', descriptor: 'masculine-russian', source: 'explicit',
    }))
    expect(store.overlay()).toContain('используй мужской род')
    expect(JSON.stringify(p.port.load('grammatical-gender'))).not.toContain('женском роде')
  })

  it('uses only the last explicit gender directive and understands a negative correction', () => {
    const p = persistence()
    const store = makeCommunicationPreferenceStore({ scope: SCOPE, persistence: p.port })

    expect(store.observeExplicit({
      text: 'Отвечай в женском роде. Нет, отвечай в мужском роде.',
      sessionId: 's1', evidenceId: 'gender-order',
    })).toBe(1)
    expect(store.active().filter(item => item.family === 'grammatical-gender'))
      .toEqual([expect.objectContaining({ descriptor: 'masculine-russian' })])
    expect(store.observeExplicit({
      text: 'Не отвечай в мужском роде', sessionId: 's2', evidenceId: 'gender-negative',
    })).toBe(1)
    expect(store.active().filter(item => item.family === 'grammatical-gender'))
      .toEqual([expect.objectContaining({ descriptor: 'feminine-russian' })])
  })

  it('persists, rolls back and forgets grammatical gender independently', () => {
    const p = persistence()
    const clock = (() => {
      let tick = 0
      return () => `2026-08-28T12:10:0${tick++}.000Z`
    })()
    const first = makeCommunicationPreferenceStore({ scope: SCOPE, persistence: p.port, nowIso: clock })
    first.observeExplicit({
      text: 'Пиши живее', sessionId: 's1', evidenceId: 'tone-one',
    })
    first.observeExplicit({
      text: 'Отвечай в женском роде', sessionId: 's1', evidenceId: 'gender-one',
    })
    first.observeExplicit({
      text: 'Отвечай в мужском роде', sessionId: 's2', evidenceId: 'gender-two',
    })

    const restarted = makeCommunicationPreferenceStore({ scope: SCOPE, persistence: p.port })
    expect(restarted.overlay()).toContain('используй мужской род')
    expect(restarted.overlay()).toContain('живым естественным русским')
    expect(restarted.rollback('grammatical-gender')).toBe(true)
    expect(restarted.overlay()).toContain('используй женский род')
    expect(restarted.active().find(item => item.family === 'tone')?.descriptor)
      .toBe('natural-russian')
    expect(restarted.forget('grammatical-gender')).toBe(true)
    expect(restarted.overlay()).not.toContain('род')
    expect(restarted.overlay()).toContain('живым естественным русским')
  })

  it('suppresses a corrupt grammatical-gender snapshot without disabling tone', () => {
    const seededPersistence = persistence()
    const seeded = makeCommunicationPreferenceStore({
      scope: SCOPE,
      persistence: seededPersistence.port,
    })
    seeded.observeExplicit({ text: 'Пиши живее', sessionId: 's1', evidenceId: 'tone' })
    const corrupt = persistence({
      'grammatical-gender': { invalid: true },
      tone: seededPersistence.port.load('tone'),
    })

    const restarted = makeCommunicationPreferenceStore({ scope: SCOPE, persistence: corrupt.port })
    expect(restarted.healthyFamilies()['grammatical-gender']).toBe(false)
    expect(restarted.overlay()).toContain('живым естественным русским')
    expect(restarted.overlay()).not.toContain('используй мужской род')
  })

  it('preserves the active revision on a failed update and rolls back one family only', () => {
    const p = persistence()
    const store = makeCommunicationPreferenceStore({
      scope: SCOPE,
      persistence: p.port,
      nowIso: (() => {
        let tick = 0
        return () => `2026-08-28T12:00:0${tick++}.000Z`
      })(),
    })
    store.observeExplicit({ text: 'Говори короче', sessionId: 's1', evidenceId: 'one' })
    store.observeExplicit({ text: 'Пиши живее', sessionId: 's1', evidenceId: 'tone' })
    p.fail('verbosity')
    expect(() => store.observeExplicit({
      text: 'Отвечай подробно', sessionId: 's2', evidenceId: 'two',
    })).toThrow('injected save failure')
    expect(store.active().find(item => item.family === 'verbosity')?.descriptor).toBe('concise')
    p.fail(null)
    store.observeExplicit({ text: 'Отвечай подробно', sessionId: 's2', evidenceId: 'two' })
    expect(store.active().find(item => item.family === 'verbosity')?.descriptor).toBe('detailed')
    expect(store.rollback('verbosity')).toBe(true)
    expect(store.active().find(item => item.family === 'verbosity')?.descriptor).toBe('concise')
    expect(store.active().find(item => item.family === 'tone')?.descriptor).toBe('natural-russian')
  })

  it('suppresses only a corrupt family and forget removes its active overlay first', () => {
    const valid = persistence()
    const seeded = makeCommunicationPreferenceStore({ scope: SCOPE, persistence: valid.port })
    seeded.observeExplicit({ text: 'Говори короче', sessionId: 's1', evidenceId: 'one' })
    seeded.observeExplicit({ text: 'Пиши живее', sessionId: 's1', evidenceId: 'two' })
    const corrupt = persistence({
      verbosity: { invalid: true },
      tone: valid.port.load('tone'),
    })
    const restarted = makeCommunicationPreferenceStore({ scope: SCOPE, persistence: corrupt.port })

    expect(restarted.healthyFamilies()['verbosity']).toBe(false)
    expect(restarted.overlay()).not.toContain('Отвечай кратко')
    expect(restarted.overlay()).toContain('живым естественным русским')
    expect(restarted.forget('tone')).toBe(true)
    expect(restarted.overlay()).toBe('')
  })
})
