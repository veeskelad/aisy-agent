# Tier 5 — UX Polish & Small Tails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Five small items (#11–#15), each one task with embedded TDD. They are independent — order is by ascending risk.

**Goal:** Close the five UX tails so the phone agent is operable end-to-end without "в разработке" dead-ends: a debug toggle with a real per-turn footer, a `/grants` view + reset, the three live menu sections, honest `--help`/`setup`, and an honest tiered-spend label.

**Architecture:** Mostly additive wiring in `@aisy/app` (`bot.ts`, `bin/aisy.ts`) + `@aisy/telegram-gw` (menu/event-bridge render) over already-built core stores. One tiny core addition (`SessionLog.recent`). Core `makeAgentLoop`, safety, and the provider/usage types stay untouched.

**Tech Stack:** TypeScript (Node16 ESM, `.js` import extensions), vitest, grammY (telegram-gw).

## Global Constraints
- License Apache-2.0; brand "Aisy", affirmative only; `research/` never referenced.
- TS strict + `exactOptionalPropertyTypes` (conditional spreads, never pass `undefined`) + `noUncheckedIndexedAccess`.
- **Do NOT widen `TurnUsage` / `ModelResponse.usage`** (the per-call-model split #15 would need is a documented follow-up, NOT this tier). **Do NOT modify `makeAgentLoop`.**
- A new bot dependency must be OPTIONAL (`?:`) on `TelegramBotDeps` and the bot must degrade gracefully when absent (mirror how `onListTriggers?`/`spend?` are handled) — keeps the bot unit-testable without full wiring.
- Read-only menu views must not mutate state; the grants reset is the only state change and goes through the existing `revokeAll()`.
- TDD, frequent commits; each task ends green (`pnpm -r build` + `pnpm -r test` + `pnpm -r typecheck`). Existing core 755 + gw 89 + app 48 stay green (after intentional render-test updates).
- Reuse: `Settings.toggle` (settings.ts), `GrantStore.list/revokeAll` (safety/grants.ts), `Skills.menu()` (skills), `CardResolver.resolve/names` (runtime/agent-cards.ts), the `/triggers` command + inline-button patterns (bot.ts), the settings-panel inline re-render (event-bridge.ts).

---

## Task 11: Debug toggle in ⚙️ Настройки + per-turn debug footer

**Files:**
- Modify: `packages/core-ts/src/runtime/settings.ts` (Settings interface + defaults)
- Modify: `packages/telegram-gw/src/event-bridge.ts` (settings panel — add the debug button)
- Modify: `packages/app/src/bot.ts` (after a turn, when `debug` on, append a compact footer)
- Test: `packages/core-ts/src/runtime/settings.spec.ts`, `packages/telegram-gw/src/event-bridge.spec.ts`

**Interfaces:**
- Produces: `Settings` gains `debug: boolean` (default `false`). Settings panel renders a third toggle `set:debug`. Bot appends a footer string when `settings.get().debug === true`.

- [ ] **Step 1 — failing tests.**
  - settings.spec.ts: a default `Settings` has `debug === false`; `toggle('debug')` flips it; persists.
  - event-bridge.spec.ts: the rendered settings panel includes a "🔧 Отладка" toggle button with callback data `set:debug` and the ✅/❌ state reflects `settings.debug`.
- [ ] **Step 2 — run, verify fail.** `pnpm --filter @aisy/core test settings` + `pnpm --filter @aisy/telegram-gw test event-bridge` ⇒ FAIL.
- [ ] **Step 3 — implement.**
  - `settings.ts`: add `debug: boolean` to `Settings`; default it `false` in the defaults object the store seeds from. (Match how `showCostPerTurn`/`budgetEnabled` are defaulted.)
  - `event-bridge.ts`: in the settings-panel render (the block that builds the two existing toggle buttons), add a third row: label `🔧 Отладка ${onOff(settings.debug)}`, callback `set:debug`.
  - `bot.ts`: in the text-turn handler, AFTER the reply is sent and `spend.record`, when `deps.settings?.get().debug === true`, send a compact footer via the existing reply path (a separate short message or appended): `🔧 ${result.state}${result.haltReason ? `/${result.haltReason}` : ''} · tools: ${toolsUsed.join(',') || '—'} · narrowed: ${result.narrowed ? 'да' : 'нет'}${result.usage ? ` · $${result.usage.dollars.toFixed(4)}` : ''}`. Derive `toolsUsed` from the data already available to the bot for the turn (if the bot does not already see tool names, use `result.state`/`narrowed`/`usage` only — do NOT add a new Core seam to surface tool names; keep the footer to fields already on `TurnResult`). The `set:debug` callback is already handled by the generic `set:` branch (`settings.toggle(key)` + panel re-render) — no new callback code.
- [ ] **Step 4 — run, verify pass.**
- [ ] **Step 5 — commit.** `feat(app): debug toggle in Настройки + per-turn debug footer (#11)`

## Task 12: `/grants` listing + "Сбросить гранты"

**Files:**
- Modify: `packages/app/src/bot.ts` (add `/grants` command + an inline reset button + its callback)
- Modify: `packages/app/src/bin/aisy.ts` (pass the existing `grants` store into the bot deps)
- Test: `packages/core-ts/src/safety/grants.spec.ts` (already covers list/revokeAll — extend only if a gap), and a bot-level wiring assertion if the bot has a test harness; otherwise build-verified.

**Interfaces:**
- Consumes: `GrantStore.list(): { tool: string; scope: 'always' | 'session' }[]` and `revokeAll(): void` (both already exist).
- Produces: `TelegramBotDeps` gains `grants?: Pick<GrantStore, 'list' | 'revokeAll'>`. Commands: `/grants` (lists), inline button `grants:reset` → `revokeAll()` + confirmation.

- [ ] **Step 1 — failing test.** If `grants.spec.ts` already asserts `list()` shape + `revokeAll()` clears, no new core test needed — confirm and skip. Add the bot wiring as a build-verified change (no bot harness). If a gap exists in `list()`/`revokeAll()` coverage, add the missing assertion first.
- [ ] **Step 2 — implement.**
  - `bot.ts`: add `grants?: Pick<GrantStore,'list'|'revokeAll'>` to `TelegramBotDeps`. Add `bot.command('grants', …)`: if `!deps.grants` or `list()` empty → reply "Активных грантов нет."; else reply the list (`• ${tool} · ${scope}` per line, 'always' first as `list()` already sorts) with an inline keyboard button `{ text: '🗑 Сбросить гранты', callback_data: 'grants:reset' }`. Add a callback handler for `grants:reset` → `deps.grants.revokeAll()` → `editMessageText('Гранты сброшены.')`. Mirror the `/triggers` reply + the approval-card inline-button + the `set:` callback patterns already in the file.
  - `bin/aisy.ts`: pass `grants` (the store built ~line 219) into the `makeTelegramBot({...})` deps.
- [ ] **Step 3 — verify build.** `pnpm -r build` clean; `pnpm -r typecheck` clean.
- [ ] **Step 4 — commit.** `feat(app): /grants list + inline reset button (ADR-0047 tail) (#12)`

## Task 13: Live menu sections — Сессии / Навыки / Агент

**Files:**
- Modify: `packages/core-ts/src/runtime/session-log.ts` (add a read-only `recent(n)` to the jsonl adapter) + `packages/core-ts/src/agent-loop/types.ts` (add `recent?(n: number)` to `SessionLog` as an OPTIONAL method so existing fakes don't break)
- Modify: `packages/app/src/bot.ts` (`handleMenu`: replace the "Раздел в разработке." catch-all for `sessions`/`skills`/`agent`)
- Modify: `packages/app/src/bin/aisy.ts` (pass `skills` menu + `cardResolver` + the session log into bot deps)
- Test: `packages/core-ts/src/runtime/session-log.spec.ts` (recent), `packages/core-ts/src/agent-loop` SessionLog fakes updated if the optional method is added to the interface.

**Interfaces:**
- Produces: `SessionLog.recent?(n: number): { sessionId: string; turns: number; lastAt: string }[]` (OPTIONAL — absent on fakes is fine). `TelegramBotDeps` gains `sessionLog?: Pick<SessionLog,'recent'>`, `skillsMenu?: () => { name: string; summary?: string }[]`, `agentCard?: () => { name: string; description: string; skills: string[]; toolTiers?: unknown }`.
- Consumes: `Skills.menu()`, `CardResolver.resolve('general')` / `names()`.

- [ ] **Step 1 — failing test.** session-log.spec.ts: after appending entries for two session ids, `recent(5)` returns one row per session id with the turn count and the latest timestamp, newest-first. (Define `recent` against the jsonl the adapter already writes.)
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement.**
  - `agent-loop/types.ts`: add `recent?(n: number): SessionSummary[]` to `SessionLog` (define `SessionSummary { sessionId; turns; lastAt }`). Optional → existing `{append,resume}` fakes still satisfy the type.
  - `session-log.ts`: implement `recent(n)` by scanning the jsonl (group by sessionId, count entries, max ts), return newest-first, capped at `n`.
  - `bot.ts` `handleMenu`: for `action==='sessions'` → render `deps.sessionLog?.recent(10)` (or "Сессий пока нет."); `action==='skills'` → render `deps.skillsMenu?.()` (name + summary, or "Навыков нет."); `action==='agent'` → render `deps.agentCard?.()` (name, description, skills list, tool tiers). Each read-only; absent dep → a graceful "—" message. Keep the `settings`/`monitor` branches unchanged.
  - `bin/aisy.ts`: wire `sessionLog`, `skillsMenu: () => skills.menu()`, `agentCard: () => { const c = cardResolver.resolve('general'); return {…} }` into bot deps. (Use the actual skills + card instances already constructed in the bin; if `skills`/`cardResolver` aren't constructed there yet, construct the minimal read-only accessor — do not rewire the runner.)
- [ ] **Step 4 — run, verify pass.** Update any SessionLog fake that the new optional method affects (it shouldn't, being optional) — run `pnpm -r typecheck`.
- [ ] **Step 5 — commit.** `feat(core,app): live menu sections (Сессии/Навыки/Агент) + SessionLog.recent (#13)`

## Task 14: `aisy setup <element>` recognition + `--help` lists run/setup

**Files:**
- Modify: `packages/core-ts/src/cli/index.ts` (USAGE text + a `setup` element validation if routed through the CLI)
- Modify: `packages/app/src/bin/aisy.ts` (the argv dispatch — recognize `setup <element>`)
- Test: `packages/core-ts/src/cli/cli.spec.ts`

**Interfaces:**
- Produces: `--help`/USAGE lists `run` and `setup`. `aisy setup <element>` where `<element>` ∈ a known set (`provider | telegram | memory | personality`) routes to `init` (scoped hint passed through as a positional); an unknown element prints the valid set and exits non-zero.

- [ ] **Step 1 — failing test.** cli.spec.ts: USAGE/`--help` output contains both `run` and `setup` lines; `parseArgs(['setup','provider'])` yields `{command:'setup', positional:['provider']}`; an unknown element (`setup nonsense`) returns a non-zero exit + an error naming the valid elements.
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement.**
  - `cli/index.ts`: add to USAGE:
    `aisy run                                          Boot the Telegram agent`
    `aisy setup [<element>]                            Re-run onboarding (optionally for one element)`
    Add a `SETUP_ELEMENTS = ['provider','telegram','memory','personality'] as const`; when the command is `setup` with a positional element, validate membership (unknown → err + non-zero). The element is passed through to `init` as a hint positional (init currently ignores it — the per-element re-config flow itself is a DOCUMENTED FOLLOW-UP requiring the onboarding refactor; this task only makes the verb honest + validated).
  - `bin/aisy.ts`: the existing `setup → init` alias stays; thread the validated element through.
- [ ] **Step 4 — run, verify pass.**
- [ ] **Step 5 — commit.** `feat(cli): --help lists run/setup; aisy setup <element> recognized + validated (#14)`

## Task 15: Honest tiered-spend label (replace "mixed (per-tier)")

**Files:**
- Modify: `packages/app/src/bin/aisy.ts` (the `modelLabel = 'mixed (per-tier)'` line ~242 + how the per-turn cost card is labeled)
- Modify: `packages/app/src/bot.ts` (the per-turn cost summary render, lines ~235–243) and/or `packages/telegram-gw/src/event-bridge.ts` (spend.report render) to make the tiered case honest
- Test: `packages/telegram-gw/src/event-bridge.spec.ts` (cost render)

**Interfaces:**
- Produces: on a tiered setup, the per-turn cost card shows the turn TOTAL `$` plus the note `(тарифицировано по тирам — разбивка по моделям в 📡 Монитор)`, instead of presenting `mixed (per-tier)` as if it were a model name. The 📡 Монитор `byModel` view is unchanged. **True per-call-model attribution is a DOCUMENTED FOLLOW-UP** — it needs the loop/adapter to report the model per call (`ModelResponse.usage.model`), a Core change deliberately out of this quick-win tier.

- [ ] **Step 1 — failing test.** event-bridge.spec.ts (or the bot cost-summary unit, wherever testable): when the cost summary is for a tiered run, the rendered text does NOT contain the bare token `mixed (per-tier)` as a model and DOES contain the turn total `$` + the тиры note. (Pick the seam that has a test harness — the event-bridge render is unit-tested; assert there.)
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement.** Replace the `mixed (per-tier)` label: where the per-turn card is built, branch on whether the run is tiered (`providersCfg.tiers`); if tiered, render the total + the тиры note rather than a fake model name. Keep the non-tiered path (real model name) unchanged. Do NOT touch `spend.ts` aggregation or `ModelResponse.usage`.
- [ ] **Step 4 — run, verify pass.**
- [ ] **Step 5 — commit.** `feat(app): honest tiered per-turn spend label (#15)`

## Verification
- `pnpm -r build` clean + `pnpm -r test` green + `pnpm -r typecheck` CLEAN after each task.
- New/updated specs: settings.debug, event-bridge debug button + tiered cost render, session-log.recent, cli setup/help.
- Manual smoke (deferred, no live token): toggle 🔧 Отладка → footer appears; `/grants` lists + reset clears; the three menu sections render real data; `aisy --help` shows run+setup; `aisy setup nonsense` errors; a tiered run's cost card no longer says "mixed (per-tier)".
- subagent-driven: implementer → spec+quality review per task → final whole-branch review on the strongest model. Documented DEFERRALS (must not be silently "completed"): #14 per-element re-config flow; #15 true per-call-model attribution (`ModelResponse.usage.model`). The final review should confirm no new Core seam was added for the debug footer and `TurnUsage` was not widened.
