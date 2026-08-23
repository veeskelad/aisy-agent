import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const processes = new Set<ChildProcess>()

function fixture(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', name)
}

function lines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('fixture timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitExit(child: ChildProcess, timeoutMs = 10_000): Promise<Readonly<{
  code: number | null
  signal: NodeJS.Signals | null
}>> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
      child.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('process exit timeout')), timeoutMs)),
  ])
}

function start(input: Readonly<{
  stateRoot: string
  trace: string
  phase: string
  recovery: boolean
}>): ChildProcess {
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    '--experimental-loader', fixture('typescript-source-loader.mjs'),
    fixture('durable-turn-envelope-crash.mts'),
  ], {
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      TMPDIR: tmpdir(),
      TZ: process.env['TZ'] ?? 'UTC',
      AISY_DURABLE_TURN_STATE_ROOT: input.stateRoot,
      AISY_DURABLE_TURN_TRACE: input.trace,
      AISY_DURABLE_TURN_PHASE: input.phase,
      AISY_DURABLE_TURN_RECOVERY: input.recovery ? '1' : '0',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  processes.add(child)
  child.once('exit', () => processes.delete(child))
  return child
}

afterEach(async () => {
  const tracked = [...processes]
  for (const child of tracked) try { child.kill('SIGKILL') } catch { /* already gone */ }
  await Promise.all(tracked.map(child => waitExit(child, 1_000).catch(() => undefined)))
  processes.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('durable Telegram/delegation turn real-process envelope', () => {
  it.each([
    { phase: 'pause-before-card', outcome: 'card-pending' },
    { phase: 'card-delivered', outcome: 'card-pending' },
    { phase: 'callback-recorded', outcome: 'completed' },
    { phase: 'actor-claimed', outcome: 'completed' },
    { phase: 'resolution-applied', outcome: 'completed' },
    { phase: 'stop-requested', outcome: 'cancelled' },
    { phase: 'stop-after-callback', outcome: 'cancelled' },
    { phase: 'stop-after-claim', outcome: 'cancelled' },
    { phase: 'actor-cancelled', outcome: 'cancelled' },
  ])('recovers SIGKILL after $phase without a second callback or late I/O', async ({
    phase,
    outcome,
  }) => {
    if (process.platform === 'win32') return
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-turn-envelope-')))
    roots.push(root)
    const trace = join(root, 'trace.log')

    const first = start({ stateRoot: root, trace, phase, recovery: false })
    await waitUntil(() => lines(trace).includes(`stop ${phase}`))
    first.kill('SIGKILL')
    await expect(waitExit(first)).resolves.toEqual({ code: null, signal: 'SIGKILL' })

    const replacement = start({ stateRoot: root, trace, phase, recovery: true })
    await expect(waitExit(replacement)).resolves.toEqual({ code: 0, signal: null })
    const evidence = lines(trace)
    expect(evidence.filter(line => line === `stop ${phase}`)).toHaveLength(1)
    expect(evidence).toContain(`recovered ${outcome}`)
    if (outcome === 'cancelled') expect(evidence).toContain('run-retired')
  }, 30_000)
})
