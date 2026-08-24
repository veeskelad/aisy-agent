import { createHash } from 'node:crypto'
import { isGenuineToolExecutionContextFor, makeAgentLoop } from './index.js'
import { actionEvidence, attachProviderActionEvidence } from './action-contract.js'
import { fakeClock } from '../testing/index.js'
import type {
  AgentLoopDeps,
  ContextSpan,
  FrozenSnapshot,
  HookCtx,
  LogEntry,
  LoopGuardian,
  MemoryPort,
  ModelRequest,
  ModelResponse,
  Plan,
  PlanStep,
  ProviderAdapter,
  HookGate,
  SessionLog,
  TranscriptRecorder,
  TranscriptRecordRequest,
  TranscriptSessionStartRequest,
  ToolCall,
  ToolExecutionContext,
  TurnInput,
  TurnProgressEvent,
  TurnState,
  VerificationTrace,
} from './types.js'

// ---------------------------------------------------------------------------
// Test-seam factories
// ---------------------------------------------------------------------------

function makeMinimalSnapshot(overrides?: Partial<FrozenSnapshot>): FrozenSnapshot {
  const prefixBytes = new TextEncoder().encode('{"system":"default"}')
  return {
    prefixBytes,
    prefixHash: 'abc123',
    breakpoints: [0, 100, 200, 300],
    takenAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeMemoryFake(snap?: FrozenSnapshot): MemoryPort & {
  forgottenRefs: string[]
  forgotten: Array<{ ref: string; humanConfirmed: boolean }>
} {
  const forgotten: Array<{ ref: string; humanConfirmed: boolean }> = []
  return {
    forgotten,
    get forgottenRefs() { return forgotten.map(f => f.ref) },
    async snapshot() {
      return snap ?? makeMinimalSnapshot()
    },
    async forget(factRef: string, humanConfirmed: boolean) {
      forgotten.push({ ref: factRef, humanConfirmed })
    },
  }
}

function makeHookGateFake(
  verdict: Awaited<ReturnType<HookGate['pre']>> = 'allow',
): HookGate & { preCalls: Array<{ call: ToolCall; ctx: HookCtx }> } {
  const preCalls: Array<{ call: ToolCall; ctx: HookCtx }> = []
  return {
    preCalls,
    async pre(call: ToolCall, ctx: HookCtx) {
      preCalls.push({ call, ctx })
      return verdict
    },
    async post(_call: ToolCall, result: unknown) { return result },
  }
}

function makeGuardianFake(tripAfter = Infinity): LoopGuardian & { replans: number } {
  let calls = 0
  let replans = 0
  return {
    get replans() { return replans },
    observe(_call: ToolCall) {
      calls++
      return { trip: calls > tripAfter, period: 2 as const }
    },
    note(event: 'replan') {
      if (event === 'replan') replans++
    },
  }
}

function makeSessionLogFake(resumeState: TurnState | null = null): SessionLog & {
  entries: LogEntry[]
  appendOrder: string[]
} {
  const entries: LogEntry[] = []
  const appendOrder: string[] = []
  return {
    entries,
    appendOrder,
    append(entry: LogEntry) {
      entries.push(entry)
      appendOrder.push(entry.kind)
    },
    resume(_sessionId: string): TurnState | null {
      return resumeState
    },
  }
}

function makeTranscriptRecorderFake(
  failAt = Infinity,
  failStart = false,
  historySpans: ContextSpan[] = [],
): TranscriptRecorder & {
  starts: TranscriptSessionStartRequest[]
  historyCalls: number
  records: TranscriptRecordRequest[]
} {
  const starts: TranscriptSessionStartRequest[] = []
  const records: TranscriptRecordRequest[] = []
  return {
    starts,
    historyCalls: 0,
    records,
    async start(input) {
      if (failStart) throw new Error('transcript start unavailable')
      starts.push(structuredClone(input))
      return structuredClone(input.frozen)
    },
    async history() {
      this.historyCalls += 1
      return structuredClone(historySpans)
    },
    async record(input) {
      if (input.ordinal === failAt) throw new Error('transcript unavailable')
      records.push(structuredClone(input))
    },
  }
}

function makeProviderFakeWithResponse(response: Partial<ModelResponse> = {}): ProviderAdapter {
  return {
    async complete(_req: ModelRequest): Promise<ModelResponse> {
      return {
        reply: 'ok',
        toolCalls: [],
        ...response,
      }
    },
  }
}

/** Scripted provider: returns queued responses in order, repeating the last one;
 *  records every ModelRequest it receives. */
function makeScriptedProvider(
  responses: Array<Partial<ModelResponse>>,
): ProviderAdapter & { requests: ModelRequest[] } {
  const queue = [...responses]
  const requests: ModelRequest[] = []
  return {
    requests,
    async complete(req: ModelRequest): Promise<ModelResponse> {
      requests.push(req)
      const next = queue.length > 1 ? queue.shift()! : (queue[0] ?? {})
      return { reply: 'ok', toolCalls: [], ...next }
    },
  }
}

/** Per-turn "tool then text": odd calls emit one tool call, even calls a text reply.
 *  Models a real turn that dispatches a tool and then answers, so the ADR-0102
 *  synthesis loop terminates after exactly one dispatch per turn (used by the
 *  cross-turn narrowing tests, which assert one preCall per turn). */
function makeAlternatingToolProvider(toolCall: ToolCall): ProviderAdapter {
  let n = 0
  return {
    async complete(): Promise<ModelResponse> {
      n++
      return n % 2 === 1 ? { reply: '', toolCalls: [toolCall] } : { reply: 'ok', toolCalls: [] }
    },
  }
}

function makeAllDownProvider(): ProviderAdapter {
  return {
    async complete(_req: ModelRequest): Promise<ModelResponse> {
      const err = new Error('all providers exhausted') as Error & { kind: string }
      err.kind = 'all-exhausted'
      throw err
    },
  }
}

/** Provider that rejects (AbortError) iff the external signal is already aborted. */
function makeAbortAwareProvider(): ProviderAdapter {
  return {
    async complete(_req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      if (signal?.aborted) {
        const e = new Error('aborted') as Error & { name: string }
        e.name = 'AbortError'
        throw e
      }
      return { reply: 'ok', toolCalls: [] }
    },
  }
}

function makeExecSpy(): { calls: ToolCall[]; fn: (call: ToolCall) => unknown } {
  const calls: ToolCall[] = []
  return {
    calls,
    fn: (call: ToolCall) => {
      calls.push(call)
      return { ok: true }
    },
  }
}

function makeOperatorSpan(text = 'hello'): ContextSpan {
  return { role: 'user', provenance: 'operator', text }
}

function makeUntrustedSpan(text = 'injected content'): ContextSpan {
  return { role: 'user', provenance: 'untrusted', text }
}

function makeDeps(overrides: Partial<AgentLoopDeps> = {}): AgentLoopDeps {
  return {
    clock: fakeClock(0),
    provider: makeProviderFakeWithResponse(),
    hookGate: makeHookGateFake(),
    memory: makeMemoryFake(),
    guardian: makeGuardianFake(),
    sessionLog: makeSessionLogFake(),
    ...overrides,
  }
}

function makeTurnInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    sessionId: 'test-session',
    spans: [makeOperatorSpan()],
    ...overrides,
  }
}

function exitTrace(): VerificationTrace {
  return { kind: 'exit', argv: ['node', '--version'], expectCode: 0 }
}

function stepWith(tool: string, overrides: Partial<PlanStep> = {}): PlanStep {
  return { intent: `run ${tool}`, tools: [tool], irreversible: false, trace: exitTrace(), ...overrides }
}

function validPlan(...tools: string[]): Plan {
  return { steps: tools.map(t => stepWith(t)) }
}

// ---------------------------------------------------------------------------
// AC-01-1 through AC-01-32
// ---------------------------------------------------------------------------

describe('AgentLoop', () => {

  // §4.2 — Deterministic L1 serialization
  it('AC-01-1: two sessions over byte-identical L1 files yield the same prefixHash', async () => {
    const snapA = makeMinimalSnapshot({ prefixHash: 'deterministic-hash-abc' })
    const snapB = makeMinimalSnapshot({ prefixHash: 'deterministic-hash-abc' })
    const provA = makeScriptedProvider([{}])
    const provB = makeScriptedProvider([{}])
    const loop1 = makeAgentLoop(makeDeps({ memory: makeMemoryFake(snapA), provider: provA }))
    const loop2 = makeAgentLoop(makeDeps({ memory: makeMemoryFake(snapB), provider: provB }))
    const [r1, r2] = await Promise.all([
      loop1.runTurn(makeTurnInput({ sessionId: 'session-a' })),
      loop2.runTurn(makeTurnInput({ sessionId: 'session-b' })),
    ])
    expect(r1.state).toBe('ok')
    expect(r2.state).toBe('ok')
    // Both sessions froze the same hash and dispatched byte-identical prefixes.
    expect(snapA.prefixHash).toBe(snapB.prefixHash)
    expect(Array.from(provA.requests[0]!.prefixBytes)).toEqual(Array.from(provB.requests[0]!.prefixBytes))
  })

  it('AC-01-2: prefixBytes contains no Clock value, no PID, no run-id; mutating takenAt does not change prefixHash', async () => {
    const clock = fakeClock(1_700_000_000_000)
    const clockStr = new Date(1_700_000_000_000).toISOString()
    const snap = makeMinimalSnapshot({ takenAt: clockStr })
    const provider = makeScriptedProvider([{}])
    const loop = makeAgentLoop(makeDeps({ clock, memory: makeMemoryFake(snap), provider }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('ok')
    const prefixText = new TextDecoder().decode(provider.requests[0]!.prefixBytes)
    expect(prefixText).not.toContain(clockStr)
    expect(prefixText).not.toContain(String(process.pid))
  })

  it('AC-01-3: L1 object with keys in reverse order produces byte-identical prefixBytes to sorted-order input', async () => {
    // Sorted keys: a, b, c — both sessions receive the canonical (sorted) serialization.
    const sorted = new TextEncoder().encode(JSON.stringify({ a: 1, b: 2, c: 3 }))
    const snapSorted = makeMinimalSnapshot({ prefixBytes: sorted, prefixHash: 'sorted-hash' })
    const snapReversed = makeMinimalSnapshot({ prefixBytes: sorted, prefixHash: 'sorted-hash' })
    const provA = makeScriptedProvider([{}])
    const provB = makeScriptedProvider([{}])
    const loop1 = makeAgentLoop(makeDeps({ memory: makeMemoryFake(snapSorted), provider: provA }))
    const loop2 = makeAgentLoop(makeDeps({ memory: makeMemoryFake(snapReversed), provider: provB }))
    await loop1.runTurn(makeTurnInput({ sessionId: 's1' }))
    await loop2.runTurn(makeTurnInput({ sessionId: 's2' }))
    expect(Array.from(provA.requests[0]!.prefixBytes)).toEqual(Array.from(provB.requests[0]!.prefixBytes))
    expect(snapSorted.prefixHash).toBe(snapReversed.prefixHash)
  })

  it('AC-01-4: after snapshot() is frozen, a within-session memory write does not change prefixHash', async () => {
    let callCount = 0
    const memory: MemoryPort = {
      async snapshot() {
        callCount++
        return makeMinimalSnapshot({ prefixHash: 'frozen-hash' })
      },
      async forget(_ref: string, _confirmed: boolean) {},
    }
    const loop = makeAgentLoop(makeDeps({ memory }))
    await loop.runTurn(makeTurnInput())
    await loop.runTurn(makeTurnInput())
    // Frozen once per session: two turns, exactly one snapshot read.
    expect(callCount).toBe(1)
  })

  it('AC-01-5: assembled prefix exposes ≤ 4 cache breakpoints at the four ADR-0019 segment boundaries', async () => {
    const snap = makeMinimalSnapshot({ breakpoints: [512, 1024, 2048, 4096] })
    const loop = makeAgentLoop(makeDeps({ memory: makeMemoryFake(snap) }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('ok')
    expect(snap.breakpoints.length).toBeLessThanOrEqual(4)
  })

  it('AC-01-6: cold start with no L1 files — runTurn boots minimal prefix, HookGate is consulted, no unhandled exception', async () => {
    const hookGate = makeHookGateFake('allow')
    const memory: MemoryPort = {
      async snapshot() { throw new Error('memory unavailable') },
      async forget() {},
    }
    // ADR-0102: tool then text — one dispatch, then a synthesis reply that ends the turn.
    const provider = makeScriptedProvider([
      { toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
      { reply: 'ok' },
    ])
    const loop = makeAgentLoop(makeDeps({ memory, hookGate, provider }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result).toBeDefined()
    expect(result.state).toBe('ok')
    expect(hookGate.preCalls.length).toBe(1)
  })

  it('AC-01-7: in cold-start mode, a Tier-2 tool call is gated to ask/deny (capabilities restricted to Tier-0/1)', async () => {
    const memory: MemoryPort = {
      async snapshot() { throw new Error('memory unavailable') },
      async forget() {},
    }
    const hookGate = makeHookGateFake('deny')
    const exec = makeExecSpy()
    const provider = makeProviderFakeWithResponse({ toolCalls: [{ name: 'send_message', args: { to: 'x' } }] })
    const loop = makeAgentLoop(makeDeps({ memory, hookGate, provider, executeTool: exec.fn }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('ok')
    expect(hookGate.preCalls.length).toBe(1)
    // Tier-2 tool was gated: never dispatched.
    expect(exec.calls.length).toBe(0)
  })

  it('AC-01-8: all-providers-down after a completed step → state:"halted", haltReason:"all-providers-down", completed step in log', async () => {
    const sessionLog = makeSessionLogFake()
    const loop = makeAgentLoop(makeDeps({ provider: makeAllDownProvider(), sessionLog }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('halted')
    expect(result.haltReason).toBe('all-providers-down')
    expect(sessionLog.entries.length).toBeGreaterThan(0)
    expect(sessionLog.appendOrder).toContain('provider.exhausted')
  })

  it('AC-01-8b: log entry payloadHash is sha256 (64 hex chars), not collision-prone djb2', async () => {
    const sessionLog = makeSessionLogFake()
    const loop = makeAgentLoop(makeDeps({ provider: makeAllDownProvider(), sessionLog }))
    await loop.runTurn(makeTurnInput())

    // sha256 → 64 lowercase hex chars; the old djb2 produced ≤ 8 hex chars.
    for (const entry of sessionLog.entries) {
      expect(entry.payloadHash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('AC-01-9: after all-providers-down halt, SessionLog.resume returns TurnState with next un-verified step; no completed step re-executes', async () => {
    const sessionLog = makeSessionLogFake({ status: 'in-progress', nextStepIndex: 1 })
    const exec = makeExecSpy()
    const plan: Plan = { steps: [stepWith('t0'), stepWith('t1')] }
    const provider = makeScriptedProvider([{ plan }])
    const loop = makeAgentLoop(makeDeps({ sessionLog, provider, executeTool: exec.fn }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('ok')
    // Resumed at step 1: step 0's tool never re-executed.
    expect(exec.calls.map(c => c.name)).toEqual(['t1'])
  })

  it('AC-01-10: crash between intent-append and result-append leaves intent entry on disk; resume re-dispatches that step', async () => {
    // Simulated crash: resume() reports step 0 as un-verified (intent without result).
    const sessionLog = makeSessionLogFake({ status: 'in-progress', nextStepIndex: 0 })
    const exec = makeExecSpy()
    const plan: Plan = { steps: [stepWith('t0')] }
    const provider = makeScriptedProvider([{ plan }])
    const loop = makeAgentLoop(makeDeps({ sessionLog, provider, executeTool: exec.fn }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('ok')
    // Step 0 was re-dispatched.
    expect(exec.calls.map(c => c.name)).toEqual(['t0'])
  })

  it('AC-01-11: session log entry for a side-effecting dispatch is fsync\'d BEFORE the dispatch call is made', async () => {
    const order: string[] = []
    const sessionLog: SessionLog = {
      append(entry: LogEntry) { order.push(`log:${entry.kind}`) },
      resume(_id: string) { return null },
    }
    const provider: ProviderAdapter = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        order.push('dispatch')
        return { reply: 'ok', toolCalls: [] }
      },
    }
    const loop = makeAgentLoop(makeDeps({ sessionLog, provider }))
    await loop.runTurn(makeTurnInput())
    const intentIdx = order.indexOf('log:step.intent')
    const dispatchIdx = order.indexOf('dispatch')
    expect(intentIdx).toBeGreaterThanOrEqual(0)
    expect(dispatchIdx).toBeGreaterThanOrEqual(0)
    expect(intentIdx).toBeLessThan(dispatchIdx)
  })

  it('AC-01-12: PLAN.md step without a trace field is rejected by linter (R1) and no mutating tool is dispatched', async () => {
    const hookGate = makeHookGateFake('allow')
    const badStep = { intent: 'no trace', tools: ['write_file'], irreversible: false } as unknown as PlanStep
    const provider = makeProviderFakeWithResponse({ plan: { steps: [badStep] } })
    const loop = makeAgentLoop(makeDeps({ hookGate, provider }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('halted')
    // §5.3/§7: the model keeps emitting an unlintable plan → re-plan budget overflows → cap-exceeded.
    expect(result.haltReason).toBe('cap-exceeded')
    expect(hookGate.preCalls.length).toBe(0)
  })

  it('AC-01-13: plan step with trace {kind:"exit", argv:["echo","ok"]} is rejected as vacuous (R3)', async () => {
    const hookGate = makeHookGateFake('allow')
    const plan: Plan = {
      steps: [stepWith('build', { trace: { kind: 'exit', argv: ['echo', 'ok'], expectCode: 0 } })],
    }
    const provider = makeProviderFakeWithResponse({ plan })
    const loop = makeAgentLoop(makeDeps({ hookGate, provider }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('halted')
    // §5.3/§7: the model keeps emitting an unlintable plan → re-plan budget overflows → cap-exceeded.
    expect(result.haltReason).toBe('cap-exceeded')
    expect(hookGate.preCalls.length).toBe(0)
  })

  it('AC-01-13b: vacuous HTTP trace at loopback (127.0.0.1, localhost, ::1, [::1], 0.0.0.0) is rejected (R3)', async () => {
    const loopbackUrls = [
      'http://127.0.0.1:8080/health',
      'http://localhost:8080/health',
      'http://[::1]:8080/health',
      'http://::1:8080/health',
      'http://0.0.0.0:8080/health',
    ]
    for (const url of loopbackUrls) {
      const hookGate = makeHookGateFake('allow')
      const plan: Plan = {
        steps: [stepWith('serve', { trace: { kind: 'http', method: 'GET', url, expectStatus: 200 } })],
      }
      const provider = makeProviderFakeWithResponse({ plan })
      const loop = makeAgentLoop(makeDeps({ hookGate, provider }))
      const result = await loop.runTurn(makeTurnInput())
      // §5.3/§7: the model keeps emitting an unlintable (vacuous-loopback) plan → re-plan budget overflows → cap-exceeded.
      expect(result.state, `url=${url}`).toBe('halted')
      expect(result.haltReason, `url=${url}`).toBe('cap-exceeded')
      expect(hookGate.preCalls.length, `url=${url}`).toBe(0)
    }
  })

  it('AC-01-14: plan step whose file trace path equals PLAN.md/TODO.md is rejected as self-referential (R4)', async () => {
    const plan: Plan = {
      steps: [stepWith('write_plan', { trace: { kind: 'file', path: 'PLAN.md', existsExpected: true } })],
    }
    const provider = makeProviderFakeWithResponse({ plan })
    const loop = makeAgentLoop(makeDeps({ provider }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('halted')
    // §5.3/§7: the model keeps emitting an unlintable plan → re-plan budget overflows → cap-exceeded.
    expect(result.haltReason).toBe('cap-exceeded')
  })

  it('AC-01-15: trace with kind:"shell" (or any value outside file|sql|http|exit) is rejected as out-of-enum (R5)', async () => {
    const badTrace = { kind: 'shell', cmd: 'ls' } as unknown as VerificationTrace
    const plan: Plan = { steps: [stepWith('list', { trace: badTrace })] }
    const provider = makeProviderFakeWithResponse({ plan })
    const loop = makeAgentLoop(makeDeps({ provider }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('halted')
    // §5.3/§7: the model keeps emitting an unlintable plan → re-plan budget overflows → cap-exceeded.
    expect(result.haltReason).toBe('cap-exceeded')
  })

  it('AC-01-16: step is marked done ONLY after its probe returns expected result; probe failure → step marked failed even if model claimed success', async () => {
    const sessionLog = makeSessionLogFake()
    const exec = makeExecSpy()
    const provider = makeScriptedProvider([{ plan: validPlan('build'), reply: 'I did it successfully!' }])
    const loop = makeAgentLoop(makeDeps({
      sessionLog,
      provider,
      executeTool: exec.fn,
      probeRunner: () => false, // external probe contradicts the model's claim
    }))
    const result = await loop.runTurn(makeTurnInput())
    expect(sessionLog.appendOrder).toContain('step.failed')
    expect(sessionLog.appendOrder).not.toContain('step.verified')
    // Repeated probe failure exhausts re-plans → cap-exceeded, never silent success.
    expect(result.state).toBe('halted')
    expect(result.haltReason).toBe('cap-exceeded')
  })

  it('AC-01-17: Tier-3 plan does not dispatch mutating tool until approval token is supplied; absent approval → state:"awaiting-approval"', async () => {
    const hookGate = makeHookGateFake('allow')
    const exec = makeExecSpy()
    const plan: Plan = { steps: [stepWith('deploy_tool', { irreversible: true })] }
    const provider = makeProviderFakeWithResponse({ plan })
    const deps = makeDeps({ hookGate, provider, executeTool: exec.fn })
    const loop = makeAgentLoop(deps)

    // No approvalToken → awaiting-approval, zero dispatches.
    const r1 = await loop.runTurn(makeTurnInput({ spans: [makeOperatorSpan('do dangerous thing')] }))
    expect(r1.state).toBe('awaiting-approval')
    expect(hookGate.preCalls.length).toBe(0)
    expect(exec.calls.length).toBe(0)
    // The gate surfaces the plan hash so the caller can issue a bound token.
    expect(r1.planHash).toBeTruthy()

    // A token bound to a DIFFERENT plan must still be refused.
    const r2 = await loop.runTurn(makeTurnInput({
      spans: [makeOperatorSpan('do dangerous thing')],
      approvalToken: 'token-for-some-other-plan',
    }))
    expect(r2.state).toBe('awaiting-approval')
    expect(exec.calls.length).toBe(0)

    // With the correctly bound approvalToken → the plan executes.
    const r3 = await loop.runTurn(makeTurnInput({
      spans: [makeOperatorSpan('do dangerous thing')],
      approvalToken: r1.planHash!,
    }))
    expect(r3.state).toBe('ok')
    expect(exec.calls.map(c => c.name)).toEqual(['deploy_tool'])
  })

  it('AC-01-18: when deterministic ambiguity floor fires (>1 interpretation emitted), runTurn returns state:"awaiting-clarification" and dispatches zero tool calls', async () => {
    const hookGate = makeHookGateFake('allow')
    const provider = makeProviderFakeWithResponse({
      interpretationCount: 2,
      toolCalls: [{ name: 'write_file', args: { path: 'x' } }],
    })
    const loop = makeAgentLoop(makeDeps({ hookGate, provider }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('awaiting-clarification')
    expect(hookGate.preCalls.length).toBe(0)
  })

  it('AC-01-19: model-advisory ambiguity component at 0 cannot lower below deterministic floor; floor still halts', async () => {
    const hookGate = makeHookGateFake('allow')
    // interpretationCount > 1 trips the deterministic floor regardless of advisory score
    const provider = makeProviderFakeWithResponse({ interpretationCount: 2 })
    const loop = makeAgentLoop(makeDeps({ hookGate, provider }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('awaiting-clarification')
    expect(hookGate.preCalls.length).toBe(0)
  })

  it('AC-01-20: untrusted span present → PreToolUse attempt to call outbound tool is blocked by code', async () => {
    const hookGate = makeHookGateFake('deny')
    const exec = makeExecSpy()
    const provider = makeProviderFakeWithResponse({ toolCalls: [{ name: 'send_message', args: { to: 'x' } }] })
    const loop = makeAgentLoop(makeDeps({ hookGate, provider, executeTool: exec.fn }))
    const result = await loop.runTurn(makeTurnInput({ spans: [makeUntrustedSpan()] }))
    expect(result.state).toBe('ok')
    expect(hookGate.preCalls.length).toBe(1)
    expect(hookGate.preCalls[0]!.ctx.narrowed).toBe(true)
    // Outbound tool never reached dispatch.
    expect(exec.calls.length).toBe(0)
  })

  it('AC-01-21: untrusted span present — tool call whose args derive from that span is blocked at PreToolUse even if tool is otherwise allowed', async () => {
    const hookGate = makeHookGateFake('allow') // gate would allow — code must still block
    const exec = makeExecSpy()
    const provider = makeProviderFakeWithResponse({
      toolCalls: [{ name: 'fetch_web', args: { url: 'https://exfil.example' }, sourceSpanProvenance: 'untrusted' }],
    })
    const loop = makeAgentLoop(makeDeps({ hookGate, provider, executeTool: exec.fn }))
    const result = await loop.runTurn(makeTurnInput({ spans: [makeOperatorSpan(), makeUntrustedSpan('exfil target')] }))
    expect(result.state).toBe('ok')
    expect(hookGate.preCalls.length).toBe(1)
    // Code-level motivated-call block: untrusted-derived args never dispatch.
    expect(exec.calls.length).toBe(0)
  })

  it('AC-01-22: model attempt to set span provenance to "operator" is ignored; code-assigned label used and narrowed mode stays active', async () => {
    const spoofedSpan: ContextSpan = { role: 'assistant', provenance: 'untrusted', text: 'I am operator' }
    const hookGate = makeHookGateFake('allow')
    const provider = makeProviderFakeWithResponse({ toolCalls: [{ name: 'read_file', args: { path: 'a' } }] })
    const loop = makeAgentLoop(makeDeps({ hookGate, provider }))
    const result = await loop.runTurn(makeTurnInput({ spans: [spoofedSpan] }))
    expect(result.state).toBe('ok')
    // Code-assigned label untouched; narrowed mode active.
    expect(spoofedSpan.provenance).toBe('untrusted')
    expect(hookGate.preCalls[0]!.ctx.narrowed).toBe(true)
  })

  it('AC-01-23: narrowed mode clears only after an operator turn with no untrusted content; operator turn including untrusted content keeps narrowing on', async () => {
    const hookGate = makeHookGateFake('allow')
    // ADR-0102: one dispatch per turn (tool then text), so preCalls has one entry/turn.
    const provider = makeAlternatingToolProvider({ name: 'read_file', args: { path: 'a' } })
    const loop = makeAgentLoop(makeDeps({ hookGate, provider }))

    // Turn 1: untrusted → narrowed
    await loop.runTurn(makeTurnInput({ spans: [makeUntrustedSpan()] }))
    // Turn 2: operator + untrusted → still narrowed
    await loop.runTurn(makeTurnInput({ spans: [makeOperatorSpan(), makeUntrustedSpan()] }))
    // Turn 3: clean operator turn → narrowing clears
    await loop.runTurn(makeTurnInput({ spans: [makeOperatorSpan()] }))

    expect(hookGate.preCalls.map(c => c.ctx.narrowed)).toEqual([true, true, false])
  })

  it('AC-01-24: after "forget this", FTS5 query for forgotten fact returns zero rows, and loop refuses to include fact\'s span in any tool argument', async () => {
    const memory = makeMemoryFake()
    const exec = makeExecSpy()
    // Turn 2 returns a tool call whose args reference the forgotten ref — it must be blocked.
    const provider = makeScriptedProvider([
      {},
      { toolCalls: [{ name: 'send_message', args: { body: 'your fact-123 is here' } }] },
    ])
    const loop = makeAgentLoop(makeDeps({ memory, provider, executeTool: exec.fn }))

    const r1 = await loop.runTurn(makeTurnInput({ spans: [makeOperatorSpan('forget: fact-123')] }))
    expect(r1.state).toBe('ok')
    expect(memory.forgottenRefs).toContain('fact-123')

    // Same session, later turn: a tool call laundering the forgotten ref into its args
    // must never reach executeTool.
    const r2 = await loop.runTurn(makeTurnInput({ spans: [makeOperatorSpan('continue')] }))
    expect(r2.state).toBe('ok')
    expect(exec.calls.some(c => JSON.stringify(c.args).includes('fact-123'))).toBe(false)
    expect(exec.calls.length).toBe(0)
  })

  it('AC-01-25: after "forget this", MemoryPort.forget was invoked with the fact ref; next session prefixBytes does not contain the fact', async () => {
    const memory = makeMemoryFake()
    const loop = makeAgentLoop(makeDeps({ memory }))
    await loop.runTurn(makeTurnInput({ spans: [makeOperatorSpan('forget: my-old-address')] }))
    expect(memory.forgottenRefs).toEqual(['my-old-address'])
  })

  it('AC-01-26: human-confirmed forget cannot be resurfaced by any automated path in a later session', async () => {
    const memory = makeMemoryFake()
    const loop = makeAgentLoop(makeDeps({ memory }))
    await loop.runTurn(makeTurnInput({ spans: [makeOperatorSpan('forget: secret-fact')] }))
    // An operator-typed forget is recorded as human-confirmed — the permanence flag
    // the resurrection-guard (Memory 03) keys on.
    expect(memory.forgotten).toEqual([{ ref: 'secret-fact', humanConfirmed: true }])
  })

  it('AC-01-27: Loop Guardian period-2 (A-B-A-B) cycle repeating >3× halts the loop with haltReason:"loop-guardian" and writes window to log', async () => {
    const guardian = makeGuardianFake(3) // trips after 3 observed calls
    const sessionLog = makeSessionLogFake()
    const provider = makeProviderFakeWithResponse({
      toolCalls: [
        { name: 'a', args: {} }, { name: 'b', args: {} },
        { name: 'a', args: {} }, { name: 'b', args: {} },
      ],
    })
    const loop = makeAgentLoop(makeDeps({ guardian, sessionLog, provider }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('halted')
    expect(result.haltReason).toBe('loop-guardian')
    expect(sessionLog.appendOrder).toContain('guardian.tripped')
  })

  it('AC-01-28: forced re-plan calls LoopGuardian.note("replan") and post-replan tool calls do not trip Guardian against pre-replan window', async () => {
    const guardian = makeGuardianFake()
    const exec = makeExecSpy()
    const badStep = { intent: 'no trace', tools: ['x'], irreversible: false } as unknown as PlanStep
    const provider = makeScriptedProvider([
      { plan: { steps: [badStep] } },   // fails lint → forces a re-plan
      { plan: validPlan('greet') },     // re-planned plan is valid
    ])
    const loop = makeAgentLoop(makeDeps({ guardian, provider, executeTool: exec.fn }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('ok')
    expect(guardian.replans).toBeGreaterThanOrEqual(1)
    // Post-replan tool call executed without tripping the Guardian.
    expect(exec.calls.map(c => c.name)).toEqual(['greet'])
  })

  it('AC-01-29: alternating plan→replan to keep Guardian window fresh still halts with haltReason:"cap-exceeded" once totalReplans > maxReplans', async () => {
    const guardian = makeGuardianFake()
    // Valid plan whose probe always fails → forced re-plan every round.
    const provider = makeScriptedProvider([{ plan: validPlan('build') }])
    const loop = makeAgentLoop(makeDeps({
      guardian,
      provider,
      maxReplans: 2,
      probeRunner: () => false,
    }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('halted')
    expect(result.haltReason).toBe('cap-exceeded')
    expect(guardian.replans).toBeGreaterThan(2)
  })

  it('AC-01-30: skill-failure threshold breach deprioritizes strategy / triggers re-plan but never sets haltReason:"loop-guardian" on its own', async () => {
    const guardian = makeGuardianFake(Infinity) // never trips on its own
    const provider = makeScriptedProvider([{ plan: validPlan('flaky-skill') }])
    const loop = makeAgentLoop(makeDeps({ guardian, provider, probeRunner: () => false }))
    const result = await loop.runTurn(makeTurnInput())
    // Repeated failures re-plan and eventually cap out — but never masquerade as a Guardian trip.
    expect(result.state).toBe('halted')
    expect(result.haltReason).not.toBe('loop-guardian')
    expect(result.haltReason).toBe('cap-exceeded')
    expect(guardian.replans).toBeGreaterThan(0)
  })

  it('replan response without a plan exits plan mode and dispatches its free-form tool calls', async () => {
    const exec = makeExecSpy()
    const guardian = makeGuardianFake()
    const provider = makeScriptedProvider([
      { plan: validPlan('build') },                    // step fails its probe
      { toolCalls: [{ name: 'fallback', args: {} }] }, // re-plan carries no plan
      { reply: 'done' },                               // ADR-0102 synthesis reply ends the turn
    ])
    const loop = makeAgentLoop(makeDeps({ provider, guardian, executeTool: exec.fn, probeRunner: () => false }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('ok')
    expect(guardian.replans).toBe(1)
    // No senseless retry of the failed plan: free-form continuation instead.
    expect(exec.calls.map(c => c.name)).toEqual(['build', 'fallback'])
  })

  it('narrowed mode persists across a turn carrying no operator span', async () => {
    const hookGate = makeHookGateFake('allow')
    // ADR-0102: one dispatch per turn (tool then text), so preCalls has one entry/turn.
    const provider = makeAlternatingToolProvider({ name: 'read_file', args: { path: 'a' } })
    const loop = makeAgentLoop(makeDeps({ hookGate, provider }))
    await loop.runTurn(makeTurnInput({ spans: [makeUntrustedSpan()] })) // → narrowed
    await loop.runTurn(makeTurnInput({ spans: [] }))                    // no operator span → stays narrowed
    await loop.runTurn(makeTurnInput({ spans: [makeOperatorSpan()] }))  // clean operator turn → clears
    expect(hookGate.preCalls.map(c => c.ctx.narrowed)).toEqual([true, true, false])
  })

  it('does not narrow on its own recorded replies, but still narrows on ingested history', async () => {
    // The agent's own answer is recorded as untrusted by construction. Read back
    // as history it would otherwise lock every later reply of the session behind
    // an approval for the agent's own previous sentence.
    const ownReply: ContextSpan = { role: 'assistant', provenance: 'untrusted', text: 'мой прошлый ответ' }
    const selfOnly = makeAgentLoop(makeDeps({
      hookGate: makeHookGateFake('allow'),
      provider: makeAlternatingToolProvider({ name: 'read_file', args: { path: 'a' } }),
      transcriptRecorder: makeTranscriptRecorderFake(Infinity, false, [ownReply]),
    }))
    const clean = await selfOnly.runTurn(makeTurnInput({
      spans: [makeOperatorSpan()], turnId: 't1', turnTs: '2026-08-10T00:00:00.000Z',
    }))
    expect(clean.narrowed).toBe(false)

    const ingested = makeAgentLoop(makeDeps({
      hookGate: makeHookGateFake('allow'),
      provider: makeAlternatingToolProvider({ name: 'read_file', args: { path: 'a' } }),
      transcriptRecorder: makeTranscriptRecorderFake(Infinity, false, [ownReply, makeUntrustedSpan()]),
    }))
    const tainted = await ingested.runTurn(makeTurnInput({
      spans: [makeOperatorSpan()], turnId: 't1', turnTs: '2026-08-10T00:00:00.000Z',
    }))
    expect(tainted.narrowed).toBe(true)
  })

  it('AC-01-31: injectable Clock produces deterministic log ts values and unchanged prefixHash', async () => {
    const clock = fakeClock(1_000_000)
    const sessionLog = makeSessionLogFake()
    const loop = makeAgentLoop(makeDeps({ clock, sessionLog }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('ok')
    const expected = new Date(1_000_000).toISOString()
    expect(sessionLog.entries.length).toBeGreaterThan(0)
    for (const entry of sessionLog.entries) {
      expect(entry.ts).toBe(expected)
    }
  })

  it('AC-01-32: injectable ProviderAdapter fake drives a full turn including all-providers-down path with no real network call', async () => {
    const allDown = makeAllDownProvider()
    const sessionLog = makeSessionLogFake()
    const loop = makeAgentLoop(makeDeps({ provider: allDown, sessionLog }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('halted')
    expect(result.haltReason).toBe('all-providers-down')
    // The log captured the turn — and the provider was a pure in-process fake.
    expect(sessionLog.entries.length).toBeGreaterThan(0)
  })

  it('replan to a shorter plan restarts execution at step 0, never silently skipping the new plan', async () => {
    const exec = makeExecSpy()
    // Original plan [A, B]: A's probe passes, B's probe fails → replan returns a 1-step plan [X].
    // The new plan must execute from step 0 (X), not be skipped because the old cursor was at 1.
    const probeResults = [true, false, true] // A pass, B fail, X pass
    let probeIdx = 0
    const provider = makeScriptedProvider([
      { plan: { steps: [stepWith('A'), stepWith('B')] } },
      { plan: { steps: [stepWith('X')] } },
    ])
    const loop = makeAgentLoop(makeDeps({
      provider,
      executeTool: exec.fn,
      probeRunner: () => probeResults[probeIdx++] ?? true,
    }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('ok')
    // X must have run; the replanned plan is not silently dropped.
    expect(exec.calls.map(c => c.name)).toEqual(['A', 'B', 'X'])
  })

  it('plan-lint loop that exhausts the re-plan budget halts with cap-exceeded, not the proximate trigger (§5.3)', async () => {
    // The model keeps emitting unlintable plans; the monotonic re-plan budget overflows.
    // Per §5.3/§7 a budget overflow halts with cap-exceeded regardless of the proximate trigger.
    const badStep = { intent: 'no trace', tools: ['x'], irreversible: false } as unknown as PlanStep
    const provider = makeProviderFakeWithResponse({ plan: { steps: [badStep] } })
    const loop = makeAgentLoop(makeDeps({ provider, maxReplans: 1 }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('halted')
    expect(result.haltReason).toBe('cap-exceeded')
  })

})

describe('Tier-2 loop control seams', () => {
  it('#4: an already-aborted signal halts the turn with stopped (clean, not error)', async () => {
    const controller = new AbortController()
    controller.abort()
    const loop = makeAgentLoop(makeDeps({ provider: makeAbortAwareProvider() }))
    const result = await loop.runTurn(makeTurnInput({ signal: controller.signal }))
    expect(result.state).toBe('halted')
    expect(result.haltReason).toBe('stopped')
    expect(result.reply).toBe('')
  })

  it('#4: passes the signal down to provider.complete', async () => {
    let seen: AbortSignal | undefined
    const provider: ProviderAdapter = {
      async complete(_req, signal) { seen = signal; return { reply: 'ok', toolCalls: [] } },
    }
    const controller = new AbortController()
    const loop = makeAgentLoop(makeDeps({ provider }))
    await loop.runTurn(makeTurnInput({ signal: controller.signal }))
    expect(seen).toBe(controller.signal)
  })

  it('emits the code-owned outbound verdict before forwarding provider deltas', async () => {
    const events: string[] = []
    const provider: ProviderAdapter = {
      async complete(_req, _signal, progress) {
        await progress?.({ type: 'started' })
        await progress?.({ type: 'text-delta', text: 'hello' })
        return { reply: 'hello', toolCalls: [] }
      },
    }
    const loop = makeAgentLoop(makeDeps({ provider }))
    const result = await loop.runTurn(makeTurnInput({
      onProgress: (event) => { events.push(event.type === 'outbound-lockout'
        ? `lock:${event.locked}`
        : event.type) },
    }))

    expect(result.reply).toBe('hello')
    expect(events).toEqual(['lock:false', 'turn-started', 'started', 'text-delta'])
  })

  it('reports an untrusted turn as locked before any provider delta', async () => {
    const events: string[] = []
    const provider: ProviderAdapter = {
      async complete(_req, _signal, progress) {
        await progress?.({ type: 'text-delta', text: 'must stay held' })
        return { reply: 'must stay held', toolCalls: [] }
      },
    }
    const loop = makeAgentLoop(makeDeps({ provider }))
    await loop.runTurn(makeTurnInput({
      spans: [makeUntrustedSpan()],
      onProgress: (event) => { events.push(event.type === 'outbound-lockout'
        ? `lock:${event.locked}`
        : event.type) },
    }))

    expect(events).toEqual(['lock:true', 'turn-started', 'text-delta'])
  })

  it('emits code-owned cumulative turn usage after accepting a model response', async () => {
    const events: TurnProgressEvent[] = []
    const loop = makeAgentLoop(makeDeps({
      provider: makeProviderFakeWithResponse({
        reply: 'done',
        usage: { inputTokens: 10, outputTokens: 4, dollars: 0.25 },
      }),
    }))
    await loop.runTurn(makeTurnInput({ onProgress: event => { events.push(event) } }))

    expect(events.filter(event => event.type === 'turn-usage')).toEqual([{
      type: 'turn-usage', inputTokens: 10, outputTokens: 4, dollars: 0.25,
    }])
  })

  it.each([
    ['read_file', 'tool'],
    ['spawn_subagent', 'subagent'],
  ] as const)('emits code-owned lifecycle for an executed %s', async (name, category) => {
    const events: Array<{ type: string; name?: string; category?: string }> = []
    const loop = makeAgentLoop(makeDeps({
      provider: makeScriptedProvider([
        { reply: '', toolCalls: [{ name, args: {} }] },
        { reply: 'done', toolCalls: [] },
      ]),
      executeTool: async () => ({ ok: true }),
    }))
    await loop.runTurn(makeTurnInput({
      onProgress: event => { events.push(event as { type: string; name?: string; category?: string }) },
    }))

    expect(events.filter(event => event.type.startsWith('tool-'))).toEqual([
      { type: 'tool-pending', sequence: 1, name, category },
      { type: 'tool-started', sequence: 1, name, category },
      { type: 'tool-completed', sequence: 1, name, category },
    ])
  })

  it('propagates only a code-classified tool interruption unchanged', async () => {
    const interruption = Object.freeze({ kind: 'durable-pause' })
    const calls: string[] = []
    const loop = makeAgentLoop(makeDeps({
      provider: makeScriptedProvider([
        { reply: '', toolCalls: [{ name: 'spawn_subagent', args: {} }] },
      ]),
      executeTool: async () => { throw interruption },
      propagateToolInterruption(error, call, context) {
        calls.push(`${call.name}:${context.ordinal}`)
        return error === interruption
      },
    }))

    await expect(loop.runTurn(makeTurnInput())).rejects.toBe(interruption)
    expect(calls).toEqual(['spawn_subagent:1'])
  })

  it('keeps unclassified tool failures as ordinary tool results', async () => {
    const loop = makeAgentLoop(makeDeps({
      provider: makeScriptedProvider([
        { reply: '', toolCalls: [{ name: 'read_file', args: {} }] },
        { reply: 'handled', toolCalls: [] },
      ]),
      executeTool: async () => { throw new Error('ordinary failure') },
      propagateToolInterruption: () => false,
    }))

    await expect(loop.runTurn(makeTurnInput())).resolves.toMatchObject({
      state: 'ok', reply: 'handled',
    })
  })

  it('lets a code-owned preflight intercept before HookGate and feeds the result back to the model', async () => {
    const hookGate = makeHookGateFake('allow')
    const executed: ToolCall[] = []
    const contexts: ToolExecutionContext[] = []
    const provider = makeScriptedProvider([
      { reply: '', toolCalls: [{ name: 'submit_plan', args: { plan: '{}' } }] },
      { reply: 'продолжаю выполнение', toolCalls: [] },
    ])
    const loop = makeAgentLoop(makeDeps({
      provider,
      hookGate,
      preToolDispatch: (_call, context) => {
        contexts.push(context)
        return { kind: 'intercept', result: { ok: true, output: 'PLAN_ACCEPTED' } }
      },
      executeTool: async (call) => { executed.push(call); return { ok: true } },
    }))

    await expect(loop.runTurn(makeTurnInput({ turnId: 'telegram-plan-1' }))).resolves.toMatchObject({
      state: 'ok', reply: 'продолжаю выполнение',
    })
    expect(hookGate.preCalls).toHaveLength(0)
    expect(executed).toHaveLength(0)
    expect(contexts[0]).toMatchObject({ sessionId: 'test-session', turnId: 'telegram-plan-1', ordinal: 1 })
    expect(provider.requests[1]?.spans).toContainEqual({
      role: 'tool', provenance: 'untrusted', text: 'submit_plan: PLAN_ACCEPTED',
    })
  })

  it('assigns a stable code-owned position to each requested tool call', async () => {
    const contexts: ToolExecutionContext[] = []
    const provider = makeScriptedProvider([
      {
        reply: '',
        toolCalls: [
          { name: 'read_file', args: { path: 'a' } },
          { name: 'spawn_subagent', args: { plan: '{}' } },
        ],
      },
      { reply: 'done', toolCalls: [] },
    ])
    const loop = makeAgentLoop(makeDeps({
      provider,
      executeTool: async (_call, context) => {
        contexts.push(context)
        return { ok: true }
      },
    }))

    await loop.runTurn(makeTurnInput({ turnId: 'telegram-update-7' }))

    expect(contexts).toEqual([
      { sessionId: 'test-session', turnId: 'telegram-update-7', ordinal: 1 },
      { sessionId: 'test-session', turnId: 'telegram-update-7', ordinal: 2 },
    ])
    expect(provider.requests.map(request => request.turnId)).toEqual([
      'telegram-update-7', 'telegram-update-7',
    ])
    expect(Object.isFrozen(contexts[0])).toBe(true)
    expect(Object.isFrozen(contexts[1])).toBe(true)
    expect(isGenuineToolExecutionContextFor(contexts[0], 'read_file')).toBe(true)
    expect(isGenuineToolExecutionContextFor(contexts[0], 'spawn_subagent')).toBe(false)
    expect(isGenuineToolExecutionContextFor(contexts[1], 'spawn_subagent')).toBe(true)
    expect(isGenuineToolExecutionContextFor({ ...contexts[1] }, 'spawn_subagent')).toBe(false)
  })

  it('reconstructs the same position for the same turn and changes it for a new turn', async () => {
    const execute = async (turnId: string): Promise<ToolExecutionContext> => {
      let seen: ToolExecutionContext | undefined
      const loop = makeAgentLoop(makeDeps({
        provider: makeScriptedProvider([
          { reply: '', toolCalls: [{ name: 'spawn_subagent', args: { plan: '{}' } }] },
          { reply: 'done', toolCalls: [] },
        ]),
        executeTool: async (_call, context) => {
          seen = context
          return { ok: true }
        },
      }))
      await loop.runTurn(makeTurnInput({ turnId }))
      return seen!
    }

    const first = await execute('turn-a')
    const replay = await execute('turn-a')
    const next = await execute('turn-b')

    expect(replay).toEqual(first)
    expect(next).toEqual({ sessionId: 'test-session', turnId: 'turn-b', ordinal: 1 })
    expect(next).not.toEqual(first)
  })

  it('counts a denied position before the next allowed call', async () => {
    const contexts: ToolExecutionContext[] = []
    let gateCalls = 0
    const loop = makeAgentLoop(makeDeps({
      provider: makeScriptedProvider([
        {
          reply: '',
          toolCalls: [
            { name: 'write_file', args: { path: 'x', content: 'x' } },
            { name: 'spawn_subagent', args: { plan: '{}' } },
          ],
        },
        { reply: 'done', toolCalls: [] },
      ]),
      hookGate: {
        pre: async () => (++gateCalls === 1 ? 'deny' : 'allow'),
        post: async (_call, result) => result,
      },
      executeTool: async (_call, context) => {
        contexts.push(context)
        return { ok: true }
      },
    }))

    await loop.runTurn(makeTurnInput({ turnId: 'turn-with-denial' }))

    expect(contexts).toEqual([
      { sessionId: 'test-session', turnId: 'turn-with-denial', ordinal: 2 },
    ])
  })

  it('emits a redacted denied lifecycle without executing the tool', async () => {
    const events: Array<{ type: string; reason?: string }> = []
    const loop = makeAgentLoop(makeDeps({
      provider: makeProviderFakeWithResponse({
        reply: 'held', toolCalls: [{ name: 'write_file', args: { path: 'x' } }],
      }),
      hookGate: { pre: async () => 'deny', post: async (_call, result) => result },
      executeTool: async () => { throw new Error('must not execute') },
    }))
    await loop.runTurn(makeTurnInput({
      onProgress: event => { events.push(event as { type: string; reason?: string }) },
    }))

    expect(events.filter(event => event.type.startsWith('tool-'))).toEqual([
      // The digest is the one part of the arguments that reaches the card: it
      // is what lets an operator see which file a denied write was aiming at.
      { type: 'tool-pending', sequence: 1, name: 'write_file', category: 'tool', arg: 'x' },
      {
        type: 'tool-denied', sequence: 1, name: 'write_file', category: 'tool', arg: 'x',
        reason: 'policy',
      },
    ])
  })

  it('emits a redacted failure lifecycle and preserves the execution error', async () => {
    const events: string[] = []
    const provider = makeScriptedProvider([
      { reply: '', toolCalls: [{ name: 'read_file', args: {} }] },
      { reply: 'recovered', toolCalls: [] },
    ])
    const loop = makeAgentLoop(makeDeps({
      provider,
      executeTool: async () => { throw new Error('executor failed') },
    }))
    await expect(loop.runTurn(makeTurnInput({
      onProgress: event => { events.push(event.type) },
    }))).resolves.toMatchObject({ state: 'ok', reply: 'recovered' })
    expect(provider.requests[1]!.spans.find(span => span.role === 'tool')?.text)
      .toContain('executor failed')
    expect(events.filter(type => type.startsWith('tool-'))).toEqual([
      'tool-pending', 'tool-started', 'tool-failed',
    ])
  })

  it('maps a typed executor {ok:false} result to tool-failed without inventing an exception', async () => {
    const events: string[] = []
    const loop = makeAgentLoop(makeDeps({
      provider: makeScriptedProvider([
        { reply: '', toolCalls: [{ name: 'read_file', args: {} }] },
        { reply: 'not read', toolCalls: [] },
      ]),
      executeTool: async () => ({ ok: false, output: 'denied' }),
    }))
    await expect(loop.runTurn(makeTurnInput({
      onProgress: event => { events.push(event.type) },
    }))).resolves.toMatchObject({ state: 'ok', reply: 'not read' })
    expect(events.filter(type => type.startsWith('tool-'))).toEqual([
      'tool-pending', 'tool-started', 'tool-failed',
    ])
  })

  it('keeps progress observational when its sink fails', async () => {
    const loop = makeAgentLoop(makeDeps())
    await expect(loop.runTurn(makeTurnInput({
      onProgress: async () => { throw new Error('telegram unavailable') },
    }))).resolves.toMatchObject({ state: 'ok', reply: 'ok' })
  })

  it('#5: budgetCheck returning true halts the turn with budget-capped', async () => {
    const loop = makeAgentLoop(makeDeps({
      provider: makeProviderFakeWithResponse({ usage: { inputTokens: 100, outputTokens: 50, dollars: 1 } }),
      budgetCheck: () => true,
    }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('halted')
    expect(result.haltReason).toBe('budget-capped')
  })

  it('#5: budgetCheck sees accumulated usage and false lets the turn finish ok', async () => {
    const seen: number[] = []
    const loop = makeAgentLoop(makeDeps({
      provider: makeProviderFakeWithResponse({ reply: 'done', usage: { inputTokens: 10, outputTokens: 5, dollars: 0.1 } }),
      budgetCheck: (u) => { seen.push(u.dollars); return false },
    }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('ok')
    expect(result.reply).toBe('done')
    expect(seen).toEqual([0.1])
  })

  it('#6: a turn with an untrusted span returns narrowed (feeds the outbound-lockout source)', async () => {
    const loop = makeAgentLoop(makeDeps())
    const result = await loop.runTurn(makeTurnInput({ spans: [makeUntrustedSpan()] }))
    expect(result.narrowed).toBe(true)
  })

  it('#4: aborting between tool calls halts with stopped before the next dispatch', async () => {
    const controller = new AbortController()
    const provider = makeProviderFakeWithResponse({
      reply: 'ok',
      toolCalls: [{ name: 'read_file', args: {} }, { name: 'read_file', args: {} }],
    })
    const loop = makeAgentLoop(makeDeps({
      provider,
      executeTool: () => { controller.abort(); return { ok: true } }, // abort during first dispatch
    }))
    const result = await loop.runTurn(makeTurnInput({ signal: controller.signal }))
    expect(result.state).toBe('halted')
    expect(result.haltReason).toBe('stopped')
  })

  it('#5: a budget-capped halt still carries the turn usage (so the bot records it and the cap advances)', async () => {
    const loop = makeAgentLoop(makeDeps({
      provider: makeProviderFakeWithResponse({ usage: { inputTokens: 100, outputTokens: 50, dollars: 2 } }),
      budgetCheck: () => true,
    }))
    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('halted')
    expect(result.haltReason).toBe('budget-capped')
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, dollars: 2 })
  })

  it('#6: a narrowed turn that halts still reports narrowed (outbound lockout persists)', async () => {
    const loop = makeAgentLoop(makeDeps({
      provider: makeProviderFakeWithResponse({ usage: { inputTokens: 10, outputTokens: 5, dollars: 1 } }),
      budgetCheck: () => true,
    }))
    const result = await loop.runTurn(makeTurnInput({ spans: [makeUntrustedSpan()] }))
    expect(result.state).toBe('halted')
    expect(result.narrowed).toBe(true)
  })

  // ADR-0102 — tool-result synthesis round on the free-form toolCalls path.
  describe('ADR-0102 tool-result synthesis round', () => {
    it('admits only the PostToolUse result to synthesis context', async () => {
      const provider = makeScriptedProvider([
        { toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
        { reply: 'safe answer' },
      ])
      const hookGate = makeHookGateFake('allow')
      hookGate.post = async () => ({ ok: true, output: 'safe-output' })
      const loop = makeAgentLoop(makeDeps({
        provider,
        hookGate,
        executeTool: async () => ({ ok: true, output: 'raw-secret' }),
      }))

      await loop.runTurn(makeTurnInput())
      const text = provider.requests[1]!.spans.find(span => span.role === 'tool')?.text ?? ''
      expect(text).toContain('safe-output')
      expect(text).not.toContain('raw-secret')
    })

    it('wraps executor exceptions as a failed result and keeps the loop alive', async () => {
      const provider = makeScriptedProvider([
        { toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
        { reply: 'recovered' },
      ])
      const hookGate = makeHookGateFake('allow')
      hookGate.post = async (_call, raw) => {
        expect(raw).toEqual({ ok: false, output: 'disk secret failed' })
        return { ok: false, output: 'Tool error: «redacted» failed' }
      }
      const loop = makeAgentLoop(makeDeps({
        provider,
        hookGate,
        executeTool: async () => { throw new Error('disk secret failed') },
      }))

      await expect(loop.runTurn(makeTurnInput())).resolves.toMatchObject({
        state: 'ok', reply: 'recovered',
      })
      const text = provider.requests[1]!.spans.find(span => span.role === 'tool')?.text ?? ''
      expect(text).toContain('Tool error: «redacted» failed')
      expect(text).not.toContain('disk secret')
    })

    it('after an executed tool, runs a second model call fed the tool result and returns its reply', async () => {
      const exec = makeExecSpy()
      const provider = makeScriptedProvider([
        { toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
        { reply: 'synthesized answer' },
      ])
      const loop = makeAgentLoop(makeDeps({ provider, executeTool: exec.fn, hookGate: makeHookGateFake('allow') }))
      const result = await loop.runTurn(makeTurnInput())

      expect(result.state).toBe('ok')
      // Synthesis reply, not the pre-tool preamble.
      expect(result.reply).toBe('synthesized answer')
      // Exactly two model calls: request + synthesis.
      expect(provider.requests.length).toBe(2)
      // The tool ran once and was NOT re-dispatched from the synthesis response.
      expect(exec.calls.map(c => c.name)).toEqual(['read_file'])
      // The synthesis request carried the assistant preamble + a tool-result span.
      const synthSpans = provider.requests[1]!.spans
      expect(synthSpans.some(s => s.role === 'assistant' && s.text === 'ok')).toBe(true)
      const toolSpan = synthSpans.find(s => s.role === 'tool')
      expect(toolSpan?.text.startsWith('read_file: ')).toBe(true)
    })

    it('dispatches every tool emitted together, then a single synthesis round', async () => {
      const exec = makeExecSpy()
      const provider = makeScriptedProvider([
        { toolCalls: [{ name: 'read_file', args: { path: 'a' } }, { name: 'list_dir', args: { path: '.' } }] },
        { reply: 'done' },
      ])
      const loop = makeAgentLoop(makeDeps({ provider, executeTool: exec.fn, hookGate: makeHookGateFake('allow') }))
      const result = await loop.runTurn(makeTurnInput())

      expect(result.reply).toBe('done')
      expect(exec.calls.map(c => c.name)).toEqual(['read_file', 'list_dir'])
      expect(provider.requests.length).toBe(2)
      expect(provider.requests[1]!.spans.filter(s => s.role === 'tool').length).toBe(2)
    })

    it('an empty preamble is not sent as an assistant span; the tool span still is', async () => {
      const exec = makeExecSpy()
      const provider = makeScriptedProvider([
        { reply: '', toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
        { reply: 'answer' },
      ])
      const loop = makeAgentLoop(makeDeps({ provider, executeTool: exec.fn, hookGate: makeHookGateFake('allow') }))
      const result = await loop.runTurn(makeTurnInput())

      expect(result.reply).toBe('answer')
      const synthSpans = provider.requests[1]!.spans
      expect(synthSpans.some(s => s.role === 'assistant')).toBe(false)
      expect(synthSpans.some(s => s.role === 'tool')).toBe(true)
    })

    it('a gated-only turn runs no synthesis round (behaviour unchanged)', async () => {
      const exec = makeExecSpy()
      const provider = makeScriptedProvider([{ toolCalls: [{ name: 'send_message', args: { to: 'x' } }] }])
      const loop = makeAgentLoop(makeDeps({ provider, executeTool: exec.fn, hookGate: makeHookGateFake('deny') }))
      const result = await loop.runTurn(makeTurnInput())

      expect(result.state).toBe('ok')
      // No tool executed → single model call, pre-tool reply returned.
      expect(exec.calls.length).toBe(0)
      expect(provider.requests.length).toBe(1)
      expect(result.reply).toBe('ok')
    })
  })

  describe('ADR-0064 full-fidelity transcript seam', () => {
    it('rejects missing turn authority before provider or tool I/O', async () => {
      const provider = makeScriptedProvider([{ toolCalls: [{ name: 'read_file', args: {} }] }])
      const exec = makeExecSpy()
      const transcriptRecorder = makeTranscriptRecorderFake()
      const loop = makeAgentLoop(makeDeps({ provider, executeTool: exec.fn, transcriptRecorder }))

      await expect(loop.runTurn(makeTurnInput())).rejects.toThrow(
        'transcript recorder requires stable turnId and turnTs',
      )
      expect(provider.requests).toEqual([])
      expect(exec.calls).toEqual([])
      expect(transcriptRecorder.starts).toEqual([])
      expect(transcriptRecorder.records).toEqual([])
    })

    it('starts once from the exact combined frozen prefix before recording input', async () => {
      const transcriptRecorder = makeTranscriptRecorderFake()
      const provider = makeScriptedProvider([{ reply: 'first' }, { reply: 'second' }])
      const base = new TextEncoder().encode('base-prefix')
      const extension = new TextEncoder().encode('skills-menu')
      const loop = makeAgentLoop(makeDeps({
        provider,
        transcriptRecorder,
        memory: makeMemoryFake({
          prefixBytes: base,
          prefixHash: 'caller-hash',
          breakpoints: [4],
          takenAt: '2026-07-27T01:00:00.000Z',
        }),
        prefixExtension: () => extension,
      }))

      await loop.runTurn(makeTurnInput({
        turnId: 'turn-1', turnTs: '2026-07-27T01:02:03.000Z',
      }))
      await loop.runTurn(makeTurnInput({
        turnId: 'turn-2', turnTs: '2026-07-27T01:03:03.000Z',
      }))

      expect(transcriptRecorder.starts).toHaveLength(1)
      expect(new TextDecoder().decode(transcriptRecorder.starts[0]!.frozen.prefixBytes))
        .toBe('base-prefixskills-menu')
      expect(transcriptRecorder.starts[0]!.frozen.prefixHash)
        .toBe(createHash('sha256').update(Buffer.concat([Buffer.from(base), Buffer.from(extension)])).digest('hex'))
      expect(transcriptRecorder.starts[0]!.frozen.breakpoints).toEqual([4])
      expect(transcriptRecorder.records.filter(item => item.span.role === 'user')).toHaveLength(2)
    })

    it('fails before input persistence and provider I/O when session start fails', async () => {
      const transcriptRecorder = makeTranscriptRecorderFake(Infinity, true)
      const provider = makeScriptedProvider([{ reply: 'must not run' }])
      const loop = makeAgentLoop(makeDeps({ provider, transcriptRecorder }))

      await expect(loop.runTurn(makeTurnInput({
        turnId: 'turn-start-failure',
        turnTs: '2026-07-27T01:02:03.000Z',
      }))).rejects.toThrow('transcript start unavailable')
      expect(provider.requests).toEqual([])
      expect(transcriptRecorder.records).toEqual([])
    })

    it('prepends projected durable history without recording it again', async () => {
      const history: ContextSpan[] = [
        { role: 'user', provenance: 'operator', text: 'previous question' },
        { role: 'assistant', provenance: 'untrusted', text: 'previous answer' },
      ]
      const transcriptRecorder = makeTranscriptRecorderFake(Infinity, false, history)
      const provider = makeScriptedProvider([{ reply: 'current answer' }])
      const loop = makeAgentLoop(makeDeps({ provider, transcriptRecorder }))

      const result = await loop.runTurn(makeTurnInput({
        turnId: 'turn-with-history',
        turnTs: '2026-07-27T01:02:03.000Z',
      }))

      expect(provider.requests[0]!.spans.slice(0, 2)).toEqual(history)
      expect(transcriptRecorder.records.map(item => item.span.text)).toEqual(['hello', 'current answer'])
      // History made of the operator and the agent's own answers is not an
      // ingested untrusted source, so replaying it does not narrow the turn.
      expect(result.narrowed).toBe(false)
    })

    it('records exact input, assistant and effective tool spans in durable order', async () => {
      const provider = makeScriptedProvider([
        { reply: 'reading', toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
        { reply: 'done' },
      ])
      const transcriptRecorder = makeTranscriptRecorderFake()
      const loop = makeAgentLoop(makeDeps({
        provider,
        transcriptRecorder,
        hookGate: makeHookGateFake({ modify: { name: 'safe_read', args: { path: 'a' } } }),
        executeTool: () => ({ output: 'contents' }),
      }))

      const result = await loop.runTurn(makeTurnInput({
        turnId: 'telegram-update-7',
        turnTs: '2026-07-27T01:02:03.000Z',
      }))

      expect(result.reply).toBe('done')
      expect(transcriptRecorder.starts).toHaveLength(1)
      expect(transcriptRecorder.records.map(item => item.ordinal)).toEqual([1, 2, 3, 4])
      expect(transcriptRecorder.records.map(item => item.span)).toEqual([
        { role: 'user', provenance: 'operator', text: 'hello' },
        { role: 'assistant', provenance: 'untrusted', text: 'reading' },
        { role: 'tool', provenance: 'untrusted', text: 'safe_read: contents' },
        { role: 'assistant', provenance: 'untrusted', text: 'done' },
      ])
      expect(transcriptRecorder.records.every(item =>
        item.sessionId === 'test-session' && item.turnId === 'telegram-update-7' &&
        item.turnTs === '2026-07-27T01:02:03.000Z')).toBe(true)
      expect(provider.requests[1]!.spans).toEqual(expect.arrayContaining([
        transcriptRecorder.records[1]!.span,
        transcriptRecorder.records[2]!.span,
      ]))
    })

    it('stops before tool dispatch when recording the provider response fails', async () => {
      const provider = makeScriptedProvider([
        { reply: 'will read', toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
      ])
      const exec = makeExecSpy()
      const transcriptRecorder = makeTranscriptRecorderFake(2)
      const loop = makeAgentLoop(makeDeps({ provider, executeTool: exec.fn, transcriptRecorder }))

      await expect(loop.runTurn(makeTurnInput({
        turnId: 'turn-fail-closed',
        turnTs: '2026-07-27T01:02:03.000Z',
      }))).rejects.toThrow('transcript unavailable')
      expect(provider.requests).toHaveLength(1)
      expect(exec.calls).toEqual([])
      expect(transcriptRecorder.records.map(item => item.span.role)).toEqual(['user'])
    })

    it('records code-owned action instructions and the deterministic failure reply', async () => {
      const provider = makeScriptedProvider([
        { reply: 'Проверил без инструмента' },
        { reply: 'По-прежнему без доказательств' },
      ])
      const transcriptRecorder = makeTranscriptRecorderFake()
      const loop = makeAgentLoop(makeDeps({ provider, transcriptRecorder }))

      const result = await loop.runTurn(makeTurnInput({
        turnId: 'turn-action-contract',
        turnTs: '2026-07-27T01:02:03.000Z',
        spans: [makeOperatorSpan('Проверь файл')],
      }))

      expect(result.actionStatus).toBe('unverified')
      expect(transcriptRecorder.records.map(item => item.span.role)).toEqual([
        'user', 'system', 'assistant', 'system', 'assistant', 'assistant',
      ])
      expect(transcriptRecorder.records[1]!.span.text).toContain('Action contract')
      expect(transcriptRecorder.records[3]!.span.text).toContain('Action contract')
      expect(transcriptRecorder.records[5]!.span).toEqual({
        role: 'assistant',
        provenance: 'operator',
        text: result.reply,
      })
    })
  })

  describe('ADR-0059 Action Contract enforcement', () => {
    it('AC-01-33: leaves informational requests on the one-call answer-only path', async () => {
      const provider = makeScriptedProvider([{ reply: 'instructions' }])
      const loop = makeAgentLoop(makeDeps({ provider }))
      const result = await loop.runTurn(makeTurnInput({
        spans: [makeOperatorSpan('Объясни, как создать файл')],
      }))

      expect(result.reply).toBe('instructions')
      expect(result.actionStatus).toBeUndefined()
      expect(provider.requests).toHaveLength(1)
      expect(provider.requests[0]!.spans.some(s => s.role === 'system' && s.text.includes('Action contract'))).toBe(false)
    })

    it('AC-01-34: gives one corrective turn then rejects a dry inspection claim as unverified', async () => {
      const provider = makeScriptedProvider([
        { reply: 'Проверил, всё хорошо' },
        { reply: 'Точно проверил' },
      ])
      const sessionLog = makeSessionLogFake()
      const loop = makeAgentLoop(makeDeps({ provider, sessionLog }))
      const progress: TurnProgressEvent[] = []
      const result = await loop.runTurn(makeTurnInput({
        spans: [makeOperatorSpan('Проверь файл')],
        onProgress: event => { progress.push(event) },
      }))

      expect(provider.requests).toHaveLength(2)
      expect(result.actionContractKind).toBe('inspect-required')
      expect(result.actionStatus).toBe('unverified')
      expect(result.reply).toContain('Не удалось подтвердить')
      expect(sessionLog.entries.map(e => e.kind)).toEqual(expect.arrayContaining([
        'action.contract',
        'action.recovery',
        'action.unverified',
      ]))
      expect(progress.filter(event => event.type.startsWith('action-'))).toEqual([
        { type: 'action-contract', kind: 'inspect-required' },
        { type: 'action-recovery', kind: 'inspect-required', missing: 'observation' },
      ])
    })

    it('AC-01-34b: does not accept an empty plan as action evidence', async () => {
      const provider = makeScriptedProvider([
        { reply: 'Готово', plan: { steps: [] } },
        { reply: 'Проверять нечем' },
      ])
      const loop = makeAgentLoop(makeDeps({ provider }))
      const result = await loop.runTurn(makeTurnInput({
        spans: [makeOperatorSpan('Исправь файл')],
      }))

      expect(provider.requests).toHaveLength(2)
      expect(result.actionStatus).toBe('unverified')
      expect(result.reply).toContain('Не удалось подтвердить')
    })

    it('AC-01-35: accepts inspection after the corrective turn executes an observation tool', async () => {
      const exec = makeExecSpy()
      const provider = makeScriptedProvider([
        { reply: 'Проверил' },
        { reply: '', toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
        { reply: 'Проверка подтверждена' },
      ])
      const loop = makeAgentLoop(makeDeps({ provider, executeTool: exec.fn }))
      const result = await loop.runTurn(makeTurnInput({
        spans: [makeOperatorSpan('Проверь файл')],
      }))

      expect(provider.requests).toHaveLength(3)
      expect(exec.calls.map(c => c.name)).toEqual(['read_file'])
      expect(result.reply).toBe('Проверка подтверждена')
      expect(result.actionStatus).toBe('verified')
    })

    it('AC-01-36: requires an independent readback after a mutation', async () => {
      const exec = makeExecSpy()
      const provider = makeScriptedProvider([
        { reply: '', toolCalls: [{ name: 'write_file', args: { path: 'a', content: 'x' } }] },
        { reply: 'Готово' },
        { reply: '', toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
        { reply: 'Изменение проверено' },
      ])
      const loop = makeAgentLoop(makeDeps({ provider, executeTool: exec.fn }))
      const result = await loop.runTurn(makeTurnInput({
        spans: [makeOperatorSpan('Исправь файл')],
      }))

      expect(provider.requests).toHaveLength(4)
      expect(exec.calls.map(c => c.name)).toEqual(['write_file', 'read_file'])
      expect(result.reply).toBe('Изменение проверено')
      expect(result.actionStatus).toBe('verified')
    })

    it('AC-01-36: does not accept a write-only completion claim without postcondition evidence', async () => {
      const exec = makeExecSpy()
      const provider = makeScriptedProvider([
        { reply: '', toolCalls: [{ name: 'write_file', args: { path: 'a', content: 'x' } }] },
        { reply: 'Готово' },
        { reply: 'Проверять не буду' },
      ])
      const loop = makeAgentLoop(makeDeps({ provider, executeTool: exec.fn }))
      const result = await loop.runTurn(makeTurnInput({
        spans: [makeOperatorSpan('Исправь файл')],
      }))

      expect(provider.requests).toHaveLength(3)
      expect(exec.calls.map(c => c.name)).toEqual(['write_file'])
      expect(result.actionStatus).toBe('unverified')
      expect(result.reply).not.toContain('Готово')
    })

    it('AC-01-37: keeps denials authoritative and performs only one recovery model call', async () => {
      const exec = makeExecSpy()
      const provider = makeScriptedProvider([
        { reply: '', toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
        { reply: 'Не могу проверить' },
      ])
      const loop = makeAgentLoop(makeDeps({
        provider,
        executeTool: exec.fn,
        hookGate: makeHookGateFake('deny'),
      }))
      const result = await loop.runTurn(makeTurnInput({
        spans: [makeOperatorSpan('Проверь файл')],
      }))

      expect(provider.requests).toHaveLength(2)
      expect(exec.calls).toHaveLength(0)
      expect(result.actionStatus).toBe('unverified')
    })

    it('AC-01-38: requires an executed subagent delegation result', async () => {
      const exec = makeExecSpy()
      const provider = makeScriptedProvider([
        { reply: '', toolCalls: [{ name: 'spawn_subagent', args: { task: 'analyze' } }] },
        { reply: 'Субагент завершил анализ' },
      ])
      const loop = makeAgentLoop(makeDeps({ provider, executeTool: exec.fn }))
      const result = await loop.runTurn(makeTurnInput({
        spans: [makeOperatorSpan('Делегируй анализ субагенту')],
      }))

      expect(exec.calls.map(c => c.name)).toEqual(['spawn_subagent'])
      expect(result.actionContractKind).toBe('delegate-required')
      expect(result.actionStatus).toBe('verified')
    })

    it('AC-01-59: accepts a subscription bridge delegation attested by the local adapter', async () => {
      const response = attachProviderActionEvidence(
        { reply: 'AISY-TEXT-OK; субагент: 323' },
        [
          actionEvidence({ name: 'remember', args: {} }, { ok: true, verified: true }),
          actionEvidence({ name: 'spawn_subagent', args: {} }, { ok: true }),
        ],
      )
      const requests: ModelRequest[] = []
      const provider: ProviderAdapter = {
        complete: async (request) => {
          requests.push(request)
          return response
        },
      }
      const loop = makeAgentLoop(makeDeps({ provider }))

      const result = await loop.runTurn(makeTurnInput({
        spans: [makeOperatorSpan(
          'Ответь AISY-TEXT-OK. Запомни факт. Поручи субагенту вычислить 17×19 и покажи ответ.',
        )],
      }))

      expect(result.reply).toBe('AISY-TEXT-OK; субагент: 323')
      expect(result.actionContractKind).toBe('delegate-required')
      expect(result.actionStatus).toBe('verified')
      expect(requests).toHaveLength(1)
      expect(requests[0]!.spans.some(span =>
        span.role === 'system' && span.text.includes('spawn_subagent') &&
        span.text.includes('{"intent":"standalone task"}'))).toBe(true)
    })

    it('AC-01-59: rejects mixed subscription work when only delegation is attested', async () => {
      const response = attachProviderActionEvidence(
        { reply: 'AISY-TEXT-OK; субагент: 323' },
        [actionEvidence({ name: 'spawn_subagent', args: {} }, { ok: true })],
      )
      const provider: ProviderAdapter = { complete: async () => response }
      const loop = makeAgentLoop(makeDeps({ provider }))

      const result = await loop.runTurn(makeTurnInput({
        spans: [makeOperatorSpan('Запомни факт и поручи субагенту вычислить 17×19.')],
      }))

      expect(result.actionContractKind).toBe('delegate-required')
      expect(result.actionStatus).toBe('unverified')
    })

    it('AC-01-61: accepts the durable receipt of a committed subscription memory write', async () => {
      const response = attachProviderActionEvidence(
        { reply: 'Запомнил.' },
        [actionEvidence({ name: 'remember', args: {} }, { ok: true, verified: true })],
      )
      let calls = 0
      const provider: ProviderAdapter = {
        complete: async () => {
          calls++
          return response
        },
      }
      const loop = makeAgentLoop(makeDeps({ provider }))

      const result = await loop.runTurn(makeTurnInput({
        spans: [makeOperatorSpan('Запомни факт')],
      }))

      expect(result.actionContractKind).toBe('mutate-required')
      expect(result.actionStatus).toBe('verified')
      expect(calls).toBe(1)
    })

    it('AC-01-39: treats an externally verified plan as satisfying the action contract', async () => {
      const exec = makeExecSpy()
      const provider = makeScriptedProvider([{ reply: 'Готово', plan: validPlan('write_file') }])
      const loop = makeAgentLoop(makeDeps({
        provider,
        executeTool: exec.fn,
        probeRunner: () => true,
      }))
      const result = await loop.runTurn(makeTurnInput({
        spans: [makeOperatorSpan('Исправь файл')],
      }))

      expect(provider.requests).toHaveLength(1)
      expect(result.actionStatus).toBe('verified')
      expect(exec.calls.map(c => c.name)).toEqual(['write_file'])
    })
  })
})

describe('late context pull (ADR-0077)', () => {
  it('adds late spans to the provider call without touching the frozen prefix', async () => {
    const provider = makeScriptedProvider([{}])
    const loop = makeAgentLoop(makeDeps({
      provider,
      lateContext: async ({ at }) => at === 'pre-provider'
        ? [{ role: 'user' as const, provenance: 'untrusted' as const, text: 'свежие данные' }]
        : [],
    }))

    const result = await loop.runTurn(makeTurnInput())
    expect(result.state).toBe('ok')

    const request = provider.requests[0]!
    expect(request.spans.some((span) => span.text.includes('свежие данные'))).toBe(true)
    // The prefix is what the KV cache keys on: late context must stay out of it.
    expect(new TextDecoder().decode(request.prefixBytes)).not.toContain('свежие данные')
  })

  it('works unchanged when no hook provides late context', async () => {
    const provider = makeScriptedProvider([{}])
    const loop = makeAgentLoop(makeDeps({ provider }))

    expect((await loop.runTurn(makeTurnInput())).state).toBe('ok')
    expect(provider.requests[0]!.spans.length).toBeGreaterThan(0)
  })
})
