import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname, isAbsolute, normalize } from 'node:path'
import {
  ConfinementError,
  type ConfinementProcessPort,
  type ConfinementWorkerRequest,
} from '@aisy/core'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_PROTOCOL_BYTES = 64 * 1024 * 1024
const MAX_DIAGNOSTIC_BYTES = 16 * 1024

export interface NodeConfinementProcessOptions {
  pythonExecutable: string
  workerPath: string
  timeoutMs?: number
}

function trustedAbsolutePath(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value) {
    throw new ConfinementError('INVALID_REQUEST')
  }
  return value
}

/** One-shot, no-shell adapter with an allowlisted process environment. */
export function makeNodeConfinementProcessPort(
  options: NodeConfinementProcessOptions,
): ConfinementProcessPort {
  const pythonExecutable = trustedAbsolutePath(options.pythonExecutable)
  const workerPath = trustedAbsolutePath(options.workerPath)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new ConfinementError('INVALID_REQUEST')
  }

  return Object.freeze<ConfinementProcessPort>({
    run(request: ConfinementWorkerRequest): Promise<unknown> {
      let encoded: string
      try {
        encoded = JSON.stringify(request)
      } catch {
        return Promise.reject(new ConfinementError('PROCESS_FAILED'))
      }
      if (Buffer.byteLength(encoded, 'utf8') > MAX_PROTOCOL_BYTES) {
        return Promise.reject(new ConfinementError('LIMIT_EXCEEDED'))
      }

      return new Promise((resolve, reject) => {
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
          reject(new ConfinementError('PROCESS_FAILED'))
          return
        }
        const stdout: Buffer[] = []
        let stdoutBytes = 0
        let diagnosticBytes = 0
        let settled = false

        const finish = (error?: ConfinementError, value?: unknown): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve(value)
        }
        const terminate = (error: ConfinementError): void => {
          child.kill('SIGKILL')
          finish(error)
        }
        const timer = setTimeout(
          () => terminate(new ConfinementError('PROCESS_FAILED')),
          timeoutMs,
        )
        timer.unref()

        child.stdout.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          stdoutBytes += buffer.byteLength
          if (stdoutBytes > MAX_PROTOCOL_BYTES) {
            terminate(new ConfinementError('PROTOCOL_ERROR'))
            return
          }
          stdout.push(buffer)
        })
        child.stderr.on('data', (chunk: Buffer | string) => {
          diagnosticBytes += Buffer.byteLength(chunk)
          if (diagnosticBytes > MAX_DIAGNOSTIC_BYTES) {
            terminate(new ConfinementError('PROCESS_FAILED'))
          }
        })
        child.on('error', () => finish(new ConfinementError('PROCESS_FAILED')))
        child.on('close', (code) => {
          if (settled) return
          if (code !== 0 && code !== 2) {
            finish(new ConfinementError('PROCESS_FAILED'))
            return
          }
          try {
            finish(undefined, JSON.parse(Buffer.concat(stdout).toString('utf8')))
          } catch {
            finish(new ConfinementError('PROTOCOL_ERROR'))
          }
        })
        child.stdin.on('error', () => finish(new ConfinementError('PROCESS_FAILED')))
        child.stdin.end(encoded)
      })
    },
  })
}
