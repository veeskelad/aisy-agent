// Node onboarding adapters (runtime).
//
// Concrete port implementations for the onboarding ops — filesystem, prereq
// probes, network validators, SQLite memory checks, the JSON vault, docker
// sandbox probes, MCP allowlist, and nightly hooks. Extracted from the bin so
// both the (legacy) core entry and the app's unified `aisy` CLI share one
// wiring. No business logic — env vars and the local filesystem are the seams.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { makeOnboardingOps } from '../onboarding/index.js'
import type {
  PromptPort,
  TelegramPairUpdate,
  ProviderCatalogEntry,
  ProvidersConfig,
} from '../onboarding/types.js'
import { PROVIDER_CATALOG, findProvider } from './providers.js'

/** Readline-backed interactive prompt; secret() mutes echo for token entry. */
function makeReadlinePrompt(): PromptPort {
  // Ctrl-C during any prompt: restore the terminal (rl.close) and exit quietly
  // (130). Without this, the bin's top-level `await runCli` is left unsettled and
  // Node prints a "Detected unsettled top-level await" warning. This just exits.
  const newRl = (): ReturnType<typeof createInterface> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on('SIGINT', () => {
      rl.close()
      process.exit(130)
    })
    return rl
  }
  const ask = (q: string, opts?: { default?: string }): Promise<string> =>
    new Promise((resolve) => {
      const rl = newRl()
      const def = opts?.default ? ` [${opts.default}]` : ''
      rl.question(`${q}${def}: `, (a) => {
        rl.close()
        resolve(a.trim().length > 0 ? a.trim() : (opts?.default ?? ''))
      })
    })
  return {
    info: (m: string): void => void process.stdout.write(`${m}\n`),
    ask,
    confirm: (q: string, opts?: { default?: boolean }): Promise<boolean> =>
      new Promise((resolve) => {
        const rl = newRl()
        rl.question(`${q} [${opts?.default ? 'Y/n' : 'y/N'}]: `, (a) => {
          rl.close()
          const t = a.trim().toLowerCase()
          resolve(t.length === 0 ? (opts?.default ?? false) : t.startsWith('y'))
        })
      }),
    secret: (q: string): Promise<string> =>
      new Promise((resolve) => {
        const rl = newRl()
        const out = rl as unknown as { _writeToOutput?: (s: string) => void }
        let muted = false
        out._writeToOutput = (s: string): void => {
          if (!muted) process.stdout.write(s)
        }
        rl.question(`${q} `, (a) => {
          rl.close()
          process.stdout.write('\n')
          resolve(a.trim())
        })
        muted = true
      }),
  }
}

const req = createRequire(import.meta.url)

type ToolName = 'node' | 'pnpm' | 'docker' | 'python' | 'ffmpeg'
const TOOL_CMD: Record<ToolName, [string, string[]]> = {
  node: ['node', ['--version']],
  pnpm: ['pnpm', ['--version']],
  docker: ['docker', ['--version']],
  python: ['python3', ['--version']],
  ffmpeg: ['ffmpeg', ['-version']],
}

type Db = { prepare(s: string): { get(): unknown }; close(): void }

/** Build the onboarding ops with real Node adapters. Honors AISY_HOME. */
export function makeNodeOnboardingOps(): ReturnType<typeof makeOnboardingOps> {
  const base = process.env['AISY_HOME'] ?? join(homedir(), '.aisy')
  const dbPath = join(base, 'memory.db')
  const vaultPath = join(base, 'vault.json')
  const mcpAllowlistPath = join(base, 'mcp-allowlist.json')
  const nightlyLockPath = join(base, 'nightly.lock')

  const clock = { nowIso: (): string => new Date().toISOString() }

  const nodeFs = {
    exists: (p: string): boolean => existsSync(p),
    isPopulated: (p: string): boolean => {
      if (!existsSync(p)) return false
      return readFileSync(p, 'utf8').split('\n').some((l) => l.trim().length > 0 && !l.startsWith('#'))
    },
    read: (p: string): string => readFileSync(p, 'utf8'),
    write: (p: string, c: string): void => {
      // Ensure the parent dir exists — scaffolds like memory/constitution.md
      // are written before the memory tree dirs are mkdirp'd.
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, c, 'utf8')
    },
    mkdirp: (p: string): void => {
      mkdirSync(p, { recursive: true })
    },
  }

  const prereqs = {
    version: (tool: ToolName): string | null => {
      const [cmd, args] = TOOL_CMD[tool]
      try {
        return execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000 }).split('\n')[0]?.trim() ?? null
      } catch {
        return null
      }
    },
  }

  const validators = {
    async pingProvider(_tier: string, key: string): Promise<{ ok: boolean; httpStatus?: number }> {
      if (!key) return { ok: false }
      try {
        const res = await fetch('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(8000),
        })
        return { ok: res.status < 400, httpStatus: res.status }
      } catch {
        return { ok: false }
      }
    },
    async telegramGetMe(token: string): Promise<{ ok: boolean; httpStatus?: number }> {
      if (!token) return { ok: false }
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
          signal: AbortSignal.timeout(8000),
        })
        const body = (await res.json()) as { ok: boolean }
        return { ok: body.ok, httpStatus: res.status }
      } catch {
        return { ok: false }
      }
    },
    async telegramGetUpdates(token: string): Promise<{ ok: boolean; updates?: TelegramPairUpdate[] }> {
      if (!token) return { ok: false }
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=0`, {
          signal: AbortSignal.timeout(8000),
        })
        const body = (await res.json()) as {
          ok: boolean
          result?: { message?: { chat?: { id?: number }; text?: string; from?: { username?: string } } }[]
        }
        const updates: TelegramPairUpdate[] = []
        for (const u of body.result ?? []) {
          const m = u.message
          if (m?.chat?.id !== undefined && typeof m.text === 'string') {
            updates.push({
              chatId: m.chat.id,
              text: m.text,
              ...(m.from?.username ? { username: m.from.username } : {}),
            })
          }
        }
        return { ok: body.ok, updates }
      } catch {
        return { ok: false }
      }
    },
    // Provider-aware reachability for the catalog picker (ADR-0050). Resolves
    // the family/endpoint from the catalog id; CLI providers skip (no key).
    async pingCatalogProvider(opts: {
      providerId: string
      baseUrl?: string
      key: string
    }): Promise<{ ok: boolean; httpStatus?: number }> {
      const entry = findProvider(opts.providerId)
      if (!entry) return { ok: false }
      if (entry.kind === 'cli') return { ok: true }
      if (!opts.key) return { ok: false }
      try {
        if (entry.kind === 'anthropic') {
          const base = opts.baseUrl ?? 'https://api.anthropic.com/v1'
          const res = await fetch(`${base}/models`, {
            headers: { 'x-api-key': opts.key, 'anthropic-version': '2023-06-01' },
            signal: AbortSignal.timeout(8000),
          })
          return { ok: res.status < 400, httpStatus: res.status }
        }
        const base = opts.baseUrl ?? entry.defaultBaseUrl
        if (!base) return { ok: false }
        const res = await fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${opts.key}` },
          signal: AbortSignal.timeout(8000),
        })
        return { ok: res.status < 400, httpStatus: res.status }
      } catch {
        return { ok: false }
      }
    },
  }

  // Provider catalog for the interactive picker — mapped to the onboarding's
  // decoupled shape (needsKey instead of provider-kind internals).
  const providerCatalog: ProviderCatalogEntry[] = PROVIDER_CATALOG.map((e) => ({
    id: e.id,
    label: e.label,
    needsKey: e.kind !== 'cli',
    ...(e.defaultBaseUrl ? { defaultBaseUrl: e.defaultBaseUrl } : {}),
    ...(e.keyEnv ? { keyEnv: e.keyEnv } : {}),
    ...(e.defaultModels ? { defaultModels: e.defaultModels } : {}),
  }))

  const providersOut = {
    write(config: ProvidersConfig): void {
      writeFileSync(join(base, 'providers.json'), JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 })
    },
  }

  const providersIn = {
    read(): ProvidersConfig | null {
      const p = join(base, 'providers.json')
      if (!existsSync(p)) return null
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as ProvidersConfig
      } catch {
        return null
      }
    },
  }

  const openDb = (): Db | null => {
    if (!existsSync(dbPath)) return null
    try {
      const Ctor = req('better-sqlite3') as (p: string, o?: object) => Db
      return Ctor(dbPath, { readonly: true })
    } catch {
      return null
    }
  }

  const memory = {
    async rebuildFromFiles(): Promise<void> {
      /* no-op: fully SQLite-backed */
    },
    async integrityCheck(): Promise<{ ok: boolean; detail?: string }> {
      const db = openDb()
      if (!db) return { ok: false, detail: `db not found at ${dbPath}` }
      try {
        const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined
        db.close()
        return row?.integrity_check === 'ok' ? { ok: true } : { ok: false, detail: 'integrity_check failed' }
      } catch (e) {
        return { ok: false, detail: String(e) }
      }
    },
    liveFactCount(): number {
      const db = openDb()
      if (!db) return 0
      try {
        const row = db.prepare('SELECT COUNT(*) as n FROM facts WHERE deleted_at IS NULL').get() as
          | { n: number }
          | undefined
        db.close()
        return row?.n ?? 0
      } catch {
        return 0
      }
    },
  }

  type VaultStore = Record<string, string>
  const loadVault = (): VaultStore => {
    if (!existsSync(vaultPath)) return {}
    try {
      return JSON.parse(readFileSync(vaultPath, 'utf8')) as VaultStore
    } catch {
      return {}
    }
  }
  const vault = {
    seed(name: string, value: string): void {
      const s = loadVault()
      s[name] = value
      writeFileSync(vaultPath, JSON.stringify(s, null, 2), { encoding: 'utf8', mode: 0o600 })
    },
    loads: (): boolean => existsSync(vaultPath),
    secretValues: (): ReadonlySet<string> => new Set(Object.values(loadVault())),
    secretKeys: (): ReadonlySet<string> => new Set(Object.keys(loadVault())),
  }

  const docker = (...args: string[]): string | null => {
    try {
      return execFileSync('docker', args, { encoding: 'utf8', timeout: 5000 })
    } catch {
      return null
    }
  }
  const sandbox = {
    daemonUp: (): boolean => docker('info') !== null,
    imagePresent: (): boolean => (docker('images', '-q', 'aisy-sandbox') ?? '').trim().length > 0,
    runtime: (): 'gvisor' | 'standard' | null => {
      const r = docker('info', '--format', '{{.DefaultRuntime}}')?.trim()
      return r ? (r === 'runsc' ? 'gvisor' : 'standard') : null
    },
    capsDropped: (): boolean => docker('info') !== null,
  }

  const parseMcp = (): boolean => {
    if (!existsSync(mcpAllowlistPath)) return false
    try {
      JSON.parse(readFileSync(mcpAllowlistPath, 'utf8'))
      return true
    } catch {
      return false
    }
  }
  const mcp = { allowlistParses: parseMcp, descriptorHashesMatch: parseMcp }

  const nightly = {
    runLockHeld: (): boolean => existsSync(nightlyLockPath),
    cronRegistered: (): boolean => {
      try {
        return execFileSync('crontab', ['-l'], { encoding: 'utf8', timeout: 2000 }).includes('aisy')
      } catch {
        return false
      }
    },
    triggerIntoStaging(): { started: boolean; reason?: string } {
      if (existsSync(nightlyLockPath)) return { started: false, reason: 'run-lock held' }
      try {
        spawn('aisy', ['nightly', '--staging-only'], { detached: true, stdio: 'ignore' }).unref()
        return { started: true }
      } catch {
        return { started: false, reason: 'spawn failed' }
      }
    },
  }

  const pkg = req('../../package.json') as { version?: string }
  const harnessVersion = pkg.version ?? '0.0.0'

  // Vault-set keys count as "already set" so interactive init skips them and
  // only prompts for what is genuinely missing.
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...loadVault() }

  return makeOnboardingOps({
    clock,
    fs: nodeFs,
    prereqs,
    validators,
    memory,
    vault,
    sandbox,
    mcp,
    nightly,
    harnessVersion,
    env,
    providerCatalog,
    providersOut,
    providersIn,
    // Interactive only on a real TTY; piped/non-interactive stays env-driven.
    ...(process.stdin.isTTY ? { prompt: makeReadlinePrompt() } : {}),
  })
}

/** Harness version from package.json (for the CLI version flag). */
export function harnessVersion(): string {
  const pkg = req('../../package.json') as { version?: string }
  return pkg.version ?? '0.0.0'
}
