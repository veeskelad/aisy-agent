import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
}): TelegramForwardBatchStore {
  if (!input.path.startsWith('/') || input.path.includes('\0')) {
    throw new Error('FORWARD_BATCH_STORE_PATH_INVALID')
  }
  const archiveDirectory = input.archiveDirectory ?? join(dirname(input.path), 'forward-batch-archive')
  const updatesDirectory = join(archiveDirectory, 'updates')
  const mutationLockPath = input.path + '.mutation.lock'

  const withMutationLock = <T>(operation: () => T): T => {
    const root = dirname(input.path)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) {
      throw new Error('FORWARD_BATCH_STORE_UNSAFE')
    }
    let fd: number
    try {
      fd = openSync(mutationLockPath, 'wx', 0o600)
    } catch {
      throw new Error('FORWARD_BATCH_STORE_LOCKED')
    }
    const token = randomUUID()
    const owned = fstatSync(fd)
    try {
      writeFileSync(fd, token, { encoding: 'utf8' })
      fsyncSync(fd)
      return operation()
    } finally {
      closeSync(fd)
      try {
        const current = lstatSync(mutationLockPath)
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev ||
          current.ino !== owned.ino) throw new Error('FORWARD_BATCH_STORE_LOCK_LOST')
        unlinkSync(mutationLockPath)
        syncDirectory(root)
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

  return {
    load,
    hasArchived(batchId) {
      if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(batchId)) throw new Error('FORWARD_BATCH_ID_INVALID')
      return existsSync(join(archiveDirectory, `${batchId}.consumed.json`))
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
        // Quarantine dismissal is a recoverable discard, not successful
        // consumption: keep forensic bytes, but allow the operator to resend
        // the exact batch after receiving the recovery notice.
        const target = current.status === 'completed'
          ? join(archiveDirectory, `${current.batchId}.consumed.json`)
          : join(archiveDirectory, `${current.batchId}.quarantined.${randomUUID()}.json`)
        if (existsSync(target)) throw new Error('FORWARD_BATCH_STORE_CONFLICT')
        renameSync(input.path, target)
        syncDirectory(archiveDirectory)
        if (dirname(input.path) !== archiveDirectory) syncDirectory(dirname(input.path))
      })
    },
  }
}
