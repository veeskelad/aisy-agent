import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquirePrivateSqliteLease,
  inspectPrivateSqliteLease,
  PrivateSqliteLeaseError,
  type PrivateSqliteLeaseProfile,
} from './private-sqlite-lease.js'

const roots: string[] = []
const SCHEMA = "CREATE TABLE lease_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), role TEXT NOT NULL CHECK (role = 'test-writer'), schema_version INTEGER NOT NULL CHECK (schema_version = 1), database_id TEXT NOT NULL CHECK (length(database_id) = 64))"
const PROFILE: PrivateSqliteLeaseProfile = {
  role: 'test-writer',
  filename: 'test-writer.sqlite3',
  applicationId: 0x41495359,
  userVersion: 1,
  exactSchemaSql: SCHEMA,
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-private-lease-'))
  roots.push(value)
  return join(value, 'lease')
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('private SQLite lease primitive', () => {
  it('keeps one exact kernel-held writer and never opens a second in-process connection', async () => {
    const directory = root()
    const first = acquirePrivateSqliteLease({ root: directory, profile: PROFILE })
    expect(first.isHeld()).toBe(true)
    expect(inspectPrivateSqliteLease({ root: directory, profile: PROFILE })).toEqual({ state: 'held' })
    expect(() => acquirePrivateSqliteLease({ root: directory, profile: PROFILE }))
      .toThrowError(expect.objectContaining({ failure: 'busy' }))
    expect(first.isHeld()).toBe(true)
    const modulePath = createRequire(import.meta.url).resolve('better-sqlite3')
    const contender = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      [
        "const { default: Database } = await import(process.argv[1])",
        "const db = new Database(process.argv[2], { timeout: 0 })",
        "let result",
        "try { db.exec('BEGIN IMMEDIATE'); result = 'acquired' } catch (error) { result = error.code === 'SQLITE_BUSY' ? 'busy' : 'error' }",
        "if (db.inTransaction) db.exec('ROLLBACK')",
        "db.close()",
        "process.send(result)",
        "setInterval(() => {}, 1000)",
      ].join(';'),
      modulePath,
      first.identity.path,
    ], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let stderr = ''
    contender.stderr?.on('data', chunk => { stderr += String(chunk) })
    const exited = once(contender, 'exit')
    const outcome = await Promise.race([
      once(contender, 'message').then(([message]) => ({ kind: 'message' as const, message })),
      exited.then(([code, signal]) => ({ kind: 'exit' as const, code, signal })),
      new Promise<{ kind: 'timeout' }>(resolveTimeout => {
        setTimeout(() => resolveTimeout({ kind: 'timeout' }), 2_000)
      }),
    ])
    if (contender.exitCode === null && contender.signalCode === null) contender.kill('SIGKILL')
    await exited
    expect({ outcome, stderr }).toEqual({
      outcome: { kind: 'message', message: 'busy' },
      stderr: '',
    })

    first.release()
    expect(inspectPrivateSqliteLease({ root: directory, profile: PROFILE })).toEqual({ state: 'free' })
  })

  it('publishes exact private DB and immutable identity anchor', () => {
    const directory = root()
    const lease = acquirePrivateSqliteLease({ root: directory, profile: PROFILE })
    const db = lstatSync(lease.identity.path)
    const anchorPath = lease.identity.path + '.identity.json'
    const anchor = lstatSync(anchorPath)
    expect(db.mode & 0o777).toBe(0o600)
    expect(db.nlink).toBe(1)
    expect(anchor.mode & 0o777).toBe(0o600)
    expect(anchor.nlink).toBe(1)
    expect(JSON.parse(readFileSync(anchorPath, 'utf8'))).toEqual({
      version: 1,
      role: 'test-writer',
      databaseId: lease.identity.databaseId,
      dev: lease.identity.dev,
      ino: lease.identity.ino,
    })
    lease.release()
  })

  it('fails closed on intermediate symlinks, DB hardlinks and identity replacement', () => {
    const base = root()
    const target = join(base, 'target')
    const linked = join(base, 'linked')
    mkdirSync(target, { recursive: true, mode: 0o700 })
    symlinkSync(target, linked)
    expect(() => acquirePrivateSqliteLease({ root: join(linked, 'nested'), profile: PROFILE }))
      .toThrowError(expect.objectContaining({ failure: 'unsafe' }))

    const directory = join(base, 'safe')
    const lease = acquirePrivateSqliteLease({ root: directory, profile: PROFILE })
    const dbPath = lease.identity.path
    lease.release()
    linkSync(dbPath, dbPath + '.foreign-hardlink')
    expect(() => acquirePrivateSqliteLease({ root: directory, profile: PROFILE }))
      .toThrowError(expect.objectContaining({ failure: 'unsafe' }))
    rmSync(dbPath + '.foreign-hardlink')
    rmSync(dbPath)
    writeFileSync(dbPath, '', { mode: 0o600 })
    expect(() => acquirePrivateSqliteLease({ root: directory, profile: PROFILE }))
      .toThrowError(expect.objectContaining({ failure: 'corrupt' }))
  })

  it('keeps inspection mutation-free when a rollback journal exists', () => {
    const directory = root()
    const lease = acquirePrivateSqliteLease({ root: directory, profile: PROFILE })
    const journalPath = lease.identity.path + '-journal'
    lease.release()
    writeFileSync(journalPath, 'private crash evidence', { mode: 0o600 })
    const before = readFileSync(journalPath)

    expect(inspectPrivateSqliteLease({ root: directory, profile: PROFILE })).toEqual({ state: 'corrupt' })
    expect(readFileSync(journalPath)).toEqual(before)
  })

  it('lets the next process acquire after the kernel releases a SIGKILLed owner', async () => {
    const directory = root()
    const initialized = acquirePrivateSqliteLease({ root: directory, profile: PROFILE })
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
    expect(() => acquirePrivateSqliteLease({ root: directory, profile: PROFILE }))
      .toThrowError(expect.objectContaining({ failure: 'busy' }))
    child.kill('SIGKILL')
    await once(child, 'exit')

    const recovered = acquirePrivateSqliteLease({ root: directory, profile: PROFILE })
    expect(recovered.isHeld()).toBe(true)
    recovered.release()
    expect(existsSync(dbPath)).toBe(true)
  })
})
