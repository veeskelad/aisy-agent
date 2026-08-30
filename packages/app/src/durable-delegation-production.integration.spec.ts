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
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('fixture timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitExit(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
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
  stopPhase: string
  recovery: boolean
  resolution?: 'retry-once' | 'cancel'
}>): ChildProcess {
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    '--experimental-loader', fixture('typescript-source-loader.mjs'),
    fixture('durable-delegation-production-crash.mts'),
  ], {
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      TMPDIR: tmpdir(),
      TZ: process.env['TZ'] ?? 'UTC',
      AISY_DURABLE_CRASH_STATE_ROOT: input.stateRoot,
      AISY_DURABLE_CRASH_TRACE: input.trace,
      AISY_DURABLE_CRASH_STOP_PHASE: input.stopPhase,
      AISY_DURABLE_CRASH_RECOVERY: input.recovery ? '1' : '0',
      AISY_DURABLE_CRASH_RESOLUTION: input.resolution ?? 'none',
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

describe('production durable delegation real-process recovery', () => {
  it.each([
    { phase: 'provider-dispatch', outcome: 'ambiguous', providerCalls: 0 },
    { phase: 'provider-response', outcome: 'ambiguous', providerCalls: 1 },
    { phase: 'child-settled', outcome: 'completed', providerCalls: 1 },
    { phase: 'verifier-settled', outcome: 'completed', providerCalls: 1 },
    { phase: 'terminal-committed', outcome: 'completed', providerCalls: 1 },
  ])('recovers a SIGKILL at $phase without a duplicate provider call', async ({
    phase,
    outcome,
    providerCalls,
  }) => {
    if (process.platform === 'win32') return
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-production-crash-')))
    roots.push(root)
    const trace = join(root, 'trace.log')

    const first = start({ stateRoot: root, trace, stopPhase: phase, recovery: false })
    await waitUntil(() => lines(trace).includes(`stop ${phase}`))
    first.kill('SIGKILL')
    await expect(waitExit(first)).resolves.toEqual({ code: null, signal: 'SIGKILL' })

    const replacement = start({ stateRoot: root, trace, stopPhase: 'none', recovery: true })
    const exit = await waitExit(replacement)
    const evidence = lines(trace)
    expect(evidence.filter(line => line === 'provider-call')).toHaveLength(providerCalls)
    expect(evidence.some(line => line === 'recovery continuation' || line === 'recovery terminal'))
      .toBe(true)
    if (outcome === 'completed') {
      expect(exit).toEqual({ code: 0, signal: null })
      expect(evidence).toContain('done completed')
    } else {
      expect(exit).toEqual({ code: 2, signal: null })
      expect(evidence.some(line => line.includes('DELEGATION_OPERATION_AMBIGUOUS')))
        .toBe(true)
      expect(evidence).not.toContain('done completed')
    }
  }, 30_000)

  it('retries an ambiguous provider only with an exact one-shot actor authority', async () => {
    if (process.platform === 'win32') return
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-production-crash-')))
    roots.push(root)
    const trace = join(root, 'trace.log')

    const first = start({
      stateRoot: root, trace, stopPhase: 'provider-response', recovery: false,
    })
    await waitUntil(() => lines(trace).includes('stop provider-response'))
    first.kill('SIGKILL')
    await expect(waitExit(first)).resolves.toEqual({ code: null, signal: 'SIGKILL' })

    const replacement = start({
      stateRoot: root,
      trace,
      stopPhase: 'none',
      recovery: true,
      resolution: 'retry-once',
    })
    await expect(waitExit(replacement)).resolves.toEqual({ code: 0, signal: null })
    const evidence = lines(trace)
    expect(evidence.filter(line => line === 'provider-call')).toHaveLength(2)
    expect(evidence).toContain('paused provider 1 1 retry-once')
    expect(evidence).toContain('ambiguity provider 1 1')
    expect(evidence).toContain('done completed')
  }, 30_000)
})
