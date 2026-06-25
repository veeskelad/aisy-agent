// Node onboarding adapters (runtime).
//
// Concrete port implementations for the onboarding ops — filesystem, prereq
// probes, network validators, SQLite memory checks, the JSON vault, docker
// sandbox probes, MCP allowlist, and nightly hooks. Extracted from the bin so
// both the (legacy) core entry and the app's unified `aisy` CLI share one
// wiring. No business logic — env vars and the local filesystem are the seams.

import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, unlinkSync } from 'node:fs'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { makeOnboardingOps } from '../onboarding/index.js'
import type {
  OnboardingOps,
  UpdateResult,
  PromptPort,
  TelegramPairUpdate,
  ProviderCatalogEntry,
  ProvidersConfig,
} from '../onboarding/types.js'
import { PROVIDER_CATALOG, findProvider } from './providers.js'
import { systemdUnit, launchdPlist } from './service-files.js'

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
          if (!muted) {
            process.stdout.write(s)
          } else if (s === '\n' || s === '\r' || s === '\r\n') {
            process.stdout.write(s) // pass newlines through
          } else {
            process.stdout.write('*'.repeat(s.length)) // mask typed input so entry is visible
          }
        }
        rl.question(`${q} `, (a) => {
          rl.close()
          process.stdout.write('\n')
          resolve(a.trim())
        })
        muted = true
      }),
    select: (prompt: string, choices: string[], opts?: { defaultIndex?: number }): Promise<number> =>
      new Promise((resolve) => {
        // Raw-mode arrow-key single-select. No external dependencies.
        // Renders an interactive list; Up/Down/k/j move, Enter confirms, Ctrl-C/Esc exits.
        let active = opts?.defaultIndex ?? 0
        // Clamp initial value to valid range.
        if (active < 0) active = 0
        if (active >= choices.length) active = choices.length > 0 ? choices.length - 1 : 0

        const stdout = process.stdout
        const stdin = process.stdin

        const restore = (): void => {
          process.stdin.setRawMode?.(false)
          stdin.pause()
          stdin.removeAllListeners('data')
        }

        const render = (firstRender: boolean): void => {
          if (!firstRender) {
            // Move cursor up N+1 lines (prompt + choices) and clear to end of screen.
            stdout.write(`\x1b[${choices.length + 1}A\x1b[J`)
          }
          stdout.write(`${prompt}:\n`)
          choices.forEach((c, i) => {
            if (i === active) {
              // Active row: cyan highlight
              stdout.write(`  \x1b[36m❯ ${c}\x1b[0m\n`)
            } else {
              stdout.write(`    ${c}\n`)
            }
          })
        }

        render(true)

        process.stdin.setRawMode?.(true)
        stdin.resume()
        stdin.setEncoding('utf8')

        const onData = (chunk: string): void => {
          if (chunk === '\x03' || chunk === '\x1b') {
            // Ctrl-C or Esc — restore terminal and exit with code 130.
            restore()
            process.exit(130)
          } else if (chunk === '\x1b[A' || chunk === 'k') {
            // Up arrow or k
            if (active > 0) active--
            render(false)
          } else if (chunk === '\x1b[B' || chunk === 'j') {
            // Down arrow or j
            if (active < choices.length - 1) active++
            render(false)
          } else if (chunk === '\r' || chunk === '\n') {
            // Enter — confirm selection.
            restore()
            const chosen = choices[active] ?? ''
            stdout.write(`${prompt}: ${chosen}\n`)
            resolve(active)
          }
          // Any other key is silently ignored.
        }

        stdin.on('data', onData)
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
export function makeNodeOnboardingOps(): OnboardingOps {
  const base = process.env['AISY_HOME'] ?? join(homedir(), '.aisy')
  const dbPath = join(base, 'memory.db')
  const vaultPath = join(base, 'vault.json')
  const mcpAllowlistPath = join(base, 'mcp-allowlist.json')
  const nightlyLockPath = join(base, 'nightly.lock')

  const clock = { nowIso: (): string => new Date().toISOString() }

  // Resolve relative paths against AISY_HOME so init scaffolds into ~/.aisy/
  // rather than the cwd. Absolute paths are left unchanged (e.g. vaultPath).
  const at = (p: string): string => (isAbsolute(p) ? p : join(base, p))

  const nodeFs = {
    exists: (p: string): boolean => existsSync(at(p)),
    isPopulated: (p: string): boolean => {
      if (!existsSync(at(p))) return false
      return readFileSync(at(p), 'utf8').split('\n').some((l) => l.trim().length > 0 && !l.startsWith('#'))
    },
    read: (p: string): string => readFileSync(at(p), 'utf8'),
    write: (p: string, c: string): void => {
      // Ensure the parent dir exists — scaffolds like memory/constitution.md
      // are written before the memory tree dirs are mkdirp'd.
      mkdirSync(dirname(at(p)), { recursive: true })
      writeFileSync(at(p), c, 'utf8')
    },
    mkdirp: (p: string): void => {
      mkdirSync(at(p), { recursive: true })
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
      mkdirSync(base, { recursive: true }) // first-run: ~/.aisy may not exist yet
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
      mkdirSync(base, { recursive: true }) // first-run: ~/.aisy may not exist yet
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

  const base_ops = makeOnboardingOps({
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

  return { ...base_ops, update: nodeUpdate, service: nodeService }
}

type ServiceAction = 'install' | 'start' | 'stop' | 'restart' | 'status' | 'uninstall'

/** Run a command via execFile; returns stdout on success or an error message. */
function runCmd(cmd: string, args: string[]): Promise<{ ok: boolean; out: string; message: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, out: '', message: (stderr ?? '').trim() || error.message })
      } else {
        resolve({ ok: true, out: (stdout ?? '').trim(), message: (stdout ?? '').trim() })
      }
    })
  })
}

async function nodeService(action: ServiceAction): Promise<{ ok: boolean; message: string }> {
  const execPath = process.execPath
  const rawBin = process.argv[1] ?? ''
  let binPath = rawBin
  try {
    if (rawBin) binPath = realpathSync(rawBin)
  } catch {
    /* fall back to the raw path */
  }
  const home = process.env['AISY_HOME'] ?? join(homedir(), '.aisy')
  const logPath = join(home, 'run.log')

  const platform = process.platform

  if (platform === 'linux') {
    const unitDir = join(homedir(), '.config', 'systemd', 'user')
    const unitPath = join(unitDir, 'aisy.service')

    if (action === 'install') {
      try {
        mkdirSync(unitDir, { recursive: true })
        writeFileSync(unitPath, systemdUnit({ execPath, binPath, home, logPath }), 'utf8')
      } catch (e) {
        return { ok: false, message: `service: failed to write unit file: ${String(e)}` }
      }
      const reload = await runCmd('systemctl', ['--user', 'daemon-reload'])
      if (!reload.ok) return { ok: false, message: `service: daemon-reload failed: ${reload.message}` }
      const enable = await runCmd('systemctl', ['--user', 'enable', '--now', 'aisy.service'])
      if (!enable.ok) return { ok: false, message: `service: enable failed: ${enable.message}` }
      return {
        ok: true,
        message:
          'Aisy service installed and started.\nNote: run `loginctl enable-linger $USER` so the service survives logout and reboot.',
      }
    }

    if (action === 'uninstall') {
      const disable = await runCmd('systemctl', ['--user', 'disable', '--now', 'aisy.service'])
      try {
        unlinkSync(unitPath)
      } catch {
        /* already gone — that is fine */
      }
      await runCmd('systemctl', ['--user', 'daemon-reload'])
      return disable.ok
        ? { ok: true, message: 'Aisy service disabled and unit file removed.' }
        : { ok: false, message: `service: disable failed: ${disable.message}` }
    }

    if (action === 'status') {
      const r = await runCmd('systemctl', ['--user', 'is-active', 'aisy.service'])
      const state = r.out.length > 0 ? r.out : r.message
      return { ok: r.ok, message: `aisy.service: ${state}` }
    }

    // start / stop / restart
    const r = await runCmd('systemctl', ['--user', action, 'aisy.service'])
    return r.ok
      ? { ok: true, message: `aisy.service ${action}ed.` }
      : { ok: false, message: `service: ${action} failed: ${r.message}` }
  }

  if (platform === 'darwin') {
    const plistDir = join(homedir(), 'Library', 'LaunchAgents')
    const plistPath = join(plistDir, 'com.aisy.agent.plist')

    if (action === 'install') {
      try {
        mkdirSync(plistDir, { recursive: true })
        writeFileSync(plistPath, launchdPlist({ execPath, binPath, home, logPath }), 'utf8')
      } catch (e) {
        return { ok: false, message: `service: failed to write plist: ${String(e)}` }
      }
      // Unload first (ignore error — not loaded yet on first install).
      await runCmd('launchctl', ['unload', plistPath])
      const load = await runCmd('launchctl', ['load', '-w', plistPath])
      return load.ok
        ? { ok: true, message: 'Aisy agent installed and loaded.' }
        : { ok: false, message: `service: launchctl load failed: ${load.message}` }
    }

    if (action === 'uninstall') {
      const unload = await runCmd('launchctl', ['unload', plistPath])
      try {
        unlinkSync(plistPath)
      } catch {
        /* already gone */
      }
      return unload.ok
        ? { ok: true, message: 'Aisy agent unloaded and plist removed.' }
        : { ok: false, message: `service: launchctl unload failed: ${unload.message}` }
    }

    if (action === 'status') {
      const r = await runCmd('launchctl', ['list'])
      if (!r.ok) return { ok: false, message: `service: launchctl list failed: ${r.message}` }
      const line = r.out.split('\n').find((l) => l.includes('com.aisy.agent'))
      return line !== undefined
        ? { ok: true, message: `com.aisy.agent: ${line.trim()}` }
        : { ok: false, message: 'com.aisy.agent: not loaded' }
    }

    if (action === 'restart') {
      const stop = await runCmd('launchctl', ['stop', 'com.aisy.agent'])
      if (!stop.ok) return { ok: false, message: `service: stop failed: ${stop.message}` }
      const start = await runCmd('launchctl', ['start', 'com.aisy.agent'])
      return start.ok
        ? { ok: true, message: 'com.aisy.agent restarted.' }
        : { ok: false, message: `service: start failed: ${start.message}` }
    }

    // start / stop
    const subcmd = action === 'start' ? 'start' : 'stop'
    const r = await runCmd('launchctl', [subcmd, 'com.aisy.agent'])
    return r.ok
      ? { ok: true, message: `com.aisy.agent ${action}ed.` }
      : { ok: false, message: `service: ${action} failed: ${r.message}` }
  }

  return {
    ok: false,
    message: "service: unsupported platform — run `aisy run` under tmux/your own supervisor",
  }
}

/**
 * Detect whether we're running from a global npm install or source checkout,
 * then update accordingly.
 */
/**
 * True when the running code is an installed package (under node_modules), not a
 * source checkout. `process.argv[1]` is the bin SYMLINK path (e.g.
 * /opt/homebrew/bin/aisy), so we also check its realpath and the module URL —
 * either of those lands under node_modules for a global install. Pure + testable.
 */
export function detectGlobalInstall(binPath: string, binReal: string, moduleUrl: string): boolean {
  return (
    binReal.includes('/node_modules/') ||
    binPath.includes('node_modules/@aisy/app') ||
    moduleUrl.includes('/node_modules/')
  )
}

function nodeUpdate(): Promise<UpdateResult> {
  const from = harnessVersion()
  const binPath = process.argv[1] ?? ''
  let binReal = binPath
  try {
    if (binPath) binReal = realpathSync(binPath)
  } catch {
    /* not resolvable — fall back to the raw path */
  }

  // Global npm install: the resolved bin / module lives inside node_modules.
  if (detectGlobalInstall(binPath, binReal, import.meta.url)) {
    return new Promise((resolve) => {
      execFile('npm', ['install', '-g', '@aisy/app@latest'], (error, _stdout, stderr) => {
        if (error) {
          resolve({
            updated: false,
            from,
            message: `Update failed: ${stderr.trim() || error.message}`,
          })
        } else {
          resolve({
            updated: true,
            from,
            message: 'Updated. Run `aisy doctor --post-upgrade` to verify.',
          })
        }
      })
    })
  }

  // Source checkout: user must update manually
  return Promise.resolve({
    updated: false,
    from,
    message: 'Running from source — update with: git pull && pnpm -r build',
  })
}

/** Harness version from package.json (for the CLI version flag). */
export function harnessVersion(): string {
  const pkg = req('../../package.json') as { version?: string }
  return pkg.version ?? '0.0.0'
}

/**
 * Returns true when `candidate` is strictly newer than `current`.
 * Compares major.minor.patch numerically; ignores pre-release/build metadata.
 * Exported for unit testing.
 */
export function isNewerVersion(current: string, candidate: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.split('.')
    const major = Number.parseInt(parts[0] ?? '0', 10)
    const minor = Number.parseInt(parts[1] ?? '0', 10)
    const patch = Number.parseInt(parts[2] ?? '0', 10)
    return [
      Number.isFinite(major) ? major : 0,
      Number.isFinite(minor) ? minor : 0,
      Number.isFinite(patch) ? patch : 0,
    ]
  }
  const [cMaj, cMin, cPat] = parse(current)
  const [nMaj, nMin, nPat] = parse(candidate)
  if (nMaj !== cMaj) return nMaj > cMaj
  if (nMin !== cMin) return nMin > cMin
  return nPat > cPat
}
