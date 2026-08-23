import { dirname, join } from 'node:path'

export interface WorkspaceMigrationLockToken {
  version: 1
  pid: number
  bootId: string
  nonce: string
  acquiredAt: string
}

export type WorkspaceMigrationLockResult =
  | { ok: true; token: WorkspaceMigrationLockToken }
  | { ok: false; code: 'MIGRATION_LOCK_HELD' }

export interface WorkspaceMigrationLock {
  acquire(): WorkspaceMigrationLockResult
  isHeld(token: WorkspaceMigrationLockToken): boolean
  release(token: WorkspaceMigrationLockToken): boolean
}

export interface WorkspaceMigrationLockDeps {
  lockPath: string
  createDirectoryExclusive(path: string): boolean
  writeFile(path: string, content: string): void
  readFile(path: string): string | undefined
  syncFile(path: string): void
  syncDirectory(path: string): void
  removeFile(path: string): void
  removeDirectory(path: string): void
  nowIso(): string
  pid: number
  bootId: string
  newNonce(): string
}

function serialize(token: WorkspaceMigrationLockToken): string {
  return JSON.stringify(token) + '\n'
}

/**
 * Exclusive migration lock backed by atomic directory creation. It never
 * performs time-based or corrupt-file takeover: recovery of an abandoned lock
 * is a separate, operator-visible doctor operation.
 */
export function makeWorkspaceMigrationLock(
  deps: WorkspaceMigrationLockDeps,
): WorkspaceMigrationLock {
  const ownerPath = join(deps.lockPath, 'owner.json')
  const parentPath = dirname(deps.lockPath)

  return {
    acquire() {
      if (!deps.createDirectoryExclusive(deps.lockPath)) {
        return { ok: false, code: 'MIGRATION_LOCK_HELD' }
      }
      const token: WorkspaceMigrationLockToken = {
        version: 1,
        pid: deps.pid,
        bootId: deps.bootId,
        nonce: deps.newNonce(),
        acquiredAt: deps.nowIso(),
      }
      try {
        deps.writeFile(ownerPath, serialize(token))
        deps.syncFile(ownerPath)
        deps.syncDirectory(deps.lockPath)
        deps.syncDirectory(parentPath)
        return { ok: true, token }
      } catch (error) {
        try { deps.removeFile(ownerPath) } catch { /* preserve the initialization error */ }
        try { deps.removeDirectory(deps.lockPath) } catch { /* doctor will recover it */ }
        throw error
      }
    },

    isHeld(token) {
      return deps.readFile(ownerPath) === serialize(token)
    },

    release(token) {
      const expected = serialize(token)
      if (deps.readFile(ownerPath) !== expected) return false
      deps.removeFile(ownerPath)
      deps.syncDirectory(deps.lockPath)
      deps.removeDirectory(deps.lockPath)
      deps.syncDirectory(parentPath)
      return true
    },
  }
}
