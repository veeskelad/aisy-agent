import { describe, expect, it, vi } from 'vitest'

import { canonicalDescriptorHash } from './index.js'
import {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  openMcpWireSession,
} from './wire-adapter.js'
import type { McpSdkClientPlan, McpSdkClientPort } from './wire-adapter.js'

function makePort(
  negotiated: ReturnType<McpSdkClientPort['negotiatedProtocol']> = {
    era: 'modern', version: MCP_MODERN_PROTOCOL_VERSION,
  },
): McpSdkClientPort {
  return {
    connect: vi.fn(async () => undefined),
    negotiatedProtocol: vi.fn(() => negotiated),
    listTools: vi.fn(async () => ({ tools: [] })),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    close: vi.fn(async () => undefined),
  }
}

describe('safe MCP wire adapter', () => {
  it('pins modern-only to exactly 2026-07-28 without cached discovery or retries', async () => {
    const port = makePort()
    let plan: McpSdkClientPlan | undefined
    const session = await openMcpWireSession({
      policy: { mode: 'modern-only' },
      createClient: value => { plan = value; return port },
    })

    expect(plan).toEqual({
      supportedProtocolVersions: [MCP_MODERN_PROTOCOL_VERSION],
      versionNegotiation: {
        mode: { pin: MCP_MODERN_PROTOCOL_VERSION },
        probe: { timeoutMs: 5_000, maxRetries: 0 },
      },
      usePriorDiscovery: false,
    })
    expect(session).toMatchObject({ era: 'modern', version: MCP_MODERN_PROTOCOL_VERSION })
  })

  it('dual-era probes modern first and accepts only the exact legacy fallback', async () => {
    const port = makePort({ era: 'legacy', version: MCP_LEGACY_PROTOCOL_VERSION })
    let plan: McpSdkClientPlan | undefined
    const session = await openMcpWireSession({
      policy: { mode: 'dual-era' },
      createClient: value => { plan = value; return port },
    })

    expect(plan).toEqual({
      supportedProtocolVersions: [MCP_MODERN_PROTOCOL_VERSION, MCP_LEGACY_PROTOCOL_VERSION],
      versionNegotiation: {
        mode: 'auto',
        probe: { timeoutMs: 5_000, maxRetries: 0 },
      },
      usePriorDiscovery: false,
    })
    expect(session).toMatchObject({ era: 'legacy', version: MCP_LEGACY_PROTOCOL_VERSION })
  })

  it('fails closed and closes when modern-only sees legacy evidence', async () => {
    const port = makePort({ era: 'legacy', version: MCP_LEGACY_PROTOCOL_VERSION })

    await expect(openMcpWireSession({
      policy: { mode: 'modern-only' },
      createClient: () => port,
    })).rejects.toMatchObject({ code: 'ERA_NOT_ALLOWED' })
    expect(port.close).toHaveBeenCalledOnce()
    expect(port.listTools).not.toHaveBeenCalled()
  })

  it('rejects missing or inconsistent negotiation evidence', async () => {
    const missing = makePort(null)
    await expect(openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => missing,
    })).rejects.toMatchObject({ code: 'NEGOTIATION_EVIDENCE_MISSING' })

    const wrongVersion = makePort({ era: 'modern', version: MCP_LEGACY_PROTOCOL_VERSION })
    await expect(openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => wrongVersion,
    })).rejects.toMatchObject({ code: 'PROTOCOL_VERSION_MISMATCH' })
    expect(wrongVersion.close).toHaveBeenCalledOnce()

    const unknownEra = makePort({
      era: 'future', version: MCP_MODERN_PROTOCOL_VERSION,
    } as unknown as ReturnType<McpSdkClientPort['negotiatedProtocol']>)
    await expect(openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => unknownEra,
    })).rejects.toMatchObject({ code: 'ERA_NOT_ALLOWED' })
    expect(unknownEra.close).toHaveBeenCalledOnce()
  })

  it('does not reinterpret authentication, network, or server errors as an era signal', async () => {
    const port = makePort()
    vi.mocked(port.connect).mockRejectedValueOnce(new Error('sensitive upstream detail'))
    const emit = vi.fn()

    await expect(openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => port, emit,
    })).rejects.toMatchObject({ code: 'NEGOTIATION_FAILED', message: 'NEGOTIATION_FAILED' })
    expect(port.negotiatedProtocol).not.toHaveBeenCalled()
    expect(port.close).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith('mcp.wire_refused', { reason: 'NEGOTIATION_FAILED' })
  })

  it('bounds pagination and rejects duplicate tool identities', async () => {
    const port = makePort()
    vi.mocked(port.listTools)
      .mockResolvedValueOnce({
        tools: [{ name: 'search', inputSchema: { type: 'object' } }],
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        tools: [{ name: 'search', inputSchema: { type: 'object' } }],
      })
    const session = await openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => port,
    })

    await expect(session.listDescriptors()).rejects.toMatchObject({ code: 'DUPLICATE_TOOL' })
    expect(port.close).toHaveBeenCalledOnce()
    expect(port.listTools).toHaveBeenNthCalledWith(1, undefined)
    expect(port.listTools).toHaveBeenNthCalledWith(2, 'next')
  })

  it('accepts only valid 2026 cache hints on tools/list pages', async () => {
    const valid = makePort()
    vi.mocked(valid.listTools).mockResolvedValueOnce({
      tools: [], ttlMs: 5_000, cacheScope: 'private',
    })
    const validSession = await openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => valid,
    })
    await expect(validSession.listDescriptors()).resolves.toEqual([])

    const obsolete = makePort()
    vi.mocked(obsolete.listTools).mockResolvedValueOnce({
      tools: [], ttl: 5_000, cacheScope: 'private',
    })
    const obsoleteSession = await openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => obsolete,
    })
    await expect(obsoleteSession.listDescriptors())
      .rejects.toMatchObject({ code: 'INVALID_TOOLS_RESULT' })

    const unsafe = makePort()
    vi.mocked(unsafe.listTools).mockResolvedValueOnce({
      tools: [], ttlMs: -1, cacheScope: 'shared',
    })
    const unsafeSession = await openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => unsafe,
    })
    await expect(unsafeSession.listDescriptors())
      .rejects.toMatchObject({ code: 'INVALID_TOOLS_RESULT' })
  })

  it('accepts the 2026 result tag and refuses a server that asks the agent for input', async () => {
    const tagged = makePort()
    vi.mocked(tagged.listTools).mockResolvedValueOnce({ resultType: 'complete', tools: [] })
    const taggedSession = await openMcpWireSession({
      policy: { mode: 'modern-only' }, createClient: () => tagged,
    })
    await expect(taggedSession.listDescriptors()).resolves.toEqual([])

    // Multi round-trip requests would let a server drive sampling, elicitation
    // or roots through this agent. Unimplemented is the safe answer, refusal is
    // the honest one.
    const asking = makePort()
    vi.mocked(asking.listTools).mockResolvedValueOnce({
      resultType: 'input_required', tools: [],
    })
    const askingSession = await openMcpWireSession({
      policy: { mode: 'modern-only' }, createClient: () => asking,
    })
    await expect(askingSession.listDescriptors())
      .rejects.toMatchObject({ code: 'UNSUPPORTED_RESULT_TYPE' })

    const askingCall = makePort()
    vi.mocked(askingCall.callTool).mockResolvedValueOnce({
      resultType: 'input_required', content: [],
    })
    const callSession = await openMcpWireSession({
      policy: { mode: 'modern-only' }, createClient: () => askingCall,
    })
    await expect(callSession.callTool('tool', {}))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_RESULT_TYPE' })
  })

  it('rejects cursor loops and a page beyond the configured maximum', async () => {
    const looping = makePort()
    vi.mocked(looping.listTools).mockResolvedValue({ tools: [], nextCursor: 'same' })
    const loopSession = await openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => looping,
    })
    await expect(loopSession.listDescriptors()).rejects.toMatchObject({ code: 'PAGINATION_LOOP' })

    const paged = makePort()
    vi.mocked(paged.listTools)
      .mockResolvedValueOnce({ tools: [], nextCursor: 'two' })
      .mockResolvedValueOnce({ tools: [], nextCursor: 'three' })
    const pageSession = await openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => paged, maxPages: 2,
    })
    await expect(pageSession.listDescriptors()).rejects.toMatchObject({ code: 'TOOLS_PAGE_LIMIT' })
  })

  it('normalizes every accepted 2026 descriptor field into the pinned hash surface', async () => {
    const port = makePort()
    vi.mocked(port.listTools).mockResolvedValueOnce({
      tools: [{
        name: 'search',
        title: 'Поиск',
        description: 'Search',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
        annotations: { readOnlyHint: true },
        execution: { taskSupport: 'forbidden' },
        icons: [{ src: 'data:image/svg+xml;base64,AA==' }],
        _meta: { vendor: { revision: 1 } },
      }],
    })
    const session = await openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => port,
    })
    const [descriptor] = await session.listDescriptors()
    expect(descriptor).toMatchObject({
      title: 'Поиск',
      annotations: { readOnlyHint: true },
      execution: { taskSupport: 'forbidden' },
      _meta: { vendor: { revision: 1 } },
    })

    const baseHash = canonicalDescriptorHash([descriptor!])
    expect(canonicalDescriptorHash([{ ...descriptor!, title: 'Changed' }])).not.toBe(baseHash)
    expect(canonicalDescriptorHash([{ ...descriptor!, annotations: { readOnlyHint: false } }])).not.toBe(baseHash)
    expect(canonicalDescriptorHash([{ ...descriptor!, execution: { taskSupport: 'optional' } }])).not.toBe(baseHash)
    expect(canonicalDescriptorHash([{ ...descriptor!, outputSchema: { type: 'object' } }])).not.toBe(baseHash)
    expect(canonicalDescriptorHash([{ ...descriptor!, _meta: { vendor: { revision: 2 } } }])).not.toBe(baseHash)
  })

  it('rejects unknown descriptor fields before they can escape descriptor hashing', async () => {
    const port = makePort()
    vi.mocked(port.listTools).mockResolvedValueOnce({
      tools: [{ name: 'search', inputSchema: { type: 'object' }, surprise: true }],
    })
    const session = await openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => port,
    })
    await expect(session.listDescriptors()).rejects.toMatchObject({ code: 'INVALID_DESCRIPTOR' })
  })

  it('rejects an invalid execution hint before descriptor publication', async () => {
    const port = makePort()
    vi.mocked(port.listTools).mockResolvedValueOnce({
      tools: [{
        name: 'search', inputSchema: { type: 'object' },
        execution: { taskSupport: 'always', surprise: true },
      }],
    })
    const session = await openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => port,
    })
    await expect(session.listDescriptors()).rejects.toMatchObject({ code: 'INVALID_DESCRIPTOR' })
  })

  it('allows one bounded text result and keeps structured output separate', async () => {
    const port = makePort()
    vi.mocked(port.callTool).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'untrusted result' }],
      structuredContent: { count: 1 },
      isError: false,
    })
    const session = await openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => port,
    })

    await expect(session.callTool('search', { q: 'x' })).resolves.toEqual({
      text: 'untrusted result', structuredContent: { count: 1 }, isError: false,
    })
    await expect(session.callTool('search', { q: 'again' }))
      .rejects.toMatchObject({ code: 'CALL_ALREADY_USED' })
  })

  it('keeps non-object structured JSON separate from prompt text', async () => {
    const port = makePort()
    vi.mocked(port.callTool).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'untrusted result' }],
      structuredContent: ['one', 2, false, null],
    })
    const session = await openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => port,
    })

    await expect(session.callTool('search', {})).resolves.toEqual({
      text: 'untrusted result',
      structuredContent: ['one', 2, false, null],
      isError: false,
    })
  })

  it('blocks unsupported media until the dedicated untrusted-media pipeline is connected', async () => {
    const port = makePort()
    vi.mocked(port.callTool).mockResolvedValueOnce({
      content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }],
    })
    const session = await openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => port,
    })
    await expect(session.callTool('search', {}))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_RESULT_CONTENT' })
    expect(port.close).toHaveBeenCalledOnce()
  })

  it('is idempotently closed and refuses all later I/O', async () => {
    const port = makePort()
    const session = await openMcpWireSession({
      policy: { mode: 'dual-era' }, createClient: () => port,
    })
    await session.close()
    await session.close()

    expect(port.close).toHaveBeenCalledOnce()
    await expect(session.listDescriptors()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.callTool('search', {})).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })
})
