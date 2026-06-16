#!/usr/bin/env node
// Unified `aisy` CLI.
//   aisy run                  → boot the live Telegram agent (this package)
//   aisy init|doctor|…        → onboarding (delegated to @aisy/core's runCli)
//
// Secrets are read from the vault (~/.aisy/vault.json), seeded by `aisy init`.
// MVP run adapters: bash sandboxed only when AISY_SANDBOX_IMAGE is set;
// cold-start memory + in-memory session log (see ADR-0048).

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
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

const memory: MemoryPort = {
  snapshot: async () => ({ prefixBytes: new Uint8Array(), prefixHash: 'cold', breakpoints: [], takenAt: new Date().toISOString() }),
  forget: async () => {},
}
const sessionLog: SessionLog = { append: () => {}, resume: () => null }

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

const executeTool = makeToolExecutor({ fs: fsPort, workspaceRoot, ...(runBash ? { runBash } : {}) })

const gateway = makeGateway({
  getAllowedChatId: async () => allowedChatId,
  getBotToken: async () => token,
  isReady: () => true,
  transcribeVoice: async () => {
    throw new VoiceUnavailable('voice transcription not configured')
  },
  isOutboundLocked: () => false,
  isSafetyAvailable: () => true,
})

const budgetUsd = Number(process.env['AISY_BUDGET_USD'] ?? '0') || 0
const bot = makeTelegramBot({
  token,
  allowedChatId,
  gateway,
  model: modelLabel,
  budgetUsd,
  buildRunner: (approve: (action: PendingAction) => Promise<ApprovalDecision>) =>
    makeAgentRunner({ provider, memory, grants, executeTool, approve, guardian: makeGuardian(), sessionLog, maxTotalToolCalls: 50 }),
})

process.stdout.write(`aisy run: starting Telegram agent (chat ${allowedChatId}, model ${modelLabel})…\n`)
void bot.start()
