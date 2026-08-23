import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, normalize, parse, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { PROTECTED_LEDGER_SCHEMA } from './protected-memory-schema.js'
import { memoryMigrationManifestPath } from './migration-cohort.js'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SOURCE_FACT_COLUMNS = [
  'rowid',
  'id',
  'text',
  'fact_key',
  'key_tokens',
  'valid_at',
  'invalid_at',
  'is_human_confirmed',
  'source_authority',
  'confidence',
  'provenance',
  'supersedes',
  'contradicts',
  'extends_key',
] as const
const SOURCE_FORGET_COLUMNS = [
  'rowid',
  'fact_key',
  'key_tokens',
  'reason',
  'is_human_confirmed',
  'ts',
  'prev_hash',
  'row_hash',
] as const

export type LegacyMemoryMigrationPhase = 'PREPARED' | 'COPIED' | 'VERIFIED'

export interface LegacyMemoryMigrationArtifact {
  path: string
  sha256: string
  bytes: number
}

/** Binds this memory migration to the registry migration of the same cohort (ADR-0070).
 *  `registryMigrationId` is the cohort id and always equals `migrationId`, so the
 *  manifest path stays derivable from the cohort — never from a directory scan. */
export interface LegacyMemoryMigrationCohort {
  registryMigrationId: string
  sourceRegistrySha256: string
}

export interface LegacyMemoryMigrationManifest {
  version: 1
  migrationId: string
  cohort: LegacyMemoryMigrationCohort
  phase: LegacyMemoryMigrationPhase
  sourceDbPath: string
  sourceDbSha256: string
  startedAt: string
  updatedAt: string
  scope: { kind: 'global'; scopeId: 'global' }
  counts: { facts: number; forgotten: number; published: number }
  backup: LegacyMemoryMigrationArtifact
  ledger: LegacyMemoryMigrationArtifact
  factFiles: LegacyMemoryMigrationArtifact[]
}

interface PlannedArtifact extends LegacyMemoryMigrationArtifact {
  content: Buffer
}

export interface LegacyMemoryMigrationPlan {
  manifestPath: string
  runDirectory: string
  manifest: LegacyMemoryMigrationManifest
  backup: PlannedArtifact
  ledger: PlannedArtifact
  factFiles: PlannedArtifact[]
}

export class LegacyMemoryMigrationError extends Error {
  constructor(public readonly code:
    | 'INVALID_INPUT'
    | 'UNSAFE_PATH'
    | 'SOURCE_UNAVAILABLE'
    | 'SOURCE_CHANGED'
    | 'SOURCE_CORRUPT'
    | 'SOURCE_SCHEMA_UNSUPPORTED'
    | 'FORGET_CHAIN_TAMPERED'
    | 'MIGRATION_ALREADY_EXISTS'
    | 'STAGING_EXISTS'
    | 'MANIFEST_CORRUPT'
    | 'MANIFEST_MISMATCH'
    | 'ARTIFACT_TAMPERED'
    | 'LEDGER_CORRUPT'
    | 'PHASE_NOT_PREPARABLE',
  ) {
    super(code)
    this.name = 'LegacyMemoryMigrationError'
  }
}

interface SourceFactRow {
  rowid: number
  id: string
  text: string
  fact_key: string
  key_tokens: string
  valid_at: string
  invalid_at: string | null
  is_human_confirmed: number
  source_authority: number | null
  confidence: number | null
  provenance: string
  supersedes: string | null
  contradicts: string | null
  extends_key: string | null
}

interface SourceForgetRow {
  rowid: number
  fact_key: string
  key_tokens: string
  reason: string
  is_human_confirmed: number
  ts: string
  prev_hash: string
  row_hash: string
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function regularNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function canonicalAbsolutePath(value: string): string {
  if (!isAbsolute(value)) throw new LegacyMemoryMigrationError('UNSAFE_PATH')
  const lexical = normalize(resolve(value))
  if (lexical === parse(lexical).root) throw new LegacyMemoryMigrationError('UNSAFE_PATH')
  const suffix: string[] = []
  let existing = lexical
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) throw new LegacyMemoryMigrationError('UNSAFE_PATH')
    suffix.unshift(basename(existing))
    existing = parent
  }
  return resolve(realpathSync(existing), ...suffix)
}

function assertRegularPrivateSource(path: string): void {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(path) !== path) {
      throw new LegacyMemoryMigrationError('UNSAFE_PATH')
    }
    if ((stat.mode & 0o077) !== 0) throw new LegacyMemoryMigrationError('UNSAFE_PATH')
  } catch (error) {
    if (error instanceof LegacyMemoryMigrationError) throw error
    throw new LegacyMemoryMigrationError('SOURCE_UNAVAILABLE')
  }
}

function assertSecureDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new LegacyMemoryMigrationError('UNSAFE_PATH')
  }
  chmodSync(path, 0o700)
}

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name)
}

function sameColumns(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((name, index) => name === expected[index])
}

function validateSourceFact(row: SourceFactRow): void {
  if (!Number.isSafeInteger(row.rowid) || row.rowid <= 0 || !nonEmpty(row.id) ||
    typeof row.text !== 'string' || !SHA256_PATTERN.test(row.fact_key) ||
    typeof row.key_tokens !== 'string' || !nonEmpty(row.valid_at) ||
    (row.invalid_at !== null && !nonEmpty(row.invalid_at)) ||
    (row.is_human_confirmed !== 0 && row.is_human_confirmed !== 1) ||
    (row.source_authority !== null && !regularNumber(row.source_authority)) ||
    (row.confidence !== null && !regularNumber(row.confidence)) ||
    typeof row.provenance !== 'string' ||
    (row.supersedes !== null && typeof row.supersedes !== 'string') ||
    (row.contradicts !== null && typeof row.contradicts !== 'string') ||
    (row.extends_key !== null && typeof row.extends_key !== 'string')) {
    throw new LegacyMemoryMigrationError('SOURCE_CORRUPT')
  }
}

function validateSourceForget(row: SourceForgetRow): void {
  if (!Number.isSafeInteger(row.rowid) || row.rowid <= 0 ||
    !SHA256_PATTERN.test(row.fact_key) || typeof row.key_tokens !== 'string' ||
    typeof row.reason !== 'string' ||
    (row.is_human_confirmed !== 0 && row.is_human_confirmed !== 1) ||
    !nonEmpty(row.ts) || !nonEmpty(row.prev_hash) || !SHA256_PATTERN.test(row.row_hash)) {
    throw new LegacyMemoryMigrationError('SOURCE_CORRUPT')
  }
}

function verifyForgetChain(rows: SourceForgetRow[]): void {
  let previous = 'genesis'
  for (const row of rows) {
    const expected = sha256(
      `${previous}‖${row.fact_key}‖${row.key_tokens}‖${row.reason}‖${row.ts}`,
    )
    if (row.prev_hash !== previous || row.row_hash !== expected) {
      throw new LegacyMemoryMigrationError('FORGET_CHAIN_TAMPERED')
    }
    previous = row.row_hash
  }
}

function readSource(sourceDbPath: string): {
  image: Buffer
  facts: SourceFactRow[]
  forgotten: SourceForgetRow[]
} {
  assertRegularPrivateSource(sourceDbPath)
  const db = new Database(sourceDbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (integrity[0]?.integrity_check !== 'ok') {
      throw new LegacyMemoryMigrationError('SOURCE_CORRUPT')
    }
    if (!sameColumns(tableColumns(db, 'facts'), SOURCE_FACT_COLUMNS) ||
      !sameColumns(tableColumns(db, 'do_not_remember'), SOURCE_FORGET_COLUMNS) ||
      tableColumns(db, 'fts').length === 0) {
      throw new LegacyMemoryMigrationError('SOURCE_SCHEMA_UNSUPPORTED')
    }
    const facts = db.prepare('SELECT * FROM facts ORDER BY rowid').all() as SourceFactRow[]
    const forgotten = db.prepare(
      'SELECT * FROM do_not_remember ORDER BY rowid',
    ).all() as SourceForgetRow[]
    facts.forEach(validateSourceFact)
    forgotten.forEach(validateSourceForget)
    verifyForgetChain(forgotten)
    return { image: db.serialize(), facts, forgotten }
  } finally {
    db.close()
  }
}

function artifact(path: string, content: Buffer): PlannedArtifact {
  return { path, content, sha256: sha256(content), bytes: content.byteLength }
}

function publicArtifact(value: PlannedArtifact): LegacyMemoryMigrationArtifact {
  return { path: value.path, sha256: value.sha256, bytes: value.bytes }
}

function buildCandidate(input: {
  sourceSha256: string
  migrationId: string
  startedAt: string
  facts: SourceFactRow[]
  forgotten: SourceForgetRow[]
}): { image: Buffer; files: Array<{ relativePath: string; content: Buffer }> } {
  const forgottenKeys = new Set(input.forgotten.map((row) => row.fact_key))
  const files: Array<{ relativePath: string; content: Buffer }> = []
  const ledger = new Database(':memory:')
  try {
    ledger.exec(PROTECTED_LEDGER_SCHEMA)
    const insertFact = ledger.prepare(`
      INSERT INTO facts (
        rowid, operation_id, id, text, fact_key, key_tokens, valid_at, invalid_at,
        is_human_confirmed, source_authority, confidence, provenance,
        supersedes, contradicts, extends_key, published, source_path, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertForget = ledger.prepare(`
      INSERT INTO do_not_remember (
        rowid, operation_id, fact_key, key_tokens, reason, is_human_confirmed,
        ts, prev_hash, row_hash
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `)
    let published = 0
    const migrate = ledger.transaction(() => {
      for (const row of input.facts) {
        const isPublished = row.invalid_at === null && !forgottenKeys.has(row.fact_key)
        const relativePath = isPublished
          ? `memory/facts/${sha256(row.id)}.md`
          : null
        const content = isPublished ? Buffer.from(row.text, 'utf8') : null
        if (relativePath !== null && content !== null) {
          files.push({ relativePath, content })
          published += 1
        }
        insertFact.run(
          row.rowid,
          null,
          row.id,
          row.text,
          row.fact_key,
          row.key_tokens,
          row.valid_at,
          row.invalid_at,
          row.is_human_confirmed,
          row.source_authority,
          row.confidence,
          row.provenance,
          row.supersedes,
          row.contradicts,
          row.extends_key,
          isPublished ? 1 : 0,
          relativePath,
          content === null ? null : sha256(content),
        )
      }
      for (const row of input.forgotten) {
        insertForget.run(
          row.rowid,
          row.fact_key,
          row.key_tokens,
          row.reason,
          row.is_human_confirmed,
          row.ts,
          row.prev_hash,
          row.row_hash,
        )
      }
      ledger.prepare(`
        INSERT INTO ledger_control (
          singleton, schema_version, operator_id, profile_id,
          scope_kind, scope_id, project_id,
          source_sha256, migration_id, started_at, forget_count, forget_head_hash
        ) VALUES (1, 2, NULL, NULL, 'global', 'global', NULL, ?, ?, ?, ?, ?)
      `).run(
        input.sourceSha256,
        input.migrationId,
        input.startedAt,
        input.forgotten.length,
        input.forgotten.at(-1)?.row_hash ?? 'genesis',
      )
    })
    migrate()
    return { image: ledger.serialize(), files }
  } finally {
    ledger.close()
  }
}

function manifestBytes(manifest: LegacyMemoryMigrationManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n'
}

function cloneManifest(manifest: LegacyMemoryMigrationManifest): LegacyMemoryMigrationManifest {
  return {
    ...manifest,
    cohort: { ...manifest.cohort },
    scope: { ...manifest.scope },
    counts: { ...manifest.counts },
    backup: { ...manifest.backup },
    ledger: { ...manifest.ledger },
    factFiles: manifest.factFiles.map((item) => ({ ...item })),
  }
}

function validateArtifact(value: LegacyMemoryMigrationArtifact, runDirectory: string): void {
  let canonicalPath: string | null = null
  try {
    canonicalPath = typeof value === 'object' && value !== null && nonEmpty(value.path)
      ? canonicalAbsolutePath(value.path)
      : null
  } catch {
    throw new LegacyMemoryMigrationError('MANIFEST_CORRUPT')
  }
  if (typeof value !== 'object' || value === null || canonicalPath === null ||
    canonicalPath !== value.path ||
    !value.path.startsWith(runDirectory + '/') || !SHA256_PATTERN.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new LegacyMemoryMigrationError('MANIFEST_CORRUPT')
  }
}

export function validateLegacyMemoryMigrationManifest(
  value: LegacyMemoryMigrationManifest,
  manifestPath: string,
): LegacyMemoryMigrationManifest {
  // The manifest anchors the whole bundle, so it gets the same control as every
  // artifact — and the check runs on the path as given: canonicalising first would
  // follow a symlink and then happily validate its target, moving the run directory
  // out of private staging while every name still matched.
  if (existsSync(manifestPath)) assertRegularPrivateSource(manifestPath)
  const canonicalManifestPath = canonicalAbsolutePath(manifestPath)
  const stagingRoot = dirname(canonicalManifestPath)
  if (typeof value !== 'object' || value === null || !nonEmpty(value.migrationId)) {
    throw new LegacyMemoryMigrationError('MANIFEST_CORRUPT')
  }
  const expectedRun = resolve(
    stagingRoot,
    `memory-${sha256(value.migrationId).slice(0, 32)}`,
  )
  let canonicalSourcePath: string | null = null
  try {
    canonicalSourcePath = nonEmpty(value.sourceDbPath)
      ? canonicalAbsolutePath(value.sourceDbPath)
      : null
  } catch {
    throw new LegacyMemoryMigrationError('MANIFEST_CORRUPT')
  }
  // ADR-0070: the cohort binding is mandatory, must be an own field, and must name
  // this very migration — an inherited `cohort` is not a binding.
  const cohort = Object.hasOwn(value, 'cohort') ? value.cohort : undefined
  if (typeof cohort !== 'object' || cohort === null ||
    !Object.hasOwn(cohort, 'registryMigrationId') || !Object.hasOwn(cohort, 'sourceRegistrySha256') ||
    cohort.registryMigrationId !== value.migrationId ||
    typeof cohort.sourceRegistrySha256 !== 'string' ||
    !SHA256_PATTERN.test(cohort.sourceRegistrySha256)) {
    throw new LegacyMemoryMigrationError('MANIFEST_CORRUPT')
  }
  if (value.version !== 1 ||
    !(['PREPARED', 'COPIED', 'VERIFIED'] as unknown[]).includes(value.phase) ||
    canonicalSourcePath === null || canonicalSourcePath !== value.sourceDbPath ||
    !SHA256_PATTERN.test(value.sourceDbSha256) || !nonEmpty(value.startedAt) ||
    !nonEmpty(value.updatedAt) || value.scope?.kind !== 'global' ||
    value.scope.scopeId !== 'global' || !Number.isSafeInteger(value.counts?.facts) ||
    value.counts.facts < 0 || !Number.isSafeInteger(value.counts.forgotten) ||
    value.counts.forgotten < 0 || !Number.isSafeInteger(value.counts.published) ||
    value.counts.published < 0 || value.counts.published > value.counts.facts ||
    !Array.isArray(value.factFiles)) {
    throw new LegacyMemoryMigrationError('MANIFEST_CORRUPT')
  }
  validateArtifact(value.backup, expectedRun)
  validateArtifact(value.ledger, expectedRun)
  const paths = new Set([value.backup.path, value.ledger.path])
  for (const item of value.factFiles) {
    validateArtifact(item, expectedRun)
    if (!item.path.startsWith(resolve(expectedRun, 'memory/facts') + '/') || paths.has(item.path)) {
      throw new LegacyMemoryMigrationError('MANIFEST_CORRUPT')
    }
    paths.add(item.path)
  }
  if (value.factFiles.length !== value.counts.published ||
    canonicalManifestPath !== memoryMigrationManifestPath(stagingRoot, value.migrationId) ||
    value.backup.path !== resolve(expectedRun, 'memory-v1.backup.sqlite') ||
    value.ledger.path !== resolve(expectedRun, 'protected-ledger-v2.candidate.sqlite')) {
    throw new LegacyMemoryMigrationError('MANIFEST_CORRUPT')
  }
  return cloneManifest(value)
}

export function planLegacyMemoryV1Migration(input: {
  sourceDbPath: string
  stagingRoot: string
  /** Cohort id — the registry migration this memory migration belongs to (ADR-0070). */
  migrationId: string
  /** `sourceRegistrySha256` of that registry migration manifest. */
  sourceRegistrySha256: string
  startedAt: string
}): LegacyMemoryMigrationPlan {
  if (!nonEmpty(input.migrationId) || !nonEmpty(input.startedAt) ||
    !SHA256_PATTERN.test(input.sourceRegistrySha256)) {
    throw new LegacyMemoryMigrationError('INVALID_INPUT')
  }
  const sourceDbPath = canonicalAbsolutePath(input.sourceDbPath)
  const stagingRoot = canonicalAbsolutePath(input.stagingRoot)
  if (sourceDbPath === stagingRoot || sourceDbPath.startsWith(stagingRoot + '/')) {
    throw new LegacyMemoryMigrationError('UNSAFE_PATH')
  }
  const source = readSource(sourceDbPath)
  const sourceDbSha256 = sha256(source.image)
  const candidate = buildCandidate({
    sourceSha256: sourceDbSha256,
    migrationId: input.migrationId,
    startedAt: input.startedAt,
    facts: source.facts,
    forgotten: source.forgotten,
  })
  const runDirectory = resolve(
    stagingRoot,
    `memory-${sha256(input.migrationId).slice(0, 32)}`,
  )
  const manifestPath = memoryMigrationManifestPath(stagingRoot, input.migrationId)
  const backup = artifact(resolve(runDirectory, 'memory-v1.backup.sqlite'), source.image)
  const ledger = artifact(
    resolve(runDirectory, 'protected-ledger-v2.candidate.sqlite'),
    candidate.image,
  )
  const factFiles = candidate.files
    .map((file) => artifact(resolve(runDirectory, file.relativePath), file.content))
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))
  const manifest = validateLegacyMemoryMigrationManifest({
    version: 1,
    migrationId: input.migrationId,
    cohort: {
      registryMigrationId: input.migrationId,
      sourceRegistrySha256: input.sourceRegistrySha256,
    },
    phase: 'PREPARED',
    sourceDbPath,
    sourceDbSha256,
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
    scope: { kind: 'global', scopeId: 'global' },
    counts: {
      facts: source.facts.length,
      forgotten: source.forgotten.length,
      published: factFiles.length,
    },
    backup: publicArtifact(backup),
    ledger: publicArtifact(ledger),
    factFiles: factFiles.map(publicArtifact),
  }, manifestPath)
  return { manifestPath, runDirectory, manifest, backup, ledger, factFiles }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function writeAtomicManifest(path: string, manifest: LegacyMemoryMigrationManifest): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporary, manifestBytes(manifest), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  syncPath(temporary)
  renameSync(temporary, path)
  syncPath(dirname(path))
}

function writeArtifactExclusive(item: PlannedArtifact): void {
  writeFileSync(item.path, item.content, { flag: 'wx', mode: 0o600 })
  syncPath(item.path)
}

function ensureArtifact(item: PlannedArtifact): void {
  if (!existsSync(item.path)) {
    writeArtifactExclusive(item)
    return
  }
  const stat = lstatSync(item.path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
    realpathSync(item.path) !== item.path || (stat.mode & 0o077) !== 0 ||
    !readFileSync(item.path).equals(item.content)) {
    throw new LegacyMemoryMigrationError('ARTIFACT_TAMPERED')
  }
}

function sourceStillMatches(plan: LegacyMemoryMigrationPlan): void {
  const current = readSource(plan.manifest.sourceDbPath)
  if (sha256(current.image) !== plan.manifest.sourceDbSha256) {
    throw new LegacyMemoryMigrationError('SOURCE_CHANGED')
  }
}

function verifyArtifacts(plan: LegacyMemoryMigrationPlan): void {
  for (const item of [plan.backup, plan.ledger, ...plan.factFiles]) {
    const stat = lstatSync(item.path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      realpathSync(item.path) !== item.path || (stat.mode & 0o077) !== 0) {
      throw new LegacyMemoryMigrationError('ARTIFACT_TAMPERED')
    }
    const bytes = readFileSync(item.path)
    if (bytes.byteLength !== item.bytes || sha256(bytes) !== item.sha256) {
      throw new LegacyMemoryMigrationError('ARTIFACT_TAMPERED')
    }
  }
  verifyLegacyMemoryMigrationCandidate(plan.ledger.path, plan.manifest)
}

function samePlan(
  durable: LegacyMemoryMigrationManifest,
  planned: LegacyMemoryMigrationManifest,
): boolean {
  const normalized = { ...durable, phase: 'PREPARED', updatedAt: planned.startedAt }
  return JSON.stringify(normalized) === JSON.stringify(planned)
}

function assertPlanIsSelfConsistent(plan: LegacyMemoryMigrationPlan): void {
  const manifest = validateLegacyMemoryMigrationManifest(plan.manifest, plan.manifestPath)
  const expectedRun = dirname(manifest.backup.path)
  const plannedArtifacts = [plan.backup, plan.ledger, ...plan.factFiles]
  const manifestArtifacts = [manifest.backup, manifest.ledger, ...manifest.factFiles]
  if (plan.runDirectory !== expectedRun || plannedArtifacts.length !== manifestArtifacts.length) {
    throw new LegacyMemoryMigrationError('MANIFEST_MISMATCH')
  }
  for (let index = 0; index < plannedArtifacts.length; index++) {
    const planned = plannedArtifacts[index]!
    const declared = manifestArtifacts[index]!
    if (planned.path !== declared.path || planned.sha256 !== declared.sha256 ||
      planned.bytes !== declared.bytes || planned.content.byteLength !== declared.bytes ||
      sha256(planned.content) !== declared.sha256) {
      throw new LegacyMemoryMigrationError('MANIFEST_MISMATCH')
    }
  }
}

function advanceManifest(
  current: LegacyMemoryMigrationManifest,
  phase: LegacyMemoryMigrationPhase,
  nowIso: () => string,
): LegacyMemoryMigrationManifest {
  const next = { ...cloneManifest(current), phase, updatedAt: nowIso() }
  return next
}

function writePlannedArtifacts(plan: LegacyMemoryMigrationPlan): void {
  for (const directory of [
    resolve(plan.runDirectory, 'memory'),
    resolve(plan.runDirectory, 'memory/facts'),
  ]) {
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 })
    assertSecureDirectory(directory)
  }
  for (const item of [plan.backup, plan.ledger, ...plan.factFiles]) ensureArtifact(item)
  syncPath(resolve(plan.runDirectory, 'memory/facts'))
  syncPath(resolve(plan.runDirectory, 'memory'))
  syncPath(plan.runDirectory)
}

/**
 * Creates and verifies only a reversible migration candidate. No function in
 * this module can install the ledger or enable v2 memory writes.
 */
export function prepareLegacyMemoryV1Migration(
  plan: LegacyMemoryMigrationPlan,
  nowIso: () => string,
): LegacyMemoryMigrationManifest {
  assertPlanIsSelfConsistent(plan)
  sourceStillMatches(plan)
  if (existsSync(plan.manifestPath)) {
    throw new LegacyMemoryMigrationError('MIGRATION_ALREADY_EXISTS')
  }
  if (!existsSync(dirname(plan.manifestPath))) {
    mkdirSync(dirname(plan.manifestPath), { recursive: true, mode: 0o700 })
  }
  assertSecureDirectory(dirname(plan.manifestPath))
  try {
    mkdirSync(plan.runDirectory, { mode: 0o700 })
  } catch {
    throw new LegacyMemoryMigrationError('STAGING_EXISTS')
  }
  assertSecureDirectory(plan.runDirectory)
  writeAtomicManifest(plan.manifestPath, plan.manifest)
  writePlannedArtifacts(plan)
  let manifest = advanceManifest(plan.manifest, 'COPIED', nowIso)
  writeAtomicManifest(plan.manifestPath, manifest)
  verifyArtifacts(plan)
  sourceStillMatches(plan)
  manifest = advanceManifest(manifest, 'VERIFIED', nowIso)
  writeAtomicManifest(plan.manifestPath, manifest)
  return cloneManifest(manifest)
}

export function resumeLegacyMemoryV1MigrationPreparation(input: {
  sourceDbPath: string
  manifestPath: string
  nowIso: () => string
}): LegacyMemoryMigrationManifest {
  // Reject a symlinked manifest before canonicalisation: resolving first would
  // follow the link and then validate its target as if it were the real manifest.
  if (existsSync(input.manifestPath)) assertRegularPrivateSource(input.manifestPath)
  const manifestPath = canonicalAbsolutePath(input.manifestPath)
  let durable: LegacyMemoryMigrationManifest
  try {
    durable = validateLegacyMemoryMigrationManifest(
      JSON.parse(readFileSync(manifestPath, 'utf8')) as LegacyMemoryMigrationManifest,
      manifestPath,
    )
  } catch (error) {
    if (error instanceof LegacyMemoryMigrationError) throw error
    throw new LegacyMemoryMigrationError('MANIFEST_CORRUPT')
  }
  const plan = planLegacyMemoryV1Migration({
    sourceDbPath: input.sourceDbPath,
    stagingRoot: dirname(manifestPath),
    migrationId: durable.migrationId,
    sourceRegistrySha256: durable.cohort.sourceRegistrySha256,
    startedAt: durable.startedAt,
  })
  if (plan.manifestPath !== manifestPath || !samePlan(durable, plan.manifest)) {
    throw new LegacyMemoryMigrationError('MANIFEST_MISMATCH')
  }
  sourceStillMatches(plan)
  if (durable.phase === 'VERIFIED') {
    verifyArtifacts(plan)
    return durable
  }
  if (durable.phase !== 'PREPARED' && durable.phase !== 'COPIED') {
    throw new LegacyMemoryMigrationError('PHASE_NOT_PREPARABLE')
  }
  assertSecureDirectory(plan.runDirectory)
  if (durable.phase === 'PREPARED') {
    writePlannedArtifacts(plan)
    durable = advanceManifest(durable, 'COPIED', input.nowIso)
    writeAtomicManifest(manifestPath, durable)
  }
  verifyArtifacts(plan)
  sourceStillMatches(plan)
  durable = advanceManifest(durable, 'VERIFIED', input.nowIso)
  writeAtomicManifest(manifestPath, durable)
  return cloneManifest(durable)
}

/**
 * Read-only verification for an already VERIFIED legacy-memory bundle.
 * Unlike resumeLegacyMemoryV1MigrationPreparation, this entry point can never
 * create artifacts or advance the manifest.
 */
export function verifyLegacyMemoryMigrationBundle(input: {
  sourceDbPath: string
  manifestPath: string
  /**
   * Cohort the caller already validated (ADR-0070). This function re-reads the
   * manifest from disk, so without it a file swapped between the two reads would
   * pass verification while belonging to a different registry preparation.
   */
  expectedCohort?: { registryMigrationId: string; sourceRegistrySha256: string }
}): LegacyMemoryMigrationManifest {
  // Reject a symlinked manifest before canonicalisation: resolving first would
  // follow the link and then validate its target as if it were the real manifest.
  if (existsSync(input.manifestPath)) assertRegularPrivateSource(input.manifestPath)
  const manifestPath = canonicalAbsolutePath(input.manifestPath)
  let durable: LegacyMemoryMigrationManifest
  try {
    durable = validateLegacyMemoryMigrationManifest(
      JSON.parse(readFileSync(manifestPath, 'utf8')) as LegacyMemoryMigrationManifest,
      manifestPath,
    )
  } catch (error) {
    if (error instanceof LegacyMemoryMigrationError) throw error
    throw new LegacyMemoryMigrationError('MANIFEST_CORRUPT')
  }
  if (durable.phase !== 'VERIFIED') {
    throw new LegacyMemoryMigrationError('PHASE_NOT_PREPARABLE')
  }
  if (input.expectedCohort !== undefined &&
    (durable.cohort.registryMigrationId !== input.expectedCohort.registryMigrationId ||
      durable.cohort.sourceRegistrySha256 !== input.expectedCohort.sourceRegistrySha256)) {
    throw new LegacyMemoryMigrationError('MANIFEST_MISMATCH')
  }
  const plan = planLegacyMemoryV1Migration({
    sourceDbPath: input.sourceDbPath,
    stagingRoot: dirname(manifestPath),
    migrationId: durable.migrationId,
    sourceRegistrySha256: durable.cohort.sourceRegistrySha256,
    startedAt: durable.startedAt,
  })
  if (plan.manifestPath !== manifestPath || !samePlan(durable, plan.manifest)) {
    throw new LegacyMemoryMigrationError('MANIFEST_MISMATCH')
  }
  sourceStillMatches(plan)
  verifyArtifacts(plan)
  return cloneManifest(durable)
}

export function verifyLegacyMemoryMigrationCandidate(
  ledgerPath: string,
  manifest: LegacyMemoryMigrationManifest,
): void {
  const source = readSource(manifest.backup.path)
  if (sha256(source.image) !== manifest.sourceDbSha256) {
    throw new LegacyMemoryMigrationError('LEDGER_CORRUPT')
  }
  const db = new Database(ledgerPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (integrity[0]?.integrity_check !== 'ok' ||
      !sameColumns(tableColumns(db, 'ledger_control'), [
        'singleton', 'schema_version', 'operator_id', 'profile_id',
        'scope_kind', 'scope_id', 'project_id', 'source_sha256', 'migration_id',
        'started_at', 'forget_count', 'forget_head_hash',
      ]) ||
      !sameColumns(tableColumns(db, 'facts'), [
        'rowid',
        'operation_id',
        ...SOURCE_FACT_COLUMNS.slice(1),
        'published',
        'source_path',
        'content_hash',
      ]) || !sameColumns(tableColumns(db, 'do_not_remember'), [
        'rowid', 'operation_id', ...SOURCE_FORGET_COLUMNS.slice(1),
      ]) || !sameColumns(tableColumns(db, 'memory_publication_wal'), [
        'operation_id', 'scope_id', 'phase', 'wal_json', 'wal_hash',
      ]) || !sameColumns(tableColumns(db, 'audit_outbox'), [
        'event_id', 'event_json', 'event_hash', 'delivered',
      ]) || !sameColumns(tableColumns(db, 'memory_deletion_wal'), [
        'operation_id', 'scope_id', 'phase', 'wal_json', 'wal_hash',
      ]) || !sameColumns(tableColumns(db, 'memory_deletion_audit_outbox'), [
        'event_id', 'event_json', 'event_hash', 'delivered',
      ]) || !sameColumns(tableColumns(db, 'memory_update_wal'), [
        'operation_id', 'scope_id', 'phase', 'wal_json', 'wal_hash',
      ]) || !sameColumns(tableColumns(db, 'memory_update_audit_outbox'), [
        'event_id', 'event_json', 'event_hash', 'delivered',
      ]) ||
      tableColumns(db, 'fts').length !== 0) {
      throw new LegacyMemoryMigrationError('LEDGER_CORRUPT')
    }
    const control = db.prepare('SELECT * FROM ledger_control WHERE singleton = 1').get() as
      | {
        schema_version: number
        operator_id: string | null
        profile_id: string | null
        scope_kind: string
        scope_id: string
        project_id: string | null
        source_sha256: string
        migration_id: string
        started_at: string
        forget_count: number
        forget_head_hash: string
      }
      | undefined
    if (!control || control.schema_version !== 2 || control.operator_id !== null ||
      control.profile_id !== null || control.scope_kind !== 'global' ||
      control.scope_id !== 'global' || control.project_id !== null ||
      control.source_sha256 !== manifest.sourceDbSha256 ||
      control.migration_id !== manifest.migrationId || control.started_at !== manifest.startedAt ||
      control.forget_count !== manifest.counts.forgotten ||
      (db.prepare('SELECT count(*) AS count FROM facts').get() as { count: number }).count !==
        manifest.counts.facts ||
      (db.prepare('SELECT count(*) AS count FROM do_not_remember').get() as { count: number }).count !==
        manifest.counts.forgotten ||
      (db.prepare('SELECT count(*) AS count FROM facts WHERE published = 1').get() as { count: number }).count !==
        manifest.counts.published ||
      (db.prepare('SELECT count(*) AS count FROM memory_publication_wal').get() as { count: number }).count !== 0 ||
      (db.prepare('SELECT count(*) AS count FROM audit_outbox').get() as { count: number }).count !== 0 ||
      (db.prepare('SELECT count(*) AS count FROM memory_deletion_wal').get() as { count: number }).count !== 0 ||
      (db.prepare('SELECT count(*) AS count FROM memory_deletion_audit_outbox').get() as
        { count: number }).count !== 0 ||
      (db.prepare('SELECT count(*) AS count FROM memory_update_wal').get() as
        { count: number }).count !== 0 ||
      (db.prepare('SELECT count(*) AS count FROM memory_update_audit_outbox').get() as
        { count: number }).count !== 0) {
      throw new LegacyMemoryMigrationError('LEDGER_CORRUPT')
    }
    const facts = db.prepare('SELECT * FROM facts ORDER BY rowid').all() as Array<
      SourceFactRow & {
        operation_id: string | null
        published: number
        source_path: string | null
        content_hash: string | null
      }
    >
    const forgotten = db.prepare(
      'SELECT * FROM do_not_remember ORDER BY rowid',
    ).all() as Array<SourceForgetRow & { operation_id: string | null }>
    facts.forEach(validateSourceFact)
    forgotten.forEach(validateSourceForget)
    verifyForgetChain(forgotten)
    if (control.forget_head_hash !== (forgotten.at(-1)?.row_hash ?? 'genesis') ||
      forgotten.some((row) => row.operation_id !== null)) {
      throw new LegacyMemoryMigrationError('LEDGER_CORRUPT')
    }
    const ledgerSourceFacts = facts.map((row): SourceFactRow => ({
      rowid: row.rowid,
      id: row.id,
      text: row.text,
      fact_key: row.fact_key,
      key_tokens: row.key_tokens,
      valid_at: row.valid_at,
      invalid_at: row.invalid_at,
      is_human_confirmed: row.is_human_confirmed,
      source_authority: row.source_authority,
      confidence: row.confidence,
      provenance: row.provenance,
      supersedes: row.supersedes,
      contradicts: row.contradicts,
      extends_key: row.extends_key,
    }))
    const ledgerSourceForgotten = forgotten.map(({ operation_id: _operationId, ...row }) => row)
    if (JSON.stringify(ledgerSourceFacts) !== JSON.stringify(source.facts) ||
      JSON.stringify(ledgerSourceForgotten) !== JSON.stringify(source.forgotten)) {
      throw new LegacyMemoryMigrationError('LEDGER_CORRUPT')
    }
    const forgottenKeys = new Set(forgotten.map((row) => row.fact_key))
    for (const row of facts) {
      if (row.operation_id !== null) throw new LegacyMemoryMigrationError('LEDGER_CORRUPT')
      const shouldPublish = row.invalid_at === null && !forgottenKeys.has(row.fact_key)
      if ((row.published === 1) !== shouldPublish ||
        (row.published !== 0 && row.published !== 1)) {
        throw new LegacyMemoryMigrationError('LEDGER_CORRUPT')
      }
      if (shouldPublish) {
        if (!nonEmpty(row.source_path) || !SHA256_PATTERN.test(row.content_hash ?? '') ||
          row.source_path.includes('..') || isAbsolute(row.source_path)) {
          throw new LegacyMemoryMigrationError('LEDGER_CORRUPT')
        }
        const canonicalFile = resolve(dirname(ledgerPath), row.source_path)
        if (!canonicalFile.startsWith(resolve(dirname(ledgerPath), 'memory/facts') + '/')) {
          throw new LegacyMemoryMigrationError('LEDGER_CORRUPT')
        }
        const bytes = readFileSync(canonicalFile)
        if (sha256(bytes) !== row.content_hash || bytes.toString('utf8') !== row.text) {
          throw new LegacyMemoryMigrationError('LEDGER_CORRUPT')
        }
      } else if (row.source_path !== null || row.content_hash !== null) {
        throw new LegacyMemoryMigrationError('LEDGER_CORRUPT')
      }
    }
  } catch (error) {
    if (error instanceof LegacyMemoryMigrationError) throw error
    throw new LegacyMemoryMigrationError('LEDGER_CORRUPT')
  } finally {
    db.close()
  }
}
