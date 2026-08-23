# Tier 1 — Live Wiring (Memory, Session Log, Provider-Aware Doctor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-built-and-tested memory component into the live `aisy run` path (real recall + `search_memory` tool), give the session log a durable on-disk form, and make `aisy doctor` read `providers.json` so a catalog-based install stops reporting false per-tier failures.

**Architecture:** Three independent tasks. (1) Two pure bridge adapters in `@aisy/core` translate the `Memory` component to the agent-loop `MemoryPort` + the execute-tool `searchMemory` port (the two `FrozenSnapshot` shapes differ, so the bridge is real, not identity); the bin constructs `makeMemoryStore` and these adapters. (2) A jsonl-backed `SessionLog` (durable append; `resume()` returns null — full crash-resume is deferred). (3) A read-only `ProvidersInPort` lets `doctor` load the chosen `providers.json` and validate the *chosen* providers via the existing `pingCatalogProvider`, falling back to the legacy per-tier checks when no `providers.json` exists.

**Tech Stack:** TypeScript (strict, Node16 ESM, `.js` import extensions), vitest, pnpm monorepo (`@aisy/core`, `@aisy/app`), `better-sqlite3` (already a core dep via the memory component).

**Verification baseline before starting:** `pnpm --filter @aisy/core exec vitest run` → 649 passing; `pnpm -r build` → green.

---

## Task 1: Memory bridge adapters (core)

**Files:**
- Create: `packages/core-ts/src/runtime/memory-adapter.ts`
- Create: `packages/core-ts/src/runtime/memory-adapter.spec.ts`

Reference shapes (verbatim from the codebase):
- `MemoryPort` (`agent-loop/types.ts`): `snapshot(): Promise<FrozenSnapshot>`; `forget(factRef: string, humanConfirmed: boolean): Promise<void>`.
- agent-loop `FrozenSnapshot`: `{ prefixBytes: Uint8Array; prefixHash: string; breakpoints: number[]; takenAt: string }`.
- memory `Memory`: `search(query, opts?: {limit?: number}): Promise<RankedHit[]>`; `readFrozenSnapshot(): Promise<FrozenSnapshot>`; `forget(factId: string, reason: string, humanConfirmed: boolean): Promise<void>`.
- memory `FrozenSnapshot`: `{ bytes: Buffer; sha256: string }`.
- `RankedHit`: `{ id: string; factKey: string; text: string; score: number; annotation?: string }`.
- execute-tool `searchMemory?: (query: string) => Promise<string> | string`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core-ts/src/runtime/memory-adapter.spec.ts
import { describe, it, expect } from 'vitest'
import { makeMemoryPort, makeMemorySearch } from './memory-adapter.js'
import type { Memory, RankedHit } from '../memory/index.js'

function fakeMemory(over: Partial<Memory> = {}): Memory {
  return {
    search: async () => [],
    load: async () => '',
    readFrozenSnapshot: async () => ({ bytes: Buffer.from('hello'), sha256: 'abc123' }),
    commit: async () => ({ verdict: 'ok' }) as never,
    forget: async () => {},
    reindex: async () => {},
    rebuildFromFiles: async () => {},
    serializeMemoryIndex: async () => ({ content: '', sha256: '' }),
    integrityCheck: async () => ({ ok: true }) as never,
    ...over,
  }
}

describe('makeMemoryPort', () => {
  it('bridges memory FrozenSnapshot {bytes,sha256} to the loop shape', async () => {
    const port = makeMemoryPort(fakeMemory(), () => '2026-06-16T00:00:00.000Z')
    const snap = await port.snapshot()
    expect(Array.from(snap.prefixBytes)).toEqual(Array.from(Buffer.from('hello')))
    expect(snap.prefixHash).toBe('abc123')
    expect(snap.breakpoints).toEqual([])
    expect(snap.takenAt).toBe('2026-06-16T00:00:00.000Z')
  })

  it('forwards forget with a reason', async () => {
    const seen: unknown[] = []
    const port = makeMemoryPort(
      fakeMemory({ forget: async (id, reason, human) => void seen.push([id, reason, human]) }),
      () => 'now',
    )
    await port.forget('fact-9', true)
    expect(seen[0]).toEqual(['fact-9', 'operator forget', true])
  })
})

describe('makeMemorySearch', () => {
  it('formats ranked hits as text lines', async () => {
    const hits: RankedHit[] = [
      { id: '1', factKey: 'project', text: 'Aisy is OSS', score: 1 },
      { id: '2', factKey: 'pref', text: 'reply in Russian', score: 0.5 },
    ]
    const search = makeMemorySearch(fakeMemory({ search: async () => hits }))
    expect(await search('q')).toBe('• [project] Aisy is OSS\n• [pref] reply in Russian')
  })

  it('reports the empty state', async () => {
    const search = makeMemorySearch(fakeMemory({ search: async () => [] }))
    expect(await search('q')).toBe('Память: ничего не найдено.')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aisy/core exec vitest run src/runtime/memory-adapter`
Expected: FAIL — `Cannot find module './memory-adapter.js'`.

- [ ] **Step 3: Write the adapters**

```ts
// packages/core-ts/src/runtime/memory-adapter.ts
// Bridge the memory component (Memory) to the agent-loop ports. The two
// FrozenSnapshot shapes differ — memory yields {bytes, sha256}; the loop wants
// {prefixBytes, prefixHash, breakpoints, takenAt} — so this is a real translation.

import type { MemoryPort } from '../agent-loop/types.js'
import type { Memory, RankedHit } from '../memory/index.js'

export function makeMemoryPort(memory: Memory, nowIso: () => string): MemoryPort {
  return {
    snapshot: async () => {
      const snap = await memory.readFrozenSnapshot()
      return {
        prefixBytes: new Uint8Array(snap.bytes),
        prefixHash: snap.sha256,
        breakpoints: [],
        takenAt: nowIso(),
      }
    },
    forget: (factRef, humanConfirmed) => memory.forget(factRef, 'operator forget', humanConfirmed),
  }
}

/** Bridge Memory.search → the execute-tool searchMemory port (hits → text). */
export function makeMemorySearch(memory: Memory, limit = 8): (query: string) => Promise<string> {
  return async (query: string) => {
    const hits: RankedHit[] = await memory.search(query, { limit })
    if (hits.length === 0) return 'Память: ничего не найдено.'
    return hits.map((h) => `• [${h.factKey}] ${h.text}`).join('\n')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aisy/core exec vitest run src/runtime/memory-adapter`
Expected: PASS (4 tests).

- [ ] **Step 5: Export from the core barrel**

In `packages/core-ts/src/index.ts`, after the spend/settings/budget exports, add:

```ts
export { makeMemoryStore } from './memory/index.js'
export type { Memory, MemoryStore, MemoryStoreDeps, RankedHit, MemoryFact } from './memory/index.js'
export { makeMemoryPort, makeMemorySearch } from './runtime/memory-adapter.js'
```

- [ ] **Step 6: Verify the barrel compiles**

Run: `pnpm --filter @aisy/core exec tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add packages/core-ts/src/runtime/memory-adapter.ts packages/core-ts/src/runtime/memory-adapter.spec.ts packages/core-ts/src/index.ts
git commit -m "feat(runtime): memory bridge adapters (MemoryPort + searchMemory) [Tier1]"
```

---

## Task 2: Durable jsonl SessionLog (core)

**Files:**
- Create: `packages/core-ts/src/runtime/session-log.ts`
- Create: `packages/core-ts/src/runtime/session-log.spec.ts`

Reference shapes (verbatim):
- `SessionLog` (`agent-loop/types.ts`): `append(entry: LogEntry): void`; `resume(sessionId: string): TurnState | null`.
- `LogEntry`: `{ seq: number; ts: string; kind: string; payloadHash: string; payload: unknown }`.

Scope: durable append (one JSON line per entry); `resume()` returns `null`. Full crash-resume (reconstructing `TurnState` from the log) is deferred — it needs a replay that rebuilds plan state and is low-value for the single-user agent today. Documented in the file header.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core-ts/src/runtime/session-log.spec.ts
import { describe, it, expect } from 'vitest'
import { makeJsonlSessionLog } from './session-log.js'

describe('makeJsonlSessionLog', () => {
  it('appends each entry as one JSON line', () => {
    const lines: string[] = []
    const log = makeJsonlSessionLog({ appendLine: (l) => lines.push(l) })
    log.append({ seq: 1, ts: 't', kind: 'turn.start', payloadHash: 'h', payload: { a: 1 } })
    log.append({ seq: 2, ts: 't2', kind: 'turn.end', payloadHash: 'h2', payload: null })
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual({ seq: 1, ts: 't', kind: 'turn.start', payloadHash: 'h', payload: { a: 1 } })
    expect(JSON.parse(lines[1]!).kind).toBe('turn.end')
  })

  it('resume returns null (crash-resume deferred)', () => {
    const log = makeJsonlSessionLog({ appendLine: () => {} })
    expect(log.resume('any-session')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aisy/core exec vitest run src/runtime/session-log`
Expected: FAIL — `Cannot find module './session-log.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core-ts/src/runtime/session-log.ts
// Durable append-only session log: each LogEntry is one JSON line via the
// injected sink (the node bin appends to ~/.aisy/session-log.jsonl). resume()
// returns null — full crash-resume (TurnState replay) is a deferred follow-up;
// this gives a durable, inspectable audit trail today.

import type { SessionLog, LogEntry } from '../agent-loop/types.js'

export function makeJsonlSessionLog(deps: { appendLine: (line: string) => void }): SessionLog {
  return {
    append: (entry: LogEntry) => deps.appendLine(JSON.stringify(entry)),
    resume: () => null,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aisy/core exec vitest run src/runtime/session-log`
Expected: PASS (2 tests).

- [ ] **Step 5: Export from the core barrel**

In `packages/core-ts/src/index.ts`, add near the other runtime exports:

```ts
export { makeJsonlSessionLog } from './runtime/session-log.js'
```

- [ ] **Step 6: Commit**

```bash
git add packages/core-ts/src/runtime/session-log.ts packages/core-ts/src/runtime/session-log.spec.ts packages/core-ts/src/index.ts
git commit -m "feat(runtime): durable jsonl SessionLog (append; resume deferred) [Tier1]"
```

---

## Task 3: Provider-aware doctor (core)

**Files:**
- Modify: `packages/core-ts/src/onboarding/types.ts` (add `ProvidersInPort`; add `providersIn?` to `OnboardingDeps`)
- Modify: `packages/core-ts/src/onboarding/index.ts` (re-export type; rewrite env + providers checks in `runChecks`)
- Modify: `packages/core-ts/src/runtime/onboarding-node.ts` (implement `providersIn` reading `~/.aisy/providers.json`)
- Test: `packages/core-ts/src/onboarding/onboarding.spec.ts` (new describe block)

Problem (verbatim, `onboarding/index.ts`): the `env.required-keys` check (`missing = REQUIRED_ENV_KEYS.filter(...)`) and the `for (const tier of TIERS)` providers loop both assume the legacy `AISY_PROVIDER_{REASONING,CRITIQUE,ROUTINE}_KEY`. After a catalog install (`providers.json` + per-provider vault keys), these report false failures. `OnboardingDeps` has only a write-only `providersOut` — **no read seam exists**, so the plan adds one.

- [ ] **Step 1: Write the failing test**

Add this block at the end of `packages/core-ts/src/onboarding/onboarding.spec.ts` (it reuses the existing `makeDeps`, `makeFakeFs`, `healthySeed`, `DEEPSEEK_ENTRY`, `PRESENT_ENV` helpers defined earlier in the file). It asserts that with a `providers.json` the doctor validates the chosen provider, not the legacy tiers:

```ts
describe('doctor — provider-aware (ADR-0050)', () => {
  it('with providers.json: pings the chosen provider, not legacy tiers; required-keys pass from vault env', async () => {
    const pinged: string[] = []
    const validators: CredentialValidators = {
      ...makeFakeValidators(),
      pingCatalogProvider: async (o) => {
        pinged.push(o.providerId)
        return { ok: true, httpStatus: 200 }
      },
    }
    // env carries the chosen provider key + telegram/memory (vault-merged in prod).
    const env: Record<string, string> = {
      AISY_PROVIDER_DEEPSEEK_KEY: 'dk',
      AISY_TELEGRAM_BOT_TOKEN: 'tok',
      AISY_TELEGRAM_CHAT_ID: '42',
      AISY_MEMORY_ROOT: '/m',
      AISY_DB_PATH: '/db',
    }
    const deps = makeDeps({
      fs: makeFakeFs(healthySeed()),
      env,
      validators,
      providerCatalog: [DEEPSEEK_ENTRY],
      providersIn: { read: () => ({ default: { provider: 'deepseek', model: 'deepseek-chat' } }) },
    })

    const report = await makeOnboardingOps(deps).doctor({})

    expect(pinged).toEqual(['deepseek'])
    const prov = report.checks.find((c) => c.id === 'providers.deepseek.reachable')
    expect(prov?.status).toBe('pass')
    const env0 = report.checks.find((c) => c.id === 'env.required-keys')
    expect(env0?.status).toBe('pass')
  })

  it('without providers.json: legacy per-tier checks still run', async () => {
    const deps = healthyDeps() // no providersIn ⇒ legacy path
    const report = await makeOnboardingOps(deps).doctor({})
    expect(report.checks.some((c) => c.id === 'providers.reasoning.reachable')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aisy/core exec vitest run src/onboarding/onboarding`
Expected: FAIL — `providersIn` not assignable to `OnboardingDeps` (type error) and/or `providers.deepseek.reachable` check absent.

- [ ] **Step 3: Add the `ProvidersInPort` type + dep**

In `packages/core-ts/src/onboarding/types.ts`, next to `ProvidersOutPort`:

```ts
/** Read seam for the persisted ProvidersConfig — lets `doctor` validate the
 *  chosen providers instead of the legacy per-tier env keys. Absent or null ⇒
 *  doctor falls back to the legacy per-tier checks. */
export interface ProvidersInPort {
  read(): ProvidersConfig | null
}
```

In the same file, add to `OnboardingDeps` (next to `providersOut`):

```ts
  /** Reads the persisted providers.json (ADR-0050) for provider-aware doctor. */
  providersIn?: ProvidersInPort
```

- [ ] **Step 4: Re-export the type**

In `packages/core-ts/src/onboarding/index.ts`, add `ProvidersInPort` to the type re-export block that already lists `ProvidersConfig`, `ProvidersOutPort`.

- [ ] **Step 5: Rewrite the env + providers checks in `runChecks`**

In `packages/core-ts/src/onboarding/index.ts`, replace the **env.required-keys** block and the **providers per-tier loop** with a provider-aware version. Insert this helper at the top of `runChecks` (before the env block):

```ts
    // ADR-0050: when a providers.json exists, doctor validates the CHOSEN
    // providers (keys from the merged env/vault map) instead of legacy tiers.
    const provCfg = deps.providersIn?.read() ?? null
    const catalog = deps.providerCatalog ?? []
    const chosenSelections = provCfg
      ? [
          ...(provCfg.default ? [provCfg.default] : []),
          ...(provCfg.tiers ? Object.values(provCfg.tiers) : []),
        ]
      : []
    const distinctChosen = [...new Map(chosenSelections.map((s) => [s.provider, s])).values()]
    const requiredKeys: readonly string[] = provCfg
      ? [
          'AISY_TELEGRAM_BOT_TOKEN',
          'AISY_TELEGRAM_CHAT_ID',
          'AISY_MEMORY_ROOT',
          'AISY_DB_PATH',
          ...distinctChosen
            .map((s) => catalog.find((e) => e.id === s.provider))
            .filter((e): e is NonNullable<typeof e> => !!e && e.needsKey && !!e.keyEnv)
            .map((e) => e.keyEnv as string),
        ]
      : REQUIRED_ENV_KEYS
```

Replace the env.required-keys block with one that, in catalog mode, checks the merged `deps.env` (where vault keys live) rather than the `.env` file:

```ts
    // env (critical) — required keys present.
    {
      let missing: string[]
      if (provCfg) {
        missing = requiredKeys.filter((k) => envValueOf(k).length === 0)
      } else {
        const body = deps.fs.exists('.env') ? deps.fs.read('.env') : ''
        const present = parseEnvBody(body)
        missing = requiredKeys.filter((k) => !present.has(k))
      }
      const ok = missing.length === 0
      add({
        id: 'env.required-keys',
        domain: 'env',
        status: ok ? 'pass' : 'fail',
        severity: 'critical',
        detail: ok ? 'all required keys present' : `missing required keys: ${missing.join(', ')}`,
        fixable: false,
      })
    }
```

Replace the providers per-tier loop with a branch:

```ts
    // providers (high) — reachability ping. Catalog install ⇒ ping the chosen
    // providers; otherwise the legacy per-tier ping.
    if (provCfg) {
      for (const sel of distinctChosen) {
        const entry = catalog.find((e) => e.id === sel.provider)
        if (!entry || !entry.needsKey || !entry.keyEnv) {
          add({
            id: `providers.${sel.provider}.reachable`,
            domain: 'providers',
            status: 'pass',
            severity: 'high',
            detail: `${sel.provider} needs no key`,
            fixable: false,
          })
          continue
        }
        const key = envValueOf(entry.keyEnv)
        const baseUrl = envValueOf(`AISY_PROVIDER_${entry.id.toUpperCase()}_BASE_URL`) || entry.defaultBaseUrl
        const ping = deps.validators.pingCatalogProvider
          ? await deps.validators.pingCatalogProvider({ providerId: sel.provider, key, ...(baseUrl ? { baseUrl } : {}) })
          : { ok: key.length > 0 }
        add({
          id: `providers.${sel.provider}.reachable`,
          domain: 'providers',
          status: ping.ok ? 'pass' : 'fail',
          severity: 'high',
          detail: ping.ok ? `${sel.provider} key reachable` : redact(`${sel.provider} key rejected (HTTP ${ping.httpStatus ?? '???'})`),
          fixable: false,
        })
      }
    } else {
      for (const tier of TIERS) {
        const key = envValueOf(`AISY_PROVIDER_${tier.toUpperCase()}_KEY`)
        const ping = await deps.validators.pingProvider(tier, key)
        add({
          id: `providers.${tier}.reachable`,
          domain: 'providers',
          status: ping.ok ? 'pass' : 'fail',
          severity: 'high',
          detail: ping.ok ? `${tier} key reachable` : redact(`${tier} key rejected (HTTP ${ping.httpStatus ?? '???'})`),
          fixable: false,
        })
      }
    }
```

- [ ] **Step 6: Run the doctor tests to verify they pass**

Run: `pnpm --filter @aisy/core exec vitest run src/onboarding/onboarding`
Expected: PASS — the two new tests plus all prior onboarding tests (no `providersIn` ⇒ legacy path unchanged).

- [ ] **Step 7: Implement `providersIn` in the node adapter**

In `packages/core-ts/src/runtime/onboarding-node.ts`, near the `providersOut` definition, add (the `base` and `existsSync`/`readFileSync` are already in scope):

```ts
  const providersIn = {
    read(): ProvidersConfig | null {
      const p = join(base, 'providers.json')
      if (!existsSync(p)) return null
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as ProvidersConfig
      } catch {
        return null
      }
    },
  }
```

Pass it into `makeOnboardingOps({ … })` alongside `providerCatalog`/`providersOut`:

```ts
    providerCatalog,
    providersOut,
    providersIn,
```

- [ ] **Step 8: Run the full onboarding suite + typecheck**

Run: `pnpm --filter @aisy/core exec vitest run src/onboarding && pnpm --filter @aisy/core exec tsc --noEmit`
Expected: all green; no type errors.

- [ ] **Step 9: Commit**

```bash
git add packages/core-ts/src/onboarding/types.ts packages/core-ts/src/onboarding/index.ts packages/core-ts/src/runtime/onboarding-node.ts packages/core-ts/src/onboarding/onboarding.spec.ts
git commit -m "feat(onboarding): provider-aware doctor reads providers.json [Tier1]"
```

---

## Task 4: Wire it all into the live bin (app)

**Files:**
- Modify: `packages/app/src/bin/aisy.ts` (replace the memory + sessionLog stubs; add `search_memory` tool; pass `searchMemory` to the executor)

Note: `@aisy/app` has no unit-test harness (`vitest run --passWithNoTests`); verification here is **typecheck + build + a smoke run**.

Current stubs (verbatim, line numbers approximate — they shift as you edit):
- `aisy.ts:150-153` memory stub; `:154` sessionLog stub; `:114-119` TOOLS array (no `search_memory`); `:183` `makeToolExecutor({ fs, workspaceRoot, ...runBash })`.

- [ ] **Step 1: Import the new factories**

In the `@aisy/core` import block in `aisy.ts`, add: `makeMemoryStore`, `makeMemoryPort`, `makeMemorySearch`, `makeJsonlSessionLog`. Add `appendFileSync` to the `node:fs` import.

- [ ] **Step 2: Replace the memory stub with the real store + adapter**

Replace:

```ts
const memory: MemoryPort = {
  snapshot: async () => ({ prefixBytes: new Uint8Array(), prefixHash: 'cold', breakpoints: [], takenAt: new Date().toISOString() }),
  forget: async () => {},
}
const sessionLog: SessionLog = { append: () => {}, resume: () => null }
```

with:

```ts
const nowIso = (): string => new Date().toISOString()
const memoryRoot = vault['AISY_MEMORY_ROOT'] ?? process.env['AISY_MEMORY_ROOT'] ?? join(base, 'memory')
const dbPath = vault['AISY_DB_PATH'] ?? process.env['AISY_DB_PATH'] ?? join(base, 'memory.db')
const memoryStore = makeMemoryStore({
  memoryRoot,
  dbPath,
  // Observability journal is wired in Tier 4; a no-op keeps commit fail-open today.
  emitEvent: async () => {},
  nowIso,
})
const memory: MemoryPort = makeMemoryPort(memoryStore, nowIso)

const sessionLogPath = join(base, 'session-log.jsonl')
const sessionLog: SessionLog = makeJsonlSessionLog({
  appendLine: (line) => appendFileSync(sessionLogPath, line + '\n', { encoding: 'utf8', mode: 0o600 }),
})
```

- [ ] **Step 3: Advertise the `search_memory` tool to the model**

In the `TOOLS` array, add (so the provider can actually emit the call):

```ts
  { name: 'search_memory', description: 'Search long-term memory (FTS) for relevant facts', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
```

- [ ] **Step 4: Pass `searchMemory` into the executor**

Change the `makeToolExecutor(...)` call to:

```ts
const executeTool = makeToolExecutor({
  fs: fsPort,
  workspaceRoot,
  searchMemory: makeMemorySearch(memoryStore),
  ...(runBash ? { runBash } : {}),
})
```

- [ ] **Step 5: Typecheck + build**

Run: `pnpm -r build`
Expected: all three packages `build: Done`, no errors.

- [ ] **Step 6: Smoke — DB is created and `doctor` is provider-aware**

```bash
rm -rf /tmp/aisy-tier1 && mkdir -p /tmp/aisy-tier1
printf '{"default":{"provider":"claude-cli","model":"sonnet"}}' > /tmp/aisy-tier1/providers.json
AISY_HOME=/tmp/aisy-tier1 node packages/app/dist/bin/aisy.js doctor 2>&1 | head -20
```
Expected: doctor runs; the providers check reads `providers.json` (a `providers.claude-cli.reachable` "needs no key" pass, NOT three legacy `providers.{reasoning,critique,routine}` failures).

Note: a full `aisy run` smoke needs a real bot token + provider key and is out of scope for an automated step; the build + doctor smoke confirm wiring.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/bin/aisy.ts
git commit -m "feat(app): wire real memory + search_memory + durable session log into aisy run [Tier1]"
```

---

## Self-Review

**1. Spec coverage (Tier 1 = roadmap items #1, #2, #3):**
- #1 Real memory + `search_memory` → Task 1 (adapters) + Task 4 (store construction, tool advertised, executor port). ✓
- #2 Durable SessionLog → Task 2 + Task 4 (jsonl sink). ✓ (full crash-resume explicitly deferred — documented).
- #3 Provider-aware doctor → Task 3 (read-port + check rewrite + node impl). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step has an expected result. The only intentional deferral (SessionLog `resume`) is documented behavior with a passing test, not a placeholder.

**3. Type consistency:**
- `makeMemoryPort(memory, nowIso)` / `makeMemorySearch(memory, limit?)` — same names used in Task 1 and Task 4. ✓
- `Memory`, `RankedHit`, `MemoryStoreDeps`, `FrozenSnapshot` shapes match the verbatim quotes. The snapshot bridge handles the `{bytes,sha256}` → `{prefixBytes,prefixHash,breakpoints,takenAt}` difference. ✓
- `makeMemoryStore` deps `{ memoryRoot, dbPath, emitEvent, nowIso }` — matches `MemoryStoreDeps`. ✓
- `ProvidersInPort.read(): ProvidersConfig | null` used identically in types, doctor (`deps.providersIn?.read()`), node impl, and the test fake. ✓
- `makeJsonlSessionLog({ appendLine })` — same in Task 2 and Task 4. ✓
- `SessionLog`/`LogEntry`/`MemoryPort` imported from `@aisy/core` already exist in the bin's import (MemoryPort, SessionLog are imported today). ✓

**Open risk to watch during execution:** `makeMemoryStore` opens `better-sqlite3` directly; confirm it resolves at app runtime (it's a core dep used by the memory tests). If the bin process can't resolve it, add `better-sqlite3` to `@aisy/app` deps. The doctor smoke (Task 4 Step 6) uses `claude-cli` (no DB/key needed) so it passes even before a memory DB exists.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-16-tier1-live-wiring.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
