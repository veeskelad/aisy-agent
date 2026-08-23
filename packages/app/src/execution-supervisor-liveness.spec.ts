import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import {
  EXECUTION_SUPERVISOR_LEASE_APPLICATION_ID,
  ExecutionSupervisorLeaseError,
  acquireExecutionRunLiveness,
  acquireExecutionSupervisorChildLivenessLease,
  acquireExecutionSupervisorManagerLease,
  decodeExecutionSupervisorChildLivenessDescriptor,
  encodeExecutionSupervisorChildLivenessDescriptor,
  resolveExecutionSupervisorChildLivenessRoot,
  waitForExecutionSupervisorChildLivenessFence,
} from './execution-supervisor-liveness.js'

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-liveness-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('execution supervisor SQLite liveness leases', () => {
  it('holds one child writer lease and releases it without unlinking the DB', () => {
    const directory = join(root(), 'runtime')
    const first = acquireExecutionSupervisorChildLivenessLease({ root: directory })

    expect(first.isHeld()).toBe(true)
    expect(first.descriptor.path).toMatch(/\/runtime\/child-liveness\.sqlite3$/)
    expect(lstatSync(first.descriptor.path).mode & 0o777).toBe(0o600)
    expect(() => acquireExecutionSupervisorChildLivenessLease({ root: directory }))
      .toThrowError(expect.objectContaining({ code: 'CHILD_LIVENESS_BUSY' }))

    first.release()
    const second = acquireExecutionSupervisorChildLivenessLease({ root: directory })
    expect(second.descriptor).toEqual(first.descriptor)
    second.release()
    expect(lstatSync(first.descriptor.path).isFile()).toBe(true)
  })

  it('uses distinct manager and runtime databases with the exact durable schema', () => {
    const stateRoot = join(root(), 'supervisor')
    const runtimeRoot = resolveExecutionSupervisorChildLivenessRoot(stateRoot)
    const manager = acquireExecutionSupervisorManagerLease(stateRoot)
    const runtime = acquireExecutionSupervisorChildLivenessLease({ root: runtimeRoot })
    manager.release()
    runtime.release()

    const managerDb = new Database(join(stateRoot, 'manager-lease.sqlite3'), { readonly: true })
    const runtimeDb = new Database(join(runtimeRoot, 'child-liveness.sqlite3'), { readonly: true })
    try {
      expect(managerDb.pragma('application_id', { simple: true })).toBe(EXECUTION_SUPERVISOR_LEASE_APPLICATION_ID)
      expect(managerDb.pragma('user_version', { simple: true })).toBe(1)
      expect(managerDb.prepare('SELECT role FROM lease_meta WHERE singleton=1').pluck().get()).toBe('manager')
      expect(runtimeDb.prepare('SELECT role FROM lease_meta WHERE singleton=1').pluck().get()).toBe('child')
      expect(managerDb.pragma('journal_mode', { simple: true })).toBe('delete')
      expect(runtimeDb.pragma('journal_mode', { simple: true })).toBe('delete')
    } finally {
      managerDb.close()
      runtimeDb.close()
    }
  })

  it('round-trips only canonical strict base64url descriptors', () => {
    const lease = acquireExecutionSupervisorChildLivenessLease({ root: join(root(), 'runtime') })
    const encoded = encodeExecutionSupervisorChildLivenessDescriptor(lease.descriptor)
    expect(decodeExecutionSupervisorChildLivenessDescriptor(encoded)).toEqual(lease.descriptor)
    expect(() => decodeExecutionSupervisorChildLivenessDescriptor(`${encoded}=`))
      .toThrowError(ExecutionSupervisorLeaseError)
    const extra = Buffer.from(JSON.stringify({ ...lease.descriptor, pid: 1 })).toString('base64url')
    expect(() => decodeExecutionSupervisorChildLivenessDescriptor(extra))
      .toThrowError(ExecutionSupervisorLeaseError)
    lease.release()
  })

  it('rejects a foreign descriptor identity and notifies loss for a replaced held inode', async () => {
    const directory = join(root(), 'runtime')
    const lease = acquireExecutionSupervisorChildLivenessLease({ root: directory })
    expect(() => acquireExecutionSupervisorChildLivenessLease({
      root: join(root(), 'other-runtime'),
      expectedDescriptor: lease.descriptor,
    })).toThrowError(expect.objectContaining({ code: 'CHILD_LIVENESS_UNSAFE' }))

    const lost = new Promise<void>((resolve) => { lease.onLost(resolve) })
    const displaced = `${lease.descriptor.path}.displaced`
    renameSync(lease.descriptor.path, displaced)
    writeFileSync(lease.descriptor.path, 'replacement', { mode: 0o600 })
    expect(lease.isHeld()).toBe(false)
    await expect(lost).resolves.toBeUndefined()
    expect(() => acquireExecutionSupervisorChildLivenessLease({ root: directory }))
      .toThrowError(expect.objectContaining({ code: 'CHILD_LIVENESS_CORRUPT' }))
    lease.release()
  })

  it('rejects unsafe roots and journal/WAL companions without repairing them', () => {
    const unsafeRoot = join(root(), 'unsafe')
    mkdirSync(unsafeRoot, { mode: 0o755 })
    expect(() => acquireExecutionSupervisorChildLivenessLease({ root: unsafeRoot }))
      .toThrowError(expect.objectContaining({ code: 'CHILD_LIVENESS_UNSAFE' }))
    expect(lstatSync(unsafeRoot).mode & 0o777).toBe(0o755)

    const linkedRoot = join(root(), 'linked')
    const target = join(root(), 'target')
    mkdirSync(target, { mode: 0o700 })
    symlinkSync(target, linkedRoot)
    expect(() => acquireExecutionSupervisorChildLivenessLease({ root: linkedRoot }))
      .toThrowError(expect.objectContaining({ code: 'CHILD_LIVENESS_UNSAFE' }))

    const runtime = join(root(), 'runtime')
    const lease = acquireExecutionSupervisorChildLivenessLease({ root: runtime })
    lease.release()
    writeFileSync(`${lease.descriptor.path}-wal`, 'foreign', { mode: 0o600 })
    expect(() => acquireExecutionSupervisorChildLivenessLease({ root: runtime }))
      .toThrowError(expect.objectContaining({ code: 'CHILD_LIVENESS_CORRUPT' }))
  })

  it.each([
    ['manager', (path: string) => acquireExecutionSupervisorManagerLease(path)],
    ['child', (path: string) => acquireExecutionSupervisorChildLivenessLease({ root: path })],
  ] as const)('rejects an intermediate root symlink with role-correct %s errors', (role, acquire) => {
    const base = root()
    const target = join(base, 'target')
    const linked = join(base, 'linked')
    mkdirSync(target, { mode: 0o700 })
    symlinkSync(target, linked)

    expect(() => acquire(join(linked, 'nested'))).toThrowError(expect.objectContaining({
      code: role === 'manager' ? 'MANAGER_LEASE_UNSAFE' : 'CHILD_LIVENESS_UNSAFE',
    }))
    expect(existsSync(join(target, 'nested'))).toBe(false)
  })

  it.each([
    ['manager', (path: string) => acquireExecutionSupervisorManagerLease(path)],
    ['child', (path: string) => acquireExecutionSupervisorChildLivenessLease({ root: path })],
  ] as const)('never trusts a symlink supplied through TMPDIR for %s', (role, acquire) => {
    const base = root()
    const target = join(base, 'tmp-target')
    const linked = join(base, 'tmp-alias')
    mkdirSync(target, { mode: 0o700 })
    symlinkSync(target, linked)
    const previous = process.env['TMPDIR']
    process.env['TMPDIR'] = linked
    try {
      expect(() => acquire(join(tmpdir(), 'lease'))).toThrowError(expect.objectContaining({
        code: role === 'manager' ? 'MANAGER_LEASE_UNSAFE' : 'CHILD_LIVENESS_UNSAFE',
      }))
      expect(existsSync(join(target, 'lease'))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env['TMPDIR']
      else process.env['TMPDIR'] = previous
    }
  })

  it.each([
    ['manager', 'manager-lease.sqlite3', (path: string) => acquireExecutionSupervisorManagerLease(path)],
    ['child', 'child-liveness.sqlite3', (path: string) => acquireExecutionSupervisorChildLivenessLease({ root: path })],
  ] as const)('recovers every crash-safe %s bootstrap publication boundary', (_role, filename, acquire) => {
    const directory = join(root(), 'lease')
    mkdirSync(directory, { mode: 0o700 })
    const emptyOrphan = join(directory, `.${filename}.bootstrap.${'a'.repeat(32)}.sqlite3`)
    writeFileSync(emptyOrphan, '', { mode: 0o600 })

    const first = acquire(directory)
    first.release()
    const dbPath = join(directory, filename)
    const anchorPath = `${dbPath}.identity.json`
    expect(lstatSync(dbPath).size).toBeGreaterThan(0)
    expect(existsSync(emptyOrphan)).toBe(true)

    // Crash after atomic DB publication but before bootstrap-link cleanup.
    const dbBootstrap = join(directory, `.${filename}.bootstrap.${'b'.repeat(32)}.sqlite3`)
    linkSync(dbPath, dbBootstrap)
    const afterDbPublish = acquire(directory)
    afterDbPublish.release()
    expect(existsSync(dbBootstrap)).toBe(false)
    expect(lstatSync(dbPath).nlink).toBe(1)

    // Crash after valid DB publication but before immutable identity anchor.
    rmSync(anchorPath)
    const recoveredAnchor = acquire(directory)
    recoveredAnchor.release()
    expect(lstatSync(anchorPath).mode & 0o777).toBe(0o600)

    // Crash after atomic anchor publication but before its temp unlink.
    const anchorBootstrap = join(directory, `.${filename}.identity.${'c'.repeat(32)}.tmp`)
    linkSync(anchorPath, anchorBootstrap)
    const afterAnchorPublish = acquire(directory)
    afterAnchorPublish.release()
    expect(existsSync(anchorBootstrap)).toBe(false)
    expect(lstatSync(anchorPath).nlink).toBe(1)
  })

  it.each([
    ['manager', 'manager-lease.sqlite3', (path: string) => acquireExecutionSupervisorManagerLease(path)],
    ['child', 'child-liveness.sqlite3', (path: string) => acquireExecutionSupervisorChildLivenessLease({ root: path })],
  ] as const)('refuses %s DB replacement when an immutable identity anchor exists', (role, filename, acquire) => {
    const directory = join(root(), 'lease')
    const original = acquire(directory)
    original.release()
    const dbPath = join(directory, filename)
    renameSync(dbPath, `${dbPath}.displaced`)
    writeFileSync(dbPath, '', { mode: 0o600 })

    expect(() => acquire(directory)).toThrowError(expect.objectContaining({
      code: role === 'manager' ? 'MANAGER_LEASE_CORRUPT' : 'CHILD_LIVENESS_CORRUPT',
    }))
    expect(lstatSync(dbPath).size).toBe(0)
  })

  it('rejects unsafe DB permissions, companion symlinks and corrupt metadata', () => {
    const runtime = join(root(), 'runtime')
    const lease = acquireExecutionSupervisorChildLivenessLease({ root: runtime })
    const dbPath = lease.descriptor.path
    lease.release()

    chmodSync(dbPath, 0o644)
    expect(() => acquireExecutionSupervisorChildLivenessLease({ root: runtime }))
      .toThrowError(expect.objectContaining({ code: 'CHILD_LIVENESS_UNSAFE' }))
    chmodSync(dbPath, 0o600)

    symlinkSync(dbPath, `${dbPath}-journal`)
    expect(() => acquireExecutionSupervisorChildLivenessLease({ root: runtime }))
      .toThrowError(expect.objectContaining({ code: 'CHILD_LIVENESS_UNSAFE' }))
    rmSync(`${dbPath}-journal`)

    const db = new Database(dbPath)
    db.pragma('application_id = 1')
    db.close()
    expect(() => acquireExecutionSupervisorChildLivenessLease({ root: runtime }))
      .toThrowError(expect.objectContaining({ code: 'CHILD_LIVENESS_CORRUPT' }))
  })

  it('aborts only a BUSY wait and never steals the active lease', async () => {
    const directory = join(root(), 'runtime')
    const active = acquireExecutionSupervisorChildLivenessLease({ root: directory })
    const controller = new AbortController()
    const waiting = waitForExecutionSupervisorChildLivenessFence({
      root: directory,
      signal: controller.signal,
      retryMs: 1,
    })
    controller.abort()
    await expect(waiting).rejects.toEqual(expect.objectContaining({ code: 'CHILD_LIVENESS_ABORTED' }))
    expect(active.isHeld()).toBe(true)
    active.release()
  })

  it('makes direct run release and fail code-only while a manager is active', () => {
    const stateRoot = join(root(), 'supervisor')
    const manager = acquireExecutionSupervisorManagerLease(stateRoot)

    expect(() => acquireExecutionRunLiveness({ stateRoot }))
      .toThrowError(expect.objectContaining({ code: 'MANAGER_LEASE_BUSY' }))

    // The failed direct probe released runtime ownership, so the supervised
    // child can acquire it while its parent still owns manager authority.
    const supervised = acquireExecutionSupervisorChildLivenessLease({
      root: resolveExecutionSupervisorChildLivenessRoot(stateRoot),
    })
    expect(supervised.isHeld()).toBe(true)
    supervised.release()
    manager.release()
  })

  it('lets a direct run keep runtime ownership after a free manager probe', () => {
    const stateRoot = join(root(), 'supervisor')
    const direct = acquireExecutionRunLiveness({ stateRoot })
    expect(direct.isHeld()).toBe(true)
    const manager = acquireExecutionSupervisorManagerLease(stateRoot)
    expect(manager.isHeld()).toBe(true)
    manager.release()
    direct.release()
  })

  it('releases the SQLite writer lease when its owning process is SIGKILLed', async () => {
    const directory = join(root(), 'runtime')
    const initialized = acquireExecutionSupervisorChildLivenessLease({ root: directory })
    const dbPath = initialized.descriptor.path
    initialized.release()
    const modulePath = createRequire(import.meta.url).resolve('better-sqlite3')
    const script = [
      "const { default: Database } = await import(process.argv[1])",
      "const db = new Database(process.argv[2], { timeout: 0 })",
      "db.exec('BEGIN IMMEDIATE')",
      "process.send('held')",
      "setInterval(() => {}, 1000)",
    ].join(';')
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, modulePath, dbPath], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    await once(child, 'message')
    expect(() => acquireExecutionSupervisorChildLivenessLease({ root: directory }))
      .toThrowError(expect.objectContaining({ code: 'CHILD_LIVENESS_BUSY' }))
    child.kill('SIGKILL')
    await once(child, 'exit')

    const recovered = acquireExecutionSupervisorChildLivenessLease({ root: directory })
    expect(recovered.isHeld()).toBe(true)
    recovered.release()
  })
})
