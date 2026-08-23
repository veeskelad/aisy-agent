import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LegacyMemoryMigrationError,
  planLegacyMemoryV1Migration,
  prepareLegacyMemoryV1Migration,
  resumeLegacyMemoryV1MigrationPreparation,
  verifyLegacyMemoryMigrationBundle,
  verifyLegacyMemoryMigrationCandidate,
} from './legacy-memory-migration.js'

const roots: string[] = []

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aisy-memory-migration-'))
  roots.push(root)
  chmodSync(root, 0o700)
  const sourceDbPath = join(root, 'memory-v1.sqlite')
  const stagingRoot = join(root, 'staging')
  const db = new Database(sourceDbPath)
  db.exec(`
    CREATE TABLE facts (
      rowid INTEGER PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      text TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      key_tokens TEXT NOT NULL,
      valid_at TEXT NOT NULL,
      invalid_at TEXT,
      is_human_confirmed INTEGER NOT NULL DEFAULT 0,
      source_authority INTEGER,
      confidence REAL,
      provenance TEXT NOT NULL DEFAULT '',
      supersedes TEXT,
      contradicts TEXT,
      extends_key TEXT
    );
    CREATE INDEX idx_facts_key ON facts(fact_key);
    CREATE VIRTUAL TABLE fts USING fts5(text);
    CREATE TABLE do_not_remember (
      rowid INTEGER PRIMARY KEY,
      fact_key TEXT NOT NULL,
      key_tokens TEXT NOT NULL,
      reason TEXT NOT NULL,
      is_human_confirmed INTEGER NOT NULL,
      ts TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      row_hash TEXT NOT NULL
    );
  `)
  const liveKey = sha256('live')
  const tombstoneKey = sha256('tombstone')
  const forgottenKey = sha256('forgotten')
  const insertFact = db.prepare(`
    INSERT INTO facts (
      rowid, id, text, fact_key, key_tokens, valid_at, invalid_at,
      is_human_confirmed, source_authority, confidence, provenance,
      supersedes, contradicts, extends_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insertFact.run(
    1, 'fact-live', 'Живой канонический факт', liveKey, 'live',
    '2026-07-27T00:00:00.000Z', null, 1, 9, 0.95, 'journal:event-1',
    tombstoneKey, forgottenKey, 'extension-key',
  )
  insertFact.run(
    2, 'fact-tombstone', 'Исторический tombstone', tombstoneKey, 'tombstone',
    '2026-07-26T00:00:00.000Z', '2026-07-27T00:00:00.000Z', 0, null, null,
    'journal:event-2', null, null, null,
  )
  insertFact.run(
    3, 'fact-forgotten', 'Забытый факт', forgottenKey, 'forgotten',
    '2026-07-25T00:00:00.000Z', null, 1, 5, 0.5,
    'journal:event-3', null, null, null,
  )
  db.prepare('INSERT INTO fts(rowid, text) VALUES (?, ?)').run(1, 'Живой канонический факт')
  db.prepare('INSERT INTO fts(rowid, text) VALUES (?, ?)').run(3, 'Забытый факт')
  const ts = '2026-07-27T01:00:00.000Z'
  const rowHash = sha256(`genesis‖${forgottenKey}‖forgotten‖operator request‖${ts}`)
  db.prepare(`
    INSERT INTO do_not_remember (
      rowid, fact_key, key_tokens, reason, is_human_confirmed, ts, prev_hash, row_hash
    ) VALUES (1, ?, 'forgotten', 'operator request', 1, ?, 'genesis', ?)
  `).run(forgottenKey, ts, rowHash)
  db.close()
  chmodSync(sourceDbPath, 0o600)
  return { root, sourceDbPath, stagingRoot, liveKey, tombstoneKey, forgottenKey }
}

function planFor(value: ReturnType<typeof fixture>) {
  return planLegacyMemoryV1Migration({
    sourceDbPath: value.sourceDbPath,
    stagingRoot: value.stagingRoot,
    migrationId: 'memory-migration-1',
    // ADR-0070: the memory run belongs to the registry migration cohort of the same id.
    sourceRegistrySha256: 'f'.repeat(64),
    startedAt: '2026-07-27T02:00:00.000Z',
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Vitest owns these isolated temporary fixtures; recursive cleanup cannot
    // reach outside the mkdtemp-created root.
    rmSync(root, { recursive: true, force: true })
  }
})

describe('legacy memory v1 migration preparation', () => {
  it('preserves every legacy field and forget row without copying the derived FTS table', () => {
    const value = fixture()
    const plan = planFor(value)
    const sourceBefore = readFileSync(value.sourceDbPath)
    let tick = 0

    const manifest = prepareLegacyMemoryV1Migration(
      plan,
      () => `2026-07-27T02:00:0${++tick}.000Z`,
    )

    expect(manifest.phase).toBe('VERIFIED')
    expect(manifest.counts).toEqual({ facts: 3, forgotten: 1, published: 1 })
    expect(readFileSync(value.sourceDbPath)).toEqual(sourceBefore)
    expect(readFileSync(plan.backup.path)).toEqual(plan.backup.content)
    const ledger = new Database(plan.ledger.path, { readonly: true })
    const facts = ledger.prepare('SELECT * FROM facts ORDER BY rowid').all() as Array<{
      id: string
      provenance: string
      supersedes: string | null
      contradicts: string | null
      extends_key: string | null
      published: number
      source_path: string | null
    }>
    const tables = ledger.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>
    const forgetRows = ledger.prepare('SELECT * FROM do_not_remember').all()
    ledger.close()
    expect(facts).toEqual([
      expect.objectContaining({
        id: 'fact-live',
        provenance: 'journal:event-1',
        supersedes: value.tombstoneKey,
        contradicts: value.forgottenKey,
        extends_key: 'extension-key',
        published: 1,
      }),
      expect.objectContaining({ id: 'fact-tombstone', published: 0, source_path: null }),
      expect.objectContaining({ id: 'fact-forgotten', published: 0, source_path: null }),
    ])
    expect(forgetRows).toHaveLength(1)
    expect(tables.some((row) => row.name === 'fts')).toBe(false)
    expect(readFileSync(plan.factFiles[0]!.path, 'utf8')).toBe('Живой канонический факт')
    expect(statSync(plan.ledger.path).mode & 0o777).toBe(0o600)
    expect(statSync(plan.runDirectory).mode & 0o777).toBe(0o700)
  })

  it('resumes from a durable PREPARED manifest after a restart and creates missing artifacts', () => {
    const value = fixture()
    const plan = planFor(value)
    mkdirSync(value.stagingRoot, { mode: 0o700 })
    mkdirSync(plan.runDirectory, { mode: 0o700 })
    mkdirSync(join(plan.runDirectory, 'memory'), { mode: 0o700 })
    mkdirSync(join(plan.runDirectory, 'memory/facts'), { mode: 0o700 })
    writeFileSync(plan.manifestPath, JSON.stringify(plan.manifest, null, 2) + '\n', {
      mode: 0o600,
    })

    const resumed = resumeLegacyMemoryV1MigrationPreparation({
      sourceDbPath: value.sourceDbPath,
      manifestPath: plan.manifestPath,
      nowIso: () => '2026-07-27T02:10:00.000Z',
    })

    expect(resumed.phase).toBe('VERIFIED')
    expect(readFileSync(plan.ledger.path)).toEqual(plan.ledger.content)
    verifyLegacyMemoryMigrationCandidate(plan.ledger.path, resumed)
  })

  it('revalidates a VERIFIED bundle on restart and fails closed on canonical-file tampering', () => {
    const value = fixture()
    const plan = planFor(value)
    prepareLegacyMemoryV1Migration(plan, () => '2026-07-27T02:01:00.000Z')
    writeFileSync(plan.factFiles[0]!.path, 'tampered')

    expect(() => resumeLegacyMemoryV1MigrationPreparation({
      sourceDbPath: value.sourceDbPath,
      manifestPath: plan.manifestPath,
      nowIso: () => '2026-07-27T02:02:00.000Z',
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_TAMPERED' }))
  })

  it('revalidates a VERIFIED bundle through the read-only inspector', () => {
    const value = fixture()
    const plan = planFor(value)
    prepareLegacyMemoryV1Migration(plan, () => '2026-07-27T02:01:00.000Z')

    const manifest = verifyLegacyMemoryMigrationBundle({
      sourceDbPath: value.sourceDbPath,
      manifestPath: plan.manifestPath,
    })

    expect(manifest.phase).toBe('VERIFIED')
  })

  it('refuses a bundle whose cohort disagrees with the one the caller already proved', () => {
    const value = fixture()
    const plan = planFor(value)
    prepareLegacyMemoryV1Migration(plan, () => '2026-07-27T02:01:00.000Z')

    // The verifier re-reads the manifest from disk; a file swapped after the caller's
    // own cohort check must not pass as a verified bundle (ADR-0070).
    expect(() => verifyLegacyMemoryMigrationBundle({
      sourceDbPath: value.sourceDbPath,
      manifestPath: plan.manifestPath,
      expectedCohort: { registryMigrationId: 'memory-migration-1', sourceRegistrySha256: 'a'.repeat(64) },
    })).toThrowError(expect.objectContaining({ code: 'MANIFEST_MISMATCH' }))

    // The cohort actually written by the plan still verifies.
    expect(verifyLegacyMemoryMigrationBundle({
      sourceDbPath: value.sourceDbPath,
      manifestPath: plan.manifestPath,
      expectedCohort: plan.manifest.cohort,
    }).phase).toBe('VERIFIED')
  })

  it('refuses a manifest reached through a symlink out of private staging', () => {
    const value = fixture()
    const plan = planFor(value)
    prepareLegacyMemoryV1Migration(plan, () => '2026-07-27T02:01:00.000Z')

    // Same basename, different directory — the shape that would otherwise re-anchor
    // the whole bundle outside private staging.
    const outside = join(value.root, 'outside')
    mkdirSync(outside, { mode: 0o700 })
    const elsewhere = join(outside, basename(plan.manifestPath))
    renameSync(plan.manifestPath, elsewhere)
    symlinkSync(elsewhere, plan.manifestPath)

    expect(() => verifyLegacyMemoryMigrationBundle({
      sourceDbPath: value.sourceDbPath,
      manifestPath: plan.manifestPath,
    })).toThrowError(expect.objectContaining({ code: 'UNSAFE_PATH' }))
  })

  it('fails read-only bundle verification after backup tampering', () => {
    const value = fixture()
    const plan = planFor(value)
    prepareLegacyMemoryV1Migration(plan, () => '2026-07-27T02:01:00.000Z')
    writeFileSync(plan.backup.path, 'tampered', { mode: 0o600 })

    expect(() => verifyLegacyMemoryMigrationBundle({
      sourceDbPath: value.sourceDbPath,
      manifestPath: plan.manifestPath,
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_TAMPERED' }))
  })

  it('refuses a stale plan before creating staging artifacts', () => {
    const value = fixture()
    const plan = planFor(value)
    const db = new Database(value.sourceDbPath)
    db.prepare(`
      INSERT INTO facts (
        rowid, id, text, fact_key, key_tokens, valid_at, invalid_at,
        is_human_confirmed, source_authority, confidence, provenance,
        supersedes, contradicts, extends_key
      ) VALUES (4, 'new', 'new', ?, 'new', 'now', NULL, 0, NULL, NULL, '', NULL, NULL, NULL)
    `).run(sha256('new'))
    db.close()

    expect(() => prepareLegacyMemoryV1Migration(plan, () => 'later')).toThrowError(
      expect.objectContaining({ code: 'SOURCE_CHANGED' }),
    )
    expect(() => statSync(plan.manifestPath)).toThrow()
  })

  it('refuses a tampered legacy forget chain before planning any publication', () => {
    const value = fixture()
    const db = new Database(value.sourceDbPath)
    db.prepare("UPDATE do_not_remember SET reason = 'changed'").run()
    db.close()

    expect(() => planFor(value)).toThrowError(
      expect.objectContaining({ code: 'FORGET_CHAIN_TAMPERED' }),
    )
  })

  it('rejects unknown legacy columns instead of silently dropping data', () => {
    const value = fixture()
    const db = new Database(value.sourceDbPath)
    db.exec('ALTER TABLE facts ADD COLUMN future_field TEXT')
    db.close()

    expect(() => planFor(value)).toThrowError(
      expect.objectContaining({ code: 'SOURCE_SCHEMA_UNSUPPORTED' }),
    )
  })

  it('refuses to copy a legacy database readable by group or other users', () => {
    const value = fixture()
    chmodSync(value.sourceDbPath, 0o644)

    expect(() => planFor(value)).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_PATH' }),
    )
  })

  it('never overwrites a pre-existing migration manifest', () => {
    const value = fixture()
    const plan = planFor(value)
    mkdirSync(value.stagingRoot, { mode: 0o700 })
    writeFileSync(plan.manifestPath, 'existing', { mode: 0o600 })

    expect(() => prepareLegacyMemoryV1Migration(plan, () => 'later')).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_ALREADY_EXISTS' }),
    )
  })

  it('rejects a caller-mutated artifact path before any write', () => {
    const value = fixture()
    const plan = planFor(value)
    plan.ledger.path = join(value.root, 'escaped.sqlite')

    expect(() => prepareLegacyMemoryV1Migration(plan, () => 'later')).toThrowError(
      expect.objectContaining({ code: 'MANIFEST_MISMATCH' }),
    )
    expect(() => statSync(join(value.root, 'escaped.sqlite'))).toThrow()
  })

  it('fails semantic verification if a published file no longer matches its ledger hash', () => {
    const value = fixture()
    const plan = planFor(value)
    const manifest = prepareLegacyMemoryV1Migration(plan, () => 'later')
    unlinkSync(plan.factFiles[0]!.path)
    writeFileSync(plan.factFiles[0]!.path, 'replacement', { mode: 0o600 })

    expect(() => verifyLegacyMemoryMigrationCandidate(plan.ledger.path, manifest)).toThrow(
      LegacyMemoryMigrationError,
    )
  })
})
