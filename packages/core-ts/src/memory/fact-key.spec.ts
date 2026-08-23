import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { deriveDeterministicMemoryFactKey } from './fact-key.js'

describe('deterministic memory fact key', () => {
  it('normalizes Unicode, stopwords, duplicates and relation synonyms deterministically', () => {
    const first = deriveDeterministicMemoryFactKey('Мой HOME — Berlin, berlin!')
    const second = deriveDeterministicMemoryFactKey('Berlin residence')

    expect(first.keyTokens).toEqual(['berlin', 'reside'])
    expect(second.keyTokens).toEqual(first.keyTokens)
    expect(first.factKey).toBe(second.factKey)
    expect(first.factKey).toBe(
      createHash('sha256').update('berlin|reside').digest('hex'),
    )
  })

  it('retains the exact pre-Unicode compatibility projection', () => {
    const result = deriveDeterministicMemoryFactKey('Секрет Berlin')

    expect(result.keyTokens).toEqual(['berlin', 'секрет'])
    expect(result.legacyKeyTokens).toEqual(['berlin'])
    expect(result.legacyFactKey).toBe(
      createHash('sha256').update('berlin').digest('hex'),
    )
  })
})
