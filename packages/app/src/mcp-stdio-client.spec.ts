// The client speaks JSON-RPC to a server process. Everything it returns is
// validated by the wire adapter, so what is tested here is framing, era
// detection and process lifetime: the three things above it cannot check.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { McpSdkClientPlan } from '@aisy/core'
import { describe, expect, it, vi } from 'vitest'

import { makeMcpStdioClient, McpStdioError } from './mcp-stdio-client.js'

const MODERN = '2026-07-28'
const LEGACY = '2025-11-25'
const META = 'io.modelcontextprotocol/protocolVersion'

const DUAL_ERA_PLAN: McpSdkClientPlan = {
  supportedProtocolVersions: [MODERN, LEGACY],
  versionNegotiation: { mode: 'auto', probe: { timeoutMs: 40, maxRetries: 0 } },
  usePriorDiscovery: false,
}

const MODERN_ONLY_PLAN: McpSdkClientPlan = {
  supportedProtocolVersions: [MODERN],
  versionNegotiation: { mode: { pin: MODERN }, probe: { timeoutMs: 40, maxRetries: 0 } },
  usePriorDiscovery: false,
}

interface FakeServer {
  child: ChildProcessWithoutNullStreams
  /** Every JSON-RPC frame the client wrote. */
  sent: Array<Record<string, unknown>>
  /** Answers the request with `method`, once it arrives. */
  reply(method: string, result: unknown): void
  replyError(method: string, code: number, message: string, data?: unknown): void
  /** Writes a raw line to stdout, bypassing the JSON-RPC shape. */
  raw(line: string): void
  exit(code: number, stderr?: string): void
  killed: string[]
}

function fakeServer(): FakeServer {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams
  Object.assign(child, {
    stdin, stdout, stderr, exitCode: null, signalCode: null,
    kill: (signal?: string) => {
      killed.push(signal ?? 'SIGTERM')
      // A well-behaved server exits on SIGTERM; the escalation to SIGKILL is
      // covered by its own test.
      Object.assign(child, { exitCode: 0 })
      child.emit('exit', 0, null)
      return true
    },
  })
  const killed: string[] = []
  const sent: Array<Record<string, unknown>> = []
  let buffer = ''
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (line.trim().length > 0) sent.push(JSON.parse(line) as Record<string, unknown>)
    }
  })
  const find = (method: string): Record<string, unknown> | undefined =>
    sent.find((frame) => frame['method'] === method)
  return {
    child, sent, killed,
    reply(method, result) {
      const frame = find(method)
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame?.['id'], result })}\n`)
    },
    replyError(method, code, message, data) {
      const frame = find(method)
      stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: frame?.['id'],
        error: { code, message, ...(data === undefined ? {} : { data }) },
      })}\n`)
    },
    raw: (line) => { stdout.write(`${line}\n`) },
    exit(code, text) {
      if (text !== undefined) stderr.write(text)
      Object.assign(child, { exitCode: code })
      child.emit('exit', code, null)
    },
  }
}

function harness(plan: McpSdkClientPlan = MODERN_ONLY_PLAN) {
  const server = fakeServer()
  const client = makeMcpStdioClient({
    command: ['/usr/bin/mcp-server', '--stdio'],
    env: { PATH: '/usr/bin' },
    requestTimeoutMs: 50,
    spawnProcess: () => server.child,
  })(plan)
  return { server, client }
}

/** Lets the client's stdin listener run before the fake answers. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

const discoverResult = (versions: string[]): Record<string, unknown> => ({
  resultType: 'complete',
  supportedVersions: versions,
  capabilities: { tools: {} },
})

/** A modern server: answers the discovery probe and lists the version. */
async function connected(plan: McpSdkClientPlan = MODERN_ONLY_PLAN, versions = [MODERN]) {
  const h = harness(plan)
  const connect = h.client.connect()
  await settle()
  h.server.reply('server/discover', discoverResult(versions))
  await connect
  return h
}

describe('era detection', () => {
  it('opens with the discovery probe, carrying the version as request metadata', async () => {
    const h = await connected()

    expect(h.server.sent[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'server/discover',
      params: { _meta: { [META]: MODERN } },
    })
    expect(h.client.negotiatedProtocol()).toEqual({ era: 'modern', version: MODERN })
  })

  it('never sends the removed handshake to a modern server', async () => {
    const h = await connected()
    await settle()

    expect(h.server.sent.some((frame) => frame['method'] === 'initialize')).toBe(false)
    expect(h.server.sent.some((frame) => frame['method'] === 'notifications/initialized')).toBe(false)
  })

  it('reports no protocol when the server lists only versions we do not speak', async () => {
    const h = await connected(MODERN_ONLY_PLAN, ['1999-01-01'])

    // The wire adapter turns this into a refusal; the client must not guess.
    expect(h.client.negotiatedProtocol()).toBeNull()
  })

  it('treats a version refusal as a modern server, not an older one', async () => {
    const h = harness(DUAL_ERA_PLAN)
    const connect = h.client.connect()
    await settle()
    h.server.replyError('server/discover', -32022, 'Unsupported protocol version', {
      supported: ['2027-01-01'], requested: MODERN,
    })
    await connect

    expect(h.client.negotiatedProtocol()).toBeNull()
    expect(h.server.sent.some((frame) => frame['method'] === 'initialize')).toBe(false)
  })

  it('falls back to the handshake when the probe draws an unknown-method error', async () => {
    const h = harness(DUAL_ERA_PLAN)
    const connect = h.client.connect()
    await settle()
    h.server.replyError('server/discover', -32601, 'Method not found')
    await settle()
    h.server.reply('initialize', { protocolVersion: LEGACY, capabilities: {}, serverInfo: {} })
    await connect

    expect(h.client.negotiatedProtocol()).toEqual({ era: 'legacy', version: LEGACY })
    expect(h.server.sent.some((frame) => frame['method'] === 'notifications/initialized')).toBe(true)
  })

  it('falls back when the probe is met with silence, without killing the server', async () => {
    const h = harness(DUAL_ERA_PLAN)
    const connect = h.client.connect()
    await settle()
    // No answer to server/discover at all — the probe times out.
    await new Promise((resolve) => setTimeout(resolve, 60))
    h.server.reply('initialize', { protocolVersion: LEGACY })
    await connect

    expect(h.client.negotiatedProtocol()).toEqual({ era: 'legacy', version: LEGACY })
    expect(h.server.killed).toEqual([])
  }, 10_000)

  it('refuses the legacy era when the plan does not carry an approved legacy version', async () => {
    const h = harness(MODERN_ONLY_PLAN)
    const connect = h.client.connect()
    await settle()
    h.server.replyError('server/discover', -32601, 'Method not found')
    await connect

    expect(h.client.negotiatedProtocol()).toBeNull()
    expect(h.server.sent.some((frame) => frame['method'] === 'initialize')).toBe(false)
  })

  it('surfaces a server that dies during the probe', async () => {
    const h = harness()
    const connect = h.client.connect()
    await settle()
    h.server.exit(1, 'config file missing')

    await expect(connect).rejects.toBeInstanceOf(McpStdioError)
  })

  it('reports a spawn that never started', async () => {
    const client = makeMcpStdioClient({
      command: ['/usr/bin/missing'],
      spawnProcess: () => { throw new Error('ENOENT') },
    })(MODERN_ONLY_PLAN)

    await expect(client.connect()).rejects.toMatchObject({ reason: 'SPAWN_FAILED' })
  })
})

describe('requests', () => {
  it('declares the agreed version on every request, not just the first', async () => {
    const h = await connected()
    const list = h.client.listTools()
    await settle()
    h.server.reply('tools/list', { resultType: 'complete', tools: [] })
    await list

    expect(h.server.sent.find((frame) => frame['method'] === 'tools/list'))
      .toMatchObject({ params: { _meta: { [META]: MODERN } } })
  })

  it('sends no request metadata to a legacy server', async () => {
    const h = harness(DUAL_ERA_PLAN)
    const connect = h.client.connect()
    await settle()
    h.server.replyError('server/discover', -32601, 'Method not found')
    await settle()
    h.server.reply('initialize', { protocolVersion: LEGACY })
    await connect
    const list = h.client.listTools()
    await settle()
    h.server.reply('tools/list', { tools: [] })
    await list

    expect(h.server.sent.find((frame) => frame['method'] === 'tools/list'))
      .toEqual({ jsonrpc: '2.0', id: expect.any(Number), method: 'tools/list', params: {} })
  })

  it('passes the cursor through on a paged listing', async () => {
    const h = await connected()
    const list = h.client.listTools('page-2')
    await settle()
    h.server.reply('tools/list', { resultType: 'complete', tools: [] })

    expect(await list).toMatchObject({ tools: [] })
    expect(h.server.sent.find((frame) => frame['method'] === 'tools/list'))
      .toMatchObject({ params: { cursor: 'page-2' } })
  })

  it('sends a call with its arguments untouched', async () => {
    const h = await connected()
    const call = h.client.callTool({ name: 'read_file', arguments: { path: 'a.txt' } })
    await settle()
    h.server.reply('tools/call', { resultType: 'complete', content: [{ type: 'text', text: 'ok' }] })

    await call
    expect(h.server.sent.find((frame) => frame['method'] === 'tools/call'))
      .toMatchObject({ params: { name: 'read_file', arguments: { path: 'a.txt' } } })
  })

  it('turns a JSON-RPC error into a rejection rather than a result', async () => {
    const h = await connected()
    const call = h.client.callTool({ name: 'read_file', arguments: {} })
    await settle()
    h.server.replyError('tools/call', -32602, 'no such file')

    await expect(call).rejects.toMatchObject({ reason: 'RPC_ERROR' })
  })

  it('gives up on a server that stops answering', async () => {
    const h = await connected()

    await expect(h.client.listTools()).rejects.toMatchObject({ reason: 'TIMEOUT' })
  })

  it('ignores frames the server sends on its own initiative', async () => {
    const h = await connected()
    const list = h.client.listTools()
    await settle()
    h.server.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' }))
    h.server.raw(JSON.stringify({ jsonrpc: '2.0', id: 999, result: { tools: ['ghost'] } }))
    h.server.reply('tools/list', { resultType: 'complete', tools: [] })

    expect(await list).toMatchObject({ tools: [] })
  })

  it('fails the request when the server writes something that is not JSON', async () => {
    const h = await connected()
    const list = h.client.listTools()
    await settle()
    h.server.raw('this is a log line, not a frame')

    await expect(list).rejects.toMatchObject({ reason: 'INVALID_FRAME' })
  })

  it('carries the server’s own words into the failure when it exits', async () => {
    const h = await connected()
    const list = h.client.listTools()
    await settle()
    h.server.exit(2, 'permission denied on /etc')

    await expect(list).rejects.toMatchObject({ reason: 'PROCESS_EXITED' })
    await expect(list).rejects.toThrow(/permission denied/u)
  })

  it('refuses to keep talking after close', async () => {
    const h = await connected()
    await h.client.close()

    await expect(h.client.listTools()).rejects.toMatchObject({ reason: 'CLOSED' })
  })
})

describe('the process', () => {
  it('spawns exactly the argv it was given, with no shell', async () => {
    const server = fakeServer()
    const spawnProcess = vi.fn(() => server.child)
    const client = makeMcpStdioClient({
      command: ['/usr/bin/mcp-server', '--stdio'],
      env: { PATH: '/usr/bin' },
      spawnProcess,
    })(MODERN_ONLY_PLAN)

    const connect = client.connect()
    await settle()
    server.reply('server/discover', discoverResult([MODERN]))
    await connect

    expect(spawnProcess).toHaveBeenCalledWith(
      ['/usr/bin/mcp-server', '--stdio'], { PATH: '/usr/bin' }, undefined,
    )
  })

  it('terminates the server when the session closes', async () => {
    const h = await connected()
    await h.client.close()

    expect(h.server.killed).toContain('SIGTERM')
  })

  it('closes only once, however many times it is asked', async () => {
    const h = await connected()
    await h.client.close()
    await h.client.close()

    expect(h.server.killed).toEqual(['SIGTERM'])
  })

  it('escalates to SIGKILL when the server ignores SIGTERM', async () => {
    const server = fakeServer()
    Object.assign(server.child, { kill: (signal?: string) => {
      server.killed.push(signal ?? 'SIGTERM')
      return true
    } })
    const client = makeMcpStdioClient({
      command: ['/usr/bin/stubborn'],
      requestTimeoutMs: 50,
      spawnProcess: () => server.child,
    })(MODERN_ONLY_PLAN)
    const connect = client.connect()
    await settle()
    server.reply('server/discover', discoverResult([MODERN]))
    await connect

    await client.close()

    expect(server.killed).toEqual(['SIGTERM', 'SIGKILL'])
  }, 10_000)
})
