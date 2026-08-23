import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import type {
  CodexAppServerSpawnPort,
  CodexAuthProcessPort,
  ModelProgressEvent,
} from '@aisy/core'
import { describe, expect, it } from 'vitest'

import { makeNodeCodexReadOnlyRuntime } from './codex-read-only-runtime.js'

class ProtocolChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly methods: string[] = []
  private buffered = ''

  constructor(private readonly reply: string) {
    super()
    this.stdin.on('data', chunk => {
      this.buffered += String(chunk)
      while (true) {
        const newline = this.buffered.indexOf('\n')
        if (newline < 0) break
        const line = this.buffered.slice(0, newline)
        this.buffered = this.buffered.slice(newline + 1)
        const message = JSON.parse(line) as { id?: number; method: string }
        this.methods.push(message.method)
        if (message.id === undefined) continue
        let result: unknown = {}
        if (message.method === 'thread/start' || message.method === 'thread/resume') {
          result = { thread: { id: 'codex-thread-1' } }
        } else if (message.method === 'turn/start') {
          result = { turn: { id: 'codex-turn-1', status: 'inProgress' } }
        }
        this.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`)
        if (message.method === 'turn/start') {
          setImmediate(() => {
            this.stdout.write(`${JSON.stringify({
              method: 'item/agentMessage/delta',
              params: {
                threadId: 'codex-thread-1', turnId: 'codex-turn-1',
                itemId: 'message-1', delta: this.reply,
              },
            })}\n`)
            this.stdout.write(`${JSON.stringify({
              method: 'turn/completed',
              params: {
                threadId: 'codex-thread-1',
                turn: { id: 'codex-turn-1', status: 'completed', items: [] },
              },
            })}\n`)
          })
        }
      }
    })
  }

  kill(): boolean { return true }
}

const authProcessPort: CodexAuthProcessPort = {
  run: async (_command, args) => exact(args, ['--version'])
    ? { exitCode: 0, output: 'codex-cli 0.144.5' }
    : { exitCode: 0, output: '' },
  start: () => ({ completed: Promise.resolve({ exitCode: 1 }), stop: () => {} }),
}

function exact(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

describe('Node Codex read-only app composition', () => {
  it('resumes the same durable thread after rebuilding the app-level runtime', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-app-codex-')))
    const projectRoot = join(root, 'project-a')
    mkdirSync(projectRoot, { mode: 0o700 })
    const executable = join(root, 'codex')
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 })
    chmodSync(executable, 0o700)
    const threadDbPath = join(root, 'codex-threads.sqlite')

    const run = async (reply: string) => {
      const child = new ProtocolChild(reply)
      const spawnPort: CodexAppServerSpawnPort = { spawn: () => child }
      const runtime = makeNodeCodexReadOnlyRuntime({
        codexExecutable: executable,
        hostCwd: root,
        threadDbPath,
        model: 'gpt-5.4',
        projectRoot: projectId => projectId === 'project-a' ? projectRoot : null,
        environment: { HOME: root, PATH: '/usr/bin' },
        authProcessPort,
        spawnPort,
      })
      const events: ModelProgressEvent[] = []
      const result = await runtime.provider('project-a').complete({
        sessionId: 'session-a',
        prefixBytes: new Uint8Array(),
        spans: [{ role: 'user', provenance: 'operator', text: 'inspect' }],
      }, new AbortController().signal, event => { events.push(event) })
      runtime.close()
      runtime.close()
      return { child, events, result }
    }

    const first = await run('first')
    expect(first.child.methods).toEqual([
      'initialize', 'initialized', 'thread/start', 'turn/start',
    ])
    expect(first.events).toEqual([
      { type: 'started' },
      { type: 'text-delta', text: 'first' },
    ])
    expect(first.result).toEqual({ reply: 'first' })

    const restarted = await run('second')
    expect(restarted.child.methods).toEqual([
      'initialize', 'initialized', 'thread/resume', 'turn/start',
    ])
    expect(restarted.events).toEqual([
      { type: 'started' },
      { type: 'text-delta', text: 'second' },
    ])
    expect(restarted.result).toEqual({ reply: 'second' })
  })

  it('rejects invalid config before creating the durable store', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-app-codex-invalid-')))
    const executable = join(root, 'codex')
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 })
    chmodSync(executable, 0o700)
    const threadDbPath = join(root, 'codex-threads.sqlite')

    expect(() => makeNodeCodexReadOnlyRuntime({
      codexExecutable: executable,
      hostCwd: root,
      threadDbPath,
      model: '../invalid',
      projectRoot: () => root,
      authProcessPort,
    })).toThrow('INVALID_CODEX_RUNTIME_CONFIG')
    expect(existsSync(threadDbPath)).toBe(false)
  })
})
