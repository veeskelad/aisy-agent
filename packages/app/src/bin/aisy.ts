#!/usr/bin/env node
// Unified `aisy` CLI.
//   aisy run                  → boot the live Telegram agent (this package)
//   aisy init|doctor|…        → onboarding (delegated to @aisy/core's runCli)
//
// Secrets are read from the vault (~/.aisy/vault.json), seeded by `aisy init`.
// Run adapters: bash sandboxed only when AISY_SANDBOX_IMAGE is set; SQLite-backed
// memory (FTS) + search_memory tool, and a durable jsonl session log (ADR-0048,
// Tier-1 wiring). Full crash-resume (SessionLog.resume) is still deferred.

import { existsSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs'
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
} from '@aisy/core'
import { makeTelegramBot } from '../bot.js'

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

const sandboxImage = process.env['AISY_SANDBOX_IMAGE'] ?? ''
const runBash = sandboxImage
  ? makeDockerBash({ image: sandboxImage, workspaceRoot, gvisor: process.env['AISY_SANDBOX_GVISOR'] === '1', timeoutSec: 120 })
  : undefined

const grants = makeGrantStore({ persistence: grantPersistence })

function adapterFor(sel: ProviderSel): ProviderAdapter {
  const apiKey = keyFor(sel.provider)
  const baseUrl = baseUrlFor(sel.provider)
  return buildProvider({
    provider: sel.provider,
    model: sel.model,
    tools: TOOLS,
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

const bot = makeTelegramBot({
  token,
  allowedChatId,
  gateway,
  model: modelLabel,
  budgetUsd,
  settings,
  spend,
  budget,
  setOutboundLocked: (locked) => { outboundLocked = locked },
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
})

process.stdout.write(`aisy run: starting Telegram agent (chat ${allowedChatId}, model ${modelLabel})…\n`)
void bot.start()
