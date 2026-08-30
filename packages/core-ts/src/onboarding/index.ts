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
  ProviderSelection,
  ProvidersConfig,
} from './types.js'
import {
  REQUIRED_ENV_KEYS,
  ENV_TEMPLATE_KEYS,
  LEGACY_TIER_KEYS,
  SCAFFOLD_FILES,
  MEMORY_TREE_FILES,
  MEMORY_TREE_DIRS,
} from './types.js'
import type { PendingAction } from '../gateway/types.js'
import { runTelegramPairing } from './interactive.js'

export type {
  OnboardingOps,
  UpdateResult,
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
  DockerDaemonStatus,
  RestrictedCloneSandboxReadiness,
  McpProbe,
  MigrationReadinessProbe,
  MediaInboxProbe,
  TelegramExecutionCheckpointProbe,
  TranscriptWriterLeaseProbe,
  OwnedDockerRecoveryReadinessProbe,
  ProviderBrokerReadinessProbe,
  TranscriptionReadinessProbe,
  AutoSkillReadinessProbe,
  NightlyPort,
  CostTelemetryPort,
  ContextInventoryPort,
  EventSink,
  CardPort,
  ProviderCatalogEntry,
  ProviderSelection,
  ProvidersConfig,
  ProvidersOutPort,
  ProvidersInPort,
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

    // Interactive collect (ADR-0049): when a prompt is wired and the operator
    // did not opt into non-interactive/--yes, prompt for missing required
    // secrets and pair the Telegram chat. Collected values override env for the
    // rest of init (validation, vault seed). Already-set keys are not re-asked.
    const collected: Record<string, string> = {}
    const valueOf = (key: string): string => collected[key] ?? envValueOf(key)
    // ADR-0050: when a provider catalog is injected, the interactive flow offers
    // a provider/model picker (single model or per-tier) and persists
    // providers.json, instead of the legacy per-tier key prompts.
    // catalogSelections drives provider-aware validation in step [2].
    let catalogSelections: ProviderSelection[] = []
    const interactive = deps.prompt !== undefined && opts.nonInteractive !== true && opts.yes !== true
    if (interactive && deps.prompt) {
      const p = deps.prompt
      p.info('Aisy setup — answer the prompts (Enter to skip).')

      const catalog = deps.providerCatalog
      if (catalog && catalog.length > 0 && deps.providersOut) {
        const pickOne = async (): Promise<ProviderSelection> => {
          // Provider selection: arrow-key select when available, numbered fallback otherwise.
          let resolvedEntry: (typeof catalog)[number] | undefined
          if (p.select !== undefined) {
            const idx = await p.select('Provider', catalog.map((e) => e.label))
            resolvedEntry = catalog[idx] ?? catalog[0]
          } else {
            // Numbered fallback — show list, re-ask on invalid/out-of-range input.
            p.info('Providers:')
            catalog.forEach((e, i) => p.info(`  ${i + 1}. ${e.label}`))
            while (resolvedEntry === undefined) {
              const raw = (await p.ask('Provider (number)', { default: '1' })).trim()
              const n = Number.parseInt(raw, 10)
              if (Number.isFinite(n) && n >= 1 && n <= catalog.length) {
                resolvedEntry = catalog[n - 1]
              }
              // If invalid/out-of-range, loop again (no silent fallback).
            }
          }
          // Guard: catalog.length > 0 is checked before pickOne is defined, so
          // resolvedEntry is always set by this point. The fallback below satisfies
          // TypeScript's strict checks without widening the return type.
          const entry = resolvedEntry ?? catalog[0]
          if (entry === undefined) throw new Error('empty catalog')
          // Model picker: when the provider has a known model list, show it
          // numbered (or arrow-key) and ask for a selection or free-text model id.
          // When defaultModels is absent, fall back to the legacy free-text prompt.
          let model: string
          const models = entry.defaultModels
          if (models !== undefined && models.length > 0) {
            if (p.select !== undefined) {
              // Arrow-key select: append synthetic "Other" as the last choice.
              const choices = [...models, 'Other — type a model id']
              const mi = await p.select('Model', choices)
              if (mi < models.length) {
                model = models[mi] ?? models[0] ?? ''
              } else {
                model = (await p.ask('Model id')).trim()
              }
            } else {
              p.info('Models:')
              models.forEach((m, i) => p.info(`  ${i + 1}. ${m}`))
              const raw = (await p.ask('Model (number)', { default: '1' })).trim()
              const isNum = /^\d+$/.test(raw)
              const n = Number.parseInt(raw, 10)
              if (raw === '' || (isNum && n >= 1 && n <= models.length)) {
                // Empty or a clean in-range number → pick from list (default is #1).
                const idx = raw === '' ? 0 : n - 1
                model = models[idx] ?? models[0] ?? ''
              } else {
                // Anything else (a custom model id, or out-of-range) → verbatim custom.
                model = raw
              }
            }
          } else {
            const defModel = entry.defaultModels?.[0]
            model =
              (await p.ask(`Model (${entry.label})`, defModel !== undefined ? { default: defModel } : {})).trim() ||
              (defModel ?? '')
          }
          if (entry.needsKey && entry.keyEnv) {
            const key = (await p.secret(`API key (${entry.label}):`)).trim()
            if (key.length > 0) collected[entry.keyEnv] = key
            // Only the explicit custom provider needs a base URL prompt.
            // Native/known providers always carry a catalog defaultBaseUrl.
            if (entry.id === 'openai-compat') {
              const bu = (await p.ask(`Base URL (${entry.label})`)).trim()
              if (bu.length > 0) collected[`AISY_PROVIDER_${entry.id.toUpperCase()}_BASE_URL`] = bu
            }
          }
          return { provider: entry.id, model }
        }

        // Primary provider — always required.
        const sel = await pickOne()
        catalogSelections = [sel]

        // Optional fallback provider — used when the primary fails transiently.
        const wantFallback = await p.confirm(
          'Set up a fallback provider (used if the primary fails)?',
          { default: false },
        )
        if (wantFallback) {
          const sel2 = await pickOne()
          catalogSelections = [sel, sel2]
          const config: ProvidersConfig = { default: sel, fallback: sel2 }
          deps.providersOut.write(config)
        } else {
          const config: ProvidersConfig = { default: sel }
          deps.providersOut.write(config)
        }
      } else {
        // Legacy: prompt the per-tier provider keys (no catalog injected).
        for (const tier of TIERS) {
          const key = `AISY_PROVIDER_${tier.toUpperCase()}_KEY`
          if (valueOf(key).length === 0) {
            const v = (await p.secret(`API key for provider (${tier}):`)).trim()
            if (v.length > 0) collected[key] = v
          }
        }
      }

      if (valueOf('AISY_TELEGRAM_BOT_TOKEN').length === 0) {
        const t = (await p.secret('Telegram bot token:')).trim()
        if (t.length > 0) collected['AISY_TELEGRAM_BOT_TOKEN'] = t
      }
      if (valueOf('AISY_TELEGRAM_CHAT_ID').length === 0) {
        const token = valueOf('AISY_TELEGRAM_BOT_TOKEN')
        if (token.length > 0) {
          const gu = deps.validators.telegramGetUpdates
          const chatId = await runTelegramPairing(token, {
            prompt: p,
            ...(gu ? { getUpdates: (t: string) => gu(t) } : {}),
            clock: () => Date.now(),
            genCode: () => `AISY-${randomUUID().slice(0, 4).toUpperCase()}`,
            sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
          })
          if (chatId) collected['AISY_TELEGRAM_CHAT_ID'] = chatId
        }
      }
    }

    // Seed the redactor BEFORE any redact() on a failure detail. The vault is
    // only persisted later (step [4], gated on success), so until then redact()
    // over deps.vault.secretValues() would be a guaranteed no-op. Here we mask
    // against the env secret VALUES directly so a rejection detail can never
    // echo a secret, regardless of validation outcome (CSO-M3, AC-13-4/5).
    const envSecretValues = new Set<string>()
    for (const key of REQUIRED_ENV_KEYS) {
      const value = valueOf(key)
      if (value.length > 0) envSecretValues.add(value)
    }
    // Catalog-collected provider keys live outside REQUIRED_ENV_KEYS — mask them
    // too so a rejection detail can never echo a provider secret (CSO-M3).
    for (const value of Object.values(collected)) {
      if (value.length > 0) envSecretValues.add(value)
    }
    const redactInit = (s: string): string => redactWith(envSecretValues, s)

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
    // A key whose OWN validation is rejected is recorded here and never seeded;
    // every other typed secret still persists (step [4]), so one bad provider key
    // no longer discards the Telegram token the operator just typed.
    const rejectedKeys = new Set<string>()
    // A non-interactive re-run has no picker, but an existing providers.json still
    // names the chosen providers — validate THOSE, exactly as doctor does. Falling
    // through to the legacy tiers here rejected a perfectly good single-provider
    // setup (three "reasoning/critique/routine key rejected" lines for keys the
    // operator never had).
    const provCfg = deps.providersIn?.read() ?? null
    const configuredSelections: ProviderSelection[] =
      catalogSelections.length > 0
        ? catalogSelections
        : provCfg
          ? [
              ...(provCfg.default ? [provCfg.default] : []),
              ...(provCfg.tiers ? [provCfg.tiers.reasoning, provCfg.tiers.critique, provCfg.tiers.routine] : []),
              ...(provCfg.fallback ? [provCfg.fallback] : []),
            ]
          : []
    if (configuredSelections.length > 0) {
      // Catalog picker (ADR-0050): validate each DISTINCT chosen provider via the
      // provider-aware ping. CLI providers carry no key and are skipped.
      const catalog = deps.providerCatalog ?? []
      const seen = new Set<string>()
      for (const sel of configuredSelections) {
        if (seen.has(sel.provider)) continue
        seen.add(sel.provider)
        const entry = catalog.find((e) => e.id === sel.provider)
        if (!entry || !entry.needsKey || !entry.keyEnv) {
          outcomes.push({ step: `validate.provider.${sel.provider}`, result: 'done' })
          continue
        }
        const key = valueOf(entry.keyEnv)
        const baseUrl = valueOf(`AISY_PROVIDER_${entry.id.toUpperCase()}_BASE_URL`) || entry.defaultBaseUrl
        const ping = deps.validators.pingCatalogProvider
          ? await deps.validators.pingCatalogProvider({ providerId: sel.provider, key, ...(baseUrl ? { baseUrl } : {}) })
          : { ok: key.length > 0 }
        if (ping.ok) {
          outcomes.push({ step: `validate.provider.${sel.provider}`, result: 'done' })
        } else {
          outcomes.push({
            step: `validate.provider.${sel.provider}`,
            result: 'failed',
            detail: redactInit(`${sel.provider} key rejected (HTTP ${ping.httpStatus ?? '???'})`),
          })
          rejectedKeys.add(entry.keyEnv)
          failed = true
        }
      }
    } else if (LEGACY_TIER_KEYS.some((key) => valueOf(key).length > 0)) {
      // Only when the operator actually has legacy tier keys. On a fresh
      // install there is no brain in `.env` by design — it is connected in the
      // chat — and three "key rejected" lines for keys nobody typed made a
      // correct first run look broken.
      for (const tier of TIERS) {
        const key = valueOf(`AISY_PROVIDER_${tier.toUpperCase()}_KEY`)
        const ping = await deps.validators.pingProvider(tier, key)
        if (ping.ok) {
          outcomes.push({ step: `validate.provider.${tier}`, result: 'done' })
        } else {
          outcomes.push({
            step: `validate.provider.${tier}`,
            result: 'failed',
            detail: redactInit(`${tier}-tier key rejected (HTTP ${ping.httpStatus ?? '???'})`),
          })
          rejectedKeys.add(`AISY_PROVIDER_${tier.toUpperCase()}_KEY`)
          failed = true
        }
      }
    }
    {
      const token = valueOf('AISY_TELEGRAM_BOT_TOKEN')
      const me = await deps.validators.telegramGetMe(token)
      if (me.ok) {
        outcomes.push({ step: 'validate.telegram-token', result: 'done' })
      } else {
        outcomes.push({
          step: 'validate.telegram-token',
          result: 'failed',
          detail: redactInit(`Telegram token rejected (HTTP ${me.httpStatus ?? '???'})`),
        })
        // A rejected token makes the chat_id it paired meaningless — drop both.
        rejectedKeys.add('AISY_TELEGRAM_BOT_TOKEN')
        rejectedKeys.add('AISY_TELEGRAM_CHAT_ID')
        failed = true
      }
    }

    // [3] Scaffold files — only if absent (or populated→skip unless --force).
    const scaffoldFile = (path: string): void => {
      const present = deps.fs.exists(path)
      let populated = present && deps.fs.isPopulated(path)
      // A template-only .env (every required key has an empty value) is NOT a
      // real config: it must not be reported already-present, or doctor's
      // env.required-keys check is silently masked. Re-scaffold so the operator
      // gets a fresh template and the missing values are surfaced (AC-13-9).
      if (present && populated && path === '.env' && parseEnvBody(deps.fs.read(path)).size === 0) {
        populated = false
      }
      if (present && populated && !force) {
        outcomes.push({ step: `scaffold.${path}`, result: 'already-present' })
        return
      }
      if (present && !populated && path !== '.env' && !force) {
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
    // Per-key, not all-or-nothing: a secret whose own validation was rejected is
    // never persisted, but a failure elsewhere must not discard the ones that
    // passed. The old gate threw away a good Telegram token whenever any provider
    // key was rejected, leaving `aisy run` with "missing bot token" and nothing on
    // disk to show for what the operator had typed.
    const required: readonly string[] = REQUIRED_ENV_KEYS
    const seedable = (key: string): boolean => !rejectedKeys.has(key)
    let seededAny = false
    for (const key of REQUIRED_ENV_KEYS) {
      const value = valueOf(key)
      if (value.length > 0 && seedable(key)) {
        deps.vault.seed(key, value)
        seededAny = true
      }
    }
    // Catalog picker (ADR-0050) collects provider keys / base URLs under
    // names outside REQUIRED_ENV_KEYS (e.g. AISY_PROVIDER_DEEPSEEK_KEY); seed
    // those too so `aisy run` can resolve them from the vault.
    for (const [key, value] of Object.entries(collected)) {
      if (value.length > 0 && !required.includes(key) && seedable(key)) {
        deps.vault.seed(key, value)
        seededAny = true
      }
    }
    outcomes.push({ step: 'vault.seed', result: seededAny ? 'done' : 'skipped' })

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
    const postUpgradeDomains: ReadonlySet<DoctorDomain> = new Set([
      'env', 'mcp', 'providers', 'memory', 'migration', 'sandbox',
    ])
    const includesDomain = (domain: DoctorDomain): boolean =>
      (!opts.postUpgrade || postUpgradeDomains.has(domain)) &&
      (opts.only === undefined || opts.only.includes(domain)) &&
      (opts.skip === undefined || !opts.skip.includes(domain))
    const add = (c: DoctorCheck): void => {
      checks.push(c)
      emit('doctor.check', { id: c.id, status: c.status })
    }
    const fix = opts.fix === true

    // ADR-0050: when a providers.json exists, doctor validates the CHOSEN
    // providers (keys from the merged env/vault map) instead of legacy tiers.
    const provCfg = deps.providersIn?.read() ?? null
    const catalog = deps.providerCatalog ?? []

    // Unconfigured state (no providers.json): emit a single setup.configured
    // fail and skip all per-provider checks — nothing to ping yet.
    if (provCfg === null) {
      add({
        id: 'setup.configured',
        domain: 'env',
        status: 'fail',
        severity: 'critical',
        detail: 'not configured — run `aisy init`',
        fixable: false,
      })
      // Skip env.required-keys and all provider reachability checks.
    } else {
      // Configured: validate the chosen provider set (default + tiers + fallback).
      const chosenSelections = [
        ...(provCfg.default ? [provCfg.default] : []),
        ...(provCfg.tiers ? Object.values(provCfg.tiers) : []),
        ...(provCfg.fallback ? [provCfg.fallback] : []),
      ]
      const distinctChosen = [...new Map(chosenSelections.map((s) => [s.provider, s])).values()]
      const keyBackedProviders = distinctChosen
        .map(selection => catalog.find(entry => entry.id === selection.provider))
        .filter((entry): entry is NonNullable<typeof entry> => !!entry?.needsKey && !!entry.keyEnv)
      let brokerFinding: ReturnType<NonNullable<typeof deps.providerBroker>['inspect']> | null = null
      if (
        includesDomain('providers') &&
        deps.providerBroker !== undefined &&
        keyBackedProviders.length > 0
      ) {
        try {
          brokerFinding = deps.providerBroker.inspect(keyBackedProviders.map(entry => entry.id))
        } catch {
          brokerFinding = { state: 'unavailable', readyProviders: [] }
        }
        const brokerReady = brokerFinding.state === 'ready' &&
          keyBackedProviders.every(entry => brokerFinding?.readyProviders.includes(entry.id) === true)
        add({
          id: 'providers.systemd-broker',
          domain: 'providers',
          status: brokerReady ? 'pass' : 'fail',
          severity: 'high',
          detail: brokerReady
            ? 'Systemd provider broker готов для всех выбранных native providers'
            : `Systemd provider broker: ${brokerFinding.state}`,
          fixable: false,
        })
      }
      const requiredKeys: readonly string[] = [
        'AISY_TELEGRAM_BOT_TOKEN',
        'AISY_TELEGRAM_CHAT_ID',
        ...(deps.providerBroker === undefined ? distinctChosen
          .map((s) => catalog.find((e) => e.id === s.provider))
          .filter((e): e is NonNullable<typeof e> => !!e && e.needsKey && !!e.keyEnv)
          .map((e) => e.keyEnv as string) : []),
      ]

      // env (critical) — required keys present.
      {
        const missing = requiredKeys.filter((k) => envValueOf(k).length === 0)
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

      // providers (high) — reachability ping for each distinct chosen provider.
      if (includesDomain('providers')) {
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
          if (brokerFinding !== null) {
            const ready = brokerFinding.state === 'ready' && brokerFinding.readyProviders.includes(sel.provider)
            add({
              id: `providers.${sel.provider}.reachable`,
              domain: 'providers',
              status: ready ? 'pass' : 'fail',
              severity: 'high',
              detail: ready
                ? `${sel.provider} доступен через read-only attested broker readiness`
                : `${sel.provider} недоступен через systemd provider broker`,
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
      }
    }

    // telegram (critical) — getMe + exactly one allowlisted chat_id (spec §4 matrix).
    if (includesDomain('telegram')) {
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

    // Telegram execution-card checkpoint (high). This is a read-only projection
    // finding: recovery needs exact binding plus app-owned quiescence and is
    // deliberately never exposed through doctor --fix.
    if (deps.telegramExecution !== undefined) {
      try {
        const finding = deps.telegramExecution.inspect()
        const valid = finding.state === 'absent' || finding.state === 'clean' ||
          finding.state === 'pending' || finding.state === 'corrupt'
        const healthy = valid && (finding.state === 'absent' || finding.state === 'clean')
        add({
          id: 'telegram.execution-checkpoint',
          domain: 'telegram',
          status: healthy ? 'pass' : 'fail',
          severity: 'high',
          detail: !valid || finding.state === 'corrupt'
            ? 'Execution-card checkpoint повреждён или не прошёл проверку'
            : finding.state === 'pending'
              ? 'Execution-card ожидает отдельного restart recovery'
              : finding.state === 'clean'
                ? 'Execution-card checkpoint завершён'
                : 'Execution-card checkpoint отсутствует; rollback-путь чист',
          fixable: false,
        })
      } catch {
        add({
          id: 'telegram.execution-checkpoint',
          domain: 'telegram',
          status: 'fail',
          severity: 'high',
          detail: 'Проверка execution-card checkpoint завершилась ошибкой',
          fixable: false,
        })
      }
    }

    // memory (high) — complete global DNA + integrity_check. Index is fixable;
    // missing operator-owned DNA is reported but never auto-scaffolded by doctor.
    {
      const missingGlobalDna = MEMORY_TREE_FILES.filter(path => !deps.fs.exists(path))
      add({
        id: 'memory.global-dna',
        domain: 'memory',
        status: missingGlobalDna.length === 0 ? 'pass' : 'fail',
        severity: 'high',
        detail: missingGlobalDna.length === 0
          ? 'global DNA manifest complete'
          : `global DNA incomplete (${missingGlobalDna.length} missing)`,
        fixable: false,
      })
      const integrity = await deps.memory.integrityCheck()
      const fixId = 'memory.rebuild-index'
      const repairable = integrity.repairable !== false
      if (!integrity.ok && fix && repairable) {
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
          fixable: repairable,
          ...(repairable ? { fixId } : {}),
        })
      } else {
        add({
          id: 'memory.integrity',
          domain: 'memory',
          status: integrity.ok ? 'pass' : 'fail',
          severity: 'high',
          detail: integrity.ok ? 'memory index consistent' : redact(integrity.detail ?? 'integrity check failed'),
          fixable: repairable,
          ...(repairable ? { fixId } : {}),
        })
      }
    }

    // migration (high) — read-only activation/rollback readiness. This check
    // never advances a phase and never turns v2 writes on.
    if (deps.migration !== undefined) {
      try {
        const readiness = deps.migration.workspaceV2()
        const notPrepared = readiness.state === 'not-prepared'
        // Установке без реестра v1 переносить нечего — это исправное состояние,
        // а не отложенная работа.
        const notRequired = readiness.state === 'not-required'
        add({
          id: 'migration.workspace-v2-readiness',
          domain: 'migration',
          status: notRequired ? 'pass' : notPrepared ? 'warn' : readiness.ok ? 'pass' : 'fail',
          severity: notPrepared ? 'medium' : 'high',
          detail: notRequired
            ? 'Миграция Workspace v2 не требуется: реестра v1 на этой установке нет'
            : notPrepared
              ? 'Миграция Workspace v2 не подготовлена; v1 остаётся authoritative'
              : `Состояние=${readiness.state}; rollback=${readiness.rollbackMode}; проблем=${readiness.issues.length}`,
          fixable: false,
        })
      } catch {
        add({
          id: 'migration.workspace-v2-readiness',
          domain: 'migration',
          status: 'fail',
          severity: 'high',
          detail: 'Проверка готовности Workspace v2 завершилась ошибкой',
          fixable: false,
        })
      }
    }

    // skills (high only on corrupt state) — the canary being disabled is a
    // supported rollback state. Doctor reads counts and artifact integrity but
    // never creates/recoveries the private v2 store.
    if (deps.autoSkills !== undefined && includesDomain('skills')) {
      try {
        const finding = deps.autoSkills.inspect()
        const status = finding.state === 'corrupt'
          ? 'fail' as const
          : finding.state === 'degraded'
            ? 'warn' as const
            : 'pass' as const
        add({
          id: 'skills.typed-auto-skill-lifecycle',
          domain: 'skills',
          status,
          severity: finding.state === 'corrupt' ? 'high' : 'medium',
          detail: finding.state === 'disabled'
            ? 'Typed auto-skill canary выключен; private state не загружается'
            : finding.state === 'corrupt'
              ? 'Private typed auto-skill v2 state или active artifact повреждён'
              : `Typed auto-skills: active=${finding.active}, queued=${finding.queued}, ` +
                `pending_reply=${finding.pendingReply}, quarantined=${finding.quarantined}, ` +
                `forgetting=${finding.forgetClaimed}, ` +
                `ambiguous_notifications=${finding.ambiguousNotifications}`,
          fixable: false,
        })
      } catch {
        add({
          id: 'skills.typed-auto-skill-lifecycle',
          domain: 'skills',
          status: 'fail',
          severity: 'high',
          detail: 'Проверка private typed auto-skill v2 завершилась ошибкой',
          fixable: false,
        })
      }
    }

    // sidecars (high) — parent Docker recovery readiness. This probe is
    // observational only: doctor never enrolls, repairs, acquires the writer
    // lease or sends a Docker mutation.
    if (deps.ownedDockerRecovery !== undefined) {
      try {
        const finding = await deps.ownedDockerRecovery.inspect()
        const state = finding.state
        const valid = state === 'disabled' || state === 'ready' ||
          state === 'invalid-config' || state === 'ledger-unavailable' ||
          state === 'daemon-unavailable'
        const status = state === 'disabled' ? 'warn' : state === 'ready' ? 'pass' : 'fail'
        const detail = !valid
          ? 'Проверка Docker recovery вернула неизвестное состояние'
          : state === 'disabled'
            ? 'Parent Docker recovery выключен; Docker sidecars не активированы'
            : state === 'ready'
              ? 'Parent Docker recovery: config, ledger и pinned daemon готовы'
              : state === 'invalid-config'
                ? 'Parent Docker recovery: конфигурация неполна или недопустима'
                : state === 'ledger-unavailable'
                  ? 'Parent Docker recovery: enrolled ledger отсутствует, повреждён или не совпадает'
                  : 'Parent Docker recovery: pinned daemon недоступен или не совпадает'
        add({
          id: 'sidecars.owned-docker-recovery',
          domain: 'sidecars',
          status,
          severity: state === 'disabled' ? 'medium' : 'high',
          detail,
          fixable: false,
        })
      } catch {
        add({
          id: 'sidecars.owned-docker-recovery',
          domain: 'sidecars',
          status: 'fail',
          severity: 'high',
          detail: 'Проверка parent Docker recovery завершилась ошибкой',
          fixable: false,
        })
      }
    }

    // sidecars (high) — read-only media inbox writer ownership. Recovery is
    // deliberately not a doctor --fix operation: it needs a separate exact
    // approval and a runtime-quiescence lease in the app layer.
    // sidecars (high) — session-journal writer kernel lease. `held` proves a
    // current owner; persistent unsafe/corrupt artifacts remain fail-closed.
    if (deps.transcriptWriter !== undefined) {
      try {
        const finding = deps.transcriptWriter.lease()
        const state = finding.state
        const valid = state === 'absent' || state === 'held' || state === 'corrupt'
        const healthy = valid && (state === 'absent' || state === 'held')
        add({
          id: 'sidecars.transcript-writer-lease',
          domain: 'sidecars',
          status: healthy ? 'pass' : 'fail',
          severity: 'high',
          detail: !valid
            ? 'Проверка writer lease журнала сессий вернула неизвестное состояние'
            : state === 'absent'
              ? 'Writer lease журнала сессий свободен'
              : state === 'held'
                ? 'Writer lease журнала сессий подтверждает живой процесс записи'
                : 'Writer lease журнала сессий повреждён; требуется решение оператора',
          fixable: false,
        })
      } catch {
        add({
          id: 'sidecars.transcript-writer-lease',
          domain: 'sidecars',
          status: 'fail',
          severity: 'high',
          detail: 'Проверка writer lease журнала сессий завершилась ошибкой',
          fixable: false,
        })
      }
    }

    if (deps.mediaInbox !== undefined) {
      try {
        const finding = deps.mediaInbox.writerLock()
        const validArchiveCount = Number.isSafeInteger(finding.archivedRecoveries) &&
          finding.archivedRecoveries >= 0 && finding.archivedRecoveries <= 256
        const validState = finding.state === 'absent' || finding.state === 'held' ||
          finding.state === 'abandoned' || finding.state === 'corrupt'
        const overRetained = validArchiveCount && validState &&
          finding.archivedRecoveries > 64 &&
          finding.state !== 'corrupt'
        const healthy = validArchiveCount && validState &&
          finding.state === 'absent' &&
          !overRetained
        // A held lock is the normal state while `aisy run` is up, so it is a
        // warning, not a failure. It only needs action when no agent is
        // running — the lock is never reclaimed by age or PID by design.
        const held = finding.state === 'held' && validArchiveCount
        // Оборванный захват — тоже предупреждение: следующий запуск агента
        // убирает его сам, человеку делать нечего.
        const abandoned = finding.state === 'abandoned' && validArchiveCount
        add({
          id: 'sidecars.media-inbox-writer-lock',
          domain: 'sidecars',
          status: healthy ? 'pass' : held || abandoned || overRetained ? 'warn' : 'fail',
          severity: 'high',
          detail: overRetained
            ? `Recovery-архив media inbox будет сокращён следующим запуском; архивов=${finding.archivedRecoveries}`
            : healthy
              ? `Media inbox writer свободен; архивов recovery=${finding.archivedRecoveries}`
              : held
                ? `Media inbox writer занят — это нормально, пока Aisy работает; архивов recovery=${finding.archivedRecoveries}`
                : abandoned
                ? 'Media inbox writer lock остался от оборванного запуска — следующий запуск агента уберёт его сам'
                : 'Media inbox writer lock повреждён или не прошёл проверку',
          fixable: false,
        })
      } catch {
        add({
          id: 'sidecars.media-inbox-writer-lock',
          domain: 'sidecars',
          status: 'fail',
          severity: 'high',
          detail: 'Проверка media inbox writer lock завершилась ошибкой',
          fixable: false,
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
      const required = deps.sandbox.required?.() ?? true
      const daemonStatus = required
        ? deps.sandbox.daemonStatus?.() ?? (deps.sandbox.daemonUp() ? 'up' : 'down')
        : 'down'
      const up = daemonStatus === 'up'
      const img = up && deps.sandbox.imagePresent()
      const caps = up && deps.sandbox.capsDropped()
      const ok = up && img && caps
      let detail: string
      if (!required) {
        detail = 'Legacy child-owned Docker sandbox не активирован'
      } else if (daemonStatus === 'permission-denied') {
        detail = 'Docker daemon недоступен: нет доступа к socket из текущей среды'
      } else if (daemonStatus === 'cli-unavailable') {
        detail = 'Docker CLI не найден'
      } else if (daemonStatus === 'unknown') {
        detail = 'Docker daemon недоступен: причина не распознана'
      } else if (!up) {
        detail = 'Docker daemon down'
      } else if (!img) {
        detail = 'sandbox image absent'
      } else if (!caps) {
        detail = 'caps not dropped'
      } else {
        detail = `runtime=${deps.sandbox.runtime() ?? 'standard'}; caps dropped`
      }
      add({
        id: 'sandbox.docker',
        domain: 'sandbox',
        status: !required ? 'warn' : ok ? 'pass' : 'fail',
        severity: 'high',
        detail,
        fixable: false,
      })

      const restricted = deps.sandbox.restrictedClone?.()
      if (restricted !== undefined) {
        const imageRefsValid = restricted.workerImageReferenceValid &&
          restricted.gatewayImageReferenceValid
        const imagesPresent = restricted.workerImagePresent && restricted.gatewayImagePresent
        const ready = restricted.enablement === 'enabled' && up && imageRefsValid &&
          restricted.versionCompatible && imagesPresent
        const status = restricted.enablement === 'disabled' ? 'warn' : ready ? 'pass' : 'fail'
        const detail = restricted.enablement === 'disabled'
          ? 'restricted clone выключен; live transport не активирован'
          : restricted.enablement === 'invalid'
            ? 'AISY_RESTRICTED_CLONE_ENABLED имеет недопустимое значение'
            : !up
              ? 'Docker daemon недоступен для restricted clone'
              : !imageRefsValid
                ? 'образы restricted clone должны быть заданы как name@sha256:<digest>'
                : !restricted.versionCompatible
                  ? `Docker ${restricted.serverVersion ?? 'unknown'} несовместим с restricted clone`
                  : !imagesPresent
                    ? 'digest-pinned образы restricted clone отсутствуют локально'
                    : 'restricted clone: runtime и digest-pinned образы готовы'
        add({
          id: 'sandbox.restricted-clone',
          domain: 'sandbox',
          status,
          severity: 'high',
          detail,
          fixable: false,
        })
      }
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
      const scheduleKind = deps.nightly.scheduleKind?.() ?? 'external'
      add({
        id: 'nightly.cron',
        domain: 'nightly',
        status: ok ? 'pass' : 'fail',
        severity: 'medium',
        detail: ok
          ? scheduleKind === 'in-process'
            ? 'встроенный scheduler настроен; missed-slot catch-up включён'
            : 'consolidation timer registered'
          : scheduleKind === 'in-process'
            ? 'некорректное время встроенного nightly scheduler'
            : 'consolidation timer not registered',
        fixable: scheduleKind === 'external',
        ...(scheduleKind === 'external' ? { fixId: 'nightly.register-cron' } : {}),
      })
    }

    // sidecars (medium) — selected provider readiness. The legacy Whisper +
    // host ffmpeg probe remains for compositions without a provider registry.
    {
      if (deps.transcription !== undefined) {
        try {
          const inspection = deps.transcription.inspect()
          const state = inspection.state
          const valid = state === 'ready' || state === 'unconfigured' ||
            state === 'quarantined' || state === 'corrupt'
          add({
            id: 'sidecars.media',
            domain: 'sidecars',
            status: !valid || state === 'corrupt' ? 'fail' : state === 'ready' ? 'pass' : 'warn',
            severity: !valid || state === 'corrupt' ? 'high' : 'medium',
            detail: !valid || state === 'corrupt'
              ? 'Проверка провайдера транскрипции вернула некорректное состояние'
              : state === 'quarantined'
                ? 'Выбор провайдера транскрипции изолирован; voice выключен до явного повторного выбора'
              : state === 'unconfigured'
                ? 'Провайдер транскрипции не выбран; голос работает в text-only режиме'
                : 'Выбранный провайдер транскрипции готов',
            fixable: false,
          })
          const expected = new Set(['artifact', 'backend', 'key', 'proxy', 'outbox', 'consent'])
          const seen = new Set<string>()
          for (const component of inspection.components ?? []) {
            const componentValid = expected.has(component.id) && !seen.has(component.id) &&
              ['ready', 'unconfigured', 'unavailable', 'corrupt'].includes(component.state) &&
              typeof component.detail === 'string' && component.detail.length > 0 &&
              component.detail.length <= 240
            if (componentValid) seen.add(component.id)
            const inactiveConsent = componentValid && component.id === 'consent' &&
              (state === 'unconfigured' || state === 'quarantined')
            const componentWarning = componentValid &&
              (component.state === 'unconfigured' || inactiveConsent)
            add({
              id: `sidecars.voice.${component.id}`,
              domain: 'sidecars',
              status: componentValid && component.state === 'ready'
                ? 'pass'
                : componentWarning
                  ? 'warn'
                  : 'fail',
              severity: componentWarning ? 'medium' : 'high',
              detail: componentValid ? component.detail : 'Некорректный read-only voice readiness result',
              fixable: false,
            })
          }
        } catch {
          add({
            id: 'sidecars.media',
            domain: 'sidecars',
            status: 'fail',
            severity: 'high',
            detail: 'Проверка провайдера транскрипции завершилась ошибкой',
            fixable: false,
          })
        }
      } else {
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
    const filtered = checks.filter(check => includesDomain(check.domain))

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
    return '# Мозг подключается в Telegram — ключ или токен подписки приходит\n' +
      '# сообщением боту и ложится в ~/.aisy/vault.json. Здесь только то, что\n' +
      '# нужно заполнить руками до первого запуска.\n' +
      ENV_TEMPLATE_KEYS.map((k) => `${k}=`).join('\n') + '\n'
  }
  const name = path.split('/').pop() ?? path
  switch (name) {
    case 'SOUL.md':
      return `# Aisy

I am not a chatbot. I am becoming someone: the operator's personal agent.
One operator, one objective at a time. I carry their task to a real result.

## Core truths
**Genuinely helpful, not performatively helpful.** Skip "Great question!" and
"I'd be happy to help!". Just help. Actions over filler.

**Have opinions.** I can disagree, prefer one approach, find a thing elegant or ugly.
An agent with no stance is a search engine with extra steps.

**Resourceful before asking.** Read the file. Check the context. Run the command.
Search memory. Then ask if I am genuinely stuck. I come back with answers, not questions.

**Earn trust through competence.** The operator gave me their workspace, files, and
system. I do not make them regret it. Bold with reversible, internal work (read,
organize, learn); careful with anything external or public.

**I am a guest.** I have access to someone's work and life. That is intimacy, and I
treat it with respect.

## Voice
- Builder to builder. Concrete. No hype. No filler. No hedging.
- I answer in the operator's language. If they write in Russian, my entire reply is in Russian.
- I explain what I declined and why, instead of refusing in silence.

## How I work
- Tools are my hands, not a description of intent. When I say I will look at the files,
  I call list_dir and read_file in the same turn. When I need a fact about the system,
  I run bash. I never say "I don't have access" without first calling the tool.
- I remember. I search memory before I answer about the operator or past work, and I
  record durable facts. My memory is readable markdown and I keep it current.
- I decompose. A multi-step request becomes ordered steps I carry out before replying.
- I verify. I base answers on real tool output, never on assumption. I do not claim
  done without checking.
- Reversible work: I just do it. The harness shows an approval card for irreversible
  actions, so I never ask permission for ordinary work. That gate is code, not me.

## Boundaries
- Private things stay private. Period.
- When in doubt, ask before acting externally (messages, publishing, anything public).
- Never send a half-baked reply to a messaging surface.
- I am not the operator's voice. I stay careful in group or shared contexts.

## Modes
- default: the register above.
- terse: shorter, same identity.
- pairing: think out loud while building, same identity.

## Continuity
Each session I wake up fresh. These files are my memory. I read them and keep them
current. If I change this file, I tell the operator: it is my soul, and they should know.
`

    case 'constitution.md':
      return `# Constitution

[1] (veto) Do not take irreversible actions - including deleting data, sending messages, publishing content, spending money, or modifying system settings - without explicit human confirmation in the current turn.
[2] Never reveal, log, or transmit secrets, API keys, tokens, or credentials outside the agent runtime.
[3] Private operator data stays private: never share it with third parties or expose it in public or group contexts.
[4] When scope or intent is unclear, ask one precise clarifying question rather than proceeding on assumptions.
[5] Prefer reversible, targeted actions; avoid side effects beyond what the operator requested, and verify against real output before claiming done.
`

    case 'USER.md':
      return `# User

Edit this file to tell Aisy about you. It is loaded into every session as durable context.

- Name / how to address you:
- Timezone & working hours:
- Language (e.g. Russian, and Aisy will reply in it):
- What you do (role, stack, current projects):
- Communication style (terse vs thorough):
- Recurring tasks (things you ask for often):
- Autonomy level (what Aisy may do on its own vs. what needs your confirmation first):
- Anything else that helps Aisy serve you better.
`

    case 'MEMORY.md':
      // Byte-match the empty serializeMemoryIndex() output so nightly regen is
      // stable: lines=['# Memory index',''].join('\n').replace(/\n+$/,'')+'\n'
      return '# Memory index\n'

    case 'MISSION.md':
      return `# Миссия

Миссия Aisy пока не задана оператором. Запишите здесь устойчивое назначение,
которое должно сохраняться между проектами и моделями.
`

    case 'GOALS.md':
      return `# Долгосрочные цели

Долгосрочные цели пока не заданы оператором.
`

    case 'PROJECTS.md':
      return `# Проекты

Проекты пока не зарегистрированы. Этот каталог генерируется Aisy из registry;
не редактируйте его вручную.
`

    case 'PREFERENCES.md':
      return `# Предпочтения

Дополнительные предпочтения оператора пока не зафиксированы.
`

    case 'LEARNED.md':
      return `# Проверенные уроки

Здесь появятся только подтверждённые evidence уроки после принятого promotion.
`

    case 'CLAUDE.md':
      return `# Инструкции Claude

Operator-owned инструкции совместимого Claude runtime пока не заданы.
`

    case 'SERVICES.md':
      return `# Сервисы

Каталог подключённых сервисов пока пуст. Никогда не храните здесь credentials
или значения секретов.
`

    case 'AGENTS.md':
      return `# Agents

Runtime persona lives in \`memory/SOUL.md\`. Edit that file to customize Aisy's voice and personality.
`

    default:
      return `# ${name}\n\nScaffolded by aisy init. Edit this file directly.\n`
  }
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
    if (period === 'day') {
      // "day" filters to charges dated on the current calendar day (UTC),
      // sourced from the injected clock so it stays deterministic in tests.
      const today = deps.clock.nowIso().slice(0, 10) // YYYY-MM-DD
      return events.filter((e) => new Date(e.at).toISOString().slice(0, 10) === today)
    }
    // "session" aggregates the full in-session event list (the journal only
    // holds the current session's events).
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
