# Component 09: Provider Routing — Specification

**Status:** Draft
**Component:** 09 / 12
**Related ADRs:** ADR-0018, ADR-0019, ADR-0016
**Depends on:** Core / Agent Loop (01), Nightly Consolidation (10), Observability & Verification (12)

> The deterministic code path that maps each task to the cheapest provider that fits,
> falls back on sustained provider errors without thrashing the KV-cache, and enforces
> the per-task spend and iteration budget that every autonomous run leans on.

## 1. Purpose

Provider Routing is the harness's deterministic dispatcher for model calls. The model
proposes *what* to think (a ~70% probabilistic act); this component decides *where*
that thought is computed and *how much* it may cost (100% code). It exists because
Aisy spans tasks with very different cost/quality profiles — nightly triage on a
$0.14/$0.28 flash model, bulk reasoning on a mid-tier model, review gates on the
strongest model — and sending everything to one provider either overpays or
underperforms (ADR-0018).

Three concerns live here, and all three are deterministic OS, never an LLM choosing
where to send itself:

- **Routing** (ADR-0018): a cheap classifier assigns each task a *tier*
  (reasoning / critique / routine), and a fixed table resolves the tier to a provider.
- **Fallback** (ADR-0018): a per-provider error counter escalates to the next provider
  only after **2 consecutive** errors, so transient blips never flip the route or
  discard the byte-stable prefix's KV-cache (ADR-0019).
- **Budget** (this spec, owned here per Eng-12): a per-task token and dollar ceiling,
  enforced in code, that bounds the worst-case spend of any autonomous run — the cap
  that ADR-0020's Loop Guardian and ADR-0021 orchestration both assume exists.

The component is the OS-around-the-model boundary for the *provider* dimension: the
model never selects its own provider, never overrides the budget, and never judges its
own output (the generator/judge runtime-independence invariant of ADR-0016 is enforced
here, §8).

## 2. Responsibilities

**Owns:**

- **The task classifier** — a small, fast call (or rule table) that labels each model
  request with a routing tier: `reasoning`, `critique`, or `routine` (ADR-0018). Its
  own cost is negligible against the routing savings.
- **The 3-tier routing table** — the fixed tier → provider mapping
  (reasoning → DeepSeek V4-Pro, critique → Claude Opus 4.8, routine/monitoring/nightly →
  V4-Flash), plus the **pinned escalation order** for fallback (GPT-5.5 → Sonnet 4.6 →
  human alert).
- **The per-provider hysteresis counter** — increments on a provider error
  (429 / 5xx / timeout), resets to zero on any success, and triggers a fallback only at
  **2 consecutive** errors (ADR-0018).
- **The byte-stable prefix contract for the dispatched call** — assembling the request
  so the KV-cached system-prefix bytes are identical across the session and Anthropic
  cache breakpoints (≤ 4, each ≥ ~1024-2048 tokens) sit at the segment boundaries
  defined in ADR-0019.
- **The per-task budget cap** (Eng-12) — token and dollar ceilings, tracked across all
  model calls of a task, enforced in code; on breach the task is halted and escalated.
- **The generator/judge runtime-independence guard** (CSO-M5) — at *run time*, the
  resolved provider/family for a judge call must differ from the generator call it is
  grading; if fallback would collapse them onto one family, the candidate is **held for
  human review** instead of being self-judged.
- **The all-providers-down terminal policy** (Eng-7) — when the escalation chain is
  exhausted, persist STATE + the durable session log, **queue** the pending call, and
  **block** further dispatch, so the loop is closed deterministically rather than left
  on an open "human alert".
- A **provider-adapter abstraction** with a swappable test double (Eng-11) so
  classifier, generator, judge, and router behavior are testable without live providers.

**Does not do (boundary — owner named):**

- **Assemble the prompt, freeze the memory snapshot, or own conversation history.**
  Owned by **Core (01)**; this component receives an already-assembled, byte-stable
  request and must not mutate its prefix.
- **Decide the generator/judge *roles* or run the nightly loop.** Owned by **Nightly
  Consolidation (10)**; this component only *resolves the provider* for each role and
  enforces that the two resolved providers differ at run time (ADR-0016).
- **Detect loops or define the autonomy tiers.** Loop detection is the **Loop Guardian**
  in **Orchestration/Observability** (ADR-0020); this component owns only the *budget
  cap* those guards assume.
- **Write the audit journal or compute spend analytics.** Owned by **Observability
  (12)**; this component emits a structured event per route/fallback/budget decision.
- **Hold provider API keys or run the egress.** Secrets live in the **Safety (05)**
  vault; network egress is the Safety egress proxy. This component requests a call; it
  does not store credentials.
- **Choose tools, run hooks, or sandbox execution.** Owned by **Tools & Hooks (04)** and
  **Safety (05)**.

## 3. Interfaces

```ts
// illustrative, not binding

export type RouteTier = "reasoning" | "critique" | "routine"

export type ProviderFamily =
  | "deepseek"   // V4-Pro, V4-Flash
  | "anthropic"  // Opus 4.8, Sonnet 4.6
  | "openai"     // GPT-5.5

export interface ProviderId {
  family: ProviderFamily
  model: string            // e.g. "deepseek-v4-pro", "claude-opus-4.8"
}

// A request handed in by Core (01) or Nightly (10). The prefix is already
// byte-stable; the router MUST NOT mutate it (ADR-0019).
export interface ModelRequest {
  taskId: string
  role: "classifier" | "generator" | "judge" | "agent"
  stablePrefix: Uint8Array      // byte-stable; cache-breakpoint layout from Core
  body: RequestBody             // append-only conversation tail + tool defs
  // for judge calls: the providerId actually used for the generator of this artifact
  pairedGeneratorProvider?: ProviderId
}

export interface RouteDecision {
  provider: ProviderId
  tier: RouteTier
  fromFallback: boolean         // true if hysteresis escalated off the default
  cacheBreakpoints: number      // 0..4 placed in the dispatched request
}

export interface Router {
  // Deterministic. The model never sees or votes on this verdict.
  classify(req: ModelRequest): Promise<RouteTier>          // cheap call or rule table
  route(req: ModelRequest): Promise<RouteDecision | DispatchError>  // tier -> provider; fails closed (all_providers_down) — never returns a known-down provider
  dispatch(req: ModelRequest): Promise<ModelResult | DispatchError> // route + budget + call + count
}

// Per-provider hysteresis state (ADR-0018). Reset to 0 on any success.
export interface HysteresisState {
  provider: ProviderId
  consecutiveErrors: number     // fallback fires at == 2
}

// Per-task budget (Eng-12). Enforced in code, across every call of the task.
export interface TaskBudget {
  taskId: string
  tokenCeiling: number
  dollarCeiling: number
  tokensSpent: number
  dollarsSpent: number
}

export type DispatchError =
  | { kind: "budget_exceeded"; budget: TaskBudget }                 // Eng-12
  | { kind: "all_providers_down"; queuedRequestId: string }         // Eng-7
  | { kind: "judge_collision_held"; candidateId: string }           // CSO-M5
  | { kind: "prefix_mutated"; expectedHash: string; actualHash: string } // ADR-0019
```

Errors are returned as typed `DispatchError` results, never thrown through the agent
loop. Events emitted to Observability (12): `route.classified`, `route.resolved`,
`route.fallback`, `route.all_down_queued`, `budget.charged`, `budget.exceeded`,
`judge.collision_held`, `cache.prefix_mismatch`.

## 4. Data structures

**Routing table (fixed, ADR-0018).** A static map, not model output:

| Tier | Default provider | Pricing (per 1M, Jun 2026) |
|---|---|---|
| `reasoning` | DeepSeek V4-Pro | $1.74 / $3.48 |
| `critique` | Claude Opus 4.8 | $5 / $25 |
| `routine` (monitoring, nightly) | DeepSeek V4-Flash | $0.14 / $0.28 |

**Escalation order (fixed, ADR-0018).** On 2 consecutive errors on the active
provider, fallback walks `GPT-5.5 ($5/$30)` → `Sonnet 4.6 ($3/$15)` → **all-down
terminal policy** (Eng-7). The order is a policy constant; review/critique gates stay
pinned and never route below their tier's quality floor.

**HysteresisState** (per provider, per session). `consecutiveErrors` is an integer that
fallback reads at the threshold `== 2`; any successful response resets it to `0`. A
single transient 429 therefore never flips the route (ADR-0018).

**Stable-prefix contract (ADR-0019).** The router treats `stablePrefix` as opaque,
byte-identical bytes for the whole session. It computes a session-start hash of the
prefix and asserts it is unchanged on every dispatch (`prefix_mutated` on mismatch). It
places up to 4 Anthropic cache breakpoints at the ADR-0019 segment boundaries
(1: system+constitution; 2: SOUL+USER; 3: MEMORY index snapshot; 4: reserved boundary
before append-only history). The router never rewrites or compacts the prefix; KV-cache
is lost only on a provider fallback (the session survives, ADR-0018/ADR-0019).

**TaskBudget (Eng-12).** Per `taskId`: a `tokenCeiling` and `dollarCeiling` set at task
admission, and running `tokensSpent` / `dollarsSpent` charged after each call using the
resolved provider's price sheet. The ceilings are code-enforced: a call that would cross
either ceiling is refused *before* dispatch.

**Queue record (Eng-7).** On all-providers-down: a durable record `{taskId, requestId,
serializedRequest, queuedAt}` written alongside the session STATE so the loop can resume
the exact pending call after recovery, rather than losing it on an open alert.

## 5. Behavior & control flow

Every model call traverses the same deterministic path. The model appears only as the
*author of the request body*; it never chooses the provider, the budget, or the
fallback.

```
   request from Core(01) / Nightly(10)  (body authored by the model)
                     |
                     v
  +-----------------------------------------------------------+
  | dispatch()  [code, 100%]                                   |
  |  1. assert prefix hash == session-start hash (ADR-0019)    |
  |       mismatch -> DispatchError.prefix_mutated (fail-closed)|
  |  2. classify() -> tier  [cheap call / rule table]          |
  |  3. route(tier) -> provider via fixed table (ADR-0018)     |
  |  4. judge-independence guard (CSO-M5) [code]:              |
  |       if role=="judge" AND provider.family ==             |
  |          pairedGeneratorProvider.family:                  |
  |            -> HOLD candidate for human review              |
  |               (judge.collision_held), do NOT self-judge    |
  |  5. budget pre-check (Eng-12) [code]:                      |
  |       est cost would cross token/dollar ceiling?          |
  |            -> budget_exceeded, halt task, escalate         |
  |  6. place <=4 cache breakpoints (ADR-0019)                |
  |  7. CALL provider                                         |
  |       success -> hysteresis[provider] = 0;                |
  |                  charge budget; emit budget.charged        |
  |       error(429/5xx/timeout) ->                           |
  |            hysteresis[provider]++                          |
  |            if hysteresis[provider] < 2: RETRY same provider|
  |            if == 2: FALLBACK to next in escalation order   |
  |               (KV-cache for old provider lost; session ok) |
  +-----------------------------------------------------------+
                     |
        all escalation steps exhausted?
                     |
              yes    v   (Eng-7 terminal policy)
  +-----------------------------------------------------------+
  | all-providers-down  [code, 100%]                          |
  |  - persist STATE + durable session log                    |
  |  - QUEUE the serialized request (resume on recovery)      |
  |  - BLOCK further dispatch for the task                    |
  |  - emit route.all_down_queued + human alert               |
  +-----------------------------------------------------------+
```

**Ordering guarantees (load-bearing):**

- The prefix hash check (step 1) runs **first**, before any provider work, so a mutated
  prefix can never reach a provider and silently re-bill the cache.
- The judge-independence guard (step 4) runs **after** the provider is resolved (so it
  sees the *run-time* family, including any fallback) and **before** the call, so a
  collision holds the candidate instead of self-judging (CSO-M5).
- The budget pre-check (step 5) runs **before** dispatch, so the ceiling cannot be
  crossed by the very call being checked (Eng-12).
- Hysteresis (step 7) increments **per provider** and resets on success, so isolated
  transient errors never flip the route (ADR-0018).
- Fallback discards only the failed provider's **KV-cache**, never the session
  (ADR-0018/ADR-0019).

**Deterministic vs model:** classification may be a cheap model call, but the *route*,
*fallback*, *budget*, *judge-independence hold*, and *all-down terminal policy* are all
code (100%). No provider, budget, or fallback decision is delegated to a model.

**Cost telemetry (v0.1, promoted from v0.2 per [ADR-0036](../decisions/2026-06-11-cost-transparency-surfacing.md)).**
On every successful dispatch the router emits a `provider.cost.charged` event
(`taskId`, `requestId`, `tier`, `tokens`, `dollars`) into the Observability journal,
where `dollars` is the resolved provider's charge for that call — after any fallback, the
*resolved* provider, not the default. This is the per-call source Observability aggregates
into per-task and per-period cost surfacing.

## 6. Dependencies

- **Internal:**
  - **Core / Agent Loop (01)** — supplies the byte-stable `stablePrefix` and the
    append-only body; consumes `RouteDecision`/`ModelResult`. On all-providers-down,
    Core resumes the queued request from STATE (ADR-0019, ADR-0018).
  - **Nightly Consolidation (10)** — issues `generator` and `judge` role requests; this
    component resolves a distinct provider per role and enforces run-time independence
    (ADR-0016). Nightly owns the *roles*; routing owns the *provider resolution*.
  - **Observability & Verification (12)** — receives one structured event per route,
    fallback, budget charge, budget breach, judge-hold, and all-down event; computes
    spend analytics from `budget.charged`.
- **External:**
  - **Provider APIs** — DeepSeek (V4-Pro, V4-Flash), Anthropic (Opus 4.8, Sonnet 4.6),
    OpenAI (GPT-5.5), reached only via the Safety egress proxy with keys from the Safety
    vault. Pricing sheets are config, versioned per the Jun 2026 numbers above
    (ADR-0018). Anthropic prompt caching: ≤ 4 breakpoints, ~1024-2048 token minimum
    (ADR-0019).

**Risk-finding requirements landed in §6 mechanism:**

- **Finding 5 (ADR-0018/0019):** the fixed 3-tier table, the 2-consecutive-error
  hysteresis counter, and the byte-stable-prefix / ≤4-breakpoint contract are all owned
  and enforced here.
- **Finding 4 (Eng-11):** the provider-adapter abstraction (`ProviderAdapter`) has a
  test double (`FakeProviderAdapter`) that can be scripted to return success, a specific
  error class (429/5xx/timeout), a token/cost figure, or a forced family, so classifier,
  generator, judge, and router are testable offline.
- **Finding 3 (Eng-12):** `TaskBudget` ceilings are defined and code-enforced here, the
  missing owner ADR-0020's Loop Guardian assumed.

## 7. Failure & degraded modes (mandatory)

| Failure | Detection | Behavior | Recovery |
|---|---|---|---|
| **Cold start** (routing table / hysteresis state / budget store not yet loaded) | Startup readiness check before first dispatch | **Fail-closed**: no model call dispatched until the routing table, price sheet, and budget store are live | Block dispatch until init; surface "router initializing"; resume on ready |
| **Active provider returns a transient error** (single 429/5xx/timeout) | Provider call returns an error class | **Degrade (retry same provider)**: `hysteresis[provider]++`; stays on provider while `< 2`; KV-cache preserved | Next success resets counter to 0; no route flip on a blip (ADR-0018) |
| **Active provider fails twice in a row** | `hysteresis[provider] == 2` | **Degrade (fallback)**: escalate to next provider in the fixed order; only the failed provider's KV-cache is lost; session survives | Counter for the new provider starts at 0; route returns to the cheaper default on the next clean session |
| **All providers down** (escalation chain exhausted, Eng-7) | Last escalation step also errors | **Fail-closed + queue**: persist STATE + durable session log, **queue** the serialized request, **block** further dispatch, raise human alert | Operator restores a provider; Core resumes the queued request from STATE; no work lost |
| **Per-task budget would be exceeded** (Eng-12) | Budget pre-check: est cost crosses token or dollar ceiling | **Fail-closed**: refuse the call before dispatch, halt the task, escalate with the budget card | Operator raises the ceiling or approves continuation; task resumes from STATE |
| **Judge resolves to the generator's family at run time** (CSO-M5) | Step 4 guard: `role=="judge" && provider.family == pairedGeneratorProvider.family` | **Fail-closed (hold)**: do **not** self-judge; hold the candidate for human review; emit `judge.collision_held` | Human reviews in the morning card, or a provider with a different family recovers and the judge call re-runs independently |
| **Stable prefix mutated mid-session** (ADR-0019) | Step 1: prefix hash != session-start hash | **Fail-closed**: refuse the call (`prefix_mutated`); do not re-bill a silently invalidated cache | Core must restart the session to change the prefix (a deliberate, single cache drop per ADR-0019) |
| **Classifier call fails or times out** | classify() errors | **Degrade (safe default)**: route to the `critique` tier (strongest model) rather than guess cheap; never downgrade a task to a weak tier on classifier failure | Retry classify on the next turn; emit `route.classified(fallback=true)` |
| **Price sheet unavailable / stale** (budget cannot be charged accurately) | Price lookup errors at charge time | **Fail-closed**: refuse new dispatch (budget cannot be enforced without prices); existing in-flight call completes | Operator supplies/refreshes the versioned price sheet; dispatch resumes |
| **Provider returns malformed/oversized response** | Response validation fails | **Degrade**: treat as a provider error (counts toward hysteresis), return a structured error result to the loop | Same fallback path; loop survives (no exception through the loop) |

## 8. Security & threat model

This component is security-relevant: it is the deterministic boundary that prevents the
model from choosing its own provider, exceeding its budget, or grading its own work. All
mitigations below are **code**, 100% adherence.

| Threat (STRIDE / OWASP-LLM) | Vector | Deterministic mitigation (code) | Enforcing ADR / Finding |
|---|---|---|---|
| **Self-evaluation collusion** (LLM judge is the defendant) | Hysteresis fallback collapses judge and generator onto the same provider family at run time, so the model effectively grades its own draft | **Run-time independence guard**: at dispatch, if a `judge` call resolves to the generator's family, the candidate is **held for human review**, never self-judged | ADR-0016, CSO-M5 |
| **Unbounded spend / resource exhaustion** (LLM10 unbounded consumption; LLM06 excessive agency) | A degenerate autonomous run (loop, retries) burns tokens/dollars overnight on a cheap provider | **Per-task token + dollar ceiling enforced in code** before each dispatch; breach halts the task and escalates; the cap the Loop Guardian assumes | Eng-12, ADR-0020 |
| **Denial of service via provider outage** | A provider outage stalls every task of a tier with no recovery path, or thrashes the route | **2-consecutive-error hysteresis + fixed escalation + all-down queue**: transient errors don't flip; real outages fall back; total outage queues + resumes rather than dropping the session | ADR-0018, Eng-7 |
| **Cache-poisoning / silent re-bill** (tampering with the cached prefix) | A mid-session prefix mutation silently invalidates the KV-cache and re-bills ~10k tokens, or poisons a more-stable segment | **Byte-stable-prefix assertion**: session-start prefix hash checked on every dispatch; mismatch fails closed; breakpoints placed only at fixed segment boundaries | ADR-0019 |
| **Elevation of routing privilege** (model picks its own provider) | The model attempts to route itself to a stronger/cheaper provider or bypass the budget | **Routing, fallback, and budget are code**, not model output; the request body cannot set provider, tier, or ceiling; the model's only input is the body it authors | ADR-0018, Eng-12 |
| **Information disclosure of provider credentials** | Keys leak through the routing path | Keys never live here; calls go through the Safety (05) vault + egress proxy; the router holds only a `ProviderId`, never a secret | ADR-0018 (routing is code; secrets owned by Safety) |

**Enforced by code vs by the model:** the route, the fallback decision, the budget
ceiling, the judge-independence hold, the prefix-stability assertion, and the all-down
terminal policy are all code (100%). The model only authors the request body; the
classifier may be a cheap model call but its *output is overridden to the safe (critique)
tier on failure*, never trusted to downgrade a task.

## 9. Acceptance criteria (mandatory)

Each is a single objectively verifiable assertion for a Phase-3 test. Tests use the
`FakeProviderAdapter` (AC-09-1) unless a live provider is explicitly required.

**Provider-adapter fake (Finding 4, Eng-11):**

1. **AC-09-1** — A `FakeProviderAdapter` implementing the `ProviderAdapter` interface can
   be injected into `Router` and scripted per-call to return (a) success with a given
   token/cost figure, (b) a specific error class (`429` / `5xx` / `timeout`), or (c) a
   forced `ProviderFamily`; a test exercising `classify`/`route`/`dispatch` runs to
   completion with zero live network calls (network-call spy records 0).

**3-tier routing (Finding 5, ADR-0018):**

2. **AC-09-2** — A request classified `reasoning` resolves to `deepseek-v4-pro`, a
   `critique` request resolves to `claude-opus-4.8`, and a `routine` request resolves to
   `deepseek-v4-flash`, asserted against the fixed routing table.
3. **AC-09-3** — The provider/tier resolution is produced by code from the table, not by
   the request body: a request body that embeds a `provider`/`tier` field has no effect
   on the resolved `RouteDecision` (the embedded field is ignored).

**Hysteresis fallback (Finding 5, ADR-0018):**

4. **AC-09-4** — One scripted error followed by a success leaves the route unchanged:
   `RouteDecision.fromFallback == false` on the next call and `hysteresis[provider] == 0`
   after the success (a single transient error never flips the route).
5. **AC-09-5** — Two consecutive scripted errors on the active provider make the third
   dispatch resolve to the next provider in the fixed escalation order
   (`fromFallback == true`); the failed provider's family changes and a `route.fallback`
   event is emitted.
6. **AC-09-6** — On fallback, only the failed provider's KV-cache marker is dropped while
   the session id and durable session log are unchanged (a test asserting the session
   survived passes; one asserting a new session was created fails).

**KV-cache economics / byte-stable prefix (Finding 5, ADR-0019):**

7. **AC-09-7** — `dispatch` places at most 4 cache breakpoints and each is at an ADR-0019
   segment boundary; a fixture requesting a 5th breakpoint or a breakpoint mid-segment
   fails validation.
8. **AC-09-8** — When the `stablePrefix` bytes differ from the session-start hash,
   `dispatch` returns `DispatchError.prefix_mutated` and the provider adapter is never
   called (network/adapter spy records 0 calls for that request).

**Budget cap (Finding 3, Eng-12):**

9. **AC-09-9** — A task with `tokenCeiling`/`dollarCeiling` set: after charged calls reach
   a ceiling, the next `dispatch` returns `DispatchError.budget_exceeded` and the adapter
   is not called (the ceiling cannot be crossed by the checked call).
10. **AC-09-10** — `budget.charged` is emitted after each successful call with the
    resolved provider's price applied, and `TaskBudget.dollarsSpent` equals the sum of
    per-call charges (token count × resolved per-1M price); a test asserts the running
    total matches.
11. **AC-09-11** — On `budget_exceeded`, the task is halted (no further dispatch for that
    `taskId`) and a budget escalation event is emitted; resuming requires an explicit
    raised ceiling (a dispatch with the old ceiling still returns `budget_exceeded`).

**Generator/judge run-time independence (Finding 2, CSO-M5):**

12. **AC-09-12** — A `judge` request whose `pairedGeneratorProvider.family` equals the
    judge's resolved family returns `DispatchError.judge_collision_held`, emits
    `judge.collision_held`, and the judge provider is never called (no self-judging).
13. **AC-09-13** — The independence check uses the **run-time** resolved provider: when
    hysteresis fallback moves the judge onto the generator's family, AC-09-12 still trips
    (a test that fixes the *default* judge family to differ but forces a fallback
    collision must still hold the candidate).
14. **AC-09-14** — A held candidate is routed to human review (its record appears in the
    review/staging queue consumed by Nightly Consolidation 10), not silently dropped and
    not auto-passed.

**All-providers-down terminal policy (Finding 1, Eng-7):**

15. **AC-09-15** — When every provider in the escalation chain is scripted to error, the
    final dispatch returns `DispatchError.all_providers_down`, persists STATE + the
    durable session log, and writes a queue record containing the serialized request
    (the queue record file/row exists and contains the request id).
16. **AC-09-16** — After all-providers-down, further `dispatch` for that task is blocked
    until recovery (a subsequent dispatch with no recovered provider does not call any
    adapter), and once a provider is restored the queued request resumes from STATE
    (the same `requestId` is dispatched and succeeds).

**Failure-mode safe defaults (§7):**

17. **AC-09-17** — When `classify` is scripted to throw/time out, `route` resolves to the
    `critique` tier (strongest model), never to a weaker tier (a test asserting a
    `routine` route on classifier failure fails).
18. **AC-09-18** — At cold start (routing table / price sheet not loaded), `dispatch`
    refuses to call any adapter and surfaces an "initializing" state; once loaded, the
    same request dispatches successfully.

**Cost telemetry (ADR-0036):**

19. **AC-09-19** — every successful dispatch emits exactly one `provider.cost.charged`
    event whose `dollars` equals the resolved provider's charge for that call (after
    fallback, the *resolved* provider, not the default). *(ADR-0036)*

## 10. Open questions

- **Adaptive ceilings per task class.** Whether `tokenCeiling`/`dollarCeiling` should be
  static config or learned per task category over time. Deferred; revisit with the
  ADR-0016 trust-gradient work and Nightly Consolidation (10).
- **Price-sheet freshness policy.** How often the versioned provider price sheet is
  refreshed and how a mid-session price change is handled (current behavior: in-flight
  call completes, new dispatch fails closed if prices are stale). Tracked against
  ADR-0018 tuning.
- **Cross-session hysteresis memory.** Whether a provider that failed hard at the end of
  one session should start the next session pre-penalized, or always start at counter 0.
  Currently always 0; deferred.
- **Region/latency-aware routing within a family.** Out of scope for v1 (cost/quality
  tiering only); a later ADR if multi-region routing is needed.

## 11. References

- ADRs:
  - [ADR-0018 — 3-Tier Model Router with Hysteresis Fallback](../decisions/2026-06-11-model-router-hysteresis-fallback.md)
  - [ADR-0019 — Stable-Prefix KV-Cache](../decisions/2026-06-11-stable-prefix-kv-cache.md)
  - [ADR-0016 — Generator + Separate Judge for Self-Learning](../decisions/2026-06-11-generator-judge-self-learning.md)
  - [ADR-0020 — Loop Guardian (the budget cap this spec owns)](../decisions/2026-06-11-loop-guardian.md)
  - [ADR-0021 — Coordinator-Workers Orchestration](../decisions/2026-06-11-coordinator-workers-orchestration.md)
  - [ADR-0036 — Cost-Transparency Surfacing](../decisions/2026-06-11-cost-transparency-surfacing.md)
- Concept docs:
  - [Nightly consolidation](../concepts/nightly-consolidation.md)
</content>
</invoke>
