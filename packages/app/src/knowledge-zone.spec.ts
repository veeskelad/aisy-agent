import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KnowledgeZoneError, makeKnowledgeZone } from './knowledge-zone.js'

const roots: string[] = []

function zoneRoot(): string {
  const created = mkdtempSync(join(tmpdir(), 'aisy-knowledge-'))
  roots.push(created)
  return created
}

function article(root: string, relativePath: string, content: string): void {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(absolute, content, { mode: 0o600 })
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('knowledge zone (ADR-0075)', () => {
  it('builds a catalogue of titles without a single byte of article bodies', () => {
    const root = zoneRoot()
    article(root, 'architecture/microservices.md', '# Микросервисы\n\nСекретное тело статьи.\n')
    article(root, 'deployment/docker.md', '# Docker\n\nЕщё тело.\n')

    const catalogue = makeKnowledgeZone({ root }).catalogue()

    expect(catalogue.markdown).toContain('## architecture')
    expect(catalogue.markdown).toContain('[Микросервисы](architecture/microservices.md)')
    expect(catalogue.markdown).toContain('[Docker](deployment/docker.md)')
    expect(catalogue.markdown).not.toContain('Секретное тело')
    expect(catalogue.markdown).not.toContain('Ещё тело')
  })

  it('is deterministic: identical trees give an identical catalogue hash', () => {
    const first = zoneRoot()
    const second = zoneRoot()
    for (const root of [first, second]) {
      article(root, 'b/second.md', '# Второй\n')
      article(root, 'a/first.md', '# Первый\n')
    }

    expect(makeKnowledgeZone({ root: first }).catalogue().sha256)
      .toBe(makeKnowledgeZone({ root: second }).catalogue().sha256)
  })

  it('falls back to the file name when an article has no heading', () => {
    const root = zoneRoot()
    article(root, 'notes/raw-dump.md', 'просто текст без заголовка\n')

    expect(makeKnowledgeZone({ root }).catalogue().entries[0]).toEqual({
      path: 'notes/raw-dump.md',
      topics: ['notes'],
      title: 'raw-dump',
    })
  })

  it('never treats the generated index as an article', () => {
    const root = zoneRoot()
    article(root, '_index.md', '# Knowledge\n- подделанная запись\n')
    article(root, 'real.md', '# Настоящая\n')

    const entries = makeKnowledgeZone({ root }).catalogue().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.path).toBe('real.md')
  })

  it('reads an article by its catalogue path', () => {
    const root = zoneRoot()
    article(root, 'architecture/db.md', '# База\n\nПочему Postgres.\n')

    expect(makeKnowledgeZone({ root }).readArticle('architecture/db.md'))
      .toContain('Почему Postgres')
  })

  it('refuses to read outside the zone', () => {
    const root = zoneRoot()
    const outside = zoneRoot()
    writeFileSync(join(outside, 'secret.md'), '# Секрет\n', { mode: 0o600 })
    const zone = makeKnowledgeZone({ root })

    expect(() => zone.readArticle('../secret.md'))
      .toThrowError(expect.objectContaining({ reason: 'outside-zone' }))
    expect(() => zone.readArticle(join(outside, 'secret.md')))
      .toThrowError(KnowledgeZoneError)
  })

  it('does not follow a symlink that points out of the zone', () => {
    const root = zoneRoot()
    const outside = zoneRoot()
    const secret = join(outside, 'secret.md')
    writeFileSync(secret, '# Секрет\n', { mode: 0o600 })
    symlinkSync(secret, join(root, 'link.md'))
    article(root, 'real.md', '# Настоящая\n')

    const zone = makeKnowledgeZone({ root })
    // Neither catalogued…
    expect(zone.catalogue().entries.map(entry => entry.path)).toEqual(['real.md'])
    // …nor readable through the link.
    expect(() => zone.readArticle('link.md')).toThrowError(KnowledgeZoneError)
  })

  it('returns an empty catalogue for an empty or absent zone', () => {
    const empty = makeKnowledgeZone({ root: zoneRoot() }).catalogue()
    expect(empty.entries).toEqual([])
    expect(empty.markdown).toBe('# Knowledge\n\n')

    const absent = makeKnowledgeZone({ root: join(zoneRoot(), 'never-created') }).catalogue()
    expect(absent.entries).toEqual([])
  })

  it('groups articles by topic and keeps root-level ones separate', () => {
    const root = zoneRoot()
    article(root, 'loose.md', '# Свободная\n')
    article(root, 'topic/inner.md', '# Внутри\n')

    const markdown = makeKnowledgeZone({ root }).catalogue().markdown
    expect(markdown.indexOf('## (root)')).toBeLessThan(markdown.indexOf('## topic'))
  })
})

describe('writing articles into the zone (ADR-0075)', () => {
  it('creates the topic folder and shows up in the catalogue', () => {
    const dir = zoneRoot()
    const zone = makeKnowledgeZone({ root: dir })

    zone.writeArticle('deploy/rollback.md', '# Как откатить релиз\n\nШаги…\n')

    expect(zone.readArticle('deploy/rollback.md')).toContain('Как откатить релиз')
    expect(zone.catalogue().markdown).toContain('[Как откатить релиз](deploy/rollback.md)')
  })

  it('refuses every path that is not a plain article name', () => {
    const zone = makeKnowledgeZone({ root: zoneRoot() })

    for (const bad of [
      '../escape.md',
      '/etc/passwd.md',
      'deploy/../../escape.md',
      'Deploy/Rollback.md',
      'notes.txt',
      'deploy//rollback.md',
      '',
    ]) {
      expect(() => zone.writeArticle(bad, 'тело')).toThrowError(KnowledgeZoneError)
    }
  })

  it('refuses to write the catalogue itself — it is derived, not authored', () => {
    const zone = makeKnowledgeZone({ root: zoneRoot() })

    expect(() => zone.writeArticle('_index.md', '# подделка')).toThrowError(KnowledgeZoneError)
    expect(() => zone.writeArticle('deploy/_index.md', '# подделка')).toThrowError(KnowledgeZoneError)
  })

  it('does not follow a symlink that already occupies the article path', () => {
    const dir = zoneRoot()
    const outside = join(dir, '..', `escape-${Date.now()}.md`)
    writeFileSync(outside, 'приватное')
    symlinkSync(outside, join(dir, 'article.md'))

    expect(() => makeKnowledgeZone({ root: dir }).writeArticle('article.md', 'перезапись'))
      .toThrowError(KnowledgeZoneError)
    expect(readFileSync(outside, 'utf8')).toBe('приватное')
    rmSync(outside, { force: true })
  })

  it('replaces an existing article rather than appending to it', () => {
    const dir = zoneRoot()
    const zone = makeKnowledgeZone({ root: dir })

    zone.writeArticle('note.md', '# Первая версия\n')
    zone.writeArticle('note.md', '# Вторая версия\n')

    expect(zone.readArticle('note.md')).toBe('# Вторая версия\n')
  })
})
