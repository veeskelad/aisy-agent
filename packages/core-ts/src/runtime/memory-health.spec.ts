import { describe, expect, it } from 'vitest'

import {
  FACT_DUPLICATE_PREFIX_CHARS,
  MEMORY_PROJECTION_LIMIT_BYTES,
  MEMORY_PROJECTION_WARN_BYTES,
  factDuplicatePrefix,
  findDuplicateFact,
  memorySelfCheck,
  projectionHealth,
  truncateProjection,
} from './memory-health.js'

const line = (n: number) => `- факт номер ${n} про рабочее окружение оператора`
const projection = (count: number) =>
  ['# Memory index', '', ...Array.from({ length: count }, (_, i) => line(i))].join('\n') + '\n'

describe('memory projection thresholds (ADR-0078)', () => {
  it('counts bytes rather than characters, so Cyrillic is not undercounted', () => {
    // 'память' is 6 characters but 12 bytes in UTF-8.
    expect(projectionHealth('память').bytes).toBe(12)
  })

  it('does not count the terminating newline as an extra line', () => {
    expect(projectionHealth('a\nb\n').lines).toBe(2)
    expect(projectionHealth('').lines).toBe(0)
  })

  it('warns before it truncates', () => {
    const warn = projectionHealth('x'.repeat(MEMORY_PROJECTION_WARN_BYTES + 1))
    expect(warn.level).toBe('warn')
    const over = projectionHealth('x'.repeat(MEMORY_PROJECTION_LIMIT_BYTES + 1))
    expect(over.level).toBe('over')
  })

  it('leaves a projection within the limit byte-for-byte untouched', () => {
    const content = projection(20)
    const result = truncateProjection(content)
    expect(result).toEqual({ content, truncated: false, droppedLines: 0 })
  })

  it('keeps a truncated projection under the hard limit, marker included', () => {
    const result = truncateProjection(projection(1000))

    expect(result.truncated).toBe(true)
    expect(result.droppedLines).toBeGreaterThan(0)
    expect(new TextEncoder().encode(result.content).length)
      .toBeLessThanOrEqual(MEMORY_PROJECTION_LIMIT_BYTES)
    // The operator must be able to tell that facts are missing from the view.
    expect(result.content).toContain('обрезана')
  })

  it('truncates deterministically, so the frozen prefix keeps its KV cache', () => {
    const a = truncateProjection(projection(1000))
    const b = truncateProjection(projection(1000))
    expect(a.content).toBe(b.content)
  })

  it('cuts at a line boundary, never mid-fact', () => {
    const result = truncateProjection(projection(1000))
    const kept = result.content.split('\n— проекция обрезана')[0]?.split('\n') ?? []
    for (const kept_line of kept) {
      if (kept_line.startsWith('- ')) expect(kept_line).toMatch(/окружение оператора$/)
    }
  })
})

describe('fact deduplication by normalized prefix (ADR-0078)', () => {
  const facts = [
    { id: 'f1', text: 'Оператор работает в часовом поясе Europe/Moscow' },
    { id: 'f2', text: 'Основной язык общения — русский' },
  ]

  it('treats case and spacing as noise', () => {
    const hit = findDuplicateFact('  оператор   РАБОТАЕТ в часовом поясе Europe/Moscow  ', facts)
    expect(hit?.id).toBe('f1')
  })

  it('recognises the same statement with a clarification appended', () => {
    const hit = findDuplicateFact(
      'Оператор работает в часовом поясе Europe/Moscow, но летом бывает в Тбилиси',
      facts,
    )
    expect(hit?.id).toBe('f1')
  })

  it('does not merge facts that differ from the start', () => {
    expect(findDuplicateFact('Оператор предпочитает короткие ответы', facts)).toBeNull()
  })

  it('never resolves a blank candidate to some existing fact', () => {
    expect(findDuplicateFact('   ', [...facts, { id: 'f3', text: '' }])).toBeNull()
  })

  it('does not merge two short statements that merely start alike', () => {
    const short = [{ id: 's1', text: 'Да, можно' }]
    expect(findDuplicateFact('Да, конечно', short)).toBeNull()
  })

  it('compares exactly the documented prefix length', () => {
    const base = 'ц'.repeat(FACT_DUPLICATE_PREFIX_CHARS)
    expect(factDuplicatePrefix(base + 'хвост')).toBe(base)
  })
})

describe('per-turn memory self-check (ADR-0078)', () => {
  const healthy = projectionHealth(projection(5))

  it('stays silent when everything is in order', () => {
    expect(memorySelfCheck({
      projection: healthy,
      sessionMessages: 3,
      operatorProfileBytes: 512,
    })).toEqual([])
  })

  it('reports an over-limit projection as facts missing from the view', () => {
    const notices = memorySelfCheck({
      projection: projectionHealth('x'.repeat(MEMORY_PROJECTION_LIMIT_BYTES + 1)),
      sessionMessages: 1,
      operatorProfileBytes: 10,
    })
    expect(notices.map((n) => n.code)).toEqual(['projection-over'])
    expect(notices[0]?.detail).toContain('не видна')
  })

  it('warns and reminds independently', () => {
    const notices = memorySelfCheck({
      projection: projectionHealth('x'.repeat(MEMORY_PROJECTION_WARN_BYTES + 1)),
      sessionMessages: 40,
      operatorProfileBytes: 0,
    })
    expect(notices.map((n) => n.code)).toEqual([
      'projection-warn',
      'session-consolidate',
      'operator-profile-empty',
    ])
  })

  it('never reports both projection notices at once', () => {
    const notices = memorySelfCheck({
      projection: projectionHealth('x'.repeat(MEMORY_PROJECTION_LIMIT_BYTES + 1)),
      sessionMessages: 1,
      operatorProfileBytes: 1,
    })
    expect(notices.filter((n) => n.code.startsWith('projection-'))).toHaveLength(1)
  })
})
