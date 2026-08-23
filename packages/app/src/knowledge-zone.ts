// Knowledge zone with a lazy catalogue (ADR-0075).
//
// Articles are files, not ledger facts: they are long, numerous, and never
// quoted as claims about the operator. Only the catalogue enters context, so the
// zone can grow without pushing the conversation out of the window.

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

export type KnowledgeRefusal =
  | 'outside-zone'
  | 'not-a-regular-file'
  | 'article-too-large'
  | 'zone-too-large'
  | 'bad-article-path'

export class KnowledgeZoneError extends Error {
  constructor(readonly reason: KnowledgeRefusal) {
    super(`knowledge zone refused: ${reason}`)
    this.name = 'KnowledgeZoneError'
  }
}

export interface KnowledgeArticleEntry {
  /** Path relative to the zone root, POSIX-style, stable across platforms. */
  path: string
  /** Topic folders, outermost first; empty for an article at the root. */
  topics: string[]
  title: string
}

export interface KnowledgeCatalogue {
  entries: KnowledgeArticleEntry[]
  /** Deterministic `_index.md` content — the only part that enters context. */
  markdown: string
  sha256: string
}

const INDEX_FILE = '_index.md'
const MAX_ARTICLES = 4096
const MAX_ARTICLE_BYTES = 4 * 1024 * 1024
const TITLE_SCAN_BYTES = 8 * 1024

/** First level-one heading, or the file name when the article has none. */
function titleOf(absolute: string, fallback: string): string {
  let head: string
  try {
    const bytes = readFileSync(absolute)
    head = bytes.subarray(0, TITLE_SCAN_BYTES).toString('utf8')
  } catch {
    return fallback
  }
  for (const line of head.split('\n')) {
    const match = /^#\s+(.+?)\s*$/.exec(line)
    if (match?.[1] !== undefined && match[1] !== '') return match[1]
  }
  return fallback
}

function walk(root: string, current: string, out: KnowledgeArticleEntry[]): void {
  if (out.length > MAX_ARTICLES) throw new KnowledgeZoneError('zone-too-large')
  let names: string[]
  try {
    names = readdirSync(current)
  } catch {
    return
  }
  // Sorted here rather than after collection: identical trees must produce an
  // identical catalogue, and readdir order is not guaranteed.
  for (const name of [...names].sort()) {
    const absolute = join(current, name)
    let stat
    try {
      stat = lstatSync(absolute)
    } catch {
      continue
    }
    // Symlinks are skipped, not followed: the catalogue never leaves the zone.
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      walk(root, absolute, out)
      continue
    }
    if (!stat.isFile() || !name.endsWith('.md') || name === INDEX_FILE) continue
    if (stat.size > MAX_ARTICLE_BYTES) throw new KnowledgeZoneError('article-too-large')
    const relativePath = relative(root, absolute).split(sep).join('/')
    const topics = relativePath.split('/').slice(0, -1)
    out.push({ path: relativePath, topics, title: titleOf(absolute, name.replace(/\.md$/, '')) })
    if (out.length > MAX_ARTICLES) throw new KnowledgeZoneError('zone-too-large')
  }
}

function renderCatalogue(entries: readonly KnowledgeArticleEntry[]): string {
  const lines: string[] = ['# Knowledge', '']
  let currentTopic: string | null = null
  for (const entry of entries) {
    const topic = entry.topics.join('/')
    if (topic !== currentTopic) {
      if (currentTopic !== null) lines.push('')
      lines.push(topic === '' ? '## (root)' : `## ${topic}`)
      currentTopic = topic
    }
    lines.push(`- [${entry.title}](${entry.path})`)
  }
  return lines.join('\n') + '\n'
}

export interface KnowledgeZone {
  /** Rebuild the catalogue from the tree; the index file is never an input. */
  catalogue(): KnowledgeCatalogue
  /** Read one article by its catalogue path, enforcing the zone boundary. */
  readArticle(relativePath: string): string
  /** Create or replace one article. The catalogue is derived, never written. */
  writeArticle(relativePath: string, content: string): void
}

/**
 * Article paths are a deliberately small language: lowercase names, digits,
 * dash, underscore, dot, `/` for topics, and a `.md` suffix. Everything a path
 * traversal needs — `..`, absolute roots, backslashes, NUL — is simply not
 * expressible, so the boundary check never has to out-argue a clever encoding.
 */
const ARTICLE_PATH = /^(?!.*\/\/)[a-z0-9][a-z0-9._/-]{0,190}\.md$/

function validArticlePath(candidate: string): boolean {
  return typeof candidate === 'string' && ARTICLE_PATH.test(candidate) &&
    !candidate.split('/').some((part) => part === '' || part === '.' || part === '..')
}

export function makeKnowledgeZone(input: { root: string }): KnowledgeZone {
  const root = resolve(input.root)

  const insideZone = (candidate: string): string => {
    const absolute = resolve(root, candidate)
    let canonical: string
    let canonicalRoot: string
    try {
      canonical = realpathSync(absolute)
      canonicalRoot = realpathSync(root)
    } catch {
      throw new KnowledgeZoneError('outside-zone')
    }
    if (canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + sep)) {
      throw new KnowledgeZoneError('outside-zone')
    }
    return canonical
  }

  return {
    catalogue(): KnowledgeCatalogue {
      const entries: KnowledgeArticleEntry[] = []
      walk(root, root, entries)
      const markdown = renderCatalogue(entries)
      return {
        entries,
        markdown,
        sha256: createHash('sha256').update(markdown, 'utf8').digest('hex'),
      }
    },

    writeArticle(relativePath: string, content: string): void {
      if (!validArticlePath(relativePath)) throw new KnowledgeZoneError('bad-article-path')
      if (relativePath === INDEX_FILE || relativePath.endsWith(`/${INDEX_FILE}`)) {
        // The catalogue is derived from the tree; writing it by hand would let
        // an article be hidden or invented without touching the zone (ADR-0075).
        throw new KnowledgeZoneError('bad-article-path')
      }
      const bytes = Buffer.from(content, 'utf8')
      if (bytes.byteLength > MAX_ARTICLE_BYTES) throw new KnowledgeZoneError('article-too-large')

      const absolute = resolve(root, relativePath)
      const parent = dirname(absolute)
      mkdirSync(parent, { recursive: true, mode: 0o700 })
      // Canonicalize after the directory exists: a symlinked topic folder must
      // not become a way to write outside the zone.
      insideZone(relative(root, parent) === '' ? '.' : relative(root, parent))
      const existing = (() => {
        try {
          return lstatSync(absolute)
        } catch {
          return null
        }
      })()
      if (existing !== null && (existing.isSymbolicLink() || !existing.isFile())) {
        throw new KnowledgeZoneError('not-a-regular-file')
      }
      writeFileSync(absolute, bytes, { mode: 0o600 })
    },

    readArticle(relativePath: string): string {
      if (typeof relativePath !== 'string' || relativePath === '') {
        throw new KnowledgeZoneError('outside-zone')
      }
      const canonical = insideZone(relativePath)
      const stat = lstatSync(canonical)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new KnowledgeZoneError('not-a-regular-file')
      }
      if (stat.size > MAX_ARTICLE_BYTES) throw new KnowledgeZoneError('article-too-large')
      return readFileSync(canonical, 'utf8')
    },
  }
}
