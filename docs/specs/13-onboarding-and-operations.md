# Component 13: Onboarding & Operations — Specification

**Status:** Draft
**Component:** 13 / 13
**Related ADRs:** ADR-0034, ADR-0035, ADR-0036, ADR-0037, ADR-0011, ADR-0012, ADR-0014, ADR-0029
**Depends on:** Gateway (02), Memory (03), Safety (05), Provider Routing (09), Nightly Consolidation (10), Observability & Verification (12)

> Onboarding & Operations is the harness's **operational shell**: the deterministic code that takes a fresh clone from zero to a running, *validated* agent (`aisy init`), proves the whole stack is healthy at any time (`aisy doctor`), exports a redacted support bundle (`aisy diagnostics`), and gives the operator a guided first-run conversation plus in-session control commands over Telegram — without ever requiring the engine to be re-implemented and without hiding any of it behind a UI that cannot be edited by hand.

## 1. Purpose

Every prior component (01–12) assumes it is already configured: a vault holds the keys, the memory tree exists and is indexed, the Telegram token is valid, the sandbox image is built. **Nothing in the harness gets the operator to that state.** Today the only path is hand-editing `.env` and reading logs, and the only health probe is `pnpm sandbox:doctor`, which checks Docker and nothing else. A competitive audit of nine comparable harnesses found that the two that won adoption both ship a setup wizard, a `doctor` health-check, and a guided first-run, while several that lacked spend caps, default-deny, or sandboxing shipped catastrophic day-0 failures (publicly-exposed instances, runaway bills, destructive auto-runs). This component closes that gap as **code**, not as a no-code product.

In the OS-around-the-model thesis this component is almost entirely **deterministic code (100%)**: prerequisite detection, credential validation, file scaffolding, store initialization, every health check, and the redaction of the diagnostics bundle are all code. The model is involved (~70%) in exactly one place — the *wording* of the BOOTSTRAP guided-setup conversation, shaped by Personality (08) — and even there it can only ask questions and explain; it cannot write a secret, confirm a card, or mark setup complete. ADR-0034 records that adding this shell does **not** make Aisy a no-code product: every artifact `init` scaffolds (`.env`, `SOUL.md`, `constitution.md`, `AGENTS.md`, `USER.md`) remains a plain file the operator edits directly, and `doctor` only *reports* (and, with explicit opt-in, repairs) — it never silently rewrites the operator's configuration.

Concretely the shell exists to do five deterministic jobs the engine cannot do for itself: (1) **scaffold and validate** a working configuration from nothing (`aisy init`); (2) **verify the whole stack** end-to-end at any time and after upgrades (`aisy doctor`); (3) **export a redacted support bundle** with zero secret leakage (`aisy diagnostics`); (4) **walk a first-time operator** from "bot is reachable" to "agent is configured" via a BOOTSTRAP conversation and config cards; (5) **surface cost and control** in-session (`/status`, `/usage`, `/context`, `/doctor`, `/consolidate`) so the operator is never surprised by spend (ADR-0036) and never has to leave Telegram to run a health check.

## 2. Responsibilities

What this component **owns**:

- **`aisy init`** — the interactive setup wizard and its non-interactive (`--yes` / env-driven) twin for CI and reproducible installs. Detects and validates prerequisites (Node 22 LTS, pnpm ≥9, Docker ≥24, optional Python 3.11+/ffmpeg); prompts for and **validates** provider API keys (per-tier reachability ping) and the Telegram bot token (`getMe`); scaffolds `.env` from `.env.example` and `SOUL.md`/`constitution.md`/`AGENTS.md`/`USER.md` from templates; initializes the memory git repo and the SQLite FTS5 index by calling Memory (03) `rebuildFromFiles()`; seeds the vault via Safety (05); optionally completes Telegram pairing. **Idempotent and resumable** — re-running never clobbers an already-populated file without explicit `--force`.
- **`aisy doctor`** — the full-stack health-check. Runs a fixed set of deterministic checks across every domain (env, providers, Telegram, memory/SQLite, vault, sandbox/Docker, MCP allowlist, nightly cron, sidecars, disk/backup, clock/timezone), each returning `pass | warn | fail` with a human-readable detail. Flags: `--json` (machine-readable, **redacted**), `--fix` (apply only the safe, explicitly-fixable repairs, each gated), `--post-upgrade` (the subset that catches migration breakage), `--only`/`--skip`/`--severity-min`. **Folds and supersedes `pnpm sandbox:doctor`.**
- **`aisy diagnostics`** — a redacted support-bundle exporter: harness version, resolved config (secret values stripped), the `doctor` report, recent journal tail (Observability 12), and component versions, written to a single archive for bug reports. No secret value, no vault handle resolution, and no memory fact content ever enters the bundle.
- **The BOOTSTRAP first-run flow** — `BOOTSTRAP.md`, read by the agent on the operator's first message, that drives a guided conversation (agent name, persona preset, default autonomy tier, budget caps, optional memory seed) using Gateway (02) config **cards** for any setting that mutates state.
- **In-session control commands** over Telegram: `/status` (current model routing, context fill, last-turn + session cost), `/usage` (cost breakdown by tier/period from the journal), `/context` (what is injected: files, tools, skills, sizes), `/doctor` (run the health-check and return a summary card), `/consolidate` (trigger a nightly consolidation pass on demand — ADR-0010-style, routed to Nightly 10's staging gate, never auto-promoted).
- **The upgrade entrypoint** — `aisy upgrade` semantics and the `doctor --post-upgrade` contract that must pass before a new version serves traffic.
- **The install/packaging contract** (ADR-0035) — the one-liner bootstrap script and Docker Compose that land the operator at the `aisy init` step.

What this component **does not** do (boundary → owner):

- It does **not** own the approval-card lifecycle, nonce, or action-hash — that is **Gateway (02)**. Config cards and the BOOTSTRAP flow **reuse** `issueCard`/`handleCardTap`; this component only constructs the `PendingAction`s.
- It does **not** implement the vault, encryption, or secret storage — that is **Safety (05)**. `init` *seeds* secrets through the Safety API and never writes a key to disk in plaintext outside `.env` (which is git-ignored and the operator's own file).
- It does **not** route, price, or call models in normal operation — that is **Provider Routing (09)**. `init`/`doctor` only issue a minimal reachability ping per configured tier to validate a key; `/usage`/`/status` only *read* the cost telemetry the router emits (ADR-0036).
- It does **not** author, index, or forget memory facts — that is **Memory (03)**. `init` only triggers the initial `rebuildFromFiles()`; `doctor` only runs Memory's `integrityCheck()`.
- It does **not** classify injection or compute provenance — that is **Safety (05)** / **Gateway (02)**. The BOOTSTRAP conversation runs under `operator` provenance only; an `untrusted` span can never advance setup.
- It does **not** run the nightly batch — that is **Nightly (10)**. `/consolidate` only *triggers* a run through Nightly's existing entrypoint and staging gate.

## 3. Interfaces

Conceptual surface (illustrative TypeScript; this is a spec, not code). CLI verbs are the public contract; the types describe their results.

```ts
// illustrative, not binding

type CheckStatus = "pass" | "warn" | "fail"

type DoctorDomain =
  | "env" | "providers" | "telegram" | "memory" | "vault"
  | "sandbox" | "mcp" | "nightly" | "sidecars" | "disk" | "clock"

interface DoctorCheck {
  id: string                    // stable, e.g. "providers.reasoning.reachable"
  domain: DoctorDomain
  status: CheckStatus
  severity: "critical" | "high" | "medium" | "low"
  detail: string                // human-readable; MUST contain no secret value
  fixable: boolean              // true => a deterministic, non-destructive repair exists
  fixId?: string                // the repair --fix would run
}

interface DoctorReport {
  ok: boolean                   // false iff any check with severity>=high is "fail"
  ranAt: string                 // ISO-8601, injected Clock
  harnessVersion: string
  checks: DoctorCheck[]
}

interface InitStep {
  id: string                    // e.g. "scaffold.env", "validate.telegram-token"
  title: string
  required: boolean
}

type InitOutcome =
  | { step: string; result: "done" | "skipped" | "already-present" }
  | { step: string; result: "failed"; detail: string }  // detail carries no secret

interface InitResult {
  completed: boolean
  outcomes: InitOutcome[]
  scaffolded: string[]          // relative paths written
}

interface OnboardingOps {
  // CLI: `aisy init [--yes] [--force] [--non-interactive]`
  // Detect+validate prereqs, validate credentials, scaffold files, init stores,
  // seed vault, optional pairing. Idempotent; never clobbers without --force.
  init(opts: { yes?: boolean; force?: boolean; nonInteractive?: boolean }): Promise<InitResult>

  // CLI: `aisy doctor [--json] [--fix] [--post-upgrade] [--only=…] [--skip=…]`
  // Read-only by default; --fix applies only checks where fixable===true, each
  // gated. Returns ok:false if any high/critical check fails.
  doctor(opts: { fix?: boolean; postUpgrade?: boolean; only?: DoctorDomain[]; skip?: DoctorDomain[] }): Promise<DoctorReport>

  // CLI: `aisy diagnostics [--out=path]` — redacted support bundle.
  diagnostics(opts: { out?: string }): Promise<{ bundlePath: string; redactedFields: string[] }>
}

// In-session command handlers (invoked by Gateway 02 on an operator slash command).
// Each returns content the Gateway renders; state-mutating ones return a PendingAction
// for Gateway to card (never auto-applied).
interface InSessionCommands {
  status(): Promise<StatusReport>            // /status  — read-only
  usage(period?: "turn" | "session" | "day"): Promise<UsageReport>  // /usage — read-only
  context(): Promise<ContextBreakdown>       // /context — read-only
  runDoctor(): Promise<DoctorReport>         // /doctor  — read-only
  requestConsolidate(): Promise<PendingAction>  // /consolidate — cards, never auto-runs
}
```

Events emitted (to Observability 12): `init.started`, `init.step`, `init.completed`, `doctor.ran`, `doctor.check`, `diagnostics.exported`, `bootstrap.started`, `bootstrap.completed`, `command.invoked`, `upgrade.checked`. Events consumed: `provider.cost.charged` (from Provider 09, ADR-0036, for `/usage`), `pending.action.created` reuse path (to Gateway 02 for config/`/consolidate` cards).

## 4. Data structures

**`DoctorCheck` / `DoctorReport`** (see §3) — the health-check result surface. `detail` is load-bearing for UX and **must be redaction-safe**: it states *what* failed (e.g. "reasoning-tier key rejected with HTTP 401"), never the secret itself. `--json` serialization is deterministic (sorted check ids, `\n` endings) so a CI gate can diff two runs.

**Doctor check matrix** (deterministic, code-fixed — the minimum set a healthy install must pass):

| Domain | Representative checks | Severity on fail |
|---|---|---|
| `env` | required keys present in `.env`; no obviously-placeholder values | critical |
| `providers` | each configured tier (reasoning/critique/routine) key reachable via minimal ping | high |
| `telegram` | bot token valid (`getMe`); exactly one allowlisted `chat_id` set | critical |
| `memory` | memory tree exists; git repo initialized & clean; SQLite `integrity_check` + FTS5 consistency (Memory 03) | high |
| `vault` | vault loads; seeded secrets decrypt; no secret in plaintext outside `.env` | critical |
| `sandbox` | Docker daemon up; sandbox image present; runtime (gVisor/standard); caps dropped (folds `sandbox:doctor`) | high |
| `mcp` | allowlist parses; each pinned server's descriptor hash matches (MCP 07) | high |
| `nightly` | consolidation cron/timer registered and reachable | medium |
| `sidecars` | Whisper model resolvable; `ffmpeg` on PATH | medium |
| `disk` | free space for SQLite + backups above threshold | medium |
| `clock` | system clock sane; timezone resolvable (never the literal `"Auto"`) | low |

**`.env` schema** — `init` writes and `doctor` validates a documented `.env.example`: `AISY_PROVIDER_*_KEY` (per tier), `AISY_TELEGRAM_BOT_TOKEN`, `AISY_TELEGRAM_CHAT_ID`, `AISY_MEMORY_ROOT`, `AISY_DB_PATH`, `AISY_WHISPER_MODEL`, `AISY_BACKUP_REMOTE`, budget ceilings. `.env` and `secrets/` are git-ignored; the schema is the single source of truth both `init` and `doctor` read.

**Scaffolding manifest** — the fixed set of files `init` creates from templates, each only if absent (unless `--force`): `.env`, `SOUL.md`, `constitution.md`, `AGENTS.md`, `USER.md`, and the memory tree skeleton (`constitution.md`, `MEMORY.md`, `working/`, `daily/`, `archive/`). Templates ship with the harness; the operator owns the result.

**Diagnostics bundle manifest** — `meta.json` (harness + component versions, `ranAt`), `doctor.json` (the report), `config.redacted.json` (resolved config with every secret value replaced by `«redacted»` and every vault handle left unresolved), `journal.tail.jsonl` (recent Observability events, secret-redacted per spec 12 CSO-M3). `redactedFields` lists every key whose value was stripped, so the operator can confirm nothing leaked.

**BOOTSTRAP record** — `bootstrap.state.json` (git-ignored): `{ started, completed, stepsDone[] }`. Lets the guided flow resume and prevents re-running it on every session. It carries no secret and no fact content.

## 5. Behavior & control flow

### 5.1 `aisy init` (deterministic; resumable)

```
aisy init
  |
  v
[1] Detect prereqs (Node/pnpm/Docker [, Python/ffmpeg])   -- code; fail => actionable message, exit nonzero
  v
[2] For each credential (provider tiers, Telegram token):
      prompt (or read env in --non-interactive) -> VALIDATE
        provider: minimal reachability ping (Provider 09)
        telegram: getMe
      invalid -> re-prompt (interactive) or fail (non-interactive); secret never logged
  v
[3] Scaffold files from templates — only if absent (else skip unless --force)
      .env, SOUL.md, constitution.md, AGENTS.md, USER.md, memory tree skeleton
  v
[4] Seed vault (Safety 05) with validated secrets; .env holds references/values, never logs
  v
[5] Initialize stores: Memory.rebuildFromFiles() -> SQLite FTS5 index; git init memory repo
  v
[6] Optional: Telegram pairing (issue pairing code; operator confirms) — reuses Gateway authz
  v
[7] Emit init.completed; print next step ("message your bot to start BOOTSTRAP")
```

Idempotency: every step records its `InitOutcome`; re-running yields `already-present`/`skipped` for satisfied steps and only redoes what failed. A crash between steps leaves a partially-scaffolded tree that the next `init` completes — no step destroys a prior step's output without `--force`.

### 5.2 `aisy doctor` (read-only by default)

Runs the §4 matrix. Default mode performs **no writes** — it only probes. `--fix` applies *only* checks with `fixable === true` (e.g. create a missing `daily/` directory, rebuild a corrupt FTS5 index via Memory `rebuildFromFiles()`, register a missing cron), each surfaced before it runs; it **never** applies a repair classified destructive (e.g. it never overwrites a populated `.env`, never deletes memory, never force-pushes). `--post-upgrade` runs the subset that catches migration breakage (schema drift, descriptor-hash mismatch after an MCP bump, a provider model id that no longer resolves). Exit code is nonzero iff `ok === false`.

### 5.3 BOOTSTRAP first-run

On the operator's first message after a fresh `init`, Core (01) loads `BOOTSTRAP.md` into context. The agent walks the operator through: agent name, persona preset (offered as choices, written to `SOUL.md`), default autonomy tier, budget caps, and an optional first memory seed. **Every setting that mutates state is a Gateway (02) config card** — the BOOTSTRAP conversation can *propose*, but the operator's tap is what commits, exactly like any Tier-gated action. The flow runs strictly under `operator` provenance; if any `untrusted` span is present, setup is paused (capability narrowing, ADR-0027). On completion, `bootstrap.state.json.completed = true` and the flow does not re-trigger.

### 5.4 In-session commands

Gateway (02) recognizes operator slash commands and dispatches to `InSessionCommands`. `/status`, `/usage`, `/context`, `/doctor` are **read-only** and stream a formatted reply. `/consolidate` is **state-mutating**: it returns a `PendingAction` that Gateway cards; on confirm it triggers Nightly (10), whose output still lands in the morning staging gate — it is never auto-promoted. Cost figures for `/status` and `/usage` come from the journal's `provider.cost.charged` events (ADR-0036); the command layer only reads and aggregates.

### 5.5 Upgrade

`aisy upgrade` pulls the new version, then **must** run `aisy doctor --post-upgrade` before serving. A failing post-upgrade check blocks traffic and prints the failed checks; the operator fixes (often `--fix`) and re-runs. This is the deterministic guard against the silent-regression failures competitors shipped via fast release cadence.

## 6. Dependencies

Internal:

- **Gateway (02)** — `init`/BOOTSTRAP/`/consolidate` reuse the card lifecycle (`issueCard`/`handleCardTap`, nonce + action-hash); the in-session commands are dispatched by the Gateway.
- **Safety (05)** — owns the vault `init` seeds and the redaction primitive `diagnostics` relies on.
- **Memory (03)** — `init` calls `rebuildFromFiles()`; `doctor` calls `integrityCheck()`.
- **Provider Routing (09)** — `init`/`doctor` issue the per-tier validation ping; `/usage`/`/status` read its cost telemetry (ADR-0036).
- **Nightly (10)** — `/consolidate` triggers a run through Nightly's entrypoint and staging gate.
- **Observability (12)** — sink for all events; source of the journal tail in diagnostics and the cost figures in `/usage`.

External:

- **Node 22 LTS + pnpm ≥9 + Docker ≥24** (optional Python 3.11+/ffmpeg) — the prerequisites `init`/`doctor` detect; packaging contract in ADR-0035.
- **Telegram Bot API** via grammY — `getMe` validation and the BOOTSTRAP/card surface (Gateway 02).

## 7. Failure & degraded modes (mandatory)

| Failure | Trigger | Detection | Behavior | Operator sees | Recovery |
|---|---|---|---|---|---|
| **Missing prerequisite** | Node/pnpm/Docker absent or wrong version | `init` step 1 / `doctor` `sandbox`+`env` | **Fail-closed**: stop with the exact missing tool + how to install; exit nonzero | "Docker ≥24 not found — install and re-run `aisy init`" | Install tool; re-run (idempotent) |
| **Invalid credential** | Provider key/Telegram token rejected | step 2 ping / `getMe` | **Re-prompt** (interactive) or **fail** (non-interactive); secret never logged | "Reasoning-tier key rejected (HTTP 401)" — value never echoed | Supply valid key |
| **Partial init (crash)** | Process killed mid-scaffold | next `init` reads `InitOutcome`s | **Resume**: redo only failed/absent steps; never clobber done steps | Re-run completes remaining steps | Re-run `aisy init` |
| **Subsystem down during doctor** | Vault/Docker/provider unreachable | the domain check errors | **Report `fail`** for that check; other checks still run; never hang | red line for the domain, others green | Fix subsystem; re-run `doctor` |
| **`--fix` repair fails** | Repair errors mid-apply | repair returns error | **Abort that repair**, report it, leave config unchanged; other repairs unaffected | "Could not rebuild index: <reason>" | Manual fix; re-run |
| **Diagnostics over a live secret** | Bundle would include a secret/PII | redaction pass | **Strip + list in `redactedFields`**; never write a raw secret | bundle + "redacted: AISY_PROVIDER_REASONING_KEY, …" | n/a (intended) |
| **`/consolidate` while nightly running** | Manual trigger overlaps the cron run | Nightly run-lock (spec 10) | **Reject/queue** per Nightly's lock; no second concurrent run | "A consolidation is already running" | Wait; retry |
| **Post-upgrade check fails** | Migration broke a contract | `doctor --post-upgrade` | **Block serving**; print failed checks; nonzero exit | failed-check list | `--fix` or manual; re-run |
| **BOOTSTRAP with untrusted span present** | Injection during first-run | provenance != operator (Gateway 02) | **Pause setup**; do not advance on untrusted content | setup waits for a clean operator turn | Operator re-sends |

## 8. Security & threat model

This component handles credentials and exports bundles, so it is security-relevant. STRIDE / OWASP-LLM; each mitigation states code vs model.

| Threat | Vector | Deterministic mitigation (code) | ADR |
|---|---|---|---|
| **Secret leak via diagnostics** (STRIDE-I) | Support bundle contains a key/PII | Redaction pass strips every secret value + leaves vault handles unresolved; `redactedFields` enumerates what was stripped; journal tail reuses spec-12 redaction | ADR-0037, spec 12 (CSO-M3) |
| **Secret leak via logs/console** (STRIDE-I) | `init` echoes a key on validate/fail | Credentials never logged; `detail`/`InitOutcome` carry status, never the value | ADR-0034 |
| **Insecure-by-default install** (STRIDE-E) | Ship with auth off / open port (OpenClaw class) | `init` sets default-deny: single allowlisted `chat_id`, pairing required for any new sender; no network listener exposed by default | ADR-0011, ADR-0034 |
| **Destructive `--fix`** (STRIDE-T/D) | Auto-repair overwrites `.env`/memory/force-pushes | `--fix` applies only `fixable && non-destructive` checks; destructive repairs are never automated; populated files never clobbered without `--force` | ADR-0034 |
| **Model self-completing setup** (OWASP-LLM Excessive Agency) | BOOTSTRAP model claims setup done / writes a secret | Only a Gateway card tap commits a setting; only `init`/vault write secrets; `bootstrap.completed` set by code | ADR-0029 |
| **Injection during onboarding** (OWASP-LLM01) | Untrusted span steers BOOTSTRAP | Setup runs under `operator` provenance only; untrusted span pauses setup (capability narrowing) | ADR-0027, ADR-0028 |
| **Supply-chain via install** (STRIDE-T) | Pinned-binary fetch tampered (Leon class) / unreviewed plugin (OpenClaw class) | Build-from-source or containerized install (ADR-0035); no community skill/plugin registry; MCP stays allowlist + pin + hash (MCP 07) | ADR-0035, ADR-0013 |
| **Cost blindness** (financial DoS) | Operator unaware of runaway spend | `/status`/`/usage` surface live cost from the journal; spend caps stay code-enforced (Provider 09) | ADR-0036, ADR-0018 |

What the model owns here: only the *wording* of the BOOTSTRAP conversation and of `/status`-style replies. Prerequisite detection, credential validation, scaffolding, every health check, redaction, and `bootstrap.completed` are 100% code.

## 9. Acceptance criteria (mandatory)

Each is a single objectively verifiable assertion a Phase-3 test can check.

1. **AC-13-1** — `aisy init --non-interactive` with all required env vars set scaffolds `.env`, `SOUL.md`, `constitution.md`, `AGENTS.md`, `USER.md`, and the memory tree skeleton, and returns `InitResult.completed === true`.
2. **AC-13-2** — Re-running `aisy init` over an already-scaffolded tree returns `already-present`/`skipped` for satisfied steps, writes no file, and never errors. *(idempotency)*
3. **AC-13-3** — `aisy init` with `--force` overwrites a populated scaffolded file; without `--force` the same run leaves it untouched.
4. **AC-13-4** — `aisy init` validates each provider key via a per-tier reachability ping; an invalid key yields a `failed` outcome whose `detail` does **not** contain the key value. *(secret never logged)*
5. **AC-13-5** — `aisy init` validates the Telegram token via `getMe`; an invalid token blocks completion in `--non-interactive` mode with a redacted error.
6. **AC-13-6** — After `aisy init`, the memory SQLite index exists and `Memory.integrityCheck()` returns `ok: true`. *(store initialized)*
7. **AC-13-7** — A crash simulated between scaffold steps leaves a partial tree that a second `aisy init` completes, redoing only the missing steps. *(resumable)*
8. **AC-13-8** — `aisy doctor` on a healthy install returns `DoctorReport.ok === true` with every check `pass`, and performs **zero writes** (assert no file/db mutation). *(read-only default)*
9. **AC-13-9** — `aisy doctor` with an injected fault (missing required env key) returns `ok === false` and exactly one `fail` check in domain `env` with `severity: "critical"`.
10. **AC-13-10** — `aisy doctor` with a corrupt SQLite index reports a `memory` `fail`; `aisy doctor --fix` rebuilds it via `rebuildFromFiles()` and a subsequent `doctor` returns the `memory` check to `pass`. *(fixable)*
11. **AC-13-11** — `aisy doctor --fix` never applies a repair classified destructive: a populated `.env` is not overwritten, no memory fact is deleted, no git force-push occurs (assert those mutations did not happen). *(no destructive auto-fix)*
12. **AC-13-12** — `aisy doctor --json` output is deterministic (byte-identical across two runs over identical state) and contains no secret value. *(redacted, reproducible)*
13. **AC-13-13** — `aisy doctor --post-upgrade` fails when an MCP descriptor hash no longer matches its pin and blocks with a nonzero exit. *(upgrade guard)*
14. **AC-13-14** — `aisy doctor` folds the legacy Docker checks: with the Docker daemon down it returns a `sandbox` `fail`, replacing `pnpm sandbox:doctor`.
15. **AC-13-15** — `aisy diagnostics` writes a bundle whose `config.redacted.json` contains `«redacted»` for every secret value and lists each in `redactedFields`; a scan of the whole bundle finds no raw secret. *(zero leakage)*
16. **AC-13-16** — The diagnostics journal tail is secret-redacted (no vault value appears) consistent with spec-12 CSO-M3.
17. **AC-13-17** — On the operator's first message after `init`, BOOTSTRAP loads and the agent proposes setup steps; no setting is committed until a Gateway card tap, and `bootstrap.state.completed` is set only by code on completion. *(card-gated, model cannot self-complete)*
18. **AC-13-18** — A BOOTSTRAP turn carrying an `untrusted` span does not advance setup (no step recorded done). *(injection during onboarding)*
19. **AC-13-19** — `/status` returns the current per-tier model routing, context fill, and last-turn + session cost, performing no state mutation.
20. **AC-13-20** — `/usage` aggregates `provider.cost.charged` journal events into a per-tier/period breakdown that equals the summed per-call charges. *(cost transparency, ADR-0036)*
21. **AC-13-21** — `/context` reports the injected files/tools/skills and their sizes without exposing any secret or full memory fact body.
22. **AC-13-22** — `/doctor` runs the health-check and returns a summary card; it is read-only.
23. **AC-13-23** — `/consolidate` returns a `PendingAction` that the Gateway cards; on confirm it triggers Nightly (10) whose result lands in the staging gate and is **not** auto-promoted; without confirm, no consolidation runs. *(human-gated)*
24. **AC-13-24** — A `/consolidate` issued while a nightly run holds the run-lock is rejected/queued and never starts a second concurrent run. *(spec 10 lock)*

## 10. Open questions

- **Wizard surface.** Whether `aisy init` ships a TUI or plain sequential prompts by default (both satisfy the non-interactive contract) is a roadmap/devex decision; the spec requires only the validated, idempotent, resumable behavior.
- **`--fix` scope ceiling.** The exact set of repairs classified safe-and-non-destructive is finalized with Safety (05); the spec fixes the *invariant* (never destructive, never clobber without `--force`), not the full list.
- **Setup second factor.** Whether committing a budget cap / autonomy default via a config card requires the same step-up as a Tier-3 action (ADR-0029) is deferred to Safety policy.
- **i18n.** All `doctor`/`init`/command output is English-only for the single technical operator; localization is explicitly out of scope for this milestone (no roadmap item).

## 11. References

- ADRs:
  - [ADR-0034 — Onboarding & operations layer](../decisions/2026-06-11-onboarding-operations-layer.md)
  - [ADR-0035 — Install & packaging](../decisions/2026-06-11-install-and-packaging.md)
  - [ADR-0036 — Cost-transparency surfacing](../decisions/2026-06-11-cost-transparency-surfacing.md)
  - [ADR-0037 — Eval & red-team harness](../decisions/2026-06-11-eval-and-red-team-harness.md)
  - [ADR-0011 — Autonomy gradient (tiers 0–3)](../decisions/2026-06-11-autonomy-gradient.md)
  - [ADR-0012 — Docker sandbox as default](../decisions/2026-06-11-docker-sandbox-default.md)
  - [ADR-0014 — Narrow-waist tool set](../decisions/2026-06-11-narrow-waist-tool-set.md)
  - [ADR-0029 — Human-confirmation provenance and approval integrity](../decisions/2026-06-11-human-confirmation-provenance-binding.md)
- Specs: [02 Gateway](./02-gateway-connectivity.md), [03 Memory](./03-memory.md), [05 Safety](./05-safety.md), [09 Provider Routing](./09-provider-routing.md), [10 Nightly Consolidation](./10-nightly-consolidation.md), [12 Observability & Verification](./12-observability-verification.md)
