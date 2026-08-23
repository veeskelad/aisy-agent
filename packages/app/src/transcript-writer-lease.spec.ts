import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { makeNodeSessionTranscriptPersistence } from './session-transcript-store.js'
import {
  acquireTranscriptWriterLease,
  inspectTranscriptWriterLease,
  TRANSCRIPT_WRITER_LEASE_DB_FILENAME,
  TRANSCRIPT_WRITER_LEASE_ROOT_DIRNAME,
  TRANSCRIPT_WRITER_LOCK_DIRNAME,
  TranscriptWriterLeaseError,
} from './transcript-writer-lease.js'

const roots: string[] = []

function root(): string {
  const created = mkdtempSync(join(tmpdir(), 'aisy-writer-lease-'))
  roots.push(created)
  return created
}

function leaseDb(home: string): string {
  return join(home, TRANSCRIPT_WRITER_LEASE_ROOT_DIRNAME, TRANSCRIPT_WRITER_LEASE_DB_FILENAME)
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('transcript writer SQLite lease (ADR-0068)', () => {
  it('publishes the exact private DB, anchor and permanent legacy barrier', () => {
    const home = root()
    const lease = acquireTranscriptWriterLease({ root: home })
    const dbPath = lease.identity.path
    const anchorPath = dbPath + '.identity.json'
    const barrierPath = join(home, TRANSCRIPT_WRITER_LOCK_DIRNAME)

    expect(dbPath).toMatch(/\/\.transcript-writer-lease\/transcript-writer-lease\.sqlite3$/)
    expect(lstatSync(join(home, TRANSCRIPT_WRITER_LEASE_ROOT_DIRNAME)).mode & 0o777).toBe(0o700)
    expect(lstatSync(dbPath).mode & 0o777).toBe(0o600)
    expect(lstatSync(dbPath).nlink).toBe(1)
    expect(lstatSync(anchorPath).mode & 0o777).toBe(0o600)
    expect(lstatSync(anchorPath).nlink).toBe(1)
    expect(lstatSync(barrierPath).isFile()).toBe(true)
    expect(lstatSync(barrierPath).mode & 0o777).toBe(0o600)
    expect(lstatSync(barrierPath).nlink).toBe(1)
    expect(JSON.parse(readFileSync(barrierPath, 'utf8'))).toEqual({
      version: 1,
      kind: 'transcript-writer-sqlite-v1',
      databaseId: lease.identity.databaseId,
      dev: lease.identity.dev,
      ino: lease.identity.ino,
    })
    lease.release()

    const db = new Database(dbPath, { readonly: true })
    try {
      expect(db.pragma('application_id', { simple: true })).toBe(0x41495359)
      expect(db.pragma('user_version', { simple: true })).toBe(1)
      expect(db.prepare(
        'SELECT role, schema_version, database_id FROM lease_meta WHERE singleton=1',
      ).get()).toEqual({
        role: 'transcript-writer',
        schema_version: 1,
        database_id: lease.identity.databaseId,
      })
    } finally {
      db.close()
    }
    expect(existsSync(barrierPath)).toBe(true)
  })

  it('grants one holder, preserves the barrier on release and admits the next holder', () => {
    const home = root()
    const first = acquireTranscriptWriterLease({ root: home })
    expect(() => acquireTranscriptWriterLease({ root: home }))
      .toThrowError(expect.objectContaining({ reason: 'held-by-another-process' }))
    first.assertOwned()
    first.release()

    expect(inspectTranscriptWriterLease({ root: home })).toEqual({ state: 'absent' })
    const second = acquireTranscriptWriterLease({ root: home })
    expect(second.identity).toEqual(first.identity)
    second.release()
    expect(lstatSync(join(home, TRANSCRIPT_WRITER_LOCK_DIRNAME)).isFile()).toBe(true)
  })

  it.each([
    ['empty directory', (path: string) => mkdirSync(path, { mode: 0o700 })],
    ['owner directory', (path: string) => {
      mkdirSync(path, { mode: 0o700 })
      writeFileSync(join(path, 'owner.json'), '{}', { mode: 0o600 })
    }],
  ])('refuses legacy %s before creating any v2 state', (_name, makeLegacy) => {
    const home = root()
    const legacy = join(home, TRANSCRIPT_WRITER_LOCK_DIRNAME)
    makeLegacy(legacy)

    expect(() => acquireTranscriptWriterLease({ root: home }))
      .toThrowError(expect.objectContaining({ reason: 'legacy-residue' }))
    expect(existsSync(join(home, TRANSCRIPT_WRITER_LEASE_ROOT_DIRNAME))).toBe(false)
    expect(lstatSync(legacy).isDirectory()).toBe(true)
  })

  it('refuses unsafe legacy symlinks and hardlinks without deleting them', () => {
    const symlinkHome = root()
    const target = join(symlinkHome, 'target')
    writeFileSync(target, 'foreign', { mode: 0o600 })
    const linked = join(symlinkHome, TRANSCRIPT_WRITER_LOCK_DIRNAME)
    symlinkSync(target, linked)
    expect(() => acquireTranscriptWriterLease({ root: symlinkHome }))
      .toThrowError(expect.objectContaining({ reason: 'lease-unsafe' }))
    expect(lstatSync(linked).isSymbolicLink()).toBe(true)

    const hardlinkHome = root()
    const foreign = join(hardlinkHome, 'foreign')
    const barrier = join(hardlinkHome, TRANSCRIPT_WRITER_LOCK_DIRNAME)
    writeFileSync(foreign, '{}\n', { mode: 0o600 })
    linkSync(foreign, barrier)
    expect(() => acquireTranscriptWriterLease({ root: hardlinkHome }))
      .toThrowError(expect.objectContaining({ reason: 'lease-unsafe' }))
    expect(lstatSync(foreign).nlink).toBe(2)
  })

  it('makes the permanent barrier reject the legacy mkdir protocol', () => {
    const home = root()
    const lease = acquireTranscriptWriterLease({ root: home })
    lease.release()
    expect(() => mkdirSync(join(home, TRANSCRIPT_WRITER_LOCK_DIRNAME), { mode: 0o700 }))
      .toThrowError(expect.objectContaining({ code: 'EEXIST' }))
  })

  it('recovers only the exact nlink=2 barrier publication crash boundary', () => {
    const home = root()
    const initialized = acquireTranscriptWriterLease({ root: home })
    initialized.release()
    const barrier = join(home, TRANSCRIPT_WRITER_LOCK_DIRNAME)
    const temporary = join(
      home,
      '..transcript-writer.lock.compat.' + 'a'.repeat(32) + '.tmp',
    )
    linkSync(barrier, temporary)
    expect(lstatSync(barrier).nlink).toBe(2)

    expect(inspectTranscriptWriterLease({ root: home })).toEqual({ state: 'corrupt' })
    expect(lstatSync(barrier).nlink).toBe(2)
    const recovered = acquireTranscriptWriterLease({ root: home })
    expect(existsSync(temporary)).toBe(false)
    expect(lstatSync(barrier).nlink).toBe(1)
    recovered.release()
  })

  it('fails closed after DB inode replacement and never repairs the anchored identity', () => {
    const home = root()
    const lease = acquireTranscriptWriterLease({ root: home })
    const dbPath = lease.identity.path
    lease.release()
    renameSync(dbPath, dbPath + '.displaced')
    writeFileSync(dbPath, '', { mode: 0o600 })

    expect(() => acquireTranscriptWriterLease({ root: home }))
      .toThrowError(expect.objectContaining({ reason: 'lease-corrupt' }))
    expect(lstatSync(dbPath).size).toBe(0)
    expect(inspectTranscriptWriterLease({ root: home })).toEqual({ state: 'corrupt' })
  })

  it('asserts primitive identity and the compatibility barrier before store I/O', async () => {
    const home = root()
    const lease = acquireTranscriptWriterLease({ root: home })
    const storeRoot = join(home, 'journal-data')
    const store = makeNodeSessionTranscriptPersistence({ root: storeRoot, lease })
    expect(await store.loadManifest('session-1')).toBeNull()

    unlinkSync(join(home, TRANSCRIPT_WRITER_LOCK_DIRNAME))
    expect(() => lease.assertOwned()).toThrowError(
      expect.objectContaining({ reason: 'lease-lost' }),
    )
    await expect(store.loadManifest('session-1')).rejects.toThrowError(TranscriptWriterLeaseError)
    expect(existsSync(join(storeRoot, 'sessions', 'session-1'))).toBe(false)
    lease.release()
  })

  it('keeps inspection mutation-free for a rollback journal', () => {
    const home = root()
    const lease = acquireTranscriptWriterLease({ root: home })
    lease.release()
    const journal = leaseDb(home) + '-journal'
    writeFileSync(journal, 'private crash evidence', { mode: 0o600 })
    const before = readFileSync(journal)

    expect(inspectTranscriptWriterLease({ root: home })).toEqual({ state: 'corrupt' })
    expect(readFileSync(journal)).toEqual(before)
  })

  it('reports an external holder and automatically recovers after SIGKILL', async () => {
    const home = root()
    const initialized = acquireTranscriptWriterLease({ root: home })
    const dbPath = initialized.identity.path
    initialized.release()
    const modulePath = createRequire(import.meta.url).resolve('better-sqlite3')
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      [
        "const { default: Database } = await import(process.argv[1])",
        "const db = new Database(process.argv[2], { timeout: 0 })",
        "db.exec('BEGIN IMMEDIATE')",
        "process.send('held')",
        "setInterval(() => {}, 1000)",
      ].join(';'),
      modulePath,
      dbPath,
    ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    await once(child, 'message')
    expect(inspectTranscriptWriterLease({ root: home })).toEqual({ state: 'held' })
    expect(() => acquireTranscriptWriterLease({ root: home }))
      .toThrowError(expect.objectContaining({ reason: 'held-by-another-process' }))

    child.kill('SIGKILL')
    await once(child, 'exit')
    const recovered = acquireTranscriptWriterLease({ root: home })
    recovered.assertOwned()
    recovered.release()
  })
})
