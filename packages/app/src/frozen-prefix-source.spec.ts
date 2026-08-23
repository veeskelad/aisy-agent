import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MEMORY_PROJECTION_LIMIT_BYTES } from '@aisy/core'

import { FrozenPrefixError, makeFrozenPrefixSource } from './frozen-prefix-source.js'

const roots: string[] = []
const FILES = ['constitution.md', 'SOUL.md', 'USER.md', 'MEMORY.md'] as const

function root(): string {
  const created = mkdtempSync(join(tmpdir(), 'aisy-prefix-'))
  roots.push(created)
  return created
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('frozen prefix source (ADR-0074 §1)', () => {
  it('concatenates present files in the code-owned order, not on-disk order', () => {
    const dir = root()
    // Written in reverse so an accidental readdir-based implementation would fail.
    writeFileSync(join(dir, 'MEMORY.md'), 'facts\n')
    writeFileSync(join(dir, 'constitution.md'), 'rules\n')

    const { bytes, sha256 } = makeFrozenPrefixSource({ memoryRoot: dir, files: FILES }).read()

    expect(bytes.toString('utf8')).toBe('rules\nfacts\n')
    expect(sha256).toBe(createHash('sha256').update('rules\nfacts\n').digest('hex'))
  })

  it('treats a missing layer as absent rather than an error', () => {
    const dir = root()
    writeFileSync(join(dir, 'SOUL.md'), 'soul\n')

    expect(makeFrozenPrefixSource({ memoryRoot: dir, files: FILES }).read().bytes.toString('utf8'))
      .toBe('soul\n')
  })

  it('produces a stable hash for identical content', () => {
    const dir = root()
    writeFileSync(join(dir, 'USER.md'), 'user\n')
    const source = makeFrozenPrefixSource({ memoryRoot: dir, files: FILES })

    expect(source.read().sha256).toBe(source.read().sha256)
  })

  it('returns an empty prefix when no layer is authored', () => {
    const { bytes, sha256 } = makeFrozenPrefixSource({ memoryRoot: root(), files: FILES }).read()

    expect(bytes.byteLength).toBe(0)
    expect(sha256).toBe(createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
  })

  it('fails closed on an oversized layer instead of truncating identity', () => {
    const dir = root()
    writeFileSync(join(dir, 'SOUL.md'), 'x'.repeat(4 * 1024 * 1024 + 1))

    expect(() => makeFrozenPrefixSource({ memoryRoot: dir, files: FILES }).read())
      .toThrowError(expect.objectContaining({ reason: 'prefix-too-large' }))
  })

  it('fails closed when the accumulated prefix exceeds the cap', () => {
    const dir = root()
    const half = 'y'.repeat(3 * 1024 * 1024)
    writeFileSync(join(dir, 'constitution.md'), half)
    writeFileSync(join(dir, 'SOUL.md'), half)

    expect(() => makeFrozenPrefixSource({ memoryRoot: dir, files: FILES }).read())
      .toThrowError(FrozenPrefixError)
  })
})

describe('fact projection thresholds inside the prefix (ADR-0078)', () => {
  const bigProjection = () =>
    ['# Memory index', '', ...Array.from({ length: 800 }, (_, i) => `- факт ${i} про оператора`)]
      .join('\n') + '\n'

  it('caps the projection so memory has a known ceiling in every turn', () => {
    const dir = root()
    writeFileSync(join(dir, 'MEMORY.md'), bigProjection())

    const prefix = makeFrozenPrefixSource({
      memoryRoot: dir,
      files: FILES,
      projectionFile: 'MEMORY.md',
    }).read()

    expect(prefix.bytes.byteLength).toBeLessThanOrEqual(MEMORY_PROJECTION_LIMIT_BYTES)
    expect(prefix.bytes.toString('utf8')).toContain('обрезана')
  })

  it('reports projection health so the operator learns to consolidate', () => {
    const dir = root()
    writeFileSync(join(dir, 'MEMORY.md'), bigProjection())
    const seen: Array<{ level: string; truncated: boolean }> = []

    makeFrozenPrefixSource({
      memoryRoot: dir,
      files: FILES,
      projectionFile: 'MEMORY.md',
      onProjectionHealth: (health) => seen.push({ level: health.level, truncated: health.truncated }),
    }).read()

    expect(seen).toEqual([{ level: 'over', truncated: true }])
  })

  it('leaves a projection within the limit byte-identical', () => {
    const dir = root()
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n\n- один факт\n')

    const withCap = makeFrozenPrefixSource({
      memoryRoot: dir, files: FILES, projectionFile: 'MEMORY.md',
    }).read()
    const without = makeFrozenPrefixSource({ memoryRoot: dir, files: FILES }).read()

    expect(withCap.sha256).toBe(without.sha256)
  })

  it('keeps the prefix when the health observer throws', () => {
    const dir = root()
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n')

    expect(() => makeFrozenPrefixSource({
      memoryRoot: dir,
      files: FILES,
      projectionFile: 'MEMORY.md',
      onProjectionHealth: () => { throw new Error('journal is down') },
    }).read()).not.toThrow()
  })
})
