import {
  ConfinementError,
  type ConfinementErrorCode,
  type ConfinementProcessPort,
  type ConfinementScanLimits,
  type ConfinementScanResult,
  type ConfinementWorkerRequest,
} from '@aisy/core'

const WORKER_CODES = new Set<ConfinementErrorCode>([
  'INVALID_REQUEST', 'INVALID_PATH', 'SYMLINK_DENIED', 'SPECIAL_FILE_DENIED',
  'HARDLINK_DENIED', 'CROSS_DEVICE_DENIED', 'LIMIT_EXCEEDED', 'NOT_FOUND',
  'NOT_DIRECTORY', 'NOT_REGULAR', 'PATH_CHANGED', 'UTF8_REQUIRED', 'IO_FAILED',
  'UNSUPPORTED_PLATFORM', 'INTERNAL_ERROR',
])
const MAX_SCAN_ENTRIES = 50_000
const MAX_SCAN_DEPTH = 64
const MAX_SCAN_FILE_BYTES = 16 * 1024 * 1024
const MAX_SCAN_TOTAL_BYTES = 256 * 1024 * 1024

export interface ConfinementTreeScanner {
  scanRoot(root: string, limits?: ConfinementScanLimits): Promise<ConfinementScanResult>
}

function record(value: unknown): Record<string, unknown> {
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

function count(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new ConfinementError('PROTOCOL_ERROR')
  }
  return value as number
}

/** Scan a code-owned staging root before it becomes registry-visible. */
export function makeConfinementTreeScanner(input: {
  process: ConfinementProcessPort
  newId: () => string
}): ConfinementTreeScanner {
  return Object.freeze<ConfinementTreeScanner>({
    async scanRoot(root, limits = {}) {
      let requestId: string
      try {
        requestId = input.newId().trim()
      } catch {
        throw new ConfinementError('INVALID_REQUEST')
      }
      if (requestId.length === 0 || Buffer.byteLength(requestId, 'utf8') > 1024) {
        throw new ConfinementError('INVALID_REQUEST')
      }
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
      const request: ConfinementWorkerRequest = {
        version: 1,
        requestId,
        root,
        op: 'scan',
        path: '.',
        maxEntries,
        maxDepth,
        maxFileBytes,
        maxTotalBytes,
      }
      let raw: unknown
      try {
        raw = await input.process.run(request)
      } catch (error) {
        if (error instanceof ConfinementError) throw error
        throw new ConfinementError('PROCESS_FAILED')
      }
      const envelope = record(raw)
      if (envelope.version !== 1 || envelope.requestId !== requestId ||
        typeof envelope.ok !== 'boolean') {
        throw new ConfinementError('PROTOCOL_ERROR')
      }
      if (!envelope.ok) {
        const code = record(envelope.error).code
        if (typeof code !== 'string' || !WORKER_CODES.has(code as ConfinementErrorCode)) {
          throw new ConfinementError('PROTOCOL_ERROR')
        }
        throw new ConfinementError(code as ConfinementErrorCode)
      }
      const data = record(envelope.data)
      const result = {
        entries: count(data.entries, maxEntries),
        files: count(data.files, maxEntries),
        directories: count(data.directories, maxEntries),
        totalBytes: count(data.totalBytes, maxTotalBytes),
      }
      if (result.files + result.directories !== result.entries) {
        throw new ConfinementError('PROTOCOL_ERROR')
      }
      return result
    },
  })
}
