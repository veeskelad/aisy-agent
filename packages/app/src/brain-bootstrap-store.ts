import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import {
  CorruptBrainBootstrapState,
  validateBrainBootstrapState,
  type BrainBootstrapState,
  type BrainBootstrapStore,
} from '@aisy/core'

type PathKind = 'missing' | 'file' | 'directory' | 'symlink' | 'other'

export interface JsonBrainBootstrapStoreDeps {
  path: string
  kind(path: string): PathKind
  mode(path: string): number | undefined
  readFile(path: string): string
  writeFileExclusive(path: string, content: string): void
  syncFile(path: string): void
  renameFile(from: string, to: string): void
  syncDirectory(path: string): void
  removeFile(path: string): void
  newNonce(): string
}

export type BrainBootstrapStoreErrorCode =
  | 'BRAIN_BOOTSTRAP_UNSAFE_PATH'
  | 'BRAIN_BOOTSTRAP_LOCK_HELD'
  | 'BRAIN_BOOTSTRAP_REVISION_CONFLICT'
  | 'BRAIN_BOOTSTRAP_WRITE_FAILED'
  | 'BRAIN_BOOTSTRAP_CLEANUP_FAILED'

export class BrainBootstrapStoreError extends Error {
  constructor(public readonly code: BrainBootstrapStoreErrorCode) {
    super(code)
    this.name = 'BrainBootstrapStoreError'
  }
}

const MAX_STATE_BYTES = 32 * 1024

function encode(state: BrainBootstrapState): string {
  return JSON.stringify(validateBrainBootstrapState(state), null, 2) + '\n'
}

function assertDirectory(deps: JsonBrainBootstrapStoreDeps, directory: string): void {
  if (deps.kind(directory) !== 'directory') {
    throw new BrainBootstrapStoreError('BRAIN_BOOTSTRAP_UNSAFE_PATH')
  }
}

function assertRegularPrivateFile(deps: JsonBrainBootstrapStoreDeps, path: string): void {
  if (deps.kind(path) !== 'file' || ((deps.mode(path) ?? 0o777) & 0o077) !== 0) {
    throw new BrainBootstrapStoreError('BRAIN_BOOTSTRAP_UNSAFE_PATH')
  }
}

function readState(deps: JsonBrainBootstrapStoreDeps, path: string): BrainBootstrapState {
  assertRegularPrivateFile(deps, path)
  const content = deps.readFile(path)
  if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) {
    throw new CorruptBrainBootstrapState()
  }
  try {
    return validateBrainBootstrapState(JSON.parse(content) as unknown)
  } catch (error) {
    if (error instanceof CorruptBrainBootstrapState) throw error
    if (error instanceof SyntaxError) throw new CorruptBrainBootstrapState()
    throw error
  }
}

function assertTargetKind(deps: JsonBrainBootstrapStoreDeps): PathKind {
  const kind = deps.kind(deps.path)
  if (kind !== 'missing' && kind !== 'file') {
    throw new BrainBootstrapStoreError('BRAIN_BOOTSTRAP_UNSAFE_PATH')
  }
  if (kind === 'file') assertRegularPrivateFile(deps, deps.path)
  return kind
}

/**
 * Durable, compare-and-swap JSON boundary for Brain bootstrap state.
 *
 * A successful save means: exclusive owner lock, exact validated revision,
 * exclusive private temp file, file fsync, atomic rename and directory fsync.
 * Locks are never stolen automatically; an abandoned lock is recovered only
 * by an operator-visible doctor action.
 */
export function makeJsonBrainBootstrapStore(
  deps: JsonBrainBootstrapStoreDeps,
): BrainBootstrapStore {
  const directory = dirname(deps.path)
  const lockPath = deps.path + '.lock'

  return {
    async load(): Promise<BrainBootstrapState | null> {
      assertDirectory(deps, directory)
      const kind = assertTargetKind(deps)
      return kind === 'missing' ? null : readState(deps, deps.path)
    },

    async save(input: BrainBootstrapState): Promise<void> {
      const state = validateBrainBootstrapState(input)
      const content = encode(state)
      const nonce = deps.newNonce()
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(nonce)) {
        throw new BrainBootstrapStoreError('BRAIN_BOOTSTRAP_UNSAFE_PATH')
      }
      const lockContent = `brain-bootstrap-lock-v1:${nonce}\n`
      const tempPath = `${deps.path}.tmp-${nonce}`
      let acquired = false
      let alreadyPublished = false
      let failure: unknown

      const ownsLock = (): boolean => {
        if (deps.kind(lockPath) !== 'file') return false
        try {
          assertRegularPrivateFile(deps, lockPath)
          return deps.readFile(lockPath) === lockContent
        } catch {
          return false
        }
      }

      try {
        assertDirectory(deps, directory)
        assertTargetKind(deps)
        if (deps.kind(lockPath) !== 'missing') {
          throw new BrainBootstrapStoreError('BRAIN_BOOTSTRAP_LOCK_HELD')
        }
        try {
          deps.writeFileExclusive(lockPath, lockContent)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new BrainBootstrapStoreError('BRAIN_BOOTSTRAP_LOCK_HELD')
          }
          throw error
        }
        acquired = true
        deps.syncFile(lockPath)
        deps.syncDirectory(directory)
        if (!ownsLock()) {
          throw new BrainBootstrapStoreError('BRAIN_BOOTSTRAP_LOCK_HELD')
        }

        const currentKind = assertTargetKind(deps)
        if (currentKind === 'missing') {
          if (state.revision !== 1) {
            throw new BrainBootstrapStoreError('BRAIN_BOOTSTRAP_REVISION_CONFLICT')
          }
        } else {
          const current = readState(deps, deps.path)
          const currentContent = encode(current)
          if (current.revision === state.revision && currentContent === content) {
            deps.syncFile(deps.path)
            deps.syncDirectory(directory)
            alreadyPublished = true
          }
          if (!alreadyPublished && current.revision !== state.revision - 1) {
            throw new BrainBootstrapStoreError('BRAIN_BOOTSTRAP_REVISION_CONFLICT')
          }
        }

        if (!alreadyPublished) {
          if (deps.kind(tempPath) !== 'missing') {
            throw new BrainBootstrapStoreError('BRAIN_BOOTSTRAP_UNSAFE_PATH')
          }
          deps.writeFileExclusive(tempPath, content)
          assertRegularPrivateFile(deps, tempPath)
          deps.syncFile(tempPath)
          if (!ownsLock()) {
            throw new BrainBootstrapStoreError('BRAIN_BOOTSTRAP_LOCK_HELD')
          }
          assertTargetKind(deps)
          deps.renameFile(tempPath, deps.path)
          deps.syncDirectory(directory)
        }
      } catch (error) {
        failure = error instanceof BrainBootstrapStoreError ||
          error instanceof CorruptBrainBootstrapState
          ? error
          : new BrainBootstrapStoreError('BRAIN_BOOTSTRAP_WRITE_FAILED')
      } finally {
        try {
          if (deps.kind(tempPath) !== 'missing') deps.removeFile(tempPath)
          if (acquired && ownsLock()) {
            deps.removeFile(lockPath)
            deps.syncDirectory(directory)
          }
        } catch {
          failure ??= new BrainBootstrapStoreError('BRAIN_BOOTSTRAP_CLEANUP_FAILED')
        }
      }

      if (failure !== undefined) throw failure
    },
  }
}

function nodeKind(path: string): PathKind {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return 'symlink'
    if (stat.isFile()) return 'file'
    if (stat.isDirectory()) return 'directory'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function nodeMode(path: string): number | undefined {
  try {
    return lstatSync(path).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function writeExclusive(path: string, content: string): void {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  )
  try {
    writeFileSync(descriptor, content, { encoding: 'utf8' })
  } finally {
    closeSync(descriptor)
  }
}

function syncPath(path: string): void {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function makeNodeBrainBootstrapStore(input: { path: string }): BrainBootstrapStore {
  const directory = dirname(input.path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return makeJsonBrainBootstrapStore({
    path: input.path,
    kind: nodeKind,
    mode: nodeMode,
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFileExclusive: writeExclusive,
    syncFile: syncPath,
    renameFile: (from, to) => renameSync(from, to),
    syncDirectory: syncPath,
    removeFile: (path) => unlinkSync(path),
    newNonce: () => `${process.pid}-${randomUUID()}`,
  })
}
