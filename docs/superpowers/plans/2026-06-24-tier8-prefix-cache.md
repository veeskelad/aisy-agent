# Tier 8 — Prefix Caching + Exact-Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps are phased (A–E); each phase is one task with embedded TDD.

**Goal:** Finish the stable-prefix KV-cache (ADR-0019, #19) by emitting provider-appropriate cache breakpoints + accurate cache-aware cost accounting, and add a provider-agnostic content-addressed exact-cache (#20) for deterministic non-stateful paths (eval-replay, nightly re-run).

**Architecture:** Two breakpoints per request — (bp1) the stable prefix (system + memory + tools), (bp2) the growing conversation tail (last message) — so the cache is reused both across inner tool-loop calls and across turns (history is append-only per ADR-0019). Caching is **provider-aware**: Anthropic emits explicit `cache_control: ephemeral`; OpenAI/DeepSeek/Gemini/GLM/Qwen auto-cache transparently (no request change); OpenRouter gets `cache_control` passthrough; claude-cli has none. Exact-cache (#20) is a `ProviderAdapter` decorator keyed on `sha256(namespace + prefixBytes + spans)` — used ONLY off the live loop.

**Tech Stack:** TypeScript (Node16 ESM, `.js` import extensions), vitest, node:crypto.

## Global Constraints
- License Apache-2.0; brand "Aisy", affirmative only; `research/` never referenced.
- TS strict + `exactOptionalPropertyTypes` (conditional spreads, never pass `undefined`) + `noUncheckedIndexedAccess`.
- **Do NOT widen the Core `TurnUsage` / `SpendUsage` types** — cache savings are an internal optimization, not user-facing (operator decision). Cache token counts are consumed only inside `parseResponse` to compute accurate `dollars`; they are never surfaced as new fields.
- **Budget-cap correctness is safety:** when Anthropic emits `cache_control`, `usage.input_tokens` reports only the uncached portion and cache tokens arrive in separate fields. Dollars MUST be computed from all three or the ledger under-bills and the cap self-disarms. Anthropic prices: cache write (5-min ephemeral) = 1.25× base input; cache read = 0.1× base input.
- **`spansToMessages` is shared** by the Anthropic and OpenAI-compat adapters — its return shape (`{ system: string; messages: {role,content:string}[] }`) MUST NOT change. All cache_control wrapping happens in each adapter's `complete()` AFTER calling it.
- The opaque-bytes 3-tier router (`provider/types.ts`, `provider/index.ts`) stays untouched (ADR-0050).
- Default-on with a kill-switch: `AISY_PREFIX_CACHE` (anything but `'0'` ⇒ on). Exact-cache opt-in: `AISY_NIGHTLY_EXACT_CACHE === '1'` (default off — preserves nightly sample freshness).
- TDD, frequent commits; each phase ends green (`pnpm -r build` + `pnpm -r test` + `pnpm -r typecheck`). Existing 743 core + 89 gw + 48 app stay green (after the intentional adapter-shape test updates in Phases A/B).

---

## Phase A — Anthropic: 2 cache breakpoints + cache-aware tiered dollars

**Files:**
- Modify: `packages/core-ts/src/runtime/provider-anthropic.ts`
- Test: `packages/core-ts/src/runtime/provider-anthropic.spec.ts`

**Interfaces:**
- Produces: `AnthropicProviderDeps` gains `prefixCache?: boolean` (default `true`). `parseResponse(body, price?)` now reads `cache_creation_input_tokens` / `cache_read_input_tokens`, sets `usage.inputTokens` = total prompt tokens (uncached + write + read), and `usage.dollars` = tiered. `TurnUsage` shape is unchanged.

- [ ] **Step 1 — failing tests.** In `provider-anthropic.spec.ts`:
  - UPDATE the existing "sends a well-formed request" test: with default `prefixCache` on, assert `sent.system` is now `[{ type: 'text', text: 'PFX\n\nsys', cache_control: { type: 'ephemeral' } }]` and the LAST message is `{ role: 'user', content: [{ type: 'text', text: 'ping', cache_control: { type: 'ephemeral' } }] }`. `sent.tools` unchanged.
  - ADD a multi-message test (e.g. spans `user 'a'`, `assistant 'b'`, `user 'c'`): only the LAST message carries the block+cache_control; earlier messages stay `{role, content: <string>}`.
  - ADD a back-compat test: `makeAnthropicProvider({ ..., prefixCache: false })` ⇒ `sent.system` is the plain string `'PFX\n\nsys'` and messages are plain `{role, content:string}` (current behavior).
  - ADD a parseResponse test: body `usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 8000, output_tokens: 50 }` with `priceFor('claude-sonnet-4-6')` (in 3, out 15) ⇒ `usage.inputTokens === 9100`, `usage.outputTokens === 50`, and `usage.dollars` ≈ `100/1e6*3 + 1000/1e6*3*1.25 + 8000/1e6*3*0.1 + 50/1e6*15` = `0.0003 + 0.00375 + 0.0024 + 0.00075` = `0.0072`. Assert with `toBeCloseTo(0.0072, 6)`.
- [ ] **Step 2 — run, verify fail.** `pnpm --filter @aisy/core test provider-anthropic` ⇒ FAIL.
- [ ] **Step 3 — implement.** In `makeAnthropicProvider`: add `const prefixCache = deps.prefixCache ?? true`. After `spansToMessages`:
  ```ts
  const payload: Record<string, unknown> = { model: deps.model, max_tokens: maxTokens }
  if (prefixCache && messages.length > 0) {
    payload['messages'] = messages.map((m, i) =>
      i === messages.length - 1
        ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] }
        : { role: m.role, content: m.content },
    )
  } else {
    payload['messages'] = messages
  }
  if (system.length > 0) {
    payload['system'] = prefixCache
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system
  }
  if (deps.tools && deps.tools.length > 0) payload['tools'] = deps.tools
  ```
  Add `prefixCache?: boolean` to `AnthropicProviderDeps`. In `parseResponse`, widen the `usage` type to include `cache_creation_input_tokens?: number; cache_read_input_tokens?: number` and replace the usage block:
  ```ts
  if (b.usage) {
    const uncached = b.usage.input_tokens ?? 0
    const cacheWrite = b.usage.cache_creation_input_tokens ?? 0
    const cacheRead = b.usage.cache_read_input_tokens ?? 0
    const inputTokens = uncached + cacheWrite + cacheRead
    const outputTokens = b.usage.output_tokens ?? 0
    const dollars = price
      ? (uncached / 1e6) * price.inPerMtok +
        (cacheWrite / 1e6) * price.inPerMtok * 1.25 +
        (cacheRead / 1e6) * price.inPerMtok * 0.1 +
        (outputTokens / 1e6) * price.outPerMtok
      : 0
    usage = { inputTokens, outputTokens, dollars }
  }
  ```
- [ ] **Step 4 — run, verify pass.** `pnpm --filter @aisy/core test provider-anthropic` ⇒ PASS.
- [ ] **Step 5 — commit.** `feat(core): Anthropic prefix+tail cache breakpoints + cache-aware tiered cost (#19)`

## Phase B — OpenAI-compat: provider-aware cache strategy

**Files:**
- Modify: `packages/core-ts/src/runtime/provider-openai.ts`
- Test: `packages/core-ts/src/runtime/provider-openai.spec.ts`

**Interfaces:**
- Produces: `OpenAIProviderDeps` gains `cache?: 'auto' | 'breakpoints'` (default `'auto'`). `'auto'` = current string-content request (OpenAI/DeepSeek/Gemini/GLM/Qwen auto-cache transparently). `'breakpoints'` = Anthropic-style `cache_control` blocks on the system message + last message (OpenRouter passthrough). `parseOpenAIResponse` is UNCHANGED (dollars stay conservative from `prompt_tokens`, which already includes cached — over-billing is safe for the cap).

- [ ] **Step 1 — failing tests.** In `provider-openai.spec.ts`:
  - The existing default test already asserts `messages[0] === { role:'system', content:'sys' }` (string) — KEEP it (default is `'auto'`, unchanged).
  - ADD a `cache: 'breakpoints'` test: `makeOpenAICompatProvider({ ..., cache: 'breakpoints' })` with spans `system 'sys'`, `user 'ping'` ⇒ `sent.messages[0] === { role:'system', content:[{ type:'text', text:'sys', cache_control:{ type:'ephemeral' } }] }` and the last message `{ role:'user', content:[{ type:'text', text:'ping', cache_control:{ type:'ephemeral' } }] }`.
  - ADD an assertion that with `cache: 'breakpoints'` and an intermediate message, only the LAST message is block-wrapped.
- [ ] **Step 2 — run, verify fail.** `pnpm --filter @aisy/core test provider-openai` ⇒ FAIL.
- [ ] **Step 3 — implement.** Add `cache?: 'auto' | 'breakpoints'` to `OpenAIProviderDeps`. In `complete()`, replace the `oaMessages` assembly:
  ```ts
  const cache = deps.cache ?? 'auto'
  const oaMessages: { role: string; content: unknown }[] = []
  if (system.length > 0) {
    oaMessages.push(
      cache === 'breakpoints'
        ? { role: 'system', content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }
        : { role: 'system', content: system },
    )
  }
  if (cache === 'breakpoints' && messages.length > 0) {
    messages.forEach((m, i) =>
      oaMessages.push(
        i === messages.length - 1
          ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] }
          : { role: m.role, content: m.content },
      ),
    )
  } else {
    for (const m of messages) oaMessages.push({ role: m.role, content: m.content })
  }
  ```
  (The `payload.messages = oaMessages` line stays.)
- [ ] **Step 4 — run, verify pass.** `pnpm --filter @aisy/core test provider-openai` ⇒ PASS.
- [ ] **Step 5 — commit.** `feat(core): OpenAI-compat provider-aware cache strategy (auto|breakpoints) (#19)`

## Phase C — Catalog + bin wiring + kill-switch

**Files:**
- Modify: `packages/core-ts/src/runtime/providers.ts` (`BuildProviderConfig`, `buildProvider`)
- Modify: `packages/app/src/bin/aisy.ts` (thread `prefixCache` from env into `buildProvider`)
- Test: `packages/core-ts/src/runtime/providers.spec.ts` (extend; create if absent)

**Interfaces:**
- Consumes: `AnthropicProviderDeps.prefixCache` (Phase A), `OpenAIProviderDeps.cache` (Phase B).
- Produces: `BuildProviderConfig` gains `prefixCache?: boolean` (default `true`). Mapping: `anthropic` ⇒ pass `prefixCache`; `openai-compat` ⇒ `cache = (prefixCache && entry.id === 'openrouter') ? 'breakpoints' : 'auto'`; `cli` ⇒ unchanged.

- [ ] **Step 1 — failing test.** In `providers.spec.ts`, assert via a fake `fetchImpl` (or by inspecting the built adapter's request) that `buildProvider({ provider:'openrouter', model:'anthropic/claude-sonnet-4-6', apiKey:'K', prefixCache:true })` emits `cache_control` blocks, while `buildProvider({ provider:'deepseek', model:'deepseek-chat', apiKey:'K', prefixCache:true })` emits plain string content. Also `prefixCache:false` ⇒ anthropic emits plain string system. (Drive each adapter's `complete` with a fake fetch and inspect the serialized body — mirror the adapter specs' `fakeFetch` helper.)
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement.** Add `prefixCache?: boolean` to `BuildProviderConfig`. In `buildProvider`:
  - `case 'anthropic':` add `prefixCache: cfg.prefixCache ?? true` to the deps.
  - `case 'openai-compat':` compute `const cache: 'auto' | 'breakpoints' = (cfg.prefixCache ?? true) && entry.id === 'openrouter' ? 'breakpoints' : 'auto'` and pass `cache` into `makeOpenAICompatProvider`.
  - In `aisy.ts` at the `buildProvider({ ... })` call (~line 222), add `prefixCache: process.env['AISY_PREFIX_CACHE'] !== '0'`.
- [ ] **Step 4 — run, verify pass.**
- [ ] **Step 5 — commit.** `feat(core,app): wire prefix-cache per-provider + AISY_PREFIX_CACHE kill-switch (#19)`

## Phase D — Exact-cache decorator (#20) + nightly opt-in

**Files:**
- Create: `packages/core-ts/src/runtime/exact-cache.ts`
- Modify: `packages/core-ts/src/runtime/index.ts` (barrel export)
- Modify: `packages/app/src/bin/aisy.ts` (wrap nightly gen/judge adapters when `AISY_NIGHTLY_EXACT_CACHE === '1'`)
- Test: `packages/core-ts/src/runtime/exact-cache.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ExactCacheStore {
    get(key: string): ModelResponse | undefined
    set(key: string, value: ModelResponse): void
  }
  export function makeMemoryExactCacheStore(): ExactCacheStore
  export function makeExactCache(inner: ProviderAdapter, store: ExactCacheStore, namespace: string): ProviderAdapter
  ```
  Key = `sha256(namespace + '\0' + prefixBytes + '\0' + JSON.stringify(spans))`. `sessionId` is deliberately EXCLUDED (content-addressed; deterministic across runs/sessions). NEVER wrap the live agent loop (ADR-0055).

- [ ] **Step 1 — failing tests.** In `exact-cache.spec.ts`:
  - hit/miss: an inner adapter counting `complete` calls; same request twice ⇒ inner called ONCE, both results deep-equal.
  - different spans ⇒ inner called twice.
  - different namespace, same request ⇒ inner called twice (namespace isolates models).
  - store round-trip: a pre-seeded store returns the cached `ModelResponse` without calling inner.
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement `exact-cache.ts`:**
  ```ts
  import { createHash } from 'node:crypto'
  import type { ProviderAdapter, ModelRequest, ModelResponse } from '../agent-loop/types.js'

  export interface ExactCacheStore {
    get(key: string): ModelResponse | undefined
    set(key: string, value: ModelResponse): void
  }
  export function makeMemoryExactCacheStore(): ExactCacheStore {
    const m = new Map<string, ModelResponse>()
    return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) }
  }
  function keyOf(namespace: string, req: ModelRequest): string {
    const h = createHash('sha256')
    h.update(namespace); h.update('\0')
    h.update(Buffer.from(req.prefixBytes)); h.update('\0')
    h.update(JSON.stringify(req.spans))
    return h.digest('hex')
  }
  /** Content-addressed exact-response cache. ONLY for deterministic, non-stateful
   *  paths (eval-replay, nightly re-run). NEVER wrap the live agent loop (ADR-0055). */
  export function makeExactCache(inner: ProviderAdapter, store: ExactCacheStore, namespace: string): ProviderAdapter {
    return {
      async complete(req, signal) {
        const key = keyOf(namespace, req)
        const hit = store.get(key)
        if (hit) return hit
        const res = await inner.complete(req, signal)
        store.set(key, res)
        return res
      },
    }
  }
  ```
  Barrel-export from `runtime/index.ts`.
- [ ] **Step 4 — run, verify pass.**
- [ ] **Step 5 — wire nightly opt-in.** In `aisy.ts`, before constructing `makeNightlyGenerator`/`makeNightlyJudge`, add:
  ```ts
  const exactStore = makeMemoryExactCacheStore()
  const nightlyExact = process.env['AISY_NIGHTLY_EXACT_CACHE'] === '1'
  const wrapNightly = (a: ProviderAdapter, ns: string): ProviderAdapter =>
    nightlyExact ? makeExactCache(a, exactStore, ns) : a
  ```
  and use `generator: makeNightlyGenerator({ provider: wrapNightly(adapterFor(genSel), `gen:${genSel.model}`), nowIso })`, `judge: makeNightlyJudge({ provider: wrapNightly(adapterFor(judgeSel), `judge:${judgeSel.model}`) })`. (Namespaces keep gen/judge entries distinct.)
- [ ] **Step 6 — verify build.** `pnpm -r build` clean.
- [ ] **Step 7 — commit.** `feat(core,app): content-addressed exact-cache for deterministic paths + nightly opt-in (#20)`

## Phase E — ADR-0019 → Accepted, ADR-0055 (exact-cache), INDEX, ROADMAP

**Files:**
- Modify: `docs/decisions/2026-06-11-stable-prefix-kv-cache.md` (Status Proposed → Accepted + a "Live implementation (Tier 8)" addendum)
- Create: `docs/decisions/2026-06-24-exact-response-cache.md` (ADR-0055, Accepted)
- Modify: `docs/decisions/INDEX.md` (flip ADR-0019 status; add ADR-0055 row, latest-first)
- Modify: `docs/ROADMAP.md` (mark Tier 8 #19 + #20 done; #21 stays deferred)

- [ ] **Step 1 — ADR-0019 addendum.** Flip Status to `Accepted`. Add an addendum: the live design uses **2 breakpoints** (stable prefix bp1 + conversation-tail bp2) rather than the 4-segment layout — within a session the prefix is frozen (byte-identical) so multi-segment buys nothing within-session, and Anthropic's 5-min/1-hr TTL makes cross-session segment reuse moot; the tail breakpoint captures the agentic-loop win (growing history across inner tool calls + turns). Per-provider cache matrix: anthropic = explicit `cache_control`; openai/deepseek/gemini/glm/qwen = transparent auto-cache (no request change); openrouter = `cache_control` passthrough; claude-cli = none. Kill-switch `AISY_PREFIX_CACHE`. 4-segment split remains a documented future option.
- [ ] **Step 2 — ADR-0055.** New ADR (MADR): content-addressed exact-response cache for deterministic, non-stateful paths (eval-replay, nightly re-run). Key = `sha256(namespace + prefixBytes + spans)`. **Invariant: never wraps the live agent loop** (stateful turns ⇒ near-zero hit + safety-bypass risk) and **never wraps an in-flight retry-for-a-fresh-sample** (would re-serve the failed sample). Opt-in `AISY_NIGHTLY_EXACT_CACHE`. References ADR-0019, ADR-0031 (semantic cache is the separate deferred #21).
- [ ] **Step 3 — INDEX + ROADMAP.** Update INDEX (ADR-0019 → Accepted; ADR-0055 row at top of the recent block). In ROADMAP, mark Tier 8 #19 + #20 ✅ done with plan link; leave #21 deferred.
- [ ] **Step 4 — commit.** `docs(adr): ADR-0019 Accepted (live prefix-cache) + ADR-0055 exact-cache; Tier 8 #19/#20 done`

## Verification
- `pnpm -r build` clean (3 packages) + `pnpm -r test` green + `pnpm -r typecheck` CLEAN.
- Adapter specs assert the cache_control request shapes (Anthropic default-on; OpenAI breakpoints opt-in) + the tiered-dollars parse + the back-compat `prefixCache:false` plain-string path.
- exact-cache spec = merge gate for #20 (hit/miss/namespace/round-trip).
- Manual smoke (deferred, no live token): a long session shows `cache_read_input_tokens` rising and per-turn `$` dropping after turn 1; `AISY_PREFIX_CACHE=0` restores plain-string requests.
- subagent-driven: implementer → spec+quality review per phase → final whole-branch review on the strongest model (scrutinize the dollar math vs budget-cap, the shared `spansToMessages` invariant, the provider matrix, and the exact-cache "never the live loop / never a retry" invariant — this gate caught real cross-seam bugs in Tier 2/3/4/7).
