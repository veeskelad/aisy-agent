import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  makeRuntimeRestart,
  type RestartIntent,
} from './runtime-restart.js'

const restartFaults = vi.hoisted(() => ({
  faultAt: new Set<string>(),
  trace: null as string[] | null,
}))

vi.mock('./runtime-restart-checkpoint.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./runtime-restart-checkpoint.js')>()
  return {
    ...original,
    restartCheckpoint: (point: string) => {
      restartFaults.trace?.push(point)
      if (restartFaults.faultAt.has(point)) throw new Error(`injected restart fault: ${point}`)
    },
  }
})

const roots: string[] = []
const NOW = '2026-07-29T12:00:00Z'

function root(): string {
  const created = mkdtempSync(join(tmpdir(), 'aisy-restart-'))
  roots.push(created)
  return created
}

function statePath(): string {
  return join(root(), 'restart.json')
}

function validIntent(reason = 'плановый перезапуск'): RestartIntent {
  return { requestedAt: NOW, reason, activeTurns: 0 }
}

function writeReceipt(path: string, content: string = JSON.stringify(validIntent()) + '\n'): void {
  writeFileSync(path, content, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function restart(over: {
  path?: string
  supervised?: boolean | (() => boolean)
  activeTurns?: number | (() => number)
  authorizePlannedRestart?: (intentHash: string) => Promise<void>
  faultAt?: string[]
  trace?: string[]
} = {}) {
  const path = over.path ?? statePath()
  const exits: RestartIntent[] = []
  const deps = {
    path,
    nowIso: () => NOW,
    supervised: () => typeof over.supervised === 'function' ? over.supervised() : (over.supervised ?? true),
    activeTurns: () => typeof over.activeTurns === 'function' ? over.activeTurns() : (over.activeTurns ?? 0),
    authorizePlannedRestart: over.authorizePlannedRestart ?? (async () => undefined),
    exit: (intent: RestartIntent) => exits.push(intent),
  }
  restartFaults.faultAt = new Set(over.faultAt ?? [])
  restartFaults.trace = over.trace ?? null
  const value = makeRuntimeRestart(deps)
  return { value, exits, path }
}

afterEach(() => {
  restartFaults.faultAt.clear()
  restartFaults.trace = null
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('runtime restart (plan 11.9)', () => {
  it('durably records private JSON before asking the process to exit', async () => {
    const path = statePath()
    const order: string[] = []
    restartFaults.trace = order
    const value = makeRuntimeRestart({
      path,
      nowIso: () => NOW,
      supervised: () => true,
      activeTurns: () => 0,
      authorizePlannedRestart: async () => { order.push('permit') },
      exit: () => { order.push('exit') },
    })

    const intent = value.prepare('  обновили   конфиг  ')

    expect(intent).toMatchObject({ requestedAt: NOW, reason: 'обновили конфиг', activeTurns: 0 })
    expect(order).not.toContain('exit')
    expect(typeof intent).toBe('object')
    await expect(value.commitExit(intent as RestartIntent)).resolves.toBe('committed')
    expect(order).toEqual([
      'publish:after-open-before-stat',
      'publish:before-file-fsync',
      'publish:after-file-fsync',
      'publish:before-rename',
      'publish:after-rename',
      'publish:before-dir-fsync',
      'publish:after-dir-fsync',
      'permit',
      'exit',
    ])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      requestedAt: NOW,
      reason: 'обновили конфиг',
      activeTurns: 0,
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    expect(readdirSync(dirname(path)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('does not overwrite the durable receipt on a repeated request', async () => {
    const h = restart()
    const first = h.value.prepare('первый')

    expect(h.value.prepare('второй')).toBe(first)
    expect(h.exits).toHaveLength(0)
    await expect(h.value.commitExit(first as RestartIntent)).resolves.toBe('committed')
    await expect(h.value.commitExit(first as RestartIntent)).resolves.toBe('already-committed')
    expect(h.exits).toHaveLength(1)
    expect(JSON.parse(readFileSync(h.path, 'utf8'))).toMatchObject({ reason: 'первый' })
  })

  it('exits only for the exact prepared object and only once', async () => {
    const h = restart()
    const prepared = h.value.prepare('плановый') as RestartIntent

    await expect(h.value.commitExit({ ...prepared })).resolves.toBe('restart-state-ambiguous')
    expect(h.exits).toEqual([])
    await expect(h.value.commitExit(prepared)).resolves.toBe('committed')
    await expect(h.value.commitExit(prepared)).resolves.toBe('already-committed')
    expect(h.exits).toEqual([prepared])
  })

  it('durably cancels an unacknowledged intent and never exits', async () => {
    const h = restart()
    const prepared = h.value.prepare('не доставлено') as RestartIntent

    expect(existsSync(h.path)).toBe(true)
    expect(h.value.cancel(prepared)).toBe('cancelled')
    expect(h.value.cancel(prepared)).toBe('already-cancelled')
    await expect(h.value.commitExit(prepared)).resolves.toBe('restart-state-ambiguous')
    expect(h.exits).toEqual([])
    expect(existsSync(h.path)).toBe(false)
  })

  it('latches ambiguity and never exits when cancellation durability is unproven', async () => {
    const h = restart({ faultAt: ['cancel:before-dir-fsync'] })
    const prepared = h.value.prepare('не доставлено') as RestartIntent

    expect(h.value.cancel(prepared)).toBe('restart-state-ambiguous')
    await expect(h.value.commitExit(prepared)).resolves.toBe('restart-state-ambiguous')
    expect(h.exits).toEqual([])
  })

  it('does not exit when supervision disappears between prepare and commit', async () => {
    let supervised = true
    const h = restart({ supervised: () => supervised })
    const prepared = h.value.prepare('плановый') as RestartIntent

    supervised = false
    await expect(h.value.commitExit(prepared)).resolves.toBe('not-supervised')
    expect(h.exits).toEqual([])
    expect(existsSync(h.path)).toBe(false)
    expect(restart({ path: h.path }).value.previous()).toBeNull()
  })

  it('does not exit when the parent refuses the opaque planned-restart permit', async () => {
    const hashes: string[] = []
    const h = restart({
      authorizePlannedRestart: async (intentHash) => {
        hashes.push(intentHash)
        throw new Error('private parent detail')
      },
    })
    const prepared = h.value.prepare('плановый') as RestartIntent

    await expect(h.value.commitExit(prepared)).resolves.toBe('not-supervised')
    expect(h.exits).toEqual([])
    expect(hashes).toHaveLength(1)
    expect(hashes[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(hashes[0]).not.toContain(prepared.reason)
    expect(existsSync(h.path)).toBe(false)
    expect(restart({ path: h.path }).value.previous()).toBeNull()
  })

  it('does not exit when a turn starts between prepare and commit', async () => {
    let activeTurns = 0
    const h = restart({ activeTurns: () => activeTurns })
    const prepared = h.value.prepare('плановый') as RestartIntent

    activeTurns = 1
    await expect(h.value.commitExit(prepared)).resolves.toBe('busy')
    expect(h.exits).toEqual([])
    expect(existsSync(h.path)).toBe(false)
    expect(restart({ path: h.path }).value.previous()).toBeNull()
  })

  it('fails closed when commit-time cancellation durability is ambiguous', async () => {
    let supervised = true
    const h = restart({
      supervised: () => supervised,
      faultAt: ['cancel:before-dir-fsync'],
    })
    const prepared = h.value.prepare('плановый') as RestartIntent

    supervised = false
    await expect(h.value.commitExit(prepared)).resolves.toBe('restart-state-ambiguous')
    await expect(h.value.commitExit(prepared)).resolves.toBe('restart-state-ambiguous')
    expect(h.exits).toEqual([])
    expect(h.value.prepare('повтор')).toBe('restart-state-ambiguous')
  })

  it('latches ambiguity when the exit callback throws', async () => {
    const path = statePath()
    const value = makeRuntimeRestart({
      path,
      nowIso: () => NOW,
      supervised: () => true,
      activeTurns: () => 0,
      authorizePlannedRestart: async () => undefined,
      exit: () => { throw new Error('exit callback failed') },
    })
    const prepared = value.prepare('плановый') as RestartIntent

    await expect(value.commitExit(prepared)).resolves.toBe('restart-state-ambiguous')
    await expect(value.commitExit(prepared)).resolves.toBe('restart-state-ambiguous')
    expect(value.prepare('повтор')).toBe('restart-state-ambiguous')
  })

  it('refuses before touching disk when no supervisor would return the process', () => {
    const h = restart({ supervised: false })

    expect(h.value.prepare('перезапусти')).toBe('not-supervised')
    expect(h.exits).toEqual([])
    expect(existsSync(h.path)).toBe(false)
  })

  it('refuses before touching disk while a turn is still running', () => {
    const h = restart({ activeTurns: 1 })

    expect(h.value.prepare('перезапусти')).toBe('busy')
    expect(h.exits).toEqual([])
    expect(existsSync(h.path)).toBe(false)
  })

  it.each([
    'publish:after-open-before-stat',
    'publish:before-file-fsync',
    'publish:before-rename',
  ])('keeps running and removes its temporary after %s fails', (faultAt) => {
    const h = restart({ faultAt: [faultAt] })

    expect(h.value.prepare('перезапусти безопасно')).toBe('intent-not-durable')
    expect(h.exits).toEqual([])
    expect(existsSync(h.path)).toBe(false)
    expect(readdirSync(dirname(h.path)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('durably removes the owned final receipt when post-rename dir fsync fails', () => {
    const trace: string[] = []
    const h = restart({ faultAt: ['publish:before-dir-fsync'], trace })

    expect(h.value.prepare('перезапусти безопасно')).toBe('intent-not-durable')
    expect(h.exits).toEqual([])
    expect(existsSync(h.path)).toBe(false)
    expect(trace).toContain('publish:before-rollback-unlink')
    expect(trace).toContain('publish:before-rollback-dir-fsync')
  })

  it.each([
    'publish:before-rollback-unlink',
    'publish:before-rollback-dir-fsync',
  ])('latches ambiguity when post-rename rollback is not durably proven at %s', (rollbackFault) => {
    const h = restart({ faultAt: ['publish:before-dir-fsync', rollbackFault] })

    expect(h.value.prepare('первый')).toBe('restart-state-ambiguous')
    const bytesAfterFailure = existsSync(h.path) ? readFileSync(h.path) : null
    expect(h.value.prepare('второй')).toBe('restart-state-ambiguous')
    expect(h.exits).toEqual([])
    if (bytesAfterFailure !== null) expect(readFileSync(h.path)).toEqual(bytesAfterFailure)
    else expect(existsSync(h.path)).toBe(false)
  })

  it('consumes and exposes a restart receipt exactly once after durable rename', () => {
    const path = statePath()
    restart({ path }).value.prepare('плановый перезапуск')

    const trace: string[] = []
    const next = restart({ path, trace })
    expect(next.value.previous()).toMatchObject({ reason: 'плановый перезапуск' })
    expect(trace).toEqual([
      'consume:before-rename',
      'consume:after-rename',
      'consume:before-dir-fsync',
      'consume:after-dir-fsync',
    ])
    expect(existsSync(path)).toBe(false)
    expect(statSync(`${path}.previous`).mode & 0o777).toBe(0o600)

    expect(restart({ path }).value.previous()).toBeNull()
  })

  it('does not expose previous when consume fsync fails and durably rolls it back', () => {
    const path = statePath()
    restart({ path }).value.prepare('плановый перезапуск')

    const failed = restart({ path, faultAt: ['consume:before-dir-fsync'] })
    expect(failed.value.previous()).toBeNull()
    expect(existsSync(path)).toBe(true)

    expect(restart({ path }).value.previous()).toMatchObject({ reason: 'плановый перезапуск' })
  })

  it('latches ambiguity and exposes nothing when consume rollback is not durable', () => {
    const path = statePath()
    restart({ path }).value.prepare('плановый перезапуск')

    const failed = restart({
      path,
      faultAt: ['consume:before-dir-fsync', 'consume:before-rollback-dir-fsync'],
    })
    expect(failed.value.previous()).toBeNull()
    expect(failed.value.prepare('ещё раз')).toBe('restart-state-ambiguous')
    expect(failed.exits).toEqual([])
  })

  it('safely consumes malformed private JSON without exposing it', () => {
    const path = statePath()
    writeReceipt(path, 'не json')

    const h = restart({ path })
    expect(h.value.previous()).toBeNull()
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(`${path}.previous`, 'utf8')).toBe('не json')
  })

  it('fatally rejects invalid UTF-8 instead of decoding replacement characters', () => {
    const path = statePath()
    writeFileSync(path, Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]), { mode: 0o600 })
    chmodSync(path, 0o600)

    const h = restart({ path })
    expect(h.value.previous()).toBeNull()
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(`${path}.previous`)).toEqual(Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]))
  })

  it.each([
    ['extra field', { ...validIntent(), extra: true }],
    ['invalid activeTurns', { ...validIntent(), activeTurns: -1 }],
    ['unnormalized reason', { ...validIntent(), reason: 'two  spaces' }],
    ['non-canonical timestamp', { ...validIntent(), requestedAt: '2026-07-29 12:00:00Z' }],
  ])('consumes but does not expose a receipt with %s', (_kind, receipt) => {
    const path = statePath()
    writeReceipt(path, JSON.stringify(receipt) + '\n')

    const h = restart({ path })
    expect(h.value.previous()).toBeNull()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.previous`)).toBe(true)
  })

  it('fails closed on a symlink parent without touching its target', () => {
    const outer = root()
    const linked = join(outer, 'linked')
    writeFileSync(join(outer, 'keep'), 'unchanged')
    // Use a real directory target with permissive defaults; it must not be
    // chmodded through the symlink.
    const targetRoot = mkdtempSync(join(outer, 'target-'))
    symlinkSync(targetRoot, linked, 'dir')

    const h = restart({ path: join(linked, 'restart.json') })
    expect(h.value.prepare('перезапусти')).toBe('restart-state-ambiguous')
    expect(h.exits).toEqual([])
    expect(existsSync(join(targetRoot, 'restart.json'))).toBe(false)
  })

  it('fails closed on a symlink receipt and never reads or overwrites its target', () => {
    const path = statePath()
    const target = join(dirname(path), 'target.json')
    writeReceipt(target, 'sensitive but not a receipt')
    symlinkSync(target, path)

    const h = restart({ path })
    expect(h.value.previous()).toBeNull()
    expect(h.value.prepare('перезапусти')).toBe('restart-state-ambiguous')
    expect(readFileSync(target, 'utf8')).toBe('sensitive but not a receipt')
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
  })

  it.each([
    ['permissive', (path: string) => { writeReceipt(path); chmodSync(path, 0o644) }],
    ['hard-linked', (path: string) => { writeReceipt(path); linkSync(path, `${path}.link`) }],
    ['oversized', (path: string) => { writeReceipt(path, 'x'.repeat(4097)) }],
  ] as const)('fails closed on a %s receipt', (_kind, arrange) => {
    const path = statePath()
    arrange(path)

    const h = restart({ path })
    expect(h.value.previous()).toBeNull()
    expect(h.value.prepare('перезапусти')).toBe('restart-state-ambiguous')
    expect(h.exits).toEqual([])
    expect(existsSync(path)).toBe(true)
  })

  it('substitutes a reason rather than storing an empty one', () => {
    const h = restart()
    expect(h.value.prepare('   ')).toMatchObject({ reason: 'по просьбе оператора' })
  })
})
