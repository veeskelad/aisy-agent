// Headless single-turn driver for Aisy — drive the fully-wired agent WITHOUT Telegram.
// Mirrors packages/app/src/bin/aisy.ts wiring, minus goals/triggers/nightly.
// Usage:
//   AISY_PROVIDER_OPENAI_KEY=... node scripts/chat-once.mjs "prompt one" "prompt two" ...
// Each argv prompt runs as its own session against a shared, persistent memory store,
// so `remember` in one turn is recallable in the next.

import { existsSync, readFileSync, writeFileSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  makeAgentRunner,
  makeToolExecutor,
  makeGrantStore,
  makeGuardian,
  buildProvider,
  makeMemoryStore,
  makeMemoryPort,
  makeMemorySearch,
  makeJsonlSessionLog,
  htmlToText,
  parseDuckDuckGo,
  isPublicHttpUrl,
} from '../packages/core-ts/dist/index.js'

const base = process.env['AISY_HOME'] ?? join(homedir(), '.aisy')
const workspaceRoot = process.env['AISY_WORKSPACE'] ?? process.cwd()
const memoryRoot = process.env['AISY_MEMORY_ROOT'] ?? join(base, 'memory')
const dbPath = process.env['AISY_DB_PATH'] ?? join(base, 'memory.db')
const providerId = process.env['AISY_PROVIDER'] ?? 'deepseek'
const model = process.env['AISY_MODEL'] ?? (providerId === 'deepseek' ? 'deepseek-chat' : 'gpt-4o')
const keyEnv = providerId === 'deepseek' ? 'AISY_PROVIDER_DEEPSEEK_KEY' : 'AISY_PROVIDER_OPENAI_KEY'
const altEnv = providerId === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'

// Key: prefer the aisy vault, fall back to env.
function vaultKey() {
  try {
    const v = JSON.parse(readFileSync(join(base, 'vault.json'), 'utf8'))
    return v[keyEnv] ?? ''
  } catch { return '' }
}
const apiKey = process.env[keyEnv] ?? process.env[altEnv] ?? vaultKey()
if (!apiKey) { process.stderr.write(`chat-once: no provider key (${keyEnv} / ${altEnv} / vault)\n`); process.exit(1) }

const prompts = process.argv.slice(2)
if (prompts.length === 0) { process.stderr.write('chat-once: pass at least one prompt\n'); process.exit(1) }

const nowIso = () => new Date().toISOString()

// Same base tool set as bin/aisy.ts (subset the headless test exercises).
const TOOLS = [
  { name: 'read_file', description: 'Read a UTF-8 file from the workspace and get its contents. Always read before you describe what a file contains. Arg `path` is relative to the workspace root.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or overwrite a workspace file with the full new contents. Overwriting is irreversible and may show the operator an approval card.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'list_dir', description: 'List the entries of a workspace directory. Use this FIRST to discover what files exist. Arg `path` (omit or "." for root).', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'bash', description: 'Run a shell command in the workspace and get stdout/stderr. Use for system facts and searches (ls, grep, find, cat).', input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  { name: 'search_memory', description: 'Full-text search your long-term memory for facts about the operator and past work. Call this BEFORE answering when the request refers to something you may have stored. Arg `query`.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'remember', description: 'Save a durable fact to long-term memory for future sessions. Arg `text`.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fetch_url', description: 'Fetch a public web page and get its readable text. Arg `url` (http/https). Internal addresses refused.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'web_search', description: 'Search the web and get the top results. Arg `query`.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
]

const fsPort = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c, 'utf8'),
  listDir: (p) => readdirSync(p),
  exists: (p) => existsSync(p),
}

const runBash = (cmd) => new Promise((resolve) => {
  execFile('bash', ['-c', cmd], { cwd: workspaceRoot, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: err && typeof err.code === 'number' ? err.code : err ? 1 : 0 })
  })
})

const memoryStore = makeMemoryStore({ memoryRoot, dbPath, emitEvent: async () => {}, nowIso })
await memoryStore.rebuildFromFiles()
const memory = makeMemoryPort(memoryStore, nowIso)
const memSearch = makeMemorySearch(memoryStore)

const provider = buildProvider({ provider: providerId, model, tools: TOOLS, prefixCache: false, apiKey })

// Log every tool call so we can see whether the agent actually acts with its hands.
const toolLog = []
const baseExec = makeToolExecutor({
  fs: fsPort,
  workspaceRoot,
  searchMemory: memSearch,
  memory: memoryStore,
  runBash,
  fetchUrl: async (url) => {
    if (!isPublicHttpUrl(url)) return 'fetch_url: refused (non-public or non-http URL)'
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow', headers: { 'user-agent': 'aisy-agent' } })
      if (!res.ok) return `fetch_url: HTTP ${res.status}`
      return htmlToText(await res.text())
    } catch (e) { return `fetch_url: ${e instanceof Error ? e.message : String(e)}` }
  },
  webSearch: async (query) => {
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'aisy-agent' } })
      const results = parseDuckDuckGo(await res.text())
      return results.length ? results.map((r) => `${r.title}\n${r.url}\n${r.snippet}`).join('\n\n') : 'web_search: ничего не найдено.'
    } catch (e) { return `web_search: ${e instanceof Error ? e.message : String(e)}` }
  },
})
const executeTool = (call) => { toolLog.push(call.name); return baseExec(call) }

const sessionLog = makeJsonlSessionLog({ appendLine: () => {}, readLines: () => [] })
const grants = makeGrantStore({ persistence: { loadAlways: () => [], saveAlways: () => {} } })

// Headless: no approval UI. Approval policy is chosen via AISY_APPROVE:
//   'reject' (default) — auto-reject irreversible/side-effecting tools (observe that
//     the agent ASKS instead of silently acting — the Autonomy Guard behaviour).
//   'confirm' — auto-approve, so side-effecting tools (bash, write_file) actually run,
//     standing in for the operator tapping "confirm" on the real Telegram card.
const approveMode = process.env['AISY_APPROVE'] ?? 'reject'
const approve = async () => ({ decision: approveMode === 'confirm' ? 'confirmed' : 'rejected' })

const runner = makeAgentRunner({ provider, memory, grants, executeTool, approve, guardian: makeGuardian(), sessionLog, maxTotalToolCalls: 20 })

// Per-turn language nudge, same as bot.ts replyLanguageInstruction.
const langInstruction = (text) => /[Ѐ-ӿ]/.test(text) ? 'Отвечай на русском языке.' : 'Reply in the same language the operator used in their message.'

for (let i = 0; i < prompts.length; i++) {
  const text = prompts[i]
  toolLog.length = 0
  const spans = [
    { role: 'system', provenance: 'operator', text: langInstruction(text) },
    { role: 'user', provenance: 'operator', text },
  ]
  const started = Date.now()
  let out
  try {
    out = await runner.handle({ sessionId: `chat-once-${i}`, spans, signal: new AbortController().signal })
  } catch (e) {
    out = { reply: `[ERROR] ${e instanceof Error ? e.stack ?? e.message : String(e)}`, state: 'error' }
  }
  const ms = Date.now() - started
  process.stdout.write(`\n===== PROMPT ${i + 1} =====\n> ${text}\n`)
  process.stdout.write(`--- tools: [${toolLog.join(', ') || 'none'}] · state: ${out.state} · ${ms}ms ---\n`)
  process.stdout.write(`${out.reply}\n`)
}
process.exit(0)
