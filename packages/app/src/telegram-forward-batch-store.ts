import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import {
  fingerprintTelegramForwardUpdate,
  validateTelegramForwardBatchState,
  type TelegramForwardBatchStateV1,
  type TelegramForwardBatchStore,
} from './telegram-forward-batch.js'
import type { ResolvedWorkBinding } from '@aisy/core'

export interface TelegramForwardBatchMaintenance {
  assertSessionIdle(binding: ResolvedWorkBinding): void
  purgeSession(binding: ResolvedWorkBinding): { removed: number }
}

function assertPrivateRegularFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('FORWARD_BATCH_STORE_UNSAFE')
  }
  if (typeof process.geteuid === 'function' && stat.uid !== process.geteuid()) {
    throw new Error('FORWARD_BATCH_STORE_UNSAFE')
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function atomicWrite(path: string, content: string): void {
  const root = dirname(path)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const rootStat = lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) {
    throw new Error('FORWARD_BATCH_STORE_UNSAFE')
  }
  const temporary = join(root, `.${basename(path)}.${randomUUID()}.tmp`)
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, content, { encoding: 'utf8' })
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  syncDirectory(root)
}

export function makeNodeTelegramForwardBatchStore(input: {
  readonly path: string
  readonly archiveDirectory?: string
  /** Deterministic seam for crash-recovery tests. */
  readonly processAlive?: (pid: number) => boolean
  readonly pid?: number
}): TelegramForwardBatchStore & TelegramForwardBatchMaintenance {
  if (!input.path.startsWith('/') || input.path.includes('\0')) {
    throw new Error('FORWARD_BATCH_STORE_PATH_INVALID')
  }
  const archiveDirectory = input.archiveDirectory ?? join(dirname(input.path), 'forward-batch-archive')
  const updatesDirectory = join(archiveDirectory, 'updates')
  const mutationLockDirectory = input.path + '.mutation-locks'
  const ownerPid = input.pid ?? process.pid
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    throw new Error('FORWARD_BATCH_STORE_CONFIG_INVALID')
  }
  const processAlive = input.processAlive ?? ((pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM') return true
      if (code === 'ESRCH') return false
      throw new Error('FORWARD_BATCH_STORE_CORRUPT')
    }
  })

  const lockChecksum = (value: {
    schemaVersion: 1
    pid: number
    token: string
  }): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

  const readLockOwner = (path: string, expectedPid: number, expectedToken: string): void => {
    assertPrivateRegularFile(path)
    const stat = lstatSync(path)
    if (stat.size > 512) throw new Error('FORWARD_BATCH_STORE_CORRUPT')
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      const value = { schemaVersion: 1 as const, pid: expectedPid, token: expectedToken }
      if (parsed['schemaVersion'] !== 1 || parsed['pid'] !== expectedPid ||
        parsed['token'] !== expectedToken || parsed['checksum'] !== lockChecksum(value) ||
        Object.keys(parsed).sort().join(',') !== 'checksum,pid,schemaVersion,token') {
        throw new Error('invalid')
      }
    } catch {
      throw new Error('FORWARD_BATCH_STORE_CORRUPT')
    }
  }

  const TEMP_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const cleanupAtomicTemps = (): void => {
    const cleanup = (
      directory: string,
      belongs: (name: string) => boolean,
    ): void => {
      if (!existsSync(directory)) return
      const rootStat = lstatSync(directory)
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) {
        throw new Error('FORWARD_BATCH_STORE_UNSAFE')
      }
      let removed = false
      for (const name of readdirSync(directory)) {
        if (!belongs(name)) continue
        const match = /^\.(.+)\.([0-9a-f-]{36})\.tmp$/.exec(name)
        if (match === null || !match[1]!.endsWith('.json') || !TEMP_TOKEN.test(match[2]!)) {
          throw new Error('FORWARD_BATCH_STORE_CORRUPT')
        }
        const path = join(directory, name)
        assertPrivateRegularFile(path)
        unlinkSync(path)
        removed = true
      }
      if (removed) syncDirectory(directory)
    }
    const canonicalPrefix = `.${basename(input.path)}.`
    cleanup(dirname(input.path), name => name.startsWith(canonicalPrefix) && name.endsWith('.tmp'))
    cleanup(archiveDirectory, name => name.startsWith('.') && name.endsWith('.tmp'))
    cleanup(updatesDirectory, name => name.startsWith('.') && name.endsWith('.tmp'))
  }

  const withMutationLock = <T>(operation: () => T): T => {
    const root = dirname(input.path)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) {
      throw new Error('FORWARD_BATCH_STORE_UNSAFE')
    }
    mkdirSync(mutationLockDirectory, { recursive: true, mode: 0o700 })
    const lockRootStat = lstatSync(mutationLockDirectory)
    if (!lockRootStat.isDirectory() || lockRootStat.isSymbolicLink() ||
      (lockRootStat.mode & 0o077) !== 0) {
      throw new Error('FORWARD_BATCH_STORE_UNSAFE')
    }
    const token = randomUUID()
    const ownName = `.mutation-${ownerPid}-${token}.json`
    const ownPath = join(mutationLockDirectory, ownName)
    const value = { schemaVersion: 1 as const, pid: ownerPid, token }
    const fd = openSync(ownPath, 'wx', 0o600)
    const owned = fstatSync(fd)
    try {
      writeFileSync(fd, JSON.stringify({ ...value, checksum: lockChecksum(value) }) + '\n', {
        encoding: 'utf8',
      })
      fsyncSync(fd)
      closeSync(fd)
      syncDirectory(mutationLockDirectory)

      let removedStale = false
      for (const name of readdirSync(mutationLockDirectory)) {
        const match = /^\.mutation-([1-9][0-9]*)-([0-9a-f-]{36})\.json$/.exec(name)
        if (match === null) throw new Error('FORWARD_BATCH_STORE_CORRUPT')
        const pid = Number(match[1])
        const markerToken = match[2]!
        if (!Number.isSafeInteger(pid) || pid <= 0 || !TEMP_TOKEN.test(markerToken)) {
          throw new Error('FORWARD_BATCH_STORE_CORRUPT')
        }
        const path = join(mutationLockDirectory, name)
        assertPrivateRegularFile(path)
        if (name === ownName) {
          readLockOwner(path, pid, markerToken)
          continue
        }
        if (processAlive(pid)) {
          readLockOwner(path, pid, markerToken)
          throw new Error('FORWARD_BATCH_STORE_LOCKED')
        }
        // A hard crash can leave zero or partial owner bytes. The exact unique
        // filename plus a dead PID is enough to retire that uncommitted marker;
        // a live owner is always parsed and blocks above.
        unlinkSync(path)
        removedStale = true
      }
      if (removedStale) syncDirectory(mutationLockDirectory)
      cleanupAtomicTemps()
      return operation()
    } finally {
      try { closeSync(fd) } catch { /* descriptor was already closed after publication */ }
      try {
        const current = lstatSync(ownPath)
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev ||
          current.ino !== owned.ino) throw new Error('FORWARD_BATCH_STORE_LOCK_LOST')
        readLockOwner(ownPath, ownerPid, token)
        unlinkSync(ownPath)
        syncDirectory(mutationLockDirectory)
      } catch (error) {
        if (error instanceof Error && error.message === 'FORWARD_BATCH_STORE_LOCK_LOST') throw error
        throw new Error('FORWARD_BATCH_STORE_LOCK_LOST')
      }
    }
  }

  const markerPath = (updateId: number): string => join(updatesDirectory, `${updateId}.json`)
  const markerChecksum = (value: {
    schemaVersion: 1
    updateId: number
    batchId: string
    fingerprint: string
  }): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

  const readMarker = (updateId: number): string | null => {
    if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error('FORWARD_BATCH_INPUT_INVALID')
    const path = markerPath(updateId)
    if (!existsSync(path)) return null
    assertPrivateRegularFile(path)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      const value = {
        schemaVersion: 1 as const,
        updateId,
        batchId: parsed['batchId'],
        fingerprint: parsed['fingerprint'],
      }
      if (parsed['schemaVersion'] !== 1 || parsed['updateId'] !== updateId ||
        typeof value.batchId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(value.batchId) ||
        typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
        parsed['checksum'] !== markerChecksum(value as typeof value & { batchId: string; fingerprint: string }) ||
        Object.keys(parsed).sort().join(',') !== 'batchId,checksum,fingerprint,schemaVersion,updateId') {
        throw new Error('invalid')
      }
      return value.fingerprint
    } catch {
      throw new Error('FORWARD_BATCH_STORE_CORRUPT')
    }
  }

  const load = (): TelegramForwardBatchStateV1 | null => {
    if (!existsSync(input.path)) return null
    assertPrivateRegularFile(input.path)
    try {
      const raw = readFileSync(input.path, 'utf8')
      if (Buffer.byteLength(raw, 'utf8') > 3 * 1024 * 1024) throw new Error('oversize')
      return validateTelegramForwardBatchState(JSON.parse(raw) as unknown)
    } catch {
      throw new Error('FORWARD_BATCH_STORE_CORRUPT')
    }
  }

  const sameSession = (left: ResolvedWorkBinding, right: ResolvedWorkBinding): boolean =>
    left.operatorId === right.operatorId && left.profileId === right.profileId &&
    left.projectId === right.projectId && left.sessionId === right.sessionId

  const terminalMarker = (state: TelegramForwardBatchStateV1): string => {
    const value = {
      schemaVersion: 1 as const,
      batchId: state.batchId,
      status: state.status,
      revision: state.revision,
      checksum: createHash('sha256').update(JSON.stringify({
        schemaVersion: 1,
        batchId: state.batchId,
        status: state.status,
        revision: state.revision,
      })).digest('hex'),
    }
    return JSON.stringify(value, null, 2) + '\n'
  }

  type TerminalMarker = Readonly<{
    schemaVersion: 1
    batchId: string
    status: 'completed' | 'quarantined'
    revision: number
  }>

  const terminalChecksum = (value: TerminalMarker): string => createHash('sha256')
    .update(JSON.stringify(value)).digest('hex')

  const parseTerminalMarker = (raw: string): TerminalMarker => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const value = {
        schemaVersion: 1 as const,
        batchId: parsed['batchId'],
        status: parsed['status'],
        revision: parsed['revision'],
      }
      if (parsed['schemaVersion'] !== 1 ||
        typeof value.batchId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(value.batchId) ||
        (value.status !== 'completed' && value.status !== 'quarantined') ||
        !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
        parsed['checksum'] !== terminalChecksum(value as TerminalMarker) ||
        Object.keys(parsed).sort().join(',') !== 'batchId,checksum,revision,schemaVersion,status') {
        throw new Error('invalid')
      }
      return Object.freeze(value as TerminalMarker)
    } catch {
      throw new Error('FORWARD_BATCH_STORE_CORRUPT')
    }
  }

  type ArchiveEntry = Readonly<
    { kind: 'marker'; path: string; marker: TerminalMarker } |
    { kind: 'legacy-raw'; path: string; state: TelegramForwardBatchStateV1 }
  >

  const readArchiveEntry = (path: string): ArchiveEntry => {
    assertPrivateRegularFile(path)
    const raw = readFileSync(path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > 3 * 1024 * 1024) {
      throw new Error('FORWARD_BATCH_STORE_CORRUPT')
    }
    try {
      const state = validateTelegramForwardBatchState(JSON.parse(raw) as unknown)
      if (state.status !== 'completed' && state.status !== 'quarantined') {
        throw new Error('FORWARD_BATCH_STORE_CORRUPT')
      }
      return { kind: 'legacy-raw', path, state }
    } catch (error) {
      if (error instanceof Error && error.message === 'FORWARD_BATCH_STORE_CORRUPT') {
        // A terminal raw state and a malformed object are distinguished by the
        // strict bounded marker parser below; neither is trusted by filename.
      }
    }
    return { kind: 'marker', path, marker: parseTerminalMarker(raw) }
  }

  const archiveInventory = (): readonly ArchiveEntry[] => {
    if (!existsSync(archiveDirectory)) return []
    const archiveStat = lstatSync(archiveDirectory)
    if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink() ||
      (archiveStat.mode & 0o077) !== 0) throw new Error('FORWARD_BATCH_STORE_UNSAFE')
    const entries: ArchiveEntry[] = []
    for (const name of readdirSync(archiveDirectory)) {
      const path = join(archiveDirectory, name)
      const stat = lstatSync(path)
      if (name === 'updates') {
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
          throw new Error('FORWARD_BATCH_STORE_CORRUPT')
        }
        for (const updateName of readdirSync(path)) {
          const match = /^([0-9]+)\.json$/.exec(updateName)
          if (match === null) throw new Error('FORWARD_BATCH_STORE_CORRUPT')
          readMarker(Number(match[1]))
        }
        continue
      }
      if (!stat.isFile() || stat.isSymbolicLink() || !name.endsWith('.json')) {
        throw new Error('FORWARD_BATCH_STORE_CORRUPT')
      }
      entries.push(readArchiveEntry(path))
    }
    return entries
  }

  return {
    load,
    hasArchived(batchId) {
      if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(batchId)) throw new Error('FORWARD_BATCH_ID_INVALID')
      const path = join(archiveDirectory, `${batchId}.consumed.json`)
      if (!existsSync(path)) return false
      const entry = readArchiveEntry(path)
      const exact = entry.kind === 'marker'
        ? entry.marker.batchId === batchId && entry.marker.status === 'completed'
        : entry.state.batchId === batchId && entry.state.status === 'completed'
      if (!exact) throw new Error('FORWARD_BATCH_STORE_CORRUPT')
      return true
    },
    lookupArchivedUpdate: readMarker,
    save(expectedRevision, next) {
      withMutationLock(() => {
        const current = load()
        if (expectedRevision === null ? current !== null : current?.revision !== expectedRevision) {
          throw new Error('FORWARD_BATCH_STORE_CONFLICT')
        }
        if (expectedRevision === null && existsSync(join(archiveDirectory, `${next.batchId}.consumed.json`))) {
          throw new Error('FORWARD_BATCH_ALREADY_CONSUMED')
        }
        const validated = validateTelegramForwardBatchState(structuredClone(next))
        atomicWrite(input.path, JSON.stringify(validated, null, 2) + '\n')
      })
    },
    archive(expectedRevision) {
      withMutationLock(() => {
        const current = load()
        if (!current || current.revision !== expectedRevision ||
          (current.status !== 'completed' && current.status !== 'quarantined')) {
          throw new Error('FORWARD_BATCH_STORE_CONFLICT')
        }
        mkdirSync(updatesDirectory, { recursive: true, mode: 0o700 })
        const archiveStat = lstatSync(archiveDirectory)
        const updatesStat = lstatSync(updatesDirectory)
        if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink() ||
          (archiveStat.mode & 0o077) !== 0 || !updatesStat.isDirectory() ||
          updatesStat.isSymbolicLink() || (updatesStat.mode & 0o077) !== 0) {
          throw new Error('FORWARD_BATCH_STORE_UNSAFE')
        }
        if (current.status === 'completed') {
          for (const entry of current.order) {
            const value = entry.kind === 'forward'
              ? current.items.find(item => item.updateId === entry.updateId)
              : current.instructions.find(item => item.updateId === entry.updateId)
            if (!value) throw new Error('FORWARD_BATCH_STORE_CORRUPT')
            const fingerprint = fingerprintTelegramForwardUpdate({
              kind: entry.kind,
              binding: current.binding,
              value,
            })
            const marker = {
              schemaVersion: 1 as const,
              updateId: entry.updateId,
              batchId: current.batchId,
              fingerprint,
            }
            const prior = readMarker(entry.updateId)
            if (prior !== null && prior !== fingerprint) throw new Error('FORWARD_BATCH_STORE_CONFLICT')
            if (prior === null) {
              atomicWrite(markerPath(entry.updateId), JSON.stringify({
                ...marker,
                checksum: markerChecksum(marker),
              }, null, 2) + '\n')
            }
          }
        }
        // Raw forwarded text is Session payload, not a forensic receipt. Keep
        // only a bounded marker after terminalization; update fingerprints
        // above remain sufficient for exact replay decisions.
        const target = current.status === 'completed'
          ? join(archiveDirectory, `${current.batchId}.consumed.json`)
          : join(archiveDirectory, `${current.batchId}.quarantined.json`)
        if (existsSync(target)) {
          const prior = readArchiveEntry(target)
          const exactMarker = prior.kind === 'marker' &&
            prior.marker.batchId === current.batchId && prior.marker.status === current.status &&
            prior.marker.revision === current.revision
          const exactLegacy = prior.kind === 'legacy-raw' && prior.state.checksum === current.checksum
          if (!exactMarker && !exactLegacy) throw new Error('FORWARD_BATCH_STORE_CONFLICT')
          if (exactLegacy) atomicWrite(target, terminalMarker(current))
        } else {
          atomicWrite(target, terminalMarker(current))
        }
        unlinkSync(input.path)
        syncDirectory(archiveDirectory)
        if (dirname(input.path) !== archiveDirectory) syncDirectory(dirname(input.path))
      })
    },
    assertSessionIdle(binding) {
      withMutationLock(() => {
        const current = load()
        if (current !== null && sameSession(current.binding, binding) &&
          (current.status === 'collecting' || current.status === 'dispatching')) {
          throw new Error('SESSION_BUSY')
        }
        archiveInventory()
      })
    },
    purgeSession(binding) {
      return withMutationLock(() => {
        let removed = 0
        const current = load()
        if (current !== null && sameSession(current.binding, binding)) {
          if (current.status === 'collecting' || current.status === 'dispatching') {
            throw new Error('SESSION_BUSY')
          }
        }
        const archivedEntries = archiveInventory()
        if (current !== null && sameSession(current.binding, binding)) {
          unlinkSync(input.path)
          syncDirectory(dirname(input.path))
          removed += 1
        }
        for (const entry of archivedEntries) {
          if (entry.kind === 'legacy-raw' && sameSession(entry.state.binding, binding)) {
            unlinkSync(entry.path)
            syncDirectory(archiveDirectory)
            removed += 1
          }
        }
        return { removed }
      })
    },
  }
}
