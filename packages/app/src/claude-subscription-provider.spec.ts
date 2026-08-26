import {
  readProviderActionEvidence,
  readProviderToolExecutions,
  type ModelProgressEvent,
  type ModelRequest,
  type RuntimeToolDefinition,
} from '@aisy/core'
import { describe, expect, it } from 'vitest'

import {
  buildClaudeSubscriptionArgs,
  makeClaudeSubscriptionProvider,
  parseClaudeStream,
} from './claude-subscription-provider.js'

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file',
    input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    tier: 0,
    outboundSink: false,
    effect: 'read',
  },
] as const satisfies readonly RuntimeToolDefinition[]

const request: ModelRequest = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  prefixBytes: new TextEncoder().encode('SYSTEM PREFIX'),
  spans: [
    { role: 'system', provenance: 'operator', text: 'trusted action contract' },
    { role: 'user', provenance: 'operator', text: 'привет' },
  ],
}

function streamOf(lines: readonly unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n')
}

const initConnected = {
  type: 'system',
  subtype: 'init',
  mcp_servers: [{ name: 'aisy', status: 'connected' }],
  tools: ['mcp__aisy__read_file'],
}

const resultOk = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'готово',
  usage: { input_tokens: 12, output_tokens: 3 },
}

describe('claude subscription argv', () => {
  it('strips every native capability and host configuration source', () => {
    const argv = buildClaudeSubscriptionArgs({
      mcpConfig: '{"mcpServers":{}}',
      allowedTools: ['mcp__aisy__read_file'],
      model: 'sonnet',
    })

    // `--tools ''` is what actually removes Bash/Edit/Read from the model's
    // context; the allowlist alone would still leave them callable.
    expect(argv).toContain('--tools')
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv).toContain('--disable-slash-commands')
    // `--safe-mode` also disables MCP, which would drop the bridge and leave
    // the model toolless — the isolation must not be built on it.
    expect(argv).not.toContain('--safe-mode')
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('mcp__aisy__read_file')
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet')
  })
})

describe('claude stream parser', () => {
  it('reads the reply, usage and bridge status from the transcript', () => {
    const outcome = parseClaudeStream(streamOf([initConnected, resultOk]))

    expect(outcome).toMatchObject({
      reply: 'готово',
      mcpConnected: true,
      nativeToolsExposed: [],
      usage: { inputTokens: 12, outputTokens: 3, dollars: 0 },
    })
  })

  it('streams text deltas and ignores unparsable lines', () => {
    const seen: string[] = []
    parseClaudeStream(
      `${streamOf([
        initConnected,
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'при' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'вет' } } },
        resultOk,
      ])}\nне json\n`,
      (event: ModelProgressEvent) => {
        if (event.type === 'text-delta') seen.push(event.text)
      },
    )

    expect(seen).toEqual(['при', 'вет'])
  })

  it('turns a reported error result into a provider error', () => {
    expect(() => parseClaudeStream(streamOf([
      initConnected,
      { type: 'result', subtype: 'error', is_error: true, result: 'лимит' },
    ]))).toThrowError(/лимит/)
  })
})

describe('claude subscription provider', () => {
  it('executes model tool calls through Aisy and reports them as progress', async () => {
    const executed: Array<{ name: string; args: Record<string, unknown> }> = []
    const contexts: Array<{ sessionId: string; turnId?: string; ordinal?: number }> = []
    const events: ModelProgressEvent[] = []

    const provider = makeClaudeSubscriptionProvider({
      tools: TOOLS,
      invokeTool: async (call, _signal, context) => {
        executed.push(call)
        contexts.push(context)
        return { text: 'содержимое', isError: false }
      },
      run: async (argv, input) => {
        // Roles remain code-owned data in the CLI's single stdin prompt.
        expect(input).toContain('AISY_CONTEXT_V1')
        expect(input).not.toContain('System:')
        expect(JSON.parse(input.split('\n').at(-1)!)).toEqual({
          version: 1,
          items: [
            { source: 'aisy_control', text: 'trusted action contract' },
            { source: 'operator', text: 'привет' },
          ],
        })
        expect(input.startsWith('SYSTEM PREFIX\n\nAISY_CONTEXT_V1\n')).toBe(true)
        const raw = argv[argv.indexOf('--mcp-config') + 1] ?? '{}'
        const config = JSON.parse(raw) as {
          mcpServers: { aisy: { url: string; headers: { authorization: string } } }
        }
        // Call the live bridge exactly as the CLI would.
        const response = await fetch(config.mcpServers.aisy.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: config.mcpServers.aisy.headers.authorization,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'read_file', arguments: { path: 'notes.md' } },
          }),
        })
        expect(response.status).toBe(200)
        return { stdout: streamOf([initConnected, resultOk]), stderr: '', exitCode: 0 }
      },
    })

    const answer = await provider.complete(request, undefined, (event) => { events.push(event) })

    expect(executed).toEqual([{ name: 'read_file', args: { path: 'notes.md' } }])
    expect(contexts).toEqual([{ sessionId: 'session-1', turnId: 'turn-1', ordinal: 1 }])
    expect(Object.isFrozen(contexts[0])).toBe(true)
    expect(answer.reply).toBe('готово')
    expect(answer.usage).toEqual({ inputTokens: 12, outputTokens: 3, dollars: 0 })
    expect(readProviderActionEvidence(answer)).toEqual([{
      tool: 'read_file', family: 'inspect', successful: true, receipt: false,
    }])
    expect(readProviderToolExecutions(answer)).toEqual([{
      call: { name: 'read_file', args: { path: 'notes.md' } },
      context: { sessionId: 'session-1', turnId: 'turn-1', ordinal: 1 },
      result: { ok: true, output: 'содержимое' },
    }])
    expect(events.map((event) => event.type)).toContain('tool-requested')
    expect(events.map((event) => event.type)).toContain('tool-result')

    const second = await provider.complete({ ...request, toolOrdinalBase: 7 })
    expect(contexts.at(-1)).toEqual({ sessionId: 'session-1', turnId: 'turn-1', ordinal: 8 })
    expect(readProviderToolExecutions(second)[0]?.context.ordinal).toBe(8)
  })

  it('attaches a failed execution when the provider-side tool handler throws', async () => {
    const provider = makeClaudeSubscriptionProvider({
      tools: TOOLS,
      invokeTool: async () => { throw new Error('ambiguous tool failure') },
      run: async (argv) => {
        const raw = argv[argv.indexOf('--mcp-config') + 1] ?? '{}'
        const config = JSON.parse(raw) as {
          mcpServers: { aisy: { url: string; headers: { authorization: string } } }
        }
        const response = await fetch(config.mcpServers.aisy.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: config.mcpServers.aisy.headers.authorization,
          },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'read_file', arguments: { path: 'notes.md' } },
          }),
        })
        expect(response.status).toBe(200)
        return { stdout: streamOf([initConnected, resultOk]), stderr: '', exitCode: 0 }
      },
    })

    const answer = await provider.complete(request)

    expect(readProviderToolExecutions(answer)).toEqual([{
      call: { name: 'read_file', args: { path: 'notes.md' } },
      context: { sessionId: 'session-1', turnId: 'turn-1', ordinal: 1 },
      result: { ok: false, output: 'TOOL_EXECUTION_FAILED' },
    }])
    expect(readProviderActionEvidence(answer)).toEqual([{
      tool: 'read_file', family: 'inspect', successful: false, receipt: false,
    }])
  })

  it('fails closed when the bridge silently failed to load', async () => {
    const provider = makeClaudeSubscriptionProvider({
      tools: TOOLS,
      invokeTool: async () => ({ text: '', isError: false }),
      // A bad --mcp-config does not fail the CLI run: the server is dropped and
      // the model answers toolless. That must never look like a normal turn.
      run: async () => ({
        stdout: streamOf([
          { type: 'system', subtype: 'init', mcp_servers: [], tools: [] },
          resultOk,
        ]),
        stderr: '',
        exitCode: 0,
      }),
    })

    await expect(provider.complete(request)).rejects.toThrow(/MCP_BRIDGE_NOT_CONNECTED/)
  })

  it('fails closed when a native capability survived the argv', async () => {
    const provider = makeClaudeSubscriptionProvider({
      tools: TOOLS,
      invokeTool: async () => ({ text: '', isError: false }),
      run: async () => ({
        stdout: streamOf([
          { ...initConnected, tools: ['Bash', 'mcp__aisy__read_file'] },
          resultOk,
        ]),
        stderr: '',
        exitCode: 0,
      }),
    })

    await expect(provider.complete(request)).rejects.toThrow(/NATIVE_TOOLS_EXPOSED/)
  })

  it('surfaces a non-zero exit as a provider error', async () => {
    const provider = makeClaudeSubscriptionProvider({
      tools: TOOLS,
      invokeTool: async () => ({ text: '', isError: false }),
      run: async () => ({ stdout: '', stderr: 'not logged in', exitCode: 1 }),
    })

    await expect(provider.complete(request)).rejects.toThrow(/claude exited 1/)
  })

  it('closes the bridge even when the run throws', async () => {
    let url = ''
    const provider = makeClaudeSubscriptionProvider({
      tools: TOOLS,
      invokeTool: async () => ({ text: '', isError: false }),
      run: async (argv) => {
        const raw = argv[argv.indexOf('--mcp-config') + 1] ?? '{}'
        url = (JSON.parse(raw) as { mcpServers: { aisy: { url: string } } }).mcpServers.aisy.url
        throw new Error('spawn failed')
      },
    })

    await expect(provider.complete(request)).rejects.toThrow(/spawn failed/)
    // A leaked listener would keep a loopback port open for the whole session.
    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow()
  })
})
