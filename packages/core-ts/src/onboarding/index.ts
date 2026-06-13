import { createHash, randomUUID } from 'node:crypto'

import type {
  OnboardingOps,
  OnboardingDeps,
  InSessionCommands,
  InSessionDeps,
  InitResult,
  InitOutcome,
  DoctorReport,
  DoctorCheck,
  DoctorDomain,
  CheckStatus,
  StatusReport,
  UsageReport,
  UsagePeriod,
  ContextBreakdown,
  BootstrapFlow,
  BootstrapState,
  BootstrapSpan,
  CardPort,
  Clock,
  RouteTier,
  CostChargedEvent,
} from './types.js'
import { REQUIRED_ENV_KEYS, SCAFFOLD_FILES, MEMORY_TREE_FILES, MEMORY_TREE_DIRS } from './types.js'
import type { PendingAction } from '../gateway/types.js'

export type {
  OnboardingOps,
  OnboardingDeps,
  InSessionCommands,
  InSessionDeps,
  InitResult,
  InitOutcome,
  InitStep,
  DoctorReport,
  DoctorCheck,
  DoctorDomain,
  CheckStatus,
  CheckSeverity,
  StatusReport,
  UsageReport,
  UsagePeriod,
  ContextBreakdown,
  ContextItem,
  BootstrapFlow,
  BootstrapState,
  BootstrapSpan,
  RouteTier,
  CostChargedEvent,
  PendingAction,
  // ports
  Clock,
  FsPort,
  PrereqPort,
  CredentialValidators,
  MemoryPort,
  VaultPort,
  SandboxProbe,
  McpProbe,
  NightlyPort,
  CostTelemetryPort,
  ContextInventoryPort,
  EventSink,
  CardPort,
} from './types.js'
export {
  REQUIRED_ENV_KEYS,
  SCAFFOLD_FILES,
  MEMORY_TREE_FILES,
  MEMORY_TREE_DIRS,
} from './types.js'

const TIERS: readonly RouteTier[] = ['reasoning', 'critique', 'routine']

// ---------------------------------------------------------------------------
// Redaction helper. The component handles credentials and exports bundles, so
// every sink runs through here: a secret VALUE never appears in detail, an
// InitOutcome, a journal tail, or a diagnostics file (CSO-M3, AC-13-4/5/15/16).
// ---------------------------------------------------------------------------

function redactWith(values: ReadonlySet<string>, text: string): string {
  let out = text
  for (const v of values) {
    if (v.length > 0) out = out.split(v).join('«redacted»')
  }
  return out
}

// ===========================================================================
// makeOnboardingOps — init / doctor / diagnostics (spec §3, §5.1–5.2, §5.5)
// All deterministic; the model is never on this path.
// ===========================================================================

export function makeOnboardingOps(deps: OnboardingDeps): OnboardingOps {
  const emit = (event: string, payload?: unknown): void => deps.events?.emit(event, payload)
  const secretValues = (): ReadonlySet<string> => deps.vault.secretValues()
  const redact = (s: string): string => redactWith(secretValues(), s)

  // ---- prereq + .env helpers --------------------------------------------

  function parseEnvBody(body: string): Set<string> {
    const keys = new Set<string>()
    for (const line of body.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m && m[1] !== undefined && (m[2] ?? '').length > 0) keys.add(m[1])
    }
    return keys
  }

  function envValueOf(key: string): string {
    return deps.env?.[key] ?? ''
  }

  // -------------------------------------------------------------------------
  // init (§5.1) — resumable: every step records an InitOutcome; satisfied
  // steps yield already-present/skipped and write nothing without --force.
  // -------------------------------------------------------------------------

  async function init(opts: { yes?: boolean; force?: boolean; nonInteractive?: boolean }): Promise<InitResult> {
    emit('init.started')
    const outcomes: InitOutcome[] = []
    const scaffolded: string[] = []
    const force = opts.force === true
    let failed = false

    // [1] Detect prerequisites — fail-closed with an actionable message (§7).
    for (const tool of ['node', 'pnpm', 'docker'] as const) {
      const v = deps.prereqs.version(tool)
      if (v === null) {
        outcomes.push({ step: `prereq.${tool}`, result: 'failed', detail: `${tool} not found — install and re-run aisy init` })
        failed = true
      } else {
        outcomes.push({ step: `prereq.${tool}`, result: 'done' })
      }
    }

    // [2] Validate credentials via INJECTED validators (no real network).
    // A secret VALUE is never written into detail — only status (AC-13-4/5).
    for (const tier of TIERS) {
      const key = envValueOf(`AISY_PROVIDER_${tier.toUpperCase()}_KEY`)
      const ping = await deps.validators.pingProvider(tier, key)
      if (ping.ok) {
        outcomes.push({ step: `validate.provider.${tier}`, result: 'done' })
      } else {
        outcomes.push({
          step: `validate.provider.${tier}`,
          result: 'failed',
          detail: redact(`${tier}-tier key rejected (HTTP ${ping.httpStatus ?? '???'})`),
        })
        failed = true
      }
    }
    {
      const token = envValueOf('AISY_TELEGRAM_BOT_TOKEN')
      const me = await deps.validators.telegramGetMe(token)
      if (me.ok) {
        outcomes.push({ step: 'validate.telegram-token', result: 'done' })
      } else {
        outcomes.push({
          step: 'validate.telegram-token',
          result: 'failed',
          detail: redact(`Telegram token rejected (HTTP ${me.httpStatus ?? '???'})`),
        })
        failed = true
      }
    }

    // [3] Scaffold files — only if absent (or populated→skip unless --force).
    const scaffoldFile = (path: string): void => {
      const present = deps.fs.exists(path)
      const populated = present && deps.fs.isPopulated(path)
      if (present && populated && !force) {
        outcomes.push({ step: `scaffold.${path}`, result: 'already-present' })
        return
      }
      if (present && !populated && !force) {
        // present-but-empty (e.g. a crash mid-write) — leave it, treat as present.
        outcomes.push({ step: `scaffold.${path}`, result: 'already-present' })
        return
      }
      deps.fs.write(path, templateFor(path))
      scaffolded.push(path)
      outcomes.push({ step: `scaffold.${path}`, result: 'done' })
      emit('init.step', { step: `scaffold.${path}` })
    }
    for (const f of SCAFFOLD_FILES) scaffoldFile(f)
    for (const f of MEMORY_TREE_FILES) scaffoldFile(f)
    for (const d of MEMORY_TREE_DIRS) {
      if (deps.fs.exists(d)) {
        outcomes.push({ step: `scaffold.${d}`, result: 'already-present' })
      } else {
        deps.fs.mkdirp(d)
        outcomes.push({ step: `scaffold.${d}`, result: 'done' })
      }
    }

    // [4] Seed vault (Safety 05) with validated secrets — never logged.
    if (!failed) {
      for (const key of REQUIRED_ENV_KEYS) {
        const value = envValueOf(key)
        if (value.length > 0) deps.vault.seed(key, value)
      }
      outcomes.push({ step: 'vault.seed', result: 'done' })
    } else {
      outcomes.push({ step: 'vault.seed', result: 'skipped' })
    }

    // [5] Initialize stores: Memory.rebuildFromFiles() → SQLite FTS5 index.
    if (!failed) {
      await deps.memory.rebuildFromFiles()
      outcomes.push({ step: 'stores.memory-index', result: 'done' })
    } else {
      outcomes.push({ step: 'stores.memory-index', result: 'skipped' })
    }

    const completed = !failed
    emit('init.completed', { completed })
    return { completed, outcomes, scaffolded }
  }

  // -------------------------------------------------------------------------
  // doctor (§5.2) — read-only by default; --fix applies only fixable &&
  // non-destructive repairs. ok:false iff any high/critical check fails.
  // -------------------------------------------------------------------------

  async function runChecks(opts: {
    fix?: boolean
    postUpgrade?: boolean
    only?: DoctorDomain[]
    skip?: DoctorDomain[]
  }): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = []
    const add = (c: DoctorCheck): void => {
      checks.push(c)
      emit('doctor.check', { id: c.id, status: c.status })
    }
    const fix = opts.fix === true

    // env (critical) — required keys present, no obvious placeholders.
    {
      const body = deps.fs.exists('.env') ? deps.fs.read('.env') : ''
      const present = parseEnvBody(body)
      const missing = REQUIRED_ENV_KEYS.filter((k) => !present.has(k))
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

    // providers (high) — per-tier reachability ping.
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

    // telegram (critical) — getMe + exactly one allowlisted chat_id (spec §4 matrix).
    {
      const token = envValueOf('AISY_TELEGRAM_BOT_TOKEN')
      const me = await deps.validators.telegramGetMe(token)
      add({
        id: 'telegram.token-valid',
        domain: 'telegram',
        status: me.ok ? 'pass' : 'fail',
        severity: 'critical',
        detail: me.ok ? 'bot token valid' : redact(`token rejected (HTTP ${me.httpStatus ?? '???'})`),
        fixable: false,
      })
      // Exactly one allowlisted chat_id must be configured: zero leaves the bot
      // open to any chat; more than one is not the single-operator default.
      const chatIds = envValueOf('AISY_TELEGRAM_CHAT_ID')
        .split(/[\s,]+/)
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
      const oneChatId = chatIds.length === 1
      add({
        id: 'telegram.chat-id-allowlist',
        domain: 'telegram',
        status: oneChatId ? 'pass' : 'fail',
        severity: 'critical',
        detail: oneChatId
          ? 'exactly one allowlisted chat_id set'
          : chatIds.length === 0
            ? 'no allowlisted chat_id set (AISY_TELEGRAM_CHAT_ID empty)'
            : `expected exactly one allowlisted chat_id, found ${chatIds.length}`,
        fixable: false,
      })
    }

    // memory (high) — tree exists + integrity_check. Fixable via rebuild.
    {
      const integrity = await deps.memory.integrityCheck()
      const fixId = 'memory.rebuild-index'
      if (!integrity.ok && fix) {
        // FIXABLE, NON-DESTRUCTIVE: rebuild re-applies the forget invariant;
        // it never deletes a fact (AC-13-10/11).
        await deps.memory.rebuildFromFiles()
        emit('doctor.fix', { fixId })
        const after = await deps.memory.integrityCheck()
        add({
          id: 'memory.integrity',
          domain: 'memory',
          status: after.ok ? 'pass' : 'fail',
          severity: 'high',
          detail: after.ok ? 'index rebuilt; integrity restored' : redact(after.detail ?? 'integrity check failed'),
          fixable: true,
          fixId,
        })
      } else {
        add({
          id: 'memory.integrity',
          domain: 'memory',
          status: integrity.ok ? 'pass' : 'fail',
          severity: 'high',
          detail: integrity.ok ? 'memory index consistent' : redact(integrity.detail ?? 'integrity check failed'),
          fixable: true,
          fixId,
        })
      }
    }

    // vault (critical) — loads + seeded secrets decrypt.
    {
      const ok = deps.vault.loads()
      add({
        id: 'vault.loads',
        domain: 'vault',
        status: ok ? 'pass' : 'fail',
        severity: 'critical',
        detail: ok ? 'vault loads; seeded secrets decrypt' : 'vault failed to load',
        fixable: false,
      })
    }

    // sandbox (high) — folds pnpm sandbox:doctor (AC-13-14).
    {
      const up = deps.sandbox.daemonUp()
      const img = deps.sandbox.imagePresent()
      const caps = deps.sandbox.capsDropped()
      const ok = up && img && caps
      const detail = !up
        ? 'Docker daemon down'
        : !img
          ? 'sandbox image absent'
          : !caps
            ? 'caps not dropped'
            : `runtime=${deps.sandbox.runtime() ?? 'standard'}; caps dropped`
      add({
        id: 'sandbox.docker',
        domain: 'sandbox',
        status: ok ? 'pass' : 'fail',
        severity: 'high',
        detail,
        fixable: false,
      })
    }

    // mcp (high) — allowlist parses + descriptor-hash pins match (AC-13-13).
    {
      const parses = deps.mcp.allowlistParses()
      const hashes = deps.mcp.descriptorHashesMatch()
      const ok = parses && hashes
      add({
        id: 'mcp.descriptor-pins',
        domain: 'mcp',
        status: ok ? 'pass' : 'fail',
        severity: 'high',
        detail: !parses ? 'MCP allowlist failed to parse' : hashes ? 'descriptor hashes match pins' : 'descriptor hash mismatch since pin',
        fixable: false,
      })
    }

    // nightly (medium) — cron/timer registered + reachable.
    {
      const ok = deps.nightly.cronRegistered()
      add({
        id: 'nightly.cron',
        domain: 'nightly',
        status: ok ? 'pass' : 'fail',
        severity: 'medium',
        detail: ok ? 'consolidation timer registered' : 'consolidation timer not registered',
        fixable: true,
        fixId: 'nightly.register-cron',
      })
    }

    // sidecars (medium) — Whisper model resolvable + ffmpeg on PATH.
    {
      const whisper = deps.whisperModelResolvable ? deps.whisperModelResolvable() : true
      const ffmpeg = deps.prereqs.version('ffmpeg') !== null
      const ok = whisper && ffmpeg
      add({
        id: 'sidecars.media',
        domain: 'sidecars',
        status: ok ? 'pass' : 'fail',
        severity: 'medium',
        detail: !whisper ? 'Whisper model unresolvable' : !ffmpeg ? 'ffmpeg not on PATH' : 'Whisper + ffmpeg present',
        fixable: false,
      })
    }

    // disk (medium) — free space above threshold.
    {
      const free = deps.diskFreeBytes ? deps.diskFreeBytes() : Number.MAX_SAFE_INTEGER
      const threshold = deps.diskThresholdBytes ?? 1024 * 1024 * 1024
      const ok = free >= threshold
      add({
        id: 'disk.free-space',
        domain: 'disk',
        status: ok ? 'pass' : 'fail',
        severity: 'medium',
        detail: ok ? 'free space above threshold' : 'free space below threshold',
        fixable: false,
      })
    }

    // clock (low) — sane + timezone resolvable, never literal "Auto".
    {
      const tz = deps.timezone ? deps.timezone() : 'UTC'
      const ok = tz.length > 0 && tz !== 'Auto'
      add({
        id: 'clock.timezone',
        domain: 'clock',
        status: ok ? 'pass' : 'fail',
        severity: 'low',
        detail: ok ? `timezone=${tz}` : 'timezone unresolved (literal "Auto")',
        fixable: false,
      })
    }

    // Post-upgrade subset: keep the checks that catch migration breakage
    // (env schema drift, MCP descriptor-hash mismatch, provider id resolve).
    let filtered = checks
    if (opts.postUpgrade) {
      const postUpgradeDomains: ReadonlySet<DoctorDomain> = new Set(['env', 'mcp', 'providers', 'memory'])
      filtered = filtered.filter((c) => postUpgradeDomains.has(c.domain))
    }
    if (opts.only) {
      const only = new Set(opts.only)
      filtered = filtered.filter((c) => only.has(c.domain))
    }
    if (opts.skip) {
      const skip = new Set(opts.skip)
      filtered = filtered.filter((c) => !skip.has(c.domain))
    }

    // Deterministic order: sorted by stable check id (§4, AC-13-12).
    return filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  async function doctor(opts: {
    fix?: boolean
    postUpgrade?: boolean
    only?: DoctorDomain[]
    skip?: DoctorDomain[]
  }): Promise<DoctorReport> {
    const checks = await runChecks(opts)
    // ok:false iff any high/critical check is "fail" (§3).
    const ok = !checks.some((c) => c.status === 'fail' && (c.severity === 'high' || c.severity === 'critical'))
    const report: DoctorReport = { ok, ranAt: deps.clock.nowIso(), harnessVersion: deps.harnessVersion, checks }
    emit('doctor.ran', { ok })
    return report
  }

  // -------------------------------------------------------------------------
  // toJson — deterministic, secret-free serialization for `--json`.
  // ranAt/harnessVersion are excluded so two runs over identical state diff
  // byte-identically (AC-13-12); the check list is already id-sorted.
  // -------------------------------------------------------------------------

  function toJson(report: DoctorReport): string {
    const stable = {
      ok: report.ok,
      checks: report.checks.map((c) => ({
        id: c.id,
        domain: c.domain,
        status: c.status,
        severity: c.severity,
        detail: redact(c.detail),
        fixable: c.fixable,
        ...(c.fixId !== undefined ? { fixId: c.fixId } : {}),
      })),
    }
    return JSON.stringify(stable, null, 2) + '\n'
  }

  // -------------------------------------------------------------------------
  // diagnostics — redacted support bundle (§4, AC-13-15/16). Every secret
  // value is replaced with «redacted»; redactedFields lists every secret key.
  // -------------------------------------------------------------------------

  async function diagnostics(opts: { out?: string }): Promise<{ bundlePath: string; redactedFields: string[] }> {
    const out = opts.out ?? 'aisy-diagnostics'
    const values = secretValues()
    const redactedFields = [...deps.vault.secretKeys()].sort()

    // meta.json — versions + ranAt.
    deps.fs.write(`${out}/meta.json`, JSON.stringify({ harnessVersion: deps.harnessVersion, ranAt: deps.clock.nowIso() }, null, 2))

    // doctor.json — the report (already redaction-safe details).
    const report = await doctor({})
    deps.fs.write(`${out}/doctor.json`, toJson(report))

    // config.redacted.json — resolved config with every secret value stripped.
    const config: Record<string, string> = {}
    for (const key of REQUIRED_ENV_KEYS) {
      const isSecret = /KEY$|TOKEN$/.test(key)
      config[key] = isSecret ? '«redacted»' : redactWith(values, envValueOf(key))
    }
    deps.fs.write(`${out}/config.redacted.json`, JSON.stringify(config, null, 2))

    // journal.tail.jsonl — recent events, secret-redacted (spec 12 CSO-M3).
    const rawTail = deps.fs.exists('journal.raw') ? deps.fs.read('journal.raw') : ''
    deps.fs.write(`${out}/journal.tail.jsonl`, redactWith(values, rawTail))

    emit('diagnostics.exported', { bundlePath: out })
    return { bundlePath: out, redactedFields }
  }

  return { init, doctor, toJson, diagnostics }
}

// Templates ship with the harness; the operator owns the result (§4).
function templateFor(path: string): string {
  if (path === '.env') {
    return REQUIRED_ENV_KEYS.map((k) => `${k}=`).join('\n') + '\n'
  }
  const name = path.split('/').pop() ?? path
  return `# ${name}\n\nScaffolded by aisy init. Edit this file directly.\n`
}

// ===========================================================================
// makeInSessionCommands — /status /usage /context /doctor /consolidate (§5.4)
// Read-only commands never mutate; /consolidate only CONSTRUCTS+cards a
// PendingAction (the Gateway tap is the only thing that runs Nightly).
// ===========================================================================

export function makeInSessionCommands(deps: InSessionDeps): InSessionCommands {
  const emit = (event: string, payload?: unknown): void => deps.events?.emit(event, payload)

  function bucketFor(period: UsagePeriod, events: readonly CostChargedEvent[]): readonly CostChargedEvent[] {
    if (period === 'turn') {
      // The "turn" bucket is the single most recent charge.
      return events.length > 0 ? [events[events.length - 1] as CostChargedEvent] : []
    }
    // session/day both aggregate the full in-session event list (the journal
    // only holds the current session's events).
    return events
  }

  return {
    async status(): Promise<StatusReport> {
      emit('command.invoked', { command: 'status' })
      const events = deps.cost.chargedEvents()
      const sessionCostUsd = events.reduce((s, e) => s + e.dollars, 0)
      const lastTurnCostUsd = events.length > 0 ? (events[events.length - 1] as CostChargedEvent).dollars : 0
      return {
        routing: deps.cost.routing(),
        contextFill: deps.cost.contextFill(),
        lastTurnCostUsd,
        sessionCostUsd,
      }
    },

    async usage(period: UsagePeriod = 'session'): Promise<UsageReport> {
      emit('command.invoked', { command: 'usage' })
      const events = bucketFor(period, deps.cost.chargedEvents())
      const byTier: Record<RouteTier, number> = { reasoning: 0, critique: 0, routine: 0 }
      let totalUsd = 0
      for (const e of events) {
        byTier[e.tier] += e.dollars
        totalUsd += e.dollars
      }
      return { period, byTier, totalUsd }
    },

    async context(): Promise<ContextBreakdown> {
      emit('command.invoked', { command: 'context' })
      // Only metadata (kind/name/size) is surfaced — never a secret or a full
      // fact body (AC-13-21).
      const items = deps.contextInventory.items().map((i) => ({ kind: i.kind, name: i.name, size: i.size }))
      const totalSize = items.reduce((s, i) => s + i.size, 0)
      return { items, totalSize }
    },

    async runDoctor(): Promise<DoctorReport> {
      emit('command.invoked', { command: 'doctor' })
      // Read-only by contract — doctor({}) performs no writes (AC-13-22).
      return deps.ops.doctor({})
    },

    async requestConsolidate(): Promise<PendingAction> {
      emit('command.invoked', { command: 'consolidate' })
      const lockHeld = deps.nightly.runLockHeld()
      // Build the PendingAction; the Gateway cards it. Issuance is never a run
      // (AC-13-23). While the lock is held, the summary signals reject/queue so
      // a tap cannot start a second concurrent run (AC-13-24).
      const summary = lockHeld
        ? 'A consolidation is already running (run-lock held) — request queued'
        : 'Trigger a consolidation pass into the morning staging gate (not auto-promoted)'
      const actionId = randomUUID()
      const action: PendingAction = {
        actionId,
        actionHash: createHash('sha256').update(`consolidate:${actionId}`).digest('hex'),
        tier: 2,
        requiresStepUp: false,
        summary,
      }
      await deps.card.issueCard(action)
      return action
    },
  }
}

// ===========================================================================
// makeBootstrapFlow — first-run guided setup (§5.3). The model can PROPOSE
// (issue a card) but only a code-driven recordStepDone (post Gateway tap)
// advances state; an untrusted span pauses setup (AC-13-17/18).
// ===========================================================================

export interface BootstrapFlowDeps {
  card: CardPort
  clock: Clock
  /** Ordered required setup steps (e.g. agent-name, persona, autonomy, budget). */
  steps: string[]
  events?: { emit(event: string, payload?: unknown): void }
}

export function makeBootstrapFlow(deps: BootstrapFlowDeps): BootstrapFlow {
  const state: BootstrapState = { started: false, completed: false, stepsDone: [] }

  return {
    async propose(span: BootstrapSpan): Promise<{ action: PendingAction; cardId: string } | null> {
      // Setup runs strictly under operator provenance; an untrusted span never
      // advances it and never even issues a card (AC-13-18; capability narrowing).
      if (span.provenance !== 'operator') return null

      const next = deps.steps.find((s) => !state.stepsDone.includes(s))
      if (next === undefined) return null

      if (!state.started) {
        state.started = true
        deps.events?.emit('bootstrap.started')
      }

      // PROPOSE only: build a PendingAction and card it. Issuance is never
      // confirmation — the operator's tap commits, exactly like any Tier-gated
      // action (AC-13-17).
      const actionId = randomUUID()
      const action: PendingAction = {
        actionId,
        actionHash: createHash('sha256').update(`bootstrap:${next}:${actionId}`).digest('hex'),
        tier: 2,
        requiresStepUp: false,
        summary: `BOOTSTRAP: configure "${next}"`,
      }
      const cardId = await deps.card.issueCard(action)
      return { action, cardId }
    },

    // The ONLY setter of stepsDone — called by code on a confirmed card tap.
    recordStepDone(stepId: string): void {
      if (!state.stepsDone.includes(stepId)) state.stepsDone.push(stepId)
    },

    // completed is set only by code, once all required steps are recorded
    // (AC-13-17; the model can never self-complete setup).
    markCompleteIfDone(): void {
      const allDone = deps.steps.every((s) => state.stepsDone.includes(s))
      if (allDone && !state.completed) {
        state.completed = true
        deps.events?.emit('bootstrap.completed')
      }
    },

    state(): BootstrapState {
      return { started: state.started, completed: state.completed, stepsDone: [...state.stepsDone] }
    },
  }
}
