import { createHash } from 'node:crypto'
import { spawn as spawnNode } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CLAUDE_CODE_PROTOCOL_PROFILE } from './claude-auth.js'
import { buildClaudeCodeRunArgs } from './claude-code-driver.js'
import {
  CLAUDE_CODE_MANAGED_POLICY_SHA256,
  ClaudeCodeSessionStoreError,
  makeNodeClaudeCodeProcessPort,
  makeNodeClaudeCodeTerminationSupervisorPort,
  makeSecureClaudeAuthProcessPort,
  makeSqliteClaudeCodeSessionStore,
  type ClaudeCodeExecPort,
  type ClaudeCodeNodeConfig,
  type ClaudeCodeSpawnPort,
} from './claude-code-node.js'

const UPSTREAM = '00000000-0000-4000-8000-000000000001'
const OPERATION_1 = '00000000-0000-4000-8000-000000000002'
const OPERATION_2 = '00000000-0000-4000-8000-000000000003'
const UPSTREAM_2 = '00000000-0000-4000-8000-000000000004'
const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class FakeChild extends EventEmitter {
  readonly pid = 4242
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-claude-')))
  roots.push(root)
  chmodSync(root, 0o700)
  const executable = join(root, 'claude-pinned')
  const executableBody = '#!/bin/sh\nexit 0\n'
  writeFileSync(executable, executableBody, { mode: 0o700 })
  chmodSync(executable, 0o700)
  const digest = createHash('sha256').update(executableBody).digest('hex')
  const cwd = join(root, 'project')
  const configDir = join(root, 'profile')
  const runtimeDir = join(root, 'runtime')
  mkdirSync(cwd, { mode: 0o700 })
  mkdirSync(configDir, { mode: 0o700 })
  mkdirSync(runtimeDir, { mode: 0o700 })
  const child = new FakeChild()
  const spawns: Array<{
    command: string
    args: readonly string[]
    options: Parameters<ClaudeCodeSpawnPort['spawn']>[2]
  }> = []
  const spawnPort: ClaudeCodeSpawnPort = {
    spawn(command, args, options) {
      spawns.push({ command, args, options })
      return child as ReturnType<ClaudeCodeSpawnPort['spawn']>
    },
  }
  const config: ClaudeCodeNodeConfig = {
    executable: { path: executable, sha256: digest },
    trust: { approved: true, fingerprint: digest },
    isolationPolicy: { kind: 'managed-policy', sha256: CLAUDE_CODE_MANAGED_POLICY_SHA256 },
    cwd,
    configDir,
    runtimeDir,
    environment: { HOME: root, LANG: 'C.UTF-8', UNSAFE_PARENT_VALUE: 'drop-me' },
    wallTimeoutMs: 5_000,
    idleTimeoutMs: 2_000,
    killGraceMs: 20,
    spawnPort,
  }
  return { root, executable, digest, cwd, configDir, runtimeDir, child, spawns, config }
}

function args(resume = false): readonly string[] {
  const value = buildClaudeCodeRunArgs({
    capabilityProfile: 'smoke-readonly',
    model: 'claude-sonnet-4-5',
    upstreamSessionId: UPSTREAM,
    resume,
  })
  if (value instanceof Error) throw value
  return value
}

describe('Claude Code Node boundary', () => {
  it('keeps the preview unavailable before spawn without a code-owned isolation runtime', async () => {
    const h = fixture()
    await expect(makeNodeClaudeCodeProcessPort(h.config).start({
      args: args(), stdin: 'hello', cwd: h.cwd, configDir: h.configDir,
    })).rejects.toMatchObject({ code: 'CLAUDE_ISOLATION_FAILED' })
    expect(h.spawns).toHaveLength(0)
    expect(readdirSync(h.runtimeDir)).toEqual([])
  })

  it('recomputes the exact hash and requires matching operator trust', async () => {
    const wrongHash = fixture()
    wrongHash.config.executable.sha256 = '0'.repeat(64)
    await expect(makeNodeClaudeCodeProcessPort(wrongHash.config).start({
      args: args(), stdin: 'hello', cwd: wrongHash.cwd, configDir: wrongHash.configDir,
    })).rejects.toMatchObject({ code: 'CLAUDE_ISOLATION_FAILED' })
    expect(wrongHash.spawns).toHaveLength(0)

    const changed = fixture()
    const port = makeNodeClaudeCodeProcessPort(changed.config)
    writeFileSync(changed.executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    await expect(port.start({
      args: args(), stdin: 'hello', cwd: changed.cwd, configDir: changed.configDir,
    })).rejects.toMatchObject({ code: 'CLAUDE_ISOLATION_FAILED' })
    expect(changed.spawns).toHaveLength(0)

    const untrusted = fixture()
    untrusted.config.trust = { approved: true, fingerprint: 'f'.repeat(64) }
    await expect(makeNodeClaudeCodeProcessPort(untrusted.config).start({
      args: args(), stdin: 'hello', cwd: untrusted.cwd, configDir: untrusted.configDir,
    })).rejects.toMatchObject({ code: 'CLAUDE_ISOLATION_FAILED' })

  })

  it('rejects an unknown policy digest before spawn', async () => {
    const unknownPolicy = fixture()
    unknownPolicy.config.isolationPolicy = {
      kind: 'managed-policy',
      sha256: 'a'.repeat(64),
    }
    await expect(makeNodeClaudeCodeProcessPort(unknownPolicy.config).start({
      args: args(), stdin: 'hello', cwd: unknownPolicy.cwd, configDir: unknownPolicy.configDir,
    })).rejects.toMatchObject({ code: 'CLAUDE_ISOLATION_FAILED' })
    expect(unknownPolicy.spawns).toHaveLength(0)

  })

  it('rejects argument drift before any staging or process I/O', async () => {
    const drift = fixture()
    await expect(makeNodeClaudeCodeProcessPort(drift.config).start({
      args: [...args(), '--argument-drift'], stdin: 'hello', cwd: drift.cwd, configDir: drift.configDir,
    })).rejects.toMatchObject({ code: 'CLAUDE_ISOLATION_FAILED' })
    expect(drift.spawns).toHaveLength(0)

  })

  it.runIf(process.platform !== 'win32')(
    'signals and verifies the exact process group of a real Node child',
    async () => {
      const child = spawnNode(process.execPath, ['-e', [
        "process.on('SIGTERM', () => {})",
        "process.stdout.write('ready')",
        'setInterval(() => {}, 1_000)',
      ].join(';')], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      if (child.stdout === null) throw new Error('missing child stdout')
      const ready = once(child.stdout, 'data')
      await once(child, 'spawn')
      await ready
      const pid = child.pid
      if (pid === undefined) throw new Error('missing child pid')
      const closed = once(child, 'close')
      const supervisor = makeNodeClaudeCodeTerminationSupervisorPort()
      try {
        await expect(supervisor.terminateAndVerify({
          pid,
          processGroupId: pid,
          executableSha256: 'a'.repeat(64),
          stagedSha256: 'a'.repeat(64),
          termSignal: 'SIGTERM',
          killSignal: 'SIGKILL',
          termGraceMs: 20,
          confirmationTimeoutMs: 2_000,
        })).resolves.toEqual({ kind: 'aisy-claude-termination-receipt-v1' })
        await closed
        expect(() => { process.kill(pid, 0) }).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        expect(() => { process.kill(-pid, 0) }).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      } finally {
        try { process.kill(-pid, 'SIGKILL') } catch { /* already absent */ }
        await closed
      }
    },
  )

  it.runIf(process.platform !== 'win32')(
    'rejects a mismatched process group without signaling a real Node child',
    async () => {
      const child = spawnNode(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
        detached: true,
        stdio: 'ignore',
      })
      await once(child, 'spawn')
      const pid = child.pid
      if (pid === undefined) throw new Error('missing child pid')
      const closed = once(child, 'close')
      try {
        await expect(makeNodeClaudeCodeTerminationSupervisorPort().terminateAndVerify({
          pid,
          processGroupId: pid + 1,
          executableSha256: 'a'.repeat(64),
          stagedSha256: 'a'.repeat(64),
          termSignal: 'SIGTERM',
          killSignal: 'SIGKILL',
          termGraceMs: 20,
          confirmationTimeoutMs: 100,
        })).rejects.toMatchObject({ code: 'CLAUDE_TERMINATION_UNCONFIRMED' })
        expect(() => { process.kill(pid, 0) }).not.toThrow()
      } finally {
        try { process.kill(-pid, 'SIGKILL') } catch { /* already absent */ }
        await closed
      }
    },
  )

  it('allows only version and auth-status checks through the verified boundary', async () => {
    const h = fixture()
    const calls: Array<Parameters<ClaudeCodeExecPort['run']>> = []
    const execPort: ClaudeCodeExecPort = {
      async run(...value) {
        calls.push(value)
        return { exitCode: 0, output: '{"opaque":true}' }
      },
    }
    const port = makeSecureClaudeAuthProcessPort({ ...h.config, execPort })
    await expect(port.run('claude', ['auth', 'status']))
      .rejects.toMatchObject({ code: 'CLAUDE_ISOLATION_FAILED' })
    await expect(port.run('claude', ['auth', 'login']))
      .rejects.toMatchObject({ code: 'CLAUDE_ISOLATION_FAILED' })
    await expect(port.run('claude', ['auth', 'status', '--json']))
      .rejects.toMatchObject({ code: 'CLAUDE_ISOLATION_FAILED' })
    expect(calls).toHaveLength(0)
  })
})

function binding(input: {
  proposedUpstreamSessionId?: string
  proposedOperationId?: string
} = {}): Parameters<ReturnType<typeof makeSqliteClaudeCodeSessionStore>['beginTurn']>[0] {
  return {
    projectId: 'project-a',
    sessionId: 'session-a',
    proposedUpstreamSessionId: input.proposedUpstreamSessionId ?? UPSTREAM,
    proposedOperationId: input.proposedOperationId ?? OPERATION_1,
    protocolProfile: CLAUDE_CODE_PROTOCOL_PROFILE,
    capabilityProfile: 'smoke-readonly' as const,
    cwd: '/private/project',
    configDir: '/private/profile',
  }
}

describe('Claude Code durable session binding', () => {
  it('never begins an already completed operation, including after restart', async () => {
    const h = fixture()
    const dbPath = join(h.root, 'state', 'claude.sqlite')
    const store = makeSqliteClaudeCodeSessionStore({ dbPath })
    const first = await store.beginTurn(binding())
    await store.completeTurn(first)
    await expect(store.beginTurn(binding({ proposedUpstreamSessionId: UPSTREAM_2 })))
      .rejects.toMatchObject({ code: 'OPERATION_ALREADY_CONSUMED' })
    store.close()

    const reopened = makeSqliteClaudeCodeSessionStore({ dbPath })
    await expect(reopened.beginTurn(binding({ proposedUpstreamSessionId: UPSTREAM_2 })))
      .rejects.toMatchObject({ code: 'OPERATION_ALREADY_CONSUMED' })
    reopened.close()
  })

  it('resumes only the exact completed upstream session', async () => {
    const h = fixture()
    const dbPath = join(h.root, 'state', 'claude.sqlite')
    const store = makeSqliteClaudeCodeSessionStore({ dbPath })
    const first = await store.beginTurn(binding())
    expect(first).toMatchObject({ upstreamSessionId: UPSTREAM, resume: false })
    await store.completeTurn(first)
    store.close()

    const reopened = makeSqliteClaudeCodeSessionStore({ dbPath })
    const resumed = await reopened.beginTurn(binding({
      proposedUpstreamSessionId: UPSTREAM_2,
      proposedOperationId: OPERATION_2,
    }))
    expect(resumed).toMatchObject({
      upstreamSessionId: UPSTREAM,
      operationId: OPERATION_2,
      resume: true,
    })
    reopened.close()
  })

  it('quarantines interrupted work and requires an exact manual reset', async () => {
    const h = fixture()
    const dbPath = join(h.root, 'state', 'claude.sqlite')
    const store = makeSqliteClaudeCodeSessionStore({ dbPath })
    await store.beginTurn(binding())
    store.close()

    const reopened = makeSqliteClaudeCodeSessionStore({ dbPath })
    await expect(reopened.beginTurn(binding({
      proposedUpstreamSessionId: UPSTREAM_2,
      proposedOperationId: OPERATION_2,
    }))).rejects.toEqual(new ClaudeCodeSessionStoreError('SESSION_QUARANTINED'))
    await expect(reopened.resetQuarantined({
      projectId: 'project-a', sessionId: 'session-a', upstreamSessionId: UPSTREAM_2,
    })).rejects.toMatchObject({ code: 'SESSION_BINDING_CONFLICT' })
    await reopened.resetQuarantined({
      projectId: 'project-a', sessionId: 'session-a', upstreamSessionId: UPSTREAM,
    })
    await expect(reopened.beginTurn(binding({
      proposedUpstreamSessionId: UPSTREAM_2,
      proposedOperationId: OPERATION_2,
    }))).resolves.toMatchObject({ upstreamSessionId: UPSTREAM_2, resume: false })
    reopened.close()
  })
})
