import { EventEmitter } from 'node:events'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import {
  readProviderActionEvidence,
  readProviderToolExecutions,
  type CodexAppServerSpawnPort,
  type CodexAuthProcessPort,
  type ModelProgressEvent,
} from '@aisy/core'
import { describe, expect, it, vi } from 'vitest'

import {
  codexSubscriptionEnvironment,
  makeNodeCodexSubscriptionRuntime,
  makeRefreshingNodeCodexAuthProcessPort,
} from './codex-subscription-runtime.js'

class FakeCodexChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: Array<{ method: string; id?: number; params: Record<string, unknown> }> = []
  bridgeResult: unknown = null
  killed = 0
  private buffered = ''
  private readonly toolName: string
  private readonly toolArgs: Record<string, unknown>

  constructor(input: {
    toolName?: string
    toolArgs?: Record<string, unknown>
  } = {}) {
    super()
    this.toolName = input.toolName ?? 'read_file'
    this.toolArgs = input.toolArgs ?? { path: 'README.md' }
    this.stdin.on('data', chunk => {
      this.buffered += String(chunk)
      while (this.buffered.includes('\n')) {
        const index = this.buffered.indexOf('\n')
        const line = this.buffered.slice(0, index)
        this.buffered = this.buffered.slice(index + 1)
        if (line !== '') void this.handle(JSON.parse(line) as {
          method: string
          id?: number
          params: Record<string, unknown>
        })
      }
    })
  }

  private respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`)
  }

  private async handle(request: {
    method: string
    id?: number
    params: Record<string, unknown>
  }): Promise<void> {
    this.requests.push(structuredClone(request))
    if (request.id === undefined) return
    if (request.method === 'initialize') {
      this.respond(request.id, {})
      return
    }
    if (request.method === 'thread/start') {
      this.respond(request.id, { thread: { id: 'thread-live' } })
      return
    }
    if (request.method === 'turn/start') {
      this.respond(request.id, { turn: { id: 'turn-live' } })
      setImmediate(() => { void this.executeAisyTool() })
      return
    }
    if (request.method === 'turn/interrupt') this.respond(request.id, {})
  }

  private async executeAisyTool(): Promise<void> {
    const started = this.requests.find(request => request.method === 'thread/start')
    const config = started?.params['config'] as {
      mcp_servers?: { aisy?: { url?: unknown; http_headers?: { authorization?: unknown } } }
    }
    const server = config?.mcp_servers?.aisy
    if (typeof server?.url !== 'string' || typeof server.http_headers?.authorization !== 'string') {
      throw new Error('missing bridge config')
    }
    const args = this.toolArgs
    const response = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: server.http_headers.authorization,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 41, method: 'tools/call',
        params: {
          name: this.toolName, arguments: args,
          _meta: {
            'x-codex-turn-metadata': {
              session_id: 'thread-live', thread_id: 'thread-live', turn_id: 'turn-live',
            },
          },
        },
      }),
    })
    this.bridgeResult = await response.json()
    this.stdout.write(`${JSON.stringify({
      method: 'item/started',
      params: {
        threadId: 'thread-live', turnId: 'turn-live',
        item: {
          id: 'tool-live', type: 'mcpToolCall', server: 'aisy', tool: this.toolName,
          arguments: args, status: 'inProgress',
        },
      },
    })}\n`)
    this.stdout.write(`${JSON.stringify({
      method: 'item/completed',
      params: {
        threadId: 'thread-live', turnId: 'turn-live',
        item: {
          id: 'tool-live', type: 'mcpToolCall', server: 'aisy', tool: this.toolName,
          arguments: args, status: 'completed',
        },
      },
    })}\n`)
    this.stdout.write(`${JSON.stringify({
      method: 'item/completed',
      params: {
        threadId: 'thread-live', turnId: 'turn-live',
        item: { id: 'answer-live', type: 'agentMessage', text: 'Готово' },
      },
    })}\n`)
    this.stdout.write(`${JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-live', turn: { id: 'turn-live', status: 'completed' } },
    })}\n`)
  }

  kill(): boolean {
    this.killed++
    return true
  }
}

function readyAuth(): CodexAuthProcessPort {
  return {
    run: async (_command, args) => args[0] === '--version'
      ? { exitCode: 0, output: 'codex-cli 0.144.5' }
      : { exitCode: 0, output: 'logged in' },
    start: () => ({ completed: Promise.resolve({ exitCode: 0 }), stop: () => {} }),
  }
}

function fixture(input: {
  toolName?: string
  toolArgs?: Record<string, unknown>
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-codex-subscription-')))
  const executable = join(root, 'codex')
  writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 })
  chmodSync(executable, 0o700)
  const codexHome = join(root, 'codex-home')
  const child = new FakeCodexChild(input)
  const spawns: Array<{
    command: string
    options: { cwd: string; env: Readonly<Record<string, string>> }
  }> = []
  const spawnPort: CodexAppServerSpawnPort = {
    spawn(command, _args, options) {
      spawns.push({ command, options })
      return child
    },
  }
  const runtime = makeNodeCodexSubscriptionRuntime({
    codexExecutable: executable,
    codexHome,
    threadDbPath: join(root, 'threads.sqlite'),
    environment: { PATH: '/usr/bin', HOME: root, PRIVATE_TOKEN: 'must-not-leak' },
    projectRoot: projectId => projectId === 'project-a' ? root : null,
    authProcessPort: readyAuth(),
    spawnPort,
  })
  return { root, executable, codexHome, child, spawns, runtime }
}

describe('live Codex subscription runtime', () => {
  it('runs one exact Aisy tool over the per-turn bridge and keeps native tools disabled', async () => {
    const h = fixture()
    const invoked = vi.fn(async (
      _call: { name: string; args: Record<string, unknown> },
      _signal: AbortSignal,
      _context: { sessionId: string; turnId?: string; ordinal?: number },
    ) => ({ text: 'project read', isError: false }))
    const progress: ModelProgressEvent[] = []
    const tools = [{
      name: 'read_file', description: 'Read a project file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    }]
    const providerConfig = {
      projectId: 'project-a',
      tools,
      invokeTool: invoked,
    }
    const provider = h.runtime.provider(providerConfig)
    tools[0]!.name = 'mutated_after_validation'
    providerConfig.invokeTool = vi.fn(async (
      _call: { name: string; args: Record<string, unknown> },
      _signal: AbortSignal,
      _context: { sessionId: string; turnId?: string; ordinal?: number },
    ) => ({ text: 'wrong executor', isError: true }))

    const response = await provider.complete({
      sessionId: 'session-a', turnId: 'operator-turn-a', prefixBytes: new Uint8Array(),
      toolOrdinalBase: 4,
      spans: [{ role: 'user', provenance: 'operator', text: 'Прочитай README' }],
    }, undefined, event => { progress.push(event) })
    expect(response).toMatchObject({ reply: 'Готово' })
    expect(readProviderActionEvidence(response)).toEqual([{
      tool: 'read_file', family: 'inspect', successful: true, receipt: false,
    }])
    expect(readProviderToolExecutions(response)).toEqual([{
      call: { name: 'read_file', args: { path: 'README.md' } },
      context: { sessionId: 'session-a', turnId: 'operator-turn-a', ordinal: 5 },
      result: { ok: true, output: 'project read' },
    }])

    expect(invoked).toHaveBeenCalledWith(
      { name: 'read_file', args: { path: 'README.md' } },
      expect.any(AbortSignal),
      { sessionId: 'session-a', turnId: 'operator-turn-a', ordinal: 5 },
    )
    expect(Object.isFrozen(invoked.mock.calls[0]?.[2])).toBe(true)
    expect(progress).toContainEqual({
      type: 'tool-requested', toolCallId: 'tool-live', name: 'read_file',
      args: { path: 'README.md' },
    })
    expect(progress).toContainEqual({
      type: 'tool-result', toolCallId: 'tool-live', result: 'CAPABILITY_COMPLETED',
    })
    expect(h.child.bridgeResult).toMatchObject({
      result: { content: [{ text: 'project read' }], isError: false },
    })
    const start = h.child.requests.find(request => request.method === 'thread/start')
    expect(start?.params).toMatchObject({
      approvalPolicy: 'never', sandbox: 'read-only',
      cwd: join(h.codexHome, 'empty-workspace'),
      config: { features: { shell_tool: false, unified_exec: false }, web_search: 'disabled' },
    })
    expect(start?.params).not.toHaveProperty('model')
    expect(h.spawns[0]?.options.env['CODEX_HOME']).toBe(h.codexHome)
    expect(h.spawns[0]?.options.cwd).toBe(join(h.codexHome, 'empty-workspace'))
    expect(JSON.stringify(h.spawns)).not.toContain('must-not-leak')
    h.runtime.close()
  })

  it('attaches a failed execution when a Codex-side tool handler throws', async () => {
    const h = fixture()
    const provider = h.runtime.provider({
      projectId: 'project-a',
      tools: [{
        name: 'read_file', description: 'Read a project file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      }],
      invokeTool: async () => { throw new Error('ambiguous tool failure') },
    })

    const response = await provider.complete({
      sessionId: 'session-a', turnId: 'operator-turn-a', prefixBytes: new Uint8Array(),
      spans: [{ role: 'user', provenance: 'operator', text: 'Прочитай README' }],
    })

    expect(readProviderToolExecutions(response)).toEqual([{
      call: { name: 'read_file', args: { path: 'README.md' } },
      context: { sessionId: 'session-a', turnId: 'operator-turn-a', ordinal: 1 },
      result: { ok: false, output: 'TOOL_EXECUTION_FAILED' },
    }])
    expect(readProviderActionEvidence(response)).toEqual([{
      tool: 'read_file', family: 'inspect', successful: false, receipt: false,
    }])
    h.runtime.close()
  })

  it('keeps exact policy operation evidence after a subscription mutation', async () => {
    const args = {
      operation: 'policy.tighten-project', target: 'current', value: 'read-only',
    }
    const h = fixture({ toolName: 'configure_agent', toolArgs: args })
    const provider = h.runtime.provider({
      projectId: 'project-a',
      tools: [{
        name: 'configure_agent', description: 'Configure Aisy',
        input_schema: {
          type: 'object',
          properties: {
            operation: { type: 'string' }, target: { type: 'string' }, value: { type: 'string' },
          },
        },
      }],
      invokeTool: async () => ({ text: 'Настроил.', isError: false, receipt: true }),
    })

    const response = await provider.complete({
      sessionId: 'session-a', turnId: 'operator-turn-a', prefixBytes: new Uint8Array(),
      spans: [{ role: 'user', provenance: 'operator', text: 'Включи только чтение' }],
    })
    expect(readProviderActionEvidence(response)).toEqual([{
      tool: 'configure_agent', family: 'mutate', successful: true, receipt: true,
      operation: 'policy.tighten-project',
    }])
    expect(readProviderToolExecutions(response)).toHaveLength(1)
    h.runtime.close()
  })

  it('uses the same private home for setup and blocks config tampering before spawn', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-codex-home-')))
    const home = join(root, 'codex-home')
    const environment = codexSubscriptionEnvironment(home, { HOME: root })
    expect(environment['CODEX_HOME']).toBe(home)
    expect(lstatSync(home).mode & 0o077).toBe(0)
    expect(lstatSync(join(home, 'config.toml')).mode & 0o077).toBe(0)

    const h = fixture()
    writeFileSync(join(h.codexHome, 'config.toml'), 'foreign configuration\n', { mode: 0o600 })
    const provider = h.runtime.provider({
      projectId: 'project-a', tools: [],
      invokeTool: async () => ({ text: 'unused', isError: true }),
    })
    await expect(provider.complete({
      sessionId: 'session-a', prefixBytes: new Uint8Array(),
      spans: [{ role: 'user', provenance: 'operator', text: 'hello' }],
    })).rejects.toMatchObject({ message: 'CODEX_APP_SERVER_UNAVAILABLE' })
    expect(h.spawns).toEqual([])
    expect(readFileSync(join(h.codexHome, 'config.toml'), 'utf8')).toBe('foreign configuration\n')
    h.runtime.close()
  })

  it('sees a Codex executable installed after setup has already started', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-codex-late-install-')))
    const executable = join(root, 'codex')
    let resolved: string | null = null
    const port = makeRefreshingNodeCodexAuthProcessPort({
      resolveExecutable: () => resolved,
      codexHome: join(root, 'codex-home'),
      environment: { PATH: '/usr/bin', HOME: root },
    })

    await expect(port.run('codex', ['--version'])).resolves.toEqual({
      exitCode: 127, output: '',
    })
    writeFileSync(executable, '#!/bin/sh\nprintf "codex-cli 0.144.5\\n"\n', { mode: 0o700 })
    chmodSync(executable, 0o700)
    resolved = executable
    await expect(port.run('codex', ['--version'])).resolves.toMatchObject({
      exitCode: 0, output: expect.stringContaining('codex-cli 0.144.5'),
    })
  })
})
