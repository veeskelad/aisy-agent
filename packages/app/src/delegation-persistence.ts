import {
  type DelegationId,
  type DelegationPersistencePort,
  type DelegationQuarantineReason,
  type PersistedDelegationV1,
  type PersistedDelegationRunV1,
} from '@aisy/core'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  isGenuineExecutionSupervisorRecoveryContextV1,
  type ExecutionSupervisorRecoveryContextV1,
} from './execution-supervisor-ipc.js'

interface DelegationManifestV1 {
  storageSchemaVersion: 1
  shardSha256: string
  checkpointSha256: string
  state: Omit<PersistedDelegationV1, 'entries' | 'checkpoint'>
}

const MAX_JSON_BYTES = 1024 * 1024
const MAX_SHARD_BYTES = 32 * 1024 * 1024
const RUN_LOCK_TOKEN = /^[1-9][0-9]{0,19}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function byteLimitFor(path: string): number {
  return path.endsWith('.jsonl') ? MAX_SHARD_BYTES : MAX_JSON_BYTES
}

function assertBounded(path: string, content: string): void {
  if (Buffer.byteLength(content, 'utf8') > byteLimitFor(path)) {
    throw new Error('delegation persistence file exceeds size limit')
  }
}

export interface DelegationPersistenceDeps {
  root: string
  exists(path: string): boolean
  readFile(path: string): string
  ensureDirectory(path: string): void
  saveAtomic(path: string, content: string): void
  nowIso(): string
}

function assertSafeId(id: DelegationId): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw new Error('unsafe delegation id')
  }
}

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function paths(root: string, id: DelegationId) {
  assertSafeId(id)
  const delegations = join(root, 'delegations')
  const directory = join(delegations, id)
  return {
    delegations,
    directory,
    shard: join(delegations, `${id}.jsonl`),
    checkpoint: join(directory, 'checkpoint.json'),
    manifest: join(directory, 'manifest.json'),
    quarantine: join(directory, 'quarantine.json'),
  }
}

function parseShard(content: string): unknown[] {
  if (content.trim().length === 0) return []
  return content.trimEnd().split('\n').map(line => JSON.parse(line) as unknown)
}

/**
 * Durable ADR-0039 adapter. The manifest is committed last and contains hashes
 * of the shard/checkpoint files, so a crash between renames is detected and
 * Core quarantines the mixed snapshot instead of resuming it.
 */
export function makeDelegationPersistence(
  deps: DelegationPersistenceDeps,
): DelegationPersistencePort {
  return {
    loadRun() {
      const path = join(deps.root, 'run-state.json')
      if (!deps.exists(path)) return undefined
      try {
        return JSON.parse(deps.readFile(path)) as unknown
      } catch {
        return { storageStatus: 'invalid-run-state' }
      }
    },

    load(delegationId) {
      const p = paths(deps.root, delegationId)
      if (deps.exists(p.quarantine)) {
        try {
          const marker = JSON.parse(deps.readFile(p.quarantine)) as {
            reason?: DelegationQuarantineReason
          }
          return { storageStatus: 'quarantined', reason: marker.reason }
        } catch {
          return { storageStatus: 'quarantined', reason: 'legacy-or-invalid-state' }
        }
      }
      if (!deps.exists(p.manifest) && !deps.exists(p.shard) && !deps.exists(p.checkpoint)) {
        return undefined
      }
      try {
        const manifestContent = deps.readFile(p.manifest)
        const shardContent = deps.readFile(p.shard)
        const checkpointContent = deps.readFile(p.checkpoint)
        const manifest = JSON.parse(manifestContent) as DelegationManifestV1
        if (manifest.storageSchemaVersion !== 1 ||
          manifest.shardSha256 !== digest(shardContent) ||
          manifest.checkpointSha256 !== digest(checkpointContent)) {
          return { storageStatus: 'invalid-or-torn-snapshot' }
        }
        return {
          ...manifest.state,
          entries: parseShard(shardContent),
          checkpoint: JSON.parse(checkpointContent) as unknown,
        }
      } catch {
        return { storageStatus: 'invalid-or-torn-snapshot' }
      }
    },

    save(state) {
      const id = state.checkpoint.delegationId
      const p = paths(deps.root, id)
      deps.ensureDirectory(p.directory)
      const shardContent = state.entries.map(entry => JSON.stringify(entry)).join('\n') +
        (state.entries.length === 0 ? '' : '\n')
      const checkpointContent = JSON.stringify(state.checkpoint, null, 2) + '\n'
      const { entries: _entries, checkpoint: _checkpoint, ...manifestState } = state
      const manifest: DelegationManifestV1 = {
        storageSchemaVersion: 1,
        shardSha256: digest(shardContent),
        checkpointSha256: digest(checkpointContent),
        state: manifestState,
      }
      deps.saveAtomic(p.shard, shardContent)
      deps.saveAtomic(p.checkpoint, checkpointContent)
      deps.saveAtomic(p.manifest, JSON.stringify(manifest, null, 2) + '\n')
    },

    saveRun(state: PersistedDelegationRunV1) {
      deps.saveAtomic(join(deps.root, 'run-state.json'), JSON.stringify(state, null, 2) + '\n')
    },

    quarantine(delegationId, reason) {
      const p = paths(deps.root, delegationId)
      deps.ensureDirectory(p.directory)
      deps.saveAtomic(p.quarantine, JSON.stringify({
        storageSchemaVersion: 1,
        delegationId,
        reason,
        quarantinedAt: deps.nowIso(),
      }, null, 2) + '\n')
    },
  }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function assertPrivateDirectory(path: string): void {
  const canonical = resolve(path)
  const info = lstatSync(canonical)
  const owner = typeof process.getuid === 'function' ? process.getuid() : info.uid
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(canonical) !== canonical ||
    info.uid !== owner || (info.mode & 0o077) !== 0) {
    throw new Error('delegation persistence directory is not private and canonical')
  }
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
  assertPrivateDirectory(path)
}

function readPrivateFile(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = fstatSync(descriptor)
    const owner = typeof process.getuid === 'function' ? process.getuid() : info.uid
    if (!info.isFile() || info.nlink !== 1 || info.uid !== owner || (info.mode & 0o077) !== 0 ||
      info.size > byteLimitFor(path)) {
      throw new Error('delegation persistence file is not private or exceeds size limit')
    }
    return readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

export interface NodeDelegationRunLock {
  acquire(): () => void
}

export function makeNodeDelegationRunLock(runRoot: string): NodeDelegationRunLock {
  assertPrivateDirectory(runRoot)
  const lockPath = join(runRoot, '.runtime.lock')
  return {
    acquire() {
      const token = `${process.pid}:${randomUUID()}`
      let descriptor: number
      try {
        descriptor = openSync(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        )
      } catch {
        throw new Error('delegation run lock held')
      }
      try {
        writeFileSync(descriptor, token, 'utf8')
        fsyncSync(descriptor)
      } catch (error) {
        try { unlinkSync(lockPath) } catch { /* fail closed on the original error */ }
        throw error
      } finally {
        closeSync(descriptor)
      }
      syncPath(runRoot)
      let released = false
      return () => {
        if (released) return
        released = true
        if (readPrivateFile(lockPath) !== token) {
          throw new Error('delegation run lock ownership lost')
        }
        unlinkSync(lockPath)
        syncPath(runRoot)
      }
    },
  }
}

/**
 * Removes only the exact legacy O_EXCL run-lock token after the parent
 * supervisor has proved process quiescence. PID and file age are validated as
 * syntax only and never used as takeover evidence.
 */
export function recoverNodeDelegationRunLockAfterQuiescence(input: Readonly<{
  runRoot: string
  context: ExecutionSupervisorRecoveryContextV1
}>): 'absent' | 'recovered' {
  if (!isGenuineExecutionSupervisorRecoveryContextV1(input.context) ||
    !input.context.isHeld()) {
    throw new Error('delegation run lock recovery authority invalid')
  }
  const runRoot = resolve(input.runRoot)
  assertPrivateDirectory(runRoot)
  const lockPath = join(runRoot, '.runtime.lock')
  let before: ReturnType<typeof lstatSync>
  try { before = lstatSync(lockPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }
  const owner = typeof process.getuid === 'function' ? process.getuid() : before.uid
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
    before.uid !== owner || (before.mode & 0o077) !== 0 || before.size > 128) {
    throw new Error('delegation run lock recovery target invalid')
  }
  const descriptor = openSync(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let token: string
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.nlink !== 1 || opened.uid !== owner || (opened.mode & 0o077) !== 0 ||
      opened.size > 128) {
      throw new Error('delegation run lock recovery target drifted')
    }
    token = readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
  if (!RUN_LOCK_TOKEN.test(token) || !input.context.isHeld()) {
    throw new Error('delegation run lock recovery target invalid')
  }
  const current = lstatSync(lockPath)
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev ||
    current.ino !== before.ino || current.nlink !== 1 || current.uid !== owner ||
    (current.mode & 0o077) !== 0 || !input.context.isHeld()) {
    throw new Error('delegation run lock recovery target drifted')
  }
  unlinkSync(lockPath)
  syncPath(runRoot)
  if (!input.context.isHeld()) {
    throw new Error('delegation run lock recovery authority lost')
  }
  return 'recovered'
}

export function makeNodeDelegationPersistence(input: {
  runRoot: string
  nowIso?: () => string
  /** Recovery inspection must never create a missing durable run root. */
  createIfMissing?: boolean
}): DelegationPersistencePort {
  const runRoot = resolve(input.runRoot)
  if (!existsSync(runRoot)) {
    if (input.createIfMissing === false) {
      throw new Error('delegation persistence root missing')
    }
    const parent = dirname(runRoot)
    assertPrivateDirectory(parent)
    mkdirSync(join(parent, basename(runRoot)), { mode: 0o700 })
  }
  assertPrivateDirectory(runRoot)
  return makeDelegationPersistence({
    root: runRoot,
    exists: path => existsSync(path),
    readFile: readPrivateFile,
    ensureDirectory: path => {
      const parent = dirname(path)
      if (parent !== runRoot) ensurePrivateDirectory(parent)
      ensurePrivateDirectory(path)
    },
    saveAtomic: (path, content) => {
      assertBounded(path, content)
      const directory = dirname(path)
      if (directory !== runRoot) {
        const parent = dirname(directory)
        if (parent !== runRoot) ensurePrivateDirectory(parent)
        ensurePrivateDirectory(directory)
      } else {
        assertPrivateDirectory(directory)
      }
      const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`
      const descriptor = openSync(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      try {
        writeFileSync(descriptor, content, 'utf8')
        fsyncSync(descriptor)
      } catch (error) {
        try { unlinkSync(tempPath) } catch { /* best-effort temp cleanup */ }
        throw error
      } finally {
        closeSync(descriptor)
      }
      try {
        renameSync(tempPath, path)
      } catch (error) {
        try { unlinkSync(tempPath) } catch { /* best-effort temp cleanup */ }
        throw error
      }
      const published = lstatSync(path)
      if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1 ||
        (published.mode & 0o077) !== 0) {
        throw new Error('delegation persistence publication is not private')
      }
      syncPath(directory)
    },
    nowIso: input.nowIso ?? (() => new Date().toISOString()),
  })
}

export type { DelegationQuarantineReason }
