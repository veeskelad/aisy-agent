import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, normalize } from 'node:path'
import {
  MediaInboxWriterRecoveryError,
  type MediaInboxRecoveryRetentionPort,
} from './telegram-attachment-inbox-recovery.js'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_PROTOCOL_BYTES = 64 * 1024
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/

export interface NodeMediaRecoveryRetentionOptions {
  readonly pythonExecutable: string
  readonly workerPath: string
  readonly timeoutMs?: number
}

function trustedAbsolutePath(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value) {
    throw new MediaInboxWriterRecoveryError('INVALID_REQUEST')
  }
  return value
}

function validDecimal(value: string): boolean {
  return DECIMAL.test(value) && BigInt(value) <= (1n << 64n) - 1n
}

function workerFailure(code: unknown): MediaInboxWriterRecoveryError {
  if (code === 'UNSUPPORTED_PLATFORM') {
    return new MediaInboxWriterRecoveryError('UNSUPPORTED_PLATFORM')
  }
  if (code === 'RECOVERY_INCOMPLETE' || code === 'INTERNAL_ERROR' ||
    code === 'IO_FAILED') {
    return new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
  }
  return new MediaInboxWriterRecoveryError('STATE_CORRUPT')
}

/** Synchronous one-shot startup adapter; it never inherits credentials or a shell. */
export function makeNodeMediaRecoveryRetentionPort(
  options: NodeMediaRecoveryRetentionOptions,
): MediaInboxRecoveryRetentionPort {
  const pythonExecutable = trustedAbsolutePath(options.pythonExecutable)
  const workerPath = trustedAbsolutePath(options.workerPath)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new MediaInboxWriterRecoveryError('INVALID_REQUEST')
  }

  return Object.freeze<MediaInboxRecoveryRetentionPort>({
    compact({ inboxRoot, seal }) {
      const root = trustedAbsolutePath(inboxRoot)
      if (seal.version !== 1 || !validDecimal(seal.rootDevice) ||
        !validDecimal(seal.rootInode) || !validDecimal(seal.lockDevice) ||
        !validDecimal(seal.lockInode) || !validDecimal(seal.ownerDevice) ||
        !validDecimal(seal.ownerInode) || !FINGERPRINT.test(seal.ownerFingerprint)) {
        throw new MediaInboxWriterRecoveryError('INVALID_REQUEST')
      }
      const requestId = randomUUID()
      const encoded = JSON.stringify({
        version: 1,
        requestId,
        root,
        op: 'media-recovery-retention',
        expectedRootDevice: seal.rootDevice,
        expectedRootInode: seal.rootInode,
        expectedWriterLockDevice: seal.lockDevice,
        expectedWriterLockInode: seal.lockInode,
        expectedWriterOwnerDevice: seal.ownerDevice,
        expectedWriterOwnerInode: seal.ownerInode,
        expectedWriterOwnerFingerprint: seal.ownerFingerprint,
      })
      let child: ReturnType<typeof spawnSync>
      try {
        child = spawnSync(pythonExecutable, [workerPath], {
          cwd: dirname(workerPath),
          shell: false,
          input: encoded,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: MAX_PROTOCOL_BYTES,
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
        throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
      }
      const stderrBytes = typeof child.stderr === 'string'
        ? Buffer.byteLength(child.stderr, 'utf8')
        : child.stderr?.byteLength ?? 0
      if (child.error !== undefined || child.signal !== null ||
        (child.status !== 0 && child.status !== 2) ||
        stderrBytes > 16 * 1024) {
        throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
      }
      let response: unknown
      const stdout = typeof child.stdout === 'string'
        ? child.stdout
        : child.stdout?.toString('utf8') ?? ''
      try { response = JSON.parse(stdout) } catch {
        throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
      }
      if (typeof response !== 'object' || response === null || Array.isArray(response)) {
        throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
      }
      const envelope = response as Record<string, unknown>
      if (envelope['version'] !== 1 || envelope['requestId'] !== requestId ||
        typeof envelope['ok'] !== 'boolean') {
        throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
      }
      if (envelope['ok'] === false) {
        if (child.status !== 2 || Object.keys(envelope).sort().join(',') !==
          'error,ok,requestId,version') {
          throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
        }
        const error = envelope['error']
        const code = typeof error === 'object' && error !== null && !Array.isArray(error)
          ? (error as Record<string, unknown>)['code']
          : undefined
        throw workerFailure(code)
      }
      if (child.status !== 0 || Object.keys(envelope).sort().join(',') !==
        'data,ok,requestId,version') {
        throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
      }
      const data = envelope['data']
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
      }
      const result = data as Record<string, unknown>
      if (Object.keys(result).sort().join(',') !== 'removed,retained' ||
        !Number.isSafeInteger(result['removed']) || (result['removed'] as number) < 0 ||
        !Number.isSafeInteger(result['retained']) || (result['retained'] as number) < 0) {
        throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
      }
      return Object.freeze({
        removed: result['removed'] as number,
        retained: result['retained'] as number,
      })
    },
  })
}
