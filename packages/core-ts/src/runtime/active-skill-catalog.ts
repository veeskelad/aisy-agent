import { createHash } from 'node:crypto'
import { parseSkillDocument } from '../skills/index.js'
import type { MenuEntry, SkillBody } from '../skills/index.js'

export type SkillTrustSource = 'builtin' | 'trusted-repo' | 'community' | 'user'
export type ActiveSkillQuarantineReason =
  | 'invalid-manifest'
  | 'invalid-skill'
  | 'hash-mismatch'
  | 'identity-mismatch'
  | 'unverified'

export interface ActiveSkillManifestEntryV1 {
  name: string
  version: number
  sha256: string
  trustSource: SkillTrustSource
  traceVerified: boolean
  status: 'active' | 'archived'
  /** Code-reviewed concrete relative paths this recipe may write. */
  touchedPaths: string[]
}

export interface ActiveSkillManifestV1 {
  schemaVersion: 1
  skills: ActiveSkillManifestEntryV1[]
}

export interface ActiveSkillPersistencePort {
  loadManifest(): unknown
  readSkill(name: string): string
  quarantine(name: string, reason: ActiveSkillQuarantineReason): void
}

export interface ActiveSkillCatalog {
  menu(): MenuEntry[]
  names(): string[]
  matchTriggers(request: string): string[]
  loadBody(name: string): Promise<SkillBody>
  touchedPaths(name: string): string[]
}

const NAME = /^[a-z0-9][a-z0-9-]*$/
const HASH = /^[a-f0-9]{64}$/
const VERIFICATION = /(^|\n)##\s+verification\b/i

export function makeActiveSkillCatalog(port: ActiveSkillPersistencePort): ActiveSkillCatalog {
  const active = new Map<string, {
    menu: MenuEntry
    body: string
    triggers: string[]
    touchedPaths: string[]
  }>()
  const quarantine = (name: string, reason: ActiveSkillQuarantineReason): void => {
    const key = NAME.test(name) || name === '__manifest__' ? name : '__manifest__'
    try { port.quarantine(key, reason) } catch { /* serving remains fail-closed for this skill */ }
  }

  let raw: unknown
  try { raw = port.loadManifest() } catch { raw = undefined }
  if (typeof raw !== 'object' || raw === null ||
    (raw as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((raw as { skills?: unknown }).skills)) {
    quarantine('__manifest__', 'invalid-manifest')
  } else {
    const entries = (raw as { skills: unknown[] }).skills
    const duplicates = new Set<string>()
    const seen = new Set<string>()
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null ||
        typeof (entry as { name?: unknown }).name !== 'string') continue
      const name = (entry as { name: string }).name
      if (seen.has(name)) duplicates.add(name)
      seen.add(name)
    }
    for (const value of entries) {
      if (typeof value !== 'object' || value === null) {
        quarantine('__manifest__', 'invalid-manifest')
        continue
      }
      const entry = value as ActiveSkillManifestEntryV1
      if (duplicates.has(entry.name)) {
        quarantine(entry.name, 'invalid-manifest')
        continue
      }
      if (!NAME.test(entry.name) || !Number.isInteger(entry.version) || entry.version < 1 ||
        !HASH.test(entry.sha256) ||
        !Array.isArray(entry.touchedPaths) || entry.touchedPaths.length > 100 ||
        entry.touchedPaths.some(path => typeof path !== 'string' || path.length === 0 ||
          path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
          path.split('/').some(part => part === '' || part === '.' || part === '..')) ||
        !['builtin', 'trusted-repo', 'community', 'user'].includes(entry.trustSource) ||
        (entry.status !== 'active' && entry.status !== 'archived')) {
        quarantine(typeof entry.name === 'string' ? entry.name : '__manifest__', 'invalid-manifest')
        continue
      }
      if (entry.status === 'archived') continue
      if (entry.traceVerified !== true) {
        quarantine(entry.name, 'unverified')
        continue
      }
      let text: string
      try { text = port.readSkill(entry.name) } catch {
        quarantine(entry.name, 'invalid-skill')
        continue
      }
      if (Buffer.byteLength(text, 'utf8') > 256 * 1024) {
        quarantine(entry.name, 'invalid-skill')
        continue
      }
      if (createHash('sha256').update(text, 'utf8').digest('hex') !== entry.sha256) {
        quarantine(entry.name, 'hash-mismatch')
        continue
      }
      const parsed = parseSkillDocument(text)
      if (!parsed.ok || !VERIFICATION.test(parsed.skill.body)) {
        quarantine(entry.name, 'invalid-skill')
        continue
      }
      if (parsed.skill.frontmatter.name !== entry.name ||
        parsed.skill.frontmatter.version !== entry.version) {
        quarantine(entry.name, 'identity-mismatch')
        continue
      }
      active.set(entry.name, {
        menu: { name: entry.name, description: parsed.skill.frontmatter.description },
        body: parsed.skill.body,
        triggers: [...parsed.skill.frontmatter.triggers],
        touchedPaths: [...entry.touchedPaths],
      })
    }
  }

  return {
    menu: () => [...active.values()].map(value => ({ ...value.menu })).sort((a, b) => a.name.localeCompare(b.name)),
    names: () => [...active.keys()].sort(),
    matchTriggers(request) {
      const query = request.toLowerCase()
      return [...active.entries()]
        .filter(([, value]) => value.triggers.some(trigger => query.includes(trigger.toLowerCase())))
        .map(([name]) => name)
        .sort()
    },
    async loadBody(name) { return active.get(name)?.body ?? '' },
    touchedPaths: name => [...(active.get(name)?.touchedPaths ?? [])],
  }
}
