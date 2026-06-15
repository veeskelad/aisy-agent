import { describe, it, expect, vi } from 'vitest'
import { makeMCPManager, canonicalDescriptorHash } from './index.js'
import type {
  McpManagerDeps,
  McpAllowlistConfig,
  McpServerEntry,
  RawDescriptor,
  McpProcessHandle,
  McpEvent,
  ResolvedMcpCall,
} from './types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHandle(id: string, env: Record<string, string> = {}): McpProcessHandle {
  return { id, env, terminate: vi.fn() }
}

const TOOL_A: RawDescriptor = {
  name: 'search',
  description: 'Search the tracker',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  rwClassInputs: {},
}

/** The stored first-approval hash for the unmutated TOOL_A descriptor set. */
const TOOL_A_HASH = canonicalDescriptorHash([TOOL_A])

const ENTRY_FULL: McpServerEntry = {
  name: 'tracker',
  transport: 'stdio',
  command: ['/usr/bin/tracker-server'],
  pin: 'v1.2.3@sha256:abc123',
  descriptorHash: TOOL_A_HASH,
  tokenEnv: 'TRACKER_TOKEN',
  tools: [
    { tool: 'search', tier: 0, outboundSink: false, summary: 'Search issues' },
  ],
}

function makeDeps(overrides: Partial<McpManagerDeps> = {}): McpManagerDeps {
  return {
    allowlist: {
      servers: [{ ...ENTRY_FULL }],
    } satisfies McpAllowlistConfig,
    isEgressAllowed: () => true,
    resolveToken: (env) => (env === 'TRACKER_TOKEN' ? 'tok-secret' : null),
    emit: vi.fn(),
    generateSummary: async () => 'Generated summary',
    spawnProcess: vi.fn((_cmd, env) => makeHandle('p1', env)),
    fetchDescriptors: vi.fn(async () => [TOOL_A]),
    resolvePin: vi.fn(async () => ENTRY_FULL.pin),
    ...overrides,
  }
}

// ── AC-07-1 through AC-07-21 ──────────────────────────────────────────────────

describe('MCP component (07)', () => {

  // ── Allowlist + pin + first-approval gate ────────────────────────────────

  it('AC-07-1: connect("unknown") returns refused:not-allowlisted, no process spawned, no menu', async () => {
    const deps = makeDeps()
    const mgr = makeMCPManager(deps)

    const result = await mgr.connect('unknown')

    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') {
      expect(result.reason).toBe('not-allowlisted')
    }
    expect(deps.spawnProcess).not.toHaveBeenCalled()
  })

  it('AC-07-2: missing pin returns refused:no-pin; missing descriptorHash returns refused:no-hash', async () => {
    const noPin = makeDeps({
      allowlist: { servers: [{ ...ENTRY_FULL, pin: '' }] },
    })
    const r1 = await makeMCPManager(noPin).connect('tracker')
    expect(r1.kind).toBe('refused')
    if (r1.kind === 'refused') expect(r1.reason).toBe('no-pin')

    const noHash = makeDeps({
      allowlist: { servers: [{ ...ENTRY_FULL, descriptorHash: '' }] },
    })
    const r2 = await makeMCPManager(noHash).connect('tracker')
    expect(r2.kind).toBe('refused')
    if (r2.kind === 'refused') expect(r2.reason).toBe('no-hash')
  })

  it('AC-07-3: live version != pin returns refused:pin-mismatch, tools/list not trusted', async () => {
    const deps = makeDeps({
      resolvePin: vi.fn(async () => 'v9.9.9@sha256:different'),
    })
    const result = await makeMCPManager(deps).connect('tracker')

    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') expect(result.reason).toBe('pin-mismatch')
    // tools/list (fetchDescriptors) must not have been called
    expect(deps.fetchDescriptors).not.toHaveBeenCalled()
  })

  // ── Descriptor hashing & rug-pull ────────────────────────────────────────

  it('AC-07-4: byte-unchanged descriptors reproduce the stored hash → connected (hash is byte-stable)', async () => {
    const deps = makeDeps()
    const mgr = makeMCPManager(deps)

    // verifyHash confirms the stored first-approval hash matches the live set.
    expect(mgr.verifyHash({ ...ENTRY_FULL }, [TOOL_A])).toBe(true)

    // Byte-stability: a clone with different key insertion order hashes identically.
    const reordered: RawDescriptor = {
      rwClassInputs: {},
      inputSchema: { properties: { q: { type: 'string' } }, type: 'object' },
      description: 'Search the tracker',
      name: 'search',
    } as RawDescriptor
    expect(canonicalDescriptorHash([reordered])).toBe(TOOL_A_HASH)

    const result = await mgr.connect('tracker')
    expect(result.kind).toBe('connected')
  })

  it('AC-07-5: mutating a tool description changes the hash → disabled:hash-mismatch + DiffCard emitted, no menu', async () => {
    const mutatedTool: RawDescriptor = { ...TOOL_A, description: 'MUTATED description' }
    const deps = makeDeps({
      fetchDescriptors: vi.fn(async () => [mutatedTool]),
    })
    const result = await makeMCPManager(deps).connect('tracker')

    expect(result.kind).toBe('disabled')
    if (result.kind === 'disabled') {
      expect(result.reason).toBe('hash-mismatch')
      expect(result.diffCard).toBeDefined()
      expect(result.diffCard.server).toBe('tracker')
    }
  })

  it('AC-07-5b: DiffCard.descriptorDiff carries BOTH the previous (pinned) and the new (live) descriptors for operator review', async () => {
    // Rug-pull review needs old-vs-new, not just the live set. The entry stores
    // the human-approved descriptors that produced descriptorHash; the diff card
    // must surface both so the operator can see exactly what changed.
    const mutatedTool: RawDescriptor = { ...TOOL_A, description: 'MUTATED description' }
    const deps = makeDeps({
      allowlist: { servers: [{ ...ENTRY_FULL, descriptors: [TOOL_A] }] },
      fetchDescriptors: vi.fn(async () => [mutatedTool]),
    })
    const result = await makeMCPManager(deps).connect('tracker')

    expect(result.kind).toBe('disabled')
    if (result.kind === 'disabled') {
      const diff = result.diffCard.descriptorDiff
      expect(diff.previous).toEqual([TOOL_A])           // old (pinned) descriptors
      expect(diff.live).toEqual([mutatedTool])          // new (live) descriptors
      // The operator can see the change: old description vs new description.
      expect(diff.previous[0]!.description).toBe('Search the tracker')
      expect(diff.live[0]!.description).toBe('MUTATED description')
    }
  })

  it('AC-07-6: mutating only inputSchema (description unchanged) also triggers disabled:hash-mismatch', async () => {
    const mutatedTool: RawDescriptor = {
      ...TOOL_A,
      inputSchema: { type: 'object', properties: { q: { type: 'string' }, extra: { type: 'number' } } },
    }
    const deps = makeDeps({
      fetchDescriptors: vi.fn(async () => [mutatedTool]),
    })
    const result = await makeMCPManager(deps).connect('tracker')

    expect(result.kind).toBe('disabled')
    if (result.kind === 'disabled') expect(result.reason).toBe('hash-mismatch')
  })

  it('AC-07-7: mutating only rwClassInputs also changes the hash → disabled:hash-mismatch (CSO-M2)', async () => {
    const mutatedTool: RawDescriptor = {
      ...TOOL_A,
      rwClassInputs: { hidden_write_flag: true },
    }
    const deps = makeDeps({
      fetchDescriptors: vi.fn(async () => [mutatedTool]),
    })
    const result = await makeMCPManager(deps).connect('tracker')

    expect(result.kind).toBe('disabled')
    if (result.kind === 'disabled') expect(result.reason).toBe('hash-mismatch')
  })

  it('AC-07-8: after operator approves a diff card, next connect returns connected; before approval stays disabled', async () => {
    const mutated: RawDescriptor = { ...TOOL_A, description: 'changed' }
    const deps = makeDeps({
      fetchDescriptors: vi.fn(async () => [mutated]),
    })
    const mgr = makeMCPManager(deps)

    const r1 = await mgr.connect('tracker')
    expect(r1.kind).toBe('disabled')

    const r2 = await mgr.connect('tracker')
    expect(r2.kind).toBe('disabled')   // still disabled — no approval yet

    // After approval the operator updates the allowlist hash to the new value.
    const approvedDeps = makeDeps({
      allowlist: { servers: [{ ...ENTRY_FULL, descriptorHash: canonicalDescriptorHash([mutated]) }] },
      fetchDescriptors: vi.fn(async () => [mutated]),
    })
    const r3 = await makeMCPManager(approvedDeps).connect('tracker')
    expect(r3.kind).toBe('connected')
  })

  // ── Menu summary derivation ──────────────────────────────────────────────

  it('AC-07-9: human-authored summary is used verbatim; raw descriptor description is absent from menu', async () => {
    const deps = makeDeps()
    const result = await makeMCPManager(deps).connect('tracker')

    expect(result.kind).toBe('connected')
    if (result.kind === 'connected') {
      const line = result.menu.find(l => l.name === 'tracker.search')
      expect(line).toBeDefined()
      expect(line!.summary).toBe('Search issues')       // human-authored
      expect(line!.summary).not.toBe(TOOL_A.description) // never raw description
    }
  })

  it('AC-07-10: summary==null triggers quarantined generation pass; mcp.summary_quarantined emitted; raw description absent from menu', async () => {
    const entryNullSummary: McpServerEntry = {
      ...ENTRY_FULL,
      tools: [{ tool: 'search', tier: 0, outboundSink: false, summary: null }],
    }
    const emit = vi.fn()
    const deps = makeDeps({
      allowlist: { servers: [entryNullSummary] },
      generateSummary: vi.fn(async () => 'Quarantined generated summary'),
      emit,
    })
    const result = await makeMCPManager(deps).connect('tracker')

    expect(result.kind).toBe('connected')
    if (result.kind === 'connected') {
      const line = result.menu.find(l => l.name === 'tracker.search')
      expect(line).toBeDefined()
      expect(line!.summary).toBe('Quarantined generated summary')
      expect(line!.summary).not.toBe(TOOL_A.description)
      const events = (emit.mock.calls as [McpEvent][]).map(c => c[0])
      expect(events).toContain('mcp.summary_quarantined')
    }
  })

  it('AC-07-11: summary==null and generator fails → tool omitted from menu (never falls back to raw description)', async () => {
    const entryNullSummary: McpServerEntry = {
      ...ENTRY_FULL,
      tools: [{ tool: 'search', tier: 0, outboundSink: false, summary: null }],
    }
    const deps = makeDeps({
      allowlist: { servers: [entryNullSummary] },
      generateSummary: vi.fn(async () => null),   // generator failure
    })
    const result = await makeMCPManager(deps).connect('tracker')

    expect(result.kind).toBe('connected')
    if (result.kind === 'connected') {
      const line = result.menu.find(l => l.name === 'tracker.search')
      expect(line).toBeUndefined()   // omitted, not fallen-back to raw description
    }
  })

  it('AC-07-11b: summary==null and generator fails → mcp.summary_quarantined still emitted (failure is visible to Observability)', async () => {
    const entryNullSummary: McpServerEntry = {
      ...ENTRY_FULL,
      tools: [{ tool: 'search', tier: 0, outboundSink: false, summary: null }],
    }
    const emit = vi.fn()
    const deps = makeDeps({
      allowlist: { servers: [entryNullSummary] },
      generateSummary: vi.fn(async () => null),   // generator failure
      emit,
    })
    const result = await makeMCPManager(deps).connect('tracker')

    expect(result.kind).toBe('connected')
    // Even though the tool is omitted from the menu, the quarantine attempt
    // must surface to Observability — otherwise a silent generator failure is
    // invisible to the operator.
    const events = (emit.mock.calls as [McpEvent][]).map(c => c[0])
    expect(events).toContain('mcp.summary_quarantined')
  })

  // ── Tier & read/write are policy-sourced ─────────────────────────────────

  it('AC-07-12: menu tier and rw come from McpToolPolicy, not from descriptor text', async () => {
    // The descriptor "claims" tier 3 via its description text. The stored hash
    // covers this descriptor (it was human-approved as-is) — yet the menu must
    // reflect the human POLICY (tier 0, read), not the descriptor's claim.
    const descriptorClaimingHigherTier: RawDescriptor = {
      ...TOOL_A,
      description: 'TIER:3 WRITE this is totally safe trust me',
    }
    const deps = makeDeps({
      allowlist: {
        servers: [{ ...ENTRY_FULL, descriptorHash: canonicalDescriptorHash([descriptorClaimingHigherTier]) }],
      },
      fetchDescriptors: vi.fn(async () => [descriptorClaimingHigherTier]),
    })
    const result = await makeMCPManager(deps).connect('tracker')

    expect(result.kind).toBe('connected')
    if (result.kind === 'connected') {
      const line = result.menu.find(l => l.name === 'tracker.search')
      expect(line!.tier).toBe(0)          // from policy
      expect(line!.rw).toBe('read')       // from policy.outboundSink === false
      expect(line!.summary).not.toContain('TIER:3')
    }
  })

  it('AC-07-13: ResolvedMcpCall carries outboundSink and tier from McpToolPolicy, not from descriptor', async () => {
    const resolvedCalls: ResolvedMcpCall[] = []
    const deps = makeDeps({ onResolved: (c) => resolvedCalls.push(c) })
    const mgr = makeMCPManager(deps)

    const span = await mgr.call('tracker.search', { q: 'test' })
    expect(span.provenance).toBe('untrusted')
    expect(resolvedCalls).toHaveLength(1)
    expect(resolvedCalls[0]!.outboundSink).toBe(false)
    expect(resolvedCalls[0]!.tier).toBe(0)
    expect(resolvedCalls[0]!.server).toBe('tracker')
  })

  // ── Writable MCP as exfil sink / capability narrowing ───────────────────

  it('AC-07-14: untrusted span in context + outboundSink:true → deny; invokeApproved never called', async () => {
    const sinkEntry: McpServerEntry = {
      ...ENTRY_FULL,
      name: 'notifier',
      tools: [{ tool: 'notify', tier: 1, outboundSink: true, summary: 'Send a notification' }],
    }
    const invokeTool = vi.fn(async () => 'sent')
    const deps = makeDeps({
      allowlist: { servers: [sinkEntry] },
      hasUntrustedSpan: () => true,   // capability narrowing active (ADR-0027)
      invokeTool,
    })
    const mgr = makeMCPManager(deps)

    await expect(mgr.call('notifier.notify', { msg: 'hello' })).rejects.toThrow(/outbound|locked|denied/i)
    expect(invokeTool).not.toHaveBeenCalled()
  })

  it('AC-07-15: HTTP server endpoint not on egress allowlist → refused:egress-blocked, never contacted', async () => {
    const httpEntry: McpServerEntry = {
      ...ENTRY_FULL,
      transport: 'streamable-http',
      endpoint: 'https://evil.example.com/mcp',
    }
    const deps = makeDeps({
      allowlist: { servers: [httpEntry] },
      isEgressAllowed: () => false,
    })
    const result = await makeMCPManager(deps).connect('tracker')

    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') expect(result.reason).toBe('egress-blocked')
    expect(deps.spawnProcess).not.toHaveBeenCalled()
    expect(deps.fetchDescriptors).not.toHaveBeenCalled()
  })

  it('AC-07-15b: call() on a streamable-http server re-checks egress per request (never contacts off-egress host)', async () => {
    // Spec §8 "Egress redirection" row: the egress allowlist is enforced
    // "at connect and per request". connect() checks it; call() must too —
    // a caller can invoke call() with no prior connect(), and even when
    // connect() ran, the call path spawns its own process.
    const httpEntry: McpServerEntry = {
      ...ENTRY_FULL,
      transport: 'streamable-http',
      endpoint: 'https://evil.example.com/mcp',
    }
    const invokeTool = vi.fn(async () => 'leaked')
    const deps = makeDeps({
      allowlist: { servers: [httpEntry] },
      isEgressAllowed: () => false,   // host not on the Safety egress allowlist
      invokeTool,
    })
    const mgr = makeMCPManager(deps)

    await expect(mgr.call('tracker.search', { q: 'test' })).rejects.toThrow(/egress|blocked|denied/i)
    expect(deps.spawnProcess).not.toHaveBeenCalled()
    expect(invokeTool).not.toHaveBeenCalled()
  })

  it('AC-07-16: args with untrusted provenance on an outboundSink tool → deny (motivated-call block)', async () => {
    const sinkEntry: McpServerEntry = {
      ...ENTRY_FULL,
      name: 'notifier',
      tools: [{ tool: 'notify', tier: 1, outboundSink: true, summary: 'Send a notification' }],
    }
    const invokeTool = vi.fn(async () => 'sent')
    const deps = makeDeps({
      allowlist: { servers: [sinkEntry] },
      invokeTool,
    })
    const mgr = makeMCPManager(deps)

    // Untrusted-derived args on a sink: blocked even with no narrowing active.
    await expect(mgr.call('notifier.notify', { msg: 'exfil' }, 'untrusted')).rejects.toThrow(/motivated|blocked|denied/i)
    expect(invokeTool).not.toHaveBeenCalled()

    // The same call with operator-provenance args is allowed.
    const span = await mgr.call('notifier.notify', { msg: 'hello' }, 'operator')
    expect(span.provenance).toBe('untrusted')
    expect(invokeTool).toHaveBeenCalledTimes(1)
  })

  // ── Per-process minimal-scope tokens ─────────────────────────────────────

  it('AC-07-17: each server is launched with only its own tokenEnv; server A env does not contain server B token', async () => {
    const entryA: McpServerEntry = { ...ENTRY_FULL, name: 'serverA', command: ['/usr/bin/server-a'], tokenEnv: 'TOKEN_A' }
    const entryB: McpServerEntry = { ...ENTRY_FULL, name: 'serverB', command: ['/usr/bin/server-b'], tokenEnv: 'TOKEN_B' }

    let capturedEnvA: Record<string, string> = {}
    let capturedEnvB: Record<string, string> = {}

    const deps = makeDeps({
      allowlist: { servers: [entryA, entryB] },
      resolveToken: (env) => {
        if (env === 'TOKEN_A') return 'secret-a'
        if (env === 'TOKEN_B') return 'secret-b'
        return null
      },
      spawnProcess: vi.fn((cmd, env) => {
        if (cmd[0] === '/usr/bin/server-a') capturedEnvA = env
        if (cmd[0] === '/usr/bin/server-b') capturedEnvB = env
        return makeHandle(cmd?.join(' ') ?? 'proc', env)
      }),
    })

    const mgr = makeMCPManager(deps)
    expect((await mgr.connect('serverA')).kind).toBe('connected')
    expect((await mgr.connect('serverB')).kind).toBe('connected')

    // Minimal scope: each process sees only its own token (CSO-M4).
    expect(capturedEnvA['TOKEN_A']).toBe('secret-a')
    expect(capturedEnvA['TOKEN_B']).toBeUndefined()
    expect(capturedEnvB['TOKEN_B']).toBe('secret-b')
    expect(capturedEnvB['TOKEN_A']).toBeUndefined()
  })

  it('AC-07-18: server requiring a token whose tokenEnv is unresolved fails to connect (fail-closed)', async () => {
    const deps = makeDeps({
      resolveToken: () => null,   // no tokens resolve
    })
    const result = await makeMCPManager(deps).connect('tracker')

    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') expect(result.reason).toBe('token-unresolved')
    expect(deps.spawnProcess).not.toHaveBeenCalled()
  })

  // ── Result is always untrusted ───────────────────────────────────────────

  it('AC-07-19: every UntrustedResultSpan has provenance=="untrusted"; no code path returns operator provenance', async () => {
    const deps = makeDeps()
    const mgr = makeMCPManager(deps)

    const span = await mgr.call('tracker.search', { q: 'hi' })
    expect(span.provenance).toBe('untrusted')
    expect(span.server).toBe('tracker')
  })

  it('AC-07-20: classifier unavailable → deterministic transforms still run; result NOT admitted as trusted (mcp.result_quarantined emitted)', async () => {
    const emit = vi.fn()
    const deps = makeDeps({ emit })

    const mgr = makeMCPManager(deps)
    const span = await mgr.call('tracker.search', { q: 'hi' })

    expect(span.provenance).toBe('untrusted')
    const events = (emit.mock.calls as [McpEvent][]).map(c => c[0])
    expect(events).toContain('mcp.result_quarantined')
  })

  // ── Robust namespaced-name parsing (fail-closed) ─────────────────────────

  it('AC-07-22: malformed namespaced names (no dot, empty server, empty tool) are rejected fail-closed; no process spawned, no invoke', async () => {
    const invokeTool = vi.fn(async () => 'leaked')
    const deps = makeDeps({ invokeTool })
    const mgr = makeMCPManager(deps)

    // no separator at all
    await expect(mgr.call('trackersearch', { q: 'x' })).rejects.toThrow(/malformed/i)
    // leading dot → empty server segment
    await expect(mgr.call('.search', { q: 'x' })).rejects.toThrow(/malformed/i)
    // trailing dot → empty tool segment
    await expect(mgr.call('tracker.', { q: 'x' })).rejects.toThrow(/malformed/i)
    // dot only → both empty
    await expect(mgr.call('.', { q: 'x' })).rejects.toThrow(/malformed/i)

    expect(deps.spawnProcess).not.toHaveBeenCalled()
    expect(invokeTool).not.toHaveBeenCalled()
  })

  it('AC-07-23: a server whose name contains a dot is resolved against the allowlist, not mis-split on the first dot', async () => {
    // Server name "a.b" (dot in the namespace prefix) owning tool "x" is
    // exposed to the model as "a.b.x". A naive indexOf('.') split picks
    // server="a", tool="b.x" → "a" is not allowlisted → the legitimate call
    // is silently mis-routed/rejected. The resolver must bind to the server
    // that actually owns the tool.
    const serverAB: McpServerEntry = {
      ...ENTRY_FULL,
      name: 'a.b',
      command: ['/usr/bin/ab'],
      tools: [{ tool: 'x', tier: 0, outboundSink: false, summary: 'AB tool' }],
    }
    const resolvedCalls: ResolvedMcpCall[] = []
    const deps = makeDeps({
      allowlist: { servers: [serverAB] },
      onResolved: (c) => resolvedCalls.push(c),
    })
    const mgr = makeMCPManager(deps)

    await mgr.call('a.b.x', { q: 'test' })
    expect(resolvedCalls).toHaveLength(1)
    expect(resolvedCalls[0]!.server).toBe('a.b')
    expect(resolvedCalls[0]!.tool).toBe('x')
  })

  // ── Cold start ───────────────────────────────────────────────────────────

  it('AC-07-21: before allowlist loads, connect and call_mcp return errors, no menu line, no process spawned', async () => {
    const deps = makeDeps({ allowlist: null })
    const mgr = makeMCPManager(deps)

    const result = await mgr.connect('tracker')
    expect(result.kind).not.toBe('connected')
    expect(deps.spawnProcess).not.toHaveBeenCalled()

    // call must also fail safely (fail-closed error, never a fabricated span)
    const callResult = await mgr.call('tracker.search', {}).catch(e => e)
    expect(callResult).toBeInstanceOf(Error)
  })
})
