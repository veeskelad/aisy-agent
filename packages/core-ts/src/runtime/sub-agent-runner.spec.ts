import { describe, it, expect } from 'vitest'
import { makeSubAgentRunner } from './sub-agent-runner.js'
import type { ProviderAdapter } from '../agent-loop/types.js'
import type { DelegationHandle, AgentCard } from '../orchestration/index.js'
import type { LoopGuardian } from '../agent-loop/types.js'
import type { MemoryPort, SessionLog } from '../agent-loop/types.js'

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

function fakeGuardian(): LoopGuardian {
  return {
    observe: () => ({ trip: false }),
    note: () => {},
  }
}

function fakeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'general',
    skills: [],
    mcpAllowlist: [],
    toolTiers: { read_file: 1 },
    maxIterations: 5,
    contextStrategy: 'compact',
    provenance: 'builtin',
    ...overrides,
  }
}

function fakeHandle(overrides: Partial<DelegationHandle> = {}): DelegationHandle {
  return {
    delegationId: 'd1',
    taskId: 't1',
    card: fakeCard(),
    owns: ['src/**'],
    writableMcp: [],
    permitsTool: (n: string) => n === 'read_file',
    permitsMcp: () => false,
    append: () => ({}) as ReturnType<DelegationHandle['append']>,
    shard: () => [],
    get guardian() {
      return fakeGuardian()
    },
    complete: () => ({}) as ReturnType<DelegationHandle['complete']>,
    fail: () => ({}) as ReturnType<DelegationHandle['fail']>,
    ...overrides,
  } as DelegationHandle
}

const memFake: MemoryPort = {
  snapshot: async () => ({
    prefixBytes: new Uint8Array(0),
    prefixHash: 'h',
    breakpoints: [],
    takenAt: '2026-01-01T00:00:00.000Z',
  }),
  forget: async () => {},
}

const logFake: SessionLog = {
  append() {},
  resume: () => null,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeSubAgentRunner', () => {
  it('a sub-agent inherits parent narrowing (operator span is forced untrusted)', async () => {
    const provider: ProviderAdapter = {
      async complete() {
        return { reply: 'done', toolCalls: [] }
      },
    }
    const runner = makeSubAgentRunner({
      handle: fakeHandle(),
      provider,
      baseExecuteTool: async () => ({ ok: true, output: '' }),
      approve: async () => ({ decision: 'rejected' }),
      memory: memFake,
      sessionLog: logFake,
      parentNarrowed: true,
      doNotTouch: [],
    })
    const result = await runner.handle({
      sessionId: 'd1',
      spans: [{ role: 'user', provenance: 'operator', text: 'do it' }],
    })
    expect(result.narrowed).toBe(true)
  })

  it('a non-narrowed parent leaves the sub-agent un-narrowed', async () => {
    const provider: ProviderAdapter = {
      async complete() {
        return { reply: 'done', toolCalls: [] }
      },
    }
    const runner = makeSubAgentRunner({
      handle: fakeHandle(),
      provider,
      baseExecuteTool: async () => ({ ok: true, output: '' }),
      approve: async () => ({ decision: 'rejected' }),
      memory: memFake,
      sessionLog: logFake,
      parentNarrowed: false,
      doNotTouch: [],
    })
    const result = await runner.handle({
      sessionId: 'd1',
      spans: [{ role: 'user', provenance: 'operator', text: 'do it' }],
    })
    expect(result.narrowed).toBe(false)
  })

  it('caps the sub-agent at card.maxIterations (passed as maxTotalToolCalls)', async () => {
    // Use distinct args per call so the guardian (cycle-detector) never trips —
    // only the tool-call cap should fire.
    let callIndex = 0
    const provider: ProviderAdapter = {
      async complete() {
        return {
          reply: 'x',
          toolCalls: Array.from({ length: 10 }, (_, i) => ({
            name: 'read_file',
            args: { n: callIndex++ * 10 + i },
          })),
        }
      },
    }
    const runner = makeSubAgentRunner({
      handle: fakeHandle({ card: fakeCard({ maxIterations: 3 }) }),
      provider,
      baseExecuteTool: async () => ({ ok: true, output: '' }),
      approve: async () => ({ decision: 'rejected' }),
      memory: memFake,
      sessionLog: logFake,
      parentNarrowed: false,
      doNotTouch: [],
    })
    const result = await runner.handle({
      sessionId: 'd1',
      spans: [{ role: 'user', provenance: 'operator', text: 'go' }],
    })
    expect(result.state).toBe('halted')
    expect(result.haltReason).toBe('cap-exceeded')
  })
})
