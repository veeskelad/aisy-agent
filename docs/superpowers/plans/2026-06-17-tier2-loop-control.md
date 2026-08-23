# Tier 2 — Loop Control & Safety (`/stop` + mid-turn budget) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator real mid-turn control on the phone — `/stop` hard-kills the in-flight turn, and an enabled per-agent budget halts a turn the moment its accumulated spend crosses the cap — without weakening any safety property of the agent loop.

**Architecture:** Two new *optional* seams on the agent loop, threaded through the existing injection chain.
(1) **Abort** rides inside `TurnInput.signal` (an `AbortSignal`); `runner.handle` already forwards `input` verbatim to `loop.runTurn`, so no runner signature changes. The loop passes the signal to `provider.complete(req, signal)`; each adapter merges it with its own timeout via `AbortSignal.any`. An abort surfaces as a clean `Halt('stopped')`, never an error.
(2) **Mid-turn budget** is an injected `budgetCheck(usage)` probe called after each model call; a positive verdict throws `Halt('budget-capped')`. The probe is wired in `aisy.ts`, closing over the existing `settings` + `budget` stores — the loop stays pure. Both `HaltReason` additions flow to the bot, which maps `stopped` to silence (the `/stop` handler already acked) and `budget-capped` to the existing `budget.capped` card.

Item **#6 (outbound-lockout)** is already live at the bot layer (`result.narrowed` → `presentOutboundLockout`); this plan adds a regression test, fixes a stale comment, and records the deliberate gateway-egress decision rather than re-building it.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, Node16 ESM, `.js` import extensions), vitest, Node ≥ 20.3 (project runs Node 25; `AbortSignal.any` + `AbortSignal.timeout` available), grammY (Telegram transport).

## Global Constraints

- **License Apache-2.0.** No GPL/AGPL deps. (No new deps in this plan.)
- **Brand always "Aisy", affirmative only.** Never "never X".
- **`research/` is gitignored — never reference it in any committed/public file.**
- **TS strict + `exactOptionalPropertyTypes`:** never pass `undefined` to an optional prop — use a conditional spread `...(x !== undefined ? { x } : {})`. Never widen Core types when an edge adapter suffices.
- **No secret in any error/log/InitOutcome detail** (redaction). The bot's turn-error path slices `err.message` to 200 chars — do not add provider keys to any thrown message.
- **A scoped grant may suppress only a tier-2 `ask`, never a `deny`; tier-3 is never grantable.** (Untouched here — the loop's gate logic is not modified.)
- **The opaque-bytes 3-tier router (`provider/types.ts`) stays untouched** — the catalog has its own id-space (ADR-0050).
- **Surgical changes:** every changed line traces to #4/#5/#6. Do not "improve" adjacent code. Match existing style (conditional spreads, ASCII-comment headers, Russian UX copy).
- **TDD, frequent commits.** Each task ends green: `pnpm -r build` + `pnpm -r test`.

---

### Task 1: Loop control seams — abort + mid-turn budget (core)

Adds the two optional seams to the agent-loop types and wires them into the loop. Both edit the same two files, so they ship as one reviewer-gated deliverable.

**Files:**
- Modify: `packages/core-ts/src/agent-loop/types.ts` (`TurnInput`, `TurnState`, `TurnResult.haltReason`, `ProviderAdapter.complete`, `AgentLoopDeps`)
- Modify: `packages/core-ts/src/agent-loop/index.ts` (`callModel`, `dispatch`)
- Test: `packages/core-ts/src/agent-loop/agent-loop.spec.ts`

**Interfaces:**
- Produces:
  - `TurnInput.signal?: AbortSignal`
  - `ProviderAdapter.complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>`
  - `AgentLoopDeps.budgetCheck?: (usage: { sessionId: string; inputTokens: number; outputTokens: number; dollars: number }) => boolean | Promise<boolean>`
  - `HaltReason` (and `TurnResult.haltReason`, `TurnState` halted reason) gains `"budget-capped" | "stopped"`
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core-ts/src/agent-loop/agent-loop.spec.ts`. First add an abort-aware provider fake near the other fakes (after `makeAllDownProvider`, ~line 141):

```ts
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
```

Then add a `describe` block (anywhere among the existing top-level describes):

```ts
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
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @aisy/core test -- agent-loop.spec`
Expected: FAIL — `budgetCheck` not assignable to `AgentLoopDeps`, `signal` not on `TurnInput`, `haltReason` not `'stopped' | 'budget-capped'`.

- [ ] **Step 3: Extend the types**

In `packages/core-ts/src/agent-loop/types.ts`:

Add `signal` to `TurnInput` (after `approvalToken`):
```ts
export interface TurnInput {
  sessionId: string
  spans: ContextSpan[]
  /** Optional approval token for Tier-3 plans (AC-01-17) */
  approvalToken?: string
  /** Per-turn cancellation (ADR-0051): /stop aborts the in-flight turn. The loop
   *  maps an abort to a clean Halt('stopped'), never an error. */
  signal?: AbortSignal
}
```

Extend the `TurnState` halted reason (keep it in sync with `TurnResult.haltReason`):
```ts
  | { status: "halted"; reason: "loop-guardian" | "all-providers-down" | "plan-lint-failed" | "cap-exceeded" | "budget-capped" | "stopped" }
```

Extend `TurnResult.haltReason`:
```ts
  haltReason?: "loop-guardian" | "all-providers-down" | "plan-lint-failed" | "cap-exceeded" | "budget-capped" | "stopped"
```

Extend `ProviderAdapter`:
```ts
export interface ProviderAdapter {
  complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>
}
```

Add `budgetCheck` to `AgentLoopDeps` (after `executeTool`):
```ts
  /** Post-model-call budget probe (ADR-0051): given the turn's running usage,
   *  return true to halt the turn with budget-capped. Default: never halts. */
  budgetCheck?: (usage: {
    sessionId: string
    inputTokens: number
    outputTokens: number
    dollars: number
  }) => boolean | Promise<boolean>
```

- [ ] **Step 4: Wire the loop**

In `packages/core-ts/src/agent-loop/index.ts`, replace the `callModel` body (lines ~228–250) with:

```ts
      const callModel = async (): Promise<ModelResponse> => {
        // Eng-7 durability: the recorded intent is fsync'd BEFORE the dispatch.
        log('step.intent', { kind: 'model-call' })
        try {
          const r = await deps.provider.complete(
            {
              sessionId: input.sessionId,
              prefixBytes: snapshot.prefixBytes,
              spans: input.spans,
            },
            input.signal,
          )
          if (r.usage) {
            usageIn += r.usage.inputTokens
            usageOut += r.usage.outputTokens
            usageDollars += r.usage.dollars
          }
          // ADR-0051 mid-turn budget: consult the injected probe with the turn's
          // running usage; a positive verdict halts before any further dispatch.
          if (deps.budgetCheck) {
            const capped = await deps.budgetCheck({
              sessionId: input.sessionId,
              inputTokens: usageIn,
              outputTokens: usageOut,
              dollars: usageDollars,
            })
            if (capped) throw new Halt('budget-capped')
          }
          return r
        } catch (err) {
          // A Halt raised in the try (budget) is control flow, not an error — re-throw as-is.
          if (err instanceof Halt) throw err
          // A /stop abort surfaces as a fetch/spawn rejection; map it to a clean
          // halt so the transport stays quiet (the /stop handler already acked).
          if (input.signal?.aborted) throw new Halt('stopped')
          if ((err as Partial<ProviderError>).kind === 'all-exhausted') {
            log('provider.exhausted', {})
            throw new Halt('all-providers-down')
          }
          throw err
        }
      }
```

In the same file, add an early abort check at the top of `dispatch` (right after `const dispatch = async (call: ToolCall): Promise<void> => {`, before `s.totalToolCalls++`):

```ts
        // ADR-0051: /stop interrupts between tool calls too, not only at model calls.
        if (input.signal?.aborted) throw new Halt('stopped')
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @aisy/core test -- agent-loop.spec`
Expected: PASS — all existing tests plus the 5 new ones. (Existing provider fakes with a 1-arg `complete` stay assignable: a function taking fewer params satisfies a wider signature.)

- [ ] **Step 6: Build the package**

Run: `pnpm --filter @aisy/core build`
Expected: clean tsc (no `exactOptionalPropertyTypes` violations — `signal`/`budgetCheck` are only read, never assigned `undefined`).

- [ ] **Step 7: Commit**

```bash
git add packages/core-ts/src/agent-loop/types.ts packages/core-ts/src/agent-loop/index.ts packages/core-ts/src/agent-loop/agent-loop.spec.ts
git commit -F - <<'EOF'
feat(agent-loop): add abort + mid-turn budget seams (Tier2 #4/#5)

TurnInput.signal threads an AbortSignal to provider.complete; an abort
maps to a clean Halt('stopped'). budgetCheck() probes running usage after
each model call and halts with Halt('budget-capped'). Both seams optional.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 2: Provider adapters honor the abort signal

Threads `signal` into all three adapters and the tiered wrapper, merging with each adapter's existing timeout.

**Files:**
- Modify: `packages/core-ts/src/runtime/provider-anthropic.ts` (`complete`)
- Modify: `packages/core-ts/src/runtime/provider-openai.ts` (`complete`)
- Modify: `packages/core-ts/src/runtime/provider-cli.ts` (`CliProviderDeps.run`, `defaultRun`, `complete`)
- Modify: `packages/core-ts/src/runtime/providers.ts` (`makeTieredProvider`)
- Test: `packages/core-ts/src/runtime/provider-anthropic.spec.ts`, `provider-openai.spec.ts`, `provider-cli.spec.ts`, `providers.spec.ts`

**Interfaces:**
- Consumes: `ProviderAdapter.complete(req, signal?)` (Task 1).
- Produces: all adapters forward an external `AbortSignal`; `makeCliProvider`'s injectable `run` gains a 3rd `signal?` param.

- [ ] **Step 1: Write the failing tests**

In `provider-anthropic.spec.ts`, add (mirror the file's existing injected-`fetchImpl` pattern; this asserts the composite signal reflects the external abort):

```ts
it('threads an external abort signal into the fetch (composite with timeout)', async () => {
  let seen: AbortSignal | undefined
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen = init?.signal ?? undefined
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }), { status: 200 })
  }) as unknown as typeof fetch
  const controller = new AbortController()
  const p = makeAnthropicProvider({ apiKey: 'k', model: 'claude-sonnet-4-6', fetchImpl })
  await p.complete(
    { sessionId: 's', prefixBytes: new Uint8Array(0), spans: [{ role: 'user', provenance: 'operator', text: 'hi' }] },
    controller.signal,
  )
  expect(seen).toBeInstanceOf(AbortSignal)
  expect(seen!.aborted).toBe(false)
  controller.abort()
  expect(seen!.aborted).toBe(true)
})
```

In `provider-openai.spec.ts`, add the analogous test (note OpenAI body shape + `baseUrl`):

```ts
it('threads an external abort signal into the fetch (composite with timeout)', async () => {
  let seen: AbortSignal | undefined
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen = init?.signal ?? undefined
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 })
  }) as unknown as typeof fetch
  const controller = new AbortController()
  const p = makeOpenAICompatProvider({ apiKey: 'k', model: 'gpt-4o', baseUrl: 'https://x/v1', fetchImpl })
  await p.complete(
    { sessionId: 's', prefixBytes: new Uint8Array(0), spans: [{ role: 'user', provenance: 'operator', text: 'hi' }] },
    controller.signal,
  )
  expect(seen).toBeInstanceOf(AbortSignal)
  controller.abort()
  expect(seen!.aborted).toBe(true)
})
```

In `provider-cli.spec.ts`, add:

```ts
it('forwards the abort signal to the injected run', async () => {
  let seen: AbortSignal | undefined
  const p = makeCliProvider({
    command: ['claude', '-p'],
    run: async (_argv, _input, signal) => { seen = signal; return { stdout: 'hi', exitCode: 0 } },
  })
  const controller = new AbortController()
  await p.complete({ sessionId: 's', prefixBytes: new Uint8Array(0), spans: [] }, controller.signal)
  expect(seen).toBe(controller.signal)
})
```

In `providers.spec.ts`, add:

```ts
it('makeTieredProvider forwards the abort signal to the delegated tier adapter', async () => {
  let seen: AbortSignal | undefined
  const adapter: ProviderAdapter = { async complete(_req, signal) { seen = signal; return { reply: 'ok' } } }
  const tiered = makeTieredProvider({ reasoning: adapter, critique: adapter, routine: adapter })
  const controller = new AbortController()
  await tiered.complete({ sessionId: 's', prefixBytes: new Uint8Array(0), spans: [] }, controller.signal)
  expect(seen).toBe(controller.signal)
})
```

(If `providers.spec.ts` does not import `ProviderAdapter`, add it to the existing type import from `'../agent-loop/types.js'`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @aisy/core test -- provider-anthropic.spec provider-openai.spec provider-cli.spec providers.spec`
Expected: FAIL — `complete` rejects the 2nd arg / `run` rejects the 3rd arg; external abort not reflected.

- [ ] **Step 3: Implement — Anthropic**

In `provider-anthropic.ts`, change the `complete` signature and merge the signal. Replace the signature line and the `signal:` line:

```ts
    async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
```

and, where the fetch is issued, replace `signal: AbortSignal.timeout(timeoutMs),` with:

```ts
          signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
```

- [ ] **Step 4: Implement — OpenAI-compat**

In `provider-openai.ts`, the identical change: signature →

```ts
    async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
```

and replace `signal: AbortSignal.timeout(timeoutMs),` with:

```ts
          signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
```

- [ ] **Step 5: Implement — CLI**

In `provider-cli.ts`:

Extend `CliProviderDeps.run`:
```ts
  /** Run argv with `input` on stdin → stdout/exit. Injected for tests. */
  run?: (argv: string[], input: string, signal?: AbortSignal) => Promise<CliRunResult>
```

Replace `defaultRun` so it kills the child on abort:
```ts
function defaultRun(timeoutMs: number): (argv: string[], input: string, signal?: AbortSignal) => Promise<CliRunResult> {
  return (argv, input, signal) =>
    new Promise<CliRunResult>((resolve, reject) => {
      const [cmd, ...args] = argv
      if (!cmd) {
        reject(new CliError('server-error', 'empty CLI command'))
        return
      }
      const child = spawn(cmd, args, { timeout: timeoutMs })
      const onAbort = (): void => { child.kill() }
      if (signal) {
        if (signal.aborted) child.kill()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      let stdout = ''
      child.stdout.on('data', (d) => (stdout += String(d)))
      child.on('error', (e) => {
        if (signal) signal.removeEventListener('abort', onAbort)
        reject(new CliError('server-error', `CLI spawn failed: ${e.message}`))
      })
      child.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve({ stdout, exitCode: code ?? 0 })
      })
      child.stdin.end(input)
    })
}
```

Change `complete` to accept and forward the signal:
```ts
    async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      const prefix = req.prefixBytes.byteLength > 0 ? Buffer.from(req.prefixBytes).toString('utf8') : ''
      const prompt = promptFromSpans(req.spans, prefix)
      const r = await run(argv, prompt, signal)
      if (r.exitCode !== 0) {
        throw new CliError('server-error', `CLI exited ${r.exitCode}`)
      }
      return { reply: r.stdout.trim() }
    },
```

- [ ] **Step 6: Implement — tiered wrapper**

In `providers.ts`, replace the `makeTieredProvider` return with:
```ts
  return {
    complete: (req, signal) => byTier[pick(req)].complete(req, signal),
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @aisy/core test -- provider-anthropic.spec provider-openai.spec provider-cli.spec providers.spec`
Expected: PASS (new + existing).

- [ ] **Step 8: Build + full core test**

Run: `pnpm --filter @aisy/core build && pnpm --filter @aisy/core test`
Expected: clean build, all green.

- [ ] **Step 9: Commit**

```bash
git add packages/core-ts/src/runtime/provider-anthropic.ts packages/core-ts/src/runtime/provider-openai.ts packages/core-ts/src/runtime/provider-cli.ts packages/core-ts/src/runtime/providers.ts packages/core-ts/src/runtime/provider-anthropic.spec.ts packages/core-ts/src/runtime/provider-openai.spec.ts packages/core-ts/src/runtime/provider-cli.spec.ts packages/core-ts/src/runtime/providers.spec.ts
git commit -F - <<'EOF'
feat(providers): honor external AbortSignal in all adapters (Tier2 #4)

Anthropic/OpenAI merge the external signal with their timeout via
AbortSignal.any; the CLI adapter kills the child on abort; makeTieredProvider
forwards the signal to the delegated tier.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 3: Runner passes `budgetCheck` through to the loop

The abort signal needs no runner change (it rides in `TurnInput`, which `handle` forwards verbatim). Only `budgetCheck` needs a passthrough.

**Files:**
- Modify: `packages/core-ts/src/runtime/agent-runner.ts` (`AgentRunnerDeps`, loop construction)
- Test: `packages/core-ts/src/runtime/agent-runner.spec.ts`

**Interfaces:**
- Consumes: `AgentLoopDeps.budgetCheck` (Task 1).
- Produces: `AgentRunnerDeps.budgetCheck?` with the same signature; forwarded to the loop.

- [ ] **Step 1: Write the failing test**

Add to `packages/core-ts/src/runtime/agent-runner.spec.ts` a self-contained test (build deps inline so it does not depend on private helpers — match the file's import of `makeAgentRunner` and types):

```ts
it('forwards budgetCheck to the loop (halts with budget-capped)', async () => {
  const provider: ProviderAdapter = {
    async complete() { return { reply: 'hi', usage: { inputTokens: 10, outputTokens: 5, dollars: 1 } } },
  }
  const runner = makeAgentRunner({
    provider,
    memory: { async snapshot() { return { prefixBytes: new Uint8Array(0), prefixHash: 'h', breakpoints: [], takenAt: '2026-01-01T00:00:00.000Z' } }, async forget() {} },
    grants: makeGrantStore({ persistence: { loadAlways: () => [], saveAlways: () => {} } }),
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
```

Ensure the spec imports `ProviderAdapter` (from `'../agent-loop/types.js'`), `makeGrantStore` (from `'../safety/index.js'`), and `makeGuardian` (from wherever the file already sources it; if not present, import from `'./guardian.js'` or the package index as the file already does for other tests).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @aisy/core test -- agent-runner.spec`
Expected: FAIL — `budgetCheck` not assignable to `AgentRunnerDeps`.

- [ ] **Step 3: Implement the passthrough**

In `packages/core-ts/src/runtime/agent-runner.ts`, add to `AgentRunnerDeps` (after `maxTotalToolCalls?`):
```ts
  /** Mid-turn budget probe forwarded to the loop (ADR-0051). */
  budgetCheck?: (usage: {
    sessionId: string
    inputTokens: number
    outputTokens: number
    dollars: number
  }) => boolean | Promise<boolean>
```

In the `makeAgentLoop({ ... })` call, add (after the `maxTotalToolCalls` conditional spread):
```ts
    ...(deps.budgetCheck !== undefined ? { budgetCheck: deps.budgetCheck } : {}),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @aisy/core test -- agent-runner.spec`
Expected: PASS.

- [ ] **Step 5: Build + commit**

```bash
pnpm --filter @aisy/core build
git add packages/core-ts/src/runtime/agent-runner.ts packages/core-ts/src/runtime/agent-runner.spec.ts
git commit -F - <<'EOF'
feat(runner): forward budgetCheck to the agent loop (Tier2 #5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 4: App wiring — `/stop` hard-kill + mid-turn budget card

Wires the seams into the live transport. `bot.ts` has no unit-test harness (it is the grammY transport boundary); verification is type-check + build + a documented manual smoke. Keep changes surgical.

**Files:**
- Modify: `packages/app/src/bot.ts` (`runTurn`, `/stop` handler, halted-state handling)
- Modify: `packages/app/src/bin/aisy.ts` (`buildRunner` closure → `budgetCheck`)

**Interfaces:**
- Consumes: `TurnInput.signal` (Task 1), `TurnResult.haltReason` (`'stopped'`/`'budget-capped'`), `AgentRunnerDeps.budgetCheck` (Task 3), existing `deps.budget` (`capFor`/`spentFor`), `deps.settings`, `renderEvent({ kind: 'budget.capped', ... })`.
- Produces: a per-turn `AbortController` the `/stop` command aborts.

- [ ] **Step 1: Add a per-turn abort controller**

In `packages/app/src/bot.ts`, next to the other turn-flow state (after `let pendingOutbound ...`, ~line 107), add:
```ts
  // The in-flight turn's abort controller; /stop fires it for a hard-kill.
  let currentAbort: AbortController | null = null
```

- [ ] **Step 2: Thread the signal + handle the new halts in `runTurn`**

In `runTurn`, after `agentState = 'running'`, create the controller and pass its signal; replace the result-handling branch. The new body of the `try` (replacing lines ~241–256) is:

```ts
    agentState = 'running'
    const abort = new AbortController()
    currentAbort = abort
    try {
      const result = await runner.handle({
        sessionId,
        spans: spans.map((s) => ({ role: 'user', provenance: s.provenance, text: s.text })),
        signal: abort.signal,
      })
      if (result.state === 'halted' && result.haltReason === 'stopped') {
        // Operator /stop already acked ("⏹ Остановлено."); stay silent.
      } else if (result.state === 'halted' && result.haltReason === 'budget-capped') {
        await sendPanel(
          renderEvent({
            kind: 'budget.capped',
            limitUsd: deps.budget?.capFor('main') ?? 0,
            spentUsd: deps.budget?.spentFor('main') ?? 0,
            stepsDone: 0,
            stepsTotal: 0,
          }),
        )
      } else if (result.narrowed === true) {
        await presentOutboundLockout(result.reply)
      } else {
        await sendReply(result.reply)
      }
      if (result.usage) {
        // Record spend always (viewed on demand in 📡 Монитор); only echo a
        // per-turn cost card when the operator opted in (default off — ADR-0050).
        deps.spend?.record({ model: deps.model, usage: result.usage })
        if (deps.settings?.get().showCostPerTurn === true) await sendCostSummary(result.usage)
      }
    } catch (err) {
```

(The `catch` block and `finally` block below are unchanged except for Step 3.)

- [ ] **Step 3: Reset the controller in `finally`**

In `runTurn`'s `finally` (currently `agentState = 'idle'` then the steer-drain), add the controller reset right after `agentState = 'idle'`:
```ts
      agentState = 'idle'
      currentAbort = null
```

- [ ] **Step 4: Make `/stop` hard-kill**

Replace the `/stop` command (lines ~320–325) with:
```ts
  bot.command('stop', async (ctx) => {
    buffered = []
    if (flushTimer) clearTimeout(flushTimer)
    currentAbort?.abort()
    await ctx.reply('⏹ Остановлено.')
  })
```
(Delete the stale `// TODO: /stop should hard-kill ...` comment above it.)

- [ ] **Step 5: Wire `budgetCheck` in `aisy.ts`**

In `packages/app/src/bin/aisy.ts`, replace the `buildRunner` closure (lines ~265–266) with:
```ts
  buildRunner: (approve: (action: PendingAction) => Promise<ApprovalDecision>) =>
    makeAgentRunner({
      provider,
      memory,
      grants,
      executeTool,
      approve,
      guardian: makeGuardian(),
      sessionLog,
      maxTotalToolCalls: 50,
      // Mid-turn budget (ADR-0051): when enforcement is on and this turn's
      // running spend would cross the main agent's cap, halt the turn.
      budgetCheck: (usage) => {
        if (settings.get().budgetEnabled !== true) return false
        const cap = budget.capFor('main')
        if (cap <= 0) return false
        return budget.spentFor('main') + usage.dollars >= cap
      },
    }),
```

- [ ] **Step 6: Build the whole workspace**

Run: `pnpm -r build`
Expected: all three packages compile clean. (`bot.ts` now references `result.haltReason`/`signal`, both exported from `@aisy/core` via the agent-loop types.)

- [ ] **Step 7: Manual smoke (documented, not automated)**

Record in the commit body that the following were checked locally if a bot token is configured, else mark as deferred to integration:
- Start a long turn, send `/stop` → bot replies "⏹ Остановлено." and the in-flight turn does not later post a reply.
- Enable budget (⚙️ Настройки → Бюджет) with a tiny `AISY_BUDGET_USD`, run a turn that exceeds it → the `budget.capped` card appears with spent/cap; "Продолжить" lifts the gate.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/bot.ts packages/app/src/bin/aisy.ts
git commit -F - <<'EOF'
feat(app): wire /stop hard-kill + mid-turn budget card (Tier2 #4/#5)

bot.ts threads a per-turn AbortController into runner.handle and fires it on
/stop; a 'stopped' halt stays silent, a 'budget-capped' halt renders the
budget.capped card. aisy.ts builds the budgetCheck probe over settings+budget.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 5: #6 outbound-lockout — wire the live lockout source

The core egress guard is already proven: `gateway.streamReply` throws `OutboundBlocked` when `isOutboundLocked()` is true, re-checks per token, and fails closed when Safety is unavailable (tested at `gateway/gateway.spec.ts` AC-02-6, REG-02-D, AC-02-19). The only gap is that the **live binary hardcodes `isOutboundLocked: () => false`** — so that proven guard never actually fires in production. This task makes it truthful by mirroring the loop's live `narrowed` state into the flag the gateway reads, and locks the loop-side source with a regression test. The bot keeps its own reply hold (`presentOutboundLockout`, allow/block) as the primary user-facing UX — a richer interaction than a thrown block — and the now-truthful gateway guard backs any egress that routes through `streamReply`.

**Files:**
- Modify: `packages/app/src/bin/aisy.ts` (live `outboundLocked` flag → `gateway.isOutboundLocked`; pass setter to the bot)
- Modify: `packages/app/src/bot.ts` (`TelegramBotDeps.setOutboundLocked`; set it after each turn; fix the stale header comment)
- Test: `packages/core-ts/src/agent-loop/agent-loop.spec.ts` (loop returns `narrowed` for an untrusted span — only add if no equivalent assertion exists)

**Interfaces:**
- Consumes: `TurnResult.narrowed` (existing); `makeGateway` deps `isOutboundLocked(): boolean` (existing).
- Produces: `TelegramBotDeps.setOutboundLocked?: (locked: boolean) => void`.

- [ ] **Step 1: Confirm or add the loop regression test (the lockout source)**

Search the spec for an existing `narrowed` return assertion:

Run: `grep -n "narrowed" packages/core-ts/src/agent-loop/agent-loop.spec.ts`

If an existing test already asserts `result.narrowed === true` for an untrusted-span turn, skip to Step 2. Otherwise add:

```ts
it('#6: a turn with an untrusted span returns narrowed (feeds the outbound-lockout source)', async () => {
  const loop = makeAgentLoop(makeDeps())
  const result = await loop.runTurn(makeTurnInput({ spans: [makeUntrustedSpan()] }))
  expect(result.narrowed).toBe(true)
})
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @aisy/core test -- agent-loop.spec`
Expected: PASS.

- [ ] **Step 3: Add the live lockout flag in `aisy.ts`**

In `packages/app/src/bin/aisy.ts`, declare the flag **before** the `makeGateway(...)` call (it is constructed ~line 207):

```ts
// Live outbound-lockout source (ADR-0051): mirrors the loop's narrowed state so
// the gateway egress guard (streamReply) is truthful in the live binary, not a
// hardcoded false. The bot updates it after each turn from TurnResult.narrowed.
let outboundLocked = false
```

In the `makeGateway({ ... })` call, replace `isOutboundLocked: () => false,` with:
```ts
  isOutboundLocked: () => outboundLocked,
```

In the `makeTelegramBot({ ... })` call, add the setter (alongside `settings`, `spend`, `budget`):
```ts
  setOutboundLocked: (locked) => { outboundLocked = locked },
```

- [ ] **Step 4: Accept + apply the flag in `bot.ts`**

In `packages/app/src/bot.ts`, add to `TelegramBotDeps` (after `budget?`):
```ts
  /** Mirror the loop's narrowed state to the gateway egress guard (ADR-0051). */
  setOutboundLocked?: (locked: boolean) => void
```

In `runTurn`, immediately after `const result = await runner.handle({ ... })` (before the halted/narrowed branch added in Task 4), add:
```ts
      // Keep the gateway egress lockout truthful: this turn's narrowed verdict
      // is the live outbound-lockout state (self-clears on a clean operator turn).
      deps.setOutboundLocked?.(result.narrowed === true)
```

Replace the stale header block (lines ~7–9) — it claims outbound-lockout is "Not yet wired", which is now false:
```ts
// Outbound lockout is live: a turn that ran with untrusted context returns
// narrowed=true; the reply is held here behind an allow/block tap
// (presentOutboundLockout, ADR-0048) AND the narrowed verdict is mirrored to the
// gateway's egress guard via setOutboundLocked, so streamReply fails closed while
// narrowed (ADR-0051). Still deferred: streaming partial replies and a push-style
// alert stream for budget/cost events.
```

- [ ] **Step 5: Build the whole workspace**

Run: `pnpm -r build && pnpm -r test`
Expected: all three packages compile; all tests green (core egress-lockout tests already cover the guard; no new core test needed beyond the loop source).

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/bin/aisy.ts packages/app/src/bot.ts packages/core-ts/src/agent-loop/agent-loop.spec.ts
git commit -F - <<'EOF'
feat(app): make outbound-lockout live — mirror narrowed to gateway guard (Tier2 #6)

isOutboundLocked now reflects the loop's live narrowed state instead of a
hardcoded false, so the (already-tested) streamReply egress guard fails closed
in production. The bot retains its allow/block reply hold as the primary UX.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 6: ADR-0051 + roadmap update

Records the loop-contract change (the consequential decision) and marks Tier 2 done.

**Files:**
- Create: `docs/decisions/2026-06-17-loop-control-abort-and-mid-turn-budget.md`
- Modify: `docs/decisions/INDEX.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Write ADR-0051**

Create `docs/decisions/2026-06-17-loop-control-abort-and-mid-turn-budget.md`:

```markdown
# ADR-0051: Loop control seams — turn abort and mid-turn budget

- Status: Accepted
- Date: 2026-06-17
- Supersedes: —
- Related: ADR-0050 (multi-provider catalog + per-agent budget), ADR-0048 (transport/outbound), ADR-0026 (loop discipline)

## Context

The agent loop (`makeAgentLoop`) was non-interruptible mid-turn and enforced
budget only at turn entry (the transport's pre-turn gate). The operator needs
phone-side control: `/stop` must hard-kill an in-flight turn, and an enabled
per-agent budget must halt a turn the moment its accumulated spend crosses the
cap — not only refuse the next turn. The loop is the most safety-critical,
most-tested module, so the change must be additive and not alter any existing
halt/gate semantics.

## Decision

Two **optional** seams, threaded through the existing injection chain:

1. **Turn abort.** `TurnInput.signal?: AbortSignal` rides through `runner.handle`
   (which forwards `input` verbatim) into the loop. `ProviderAdapter.complete`
   gains an optional 2nd `signal?` parameter; each adapter merges it with its own
   timeout via `AbortSignal.any` (the CLI adapter kills its child). An abort is
   mapped to a clean `Halt('stopped')` at the loop boundary — never an error —
   and the loop also checks the signal between tool dispatches. The transport owns
   a per-turn `AbortController` and fires it on `/stop`.

2. **Mid-turn budget.** `AgentLoopDeps.budgetCheck?(usage)` is consulted after each
   model call with the turn's running usage; a positive verdict throws
   `Halt('budget-capped')`. The probe is wired in `aisy.ts`, closing over the
   existing settings + budget stores, so the loop stays pure. The transport renders
   the existing `budget.capped` card.

`HaltReason` (hence `TurnResult.haltReason` and `TurnState` halted) gains
`"stopped"` and `"budget-capped"`.

**Outbound lockout (#6):** the gateway's egress guard (`streamReply` throws
`OutboundBlocked` while locked, re-checks per token, fails closed when Safety is
unavailable) was already implemented and tested (AC-02-6, REG-02-D, AC-02-19) but
the live binary hardcoded `isOutboundLocked: () => false`, so it never fired in
production. It is now wired to the live narrowed state: the bot mirrors each
turn's `TurnResult.narrowed` into the flag the gateway reads (`setOutboundLocked`),
so the proven guard is truthful in production and self-clears on a clean operator
turn. The bot also retains its own reply hold behind an allow/block tap
(`presentOutboundLockout`) as the primary user-facing UX — a richer interaction
than a thrown block — so the lockout has both a transport-layer hold and a
truthful gateway-egress guard.

## Consequences

- **Positive:** `/stop` is a real hard-kill; budget enforcement is mid-turn, not
  just turn-gated. Both seams are optional — every existing caller and test is
  unaffected (a 1-arg `complete` stays assignable to the 2-arg signature; absent
  `signal`/`budgetCheck` = today's behavior). No safety gate or grant rule changed.
- **Negative / trade-offs:** `ProviderAdapter.complete` signature widened (all
  adapters updated). Abort granularity is per-model-call and per-dispatch, not
  truly preemptive inside a running tool. `budgetCheck` sees the in-flight turn's
  usage plus ledger spend, so the cap is enforced approximately at the call that
  crosses it (the crossing call's tokens are already spent).
- **Follow-ups:** the bot mirrors `result.narrowed` into `isOutboundLocked` after
  the turn, so the gateway flag trails the in-turn state by one turn — acceptable
  because the bot's own reply hold uses the fresh `result.narrowed` and the gateway
  egress is not the bot's reply path. If `streamReply` ever becomes the reply path,
  source the flag from the loop's live session state instead of the post-turn mirror.

## Alternatives considered

- **Construction-time abort dep on the runner.** Rejected: the bot builds the
  runner once but needs a fresh controller per turn; a per-turn `TurnInput.signal`
  is the natural carrier and needs no runner signature change.
- **Budget enforced by wrapping the provider adapter.** Rejected: the adapter
  lacks per-agent/turn context and the settings store; the loop is where usage
  accumulates, so the probe belongs there.
- **A dedicated options bag `complete(req, opts)`.** Deferred (YAGNI): a single
  optional `signal?` is the only per-call cross-cutting concern today.
```

- [ ] **Step 2: Prepend ADR-0051 to `docs/decisions/INDEX.md`**

Read the INDEX, add a row at the top of the table (latest first), matching the existing column format, e.g.:
```
| [ADR-0051](2026-06-17-loop-control-abort-and-mid-turn-budget.md) | Loop control seams — turn abort & mid-turn budget | Accepted | 2026-06-17 |
```
(Match the actual column headers/order already in the file.)

- [ ] **Step 3: Mark Tier 2 done in `docs/ROADMAP.md`**

In the Tier 2 table, append a Status column entry (or inline ✅) for #4, #5, #6 noting the shipping commits, and add a line under the table:
```
→ **Plan:** [`docs/superpowers/plans/2026-06-17-tier2-loop-control.md`](./superpowers/plans/2026-06-17-tier2-loop-control.md) — #4/#5 via ADR-0051 loop seams; #6 wires the live `isOutboundLocked` source (bot mirrors `narrowed` → gateway egress guard) on top of the existing transport-layer hold. #7 (voice) split to its own plan.
```

- [ ] **Step 4: Commit**

```bash
git add docs/decisions/2026-06-17-loop-control-abort-and-mid-turn-budget.md docs/decisions/INDEX.md docs/ROADMAP.md
git commit -F - <<'EOF'
docs(adr): ADR-0051 loop control seams; mark Tier 2 done

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Self-Review

**Spec coverage (vs ROADMAP Tier 2):**
- #4 `/stop` hard-kill — Tasks 1 (loop abort → `Halt('stopped')`), 2 (adapters honor signal), 4 (bot AbortController + `/stop`). ✅
- #4b — already done (`be837ee`); residual (error-detail redaction) is out of this plan's scope and is noted in ROADMAP, not regressed here. ✅
- #5 mid-turn budget — Tasks 1 (`budgetCheck` → `Halt('budget-capped')`), 3 (runner passthrough), 4 (aisy.ts probe + bot card). ✅
- #6 outbound-lockout — Task 5 (wire live `isOutboundLocked` from `narrowed`; loop-source test + comment-fix). The core egress guard was already tested; this makes it truthful in the live binary. ✅
- #7 voice — explicitly split to its own plan (separate subsystem: Whisper sidecar). Noted in Task 6 ROADMAP edit. ✅

**Placeholder scan:** every code step shows full code; no TBD/TODO left in product code (the only TODO removed is the stale `/stop` one). The `AISY_BUDGET_USD` smoke (Task 4 Step 7) is a documented manual check, not a code placeholder.

**Type consistency:** `budgetCheck` signature is identical in `AgentLoopDeps` (Task 1), `AgentRunnerDeps` (Task 3), and the `aisy.ts` closure (Task 4). `signal?: AbortSignal` is consistent on `TurnInput` and as the 2nd param of `complete` across all adapters + tiered wrapper. `HaltReason` additions (`'stopped'`, `'budget-capped'`) are applied to both `TurnState` halted and `TurnResult.haltReason`. `capFor`/`spentFor`/`over` match the `BudgetTracker` API used at `bot.ts:228`.

**Risk control:** all seams optional → existing 658 core + 89 telegram-gw tests stay green; the loop's halt/gate/grant logic is untouched; the consequential loop-contract change is captured in ADR-0051 (Task 6).
