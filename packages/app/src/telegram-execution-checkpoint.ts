import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  renderExecution,
  type ExecutionState,
} from '@aisy/telegram-gw'

const HASH = /^[a-f0-9]{64}$/
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CAPABILITY = /^[a-z][a-z0-9_.:-]{0,127}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_CHECKPOINT_BYTES = 64 * 1024
const CHECKPOINT_KEYS = new Set([
  'schemaVersion', 'bindingHash', 'ownerId', 'revision', 'phase', 'delivery',
  'messageId', 'locked', 'state', 'updatedAt', 'checksum',
])
const STATE_KEYS = new Set(['scope', 'steps', 'tool', 'action', 'usage', 'thinking', 'status'])
const DELIVERY_RECEIPT_KEYS = new Set([
  'schemaVersion', 'bindingHash', 'revision', 'delivery', 'messageId', 'checkpointHash',
])

export type TelegramExecutionCheckpointPhase = 'prepared' | 'bound' | 'terminal'
export type TelegramExecutionCheckpointDelivery = 'pending' | 'delivered'

export interface TelegramExecutionCheckpointV1 {
  schemaVersion: 1
  bindingHash: string
  ownerId: string
  revision: number
  phase: TelegramExecutionCheckpointPhase
  delivery: TelegramExecutionCheckpointDelivery
  messageId?: number
  locked: boolean
  state: ExecutionState
  updatedAt: string
  checksum: string
}

export type TelegramExecutionCheckpointLoad =
  | { status: 'missing' }
  | { status: 'ready'; checkpoint: TelegramExecutionCheckpointV1 }
  | { status: 'quarantined'; reason: 'corrupt-or-unsafe-checkpoint' }

export type TelegramExecutionCheckpointFinding = {
  state: 'absent' | 'clean' | 'pending' | 'corrupt'
}

export type TelegramExecutionDirectCheckpointInspectionV1 =
  | Readonly<{ state: 'absent' }>
  | Readonly<{
      state: 'clean'
      bindingHash: string
      revision: number
      phase: TelegramExecutionCheckpointPhase
      delivery: TelegramExecutionCheckpointDelivery
    }>
  | Readonly<{
      state: 'pending' | 'foreign'
      code: 'SUPERVISED_RECOVERY_REQUIRED'
      bindingHash: string
      revision: number
      phase: TelegramExecutionCheckpointPhase
      delivery: TelegramExecutionCheckpointDelivery
    }>
  | Readonly<{
      state: 'corrupt'
      code: 'SUPERVISED_RECOVERY_REQUIRED'
    }>

export interface TelegramExecutionCheckpointStore {
  load(): TelegramExecutionCheckpointLoad
  begin(checkpoint: TelegramExecutionCheckpointV1): void
  replace(
    checkpoint: TelegramExecutionCheckpointV1,
    expected: { ownerId: string; revision: number; bindingHash: string },
  ): void
}

export interface TelegramExecutionDeliveryReceiptV1 {
  readonly schemaVersion: 1
  readonly bindingHash: string
  readonly revision: number
  readonly delivery: 'delivered'
  readonly messageId: number
  readonly checkpointHash: string
}

export type TelegramExecutionDeliveryConfirmationV1 =
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'delivered'; receipt: TelegramExecutionDeliveryReceiptV1 }>
  | Readonly<{
      kind: 'delivery-uncertain'
      code: 'DELIVERY_UNCERTAIN'
      revision: number
      messageId?: number
    }>
  | Readonly<{ kind: 'denied'; code: 'EXECUTION_CHECKPOINT_IDENTITY_MISMATCH' }>
  | Readonly<{ kind: 'quarantined'; code: 'EXECUTION_CHECKPOINT_QUARANTINED' }>

export interface TelegramExecutionCheckpointOutput {
  sendText(html: string): Promise<number>
  editText(messageId: number, html: string): Promise<void>
}

export interface TelegramExecutionCheckpointQuiescence {
  assertHeld(): boolean
}

export type TelegramExecutionRecoveryResult =
  | { kind: 'none' }
  | { kind: 'recovered'; delivery: 'edited' | 'replacement-sent'; messageId: number }
  | { kind: 'denied'; code: 'QUIESCENCE_REQUIRED' | 'FOREIGN_BINDING' }
  | { kind: 'quarantined'; code: 'CHECKPOINT_QUARANTINED' }
  | { kind: 'delivery-pending'; code: 'TELEGRAM_DELIVERY_FAILED' }

const NODE_STORE_CAPABILITIES = new WeakMap<TelegramExecutionCheckpointStore, Readonly<{
  path: string
  trustedRoot: string
  identities: readonly PrivateDirectoryIdentity[]
}>>()

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function safeState(value: unknown): value is ExecutionState {
  const state = record(value)
  // `scope` is a project label an operator chose, so it is bounded and free of
  // control characters — but unlike the rest of the card it is allowed here,
  // because a recovery card with no idea where it was working is a riddle.
  if (!state || !exactKeys(state, STATE_KEYS) ||
    (state['scope'] !== undefined && (typeof state['scope'] !== 'string' ||
      state['scope'].length === 0 || state['scope'].length > 64 ||
      /[\u0000-\u001f\u007f<>&]/u.test(state['scope']))) ||
    !Array.isArray(state['steps']) || state['steps'].length !== 0 ||
    typeof state['thinking'] !== 'boolean' ||
    !['running', 'completed', 'stopped', 'failed', 'awaiting', 'interrupted']
      .includes(String(state['status']))) return false

  if (state['tool'] !== undefined) {
    const tool = record(state['tool'])
    if (!tool || !exactKeys(tool, new Set(['name', 'kind', 'status', 'elapsedMs'])) ||
      typeof tool['name'] !== 'string' || !CAPABILITY.test(tool['name']) ||
      !['tool', 'subagent'].includes(String(tool['kind'])) ||
      !['pending', 'running', 'completed', 'denied', 'failed'].includes(String(tool['status'])) ||
      (tool['elapsedMs'] !== undefined && !finiteNonNegative(tool['elapsedMs']))) return false
  }
  if (state['action'] !== undefined) {
    const action = record(state['action'])
    if (!action || !exactKeys(action, new Set(['kind', 'status', 'missing'])) ||
      !['inspect-required', 'mutate-required', 'delegate-required'].includes(String(action['kind'])) ||
      !['required', 'recovering', 'verified', 'unverified'].includes(String(action['status'])) ||
      (action['missing'] !== undefined &&
        !['observation', 'mutation', 'postcondition', 'delegation'].includes(String(action['missing'])))) return false
  }
  if (state['usage'] !== undefined) {
    const usage = record(state['usage'])
    if (!usage || !exactKeys(usage, new Set(['inputTokens', 'outputTokens', 'dollars'])) ||
      !finiteNonNegative(usage['inputTokens']) || !Number.isSafeInteger(usage['inputTokens']) ||
      !finiteNonNegative(usage['outputTokens']) || !Number.isSafeInteger(usage['outputTokens']) ||
      !finiteNonNegative(usage['dollars'])) return false
  }
  return true
}

function withoutChecksum(checkpoint: TelegramExecutionCheckpointV1): Omit<TelegramExecutionCheckpointV1, 'checksum'> {
  const {
    schemaVersion,
    bindingHash,
    ownerId,
    revision,
    phase,
    delivery,
    messageId,
    locked,
    state,
    updatedAt,
  } = checkpoint
  return {
    schemaVersion,
    bindingHash,
    ownerId,
    revision,
    phase,
    delivery,
    ...(messageId === undefined ? {} : { messageId }),
    locked,
    state,
    updatedAt,
  }
}

export function computeTelegramExecutionCheckpointChecksum(
  checkpoint: TelegramExecutionCheckpointV1,
): string {
  return createHash('sha256')
    .update('aisy.telegram.execution-checkpoint.v1\0')
    .update(JSON.stringify(withoutChecksum(checkpoint)))
    .digest('hex')
}

export function makeTelegramExecutionBindingHash(input: {
  chatId: number
  sessionId: string
  turnId: string
}): string {
  if (!Number.isSafeInteger(input.chatId) || input.sessionId.length < 1 ||
    input.sessionId.length > 256 || input.turnId.length < 1 || input.turnId.length > 512) {
    throw new Error('EXECUTION_CHECKPOINT_BINDING_INVALID')
  }
  return createHash('sha256')
    .update('aisy.telegram.execution-binding.v1\0')
    .update(String(input.chatId))
    .update('\0')
    .update(input.sessionId)
    .update('\0')
    .update(input.turnId)
    .digest('hex')
}

export function makeTelegramExecutionCheckpoint(input: {
  bindingHash: string
  ownerId: string
  revision: number
  phase: TelegramExecutionCheckpointPhase
  delivery: TelegramExecutionCheckpointDelivery
  messageId?: number
  locked: boolean
  state: ExecutionState
  updatedAt: string
}): TelegramExecutionCheckpointV1 {
  const candidate: TelegramExecutionCheckpointV1 = {
    schemaVersion: 1,
    bindingHash: input.bindingHash,
    ownerId: input.ownerId,
    revision: input.revision,
    phase: input.phase,
    delivery: input.delivery,
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    locked: input.locked,
    state: structuredClone(input.state),
    updatedAt: input.updatedAt,
    checksum: '',
  }
  candidate.checksum = computeTelegramExecutionCheckpointChecksum(candidate)
  return validateTelegramExecutionCheckpoint(candidate)
}

export function validateTelegramExecutionCheckpoint(value: unknown): TelegramExecutionCheckpointV1 {
  const checkpoint = record(value)
  if (!checkpoint || !exactKeys(checkpoint, CHECKPOINT_KEYS) || checkpoint['schemaVersion'] !== 1 ||
    typeof checkpoint['bindingHash'] !== 'string' || !HASH.test(checkpoint['bindingHash']) ||
    typeof checkpoint['ownerId'] !== 'string' || !OWNER.test(checkpoint['ownerId']) ||
    !Number.isSafeInteger(checkpoint['revision']) || Number(checkpoint['revision']) < 1 ||
    !['prepared', 'bound', 'terminal'].includes(String(checkpoint['phase'])) ||
    !['pending', 'delivered'].includes(String(checkpoint['delivery'])) ||
    typeof checkpoint['locked'] !== 'boolean' || !safeState(checkpoint['state']) ||
    typeof checkpoint['updatedAt'] !== 'string' || !ISO_INSTANT.test(checkpoint['updatedAt']) ||
    new Date(checkpoint['updatedAt']).toISOString() !== checkpoint['updatedAt'] ||
    typeof checkpoint['checksum'] !== 'string' || !HASH.test(checkpoint['checksum'])) {
    throw new Error('EXECUTION_CHECKPOINT_INVALID')
  }
  const candidate = structuredClone(value) as TelegramExecutionCheckpointV1
  if ((candidate.phase === 'prepared' && candidate.messageId !== undefined) ||
    (candidate.phase === 'bound' && candidate.messageId === undefined) ||
    (candidate.messageId !== undefined && (!Number.isSafeInteger(candidate.messageId) || candidate.messageId < 1)) ||
    (candidate.phase === 'bound' && candidate.state.status !== 'running') ||
    (candidate.phase === 'terminal' && candidate.state.status === 'running') ||
    candidate.state.thinking !== (candidate.state.status === 'running') ||
    (candidate.locked && (candidate.state.tool !== undefined || candidate.state.action !== undefined)) ||
    computeTelegramExecutionCheckpointChecksum(candidate) !== candidate.checksum) {
    throw new Error('EXECUTION_CHECKPOINT_INVALID')
  }
  return Object.freeze(candidate)
}

export function makeTelegramExecutionDeliveryReceipt(
  value: TelegramExecutionCheckpointV1,
): TelegramExecutionDeliveryReceiptV1 | null {
  const checkpoint = validateTelegramExecutionCheckpoint(value)
  if (checkpoint.phase !== 'terminal' || checkpoint.delivery !== 'delivered' ||
    checkpoint.messageId === undefined) return null
  return Object.freeze({
    schemaVersion: 1,
    bindingHash: checkpoint.bindingHash,
    revision: checkpoint.revision,
    delivery: 'delivered',
    messageId: checkpoint.messageId,
    checkpointHash: checkpoint.checksum,
  })
}

function isRecoverable(checkpoint: TelegramExecutionCheckpointV1): boolean {
  return checkpoint.phase !== 'terminal' || checkpoint.delivery !== 'delivered'
}

export function makeJsonTelegramExecutionCheckpointStore(input: {
  exists(): boolean
  read(): string
  saveAtomic(content: string): void
}): TelegramExecutionCheckpointStore {
  const load = (): TelegramExecutionCheckpointLoad => {
    if (!input.exists()) return { status: 'missing' }
    try {
      const raw = input.read()
      if (Buffer.byteLength(raw, 'utf8') > MAX_CHECKPOINT_BYTES) throw new Error('oversized')
      return { status: 'ready', checkpoint: validateTelegramExecutionCheckpoint(JSON.parse(raw) as unknown) }
    } catch {
      return { status: 'quarantined', reason: 'corrupt-or-unsafe-checkpoint' }
    }
  }
  const save = (checkpoint: TelegramExecutionCheckpointV1): void => {
    const validated = validateTelegramExecutionCheckpoint(checkpoint)
    input.saveAtomic(JSON.stringify(validated, null, 2) + '\n')
  }
  return {
    load,
    begin(checkpoint) {
      const current = load()
      if (current.status === 'quarantined') throw new Error('EXECUTION_CHECKPOINT_QUARANTINED')
      if (current.status === 'ready' && isRecoverable(current.checkpoint)) {
        throw new Error('EXECUTION_CHECKPOINT_ACTIVE')
      }
      if (checkpoint.revision !== 1 || checkpoint.phase !== 'prepared') {
        throw new Error('EXECUTION_CHECKPOINT_TRANSITION_INVALID')
      }
      save(checkpoint)
    },
    replace(checkpoint, expected) {
      const current = load()
      if (current.status !== 'ready') throw new Error('EXECUTION_CHECKPOINT_UNAVAILABLE')
      if (current.checkpoint.ownerId !== expected.ownerId ||
        current.checkpoint.revision !== expected.revision ||
        current.checkpoint.bindingHash !== expected.bindingHash ||
        checkpoint.revision !== expected.revision + 1 ||
        checkpoint.bindingHash !== expected.bindingHash) {
        throw new Error('EXECUTION_CHECKPOINT_STALE_OWNER')
      }
      save(checkpoint)
    },
  }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('EXECUTION_CHECKPOINT_PATH_UNSAFE')
  }
}

function readNodeCheckpoint(path: string): string {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CHECKPOINT_BYTES ||
    (before.mode & 0o077) !== 0) {
    throw new Error('EXECUTION_CHECKPOINT_PATH_UNSAFE')
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const after = fstatSync(descriptor)
    if (!after.isFile() || after.size > MAX_CHECKPOINT_BYTES || (after.mode & 0o077) !== 0 ||
      before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('EXECUTION_CHECKPOINT_PATH_UNSAFE')
    }
    return readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

function nodeErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

interface PrivateDirectoryIdentity {
  path: string
  dev: number
  ino: number
  uid: number
  mode: number
}

type PrivateDirectoryChainInspection =
  | Readonly<{ state: 'ready'; identities: readonly PrivateDirectoryIdentity[] }>
  | Readonly<{
      state: 'absent'
      identities: readonly PrivateDirectoryIdentity[]
      missingPath: string
    }>
  | Readonly<{ state: 'unsafe' }>

function inspectPrivateDirectory(
  path: string,
  uid: number,
): Readonly<{ state: 'ready'; identity: PrivateDirectoryIdentity }> |
  Readonly<{ state: 'absent' }> | Readonly<{ state: 'unsafe' }> {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
      (stat.mode & 0o077) !== 0) {
      return { state: 'unsafe' }
    }
    return {
      state: 'ready',
      identity: { path, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode },
    }
  } catch (error) {
    return nodeErrorCode(error) === 'ENOENT' ? { state: 'absent' } : { state: 'unsafe' }
  }
}

function inspectPrivateDirectoryChain(
  trustedRoot: string,
  directory: string,
  uid: number,
): PrivateDirectoryChainInspection {
  const relativeDirectory = relative(trustedRoot, directory)
  if (relativeDirectory === '..' || relativeDirectory.startsWith(`..${sep}`) ||
    isAbsolute(relativeDirectory)) return { state: 'unsafe' }
  let current = trustedRoot
  const identities: PrivateDirectoryIdentity[] = []
  const root = inspectPrivateDirectory(current, uid)
  if (root.state === 'absent') return { state: 'absent', identities, missingPath: current }
  if (root.state === 'unsafe') return root
  identities.push(root.identity)
  if (relativeDirectory === '') return { state: 'ready', identities }
  for (const component of relativeDirectory.split(sep)) {
    if (component.length === 0 || component === '.' || component === '..') {
      return { state: 'unsafe' }
    }
    current = join(current, component)
    const inspected = inspectPrivateDirectory(current, uid)
    if (inspected.state === 'absent') {
      return { state: 'absent', identities, missingPath: current }
    }
    if (inspected.state === 'unsafe') return inspected
    identities.push(inspected.identity)
  }
  return { state: 'ready', identities }
}

function privateDirectoryChainIsUnchanged(
  identities: readonly PrivateDirectoryIdentity[],
): boolean {
  for (const identity of identities) {
    try {
      const stat = lstatSync(identity.path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev ||
        stat.ino !== identity.ino || stat.uid !== identity.uid || stat.mode !== identity.mode) {
        return false
      }
    } catch {
      return false
    }
  }
  return true
}

function pathIsStillAbsent(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    return nodeErrorCode(error) === 'ENOENT'
  }
}

function privateDirectoryAbsenceIsUnchanged(
  inspection: Extract<PrivateDirectoryChainInspection, { state: 'absent' }>,
): boolean {
  return privateDirectoryChainIsUnchanged(inspection.identities) &&
    pathIsStillAbsent(inspection.missingPath)
}

function readNodeCheckpointForDirectInspection(path: string): string {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid)) throw new Error('EXECUTION_CHECKPOINT_PATH_UNSAFE')
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || before.nlink !== 1 ||
    before.size > MAX_CHECKPOINT_BYTES || (before.mode & 0o077) !== 0) {
    throw new Error('EXECUTION_CHECKPOINT_PATH_UNSAFE')
  }
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new Error('EXECUTION_CHECKPOINT_PATH_UNSAFE')
  }
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.uid !== uid || opened.nlink !== 1 ||
      opened.size > MAX_CHECKPOINT_BYTES || (opened.mode & 0o077) !== 0 ||
      before.dev !== opened.dev || before.ino !== opened.ino ||
      before.size !== opened.size || before.mtimeMs !== opened.mtimeMs ||
      before.ctimeMs !== opened.ctimeMs) {
      throw new Error('EXECUTION_CHECKPOINT_PATH_UNSAFE')
    }
    const bounded = Buffer.alloc(MAX_CHECKPOINT_BYTES + 1)
    let bytes = 0
    let eof = false
    while (bytes < bounded.length) {
      const count = readSync(descriptor, bounded, bytes, bounded.length - bytes, null)
      if (count === 0) {
        eof = true
        break
      }
      bytes += count
    }
    const after = fstatSync(descriptor)
    let published: ReturnType<typeof lstatSync>
    try { published = lstatSync(path) } catch {
      throw new Error('EXECUTION_CHECKPOINT_PATH_UNSAFE')
    }
    if (!eof || bytes > MAX_CHECKPOINT_BYTES || bytes !== opened.size || !after.isFile() ||
      after.uid !== opened.uid || after.nlink !== opened.nlink || after.mode !== opened.mode ||
      opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs ||
      !published.isFile() || published.isSymbolicLink() || published.dev !== opened.dev ||
      published.ino !== opened.ino || published.uid !== opened.uid ||
      published.nlink !== opened.nlink || published.mode !== opened.mode ||
      published.size !== opened.size ||
      published.mtimeMs !== opened.mtimeMs || published.ctimeMs !== opened.ctimeMs) {
      throw new Error('EXECUTION_CHECKPOINT_PATH_UNSAFE')
    }
    return bounded.toString('utf8', 0, bytes)
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Direct-run startup evidence. It never creates, renames, repairs or writes;
 * pending, foreign and unreadable state always requires supervised recovery.
 */
export function inspectNodeTelegramExecutionCheckpointForDirectRun(input: Readonly<{
  path: string
  trustedRoot: string
  expectedBindingHash?: string
}>): TelegramExecutionDirectCheckpointInspectionV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input) ||
    typeof input.path !== 'string' || !isAbsolute(input.path) || resolve(input.path) !== input.path ||
    typeof input.trustedRoot !== 'string' || !isAbsolute(input.trustedRoot) ||
    resolve(input.trustedRoot) !== input.trustedRoot ||
    (input.expectedBindingHash !== undefined && !HASH.test(input.expectedBindingHash))) {
    return Object.freeze({ state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' })
  }
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid)) {
    return Object.freeze({ state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' })
  }
  const path = input.path
  const directory = inspectPrivateDirectoryChain(input.trustedRoot, dirname(path), Number(uid))
  if (directory.state === 'absent') {
    return privateDirectoryAbsenceIsUnchanged(directory)
      ? Object.freeze({ state: 'absent' })
      : Object.freeze({ state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' })
  }
  if (directory.state === 'unsafe') {
    return Object.freeze({ state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' })
  }
  let raw: string
  try {
    raw = readNodeCheckpointForDirectInspection(path)
  } catch (error) {
    if (!privateDirectoryChainIsUnchanged(directory.identities)) {
      return Object.freeze({ state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' })
    }
    if (nodeErrorCode(error) === 'ENOENT') {
      return pathIsStillAbsent(path)
        ? Object.freeze({ state: 'absent' })
        : Object.freeze({ state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' })
    }
    return Object.freeze({ state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' })
  }
  let checkpoint: TelegramExecutionCheckpointV1
  try {
    checkpoint = validateTelegramExecutionCheckpoint(JSON.parse(raw) as unknown)
  } catch {
    if (!privateDirectoryChainIsUnchanged(directory.identities)) {
      return Object.freeze({ state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' })
    }
    return Object.freeze({ state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' })
  }
  if (!privateDirectoryChainIsUnchanged(directory.identities)) {
    return Object.freeze({ state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' })
  }
  const metadata = {
    bindingHash: checkpoint.bindingHash,
    revision: checkpoint.revision,
    phase: checkpoint.phase,
    delivery: checkpoint.delivery,
  }
  if (input.expectedBindingHash !== undefined &&
    checkpoint.bindingHash !== input.expectedBindingHash) {
    return Object.freeze({
      state: 'foreign',
      code: 'SUPERVISED_RECOVERY_REQUIRED',
      ...metadata,
    })
  }
  if (isRecoverable(checkpoint)) {
    return Object.freeze({
      state: 'pending',
      code: 'SUPERVISED_RECOVERY_REQUIRED',
      ...metadata,
    })
  }
  return Object.freeze({ state: 'clean', ...metadata })
}

/**
 * Confirms the exact terminal bytes through a manager-created Node store.
 * Generic/in-memory stores cannot mint durable delivery evidence.
 */
export function confirmTelegramExecutionCheckpointDelivery(input: Readonly<{
  store: TelegramExecutionCheckpointStore
  bindingHash: string
  expectedReceipt: TelegramExecutionDeliveryReceiptV1
}>): TelegramExecutionDeliveryConfirmationV1 {
  let capability: Readonly<{
    path: string
    trustedRoot: string
    identities: readonly PrivateDirectoryIdentity[]
  }> | undefined
  try { capability = NODE_STORE_CAPABILITIES.get(input.store) } catch { /* unavailable */ }
  if (capability === undefined) return Object.freeze({ kind: 'unavailable' })

  let expected: TelegramExecutionDeliveryReceiptV1
  try { expected = structuredClone(input.expectedReceipt) } catch {
    return Object.freeze({ kind: 'denied', code: 'EXECUTION_CHECKPOINT_IDENTITY_MISMATCH' })
  }
  if (!HASH.test(input.bindingHash) || !exactKeys(expected as unknown as Record<string, unknown>, DELIVERY_RECEIPT_KEYS) ||
    Object.keys(expected).length !== DELIVERY_RECEIPT_KEYS.size ||
    expected.schemaVersion !== 1 || expected.bindingHash !== input.bindingHash ||
    expected.delivery !== 'delivered' ||
    !Number.isSafeInteger(expected.revision) || expected.revision < 1 ||
    !Number.isSafeInteger(expected.messageId) || expected.messageId < 1 ||
    !HASH.test(expected.checkpointHash)) {
    return Object.freeze({ kind: 'denied', code: 'EXECUTION_CHECKPOINT_IDENTITY_MISMATCH' })
  }
  const uncertain = (revision = expected.revision, messageId?: number): TelegramExecutionDeliveryConfirmationV1 =>
    Object.freeze({
      kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN', revision,
      ...(messageId === undefined ? {} : { messageId }),
    })
  if (!privateDirectoryChainIsUnchanged(capability.identities)) {
    return Object.freeze({ kind: 'quarantined', code: 'EXECUTION_CHECKPOINT_QUARANTINED' })
  }
  let checkpoint: TelegramExecutionCheckpointV1
  try {
    if (realpathSync(capability.trustedRoot) !== capability.trustedRoot) {
      throw new Error('EXECUTION_CHECKPOINT_PATH_UNSAFE')
    }
    checkpoint = validateTelegramExecutionCheckpoint(
      JSON.parse(readNodeCheckpointForDirectInspection(capability.path)) as unknown,
    )
  } catch {
    return Object.freeze({ kind: 'quarantined', code: 'EXECUTION_CHECKPOINT_QUARANTINED' })
  }
  if (!privateDirectoryChainIsUnchanged(capability.identities)) {
    return Object.freeze({ kind: 'quarantined', code: 'EXECUTION_CHECKPOINT_QUARANTINED' })
  }
  if (checkpoint.bindingHash !== input.bindingHash) {
    return Object.freeze({ kind: 'denied', code: 'EXECUTION_CHECKPOINT_IDENTITY_MISMATCH' })
  }
  const actual = makeTelegramExecutionDeliveryReceipt(checkpoint)
  if (actual === null) return uncertain(checkpoint.revision, checkpoint.messageId)
  if (actual.schemaVersion !== expected.schemaVersion ||
    actual.bindingHash !== expected.bindingHash || actual.revision !== expected.revision ||
    actual.delivery !== expected.delivery ||
    actual.messageId !== expected.messageId || actual.checkpointHash !== expected.checkpointHash) {
    return uncertain(actual.revision, actual.messageId)
  }
  return Object.freeze({ kind: 'delivered', receipt: actual })
}

/** Read-only doctor probe. It never creates the state directory or repairs bytes. */
export function inspectNodeTelegramExecutionCheckpoint(input: {
  path: string
}): TelegramExecutionCheckpointFinding {
  const path = resolve(input.path)
  try {
    const raw = readNodeCheckpoint(path)
    const checkpoint = validateTelegramExecutionCheckpoint(JSON.parse(raw) as unknown)
    return { state: isRecoverable(checkpoint) ? 'pending' : 'clean' }
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    return { state: code === 'ENOENT' ? 'absent' : 'corrupt' }
  }
}

export function makeNodeTelegramExecutionCheckpointStore(input: {
  path: string
  trustedRoot?: string
}): TelegramExecutionCheckpointStore {
  const path = resolve(input.path)
  const directory = dirname(path)
  const uid = process.getuid?.()
  let canonicalTrustedRoot: string | null = null
  if (typeof input.trustedRoot === 'string' && isAbsolute(input.trustedRoot) &&
    resolve(input.trustedRoot) === input.trustedRoot) {
    try {
      if (realpathSync(input.trustedRoot) === input.trustedRoot) canonicalTrustedRoot = input.trustedRoot
    } catch { /* absent roots remain legacy-only and cannot mint evidence */ }
  }
  const rootBeforeMutation = canonicalTrustedRoot !== null && Number.isSafeInteger(uid)
    ? inspectPrivateDirectory(canonicalTrustedRoot, Number(uid))
    : { state: 'unsafe' as const }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertPrivateDirectory(directory)
  const chain = canonicalTrustedRoot !== null && rootBeforeMutation.state === 'ready'
    ? inspectPrivateDirectoryChain(canonicalTrustedRoot, directory, Number(uid))
    : { state: 'unsafe' as const }
  const firstIdentity = chain.state === 'ready' ? chain.identities[0] : undefined
  const pinnedIdentities = chain.state === 'ready' && rootBeforeMutation.state === 'ready' &&
    firstIdentity !== undefined && firstIdentity.dev === rootBeforeMutation.identity.dev &&
    firstIdentity.ino === rootBeforeMutation.identity.ino &&
    firstIdentity.uid === rootBeforeMutation.identity.uid &&
    firstIdentity.mode === rootBeforeMutation.identity.mode
    ? chain.identities
    : null
  const store = Object.freeze(makeJsonTelegramExecutionCheckpointStore({
    exists: () => existsSync(path),
    read: () => readNodeCheckpoint(path),
    saveAtomic(content) {
      if (pinnedIdentities !== null && !privateDirectoryChainIsUnchanged(pinnedIdentities)) {
        throw new Error('EXECUTION_CHECKPOINT_PATH_UNSAFE')
      }
      const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
      writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      syncPath(temporary)
      renameSync(temporary, path)
      syncPath(directory)
      if (pinnedIdentities !== null && !privateDirectoryChainIsUnchanged(pinnedIdentities)) {
        throw new Error('EXECUTION_CHECKPOINT_PATH_UNSAFE')
      }
    },
  }))
  if (pinnedIdentities !== null && canonicalTrustedRoot !== null) {
    NODE_STORE_CAPABILITIES.set(store, Object.freeze({
      path,
      trustedRoot: canonicalTrustedRoot,
      identities: Object.freeze(pinnedIdentities.map(identity => Object.freeze({ ...identity }))),
    }))
  }
  return store
}

/**
 * Move a checkpoint this build cannot validate out of the way, keeping the
 * bytes for inspection. Corrupt or written by another version — either way it
 * names no message, no binding and no owner, so there is nothing to recover
 * from it and nothing in it to protect. Returns false if the file could not be
 * moved; the caller then still holds an unreadable checkpoint.
 */
export function discardNodeTelegramExecutionCheckpoint(input: { path: string }): boolean {
  const path = resolve(input.path)
  try {
    renameSync(path, `${path}.rejected`)
    return true
  } catch {
    return false
  }
}

function interruptedState(state: ExecutionState): ExecutionState {
  return {
    ...structuredClone(state),
    steps: [],
    thinking: false,
    status: 'interrupted',
  }
}

export async function recoverTelegramExecutionCheckpoint(input: {
  store: TelegramExecutionCheckpointStore
  bindingHash: string
  output: TelegramExecutionCheckpointOutput
  quiescence: TelegramExecutionCheckpointQuiescence
  newOwnerId: () => string
  nowIso?: () => string
}): Promise<TelegramExecutionRecoveryResult> {
  const loaded = input.store.load()
  if (loaded.status === 'missing') return { kind: 'none' }
  if (loaded.status === 'quarantined') return { kind: 'quarantined', code: 'CHECKPOINT_QUARANTINED' }
  const current = loaded.checkpoint
  if (!isRecoverable(current)) return { kind: 'none' }
  if (current.bindingHash !== input.bindingHash) return { kind: 'denied', code: 'FOREIGN_BINDING' }
  if (!input.quiescence.assertHeld()) return { kind: 'denied', code: 'QUIESCENCE_REQUIRED' }

  const ownerId = input.newOwnerId()
  if (!OWNER.test(ownerId)) throw new Error('EXECUTION_CHECKPOINT_OWNER_INVALID')
  const next = makeTelegramExecutionCheckpoint({
    bindingHash: current.bindingHash,
    ownerId,
    revision: current.revision + 1,
    phase: current.messageId === undefined ? 'prepared' : 'terminal',
    delivery: 'pending',
    ...(current.messageId === undefined ? {} : { messageId: current.messageId }),
    locked: current.locked,
    state: interruptedState(current.state),
    updatedAt: (input.nowIso ?? (() => new Date().toISOString()))(),
  })
  input.store.replace(next, {
    ownerId: current.ownerId,
    revision: current.revision,
    bindingHash: current.bindingHash,
  })

  try {
    let messageId = next.messageId
    let delivery: 'edited' | 'replacement-sent'
    if (messageId === undefined) {
      messageId = await input.output.sendText(renderExecution(next.state).html)
      delivery = 'replacement-sent'
    } else {
      await input.output.editText(messageId, renderExecution(next.state).html)
      delivery = 'edited'
    }
    // The Telegram await is an authority-loss window. Never make `delivered`
    // durable unless quiescence still holds immediately after the network I/O.
    if (!input.quiescence.assertHeld()) {
      return { kind: 'denied', code: 'QUIESCENCE_REQUIRED' }
    }
    const delivered = makeTelegramExecutionCheckpoint({
      ...next,
      revision: next.revision + 1,
      phase: 'terminal',
      delivery: 'delivered',
      messageId,
    })
    input.store.replace(delivered, {
      ownerId,
      revision: next.revision,
      bindingHash: next.bindingHash,
    })
    return { kind: 'recovered', delivery, messageId }
  } catch {
    return { kind: 'delivery-pending', code: 'TELEGRAM_DELIVERY_FAILED' }
  }
}
