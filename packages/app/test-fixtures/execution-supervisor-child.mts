import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'

import {
  EXECUTION_SUPERVISOR_SELECTOR_ENV,
  establishExecutionSupervisorStartupBarrier,
  makeNodeExecutionSupervisorChildChannel,
} from '../src/execution-supervisor-ipc.ts'
import {
  EXECUTION_SUPERVISOR_LIVENESS_ENV,
  acquireExecutionRunLiveness,
  decodeExecutionSupervisorChildLivenessDescriptor,
} from '../src/execution-supervisor-liveness.ts'

const mode = process.env['AISY_SUPERVISOR_FIXTURE_MODE'] ?? 'healthy'
const tracePath = process.env['AISY_SUPERVISOR_FIXTURE_TRACE']
const externalPath = process.env['AISY_SUPERVISOR_FIXTURE_EXTERNAL']

function trace(event: string): void {
  if (tracePath !== undefined && tracePath !== '') {
    appendFileSync(tracePath, `${Date.now()} ${event} ${process.pid}\n`, { mode: 0o600 })
  }
}

function external(): void {
  if (externalPath !== undefined && externalPath !== '') {
    appendFileSync(externalPath, `external ${process.pid}\n`, { mode: 0o600 })
  }
  trace('external')
}

const selected = process.env[EXECUTION_SUPERVISOR_SELECTOR_ENV] === '1'
let runtimeLease
try {
  const stateRoot = process.env['AISY_SUPERVISOR_FIXTURE_STATE_ROOT']
  if (stateRoot === undefined || stateRoot === '') throw new Error('missing state root')
  if (selected) {
    const raw = process.env[EXECUTION_SUPERVISOR_LIVENESS_ENV]
    if (raw === undefined) throw new Error('missing liveness descriptor')
    delete process.env[EXECUTION_SUPERVISOR_LIVENESS_ENV]
    const descriptor = decodeExecutionSupervisorChildLivenessDescriptor(raw)
    runtimeLease = acquireExecutionRunLiveness({
      stateRoot,
      supervisedDescriptor: descriptor,
    })
  } else {
    runtimeLease = acquireExecutionRunLiveness({ stateRoot })
  }
} catch (error) {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown'
  trace(`${selected ? 'liveness-refused' : 'direct-refused'}-${code}`)
  process.exit(81)
}

const closeAndExit = (code: number): never => {
  try { runtimeLease.release() } catch { /* process exit remains authoritative */ }
  trace('child-exit')
  process.exit(code)
}
runtimeLease.onLost(() => closeAndExit(83))
trace('liveness-acquired')
process.on('SIGTERM', () => closeAndExit(0))

if (!selected) {
  external()
  trace('direct-ready')
  setInterval(() => undefined, 1_000)
  await new Promise<never>(() => undefined)
}

const preHelloDelayMs = Number(process.env['AISY_SUPERVISOR_FIXTURE_PRE_HELLO_MS'] ?? '0')
if (Number.isSafeInteger(preHelloDelayMs) && preHelloDelayMs > 0) {
  trace('pre-hello-wait')
  await new Promise((resolve) => setTimeout(resolve, preHelloDelayMs))
}

const channel = process.connected === true && typeof process.send === 'function'
  ? makeNodeExecutionSupervisorChildChannel(process as never)
  : null

let session
try {
  session = await establishExecutionSupervisorStartupBarrier({
    selected: true,
    channel,
    newRequestId: () => randomUUID(),
    randomNonce: () => randomBytes(32).toString('base64url'),
    nowMs: () => Date.now(),
    livenessDescriptorHash: runtimeLease.descriptorHash,
    timeoutMs: 10_000,
  })
} catch {
  closeAndExit(91)
}

if (session === null) closeAndExit(92)
session.onLost(() => {
  const delayMs = Number(process.env['AISY_SUPERVISOR_FIXTURE_ORPHAN_HOLD_MS'] ?? '0')
  trace('authority-lost')
  if (Number.isSafeInteger(delayMs) && delayMs > 0) {
    setTimeout(() => closeAndExit(93), delayMs)
  } else closeAndExit(93)
})

if (session.recoveryLease !== null) closeAndExit(92)

const authorizeAndExit = async (): Promise<never> => {
  const intentHash = createHash('sha256').update('real-process-planned-restart').digest('hex')
  await session.authorizePlannedRestart(intentHash)
  return closeAndExit(75)
}

if (mode === 'planned') await authorizeAndExit()
if (mode === 'planned-once') {
  const marker = process.env['AISY_SUPERVISOR_FIXTURE_MARKER']
  if (typeof marker !== 'string' || marker === '') closeAndExit(94)
  try {
    writeFileSync(marker, 'planned\n', { flag: 'wx', mode: 0o600 })
    await authorizeAndExit()
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
  }
}
if (mode === 'crash') closeAndExit(1)

external()
trace('supervised-ready')
setInterval(() => undefined, 1_000)
await new Promise<never>(() => undefined)
