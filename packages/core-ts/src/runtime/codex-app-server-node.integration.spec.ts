import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import type { BrainEvent } from '../onboarding/brain-connections.js'
import type { CodexSubscriptionAuth } from './codex-auth.js'
import { makeCodexAppServerReadOnlyDriver } from './codex-app-server-driver.js'
import {
  makeNodeCodexAppServerSessionFactory,
  type CodexAppServerSpawnPort,
} from './codex-app-server-node.js'
import { makeSqliteCodexThreadStore } from './sqlite-codex-thread-store.js'

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

const auth: CodexSubscriptionAuth = {
  detect: async () => ({ installed: true, version: 'codex-cli 0.144.5' }),
  beginAuth: async () => ({
    kind: 'device-code', verificationUri: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-1234',
  }),
  validate: async () => ({ ok: true, safeDetail: 'ready' }),
  revoke: async () => ({ ok: true, safeDetail: 'revoked' }),
}

describe('Codex app-server Node composition', () => {
  it('streams over JSONL and resumes the exact durable thread after restart', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-codex-composition-')))
    const projectRoot = join(root, 'project-a')
    mkdirSync(projectRoot, { mode: 0o700 })
    const codexExecutable = join(root, 'codex')
    writeFileSync(codexExecutable, '#!/bin/sh\n', { mode: 0o700 })
    chmodSync(codexExecutable, 0o700)
    const dbPath = join(root, 'codex-threads.sqlite')

    const run = async (reply: string) => {
      const child = new ProtocolChild(reply)
      const spawnPort: CodexAppServerSpawnPort = { spawn: () => child }
      const store = makeSqliteCodexThreadStore({ dbPath })
      const driver = makeCodexAppServerReadOnlyDriver({
        auth,
        sessions: makeNodeCodexAppServerSessionFactory({
          codexExecutable, hostCwd: root, spawnPort,
          environment: { HOME: root, PATH: '/usr/bin' },
        }),
        threads: store,
        model: 'gpt-5.4',
        projectRoot: projectId => projectId === 'project-a' ? projectRoot : null,
      })
      const events: BrainEvent[] = []
      for await (const event of driver.run({
        projectId: 'project-a',
        sessionId: 'session-a',
        request: {
          sessionId: 'session-a', prefixBytes: new Uint8Array(),
          spans: [{ role: 'user', provenance: 'operator', text: 'inspect' }],
        },
      }, new AbortController().signal)) events.push(event)
      store.close()
      return { child, events }
    }

    const first = await run('first')
    expect(first.child.methods).toEqual([
      'initialize', 'initialized', 'thread/start', 'turn/start',
    ])
    expect(first.events.at(-1)).toEqual({ type: 'completed', reply: 'first' })

    const restarted = await run('second')
    expect(restarted.child.methods).toEqual([
      'initialize', 'initialized', 'thread/resume', 'turn/start',
    ])
    expect(restarted.events.at(-1)).toEqual({ type: 'completed', reply: 'second' })
  })
})
