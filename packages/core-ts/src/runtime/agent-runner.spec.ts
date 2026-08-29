import { describe, it, expect } from 'vitest'
import { makeAgentRunner, type AgentRunnerDeps } from './agent-runner.js'
import { makeGrantStore } from '../safety/index.js'
import { makeGuardian } from './guardian.js'
import type { ApprovalDecision } from './hook-gate.js'
import type { PendingAction } from '../gateway/index.js'
import type {
  ProviderAdapter,
  ModelResponse,
  MemoryPort,
  LoopGuardian,
  SessionLog,
  TranscriptRecordRequest,
  ToolCall,
  TurnInput,
} from '../agent-loop/types.js'

const memory: MemoryPort = {
  snapshot: async () => ({ prefixBytes: new Uint8Array(), prefixHash: 'h', breakpoints: [], takenAt: 't' }),
  forget: async () => {},
}
const guardian: LoopGuardian = { observe: () => ({ trip: false }), note: () => {} }
const sessionLog: SessionLog = { append: () => {}, resume: () => null }
const GRANT_BINDING = {
  operatorId: 'operator',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 's1',
  scope: 'project' as const,
}

function provider(...responses: ModelResponse[]): ProviderAdapter {
  let i = 0
  return { complete: async () => responses[Math.min(i++, responses.length - 1)]! }
}

function setup(opts: {
  responses: ModelResponse[]
  decision?: ApprovalDecision
  toolTiers?: AgentRunnerDeps['toolTiers']
  unsafeHostBashBypass?: () => boolean
}): { runner: ReturnType<typeof makeAgentRunner>; executed: ToolCall[]; approvals: number } {
  const executed: ToolCall[] = []
  let approvals = 0
  const deps: AgentRunnerDeps = {
    provider: provider(...opts.responses),
    memory,
    grants: makeGrantStore(),
    grantBinding: GRANT_BINDING,
    executeTool: (call) => void executed.push(call),
    approve: async () => {
      approvals++
      return opts.decision ?? { decision: 'rejected' }
    },
    guardian,
    sessionLog,
    clock: { now: () => '2026-06-16T00:00:00Z' },
    ...(opts.toolTiers === undefined ? {} : { toolTiers: opts.toolTiers }),
    ...(opts.unsafeHostBashBypass === undefined
      ? {}
      : { unsafeHostBashBypass: opts.unsafeHostBashBypass }),
  }
  const runner = makeAgentRunner(deps)
  return {
    runner,
    executed,
    get approvals() {
      return approvals
    },
  } as { runner: ReturnType<typeof makeAgentRunner>; executed: ToolCall[]; approvals: number }
}

function turn(text = 'do it'): TurnInput {
  return { sessionId: 's1', spans: [{ role: 'user', provenance: 'operator', text }] }
}

describe('call_mcp seam', () => {
  const mcpTurn = (): ModelResponse => ({
    reply: '',
    toolCalls: [{ name: 'call_mcp', args: { tool: 'tracker.search', args: { q: 'bug' } } }],
  })

  it('refuses call_mcp outright when no MCP capability is installed', async () => {
    const executed: ToolCall[] = []
    let approvals = 0
    const runner = makeAgentRunner({
      provider: provider(mcpTurn(), { reply: 'done' }),
      memory,
      grants: makeGrantStore(),
      grantBinding: GRANT_BINDING,
      executeTool: (call) => void executed.push(call),
      approve: async () => { approvals++; return { decision: 'confirmed' } },
      guardian,
      sessionLog,
    })

    await runner.handle(turn())

    // Not an unknown-tool error to the operator: an unavailable capability is
    // simply not a tool, and nothing about it reaches Safety or the executor.
    expect(executed).toEqual([])
    expect(approvals).toBe(0)
  })

  it('lets the capability own the tier, the approval identity and the result', async () => {
    const executed: ToolCall[] = []
    const completed: Array<{ tool: string; allowed: boolean }> = []
    let approvals = 0
    const runner = makeAgentRunner({
      provider: provider(mcpTurn(), { reply: 'done' }),
      memory,
      grants: makeGrantStore(),
      grantBinding: GRANT_BINDING,
      executeTool: (call) => void executed.push(call),
      approve: async () => { approvals++; return { decision: 'confirmed' } },
      guardian,
      sessionLog,
      mcpCapability: {
        // Exactly the shape the real capability runtime returns: a tool name
        // carrying the server policy, not the wrapper's name.
        resolveSafetyCall: (call, ctx) => ({
          tool: 'mcp:write:tracker.search',
          args: call.args['args'] as Record<string, unknown>,
          policyTier: 2,
          outboundSink: true,
          argsTainted: ctx.provenance === 'untrusted',
        }),
        completeSafetyCall: (_call, safetyCall, allowed) => {
          completed.push({ tool: safetyCall.tool, allowed })
        },
      },
    })

    await runner.handle(turn())

    // Tier 2 came from the MCP policy, so the operator was asked — the wrapper
    // itself has no tier that could have decided this.
    expect(approvals).toBe(1)
    expect(completed).toEqual([{ tool: 'mcp:write:tracker.search', allowed: true }])
    expect(executed).toEqual([{ name: 'call_mcp', args: { tool: 'tracker.search', args: { q: 'bug' } } }])
  })
})

describe('makeAgentRunner.handle', () => {
  it('makes every conversational policy relaxation a Tier-3 confirmed action', async () => {
    const approvals: PendingAction[] = []
    const executed: ToolCall[] = []
    const runner = makeAgentRunner({
      provider: provider({
        reply: '',
        toolCalls: [{
          name: 'configure_agent',
          args: { operation: 'policy.relax-path', target: 'opaque', value: 'read-only' },
        }],
      }, { reply: 'Готово.' }),
      memory,
      grants: makeGrantStore(),
      grantBinding: GRANT_BINDING,
      executeTool: (call) => { executed.push(call); return { ok: true } },
      approve: async (action) => { approvals.push(action); return { decision: 'confirmed' } },
      describePolicyRelaxation: (_call, context) =>
        context.sessionId === 's1'
          ? { scope: 'path', relativePath: 'docs/private' }
          : null,
      guardian,
      sessionLog,
    })

    await runner.handle(turn('Разреши запись в выбранной папке'))

    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      tier: 3,
      requiresStepUp: true,
      canRememberSimilar: false,
      summary: 'Ослабить настройку «только чтение» для папки «docs/private». После этого агент получит больше свободы.',
    })
    expect(executed).toEqual([{
      name: 'configure_agent',
      args: { operation: 'policy.relax-path', target: 'opaque', value: 'read-only' },
    }])
  })

  it('forwards the recorder seam after applying lazy turn augmentation', async () => {
    const records: TranscriptRecordRequest[] = []
    const starts: string[] = []
    const runner = makeAgentRunner({
      provider: provider({ reply: 'ok' }),
      memory,
      grants: makeGrantStore(),
      executeTool: () => ({ ok: true }),
      approve: async () => ({ decision: 'rejected' }),
      guardian,
      sessionLog,
      transcriptRecorder: {
        start: async input => {
          starts.push(new TextDecoder().decode(input.frozen.prefixBytes))
          return structuredClone(input.frozen)
        },
        history: async () => [],
        record: async input => { records.push(structuredClone(input)) },
      },
      augmentTurn: async () => [{ role: 'system', provenance: 'operator', text: 'triggered skill' }],
    })

    await runner.handle({
      ...turn('hello'),
      turnId: 'turn-1',
      turnTs: '2026-07-27T01:02:03.000Z',
    })

    expect(starts).toEqual([''])
    expect(records.map(item => item.span)).toEqual([
      { role: 'user', provenance: 'operator', text: 'hello' },
      { role: 'system', provenance: 'operator', text: 'triggered skill' },
      { role: 'assistant', provenance: 'untrusted', text: 'ok' },
    ])
  })

  it('runs a turn the transport could not identify — a greeting has no batch to replay', async () => {
    const records: TranscriptRecordRequest[] = []
    const runner = makeAgentRunner({
      provider: provider({ reply: 'ok' }),
      memory,
      grants: makeGrantStore(),
      executeTool: () => ({ ok: true }),
      approve: async () => ({ decision: 'rejected' }),
      guardian,
      sessionLog,
      clock: { now: () => '2026-08-08T10:00:00.000Z' },
      transcriptRecorder: {
        start: async input => structuredClone(input.frozen),
        history: async () => [],
        record: async input => { records.push(structuredClone(input)) },
      },
    })

    await runner.handle(turn('привет'))
    await runner.handle(turn('и ещё раз'))

    // Minted, not blank — and distinct per turn, or the second turn's rows
    // would look like a replay of the first.
    const ids = [...new Set(records.map(item => item.turnId))]
    expect(ids).toHaveLength(2)
    expect(ids.every(id => id.length > 0)).toBe(true)
    expect(records.every(item => item.turnTs === '2026-08-08T10:00:00.000Z')).toBe(true)
  })

  it('mints provider turn identity even when transcript recording is explicitly disabled', async () => {
    const seen: Array<string | undefined> = []
    const runner = makeAgentRunner({
      provider: { complete: async request => { seen.push(request.turnId); return { reply: 'ok' } } },
      memory,
      grants: makeGrantStore(),
      executeTool: () => ({ ok: true }),
      approve: async () => ({ decision: 'rejected' }),
      guardian,
      sessionLog,
      clock: { now: () => '2026-08-09T00:00:00.000Z' },
    })

    await runner.handle(turn('proactive plan'))
    expect(seen).toEqual(['local:s1:2026-08-09T00:00:00.000Z:1'])
  })

  it('keeps the transport’s own turn identity when it supplies one', async () => {
    const records: TranscriptRecordRequest[] = []
    const runner = makeAgentRunner({
      provider: provider({ reply: 'ok' }),
      memory,
      grants: makeGrantStore(),
      executeTool: () => ({ ok: true }),
      approve: async () => ({ decision: 'rejected' }),
      guardian,
      sessionLog,
      transcriptRecorder: {
        start: async input => structuredClone(input.frozen),
        history: async () => [],
        record: async input => { records.push(structuredClone(input)) },
      },
    })

    await runner.handle({ ...turn('hello'), turnId: 'telegram:1:abc', turnTs: '2026-07-27T01:02:03.000Z' })

    expect(records.every(item => item.turnId === 'telegram:1:abc')).toBe(true)
  })

  it('freezes a prefix extension once per session and lazily augments every turn', async () => {
    const seen: Array<{ prefix: string; spans: string[] }> = []
    let prefixCalls = 0
    const runner = makeAgentRunner({
      provider: {
        async complete(request) {
          seen.push({
            prefix: new TextDecoder().decode(request.prefixBytes),
            spans: request.spans.map(span => span.text),
          })
          return { reply: 'ok' }
        },
      },
      memory,
      grants: makeGrantStore(),
      executeTool: () => ({ ok: true }),
      approve: async () => ({ decision: 'rejected' }),
      guardian,
      sessionLog,
      prefixExtension: () => {
        prefixCalls++
        return new TextEncoder().encode('skills menu')
      },
      augmentTurn: async input => [{
        role: 'system',
        provenance: 'operator',
        text: `skill body for ${input.spans[0]?.text ?? ''}`,
      }],
    })
    await runner.handle(turn('first'))
    await runner.handle(turn('second'))
    expect(prefixCalls).toBe(1)
    expect(seen.map(item => item.prefix)).toEqual(['skills menu', 'skills menu'])
    expect(seen[0]?.spans).toContain('skill body for first')
    expect(seen[1]?.spans).toContain('skill body for second')
  })

  it('freezes global DNA within a session and reloads its source for a new session', async () => {
    const seen: Array<{ sessionId: string; prefix: string }> = []
    let snapshotCalls = 0
    const runner = makeAgentRunner({
      provider: {
        async complete(request) {
          seen.push({
            sessionId: request.sessionId,
            prefix: new TextDecoder().decode(request.prefixBytes),
          })
          return { reply: 'ok' }
        },
      },
      memory: {
        snapshot: async () => {
          snapshotCalls++
          return {
            prefixBytes: new TextEncoder().encode(`global-dna-v${snapshotCalls}`),
            prefixHash: `hash-${snapshotCalls}`,
            breakpoints: [],
            takenAt: `time-${snapshotCalls}`,
          }
        },
        forget: async () => {},
      },
      grants: makeGrantStore(),
      executeTool: () => ({ ok: true }),
      approve: async () => ({ decision: 'rejected' }),
      guardian,
      sessionLog,
    })

    await runner.handle(turn('first'))
    await runner.handle(turn('second'))
    await runner.handle({ ...turn('new session'), sessionId: 's2' })

    expect(snapshotCalls).toBe(2)
    expect(seen).toEqual([
      { sessionId: 's1', prefix: 'global-dna-v1' },
      { sessionId: 's1', prefix: 'global-dna-v1' },
      { sessionId: 's2', prefix: 'global-dna-v2' },
    ])
  })

  it('returns a plain reply with no tools', async () => {
    const { runner, executed } = setup({ responses: [{ reply: 'hi' }] })
    const res = await runner.handle(turn())
    expect(res).toMatchObject({ reply: 'hi', state: 'ok' })
    expect(executed).toHaveLength(0)
  })

  it('executes a Tier-0 tool without an approval', async () => {
    // ADR-0102: tool then a synthesis reply that ends the turn (one dispatch).
    const s = setup({ responses: [{ reply: '', toolCalls: [{ name: 'read_file', args: { path: 'a' } }] }, { reply: 'done' }] })
    await s.runner.handle(turn())
    expect(s.executed).toEqual([{ name: 'read_file', args: { path: 'a' } }])
    expect(s.approvals).toBe(0)
  })

  it('enforces an AgentCard tier tightening in the live Safety call', async () => {
    const s = setup({
      responses: [{ reply: '', toolCalls: [{ name: 'read_file', args: { path: 'a' } }] }],
      toolTiers: { read_file: 2 },
      decision: { decision: 'rejected' },
    })
    await s.runner.handle(turn())
    expect(s.approvals).toBe(1)
    expect(s.executed).toEqual([])
  })

  it('a confirmed approval lets a Tier-2 tool execute', async () => {
    const s = setup({
      responses: [{ reply: 'ok', toolCalls: [{ name: 'bash', args: { cmd: 'npm test' } }] }, { reply: 'done' }],
      decision: { decision: 'confirmed' },
    })
    await s.runner.handle(turn())
    expect(s.approvals).toBe(1)
    expect(s.executed.map((c) => c.name)).toEqual(['bash'])
  })

  it('a rejected approval blocks the Tier-2 tool', async () => {
    const s = setup({
      responses: [{ reply: 'ok', toolCalls: [{ name: 'bash', args: { cmd: 'npm test' } }] }],
      decision: { decision: 'rejected' },
    })
    await s.runner.handle(turn())
    expect(s.executed).toHaveLength(0)
  })

  it('bypasses denial and approval only for exact host Bash when explicitly active', async () => {
    const destructiveFixture = `${['r', 'm'].join('')} ${['-rf', '/'].join(' ')}`
    const s = setup({
      responses: [
        { reply: '', toolCalls: [{ name: 'bash', args: { cmd: destructiveFixture } }] },
        { reply: 'done' },
      ],
      unsafeHostBashBypass: () => true,
    })

    await s.runner.handle({
      sessionId: 's1',
      spans: [{ role: 'user', provenance: 'untrusted', text: 'host command' }],
    })
    expect(s.approvals).toBe(0)
    expect(s.executed).toEqual([{ name: 'bash', args: { cmd: destructiveFixture } }])
  })

  it('does not extend Bash bypass to another tool', async () => {
    const s = setup({
      responses: [{ reply: '', toolCalls: [{ name: 'write_file', args: { path: 'a', content: 'b' } }] }],
      unsafeHostBashBypass: () => true,
      decision: { decision: 'rejected' },
    })

    await s.runner.handle(turn())
    expect(s.approvals).toBe(1)
    expect(s.executed).toEqual([])
  })

  it('surfaces narrowed=true and accumulated usage in the TurnResult', async () => {
    const s = setup({
      responses: [{ reply: 'ok', usage: { inputTokens: 100, outputTokens: 20, dollars: 0.01 } }],
    })
    const res = await s.runner.handle({
      sessionId: 's1',
      spans: [{ role: 'user', provenance: 'untrusted', text: 'forwarded' }],
    })
    expect(res.narrowed).toBe(true)
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 20, dollars: 0.01 })
  })

  it('reports narrowed=false for a clean operator turn', async () => {
    const s = setup({ responses: [{ reply: 'hi' }] })
    const res = await s.runner.handle(turn())
    expect(res.narrowed).toBe(false)
  })

  it('a similar session grant suppresses only the matching second card', async () => {
    const s = setup({
      responses: [
        {
          reply: '',
          toolCalls: [
            { name: 'bash', args: { cmd: 'pnpm test' } },
            { name: 'bash', args: { cmd: 'pnpm   test' } },
          ],
        },
        { reply: 'done' }, // ADR-0102 synthesis reply ends the turn
      ],
      decision: { decision: 'confirmed', scope: 'session' },
    })
    await s.runner.handle(turn())
    expect(s.approvals).toBe(1)
    expect(s.executed.map((c) => c.args['cmd'])).toEqual(['pnpm test', 'pnpm   test'])
  })

  it('forwards budgetCheck to the loop (halts with budget-capped)', async () => {
    const provider: ProviderAdapter = {
      async complete() { return { reply: 'hi', usage: { inputTokens: 10, outputTokens: 5, dollars: 1 } } },
    }
    const runner = makeAgentRunner({
      provider,
      memory: { async snapshot() { return { prefixBytes: new Uint8Array(0), prefixHash: 'h', breakpoints: [], takenAt: '2026-01-01T00:00:00.000Z' } }, async forget() {} },
      grants: makeGrantStore({ persistence: { load: () => undefined, save: () => {} } }),
      grantBinding: GRANT_BINDING,
      executeTool: () => ({ ok: true }),
      approve: async () => ({ decision: 'rejected' }),
      guardian: makeGuardian(),
      sessionLog: { append() {}, resume: () => null },
      budgetCheck: () => true,
    })
    const result = await runner.handle({ sessionId: 's', spans: [{ role: 'user', provenance: 'operator', text: 'hi' }] })
    expect(result.state).toBe('halted')
    expect(result.haltReason).toBe('budget-capped')
  })
})
