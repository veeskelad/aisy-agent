import { describe, it, expect } from 'vitest'
import { makeAgentRunner, type AgentRunnerDeps } from './agent-runner.js'
import { makeGrantStore } from '../safety/index.js'
import type { ApprovalDecision } from './hook-gate.js'
import type {
  ProviderAdapter,
  ModelResponse,
  MemoryPort,
  LoopGuardian,
  SessionLog,
  ToolCall,
  TurnInput,
} from '../agent-loop/types.js'

const memory: MemoryPort = {
  snapshot: async () => ({ prefixBytes: new Uint8Array(), prefixHash: 'h', breakpoints: [], takenAt: 't' }),
  forget: async () => {},
}
const guardian: LoopGuardian = { observe: () => ({ trip: false }), note: () => {} }
const sessionLog: SessionLog = { append: () => {}, resume: () => null }

function provider(...responses: ModelResponse[]): ProviderAdapter {
  let i = 0
  return { complete: async () => responses[Math.min(i++, responses.length - 1)]! }
}

function setup(opts: {
  responses: ModelResponse[]
  decision?: ApprovalDecision
}): { runner: ReturnType<typeof makeAgentRunner>; executed: ToolCall[]; approvals: number } {
  const executed: ToolCall[] = []
  let approvals = 0
  const deps: AgentRunnerDeps = {
    provider: provider(...opts.responses),
    memory,
    grants: makeGrantStore(),
    executeTool: (call) => void executed.push(call),
    approve: async () => {
      approvals++
      return opts.decision ?? { decision: 'rejected' }
    },
    guardian,
    sessionLog,
    clock: { now: () => '2026-06-16T00:00:00Z' },
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

describe('makeAgentRunner.handle', () => {
  it('returns a plain reply with no tools', async () => {
    const { runner, executed } = setup({ responses: [{ reply: 'hi' }] })
    const res = await runner.handle(turn())
    expect(res).toMatchObject({ reply: 'hi', state: 'ok' })
    expect(executed).toHaveLength(0)
  })

  it('executes a Tier-0 tool without an approval', async () => {
    const s = setup({ responses: [{ reply: '', toolCalls: [{ name: 'read_file', args: { path: 'a' } }] }] })
    await s.runner.handle(turn())
    expect(s.executed).toEqual([{ name: 'read_file', args: { path: 'a' } }])
    expect(s.approvals).toBe(0)
  })

  it('a confirmed approval lets a Tier-2 tool execute', async () => {
    const s = setup({
      responses: [{ reply: 'ok', toolCalls: [{ name: 'bash', args: { cmd: 'npm test' } }] }],
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

  it('a session grant suppresses the second cards: approve once, execute twice', async () => {
    const s = setup({
      responses: [
        {
          reply: '',
          toolCalls: [
            { name: 'bash', args: { cmd: 'a' } },
            { name: 'bash', args: { cmd: 'b' } },
          ],
        },
      ],
      decision: { decision: 'confirmed', scope: 'session' },
    })
    await s.runner.handle(turn())
    expect(s.approvals).toBe(1) // second bash allowed by the recorded grant
    expect(s.executed.map((c) => c.args['cmd'])).toEqual(['a', 'b'])
  })
})
