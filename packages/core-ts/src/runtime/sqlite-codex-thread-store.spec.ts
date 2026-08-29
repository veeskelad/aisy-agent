import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CODEX_APP_SERVER_CAPABILITY_PROTOCOL_PROFILE,
  CODEX_APP_SERVER_PROTOCOL_PROFILE,
  type CodexAppServerThreadRecord,
} from './codex-app-server-driver.js'
import {
  CodexThreadStoreError,
  makeSqliteCodexThreadStore,
  type SqliteCodexThreadStore,
} from './sqlite-codex-thread-store.js'

const stores: SqliteCodexThreadStore[] = []

function path(name = 'threads.sqlite'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-codex-thread-store-')))
  return join(root, name)
}

function open(dbPath: string): SqliteCodexThreadStore {
  const store = makeSqliteCodexThreadStore({ dbPath })
  stores.push(store)
  return store
}

function record(
  projectId = 'project-a',
  sessionId = 'session-a',
  threadId = 'thread-a',
): CodexAppServerThreadRecord {
  return {
    projectId,
    sessionId,
    threadId,
    protocolProfile: CODEX_APP_SERVER_PROTOCOL_PROFILE,
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close() } catch { /* already closed */ }
  }
})

describe('SQLite Codex app-server thread store', () => {
  it('persists an exact binding across a real process restart', async () => {
    const dbPath = path()
    const first = open(dbPath)
    await first.saveNew(record())
    first.close()

    const restarted = open(dbPath)
    expect(restarted.hasBinding('project-a', 'session-a')).toBe(true)
    expect(restarted.hasBinding('project-a', 'other-session')).toBe(false)
    await expect(restarted.load('project-a', 'session-a')).resolves.toEqual(record())
    await expect(restarted.load('project-a', 'other-session')).resolves.toBeNull()
  })

  it('persists the capability profile and refuses to reopen it as read-only', async () => {
    const dbPath = path()
    const capability: CodexAppServerThreadRecord = {
      ...record(),
      protocolProfile: CODEX_APP_SERVER_CAPABILITY_PROTOCOL_PROFILE,
    }
    const first = open(dbPath)
    await first.saveNew(capability)
    first.close()

    const restarted = open(dbPath)
    await expect(restarted.load('project-a', 'session-a')).resolves.toEqual(capability)
    await expect(restarted.saveNew(record())).rejects.toEqual(
      new CodexThreadStoreError('THREAD_BINDING_CONFLICT'),
    )
  })

  it('allows an identical retry but rejects binding or thread ownership changes', async () => {
    const store = open(path())
    await store.saveNew(record())
    await expect(store.saveNew(record())).resolves.toBeUndefined()
    await expect(store.saveNew(record('project-a', 'session-a', 'thread-b'))).rejects.toEqual(
      new CodexThreadStoreError('THREAD_BINDING_CONFLICT'),
    )
    await expect(store.saveNew(record('project-b', 'session-b', 'thread-a'))).rejects.toEqual(
      new CodexThreadStoreError('THREAD_BINDING_CONFLICT'),
    )
  })

  it('has one winner across two store instances', async () => {
    const dbPath = path()
    const left = open(dbPath)
    const right = open(dbPath)
    const results = await Promise.allSettled([
      left.saveNew(record('project-a', 'session-a', 'thread-left')),
      right.saveNew(record('project-a', 'session-a', 'thread-right')),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const stored = await left.load('project-a', 'session-a')
    expect(['thread-left', 'thread-right']).toContain(stored?.threadId)
  })

  it('rejects invalid records before SQLite mutation', async () => {
    const store = open(path())
    await expect(store.saveNew({ ...record(), projectId: '../escape' })).rejects.toEqual(
      new CodexThreadStoreError('INVALID_THREAD_RECORD'),
    )
    await expect(store.saveNew({ ...record(), protocolProfile: 'future' as never })).rejects.toEqual(
      new CodexThreadStoreError('INVALID_THREAD_RECORD'),
    )
    await expect(store.load('../escape', 'session-a')).rejects.toEqual(
      new CodexThreadStoreError('INVALID_THREAD_RECORD'),
    )
    expect(() => store.hasBinding('../escape', 'session-a')).toThrow(
      expect.objectContaining({ code: 'INVALID_THREAD_RECORD' }),
    )
  })

  it('refuses a symlink or an over-broad pre-existing database', () => {
    const target = path('target.sqlite')
    const initialized = open(target)
    initialized.close()
    const link = join(realpathSync(mkdtempSync(join(tmpdir(), 'aisy-codex-thread-link-'))), 'link.sqlite')
    symlinkSync(target, link)
    expect(() => makeSqliteCodexThreadStore({ dbPath: link })).toThrow(
      expect.objectContaining({ code: 'INSECURE_STORE' }),
    )

    chmodSync(target, 0o644)
    expect(() => makeSqliteCodexThreadStore({ dbPath: target })).toThrow(
      expect.objectContaining({ code: 'INSECURE_STORE' }),
    )
  })

  it('refuses an unidentified existing file and incompatible schema', () => {
    const unknown = path('unknown.sqlite')
    writeFileSync(unknown, 'not sqlite', { mode: 0o600 })
    expect(() => makeSqliteCodexThreadStore({ dbPath: unknown })).toThrow(
      expect.objectContaining({ code: 'CORRUPT_STORE' }),
    )

    const incompatible = path('incompatible.sqlite')
    const db = new Database(incompatible)
    db.exec('CREATE TABLE other(value TEXT)')
    db.close()
    chmodSync(incompatible, 0o600)
    expect(() => makeSqliteCodexThreadStore({ dbPath: incompatible })).toThrow(
      expect.objectContaining({ code: 'CORRUPT_STORE' }),
    )
  })

  it('detects a dormant tampered persisted profile during startup', async () => {
    const dbPath = path()
    const store = open(dbPath)
    await store.saveNew(record())
    await store.saveNew(record('project-b', 'session-b', 'thread-b'))
    store.close()
    const db = new Database(dbPath)
    db.prepare(
      'UPDATE codex_thread_bindings SET protocol_profile = ? WHERE project_id = ?',
    ).run('future-profile', 'project-b')
    db.close()

    expect(() => open(dbPath)).toThrow(
      expect.objectContaining({ code: 'CORRUPT_STORE' }),
    )
  })

  it('rejects extra indexes, triggers, or views in the private schema', () => {
    const dbPath = path()
    const store = open(dbPath)
    store.close()
    const db = new Database(dbPath)
    db.exec(`
      CREATE INDEX injected_index ON codex_thread_bindings(project_id);
      CREATE VIEW injected_view AS SELECT project_id FROM codex_thread_bindings;
    `)
    db.close()

    expect(() => open(dbPath)).toThrow(
      expect.objectContaining({ code: 'CORRUPT_STORE' }),
    )
  })

  it('requires a canonical database path', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-codex-non-canonical-')))
    const nonCanonical = `${root}/sub/../threads.sqlite`
    expect(() => makeSqliteCodexThreadStore({ dbPath: nonCanonical })).toThrow(
      expect.objectContaining({ code: 'INVALID_STORE_PATH' }),
    )
  })
})
