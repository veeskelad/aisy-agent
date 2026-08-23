import { randomBytes } from 'node:crypto'
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  makeExecutionParentSupervisor,
  makeNodeExecutionSupervisorSpawnPort,
  type ExecutionSupervisorSpawnPort,
} from './execution-parent-supervisor.js'
import { makeNodeExecutionSupervisorStateStore, type ExecutionSupervisorStateStore } from './supervisor-state.js'

const roots: string[] = []
const traces: string[] = []
const processes = new Set<ChildProcess>()

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-parent-supervisor-e2e-'))
  roots.push(value)
  return value
}

function fixture(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', name)
}

function opaque(): string {
  return randomBytes(32).toString('base64url')
}

function lines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
}

function eventCount(path: string, event: string): number {
  return lines(path).filter((line) => line.includes(` ${event} `)).length
}

function eventPid(path: string, event: string, occurrence = 0): number {
  const line = lines(path).filter((entry) => entry.includes(` ${event} `))[occurrence]
  if (line === undefined) throw new Error(`missing fixture event: ${event}`)
  const value = Number(line.split(' ').at(-1))
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`bad fixture pid: ${line}`)
  return value
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('fixture timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('process exit timeout')), timeoutMs)),
  ])
}

function startFixture(path: string, env: Record<string, string>): ChildProcess {
  const child = spawnProcess(process.execPath, [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    '--experimental-loader', fixture('typescript-source-loader.mjs'),
    path,
  ], {
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      TMPDIR: tmpdir(),
      TZ: process.env['TZ'] ?? 'UTC',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  processes.add(child)
  child.once('exit', () => processes.delete(child))
  return child
}

function startManager(input: {
  stateRoot: string
  trace: string
  external: string
  mode?: string
  child?: string
  extra?: Record<string, string>
}): ChildProcess {
  traces.push(input.trace)
  return startFixture(fixture('execution-supervisor-manager.mts'), {
    AISY_SUPERVISOR_FIXTURE_STATE_ROOT: input.stateRoot,
    AISY_SUPERVISOR_FIXTURE_CHILD: input.child ?? fixture('execution-supervisor-child.mts'),
    AISY_SUPERVISOR_FIXTURE_LOADER: fixture('typescript-source-loader.mjs'),
    AISY_SUPERVISOR_FIXTURE_TRACE: input.trace,
    AISY_SUPERVISOR_FIXTURE_EXTERNAL: input.external,
    AISY_SUPERVISOR_FIXTURE_MODE: input.mode ?? 'healthy',
    ...input.extra,
  })
}

function startDirect(input: { stateRoot: string; trace: string; external: string }): ChildProcess {
  traces.push(input.trace)
  return startFixture(fixture('execution-supervisor-child.mts'), {
    AISY_SUPERVISOR_FIXTURE_STATE_ROOT: input.stateRoot,
    AISY_SUPERVISOR_FIXTURE_TRACE: input.trace,
    AISY_SUPERVISOR_FIXTURE_EXTERNAL: input.external,
    AISY_SUPERVISOR_FIXTURE_MODE: 'healthy',
  })
}

function localSupervisor(input: {
  stateRoot: string
  trace: string
  external: string
  mode?: string
  extra?: Record<string, string>
  beforeSpawn?: () => void
  onLoad?: () => void
  spawnCap?: number
}) {
  traces.push(input.trace)
  const node = makeNodeExecutionSupervisorSpawnPort()
  let spawned = 0
  const spawn: ExecutionSupervisorSpawnPort = {
    spawn(child) {
      if (spawned >= (input.spawnCap ?? 2)) throw new Error('fixture child spawn cap exceeded')
      input.beforeSpawn?.()
      spawned += 1
      appendFileSync(input.trace, `${Date.now()} local-spawn ${process.pid}\n`, { mode: 0o600 })
      return node.spawn(child)
    },
  }
  const base = makeNodeExecutionSupervisorStateStore({ root: input.stateRoot })
  const state: ExecutionSupervisorStateStore = {
    acquireManagerLease: () => base.acquireManagerLease(),
    acquireChildLivenessFence: (signal) => base.acquireChildLivenessFence(signal),
    load() { input.onLoad?.(); return base.load() },
    publish: (value) => base.publish(value),
  }
  const controller = new AbortController()
  const supervisor = makeExecutionParentSupervisor({
    execPath: process.execPath,
    binPath: '--experimental-strip-types',
    childArgs: [
      '--disable-warning=ExperimentalWarning',
      '--experimental-loader', fixture('typescript-source-loader.mjs'),
      fixture('execution-supervisor-child.mts'),
    ],
    childEnv: {
      TMPDIR: tmpdir(),
      AISY_SUPERVISOR_FIXTURE_STATE_ROOT: input.stateRoot,
      AISY_SUPERVISOR_FIXTURE_MODE: input.mode ?? 'healthy',
      AISY_SUPERVISOR_FIXTURE_TRACE: input.trace,
      AISY_SUPERVISOR_FIXTURE_EXTERNAL: input.external,
      ...input.extra,
    },
    spawn,
    state,
    nowMs: () => Date.now(),
    newId: opaque,
    randomNonce: opaque,
    sleep: async (_ms, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve()
        const timer = setTimeout(resolve, 10)
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
    },
    handshakeTimeoutMs: 15_000,
    stopTimeoutMs: 2_000,
  })
  return { controller, supervisor, spawned: () => spawned }
}

afterEach(async () => {
  const tracked = [...processes]
  const pids = new Set<number>()
  for (const trace of traces.splice(0)) {
    for (const line of lines(trace)) {
      const pid = Number(line.split(' ').at(-1))
      if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) pids.add(pid)
    }
  }
  for (const child of processes) {
    try { child.kill('SIGCONT') } catch { /* already gone */ }
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGCONT') } catch { /* already gone */ }
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
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

describe('execution parent supervisor real process', () => {
  it('observes planned child exit before starting one replacement over direct IPC', async () => {
    const directory = root()
    const trace = join(directory, 'trace.log')
    const marker = join(directory, 'planned.marker')
    const external = join(directory, 'external.log')
    const runtime = localSupervisor({
      stateRoot: join(directory, 'manager'), trace, external, mode: 'planned-once',
      extra: { AISY_SUPERVISOR_FIXTURE_MARKER: marker },
    })
    const run = runtime.supervisor.run(runtime.controller.signal)
    await waitUntil(() => {
      const observed = lines(trace)
      if (observed.some((line) => line.includes(' liveness-refused-'))) {
        throw new Error(`fixture liveness refused: ${observed.join(' | ')}`)
      }
      return runtime.spawned() === 2 && runtime.supervisor.status().phase === 'running'
    })
    expect(existsSync(marker)).toBe(true)
    runtime.controller.abort()
    await expect(run).resolves.toEqual({ kind: 'stopped' })
    expect(runtime.spawned()).toBe(2)
  }, 20_000)

  it('allows two real managers to start exactly one child', async () => {
    const directory = root()
    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    const stateRoot = join(directory, 'manager')
    const first = startManager({ stateRoot, trace, external })
    const second = startManager({ stateRoot, trace, external })
    await waitUntil(() => eventCount(trace, 'external') === 1 &&
      lines(trace).some((line) => line.includes(' manager-quarantined-')))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(eventCount(trace, 'manager-spawn-1')).toBe(1)
    expect(eventCount(trace, 'external')).toBe(1)
    first.kill('SIGTERM')
    second.kill('SIGTERM')
    await Promise.all([waitExit(first), waitExit(second)])
  }, 20_000)

  it.each(['direct-first', 'supervise-first'] as const)(
    'keeps direct run and supervise mutually exclusive with %s ordering',
    async (ordering) => {
      const directory = root()
      const trace = join(directory, 'trace.log')
      const external = join(directory, 'external.log')
      const stateRoot = join(directory, 'manager')
      if (ordering === 'direct-first') {
        const direct = startDirect({ stateRoot, trace, external })
        await waitUntil(() => eventCount(trace, 'direct-ready') === 1)
        const manager = startManager({ stateRoot, trace, external })
        await waitUntil(() => eventCount(trace, 'manager-start') === 1)
        await new Promise((resolve) => setTimeout(resolve, 250))
        expect(eventCount(trace, 'manager-spawn-1')).toBe(0)
        expect(eventCount(trace, 'external')).toBe(1)
        manager.kill('SIGTERM')
        await waitExit(manager)
        direct.kill('SIGTERM')
        await waitExit(direct)
      } else {
        const manager = startManager({ stateRoot, trace, external })
        await waitUntil(() => eventCount(trace, 'supervised-ready') === 1)
        const direct = startDirect({ stateRoot, trace, external })
        await waitExit(direct)
        expect(lines(trace).filter((line) => line.includes(' direct-refused-') ||
          line.includes(' liveness-refused-'))).toHaveLength(1)
        expect(eventCount(trace, 'external')).toBe(1)
        manager.kill('SIGTERM')
        await waitExit(manager)
      }
    },
    20_000,
  )

  it('waits for an orphaned child exit before state read and replacement spawn', async () => {
    if (process.platform === 'win32') return
    const directory = root()
    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    const stateRoot = join(directory, 'manager')
    const manager = startManager({
      stateRoot, trace, external,
      extra: { AISY_SUPERVISOR_FIXTURE_ORPHAN_HOLD_MS: '700' },
    })
    await waitUntil(() => eventCount(trace, 'supervised-ready') === 1)
    const oldPid = eventPid(trace, 'supervised-ready')
    manager.kill('SIGKILL')
    await waitExit(manager)

    let loads = 0
    const replacement = localSupervisor({
      stateRoot, trace, external,
      onLoad: () => { loads += 1 },
      beforeSpawn: () => {
        expect(alive(oldPid)).toBe(false)
        appendFileSync(trace, `${Date.now()} replacement-spawn ${process.pid}\n`, { mode: 0o600 })
      },
    })
    const run = replacement.supervisor.run(replacement.controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(loads).toBe(0)
    expect(replacement.spawned()).toBe(0)
    await waitUntil(() => replacement.spawned() === 1 && replacement.supervisor.status().phase === 'running')
    const ordered = lines(trace)
    expect(ordered.findIndex((line) => line.includes(' child-exit ')))
      .toBeLessThan(ordered.findIndex((line) => line.includes(' replacement-spawn ')))
    expect(eventCount(trace, 'external')).toBe(2)
    replacement.controller.abort()
    await expect(run).resolves.toEqual({ kind: 'stopped' })
  }, 25_000)

  it('blocks a replacement behind a delayed pre-hello orphan without external I/O', async () => {
    if (process.platform === 'win32') return
    const directory = root()
    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    const stateRoot = join(directory, 'manager')
    const manager = startManager({
      stateRoot, trace, external,
      extra: { AISY_SUPERVISOR_FIXTURE_PRE_HELLO_MS: '700' },
    })
    await waitUntil(() => eventCount(trace, 'pre-hello-wait') === 1)
    const orphanPid = eventPid(trace, 'pre-hello-wait')
    manager.kill('SIGKILL')
    await waitExit(manager)

    let loads = 0
    const replacement = localSupervisor({ stateRoot, trace, external, onLoad: () => { loads += 1 } })
    const run = replacement.supervisor.run(replacement.controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(loads).toBe(0)
    expect(replacement.spawned()).toBe(0)
    expect(eventCount(trace, 'external')).toBe(0)
    await waitUntil(() => replacement.spawned() === 1 &&
      replacement.supervisor.status().phase === 'running' && eventCount(trace, 'external') === 1)
    expect(alive(orphanPid)).toBe(false)
    expect(eventCount(trace, 'external')).toBe(1)
    replacement.controller.abort()
    await expect(run).resolves.toEqual({ kind: 'stopped' })
  }, 25_000)

  it('never times out a SIGSTOP-held liveness fence', async () => {
    if (process.platform === 'win32') return
    const directory = root()
    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    const stateRoot = join(directory, 'manager')
    const manager = startManager({ stateRoot, trace, external })
    await waitUntil(() => eventCount(trace, 'supervised-ready') === 1)
    const oldPid = eventPid(trace, 'supervised-ready')
    process.kill(oldPid, 'SIGSTOP')
    manager.kill('SIGKILL')
    await waitExit(manager)

    let loads = 0
    const replacement = localSupervisor({ stateRoot, trace, external, onLoad: () => { loads += 1 } })
    const run = replacement.supervisor.run(replacement.controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(loads).toBe(0)
    expect(replacement.spawned()).toBe(0)
    expect(eventCount(trace, 'external')).toBe(1)
    replacement.controller.abort()
    await expect(run).resolves.toEqual({ kind: 'stopped' })
    process.kill(oldPid, 'SIGCONT')
    await waitUntil(() => !alive(oldPid))
  }, 20_000)

  it('reacquires the liveness fence after SIGKILL child before one replacement', async () => {
    if (process.platform === 'win32') return
    const directory = root()
    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    const runtime = localSupervisor({ stateRoot: join(directory, 'manager'), trace, external })
    const run = runtime.supervisor.run(runtime.controller.signal)
    await waitUntil(() => eventCount(trace, 'supervised-ready') === 1)
    const firstPid = eventPid(trace, 'supervised-ready')
    process.kill(firstPid, 'SIGKILL')
    await waitUntil(() => eventCount(trace, 'supervised-ready') === 2)
    expect(runtime.spawned()).toBe(2)
    expect(alive(firstPid)).toBe(false)
    runtime.controller.abort()
    await expect(run).resolves.toEqual({ kind: 'stopped' })
  }, 20_000)

  it('fails closed without a second runtime when the held liveness inode is replaced', async () => {
    const directory = root()
    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    const runtime = localSupervisor({ stateRoot: join(directory, 'manager'), trace, external })
    const run = runtime.supervisor.run(runtime.controller.signal)
    await waitUntil(() => eventCount(trace, 'supervised-ready') === 1)
    const firstPid = eventPid(trace, 'supervised-ready')
    const dbPath = join(directory, 'execution-liveness', 'child-liveness.sqlite3')
    renameSync(dbPath, `${dbPath}.displaced`)
    writeFileSync(dbPath, 'replacement', { mode: 0o600 })

    await waitUntil(() => !alive(firstPid))
    await waitUntil(() => runtime.supervisor.status().phase === 'quarantined')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(runtime.spawned()).toBe(1)
    expect(eventCount(trace, 'external')).toBe(1)
    runtime.controller.abort()
    await expect(run).resolves.toEqual({
      kind: 'quarantined', code: 'SUPERVISOR_STATE_UNAVAILABLE',
    })

    const direct = startDirect({ stateRoot: join(directory, 'manager'), trace, external })
    await waitExit(direct)
    expect(lines(trace).some((line) =>
      line.includes(' direct-refused-CHILD_LIVENESS_CORRUPT '))).toBe(true)

    const replacementManager = startManager({
      stateRoot: join(directory, 'manager'), trace, external,
    })
    await waitUntil(() => lines(trace).some((line) => line.includes(' manager-quarantined-')))
    expect(eventCount(trace, 'manager-spawn-1')).toBe(0)
    expect(eventCount(trace, 'external')).toBe(1)
    replacementManager.kill('SIGTERM')
    await waitExit(replacementManager)
  }, 20_000)

  it('reuses exact lease DB inodes after two clean stop/start cycles with no child left', async () => {
    const directory = root()
    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    const stateRoot = join(directory, 'manager')
    const first = localSupervisor({ stateRoot, trace, external })
    const firstRun = first.supervisor.run(first.controller.signal)
    await waitUntil(() => first.supervisor.status().phase === 'running' &&
      eventCount(trace, 'supervised-ready') === 1)
    const firstPid = eventPid(trace, 'supervised-ready')
    const managerDb = join(stateRoot, 'manager-lease.sqlite3')
    const childDb = join(directory, 'execution-liveness', 'child-liveness.sqlite3')
    const inodes = [statSync(managerDb).ino, statSync(childDb).ino]
    first.controller.abort()
    await expect(firstRun).resolves.toEqual({ kind: 'stopped' })
    await waitUntil(() => !alive(firstPid))

    const second = localSupervisor({ stateRoot, trace, external })
    const secondRun = second.supervisor.run(second.controller.signal)
    await waitUntil(() => second.supervisor.status().phase === 'running' &&
      eventCount(trace, 'supervised-ready') === 2)
    const secondPid = eventPid(trace, 'supervised-ready', 1)
    expect([statSync(managerDb).ino, statSync(childDb).ino]).toEqual(inodes)
    second.controller.abort()
    await expect(secondRun).resolves.toEqual({ kind: 'stopped' })
    await waitUntil(() => !alive(secondPid))
  }, 20_000)
})
