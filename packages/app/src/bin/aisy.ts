#!/usr/bin/env node
// Unified `aisy` CLI.
//   aisy run                  → boot the live Telegram agent (this package)
//   aisy init|doctor|…        → onboarding (delegated to @aisy/core's runCli)
//
// Secrets are read from the vault (~/.aisy/vault.json), seeded by `aisy init`.
// Run adapters: bash sandboxed only when AISY_SANDBOX_IMAGE is set; SQLite-backed
// memory (FTS) + search_memory tool, and a durable jsonl session log (ADR-0048,
// Tier-1 wiring). Full crash-resume (SessionLog.resume) is still deferred.

import { existsSync, readFileSync, writeFileSync, readdirSync, appendFileSync, unlinkSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  makeAgentRunner,
  makeToolExecutor,
  makeGateway,
  makeGrantStore,
  makeGuardian,
  makeDockerBash,
  makeNodeOnboardingOps,
  buildProvider,
  makeTieredProvider,
  findProvider,
  makeSpendStore,
  makeSettingsStore,
  makeBudgetTracker,
  makeMemoryStore,
  makeMemoryPort,
  makeMemorySearch,
  makeJsonlSessionLog,
  makeCardResolver,
  makeDelegationManager,
  runDelegation,
  makeSubAgentRunner,
  normalizeSpawnPlan,
  DEFAULT_GENERAL_CARD,
  runCli,
  harnessVersion,
  VoiceUnavailable,
  type AnthropicTool,
  type ApprovalDecision,
  type FsPort,
  type GrantPersistencePort,
  type MemoryPort,
  type PendingAction,
  type ProviderAdapter,
  type SessionLog,
  type SpendEntry,
  type Settings,
  type TaskObservation,
  type LogEntry,
  type VerificationTrace,
} from '@aisy/core'
import { makeTelegramBot } from '../bot.js'
import { makeJsonlJournal } from '../journal.js'
import { makeScheduler } from '../scheduler.js'
import { makeTriggerStore } from '../trigger-store.js'
import { makeTriggerProbeRunner } from '../trigger-probe.js'
import { makeGoalStore } from '../goal-store.js'
import { makeGoalOrchestrator } from '../goal-orchestrator.js'
import { parseGoalMode } from '../goal-parse.js'
import {
  makeConsolidationRunner,
  makeFileRunLock,
  makeMemoryValidators,
  liveFactsForNightly,
  memOpToMemoryOp,
  makeNightlyGenerator,
  makeNightlyJudge,
  makeTriggerEngine,
  makeGoalSpec,
  type GoalMode,
  type NightlyConfig,
  type TriggerBudget,
} from '@aisy/core'

const argv = process.argv.slice(2)

// Non-run commands → onboarding CLI. `setup` is an alias for interactive init.
if (argv[0] !== 'run') {
  const cliArgv = argv[0] === 'setup' ? ['init', ...argv.slice(1)] : argv
  const exitCode = await runCli(cliArgv, {
    ops: makeNodeOnboardingOps(),
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    version: harnessVersion(),
  })
  process.exit(exitCode)
}

// --- aisy run: boot the live agent ---
const base = process.env['AISY_HOME'] ?? join(homedir(), '.aisy')
const vaultPath = join(base, 'vault.json')
const grantsPath = join(base, 'grants.json')
const workspaceRoot = process.env['AISY_WORKSPACE'] ?? process.cwd()

function loadVault(): Record<string, string> {
  if (!existsSync(vaultPath)) return {}
  try {
    return JSON.parse(readFileSync(vaultPath, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

const vault = loadVault()
const token = vault['AISY_TELEGRAM_BOT_TOKEN'] ?? process.env['AISY_TELEGRAM_BOT_TOKEN'] ?? ''
const chatIdRaw = vault['AISY_TELEGRAM_CHAT_ID'] ?? process.env['AISY_TELEGRAM_CHAT_ID'] ?? ''
// Provider selection from ~/.aisy/providers.json (per-tier or a single default).
// Back-compat: no file ⇒ Anthropic + AISY_PROVIDER_MODEL + the legacy reasoning key.
interface ProviderSel {
  provider: string
  model: string
}
interface ProvidersConfig {
  default?: ProviderSel
  tiers?: { reasoning: ProviderSel; critique: ProviderSel; routine: ProviderSel }
  /** Per-(sub)agent overrides + budgets (ADR-0050 Phase 3). The main agent's
   *  budget may also come from AISY_BUDGET_USD. */
  agents?: Record<string, { provider?: string; model?: string; budgetUsd?: number }>
}
const providersPath = join(base, 'providers.json')
function loadProviders(): ProvidersConfig {
  if (!existsSync(providersPath)) return {}
  try {
    return JSON.parse(readFileSync(providersPath, 'utf8')) as ProvidersConfig
  } catch {
    return {}
  }
}
const providersCfg = loadProviders()
const defaultSel: ProviderSel =
  providersCfg.default ?? { provider: 'anthropic', model: process.env['AISY_PROVIDER_MODEL'] ?? 'claude-sonnet-4-6' }

function keyFor(providerId: string): string {
  const entry = findProvider(providerId)
  if (!entry?.keyEnv) return '' // CLI providers need no key
  let k = vault[entry.keyEnv] ?? process.env[entry.keyEnv] ?? ''
  if (!k && providerId === 'anthropic') {
    k = vault['AISY_PROVIDER_REASONING_KEY'] ?? process.env['AISY_PROVIDER_REASONING_KEY'] ?? ''
  }
  return k
}
function baseUrlFor(providerId: string): string | undefined {
  const k = `AISY_PROVIDER_${providerId.toUpperCase()}_BASE_URL`
  return vault[k] ?? process.env[k]
}

const defaultNeedsKey = findProvider(defaultSel.provider)?.kind !== 'cli'
if (!token || !chatIdRaw || (defaultNeedsKey && keyFor(defaultSel.provider).length === 0)) {
  process.stderr.write('aisy run: missing bot token / chat_id / provider key — run `aisy init` first.\n')
  process.exit(1)
}
const allowedChatId = Number(chatIdRaw)

const TOOLS: AnthropicTool[] = [
  { name: 'read_file', description: 'Read a file in the workspace', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write a file in the workspace', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'list_dir', description: 'List a directory in the workspace', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'bash', description: 'Run a shell command in the sandbox', input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  { name: 'search_memory', description: 'Search long-term memory (FTS) for relevant facts', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'spawn_subagent', description: 'Delegate a scoped task or a goal-DAG plan to a sub-agent (AgentCard). Arg: plan = JSON of {steps:[{intent}]} or a PlanDAG.', input_schema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] } },
  { name: 'goal_done', description: 'Signal that you believe the active goal objective is now met. A deterministic probe verifies the claim before the goal is closed.', input_schema: { type: 'object', properties: { summary: { type: 'string' } } } },
]

const fsPort: FsPort = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c, 'utf8'),
  listDir: (p) => readdirSync(p),
  exists: (p) => existsSync(p),
}

const grantPersistence: GrantPersistencePort = {
  loadAlways: () => {
    if (!existsSync(grantsPath)) return []
    try {
      const j = JSON.parse(readFileSync(grantsPath, 'utf8')) as { always?: string[] }
      return Array.isArray(j.always) ? j.always : []
    } catch {
      return []
    }
  },
  saveAlways: (tools) =>
    writeFileSync(grantsPath, JSON.stringify({ always: tools }, null, 2), { encoding: 'utf8', mode: 0o600 }),
}

const nowIso = (): string => new Date().toISOString()
const memoryRoot = vault['AISY_MEMORY_ROOT'] ?? process.env['AISY_MEMORY_ROOT'] ?? join(base, 'memory')
const dbPath = vault['AISY_DB_PATH'] ?? process.env['AISY_DB_PATH'] ?? join(base, 'memory.db')

const journalPath = join(base, 'journal.jsonl')
const journal = makeJsonlJournal({
  appendLine: (line) => appendFileSync(journalPath, line + '\n', { encoding: 'utf8', mode: 0o600 }),
  nowIso,
})

const memoryStore = makeMemoryStore({
  memoryRoot,
  dbPath,
  emitEvent: async (event, payload) => journal.append('memory', event, payload),
  nowIso,
})
const memory: MemoryPort = makeMemoryPort(memoryStore, nowIso)

const sessionLogPath = join(base, 'session-log.jsonl')
const sessionLog: SessionLog = makeJsonlSessionLog({
  appendLine: (line) => appendFileSync(sessionLogPath, line + '\n', { encoding: 'utf8', mode: 0o600 }),
})

const sandboxImage = process.env['AISY_SANDBOX_IMAGE'] ?? ''
const runBash = sandboxImage
  ? makeDockerBash({ image: sandboxImage, workspaceRoot, gvisor: process.env['AISY_SANDBOX_GVISOR'] === '1', timeoutSec: 120 })
  : undefined

const grants = makeGrantStore({ persistence: grantPersistence })

const prefixCache = process.env['AISY_PREFIX_CACHE'] !== '0'

function adapterFor(sel: ProviderSel): ProviderAdapter {
  const apiKey = keyFor(sel.provider)
  const baseUrl = baseUrlFor(sel.provider)
  return buildProvider({
    provider: sel.provider,
    model: sel.model,
    tools: TOOLS,
    prefixCache,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  })
}
const provider: ProviderAdapter = providersCfg.tiers
  ? makeTieredProvider({
      reasoning: adapterFor(providersCfg.tiers.reasoning),
      critique: adapterFor(providersCfg.tiers.critique),
      routine: adapterFor(providersCfg.tiers.routine),
    })
  : adapterFor(defaultSel)
const modelLabel = providersCfg.tiers ? 'mixed (per-tier)' : defaultSel.model

const memSearch = makeMemorySearch(memoryStore)

const executeTool = makeToolExecutor({
  fs: fsPort,
  workspaceRoot,
  searchMemory: memSearch,
  ...(runBash ? { runBash } : {}),
  spawnSubagent: (planJson) => spawnSubagent(planJson),  // thunk → const defined below (after budget)
})

// Live outbound-lockout source (ADR-0051): mirrors the loop's narrowed state so
// the gateway egress guard (streamReply) is truthful in the live binary, not a
// hardcoded false. The bot updates it after each turn from TurnResult.narrowed.
let outboundLocked = false

const gateway = makeGateway({
  getAllowedChatId: async () => allowedChatId,
  getBotToken: async () => token,
  isReady: () => true,
  transcribeVoice: async () => {
    throw new VoiceUnavailable('voice transcription not configured')
  },
  isOutboundLocked: () => outboundLocked,
  isSafetyAvailable: () => true,
})

const budgetUsd = Number(process.env['AISY_BUDGET_USD'] ?? '0') || 0

// Spend ledger + operator settings (ADR-0050 Phase 2), persisted under AISY_HOME.
const spendPath = join(base, 'spend.json')
const settingsPath = join(base, 'settings.json')
const readJson = <T>(path: string, fallback: T): T => {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}
const spend = makeSpendStore({
  persistence: {
    load: () => readJson<SpendEntry[]>(spendPath, []),
    save: (entries) => writeFileSync(spendPath, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 }),
  },
})
const settings = makeSettingsStore({
  persistence: {
    load: () => readJson<Partial<Settings>>(settingsPath, {}),
    save: (s) => writeFileSync(settingsPath, JSON.stringify(s, null, 2), { encoding: 'utf8', mode: 0o600 }),
  },
})

// Per-agent budget caps (ADR-0050 Phase 3): the main agent's cap is
// agents.main.budgetUsd or AISY_BUDGET_USD; sub-agents declare their own.
// `spent` is read live from the spend ledger.
const caps: Record<string, number> = { main: providersCfg.agents?.['main']?.budgetUsd ?? budgetUsd }
for (const [id, a] of Object.entries(providersCfg.agents ?? {})) {
  if (typeof a.budgetUsd === 'number') caps[id] = a.budgetUsd
}
const budget = makeBudgetTracker({
  caps,
  spent: (agentId) => spend.byAgent().find((a) => a.agentId === agentId)?.dollars ?? 0,
})

// --- Tier-3 sub-agent delegation wiring ---
const cardResolver = makeCardResolver({
  dir: join(base, 'agents'),
  exists: (p) => existsSync(p),
  readDir: (d) => (existsSync(d) ? readdirSync(d) : []),
  readFile: (p) => readFileSync(p, 'utf8'),
})

// Sub-agents use a base executor WITHOUT spawn_subagent — no nested delegation in v1.
const subAgentBaseExecutor = makeToolExecutor({
  fs: fsPort,
  workspaceRoot,
  searchMemory: memSearch,
  ...(runBash ? { runBash } : {}),
})

// Per-(sub)agent model selection from providers.json:agents; fall back to the default.
function selectionForAgent(agentId: string): ProviderSel {
  const a = providersCfg.agents?.[agentId]
  return a?.provider != null && a.model != null ? { provider: a.provider, model: a.model } : defaultSel
}

// The bot supplies the human approval port inside buildRunner; capture it for sub-agents.
let approveRef: ((action: PendingAction) => Promise<ApprovalDecision>) | null = null

const spawnSubagent = async (planJson: string): Promise<TaskObservation[]> => {
  let parsed: unknown
  try { parsed = JSON.parse(planJson) }
  catch { return [] }
  const plan = normalizeSpawnPlan(parsed, DEFAULT_GENERAL_CARD.name)
  let manager
  try {
    manager = makeDelegationManager(plan, {
      resolveCard: (name) => cardResolver.resolve(name) ?? cardResolver.resolve(DEFAULT_GENERAL_CARD.name) ?? DEFAULT_GENERAL_CARD,
      skillTouchedPaths: () => [],   // Skills (06) not live yet — default card declares none
      mcpWritable: () => false,      // MCP (07) not live yet
      emit: () => {},                // Observability journal wired in Tier 4
    })
  } catch { return [] }
  return runDelegation({
    manager,
    runTask: async (handle, task) => {
      const agentId = task.assignedTo ?? handle.card.name
      const sel = selectionForAgent(agentId)
      const shardLog: SessionLog = {
        append: (e: LogEntry) => { handle.append(e.kind, e.payload) },
        resume: () => null,
      }
      const subRunner = makeSubAgentRunner({
        handle,
        provider: adapterFor(sel),
        baseExecuteTool: subAgentBaseExecutor,
        approve: approveRef ?? (async () => ({ decision: 'rejected' as const })),
        memory,
        sessionLog: shardLog,
        parentNarrowed: outboundLocked,   // Tier-2 narrowed mirror (one-turn-stale, ADR-0052)
        doNotTouch: task.scope.doNotTouch,
      })
      const result = await subRunner.handle({
        sessionId: handle.delegationId,
        spans: [{ role: 'user', provenance: 'operator', text: task.intent }],
      })
      if (result.usage != null) {
        spend.record({ model: sel.model, agentId, usage: result.usage })
      }
      const cost = { iterations: 1, spendUsd: result.usage?.dollars ?? 0, wallMs: 0 }
      return result.state === 'halted'
        ? handle.fail(result.haltReason ?? 'halted', cost)
        : handle.complete(result.reply, result.reply, cost)
    },
  })
}

// --- Tier-4 nightly consolidation ---
const nightlyAt = process.env['AISY_NIGHTLY_AT'] ?? '03:30'
const nightlyConfig: NightlyConfig = {
  runAt: nightlyAt,
  maxHeldMs: 2 * 60 * 60 * 1000,
  lintStaleDays: 30,
  backupRemote: process.env['AISY_BACKUP_REMOTE'] ?? '',
  stagingDir: join(base, 'staging'),
  archiveDir: join(base, 'archive'),
}

// Generator on the routine tier; judge on critique. Single-provider fallback logged.
const genSel = providersCfg.tiers?.routine ?? defaultSel
const judgeSel = providersCfg.tiers?.critique ?? defaultSel
if (genSel === judgeSel) {
  process.stdout.write('aisy run: nightly judge uses the same provider as the generator (single-provider config)\n')
}

const bootStamp = nowIso()
const processStartTime = Date.now()

// v1 limitation: facts/validators are captured at process boot; facts added during
// the session are consolidated only after a restart — a facts-thunk for live
// freshness is a follow-up. Both facts AND validators are boot-time → internally consistent.
const bootLiveFacts = await memoryStore.listLive()
const nightlyRunner = makeConsolidationRunner({
  clock: { now: () => new Date(nowIso()) },
  generator: makeNightlyGenerator({ provider: adapterFor(genSel), nowIso }),
  judge: makeNightlyJudge({ provider: adapterFor(judgeSel) }),
  validators: makeMemoryValidators({ liveFactIds: new Set(bootLiveFacts.map((f) => f.id)) }),
  lock: makeFileRunLock({
    lockPath: join(base, 'nightly.lock'),
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, c) => writeFileSync(p, c, { encoding: 'utf8', mode: 0o600 }),
    exists: (p) => existsSync(p),
    removeFile: (p) => { try { unlinkSync(p) } catch { /* stale lock already gone */ } },
    pid: process.pid,
    bootId: bootStamp,
    startTime: processStartTime,
    now: () => Date.now(),
  }),
  facts: liveFactsForNightly(bootLiveFacts),
  memoryTxn: async (apply) => { await apply() },
  reindex: (factId) => { void memoryStore.reindex({ ids: [factId] }) },
  emit: (event) => journal.append('nightly', event, {}),
  commitOp: async (op) => {
    const mop = memOpToMemoryOp(op)
    if (!mop) return null
    if (mop.op === 'DELETE') {
      await memoryStore.forget(mop.targetId, mop.reason, mop.humanConfirmed)
      return mop.targetId
    }
    const r = await memoryStore.commit(mop, { withinSession: false })
    return r.factId ?? null
  },
})

// --- Tier-4 D2: helpers for trigger command parsing ---

/** Parse a relative or absolute time string into an ISO-8601 string, or null. */
function parseWhen(when?: string): string | null {
  if (!when) return null
  const rel = /^(\d+)(m|h|d)$/.exec(when)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]!
    const ms = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000
    return new Date(Date.now() + ms).toISOString()
  }
  const parsed = Date.parse(when)
  if (!isNaN(parsed)) return new Date(parsed).toISOString()
  return null
}

/** Parse a probe shorthand (file:<path> or http:<url>) into a VerificationTrace, or null. */
function parseProbe(p?: string): VerificationTrace | null {
  if (!p) return null
  if (p.startsWith('file:')) {
    const path = p.slice('file:'.length)
    if (!path) return null
    return { kind: 'file', path, existsExpected: true }
  }
  if (p.startsWith('http:')) {
    const url = p.slice('http:'.length)
    if (!url) return null
    return { kind: 'http', method: 'GET', url, expectStatus: 200 }
  }
  return null
}

// sendProactive is resolved after makeTelegramBot; runNightly captures it via closure.
let sendProactiveRef: ((text: string) => Promise<void>) | null = null

// --- Tier-7 goal wiring (pre-bot declarations; onGoalCommand closes over these) ---
const goalStore = makeGoalStore({
  path: join(base, 'goal.json'),
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c, { encoding: 'utf8', mode: 0o600 }),
  exists: (p) => existsSync(p),
  removeFile: (p) => { try { unlinkSync(p) } catch { /* already gone */ } },
})
const goalBackstop = {
  maxIterations: Number(process.env['AISY_GOAL_MAX_ITERATIONS'] ?? '25') || 25,
  tokenCeiling: Number(process.env['AISY_GOAL_TOKEN_CEILING'] ?? '500000') || 500000,
  dollarCeiling: Number(process.env['AISY_GOAL_DOLLAR_CEILING'] ?? '5') || 5,
}
// Forward reference: orchestrator is assigned after makeTelegramBot (chicken-egg break).
// onGoalCommand (inside makeTelegramBot deps) closes over orchestrator by reference;
// it is only called at runtime (never at definition time), so the assignment below is safe.
let orchestrator: ReturnType<typeof makeGoalOrchestrator>
let goalAbort: AbortController | null = null

async function runNightly(): Promise<void> {
  const result = await nightlyRunner.run(nightlyConfig)
  await gateway.issueCard({
    actionId: `nightly-${result.runDate}`,
    actionHash: createHash('sha256').update(`nightly:${result.runDate}`).digest('hex'),
    tier: 1,
    requiresStepUp: false,
    summary: `🌅 Ночная консолидация ${result.runDate}: ${result.card.memoryEdits.length} правок памяти на одобрение.`,
  })
  await sendProactiveRef?.(`🌅 Ночная консолидация ${result.runDate} готова — ${result.card.memoryEdits.length} правок в staging. Открой карту для одобрения.`)
}

const { bot, runProactiveTurn, sendProactive, runGoalTurn } = makeTelegramBot({
  token,
  allowedChatId,
  gateway,
  model: modelLabel,
  budgetUsd,
  settings,
  spend,
  budget,
  setOutboundLocked: (locked) => { outboundLocked = locked },
  onConsolidate: runNightly,
  getStaging: async () => {
    const area = await nightlyRunner.getStagedProposals()
    return area.memoryPatches.map((p) => ({ id: p.id, preview: p.body.slice(0, 80), judged: p.judged }))
  },
  onApproveNightly: async (id: string) => {
    await nightlyRunner.approveStagedItem(id)
  },
  onRegisterTrigger: async (input) => {
    try {
      const budget = { tokenCeiling: 50000, dollarCeiling: 0.5, tokensSpent: 0, dollarsSpent: 0 }
      if (input.kind === 'remind') {
        const fireAt = parseWhen(input.when)
        if (!fireAt) return { ok: false, error: 'Не понял время. Примеры: 30m, 2h, 1d, или ISO-8601.' }
        const spec = await triggerEngine.register({ id: randomUUID(), kind: 'remind', createdBy: 'operator', prompt: input.prompt, fireAt, budget })
        return { ok: true, id: spec.id }
      }
      if (input.kind === 'schedule') {
        const spec = await triggerEngine.register({ id: randomUUID(), kind: 'schedule', createdBy: 'operator', prompt: input.prompt, cron: input.cron!, budget })
        return { ok: true, id: spec.id }
      }
      // watch
      const probe = parseProbe(input.probe)
      if (!probe) return { ok: false, error: 'Не понял пробу. Примеры: file:/path, http:https://…' }
      const spec = await triggerEngine.register({ id: randomUUID(), kind: 'watch', createdBy: 'operator', prompt: input.prompt, probe, intervalMs: 60000, budget })
      return { ok: true, id: spec.id }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'ошибка' } }
  },
  onListTriggers: async () => (await triggerEngine.list()).map((t) => ({ id: t.id, kind: t.kind, prompt: t.prompt })),
  onCancelTrigger: async (id) => { try { await triggerEngine.cancel(id); return true } catch { return false } },
  buildRunner: (approve: (action: PendingAction) => Promise<ApprovalDecision>) => {
    approveRef = approve
    return makeAgentRunner({
      provider,
      memory,
      grants,
      executeTool,
      approve,
      guardian: makeGuardian(),
      sessionLog,
      maxTotalToolCalls: 50,
      // Mid-turn budget (ADR-0051): when enforcement is on and this turn's
      // running spend would cross the main agent's cap, halt the turn.
      budgetCheck: (usage) => {
        if (settings.get().budgetEnabled !== true) return false
        const cap = budget.capFor('main')
        if (cap <= 0) return false
        return budget.spentFor('main') + usage.dollars >= cap
      },
    })
  },
  buildGoalRunner: (approve: (action: PendingAction) => Promise<ApprovalDecision>) => {
    let done = false
    const goalExec: typeof executeTool = (call) => {
      if (call.name === 'goal_done') {
        done = true
        return Promise.resolve({ ok: true as const, output: 'acknowledged' })
      }
      return executeTool(call)
    }
    const runner = makeAgentRunner({
      provider,
      memory,
      grants,
      executeTool: goalExec,
      approve,
      guardian: makeGuardian(),
      sessionLog,
      maxTotalToolCalls: 50,
      budgetCheck: (usage) => {
        if (settings.get().budgetEnabled !== true) return false
        const cap = budget.capFor('main')
        if (cap <= 0) return false
        return budget.spentFor('main') + usage.dollars >= cap
      },
    })
    return { runner, takeClaimedDone: () => { const d = done; done = false; return d } }
  },
  onGoalCommand: async (input) => {
    if (input.kind === 'status') {
      const g = orchestrator.status() ?? await goalStore.load()
      if (!g) return { ok: true as const, message: 'Активной цели нет.' }
      return { ok: true as const, message: `🎯 ${g.objective}\nРежим: ${g.mode.kind} · статус: ${g.status} · итераций: ${g.iterationsSpent}/${g.backstop.maxIterations} · $${g.usageSpent.dollars.toFixed(3)}/${g.backstop.dollarCeiling}` }
    }
    if (input.kind === 'stop') {
      goalAbort?.abort()
      await goalStore.clear()
      return { ok: true as const, message: '⏹ Цель остановлена.' }
    }
    // start
    const mode: GoalMode | null = parseGoalMode(input.mode)
    if (!mode) return { ok: false as const, error: `Не понял режим «${input.mode}». Примеры: until, until:file:/p, every:10m, budget:0.50` }
    goalAbort?.abort()
    goalAbort = new AbortController()
    const grantedScope = (process.env['AISY_GOAL_SCOPE']?.split(',').map((s) => s.trim()).filter(Boolean)) ?? ['read_file', 'list_dir', 'search_memory']
    const spec = makeGoalSpec({ id: randomUUID(), objective: input.objective, mode, backstop: goalBackstop, grantedScope, nowIso: nowIso() })
    await goalStore.save(spec)
    if (mode.kind !== 'every') void orchestrator.start(spec, goalAbort.signal)
    return { ok: true as const, message: `🎯 Цель принята (${mode.kind}). ${mode.kind === 'every' ? 'Буду работать по расписанию.' : 'Работаю до завершения/бэкстопа. /goal status — прогресс, /goal stop — стоп.'}` }
  },
})
sendProactiveRef = sendProactive

// --- Tier-4 triggers ---
const triggerStore = makeTriggerStore({
  path: join(base, 'triggers.json'),
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c, { encoding: 'utf8', mode: 0o600 }),
  exists: (p) => existsSync(p),
})
const triggerProbe = makeTriggerProbeRunner({
  exists: (p) => existsSync(p),
  ...(runBash ? { runBash: async (cmd) => { const r = await runBash(cmd); return { exitCode: r.exitCode } } } : {}),
})
const triggerBudget: TriggerBudget = {
  tokenCeiling: 200000,
  dollarCeiling: Number(process.env['AISY_TRIGGER_BUDGET_USD'] ?? '1') || 1,
  tokensSpent: 0,
  dollarsSpent: 0,
}
const triggerEngine = makeTriggerEngine({
  clock: { now: () => nowIso() },
  probeRunner: triggerProbe,
  startTurn: async ({ prompt, spans }) => {
    const provenance = spans.some((s) => s.provenance === 'untrusted') ? 'untrusted' as const : 'operator' as const
    // Debit the global background budget so budgetExhausted() eventually bites
    // and pauses further background firings. Per-trigger spec.budget debit needs
    // store persistence and is a documented follow-up; the shared cap is the key
    // anti-drain guard for v1.
    const before = spend.total()
    await runProactiveTurn(prompt, { provenance })
    const after = spend.total()
    triggerBudget.tokensSpent += Math.max(0, (after.inputTokens + after.outputTokens) - (before.inputTokens + before.outputTokens))
    triggerBudget.dollarsSpent += Math.max(0, after.dollars - before.dollars)
  },
  store: triggerStore,
  emitEvent: (event, payload) => { journal.append('triggers', event, payload) },
  globalBackgroundBudget: triggerBudget,
})

// --- Tier-7 goal orchestrator (assigned here; triggerProbe + sendProactive now in scope) ---
orchestrator = makeGoalOrchestrator({
  store: goalStore,
  runGoalTurn,
  probeRunner: triggerProbe,
  recordGrant: (tool) => grants.record(tool, 'session'),
  sendProgress: sendProactive,
  clock: { now: () => nowIso() },
  emit: (event, payload) => { journal.append('goal', event, payload) },
})

// --- Scheduler: drives nightly + trigger tick (triggers wired in Phase D) ---
const lastRunPath = join(base, 'nightly-last.json')
const scheduler = makeScheduler({
  now: () => new Date(nowIso()),
  nightlyAt,
  lastNightlyRun: () => {
    try {
      return (JSON.parse(readFileSync(lastRunPath, 'utf8')) as { date?: string }).date ?? null
    } catch {
      return null
    }
  },
  markNightlyRun: (date) => {
    try {
      writeFileSync(lastRunPath, JSON.stringify({ date }), { encoding: 'utf8', mode: 0o600 })
    } catch { /* non-fatal */ }
  },
  runNightly,
  tickTriggers: async () => { await triggerEngine.tick() },
  tickGoal: (() => {
    let lastGoalTick = 0
    return async () => {
      const g = await goalStore.load()
      if (g?.mode.kind !== 'every' || g.status !== 'active') return
      const intervalMs = (g.mode as { kind: 'every'; intervalMs?: number }).intervalMs ?? 600_000
      if ((Date.now() - lastGoalTick) < intervalMs) return
      if (!goalAbort) return
      lastGoalTick = Date.now()
      await orchestrator.tick(goalAbort.signal)
    }
  })(),
})
scheduler.start()

// Resume any active goal persisted from a previous run.
goalAbort = new AbortController()
await orchestrator.resume(goalAbort.signal)

process.stdout.write(`aisy run: starting Telegram agent (chat ${allowedChatId}, model ${modelLabel})…\n`)
void bot.start()
