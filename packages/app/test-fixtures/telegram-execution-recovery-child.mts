import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, linkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

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
import {
  makeNodeTelegramExecutionCheckpointStore,
  makeTelegramExecutionBindingHash,
} from '../src/telegram-execution-checkpoint.ts'
import { recoverTelegramExecutionAtStartup } from '../src/telegram-execution-startup-recovery.ts'
import { makeTelegramExecutionStream } from '../src/telegram-execution-stream.ts'

const mode = process.env['AISY_SUPERVISOR_FIXTURE_MODE'] ?? ''
const checkpointPath = process.env['AISY_SUPERVISOR_FIXTURE_CHECKPOINT']
const resultMarker = process.env['AISY_SUPERVISOR_FIXTURE_RESULT']
const managerStage = process.env['AISY_SUPERVISOR_FIXTURE_STAGE']
const tracePath = process.env['AISY_SUPERVISOR_FIXTURE_TRACE']
const externalPath = process.env['AISY_SUPERVISOR_FIXTURE_EXTERNAL']
if ((!mode.startsWith('recovery-') && mode !== 'manager-recovery') ||
  typeof checkpointPath !== 'string' || checkpointPath === '' ||
  typeof resultMarker !== 'string' || resultMarker === '') process.exit(95)

function trace(event: string): void {
  if (tracePath !== undefined && tracePath !== '') {
    appendFileSync(tracePath, `${Date.now()} ${event} ${process.pid}\n`, { mode: 0o600 })
  }
}

function external(event: string): void {
  if (externalPath !== undefined && externalPath !== '') {
    appendFileSync(externalPath, `${event} ${process.pid}\n`, { mode: 0o600 })
  }
  trace(event)
}

function publishResultMarker(path: string, payload: string): void {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let failure: unknown
  try {
    // `writeFileSync(path, { flag: "wx" })` exposes the destination before its
    // payload is complete. A private same-directory inode is filled first;
    // link is the portable no-clobber publication primitive (unlike rename,
    // which would overwrite an existing marker).
    writeFileSync(temporary, payload, { flag: 'wx', mode: 0o600 })
    linkSync(temporary, path)
  } catch (error) {
    failure = error
  }
  try {
    unlinkSync(temporary)
  } catch (error) {
    const details = error as NodeJS.ErrnoException
    if (details.code !== 'ENOENT' && failure === undefined) failure = error
  }
  if (failure !== undefined) throw failure
}

async function pauseAt(stage: string): Promise<void> {
  if (mode !== 'manager-recovery' || managerStage !== stage) return
  trace(`stage-${stage}`)
  await new Promise<never>(() => undefined)
}

process.on('SIGTERM', () => process.exit(0))
const selected = process.env[EXECUTION_SUPERVISOR_SELECTOR_ENV] === '1'
const rawDescriptor = process.env[EXECUTION_SUPERVISOR_LIVENESS_ENV]
const stateRoot = process.env['AISY_SUPERVISOR_FIXTURE_STATE_ROOT']
if (!selected || rawDescriptor === undefined || stateRoot === undefined || stateRoot === '') process.exit(90)
delete process.env[EXECUTION_SUPERVISOR_LIVENESS_ENV]
const descriptor = decodeExecutionSupervisorChildLivenessDescriptor(rawDescriptor)
const runtimeLease = acquireExecutionRunLiveness({
  stateRoot,
  supervisedDescriptor: descriptor,
})
runtimeLease.onLost(() => process.exit(83))
trace('liveness-acquired')
const channel = selected && process.connected === true && typeof process.send === 'function'
  ? makeNodeExecutionSupervisorChildChannel(process as never)
  : null
const session = await establishExecutionSupervisorStartupBarrier({
  selected,
  channel,
  newRequestId: () => randomUUID(),
  randomNonce: () => randomBytes(32).toString('base64url'),
  nowMs: () => Date.now(),
  livenessDescriptorHash: runtimeLease.descriptorHash,
  timeoutMs: 10_000,
})
if (session === null) process.exit(92)
session.onLost(() => process.exit(93))

const store = makeNodeTelegramExecutionCheckpointStore({ path: checkpointPath })
if (session.recoveryLease !== null) {
  const recoveryLease = session.recoveryLease
  let acquired = false
  const result = await recoverTelegramExecutionAtStartup({
    store,
    serviceManager: {
      async acquireRecoveryLease() {
        if (acquired) return null
        acquired = true
        return recoveryLease
      },
    },
    output: {
      async sendText() { external('telegram-send'); return 102 },
      async editText() { external('telegram-edit') },
    },
    newOwnerId: () => 'fixture-recovery-owner',
    nowIso: () => '2026-07-29T12:10:00.000Z',
  })
  const loaded = store.load()
  publishResultMarker(resultMarker, JSON.stringify({
    result,
    recoveryAuthorityPhase: recoveryLease.authorityPhase,
    checkpoint: loaded.status === 'ready'
      ? { phase: loaded.checkpoint.phase, delivery: loaded.checkpoint.delivery }
      : { status: loaded.status },
  }) + '\n')
  setInterval(() => undefined, 1_000)
  await new Promise<never>(() => undefined)
}

const bindingHash = makeTelegramExecutionBindingHash({
  chatId: 42,
  sessionId: 'fixture-session',
  turnId: 'telegram:42:fixture-turn',
})
const lease = await session.captureTurn(bindingHash)
if (mode === 'recovery-captured-missing') process.kill(process.pid, 'SIGKILL')
await pauseAt('captured-unbound')

const terminalEditFails = mode === 'recovery-terminal-pending' ||
  (mode === 'manager-recovery' && managerStage === 'terminal-pending')
const stream = makeTelegramExecutionStream({
  sessionId: 'fixture-session',
  signal: new AbortController().signal,
  editIntervalMs: 0,
  checkpoint: {
    store,
    bindingHash,
    ownerId: 'fixture-crashed-owner',
    nowIso: () => '2026-07-29T12:00:00.000Z',
    assertAuthorityHeld: () => lease.isHeld(),
  },
  output: {
    async sendText() { external('telegram-send'); return 101 },
    async editText() {
      external('telegram-edit')
      if (terminalEditFails) throw new Error('fixture terminal edit failure')
    },
  },
})
await stream.prepare()
if (mode === 'recovery-prepared') process.kill(process.pid, 'SIGKILL')
await lease.bindCheckpoint()
await pauseAt('checkpoint-bound')
await stream.start()
if (mode === 'recovery-bound') process.kill(process.pid, 'SIGKILL')
try {
  await stream.complete({ state: 'ok', reply: 'not-persisted', narrowed: false })
} catch {
  if (!terminalEditFails) throw new Error('unexpected fixture stream failure')
}
await pauseAt(terminalEditFails ? 'terminal-pending' : 'terminal-delivered')
if (mode === 'recovery-terminal-pending' || mode === 'recovery-terminal-delivered') {
  process.kill(process.pid, 'SIGKILL')
}
process.exit(96)
