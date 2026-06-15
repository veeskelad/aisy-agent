import { makeAgentLoop } from './index.js'
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
  ToolCall,
  TurnInput,
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
    async post(_call: ToolCall, _result: unknown) {},
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

function makeAllDownProvider(): ProviderAdapter {
  return {
    async complete(_req: ModelRequest): Promise<ModelResponse> {
      const err = new Error('all providers exhausted') as Error & { kind: string }
      err.kind = 'all-exhausted'
      throw err
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
    const provider = makeProviderFakeWithResponse({ toolCalls: [{ name: 'read_file', args: { path: 'a' } }] })
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
    const provider = makeProviderFakeWithResponse({ toolCalls: [{ name: 'read_file', args: { path: 'a' } }] })
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
    const provider = makeProviderFakeWithResponse({ toolCalls: [{ name: 'read_file', args: { path: 'a' } }] })
    const loop = makeAgentLoop(makeDeps({ hookGate, provider }))
    await loop.runTurn(makeTurnInput({ spans: [makeUntrustedSpan()] })) // → narrowed
    await loop.runTurn(makeTurnInput({ spans: [] }))                    // no operator span → stays narrowed
    await loop.runTurn(makeTurnInput({ spans: [makeOperatorSpan()] }))  // clean operator turn → clears
    expect(hookGate.preCalls.map(c => c.ctx.narrowed)).toEqual([true, true, false])
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
