# Component 13: Onboarding & Operations — Specification

**Status:** Draft
**Component:** 13 / 17
**Related ADRs:** ADR-0034, ADR-0035, ADR-0036, ADR-0037, ADR-0011, ADR-0012, ADR-0014, ADR-0029
**Depends on:** Gateway (02), Memory (03), Safety (05), Provider Routing (09), Nightly Consolidation (10), Observability & Verification (12)

> Onboarding & Operations is the harness's **operational shell**: the deterministic code that takes a fresh clone from zero to a running, *validated* agent (`aisy init`), proves the whole stack is healthy at any time (`aisy doctor`), exports a redacted support bundle (`aisy diagnostics`), and gives the operator a guided first-run conversation plus in-session control commands over Telegram — without ever requiring the engine to be re-implemented and without hiding any of it behind a UI that cannot be edited by hand.

## 1. Purpose

Every prior component (01–12) assumes it is already configured: a vault holds the keys, the memory tree exists and is indexed, the Telegram token is valid, the sandbox image is built. **Nothing in the harness gets the operator to that state.** Today the only path is hand-editing `.env` and reading logs, and the only health probe is `pnpm sandbox:doctor`, which checks Docker and nothing else. A competitive audit of nine comparable harnesses found that the two that won adoption both ship a setup wizard, a `doctor` health-check, and a guided first-run, while several that lacked spend caps, default-deny, or sandboxing shipped catastrophic day-0 failures (publicly-exposed instances, runaway bills, destructive auto-runs). This component closes that gap as **code**, not as a no-code product.

In the OS-around-the-model thesis this component is almost entirely **deterministic code (100%)**: prerequisite detection, credential validation, file scaffolding, store initialization, every health check, and the redaction of the diagnostics bundle are all code. The model is involved (~70%) in exactly one place — the *wording* of the BOOTSTRAP guided-setup conversation, shaped by Personality (08) — and even there it can only ask questions and explain; it cannot write a secret, confirm a card, or mark setup complete. ADR-0034 records that adding this shell does **not** make Aisy a no-code product: every artifact `init` scaffolds (`.env`, `SOUL.md`, `constitution.md`, `AGENTS.md`, `USER.md`) remains a plain file the operator edits directly, and `doctor` only *reports* (and, with explicit opt-in, repairs) — it never silently rewrites the operator's configuration.

Concretely the shell exists to do five deterministic jobs the engine cannot do for itself: (1) **scaffold and validate** a working configuration from nothing (`aisy init`); (2) **verify the whole stack** end-to-end at any time and after upgrades (`aisy doctor`); (3) **export a redacted support bundle** with zero secret leakage (`aisy diagnostics`); (4) **walk a first-time operator** from "bot is reachable" to "agent is configured" via a BOOTSTRAP conversation and config cards; (5) **surface cost and control** in-session (`/status`, `/usage`, `/context`, `/doctor`, `/consolidate`) so the operator is never surprised by spend (ADR-0036) and never has to leave Telegram to run a health check.

## 2. Responsibilities

What this component **owns**:

- **`aisy init`** — the interactive setup wizard and its non-interactive (`--yes` / env-driven) twin for CI and reproducible installs. Detects and validates prerequisites (Node 22 LTS, pnpm ≥9, Docker ≥24, optional Python 3.11+/ffmpeg); prompts for and **validates** provider API keys (per-tier reachability ping) and the Telegram bot token (`getMe`); scaffolds `.env` from `.env.example` and `SOUL.md`/`constitution.md`/`AGENTS.md`/`USER.md` from templates; initializes the memory git repo and the SQLite FTS5 index by calling Memory (03) `rebuildFromFiles(workspaceLease)`; seeds the vault via Safety (05); optionally completes Telegram pairing. **Idempotent and resumable** — re-running never clobbers an already-populated file without explicit `--force`.
- **`aisy doctor`** — full-stack health-check текущей production-композиции. Он
  проверяет не исторический список инструментов, а включённые LIVE-пути:
  protected scoped memory, встроенный scheduler, durable-выбор провайдера
  транскрипции и Docker только для реально активированной Docker-функции.
  Результат каждой проверки — `pass | warn | fail` с redaction-safe detail.
  Флаги: `--json`, `--fix`, `--post-upgrade`, `--only`/`--skip`.
- **`aisy diagnostics`** — a redacted support-bundle exporter: harness version, resolved config (secret values stripped), the `doctor` report, recent journal tail (Observability 12), and component versions, written to a single archive for bug reports. No secret value, no vault handle resolution, and no memory fact content ever enters the bundle.
- **The BOOTSTRAP first-run flow** — `BOOTSTRAP.md`, read by the agent on the operator's first message, that drives a guided conversation (agent name, persona preset, default autonomy tier, budget caps, optional memory seed) using Gateway (02) config **cards** for any setting that mutates state.
- **In-session control commands** over Telegram: `/status` (current model routing, context fill, last-turn + session cost), `/usage` (cost breakdown by tier/period from the journal), `/context` (what is injected: files, tools, skills, sizes), `/doctor` (run the health-check and return a summary card), `/consolidate` (trigger a nightly consolidation pass on demand — ADR-0010-style, routed to Nightly 10's staging gate, never auto-promoted).
- **The upgrade entrypoint** — `aisy upgrade` semantics and the `doctor --post-upgrade` contract that must pass before a new version serves traffic.
- **The install/packaging contract** (ADR-0035) — the one-liner bootstrap script and Docker Compose that land the operator at the `aisy init` step.

What this component **does not** do (boundary → owner):

- It does **not** own the approval-card lifecycle, nonce, or action-hash — that is **Gateway (02)**. Config cards and the BOOTSTRAP flow **reuse** `issueCard`/`handleCardTap`; this component only constructs the `PendingAction`s.
- It does **not** implement the vault, encryption, or secret storage — that is **Safety (05)**. `init` *seeds* secrets through the Safety API and never writes a key to disk in plaintext outside `.env` (which is git-ignored and the operator's own file).
- It does **not** route, price, or call models in normal operation — that is **Provider Routing (09)**. `init`/`doctor` only issue a minimal reachability ping per configured tier to validate a key; `/usage`/`/status` only *read* the cost telemetry the router emits (ADR-0036).
- It does **not** author, index, or forget memory facts — that is **Memory (03)**. `init` only triggers the initial `rebuildFromFiles(workspaceLease)`; `doctor` only runs Memory's `integrityCheck(workspaceLease)`.
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
| `telegram` | bot token valid (`getMe`); exactly one allowlisted `chat_id`; execution-card checkpoint absent/clean, pending/corrupt recovery state | critical для identity, high для checkpoint |
| `memory` | global DNA; identity/schema/`integrity_check` ledger, keyword projection и scope barrier защищённой global memory; число живых ledger-записей совпадает с keyword projection | high |
| `vault` | vault loads; seeded secrets decrypt; no secret in plaintext outside `.env` | critical |
| `sandbox` | если включён Docker-backed LIVE-путь — daemon/image/caps; для enabled restricted clone — Engine ≥29.5.2 и оба exact RepoDigest локально; если ни один путь не включён — `warn` без обращения к Docker | high |
| `mcp` | allowlist parses; each pinned server's descriptor hash matches (MCP 07) | high |
| `nightly` | валидное `HH:MM` встроенного scheduler и missed-slot catch-up; внешний cron не требуется | medium |
| `sidecars` | durable-выбор provider транскрипции (`ready`/`unconfigured`/`quarantined`/`corrupt`); kernel lease журнала absent/held, но не corrupt; media inbox writer lock absent/held и recovery archives structurally valid | high для structural `corrupt`, medium для optional `unconfigured`/`quarantined` |
| `disk` | free space for SQLite + backups above threshold | medium |
| `clock` | system clock sane; timezone resolvable (never the literal `"Auto"`) | low |

**`.env` schema** — `init` writes and `doctor` validates a documented `.env.example`: `AISY_PROVIDER_*_KEY` (per tier), `AISY_TELEGRAM_BOT_TOKEN`, `AISY_TELEGRAM_CHAT_ID`, `AISY_MEMORY_ROOT`, `AISY_DB_PATH`, `AISY_WHISPER_MODEL`, `AISY_BACKUP_REMOTE`, budget ceilings. Restricted clone остаётся выключенным без `AISY_RESTRICTED_CLONE_ENABLED=true`; перед включением обязательны `AISY_RESTRICTED_CLONE_WORKER_IMAGE` и `AISY_RESTRICTED_CLONE_GATEWAY_IMAGE` в форме `name@sha256:<digest>`. `.env` и `secrets/` git-ignored; схема является общей authority для `init` и `doctor`.

**Scaffolding manifest** — the fixed set of files `init` creates from templates, each only if absent (unless `--force`): `.env`, `SOUL.md`, `constitution.md`, `AGENTS.md`, `USER.md`, and the memory tree skeleton (`constitution.md`, `MEMORY.md`, `working/`, `daily/`, `archive/`). Templates ship with the harness; the operator owns the result.

**Нормативное уточнение ADR-0063:** текущий scaffolding manifest создаёт под
`memory/` все 11 global DNA files в том же code-owned порядке, что использует
`readFrozenSnapshot`: `constitution.md`, `SOUL.md`, `USER.md`, `MEMORY.md`,
`MISSION.md`, `GOALS.md`, `PROJECTS.md`, `PREFERENCES.md`, `LEARNED.md`,
`CLAUDE.md`, `SERVICES.md`. Существующие bytes не перезаписываются без
`--force`; generated `MEMORY.md` и `PROJECTS.md` затем обновляются только
своими code-owned projections.

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
[5] Initialize stores: Memory.rebuildFromFiles(workspaceLease) -> SQLite FTS5 index; git init memory repo
  v
[6] Optional: Telegram pairing (issue pairing code; operator confirms) — reuses Gateway authz
  v
[7] Emit init.completed; print next step ("message your bot to start BOOTSTRAP")
```

Idempotency: every step records its `InitOutcome`; re-running yields `already-present`/`skipped` for satisfied steps and only redoes what failed. A crash between steps leaves a partially-scaffolded tree that the next `init` completes — no step destroys a prior step's output without `--force`.

### 5.2 `aisy doctor` (read-only by default)

Runs the §4 matrix. Default mode performs **no writes** — it only probes.
`--fix` applies only explicitly repairable legacy checks. Protected scoped memory
не имеет file-authoritative rebuild (ADR-0074), поэтому её integrity failure
никогда не предлагает `memory.rebuild-index`. Встроенный scheduler не создаёт
crontab. `--post-upgrade` сохраняет fail-closed gates миграции, MCP descriptor
pins и каждого действительно включённого Docker-пути. Exit code is nonzero iff
`ok === false`.

`--post-upgrade`, `--only` и `--skip` ограничивают не только итоговый
отчёт, но и исполнение probes до любого внешнего I/O. Validator исключённого
domain не вызывается: в частности, migration-only или post-upgrade doctor не
делает скрытый Telegram `getMe`, а domain-only doctor не пингует provider.

Held transcript kernel lease означает, что точный SQLite lease сейчас удерживает
живой writer, и потому является `pass`, а не «зависшим lock». Corrupt/unsafe
lease остаётся high-severity fail. Held media-inbox writer остаётся warning:
его формат доказывает ownership, но не даёт Doctor права на recovery.

App injects a strictly read-only `telegram.execution-checkpoint` probe into the
real `aisy doctor`. Missing state is a healthy default-off/rollback path;
terminal delivered state is clean. Pending/ambiguous recovery либо corrupt/
unsafe bytes дают high-severity fail. Detail не содержит path, raw chat/turn
binding, owner id, revision или transport error. Даже `doctor --fix` не создаёт
state directory, не меняет checkpoint и не вызывает Telegram: recovery требует
отдельных exact binding и service-manager quiescence.

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
- **Memory (03)** — `init` calls `rebuildFromFiles(workspaceLease)`; `doctor` calls `integrityCheck(workspaceLease)`.
- **Provider Routing (09)** — `init`/`doctor` issue the per-tier validation ping; `/usage`/`/status` read its cost telemetry (ADR-0036).
- **Nightly (10)** — `/consolidate` triggers a run through Nightly's entrypoint and staging gate.
- **Observability (12)** — sink for all events; source of the journal tail in diagnostics and the cost figures in `/usage`.

External:

- **Node 22 LTS + pnpm ≥9 + Docker ≥24** для общего opt-in bash sandbox; restricted public clone требует **Docker Engine ≥29.5.2**. Optional Python 3.11+/ffmpeg проверяются отдельно; packaging contract — ADR-0035.
- **Telegram Bot API** via grammY — `getMe` validation and the BOOTSTRAP/card surface (Gateway 02).

## 7. Failure & degraded modes (mandatory)

| Failure | Trigger | Detection | Behavior | Operator sees | Recovery |
|---|---|---|---|---|---|
| **Missing required prerequisite** | Инструмент отсутствует у включённого LIVE-пути | `init` / соответствующий Doctor probe | **Fail-closed** для этого пути; выключенная optional-функция остаётся warning | Точная code-owned причина без raw stderr/path | Install tool либо оставь функцию выключенной; re-run |
| **Restricted clone не готов** | Enablement=true, но Docker <29.5.2, tag вместо digest либо образ отсутствует | `sandbox.restricted-clone` | **Fail-closed без Docker mutation**; post-upgrade также блокируется | русская причина без image ref/секрета | обновить runtime/загрузить pinned images; повторить doctor |
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
6. **AC-13-6** — After `aisy init`, the memory SQLite index exists and `Memory.integrityCheck(workspaceLease)` returns `ok: true`. *(store initialized)*
7. **AC-13-7** — A crash simulated between scaffold steps leaves a partial tree that a second `aisy init` completes, redoing only the missing steps. *(resumable)*
8. **AC-13-8** — `aisy doctor` on a healthy install returns `DoctorReport.ok === true` with every check `pass`, and performs **zero writes** (assert no file/db mutation). *(read-only default)*
9. **AC-13-9** — `aisy doctor` with an injected fault (missing required env key) returns `ok === false` and exactly one `fail` check in domain `env` with `severity: "critical"`.
10. **AC-13-10** — legacy composition с repairable SQLite index допускает
    `rebuildFromFiles`; production protected scoped memory проверяет точные
    global ledger/keyword/barrier identity, schema, integrity и projection
    consistency read-only, возвращает `fixable:false` и никогда не вызывает
    legacy rebuild даже с `--fix`.
11. **AC-13-11** — `aisy doctor --fix` never applies a repair classified destructive: a populated `.env` is not overwritten, no memory fact is deleted, no git force-push occurs (assert those mutations did not happen). *(no destructive auto-fix)*
12. **AC-13-12** — `aisy doctor --json` output is deterministic (byte-identical across two runs over identical state) and contains no secret value. *(redacted, reproducible)*
13. **AC-13-13** — `aisy doctor --post-upgrade` fails when an MCP descriptor hash no longer matches its pin and blocks with a nonzero exit. *(upgrade guard)*
14. **AC-13-14** — при включённом Docker-backed пути `aisy doctor` возвращает
    `sandbox fail` для остановленного daemon и различает socket permission,
    отсутствие CLI и unknown failure без raw stderr/path; при отсутствии таких
    путей возвращает warning и выполняет zero Docker calls.
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
25. **AC-13-25** — выключенный restricted clone возвращает `sandbox.restricted-clone=warn`, выполняет zero writes и не становится активным.
26. **AC-13-26** — включённый restricted clone с Docker 27.4.0, malformed enablement, tag reference, отсутствующим либо несовпадающим RepoDigest возвращает high-severity `fail`; image reference не исполняется как option/command.
27. **AC-13-27** — `doctor --post-upgrade` включает sandbox compatibility и проходит restricted clone только при Docker ≥29.5.2 и двух локальных exact RepoDigest.
28. **AC-13-28** — fresh `init` создаёт все 11 ADR-0063 global DNA files
    строго под `memory/`; manifest byte-for-byte совпадает с code-owned
    `GLOBAL_DNA_PREFIX_FILES`, повторный init ничего не перезаписывает, а
    partial restart создаёт только отсутствующие files.
29. **AC-13-29** — read-only doctor возвращает `memory.global-dna=fail`, если
    отсутствует хотя бы один manifest file; detail содержит только количество,
    а `--fix` не создаёт и не перезаписывает operator-owned DNA.
30. **AC-13-30** — optional read-only `migration.workspace-v2-readiness`
    возвращает warning для `not-prepared`, pass только для полного
    `ready-for-approval`/здорового forward-repair evidence и high-severity fail
    для incomplete/tampered runtime; проверка входит в `--post-upgrade` и не
    выполняет ни одной записи.
31. **AC-13-31** — readiness verdict до `V2_WRITES_ENABLED` требует проверенных
    backup, rollback rehearsal и exclusive-lock availability; после включения
    writes он запрещает automatic rollback независимо от старых backup и
    требует forward repair. Любая ошибка probe редактируется до русской
    code-owned причины без внутренних путей.
32. **AC-13-32** — Node readiness composition преобразует missing manifest в
    `not-prepared`, а corrupt/tampered registry или memory bundle — в
    fail-closed evidence, не раскрывая exception/path. Инспекторы не вызывают
    persistence writes и не захватывают migration lock; activation обязана
    повторно проверить bundles уже под lock.
33. **AC-13-33** — optional `sidecars.media-inbox-writer-lock` является строго
    read-only: absent lock даёт pass, corrupt — high-severity fail, held и
    abandoned — предупреждение; `doctor --fix` не архивирует и не изменяет lock,
    не выполняет retention и не завершает pending GC, а detail не содержит path,
    owner nonce, fingerprint или raw probe error. Bounded cleanup выполняется
    только startup-кодом под exact held/idle singleton writer либо до archive
    доказанно dead writer через descriptor-relative one-shot boundary по
    AC-02-53a; валидный набор 65..256 при absent/held/abandoned до startup даёт
    warning, а не блокирует repair-код. После startup Doctor видит не более
    восьми structurally-valid archives у live writer. Набор >256 остаётся
    high-severity fail. Runtime отдельно сообщает code-only busy и необходимость
    проверить recovery-state через `aisy doctor`, не называя любую ошибку живым
    writer.
34. **AC-13-34** — реальный `aisy doctor` получает read-only
    `telegram.execution-checkpoint`: absent/clean дают pass, pending/corrupt —
    high-severity fail; `--fix` выполняет zero filesystem/Telegram writes, а
    detail не раскрывает path, binding, owner, revision или raw probe error.

34a. **AC-13-34a** — production Doctor проверяет durable-выбор текущего
    transcription provider тем же schema/disclosure revision/hash контрактом,
    что live registry: ready=pass, отсутствующий выбор=warning/text-only, а
    stale/unsafe durable choice=`quarantined` warning с явной изоляцией voice.
    Он не даёт selected external provider и создаёт zero external audio egress
    до нового выбора; зарегистрированный safe local provider может остаться
    локальным fallback.
    `corrupt` registry/probe, повреждение root-owned voice runtime или
    readiness-конфликт уже выбранного provider остаются high fail. Host
    `ffmpeg` не проверяется для cloud provider.

34b. **AC-13-34b** — валидный held transcript SQLite kernel lease даёт pass,
    absent даёт pass, corrupt/unsafe даёт high fail; probe не раскрывает
    identity/path и не создаёт, не освобождает и не ремонтирует lease.

34c. **AC-13-34c** — `nightly.cron` в production означает валидный `HH:MM`
    встроенного scheduler с missed-slot catch-up, возвращает `fixable:false` и
    никогда не читает/не регистрирует crontab.

35. **AC-13-35** — Остановка идущего хода доступна с самой карточки выполнения:
    пока ход идёт, карточка несёт кнопку остановки, тап делает ровно то же, что
    `/stop` (сброс буфера, отмена хода, остановка активной цели), а карточка,
    пережившая ход, теряет кнопку — останавливать больше нечего. Тап по
    осиротевшей кнопке отвечает словами, а не молчанием.
36. **AC-13-36** — Каждая операторская возможность, существовавшая только как
    команда с позиционными аргументами, достижима кнопками: разрешения и их
    сброс, операции доступа к серверу из конфигурации установки (беcключевые —
    одним тапом, `add-key`/`remove-key` — формой на одно сообщение), добавление
    бота в реестр, ночная консолидация и список правок памяти на проверке.
    Форма живёт не дольше пяти минут и снимается при уходе на другой экран,
    чтобы обычное сообщение не было съедено как ответ формы.
37. **AC-13-37** — Экран 🎯 Цели показывает единственную возможную цель как
    прогресс — формулировку, режим, статус, израсходованные итерации и деньги
    против потолка, последнюю проверку — и предлагает остановку только тогда,
    когда цель ещё идёт. Остановка перерисовывает экран пустым, а не отвечает
    словом «готово». Пустой экран объясняет, чем цель отличается от задачи и
    таймера, вместо того чтобы показывать пустую карточку.
38. **AC-13-38** — Обход всех кнопок бота — детерминированный тест, а не
    ревью: он тапает каждую метку меню, обходит в ширину каждую inline-кнопку и
    требует видимого ответа (одного `answerCallbackQuery` недостаточно), плюс
    статически проверяет, что живая композиция передаёт порт под каждый экран,
    который бот показывает.
39. **AC-13-39** — Идущая цель публикует состояние: карточка отправляется один
    раз до первой итерации и дальше редактируется на месте после каждой —
    повтор того же состояния не порождает правки. Цель, дошедшая до конца,
    отпускает карточку: она остаётся в чате как отчёт без кнопки остановки, а
    следующая цель заводит свою. Сбой доставки карточки не останавливает работу.
40. **AC-13-40** — Идущее исследование (`deep_research`, ADR-0097) публикует
    пульс: карточка 🔬 отправляется до первой страницы и редактируется на
    месте после каждой подтверждённой — отвергнутая страница пульса не даёт,
    повтор того же состояния не порождает правки. Карточка без кнопок (ход
    останавливает своя ⏹-карточка выполнения); в конце она закрывается строкой
    о причине ранней остановки, если та была, и отпускается — следующее
    исследование заводит свою. Сбой доставки карточки не останавливает поиск.
41. **AC-13-41** — `doctor --post-upgrade`, `--only` и `--skip` применяют
    domain filter до исполнения network validators: исключённый Telegram
    `getMe` и provider ping не вызываются и не могут блокировать выбранный
    read-only corpus.

## 10. Open questions

- **Wizard surface.** Whether `aisy init` ships a TUI or plain sequential prompts by default (both satisfy the non-interactive contract) is a roadmap/devex decision; the spec requires only the validated, idempotent, resumable behavior.
- **`--fix` scope ceiling.** The exact set of repairs classified safe-and-non-destructive is finalized with Safety (05); the spec fixes the *invariant* (never destructive, never clobber without `--force`), not the full list.
- **Setup second factor.** Whether committing a budget cap / autonomy default via a config card requires the same step-up as a Tier-3 action (ADR-0029) is deferred to Safety policy.
- **Язык.** Новая публичная диагностика и документация пишутся по-русски согласно правилам репозитория; legacy English-текст переводится отдельными хирургическими инкрементами без изменения протокольных id.

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
