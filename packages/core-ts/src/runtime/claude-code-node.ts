import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'

import Database from 'better-sqlite3'

import type { ClaudeAuthProcessPort, ClaudeCommandResult } from './claude-auth.js'
import { CLAUDE_CODE_PROTOCOL_PROFILE } from './claude-auth.js'
import {
  ClaudeCodeDriverError,
  isClaudeCodeRunArgs,
  type ClaudeCodeCapabilityProfileKind,
  type ClaudeCodeProcessCompletion,
  type ClaudeCodeProcessPort,
  type ClaudeCodeProcessSession,
  type ClaudeCodeSessionStore,
  type ClaudeCodeTurnLease,
} from './claude-code-driver.js'

export interface ClaudeCodeExecutablePin {
  path: string
  sha256: string
}

export interface ClaudeCodeTrustAttestation {
  approved: true
  fingerprint: string
}

export interface ClaudeCodeIsolationPolicy {
  kind: 'managed-policy' | 'isolated-container'
  sha256: string
}

export interface ClaudeCodeTerminationFacts {
  pid: number
  processGroupId: number
  executableSha256: string
  stagedSha256: string
  termSignal: 'SIGTERM'
  killSignal: 'SIGKILL'
  termGraceMs: number
  confirmationTimeoutMs: number
}

export interface ClaudeCodeTerminationReceipt {
  readonly kind: 'aisy-claude-termination-receipt-v1'
}

export interface ClaudeCodeTerminationSupervisorPort {
  terminateAndVerify(facts: ClaudeCodeTerminationFacts): Promise<ClaudeCodeTerminationReceipt>
}

interface ClaudeCodeChild {
  pid?: number
  stdin: Writable
  stdout: Readable
  stderr: Readable
  on(event: 'error', listener: () => void): this
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: () => void): this
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  removeListener(event: 'error', listener: () => void): this
  removeListener(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export interface ClaudeCodeSpawnPort {
  spawn(command: string, args: readonly string[], options: Readonly<{
    cwd: string
    env: Readonly<Record<string, string>>
    shell: false
    stdio: ['pipe', 'pipe', 'pipe']
    detached: true
  }>): ClaudeCodeChild
}

export interface ClaudeCodeExecPort {
  run(command: string, args: readonly string[], options: Readonly<{
    cwd: string
    env: Readonly<Record<string, string>>
    timeout: number
    maxBuffer: number
  }>): Promise<ClaudeCommandResult>
}

export interface ClaudeCodeNodeConfig {
  executable: ClaudeCodeExecutablePin
  trust: ClaudeCodeTrustAttestation
  isolationPolicy: ClaudeCodeIsolationPolicy
  cwd: string
  configDir: string
  runtimeDir: string
  environment?: NodeJS.ProcessEnv
  wallTimeoutMs?: number
  idleTimeoutMs?: number
  killGraceMs?: number
  spawnPort?: ClaudeCodeSpawnPort
  execPort?: ClaudeCodeExecPort
}

const SHA256 = /^[0-9a-f]{64}$/
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024
const MAX_PROMPT_BYTES = 2 * 1024 * 1024
const MAX_LINE_BYTES = 1024 * 1024
const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const MAX_AUTH_BYTES = 16 * 1024
const MAX_QUEUE = 256
const PAUSE_QUEUE = 192
const RESUME_QUEUE = 64

const MANAGED_POLICY_CANONICAL =
  'aisy:claude-code:smoke-readonly:managed-policy:v1:fs=deny-unmanaged:network=deny-unmanaged:tools=none:mcp=none'
const CONTAINER_POLICY_CANONICAL =
  'aisy:claude-code:smoke-readonly:isolated-container:v1:fs=deny-unmanaged:network=deny-unmanaged:tools=none:mcp=none'

export const CLAUDE_CODE_MANAGED_POLICY_SHA256 =
  createHash('sha256').update(MANAGED_POLICY_CANONICAL).digest('hex')
export const CLAUDE_CODE_CONTAINER_POLICY_SHA256 =
  createHash('sha256').update(CONTAINER_POLICY_CANONICAL).digest('hex')

const terminationReceipts = new WeakMap<object, string>()

function stable(code: ConstructorParameters<typeof ClaudeCodeDriverError>[0]): ClaudeCodeDriverError {
  return new ClaudeCodeDriverError(code)
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function terminationFactsSha256(facts: ClaudeCodeTerminationFacts): string {
  return sha256(JSON.stringify([
    facts.pid,
    facts.processGroupId,
    facts.executableSha256,
    facts.stagedSha256,
    facts.termSignal,
    facts.killSignal,
    facts.termGraceMs,
    facts.confirmationTimeoutMs,
  ]))
}

function approvedIsolationPolicy(policy: ClaudeCodeIsolationPolicy | undefined): boolean {
  return (policy?.kind === 'managed-policy' && policy.sha256 === CLAUDE_CODE_MANAGED_POLICY_SHA256) ||
    (policy?.kind === 'isolated-container' && policy.sha256 === CLAUDE_CODE_CONTAINER_POLICY_SHA256)
}

export function makeNodeClaudeCodeTerminationSupervisorPort(): ClaudeCodeTerminationSupervisorPort {
  return Object.freeze({
    async terminateAndVerify(facts: ClaudeCodeTerminationFacts): Promise<ClaudeCodeTerminationReceipt> {
      if (!Number.isSafeInteger(facts.pid) || facts.pid <= 1 || facts.processGroupId !== facts.pid ||
        !SHA256.test(facts.executableSha256) || !SHA256.test(facts.stagedSha256) ||
        facts.termSignal !== 'SIGTERM' || facts.killSignal !== 'SIGKILL' ||
        !validTimeout(facts.termGraceMs, 10, 10_000) ||
        !validTimeout(facts.confirmationTimeoutMs, 10, 10_000)) {
        throw stable('CLAUDE_TERMINATION_UNCONFIRMED')
      }
      const digest = terminationFactsSha256(facts)
      try {
        process.kill(-facts.processGroupId, facts.termSignal)
        await new Promise(resolveDelay => { setTimeout(resolveDelay, facts.termGraceMs) })
        try {
          process.kill(-facts.processGroupId, facts.killSignal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
        const deadline = Date.now() + facts.confirmationTimeoutMs
        while (processTargetExists(facts.pid) || processTargetExists(-facts.processGroupId)) {
          if (Date.now() >= deadline) throw stable('CLAUDE_TERMINATION_UNCONFIRMED')
          await new Promise(resolveDelay => { setTimeout(resolveDelay, 10) })
        }
      } catch {
        throw stable('CLAUDE_TERMINATION_UNCONFIRMED')
      }
      const receipt = Object.freeze<ClaudeCodeTerminationReceipt>({
        kind: 'aisy-claude-termination-receipt-v1',
      })
      terminationReceipts.set(receipt, digest)
      return receipt
    },
  })
}

function processTargetExists(target: number): boolean {
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function safeAbsolute(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && isAbsolute(value) && normalize(value) === value
}

function sameStat(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs &&
    a.mode === b.mode && a.uid === b.uid
}

function verifyControlledParent(value: string): void {
  try {
    if (!safeAbsolute(value) || realpathSync(value) !== value) throw stable('CLAUDE_ISOLATION_FAILED')
    const stat = lstatSync(value)
    const ownerOk = typeof process.getuid !== 'function' || stat.uid === process.getuid()
    if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerOk || (stat.mode & 0o022) !== 0) {
      throw stable('CLAUDE_ISOLATION_FAILED')
    }
  } catch (error) {
    if (error instanceof ClaudeCodeDriverError) throw error
    throw stable('CLAUDE_ISOLATION_FAILED')
  }
}

function readVerifiedExecutable(pin: ClaudeCodeExecutablePin, trust: ClaudeCodeTrustAttestation): Buffer {
  if (!safeAbsolute(pin.path) || !SHA256.test(pin.sha256) || trust.approved !== true ||
    trust.fingerprint !== pin.sha256) throw stable('CLAUDE_ISOLATION_FAILED')
  try {
    verifyControlledParent(dirname(pin.path))
    if (realpathSync(pin.path) !== pin.path) throw stable('CLAUDE_ISOLATION_FAILED')
    const fd = openSync(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = fstatSync(fd)
      const ownerOk = typeof process.getuid !== 'function' || before.uid === process.getuid()
      if (!before.isFile() || !ownerOk || (before.mode & 0o111) === 0 || (before.mode & 0o022) !== 0 ||
        before.size < 1 || before.size > MAX_EXECUTABLE_BYTES) throw stable('CLAUDE_ISOLATION_FAILED')
      const bytes = Buffer.allocUnsafe(before.size)
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (count <= 0) throw stable('CLAUDE_ISOLATION_FAILED')
        offset += count
      }
      const eofProbe = Buffer.allocUnsafe(1)
      if (readSync(fd, eofProbe, 0, 1, offset) !== 0) throw stable('CLAUDE_ISOLATION_FAILED')
      const after = fstatSync(fd)
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (!sameStat(before, after) || digest !== pin.sha256) throw stable('CLAUDE_ISOLATION_FAILED')
      return bytes
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if (error instanceof ClaudeCodeDriverError) throw error
    throw stable('CLAUDE_ISOLATION_FAILED')
  }
}

interface ClaudeCodeExecutableStage {
  directory: string
  executable: string
  sha256: string
}

function cleanupStage(stage: Pick<ClaudeCodeExecutableStage, 'directory' | 'executable'>): void {
  try { unlinkSync(stage.executable) } catch { /* already absent */ }
  try { rmdirSync(stage.directory) } catch { /* exact private directory retained for inspection */ }
}

function stageExecutable(input: ClaudeCodeNodeConfig): ClaudeCodeExecutableStage {
  const runtimeDir = verifyPrivateDirectory(input.runtimeDir)
  const bytes = readVerifiedExecutable(input.executable, input.trust)
  let directory: string | null = null
  let executable: string | null = null
  try {
    directory = mkdtempSync(join(runtimeDir, 'launch-'))
    chmodSync(directory, 0o700)
    if (realpathSync(directory) !== directory) throw stable('CLAUDE_ISOLATION_FAILED')
    executable = join(directory, `claude-${randomUUID()}`)
    writeFileSync(executable, bytes, { flag: 'wx', mode: 0o500 })
    chmodSync(executable, 0o500)
    const staged = lstatSync(executable)
    const ownerOk = typeof process.getuid !== 'function' || staged.uid === process.getuid()
    accessSync(executable, constants.X_OK)
    if (!staged.isFile() || staged.isSymbolicLink() || !ownerOk || (staged.mode & 0o777) !== 0o500 ||
      createHash('sha256').update(readFileSync(executable)).digest('hex') !== input.executable.sha256) {
      throw stable('CLAUDE_ISOLATION_FAILED')
    }
    return { directory, executable, sha256: input.executable.sha256 }
  } catch (error) {
    if (directory !== null) cleanupStage({ directory, executable: executable ?? join(directory, 'missing') })
    if (error instanceof ClaudeCodeDriverError) throw error
    throw stable('CLAUDE_ISOLATION_FAILED')
  }
}

function verifyPrivateDirectory(value: string): string {
  if (!safeAbsolute(value)) throw stable('CLAUDE_ISOLATION_FAILED')
  try {
    if (realpathSync(value) !== value) throw stable('CLAUDE_ISOLATION_FAILED')
    const stat = lstatSync(value)
    const ownerOk = typeof process.getuid !== 'function' || stat.uid === process.getuid()
    if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerOk || (stat.mode & 0o777) !== 0o700) {
      throw stable('CLAUDE_ISOLATION_FAILED')
    }
    return value
  } catch (error) {
    if (error instanceof ClaudeCodeDriverError) throw error
    throw stable('CLAUDE_ISOLATION_FAILED')
  }
}

const SAFE_PARENT_ENV = [
  'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'NO_COLOR',
] as const

function safeEnvironment(source: NodeJS.ProcessEnv, configDir: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const key of SAFE_PARENT_ENV) {
    const value = source[key]
    if (typeof value === 'string' && value.length <= 8192 && !value.includes('\0')) result[key] = value
  }
  Object.assign(result, {
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_CRON: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    CLAUDE_CODE_MAX_RETRIES: '3',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    NO_COLOR: '1',
    TERM: 'dumb',
  })
  return Object.freeze(result)
}

function rejectUnavailableIsolationRuntime(
  stage: ClaudeCodeExecutableStage,
): void {
  try {
    const stat = lstatSync(stage.executable)
    const ownerOk = typeof process.getuid !== 'function' || stat.uid === process.getuid()
    if (!stat.isFile() || stat.isSymbolicLink() || !ownerOk || (stat.mode & 0o777) !== 0o500 ||
      sha256(readFileSync(stage.executable)) !== stage.sha256) {
      throw stable('CLAUDE_ISOLATION_FAILED')
    }
  } catch (error) {
    if (error instanceof ClaudeCodeDriverError) throw error
    throw stable('CLAUDE_ISOLATION_FAILED')
  }
  // No code-owned managed-policy/container attestor has landed yet. Caller
  // assertions must never activate the dormant Claude process boundary.
  throw stable('CLAUDE_ISOLATION_FAILED')
}

function validTimeout(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum
}

function nodeSpawnPort(): ClaudeCodeSpawnPort {
  return {
    spawn(command, args, options) {
      return spawn(command, [...args], options) as ClaudeCodeChild
    },
  }
}

function nodeExecPort(): ClaudeCodeExecPort {
  return {
    run(command, args, options) {
      return new Promise(resolveResult => {
        execFile(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeout,
          maxBuffer: options.maxBuffer,
          encoding: 'utf8',
        }, (error, stdout) => {
          const exitCode = typeof (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code === 'number'
            ? Number((error as { code: number }).code)
            : error ? 1 : 0
          resolveResult({ exitCode, output: stdout })
        })
      })
    },
  }
}

function validatedConfig(input: ClaudeCodeNodeConfig): {
  wallTimeoutMs: number
  idleTimeoutMs: number
  killGraceMs: number
  environment: Readonly<Record<string, string>>
} {
  const wallTimeoutMs = input.wallTimeoutMs ?? 300_000
  const idleTimeoutMs = input.idleTimeoutMs ?? 60_000
  const killGraceMs = input.killGraceMs ?? 2_000
  if (!validTimeout(wallTimeoutMs, 1_000, 900_000) ||
    !validTimeout(idleTimeoutMs, 1_000, wallTimeoutMs) ||
    !validTimeout(killGraceMs, 10, 10_000) ||
    !approvedIsolationPolicy(input.isolationPolicy)) {
    throw stable('CLAUDE_ISOLATION_FAILED')
  }
  verifyControlledParent(dirname(input.cwd))
  verifyPrivateDirectory(input.cwd)
  verifyControlledParent(dirname(input.configDir))
  const configDir = verifyPrivateDirectory(input.configDir)
  verifyControlledParent(dirname(input.runtimeDir))
  verifyPrivateDirectory(input.runtimeDir)
  return {
    wallTimeoutMs,
    idleTimeoutMs,
    killGraceMs,
    environment: safeEnvironment(input.environment ?? process.env, configDir),
  }
}

/** Exact, bounded JSONL process adapter for the dormant read-only profile. */
export function makeNodeClaudeCodeProcessPort(config: ClaudeCodeNodeConfig): ClaudeCodeProcessPort {
  const spawnPort = config.spawnPort ?? nodeSpawnPort()
  const terminationSupervisor = makeNodeClaudeCodeTerminationSupervisorPort()

  return Object.freeze({
    async start(input: Parameters<ClaudeCodeProcessPort['start']>[0]): Promise<ClaudeCodeProcessSession> {
      if (!isClaudeCodeRunArgs(input.args) || input.cwd !== config.cwd ||
        input.configDir !== config.configDir || Buffer.byteLength(input.stdin, 'utf8') > MAX_PROMPT_BYTES ||
        input.stdin.includes('\0')) throw stable('CLAUDE_ISOLATION_FAILED')
      const checked = validatedConfig(config)
      const stage = stageExecutable(config)
      try {
        rejectUnavailableIsolationRuntime(stage)
      } catch (error) {
        cleanupStage(stage)
        throw error
      }
      let child: ClaudeCodeChild
      try {
        child = spawnPort.spawn(stage.executable, input.args, {
          cwd: verifyPrivateDirectory(input.cwd),
          env: checked.environment,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        })
      } catch {
        cleanupStage(stage)
        throw stable('CLAUDE_PROCESS_FAILED')
      }
      if (!Number.isSafeInteger(child.pid) || Number(child.pid) <= 1) {
        throw stable('CLAUDE_TERMINATION_UNCONFIRMED')
      }
      const pid = Number(child.pid)

      let closed = false
      let fatal: ClaudeCodeDriverError | null = null
      let buffered = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let eventsTaken = false
      let paused = false
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const queue: unknown[] = []
      const waiters: Array<{
        resolve(value: IteratorResult<unknown>): void
        reject(error: ClaudeCodeDriverError): void
      }> = []
      let resolveCompletion!: (value: ClaudeCodeProcessCompletion) => void
      const completion = new Promise<ClaudeCodeProcessCompletion>(resolve => { resolveCompletion = resolve })
      let wallTimer: ReturnType<typeof setTimeout> | null = null
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let terminationStarted = false
      let terminationPromise: Promise<void> | null = null

      const finishWaiters = (): void => {
        for (const waiter of waiters.splice(0)) {
          if (fatal) waiter.reject(fatal)
          else waiter.resolve({ done: true, value: undefined })
        }
      }
      const clearLifecycleTimers = (): void => {
        if (wallTimer) clearTimeout(wallTimer)
        if (idleTimer) clearTimeout(idleTimer)
      }
      const beginTermination = (): Promise<void> => {
        if (terminationPromise !== null) return terminationPromise
        if (closed) return Promise.resolve()
        terminationStarted = true
        clearLifecycleTimers()
        const facts = Object.freeze<ClaudeCodeTerminationFacts>({
          pid,
          processGroupId: pid,
          executableSha256: config.executable.sha256,
          stagedSha256: stage.sha256,
          termSignal: 'SIGTERM',
          killSignal: 'SIGKILL',
          termGraceMs: checked.killGraceMs,
          confirmationTimeoutMs: checked.killGraceMs,
        })
        terminationPromise = new Promise<void>(resolveTermination => {
          let settled = false
          const settle = (receipt: ClaudeCodeTerminationReceipt | null): void => {
            if (settled) return
            settled = true
            clearTimeout(supervisorTimer)
            const verified = receipt?.kind === 'aisy-claude-termination-receipt-v1' &&
              terminationReceipts.get(receipt) === terminationFactsSha256(facts)
            if (verified) cleanupStage(stage)
            else fatal = stable('CLAUDE_TERMINATION_UNCONFIRMED')
            closed = true
            finishWaiters()
            resolveCompletion({
              exitCode: 1,
              signal: verified ? 'SIGKILL' : null,
            })
            resolveTermination()
          }
          const supervisorTimer = setTimeout(
            () => { settle(null) },
            checked.killGraceMs * 3,
          )
          void terminationSupervisor.terminateAndVerify(facts)
            .then(receipt => { settle(receipt) })
            .catch(() => { settle(null) })
        })
        return terminationPromise
      }
      const abort = async (error: ClaudeCodeDriverError): Promise<void> => {
        if (closed) return
        if (fatal === null) {
          fatal = error
          queue.length = 0
        }
        await beginTermination()
      }
      const resumeIfNeeded = (): void => {
        if (paused && queue.length <= RESUME_QUEUE) {
          paused = false
          child.stdout.resume()
        }
      }
      const enqueue = (value: unknown): void => {
        if (fatal !== null || closed) return
        const waiter = waiters.shift()
        if (waiter) {
          waiter.resolve({ done: false, value })
          return
        }
        if (queue.length >= MAX_QUEUE) {
          void abort(stable('CLAUDE_OUTPUT_REJECTED'))
          return
        }
        queue.push(value)
        if (!paused && queue.length >= PAUSE_QUEUE) {
          paused = true
          child.stdout.pause()
        }
      }
      const handleLine = (line: string): void => {
        const clean = line.endsWith('\r') ? line.slice(0, -1) : line
        if (clean.length === 0) return
        if (Buffer.byteLength(clean, 'utf8') > MAX_LINE_BYTES) {
          void abort(stable('CLAUDE_OUTPUT_REJECTED'))
          return
        }
        let value: unknown
        try { value = JSON.parse(clean) as unknown } catch {
          void abort(stable('CLAUDE_PROTOCOL_FAILED'))
          return
        }
        enqueue(Object.freeze(structuredClone(value)))
      }

      const resetIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => { void abort(stable('CLAUDE_TIMEOUT')) }, checked.idleTimeoutMs)
      }
      wallTimer = setTimeout(() => { void abort(stable('CLAUDE_TIMEOUT')) }, checked.wallTimeoutMs)
      idleTimer = setTimeout(() => { void abort(stable('CLAUDE_TIMEOUT')) }, checked.idleTimeoutMs)

      child.stdout.on('data', (chunk: Buffer | string) => {
        if (closed || fatal !== null) return
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        stdoutBytes += bytes.byteLength
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          void abort(stable('CLAUDE_OUTPUT_REJECTED'))
          return
        }
        resetIdle()
        try { buffered += decoder.decode(bytes, { stream: true }) } catch {
          void abort(stable('CLAUDE_OUTPUT_REJECTED'))
          return
        }
        if (Buffer.byteLength(buffered, 'utf8') > MAX_LINE_BYTES) {
          void abort(stable('CLAUDE_OUTPUT_REJECTED'))
          return
        }
        while (fatal === null) {
          const newline = buffered.indexOf('\n')
          if (newline < 0) break
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          handleLine(line)
        }
      })
      child.stderr.on('data', (chunk: Buffer | string) => {
        if (closed || fatal !== null) return
        stderrBytes += Buffer.byteLength(chunk)
        if (stderrBytes > MAX_STDERR_BYTES) void abort(stable('CLAUDE_OUTPUT_REJECTED'))
      })
      child.on('error', () => { void abort(stable('CLAUDE_PROCESS_FAILED')) })
      child.on('close', (code, signal) => {
        if (closed || terminationStarted) return
        clearLifecycleTimers()
        if (fatal === null) {
          try { buffered += decoder.decode() } catch { fatal = stable('CLAUDE_OUTPUT_REJECTED') }
          if (fatal === null && buffered.length > 0) handleLine(buffered)
        }
        closed = true
        clearLifecycleTimers()
        cleanupStage(stage)
        finishWaiters()
        resolveCompletion({ exitCode: code ?? 1, signal })
      })

      await new Promise<void>((resolveWrite, rejectWrite) => {
        let settled = false
        const settle = (error?: ClaudeCodeDriverError): void => {
          if (settled) return
          settled = true
          clearTimeout(writeTimer)
          child.stdin.removeListener('error', onWriteError)
          child.removeListener('close', onWriteClose)
          if (error) rejectWrite(error)
          else resolveWrite()
        }
        const onWriteError = (): void => {
          const error = stable('CLAUDE_PROCESS_FAILED')
          void abort(error).then(() => { settle(fatal ?? error) })
        }
        const onWriteClose = (): void => {
          const error = stable('CLAUDE_PROCESS_FAILED')
          void abort(error).then(() => { settle(fatal ?? error) })
        }
        const writeTimer = setTimeout(() => {
          const error = stable('CLAUDE_TIMEOUT')
          void abort(error).then(() => { settle(fatal ?? error) })
        }, Math.min(checked.idleTimeoutMs, 30_000))
        child.stdin.once('error', onWriteError)
        child.once('close', onWriteClose)
        try {
          child.stdin.end(input.stdin, () => {
            child.stdin.on('error', () => { void abort(stable('CLAUDE_PROCESS_FAILED')) })
            settle()
          })
        } catch {
          onWriteError()
        }
      })

      return Object.freeze<ClaudeCodeProcessSession>({
        completion,
        events() {
          if (eventsTaken) throw stable('CLAUDE_PROTOCOL_FAILED')
          eventsTaken = true
          return Object.freeze({
            [Symbol.asyncIterator]() { return this },
            next(): Promise<IteratorResult<unknown>> {
              if (closed && fatal) return Promise.reject(fatal)
              const value = queue.shift()
              if (value !== undefined) {
                resumeIfNeeded()
                return Promise.resolve({ done: false, value })
              }
              if (closed) return Promise.resolve({ done: true, value: undefined })
              return new Promise((resolve, reject) => { waiters.push({ resolve, reject }) })
            },
          }) as AsyncIterableIterator<unknown>
        },
        async terminate() {
          if (closed) return
          if (fatal === null) {
            fatal = stable('CLAUDE_INTERRUPTED')
            queue.length = 0
          }
          await beginTermination()
          if (fatal.code === 'CLAUDE_TERMINATION_UNCONFIRMED') throw fatal
        },
      })
    },
  })
}

/** Narrow process boundary for version and non-secret auth-status checks only. */
export function makeSecureClaudeAuthProcessPort(config: ClaudeCodeNodeConfig): ClaudeAuthProcessPort {
  const execPort = config.execPort ?? nodeExecPort()
  return Object.freeze({
    async run(command: string, args: string[]): Promise<ClaudeCommandResult> {
      const allowed = command === 'claude' && (
        (args.length === 1 && args[0] === '--version') ||
        (args.length === 2 && args[0] === 'auth' && args[1] === 'status')
      )
      if (!allowed) throw stable('CLAUDE_ISOLATION_FAILED')
      const checked = validatedConfig(config)
      const stage = stageExecutable(config)
      let result: ClaudeCommandResult
      try {
        rejectUnavailableIsolationRuntime(stage)
        result = await execPort.run(stage.executable, args, {
          cwd: verifyPrivateDirectory(config.cwd),
          env: checked.environment,
          timeout: Math.min(checked.idleTimeoutMs, 30_000),
          maxBuffer: MAX_AUTH_BYTES,
        })
      } finally {
        cleanupStage(stage)
      }
      if (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0 ||
        typeof result.output !== 'string' || Buffer.byteLength(result.output, 'utf8') > MAX_AUTH_BYTES ||
        result.output.includes('\0')) throw stable('CLAUDE_OUTPUT_REJECTED')
      return { exitCode: result.exitCode, output: result.output }
    },
  })
}

export class ClaudeCodeSessionStoreError extends Error {
  constructor(public readonly code:
    | 'INVALID_STORE_PATH'
    | 'INSECURE_STORE'
    | 'CORRUPT_STORE'
    | 'INVALID_SESSION_BINDING'
    | 'OPERATION_ALREADY_CONSUMED'
    | 'SESSION_BINDING_CONFLICT'
    | 'SESSION_QUARANTINED',
  ) {
    super(code)
    this.name = 'ClaudeCodeSessionStoreError'
  }
}

export interface SqliteClaudeCodeSessionStore extends ClaudeCodeSessionStore {
  resetQuarantined(input: {
    projectId: string
    sessionId: string
    upstreamSessionId: string
  }): Promise<void>
  close(): void
}

interface SessionRow {
  project_id: string
  session_id: string
  upstream_session_id: string
  operation_id: string
  protocol_profile: string
  capability_profile: string
  cwd: string
  config_dir: string
  state: string
}

const STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const STORE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STORE_SCHEMA_VERSION = 2
const MAX_BINDINGS = 100_000
const CAPABILITY_PROFILES = new Set<ClaudeCodeCapabilityProfileKind>([
  'smoke-readonly', 'confined-native', 'aisy-bridge',
])

function validBindingPath(value: string): boolean {
  return safeAbsolute(value)
}

function validStoreInput(input: {
  projectId: string
  sessionId: string
  proposedUpstreamSessionId: string
  proposedOperationId: string
  protocolProfile: string
  capabilityProfile: ClaudeCodeCapabilityProfileKind
  cwd: string
  configDir: string
}): boolean {
  return STORE_ID.test(input.projectId) && STORE_ID.test(input.sessionId) &&
    STORE_UUID.test(input.proposedUpstreamSessionId) && STORE_UUID.test(input.proposedOperationId) &&
    input.protocolProfile === CLAUDE_CODE_PROTOCOL_PROFILE &&
    CAPABILITY_PROFILES.has(input.capabilityProfile) &&
    validBindingPath(input.cwd) && validBindingPath(input.configDir)
}

function leaseFromRow(row: SessionRow, resume: boolean): ClaudeCodeTurnLease {
  const lease = {
    projectId: row.project_id,
    sessionId: row.session_id,
    upstreamSessionId: row.upstream_session_id,
    operationId: row.operation_id,
    protocolProfile: row.protocol_profile,
    capabilityProfile: row.capability_profile,
    cwd: row.cwd,
    configDir: row.config_dir,
    resume,
  } as ClaudeCodeTurnLease
  if (!STORE_ID.test(lease.projectId) || !STORE_ID.test(lease.sessionId) ||
    !STORE_UUID.test(lease.upstreamSessionId) || !STORE_UUID.test(lease.operationId) ||
    lease.protocolProfile !== CLAUDE_CODE_PROTOCOL_PROFILE ||
    !CAPABILITY_PROFILES.has(lease.capabilityProfile) ||
    !validBindingPath(lease.cwd) || !validBindingPath(lease.configDir) ||
    !['pending', 'ready', 'quarantined'].includes(row.state)) {
    throw new ClaudeCodeSessionStoreError('CORRUPT_STORE')
  }

  return Object.freeze(lease)
}

function exactLease(row: SessionRow, lease: ClaudeCodeTurnLease): boolean {
  return row.project_id === lease.projectId && row.session_id === lease.sessionId &&
    row.upstream_session_id === lease.upstreamSessionId && row.operation_id === lease.operationId &&
    row.protocol_profile === lease.protocolProfile && row.capability_profile === lease.capabilityProfile &&
    row.cwd === lease.cwd && row.config_dir === lease.configDir
}

interface StoreColumn {
  name: string
  type: 'INTEGER' | 'TEXT'
  notnull: 0 | 1
  pk: number
}

function exactTable(db: Database.Database, name: string, expected: readonly StoreColumn[]): boolean {
  const rows = db.prepare(`PRAGMA table_info(${name})`).all() as StoreColumn[]
  return rows.length === expected.length && rows.every((row, index) => {
    const wanted = expected[index]
    return wanted !== undefined && row.name === wanted.name && row.type === wanted.type &&
      row.notnull === wanted.notnull && row.pk === wanted.pk
  })
}

function exactUniqueIndex(db: Database.Database, table: string, name: string, column: string): boolean {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string
    unique: number
    origin: string
    partial: number
  }>
  const index = indexes.find(item => item.name === name)
  if (!index || index.unique !== 1 || index.origin !== 'c' || index.partial !== 0) return false
  const columns = db.prepare(`PRAGMA index_info(${name})`).all() as Array<{
    seqno: number
    cid: number
    name: string
  }>
  return columns.length === 1 && columns[0]?.seqno === 0 && columns[0]?.name === column
}

/** Durable exact Project/Session to upstream Claude session binding. */
export function makeSqliteClaudeCodeSessionStore(input: { dbPath: string }): SqliteClaudeCodeSessionStore {
  const parent = dirname(input.dbPath)
  if (!safeAbsolute(input.dbPath) || basename(input.dbPath).length === 0 ||
    !resolve(input.dbPath).startsWith(`${resolve(parent)}/`)) {
    throw new ClaudeCodeSessionStoreError('INVALID_STORE_PATH')
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  let canonicalParent: string
  try { canonicalParent = realpathSync(parent) } catch {
    throw new ClaudeCodeSessionStoreError('INVALID_STORE_PATH')
  }
  const canonicalPath = join(canonicalParent, basename(input.dbPath))
  if (canonicalPath !== input.dbPath) throw new ClaudeCodeSessionStoreError('INVALID_STORE_PATH')
  const parentStat = lstatSync(canonicalParent)
  const parentOwnerOk = typeof process.getuid !== 'function' || parentStat.uid === process.getuid()
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !parentOwnerOk ||
    (parentStat.mode & 0o777) !== 0o700) throw new ClaudeCodeSessionStoreError('INSECURE_STORE')

  const existed = existsSync(canonicalPath)
  if (existed) {
    const stat = lstatSync(canonicalPath)
    const ownerOk = typeof process.getuid !== 'function' || stat.uid === process.getuid()
    if (!stat.isFile() || stat.isSymbolicLink() || !ownerOk || (stat.mode & 0o077) !== 0) {
      throw new ClaudeCodeSessionStoreError('INSECURE_STORE')
    }
  }

  let db: Database.Database
  try { db = new Database(canonicalPath) } catch {
    throw new ClaudeCodeSessionStoreError('CORRUPT_STORE')
  }
  try {
    if (!existed) chmodSync(canonicalPath, 0o600)
    const openedStat = lstatSync(canonicalPath)
    const openedOwnerOk = typeof process.getuid !== 'function' || openedStat.uid === process.getuid()
    if (!openedStat.isFile() || openedStat.isSymbolicLink() || !openedOwnerOk ||
      (openedStat.mode & 0o077) !== 0) throw new ClaudeCodeSessionStoreError('INSECURE_STORE')

    db.pragma('journal_mode = DELETE')
    db.pragma('synchronous = FULL')
    db.pragma('secure_delete = ON')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')

    if (!existed) {
      db.exec(`
        CREATE TABLE claude_session_control (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schema_version INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE claude_session_bindings (
          project_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          upstream_session_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          protocol_profile TEXT NOT NULL,
          capability_profile TEXT NOT NULL,
          cwd TEXT NOT NULL,
          config_dir TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'quarantined')),
          PRIMARY KEY (project_id, session_id)
        ) STRICT;
        CREATE UNIQUE INDEX claude_session_upstream_id
          ON claude_session_bindings(upstream_session_id);
        CREATE UNIQUE INDEX claude_session_operation_id
          ON claude_session_bindings(operation_id);
        CREATE TABLE claude_session_consumed_operations (
          operation_id TEXT NOT NULL PRIMARY KEY,
          project_id TEXT NOT NULL,
          session_id TEXT NOT NULL
        ) STRICT;
        INSERT INTO claude_session_control(singleton, schema_version) VALUES (1, 2);
      `)
    }

    const objects = db.prepare(
      `SELECT type, name FROM sqlite_master
       WHERE type IN ('table', 'index', 'trigger', 'view')
         AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    ).all() as Array<{ type: string; name: string }>
    if (objects.map(row => `${row.type}:${row.name}`).join(',') !==
      'index:claude_session_operation_id,index:claude_session_upstream_id,table:claude_session_bindings,table:claude_session_consumed_operations,table:claude_session_control') {
      throw new ClaudeCodeSessionStoreError('CORRUPT_STORE')
    }
    if (!exactTable(db, 'claude_session_control', [
      { name: 'singleton', type: 'INTEGER', notnull: 0, pk: 1 },
      { name: 'schema_version', type: 'INTEGER', notnull: 1, pk: 0 },
    ]) || !exactTable(db, 'claude_session_bindings', [
      { name: 'project_id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'session_id', type: 'TEXT', notnull: 1, pk: 2 },
      { name: 'upstream_session_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'operation_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'protocol_profile', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'capability_profile', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'cwd', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'config_dir', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
    ]) || !exactTable(db, 'claude_session_consumed_operations', [
      { name: 'operation_id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'session_id', type: 'TEXT', notnull: 1, pk: 0 },
    ]) || !exactUniqueIndex(
      db, 'claude_session_bindings', 'claude_session_upstream_id', 'upstream_session_id',
    ) || !exactUniqueIndex(
      db, 'claude_session_bindings', 'claude_session_operation_id', 'operation_id',
    )) throw new ClaudeCodeSessionStoreError('CORRUPT_STORE')
    const control = db.prepare(
      'SELECT schema_version FROM claude_session_control WHERE singleton = 1',
    ).get() as { schema_version: number } | undefined
    if (control?.schema_version !== STORE_SCHEMA_VERSION ||
      db.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new ClaudeCodeSessionStoreError('CORRUPT_STORE')
    }
    const rows = db.prepare(
      `SELECT project_id, session_id, upstream_session_id, operation_id, protocol_profile,
              capability_profile, cwd, config_dir, state
       FROM claude_session_bindings LIMIT ?`,
    ).all(MAX_BINDINGS + 1) as SessionRow[]
    if (rows.length > MAX_BINDINGS) throw new ClaudeCodeSessionStoreError('CORRUPT_STORE')
    for (const row of rows) leaseFromRow(row, row.state === 'ready')
    const consumed = db.prepare(
      'SELECT operation_id, project_id, session_id FROM claude_session_consumed_operations LIMIT ?',
    ).all(MAX_BINDINGS + 1) as Array<{ operation_id: string; project_id: string; session_id: string }>
    if (consumed.length > MAX_BINDINGS || consumed.some(row =>
      !STORE_UUID.test(row.operation_id) || !STORE_ID.test(row.project_id) || !STORE_ID.test(row.session_id))) {
      throw new ClaudeCodeSessionStoreError('CORRUPT_STORE')
    }
    db.prepare("UPDATE claude_session_bindings SET state = 'quarantined' WHERE state = 'pending'").run()
  } catch (error) {
    db.close()
    if (error instanceof ClaudeCodeSessionStoreError) throw error
    throw new ClaudeCodeSessionStoreError('CORRUPT_STORE')
  }

  const select = db.prepare(
    `SELECT project_id, session_id, upstream_session_id, operation_id, protocol_profile,
            capability_profile, cwd, config_dir, state
     FROM claude_session_bindings WHERE project_id = ? AND session_id = ?`,
  )
  const insert = db.prepare(
    `INSERT INTO claude_session_bindings(
       project_id, session_id, upstream_session_id, operation_id, protocol_profile,
       capability_profile, cwd, config_dir, state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  )
  const markPending = db.prepare(
    `UPDATE claude_session_bindings SET operation_id = ?, state = 'pending'
     WHERE project_id = ? AND session_id = ? AND state = 'ready'`,
  )
  const markReady = db.prepare(
    `UPDATE claude_session_bindings SET state = 'ready'
     WHERE project_id = ? AND session_id = ? AND upstream_session_id = ?
       AND operation_id = ? AND state = 'pending'`,
  )
  const markQuarantined = db.prepare(
    `UPDATE claude_session_bindings SET state = 'quarantined'
     WHERE project_id = ? AND session_id = ? AND upstream_session_id = ?
       AND operation_id = ? AND state = 'pending'`,
  )
  const removeQuarantined = db.prepare(
    `DELETE FROM claude_session_bindings
     WHERE project_id = ? AND session_id = ? AND upstream_session_id = ?
       AND state = 'quarantined'`,
  )
  const consumedOperation = db.prepare(
    'SELECT operation_id FROM claude_session_consumed_operations WHERE operation_id = ?',
  )
  const insertConsumedOperation = db.prepare(
    `INSERT INTO claude_session_consumed_operations(operation_id, project_id, session_id)
     VALUES (?, ?, ?)`,
  )

  const store: SqliteClaudeCodeSessionStore = {
    async beginTurn(value) {
      if (!validStoreInput(value)) throw new ClaudeCodeSessionStoreError('INVALID_SESSION_BINDING')
      try {
        const result = db.transaction((): ClaudeCodeTurnLease | null => {
          if (consumedOperation.get(value.proposedOperationId)) {
            throw new ClaudeCodeSessionStoreError('OPERATION_ALREADY_CONSUMED')
          }
          const current = select.get(value.projectId, value.sessionId) as SessionRow | undefined
          if (!current) {
            insert.run(
              value.projectId, value.sessionId, value.proposedUpstreamSessionId,
              value.proposedOperationId, value.protocolProfile, value.capabilityProfile,
              value.cwd, value.configDir,
            )
            return Object.freeze<ClaudeCodeTurnLease>({
              projectId: value.projectId,
              sessionId: value.sessionId,
              upstreamSessionId: value.proposedUpstreamSessionId,
              operationId: value.proposedOperationId,
              protocolProfile: value.protocolProfile,
              capabilityProfile: value.capabilityProfile,
              cwd: value.cwd,
              configDir: value.configDir,
              resume: false,
            })
          }
          leaseFromRow(current, current.state === 'ready')
          if (current.protocol_profile !== value.protocolProfile ||
            current.capability_profile !== value.capabilityProfile || current.cwd !== value.cwd ||
            current.config_dir !== value.configDir) {
            throw new ClaudeCodeSessionStoreError('SESSION_BINDING_CONFLICT')
          }
          if (current.state === 'pending') {
            db.prepare(
              "UPDATE claude_session_bindings SET state = 'quarantined' WHERE project_id = ? AND session_id = ?",
            ).run(value.projectId, value.sessionId)
            return null
          }
          if (current.state === 'quarantined') {
            throw new ClaudeCodeSessionStoreError('SESSION_QUARANTINED')
          }
          const updated = markPending.run(value.proposedOperationId, value.projectId, value.sessionId)
          if (updated.changes !== 1) throw new ClaudeCodeSessionStoreError('CORRUPT_STORE')
          return Object.freeze<ClaudeCodeTurnLease>({
            projectId: current.project_id,
            sessionId: current.session_id,
            upstreamSessionId: current.upstream_session_id,
            operationId: value.proposedOperationId,
            protocolProfile: value.protocolProfile,
            capabilityProfile: value.capabilityProfile,
            cwd: value.cwd,
            configDir: value.configDir,
            resume: true,
          })
        }).immediate()
        if (result === null) throw new ClaudeCodeSessionStoreError('SESSION_QUARANTINED')
        return result
      } catch (error) {
        if (error instanceof ClaudeCodeSessionStoreError) throw error
        throw new ClaudeCodeSessionStoreError('CORRUPT_STORE')
      }
    },

    async completeTurn(lease) {
      try {
        db.transaction(() => {
          const row = select.get(lease.projectId, lease.sessionId) as SessionRow | undefined
          if (!row || !exactLease(row, lease) || row.state !== 'pending') {
            throw new ClaudeCodeSessionStoreError('SESSION_BINDING_CONFLICT')
          }
          if (consumedOperation.get(lease.operationId)) {
            throw new ClaudeCodeSessionStoreError('OPERATION_ALREADY_CONSUMED')
          }
          insertConsumedOperation.run(lease.operationId, lease.projectId, lease.sessionId)
          if (markReady.run(
            lease.projectId, lease.sessionId, lease.upstreamSessionId, lease.operationId,
          ).changes !== 1) throw new ClaudeCodeSessionStoreError('SESSION_BINDING_CONFLICT')
        }).immediate()
      } catch (error) {
        if (error instanceof ClaudeCodeSessionStoreError) throw error
        throw new ClaudeCodeSessionStoreError('CORRUPT_STORE')
      }
    },

    async quarantineTurn(lease) {
      const row = select.get(lease.projectId, lease.sessionId) as SessionRow | undefined
      if (!row || !exactLease(row, lease) || row.state !== 'pending' ||
        markQuarantined.run(lease.projectId, lease.sessionId, lease.upstreamSessionId, lease.operationId).changes !== 1) {
        throw new ClaudeCodeSessionStoreError('SESSION_BINDING_CONFLICT')
      }
    },

    async resetQuarantined(value) {
      if (!STORE_ID.test(value.projectId) || !STORE_ID.test(value.sessionId) ||
        !STORE_UUID.test(value.upstreamSessionId) ||
        removeQuarantined.run(value.projectId, value.sessionId, value.upstreamSessionId).changes !== 1) {
        throw new ClaudeCodeSessionStoreError('SESSION_BINDING_CONFLICT')
      }
    },

    close() { db.close() },
  }
  return Object.freeze(store)
}
