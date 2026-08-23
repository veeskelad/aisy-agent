import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ExecutionProcessGroupError,
  makeDormantNodeExecutionProcessGroupPort,
  makeExecutionProcessGroupPort,
  makeNodeExecutionProcessGroupSystemPort,
  type ExecutionProcessGroup,
  type ExecutionProcessGroupSignal,
  type ExecutionProcessGroupSpawnInput,
  type ExecutionProcessGroupSubprocess,
  type ExecutionProcessGroupSystemPort,
} from './execution-process-group.js'

function errno(code: string): Error {
  return Object.assign(new Error('raw detail must not escape'), { code })
}

interface FakeHarness {
  readonly child: EventEmitter & {
    pid?: number
    kill(signal: ExecutionProcessGroupSignal): boolean
  }
  system: ExecutionProcessGroupSystemPort
  readonly signals: Array<{ target: number; signal: ExecutionProcessGroupSignal | 0 }>
  leaderPresent: boolean
  groupPresent: boolean
  probeError: string | null
  signalError: string | null
  now: number
}

function fakeHarness(platform: NodeJS.Platform = 'linux'): FakeHarness {
  const child = new EventEmitter() as FakeHarness['child']
  child.pid = 4312
  child.kill = vi.fn(() => true)
  const signals: Array<{ target: number; signal: ExecutionProcessGroupSignal | 0 }> = []
  const harness: FakeHarness = {
    child,
    signals,
    leaderPresent: true,
    groupPresent: true,
    probeError: null,
    signalError: null,
    now: 0,
    system: null as never,
  }
  harness.system = {
    platform,
    currentPid: 99,
    spawn(input: ExecutionProcessGroupSpawnInput & { readonly detached: true }) {
      expect(input.detached).toBe(true)
      return child as unknown as ExecutionProcessGroupSubprocess
    },
    signal(target: number, signal: ExecutionProcessGroupSignal | 0) {
      signals.push({ target, signal })
      if (signal === 0 && harness.probeError !== null) throw errno(harness.probeError)
      if (signal !== 0 && harness.signalError !== null) throw errno(harness.signalError)
      const present = target > 0 ? harness.leaderPresent : harness.groupPresent
      if (!present) throw errno('ESRCH')
    },
    monotonicMs: () => harness.now,
    async wait(ms: number, signal: AbortSignal) {
      if (signal.aborted) throw new ExecutionProcessGroupError('PROCESS_GROUP_QUIESCENCE_ABORTED')
      harness.now += ms
      await Promise.resolve()
    },
  }
  return harness
}

const SPAWN_INPUT: ExecutionProcessGroupSpawnInput = {
  command: '/usr/bin/node',
  args: ['fixture.js'],
  environment: {},
}

async function errorCode(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
    return 'resolved'
  } catch (error) {
    return error instanceof ExecutionProcessGroupError ? error.code : 'foreign-error'
  }
}

describe('execution process group unit contract', () => {
  it('uses a monotonic deadline source even when wall time moves backwards', () => {
    const wall = vi.spyOn(Date, 'now').mockReturnValueOnce(10_000).mockReturnValue(1)
    try {
      const system = makeNodeExecutionProcessGroupSystemPort()
      const before = system.monotonicMs()
      Date.now()
      Date.now()
      expect(system.monotonicMs()).toBeGreaterThanOrEqual(before)
    } finally {
      wall.mockRestore()
    }
  })

  it('fails closed on Windows before any spawn', () => {
    const h = fakeHarness('win32')
    const spawn = vi.spyOn(h.system, 'spawn')

    expect(() => makeExecutionProcessGroupPort(h.system)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_PLATFORM' }),
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('publishes exact PID equals PGID identity only after detached spawn', async () => {
    const h = fakeHarness()
    const group = makeExecutionProcessGroupPort(h.system).spawn(SPAWN_INPUT)
    let settled = false
    void group.started.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    h.child.emit('spawn')

    await expect(group.started).resolves.toEqual({
      kind: 'spawned', leaderPid: 4312, processGroupId: 4312,
    })
  })

  it('sends TERM and one KILL upgrade to negative PGID and ignores duplicates', async () => {
    const h = fakeHarness()
    const group = makeExecutionProcessGroupPort(h.system).spawn(SPAWN_INPUT)
    h.child.emit('spawn')
    await group.started

    group.terminate('SIGTERM')
    group.terminate('SIGTERM')
    group.terminate('SIGKILL')
    group.terminate('SIGKILL')
    group.terminate('SIGTERM')

    expect(h.signals).toEqual([
      { target: -4312, signal: 'SIGTERM' },
      { target: -4312, signal: 'SIGKILL' },
    ])
  })

  it('latches a pre-spawn request and delivers it only after identity exists', async () => {
    const h = fakeHarness()
    const group = makeExecutionProcessGroupPort(h.system).spawn(SPAWN_INPUT)
    group.terminate('SIGTERM')
    expect(h.signals).toEqual([])

    h.child.emit('spawn')
    await group.started
    expect(h.signals).toEqual([{ target: -4312, signal: 'SIGTERM' }])
  })

  it('does not turn leader exit into quiescence while the group remains', async () => {
    const h = fakeHarness()
    const group = makeExecutionProcessGroupPort(h.system).spawn(SPAWN_INPUT)
    h.child.emit('spawn')
    h.child.emit('exit', 0, null)
    h.leaderPresent = false

    await expect(group.exited).resolves.toEqual({ code: 0, signal: null })
    await expect(errorCode(group.waitForQuiescence({
      timeoutMs: 20, signal: new AbortController().signal,
    }))).resolves.toBe('PROCESS_GROUP_QUIESCENCE_TIMEOUT')

    h.groupPresent = false
    await expect(group.waitForQuiescence({
      timeoutMs: 20, signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'process-group-absent',
      leaderPid: 4312,
      processGroupId: 4312,
      leaderProbe: 'ESRCH',
      groupProbe: 'ESRCH',
      exit: { code: 0, signal: null },
    })
  })

  it('requires both ESRCH observations and an actual exit event', async () => {
    const h = fakeHarness()
    const group = makeExecutionProcessGroupPort(h.system).spawn(SPAWN_INPUT)
    h.child.emit('spawn')
    h.leaderPresent = false
    h.groupPresent = false

    await expect(errorCode(group.waitForQuiescence({
      timeoutMs: 20, signal: new AbortController().signal,
    }))).resolves.toBe('PROCESS_GROUP_QUIESCENCE_TIMEOUT')

    h.child.emit('exit', null, 'SIGKILL')
    await expect(group.waitForQuiescence({
      timeoutMs: 20, signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: 'process-group-absent', exit: { code: null, signal: 'SIGKILL' },
    })
  })

  it('latches group ESRCH and never sends a later non-zero signal', async () => {
    const h = fakeHarness()
    const group = makeExecutionProcessGroupPort(h.system).spawn(SPAWN_INPUT)
    h.child.emit('spawn')
    await group.started
    h.groupPresent = false

    group.terminate('SIGTERM')
    group.terminate('SIGKILL')
    expect(h.signals).toEqual([{ target: -4312, signal: 'SIGTERM' }])

    h.leaderPresent = false
    h.child.emit('exit', 0, null)
    await expect(group.waitForQuiescence({
      timeoutMs: 20, signal: new AbortController().signal,
    })).resolves.toMatchObject({ kind: 'process-group-absent' })
    group.terminate('SIGKILL')
    expect(h.signals).toEqual([
      { target: -4312, signal: 'SIGTERM' },
      { target: 4312, signal: 0 },
    ])
  })

  it('keeps pre-spawn failure separate and never fabricates exit or signals', async () => {
    const h = fakeHarness()
    const group = makeExecutionProcessGroupPort(h.system).spawn(SPAWN_INPUT)
    group.terminate('SIGTERM')
    h.child.emit('error', errno('ENOENT'))

    await expect(group.started).resolves.toEqual({ kind: 'spawn-failed' })
    await expect(errorCode(group.waitForQuiescence({
      timeoutMs: 20, signal: new AbortController().signal,
    }))).resolves.toBe('PROCESS_GROUP_SPAWN_FAILED')
    expect(h.signals).toEqual([])
    let exitObserved = false
    void group.exited.then(() => { exitObserved = true })
    await Promise.resolve()
    expect(exitObserved).toBe(false)
  })

  it('refuses an emitted spawn without a safe PID instead of inventing group identity', async () => {
    const h = fakeHarness()
    delete h.child.pid
    const group = makeExecutionProcessGroupPort(h.system).spawn(SPAWN_INPUT)
    h.child.emit('spawn')

    await expect(group.started).resolves.toEqual({ kind: 'identity-unavailable' })
    await expect(errorCode(group.waitForQuiescence({
      timeoutMs: 20, signal: new AbortController().signal,
    }))).resolves.toBe('PROCESS_GROUP_IDENTITY_UNAVAILABLE')
    group.terminate('SIGKILL')
    expect(h.signals).toEqual([])
    expect(h.child.kill).toHaveBeenCalledOnce()
    expect(h.child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it.each([
    ['EPERM', 'PROCESS_GROUP_SIGNAL_DENIED'],
    ['EIO', 'PROCESS_GROUP_SIGNAL_FAILED'],
  ] as const)('maps signal %s to stable code-only %s', async (rawCode, stableCode) => {
    const h = fakeHarness()
    const group = makeExecutionProcessGroupPort(h.system).spawn(SPAWN_INPUT)
    h.child.emit('spawn')
    h.signalError = rawCode
    group.terminate('SIGTERM')

    const observed = await group.waitForQuiescence({
      timeoutMs: 20, signal: new AbortController().signal,
    }).catch((error: unknown) => error)
    expect(observed).toMatchObject({ code: stableCode, message: stableCode })
    expect(String(observed)).not.toContain('raw detail')
  })

  it.each([
    ['EPERM', 'PROCESS_GROUP_PROBE_DENIED'],
    ['EIO', 'PROCESS_GROUP_PROBE_FAILED'],
  ] as const)('maps probe %s to stable code-only %s', async (rawCode, stableCode) => {
    const h = fakeHarness()
    const group = makeExecutionProcessGroupPort(h.system).spawn(SPAWN_INPUT)
    h.child.emit('spawn')
    h.probeError = rawCode

    const observed = await group.waitForQuiescence({
      timeoutMs: 20, signal: new AbortController().signal,
    }).catch((error: unknown) => error)
    expect(observed).toBeInstanceOf(ExecutionProcessGroupError)
    expect(observed).toMatchObject({ code: stableCode, message: stableCode })
    expect(String(observed)).not.toContain('raw detail')
  })

  it('returns stable abort without claiming proof', async () => {
    const h = fakeHarness()
    const group = makeExecutionProcessGroupPort(h.system).spawn(SPAWN_INPUT)
    h.child.emit('spawn')
    const controller = new AbortController()
    controller.abort()

    await expect(errorCode(group.waitForQuiescence({
      timeoutMs: 20, signal: controller.signal,
    }))).resolves.toBe('PROCESS_GROUP_QUIESCENCE_ABORTED')
  })
})

const realRoots: string[] = []
const realGroups = new Set<ExecutionProcessGroup>()

function realRoot(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-process-group-'))
  realRoots.push(value)
  return value
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('real process fixture timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function fixturePids(tracePath: string): { leaderPid: number; grandchildPid: number } {
  const values = readFileSync(tracePath, 'utf8').trim().split(' ').map(Number)
  const leaderPid = values[0]
  const grandchildPid = values[1]
  if (!Number.isSafeInteger(leaderPid) || !Number.isSafeInteger(grandchildPid) ||
    leaderPid === undefined || grandchildPid === undefined || leaderPid < 2 || grandchildPid < 2) {
    throw new Error('invalid fixture pid trace')
  }
  return { leaderPid, grandchildPid }
}

afterEach(async () => {
  try {
    for (const group of realGroups) {
      group.terminate('SIGTERM')
      try {
        await group.waitForQuiescence({
          timeoutMs: 250,
          signal: new AbortController().signal,
        })
      } catch (error) {
        if (!(error instanceof ExecutionProcessGroupError) ||
          error.code !== 'PROCESS_GROUP_QUIESCENCE_TIMEOUT') throw error
        group.terminate('SIGKILL')
        await group.waitForQuiescence({
          timeoutMs: 2_000,
          signal: new AbortController().signal,
        })
      }
    }
  } finally {
    realGroups.clear()
    for (const root of realRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  }
})

const GRANDCHILD = `
const { writeFileSync } = require('node:fs')
if (process.env['AISY_GROUP_STUBBORN'] === '1') process.on('SIGTERM', () => undefined)
else process.on('SIGTERM', () => process.exit(0))
writeFileSync(process.env['AISY_GROUP_READY'], String(process.pid), { mode: 0o600 })
setInterval(() => undefined, 1000)
`

const NESTED_LEADER = `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const grandchild = spawn(process.execPath, ['-e', process.env['AISY_GROUP_GRANDCHILD']], {
  stdio: 'ignore',
})
writeFileSync(process.env['AISY_GROUP_TRACE'], process.pid + ' ' + grandchild.pid, { mode: 0o600 })
process.on('SIGTERM', () => {
  if (grandchild.exitCode !== null || grandchild.signalCode !== null) process.exit(0)
  grandchild.once('exit', () => process.exit(0))
})
setInterval(() => undefined, 1000)
`

const LEADER_FIRST = `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const grandchild = spawn(process.execPath, ['-e', process.env['AISY_GROUP_GRANDCHILD']], {
  stdio: 'ignore',
})
writeFileSync(process.env['AISY_GROUP_TRACE'], process.pid + ' ' + grandchild.pid, { mode: 0o600 })
setTimeout(() => process.exit(0), 100)
`

describe.skipIf(process.platform === 'win32')('execution process group real processes', () => {
  it('spawns PID equal PGID and TERM removes a real child and grandchild', async () => {
    const directory = realRoot()
    const tracePath = join(directory, 'pids.txt')
    const readyPath = join(directory, 'ready.txt')
    const group = makeDormantNodeExecutionProcessGroupPort().spawn({
      command: process.execPath,
      args: ['-e', NESTED_LEADER],
      environment: {
        AISY_GROUP_TRACE: tracePath,
        AISY_GROUP_GRANDCHILD: GRANDCHILD,
        AISY_GROUP_READY: readyPath,
      },
      stdio: 'ignore',
    })
    const started = await group.started
    expect(started.kind).toBe('spawned')
    if (started.kind !== 'spawned') throw new Error('fixture did not spawn')
    realGroups.add(group)
    await waitUntil(() => existsSync(tracePath) && existsSync(readyPath))
    const pids = fixturePids(tracePath)

    expect(pids.leaderPid).toBe(started.leaderPid)
    expect(started.leaderPid).toBe(started.processGroupId)

    group.terminate('SIGTERM')
    await expect(group.waitForQuiescence({
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: 'process-group-absent',
      leaderPid: started.leaderPid,
      processGroupId: started.processGroupId,
      leaderProbe: 'ESRCH',
      groupProbe: 'ESRCH',
    })
    expect(alive(pids.leaderPid)).toBe(false)
    expect(alive(pids.grandchildPid)).toBe(false)
    realGroups.delete(group)
  }, 10_000)

  it('does not accept leader-first exit while a stubborn grandchild survives, then KILL proves absence', async ({ skip }) => {
    const directory = realRoot()
    const tracePath = join(directory, 'pids.txt')
    const readyPath = join(directory, 'ready.txt')
    const group = makeDormantNodeExecutionProcessGroupPort().spawn({
      command: process.execPath,
      args: ['-e', LEADER_FIRST],
      environment: {
        AISY_GROUP_TRACE: tracePath,
        AISY_GROUP_GRANDCHILD: GRANDCHILD,
        AISY_GROUP_READY: readyPath,
        AISY_GROUP_STUBBORN: '1',
      },
      stdio: 'ignore',
    })
    const started = await group.started
    expect(started.kind).toBe('spawned')
    if (started.kind !== 'spawned') throw new Error('fixture did not spawn')
    realGroups.add(group)
    await waitUntil(() => existsSync(tracePath) && existsSync(readyPath))
    const pids = fixturePids(tracePath)
    await expect(group.exited).resolves.toEqual({ code: 0, signal: null })
    expect(alive(pids.grandchildPid)).toBe(true)

    group.terminate('SIGTERM')
    await expect(errorCode(group.waitForQuiescence({
      timeoutMs: 100,
      signal: new AbortController().signal,
    }))).resolves.toBe('PROCESS_GROUP_QUIESCENCE_TIMEOUT')
    expect(alive(pids.grandchildPid)).toBe(true)

    group.terminate('SIGKILL')
    const finalProof = await group.waitForQuiescence({
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    }).catch((error: unknown) => error)
    if (finalProof instanceof ExecutionProcessGroupError &&
      finalProof.code === 'PROCESS_GROUP_PROBE_DENIED') {
      await waitUntil(() => !alive(pids.grandchildPid), 2_000)
      realGroups.delete(group)
      skip()
      return
    }
    expect(finalProof).toMatchObject({
      kind: 'process-group-absent',
      leaderPid: started.leaderPid,
      processGroupId: started.processGroupId,
      exit: { code: 0, signal: null },
    })
    expect(alive(pids.grandchildPid)).toBe(false)
    realGroups.delete(group)
  }, 10_000)
})
