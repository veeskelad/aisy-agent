// Durable state owned by the parent execution supervisor (ADR-0071).
//
// The child never receives this root. Only opaque hashes, restart counters and
// protocol identifiers are stored here; Telegram content and credentials are
// deliberately outside the schema.

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import type { Stats } from 'node:fs'
import {
  acquireExecutionSupervisorManagerLease,
  resolveExecutionSupervisorChildLivenessRoot,
  waitForExecutionSupervisorChildLivenessFence,
  type ExecutionSupervisorChildLivenessLease,
  type ExecutionSupervisorSqliteLease,
} from './execution-supervisor-liveness.js'

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9_-]{16,64}$/
const MAX_STATE_BYTES = 64 * 1024

export type ExecutionSupervisorQuarantineCode =
  | 'RESTART_BUDGET_EXHAUSTED'
  | 'SUPERVISOR_PREVIOUS_EXIT_UNCLEAN'
  | 'SUPERVISOR_STATE_UNAVAILABLE'
  | 'OWNED_DOCKER_RECOVERY_UNAVAILABLE'

export type ExecutionSupervisorAuthorityState =
  | {
      phase: 'captured-unbound'
      bindingHash: string
      leaseId: string
      capturedAtMs: number
    }

  | {
      phase: 'checkpoint-bound'
      bindingHash: string
      leaseId: string
      capturedAtMs: number
      boundAtMs: number
    }
  | {
      phase: 'recovery-leased'
      authorityPhase: 'captured-unbound' | 'checkpoint-bound'
      bindingHash: string
      leaseId: string
      leasedToSessionId: string
      leasedAtMs: number
    }

export interface ExecutionSupervisorReleaseReceiptV1 {
  readonly releaseIntentHash: string
  readonly envelopeHash: string
  readonly receiptHash: string
  readonly bindingHash: string
  readonly runLivenessHash: string
  readonly authorityPhase: 'captured-unbound' | 'checkpoint-bound'
  readonly releasedAtMs: number
}

export interface ExecutionSupervisorStateV1 {
  schemaVersion: 1
  revision: number
  manager: {
    epoch: string
    cleanShutdown: boolean
    startedAtMs: number
  }
  authority: ExecutionSupervisorAuthorityState | null
  restart: {
    unexpectedExitMs: number[]
    consecutiveUnexpectedExits: number
    quarantine: null | {
      code: ExecutionSupervisorQuarantineCode
      atMs: number
    }
  }
  checksum: string
}

export interface ExecutionSupervisorStateV2 {
  schemaVersion: 2
  revision: number
  manager: ExecutionSupervisorStateV1['manager']
  authority: ExecutionSupervisorAuthorityState | null
  releaseReceipt: ExecutionSupervisorReleaseReceiptV1 | null
  restart: ExecutionSupervisorStateV1['restart']
  checksum: string
}

export type ExecutionSupervisorState = ExecutionSupervisorStateV1 | ExecutionSupervisorStateV2

export type ExecutionSupervisorStateLoadResult =
  | { kind: 'missing' }
  | { kind: 'ready'; state: ExecutionSupervisorState }
  | { kind: 'refused'; code: 'UNSAFE_STATE_ROOT' | 'CORRUPT_STATE' | 'UNSAFE_PERMISSIONS' }

export interface ExecutionSupervisorStateStore {
  acquireManagerLease(): ExecutionSupervisorManagerLease
  acquireChildLivenessFence(signal: AbortSignal): Promise<ExecutionSupervisorChildLivenessLease>
  load(): ExecutionSupervisorStateLoadResult
  publish(state: ExecutionSupervisorStateV2): void
}

export interface ExecutionSupervisorManagerLease {
  isHeld(): boolean
  release(): void
}

export class ExecutionSupervisorStateError extends Error {
  readonly code: 'STATE_UNAVAILABLE' | 'STATE_CONFLICT'

  constructor(code: 'STATE_UNAVAILABLE' | 'STATE_CONFLICT') {
    super(code)
    this.name = 'ExecutionSupervisorStateError'
    this.code = code
  }
}

type StateWithoutChecksum =
  | Omit<ExecutionSupervisorStateV1, 'checksum'>
  | Omit<ExecutionSupervisorStateV2, 'checksum'>

function exactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && own.every((key) => keys.includes(key))
}

function safeMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function canonicalPayload(state: StateWithoutChecksum): string {
  const authority = state.authority === null
    ? null
    : state.authority.phase === 'captured-unbound'
      ? {
          phase: 'captured-unbound' as const,
          bindingHash: state.authority.bindingHash,
          leaseId: state.authority.leaseId,
          capturedAtMs: state.authority.capturedAtMs,
        }
      : state.authority.phase === 'checkpoint-bound'
        ? {
            phase: 'checkpoint-bound' as const,
            bindingHash: state.authority.bindingHash,
            leaseId: state.authority.leaseId,
            capturedAtMs: state.authority.capturedAtMs,
            boundAtMs: state.authority.boundAtMs,
          }
      : {
          phase: 'recovery-leased' as const,
          authorityPhase: state.authority.authorityPhase,
          bindingHash: state.authority.bindingHash,
          leaseId: state.authority.leaseId,
          leasedToSessionId: state.authority.leasedToSessionId,
          leasedAtMs: state.authority.leasedAtMs,
        }
  const releaseReceipt = state.schemaVersion === 2 && state.releaseReceipt !== null
    ? {
        releaseIntentHash: state.releaseReceipt.releaseIntentHash,
        envelopeHash: state.releaseReceipt.envelopeHash,
        receiptHash: state.releaseReceipt.receiptHash,
        bindingHash: state.releaseReceipt.bindingHash,
        runLivenessHash: state.releaseReceipt.runLivenessHash,
        authorityPhase: state.releaseReceipt.authorityPhase,
        releasedAtMs: state.releaseReceipt.releasedAtMs,
      }
    : null
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    manager: {
      epoch: state.manager.epoch,
      cleanShutdown: state.manager.cleanShutdown,
      startedAtMs: state.manager.startedAtMs,
    },
    authority,
    ...(state.schemaVersion === 2 ? { releaseReceipt } : {}),
    restart: {
      unexpectedExitMs: [...state.restart.unexpectedExitMs],
      consecutiveUnexpectedExits: state.restart.consecutiveUnexpectedExits,
      quarantine: state.restart.quarantine === null
        ? null
        : {
            code: state.restart.quarantine.code,
            atMs: state.restart.quarantine.atMs,
          },
    },
  })
}

export function withExecutionSupervisorStateChecksum(
  state: Omit<ExecutionSupervisorStateV1, 'checksum'>,
): ExecutionSupervisorStateV1
export function withExecutionSupervisorStateChecksum(
  state: Omit<ExecutionSupervisorStateV2, 'checksum'>,
): ExecutionSupervisorStateV2
export function withExecutionSupervisorStateChecksum(
  state: StateWithoutChecksum,
): ExecutionSupervisorState {
  const checksum = createHash('sha256').update(canonicalPayload(state)).digest('hex')
  return { ...state, checksum } as ExecutionSupervisorState
}

export function makeExecutionSupervisorState(input: {
  epoch: string
  startedAtMs: number
}): ExecutionSupervisorStateV2 {
  return withExecutionSupervisorStateChecksum({
    schemaVersion: 2,
    revision: 1,
    manager: {
      epoch: input.epoch,
      cleanShutdown: false,
      startedAtMs: input.startedAtMs,
    },
    authority: null,
    releaseReceipt: null,
    restart: {
      unexpectedExitMs: [],
      consecutiveUnexpectedExits: 0,
      quarantine: null,
    },
  }) as ExecutionSupervisorStateV2
}

export function migrateExecutionSupervisorStateV1(
  state: ExecutionSupervisorStateV1,
): ExecutionSupervisorStateV2 {
  const checked = decodeState(JSON.stringify(state))
  if (checked === null || checked.schemaVersion !== 1) {
    throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
  }
  return withExecutionSupervisorStateChecksum({
    schemaVersion: 2,
    revision: checked.revision + 1,
    manager: checked.manager,
    authority: checked.authority,
    releaseReceipt: null,
    restart: checked.restart,
  }) as ExecutionSupervisorStateV2
}

export function resolveExecutionSupervisorStateRoot(input: {
  platform: NodeJS.Platform
  home: string
  xdgStateHome?: string
}): string {
  if (input.platform === 'darwin') {
    return join(input.home, 'Library', 'Application Support', 'Aisy', 'supervisor')
  }
  const stateHome = input.xdgStateHome === undefined || input.xdgStateHome === ''
    ? join(input.home, '.local', 'state')
    : input.xdgStateHome
  return join(stateHome, 'aisy', 'supervisor')
}

function decodeState(raw: string): ExecutionSupervisorState | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    return null
  }
  const record = value as Record<string, unknown>
  const schemaVersion = record['schemaVersion']
  if ((schemaVersion !== 1 && schemaVersion !== 2) ||
    !exactKeys(value, schemaVersion === 1
      ? ['schemaVersion', 'revision', 'manager', 'authority', 'restart', 'checksum']
      : ['schemaVersion', 'revision', 'manager', 'authority', 'releaseReceipt', 'restart', 'checksum']) ||
    !Number.isSafeInteger(record['revision']) ||
    Number(record['revision']) < 1 || typeof record['checksum'] !== 'string' ||
    !HASH.test(record['checksum'])) return null

  const manager = record['manager']
  if (typeof manager !== 'object' || manager === null || Array.isArray(manager) ||
    !exactKeys(manager, ['epoch', 'cleanShutdown', 'startedAtMs'])) return null
  const managerRecord = manager as Record<string, unknown>
  if (typeof managerRecord['epoch'] !== 'string' || !ID.test(managerRecord['epoch']) ||
    typeof managerRecord['cleanShutdown'] !== 'boolean' || !safeMs(managerRecord['startedAtMs'])) return null

  let authority: ExecutionSupervisorAuthorityState | null = null
  const authorityInput = record['authority']
  if (authorityInput !== null) {
    if (typeof authorityInput !== 'object' || Array.isArray(authorityInput)) return null
    const authorityRecord = authorityInput as Record<string, unknown>
    if (authorityRecord['phase'] === 'captured-unbound') {
      if (!exactKeys(authorityInput, ['phase', 'bindingHash', 'leaseId', 'capturedAtMs']) ||
        typeof authorityRecord['bindingHash'] !== 'string' || !HASH.test(authorityRecord['bindingHash']) ||
        typeof authorityRecord['leaseId'] !== 'string' || !ID.test(authorityRecord['leaseId']) ||
        !safeMs(authorityRecord['capturedAtMs'])) return null
      authority = {
        phase: 'captured-unbound',
        bindingHash: authorityRecord['bindingHash'],
        leaseId: authorityRecord['leaseId'],
        capturedAtMs: authorityRecord['capturedAtMs'],
      }
    } else if (authorityRecord['phase'] === 'checkpoint-bound') {
      if (!exactKeys(authorityInput, ['phase', 'bindingHash', 'leaseId', 'capturedAtMs', 'boundAtMs']) ||
        typeof authorityRecord['bindingHash'] !== 'string' || !HASH.test(authorityRecord['bindingHash']) ||
        typeof authorityRecord['leaseId'] !== 'string' || !ID.test(authorityRecord['leaseId']) ||
        !safeMs(authorityRecord['capturedAtMs']) || !safeMs(authorityRecord['boundAtMs']) ||
        authorityRecord['boundAtMs'] < authorityRecord['capturedAtMs']) return null
      authority = {
        phase: 'checkpoint-bound',
        bindingHash: authorityRecord['bindingHash'],
        leaseId: authorityRecord['leaseId'],
        capturedAtMs: authorityRecord['capturedAtMs'],
        boundAtMs: authorityRecord['boundAtMs'],
      }
    } else if (authorityRecord['phase'] === 'recovery-leased') {
      if (!exactKeys(authorityInput, ['phase', 'authorityPhase', 'bindingHash', 'leaseId', 'leasedToSessionId', 'leasedAtMs']) ||
        !['captured-unbound', 'checkpoint-bound'].includes(String(authorityRecord['authorityPhase'])) ||
        typeof authorityRecord['bindingHash'] !== 'string' || !HASH.test(authorityRecord['bindingHash']) ||
        typeof authorityRecord['leaseId'] !== 'string' || !ID.test(authorityRecord['leaseId']) ||
        typeof authorityRecord['leasedToSessionId'] !== 'string' || !ID.test(authorityRecord['leasedToSessionId']) ||
        !safeMs(authorityRecord['leasedAtMs'])) return null
      authority = {
        phase: 'recovery-leased',
        authorityPhase: authorityRecord['authorityPhase'] as 'captured-unbound' | 'checkpoint-bound',
        bindingHash: authorityRecord['bindingHash'],
        leaseId: authorityRecord['leaseId'],
        leasedToSessionId: authorityRecord['leasedToSessionId'],
        leasedAtMs: authorityRecord['leasedAtMs'],
      }
    } else {
      return null
    }
  }

  let releaseReceipt: ExecutionSupervisorReleaseReceiptV1 | null = null
  if (schemaVersion === 2 && record['releaseReceipt'] !== null) {
    const receiptInput = record['releaseReceipt']
    if (typeof receiptInput !== 'object' || Array.isArray(receiptInput) ||
      !exactKeys(receiptInput, [
        'releaseIntentHash', 'envelopeHash', 'receiptHash', 'bindingHash',
        'runLivenessHash', 'authorityPhase', 'releasedAtMs',
      ])) return null
    const receipt = receiptInput as Record<string, unknown>
    if (typeof receipt['releaseIntentHash'] !== 'string' || !HASH.test(receipt['releaseIntentHash']) ||
      typeof receipt['envelopeHash'] !== 'string' || !HASH.test(receipt['envelopeHash']) ||
      typeof receipt['receiptHash'] !== 'string' || !HASH.test(receipt['receiptHash']) ||
      typeof receipt['bindingHash'] !== 'string' || !HASH.test(receipt['bindingHash']) ||
      typeof receipt['runLivenessHash'] !== 'string' || !HASH.test(receipt['runLivenessHash']) ||
      !['captured-unbound', 'checkpoint-bound'].includes(String(receipt['authorityPhase'])) ||
      !safeMs(receipt['releasedAtMs'])) return null
    releaseReceipt = {
      releaseIntentHash: receipt['releaseIntentHash'],
      envelopeHash: receipt['envelopeHash'],
      receiptHash: receipt['receiptHash'],
      bindingHash: receipt['bindingHash'],
      runLivenessHash: receipt['runLivenessHash'],
      authorityPhase: receipt['authorityPhase'] as 'captured-unbound' | 'checkpoint-bound',
      releasedAtMs: receipt['releasedAtMs'],
    }
  }
  if (schemaVersion === 2 && authority !== null && releaseReceipt !== null) return null

  const restart = record['restart']
  if (typeof restart !== 'object' || restart === null || Array.isArray(restart) ||
    !exactKeys(restart, ['unexpectedExitMs', 'consecutiveUnexpectedExits', 'quarantine'])) return null
  const restartRecord = restart as Record<string, unknown>
  if (!Array.isArray(restartRecord['unexpectedExitMs']) ||
    restartRecord['unexpectedExitMs'].length > 5 ||
    !restartRecord['unexpectedExitMs'].every(safeMs) ||
    restartRecord['unexpectedExitMs'].some((entry, index, all) => index > 0 && Number(entry) < Number(all[index - 1])) ||
    !Number.isSafeInteger(restartRecord['consecutiveUnexpectedExits']) ||
    Number(restartRecord['consecutiveUnexpectedExits']) < 0) return null

  let quarantine: ExecutionSupervisorStateV1['restart']['quarantine'] = null
  const quarantineInput = restartRecord['quarantine']
  if (quarantineInput !== null) {
    if (typeof quarantineInput !== 'object' || Array.isArray(quarantineInput) ||
      !exactKeys(quarantineInput, ['code', 'atMs'])) return null
    const quarantineRecord = quarantineInput as Record<string, unknown>
    if (!['RESTART_BUDGET_EXHAUSTED', 'SUPERVISOR_PREVIOUS_EXIT_UNCLEAN',
      'SUPERVISOR_STATE_UNAVAILABLE', 'OWNED_DOCKER_RECOVERY_UNAVAILABLE']
      .includes(String(quarantineRecord['code'])) || !safeMs(quarantineRecord['atMs'])) return null
    quarantine = {
      code: quarantineRecord['code'] as ExecutionSupervisorQuarantineCode,
      atMs: quarantineRecord['atMs'],
    }
  }

  const common = {
    revision: Number(record['revision']),
    manager: {
      epoch: managerRecord['epoch'],
      cleanShutdown: managerRecord['cleanShutdown'],
      startedAtMs: managerRecord['startedAtMs'],
    },
    authority,
    restart: {
      unexpectedExitMs: (restartRecord['unexpectedExitMs'] as number[]).map(Number),
      consecutiveUnexpectedExits: Number(restartRecord['consecutiveUnexpectedExits']),
      quarantine,
    },
  }
  const withoutChecksum: StateWithoutChecksum = schemaVersion === 1
    ? { schemaVersion: 1, ...common }
    : { schemaVersion: 2, ...common, releaseReceipt }
  const checksum = createHash('sha256').update(canonicalPayload(withoutChecksum)).digest('hex')
  return checksum === record['checksum']
    ? { ...withoutChecksum, checksum } as ExecutionSupervisorState
    : null
}

interface PrivateDirectory {
  fd: number
  path: string
  uid: number
  dev: number
  ino: number
}

interface OwnedFile {
  uid: number
  dev: number
  ino: number
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) {
    throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
  }
  return Number(uid)
}

function noFollowFlag(): number {
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
  }
  return constants.O_NOFOLLOW
}

function directoryFlag(): number {
  if (!Number.isInteger(constants.O_DIRECTORY)) {
    throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
  }
  return constants.O_DIRECTORY
}

function sameIdentity(value: { dev: number; ino: number }, owned: { dev: number; ino: number }): boolean {
  return value.dev === owned.dev && value.ino === owned.ino
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function ensurePathWithoutSymlink(path: string): void {
  const absolute = resolve(path)
  if (!isAbsolute(absolute)) throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
  const parsed = parse(absolute)
  let current = parsed.root
  const components = absolute.slice(parsed.root.length).split(sep).filter((part) => part !== '')
  for (const [index, component] of components.entries()) {
    current = join(current, component)
    let stat: Stats | null = null
    try {
      stat = lstatSync(current)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
    }
    if (stat === null) {
      try {
        mkdirSync(current, { mode: index === components.length - 1 ? 0o700 : 0o700 })
      } catch {
        throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
      }
      stat = lstatSync(current)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
    }
  }
}

function openPrivateDirectory(path: string): PrivateDirectory {
  const uid = currentUid()
  ensurePathWithoutSymlink(path)
  let before: Stats
  try {
    before = lstatSync(path)
  } catch {
    throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
  }
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid ||
    (before.mode & 0o777) !== 0o700) {
    throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
  }
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
  } catch {
    throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isDirectory() || opened.uid !== uid || (opened.mode & 0o777) !== 0o700 ||
      !sameIdentity(opened, before)) throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
    return { fd, path, uid, dev: opened.dev, ino: opened.ino }
  } catch (error) {
    try { closeSync(fd) } catch { /* retain code-only failure */ }
    if (error instanceof ExecutionSupervisorStateError) throw error
    throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
  }
}

function assertDirectoryIdentity(directory: PrivateDirectory): void {
  let current: Stats
  try {
    current = lstatSync(directory.path)
  } catch {
    throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
  }
  if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== directory.uid ||
    (current.mode & 0o777) !== 0o700 || !sameIdentity(current, directory)) {
    throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
  }
  const opened = fstatSync(directory.fd)
  if (!sameIdentity(opened, directory)) throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
}

function isPrivateRegular(stat: Stats, uid: number): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.nlink === 1 &&
    (stat.mode & 0o777) === 0o600
}

type PathIdentity =
  | { kind: 'absent' }
  | { kind: 'safe'; file: OwnedFile }
  | { kind: 'unsafe' }

function pathIdentity(path: string, uid: number): PathIdentity {
  try {
    const stat = lstatSync(path)
    if (!isPrivateRegular(stat, uid)) return { kind: 'unsafe' }
    return { kind: 'safe', file: { uid, dev: stat.dev, ino: stat.ino } }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'absent' }
    throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
  }
}

function readStateFile(path: string, directory: PrivateDirectory): ExecutionSupervisorStateLoadResult {
  let fd: number | null = null
  try {
    assertDirectoryIdentity(directory)
    fd = openSync(path, constants.O_RDONLY | noFollowFlag())
    const before = fstatSync(fd)
    if (!isPrivateRegular(before, directory.uid)) {
      return { kind: 'refused', code: 'UNSAFE_PERMISSIONS' }
    }
    if (before.size > MAX_STATE_BYTES) return { kind: 'refused', code: 'CORRUPT_STATE' }
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1)
    let read = 0
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read)
      if (count === 0) break
      read += count
    }
    const after = fstatSync(fd)
    assertDirectoryIdentity(directory)
    const current = lstatSync(path)
    if (read > MAX_STATE_BYTES || !isPrivateRegular(after, directory.uid) ||
      !sameIdentity(before, after) || !sameIdentity(after, current) || after.size !== read) {
      return { kind: 'refused', code: 'CORRUPT_STATE' }
    }
    const decoded = decodeState(buffer.subarray(0, read).toString('utf8'))
    return decoded === null
      ? { kind: 'refused', code: 'CORRUPT_STATE' }
      : { kind: 'ready', state: decoded }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' }
    return { kind: 'refused', code: 'UNSAFE_STATE_ROOT' }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* read result already code-owned */ }
    }
  }
}

function canonicalRoot(path: string): string {
  const requested = resolve(path)
  const finalComponent = basename(requested)
  const missingParents: string[] = []
  let ancestor = dirname(requested)
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
    missingParents.unshift(basename(ancestor))
    ancestor = parent
  }
  let canonical: string
  try {
    canonical = realpathSync(ancestor)
  } catch {
    throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
  }
  // Resolve only the existing parent chain. The final component is preserved
  // verbatim so a symlink supplied as the supervisor root is still rejected by
  // openPrivateDirectory instead of being silently canonicalized to its target.
  return join(canonical, ...missingParents, finalComponent)
}

export function makeNodeExecutionSupervisorStateStore(input: {
  root: string
}): ExecutionSupervisorStateStore {
  const root = canonicalRoot(input.root)
  const statePath = join(root, 'state.json')
  let activeSqliteManager: ExecutionSupervisorSqliteLease | null = null

  const requireManager = (): void => {
    if (activeSqliteManager === null || !activeSqliteManager.isHeld()) {
      throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
    }
  }

  const load = (): ExecutionSupervisorStateLoadResult => {
    try { requireManager() } catch { return { kind: 'refused', code: 'UNSAFE_STATE_ROOT' } }
    let directory: PrivateDirectory | null = null
    try {
      ensurePathWithoutSymlink(root)
      const rootStat = lstatSync(root)
      const uid = currentUid()
      if (rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === uid &&
        (rootStat.mode & 0o777) !== 0o700) {
        return { kind: 'refused', code: 'UNSAFE_PERMISSIONS' }
      }
      directory = openPrivateDirectory(root)
      return readStateFile(statePath, directory)
    } catch {
      return { kind: 'refused', code: 'UNSAFE_STATE_ROOT' }
    } finally {
      if (directory !== null) {
        try { closeSync(directory.fd) } catch { /* code-only refusal on next operation */ }
      }
    }
  }

  return {
    acquireManagerLease() {
      if (activeSqliteManager !== null) throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
      let sqlite: ExecutionSupervisorSqliteLease
      try { sqlite = acquireExecutionSupervisorManagerLease(root) } catch {
        throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
      }
      activeSqliteManager = sqlite
      return {
        isHeld: () => activeSqliteManager === sqlite && sqlite.isHeld(),
        release() {
          if (activeSqliteManager !== sqlite) return
          activeSqliteManager = null
          try { sqlite.release() } catch { throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE') }
        },
      }
    },
    acquireChildLivenessFence(signal) {
      return waitForExecutionSupervisorChildLivenessFence({
        root: resolveExecutionSupervisorChildLivenessRoot(root),
        signal,
      })
    },
    load,
    publish(state) {
      requireManager()
      if (state.schemaVersion !== 2) throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
      const checked = decodeState(JSON.stringify(state))
      if (checked === null || checked.schemaVersion !== 2) {
        throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
      }
      const current = load()
      if (current.kind === 'refused') throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
      if (current.kind === 'ready' && state.revision <= current.state.revision) {
        throw new ExecutionSupervisorStateError('STATE_CONFLICT')
      }

      let directory: PrivateDirectory | null = null
      let file: number | null = null
      let temporary = ''
      let renamed = false
      let temporaryOwned: OwnedFile | null = null
      try {
        directory = openPrivateDirectory(root)
        assertDirectoryIdentity(directory)
        const targetBefore = pathIdentity(statePath, directory.uid)
        if (targetBefore.kind === 'unsafe') {
          throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
        }
        if (current.kind === 'missing' && targetBefore.kind !== 'absent') {
          throw new ExecutionSupervisorStateError('STATE_CONFLICT')
        }
        if (current.kind === 'ready' && targetBefore.kind !== 'safe') {
          throw new ExecutionSupervisorStateError('STATE_CONFLICT')
        }
        const boundCurrent = readStateFile(statePath, directory)
        const targetAfterRead = pathIdentity(statePath, directory.uid)
        if (targetAfterRead.kind === 'unsafe') {
          throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
        }
        if (targetBefore.kind !== targetAfterRead.kind ||
          (targetBefore.kind === 'safe' && targetAfterRead.kind === 'safe' &&
            !sameIdentity(targetBefore.file, targetAfterRead.file)) ||
          boundCurrent.kind !== current.kind ||
          (boundCurrent.kind === 'ready' && current.kind === 'ready' &&
            (boundCurrent.state.revision !== current.state.revision ||
              boundCurrent.state.checksum !== current.state.checksum))) {
          throw new ExecutionSupervisorStateError('STATE_CONFLICT')
        }

        temporary = join(directory.path,
          `.${basename(statePath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`)
        file = openSync(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
          0o600,
        )
        const created = fstatSync(file)
        if (!created.isFile() || created.uid !== directory.uid || created.nlink !== 1) {
          throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
        }
        fchmodSync(file, 0o600)
        const privateCreated = fstatSync(file)
        const owned = { uid: directory.uid, dev: privateCreated.dev, ino: privateCreated.ino }
        if (!isPrivateRegular(privateCreated, directory.uid)) {
          throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
        }
        temporaryOwned = owned
        writeFileSync(file, JSON.stringify(checked) + '\n')
        const written = fstatSync(file)
        if (!isPrivateRegular(written, directory.uid) || !sameIdentity(written, owned) ||
          written.size > MAX_STATE_BYTES) throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
        fsyncSync(file)
        closeSync(file)
        file = null

        assertDirectoryIdentity(directory)
        const targetNow = pathIdentity(statePath, directory.uid)
        if (targetNow.kind === 'unsafe') {
          throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
        }
        if (targetBefore.kind !== targetNow.kind ||
          (targetBefore.kind === 'safe' && targetNow.kind === 'safe' &&
            !sameIdentity(targetBefore.file, targetNow.file))) {
          throw new ExecutionSupervisorStateError('STATE_CONFLICT')
        }
        const temporaryNow = pathIdentity(temporary, directory.uid)
        if (temporaryNow.kind !== 'safe' || !sameIdentity(temporaryNow.file, owned)) {
          throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
        }
        renameSync(temporary, statePath)
        renamed = true
        assertDirectoryIdentity(directory)
        const published = pathIdentity(statePath, directory.uid)
        if (published.kind !== 'safe' || !sameIdentity(published.file, owned)) {
          throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
        }
        fsyncSync(directory.fd)
      } catch (error) {
        if (error instanceof ExecutionSupervisorStateError) throw error
        throw new ExecutionSupervisorStateError('STATE_UNAVAILABLE')
      } finally {
        if (file !== null) {
          try { closeSync(file) } catch { /* preserve original result */ }
        }
        if (!renamed && temporary !== '' && directory !== null && temporaryOwned !== null) {
          try {
            const current = pathIdentity(temporary, directory.uid)
            if (current.kind === 'safe' && sameIdentity(current.file, temporaryOwned)) {
              unlinkSync(temporary)
              assertDirectoryIdentity(directory)
              fsyncSync(directory.fd)
            }
          } catch { /* changed, unsafe or absent temp is never removed */ }
        }
        if (directory !== null) {
          try { closeSync(directory.fd) } catch { /* fsync already determined durability */ }
        }
      }
    },
  }
}
