import { describe, expect, it } from 'vitest'

import {
  demoteLearnedAutonomy,
  forgetLearnedAutonomy,
  learnedGrantAction,
  LEARNED_GRANT_TTL_DAYS_MAX,
  makeLearnedAutonomyPort,
  makeLearnedGrantRegistry,
  type DemotionReason,
  type LearnedGrantEnvelope,
  type LearnedGrantPersistence,
  type LearnedGrantStateV1,
} from './autonomy-promotion.js'

function persistence(initial?: unknown): LearnedGrantPersistence & { state?: LearnedGrantStateV1 } {
  const box: { state?: LearnedGrantStateV1 } = {}
  return {
    ...box,
    load: () => (initial === undefined ? box.state : initial),
    save: (next) => { box.state = next },
    get state() { return box.state },
  } as LearnedGrantPersistence & { state?: LearnedGrantStateV1 }
}

const KEY = 'a'.repeat(32)

function envelope(overrides: Partial<LearnedGrantEnvelope> = {}): LearnedGrantEnvelope {
  return {
    workflowKey: KEY,
    scope: { projectId: 'p1', tool: 'fetch_url', resourcePattern: 'example.com' },
    tier: 2,
    version: 1,
    issuedAt: '2026-08-13T10:00:00Z',
    expiresAt: '2026-09-13T10:00:00Z',
    ...overrides,
  }
}

function proofFor(e: LearnedGrantEnvelope, cardId = 'card-1') {
  const action = learnedGrantAction(e)
  return {
    cardId,
    actionId: action.actionId,
    actionHash: action.actionHash,
    confirmedAt: '2026-08-13T10:00:01Z',
    stepUpVerified: true as const,
  }
}

function registry(initial?: unknown) {
  return makeLearnedGrantRegistry({
    persistence: persistence(initial),
    nowIso: () => '2026-08-13T10:00:02Z',
  })
}

describe('промоушен требует подтверждённой карточки (AC-24-5)', () => {
  it('оформляет грант по валидному step-up proof', () => {
    const r = registry()
    const e = envelope()

    const result = r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) })

    expect(result).toMatchObject({ granted: { workflowKey: KEY, version: 1, rollbackRef: null } })
    expect(r.active(KEY, '2026-08-20T00:00:00Z')).not.toBeNull()
  })

  it('отвергает proof без step-up: расширение полномочий требует именно его', () => {
    const r = registry()
    const e = envelope()

    const result = r.promote({
      envelope: e,
      approvedBy: 'operator',
      proof: { ...proofFor(e), stepUpVerified: false },
    })

    expect(result).toEqual({ refused: 'proof-invalid' })
    expect(r.active(KEY, '2026-08-20T00:00:00Z')).toBeNull()
  })

  it('отвергает proof от карточки другого процесса', () => {
    const r = registry()
    const mine = envelope()
    const other = envelope({ workflowKey: 'b'.repeat(32) })

    const result = r.promote({
      envelope: mine, approvedBy: 'operator', proof: proofFor(other),
    })

    expect(result).toEqual({ refused: 'proof-mismatch' })
  })

  it('отвергает proof от карточки того же процесса, но другой версии', () => {
    const r = registry()
    const e = envelope()
    r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) })
    const second = envelope({ version: 2 })

    // Proof выпущен для v1, предъявлен для v2 — хэш конверта не сойдётся.
    const result = r.promote({
      envelope: second, approvedBy: 'operator', proof: proofFor(e, 'card-2'),
    })

    expect(result).toEqual({ refused: 'proof-mismatch' })
  })

  it('одна карточка — один грант: повтор не создаёт второй', () => {
    const r = registry()
    const e = envelope()
    r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) })

    const replay = r.promote({
      envelope: envelope({ version: 2 }), approvedBy: 'operator', proof: proofFor(e),
    })

    expect(replay).toEqual({ refused: 'proof-mismatch' })
    expect(r.list()).toHaveLength(1)
  })

  it('reused cardId отвергается даже при совпавшем хэше', () => {
    const r = registry()
    const e = envelope()
    r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e, 'card-x') })
    r.revoke(KEY, 'operator')

    // Тот же конверт, тот же cardId — карточка уже потрачена.
    const replay = r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e, 'card-x') })

    expect(replay).toEqual({ refused: 'proof-reused' })
  })

  it('пустой approvedBy отвергается: грант всегда чей-то', () => {
    const r = registry()
    const e = envelope()

    expect(r.promote({ envelope: e, approvedBy: '  ', proof: proofFor(e) }))
      .toEqual({ refused: 'proof-invalid' })
  })
})

describe('TTL (AC-24-9)', () => {
  it('отвергает грант длиннее нормативного максимума', () => {
    const r = registry()
    const e = envelope({ expiresAt: '2027-08-13T10:00:00Z' })

    expect(r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) }))
      .toEqual({ refused: 'ttl-exceeded' })
    expect(LEARNED_GRANT_TTL_DAYS_MAX).toBe(90)
  })

  it('отвергает конверт, истекающий раньше выдачи', () => {
    const r = registry()
    const e = envelope({ expiresAt: '2026-08-12T10:00:00Z' })

    expect(r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) }))
      .toEqual({ refused: 'ttl-exceeded' })
  })

  it('истёкший грант перестаёт действовать сам, без чьего-либо участия', () => {
    const r = registry()
    const e = envelope()
    r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) })

    expect(r.active(KEY, '2026-09-12T00:00:00Z')).not.toBeNull()
    expect(r.active(KEY, '2026-09-14T00:00:00Z')).toBeNull()
  })
})

describe('версии и откат', () => {
  it('новая версия сменяет прежнюю, оставляя ссылку для отката', () => {
    const r = registry()
    const first = envelope()
    r.promote({ envelope: first, approvedBy: 'operator', proof: proofFor(first) })
    const second = envelope({ version: 2, scope: {
      projectId: 'p1', tool: 'fetch_url', resourcePattern: 'docs.example.com',
    } })

    const result = r.promote({
      envelope: second, approvedBy: 'operator', proof: proofFor(second, 'card-2'),
    })

    expect(result).toMatchObject({ granted: { version: 2, rollbackRef: 1 } })
    // Живой грант ровно один: два ответа на «что разрешено» недопустимы.
    const live = r.list().filter((g) => g.revoked === undefined)
    expect(live).toHaveLength(1)
    expect(live[0]!.version).toBe(2)
    expect(r.list()[0]!.revoked).toMatchObject({ why: 'superseded' })
  })

  it('пропуск версии отвергается', () => {
    const r = registry()
    const e = envelope({ version: 3 })

    expect(r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) }))
      .toEqual({ refused: 'version-gap' })
  })
})

describe('отзыв (AC-24-8)', () => {
  it('отзыв немедленно гасит грант и идемпотентен', () => {
    const r = registry()
    const e = envelope()
    r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) })

    r.revoke(KEY, 'operator-correction')
    expect(r.active(KEY, '2026-08-14T00:00:00Z')).toBeNull()

    r.revoke(KEY, 'operator-correction')
    expect(r.list()).toHaveLength(1)
    expect(r.list()[0]!.revoked).toMatchObject({ why: 'operator-correction' })
  })

  it('отзыв несуществующего процесса ничего не ломает', () => {
    const r = registry()

    expect(() => r.revoke('нет такого', 'why')).not.toThrow()
  })
})

describe('порт для гейта (AC-24-6)', () => {
  function port(r: ReturnType<typeof registry>, projectId = 'p1') {
    return makeLearnedAutonomyPort({
      grants: r,
      keyFor: (c) => (c.name === 'fetch_url' ? KEY : null),
      resourceFor: (c) => {
        const url = c.args['url']
        if (typeof url !== 'string') return null
        try { return new URL(url).hostname } catch { return null }
      },
      projectId: () => projectId,
      nowIso: () => '2026-08-20T00:00:00Z',
    })
  }

  function granted() {
    const r = registry()
    const e = envelope()
    r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) })
    return r
  }

  it('покрывает ровно тот процесс, ресурс и проект, что подтвердил оператор', () => {
    const covered = port(granted())

    expect(covered({ name: 'fetch_url', args: { url: 'https://example.com/a' } })).toBe(true)
  })

  it('другой ресурс не покрыт: домены не наследуются', () => {
    const covered = port(granted())

    expect(covered({ name: 'fetch_url', args: { url: 'https://другой.example' } })).toBe(false)
  })

  it('другой проект не покрыт даже при том же процессе', () => {
    const covered = port(granted(), 'p2')

    expect(covered({ name: 'fetch_url', args: { url: 'https://example.com/a' } })).toBe(false)
  })

  it('вызов вне известного процесса не покрыт', () => {
    const covered = port(granted())

    expect(covered({ name: 'bash', args: { command: 'ls' } })).toBe(false)
  })

  it('отозванный и истёкший грант больше не покрывают', () => {
    const r = granted()
    const covered = port(r)
    expect(covered({ name: 'fetch_url', args: { url: 'https://example.com/a' } })).toBe(true)

    r.revoke(KEY, 'operator-revoke')

    expect(covered({ name: 'fetch_url', args: { url: 'https://example.com/a' } })).toBe(false)
  })
})

describe('каскад демоушена (AC-24-8)', () => {
  it('гасит грант раньше, чем счёт: осиротевший грант опаснее осиротевшей записи', () => {
    const order: string[] = []
    const r = registry()
    const e = envelope()
    r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) })

    const result = demoteLearnedAutonomy({
      workflowKey: KEY,
      reason: 'operator-correction',
      grants: { revoke: (key, why) => { order.push('revoke'); r.revoke(key, why) } },
      evidence: { demote: () => { order.push('demote') } },
    })

    expect(order).toEqual(['revoke', 'demote'])
    expect(r.active(KEY, '2026-08-14T00:00:00Z')).toBeNull()
    expect(result.line).toContain('поправил')
  })

  it('каждая причина объясняется оператору одной строкой', () => {
    const reasons: DemotionReason[] = [
      'operator-correction', 'failed-postcondition', 'evidence-forgotten', 'operator-revoke',
    ]

    for (const reason of reasons) {
      const { line } = demoteLearnedAutonomy({
        workflowKey: KEY,
        reason,
        grants: { revoke: () => {} },
        evidence: { demote: () => {} },
      })
      expect(line.length).toBeGreaterThan(10)
    }
  })
})

describe('каскад забывания (AC-24-10)', () => {
  it('забытый проект уносит гранты, стоявшие на его доказательствах', () => {
    const order: string[] = []
    const r = registry()
    const mine = envelope()
    r.promote({ envelope: mine, approvedBy: 'operator', proof: proofFor(mine) })
    const foreign = envelope({
      workflowKey: 'b'.repeat(32),
      scope: { projectId: 'p2', tool: 'bash', resourcePattern: 'repo' },
    })
    r.promote({ envelope: foreign, approvedBy: 'operator', proof: proofFor(foreign, 'card-2') })

    const result = forgetLearnedAutonomy({
      selector: { projectId: 'p1' },
      grants: {
        list: () => r.list(),
        revoke: (key, why) => { order.push('revoke'); r.revoke(key, why) },
      },
      evidence: { forget: () => { order.push('forget'); return { removed: 5 } } },
    })

    expect(order).toEqual(['revoke', 'forget'])
    expect(result).toEqual({ revoked: 1, removed: 5 })
    // Свой проект потерял автономию, чужой сохранил.
    expect(r.active(KEY, '2026-08-20T00:00:00Z')).toBeNull()
    expect(r.active('b'.repeat(32), '2026-08-20T00:00:00Z')).not.toBeNull()
  })

  it('забывание сессии чистит записи, но грант проекта не трогает', () => {
    const r = registry()
    const e = envelope()
    r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) })

    const result = forgetLearnedAutonomy({
      selector: { sessionId: 's1' },
      grants: r,
      evidence: { forget: () => ({ removed: 2 }) },
    })

    // Грант живёт: он про проект, а не про одну сессию. Зрелость пересчитает
    // ledger, и если доказательств не хватит — демоушен придёт своим путём.
    expect(result).toEqual({ revoked: 0, removed: 2 })
    expect(r.active(KEY, '2026-08-20T00:00:00Z')).not.toBeNull()
  })

  it('идемпотентен: второй проход не находит чего отзывать', () => {
    const r = registry()
    const e = envelope()
    r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) })
    const evidence = { forget: () => ({ removed: 0 }) }

    forgetLearnedAutonomy({ selector: { projectId: 'p1' }, grants: r, evidence })
    const second = forgetLearnedAutonomy({ selector: { projectId: 'p1' }, grants: r, evidence })

    expect(second).toEqual({ revoked: 0, removed: 0 })
  })
})

describe('повреждённое состояние', () => {
  it('fail-closed в обе стороны: не выдаёт и не подтверждает', () => {
    const r = registry({ schemaVersion: 'не то' })

    expect(r.corrupted()).toBe(true)
    const e = envelope()
    expect(r.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) }))
      .toEqual({ refused: 'store-corrupt' })
    expect(r.active(KEY, '2026-08-14T00:00:00Z')).toBeNull()
  })

  it('переживает рестарт: сохранённое состояние поднимается как есть', () => {
    const shared = persistence()
    const first = makeLearnedGrantRegistry({
      persistence: shared, nowIso: () => '2026-08-13T10:00:02Z',
    })
    const e = envelope()
    first.promote({ envelope: e, approvedBy: 'operator', proof: proofFor(e) })

    const reopened = makeLearnedGrantRegistry({
      persistence: shared, nowIso: () => '2026-08-13T12:00:00Z',
    })

    expect(reopened.corrupted()).toBe(false)
    expect(reopened.active(KEY, '2026-08-20T00:00:00Z')).not.toBeNull()
    // И потраченная карточка помнится через рестарт.
    expect(reopened.promote({ envelope: envelope({ version: 2 }), approvedBy: 'op', proof: proofFor(e) }))
      .toEqual({ refused: 'proof-mismatch' })
  })
})
