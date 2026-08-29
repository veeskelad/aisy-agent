import type { ContextLeaseCoordinator, TurnContextLease } from './context-lease.js'

const PROTOCOL_VERSION = 1
const MAX_READ_BYTES = 8 * 1024 * 1024
const MAX_WRITE_BYTES = 8 * 1024 * 1024
const MAX_LIST_ENTRIES = 50_000
const MAX_SCAN_ENTRIES = 50_000
const MAX_SCAN_DEPTH = 64
const MAX_SCAN_FILE_BYTES = 16 * 1024 * 1024
const MAX_SCAN_TOTAL_BYTES = 256 * 1024 * 1024

export type ConfinementErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_PATH'
  | 'SYMLINK_DENIED'
  | 'SPECIAL_FILE_DENIED'
  | 'HARDLINK_DENIED'
  | 'CROSS_DEVICE_DENIED'
  | 'LIMIT_EXCEEDED'
  | 'NOT_FOUND'
  | 'NOT_DIRECTORY'
  | 'NOT_REGULAR'
  | 'PATH_CHANGED'
  | 'PRECONDITION_FAILED'
  | 'AMBIGUOUS_MATCH'
  | 'UTF8_REQUIRED'
  | 'IO_FAILED'
  | 'UNSUPPORTED_PLATFORM'
  | 'INTERNAL_ERROR'
  | 'PROCESS_FAILED'
  | 'PROTOCOL_ERROR'

export type ConfinementOperation = 'read' | 'write' | 'edit' | 'list' | 'scan'

export interface ConfinementWorkerRequest {
  version: 1
  requestId: string
  root: string
  op: ConfinementOperation
  path?: string
  text?: string
  oldText?: string
  newText?: string
  replaceAll?: boolean
  maxBytes?: number
  maxEntries?: number
  maxDepth?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  /** Optional decimal-string pin; both root identity fields must be supplied together. */
  expectedRootDevice?: string
  expectedRootInode?: string
  /** Existing descriptor-relative components pinned before policy admission. */
  expectedPathComponents?: Array<{
    name: string
    device: string
    inode: string
  }>
}

export interface ConfinementPathPin {
  readonly rootDevice: string
  readonly rootInode: string
  readonly components: readonly Readonly<{
    name: string
    device: string
    inode: string
  }>[]
}

export interface ConfinementProcessPort {
  run(request: ConfinementWorkerRequest): Promise<unknown>
}

export interface ConfinementScanLimits {
  maxEntries?: number
  maxDepth?: number
  maxFileBytes?: number
  maxTotalBytes?: number
}

export interface ConfinementScanResult {
  entries: number
  files: number
  directories: number
  totalBytes: number
}

export interface ConfinementEvent {
  kind: 'confinement.started' | 'confinement.completed' | 'confinement.denied'
  operation: ConfinementOperation
  operationId: string
  leaseId: string
  projectId: string
  sessionId: string
  generation: number
  code?: ConfinementErrorCode
}

export interface ConfinementPort {
  readText(
    lease: TurnContextLease,
    path: string,
    maxBytes?: number,
    pin?: ConfinementPathPin,
  ): Promise<string>
  writeText(
    lease: TurnContextLease,
    path: string,
    text: string,
    maxBytes?: number,
    pin?: ConfinementPathPin,
  ): Promise<number>
  editText(
    lease: TurnContextLease,
    path: string,
    oldText: string,
    newText: string,
    options?: { replaceAll?: boolean; maxBytes?: number },
  ): Promise<{ bytes: number; replacements: number }>
  list(
    lease: TurnContextLease,
    path?: string,
    maxEntries?: number,
    pin?: ConfinementPathPin,
  ): Promise<string[]>
  scan(
    lease: TurnContextLease,
    path?: string,
    limits?: ConfinementScanLimits,
  ): Promise<ConfinementScanResult>
}

export class ConfinementError extends Error {
  constructor(public readonly code: ConfinementErrorCode) {
    super(code)
    this.name = 'ConfinementError'
  }
}

const WORKER_CODES = new Set<ConfinementErrorCode>([
  'INVALID_REQUEST',
  'INVALID_PATH',
  'SYMLINK_DENIED',
  'SPECIAL_FILE_DENIED',
  'HARDLINK_DENIED',
  'CROSS_DEVICE_DENIED',
  'LIMIT_EXCEEDED',
  'NOT_FOUND',
  'NOT_DIRECTORY',
  'NOT_REGULAR',
  'PATH_CHANGED',
  'PRECONDITION_FAILED',
  'AMBIGUOUS_MATCH',
  'UTF8_REQUIRED',
  'IO_FAILED',
  'UNSUPPORTED_PLATFORM',
  'INTERNAL_ERROR',
])

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfinementError('PROTOCOL_ERROR')
  }
  return value as Record<string, unknown>
}

function positiveLimit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new ConfinementError('LIMIT_EXCEEDED')
  }
  return result
}

function nonEmptyId(value: string): string {
  const result = value.trim()
  if (result.length === 0 || Buffer.byteLength(result, 'utf8') > 1024) {
    throw new ConfinementError('INVALID_REQUEST')
  }
  return result
}

function natural(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new ConfinementError('PROTOCOL_ERROR')
  }
  return value as number
}

function pinRequest(pin: ConfinementPathPin | undefined): Pick<
  ConfinementWorkerRequest,
  'expectedRootDevice' | 'expectedRootInode' | 'expectedPathComponents'
> {
  if (pin === undefined) return {}
  const decimal = /^(?:0|[1-9][0-9]{0,19})$/
  if (!decimal.test(pin.rootDevice) || !decimal.test(pin.rootInode) ||
    !Array.isArray(pin.components) || pin.components.length > 256) {
    throw new ConfinementError('INVALID_REQUEST')
  }
  const components = pin.components.map((component) => {
    if (typeof component.name !== 'string' || component.name.length === 0 ||
      component.name === '.' || component.name === '..' || component.name.includes('/') ||
      component.name.includes('\0') || !decimal.test(component.device) ||
      !decimal.test(component.inode)) {
      throw new ConfinementError('INVALID_REQUEST')
    }
    return {
      name: component.name,
      device: component.device,
      inode: component.inode,
    }
  })
  return {
    expectedRootDevice: pin.rootDevice,
    expectedRootInode: pin.rootInode,
    expectedPathComponents: components,
  }
}

function parseEnvelope(response: unknown, requestId: string): Record<string, unknown> {
  const envelope = object(response)
  if (envelope.version !== PROTOCOL_VERSION || envelope.requestId !== requestId ||
    typeof envelope.ok !== 'boolean') {
    throw new ConfinementError('PROTOCOL_ERROR')
  }
  if (envelope.ok === false) {
    const error = object(envelope.error)
    const code = error.code
    if (typeof code !== 'string' || !WORKER_CODES.has(code as ConfinementErrorCode)) {
      throw new ConfinementError('PROTOCOL_ERROR')
    }
    throw new ConfinementError(code as ConfinementErrorCode)
  }
  return object(envelope.data)
}

export function makeConfinementPort(deps: {
  leases: ContextLeaseCoordinator
  process: ConfinementProcessPort
  newId: () => string
  emit?: (event: ConfinementEvent) => void
}): ConfinementPort {
  const execute = async <T>(
    lease: TurnContextLease,
    request: Omit<ConfinementWorkerRequest, 'version' | 'requestId' | 'root'>,
    parse: (data: Record<string, unknown>) => T,
    preflight?: () => void,
  ): Promise<T> => {
    const operation = deps.leases.reserveOperation(lease)
    const event = (kind: ConfinementEvent['kind'], code?: ConfinementErrorCode): void => {
      deps.emit?.({
        kind,
        operation: request.op,
        operationId: operation.operationId,
        leaseId: lease.leaseId,
        projectId: lease.projectId,
        sessionId: lease.sessionId,
        generation: lease.generation,
        ...(code === undefined ? {} : { code }),
      })
    }
    try {
      let requestId: string
      try {
        requestId = nonEmptyId(deps.newId())
      } catch (error) {
        if (error instanceof ConfinementError) throw error
        throw new ConfinementError('INVALID_REQUEST')
      }
      preflight?.()
      operation.beginIo()
      event('confinement.started')
      let response: unknown
      try {
        response = await deps.process.run({
          version: PROTOCOL_VERSION,
          requestId,
          root: lease.root,
          ...request,
        })
      } catch (error) {
        if (error instanceof ConfinementError) throw error
        throw new ConfinementError('PROCESS_FAILED')
      }
      const result = parse(parseEnvelope(response, requestId))
      event('confinement.completed')
      return result
    } catch (error) {
      if (error instanceof ConfinementError) event('confinement.denied', error.code)
      throw error
    } finally {
      operation.complete()
    }
  }

  return Object.freeze<ConfinementPort>({
    readText(lease, path, maxBytes, pin) {
      const limit = positiveLimit(maxBytes, MAX_READ_BYTES, MAX_READ_BYTES)
      return execute(lease, { op: 'read', path, maxBytes: limit, ...pinRequest(pin) }, (data) => {
        if (typeof data.text !== 'string') throw new ConfinementError('PROTOCOL_ERROR')
        const bytes = natural(data.bytes, limit)
        if (Buffer.byteLength(data.text, 'utf8') !== bytes) {
          throw new ConfinementError('PROTOCOL_ERROR')
        }
        return data.text
      })
    },

    writeText(lease, path, text, maxBytes, pin) {
      const limit = positiveLimit(maxBytes, MAX_WRITE_BYTES, MAX_WRITE_BYTES)
      const expectedBytes = Buffer.byteLength(text, 'utf8')
      return execute(lease, {
        op: 'write', path, text, maxBytes: limit, ...pinRequest(pin),
      }, (data) => {
        const bytes = natural(data.bytes, limit)
        if (bytes !== expectedBytes) throw new ConfinementError('PROTOCOL_ERROR')
        return bytes
      }, () => {
        if (expectedBytes > limit) throw new ConfinementError('LIMIT_EXCEEDED')
      })
    },

    editText(lease, path, oldText, newText, options = {}) {
      const limit = positiveLimit(options.maxBytes, MAX_WRITE_BYTES, MAX_WRITE_BYTES)
      const oldBytes = Buffer.byteLength(oldText, 'utf8')
      const newBytes = Buffer.byteLength(newText, 'utf8')
      return execute(lease, {
        op: 'edit',
        path,
        oldText,
        newText,
        replaceAll: options.replaceAll === true,
        maxBytes: limit,
      }, (data) => {
        const replacements = natural(data.replacements, limit)
        if (replacements < 1) throw new ConfinementError('PROTOCOL_ERROR')
        return { bytes: natural(data.bytes, limit), replacements }
      }, () => {
        if (oldBytes < 1) throw new ConfinementError('INVALID_REQUEST')
        if (oldBytes > MAX_WRITE_BYTES || newBytes > MAX_WRITE_BYTES) {
          throw new ConfinementError('LIMIT_EXCEEDED')
        }
      })
    },

    list(lease, path = '.', maxEntries, pin) {
      const limit = positiveLimit(maxEntries, MAX_LIST_ENTRIES, MAX_LIST_ENTRIES)
      return execute(lease, { op: 'list', path, maxEntries: limit, ...pinRequest(pin) }, (data) => {
        if (!Array.isArray(data.entries) || data.entries.length > limit ||
          data.entries.some((entry) => typeof entry !== 'string' || entry.length === 0 ||
            entry === '.' || entry === '..' || entry.includes('/') || entry.includes('\0')) ||
          new Set(data.entries).size !== data.entries.length) {
          throw new ConfinementError('PROTOCOL_ERROR')
        }
        return data.entries as string[]
      })
    },

    scan(lease, path = '.', limits = {}) {
      const maxEntries = positiveLimit(limits.maxEntries, MAX_SCAN_ENTRIES, MAX_SCAN_ENTRIES)
      const maxDepth = positiveLimit(limits.maxDepth, MAX_SCAN_DEPTH, MAX_SCAN_DEPTH)
      const maxFileBytes = positiveLimit(
        limits.maxFileBytes,
        MAX_SCAN_FILE_BYTES,
        MAX_SCAN_FILE_BYTES,
      )
      const maxTotalBytes = positiveLimit(
        limits.maxTotalBytes,
        MAX_SCAN_TOTAL_BYTES,
        MAX_SCAN_TOTAL_BYTES,
      )
      return execute(lease, {
        op: 'scan',
        path,
        maxEntries,
        maxDepth,
        maxFileBytes,
        maxTotalBytes,
      }, (data) => {
        const result = {
          entries: natural(data.entries, maxEntries),
          files: natural(data.files, maxEntries),
          directories: natural(data.directories, maxEntries),
          totalBytes: natural(data.totalBytes, maxTotalBytes),
        }
        if (result.files + result.directories !== result.entries) {
          throw new ConfinementError('PROTOCOL_ERROR')
        }
        return result
      })
    },
  })
}
