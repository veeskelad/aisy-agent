import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { Readable, Writable } from 'node:stream'

import type {
  CodexAppServerSession,
  CodexAppServerSessionFactory,
} from './codex-app-server-driver.js'
import {
  canonicalCodexExecutable,
  canonicalCodexWorkingDirectory,
  safeCodexEnvironment,
} from './codex-process-security.js'

export class CodexAppServerTransportError extends Error {
  constructor(public readonly code:
    | 'INVALID_TRANSPORT_CONFIG'
    | 'METHOD_NOT_ALLOWED'
    | 'TRANSPORT_CLOSED'
    | 'PROTOCOL_VIOLATION'
    | 'REQUEST_FAILED'
    | 'REQUEST_TIMEOUT'
    | 'EVENT_QUEUE_OVERFLOW',
  ) {
    super(code)
    this.name = 'CodexAppServerTransportError'
  }
}

interface CodexAppServerChild {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  on(event: 'error', listener: () => void): this
  on(event: 'close', listener: (code: number | null) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

export interface CodexAppServerSpawnPort {
  spawn(
    command: string,
    args: readonly string[],
    options: Readonly<{
      cwd: string
      env: Readonly<Record<string, string>>
      shell: false
      stdio: ['pipe', 'pipe', 'pipe']
    }>,
  ): CodexAppServerChild
}

const REQUEST_METHODS = new Set([
  'initialize', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt',
])
const NOTIFICATION_METHODS = new Set(['initialized'])
const MAX_MESSAGE_BYTES = 1024 * 1024
const MAX_PENDING = 64
const MAX_EVENTS = 256

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nodeSpawnPort(): CodexAppServerSpawnPort {
  return {
    spawn(command, args, options) {
      return spawn(command, [...args], options) as CodexAppServerChild
    },
  }
}

function stableError(code: CodexAppServerTransportError['code']): CodexAppServerTransportError {
  return new CodexAppServerTransportError(code)
}

/**
 * Starts only `codex app-server --listen stdio://`. The child receives a small
 * environment allowlist; provider/API secrets and arbitrary parent variables
 * are never inherited.
 */
export function makeNodeCodexAppServerSessionFactory(input: {
  codexExecutable: string
  hostCwd: string
  environment?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  spawnPort?: CodexAppServerSpawnPort
}): CodexAppServerSessionFactory {
  const requestTimeoutMs = input.requestTimeoutMs ?? 30_000
  const executable = canonicalCodexExecutable(input.codexExecutable)
  const hostCwd = canonicalCodexWorkingDirectory(input.hostCwd)
  if (executable === null || hostCwd === null || !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1_000 || requestTimeoutMs > 120_000) {
    throw stableError('INVALID_TRANSPORT_CONFIG')
  }
  const environment = safeCodexEnvironment(input.environment ?? process.env)
  const spawnPort = input.spawnPort ?? nodeSpawnPort()

  return Object.freeze({
    async open(): Promise<CodexAppServerSession> {
      let child: CodexAppServerChild
      try {
        child = spawnPort.spawn(executable, ['app-server', '--listen', 'stdio://'], {
          cwd: hostCwd,
          env: environment,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch {
        throw stableError('TRANSPORT_CLOSED')
      }

      let closed = false
      let nextId = 1
      let buffered = ''
      const decoder = new StringDecoder('utf8')
      const pending = new Map<number, {
        resolve(value: unknown): void
        reject(error: CodexAppServerTransportError): void
        timer: ReturnType<typeof setTimeout>
      }>()
      const queue: unknown[] = []
      const waiters: Array<(value: IteratorResult<unknown>) => void> = []
      let eventsTaken = false

      const finishWaiters = (): void => {
        for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined })
      }
      const rejectPending = (error: CodexAppServerTransportError): void => {
        for (const item of pending.values()) {
          clearTimeout(item.timer)
          item.reject(error)
        }
        pending.clear()
      }
      const terminate = (error: CodexAppServerTransportError): void => {
        if (closed) return
        closed = true
        rejectPending(error)
        queue.length = 0
        finishWaiters()
        try { child.kill('SIGTERM') } catch { /* already unavailable */ }
      }
      const enqueue = (value: unknown): void => {
        const waiter = waiters.shift()
        if (waiter) {
          waiter({ done: false, value })
          return
        }
        if (queue.length >= MAX_EVENTS) {
          terminate(stableError('EVENT_QUEUE_OVERFLOW'))
          return
        }
        queue.push(value)
      }
      const handleLine = (line: string): void => {
        if (line.length === 0) return
        if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
          terminate(stableError('PROTOCOL_VIOLATION'))
          return
        }
        let value: unknown
        try { value = JSON.parse(line) as unknown } catch {
          terminate(stableError('PROTOCOL_VIOLATION'))
          return
        }
        if (!record(value)) {
          terminate(stableError('PROTOCOL_VIOLATION'))
          return
        }
        if (typeof value.method === 'string') {
          enqueue(Object.freeze(structuredClone(value)))
          return
        }
        if (!Number.isSafeInteger(value.id) || typeof value.id !== 'number' ||
          (value.result === undefined) === (value.error === undefined)) {
          terminate(stableError('PROTOCOL_VIOLATION'))
          return
        }
        const item = pending.get(value.id)
        if (!item) {
          terminate(stableError('PROTOCOL_VIOLATION'))
          return
        }
        pending.delete(value.id)
        clearTimeout(item.timer)
        if (value.error !== undefined) item.reject(stableError('REQUEST_FAILED'))
        else item.resolve(structuredClone(value.result))
      }
      const onStdout = (chunk: Buffer | string): void => {
        if (closed) return
        buffered += decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        if (Buffer.byteLength(buffered, 'utf8') > MAX_MESSAGE_BYTES) {
          terminate(stableError('PROTOCOL_VIOLATION'))
          return
        }
        while (true) {
          const newline = buffered.indexOf('\n')
          if (newline < 0) break
          const line = buffered.slice(0, newline).replace(/\r$/, '')
          buffered = buffered.slice(newline + 1)
          handleLine(line)
          if (closed) break
        }
      }
      child.stdout.on('data', onStdout)
      child.stderr.on('data', () => { /* deliberately drained and discarded */ })
      child.on('error', () => { terminate(stableError('TRANSPORT_CLOSED')) })
      child.on('close', () => { terminate(stableError('TRANSPORT_CLOSED')) })

      const write = (value: unknown): Promise<void> => {
        if (closed) return Promise.reject(stableError('TRANSPORT_CLOSED'))
        let line: string
        try { line = `${JSON.stringify(value)}\n` } catch {
          return Promise.reject(stableError('PROTOCOL_VIOLATION'))
        }
        if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
          return Promise.reject(stableError('PROTOCOL_VIOLATION'))
        }
        return new Promise((resolve, reject) => {
          child.stdin.write(line, (error) => {
            if (error) reject(stableError('TRANSPORT_CLOSED'))
            else resolve()
          })
        })
      }

      return Object.freeze<CodexAppServerSession>({
        async request(method, params) {
          if (!REQUEST_METHODS.has(method)) throw stableError('METHOD_NOT_ALLOWED')
          if (closed) throw stableError('TRANSPORT_CLOSED')
          if (pending.size >= MAX_PENDING) throw stableError('PROTOCOL_VIOLATION')
          const id = nextId++
          if (!Number.isSafeInteger(id)) throw stableError('PROTOCOL_VIOLATION')
          return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(id)
              reject(stableError('REQUEST_TIMEOUT'))
              terminate(stableError('REQUEST_TIMEOUT'))
            }, requestTimeoutMs)
            pending.set(id, { resolve, reject, timer })
            void write({ method, id, params }).catch(() => {
              const item = pending.get(id)
              if (!item) return
              pending.delete(id)
              clearTimeout(item.timer)
              item.reject(stableError('TRANSPORT_CLOSED'))
              terminate(stableError('TRANSPORT_CLOSED'))
            })
          })
        },
        async notify(method, params) {
          if (!NOTIFICATION_METHODS.has(method)) throw stableError('METHOD_NOT_ALLOWED')
          await write({ method, params })
        },
        events() {
          if (eventsTaken) throw stableError('PROTOCOL_VIOLATION')
          eventsTaken = true
          return Object.freeze({
            [Symbol.asyncIterator]() { return this },
            next(): Promise<IteratorResult<unknown>> {
              const value = queue.shift()
              if (value !== undefined) return Promise.resolve({ done: false, value })
              if (closed) return Promise.resolve({ done: true, value: undefined })
              return new Promise(resolve => { waiters.push(resolve) })
            },
          }) as AsyncIterableIterator<unknown>
        },
        async close() {
          if (closed) return
          closed = true
          rejectPending(stableError('TRANSPORT_CLOSED'))
          queue.length = 0
          finishWaiters()
          try { child.stdin.end() } catch { /* already closed */ }
          try { child.kill('SIGTERM') } catch { /* already closed */ }
        },
      })
    },
  })
}
