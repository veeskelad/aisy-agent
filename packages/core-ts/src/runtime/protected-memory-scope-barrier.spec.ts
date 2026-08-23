import { once } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { makeContextLeaseCoordinator } from './context-lease.js'
import {
  makeProtectedMemoryScopeBarrier,
  ProtectedMemoryScopeBarrierError,
} from './protected-memory-scope-barrier.js'
import type { ProtectedMemoryScope } from './protected-memory-publication.js'

const roots: string[] = []
const children: ChildProcess[] = []
const scope: ProtectedMemoryScope = {
  kind: 'project',
  scopeId: 'project:project-a',
  projectId: 'project-a',
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-scope-barrier-')))
  roots.push(root)
  const projectRoot = join(root, 'project')
  mkdirSync(projectRoot, { mode: 0o700 })
  const lockPath = join(root, 'locks', 'project-a.sqlite')
  let nonce = 0
  const barrier = makeProtectedMemoryScopeBarrier({
    lockPath,
    operatorId: 'telegram:42',
    profileId: 'default',
    scope,
    nowIso: () => '2026-07-27T05:00:00.000Z',
    newNonce: () => `nonce-${++nonce}`,
    pid: 42,
  })
  let leaseId = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++leaseId}` })
  const lease = leases.acquire({
    operatorId: 'telegram:42',
    profileId: 'default',
    projectId: 'project-a',
    projectKind: 'project',
    sessionId: 'session-a',
    root: projectRoot,
    generation: 4,
  })
  return { barrier, lease, leases, lockPath, projectRoot, root }
}

async function waitForLine(child: ChildProcess, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('child timeout')), 5_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.stdout?.once('data', (data: Buffer) => {
      clearTimeout(timeout)
      if (data.toString('utf8').trim() !== expected) reject(new Error('unexpected child output'))
      else resolve()
    })
  })
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('protected memory cross-process scope barrier', () => {
  it('releases ownership after success and callback failure', async () => {
    const h = fixture()
    await expect(h.barrier.withScopeExclusive(h.lease, scope, async () => 'done'))
      .resolves.toBe('done')
    await expect(h.barrier.withScopeExclusive(h.lease, scope, async () => {
      throw new Error('operation failed')
    })).rejects.toThrow('operation failed')
    await expect(h.barrier.withScopeExclusive(h.lease, scope, async () => 'recovered'))
      .resolves.toBe('recovered')
  })

  it('binds the physical barrier to exact owner, profile and scope', async () => {
    const h = fixture()
    const otherLease = h.leases.acquire({
      operatorId: 'telegram:99',
      profileId: h.lease.profileId,
      projectId: h.lease.projectId,
      projectKind: h.lease.projectKind,
      sessionId: h.lease.sessionId,
      root: h.lease.root,
      generation: h.lease.generation,
    })
    await expect(h.barrier.withScopeExclusive(otherLease, scope, async () => undefined))
      .rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
    expect(() => makeProtectedMemoryScopeBarrier({
      lockPath: h.lockPath,
      operatorId: 'telegram:42',
      profileId: 'other-profile',
      scope,
    })).toThrowError(ProtectedMemoryScopeBarrierError)
  })

  it('fails fast under live contention and reacquires after the holder is killed', async () => {
    const h = fixture()
    const script = [
      "const Database = require('better-sqlite3')",
      'const db = new Database(process.argv[1], { timeout: 0 })',
      "db.pragma('busy_timeout = 0')",
      "db.exec('BEGIN IMMEDIATE')",
      "process.stdout.write('locked\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const child = spawn(process.execPath, ['-e', script, h.lockPath], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    await waitForLine(child, 'locked')

    await expect(h.barrier.withScopeExclusive(h.lease, scope, async () => undefined))
      .rejects.toMatchObject({ code: 'SCOPE_BUSY' })

    child.kill('SIGKILL')
    await once(child, 'exit')
    children.splice(children.indexOf(child), 1)
    await expect(h.barrier.withScopeExclusive(h.lease, scope, async () => 'after-crash'))
      .resolves.toBe('after-crash')
  })

  it('revalidates the lock path before every acquisition', async () => {
    const h = fixture()
    const outside = join(h.root, 'outside.sqlite')
    writeFileSync(outside, 'not a barrier', { mode: 0o600 })
    rmSync(h.lockPath)
    symlinkSync(outside, h.lockPath)

    await expect(h.barrier.withScopeExclusive(h.lease, scope, async () => undefined))
      .rejects.toMatchObject({ code: 'UNSAFE_PATH' })
  })
})
