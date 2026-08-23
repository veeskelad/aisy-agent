import { describe, expect, it } from 'vitest'

import {
  DOCUMENT_MAX_BYTES,
  MAX_RETRIES,
  MESSAGE_LIMIT,
  SPLIT_LIMIT,
  VOICE_PREVIEW_CHARS,
  acceptDocument,
  retryPlan,
  splitByParagraph,
  transcriptPreview,
} from './ux-limits.js'

describe('splitting a long reply', () => {
  it('leaves a short reply as one message', () => {
    expect(splitByParagraph('короткий ответ')).toEqual(['короткий ответ'])
    expect(splitByParagraph('')).toEqual([])
  })

  it('never produces a part above the limit', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Абзац ${i}. ${'слово '.repeat(60)}`).join('\n\n')

    for (const part of splitByParagraph(text)) {
      expect(part.length).toBeLessThanOrEqual(SPLIT_LIMIT)
    }
  })

  it('splits on paragraph boundaries when it can', () => {
    const paragraph = 'п'.repeat(2_000)
    const parts = splitByParagraph(`${paragraph}\n\n${paragraph}`)

    expect(parts).toEqual([paragraph, paragraph])
  })

  it('falls back to lines, then to a hard cut, without losing a character', () => {
    const line = 'с'.repeat(SPLIT_LIMIT + 500)
    const parts = splitByParagraph(`начало\n${line}`)

    expect(parts.join('').replace(/\n/g, '')).toContain('начало')
    expect(parts.join('').length).toBeGreaterThanOrEqual(line.length)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(SPLIT_LIMIT)
  })

  it('stays under what Telegram itself accepts', () => {
    expect(SPLIT_LIMIT).toBeLessThan(MESSAGE_LIMIT)
  })
})

describe('retry policy', () => {
  it('never retries a rate limit — that is what turns 429 into a ban', () => {
    expect(retryPlan({ statusCode: 429, attempt: 0 })).toEqual({
      retry: false,
      reason: 'rate-limited',
    })
  })

  it('retries a server error a bounded number of times', () => {
    expect(retryPlan({ statusCode: 500, attempt: 0 })).toMatchObject({ retry: true })
    expect(retryPlan({ statusCode: 500, attempt: MAX_RETRIES }))
      .toEqual({ retry: false, reason: 'permanent' })
  })

  it('backs off further on the second attempt', () => {
    const first = retryPlan({ statusCode: 503, attempt: 0 })
    const second = retryPlan({ statusCode: 503, attempt: 1 })

    expect(first.retry && second.retry).toBe(true)
    if (first.retry && second.retry) expect(second.afterMs).toBeGreaterThan(first.afterMs)
  })

  it('does not retry a request that was simply wrong', () => {
    expect(retryPlan({ statusCode: 400, attempt: 0 })).toEqual({ retry: false, reason: 'permanent' })
    expect(retryPlan({ statusCode: 403, attempt: 0 })).toEqual({ retry: false, reason: 'permanent' })
  })

  it('treats a missing status as a network hiccup worth one more try', () => {
    expect(retryPlan({ attempt: 0 })).toMatchObject({ retry: true })
  })
})

describe('document limits', () => {
  it('accepts what the operator normally sends', () => {
    expect(acceptDocument({ filename: 'отчёт.MD', sizeBytes: 1024 })).toBe(true)
    expect(acceptDocument({ filename: 'схема.png', sizeBytes: 1024 })).toBe(true)
  })

  it('refuses an extension that is not on the list', () => {
    expect(acceptDocument({ filename: 'payload.exe', sizeBytes: 10 }))
      .toBe('extension-not-allowed')
    // A permitted extension inside the name is not a permitted extension.
    expect(acceptDocument({ filename: 'notes.md.exe', sizeBytes: 10 }))
      .toBe('extension-not-allowed')
  })

  it('refuses an oversized or unmeasurable file', () => {
    expect(acceptDocument({ filename: 'dump.log', sizeBytes: DOCUMENT_MAX_BYTES + 1 }))
      .toBe('too-large')
    expect(acceptDocument({ filename: 'dump.log', sizeBytes: Number.NaN })).toBe('too-large')
  })
})

describe('voice transcript preview', () => {
  it('shows a short transcript in full', () => {
    expect(transcriptPreview('  привет,   как дела  ')).toBe('привет, как дела')
  })

  it('marks a cut transcript explicitly', () => {
    const preview = transcriptPreview('я'.repeat(VOICE_PREVIEW_CHARS + 100))

    expect(preview).toContain('обрезана')
    expect(preview.startsWith('я'.repeat(VOICE_PREVIEW_CHARS))).toBe(true)
  })
})
