import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname, isAbsolute, normalize, resolve } from 'node:path'
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import {
  AttachmentImportError,
  type AttachmentImportFilePort,
  type InboxAttachmentV1,
} from '@aisy/core'

const PROTOCOL_VERSION = 1
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_DIAGNOSTIC_BYTES = 16 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const HASH = /^[a-f0-9]{64}$/

export type AttachmentSidecarErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_PATH'
  | 'INVALID_RECORD'
  | 'SYMLINK_DENIED'
  | 'SPECIAL_FILE_DENIED'
  | 'HARDLINK_DENIED'
  | 'CROSS_DEVICE_DENIED'
  | 'LIMIT_EXCEEDED'
  | 'NOT_FOUND'
  | 'NOT_DIRECTORY'
  | 'NOT_REGULAR'
  | 'PATH_CHANGED'
  | 'HASH_MISMATCH'
  | 'STATE_CONFLICT'
  | 'IO_FAILED'
  | 'UNSUPPORTED_PLATFORM'
  | 'INTERNAL_ERROR'
  | 'PROCESS_FAILED'
  | 'PROTOCOL_ERROR'

const WORKER_CODES = new Set<AttachmentSidecarErrorCode>([
  'INVALID_REQUEST', 'INVALID_PATH', 'INVALID_RECORD', 'SYMLINK_DENIED',
  'SPECIAL_FILE_DENIED', 'HARDLINK_DENIED', 'CROSS_DEVICE_DENIED',
  'LIMIT_EXCEEDED', 'NOT_FOUND', 'NOT_DIRECTORY', 'NOT_REGULAR',
  'PATH_CHANGED', 'HASH_MISMATCH', 'STATE_CONFLICT', 'IO_FAILED',
  'UNSUPPORTED_PLATFORM', 'INTERNAL_ERROR',
])

export class AttachmentSidecarError extends Error {
  constructor(public readonly code: AttachmentSidecarErrorCode) {
    super(code)
    this.name = 'AttachmentSidecarError'
  }
}

type AttachmentWorkerOperation = 'read-record' | 'verify' | 'stage' | 'install'

export interface AttachmentWorkerRequest {
  version: 1
  requestId: string
  op: AttachmentWorkerOperation
  root?: string
  path?: string
  sourceRoot?: string
  sourcePath?: string
  destinationRoot?: string
  destinationPath?: string
  operationId?: string
  expectedSha256?: string
  expectedSizeBytes?: number
  maxBytes: number
}

export interface AttachmentWorkerProcessPort {
  run(request: AttachmentWorkerRequest): Promise<unknown>
}

export interface AttachmentInboxRecordReader {
  loadInboxRecord(fileId: string): Promise<unknown | null>
}

export interface NodeAttachmentWorkerOptions {
  pythonExecutable: string
  workerPath: string
  timeoutMs?: number
}

function trustedAbsolutePath(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value) {
    throw new AttachmentSidecarError('INVALID_REQUEST')
  }
  return value
}

function safeId(value: string): void {
  if (!ID.test(value)) throw new AttachmentImportError('INVALID_REQUEST')
}

function ensureTrustedDirectory(path: string): void {
  let ancestor = path
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new AttachmentSidecarError('INVALID_REQUEST')
    ancestor = parent
  }
  const ancestorInfo = lstatSync(ancestor)
  if (!ancestorInfo.isDirectory() || ancestorInfo.isSymbolicLink() ||
    realpathSync(ancestor) !== ancestor) {
    throw new AttachmentSidecarError('SYMLINK_DENIED')
  }
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const finalInfo = lstatSync(path)
  if (!finalInfo.isDirectory() || finalInfo.isSymbolicLink() || realpathSync(path) !== path) {
    throw new AttachmentSidecarError('SYMLINK_DENIED')
  }
  chmodSync(path, 0o700)
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AttachmentSidecarError('PROTOCOL_ERROR')
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    Object.keys(value).every(key => keys.includes(key))
}

function natural(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new AttachmentSidecarError('PROTOCOL_ERROR')
  }
  return value as number
}

function parseEnvelope(response: unknown, requestId: string): Record<string, unknown> {
  const envelope = object(response)
  if (envelope['version'] !== PROTOCOL_VERSION || envelope['requestId'] !== requestId ||
    typeof envelope['ok'] !== 'boolean') {
    throw new AttachmentSidecarError('PROTOCOL_ERROR')
  }
  if (envelope['ok'] === false) {
    if (!exactKeys(envelope, ['version', 'requestId', 'ok', 'error'])) {
      throw new AttachmentSidecarError('PROTOCOL_ERROR')
    }
    const error = object(envelope['error'])
    if (!exactKeys(error, ['code']) || typeof error['code'] !== 'string' ||
      !WORKER_CODES.has(error['code'] as AttachmentSidecarErrorCode)) {
      throw new AttachmentSidecarError('PROTOCOL_ERROR')
    }
    throw new AttachmentSidecarError(error['code'] as AttachmentSidecarErrorCode)
  }
  if (!exactKeys(envelope, ['version', 'requestId', 'ok', 'data'])) {
    throw new AttachmentSidecarError('PROTOCOL_ERROR')
  }
  return object(envelope['data'])
}

export function makeNodeAttachmentWorkerProcessPort(
  options: NodeAttachmentWorkerOptions,
): AttachmentWorkerProcessPort {
  const pythonExecutable = trustedAbsolutePath(options.pythonExecutable)
  const workerPath = trustedAbsolutePath(options.workerPath)
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new AttachmentSidecarError('INVALID_REQUEST')
  }

  return Object.freeze<AttachmentWorkerProcessPort>({
    run(request) {
      let encoded: string
      try {
        encoded = JSON.stringify(request)
      } catch {
        return Promise.reject(new AttachmentSidecarError('PROCESS_FAILED'))
      }
      if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) {
        return Promise.reject(new AttachmentSidecarError('LIMIT_EXCEEDED'))
      }
      return new Promise((resolvePromise, reject) => {
        let child: ChildProcessWithoutNullStreams
        try {
          child = spawn(pythonExecutable, [workerPath], {
            cwd: dirname(workerPath),
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
              LANG: 'C.UTF-8',
              LC_ALL: 'C.UTF-8',
              PYTHONNOUSERSITE: '1',
              PYTHONDONTWRITEBYTECODE: '1',
              PYTHONSAFEPATH: '1',
            },
          })
        } catch {
          reject(new AttachmentSidecarError('PROCESS_FAILED'))
          return
        }
        const stdout: Buffer[] = []
        let stdoutBytes = 0
        let diagnosticBytes = 0
        let settled = false
        const finish = (error?: AttachmentSidecarError, value?: unknown): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolvePromise(value)
        }
        const terminate = (error: AttachmentSidecarError): void => {
          child.kill('SIGKILL')
          finish(error)
        }
        const timer = setTimeout(
          () => terminate(new AttachmentSidecarError('PROCESS_FAILED')),
          timeoutMs,
        )
        timer.unref()
        child.stdout.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          stdoutBytes += buffer.byteLength
          if (stdoutBytes > MAX_RESPONSE_BYTES) {
            terminate(new AttachmentSidecarError('PROTOCOL_ERROR'))
            return
          }
          stdout.push(buffer)
        })
        child.stderr.on('data', (chunk: Buffer | string) => {
          diagnosticBytes += Buffer.byteLength(chunk)
          if (diagnosticBytes > MAX_DIAGNOSTIC_BYTES) {
            terminate(new AttachmentSidecarError('PROCESS_FAILED'))
          }
        })
        child.on('error', () => finish(new AttachmentSidecarError('PROCESS_FAILED')))
        child.on('close', (code) => {
          if (settled) return
          if (code !== 0 && code !== 2) {
            finish(new AttachmentSidecarError('PROCESS_FAILED'))
            return
          }
          try {
            finish(undefined, JSON.parse(Buffer.concat(stdout).toString('utf8')))
          } catch {
            finish(new AttachmentSidecarError('PROTOCOL_ERROR'))
          }
        })
        child.stdin.on('error', () => finish(new AttachmentSidecarError('PROCESS_FAILED')))
        child.stdin.end(encoded)
      })
    },
  })
}

export function makeNodeAttachmentImportFilePort(input: {
  process: AttachmentWorkerProcessPort
  inboxRoot: string
  stagingRoot: string
  maxAttachmentBytes: number
  newRequestId: () => string
  faultAt?: (point: 'after-stage' | 'after-install') => void
}): AttachmentImportFilePort & AttachmentInboxRecordReader {
  const inboxRoot = trustedAbsolutePath(resolve(input.inboxRoot))
  const stagingRoot = trustedAbsolutePath(resolve(input.stagingRoot))
  if (!Number.isSafeInteger(input.maxAttachmentBytes) || input.maxAttachmentBytes < 1) {
    throw new AttachmentImportError('INVALID_REQUEST')
  }
  ensureTrustedDirectory(stagingRoot)

  const requestId = (): string => {
    const value = input.newRequestId()
    if (value.length === 0 || Buffer.byteLength(value, 'utf8') > 1024 || value.includes('\0')) {
      throw new AttachmentSidecarError('INVALID_REQUEST')
    }
    return value
  }
  const execute = async (
    request: Omit<AttachmentWorkerRequest, 'version' | 'requestId'>,
  ): Promise<Record<string, unknown>> => {
    const id = requestId()
    let response: unknown
    try {
      response = await input.process.run({ version: 1, requestId: id, ...request })
    } catch (error) {
      if (error instanceof AttachmentSidecarError) throw error
      throw new AttachmentSidecarError('PROCESS_FAILED')
    }
    return parseEnvelope(response, id)
  }
  const verify = async (root: string, path: string): Promise<{
    exists: boolean
    sha256?: string
    sizeBytes?: number
  }> => {
    const data = await execute({
      op: 'verify',
      root,
      path,
      maxBytes: input.maxAttachmentBytes,
    })
    if (data['exists'] === false && exactKeys(data, ['exists'])) return { exists: false }
    if (data['exists'] !== true || !exactKeys(data, ['exists', 'sha256', 'sizeBytes']) ||
      typeof data['sha256'] !== 'string' || !HASH.test(data['sha256'])) {
      throw new AttachmentSidecarError('PROTOCOL_ERROR')
    }
    return {
      exists: true,
      sha256: data['sha256'],
      sizeBytes: natural(data['sizeBytes'], input.maxAttachmentBytes),
    }
  }

  return Object.freeze<AttachmentImportFilePort & AttachmentInboxRecordReader>({
    async loadInboxRecord(fileId: string): Promise<unknown | null> {
      safeId(fileId)
      try {
        const data = await execute({
          op: 'read-record',
          root: inboxRoot,
          path: `records/${fileId}.json`,
          maxBytes: MAX_RECORD_BYTES,
        })
        if (!exactKeys(data, ['record'])) throw new AttachmentSidecarError('PROTOCOL_ERROR')
        return data['record']
      } catch (error) {
        if (error instanceof AttachmentSidecarError && error.code === 'NOT_FOUND') return null
        if (error instanceof AttachmentSidecarError &&
          (error.code === 'INVALID_RECORD' || error.code === 'INVALID_REQUEST')) {
          throw new AttachmentImportError('INBOX_INVALID')
        }
        throw error
      }
    },

    async verifyInbox(inbox: InboxAttachmentV1) {
      safeId(inbox.fileId)
      const result = await verify(inboxRoot, `objects/${inbox.fileId}`)
      if (!result.exists || result.sha256 === undefined || result.sizeBytes === undefined) {
        throw new AttachmentImportError('HASH_MISMATCH')
      }
      return { sha256: result.sha256, sizeBytes: result.sizeBytes }
    },

    async stage({ operationId, inbox }) {
      const data = await execute({
        op: 'stage',
        sourceRoot: inboxRoot,
        sourcePath: `objects/${inbox.fileId}`,
        destinationRoot: stagingRoot,
        destinationPath: `${operationId}.bin`,
        operationId,
        expectedSha256: inbox.sha256,
        expectedSizeBytes: inbox.sizeBytes,
        maxBytes: input.maxAttachmentBytes,
      })
      if (!exactKeys(data, ['status']) ||
        (data['status'] !== 'staged' && data['status'] !== 'already-staged')) {
        if (data['status'] === 'state-conflict') throw new AttachmentImportError('WAL_CONFLICT')
        throw new AttachmentSidecarError('PROTOCOL_ERROR')
      }
      input.faultAt?.('after-stage')
    },

    async install({ operationId, lease, relativePath, sha256, sizeBytes }) {
      const data = await execute({
        op: 'install',
        sourceRoot: stagingRoot,
        sourcePath: `${operationId}.bin`,
        destinationRoot: trustedAbsolutePath(resolve(lease.root)),
        destinationPath: relativePath,
        operationId,
        expectedSha256: sha256,
        expectedSizeBytes: sizeBytes,
        maxBytes: input.maxAttachmentBytes,
      })
      if (!exactKeys(data, ['status']) ||
        (data['status'] !== 'installed' && data['status'] !== 'already-installed' &&
          data['status'] !== 'collision')) {
        throw new AttachmentSidecarError('PROTOCOL_ERROR')
      }
      input.faultAt?.('after-install')
      return data['status']
    },

    async verifyInstalled({ lease, relativePath, sha256, sizeBytes }) {
      const result = await verify(trustedAbsolutePath(resolve(lease.root)), relativePath)
      return result.exists && result.sha256 === sha256 && result.sizeBytes === sizeBytes
    },
  })
}
