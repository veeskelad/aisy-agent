# ADR-0050: Multi-Provider Catalog, Per-Agent Budget & On-Demand Spend

**Status:** Accepted
**Date:** 2026-06-16
**Tags:** providers, runtime, telegram, cost

## Context

The live agent was hardwired to one Anthropic adapter (`makeAnthropicProvider`),
onboarding assumed Anthropic for every key, and the per-turn `cost.summary`
alert was sent on **every** turn — noise in the main chat. The operator wants:

- a **full provider catalog** — Anthropic, OpenAI, DeepSeek, OpenRouter, Qwen,
  GLM, Gemini, a generic OpenAI-compatible custom endpoint, and a **Claude CLI**
  subprocess (both HTTP and CLI for Claude);
- model selection **per tier** (reasoning/critique/routine) with a **single
  "one model for everything"** simple mode, plus a per-(sub)agent model choice;
- **budgets allocated per agent**, toggled in Settings; spend viewable **on
  demand** (Settings/Monitor), per model — not spammed per turn.

Most target providers speak the OpenAI chat API, so one generic adapter covers
DeepSeek/OpenRouter/Qwen/GLM/Gemini/OpenAI; Anthropic keeps its native adapter;
a subprocess adapter covers `claude -p`. All adapters implement the agent-loop's
`ProviderAdapter.complete` — the live seam. The opaque-bytes 3-tier router
(`provider/types.ts`) is a separate, not-yet-live surface and stays untouched.

## Decision

Adopt a provider catalog + factory, a provider-aware onboarding picker, an
on-demand spend ledger gated by operator settings, and a per-agent budget
tracker. Delivered in three phases behind one decision.

1. **Catalog + adapters (`runtime/`).** `PROVIDER_CATALOG` enumerates entries
   `{ id, label, kind, defaultBaseUrl?, keyEnv?, defaultModels?, cliCommand? }`
   where `kind ∈ {anthropic, openai-compat, cli}`. The catalog uses its **own
   string id-space** (decoupled from the 3-tier `ProviderFamily` union — less
   coupling, router untouched). `buildProvider(cfg)` dispatches by kind;
   `makeOpenAICompatProvider` (chat/completions, tool_calls, usage→dollars via a
   price table) and `makeCliProvider` (prompt on stdin, stdout→reply, reply-only)
   are new; Anthropic is unchanged. `makeTieredProvider(byTier, classify?)` wraps
   per-tier adapters behind one `complete()`; single-model ⇒ all tiers resolve to
   the same adapter.

2. **Config — `~/.aisy/providers.json` + vault.** `{ default?, tiers?, agents? }`:
   `tiers` absent ⇒ `default` serves every tier (simple mode). Keys/base-URLs per
   provider live in the vault (`AISY_PROVIDER_<ID>_KEY`, `…_BASE_URL`); CLI
   providers need no key. The bin builds the live provider from this file with
   back-compat to Anthropic + the legacy reasoning key.

3. **Onboarding picker (decoupled).** Onboarding never imports provider
   internals: the catalog is **injected as plain data** (`ProviderCatalogEntry`,
   `needsKey` instead of kind) and the chosen config is written through a
   `ProvidersOutPort`. Interactive `aisy init` offers the catalog, asks "one
   model or per-tier", prompts model + secret key (skipped for CLI) + base-URL
   (only for the custom entry), validates via a provider-aware
   `pingCatalogProvider`, and persists `providers.json` + vault. The legacy
   per-tier key prompts remain as a fallback when no catalog is injected, so all
   prior onboarding tests pass unchanged.

4. **Spend ledger + settings.** `makeSpendStore` aggregates `record/byModel/
   byAgent/total` over an injected persistence port (`~/.aisy/spend.json`), fed
   from `TurnResult.usage`. `makeSettingsStore` (`~/.aisy/settings.json`) holds
   `{ showCostPerTurn:false, budgetEnabled:false }` — **conservative defaults**.
   The per-turn `cost.summary` is sent **only** when `showCostPerTurn` is on;
   otherwise spend accrues silently and is viewed on demand. New telegram-gw
   `UiEvent`s `spend.report` (per-model rows + total + per-agent) and
   `settings.panel` (toggles with `set:` callbacks) wire the ⚙️ Настройки and
   📡 Монитор menu taps (previously unhandled — labels leaked to the agent).

5. **Per-agent budget (turn-level).** `makeBudgetTracker({ caps, spent })` keys
   on arbitrary agent ids; caps come from config (`agents[*].budgetUsd` + the
   main agent's `AISY_BUDGET_USD`), `spent` is read **live** from the ledger
   (the tracker holds no state). When `budgetEnabled` and the main agent is
   `over` its cap, the transport **refuses the turn** and emits `budget.capped`
   (wiring the previously-deferred alert); its buttons map to `budget:details`
   (spend report) and `budget:resume` (lift enforcement for the session).

## Consequences

- **Positive:** Any of nine providers runs via `providers.json`; the common
  single-model case is one picker flow. One generic OpenAI-compat adapter
  amortizes across five providers.
- **Positive:** The main chat is quiet by default — spend is on-demand, matching
  the operator's "не спамить в основной сессии" requirement. Budget enforcement
  is opt-in and reversible from the alert.
- **Positive:** Additive and decoupled — onboarding stays free of provider
  internals (injected catalog + port); the 3-tier router and the tested
  agent-loop are untouched. core 649 + telegram-gw 89 tests green.
- **Negative / accepted:** Budget enforcement is **turn-level**, not mid-turn —
  a single turn can overrun its cap by up to one turn's spend. A first-class
  mid-turn halt needs a new loop halt-reason + budget port; deferred until it
  matters (the loop already caps tool-calls).
- **Negative / accepted:** The spend ledger attributes a turn to `deps.model`
  (the configured label); with a tiered provider the real per-call model is not
  yet split out. Per-call attribution lands with the provider-wrapper seam below.
- **Deferred:** Sub-agent **inheritance** of model + budget via delegation
  (ADR-0039) — the tracker/config already key on arbitrary agent ids, so the
  data model is ready; only the live multi-agent runtime is missing. `doctor`
  remains keyed on the legacy per-tier env keys (a catalog-based install shows
  spurious `env.required-keys`/`providers.*` failures) — making doctor
  provider-aware is a follow-on.

## Alternatives considered

- **Extend `ProviderFamily` + reuse the 3-tier router as the live path:**
  rejected — the router is opaque-bytes and not wired; coupling the catalog to it
  buys nothing now and constrains later. Kept the catalog in its own id-space.
- **One adapter per provider:** rejected — five of them are OpenAI-compatible;
  one generic adapter + a base-URL is far less code.
- **Mid-turn budget via a provider wrapper that throws:** rejected — the loop
  only cleanly halts on its internal `Halt`; a thrown `all-exhausted` would
  mislabel the stop and yield an empty reply. Turn-level gate is honest and safe.
- **Rip out the per-tier env-key model in onboarding:** rejected as out-of-scope
  churn on a well-tested path; the catalog picker is additive with a legacy
  fallback.

## References

- ADR-0036 (provider cost telemetry), ADR-0039 (sub-agent delegation),
  ADR-0048 (runtime composition + app package), ADR-0049 (interactive onboarding)
- `packages/core-ts/src/runtime/`: `providers.ts`, `provider-openai.ts`,
  `provider-cli.ts`, `spend.ts`, `settings.ts`, `budget.ts`, `onboarding-node.ts`
- `packages/core-ts/src/onboarding/`: `types.ts`, `index.ts` (catalog picker)
- `packages/telegram-gw/src/event-bridge.ts` (`spend.report`, `settings.panel`,
  `budget.capped`)
- `packages/app/src/bot.ts` (gate per-turn cost, menu panels, budget gate),
  `bin/aisy.ts` (build provider + stores from `providers.json`)
