# Tier 4 — Proactivity: Nightly Consolidation + Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the harness's two built-but-dormant proactivity components live in `aisy run`: (#9) nightly memory consolidation — a scheduled pipeline that proposes durable memory edits into a human-approved morning staging gate; and (#10) triggers — operator/agent reminders, schedules, and watches that wake a budget-capped agent turn. Both run on a shared in-process scheduler with missed-slot catch-up; both emit to a durable journal.

**Architecture.** A new **in-process scheduler** (a `setInterval` loop started alongside `bot.start()`) ticks every minute: it runs `TriggerEngine.tick()` and checks whether the nightly cron slot is due (with a persisted last-run marker for idempotency + startup catch-up). The agent loop and Core types are untouched. New work splits into four layers:
1. **Shared infra:** a durable JSONL **journal sink** (replaces the memory `emitEvent` no-op; fed by memory/nightly/triggers), the **scheduler**, and a **bot proactive seam** (`makeTelegramBot` returns `{ bot, runProactiveTurn, sendProactive }` so a background job can inject a turn / send a message).
2. **Memory + nightly adapters:** a new `Memory.listLive()` enumerate API (the consolidation generator needs the live fact set), a file-based **RunLock**, deterministic **Validators**, a nightly↔memory **type bridge** + promotion effect seams (`memoryTxn`/`reindex` → `memory.commit`/`memory.reindex`), and the **LLM Generator/Judge** adapters (the generator proposes `MemOp`s from the day log as strict JSON; the judge — a different tier — grades the diff).
3. **Nightly live:** construct `makeConsolidationRunner` in `aisy.ts`, drive it from the scheduler, issue the `MorningCard` via `gateway.issueCard`, route a morning-card tap to `approveStagedItem`, and wire the `/consolidate` command.
4. **Triggers live:** a JSONL `TriggerStore`, a deterministic `probeRunner`, construct `makeTriggerEngine`, wire `startTurn` → the bot proactive turn, `/remind` `/schedule` `/watch` commands, and agent-created-trigger confirmation via a card → `trigger.confirm`.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, Node16 ESM, `.js` import extensions), vitest, better-sqlite3 (already used by memory), grammY transport. No new runtime deps.

## Global Constraints

- **License Apache-2.0.** No GPL/AGPL deps. No new runtime deps in this plan.
- **Brand always "Aisy", affirmative only.** Never "never X".
- **`research/` is gitignored — never reference it in any committed/public file.**
- **TS strict + `exactOptionalPropertyTypes`:** never pass `undefined` to an optional prop — conditional spread `...(x !== undefined ? { x } : {})`. `noUncheckedIndexedAccess`: guard array/Map index access.
- **Staging discipline (nightly):** NOTHING is promoted to live memory until the operator taps Approve on the morning card. The runner stages to disk; `approveStagedItem(id)` is the SOLE promotion path; it re-runs the resurrection-guard + a TOCTOU hash check. The model (generator/judge) NEVER sets `is_human_confirmed`.
- **Two-phase trigger budget (ADR-0038):** phase 1 (due/cron/probe check) is deterministic and costs ~0 model tokens; phase 2 (the woken turn) is gated by BOTH the per-trigger budget AND a shared `globalBackgroundBudget`. A budget-exhausted trigger is paused and reported once, never silently retried.
- **A trigger-woken turn is a normal agent turn:** it runs through the same runner + safety gates (tier-2/3 approvals, narrowing, grants). Watched content is stamped `untrusted` provenance by code. A proactive turn that calls an irreversible tool still raises an approval card.
- **No secret in any journal entry, observation, MorningCard, or trigger payload** (redaction). Provider keys never leave the adapter closures.
- **The opaque-bytes 3-tier router (`provider/types.ts`) stays untouched.** The nightly generator/judge use the catalog adapters (ADR-0050), not the router.
- **Surgical changes:** every changed line traces to Tier-4. Match existing style (conditional spreads, ASCII-comment headers, Russian UX copy).
- **TDD, frequent commits.** Each task ends green: `pnpm -r build` + `pnpm -r test`. Existing 703 core + 89 telegram-gw tests stay green.

## Exact existing shapes this plan builds on (reference — verbatim from the codebase)

**Memory** (`memory/types.ts`, `memory/index.ts`): `Memory` interface methods — `search(query,opts)`, `readFrozenSnapshot()`, `commit(op: MemoryOp, ctx:{withinSession:boolean}): Promise<CommitResult>`, `forget(factId,reason,humanConfirmed)`, `reindex(scope:'all'|{ids:string[]})`, `rebuildFromFiles()`. `MemoryFact { id; text; factKey: FactKey; invalidAt: string|null; supersedes?; ... }`. `FactKey = string`. Read path is forget-filtered (`invalid_at IS NULL AND id NOT IN do_not_remember`). **No enumerate method exists — Task B1 adds `listLive()`.**

**Nightly** (`nightly/types.ts`, `nightly/index.ts`): `makeConsolidationRunner(deps: ConsolidationDeps): ConsolidationRunner`. `ConsolidationRunner { run(config: NightlyConfig): Promise<NightResult>; runLintPass(): Promise<LintPassResult>; getStagedProposals(): Promise<StagingArea>; approveStagedItem(id: string): Promise<void> }`. `ConsolidationDeps { clock:{now():Date}; generator: Generator; judge: Judge; validators: Validators; lock: RunLock; ...optional effect seams: rawDayLog?, isForgotten?, facts?: Fact[], tombstones?, guardAvailable?, onGuardCheck?, archive?, memoryTxn?(apply), reindex?(factId), currentBodyForPatch?(id,body), onDelete?, git?, hygiene?, traceProbe?, envContext?, lintInputs?, journal?, stagingWrite?, emit?(event) }`. `Generator { proposeMemoryOps(log: NormalizedDayLog, liveFacts: Fact[]): Promise<{ops: MemOp[]; diff: Diff}>; draftSkills(log): Promise<SkillDraft[]> }`. `Judge { grade(quarantinedDiff: QuarantinedDiff): Promise<JudgeVerdict> }`. `Validators { check(candidate: MemOp|SkillDraft): ValidatorResult }`. `RunLock { acquire(): {ok:true;token:LockToken}|{ok:false;heldBy:LockToken;heldForMs:number}; release(token) }`. `MemOp = {kind:'ADD';factKey;text} | {kind:'UPDATE';factId;factKey;text} | {kind:'DELETE';factId;reason} | {kind:'NOOP';factId}`. `NightlyConfig { runAt; maxHeldMs; lintStaleDays; backupRemote; stagingDir; archiveDir }`. `NightResult { runDate; stagesCompleted; card: MorningCard; lockToken }`. `MorningCard { runDate; memoryEdits: MorningCardItem[]; triedToResurrect; skillChanges; lintReport; hygieneReport; backupStatus; verificationMisses; cost{...} }`. **Not exported from the `@aisy/core` barrel — Task E adds it.**

**Triggers** (`triggers/types.ts`, `triggers/index.ts`): `makeTriggerEngine(deps: TriggerEngineDeps): TriggerEngine`. `TriggerEngine { register(spec: Omit<TriggerSpec,'confirmed'|'enabled'>): Promise<TriggerSpec>; confirm(id): Promise<void>; cancel(id): Promise<void>; list(): Promise<TriggerSpec[]>; tick(): Promise<TriggerFiring[]> }`. `TriggerEngineDeps { clock: Clock; probeRunner(trace): Promise<boolean>|boolean; startTurn(input:{triggerId;prompt;spans:ContextSpan[];budget:TriggerBudget}): Promise<void>; store: TriggerStore; emitEvent(event,payload); globalBackgroundBudget: TriggerBudget; observe?(trace): Promise<string> }`. `TriggerSpec { id; kind:'remind'|'schedule'|'watch'; createdBy:'operator'|'agent'; confirmed; prompt; fireAt?; cron?; probe?: VerificationTrace; intervalMs?; budget: TriggerBudget; expiresAt?; enabled; firedSlots?: string[] }`. `TriggerStore { load(): Promise<TriggerSpec[]>; save(spec): Promise<void>; remove(id): Promise<void> }`. `TriggerBudget { tokenCeiling; dollarCeiling; tokensSpent; dollarsSpent }`. `TriggerFiring { triggerId; firedAt; phase1; turnStarted }`. **Not exported from the barrel — Task E adds it.**

**Gateway** (`gateway/types.ts`): `issueCard(action: PendingAction): Promise<CardId>`; `getIssuedCard(cardId): IssuedCardView|null`; `handleCardTap(tap: CardTap): Promise<ApprovalResult>`. `PendingAction { actionId; actionHash; tier:0|1|2|3; requiresStepUp; summary }`. `ApprovalResult = {decision:'confirmed';actionId;scope?} | {decision:'rejected';reason}`. The bot already issues/render/resolves cards (`bot.ts` approve closure + `callback_query:data` handler).

**Bot** (`bot.ts`): `makeTelegramBot(deps: TelegramBotDeps): Bot` — currently returns ONLY the grammY `Bot`; internal `runTurn(spans)`, `sendReply(text)`, `runner`, `approve` are closed over. **Task A3 changes the return to expose a proactive seam.**

**Bin** (`bin/aisy.ts`): ends with `const bot = makeTelegramBot({...}); ...; void bot.start()`. Locals in scope: `memoryStore`, `memory`, `gateway`, `approveRef`, `spend`, `budget`, `settings`, `provider`, `adapterFor`, `providersCfg`, `defaultSel`, `nowIso`, `base` (=`~/.aisy`). The nightly lock convention is `~/.aisy/nightly.lock` (from the onboarding-node stub).

**Provider** (`agent-loop/types.ts`): `ProviderAdapter.complete(req: ModelRequest, signal?): Promise<ModelResponse>`; `ModelResponse { reply; toolCalls?; usage? }`. `ContextSpan { role; provenance:'operator'|'untrusted'; text }`.

---

## Phase A — Shared infrastructure

### Task A1: Durable journal sink (replace the memory no-op)

**Files:**
- Create: `packages/app/src/journal.ts` (a tiny JSONL append sink — app-level, like `session-log` wiring)
- Modify: `packages/app/src/bin/aisy.ts` (construct the journal; feed `memoryStore`'s `emitEvent`)
- Test: `packages/app/src/journal.spec.ts` — only if the app package has a test setup; otherwise this is verified by build + the core memory tests (memory already tests its emit contract). (Check `packages/app` for an existing `*.spec.ts`; if none, this module is verified via build and a focused unit test added under `packages/core-ts` is NOT appropriate since it's app-level — instead add the test in app if vitest is configured there, else document as build-verified.)

**Interfaces:**
- Produces:
  ```ts
  export interface JournalSink { append(source: string, kind: string, payload: unknown): void }
  export function makeJsonlJournal(deps: { appendLine: (line: string) => void; nowIso: () => string }): JournalSink
  ```
  `append` writes one JSON line `{ ts, source, kind, payload }`. Payloads carry event names + ids/counts only (no secrets — caller's contract). Fire-and-forget (sync append); never throws into the caller (wrap the write in try/catch, drop on error).

- [ ] **Step 1: Write the failing test** (if app vitest exists; else skip to Step 3 and verify by build)

```ts
import { describe, it, expect } from 'vitest'
import { makeJsonlJournal } from './journal.js'

describe('makeJsonlJournal', () => {
  it('appends one JSON line per event with ts/source/kind/payload', () => {
    const lines: string[] = []
    const j = makeJsonlJournal({ appendLine: (l) => lines.push(l), nowIso: () => '2026-06-22T00:00:00.000Z' })
    j.append('memory', 'memory.committed', { factId: 'f1' })
    expect(lines).toHaveLength(1)
    const e = JSON.parse(lines[0]!)
    expect(e).toEqual({ ts: '2026-06-22T00:00:00.000Z', source: 'memory', kind: 'memory.committed', payload: { factId: 'f1' } })
  })
  it('never throws when the writer fails', () => {
    const j = makeJsonlJournal({ appendLine: () => { throw new Error('disk full') }, nowIso: () => 't' })
    expect(() => j.append('x', 'y', {})).not.toThrow()
  })
})
```

- [ ] **Step 2: Run it** → FAIL (module missing). (If app has no vitest, note it and proceed; Step 6 build is the gate.)

- [ ] **Step 3: Implement** `packages/app/src/journal.ts`:

```ts
// Durable JSONL journal sink (app, Tier-4 observability wiring).
//
// Replaces the memory store's emitEvent no-op and feeds nightly + triggers.
// One JSON line per event; payloads carry ids/counts/event-names only (never
// secrets). Append is best-effort: a write failure is dropped, never thrown
// into the caller (observability must not break a commit or a turn).

export interface JournalSink {
  append(source: string, kind: string, payload: unknown): void
}

export function makeJsonlJournal(deps: { appendLine: (line: string) => void; nowIso: () => string }): JournalSink {
  return {
    append(source, kind, payload) {
      try {
        deps.appendLine(JSON.stringify({ ts: deps.nowIso(), source, kind, payload }))
      } catch {
        // best-effort: never break the caller on a journal write failure
      }
    },
  }
}
```

- [ ] **Step 4: Wire the memory emitter in `aisy.ts`.** Construct the journal near the session-log construction:
```ts
const journalPath = join(base, 'journal.jsonl')
const journal = makeJsonlJournal({
  appendLine: (line) => appendFileSync(journalPath, line + '\n', { encoding: 'utf8', mode: 0o600 }),
  nowIso,
})
```
Replace `makeMemoryStore({ ..., emitEvent: async () => {}, nowIso })` with:
```ts
const memoryStore = makeMemoryStore({
  memoryRoot,
  dbPath,
  emitEvent: async (event, payload) => journal.append('memory', event, payload),
  nowIso,
})
```
(Confirm the memory `emitEvent` signature is `(event: string, payload: unknown) => Promise<void>` — match it; the journal `append` is sync, so wrap in an async arrow.)

- [ ] **Step 5: Run app tests (if any) + Step 6: `pnpm -r build`** clean.

- [ ] **Step 7: Commit**
```bash
git add packages/app/src/journal.ts packages/app/src/bin/aisy.ts packages/app/src/journal.spec.ts 2>/dev/null
git commit -F - <<'EOF'
feat(app): durable JSONL journal sink; wire memory observability (Tier4 A1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task A2: In-process scheduler with missed-slot catch-up

**Files:**
- Create: `packages/app/src/scheduler.ts`
- Test: `packages/app/src/scheduler.spec.ts` (if app vitest exists; the scheduler logic is pure + injectable so it IS unit-testable)

**Interfaces:**
- Produces:
  ```ts
  export interface SchedulerDeps {
    now: () => Date
    /** The local HH:MM the nightly should run at (default '03:30'). */
    nightlyAt: string
    /** Returns the last nightly run date (YYYY-MM-DD) or null. */
    lastNightlyRun: () => string | null
    /** Persist that the nightly ran for this YYYY-MM-DD. */
    markNightlyRun: (date: string) => void
    /** Run the nightly pipeline (idempotent per day; the scheduler gates the call). */
    runNightly: () => Promise<void>
    /** One trigger scan. */
    tickTriggers: () => Promise<void>
    /** Injected timer (setInterval) for tests; default real setInterval. */
    setInterval?: (fn: () => void, ms: number) => unknown
    /** Tick period; default 60_000. */
    tickMs?: number
  }
  export interface Scheduler { start(): void; /** run the due-check once (for tests + startup catch-up) */ pump(): Promise<void> }
  export function makeScheduler(deps: SchedulerDeps): Scheduler
  ```
  Behavior of `pump()` (one cycle): (1) `await tickTriggers()`; (2) compute `today = YYYY-MM-DD` and `hm = HH:MM` from `now()`; if `hm >= nightlyAt` AND `lastNightlyRun() !== today` → `await runNightly()` then `markNightlyRun(today)`. `start()` calls `pump()` once immediately (the **startup catch-up** — if the process boots after `nightlyAt` and today's run is missing, it runs now), then schedules `pump` every `tickMs`. Errors inside `pump` are caught + swallowed (logged via the caller's runNightly/tick) so the loop never dies.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { makeScheduler } from './scheduler.js'

function deps(over = {}) {
  const calls = { nightly: 0, ticks: 0, marked: [] as string[] }
  let last: string | null = null
  return {
    calls,
    d: {
      now: () => new Date('2026-06-22T04:00:00'),  // after 03:30
      nightlyAt: '03:30',
      lastNightlyRun: () => last,
      markNightlyRun: (date: string) => { last = date; calls.marked.push(date) },
      runNightly: async () => { calls.nightly++ },
      tickTriggers: async () => { calls.ticks++ },
      setInterval: (_fn: () => void, _ms: number) => 0,
      ...over,
    },
  }
}

describe('makeScheduler', () => {
  it('pump runs triggers every cycle and the nightly once per day when the slot has passed (catch-up)', async () => {
    const { calls, d } = deps()
    const s = makeScheduler(d)
    await s.pump()
    expect(calls.ticks).toBe(1)
    expect(calls.nightly).toBe(1)          // 04:00 >= 03:30 and not run today → catch-up fires
    await s.pump()
    expect(calls.ticks).toBe(2)
    expect(calls.nightly).toBe(1)          // already marked today → not re-run
  })
  it('does not run the nightly before its slot', async () => {
    const { calls, d } = deps({ now: () => new Date('2026-06-22T02:00:00') }) // before 03:30
    const s = makeScheduler(d)
    await s.pump()
    expect(calls.ticks).toBe(1)
    expect(calls.nightly).toBe(0)
  })
  it('a throwing runNightly does not break the loop (next pump still ticks triggers)', async () => {
    const { calls, d } = deps({ runNightly: async () => { throw new Error('boom') } })
    const s = makeScheduler(d)
    await s.pump()                          // nightly throws, swallowed
    expect(calls.ticks).toBe(1)
    await s.pump()
    expect(calls.ticks).toBe(2)
  })
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `packages/app/src/scheduler.ts` per the Interfaces contract. `pump`:
```ts
  const pump = async (): Promise<void> => {
    try { await deps.tickTriggers() } catch { /* swallow — loop must survive */ }
    try {
      const n = deps.now()
      const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
      const hm = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`
      if (hm >= deps.nightlyAt && deps.lastNightlyRun() !== today) {
        await deps.runNightly()
        deps.markNightlyRun(today)
      }
    } catch { /* swallow */ }
  }
```
`start()`: `void pump(); (deps.setInterval ?? setInterval)(() => { void pump() }, deps.tickMs ?? 60_000)`.

- [ ] **Step 4: Run** → PASS. **Step 5: build clean. Step 6: commit** `feat(app): in-process scheduler with nightly catch-up + trigger tick (Tier4 A2)`.

---

### Task A3: Bot proactive seam (return runProactiveTurn + sendProactive)

**Files:**
- Modify: `packages/app/src/bot.ts` (`makeTelegramBot` return shape)
- Modify: `packages/app/src/bin/aisy.ts` (the `const bot = makeTelegramBot(...)` call site + `void bot.start()`)

**Interfaces:**
- Produces: `makeTelegramBot(deps): { bot: Bot; runProactiveTurn(prompt: string, opts?: { provenance?: Provenance }): Promise<void>; sendProactive(text: string): Promise<void> }`.
  - `runProactiveTurn(prompt, opts)` calls the existing internal `runTurn([{ text: prompt, provenance: opts?.provenance ?? 'operator' }])` (reusing all of runTurn's budget gate, abort, narrowed handling, reply send, spend record). A trigger watch passes `provenance: 'untrusted'`.
  - `sendProactive(text)` calls the existing internal `sendReply(text)` (used to push the nightly MorningCard summary / a reminder text directly).

- [ ] **Step 1: Change the return.** At the end of `makeTelegramBot`, replace `return bot` with:
```ts
  return {
    bot,
    runProactiveTurn: (prompt: string, opts?: { provenance?: Provenance }): Promise<void> =>
      runTurn([{ text: prompt, provenance: opts?.provenance ?? 'operator' }]),
    sendProactive: (text: string): Promise<void> => sendReply(text),
  }
```
(`runTurn` and `sendReply` are already defined in the closure. `Provenance` is already imported.)

- [ ] **Step 2: Update the bin call site.** In `aisy.ts`, change `const bot = makeTelegramBot({...})` → `const { bot, runProactiveTurn, sendProactive } = makeTelegramBot({...})`, and keep `void bot.start()`. `runProactiveTurn`/`sendProactive` are now in scope for the scheduler wiring (Phases C/D).

- [ ] **Step 3: `pnpm -r build`** — all 3 packages compile (the bin destructures the new return). No behavior change yet (nothing calls the proactive methods until Phases C/D). **Step 4: commit** `feat(app): expose bot proactive seam (runProactiveTurn/sendProactive) (Tier4 A3)`.

(bot.ts has no unit harness; this is build-verified. Manual smoke deferred — the proactive methods are exercised by Phases C/D.)

---

## Phase B — Memory enumerate + nightly adapters

### Task B1: `Memory.listLive()` — enumerate live facts

**Files:**
- Modify: `packages/core-ts/src/memory/types.ts` (`Memory` interface) + `packages/core-ts/src/memory/index.ts` (impl)
- Test: `packages/core-ts/src/memory/memory.spec.ts`

**Interfaces:**
- Produces: `Memory.listLive(): Promise<MemoryFact[]>` — returns all facts with `invalid_at IS NULL` AND not on the forget-list, through the SAME forget filter as the read path (never around it — ADR-0030). Read-only; no model.

- [ ] **Step 1: Write the failing test** in `memory.spec.ts` (mirror the file's existing setup that commits facts): commit two live facts + one that's superseded/invalidated, assert `listLive()` returns exactly the two live ones (ids/text), and that a forgotten fact never appears. (Follow the spec file's existing fixture helpers for committing/forgetting.)

- [ ] **Step 2: Run** → FAIL (method missing).

- [ ] **Step 3: Implement.** Add to the `Memory` interface in `memory/types.ts`:
```ts
  /** Enumerate live facts (invalid_at IS NULL, not forgotten) through the read-path
   *  forget filter. Used by nightly consolidation (Tier-4). */
  listLive(): Promise<MemoryFact[]>
```
In `memory/index.ts`, add the method to the returned object — a SELECT over the facts table `WHERE invalid_at IS NULL`, then drop any id on the forget-list (reuse the existing forget-filter predicate the read path uses — do NOT reimplement it; route through the same choke point). Map rows → `MemoryFact`.

- [ ] **Step 4: Run** → PASS. **Step 5: `pnpm --filter @aisy/core build` + full core test** green. **Step 6: commit** `feat(memory): listLive() enumerate API for nightly consolidation (Tier4 B1)`.

---

### Task B2: Nightly support adapters — RunLock, Validators, type bridge, promotion seams

**Files:**
- Create: `packages/core-ts/src/runtime/nightly-adapters.ts`
- Test: `packages/core-ts/src/runtime/nightly-adapters.spec.ts`

**Interfaces:**
- Produces (all import nightly types from `'../nightly/index.js'` and memory types from `'../memory/index.js'`):
  - `makeFileRunLock(deps: { lockPath: string; readFile; writeFile; exists; removeFile; pid: number; bootId: string; startTime: number; now: () => number }): RunLock` — `acquire()` writes the token triple `{pid, bootId, startTime}` to `lockPath` if absent (or if the held token's process is dead); returns `{ok:true, token}`; if a live lock is held, returns `{ok:false, heldBy, heldForMs}`. `release(token)` removes the file iff the token matches. (PID-liveness check: a token whose `bootId` differs from the current boot, or whose pid is not the writer, is stale — for v1, treat a lock file older than `maxHeldMs` as stale; keep it simple + documented.)
  - `makeMemoryValidators(deps: { liveFactIds: Set<string> }): Validators` — deterministic `check(candidate)`: an `UPDATE`/`DELETE` whose `factId` is not in `liveFactIds` → `{ ok:false, id:'refs_exist', ... }`; an `ADD` with an empty `text` → fail; otherwise `{ ok:true }`. (Match the real `ValidatorResult` shape — read `nightly/types.ts`.)
  - `liveFactsForNightly(facts: MemoryFact[]): Fact[]` — map memory `MemoryFact` → nightly `Fact` (field-by-field; read the nightly `Fact` shape and map `id`/`text`/`factKey`/`invalidAt`).
  - `memOpToMemoryOp(op: MemOp): MemoryOp | null` — map a nightly `MemOp` (ADD/UPDATE/DELETE) to a memory `MemoryOp` for promotion (NOOP → null). (Read the memory `MemoryOp` shape; ADD→a commit of a new fact, UPDATE→a commit with `supersedes`, DELETE→a forget/invalidate. Map faithfully.)

- [ ] **Steps:** TDD each adapter. Tests: RunLock acquire/contend/release + stale-takeover; Validators refs_exist/empty-text/ok; the two mappers produce the right target shapes for each MemOp kind. Read `nightly/types.ts` (`Fact`, `ValidatorResult`, `LockToken`) + `memory/types.ts` (`MemoryOp`, `MemoryFact`) FIRST and match shapes verbatim. Run focused spec RED→GREEN, build, commit `feat(runtime): nightly support adapters — RunLock, Validators, type bridge (Tier4 B2)`.

---

### Task B3: LLM Generator + Judge for nightly consolidation

**Files:**
- Create: `packages/core-ts/src/runtime/nightly-generator.ts`
- Test: `packages/core-ts/src/runtime/nightly-generator.spec.ts`

**Interfaces:**
- Produces (import `Generator`, `Judge`, `MemOp`, `Fact`, `NormalizedDayLog`, `Diff`, `QuarantinedDiff`, `JudgeVerdict`, `SkillDraft` from `'../nightly/index.js'`; `ProviderAdapter` from `'../agent-loop/types.js'`):
  - `makeNightlyGenerator(deps: { provider: ProviderAdapter; nowIso: () => string }): Generator`
    - `proposeMemoryOps(log, liveFacts)`: build a strict prompt — system: "You consolidate a day's events into durable long-term memory. Propose ops as a STRICT JSON array; no prose." user: the normalized day log text + a compact list of current live facts (`factId | factKey | text`). Ask for ops in this exact JSON schema: `[{"kind":"ADD","factKey":string,"text":string} | {"kind":"UPDATE","factId":string,"factKey":string,"text":string} | {"kind":"DELETE","factId":string,"reason":string} | {"kind":"NOOP","factId":string}]`. Call `provider.complete`; `parseMemOps(reply)` = extract the first JSON array, `JSON.parse`, validate each element against the MemOp union (drop malformed elements), cap the count (e.g. ≤ 50). Build `diff` from the ops (read the `Diff` shape and construct it). Return `{ ops, diff }`. On parse failure → `{ ops: [], diff: emptyDiff }` (graceful — the runner stages nothing).
    - `draftSkills(log)`: return `[]` (skill drafting deferred to a follow-up; documented). The runner handles an empty draft set.
  - `makeNightlyJudge(deps: { provider: ProviderAdapter }): Judge`
    - `grade(quarantinedDiff)`: build a prompt — "You are a STRICT reviewer. You see only a proposed memory diff, never the author's reasoning. Accept only safe, durable, non-redundant edits. Output strict JSON `{ "verdict": "accept"|"reject", "reasons": string[] }`." (Match the real `JudgeVerdict` shape — read `nightly/types.ts`; if it's per-op, grade per-op.) Call `provider.complete`, parse, default to `reject` on parse failure (fail-safe — an unparseable judge verdict never accepts).

**Design notes (in the plan, for the executor):** The generator uses the **routine/critique tier** adapter; the judge uses a **different** adapter than the generator (the caller passes a distinct provider — Task C constructs the generator from one tier and the judge from another, honoring "different model, sees only the artifact"). Token usage is reported by the provider; the caller accumulates it into the MorningCard cost. The prompts must instruct strict-JSON-only output; the parser is defensive (extract-first-array, validate-each, drop-malformed, cap-count) — an LLM that emits prose around the JSON still parses.

- [ ] **Steps:** TDD with an INJECTED fake `ProviderAdapter` (no real network). Tests: (1) a provider returning a valid MemOp JSON array → `proposeMemoryOps` returns the parsed ops; (2) a provider returning prose+JSON → the array is still extracted; (3) malformed JSON → `{ops:[], ...}` (graceful); (4) ops count capped; (5) judge accept JSON → accept verdict; (6) judge malformed → reject (fail-safe). Read the nightly `Diff`/`JudgeVerdict`/`Fact` shapes FIRST and match them. RED→GREEN, build, commit `feat(runtime): LLM Generator + Judge for nightly consolidation (Tier4 B3)`.

---

## Phase C — Nightly live

### Task C1: Construct + drive the ConsolidationRunner in `aisy.ts`

**Files:**
- Modify: `packages/core-ts/src/index.ts` (barrel: export `makeConsolidationRunner` + the nightly types the app needs; export the B2/B3 adapters)
- Modify: `packages/app/src/bin/aisy.ts`

**Interfaces consumed:** `makeConsolidationRunner`, `makeFileRunLock`, `makeMemoryValidators`, `liveFactsForNightly`, `memOpToMemoryOp`, `makeNightlyGenerator`, `makeNightlyJudge`, `Memory.listLive`, `gateway.issueCard`, the scheduler (A2), the journal (A1), `runProactiveTurn`/`sendProactive` (A3).

- [ ] **Step 1: Barrel exports.** Add to `packages/core-ts/src/index.ts`: `export { makeConsolidationRunner } from './nightly/index.js'` + `export type { ConsolidationRunner, ConsolidationDeps, NightlyConfig, NightResult, MorningCard, MemOp, Fact } from './nightly/index.js'`; and `export { makeFileRunLock, makeMemoryValidators, liveFactsForNightly, memOpToMemoryOp, makeNightlyGenerator, makeNightlyJudge } from './runtime/...js'` (+ types). Build core.

- [ ] **Step 2: Construct the runner in `aisy.ts`** (after the providers + memory + journal are built). Build `NightlyConfig` (runAt from `AISY_NIGHTLY_AT` env or '03:30'; stagingDir=`join(base,'staging')`; archiveDir=`join(base,'archive')`; backupRemote from env or ''; maxHeldMs=2h; lintStaleDays=30). Construct generator from a routine/critique-tier adapter and judge from a DIFFERENT adapter (e.g. `adapterFor` with the critique tier vs the generator's tier; if only one provider configured, document that judge==generator falls back with a logged note — acceptable v1). Build a `runNightly()` closure:
```ts
const runNightly = async (): Promise<void> => {
  const liveFacts = await memoryStore.listLive()
  const runner = makeConsolidationRunner({
    clock: { now: () => new Date(nowIso()) },
    generator: makeNightlyGenerator({ provider: <routine adapter>, nowIso }),
    judge: makeNightlyJudge({ provider: <critique adapter> }),
    validators: makeMemoryValidators({ liveFactIds: new Set(liveFacts.map((f) => f.id)) }),
    lock: makeFileRunLock({ lockPath: join(base, 'nightly.lock'), /* fs ports */, pid: process.pid, bootId: <boot id>, startTime: <proc start>, now: () => Date.now() }),
    facts: liveFactsForNightly(liveFacts),
    // promotion effect seams → memory:
    memoryTxn: async (apply) => { await apply() },          // memory.commit is itself transactional; v1 runs apply directly
    reindex: (factId) => { void memoryStore.reindex({ ids: [factId] }) },
    emit: (event) => journal.append('nightly', event, {}),
    // optional seams (git/hygiene/archive) omitted in v1 → runner uses safe defaults / skips
  })
  const result = await runner.run(nightlyConfig)
  // Issue the morning card (informational tier-1) + a proactive summary message.
  await gateway.issueCard({
    actionId: `nightly-${result.runDate}`,
    actionHash: createHash('sha256').update(`nightly:${result.runDate}`).digest('hex'),
    tier: 1, requiresStepUp: false,
    summary: `🌅 Ночная консолидация ${result.runDate}: ${result.card.memoryEdits.length} правок памяти на одобрение.`,
  })
  await sendProactive(`🌅 Ночная консолидация ${result.runDate} готова — ${result.card.memoryEdits.length} правок в staging. Открой карту для одобрения.`)
}
```
(Resolve `bootId`/`startTime` simply: `bootId = String(os.uptime())`-derived or a per-process random stamped once; `startTime = Date.now()` at boot. Keep the RunLock liveness check simple per B2.)

- [ ] **Step 3: Wire the scheduler.** After the bot is built, construct `makeScheduler({ now: () => new Date(nowIso()), nightlyAt: nightlyConfig.runAt-as-HH:MM, lastNightlyRun: <read marker>, markNightlyRun: <write marker>, runNightly, tickTriggers: <Phase D; for now async () => {}> })` and `scheduler.start()` BEFORE `void bot.start()`. The last-run marker is `~/.aisy/nightly-last.json` (`{ date }`). (Phase D replaces the `tickTriggers` stub.)

- [ ] **Step 4: `pnpm -r build`** clean. Document the manual smoke (set `AISY_NIGHTLY_AT` to a near time, run `aisy run`, confirm a morning card + summary appear; deferred to integration). **Step 5: commit** `feat(app): construct + schedule the nightly consolidation runner (Tier4 C1)`.

---

### Task C2: Morning-card approval → `approveStagedItem`; `/consolidate` command

**Files:**
- Modify: `packages/app/src/bot.ts` (a callback for the morning-card approve tap → call a deps-injected `onApproveNightly(stagedItemId)`; a `/consolidate` command)
- Modify: `packages/app/src/bin/aisy.ts` (pass `onApproveNightly` + `onConsolidate` into the bot deps; wire to the runner's `approveStagedItem` / a staging run)

**Interfaces:**
- The runner's `approveStagedItem(id)` must be reachable from the morning-card tap. The runner is constructed inside `runNightly` (per-run). To approve later, the runner (or its staging area) must persist across runs. **Resolution:** construct the `ConsolidationRunner` ONCE at bin scope (not per-run) so `approveStagedItem` and `getStagedProposals` are stable; `runNightly` calls the same instance's `run()`. (Adjust C1 Step 2 to build the runner once; `runNightly` closes over it. `listLive`/validators are refreshed inside `run()` via the deps that read live each call — if validators need the current fact set, rebuild the runner per run OR make validators read live via a closure. Simplest correct v1: rebuild per run for `run()`, but keep a STABLE reference for `approveStagedItem` by having the runner read staging from disk — the staging area is disk-backed, so `approveStagedItem` on a fresh runner instance still finds the staged patches. Confirm by reading the nightly impl: `getStagedProposals`/`approveStagedItem` read from `stagingDir` on disk, so a fresh runner instance over the same `stagingDir` can approve a prior run's patches. Use that — construct a runner on demand for approval too, pointing at the same stagingDir.)
- `TelegramBotDeps` gains `onApproveNightly?: (stagedItemId: string) => Promise<void>` and `onConsolidate?: () => Promise<void>`.

- [ ] **Steps:** Add a `/consolidate` `bot.command` → `await deps.onConsolidate?.()` (which triggers `runNightly()` into staging immediately + acks). Add morning-card approve handling: the morning card's buttons carry the staged-item id; on tap → `await deps.onApproveNightly?.(id)`. In `aisy.ts`, wire `onConsolidate: runNightly` and `onApproveNightly: async (id) => { const r = makeConsolidationRunner({...same deps, stagingDir...}); await r.approveStagedItem(id) }`. Build clean; manual smoke deferred. Commit `feat(app): /consolidate command + morning-card approval → approveStagedItem (Tier4 C2)`.

(Detail to resolve during execution: the MorningCard → inline-button encoding for per-item approve. Read how the existing approval card encodes buttons (`makeCardButtons`/`renderCard` in telegram-gw) and mirror it for staged items, OR render the morning card as a summary with a single "Открыть staging" that lists items. Pick the simpler v1 that lets the operator approve items; document the choice.)

---

## Phase D — Triggers live

### Task D1: TriggerStore (JSONL) + probeRunner + construct the engine

**Files:**
- Create: `packages/app/src/trigger-store.ts` (JSONL-backed `TriggerStore`)
- Create or reuse: a `probeRunner` for triggers (the deterministic file/sql/http/exit probe). Check if the agent-loop already exposes a probe runner (`probeRunner` in `AgentLoopDeps`); if a reusable implementation exists in runtime, import it; else implement a minimal one in `packages/app/src/trigger-probe.ts` (file-exists, exit-code via the sandbox bash, http-status, sql skipped/unsupported-in-v1 → false with a logged note).
- Modify: `packages/app/src/bin/aisy.ts` (construct `makeTriggerEngine`)
- Test: `packages/app/src/trigger-store.spec.ts` (if app vitest) — load/save/remove round-trip.

**Interfaces:**
- `makeTriggerStore(deps: { path: string; readFile; writeFile; exists }): TriggerStore` — `load()` parses a JSONL (or JSON array) file of `TriggerSpec`; `save(spec)` upserts by id + rewrites; `remove(id)` drops + rewrites.
- The bin constructs `makeTriggerEngine({ clock: { now: () => nowIso() }, probeRunner, startTurn, store, emitEvent: (e,p) => journal.append('triggers', e, p), globalBackgroundBudget, observe })`. `globalBackgroundBudget` from config (env `AISY_TRIGGER_BUDGET_USD` → `{ tokenCeiling, dollarCeiling, tokensSpent:0, dollarsSpent:0 }`).

- [ ] **Steps:** TDD the store (round-trip, upsert, remove). Implement the probeRunner (reuse if present). Construct the engine in `aisy.ts`. Replace the scheduler's `tickTriggers` stub (C1 Step 3) with `async () => { const firings = await triggerEngine.tick(); for (const f of firings) if (f.turnStarted) journal.append('triggers','fired',{id:f.triggerId}) }` — note `startTurn` itself drives the turn (D2), so `tick()` already wakes turns; the loop just journals. Build clean. Commit `feat(app): JSONL TriggerStore + probe runner + construct trigger engine (Tier4 D1)`.

---

### Task D2: `startTurn` → proactive turn; `/remind` `/schedule` `/watch` commands; agent-trigger confirm

**Files:**
- Modify: `packages/app/src/bin/aisy.ts` (the `startTurn` callback)
- Modify: `packages/app/src/bot.ts` (the three commands + agent-created-trigger confirmation card handling)
- Modify: `packages/app/src/bin/aisy.ts` (pass `onRegisterTrigger`/`onConfirmTrigger`/`onCancelTrigger` + the engine into the bot deps)

**Interfaces:**
- `startTurn(input)`: in `aisy.ts`, wire to the bot's proactive seam:
  ```ts
  startTurn: async (input) => {
    const provenance = input.spans.some((s) => s.provenance === 'untrusted') ? 'untrusted' : 'operator'
    await runProactiveTurn(input.prompt, { provenance })
  }
  ```
  (Watched content arrives as untrusted spans → the woken turn is narrowed; the prompt is operator-authored.)
- `TelegramBotDeps` gains trigger ports: `onRegisterTrigger?(spec): Promise<TriggerSpec>`, `onListTriggers?(): Promise<TriggerSpec[]>`, `onCancelTrigger?(id): Promise<void>`, `onConfirmTrigger?(id): Promise<void>`.
- Commands (operator-created → active immediately; the engine's `register` sets `confirmed` per `createdBy`):
  - `/remind <ISO-or-relative> <prompt>` → `register({ kind:'remind', createdBy:'operator', prompt, fireAt, budget })`.
  - `/schedule <cron|HH:MM> <prompt>` → `register({ kind:'schedule', createdBy:'operator', cron, prompt, budget })`.
  - `/watch <probe-spec> <prompt>` → `register({ kind:'watch', createdBy:'operator', probe, prompt, budget, intervalMs })`.
  - `/triggers` → list; `/untrigger <id>` → cancel.
  (Parse minimally; on bad args, reply with usage. Use a per-trigger default budget from config.)
- Agent-created triggers (a tool the agent calls to propose a trigger) pend until the operator confirms via a card → `onConfirmTrigger(id)` → `engine.confirm(id)`. (For v1, a `propose_trigger` tool is OPTIONAL — if out of scope, document that only operator `/`-commands create triggers in v1; agent-created confirmation path is wired but no tool emits it yet.)

- [ ] **Steps:** Wire `startTurn`. Add the commands + the trigger ports. Build clean (bot has no harness; the engine + store are unit-tested in D1/core). Manual smoke deferred (register a `/remind` 1 minute out, confirm the proactive turn fires). Commit `feat(app): trigger commands + startTurn proactive wiring (Tier4 D2)`.

---

## Phase E — ADRs + roadmap

### Task E1: ADR-0053 + ADR-0038/spec statuses + INDEX + ROADMAP

**Files:**
- Create: `docs/decisions/2026-06-22-proactivity-scheduler-and-nightly-generator.md` (ADR-0053)
- Modify: `docs/decisions/2026-06-12-triggers-and-proactivity.md` (ADR-0038 `Proposed` → `Accepted` + "Runtime realized by ADR-0053")
- Modify: `docs/specs/10-nightly-consolidation.md` + `docs/specs/14-triggers-and-proactivity.md` (Draft → Accepted/Implemented note)
- Modify: `docs/decisions/INDEX.md` (ADR-0053 row above ADR-0052; ADR-0038 → Accepted)
- Modify: `docs/ROADMAP.md` (Tier 4 / #9 + #10 ✅ done)

- [ ] **Step 1: Write ADR-0053** (MADR; Status Accepted; Date 2026-06-22; Related ADR-0038, ADR-0033 (lint), ADR-0030 (forget filter), ADR-0050) capturing the consequential decisions:
  - **In-process scheduler + missed-slot catch-up** (vs external system cron): a `setInterval` loop in `aisy run` ticks triggers every minute and runs the nightly when its local-time slot is due and not yet run today (persisted marker); a process that boots after the slot runs the nightly on startup. Single process, no crontab. Trade-off: a process that is DOWN across the slot runs the nightly on next boot (acceptable for a single-user phone harness); an always-down process never consolidates.
  - **The bot proactive seam:** `makeTelegramBot` now returns `{ bot, runProactiveTurn, sendProactive }` so a background job (scheduler/trigger) can inject a turn or push a message; a proactive turn reuses the full runner + safety gates; watched content is stamped untrusted.
  - **Nightly Generator/Judge are LLM adapters, not dormant code:** the generator (routine tier) proposes `MemOp`s as strict JSON from the day log + the new `Memory.listLive()` set; the judge (a DIFFERENT tier, sees only the artifact) grades; both parse defensively and fail safe (unparseable judge = reject; unparseable generator = stage nothing). Skill drafting (`draftSkills`) returns `[]` in v1.
  - **Staging discipline preserved:** nothing promotes without the morning-card Approve tap → `approveStagedItem` (TOCTOU + resurrection-guard re-run); the disk-backed staging area lets a fresh runner instance approve a prior run's patches.
  - **Observability:** a durable JSONL journal sink (`append(source,kind,payload)`) replaces the memory no-op and feeds nightly + triggers; payloads carry ids/counts/event-names only (no secrets). The full hash-chained, redacting AuditLog (Component 12) is a follow-up.
  - **Consequences + follow-ups:** real `draftSkills`; full AuditLog wiring; SQL watch probes; an agent `propose_trigger` tool; nightly git/hygiene/archive effect seams (omitted v1 → safe defaults); judge==generator fallback when only one provider is configured.
  - **Alternatives considered:** external system cron (rejected — crontab ops + a separate process path, the user chose in-process+catch-up); sequential vs concurrent (n/a here); deferring nightly's LLM generator (rejected — the user chose full Tier 4 now).
- [ ] **Step 2:** ADR-0038 → Accepted (+ realized-by note); specs 10 + 14 → status note.
- [ ] **Step 3: INDEX.md** — insert above ADR-0052 (latest-first; column order `| ID | Status | Date | Title | Tags |`, `Accepted  ` two-space format):
  `| ADR-0053 | Accepted  | 2026-06-22 | [Proactivity: In-Process Scheduler & Nightly Generator/Judge](./2026-06-22-proactivity-scheduler-and-nightly-generator.md) | proactivity, nightly, triggers, scheduler |`
  Update the ADR-0038 row Status → Accepted.
- [ ] **Step 4: ROADMAP.md** — mark Tier 4 / #9 + #10 ✅ done with shipping commits + the plan link; note v1 scope + the follow-ups (draftSkills, full AuditLog, SQL watches, propose_trigger tool, nightly git/hygiene seams). Mirror Tier 1/2/3 done-rows.
- [ ] **Step 5: commit** `docs(adr): ADR-0053 proactivity scheduler + nightly generator; mark Tier 4 done`.

---

## Self-Review

**Spec coverage (vs ROADMAP Tier 4 + the user's decisions):**
- #9 nightly consolidation — B1 (listLive) + B2 (RunLock/Validators/bridge) + B3 (Generator/Judge) + C1 (construct+schedule+morning card) + C2 (/consolidate + approveStagedItem). ✅
- #10 triggers — D1 (store+probe+engine) + D2 (startTurn proactive + commands + confirm). ✅
- **Decision: in-process scheduler + catch-up** — A2 + C1 Step 3. ✅
- **Decision: full Tier 4 now (incl. LLM generator design)** — B3 designs the generator/judge prompts + strict-JSON parse; B1 adds the facts-enumerate API. ✅
- Shared infra (journal, scheduler, bot seam) — A1/A2/A3. ✅
- New ADR — E1 (ADR-0053) + ADR-0038 → Accepted. ✅

**Placeholder scan:** new modules have full code/contracts; the LLM prompts are designed in B3 with a defensive parser. Genuinely-open execution choices are flagged explicitly (not silent TODOs): the RunLock liveness heuristic (B2), the MorningCard per-item button encoding (C2), the probeRunner reuse-vs-implement (D1), the judge==generator single-provider fallback (C1), and the `propose_trigger` tool deferral (D2). The app-package test setup is checked before asserting app unit tests (A1/A2/D1).

**Type consistency:** nightly types (`Generator`/`Judge`/`MemOp`/`Fact`/`MorningCard`/`NightlyConfig`) are used per the verbatim shapes from `nightly/types.ts`; trigger types per `triggers/types.ts`; the bridge (B2) maps nightly `Fact`/`MemOp` ↔ memory `MemoryFact`/`MemoryOp` explicitly. `startTurn`'s `{triggerId,prompt,spans,budget}` input matches `TriggerEngineDeps`. The bot proactive seam return is consumed by the bin destructure (A3) and the scheduler/startTurn wiring (C/D).

**Risk control:** the agent loop + Core types are untouched (only an additive `Memory.listLive`). All new wiring is additive; existing 703 core + 89 telegram-gw tests stay green. The highest-risk surfaces — staging discipline (no promote without the Approve tap + TOCTOU + resurrection-guard) and the proactive-turn safety (full runner + gates, watched content untrusted, budget-capped twice) — are preserved by construction and captured in ADR-0053. Observability is a durable journal (no secrets in payloads). The generator/judge fail safe (stage-nothing / reject-on-unparse).
