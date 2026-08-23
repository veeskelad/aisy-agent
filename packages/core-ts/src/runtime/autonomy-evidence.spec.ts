import { describe, expect, it } from 'vitest'

import {
  makeAutonomyLedger,
  NORMATIVE_THRESHOLDS,
  workflowKey,
  type DemonstrationInput,
  type EvidencePersistence,
} from './autonomy-evidence.js'

function memoryPersistence(initial: string[] = []): EvidencePersistence & { lines: string[] } {
  const lines = [...initial]
  return {
    lines,
    load: () => [...lines],
    append: (line) => { lines.push(line) },
    rewrite: (next) => { lines.length = 0; lines.push(...next) },
  }
}

const KEY = workflowKey([{ tool: 'fetch_url', argClass: 'https-url', resourceMask: 'example.com' }])

function demo(overrides: Partial<DemonstrationInput> = {}): DemonstrationInput {
  return {
    workflowKey: KEY,
    scope: { projectId: 'p1', tool: 'fetch_url', resourcePattern: 'example.com' },
    tier: 2,
    binding: { operatorId: 'op', projectId: 'p1', sessionId: 's1' },
    evidence: { transcriptRef: 'transcript-1' },
    outcome: 'confirmed',
    provenance: 'operator',
    ...overrides,
  }
}

/** Ledger, дозревший ровно до порогов: 5 подтверждений, 3 сессии, 8 дней, 3 shadow. */
function ripeLedger(persistence = memoryPersistence()) {
  let day = 0
  const ledger = makeAutonomyLedger({
    persistence,
    nowIso: () => new Date(Date.UTC(2026, 7, 1 + day)).toISOString(),
  })
  const sessions = ['s1', 's2', 's3', 's1', 's2']
  for (let i = 0; i < 5; i += 1) {
    day = i * 2 // 0..8 дней — окно 8 ≥ 7
    ledger.observe(demo({ binding: { operatorId: 'op', projectId: 'p1', sessionId: sessions[i]! } }))
  }
  for (let i = 0; i < 3; i += 1) {
    ledger.shadowResult({ workflowKey: KEY, projectId: 'p1', matched: true })
  }
  return { ledger, persistence }
}

describe('наблюдение (AC-24-1)', () => {
  it('записывает только operator-provenance', () => {
    const p = memoryPersistence()
    const ledger = makeAutonomyLedger({ persistence: p, nowIso: () => '2026-08-12T10:00:00Z' })

    const smuggled = { ...demo(), provenance: 'untrusted' as unknown as 'operator' }
    expect(ledger.observe(smuggled)).toBe('refused-provenance')
    expect(p.lines).toHaveLength(0)

    expect(ledger.observe(demo())).toBe('recorded')
    expect(p.lines).toHaveLength(1)
  })

  it('отвергает tier вне 1..2 — tier 3 не наблюдается вовсе', () => {
    const ledger = makeAutonomyLedger({
      persistence: memoryPersistence(), nowIso: () => '2026-08-12T10:00:00Z',
    })

    expect(ledger.observe({ ...demo(), tier: 3 as unknown as 2 })).toBe('refused-tier')
  })
})

describe('зрелость кандидата (AC-24-2, AC-24-3, AC-24-4)', () => {
  it('дозревший по всем порогам кандидат предлагается', () => {
    const { ledger } = ripeLedger()

    const ripe = ledger.ripeCandidates()
    expect(ripe).toHaveLength(1)
    expect(ripe[0]).toMatchObject({
      workflowKey: KEY,
      tier: 2,
      stats: { confirmed: 5, distinctSessions: 3, shadowStreak: 3 },
      ripe: true,
    })
  })

  it('пять подтверждений в одной сессии не зреют: одна привычка одного вечера', () => {
    // distinctSessions = 1 < 3 при выполненных остальных порогах shadow.
    const ledger = makeAutonomyLedger({
      persistence: memoryPersistence(), nowIso: () => '2026-08-12T10:00:00Z',
    })
    for (let i = 0; i < 5; i += 1) ledger.observe(demo())
    for (let i = 0; i < 3; i += 1) {
      ledger.shadowResult({ workflowKey: KEY, projectId: 'p1', matched: true })
    }

    expect(ledger.ripeCandidates()).toHaveLength(0)
    expect(ledger.candidates()[0]!.stats.distinctSessions).toBe(1)
  })

  it('окно меньше недели не зреет: пять подтверждений за вечер — привычка вечера', () => {
    let minute = 0
    const ledger = makeAutonomyLedger({
      persistence: memoryPersistence(),
      nowIso: () => new Date(Date.UTC(2026, 7, 1, 20, minute)).toISOString(),
    })
    const sessions = ['s1', 's2', 's3', 's4', 's5']
    for (let i = 0; i < 5; i += 1) {
      minute = i * 10
      ledger.observe(demo({ binding: { operatorId: 'op', projectId: 'p1', sessionId: sessions[i]! } }))
    }
    for (let i = 0; i < 3; i += 1) {
      ledger.shadowResult({ workflowKey: KEY, projectId: 'p1', matched: true })
    }

    expect(ledger.ripeCandidates()).toHaveLength(0)
  })

  it('свежее исправление обнуляет зрелость (AC-24-3)', () => {
    const { ledger } = ripeLedger()
    ledger.observe(demo({ outcome: 'corrected' }))

    expect(ledger.ripeCandidates()).toHaveLength(0)
    expect(ledger.candidates()[0]!.stats.corrected).toBe(1)
  })

  it('shadow-расхождение рвёт серию (AC-24-4)', () => {
    const { ledger } = ripeLedger()
    ledger.shadowResult({ workflowKey: KEY, projectId: 'p1', matched: false })
    ledger.shadowResult({ workflowKey: KEY, projectId: 'p1', matched: true })

    // После промаха серия 1 < 3 — заново.
    expect(ledger.ripeCandidates()).toHaveLength(0)
    expect(ledger.candidates()[0]!.stats.shadowStreak).toBe(1)
  })

  it('пороги можно только ужесточить, ослабить нельзя', () => {
    const p = memoryPersistence()
    const { persistence } = ripeLedger(p)
    const lenient = makeAutonomyLedger({
      persistence,
      nowIso: () => '2026-08-12T10:00:00Z',
      thresholds: { minConfirmed: 1, minDistinctSessions: 1, minWindowDays: 0, minShadowMatches: 0 },
    })
    const strict = makeAutonomyLedger({
      persistence,
      nowIso: () => '2026-08-12T10:00:00Z',
      thresholds: { minConfirmed: 20 },
    })

    // «Ослабленные» пороги молча поднялись до нормативных — зрелый остался зрелым…
    expect(lenient.ripeCandidates()).toHaveLength(1)
    expect(NORMATIVE_THRESHOLDS.minConfirmed).toBe(5)
    // …а ужесточение действует.
    expect(strict.ripeCandidates()).toHaveLength(0)
  })
})

describe('демоушен (AC-24-8, частично)', () => {
  it('сжигает и демонстрации, и shadow-серию: доверие набирается заново', () => {
    const { ledger } = ripeLedger()
    ledger.demote(KEY, 'operator-correction')

    expect(ledger.ripeCandidates()).toHaveLength(0)
    // Кандидат остаётся видимым — экрану нужно что показывать, — но весь счёт
    // до демоушена сгорел.
    expect(ledger.candidates()[0]!.stats).toMatchObject({
      confirmed: 0, distinctSessions: 0, shadowStreak: 0,
    })
  })

  it('после демоушена процесс может дозреть заново', () => {
    const p = memoryPersistence()
    const first = ripeLedger(p)
    first.ledger.demote(KEY, 'failed-postcondition')

    // Новый заход: снова 5 подтверждений в 3 сессиях за 8 дней + 3 shadow.
    let day = 20
    const ledger = makeAutonomyLedger({
      persistence: p,
      nowIso: () => new Date(Date.UTC(2026, 7, 1 + day)).toISOString(),
    })
    const sessions = ['s7', 's8', 's9', 's7', 's8']
    for (let i = 0; i < 5; i += 1) {
      day = 20 + i * 2
      ledger.observe(demo({ binding: { operatorId: 'op', projectId: 'p1', sessionId: sessions[i]! } }))
    }
    for (let i = 0; i < 3; i += 1) {
      ledger.shadowResult({ workflowKey: KEY, projectId: 'p1', matched: true })
    }

    expect(ledger.ripeCandidates()).toHaveLength(1)
  })
})

describe('забывание (AC-24-10)', () => {
  it('физически удаляет записи проекта, и id не находится в журнале', () => {
    const { ledger, persistence } = ripeLedger()
    ledger.observe(demo({
      workflowKey: 'other-key',
      scope: { projectId: 'p2', tool: 'bash', resourcePattern: 'repo' },
      binding: { operatorId: 'op', projectId: 'p2', sessionId: 's9' },
    }))

    const result = ledger.forget({ projectId: 'p1' })

    expect(result.removed).toBeGreaterThan(0)
    expect(persistence.lines.join('\n')).not.toContain('"p1"')
    expect(persistence.lines.join('\n')).toContain('"p2"')
    expect(ledger.ripeCandidates()).toHaveLength(0)
  })

  it('повторный вызов идемпотентен', () => {
    const { ledger } = ripeLedger()
    ledger.forget({ projectId: 'p1' })

    expect(ledger.forget({ projectId: 'p1' })).toEqual({ removed: 0 })
  })

  it('пустой селектор не удаляет ничего — забывание всегда адресное', () => {
    const { ledger, persistence } = ripeLedger()
    const before = persistence.lines.length

    expect(ledger.forget({})).toEqual({ removed: 0 })
    expect(persistence.lines).toHaveLength(before)
  })

  it('забывание сессии оставляет чужие сессии на месте', () => {
    const { ledger } = ripeLedger()

    ledger.forget({ sessionId: 's1' })

    // Двух демонстраций s1 больше нет; остальное живо, но незрело.
    const stats = ledger.candidates()[0]!.stats
    expect(stats.confirmed).toBe(3)
    expect(ledger.ripeCandidates()).toHaveLength(0)
  })
})

describe('повреждённый журнал (AC-24-11)', () => {
  it('одна битая строка гасит кандидатов и наблюдение, но не бросает', () => {
    const p = memoryPersistence(['{"kind":"demonstration"', '{нечитаемое}'])
    const events: string[] = []
    const ledger = makeAutonomyLedger({
      persistence: p,
      nowIso: () => '2026-08-12T10:00:00Z',
      emit: (event) => { events.push(event) },
    })

    expect(ledger.corrupted()).toBe(true)
    expect(ledger.ripeCandidates()).toEqual([])
    expect(ledger.observe(demo())).toBe('refused-corrupt')
    expect(p.lines).toHaveLength(2) // в повреждённый файл не дописываем
    expect(events).toContain('autonomy.store_corrupt')
  })

  it('недоступный store ведёт себя как повреждённый', () => {
    const ledger = makeAutonomyLedger({
      persistence: {
        load: () => { throw new Error('disk') },
        append: () => {},
        rewrite: () => {},
      },
      nowIso: () => '2026-08-12T10:00:00Z',
    })

    expect(ledger.corrupted()).toBe(true)
    expect(ledger.ripeCandidates()).toEqual([])
  })
})

describe('workflowKey', () => {
  it('детерминирован и различает процессы', () => {
    const a = workflowKey([{ tool: 'bash', argClass: 'git-commit', resourceMask: 'repo-a' }])
    const b = workflowKey([{ tool: 'bash', argClass: 'git-commit', resourceMask: 'repo-b' }])

    expect(a).toBe(workflowKey([{ tool: 'bash', argClass: 'git-commit', resourceMask: 'repo-a' }]))
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })
})
