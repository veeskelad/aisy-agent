#!/usr/bin/env node
// `aisy-run` — boot the live Telegram agent.
//
// Wires real runtime adapters (Anthropic provider, node fs tools, gateway,
// persisted grants) into the agent runner and starts grammY long-polling.
// Secrets are read from the vault (~/.aisy/vault.json), seeded by `aisy init`.
//
// MVP adapters: no sandbox (bash reports unavailable), cold-start memory, and an
// in-memory session log. These layer in as the corresponding ports land.

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  makeAgentRunner,
  makeAnthropicProvider,
  makeToolExecutor,
  makeGateway,
  makeGrantStore,
  VoiceUnavailable,
  type AnthropicTool,
  type ApprovalDecision,
  type FsPort,
  type GrantPersistencePort,
  type LoopGuardian,
  type MemoryPort,
  type PendingAction,
  type SessionLog,
} from '@aisy/core'
import { makeTelegramBot } from '../bot.js'

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
const apiKey = vault['AISY_PROVIDER_REASONING_KEY'] ?? process.env['AISY_PROVIDER_REASONING_KEY'] ?? ''
const model = process.env['AISY_PROVIDER_MODEL'] ?? 'claude-sonnet-4-6'

if (!token || !chatIdRaw || !apiKey) {
  process.stderr.write('aisy run: missing bot token / chat_id / provider key — run `aisy init` first.\n')
  process.exit(1)
}
const allowedChatId = Number(chatIdRaw)

// Tools advertised to the model (MVP set; bash is gated by the sandbox port).
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

// MVP memory: cold-start snapshot, no within-session forget persistence.
const memory: MemoryPort = {
  snapshot: async () => ({ prefixBytes: new Uint8Array(), prefixHash: 'cold', breakpoints: [], takenAt: new Date().toISOString() }),
  forget: async () => {},
}
const sessionLog: SessionLog = { append: () => {}, resume: () => null }
// MVP guardian: no cycle detection yet — the runner's tool-call cap is the
// backstop. TODO: wire a real agent-loop LoopGuardian.
const guardian: LoopGuardian = { observe: () => ({ trip: false }), note: () => {} }

const grants = makeGrantStore({ persistence: grantPersistence })
const provider = makeAnthropicProvider({ apiKey, model, tools: TOOLS })
const executeTool = makeToolExecutor({ fs: fsPort, workspaceRoot })

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

const bot = makeTelegramBot({
  token,
  allowedChatId,
  gateway,
  buildRunner: (approve: (action: PendingAction) => Promise<ApprovalDecision>) =>
    makeAgentRunner({ provider, memory, grants, executeTool, approve, guardian, sessionLog, maxTotalToolCalls: 50 }),
})

process.stdout.write(`aisy run: starting Telegram agent (chat ${allowedChatId}, model ${model})…\n`)
void bot.start()
