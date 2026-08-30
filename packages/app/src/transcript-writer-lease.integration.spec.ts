import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  TRANSCRIPT_WRITER_LEASE_DB_FILENAME,
  TRANSCRIPT_WRITER_LEASE_ROOT_DIRNAME,
  TRANSCRIPT_WRITER_LOCK_DIRNAME,
} from './transcript-writer-lease.js'

const roots: string[] = []
const processes = new Set<ChildProcess>()

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-transcript-writer-e2e-')))
  roots.push(value)
  return value
}

function fixture(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', name)
}

function lines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
}

function eventCount(path: string, event: string): number {
  return lines(path).filter((line) => line.split(' ')[1] === event).length
}

function startLeaseProcess(input: {
  leaseRoot: string
  trace: string
  external: string
  mode?: 'once' | 'hold'
}): ChildProcess {
  const child = spawnProcess(process.execPath, [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    '--experimental-loader', fixture('typescript-source-loader.mjs'),
    fixture('transcript-writer-process.mts'),
  ], {
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      TMPDIR: tmpdir(),
      TZ: process.env['TZ'] ?? 'UTC',
      AISY_TRANSCRIPT_FIXTURE_ROOT: input.leaseRoot,
      AISY_TRANSCRIPT_FIXTURE_TRACE: input.trace,
      AISY_TRANSCRIPT_FIXTURE_EXTERNAL: input.external,
      AISY_TRANSCRIPT_FIXTURE_MODE: input.mode ?? 'once',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  processes.add(child)
  child.once('exit', () => processes.delete(child))
  return child
}

function startAisy(input: {
  base: string
  state: string
  external: string
  journal: '0' | '1'
  mode?: 'full' | 'setup'
}): { child: ChildProcess; stderr: () => string } {
  mkdirSync(input.base, { recursive: true, mode: 0o700 })
  const workspace = join(dirname(input.base), 'workspace')
  mkdirSync(workspace, { mode: 0o700 })
  if ((input.mode ?? 'full') === 'full') {
    writeFileSync(join(input.base, 'providers.json'), JSON.stringify({
      default: { provider: 'claude-cli', model: 'sonnet' },
    }), { mode: 0o600 })
  }
  let stderr = ''
  const child = spawnProcess(process.execPath, [
    '--import', fixture('external-fetch-sentinel.mjs'),
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    '--experimental-loader', fixture('typescript-source-loader.mjs'),
    join(dirname(fileURLToPath(import.meta.url)), 'bin', 'aisy.ts'),
    'run',
  ], {
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      TMPDIR: tmpdir(),
      TZ: process.env['TZ'] ?? 'UTC',
      NO_COLOR: '1',
      HOME: input.base,
      AISY_HOME: input.base,
      AISY_WORKSPACE: workspace,
      XDG_STATE_HOME: input.state,
      AISY_TELEGRAM_BOT_TOKEN: '123:fixture-token',
      AISY_TELEGRAM_CHAT_ID: '123',
      AISY_SESSION_JOURNAL: input.journal,
      AISY_PROTECTED_MEMORY: 'off',
      AISY_EXTERNAL_FETCH_SENTINEL: input.external,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })
  processes.add(child)
  child.once('exit', () => processes.delete(child))
  return { child, stderr: () => stderr }
}

async function waitForExternalOrExit(
  runtime: { child: ChildProcess; stderr: () => string },
  external: string,
): Promise<void> {
  await waitUntil(() => lines(external).length > 0 ||
    runtime.child.exitCode !== null || runtime.child.signalCode !== null, 20_000)
  if (lines(external).length === 0) {
    throw new Error(`aisy exited before external sentinel: ${runtime.stderr()}`)
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('fixture timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitExit(child: ChildProcess, timeoutMs = 15_000): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null }
  }
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer)
      resolve({ code, signal })
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error('process exit timeout'))
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function initialize(leaseRoot: string, trace: string, external: string): Promise<void> {
  const child = startLeaseProcess({ leaseRoot, trace, external })
  const result = await waitExit(child)
  expect(result, lines(trace).join(' | ')).toEqual({ code: 0, signal: null })
}

function databasePath(leaseRoot: string): string {
  return join(leaseRoot, TRANSCRIPT_WRITER_LEASE_ROOT_DIRNAME, TRANSCRIPT_WRITER_LEASE_DB_FILENAME)
}

afterEach(async () => {
  const tracked = [...processes]
  for (const child of tracked) {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
  await Promise.all(tracked.map((child) => waitExit(child, 2_000).catch(() => undefined)))
  for (const child of processes) {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  await Promise.all(tracked.map((child) => waitExit(child, 5_000)))
  processes.clear()
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('transcript writer lease real processes', () => {
  it('allows exactly one external writer across two concurrent processes', async () => {
    const directory = root()
    const leaseRoot = join(directory, 'journal')
    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    const holder = startLeaseProcess({ leaseRoot, trace, external, mode: 'hold' })
    await waitUntil(() => eventCount(trace, 'acquired') === 1)

    const contender = startLeaseProcess({ leaseRoot, trace, external })
    await expect(waitExit(contender)).resolves.toEqual({ code: 73, signal: null })

    expect(eventCount(trace, 'acquired')).toBe(1)
    expect(eventCount(external, 'external')).toBe(1)
    expect(lines(trace).some((line) => line.includes('refused-held-by-another-process'))).toBe(true)
    holder.kill('SIGTERM')
    await expect(waitExit(holder)).resolves.toEqual({ code: 0, signal: null })
  }, 40_000)

  it('reacquires after holder SIGKILL without overlapping external work', async () => {
    const directory = root()
    const leaseRoot = join(directory, 'journal')
    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    const holder = startLeaseProcess({ leaseRoot, trace, external, mode: 'hold' })
    await waitUntil(() => eventCount(trace, 'acquired') === 1 && eventCount(external, 'external') === 1)

    holder.kill('SIGKILL')
    await expect(waitExit(holder)).resolves.toEqual({ code: null, signal: 'SIGKILL' })
    const replacement = startLeaseProcess({ leaseRoot, trace, external })
    await expect(waitExit(replacement)).resolves.toEqual({ code: 0, signal: null })

    expect(eventCount(trace, 'acquired')).toBe(2)
    expect(eventCount(external, 'external')).toBe(2)
  }, 40_000)

  it('supports a clean release followed by a fresh process', async () => {
    const directory = root()
    const leaseRoot = join(directory, 'journal')
    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')

    await initialize(leaseRoot, trace, external)
    await initialize(leaseRoot, trace, external)

    expect(eventCount(trace, 'acquired')).toBe(2)
    expect(eventCount(trace, 'released')).toBe(2)
    expect(eventCount(external, 'external')).toBe(2)
  }, 35_000)

  it('keeps a legacy directory as a fail-closed compatibility residue', async () => {
    const directory = root()
    const leaseRoot = join(directory, 'journal')
    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    mkdirSync(leaseRoot, { mode: 0o700 })
    mkdirSync(join(leaseRoot, TRANSCRIPT_WRITER_LOCK_DIRNAME), { mode: 0o700 })

    const child = startLeaseProcess({ leaseRoot, trace, external })
    await expect(waitExit(child)).resolves.toEqual({ code: 73, signal: null })

    expect(lines(trace).some((line) => line.includes('refused-legacy-residue'))).toBe(true)
    expect(lines(external)).toEqual([])
  }, 30_000)

  it('publishes a permanent regular barrier that denies a legacy mkdir client', async () => {
    const directory = root()
    const leaseRoot = join(directory, 'journal')
    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    await initialize(leaseRoot, trace, external)

    const barrier = join(leaseRoot, TRANSCRIPT_WRITER_LOCK_DIRNAME)
    const stat = statSync(barrier)
    expect(stat.isFile()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o600)
    expect(() => mkdirSync(barrier)).toThrow(expect.objectContaining({ code: 'EEXIST' }))
    await initialize(leaseRoot, trace, external)
    expect(eventCount(external, 'external')).toBe(2)
  }, 35_000)

  it('refuses corrupt bytes without reaching the external boundary', async () => {
    const directory = root()
    const leaseRoot = join(directory, 'journal')
    const bootstrapTrace = join(directory, 'bootstrap-trace.log')
    const bootstrapExternal = join(directory, 'bootstrap-external.log')
    await initialize(leaseRoot, bootstrapTrace, bootstrapExternal)
    writeFileSync(databasePath(leaseRoot), 'not sqlite', { mode: 0o600 })

    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    const child = startLeaseProcess({ leaseRoot, trace, external })
    await expect(waitExit(child)).resolves.toEqual({ code: 73, signal: null })

    expect(lines(trace).some((line) => line.includes('refused-lease-corrupt'))).toBe(true)
    expect(lines(external)).toEqual([])
  }, 35_000)

  it('refuses an unsafe compatibility barrier without external work', async () => {
    const directory = root()
    const leaseRoot = join(directory, 'journal')
    const bootstrapTrace = join(directory, 'bootstrap-trace.log')
    const bootstrapExternal = join(directory, 'bootstrap-external.log')
    await initialize(leaseRoot, bootstrapTrace, bootstrapExternal)
    chmodSync(join(leaseRoot, TRANSCRIPT_WRITER_LOCK_DIRNAME), 0o644)

    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    const child = startLeaseProcess({ leaseRoot, trace, external })
    await expect(waitExit(child)).resolves.toEqual({ code: 73, signal: null })

    expect(lines(trace).some((line) => line.includes('refused-lease-unsafe'))).toBe(true)
    expect(lines(external)).toEqual([])
  }, 35_000)

  it('refuses a valid database copied onto a replacement inode', async () => {
    const directory = root()
    const leaseRoot = join(directory, 'journal')
    const bootstrapTrace = join(directory, 'bootstrap-trace.log')
    const bootstrapExternal = join(directory, 'bootstrap-external.log')
    await initialize(leaseRoot, bootstrapTrace, bootstrapExternal)
    const database = databasePath(leaseRoot)
    const displaced = join(directory, 'displaced.sqlite3')
    renameSync(database, displaced)
    copyFileSync(displaced, database)
    chmodSync(database, 0o600)

    const trace = join(directory, 'trace.log')
    const external = join(directory, 'external.log')
    const child = startLeaseProcess({ leaseRoot, trace, external })
    await expect(waitExit(child)).resolves.toEqual({ code: 73, signal: null })

    expect(lines(trace).some((line) => line.includes('refused-lease-corrupt'))).toBe(true)
    expect(lines(external)).toEqual([])
  }, 35_000)

  it('makes the enabled live CLI fail before any fetch on legacy residue', async () => {
    const directory = root()
    const base = join(directory, 'home')
    const journal = join(base, 'journal')
    const external = join(directory, 'external.log')
    mkdirSync(journal, { recursive: true, mode: 0o700 })
    mkdirSync(join(journal, TRANSCRIPT_WRITER_LOCK_DIRNAME), { mode: 0o700 })

    const runtime = startAisy({
      base,
      state: join(directory, 'state'),
      external,
      journal: '1',
    })
    await expect(waitExit(runtime.child, 20_000)).resolves.toEqual({ code: 1, signal: null })

    expect(runtime.stderr()).toContain('writer lease журнала сессий недоступен (legacy-residue)')
    expect(lines(external)).toEqual([])
  }, 30_000)

  it('makes the enabled live CLI fail before fetch while another writer holds the lease', async () => {
    const directory = root()
    const base = join(directory, 'home')
    const journal = join(base, 'journal')
    const holderTrace = join(directory, 'holder-trace.log')
    const holderExternal = join(directory, 'holder-external.log')
    const cliExternal = join(directory, 'cli-external.log')
    const holder = startLeaseProcess({
      leaseRoot: journal,
      trace: holderTrace,
      external: holderExternal,
      mode: 'hold',
    })
    await waitUntil(() => eventCount(holderTrace, 'acquired') === 1)

    const runtime = startAisy({
      base,
      state: join(directory, 'state'),
      external: cliExternal,
      journal: '1',
    })
    await expect(waitExit(runtime.child, 20_000)).resolves.toEqual({ code: 1, signal: null })

    expect(runtime.stderr()).toContain('writer lease журнала сессий недоступен (held-by-another-process)')
    expect(lines(cliExternal)).toEqual([])
    holder.kill('SIGTERM')
    await expect(waitExit(holder)).resolves.toEqual({ code: 0, signal: null })
  }, 35_000)

  it('keeps exact AISY_SESSION_JOURNAL=0 as an explicit live rollback', async () => {
    const directory = root()
    const base = join(directory, 'home')
    const journal = join(base, 'journal')
    const external = join(directory, 'external.log')
    mkdirSync(journal, { recursive: true, mode: 0o700 })
    mkdirSync(join(journal, TRANSCRIPT_WRITER_LOCK_DIRNAME), { mode: 0o700 })

    const runtime = startAisy({
      base,
      state: join(directory, 'state'),
      external,
      journal: '0',
    })
    await waitForExternalOrExit(runtime, external)
    runtime.child.kill('SIGTERM')
    await waitExit(runtime.child, 10_000)

    expect(lines(external).some((line) => line.includes('fetch'))).toBe(true)
  }, 35_000)

  it('keeps setup-only Telegram outside the full-runtime transcript lease', async () => {
    const directory = root()
    const base = join(directory, 'home')
    const journal = join(base, 'journal')
    const external = join(directory, 'external.log')
    mkdirSync(journal, { recursive: true, mode: 0o700 })
    mkdirSync(join(journal, TRANSCRIPT_WRITER_LOCK_DIRNAME), { mode: 0o700 })

    const runtime = startAisy({
      base,
      state: join(directory, 'state'),
      external,
      journal: '1',
      mode: 'setup',
    })
    await waitForExternalOrExit(runtime, external)
    runtime.child.kill('SIGTERM')
    await waitExit(runtime.child, 10_000)

    expect(runtime.stderr()).not.toContain('writer lease журнала сессий недоступен')
    expect(lines(external).some((line) => line.includes('fetch'))).toBe(true)
  }, 35_000)
})
