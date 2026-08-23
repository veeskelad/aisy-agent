import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  CodexAppServerTransportError,
  makeNodeCodexAppServerSessionFactory,
  type CodexAppServerSpawnPort,
} from './codex-app-server-node.js'

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly writes: string[] = []
  killed = 0

  constructor() {
    super()
    this.stdin.on('data', chunk => { this.writes.push(String(chunk)) })
  }

  kill(): boolean {
    this.killed++
    return true
  }
}

function setup(options: { timeoutMs?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-codex-transport-')))
  const executable = join(root, 'codex')
  writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 })
  chmodSync(executable, 0o700)
  const child = new FakeChild()
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = []
  const spawnPort: CodexAppServerSpawnPort = {
    spawn(command, args, spawnOptions) {
      calls.push({ command, args, options: spawnOptions })
      return child
    },
  }
  const factory = makeNodeCodexAppServerSessionFactory({
    codexExecutable: executable,
    hostCwd: root,
    environment: {
      PATH: '/usr/bin',
      HOME: '/home/operator',
      LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'must-not-be-inherited',
      ANTHROPIC_API_KEY: 'must-not-be-inherited',
      RANDOM_PRIVATE_VALUE: 'must-not-be-inherited',
    },
    requestTimeoutMs: options.timeoutMs ?? 30_000,
    spawnPort,
  })
  return { child, calls, factory, root, executable }
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('Node Codex app-server JSONL transport', () => {
  it('spawns only the official stdio command with a sanitized environment', async () => {
    const h = setup()
    const session = await h.factory.open()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({
      command: h.executable,
      args: ['app-server', '--listen', 'stdio://'],
      options: {
        cwd: h.root,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { HOME: '/home/operator', LANG: 'en_US.UTF-8' },
      },
    })
    // The allowlist is about not leaking credentials, not about preserving PATH:
    // `codex` is a `#!/usr/bin/env node` script, so the directory of the running
    // Node binary is prepended, or the child cannot start at all under a service
    // manager. The operator's own PATH entries stay, and stay in order.
    const env = (h.calls[0]?.options as { env: Record<string, string> }).env
    expect(env['PATH']?.split(':')[0]).toBe(dirname(process.execPath))
    expect(env['PATH']?.endsWith('/usr/bin')).toBe(true)
    expect(JSON.stringify(h.calls[0])).not.toContain('must-not-be-inherited')
    await session.close()
  })

  it('correlates JSONL responses and streams notifications', async () => {
    const h = setup()
    const session = await h.factory.open()
    const response = session.request('initialize', { clientInfo: { name: 'aisy' } })
    await tick()
    const sent = JSON.parse(h.child.writes.join('').trim()) as { id: number }
    h.child.stdout.write(`${JSON.stringify({ id: sent.id, result: { userAgent: 'codex' } })}\n`)
    await expect(response).resolves.toEqual({ userAgent: 'codex' })

    const next = session.events()[Symbol.asyncIterator]().next()
    const notification = { method: 'turn/started', params: { threadId: 'thread-1' } }
    h.child.stdout.write(`${JSON.stringify(notification)}\n`)
    await expect(next).resolves.toEqual({ done: false, value: notification })
    await session.close()
  })

  it('allows exactly one event consumer per connection', async () => {
    const h = setup()
    const session = await h.factory.open()
    session.events()
    expect(() => session.events()).toThrow(
      expect.objectContaining({ code: 'PROTOCOL_VIOLATION' }),
    )
    await session.close()
  })

  it('rejects non-allowlisted client methods before writing', async () => {
    const h = setup()
    const session = await h.factory.open()
    await expect(session.request('thread/shellCommand', {})).rejects.toEqual(
      new CodexAppServerTransportError('METHOD_NOT_ALLOWED'),
    )
    await expect(session.notify('experimental/enable', {})).rejects.toEqual(
      new CodexAppServerTransportError('METHOD_NOT_ALLOWED'),
    )
    expect(h.child.writes).toEqual([])
    await session.close()
  })

  it.each([
    ['malformed JSON', '{broken\n'],
    ['non-object JSON', '[]\n'],
    ['oversized line', `${'x'.repeat(1024 * 1024 + 1)}\n`],
  ])('closes on %s without exposing raw output', async (_name, output) => {
    const h = setup()
    const session = await h.factory.open()
    const pending = session.request('initialize', {})
    await tick()
    h.child.stdout.write(output)
    await expect(pending).rejects.toMatchObject({ code: 'PROTOCOL_VIOLATION' })
    expect(h.child.killed).toBe(1)
  })

  it('closes on an unknown or replayed response id', async () => {
    const h = setup()
    const session = await h.factory.open()
    const pending = session.request('initialize', {})
    await tick()
    h.child.stdout.write(`${JSON.stringify({ id: 999, result: {} })}\n`)
    await expect(pending).rejects.toMatchObject({ code: 'PROTOCOL_VIOLATION' })
    expect(h.child.killed).toBe(1)
  })

  it('fails closed when the bounded event queue overflows', async () => {
    const h = setup()
    const session = await h.factory.open()
    const lines = Array.from({ length: 257 }, (_, id) =>
      JSON.stringify({ method: 'unknown/notification', params: { id } })).join('\n') + '\n'
    h.child.stdout.write(lines)
    await tick()
    await expect(session.request('initialize', {})).rejects.toMatchObject({
      code: 'TRANSPORT_CLOSED',
    })
    expect(h.child.killed).toBe(1)
  })

  it('times out one pending request and terminates the whole connection', async () => {
    vi.useFakeTimers()
    try {
      const h = setup({ timeoutMs: 1_000 })
      const session = await h.factory.open()
      const pending = session.request('initialize', {})
      const rejection = expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(1_000)
      await rejection
      expect(h.child.killed).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('close is idempotent, rejects pending work and ends event iteration', async () => {
    const h = setup()
    const session = await h.factory.open()
    const pending = session.request('initialize', {})
    const iterator = session.events()[Symbol.asyncIterator]()
    const next = iterator.next()
    await session.close()
    await session.close()
    await expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
    await expect(next).resolves.toEqual({ done: true, value: undefined })
    expect(h.child.killed).toBe(1)
  })

  it('rejects invalid cwd and timeout configuration before spawn', () => {
    const h = setup()
    expect(() => makeNodeCodexAppServerSessionFactory({ codexExecutable: h.executable, hostCwd: 'relative' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_TRANSPORT_CONFIG' }))
    expect(() => makeNodeCodexAppServerSessionFactory({ codexExecutable: 'codex', hostCwd: h.root }))
      .toThrow(expect.objectContaining({ code: 'INVALID_TRANSPORT_CONFIG' }))
    expect(() => makeNodeCodexAppServerSessionFactory({ codexExecutable: h.executable, hostCwd: h.root, requestTimeoutMs: 999 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_TRANSPORT_CONFIG' }))
  })

  it('rejects group-writable executable and working directory paths', () => {
    const h = setup()
    chmodSync(h.executable, 0o770)
    expect(() => makeNodeCodexAppServerSessionFactory({
      codexExecutable: h.executable,
      hostCwd: h.root,
    })).toThrow(expect.objectContaining({ code: 'INVALID_TRANSPORT_CONFIG' }))

    chmodSync(h.executable, 0o700)
    chmodSync(h.root, 0o770)
    expect(() => makeNodeCodexAppServerSessionFactory({
      codexExecutable: h.executable,
      hostCwd: h.root,
    })).toThrow(expect.objectContaining({ code: 'INVALID_TRANSPORT_CONFIG' }))
  })
})
