import type {
  ActiveSkillManifestV1,
  ActiveSkillPersistencePort,
  ActiveSkillQuarantineReason,
  ParseError,
  SkillTrustSource,
} from '@aisy/core'
import { makeActiveSkillCatalog, parseSkillDocument } from '@aisy/core'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

interface QuarantineStateV1 {
  schemaVersion: 1
  records: Record<string, { reason: ActiveSkillQuarantineReason; quarantinedAt: string }>
}

export interface SkillActivationInput {
  operationId: string
  name: string
  version: number
  sha256: string
  trustSource: SkillTrustSource
  touchedPaths: string[]
  skillText: string
  baseVersion: number | null
  baseHash: string | null
}

export interface ActiveSkillIdentity {
  name: string
  version: number
  hash: string
  skillText: string
}

type ActivationPhase = 'prepared' | 'skill-written' | 'manifest-written' | 'committed' | 'rolled-back'

interface ActivationWalV1 {
  schemaVersion: 1
  operationId: string
  phase: ActivationPhase
  name: string
  previousManifest: ActiveSkillManifestV1 | null
  previousSkillBase64: string | null
  nextManifest: ActiveSkillManifestV1
  nextSkillBase64: string
}

export interface SkillActivationPort {
  validate?(input: SkillActivationInput): boolean
  current(name: string): ActiveSkillIdentity | null
  prepare(input: SkillActivationInput): 'prepared' | 'revision_conflict'
  activate(input: SkillActivationInput): void
  rollback(operationId: string): boolean
}

/** One row of the skills folder as the operator sees it. */
export interface SkillFolderEntry {
  name: string
  version: number
  description: string
  /** Served to the agent. `false` means the operator switched it off. */
  enabled: boolean
  trustSource: SkillTrustSource
  /** Why the runtime refuses to serve it, when it does. */
  problem: ActiveSkillQuarantineReason | null
}

export type SkillInstallResult =
  | {
    ok: true
    name: string
    version: number
    /** Null on a first install. */
    previousVersion: number | null
    /** The sent document reused an old version number and we raised it. */
    versionRaised: boolean
  }
  | {
    ok: false
    errorCode:
      | 'TOO_LARGE'
      | 'NOT_A_SKILL'
      | 'NO_VERIFICATION'
      | 'ALREADY_INSTALLED'
      | 'REVISION_CONFLICT'
      | 'WRITE_FAILED'
    detail?: string
  }

/** Operator-facing folder operations over the same manifest the catalog reads. */
export interface SkillFolderPort {
  list(): SkillFolderEntry[]
  /** False when no such skill is in the manifest. */
  setEnabled(name: string, enabled: boolean): boolean
  remove(name: string): boolean
  install(skillText: string): SkillInstallResult
}

export interface NodeActiveSkillPersistence
  extends ActiveSkillPersistencePort, SkillActivationPort, SkillFolderPort {}

export class SkillActivationError extends Error {
  constructor(public readonly code:
    | 'INVALID_ACTIVATION'
    | 'INVALID_ACTIVE_MANIFEST'
    | 'CORRUPT_ACTIVATION_WAL'
    | 'ACTIVATION_CONFLICT'
    | 'REVISION_CONFLICT',
  ) {
    super(code)
    this.name = 'SkillActivationError'
  }
}

const safeName = (name: string): void => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('unsafe skill name')
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

/** Mirrors the catalog's own limits so install refuses what serving would. */
const MAX_SKILL_BYTES = 256 * 1024
const VERIFICATION = /(^|\n)##\s+verification\b/i

/**
 * Rewrite the `version:` line inside the frontmatter fence only, then re-parse:
 * the document that comes back is the one that gets hashed and served, so a
 * substitution that changed anything else is rejected instead of stored.
 */
function withVersion(raw: string, version: number): string | null {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '---') return null
  const fence = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (fence < 0) return null
  const target = lines.findIndex((line, index) =>
    index > 0 && index < fence && /^version:/.test(line))
  if (target < 0) return null
  const next = [...lines]
  next[target] = `version: ${version}`
  const text = next.join('\n')
  const parsed = parseSkillDocument(text)
  const original = parseSkillDocument(raw)
  return parsed.ok && original.ok &&
    parsed.skill.frontmatter.version === version &&
    parsed.skill.body === original.skill.body &&
    parsed.skill.frontmatter.name === original.skill.frontmatter.name &&
    parsed.skill.frontmatter.description === original.skill.frontmatter.description
    ? text
    : null
}

function describeParseErrors(errors: readonly ParseError[]): string {
  return errors.map(error => {
    if (error.kind === 'missing_field') return `нет поля «${error.field}»`
    if (error.kind === 'description_too_long') return `описание длиннее 60 символов (${error.length})`
    if (error.kind === 'invalid_name_format') return `имя «${error.name}» не подходит (нужны строчные буквы, цифры и дефис)`
    if (error.kind === 'prohibited_authority_field') return `лишнее поле «${error.field}»`
    if (error.kind === 'empty_trigger') return 'пустой триггер'
    return `заголовок: ${error.detail}`
  }).join('; ')
}

function saveAtomic(path: string, content: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  syncPath(temporary)
  renameSync(temporary, path)
  syncPath(directory)
}

export function makeNodeActiveSkillPersistence(input: {
  root: string
  nowIso?: () => string
  /** Test-only crash injection after a durable phase boundary. */
  onActivationPhase?: (phase: ActivationPhase) => void
}): NodeActiveSkillPersistence {
  mkdirSync(input.root, { recursive: true, mode: 0o700 })
  chmodSync(input.root, 0o700)
  const manifestPath = join(input.root, 'skills-manifest.json')
  const quarantinePath = join(input.root, 'skills-quarantine.json')
  const activationWalPath = join(input.root, 'skills-activation.json')
  const nowIso = input.nowIso ?? (() => new Date().toISOString())

  const loadValidManifest = (): ActiveSkillManifestV1 => {
    if (!existsSync(manifestPath)) return { schemaVersion: 1, skills: [] }
    try {
      const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as ActiveSkillManifestV1
      if (value.schemaVersion !== 1 || !Array.isArray(value.skills)) throw new Error('invalid')
      return value
    } catch {
      throw new SkillActivationError('INVALID_ACTIVE_MANIFEST')
    }
  }

  const validateWal = (value: unknown): ActivationWalV1 => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SkillActivationError('CORRUPT_ACTIVATION_WAL')
    }
    const wal = value as ActivationWalV1
    if (wal.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(wal.operationId) ||
      !['prepared', 'skill-written', 'manifest-written', 'committed', 'rolled-back'].includes(wal.phase) ||
      !/^[a-z0-9][a-z0-9-]*$/.test(wal.name) || typeof wal.nextSkillBase64 !== 'string' ||
      (wal.previousSkillBase64 !== null && typeof wal.previousSkillBase64 !== 'string') ||
      wal.nextManifest?.schemaVersion !== 1 || !Array.isArray(wal.nextManifest.skills) ||
      (wal.previousManifest !== null && (wal.previousManifest.schemaVersion !== 1 || !Array.isArray(wal.previousManifest.skills)))) {
      throw new SkillActivationError('CORRUPT_ACTIVATION_WAL')
    }
    return wal
  }

  const saveWal = (wal: ActivationWalV1, notify = true): void => {
    saveAtomic(activationWalPath, JSON.stringify(wal, null, 2) + '\n')
    if (notify) input.onActivationPhase?.(wal.phase)
  }

  const skillPath = (name: string): string => join(input.root, 'skills', name, 'SKILL.md')

  const validActivation = (value: SkillActivationInput): boolean => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.operationId) ||
      !/^[a-z0-9][a-z0-9-]*$/.test(value.name) ||
      !Number.isInteger(value.version) || value.version < 1 || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !['builtin', 'trusted-repo', 'community', 'user'].includes(value.trustSource) ||
      !Array.isArray(value.touchedPaths) ||
      ((value.baseVersion === null) !== (value.baseHash === null)) ||
      (value.baseVersion !== null && (!Number.isInteger(value.baseVersion) || value.baseVersion < 1)) ||
      (value.baseHash !== null && !/^[a-f0-9]{64}$/.test(value.baseHash)) ||
      createHash('sha256').update(value.skillText, 'utf8').digest('hex') !== value.sha256) return false
    const quarantined: string[] = []
    const catalog = makeActiveSkillCatalog({
      loadManifest: () => ({
        schemaVersion: 1,
        skills: [{
          name: value.name, version: value.version, sha256: value.sha256,
          trustSource: value.trustSource, traceVerified: true, status: 'active', touchedPaths: value.touchedPaths,
        }],
      }),
      readSkill: () => value.skillText,
      quarantine: (_name, reason) => { quarantined.push(reason) },
    })
    return quarantined.length === 0 && catalog.names().length === 1
  }

  const restore = (wal: ActivationWalV1): void => {
    const path = skillPath(wal.name)
    if (wal.previousSkillBase64 === null) {
      if (existsSync(path)) {
        unlinkSync(path)
        syncPath(dirname(path))
      }
    } else {
      saveAtomic(path, Buffer.from(wal.previousSkillBase64, 'base64').toString('utf8'))
    }
    if (wal.previousManifest === null) {
      if (existsSync(manifestPath)) {
        unlinkSync(manifestPath)
        syncPath(dirname(manifestPath))
      }
    } else {
      saveAtomic(manifestPath, JSON.stringify(wal.previousManifest, null, 2) + '\n')
    }
  }

  const currentIdentity = (name: string): ActiveSkillIdentity | null => {
    safeName(name)
    const manifest = loadValidManifest()
    const entry = manifest.skills.find(item => item.name === name && item.status === 'active')
    if (!entry) return null
    const path = skillPath(name)
    if (!existsSync(path)) throw new SkillActivationError('INVALID_ACTIVE_MANIFEST')
    const skillText = readFileSync(path, 'utf8')
    const hash = createHash('sha256').update(skillText, 'utf8').digest('hex')
    if (hash !== entry.sha256) throw new SkillActivationError('REVISION_CONFLICT')
    return { name, version: entry.version, hash, skillText }
  }

  const matchesPreviousState = (wal: ActivationWalV1): boolean => {
    const path = skillPath(wal.name)
    if ((wal.previousSkillBase64 === null) !== !existsSync(path)) return false
    if (wal.previousSkillBase64 !== null && readFileSync(path).toString('base64') !== wal.previousSkillBase64) {
      return false
    }
    if ((wal.previousManifest === null) !== !existsSync(manifestPath)) return false
    if (wal.previousManifest !== null) {
      try {
        if (JSON.stringify(loadValidManifest()) !== JSON.stringify(wal.previousManifest)) return false
      } catch {
        return false
      }
    }
    return true
  }

  const ownsSkillWrittenState = (wal: ActivationWalV1): boolean => {
    const path = skillPath(wal.name)
    if (!existsSync(path) || readFileSync(path).toString('base64') !== wal.nextSkillBase64) return false
    if ((wal.previousManifest === null) !== !existsSync(manifestPath)) return false
    if (wal.previousManifest !== null) {
      try {
        return JSON.stringify(loadValidManifest()) === JSON.stringify(wal.previousManifest)
      } catch {
        return false
      }
    }
    return true
  }

  const ownsManifestWrittenState = (wal: ActivationWalV1): boolean => {
    const path = skillPath(wal.name)
    if (!existsSync(path) || readFileSync(path).toString('base64') !== wal.nextSkillBase64 || !existsSync(manifestPath)) {
      return false
    }
    try {
      return JSON.stringify(loadValidManifest()) === JSON.stringify(wal.nextManifest)
    } catch {
      return false
    }
  }

  const prepareActivation = (value: SkillActivationInput): 'prepared' | 'revision_conflict' => {
    if (!validActivation(value)) throw new SkillActivationError('INVALID_ACTIVATION')
    if (existsSync(activationWalPath)) {
      const wal = validateWal(JSON.parse(readFileSync(activationWalPath, 'utf8')) as unknown)
      if (wal.operationId === value.operationId &&
        (wal.phase === 'prepared' || wal.phase === 'skill-written' || wal.phase === 'manifest-written' || wal.phase === 'committed')) {
        const nextEntry = wal.nextManifest.skills.find(entry => entry.name === value.name)
        if (wal.name !== value.name || wal.nextSkillBase64 !== Buffer.from(value.skillText, 'utf8').toString('base64') ||
          !nextEntry || nextEntry.version !== value.version || nextEntry.sha256 !== value.sha256 ||
          nextEntry.trustSource !== value.trustSource ||
          JSON.stringify(nextEntry.touchedPaths) !== JSON.stringify(value.touchedPaths)) {
          throw new SkillActivationError('ACTIVATION_CONFLICT')
        }
        return 'prepared'
      }
      if (wal.phase !== 'rolled-back' && wal.phase !== 'committed') return 'revision_conflict'
    }
    const current = currentIdentity(value.name)
    if (value.baseVersion === null) {
      if (current !== null || existsSync(skillPath(value.name))) return 'revision_conflict'
    } else if (!current || current.version !== value.baseVersion || current.hash !== value.baseHash) {
      return 'revision_conflict'
    }
    const previousManifest = existsSync(manifestPath) ? loadValidManifest() : null
    const path = skillPath(value.name)
    const previousSkillBase64 = existsSync(path) ? readFileSync(path).toString('base64') : null
    const base = previousManifest ?? { schemaVersion: 1 as const, skills: [] }
    const nextManifest: ActiveSkillManifestV1 = {
      schemaVersion: 1,
      skills: [
        ...base.skills.filter(entry => entry.name !== value.name),
        {
          name: value.name, version: value.version, sha256: value.sha256,
          trustSource: value.trustSource, traceVerified: true, status: 'active' as const,
          touchedPaths: [...value.touchedPaths],
        },
      ].sort((left, right) => left.name.localeCompare(right.name)),
    }
    saveWal({
      schemaVersion: 1, operationId: value.operationId, phase: 'prepared', name: value.name,
      previousManifest, previousSkillBase64, nextManifest,
      nextSkillBase64: Buffer.from(value.skillText, 'utf8').toString('base64'),
    })
    return 'prepared'
  }

  // The WAL is the restart authority for the two-file publication. An operation
  // that had not durably published the manifest is rolled back; one that had is
  // deterministically completed. Recovery never consults a model or network.
  if (existsSync(activationWalPath)) {
    let wal: ActivationWalV1
    try { wal = validateWal(JSON.parse(readFileSync(activationWalPath, 'utf8')) as unknown) } catch {
      throw new SkillActivationError('CORRUPT_ACTIVATION_WAL')
    }
    if (wal.phase === 'prepared') {
      // prepare() is a reservation only and owns no live bytes. Never erase a
      // manual edit that raced with the reservation during restart recovery.
      saveWal({ ...wal, phase: 'rolled-back' }, false)
    } else if (wal.phase === 'skill-written') {
      // Roll back only bytes demonstrably written by this operation.
      if (ownsSkillWrittenState(wal)) restore(wal)
      saveWal({ ...wal, phase: 'rolled-back' }, false)
    } else if (wal.phase === 'manifest-written') {
      // Both files were durable before this phase was recorded. Complete only
      // if they are still our exact bytes; otherwise preserve the newer edit.
      saveWal({ ...wal, phase: ownsManifestWrittenState(wal) ? 'committed' : 'rolled-back' }, false)
    }
  }

  const loadQuarantine = (): QuarantineStateV1 => {
    if (!existsSync(quarantinePath)) return { schemaVersion: 1, records: {} }
    try {
      const value = JSON.parse(readFileSync(quarantinePath, 'utf8')) as QuarantineStateV1
      return value.schemaVersion === 1 && value.records && typeof value.records === 'object'
        ? value
        : { schemaVersion: 1, records: { __manifest__: { reason: 'invalid-manifest', quarantinedAt: nowIso() } } }
    } catch {
      return { schemaVersion: 1, records: { __manifest__: { reason: 'invalid-manifest', quarantinedAt: nowIso() } } }
    }
  }

  const clearQuarantine = (name: string): void => {
    const state = loadQuarantine()
    if (state.records[name] === undefined) return
    delete state.records[name]
    saveAtomic(quarantinePath, JSON.stringify(state, null, 2) + '\n')
  }

  const activateSkill = (value: SkillActivationInput): void => {
    safeName(value.name)
    if (!validActivation(value)) {
      throw new SkillActivationError('INVALID_ACTIVATION')
    }
    const prepared = prepareActivation(value)
    if (prepared === 'revision_conflict') throw new SkillActivationError('REVISION_CONFLICT')
    const existing = validateWal(JSON.parse(readFileSync(activationWalPath, 'utf8')) as unknown)
    if (existing.operationId !== value.operationId) throw new SkillActivationError('ACTIVATION_CONFLICT')
    if (existing.phase === 'committed') return
    if (existing.phase === 'prepared' && !matchesPreviousState(existing)) {
      throw new SkillActivationError('REVISION_CONFLICT')
    }
    if (existing.phase === 'skill-written' && !ownsSkillWrittenState(existing)) {
      throw new SkillActivationError('REVISION_CONFLICT')
    }
    if (existing.phase === 'manifest-written' && !ownsManifestWrittenState(existing)) {
      throw new SkillActivationError('REVISION_CONFLICT')
    }
    const path = skillPath(value.name)
    let wal = existing
    saveAtomic(path, value.skillText)
    wal = { ...wal, phase: 'skill-written' }
    saveWal(wal)
    saveAtomic(manifestPath, JSON.stringify(wal.nextManifest, null, 2) + '\n')
    wal = { ...wal, phase: 'manifest-written' }
    saveWal(wal)
    saveWal({ ...wal, phase: 'committed' })
  }

  const rollbackOperation = (operationId: string): boolean => {
    if (!existsSync(activationWalPath)) return false
    const wal = validateWal(JSON.parse(readFileSync(activationWalPath, 'utf8')) as unknown)
    if (wal.operationId !== operationId) return false
    if (wal.phase === 'rolled-back') return true
    if (wal.phase === 'skill-written' && !ownsSkillWrittenState(wal)) return false
    if ((wal.phase === 'manifest-written' || wal.phase === 'committed') && !ownsManifestWrittenState(wal)) return false
    if (wal.phase !== 'prepared') restore(wal)
    saveWal({ ...wal, phase: 'rolled-back' }, false)
    return true
  }

  return {
    loadManifest() {
      if (!existsSync(manifestPath)) return { schemaVersion: 1, skills: [] }
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
      const quarantine = loadQuarantine()
      if (quarantine.records['__manifest__']) return { schemaVersion: 1, skills: [] }
      if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { skills?: unknown }).skills)) return raw
      return {
        ...(raw as Record<string, unknown>),
        skills: (raw as { skills: unknown[] }).skills.map(value => {
          if (typeof value !== 'object' || value === null) return value
          const name = (value as { name?: unknown }).name
          return typeof name === 'string' && quarantine.records[name]
            ? { ...value, status: 'archived' }
            : value
        }),
      }
    },
    readSkill(name) {
      safeName(name)
      const path = join(input.root, 'skills', name, 'SKILL.md')
      return readFileSync(path, 'utf8')
    },
    quarantine(name, reason) {
      if (name !== '__manifest__') safeName(name)
      const state = loadQuarantine()
      state.records[name] = { reason, quarantinedAt: nowIso() }
      saveAtomic(quarantinePath, JSON.stringify(state, null, 2) + '\n')
    },
    validate: validActivation,
    current: currentIdentity,
    prepare: prepareActivation,
    activate: activateSkill,
    rollback: rollbackOperation,

    list() {
      const quarantine = loadQuarantine().records
      if (quarantine['__manifest__']) throw new SkillActivationError('INVALID_ACTIVE_MANIFEST')
      return loadValidManifest().skills.map((entry): SkillFolderEntry => {
        const record = quarantine[entry.name]
        let description = ''
        try {
          const parsed = parseSkillDocument(readFileSync(skillPath(entry.name), 'utf8'))
          if (parsed.ok) description = parsed.skill.frontmatter.description
        } catch { /* a broken file is reported through `problem`, not by throwing */ }
        return {
          name: entry.name,
          version: entry.version,
          description,
          enabled: entry.status === 'active' && record === undefined,
          trustSource: entry.trustSource,
          problem: record?.reason ?? null,
        }
      }).sort((left, right) => left.name.localeCompare(right.name))
    },

    setEnabled(name, enabled) {
      safeName(name)
      const manifest = loadValidManifest()
      const entry = manifest.skills.find(item => item.name === name)
      if (!entry) return false
      saveAtomic(manifestPath, JSON.stringify({
        ...manifest,
        skills: manifest.skills.map(item =>
          item.name === name ? { ...item, status: enabled ? 'active' as const : 'archived' as const } : item),
      }, null, 2) + '\n')
      // Switching a skill back on asks the runtime to judge it again; a stale
      // quarantine record would keep it archived no matter what the file says.
      if (enabled) clearQuarantine(name)
      return true
    },

    remove(name) {
      safeName(name)
      const manifest = loadValidManifest()
      if (!manifest.skills.some(item => item.name === name)) return false
      // Manifest first: a crash between the two steps leaves an orphan file the
      // catalog ignores, whereas the reverse order leaves an entry pointing at
      // nothing and quarantines the whole skill on the next boot.
      saveAtomic(manifestPath, JSON.stringify({
        ...manifest,
        skills: manifest.skills.filter(item => item.name !== name),
      }, null, 2) + '\n')
      rmSync(join(input.root, 'skills', name), { recursive: true, force: true })
      clearQuarantine(name)
      return true
    },

    install(skillText) {
      if (Buffer.byteLength(skillText, 'utf8') > MAX_SKILL_BYTES) {
        return { ok: false, errorCode: 'TOO_LARGE' }
      }
      const parsed = parseSkillDocument(skillText)
      if (!parsed.ok) {
        return { ok: false, errorCode: 'NOT_A_SKILL', detail: describeParseErrors(parsed.errors) }
      }
      if (!VERIFICATION.test(parsed.skill.body)) return { ok: false, errorCode: 'NO_VERIFICATION' }
      const name = parsed.skill.frontmatter.name
      let current: ActiveSkillIdentity | null
      try { current = currentIdentity(name) } catch {
        return { ok: false, errorCode: 'REVISION_CONFLICT' }
      }
      let text = skillText
      let version = parsed.skill.frontmatter.version
      let versionRaised = false
      if (current !== null && version <= current.version) {
        // Compare at the installed version, not as sent: once we have raised a
        // version ourselves, the same unchanged file differs from the stored
        // bytes by exactly that line and would install again on every send.
        const asStored = withVersion(skillText, current.version) ?? skillText
        if (current.hash === createHash('sha256').update(asStored, 'utf8').digest('hex')) {
          return { ok: false, errorCode: 'ALREADY_INSTALLED' }
        }
        // The operator edits the file and sends it; remembering to bump the
        // version by hand is exactly the step they will forget, and the catalog
        // refuses to serve a body whose hash no longer matches the entry.
        const raised = withVersion(skillText, current.version + 1)
        if (raised === null) return { ok: false, errorCode: 'NOT_A_SKILL', detail: 'version' }
        text = raised
        version = current.version + 1
        versionRaised = true
      }
      const previous = loadValidManifest().skills.find(entry => entry.name === name)
      const activation: SkillActivationInput = {
        operationId: `install-${randomUUID()}`,
        name,
        version,
        sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        // Write grants belong to the slot, not to the bytes: they were reviewed
        // for this skill name, and a fresh install gets none.
        trustSource: previous?.trustSource ?? 'user',
        touchedPaths: previous?.touchedPaths ?? [],
        skillText: text,
        baseVersion: current?.version ?? null,
        baseHash: current?.hash ?? null,
      }
      try {
        activateSkill(activation)
      } catch (error) {
        try { rollbackOperation(activation.operationId) } catch { /* best effort */ }
        const code = error instanceof SkillActivationError ? error.code : 'WRITE_FAILED'
        return code === 'REVISION_CONFLICT'
          ? { ok: false, errorCode: 'REVISION_CONFLICT' }
          : { ok: false, errorCode: 'WRITE_FAILED', detail: code }
      }
      clearQuarantine(name)
      return {
        ok: true,
        name,
        version,
        previousVersion: current?.version ?? null,
        versionRaised,
      }
    },
  }
}
