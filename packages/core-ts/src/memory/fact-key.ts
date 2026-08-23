import { createHash } from 'node:crypto'

const STOPWORDS = new Set([
  'i', 'my', 'me', 'a', 'an', 'the', 'is', 'are', 'was', 'were', 'in', 'on',
  'at', 'of', 'to', 'and', 'or', 'where', 'that', 'this', 'it', 'be', 'am',
  'я', 'мы', 'мой', 'моя', 'моё', 'мои', 'это', 'в', 'во', 'на', 'и', 'или',
  'над', 'по', 'с', 'со', 'из', 'к', 'у', 'о', 'об', 'для',
])

const CANON: Readonly<Record<string, string>> = Object.freeze({
  live: 'reside', lives: 'reside', living: 'reside', home: 'reside',
  reside: 'reside', resides: 'reside', residence: 'reside',
  job: 'role', position: 'role', role: 'role',
})

export interface DeterministicMemoryFactKey {
  factKey: string
  keyTokens: string[]
  legacyFactKey: string
  legacyKeyTokens: string[]
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalTokens(text: string): string[] {
  const tokens = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(token => /[\p{L}\p{N}]/u.test(token) && !STOPWORDS.has(token))
    .map(token => CANON[token] ?? token)
  return [...new Set(tokens)].sort()
}

function legacyTokens(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 0 && !STOPWORDS.has(token))
    .map(token => CANON[token] ?? token)
  return [...new Set(tokens)].sort()
}

/**
 * Code-owned equivalence key shared by legacy and protected memory boundaries.
 * The legacy projection remains available only for pre-Unicode forget entries.
 */
export function deriveDeterministicMemoryFactKey(text: string): DeterministicMemoryFactKey {
  const keyTokens = canonicalTokens(text)
  const legacyKeyTokens = legacyTokens(text)
  return {
    factKey: sha256(keyTokens.join('|')),
    keyTokens,
    legacyFactKey: sha256(legacyKeyTokens.join('|')),
    legacyKeyTokens,
  }
}
