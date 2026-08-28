import { randomBytes } from 'node:crypto'
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { appendFileSync } from 'node:fs'

import {
  makeExecutionParentSupervisor,
  sleepExecutionSupervisorDelay,
  type ExecutionSupervisorChildProcess,
  type ExecutionSupervisorChildSpawn,
  type ExecutionSupervisorSpawnPort,
} from '../src/execution-parent-supervisor.ts'
import { makeNodeExecutionSupervisorChildChannel } from '../src/execution-supervisor-ipc.ts'
import { makeNodeExecutionSupervisorStateStore } from '../src/supervisor-state.ts'

const stateRoot = process.env['AISY_SUPERVISOR_FIXTURE_STATE_ROOT']
const childFixture = process.env['AISY_SUPERVISOR_FIXTURE_CHILD']
const sourceLoader = process.env['AISY_SUPERVISOR_FIXTURE_LOADER']
const tracePath = process.env['AISY_SUPERVISOR_FIXTURE_TRACE']
if (stateRoot === undefined || stateRoot === '' || childFixture === undefined || childFixture === '' ||
  sourceLoader === undefined || sourceLoader === '' || tracePath === undefined || tracePath === '') process.exit(97)

function trace(event: string): void {
  appendFileSync(tracePath!, `${Date.now()} ${event} ${process.pid}\n`, { mode: 0o600 })
}

function opaque(): string {
  return randomBytes(32).toString('base64url')
}

let spawned = 0
const spawn: ExecutionSupervisorSpawnPort = {
  spawn(input: ExecutionSupervisorChildSpawn): ExecutionSupervisorChildProcess {
    spawned += 1
    if (spawned > 2) throw new Error('fixture child spawn cap exceeded')
    const child: ChildProcess = spawnProcess(input.execPath, [input.binPath, ...input.args], {
      env: { ...input.env },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    trace(`manager-spawn-${spawned}`)
    const started = new Promise<{ kind: 'spawned' } | { kind: 'spawn-failed' }>((resolve) => {
      let didSpawn = false
      child.once('spawn', () => {
        didSpawn = true
        trace(`manager-child-pid-${child.pid ?? 0}`)
        resolve({ kind: 'spawned' })
      })
      child.once('error', () => { if (!didSpawn) resolve({ kind: 'spawn-failed' }) })
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => {
        trace(`manager-child-exit-${spawned}`)
        resolve({ code, signal: signal as NodeJS.Signals | null })
      })
    })
    return {
      instanceId: opaque(),
      channel: makeNodeExecutionSupervisorChildChannel(child),
      started,
      exited,
      terminate(signal) { try { child.kill(signal) } catch { /* exit observation is authoritative */ } },
    }
  },
}

const childEnv: Record<string, string> = {}
for (const name of [
  'TMPDIR',
  'AISY_SUPERVISOR_FIXTURE_STATE_ROOT',
  'AISY_SUPERVISOR_FIXTURE_MODE',
  'AISY_SUPERVISOR_FIXTURE_MARKER',
  'AISY_SUPERVISOR_FIXTURE_TRACE',
  'AISY_SUPERVISOR_FIXTURE_EXTERNAL',
  'AISY_SUPERVISOR_FIXTURE_PRE_HELLO_MS',
  'AISY_SUPERVISOR_FIXTURE_ORPHAN_HOLD_MS',
  'AISY_SUPERVISOR_FIXTURE_CHECKPOINT',
  'AISY_SUPERVISOR_FIXTURE_RESULT',
  'AISY_SUPERVISOR_FIXTURE_STAGE',
]) {
  const value = process.env[name]
  if (value !== undefined) childEnv[name] = value
}

const controller = new AbortController()
process.on('SIGTERM', () => controller.abort())
process.on('SIGINT', () => controller.abort())

const supervisor = makeExecutionParentSupervisor({
  execPath: process.execPath,
  binPath: '--experimental-strip-types',
  childArgs: ['--disable-warning=ExperimentalWarning', '--experimental-loader', sourceLoader, childFixture],
  childEnv,
  spawn,
  state: makeNodeExecutionSupervisorStateStore({ root: stateRoot }),
  nowMs: () => Date.now(),
  newId: opaque,
  randomNonce: opaque,
  sleep: sleepExecutionSupervisorDelay,
  handshakeTimeoutMs: 15_000,
  stopTimeoutMs: 2_000,
})

trace('manager-start')
const statusTimer = process.env['AISY_SUPERVISOR_FIXTURE_NO_STATUS_TIMER'] === '1'
  ? null
  : setInterval(() => {
      const status = supervisor.status()
      if (status.phase === 'running') trace('manager-running')
      if (status.phase === 'quarantined') trace(`manager-quarantined-${status.quarantineCode ?? 'unknown'}`)
    }, 25)
try {
  const result = await supervisor.run(controller.signal)
  trace(`manager-result-${result.kind}`)
} finally {
  if (statusTimer !== null) clearInterval(statusTimer)
}
