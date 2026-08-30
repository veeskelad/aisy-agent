import { randomBytes } from 'node:crypto'
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  makeExecutionParentSupervisor,
  makeNodeExecutionSupervisorSpawnPort,
  type ExecutionSupervisorSpawnPort,
} from './execution-parent-supervisor.js'
import { makeNodeExecutionSupervisorStateStore } from './supervisor-state.js'

const roots: string[] = []
const traceFiles: string[] = []
const processes = new Set<ChildProcess>()

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-execution-recovery-e2e-'))
  roots.push(value)
  return value
}

function opaque(): string {
  return randomBytes(32).toString('base64url')
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('fixture timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function lines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('process exit timeout')), timeoutMs)),
  ])
}

afterEach(async () => {
  const tracked = [...processes]
  const pids = new Set<number>()
  for (const trace of traceFiles.splice(0)) {
    for (const line of lines(trace)) {
      const pid = Number(line.split(' ').at(-1))
      if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) pids.add(pid)
    }
  }
  for (const child of processes) { try { child.kill('SIGTERM') } catch { /* already gone */ } }
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } }
  await Promise.race([
    Promise.all(tracked.map((child) => waitExit(child, 250).catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, 300)),
  ])
  for (const child of processes) { try { child.kill('SIGKILL') } catch { /* already gone */ } }
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
  await Promise.race([
    Promise.all(tracked.map((child) => waitExit(child, 1_500).catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, 1_600)),
  ])
  await waitUntil(() => [...pids].every((pid) => !alive(pid)), 1_500).catch(() => undefined)
  processes.clear()
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('Telegram execution recovery through a real parent and child', () => {
  it.each([
    {
      stage: 'captured-missing',
      authorityPhase: 'captured-unbound',
      result: { kind: 'none' },
      checkpoint: { status: 'missing' },
    },
    {
      stage: 'prepared',
      authorityPhase: 'captured-unbound',
      result: { kind: 'recovered', delivery: 'replacement-sent', messageId: 102 },
      checkpoint: { phase: 'terminal', delivery: 'delivered' },
    },
    {
      stage: 'bound',
      authorityPhase: 'checkpoint-bound',
      result: { kind: 'recovered', delivery: 'edited', messageId: 101 },
      checkpoint: { phase: 'terminal', delivery: 'delivered' },
    },
    {
      stage: 'terminal-pending',
      authorityPhase: 'checkpoint-bound',
      result: { kind: 'recovered', delivery: 'edited', messageId: 101 },
      checkpoint: { phase: 'terminal', delivery: 'delivered' },
    },
    {
      stage: 'terminal-delivered',
      authorityPhase: 'checkpoint-bound',
      result: { kind: 'none' },
      checkpoint: { phase: 'terminal', delivery: 'delivered' },
    },
  ])('recovers $stage after SIGKILL with exact two-phase authority', async ({
    stage,
    authorityPhase,
    result,
    checkpoint,
  }) => {
    if (process.platform === 'win32') return
    const directory = root()
    const stateRoot = join(directory, 'manager')
    const checkpointPath = join(directory, 'runtime', 'execution-card.json')
    const resultMarker = join(directory, 'recovery-result.json')
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'test-fixtures',
      'telegram-execution-recovery-child.mts',
    )
    const sourceLoader = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'test-fixtures',
      'typescript-source-loader.mjs',
    )
    const node = makeNodeExecutionSupervisorSpawnPort()
    let count = 0
    const spawn: ExecutionSupervisorSpawnPort = {
      spawn(input) {
        if (count >= 2) throw new Error('fixture child spawn cap exceeded')
        count += 1
        return node.spawn(input)
      },
    }
    const controller = new AbortController()
    const supervisor = makeExecutionParentSupervisor({
      execPath: process.execPath,
      binPath: '--experimental-strip-types',
      childArgs: [
        '--disable-warning=ExperimentalWarning',
        '--experimental-loader', sourceLoader,
        fixture,
      ],
      childEnv: {
        TMPDIR: tmpdir(),
        AISY_SUPERVISOR_FIXTURE_STATE_ROOT: stateRoot,
        AISY_SUPERVISOR_FIXTURE_MODE: `recovery-${stage}`,
        AISY_SUPERVISOR_FIXTURE_CHECKPOINT: checkpointPath,
        AISY_SUPERVISOR_FIXTURE_RESULT: resultMarker,
      },
      spawn,
      state: makeNodeExecutionSupervisorStateStore({ root: stateRoot }),
      nowMs: () => Date.now(),
      newId: opaque,
      randomNonce: opaque,
      sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 10)) },
      // The source-loader fixture imports the full checkpoint/stream graph
      // before it begins the barrier; CI cold starts can exceed the production
      // child's already-running 2s handshake default.
      handshakeTimeoutMs: 10_000,
    })

    const run = supervisor.run(controller.signal)
    let observed: unknown
    let runResult: Awaited<typeof run> | null = null
    try {
      await waitUntil(() => existsSync(resultMarker) && count === 2 &&
        supervisor.status().phase === 'running')
      observed = JSON.parse(readFileSync(resultMarker, 'utf8')) as unknown
    } finally {
      controller.abort()
      runResult = await run
    }

    expect(runResult).toEqual({ kind: 'stopped' })
    expect(observed).toEqual({
      result,
      recoveryAuthorityPhase: authorityPhase,
      checkpoint,
    })
    expect(count).toBe(2)
  }, 20_000)

  it.each([
    {
      stage: 'captured-unbound',
      result: { kind: 'none' },
      checkpoint: { status: 'missing' },
      externalCount: 0,
    },
    {
      stage: 'checkpoint-bound',
      result: { kind: 'recovered', delivery: 'replacement-sent', messageId: 102 },
      checkpoint: { phase: 'terminal', delivery: 'delivered' },
      externalCount: 1,
    },
    {
      stage: 'terminal-pending',
      result: { kind: 'recovered', delivery: 'edited', messageId: 101 },
      checkpoint: { phase: 'terminal', delivery: 'delivered' },
      externalCount: 3,
    },
    {
      stage: 'terminal-delivered',
      result: { kind: 'none' },
      checkpoint: { phase: 'terminal', delivery: 'delivered' },
      externalCount: 2,
    },
  ])('recovers $stage after manager SIGKILL only after its child loses liveness', async ({
    stage,
    result,
    checkpoint,
    externalCount,
  }) => {
    if (process.platform === 'win32') return
    const directory = root()
    const stateRoot = join(directory, 'manager')
    const checkpointPath = join(directory, 'runtime', 'execution-card.json')
    const resultMarker = join(directory, 'recovery-result.json')
    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    traceFiles.push(trace)
    const recoveryFixture = join(
      dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures',
      'telegram-execution-recovery-child.mts',
    )
    const managerFixture = join(
      dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures',
      'execution-supervisor-manager.mts',
    )
    const sourceLoader = join(
      dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures',
      'typescript-source-loader.mjs',
    )
    const manager = spawnProcess(process.execPath, [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--experimental-loader', sourceLoader,
      managerFixture,
    ], {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        TMPDIR: tmpdir(),
        TZ: process.env['TZ'] ?? 'UTC',
        AISY_SUPERVISOR_FIXTURE_STATE_ROOT: stateRoot,
        AISY_SUPERVISOR_FIXTURE_CHILD: recoveryFixture,
        AISY_SUPERVISOR_FIXTURE_LOADER: sourceLoader,
        AISY_SUPERVISOR_FIXTURE_TRACE: trace,
        AISY_SUPERVISOR_FIXTURE_EXTERNAL: external,
        AISY_SUPERVISOR_FIXTURE_MODE: 'manager-recovery',
        AISY_SUPERVISOR_FIXTURE_STAGE: stage,
        AISY_SUPERVISOR_FIXTURE_CHECKPOINT: checkpointPath,
        AISY_SUPERVISOR_FIXTURE_RESULT: resultMarker,
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    processes.add(manager)
    manager.once('exit', () => processes.delete(manager))
    await waitUntil(() => lines(trace).some((line) => line.includes(` stage-${stage} `)))
    const stageLine = lines(trace).find((line) => line.includes(` stage-${stage} `))!
    const oldChildPid = Number(stageLine.split(' ').at(-1))
    expect(alive(oldChildPid)).toBe(true)
    manager.kill('SIGKILL')
    await waitExit(manager)

    const node = makeNodeExecutionSupervisorSpawnPort()
    let count = 0
    const spawn: ExecutionSupervisorSpawnPort = {
      spawn(input) {
        if (count >= 1) throw new Error('fixture replacement spawn cap exceeded')
        expect(alive(oldChildPid)).toBe(false)
        count += 1
        return node.spawn(input)
      },
    }
    const controller = new AbortController()
    const supervisor = makeExecutionParentSupervisor({
      execPath: process.execPath,
      binPath: '--experimental-strip-types',
      childArgs: [
        '--disable-warning=ExperimentalWarning',
        '--experimental-loader', sourceLoader,
        recoveryFixture,
      ],
      childEnv: {
        TMPDIR: tmpdir(),
        AISY_SUPERVISOR_FIXTURE_STATE_ROOT: stateRoot,
        AISY_SUPERVISOR_FIXTURE_MODE: 'manager-recovery',
        AISY_SUPERVISOR_FIXTURE_STAGE: stage,
        AISY_SUPERVISOR_FIXTURE_TRACE: trace,
        AISY_SUPERVISOR_FIXTURE_EXTERNAL: external,
        AISY_SUPERVISOR_FIXTURE_CHECKPOINT: checkpointPath,
        AISY_SUPERVISOR_FIXTURE_RESULT: resultMarker,
      },
      spawn,
      state: makeNodeExecutionSupervisorStateStore({ root: stateRoot }),
      nowMs: () => Date.now(),
      newId: opaque,
      randomNonce: opaque,
      sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 10)) },
      handshakeTimeoutMs: 15_000,
      stopTimeoutMs: 2_000,
    })
    const run = supervisor.run(controller.signal)
    let observed: unknown
    let runResult: Awaited<typeof run> | null = null
    try {
      await waitUntil(() => existsSync(resultMarker) && count === 1 &&
        supervisor.status().phase === 'running')
      observed = JSON.parse(readFileSync(resultMarker, 'utf8')) as unknown
    } finally {
      controller.abort()
      runResult = await run
    }
    expect(runResult).toEqual({ kind: 'stopped' })
    expect(observed).toEqual({
      result,
      recoveryAuthorityPhase: stage === 'captured-unbound' ? 'captured-unbound' : 'checkpoint-bound',
      checkpoint,
    })
    expect(count).toBe(1)
    expect(lines(external)).toHaveLength(externalCount)
  }, 30_000)
})
