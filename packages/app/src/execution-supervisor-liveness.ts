import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import {
  acquirePrivateSqliteLease,
  PrivateSqliteLeaseError,
  type PrivateSqliteLease,
  type PrivateSqliteLeaseFailure,
  type PrivateSqliteLeaseProfile,
} from './private-sqlite-lease.js'

export const EXECUTION_SUPERVISOR_LIVENESS_ENV = 'AISY_EXECUTION_LIVENESS_V1' as const
export const EXECUTION_SUPERVISOR_LEASE_APPLICATION_ID = 0x41495359
export const EXECUTION_SUPERVISOR_LEASE_USER_VERSION = 1

const HASH = /^[a-f0-9]{64}$/
const DECIMAL_ID = /^(0|[1-9][0-9]{0,19})$/
const ROLE_SCHEMA = "CREATE TABLE lease_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), role TEXT NOT NULL CHECK (role IN ('manager', 'child')), schema_version INTEGER NOT NULL CHECK (schema_version = 1), database_id TEXT NOT NULL CHECK (length(database_id) = 64))"

export type ExecutionSupervisorLeaseRole = 'manager' | 'child'
export type ExecutionSupervisorLeaseErrorCode =
  | 'MANAGER_LEASE_BUSY'
  | 'MANAGER_LEASE_UNSAFE'
  | 'MANAGER_LEASE_CORRUPT'
  | 'MANAGER_LEASE_UNAVAILABLE'
  | 'MANAGER_LEASE_LOST'
  | 'CHILD_LIVENESS_BUSY'
  | 'CHILD_LIVENESS_UNSAFE'
  | 'CHILD_LIVENESS_CORRUPT'
  | 'CHILD_LIVENESS_UNAVAILABLE'
  | 'CHILD_LIVENESS_LOST'
  | 'CHILD_LIVENESS_ABORTED'

export class ExecutionSupervisorLeaseError extends Error {
  constructor(readonly code: ExecutionSupervisorLeaseErrorCode) {
    super(code)
    this.name = 'ExecutionSupervisorLeaseError'
  }
}

export interface ExecutionSupervisorChildLivenessDescriptorV1 {
  version: 1
  path: string
  dev: string
  ino: string
}

export interface ExecutionSupervisorSqliteLease {
  isHeld(): boolean
  onLost(listener: () => void): () => void
  release(): void
}

export interface ExecutionSupervisorChildLivenessLease extends ExecutionSupervisorSqliteLease {
  readonly descriptor: ExecutionSupervisorChildLivenessDescriptorV1
  readonly descriptorHash: string
}

const MANAGER_PROFILE: PrivateSqliteLeaseProfile = {
  role: 'manager',
  filename: 'manager-lease.sqlite3',
  applicationId: EXECUTION_SUPERVISOR_LEASE_APPLICATION_ID,
  userVersion: EXECUTION_SUPERVISOR_LEASE_USER_VERSION,
  exactSchemaSql: ROLE_SCHEMA,
  validateRootWhileHeld: false,
}

const CHILD_PROFILE: PrivateSqliteLeaseProfile = {
  role: 'child',
  filename: 'child-liveness.sqlite3',
  applicationId: EXECUTION_SUPERVISOR_LEASE_APPLICATION_ID,
  userVersion: EXECUTION_SUPERVISOR_LEASE_USER_VERSION,
  exactSchemaSql: ROLE_SCHEMA,
  validateRootWhileHeld: false,
}

function roleCode(
  role: ExecutionSupervisorLeaseRole,
  suffix: 'BUSY' | 'UNSAFE' | 'CORRUPT' | 'UNAVAILABLE' | 'LOST',
): ExecutionSupervisorLeaseErrorCode {
  return ((role === 'manager' ? 'MANAGER_LEASE_' : 'CHILD_LIVENESS_') + suffix) as ExecutionSupervisorLeaseErrorCode
}

function mapFailure(
  role: ExecutionSupervisorLeaseRole,
  failure: PrivateSqliteLeaseFailure,
): ExecutionSupervisorLeaseError {
  return new ExecutionSupervisorLeaseError(
    roleCode(role, failure.toUpperCase() as Uppercase<PrivateSqliteLeaseFailure>),
  )
}

function mapError(role: ExecutionSupervisorLeaseRole, error: unknown): ExecutionSupervisorLeaseError {
  if (error instanceof ExecutionSupervisorLeaseError) return error
  if (error instanceof PrivateSqliteLeaseError) return mapFailure(role, error.failure)
  return new ExecutionSupervisorLeaseError(roleCode(role, 'UNAVAILABLE'))
}

function wrapLease(lease: PrivateSqliteLease): ExecutionSupervisorChildLivenessLease {
  const descriptor: ExecutionSupervisorChildLivenessDescriptorV1 = {
    version: 1,
    path: lease.identity.path,
    dev: lease.identity.dev,
    ino: lease.identity.ino,
  }
  const descriptorHash = hashExecutionSupervisorChildLivenessDescriptor(descriptor)
  return {
    descriptor,
    descriptorHash,
    isHeld: () => lease.isHeld(),
    onLost(listener) {
      return lease.onLost(listener)
    },
    release() {
      lease.release()
    },
  }
}

function openLease(input: {
  root: string
  role: ExecutionSupervisorLeaseRole
  profile: PrivateSqliteLeaseProfile
}): ExecutionSupervisorChildLivenessLease {
  try {
    return wrapLease(acquirePrivateSqliteLease({
      root: input.root,
      profile: input.profile,
    }))
  } catch (error) {
    throw mapError(input.role, error)
  }
}

export function resolveExecutionSupervisorChildLivenessRoot(stateRoot: string): string {
  return join(dirname(resolve(stateRoot)), 'execution-liveness')
}

export function encodeExecutionSupervisorChildLivenessDescriptor(
  descriptor: ExecutionSupervisorChildLivenessDescriptorV1,
): string {
  return Buffer.from(JSON.stringify(descriptor), 'utf8').toString('base64url')
}

export function decodeExecutionSupervisorChildLivenessDescriptor(
  raw: string,
): ExecutionSupervisorChildLivenessDescriptorV1 {
  let value: unknown
  try {
    if (raw === '' || /[^A-Za-z0-9_-]/.test(raw)) throw new Error()
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new ExecutionSupervisorLeaseError('CHILD_LIVENESS_UNSAFE')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 4) {
    throw new ExecutionSupervisorLeaseError('CHILD_LIVENESS_UNSAFE')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.path !== 'string' || !isAbsolute(record.path) ||
    typeof record.dev !== 'string' || !DECIMAL_ID.test(record.dev) ||
    typeof record.ino !== 'string' || !DECIMAL_ID.test(record.ino)) {
    throw new ExecutionSupervisorLeaseError('CHILD_LIVENESS_UNSAFE')
  }
  const descriptor = {
    version: 1 as const,
    path: record.path,
    dev: record.dev,
    ino: record.ino,
  }
  if (encodeExecutionSupervisorChildLivenessDescriptor(descriptor) !== raw) {
    throw new ExecutionSupervisorLeaseError('CHILD_LIVENESS_UNSAFE')
  }
  return descriptor
}

export function hashExecutionSupervisorChildLivenessDescriptor(
  descriptor: ExecutionSupervisorChildLivenessDescriptorV1,
): string {
  const hash = createHash('sha256').update(JSON.stringify(descriptor), 'utf8').digest('hex')
  if (!HASH.test(hash)) throw new ExecutionSupervisorLeaseError('CHILD_LIVENESS_UNAVAILABLE')
  return hash
}

export function acquireExecutionSupervisorManagerLease(root: string): ExecutionSupervisorSqliteLease {
  return openLease({ root, role: 'manager', profile: MANAGER_PROFILE })
}

export function acquireExecutionSupervisorChildLivenessLease(input: {
  root: string
  expectedDescriptor?: ExecutionSupervisorChildLivenessDescriptorV1
}): ExecutionSupervisorChildLivenessLease {
  const lease = openLease({ root: input.root, role: 'child', profile: CHILD_PROFILE })
  if (input.expectedDescriptor !== undefined &&
    JSON.stringify(input.expectedDescriptor) !== JSON.stringify(lease.descriptor)) {
    lease.release()
    throw new ExecutionSupervisorLeaseError('CHILD_LIVENESS_UNSAFE')
  }
  return lease
}

/** First effect for every aisy run; direct mode additionally probes manager ownership. */
export function acquireExecutionRunLiveness(input: {
  stateRoot: string
  supervisedDescriptor?: ExecutionSupervisorChildLivenessDescriptorV1
}): ExecutionSupervisorChildLivenessLease {
  const runtime = acquireExecutionSupervisorChildLivenessLease({
    root: resolveExecutionSupervisorChildLivenessRoot(input.stateRoot),
    ...(input.supervisedDescriptor === undefined
      ? {}
      : { expectedDescriptor: input.supervisedDescriptor }),
  })
  if (input.supervisedDescriptor !== undefined) return runtime
  try {
    const managerProbe = acquireExecutionSupervisorManagerLease(input.stateRoot)
    managerProbe.release()
    return runtime
  } catch (error) {
    runtime.release()
    throw error
  }
}

export async function waitForExecutionSupervisorChildLivenessFence(input: {
  root: string
  signal: AbortSignal
  retryMs?: number
}): Promise<ExecutionSupervisorChildLivenessLease> {
  const retryMs = input.retryMs ?? 25
  while (true) {
    if (input.signal.aborted) throw new ExecutionSupervisorLeaseError('CHILD_LIVENESS_ABORTED')
    try {
      return acquireExecutionSupervisorChildLivenessLease({ root: input.root })
    } catch (error) {
      if (!(error instanceof ExecutionSupervisorLeaseError) ||
        error.code !== 'CHILD_LIVENESS_BUSY') throw error
    }
    await new Promise<void>((resolveWait, reject) => {
      const timer = setTimeout(done, retryMs)
      const abort = (): void => {
        clearTimeout(timer)
        reject(new ExecutionSupervisorLeaseError('CHILD_LIVENESS_ABORTED'))
      }
      function done(): void {
        input.signal.removeEventListener('abort', abort)
        resolveWait()
      }
      input.signal.addEventListener('abort', abort, { once: true })
    })
  }
}
