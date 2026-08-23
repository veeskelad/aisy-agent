import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  makeDockerRecoveryActivationTestFixture,
  type DockerRecoveryActivationTestFixture,
} from './__test_support__/docker-recovery-activation.js'

import {
  initializeOwnedDockerResourceLedger,
  loadOwnedDockerResourceLedgerActivation,
  openActivatedOwnedDockerResourceLedger,
  OWNED_DOCKER_LEDGER_FILENAME,
  reconcileOwnedDockerResources,
  type OwnedDockerCommandPort,
  type OwnedDockerEndpointIdentityV1,
  type OwnedDockerObservedResourceV2,
  type OwnedDockerResourceKind,
} from './execution-owned-docker-resources.js'

const INSTALLATION_ID = '1'.repeat(64)
let activationFixture: DockerRecoveryActivationTestFixture
let ENDPOINT_IDENTITY: OwnedDockerEndpointIdentityV1
const roots: string[] = []

beforeAll(async () => {
  activationFixture = await makeDockerRecoveryActivationTestFixture()
  ENDPOINT_IDENTITY = activationFixture.endpointIdentity
})
afterAll(async () => activationFixture.close())

function ledgerRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'aisy-owned-docker-v4-'))
  roots.push(base)
  return join(base, 'private-ledger')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class EmptyDocker implements OwnedDockerCommandPort {
  endpointIdentity: OwnedDockerEndpointIdentityV1 = ENDPOINT_IDENTITY
  calls = 0
  readonly resources = new Map<string, OwnedDockerObservedResourceV2>()
  async probe() { this.calls += 1; return { kind: 'compatible' } as const }
  async scanInstallation(installationId: string) {
    this.calls += 1
    return {
      kind: 'ok',
      resources: [...this.resources.values()].filter(item =>
        item.labels.installationId === installationId),
    } as const
  }
  async inspectById(input: { resourceKind: OwnedDockerResourceKind; objectId: string }) {
    this.calls += 1
    const resource = this.resources.get(input.objectId)
    return resource === undefined ? { kind: 'absent' } as const : { kind: 'found', resource } as const
  }
  async inspectByName(input: { resourceKind: OwnedDockerResourceKind; name: string }) {
    this.calls += 1
    const resource = [...this.resources.values()].find(item =>
      item.resourceKind === input.resourceKind && item.name === input.name)
    return resource === undefined ? { kind: 'absent' } as const : { kind: 'found', resource } as const
  }
  async removeById(input: { resourceKind: OwnedDockerResourceKind; objectId: string }) {
    this.calls += 1
    const existed = this.resources.delete(input.objectId)
    return existed ? { kind: 'removed' } as const : { kind: 'absent' } as const
  }
}

function bootstrap(root: string) {
  return initializeOwnedDockerResourceLedger({
    root, installationId: INSTALLATION_ID, endpointIdentity: ENDPOINT_IDENTITY,
  })
}

describe('owned Docker ledger schema v4', () => {
  it('loads exact production activation read-only and never bootstraps missing state', () => {
    const root = ledgerRoot()
    expect(() => loadOwnedDockerResourceLedgerActivation({
      root, installationId: INSTALLATION_ID, endpointIdentity: ENDPOINT_IDENTITY,
    })).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_MISSING' }))
    const activation = bootstrap(root)
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    const before = readFileSync(path)
    expect(loadOwnedDockerResourceLedgerActivation({
      root, installationId: INSTALLATION_ID, endpointIdentity: ENDPOINT_IDENTITY,
    })).toEqual(activation)
    expect(() => loadOwnedDockerResourceLedgerActivation({
      root,
      installationId: '2'.repeat(64),
      endpointIdentity: ENDPOINT_IDENTITY,
    })).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_CONFLICT' }))
    expect(readFileSync(path)).toEqual(before)
    expect(existsSync(path + '-wal')).toBe(false)
    expect(existsSync(path + '-shm')).toBe(false)
  })

  it('creates exact private v4 state with endpoint identity and dual projection columns', () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    expect(activation).toEqual({
      version: 4,
      kind: 'aisy-owned-docker-ledger-v4',
      installationId: INSTALLATION_ID,
      databaseId: expect.stringMatching(/^[a-f0-9]{64}$/),
      endpointIdentity: ENDPOINT_IDENTITY,
    })
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    const db = new Database(path, { readonly: true, fileMustExist: true })
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    expect(db.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).pluck().all()).toEqual(['ledger_meta', 'operations', 'resources'])
    expect(db.prepare(
      'SELECT manager_state, manager_epoch, operation_seq FROM ledger_meta',
    ).get()).toEqual({ manager_state: 'recovery', manager_epoch: 0, operation_seq: 0 })
    expect(db.prepare('SELECT integrity_hash FROM ledger_meta').pluck().get())
      .toEqual(expect.stringMatching(/^[a-f0-9]{64}$/))
    expect(db.prepare("PRAGMA table_info('resources')").all()).toEqual([
      { cid: 0, name: 'operation_seq', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: 'role', type: 'TEXT', notnull: 1, dflt_value: null, pk: 2 },
      { cid: 2, name: 'resource_kind', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: 'resource_name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 4, name: 'create_projection_contract', type: 'TEXT', notnull: 1,
        dflt_value: null, pk: 0 },
      { cid: 5, name: 'create_projection_hash', type: 'TEXT', notnull: 1,
        dflt_value: null, pk: 0 },
      { cid: 6, name: 'bound_projection_hash_v1', type: 'TEXT', notnull: 0,
        dflt_value: null, pk: 0 },
      { cid: 7, name: 'phase', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 8, name: 'integrity_hash', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 9, name: 'object_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 10, name: 'object_integrity_hash', type: 'TEXT', notnull: 0,
        dflt_value: null, pk: 0 },
    ])
    db.close()
  })

  it('runtime open is recovery-only and prepare authority appears only after zero proof', async () => {
    const root = ledgerRoot()
    const ledger = openActivatedOwnedDockerResourceLedger({ root, activation: bootstrap(root) })
    expect(ledger.mode).toBe('recovery')
    expect('prepare' in ledger).toBe(false)
    const docker = new EmptyDocker()
    const reconciled = await reconcileOwnedDockerResources({ ledger, docker })
    expect(reconciled.kind).toBe('completed')
    const result = await activationFixture.activate(ledger, docker)
    expect(result.kind).toBe('reconciled-and-activated')
    expect(result.activeEpoch.epoch).toBe(1)
    expect(typeof result.activeEpoch.prepare).toBe('function')
    ledger.close()
  })

  it('does not create a missing root, writer lease, or ledger during runtime open', () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    rmSync(root, { recursive: true, force: true })
    expect(() => openActivatedOwnedDockerResourceLedger({ root, activation }))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_MISSING' }))
  })

  it('rejects v1 activation explicitly instead of attempting a live migration', () => {
    const root = ledgerRoot()
    bootstrap(root)
    expect(() => openActivatedOwnedDockerResourceLedger({
      root,
      activation: {
        version: 1,
        kind: 'aisy-owned-docker-ledger-v1',
        installationId: INSTALLATION_ID,
        databaseId: '2'.repeat(64),
      },
    })).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_SCHEMA_UNSUPPORTED' }))
  })

  it('rejects v2 activation explicitly instead of reinterpreting its exact schema', () => {
    const root = ledgerRoot()
    bootstrap(root)
    expect(() => openActivatedOwnedDockerResourceLedger({
      root,
      activation: {
        version: 2,
        kind: 'aisy-owned-docker-ledger-v2',
        installationId: INSTALLATION_ID,
        databaseId: '2'.repeat(64),
      },
    })).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_SCHEMA_UNSUPPORTED' }))
  })

  it('rejects v3 activation explicitly instead of reinterpreting projection_hash', () => {
    const root = ledgerRoot()
    bootstrap(root)
    expect(() => openActivatedOwnedDockerResourceLedger({
      root,
      activation: {
        version: 3,
        kind: 'aisy-owned-docker-ledger-v3',
        installationId: INSTALLATION_ID,
        databaseId: '2'.repeat(64),
        endpointIdentity: ENDPOINT_IDENTITY,
      },
    })).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_SCHEMA_UNSUPPORTED' }))
  })

  it('rejects malformed v4 activation shapes before opening the ledger', () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    const extra = { ...activation, extra: true }
    const symbol = { ...activation } as Record<PropertyKey, unknown>
    symbol[Symbol('forbidden')] = true
    const accessor = { ...activation } as Record<string, unknown>
    Object.defineProperty(accessor, 'endpointIdentity', {
      get: () => ENDPOINT_IDENTITY, enumerable: true,
    })
    const crossKind = { ...activation, kind: 'aisy-owned-docker-ledger-v3' }
    for (const malformed of [extra, symbol, accessor, crossKind]) {
      expect(() => openActivatedOwnedDockerResourceLedger({ root, activation: malformed as never }))
        .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
    }
  })

  it('rejects an on-disk v1 marker without mutating it', () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    const db = new Database(path, { fileMustExist: true })
    db.pragma('user_version = 1')
    db.close()
    const evidence = readFileSync(path)
    expect(() => openActivatedOwnedDockerResourceLedger({ root, activation }))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_SCHEMA_UNSUPPORTED' }))
    expect(readFileSync(path)).toEqual(evidence)
    expect(existsSync(path + '-wal')).toBe(false)
    expect(existsSync(path + '-shm')).toBe(false)
  })

  it('rejects an on-disk v2 marker without mutating it', () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    const db = new Database(path, { fileMustExist: true })
    db.pragma('user_version = 2')
    db.close()
    const evidence = readFileSync(path)
    expect(() => openActivatedOwnedDockerResourceLedger({ root, activation }))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_SCHEMA_UNSUPPORTED' }))
    expect(readFileSync(path)).toEqual(evidence)
    expect(existsSync(path + '-wal')).toBe(false)
    expect(existsSync(path + '-shm')).toBe(false)
  })

  it('rejects an on-disk v3 marker without mutating it', () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    const db = new Database(path, { fileMustExist: true })
    db.pragma('user_version = 3')
    db.close()
    const evidence = readFileSync(path)
    expect(() => openActivatedOwnedDockerResourceLedger({ root, activation }))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_SCHEMA_UNSUPPORTED' }))
    expect(readFileSync(path)).toEqual(evidence)
    expect(existsSync(path + '-wal')).toBe(false)
    expect(existsSync(path + '-shm')).toBe(false)
  })

  it('repeat initialize rejects v3 before recreating a missing writer lease', () => {
    const root = ledgerRoot()
    bootstrap(root)
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    const db = new Database(path, { fileMustExist: true })
    db.pragma('user_version = 3')
    db.close()
    rmSync(join(root, '.writer-lease'), { recursive: true, force: true })
    const evidence = readFileSync(path)
    const stat = lstatSync(path)
    expect(() => initializeOwnedDockerResourceLedger({
      root, installationId: INSTALLATION_ID, endpointIdentity: ENDPOINT_IDENTITY,
    })).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_SCHEMA_UNSUPPORTED' }))
    expect(existsSync(join(root, '.writer-lease'))).toBe(false)
    expect(readFileSync(path)).toEqual(evidence)
    const after = lstatSync(path)
    expect({ ino: after.ino, size: after.size, mtimeMs: after.mtimeMs })
      .toEqual({ ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs })
  })

  it('classifies a foreign application_id with v3 marker as corrupt without mutation', () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    const db = new Database(path, { fileMustExist: true })
    db.pragma('application_id = 1234')
    db.pragma('user_version = 3')
    db.close()
    const evidence = readFileSync(path)
    expect(() => openActivatedOwnedDockerResourceLedger({ root, activation }))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_CORRUPT' }))
    expect(readFileSync(path)).toEqual(evidence)
    expect(existsSync(path + '-wal')).toBe(false)
    expect(existsSync(path + '-shm')).toBe(false)
  })

  it('classifies a truncated private ledger as corrupt without creating artifacts', () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    writeFileSync(path, Buffer.alloc(50, 0x41))
    const evidence = readFileSync(path)
    expect(() => openActivatedOwnedDockerResourceLedger({ root, activation }))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_CORRUPT' }))
    expect(readFileSync(path)).toEqual(evidence)
    expect(existsSync(path + '-wal')).toBe(false)
    expect(existsSync(path + '-shm')).toBe(false)
  })

  it('rejects a persistent WAL header before SQLite open without materializing companions', () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    const evidence = readFileSync(path)
    evidence[18] = 2
    evidence[19] = 2
    writeFileSync(path, evidence)
    const walEvidence = readFileSync(path)
    expect(() => openActivatedOwnedDockerResourceLedger({ root, activation }))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_CORRUPT' }))
    expect(readFileSync(path)).toEqual(walEvidence)
    expect(existsSync(path + '-wal')).toBe(false)
    expect(existsSync(path + '-shm')).toBe(false)
  })

  it('repeat initialize also raw-preflights an existing WAL header without mutation', () => {
    const root = ledgerRoot()
    bootstrap(root)
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    const evidence = readFileSync(path)
    evidence[18] = 2
    evidence[19] = 2
    writeFileSync(path, evidence)
    const walEvidence = readFileSync(path)
    expect(() => initializeOwnedDockerResourceLedger({
      root, installationId: INSTALLATION_ID, endpointIdentity: ENDPOINT_IDENTITY,
    }))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_CORRUPT' }))
    expect(readFileSync(path)).toEqual(walEvidence)
    expect(existsSync(path + '-wal')).toBe(false)
    expect(existsSync(path + '-shm')).toBe(false)
  })

  it('recovers a private hot rollback journal only after raw preflight and writer lease', async () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    const crashed = spawnSync(process.execPath, ['-e', [
      "const Database = require('better-sqlite3')",
      'const db = new Database(process.argv[1])',
      "db.pragma('journal_mode = DELETE')",
      "db.exec('BEGIN IMMEDIATE')",
      "db.prepare('UPDATE ledger_meta SET operation_seq = operation_seq + 7').run()",
      "process.kill(process.pid, 'SIGKILL')",
    ].join(';'), path], { cwd: process.cwd() })
    expect(crashed.signal).toBe('SIGKILL')
    expect(existsSync(path + '-journal')).toBe(true)

    const ledger = openActivatedOwnedDockerResourceLedger({ root, activation })
    const docker = new EmptyDocker()
    await expect(reconcileOwnedDockerResources({ ledger, docker }))
      .resolves.toMatchObject({ kind: 'completed' })
    await expect(activationFixture.activate(ledger, docker))
      .resolves.toMatchObject({ kind: 'reconciled-and-activated' })
    expect(ledger.listOperations()).toEqual([])
    ledger.close()
  })

  it('does not recover or alter a hot journal before exact activation identity proof', () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    const crashed = spawnSync(process.execPath, ['-e', [
      "const Database = require('better-sqlite3')",
      'const db = new Database(process.argv[1])',
      "db.pragma('journal_mode = DELETE')",
      "db.exec('BEGIN IMMEDIATE')",
      "db.prepare('UPDATE ledger_meta SET operation_seq = operation_seq + 9').run()",
      "process.kill(process.pid, 'SIGKILL')",
    ].join(';'), path], { cwd: process.cwd() })
    expect(crashed.signal).toBe('SIGKILL')
    const journalPath = path + '-journal'
    const databaseEvidence = readFileSync(path)
    const journalEvidence = readFileSync(journalPath)
    const databaseStat = lstatSync(path)
    const journalStat = lstatSync(journalPath)

    expect(() => openActivatedOwnedDockerResourceLedger({
      root,
      activation: { ...activation, databaseId: '9'.repeat(64) },
    })).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_CORRUPT' }))
    expect(readFileSync(path)).toEqual(databaseEvidence)
    expect(readFileSync(journalPath)).toEqual(journalEvidence)
    const databaseAfter = lstatSync(path)
    const journalAfter = lstatSync(journalPath)
    expect({ ino: databaseAfter.ino, size: databaseAfter.size, mtimeMs: databaseAfter.mtimeMs })
      .toEqual({ ino: databaseStat.ino, size: databaseStat.size, mtimeMs: databaseStat.mtimeMs })
    expect({ ino: journalAfter.ino, size: journalAfter.size, mtimeMs: journalAfter.mtimeMs })
      .toEqual({ ino: journalStat.ino, size: journalStat.size, mtimeMs: journalStat.mtimeMs })
  })

  it('fails closed on unsafe permissions', () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    chmodSync(join(root, OWNED_DOCKER_LEDGER_FILENAME), 0o644)
    expect(() => openActivatedOwnedDockerResourceLedger({ root, activation }))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_UNSAFE' }))
  })

  it('rejects daemon members that have no durable intent', async () => {
    const root = ledgerRoot()
    const ledger = openActivatedOwnedDockerResourceLedger({ root, activation: bootstrap(root) })
    const docker = new EmptyDocker()
    docker.resources.set('a'.repeat(64), {
      version: 2,
      objectId: 'a'.repeat(64),
      resourceKind: 'container',
      name: 'aisy-whisper-worker-unknown',
      labels: {
        version: '1', installationId: INSTALLATION_ID,
        ownerBindingHash: '2'.repeat(64), sessionBindingHash: '3'.repeat(64),
        operationBindingHash: '4'.repeat(64), sidecarKind: 'whisper', role: 'worker',
        policyHash: '5'.repeat(64),
      },
      createProjectionContract: 'container-selected-v2',
      createProjectionHash: '6'.repeat(64),
      projectionHashV1: '7'.repeat(64),
      networkEndpointCount: null,
    })
    await expect(reconcileOwnedDockerResources({ ledger, docker }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_OWNERSHIP_UNPROVEN' })
    ledger.close()
  })

  it('detects a valid-integer high-water rollback before Docker I/O', async () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    const ledger = openActivatedOwnedDockerResourceLedger({ root, activation })
    const docker = new EmptyDocker()
    await reconcileOwnedDockerResources({ ledger, docker })
    const active = (await activationFixture.activate(ledger, docker)).activeEpoch
    active.prepare({
      version: 2,
      sidecarKind: 'whisper',
      policyHash: '4'.repeat(64),
      resources: [{
        version: 2,
        role: 'worker',
        resourceKind: 'container',
        createProjectionContract: 'container-selected-v2',
        createProjectionHash: '5'.repeat(64),
      }],
    })
    docker.calls = 0
    const db = new Database(join(root, OWNED_DOCKER_LEDGER_FILENAME), { fileMustExist: true })
    db.prepare('UPDATE ledger_meta SET operation_seq = 0').run()
    db.close()
    await expect(reconcileOwnedDockerResources({ ledger, docker }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_CORRUPT' })
    expect(docker.calls).toBe(0)
    ledger.close()
  })

  it('detects persisted endpoint identity tampering during read-only preflight', () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    const db = new Database(path, { fileMustExist: true })
    db.prepare('UPDATE ledger_meta SET endpoint_binding_hash = ?').run('8'.repeat(64))
    db.close()
    expect(() => openActivatedOwnedDockerResourceLedger({ root, activation }))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_CORRUPT' }))
  })

  it('rejects a wrong attested daemon before probe, scan, or manager rotation', async () => {
    const root = ledgerRoot()
    const activation = bootstrap(root)
    const ledger = openActivatedOwnedDockerResourceLedger({ root, activation })
    const docker = new EmptyDocker()
    docker.endpointIdentity = { ...ENDPOINT_IDENTITY, endpointBindingHash: '8'.repeat(64) }
    await expect(reconcileOwnedDockerResources({ ledger, docker }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' })
    expect(docker.calls).toBe(0)
    const db = new Database(join(root, OWNED_DOCKER_LEDGER_FILENAME), { readonly: true })
    expect(db.prepare('SELECT manager_state, manager_epoch FROM ledger_meta').get())
      .toEqual({ manager_state: 'recovery', manager_epoch: 0 })
    db.close()
    ledger.close()
  })

  it.each([
    ['inherited port property', (docker: EmptyDocker) => {
      const inherited = Object.create(Object.getPrototypeOf(docker)) as object
      Object.defineProperty(inherited, 'endpointIdentity', {
        value: ENDPOINT_IDENTITY, enumerable: true, configurable: true,
      })
      Reflect.deleteProperty(docker, 'endpointIdentity')
      Object.setPrototypeOf(docker, inherited)
    }],
    ['port accessor', (docker: EmptyDocker) => {
      Reflect.deleteProperty(docker, 'endpointIdentity')
      Object.defineProperty(docker, 'endpointIdentity', {
        get: () => ENDPOINT_IDENTITY, enumerable: true, configurable: true,
      })
    }],
    ['extra identity key', (docker: EmptyDocker) => {
      docker.endpointIdentity = {
        ...ENDPOINT_IDENTITY, extra: 'forbidden',
      } as unknown as OwnedDockerEndpointIdentityV1
    }],
    ['symbol identity key', (docker: EmptyDocker) => {
      const identity: Record<PropertyKey, unknown> = { ...ENDPOINT_IDENTITY }
      identity[Symbol('forbidden')] = true
      docker.endpointIdentity = identity as unknown as OwnedDockerEndpointIdentityV1
    }],
  ] as const)('rejects %s at the exact endpoint boundary before Docker I/O', async (_name, mutate) => {
    const root = ledgerRoot()
    const ledger = openActivatedOwnedDockerResourceLedger({ root, activation: bootstrap(root) })
    const docker = new EmptyDocker()
    mutate(docker)
    await expect(reconcileOwnedDockerResources({ ledger, docker }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' })
    expect(docker.calls).toBe(0)
    expect(ledger.listOperations()).toEqual([])
    ledger.close()
  })
})
