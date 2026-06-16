// Component 13: Onboarding & Operations — types (extracted from spec §3 / §4).
// Pure interfaces + injected-deps port seams. No implementation here.
//
// This component is the operational shell: deterministic code that takes a
// fresh clone from zero to a running, validated agent (`aisy init`), proves
// the stack healthy (`aisy doctor`), exports a redacted support bundle
// (`aisy diagnostics`), and surfaces cost/control in-session. Everything here
// is deterministic; the model only shapes BOOTSTRAP wording (never state).

import type { PendingAction } from '../gateway/types.js'

export type { PendingAction } from '../gateway/types.js'

// ---------------------------------------------------------------------------
// Doctor surface (spec §3, §4)
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail'

export type CheckSeverity = 'critical' | 'high' | 'medium' | 'low'

export type DoctorDomain =
  | 'env'
  | 'providers'
  | 'telegram'
  | 'memory'
  | 'vault'
  | 'sandbox'
  | 'mcp'
  | 'nightly'
  | 'sidecars'
  | 'disk'
  | 'clock'

export interface DoctorCheck {
  /** Stable id, e.g. "providers.reasoning.reachable". */
  id: string
  domain: DoctorDomain
  status: CheckStatus
  severity: CheckSeverity
  /** Human-readable; MUST contain no secret value (redaction-safe). */
  detail: string
  /** true => a deterministic, non-destructive repair exists. */
  fixable: boolean
  /** The repair `--fix` would run. */
  fixId?: string
}

export interface DoctorReport {
  /** false iff any check with severity>=high is "fail" (§3). */
  ok: boolean
  /** ISO-8601, injected Clock. */
  ranAt: string
  harnessVersion: string
  checks: DoctorCheck[]
}

// ---------------------------------------------------------------------------
// Init surface (spec §3, §5.1)
// ---------------------------------------------------------------------------

export interface InitStep {
  /** e.g. "scaffold.env", "validate.telegram-token". */
  id: string
  title: string
  required: boolean
}

export type InitOutcome =
  | { step: string; result: 'done' | 'skipped' | 'already-present' }
  /** detail carries no secret. */
  | { step: string; result: 'failed'; detail: string }

export interface InitResult {
  completed: boolean
  outcomes: InitOutcome[]
  /** Relative paths written this run. */
  scaffolded: string[]
}

// ---------------------------------------------------------------------------
// In-session command result shapes (spec §3, §5.4)
// ---------------------------------------------------------------------------

export type RouteTier = 'reasoning' | 'critique' | 'routine'

export interface StatusReport {
  /** Current per-tier model routing (tier -> model id). */
  routing: Record<RouteTier, string>
  /** Context window fill 0..1. */
  contextFill: number
  /** Dollar cost of the last turn. */
  lastTurnCostUsd: number
  /** Dollar cost of the whole session. */
  sessionCostUsd: number
}

export type UsagePeriod = 'turn' | 'session' | 'day'

export interface UsageReport {
  period: UsagePeriod
  /** Per-tier dollar breakdown over the period. */
  byTier: Record<RouteTier, number>
  /** Total dollars over the period; equals the summed per-call charges. */
  totalUsd: number
}

export interface ContextItem {
  kind: 'file' | 'tool' | 'skill'
  name: string
  /** Size in bytes/tokens; surface metric only, never the content. */
  size: number
}

export interface ContextBreakdown {
  items: ContextItem[]
  totalSize: number
}

// ---------------------------------------------------------------------------
// BOOTSTRAP record (spec §4)
// ---------------------------------------------------------------------------

export interface BootstrapState {
  started: boolean
  completed: boolean
  stepsDone: string[]
}

// ---------------------------------------------------------------------------
// Public CLI / command interfaces (spec §3)
// ---------------------------------------------------------------------------

export interface OnboardingOps {
  /**
   * CLI: `aisy init [--yes] [--force] [--non-interactive]`.
   * Detect+validate prereqs, validate credentials, scaffold files, init
   * stores, seed vault. Idempotent; never clobbers without --force.
   */
  init(opts: { yes?: boolean; force?: boolean; nonInteractive?: boolean }): Promise<InitResult>

  /**
   * CLI: `aisy doctor [--json] [--fix] [--post-upgrade] [--only=…] [--skip=…]`.
   * Read-only by default; --fix applies only fixable===true repairs, each
   * gated and non-destructive. ok:false iff any high/critical check fails.
   */
  doctor(opts: {
    fix?: boolean
    postUpgrade?: boolean
    only?: DoctorDomain[]
    skip?: DoctorDomain[]
  }): Promise<DoctorReport>

  /**
   * Deterministic, byte-stable serialization of a DoctorReport for `--json`
   * (sorted check ids, \n endings, secret-free). Pure helper exposed so a CI
   * gate can diff two runs (AC-13-12).
   */
  toJson(report: DoctorReport): string

  /** CLI: `aisy diagnostics [--out=path]` — redacted support bundle. */
  diagnostics(opts: { out?: string }): Promise<{ bundlePath: string; redactedFields: string[] }>
}

export interface InSessionCommands {
  /** /status — read-only. */
  status(): Promise<StatusReport>
  /** /usage — read-only. */
  usage(period?: UsagePeriod): Promise<UsageReport>
  /** /context — read-only. */
  context(): Promise<ContextBreakdown>
  /** /doctor — read-only. */
  runDoctor(): Promise<DoctorReport>
  /** /consolidate — returns a PendingAction the Gateway cards; never auto-runs. */
  requestConsolidate(): Promise<PendingAction>
}

// ---------------------------------------------------------------------------
// Injected-deps PORT seams (narrow local interfaces; tests inject fakes).
// Each port is a thin abstraction over a sibling component (Memory 03,
// Safety 05, Provider 09, Nightly 10, Observability 12, Telegram). We do NOT
// import implementation internals — only these narrow shapes.
// ---------------------------------------------------------------------------

/** Clock seam — deterministic ISO time for ranAt / records. */
export interface Clock {
  nowIso(): string
}

/** Filesystem port — every scaffold/probe write goes through here so tests
 * can assert zero writes in read-only doctor (AC-13-8). */
export interface FsPort {
  exists(path: string): boolean
  /** true if the file exists AND has non-template/non-empty content. */
  isPopulated(path: string): boolean
  read(path: string): string
  write(path: string, content: string): void
  mkdirp(path: string): void
}

/** Prerequisite detection port (Node/pnpm/Docker [, Python/ffmpeg]) (§5.1[1]). */
export interface PrereqPort {
  /** Resolved version string, or null if the tool is absent. */
  version(tool: 'node' | 'pnpm' | 'docker' | 'python' | 'ffmpeg'): string | null
}

/** Credential validators — INJECTED so init/doctor never hit a real network.
 * Implementations return only a status; they NEVER echo the secret value. */
export interface CredentialValidators {
  /** Per-tier provider reachability ping (Provider 09). */
  pingProvider(tier: RouteTier, key: string): Promise<{ ok: boolean; httpStatus?: number }>
  /** Telegram getMe token validation. */
  telegramGetMe(token: string): Promise<{ ok: boolean; httpStatus?: number }>
  /** Recent inbound updates — used for terminal pairing (capture the chat that
   *  sends the pairing code). Optional: absent ⇒ pairing falls back to manual. */
  telegramGetUpdates?(token: string): Promise<{ ok: boolean; updates?: TelegramPairUpdate[] }>
}

/** A minimal inbound update for pairing: who sent what. */
export interface TelegramPairUpdate {
  chatId: number
  text: string
  username?: string
}

/** Interactive terminal I/O port — injected so the wizard is testable with a
 *  scripted double; the real adapter is readline. Absent ⇒ non-interactive. */
export interface PromptPort {
  /** Free-text question with an optional default (shown, returned on empty). */
  ask(question: string, opts?: { default?: string }): Promise<string>
  /** Secret entry (no echo) — API keys, bot tokens. */
  secret(question: string): Promise<string>
  /** Yes/no confirmation. */
  confirm(question: string, opts?: { default?: boolean }): Promise<boolean>
  /** Print an informational line to the operator. */
  info(message: string): void
}

/** Memory port (Memory 03) — init triggers rebuild; doctor checks integrity. */
export interface MemoryPort {
  rebuildFromFiles(): Promise<void>
  integrityCheck(): Promise<{ ok: boolean; detail?: string }>
  /** Number of live (un-deleted) facts; doctor --fix must not reduce this. */
  liveFactCount(): number
}

/** Vault port (Safety 05) — init seeds; doctor verifies decrypt; diagnostics
 * redacts through it. We never write a key to disk in plaintext here. */
export interface VaultPort {
  seed(name: string, value: string): void
  /** true if the vault loads and seeded secrets decrypt. */
  loads(): boolean
  /** The set of secret VALUES, used to redact bundles + journal tail. */
  secretValues(): ReadonlySet<string>
  /** The set of secret KEYS (env var names), used to list redactedFields. */
  secretKeys(): ReadonlySet<string>
}

/** Sandbox/Docker probe (folds `pnpm sandbox:doctor`) (§4, AC-13-14). */
export interface SandboxProbe {
  daemonUp(): boolean
  imagePresent(): boolean
  runtime(): 'gvisor' | 'standard' | null
  capsDropped(): boolean
}

/** MCP allowlist probe — descriptor-hash pin match (MCP 07, AC-13-13). */
export interface McpProbe {
  allowlistParses(): boolean
  /** true iff every pinned server's descriptor hash matches its pin. */
  descriptorHashesMatch(): boolean
}

/** Nightly port (Nightly 10) — /consolidate triggers a staged run, never
 * auto-promoted; rejected/queued while the run-lock is held (AC-13-23/24). */
export interface NightlyPort {
  /** true while a nightly run holds the run-lock. */
  runLockHeld(): boolean
  /** cron/timer registered + reachable (doctor `nightly` check). */
  cronRegistered(): boolean
  /** Trigger a consolidation pass into staging. Never auto-promotes. */
  triggerIntoStaging(): { started: boolean; reason?: string }
}

/** Provider cost telemetry port (Provider 09, ADR-0036) — /usage and /status
 * READ these journal events; the command layer only aggregates. */
export interface CostChargedEvent {
  tier: RouteTier
  dollars: number
  /** epoch ms; lets /usage bucket by turn/session/day. */
  at: number
}

export interface CostTelemetryPort {
  /** All provider.cost.charged events recorded this session. */
  chargedEvents(): readonly CostChargedEvent[]
  /** Current per-tier model routing (tier -> model id). */
  routing(): Record<RouteTier, string>
  /** Context window fill 0..1. */
  contextFill(): number
}

/** Injected context inventory for /context (files/tools/skills + sizes). */
export interface ContextInventoryPort {
  items(): readonly ContextItem[]
}

/** Observability event sink (Observability 12). Write-only; redacted upstream. */
export interface EventSink {
  emit(event: string, payload?: unknown): void
}

/** Card port (Gateway 02) — onboarding only CONSTRUCTS PendingActions and
 * issues cards through this; only a tap commits. `bootstrap.completed` is set
 * by code, never by a model claim (AC-13-17). */
export interface CardPort {
  issueCard(action: PendingAction): Promise<string>
}

// ---------------------------------------------------------------------------
// BOOTSTRAP first-run flow (spec §5.3)
// ---------------------------------------------------------------------------

/** A span as seen by the bootstrap flow; provenance gates advancement. */
export interface BootstrapSpan {
  provenance: 'operator' | 'untrusted'
  text: string
}

export interface BootstrapFlow {
  /** Propose the next setup step's card WITHOUT committing. Returns null when
   * an untrusted span is present (setup paused) or the flow is complete. */
  propose(span: BootstrapSpan): Promise<{ action: PendingAction; cardId: string } | null>
  /** The ONLY setter of stepsDone / completed — called by code on a confirmed
   * card tap. A model can never advance state. */
  recordStepDone(stepId: string): void
  /** Set completed only by code, once all required steps are done. */
  markCompleteIfDone(): void
  state(): BootstrapState
}

// ---------------------------------------------------------------------------
// Factory dependency surfaces
// ---------------------------------------------------------------------------

/** The required env keys (spec §4 `.env` schema). */
export const REQUIRED_ENV_KEYS = [
  'AISY_PROVIDER_REASONING_KEY',
  'AISY_PROVIDER_CRITIQUE_KEY',
  'AISY_PROVIDER_ROUTINE_KEY',
  'AISY_TELEGRAM_BOT_TOKEN',
  'AISY_TELEGRAM_CHAT_ID',
  'AISY_MEMORY_ROOT',
  'AISY_DB_PATH',
] as const

/** The fixed scaffolding manifest (spec §4) — top-level files + memory tree. */
export const SCAFFOLD_FILES = [
  '.env',
  'SOUL.md',
  'constitution.md',
  'AGENTS.md',
  'USER.md',
] as const

export const MEMORY_TREE_FILES = [
  'memory/constitution.md',
  'memory/MEMORY.md',
] as const

export const MEMORY_TREE_DIRS = ['memory/working', 'memory/daily', 'memory/archive'] as const

export interface OnboardingDeps {
  clock: Clock
  fs: FsPort
  prereqs: PrereqPort
  validators: CredentialValidators
  memory: MemoryPort
  vault: VaultPort
  sandbox: SandboxProbe
  mcp: McpProbe
  nightly: NightlyPort
  harnessVersion: string

  // --- optional seams ---
  /** Env values for --non-interactive init (read instead of prompting). */
  env?: Record<string, string>
  /** Interactive terminal I/O. Present + a TTY ⇒ init prompts for missing
   *  secrets and runs Telegram pairing; absent ⇒ env-driven (current behavior). */
  prompt?: PromptPort
  /** Event sink (Observability 12). */
  events?: EventSink
  /** Disk free bytes probe; default healthy. */
  diskFreeBytes?: () => number
  /** Min disk free threshold; default 1 GiB. */
  diskThresholdBytes?: number
  /** Resolved timezone; doctor `clock` rejects the literal "Auto". */
  timezone?: () => string
  /** Whisper model resolvable (sidecars check). */
  whisperModelResolvable?: () => boolean
}

export interface InSessionDeps {
  cost: CostTelemetryPort
  contextInventory: ContextInventoryPort
  nightly: NightlyPort
  /** Reused to run /doctor read-only. */
  ops: Pick<OnboardingOps, 'doctor'>
  card: CardPort
  clock: Clock
  events?: EventSink
}
