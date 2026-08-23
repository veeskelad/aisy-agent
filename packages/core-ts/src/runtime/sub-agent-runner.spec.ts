import { describe, it, expect } from 'vitest'
import { makeBoundSubAgentRunner, makeSubAgentRunner } from './sub-agent-runner.js'
import type { ProviderAdapter } from '../agent-loop/types.js'
import { isGenuineToolExecutionContextFor } from '../agent-loop/index.js'
import type { ModelProgressEvent, ToolExecutionContext } from '../agent-loop/types.js'
import type { DelegationHandle, AgentCard, DelegationTask, ShardEntry } from '../orchestration/index.js'
import type { LoopGuardian } from '../agent-loop/types.js'
import type { MemoryPort, SessionLog } from '../agent-loop/types.js'
import {
  resolveAgentCapabilityMatrix,
  resolveDelegationExecutionAuthority,
} from './agent-capabilities.js'
import { runtimeProviderTools } from './tool-catalog.js'

const runtimeTool = (name: string) => runtimeProviderTools().find(tool => tool.name === name)!

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
    instructions: 'Read and report.',
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
    binding: {
      operatorId: 'operator-1', profileId: 'default', projectId: 'project-1',
      sessionId: 'session-1', scope: 'session',
    },
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
  it('injects the immutable AgentCard Markdown body as the child system DNA', async () => {
    let seen = ''
    const provider: ProviderAdapter = {
      async complete(request) {
        seen = request.spans.find(span => span.role === 'system')?.text ?? ''
        return { reply: 'done', toolCalls: [] }
      },
    }
    const runner = makeSubAgentRunner({
      handle: fakeHandle({ card: fakeCard({ instructions: 'Follow the reviewer DNA.' }) }),
      provider,
      baseExecuteTool: async () => ({ ok: true, output: '' }),
      approve: async () => ({ decision: 'rejected' }),
      memory: memFake,
      sessionLog: logFake,
      parentNarrowed: false,
      doNotTouch: [],
    })
    await runner.handle({
      sessionId: 'd1',
      spans: [{ role: 'user', provenance: 'operator', text: 'review' }],
    })
    expect(seen).toBe('Follow the reviewer DNA.')
  })

  it('treats community AgentCard DNA as untrusted and starts the child narrowed', async () => {
    const provider: ProviderAdapter = {
      async complete() { return { reply: 'done', toolCalls: [] } },
    }
    const runner = makeSubAgentRunner({
      handle: fakeHandle({ card: fakeCard({ provenance: 'community' }) }),
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
      spans: [{ role: 'user', provenance: 'operator', text: 'review' }],
    })
    expect(result.narrowed).toBe(true)
  })

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

function boundTask(): DelegationTask {
  return {
    taskId: 't1',
    intent: 'read evidence',
    assignedTo: 'general',
    dependsOn: [],
    scope: { owns: ['src/**'], doNotTouch: ['src/private/**'], taskClass: 'reasoning' },
    budgetSlice: { iterations: 4, spendUsd: 0.2 },
    outputContract: 'summary',
    retryPolicy: { maxReplans: 1, maxIterations: 3 },
  }
}

function boundHandle(overrides: Partial<DelegationHandle> = {}): DelegationHandle {
  return fakeHandle({ delegationId: 'd-t1', ...overrides })
}

function boundAuthority(handle = boundHandle()) {
  const matrix = resolveAgentCapabilityMatrix({
    card: handle.card,
    toolCatalog: [runtimeTool('read_file')],
    activeSkills: new Set(),
    activeMcpServers: new Set(),
  })
  return resolveDelegationExecutionAuthority({
    handle,
    task: boundTask(),
    matrix,
    maxConcurrency: 2,
  })
}

function authorityJournal(initial: ShardEntry[] = [], chainOverride?: boolean) {
  const entries = structuredClone(initial)
  let appends = 0
  return {
    entries,
    get appends() { return appends },
    appendAuthoritySeal(authorityHash: string): ShardEntry {
      appends++
      const previous = entries[entries.length - 1]
      const entry: ShardEntry = {
        delegationId: 'd-t1', seq: entries.length + 1,
        prevHash: previous?.hash ?? '0'.repeat(64), hash: `${entries.length + 1}`.padStart(64, '0'),
        kind: 'runtime.agent-authority.v1',
        payload: { schemaVersion: 1, authorityHash },
        ts: '2026-07-28T00:00:00.000Z',
      }
      entries.push(entry)
      return structuredClone(entry)
    },
    shard: () => structuredClone(entries),
    verifyShardChain: () => chainOverride ?? entries.every((entry, index) =>
      entry.seq === index + 1 && entry.delegationId === 'd-t1' &&
      entry.prevHash === (index === 0 ? '0'.repeat(64) : entries[index - 1]!.hash) &&
      entry.hash.length === 64),
  }
}

describe('makeBoundSubAgentRunner', () => {
  it('seals authority before provider construction and gives the provider only frozen schemas', async () => {
    const authority = boundAuthority()
    const journal = authorityJournal()
    const order: string[] = []
    const originalAppend = journal.appendAuthoritySeal.bind(journal)
    journal.appendAuthoritySeal = (authorityHash) => {
      order.push('seal')
      return originalAppend(authorityHash)
    }
    let seenTools: readonly unknown[] = []
    const runner = makeBoundSubAgentRunner({
      authority,
      authorityJournal: journal,
      permitsTool: name => name === 'read_file',
      providerFactory: tools => {
        order.push('provider')
        seenTools = tools
        return { async complete() { return { reply: 'done' } } }
      },
      baseExecuteTool: async () => ({ ok: true, output: '' }),
      approve: async () => ({ decision: 'rejected' }),
      memory: memFake,
      sessionLog: logFake,
      parentNarrowed: false,
      budgetCheck: () => false,
    })

    expect(order).toEqual(['seal'])
    expect(journal.appends).toBe(1)
    await expect(runner.handle({
      sessionId: 'd-t1', spans: [{ role: 'user', provenance: 'operator', text: 'go' }],
    })).resolves.toMatchObject({ state: 'ok', reply: 'done' })
    expect(order).toEqual(['seal', 'provider'])
    expect(Object.isFrozen(seenTools)).toBe(true)
    expect(Object.isFrozen((seenTools[0] as { input_schema: object }).input_schema)).toBe(true)
  })

  it('forwards the exact abort signal, provider progress event, and genuine tool context', async () => {
    const controller = new AbortController()
    const providerEvent = Object.freeze({ type: 'thinking', safeSummary: 'working' }) satisfies ModelProgressEvent
    const progressEvents: unknown[] = []
    let seenSignal: AbortSignal | undefined
    let seenContext: ToolExecutionContext | undefined
    let providerRound = 0
    const runner = makeBoundSubAgentRunner({
      authority: boundAuthority(),
      authorityJournal: authorityJournal(),
      permitsTool: name => name === 'read_file',
      providerFactory: () => ({
        async complete(_request, signal, onProgress) {
          seenSignal = signal
          await onProgress?.(providerEvent)
          return providerRound++ === 0
            ? { reply: '', toolCalls: [{ name: 'read_file', args: { path: 'src/a.ts' } }] }
            : { reply: 'done' }
        },
      }),
      baseExecuteTool: async (_call, context) => {
        seenContext = context
        return { ok: true, output: 'read' }
      },
      approve: async () => ({ decision: 'rejected' }),
      memory: memFake,
      sessionLog: logFake,
      parentNarrowed: false,
      budgetCheck: () => false,
    })

    await expect(runner.handle({
      sessionId: 'd-t1',
      turnId: 'turn-1',
      signal: controller.signal,
      onProgress: event => { progressEvents.push(event) },
      spans: [{ role: 'user', provenance: 'operator', text: 'go' }],
    })).resolves.toMatchObject({ state: 'ok', reply: 'done' })

    expect(seenSignal).toBe(controller.signal)
    expect(progressEvents).toContain(providerEvent)
    expect(seenContext?.signal).toBe(controller.signal)
    expect(seenContext).toMatchObject({ sessionId: 'd-t1', turnId: 'turn-1', ordinal: 1 })
    expect(isGenuineToolExecutionContextFor(seenContext, 'read_file')).toBe(true)
  })

  it('exposes only the manager-owned seal operation, so child code cannot choose a reserved record kind', () => {
    const journal = authorityJournal()
    expect('append' in journal).toBe(false)
    expect(Object.keys(journal).sort()).toEqual([
      'appendAuthoritySeal', 'appends', 'entries', 'shard', 'verifyShardChain',
    ])

    makeBoundSubAgentRunner({
      authority: boundAuthority(),
      authorityJournal: journal,
      permitsTool: () => true,
      providerFactory: () => ({ async complete() { return { reply: 'done' } } }),
      baseExecuteTool: async () => ({ ok: true, output: '' }),
      approve: async () => ({ decision: 'rejected' }),
      memory: memFake,
      sessionLog: logFake,
      parentNarrowed: false,
      budgetCheck: () => false,
    })
    expect(journal.entries).toHaveLength(1)
    expect(journal.entries[0]).toMatchObject({
      kind: 'runtime.agent-authority.v1',
      payload: { schemaVersion: 1, authorityHash: boundAuthority().authorityHash },
    })
  })

  it.each([
    ['DNA', (value: ReturnType<typeof boundAuthority>) => {
      ;(value.dna as { body: string }).body = 'tampered DNA'
    }],
    ['tool schema', (value: ReturnType<typeof boundAuthority>) => {
      ;(value.capabilities.tools[0]!.input_schema as Record<string, unknown>)['required'] = ['token']
    }],
    ['scope', (value: ReturnType<typeof boundAuthority>) => {
      ;(value.scope.owns as string[]).push('secrets/**')
    }],
    ['limits', (value: ReturnType<typeof boundAuthority>) => {
      ;(value.limits as { maxIterations: number }).maxIterations = 2
    }],
    ['checkpoint hash', (value: ReturnType<typeof boundAuthority>) => {
      ;(value as { authorityHash: string }).authorityHash = '0'.repeat(64)
    }],
  ])('rejects stale-hash %s authority before journal or provider I/O', (label, mutate) => {
    const authority = structuredClone(boundAuthority())
    mutate(authority)
    const journal = authorityJournal()
    let factories = 0

    expect(() => makeBoundSubAgentRunner({
      authority,
      authorityJournal: journal,
      permitsTool: () => true,
      providerFactory: () => {
        factories++
        return { async complete() { return { reply: 'unreachable' } } }
      },
      baseExecuteTool: async () => ({ ok: true, output: '' }),
      approve: async () => ({ decision: 'rejected' }),
      memory: memFake,
      sessionLog: logFake,
      parentNarrowed: false,
      budgetCheck: () => false,
    })).toThrow(expect.objectContaining({
      code: label === 'tool schema' ? 'CAPABILITY_MISMATCH' : 'AUTHORITY_CHECKPOINT_MISMATCH',
    }))
    expect(journal.appends).toBe(0)
    expect(factories).toBe(0)
  })

  it('defensively snapshots authority so later provider/executor mutations cannot widen it', async () => {
    const supplied = structuredClone(boundAuthority())
    let providerTools: readonly { name: string }[] = []
    let firstSpan = ''
    let round = 0
    let baseCalls = 0
    const runner = makeBoundSubAgentRunner({
      authority: supplied,
      authorityJournal: authorityJournal(),
      permitsTool: name => name === 'read_file',
      providerFactory: tools => {
        providerTools = tools
        return {
          async complete(request) {
            firstSpan = request.spans[0]?.text ?? ''
            return round++ === 0
              ? { reply: '', toolCalls: [{ name: 'write_file', args: { path: 'secrets/a' } }] }
              : { reply: 'done' }
          },
        }
      },
      baseExecuteTool: async () => { baseCalls++; return { ok: true, output: '' } },
      approve: async () => ({ decision: 'rejected' }),
      memory: memFake,
      sessionLog: logFake,
      parentNarrowed: false,
      budgetCheck: () => false,
    })

    ;(supplied.dna as { body: string }).body = 'mutated after construction'
    ;(supplied.capabilities.tools[0] as { name: string }).name = 'write_file'
    ;(supplied.capabilities.tools[0]!.input_schema as Record<string, unknown>)['required'] = ['token']
    ;(supplied.scope.owns as string[]).push('secrets/**')
    ;(supplied.limits as { maxIterations: number }).maxIterations = 99

    await expect(runner.handle({
      sessionId: 'd-t1', spans: [{ role: 'user', provenance: 'operator', text: 'go' }],
    })).resolves.toMatchObject({ state: 'ok', reply: '' })
    expect(firstSpan).toBe('Read and report.')
    expect(providerTools.map(tool => tool.name)).toEqual(['read_file'])
    expect(Object.isFrozen(providerTools)).toBe(true)
    expect(runner.authority.scope.owns).toEqual(['src/**'])
    expect(runner.authority.limits.maxIterations).toBe(3)
    expect(baseCalls).toBe(0)
  })

  it('accepts one exact restart seal and rejects changed, duplicate, or missing seals before provider construction', () => {
    const firstAuthority = boundAuthority()
    const journal = authorityJournal()
    let factories = 0
    const deps = (authority = firstAuthority) => ({
      authority,
      authorityJournal: journal,
      permitsTool: () => true,
      providerFactory: () => {
        factories++
        return { async complete() { return { reply: 'done' } } }
      },
      baseExecuteTool: async () => ({ ok: true as const, output: '' }),
      approve: async () => ({ decision: 'rejected' as const }),
      memory: memFake,
      sessionLog: logFake,
      parentNarrowed: false,
      budgetCheck: () => false,
    })
    makeBoundSubAgentRunner(deps())
    makeBoundSubAgentRunner(deps())
    expect(journal.appends).toBe(1)
    expect(factories).toBe(0)

    const changed = resolveDelegationExecutionAuthority({
      handle: boundHandle(), task: boundTask(),
      matrix: firstAuthority.capabilities as typeof firstAuthority.capabilities,
      maxConcurrency: 3,
    })
    expect(() => makeBoundSubAgentRunner(deps(changed))).toThrow(
      expect.objectContaining({ code: 'AUTHORITY_CHECKPOINT_MISMATCH' }),
    )
    expect(factories).toBe(0)

    const duplicate = authorityJournal([...journal.entries, structuredClone(journal.entries[0]!)])
    expect(() => makeBoundSubAgentRunner({ ...deps(), authorityJournal: duplicate })).toThrow(
      expect.objectContaining({ code: 'AUTHORITY_CHECKPOINT_MISMATCH' }),
    )
    const missing = authorityJournal([{
      ...journal.entries[0]!, kind: 'reasoning', payload: { safe: true },
    }])
    expect(() => makeBoundSubAgentRunner({ ...deps(), authorityJournal: missing })).toThrow(
      expect.objectContaining({ code: 'AUTHORITY_CHECKPOINT_MISMATCH' }),
    )
  })

  it('rejects misplaced, foreign, and chain-invalid authority seals', () => {
    const authority = boundAuthority()
    const sealed = authorityJournal()
    makeBoundSubAgentRunner({
      authority,
      authorityJournal: sealed,
      permitsTool: () => true,
      providerFactory: () => ({ async complete() { return { reply: 'done' } } }),
      baseExecuteTool: async () => ({ ok: true, output: '' }),
      approve: async () => ({ decision: 'rejected' }),
      memory: memFake,
      sessionLog: logFake,
      parentNarrowed: false,
      budgetCheck: () => false,
    })
    const seal = sealed.entries[0]!
    const reasoning: ShardEntry = {
      ...structuredClone(seal), kind: 'reasoning', payload: { safe: true },
    }
    const misplacedSeal: ShardEntry = {
      ...structuredClone(seal), seq: 2, prevHash: reasoning.hash,
    }
    const foreignSeal: ShardEntry = {
      ...structuredClone(seal), delegationId: 'd-foreign',
    }
    const invalidChainSeal: ShardEntry = {
      ...structuredClone(seal), prevHash: 'f'.repeat(64),
    }
    const makeDeps = (journal: ReturnType<typeof authorityJournal>) => ({
      authority,
      authorityJournal: journal,
      permitsTool: () => true,
      providerFactory: () => ({ async complete() { return { reply: 'done' } } }),
      baseExecuteTool: async () => ({ ok: true as const, output: '' }),
      approve: async () => ({ decision: 'rejected' as const }),
      memory: memFake,
      sessionLog: logFake,
      parentNarrowed: false,
      budgetCheck: () => false,
    })

    expect(() => makeBoundSubAgentRunner(makeDeps(
      authorityJournal([reasoning, misplacedSeal], true),
    ))).toThrow(expect.objectContaining({ code: 'AUTHORITY_CHECKPOINT_MISMATCH' }))
    expect(() => makeBoundSubAgentRunner(makeDeps(
      authorityJournal([foreignSeal], true),
    ))).toThrow(expect.objectContaining({ code: 'AUTHORITY_CHECKPOINT_MISMATCH' }))
    expect(() => makeBoundSubAgentRunner(makeDeps(
      authorityJournal([invalidChainSeal]),
    ))).toThrow(expect.objectContaining({ code: 'AUTHORITY_CHECKPOINT_MISMATCH' }))
  })

  it('rejects session routing drift before memory/provider/tool I/O', async () => {
    let memoryCalls = 0
    let providerCalls = 0
    let toolCalls = 0
    const runner = makeBoundSubAgentRunner({
      authority: boundAuthority(),
      authorityJournal: authorityJournal(),
      permitsTool: () => true,
      providerFactory: () => ({
        async complete() { providerCalls++; return { reply: 'done' } },
      }),
      baseExecuteTool: async () => { toolCalls++; return { ok: true, output: '' } },
      approve: async () => ({ decision: 'rejected' }),
      memory: {
        async snapshot() {
          memoryCalls++
          return { prefixBytes: new Uint8Array(), prefixHash: 'h', breakpoints: [], takenAt: 't' }
        },
        async forget() {},
      },
      sessionLog: logFake,
      parentNarrowed: false,
      budgetCheck: () => false,
    })

    await expect(runner.handle({
      sessionId: 'wrong', spans: [{ role: 'user', provenance: 'operator', text: 'go' }],
    })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
    expect({ memoryCalls, providerCalls, toolCalls }).toEqual({ memoryCalls: 0, providerCalls: 0, toolCalls: 0 })
  })

  it('uses snapshot DNA first, inherits narrowing, and denies an off-card tool before the base executor', async () => {
    const handle = boundHandle({ card: fakeCard({ provenance: 'community', instructions: 'Frozen child DNA' }) })
    const authority = boundAuthority(handle)
    let firstSpan = ''
    let baseCalls = 0
    let round = 0
    const runner = makeBoundSubAgentRunner({
      authority,
      authorityJournal: authorityJournal(),
      permitsTool: name => name === 'read_file',
      providerFactory: () => ({
        async complete(request) {
          firstSpan = request.spans[0]?.text ?? ''
          return round++ === 0
            ? { reply: '', toolCalls: [{ name: 'write_file', args: { path: 'src/a.ts' } }] }
            : { reply: 'done' }
        },
      }),
      baseExecuteTool: async () => { baseCalls++; return { ok: true, output: '' } },
      approve: async () => ({ decision: 'rejected' }),
      memory: memFake,
      sessionLog: logFake,
      parentNarrowed: true,
      budgetCheck: () => false,
    })

    const result = await runner.handle({
      sessionId: 'd-t1', spans: [{ role: 'user', provenance: 'operator', text: 'go' }],
    })
    expect(firstSpan).toBe('Frozen child DNA')
    expect(result.narrowed).toBe(true)
    expect(baseCalls).toBe(0)
  })

  it('enforces doNotTouch before the base executor', async () => {
    const writeCard = fakeCard({ toolTiers: { write_file: 2 } })
    const handle = boundHandle({ card: writeCard, permitsTool: name => name === 'write_file' })
    const task = boundTask()
    const matrix = resolveAgentCapabilityMatrix({
      card: writeCard,
      toolCatalog: [runtimeTool('write_file')],
      activeSkills: new Set(), activeMcpServers: new Set(),
    })
    const authority = resolveDelegationExecutionAuthority({ handle, task, matrix, maxConcurrency: 1 })
    let baseCalls = 0
    let round = 0
    const runner = makeBoundSubAgentRunner({
      authority, authorityJournal: authorityJournal(), permitsTool: handle.permitsTool,
      providerFactory: () => ({
        async complete() {
          return round++ === 0
            ? { reply: '', toolCalls: [{ name: 'write_file', args: { path: 'src/private/a.ts' } }] }
            : { reply: 'done' }
        },
      }),
      baseExecuteTool: async () => { baseCalls++; return { ok: true, output: '' } },
      approve: async () => ({ decision: 'confirmed' }),
      memory: memFake, sessionLog: logFake, parentNarrowed: false,
      budgetCheck: () => false,
    })
    await runner.handle({
      sessionId: 'd-t1', spans: [{ role: 'user', provenance: 'operator', text: 'go' }],
    })
    expect(baseCalls).toBe(0)
  })

  it('enforces the sealed spend ceiling independently of the injected budget probe', async () => {
    const runner = makeBoundSubAgentRunner({
      authority: boundAuthority(), authorityJournal: authorityJournal(), permitsTool: () => true,
      providerFactory: () => ({
        async complete() {
          return { reply: 'expensive', usage: { inputTokens: 1, outputTokens: 1, dollars: 0.21 } }
        },
      }),
      baseExecuteTool: async () => ({ ok: true, output: '' }),
      approve: async () => ({ decision: 'rejected' }),
      memory: memFake, sessionLog: logFake, parentNarrowed: false,
      budgetCheck: () => false,
    })
    await expect(runner.handle({
      sessionId: 'd-t1', spans: [{ role: 'user', provenance: 'operator', text: 'go' }],
    })).resolves.toMatchObject({ state: 'halted', haltReason: 'budget-capped' })
  })
})
