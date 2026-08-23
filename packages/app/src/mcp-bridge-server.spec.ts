import { afterEach, describe, expect, it } from 'vitest'

import {
  MCP_BRIDGE_PROTOCOL_VERSION,
  startAisyMcpBridge,
  type AisyMcpBridge,
  type McpBridgeInvocation,
} from './mcp-bridge-server.js'

const bridges: AisyMcpBridge[] = []

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
] as const

async function bridge(input: {
  invoke?: (call: McpBridgeInvocation) => Promise<{ text: string; isError: boolean }>
  requireCodexTurnBinding?: boolean
}): Promise<AisyMcpBridge> {
  const started = await startAisyMcpBridge({
    tools: TOOLS,
    invoke: input.invoke ?? (async () => ({ text: 'ok', isError: false })),
    ...(input.requireCodexTurnBinding === undefined
      ? {}
      : { requireCodexTurnBinding: input.requireCodexTurnBinding }),
  })
  bridges.push(started)
  return started
}

async function rpc(
  target: AisyMcpBridge,
  body: unknown,
  options: { token?: string | null } = {},
): Promise<{ status: number; body: unknown }> {
  const token = options.token === undefined ? target.token : options.token
  const response = await fetch(target.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((entry) => entry.close()))
})

describe('Aisy MCP bridge server', () => {
  it('binds loopback only and refuses every request without the exact token', async () => {
    const target = await bridge({})
    expect(target.url.startsWith('http://127.0.0.1:')).toBe(true)

    const call = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    expect((await rpc(target, call, { token: null })).status).toBe(401)
    expect((await rpc(target, call, { token: 'wrong' })).status).toBe(401)
    expect((await rpc(target, call, { token: `${target.token}x` })).status).toBe(401)
    expect((await rpc(target, call)).status).toBe(200)
  })

  it('completes the handshake and lists the published catalogue', async () => {
    const target = await bridge({})

    const init = await rpc(target, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION, capabilities: {} },
    })
    expect(init.status).toBe(200)
    expect(init.body).toMatchObject({
      id: 1,
      result: {
        protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
        serverInfo: { name: 'aisy' },
      },
    })

    // A notification carries no id and must be acknowledged without a body.
    const ready = await rpc(target, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(ready.status).toBe(202)
    expect(ready.body).toBeUndefined()

    const listed = await rpc(target, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(listed.body).toMatchObject({
      id: 2,
      result: {
        tools: [{ name: 'read_file', inputSchema: { type: 'object' } }],
      },
    })
  })

  it('routes a call to the injected executor and passes arguments through', async () => {
    const seen: McpBridgeInvocation[] = []
    const target = await bridge({
      invoke: async (call) => {
        seen.push(call)
        return { text: `read ${String(call.args['path'])}`, isError: false }
      },
    })

    const called = await rpc(target, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'notes.md' } },
    })

    expect(seen).toEqual([{ name: 'read_file', args: { path: 'notes.md' } }])
    expect(called.body).toMatchObject({
      id: 7,
      result: { content: [{ type: 'text', text: 'read notes.md' }], isError: false },
    })
  })

  it('reports a refusal as an error result instead of killing the caller loop', async () => {
    const target = await bridge({
      invoke: async () => { throw new Error('approval denied') },
    })

    const called = await rpc(target, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'notes.md' } },
    })

    expect(called.status).toBe(200)
    expect(called.body).toMatchObject({
      id: 8,
      result: { content: [{ type: 'text', text: 'TOOL_EXECUTION_FAILED' }], isError: true },
    })
  })

  it.each([
    ['malformed', { text: 7, isError: false }],
    ['oversized', { text: 'x'.repeat(1024 * 1024 + 1), isError: false }],
  ])('bounds a %s executor result before returning it to the model', async (_name, raw) => {
    const target = await bridge({
      invoke: async () => raw as never,
    })
    const called = await rpc(target, {
      jsonrpc: '2.0', id: 81, method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'notes.md' } },
    })
    expect(called.body).toMatchObject({
      result: { content: [{ text: 'TOOL_EXECUTION_FAILED' }], isError: true },
    })
  })

  it('rejects an unknown tool and a malformed envelope without executing anything', async () => {
    let calls = 0
    const target = await bridge({
      invoke: async () => { calls += 1; return { text: 'ok', isError: false } },
    })

    const unknown = await rpc(target, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'rm_rf', arguments: {} },
    })
    expect(unknown.body).toMatchObject({ id: 9, error: { code: -32602 } })

    const malformed = await rpc(target, { id: 10, method: 'tools/list' })
    expect(malformed.status).toBe(400)

    const unsupported = await rpc(target, { jsonrpc: '2.0', id: 11, method: 'resources/list' })
    expect(unsupported.body).toMatchObject({ id: 11, error: { code: -32601 } })

    expect(calls).toBe(0)
  })

  it('executes a Codex call only after binding the exact thread and turn', async () => {
    let calls = 0
    const target = await bridge({
      requireCodexTurnBinding: true,
      invoke: async () => { calls++; return { text: 'bound', isError: false } },
    })
    const request = (metadata?: Record<string, unknown>) => ({
      jsonrpc: '2.0', id: 21, method: 'tools/call',
      params: {
        name: 'read_file', arguments: { path: 'notes.md' },
        ...(metadata === undefined ? {} : { _meta: { 'x-codex-turn-metadata': metadata } }),
      },
    })

    expect((await rpc(target, request())).body).toMatchObject({ error: { code: -32001 } })
    target.bindCodexTurn('thread-7', 'turn-8')
    expect((await rpc(target, request({
      session_id: 'foreign', thread_id: 'thread-7', turn_id: 'turn-8',
    }))).body).toMatchObject({ error: { code: -32001 } })
    const exact = await rpc(target, request({
      session_id: 'thread-7', thread_id: 'thread-7', turn_id: 'turn-8',
    }))
    expect(exact.body).toMatchObject({ result: { content: [{ text: 'bound' }] } })
    expect(calls).toBe(1)
    expect(() => target.bindCodexTurn('thread-7', 'turn-8')).toThrow(
      'MCP_BRIDGE_TURN_BINDING_REJECTED',
    )
  })

  it('returns the same result for an exact replay and rejects an altered replay', async () => {
    let calls = 0
    const target = await bridge({
      invoke: async () => {
        calls++
        await Promise.resolve()
        return { text: 'once', isError: false }
      },
    })
    const exact = {
      jsonrpc: '2.0', id: 'call-1', method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'a.md' } },
    }
    const [first, replay] = await Promise.all([rpc(target, exact), rpc(target, exact)])
    expect(first.body).toEqual(replay.body)
    expect(calls).toBe(1)

    const altered = await rpc(target, {
      ...exact,
      params: { name: 'read_file', arguments: { path: 'b.md' } },
    })
    expect(altered.body).toMatchObject({ error: { code: -32002 } })
    expect(calls).toBe(1)
  })

  it('stops answering once closed', async () => {
    const target = await startAisyMcpBridge({
      tools: TOOLS,
      invoke: async () => ({ text: 'ok', isError: false }),
    })
    const { url, token } = target
    await target.close()

    await expect(fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })).rejects.toThrow()
  })
})
