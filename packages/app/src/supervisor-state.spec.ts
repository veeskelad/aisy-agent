import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ExecutionSupervisorStateError,
  makeExecutionSupervisorState,
  migrateExecutionSupervisorStateV1,
  makeNodeExecutionSupervisorStateStore,
  resolveExecutionSupervisorStateRoot,
  withExecutionSupervisorStateChecksum,
  type ExecutionSupervisorManagerLease,
} from './supervisor-state.js'

const roots: string[] = []
const managerLeases: ExecutionSupervisorManagerLease[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-supervisor-state-'))
  roots.push(value)
  return value
}

function nextState(revision: number) {
  return withExecutionSupervisorStateChecksum({
    schemaVersion: 2,
    revision,
    manager: {
      epoch: 'epoch_abcdefghijklmnop',
      cleanShutdown: false,
      startedAtMs: 100,
    },
    authority: null,
    releaseReceipt: null,
    restart: {
      unexpectedExitMs: [],
      consecutiveUnexpectedExits: 0,
      quarantine: null,
    },
  })
}

afterEach(() => {
  for (const lease of managerLeases.splice(0)) {
    try { lease.release() } catch { /* unsafe-root tests deliberately invalidate the lease */ }
  }
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

function leasedStore(path: string) {
  const store = makeNodeExecutionSupervisorStateStore({ root: path })
  managerLeases.push(store.acquireManagerLease())
  return store
}

describe('execution supervisor durable state', () => {
  it('serializes state access with one exact lifetime manager lease', () => {
    const directory = join(root(), 'private')
    const first = makeNodeExecutionSupervisorStateStore({ root: directory })
    const second = makeNodeExecutionSupervisorStateStore({ root: directory })
    const firstLease = first.acquireManagerLease()
    managerLeases.push(firstLease)

    expect(firstLease.isHeld()).toBe(true)
    expect(lstatSync(join(directory, 'manager-lease.sqlite3')).mode & 0o777).toBe(0o600)
    expect(() => second.acquireManagerLease()).toThrowError(ExecutionSupervisorStateError)
    expect(second.load()).toEqual({ kind: 'refused', code: 'UNSAFE_STATE_ROOT' })

    firstLease.release()
    const secondLease = second.acquireManagerLease()
    managerLeases.push(secondLease)
    expect(secondLease.isHeld()).toBe(true)
    expect(second.load()).toEqual({ kind: 'missing' })
  })

  it('ignores but never removes the obsolete file lock', () => {
    const directory = join(root(), 'private')
    mkdirSync(directory, { mode: 0o700 })
    const lockPath = join(directory, 'manager.lock')
    writeFileSync(lockPath, 'stale-owner-token\n', { mode: 0o600 })
    const store = makeNodeExecutionSupervisorStateStore({ root: directory })

    const lease = store.acquireManagerLease()
    managerLeases.push(lease)
    expect(readFileSync(lockPath, 'utf8')).toBe('stale-owner-token\n')
    expect(store.load()).toEqual({ kind: 'missing' })
  })

  it('requires the lifetime lease before any state load or publication', () => {
    const store = makeNodeExecutionSupervisorStateStore({ root: join(root(), 'private') })

    expect(store.load()).toEqual({ kind: 'refused', code: 'UNSAFE_STATE_ROOT' })
    expect(() => store.publish(nextState(1))).toThrowError(ExecutionSupervisorStateError)
  })

  it('resolves a manager root outside AISY_HOME for Linux and macOS', () => {
    expect(resolveExecutionSupervisorStateRoot({
      platform: 'linux',
      home: '/home/operator',
    })).toBe('/home/operator/.local/state/aisy/supervisor')
    expect(resolveExecutionSupervisorStateRoot({
      platform: 'linux',
      home: '/home/operator',
      xdgStateHome: '/state',
    })).toBe('/state/aisy/supervisor')
    expect(resolveExecutionSupervisorStateRoot({
      platform: 'darwin',
      home: '/Users/operator',
    })).toBe('/Users/operator/Library/Application Support/Aisy/supervisor')
  })

  it('publishes strict private checksummed state atomically', () => {
    const directory = join(root(), 'private')
    const store = leasedStore(directory)
    expect(store.load()).toEqual({ kind: 'missing' })

    const state = makeExecutionSupervisorState({
      epoch: 'epoch_abcdefghijklmnop',
      startedAtMs: 100,
    })
    store.publish(state)

    expect(store.load()).toEqual({ kind: 'ready', state })
    expect(lstatSync(directory).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(directory, 'state.json')).mode & 0o777).toBe(0o600)
    const encoded = readFileSync(join(directory, 'state.json'), 'utf8')
    for (const forbidden of [
      'token', 'credential', 'content', 'message', 'reason', 'path',
      '/private/manager-root-sentinel', 'telegram-content-sentinel', 'credential-sentinel',
    ]) expect(encoded).not.toContain(forbidden)
    expect(state.schemaVersion).toBe(2)
    expect(state.releaseReceipt).toBeNull()
  })

  it('migrates an exact V1 state once under the manager lease', () => {
    const directory = join(root(), 'private')
    const store = leasedStore(directory)
    const legacy = withExecutionSupervisorStateChecksum({
      schemaVersion: 1,
      revision: 7,
      manager: { epoch: 'epoch_abcdefghijklmnop', cleanShutdown: false, startedAtMs: 100 },
      authority: null,
      restart: { unexpectedExitMs: [], consecutiveUnexpectedExits: 0, quarantine: null },
    })
    writeFileSync(join(directory, 'state.json'), JSON.stringify(legacy), { mode: 0o600 })
    const loaded = store.load()
    expect(loaded).toEqual({ kind: 'ready', state: legacy })
    if (loaded.kind !== 'ready' || loaded.state.schemaVersion !== 1) throw new Error('legacy')

    const migrated = migrateExecutionSupervisorStateV1(loaded.state)
    expect(migrated).toMatchObject({ schemaVersion: 2, revision: 8, releaseReceipt: null })
    store.publish(migrated)
    expect(store.load()).toEqual({ kind: 'ready', state: migrated })
  })

  it('persists one exact release receipt and rejects authority plus receipt', () => {
    const receipt = {
      releaseIntentHash: 'a'.repeat(64),
      envelopeHash: 'b'.repeat(64),
      receiptHash: 'c'.repeat(64),
      bindingHash: 'd'.repeat(64),
      runLivenessHash: 'e'.repeat(64),
      authorityPhase: 'checkpoint-bound' as const,
      releasedAtMs: 200,
    }
    const state = withExecutionSupervisorStateChecksum({
      schemaVersion: 2,
      revision: 1,
      manager: { epoch: 'epoch_abcdefghijklmnop', cleanShutdown: false, startedAtMs: 100 },
      authority: null,
      releaseReceipt: receipt,
      restart: { unexpectedExitMs: [], consecutiveUnexpectedExits: 0, quarantine: null },
    })
    const store = leasedStore(join(root(), 'private'))
    store.publish(state)
    expect(store.load()).toEqual({ kind: 'ready', state })

    const mixed = withExecutionSupervisorStateChecksum({
      schemaVersion: 2,
      revision: 2,
      manager: state.manager,
      authority: {
        phase: 'captured-unbound' as const,
        bindingHash: receipt.bindingHash,
        leaseId: 'lease_abcdefghijklmnop',
        capturedAtMs: 201,
      },
      releaseReceipt: receipt,
      restart: state.restart,
    })
    expect(() => store.publish(mixed)).toThrowError(ExecutionSupervisorStateError)
    expect(store.load()).toEqual({ kind: 'ready', state })
  })

  it('rejects a corrupt checksum and unknown fields', () => {
    const directory = join(root(), 'private')
    const store = leasedStore(directory)
    const state = makeExecutionSupervisorState({
      epoch: 'epoch_abcdefghijklmnop',
      startedAtMs: 100,
    })
    store.publish(state)
    writeFileSync(join(directory, 'state.json'), JSON.stringify({
      ...state,
      content: 'secret message',
    }), { mode: 0o600 })

    expect(store.load()).toEqual({ kind: 'refused', code: 'CORRUPT_STATE' })
    expect(() => store.publish(nextState(2))).toThrowError(
      expect.objectContaining({ code: 'STATE_UNAVAILABLE' }),
    )
  })

  it('does not repair or publish through an unsafe state root', () => {
    const base = root()
    const target = join(base, 'target')
    const linked = join(base, 'linked')
    writeFileSync(target, 'not a directory')
    symlinkSync(target, linked)
    const store = makeNodeExecutionSupervisorStateStore({ root: linked })

    expect(() => store.acquireManagerLease()).toThrowError(ExecutionSupervisorStateError)
    expect(store.load()).toEqual({ kind: 'refused', code: 'UNSAFE_STATE_ROOT' })
    expect(() => store.publish(nextState(1))).toThrowError(ExecutionSupervisorStateError)
    expect(readFileSync(target, 'utf8')).toBe('not a directory')
  })

  it('rejects a final root symlink even when its target is a valid private directory', () => {
    const base = root()
    const target = join(base, 'private-target')
    const linked = join(base, 'linked-root')
    mkdirSync(target, { mode: 0o700 })
    symlinkSync(target, linked)
    const store = makeNodeExecutionSupervisorStateStore({ root: linked })

    expect(() => store.acquireManagerLease()).toThrowError(ExecutionSupervisorStateError)
    expect(store.load()).toEqual({ kind: 'refused', code: 'UNSAFE_STATE_ROOT' })
    expect(() => store.publish(nextState(1))).toThrowError(ExecutionSupervisorStateError)
    expect(lstatSync(target).mode & 0o777).toBe(0o700)
  })

  it('refuses unsafe existing permissions instead of chmod-repairing them', () => {
    const directory = join(root(), 'private')
    const store = leasedStore(directory)
    expect(store.load()).toEqual({ kind: 'missing' })
    chmodSync(directory, 0o755)

    expect(store.load()).toEqual({ kind: 'refused', code: 'UNSAFE_PERMISSIONS' })
    expect(() => store.publish(nextState(1))).toThrowError(ExecutionSupervisorStateError)
    expect(lstatSync(directory).mode & 0o777).toBe(0o755)
  })

  it('enforces strictly increasing revisions', () => {
    const store = leasedStore(join(root(), 'private'))
    store.publish(nextState(1))

    expect(() => store.publish(nextState(1))).toThrowError(
      expect.objectContaining({ code: 'STATE_CONFLICT' }),
    )
    store.publish(nextState(2))
    expect(store.load()).toMatchObject({ kind: 'ready', state: { revision: 2 } })
  })

  it('does not overwrite an unsafe target introduced at the final publication CAS', () => {
    const directory = join(root(), 'private')
    const store = leasedStore(directory)
    const statePath = join(directory, 'state.json')
    const originalStringify = JSON.stringify
    let injected = false
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
      if (!injected && readdirSync(directory).some((name) => name.endsWith('.tmp'))) {
        writeFileSync(statePath, 'concurrent unsafe target\n', { mode: 0o644 })
        injected = true
      }
      return originalStringify(value)
    })

    try {
      expect(() => store.publish(nextState(1))).toThrowError(
        expect.objectContaining({ code: 'STATE_UNAVAILABLE' }),
      )
    } finally {
      stringify.mockRestore()
    }

    expect(injected).toBe(true)
    expect(readFileSync(statePath, 'utf8')).toBe('concurrent unsafe target\n')
    expect(lstatSync(statePath).mode & 0o777).toBe(0o644)
  })

  it('never deletes a concurrent replacement at its random temporary path', () => {
    const directory = join(root(), 'private')
    const store = leasedStore(directory)
    const displaced = join(directory, 'displaced-owned-temp')
    const originalStringify = JSON.stringify
    let replacement = ''
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
      if (replacement === '') {
        const temporary = readdirSync(directory).find((name) => name.endsWith('.tmp'))
        if (temporary !== undefined) {
          replacement = join(directory, temporary)
          renameSync(replacement, displaced)
          writeFileSync(replacement, 'concurrent private replacement\n', { mode: 0o600 })
        }
      }
      return originalStringify(value)
    })

    try {
      expect(() => store.publish(nextState(1))).toThrowError(
        expect.objectContaining({ code: 'STATE_UNAVAILABLE' }),
      )
    } finally {
      stringify.mockRestore()
    }

    expect(replacement).not.toBe('')
    expect(readFileSync(replacement, 'utf8')).toBe('concurrent private replacement\n')
    expect(readFileSync(displaced, 'utf8')).toContain('"schemaVersion":2')
  })

  it('accepts only sorted bounded restart timestamps and allowlisted state', () => {
    const state = withExecutionSupervisorStateChecksum({
      schemaVersion: 2,
      revision: 1,
      manager: {
        epoch: 'epoch_abcdefghijklmnop',
        cleanShutdown: false,
        startedAtMs: 100,
      },
      authority: {
        phase: 'captured-unbound',
        bindingHash: 'a'.repeat(64),
        leaseId: 'lease_abcdefghijklmnop',
        capturedAtMs: 101,
      },
      releaseReceipt: null,
      restart: {
        unexpectedExitMs: [100, 200, 300],
        consecutiveUnexpectedExits: 3,
        quarantine: null,
      },
    })
    const store = leasedStore(join(root(), 'private'))
    store.publish(state)

    expect(store.load()).toEqual({ kind: 'ready', state })
  })

  it('round-trips the Docker recovery quarantine without free-form details', () => {
    const state = withExecutionSupervisorStateChecksum({
      schemaVersion: 2,
      revision: 1,
      manager: {
        epoch: 'epoch_abcdefghijklmnop',
        cleanShutdown: false,
        startedAtMs: 100,
      },
      authority: null,
      releaseReceipt: null,
      restart: {
        unexpectedExitMs: [],
        consecutiveUnexpectedExits: 0,
        quarantine: { code: 'OWNED_DOCKER_RECOVERY_UNAVAILABLE', atMs: 101 },
      },
    })
    const store = leasedStore(join(root(), 'private'))
    store.publish(state)

    expect(store.load()).toEqual({ kind: 'ready', state })
  })
})
