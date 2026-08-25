// Node onboarding adapters (runtime).
//
// Concrete port implementations for the onboarding ops — filesystem, prereq
// probes, network validators, SQLite memory checks, the JSON vault, docker
// sandbox probes, MCP allowlist, and nightly hooks. Extracted from the bin so
// both the (legacy) core entry and the app's unified `aisy` CLI share one
// wiring. No business logic — env vars and the local filesystem are the seams.

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { makeOnboardingOps } from '../onboarding/index.js'
import {
  makeActiveMcpAllowlist,
  type ActiveMcpQuarantineReason,
} from './active-mcp-allowlist.js'
import { loadDotEnv } from './dotenv.js'
import {
  isRestrictedCloneDockerVersionCompatible,
  isRestrictedCloneImageDigest,
} from './restricted-public-clone.js'
import type {
  OnboardingOps,
  UpdateResult,
  PromptPort,
  TelegramPairUpdate,
  ProviderCatalogEntry,
  ProvidersConfig,
  DockerDaemonStatus,
  RestrictedCloneSandboxReadiness,
  MediaInboxProbe,
  TranscriptWriterLeaseProbe,
  OwnedDockerRecoveryReadinessProbe,
  ProviderBrokerReadinessProbe,
  TranscriptionReadinessProbe,
  AutoSkillReadinessProbe,
  MemoryPort,
  MigrationReadinessProbe,
  TelegramExecutionCheckpointProbe,
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

const RESTRICTED_CLONE_ENABLED = 'AISY_RESTRICTED_CLONE_ENABLED'
const RESTRICTED_CLONE_WORKER_IMAGE = 'AISY_RESTRICTED_CLONE_WORKER_IMAGE'
const RESTRICTED_CLONE_GATEWAY_IMAGE = 'AISY_RESTRICTED_CLONE_GATEWAY_IMAGE'

export function nodeDockerRequired(env: Readonly<Record<string, string | undefined>>): boolean {
  const restricted = (env[RESTRICTED_CLONE_ENABLED] ?? '').trim().toLowerCase()
  return (env['AISY_SANDBOX_IMAGE'] ?? '').trim().length > 0 ||
    (env['AISY_WHISPER_IMAGE'] ?? '').trim().length > 0 ||
    !['', '0', 'false', 'no'].includes(restricted)
}

export function validNightlySchedule(value: string | undefined): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value ?? '03:30')
}

export function inspectNodeMcpAllowlist(path: string): { parses: boolean; hashes: boolean } {
  const reasons: ActiveMcpQuarantineReason[] = []
  try {
    makeActiveMcpAllowlist({
      loadManifest: () => existsSync(path)
        ? JSON.parse(readFileSync(path, 'utf8')) as unknown
        : { schemaVersion: 1, servers: [] },
      quarantine: (_name, reason) => { reasons.push(reason) },
    })
  } catch {
    reasons.push('invalid-manifest')
  }
  const hashReasons = new Set<ActiveMcpQuarantineReason>([
    'invalid-hash', 'invalid-descriptor', 'descriptor-hash-mismatch', 'live-pin-mismatch',
  ])
  return Object.freeze({
    parses: reasons.length === 0 || reasons.every(reason => hashReasons.has(reason)),
    hashes: reasons.every(reason => !hashReasons.has(reason)),
  })
}

/** Classifies Docker CLI failures without returning raw stderr or local paths. */
export function classifyDockerDaemonFailure(error: unknown): Exclude<DockerDaemonStatus, 'up'> {
  const candidate = error as { code?: unknown; message?: unknown; stderr?: unknown }
  const code = typeof candidate?.code === 'string' ? candidate.code.toLowerCase() : ''
  const stderr = typeof candidate?.stderr === 'string'
    ? candidate.stderr
    : Buffer.isBuffer(candidate?.stderr)
      ? candidate.stderr.toString('utf8')
      : ''
  const message = typeof candidate?.message === 'string' ? candidate.message : ''
  const text = `${code}\n${message}\n${stderr}`.toLowerCase()
  if (code === 'enoent' || text.includes('spawn docker enoent')) return 'cli-unavailable'
  if (code === 'eacces' || code === 'eperm' || text.includes('permission denied') ||
    text.includes('operation not permitted')) return 'permission-denied'
  if (text.includes('cannot connect to the docker daemon') ||
    text.includes('is the docker daemon running') || text.includes('connection refused')) {
    return 'down'
  }
  return 'unknown'
}

export function probeRestrictedCloneSandbox(input: {
  env: Readonly<Record<string, string | undefined>>
  docker: (...args: string[]) => string | null
}): RestrictedCloneSandboxReadiness {
  const rawEnabled = (input.env[RESTRICTED_CLONE_ENABLED] ?? '').trim().toLowerCase()
  const enablement = rawEnabled === '' || rawEnabled === '0' || rawEnabled === 'false' || rawEnabled === 'no'
    ? 'disabled'
    : rawEnabled === '1' || rawEnabled === 'true' || rawEnabled === 'yes'
      ? 'enabled'
      : 'invalid'
  const workerImage = (input.env[RESTRICTED_CLONE_WORKER_IMAGE] ?? '').trim()
  const gatewayImage = (input.env[RESTRICTED_CLONE_GATEWAY_IMAGE] ?? '').trim()
  const workerImageReferenceValid = isRestrictedCloneImageDigest(workerImage)
  const gatewayImageReferenceValid = isRestrictedCloneImageDigest(gatewayImage)
  if (enablement !== 'enabled') {
    return Object.freeze({
      enablement,
      workerImageReferenceValid,
      gatewayImageReferenceValid,
      serverVersion: null,
      versionCompatible: false,
      workerImagePresent: false,
      gatewayImagePresent: false,
    })
  }

  const versionOutput = input.docker('version', '--format={{.Server.Version}}')
  const serverVersion = versionOutput?.trim() || null
  const imagePresent = (reference: string, valid: boolean): boolean => {
    if (!valid) return false
    const output = input.docker('image', 'inspect', '--format={{json .RepoDigests}}', reference)
    if (output === null || Buffer.byteLength(output, 'utf8') > 64 * 1024) return false
    try {
      const digests: unknown = JSON.parse(output)
      return Array.isArray(digests) && digests.every(value => typeof value === 'string') &&
        digests.includes(reference)
    } catch {
      return false
    }
  }
  return Object.freeze({
    enablement,
    workerImageReferenceValid,
    gatewayImageReferenceValid,
    serverVersion,
    versionCompatible: serverVersion !== null &&
      isRestrictedCloneDockerVersionCompatible(serverVersion),
    workerImagePresent: imagePresent(workerImage, workerImageReferenceValid),
    gatewayImagePresent: imagePresent(gatewayImage, gatewayImageReferenceValid),
  })
}

/** Build the onboarding ops with real Node adapters. Honors AISY_HOME. */
export function makeNodeOnboardingOps(input: {
  mediaInbox?: MediaInboxProbe
  telegramExecution?: TelegramExecutionCheckpointProbe
  transcriptWriter?: TranscriptWriterLeaseProbe
  ownedDockerRecovery?: OwnedDockerRecoveryReadinessProbe
  providerBroker?: ProviderBrokerReadinessProbe
  transcription?: TranscriptionReadinessProbe
  autoSkills?: AutoSkillReadinessProbe
  memory?: MemoryPort
  migration?: MigrationReadinessProbe
} = {}): OnboardingOps {
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
  const dockerDaemonStatus = (): DockerDaemonStatus => {
    try {
      execFileSync('docker', ['info'], { encoding: 'utf8', timeout: 5000 })
      return 'up'
    } catch (error) {
      return classifyDockerDaemonFailure(error)
    }
  }
  const sandbox = {
    required: (): boolean => nodeDockerRequired(env),
    daemonUp: (): boolean => dockerDaemonStatus() === 'up',
    daemonStatus: dockerDaemonStatus,
    imagePresent: (): boolean => (docker('images', '-q', 'aisy-sandbox') ?? '').trim().length > 0,
    runtime: (): 'gvisor' | 'standard' | null => {
      const r = docker('info', '--format', '{{.DefaultRuntime}}')?.trim()
      return r ? (r === 'runsc' ? 'gvisor' : 'standard') : null
    },
    capsDropped: (): boolean => docker('info') !== null,
    restrictedClone: (): RestrictedCloneSandboxReadiness => probeRestrictedCloneSandbox({
      env,
      docker,
    }),
  }

  let mcpInspection: { parses: boolean; hashes: boolean } | null = null
  const inspectMcp = (): { parses: boolean; hashes: boolean } => {
    if (mcpInspection !== null) return mcpInspection
    mcpInspection = inspectNodeMcpAllowlist(mcpAllowlistPath)
    return mcpInspection
  }
  const mcp = {
    allowlistParses: (): boolean => inspectMcp().parses,
    descriptorHashesMatch: (): boolean => inspectMcp().hashes,
  }

  const nightly = {
    runLockHeld: (): boolean => existsSync(nightlyLockPath),
    cronRegistered: (): boolean => validNightlySchedule(env['AISY_NIGHTLY_AT']),
    scheduleKind: (): 'in-process' => 'in-process',
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
  // only prompts for what is genuinely missing. The scaffolded ~/.aisy/.env is
  // the lowest layer: a key the operator typed there is honoured (and not
  // re-prompted), matching how `aisy run` resolves config.
  const env: Record<string, string> = {
    ...loadDotEnv(join(base, '.env'), { existsSync, readFileSync }),
    ...(process.env as Record<string, string>),
    ...loadVault(),
  }

  const base_ops = makeOnboardingOps({
    clock,
    fs: nodeFs,
    prereqs,
    validators,
    memory: input.memory ?? memory,
    vault,
    sandbox,
    mcp,
    ...(input.mediaInbox === undefined ? {} : { mediaInbox: input.mediaInbox }),
    ...(input.transcriptWriter === undefined ? {} : { transcriptWriter: input.transcriptWriter }),
    ...(input.ownedDockerRecovery === undefined
      ? {}
      : { ownedDockerRecovery: input.ownedDockerRecovery }),
    ...(input.providerBroker === undefined ? {} : { providerBroker: input.providerBroker }),
    ...(input.transcription === undefined ? {} : { transcription: input.transcription }),
    ...(input.autoSkills === undefined ? {} : { autoSkills: input.autoSkills }),
    ...(input.migration === undefined ? {} : { migration: input.migration }),
    ...(input.telegramExecution === undefined
      ? {}
      : { telegramExecution: input.telegramExecution }),
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
type CommandResult = { ok: boolean; out: string; message: string }
type ServiceResult = { ok: boolean; message: string }

/** Run a command via execFile; returns stdout on success or an error message. */
function runCmd(cmd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const out = (stdout ?? '').trim()
        resolve({ ok: false, out, message: (stderr ?? '').trim() || out || error.message })
      } else {
        resolve({ ok: true, out: (stdout ?? '').trim(), message: (stdout ?? '').trim() })
      }
    })
  })
}

interface ServiceFileSnapshot {
  bytes: Buffer
  mode: number
  identity: ServiceFileIdentity
}

interface ServiceFileIdentity {
  dev: number
  ino: number
}

interface PrivateServiceDirectory {
  fd: number
  path: string
  uid: number
  dev: number
  ino: number
}

const MAX_SERVICE_FILE_BYTES = 64 * 1024

function serviceErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function serviceUid(): number {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) {
    throw new Error('service ownership is unavailable')
  }
  return Number(uid)
}

function requiredServiceFlag(value: number | undefined, name: string): number {
  if (!Number.isInteger(value)) throw new Error(`service filesystem lacks ${name}`)
  return Number(value)
}

function sameServiceIdentity(
  stat: { dev: number; ino: number },
  identity: { dev: number; ino: number },
): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino
}

function isOwnedServiceFile(
  stat: Stats,
  uid: number,
  mode?: number,
): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.nlink === 1 &&
    (mode === undefined || (stat.mode & 0o777) === mode)
}

function ensureServiceDirectoryChain(trustedRoot: string, path: string, create: boolean): void {
  const root = resolve(trustedRoot)
  const target = resolve(path)
  const suffix = relative(root, target)
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('service directory escapes trusted root')
  }
  const filesystemRoot = parse(target).root
  const components = target.slice(filesystemRoot.length).split(sep).filter(Boolean)
  let current = filesystemRoot
  for (const component of components) {
    current = join(current, component)
    let stat: Stats
    try {
      stat = lstatSync(current)
    } catch (error) {
      const fromTrustedRoot = relative(root, current)
      const mayCreate = fromTrustedRoot === '' ||
        (!fromTrustedRoot.startsWith(`..${sep}`) && fromTrustedRoot !== '..' && !isAbsolute(fromTrustedRoot))
      if (!create || !mayCreate || serviceErrorCode(error) !== 'ENOENT') throw error
      mkdirSync(current, { mode: 0o700 })
      stat = lstatSync(current)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('service directory chain is unsafe')
    }
  }
}

function openPrivateServiceDirectory(
  path: string,
  trustedRoot: string,
  create = true,
): PrivateServiceDirectory {
  ensureServiceDirectoryChain(trustedRoot, path, create)
  const uid = serviceUid()
  const before = lstatSync(path)
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid) {
    throw new Error('service directory is not an owned directory')
  }
  const fd = openSync(
    path,
    constants.O_RDONLY |
      requiredServiceFlag(constants.O_DIRECTORY, 'O_DIRECTORY') |
      requiredServiceFlag(constants.O_NOFOLLOW, 'O_NOFOLLOW'),
  )
  try {
    const opened = fstatSync(fd)
    if (!opened.isDirectory() || opened.uid !== uid || !sameServiceIdentity(opened, before)) {
      throw new Error('service directory identity changed')
    }
    fchmodSync(fd, 0o700)
    const secured = fstatSync(fd)
    const current = lstatSync(path)
    if (!secured.isDirectory() || secured.uid !== uid || (secured.mode & 0o777) !== 0o700 ||
      !sameServiceIdentity(secured, opened) || !current.isDirectory() || current.isSymbolicLink() ||
      current.uid !== uid || (current.mode & 0o777) !== 0o700 ||
      !sameServiceIdentity(current, secured)) {
      throw new Error('service directory is not private')
    }
    return { fd, path, uid, dev: secured.dev, ino: secured.ino }
  } catch (error) {
    try { closeSync(fd) } catch { /* preserve validation failure */ }
    throw error
  }
}

function assertServiceDirectoryIdentity(directory: PrivateServiceDirectory): void {
  const opened = fstatSync(directory.fd)
  const current = lstatSync(directory.path)
  if (!opened.isDirectory() || opened.uid !== directory.uid || (opened.mode & 0o777) !== 0o700 ||
    !sameServiceIdentity(opened, directory) || !current.isDirectory() || current.isSymbolicLink() ||
    current.uid !== directory.uid || (current.mode & 0o777) !== 0o700 ||
    !sameServiceIdentity(current, directory)) {
    throw new Error('service directory identity changed')
  }
}

function snapshotServiceFile(path: string, trustedRoot: string): ServiceFileSnapshot | null {
  const directory = openPrivateServiceDirectory(dirname(path), trustedRoot)
  let fd: number | null = null
  try {
    assertServiceDirectoryIdentity(directory)
    try {
      fd = openSync(path, constants.O_RDONLY | requiredServiceFlag(constants.O_NOFOLLOW, 'O_NOFOLLOW'))
    } catch (error) {
      if (serviceErrorCode(error) === 'ENOENT') return null
      throw error
    }
    const before = fstatSync(fd)
    if (!isOwnedServiceFile(before, directory.uid) || before.size > MAX_SERVICE_FILE_BYTES) {
      throw new Error('service file is not a bounded owned regular file')
    }
    const mode = before.mode & 0o777
    const buffer = Buffer.alloc(MAX_SERVICE_FILE_BYTES + 1)
    let read = 0
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read)
      if (count === 0) break
      read += count
    }
    const after = fstatSync(fd)
    assertServiceDirectoryIdentity(directory)
    const current = lstatSync(path)
    if (read > MAX_SERVICE_FILE_BYTES || after.size !== read ||
      !isOwnedServiceFile(after, directory.uid, mode) ||
      !isOwnedServiceFile(current, directory.uid, mode) ||
      !sameServiceIdentity(before, after) || !sameServiceIdentity(after, current)) {
      throw new Error('service file changed while it was read')
    }
    return {
      bytes: Buffer.from(buffer.subarray(0, read)),
      mode,
      identity: { dev: after.dev, ino: after.ino },
    }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* preserve snapshot result */ }
    }
    closeSync(directory.fd)
  }
}

function generatedServiceFileSnapshot(
  path: string,
  trustedRoot: string,
  expected: string,
): ServiceFileSnapshot | null {
  const snapshot = snapshotServiceFile(path, trustedRoot)
  if (snapshot === null) return null
  if (snapshot.mode !== 0o600 || !snapshot.bytes.equals(Buffer.from(expected, 'utf8'))) {
    throw new Error('service file does not match generated content')
  }
  return snapshot
}

function exactGeneratedServiceFile(
  path: string,
  trustedRoot: string,
  expected: string,
): boolean {
  return generatedServiceFileSnapshot(path, trustedRoot, expected) !== null
}

function exactGeneratedServiceIdentity(
  path: string,
  trustedRoot: string,
  expected: string,
  identity: ServiceFileIdentity,
): boolean {
  try {
    const current = generatedServiceFileSnapshot(path, trustedRoot, expected)
    return current !== null && sameServiceIdentity(current.identity, identity)
  } catch {
    return false
  }
}

class ServicePublicationError extends Error {
  constructor(readonly expectedCurrent: ServiceFileIdentity | null) {
    super('service publication failed')
  }
}

function assertServiceTarget(
  path: string,
  uid: number,
  expected: ServiceFileIdentity | null,
): void {
  let current: Stats
  try {
    current = lstatSync(path)
  } catch (error) {
    if (expected === null && serviceErrorCode(error) === 'ENOENT') return
    throw new Error('service publication target changed')
  }
  if (expected === null || !isOwnedServiceFile(current, uid) ||
    !sameServiceIdentity(current, expected)) {
    throw new Error('service publication target changed')
  }
}

function publishServiceFile(
  path: string,
  bytes: string | Buffer,
  mode = 0o600,
  trustedRoot: string,
  expected: ServiceFileIdentity | null,
): ServiceFileIdentity {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777 ||
    Buffer.byteLength(bytes) > MAX_SERVICE_FILE_BYTES) {
    throw new Error('service file payload is invalid')
  }
  const directory = openPrivateServiceDirectory(dirname(path), trustedRoot)
  const filename = path.split('/').at(-1) ?? 'aisy-service'
  const temporary = join(
    directory.path,
    `.${filename}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`,
  )
  let fd: number | null = null
  let renamed = false
  let createdIdentity: ServiceFileIdentity | null = null
  try {
    assertServiceDirectoryIdentity(directory)
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        requiredServiceFlag(constants.O_NOFOLLOW, 'O_NOFOLLOW'),
      mode,
    )
    fchmodSync(fd, mode)
    const created = fstatSync(fd)
    if (!isOwnedServiceFile(created, directory.uid, mode)) {
      throw new Error('temporary service file is unsafe')
    }
    createdIdentity = { dev: created.dev, ino: created.ino }
    writeFileSync(fd, bytes)
    const written = fstatSync(fd)
    if (!isOwnedServiceFile(written, directory.uid, mode) ||
      !sameServiceIdentity(written, created) || written.size !== Buffer.byteLength(bytes)) {
      throw new Error('temporary service file changed while it was written')
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    assertServiceDirectoryIdentity(directory)
    assertServiceTarget(path, directory.uid, expected)
    renameSync(temporary, path)
    renamed = true
    assertServiceDirectoryIdentity(directory)
    const published = lstatSync(path)
    if (!isOwnedServiceFile(published, directory.uid, mode) ||
      !sameServiceIdentity(published, created)) {
      throw new Error('published service file failed validation')
    }
    fsyncSync(directory.fd)
    return createdIdentity
  } catch {
    throw new ServicePublicationError(renamed ? createdIdentity : expected)
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
    if (!renamed && createdIdentity !== null) {
      try {
        const current = lstatSync(temporary)
        if (isOwnedServiceFile(current, directory.uid) &&
          sameServiceIdentity(current, createdIdentity)) unlinkSync(temporary)
      } catch { /* absent, changed or already cleaned */ }
    }
    closeSync(directory.fd)
  }
}

function restoreServiceFile(
  path: string,
  snapshot: ServiceFileSnapshot | null,
  trustedRoot: string,
  expectedCurrent: ServiceFileIdentity | null,
): void {
  if (snapshot !== null) {
    publishServiceFile(path, snapshot.bytes, snapshot.mode, trustedRoot, expectedCurrent)
    return
  }
  const directory = openPrivateServiceDirectory(dirname(path), trustedRoot)
  try {
    assertServiceDirectoryIdentity(directory)
    assertServiceTarget(path, directory.uid, expectedCurrent)
    if (expectedCurrent !== null) unlinkSync(path)
  } finally {
    try {
      assertServiceDirectoryIdentity(directory)
      fsyncSync(directory.fd)
    } finally {
      closeSync(directory.fd)
    }
  }
}

interface PreparedServiceFileRemoval {
  directory: PrivateServiceDirectory
  path: string
  target: { dev: number; ino: number }
}

function prepareServiceFileRemoval(
  path: string,
  trustedRoot: string,
): PreparedServiceFileRemoval | null {
  const directoryPath = dirname(path)
  try {
    ensureServiceDirectoryChain(trustedRoot, directoryPath, false)
  } catch (error) {
    if (serviceErrorCode(error) === 'ENOENT') return null
    throw error
  }
  const directory = openPrivateServiceDirectory(directoryPath, trustedRoot, false)
  try {
    assertServiceDirectoryIdentity(directory)
    let target: Stats
    try {
      target = lstatSync(path)
    } catch (error) {
      if (serviceErrorCode(error) === 'ENOENT') {
        closeSync(directory.fd)
        return null
      }
      throw error
    }
    if (!isOwnedServiceFile(target, directory.uid)) {
      throw new Error('service file removal target is unsafe')
    }
    return {
      directory,
      path,
      target: { dev: target.dev, ino: target.ino },
    }
  } catch (error) {
    try { closeSync(directory.fd) } catch { /* preserve validation failure */ }
    throw error
  }
}

function cancelServiceFileRemoval(prepared: PreparedServiceFileRemoval | null): void {
  if (prepared === null) return
  closeSync(prepared.directory.fd)
}

function commitServiceFileRemoval(prepared: PreparedServiceFileRemoval | null): void {
  if (prepared === null) return
  try {
    assertServiceDirectoryIdentity(prepared.directory)
    const current = lstatSync(prepared.path)
    if (!isOwnedServiceFile(current, prepared.directory.uid) ||
      !sameServiceIdentity(current, prepared.target)) {
      throw new Error('service file removal target changed')
    }
    unlinkSync(prepared.path)
    assertServiceDirectoryIdentity(prepared.directory)
    fsyncSync(prepared.directory.fd)
  } finally {
    closeSync(prepared.directory.fd)
  }
}

export interface NodeServiceOptions {
  platform: NodeJS.Platform
  homeDir: string
  execPath: string
  binPath: string
  aisyHome: string
  runCommand: (cmd: string, args: string[]) => Promise<CommandResult>
}

interface LinuxActivationSnapshot {
  enabled: 'enabled' | 'enabled-runtime' | 'disabled' | 'not-found' | null
  active: 'active' | 'inactive' | null
}

function commandState(result: CommandResult): string {
  const value = (result.out || result.message).trim().split(/\s+/u)[0]?.toLowerCase() ?? ''
  return value
}

async function snapshotLinuxActivation(
  runCommand: NodeServiceOptions['runCommand'],
): Promise<LinuxActivationSnapshot> {
  const enabled = await runCommand('systemctl', ['--user', 'is-enabled', 'aisy.service'])
  const active = await runCommand('systemctl', ['--user', 'is-active', 'aisy.service'])
  const enabledState = commandState(enabled)
  const activeState = commandState(active)
  return {
    enabled: ['enabled', 'enabled-runtime', 'disabled', 'not-found'].includes(enabledState)
      ? enabledState as LinuxActivationSnapshot['enabled']
      : null,
    active: ['active', 'inactive'].includes(activeState)
      ? activeState as LinuxActivationSnapshot['active']
      : null,
  }
}

async function rollbackLinuxInstall(input: {
  runCommand: NodeServiceOptions['runCommand']
  unitPath: string
  trustedRoot: string
  previous: ServiceFileSnapshot | null
  published: ServiceFileIdentity
  activation: LinuxActivationSnapshot
  deactivateNew: boolean
  restoreActivation: boolean
}): Promise<boolean> {
  let ok = true
  if (input.deactivateNew) {
    const disabled = await input.runCommand(
      'systemctl',
      ['--user', 'disable', '--now', 'aisy.service'],
    )
    ok = disabled.ok && ok
  }

  let fileRestored = true
  try {
    restoreServiceFile(input.unitPath, input.previous, input.trustedRoot, input.published)
  } catch {
    fileRestored = false
    ok = false
  }
  const reloaded = await input.runCommand('systemctl', ['--user', 'daemon-reload'])
  ok = reloaded.ok && ok

  if (input.restoreActivation && fileRestored && reloaded.ok) {
    if (input.activation.enabled === 'enabled' || input.activation.enabled === 'enabled-runtime') {
      const enabled = await input.runCommand(
        'systemctl',
        ['--user', 'enable',
          ...(input.activation.enabled === 'enabled-runtime' ? ['--runtime'] : []),
          'aisy.service'],
      )
      ok = enabled.ok && ok
    } else if (input.activation.enabled === 'disabled') {
      const disabled = await input.runCommand(
        'systemctl', ['--user', 'disable', 'aisy.service'],
      )
      ok = disabled.ok && ok
    }
    if (input.activation.active !== null && input.activation.enabled !== 'not-found') {
      const active = await input.runCommand(
        'systemctl',
        ['--user', input.activation.active === 'active' ? 'start' : 'stop', 'aisy.service'],
      )
      ok = active.ok && ok
    }
  }
  return ok
}

async function rollbackLaunchdInstall(input: {
  runCommand: NodeServiceOptions['runCommand']
  plistPath: string
  trustedRoot: string
  previous: ServiceFileSnapshot | null
  published: ServiceFileIdentity
  previouslyLoaded: boolean
}): Promise<boolean> {
  const unloaded = await input.runCommand('launchctl', ['unload', input.plistPath])
  let ok = unloaded.ok
  let fileRestored = true
  try {
    restoreServiceFile(input.plistPath, input.previous, input.trustedRoot, input.published)
  } catch {
    fileRestored = false
    ok = false
  }
  if (input.previouslyLoaded && fileRestored) {
    const loaded = await input.runCommand('launchctl', ['load', '-w', input.plistPath])
    ok = loaded.ok && ok
  }
  return ok
}

function launchctlListHasLabel(output: string, label: string): boolean {
  return output.split('\n').some((line) => {
    const fields = line.trim().split(/\s+/u)
    return fields.length >= 3 && fields[2] === label
  })
}

/** Testable OS-service adapter. Commands are explicit while filesystem writes
 * stay real, allowing mode and rollback tests in isolated temporary homes. */
export function makeNodeService(options: NodeServiceOptions): (action: ServiceAction) => Promise<ServiceResult> {
  const { platform, homeDir, execPath, binPath, aisyHome: home, runCommand } = options
  const logPath = join(home, 'run.log')

  return async (action: ServiceAction): Promise<ServiceResult> => {

  if (platform === 'linux') {
    const unitDir = join(homeDir, '.config', 'systemd', 'user')
    const unitPath = join(unitDir, 'aisy.service')

    if (action === 'install') {
      let previous: ServiceFileSnapshot | null
      try {
        previous = snapshotServiceFile(unitPath, homeDir)
      } catch {
        return { ok: false, message: 'service: existing unit file is unsafe' }
      }
      const activation = await snapshotLinuxActivation(runCommand)
      if (activation.enabled === null || activation.active === null) {
        return { ok: false, message: 'service: systemd state unavailable' }
      }
      const activationConsistent = previous === null
        ? activation.enabled === 'not-found' && activation.active === 'inactive'
        : activation.enabled !== 'not-found'
      if (!activationConsistent) {
        return { ok: false, message: 'service: systemd state conflicts with owned unit file' }
      }
      let published: ServiceFileIdentity
      try {
        published = publishServiceFile(
          unitPath,
          systemdUnit({ execPath, binPath, home, logPath }),
          0o600,
          homeDir,
          previous?.identity ?? null,
        )
      } catch (error) {
        let restored = true
        try {
          const expected = error instanceof ServicePublicationError
            ? error.expectedCurrent
            : previous?.identity ?? null
          restoreServiceFile(unitPath, previous, homeDir, expected)
        } catch { restored = false }
        return {
          ok: false,
          message: 'service: failed to publish private unit file' +
            (restored ? '' : '; rollback failed'),
        }
      }
      const reload = await runCommand('systemctl', ['--user', 'daemon-reload'])
      if (!reload.ok) {
        const restored = await rollbackLinuxInstall({
          runCommand,
          unitPath,
          trustedRoot: homeDir,
          previous,
          published,
          activation,
          deactivateNew: false,
          restoreActivation: false,
        })
        return {
          ok: false,
          message: `service: daemon-reload failed: ${reload.message}` +
            (restored ? '' : '; rollback failed'),
        }
      }
      const enable = await runCommand('systemctl', ['--user', 'enable', '--now', 'aisy.service'])
      if (!enable.ok) {
        const restored = await rollbackLinuxInstall({
          runCommand,
          unitPath,
          trustedRoot: homeDir,
          previous,
          published,
          activation,
          deactivateNew: true,
          restoreActivation: true,
        })
        return {
          ok: false,
          message: `service: enable failed: ${enable.message}` +
            (restored ? '' : '; rollback failed'),
        }
      }
      return {
        ok: true,
        message:
          'Aisy service installed and started.\nNote: run `loginctl enable-linger $USER` so the service survives logout and reboot.',
      }
    }

    if (action === 'uninstall') {
      const expectedUnit = systemdUnit({ execPath, binPath, home, logPath })
      let owned: ServiceFileSnapshot | null
      try {
        owned = generatedServiceFileSnapshot(unitPath, homeDir, expectedUnit)
      } catch {
        return { ok: false, message: 'service: owned systemd unit is unsafe or does not match Aisy' }
      }
      const activation = await snapshotLinuxActivation(runCommand)
      if (activation.enabled === null || activation.active === null) {
        return { ok: false, message: 'service: systemd state unavailable' }
      }
      if (owned === null) {
        return activation.enabled === 'not-found' && activation.active === 'inactive'
          ? { ok: true, message: 'Aisy service is already absent.' }
          : { ok: false, message: 'service: systemd state exists without an exact owned unit' }
      }
      if (activation.enabled === 'not-found') {
        return { ok: false, message: 'service: owned systemd unit is not recognized by systemd' }
      }
      let removal: PreparedServiceFileRemoval | null
      try {
        removal = prepareServiceFileRemoval(unitPath, homeDir)
      } catch {
        return { ok: false, message: 'service: unit file removal is unsafe' }
      }
      if (removal === null || !sameServiceIdentity(removal.target, owned.identity)) {
        cancelServiceFileRemoval(removal)
        return { ok: false, message: 'service: unit file changed before uninstall' }
      }
      if (!exactGeneratedServiceIdentity(unitPath, homeDir, expectedUnit, owned.identity)) {
        cancelServiceFileRemoval(removal)
        return { ok: false, message: 'service: unit file changed before uninstall' }
      }
      if (activation.enabled !== 'disabled' || activation.active !== 'inactive') {
        const disable = await runCommand('systemctl', ['--user', 'disable', '--now', 'aisy.service'])
        if (!disable.ok) {
          cancelServiceFileRemoval(removal)
          return { ok: false, message: `service: disable failed: ${disable.message}` }
        }
      }
      if (!exactGeneratedServiceIdentity(unitPath, homeDir, expectedUnit, owned.identity)) {
        cancelServiceFileRemoval(removal)
        return { ok: false, message: 'service: unit file changed before removal' }
      }
      try {
        commitServiceFileRemoval(removal)
      } catch {
        return { ok: false, message: 'service: failed to remove unit file' }
      }
      const reload = await runCommand('systemctl', ['--user', 'daemon-reload'])
      return reload.ok
        ? { ok: true, message: 'Aisy service disabled and unit file removed.' }
        : { ok: false, message: 'service: daemon-reload failed' }
    }

    if (action === 'status') {
      const r = await runCommand('systemctl', ['--user', 'is-active', 'aisy.service'])
      const state = r.out.length > 0 ? r.out : r.message
      return { ok: r.ok, message: `aisy.service: ${state}` }
    }

    if (action === 'stop') {
      let owned: ServiceFileSnapshot | null
      try {
        owned = generatedServiceFileSnapshot(
          unitPath,
          homeDir,
          systemdUnit({ execPath, binPath, home, logPath }),
        )
      } catch {
        return { ok: false, message: 'service: owned systemd unit is unsafe or does not match Aisy' }
      }
      const activation = await snapshotLinuxActivation(runCommand)
      if (activation.enabled === null || activation.active === null) {
        return { ok: false, message: 'service: systemd state unavailable' }
      }
      if (owned === null) {
        return activation.enabled === 'not-found' && activation.active === 'inactive'
          ? { ok: true, message: 'aisy.service stopped.' }
          : { ok: false, message: 'service: systemd state exists without an exact owned unit' }
      }
      if (activation.enabled === 'not-found') {
        return { ok: false, message: 'service: owned systemd unit is not recognized by systemd' }
      }
      if (activation.active === 'inactive') return { ok: true, message: 'aisy.service stopped.' }
      if (!exactGeneratedServiceIdentity(
        unitPath,
        homeDir,
        systemdUnit({ execPath, binPath, home, logPath }),
        owned.identity,
      )) {
        return { ok: false, message: 'service: owned systemd unit changed before stop' }
      }
      const stopped = await runCommand('systemctl', ['--user', 'stop', 'aisy.service'])
      return stopped.ok
        ? { ok: true, message: 'aisy.service stopped.' }
        : { ok: false, message: `service: stop failed: ${stopped.message}` }
    }

    if (action === 'start' || action === 'restart') {
      let exact = false
      try {
        exact = exactGeneratedServiceFile(
          unitPath,
          homeDir,
          systemdUnit({ execPath, binPath, home, logPath }),
        )
      } catch { /* code-only refusal below */ }
      if (!exact) {
        return { ok: false, message: 'service: owned systemd unit is missing or does not match Aisy' }
      }
    }

    // Граница v1: параллельные lifecycle-команды одного OS-пользователя не
    // поддерживаются. Файловый CAS закрывает подмену unit/plist, но порядок
    // activation-state остаётся операторски сериализованным.
    const r = await runCommand('systemctl', ['--user', action, 'aisy.service'])
    return r.ok
      ? { ok: true, message: `aisy.service ${action}ed.` }
      : { ok: false, message: `service: ${action} failed: ${r.message}` }
  }

  if (platform === 'darwin') {
    const plistDir = join(homeDir, 'Library', 'LaunchAgents')
    const plistPath = join(plistDir, 'com.aisy.agent.plist')

    if (action === 'install') {
      let previous: ServiceFileSnapshot | null
      try {
        previous = snapshotServiceFile(plistPath, homeDir)
      } catch {
        return { ok: false, message: 'service: existing plist is unsafe' }
      }
      const listed = await runCommand('launchctl', ['list'])
      if (!listed.ok) {
        return { ok: false, message: 'service: launchctl state unavailable' }
      }
      const previouslyLoaded = launchctlListHasLabel(listed.out, 'com.aisy.agent')
      if (previous === null && previouslyLoaded) {
        return { ok: false, message: 'service: loaded launchd job has no owned plist' }
      }
      let published: ServiceFileIdentity
      try {
        published = publishServiceFile(
          plistPath,
          launchdPlist({ execPath, binPath, home, logPath }),
          0o600,
          homeDir,
          previous?.identity ?? null,
        )
      } catch (error) {
        let restored = true
        try {
          const expected = error instanceof ServicePublicationError
            ? error.expectedCurrent
            : previous?.identity ?? null
          restoreServiceFile(plistPath, previous, homeDir, expected)
        } catch { restored = false }
        return {
          ok: false,
          message: 'service: failed to publish private plist' +
            (restored ? '' : '; rollback failed'),
        }
      }
      if (previouslyLoaded) {
        const unloadPrevious = await runCommand('launchctl', ['unload', plistPath])
        if (!unloadPrevious.ok) {
          const restored = await rollbackLaunchdInstall({
            runCommand,
            plistPath,
            trustedRoot: homeDir,
            previous,
            published,
            previouslyLoaded,
          })
          return {
            ok: false,
            message: 'service: launchctl unload failed' +
              (restored ? '' : '; rollback failed'),
          }
        }
      }
      const load = await runCommand('launchctl', ['load', '-w', plistPath])
      if (load.ok) return { ok: true, message: 'Aisy agent installed and loaded.' }

      const restored = await rollbackLaunchdInstall({
        runCommand,
        plistPath,
        trustedRoot: homeDir,
        previous,
        published,
        previouslyLoaded,
      })
      return {
        ok: false,
        message: `service: launchctl load failed: ${load.message}` +
          (restored ? '' : '; rollback failed'),
      }
    }

    if (action === 'uninstall') {
      const expectedPlist = launchdPlist({ execPath, binPath, home, logPath })
      let owned: ServiceFileSnapshot | null
      try {
        owned = generatedServiceFileSnapshot(plistPath, homeDir, expectedPlist)
      } catch {
        return { ok: false, message: 'service: owned launchd plist is unsafe or does not match Aisy' }
      }
      const listed = await runCommand('launchctl', ['list'])
      if (!listed.ok) {
        return { ok: false, message: `service: launchctl list failed: ${listed.message}` }
      }
      const loaded = launchctlListHasLabel(listed.out, 'com.aisy.agent')
      if (owned === null) {
        return loaded
          ? { ok: false, message: 'service: loaded launchd job has no exact owned plist' }
          : { ok: true, message: 'Aisy agent is already absent.' }
      }
      let removal: PreparedServiceFileRemoval | null
      try {
        removal = prepareServiceFileRemoval(plistPath, homeDir)
      } catch {
        return { ok: false, message: 'service: plist removal is unsafe' }
      }
      if (removal === null || !sameServiceIdentity(removal.target, owned.identity)) {
        cancelServiceFileRemoval(removal)
        return { ok: false, message: 'service: plist changed before uninstall' }
      }
      if (!exactGeneratedServiceIdentity(plistPath, homeDir, expectedPlist, owned.identity)) {
        cancelServiceFileRemoval(removal)
        return { ok: false, message: 'service: plist changed before uninstall' }
      }
      if (loaded) {
        const unload = await runCommand('launchctl', ['unload', plistPath])
        if (!unload.ok) {
          cancelServiceFileRemoval(removal)
          return { ok: false, message: `service: launchctl unload failed: ${unload.message}` }
        }
      }
      if (!exactGeneratedServiceIdentity(plistPath, homeDir, expectedPlist, owned.identity)) {
        cancelServiceFileRemoval(removal)
        return { ok: false, message: 'service: plist changed before removal' }
      }
      try {
        commitServiceFileRemoval(removal)
      } catch {
        return { ok: false, message: 'service: failed to remove plist' }
      }
      return { ok: true, message: 'Aisy agent unloaded and plist removed.' }
    }

    if (action === 'status') {
      const r = await runCommand('launchctl', ['list'])
      if (!r.ok) return { ok: false, message: `service: launchctl list failed: ${r.message}` }
      const line = r.out.split('\n').find((l) => launchctlListHasLabel(l, 'com.aisy.agent'))
      return line !== undefined
        ? { ok: true, message: `com.aisy.agent: ${line.trim()}` }
        : { ok: false, message: 'com.aisy.agent: not loaded' }
    }

    if (action === 'stop') {
      let owned: ServiceFileSnapshot | null
      try {
        owned = generatedServiceFileSnapshot(
          plistPath,
          homeDir,
          launchdPlist({ execPath, binPath, home, logPath }),
        )
      } catch {
        return { ok: false, message: 'service: owned launchd plist is unsafe or does not match Aisy' }
      }
      const listed = await runCommand('launchctl', ['list'])
      if (!listed.ok) return { ok: false, message: `service: launchctl list failed: ${listed.message}` }
      const loaded = launchctlListHasLabel(listed.out, 'com.aisy.agent')
      if (owned === null) {
        return loaded
          ? { ok: false, message: 'service: loaded launchd job has no exact owned plist' }
          : { ok: true, message: 'com.aisy.agent stopped.' }
      }
      if (!loaded) {
        return { ok: true, message: 'com.aisy.agent stopped.' }
      }
      if (!exactGeneratedServiceIdentity(
        plistPath,
        homeDir,
        launchdPlist({ execPath, binPath, home, logPath }),
        owned.identity,
      )) {
        return { ok: false, message: 'service: owned launchd plist changed before stop' }
      }
      const unload = await runCommand('launchctl', ['unload', plistPath])
      return unload.ok
        ? { ok: true, message: 'com.aisy.agent stopped.' }
        : { ok: false, message: `service: stop failed: ${unload.message}` }
    }

    const expectedPlist = launchdPlist({ execPath, binPath, home, logPath })
    let exact = false
    try { exact = exactGeneratedServiceFile(plistPath, homeDir, expectedPlist) } catch { /* refusal below */ }
    if (!exact) {
      return { ok: false, message: 'service: owned launchd plist is missing or does not match Aisy' }
    }

    if (action === 'start') {
      const load = await runCommand('launchctl', ['load', '-w', plistPath])
      return load.ok
        ? { ok: true, message: 'com.aisy.agent started.' }
        : { ok: false, message: `service: start failed: ${load.message}` }
    }

    const unload = await runCommand('launchctl', ['unload', plistPath])
    if (!unload.ok) return { ok: false, message: `service: stop failed: ${unload.message}` }
    try { exact = exactGeneratedServiceFile(plistPath, homeDir, expectedPlist) } catch { exact = false }
    if (!exact) {
      return { ok: false, message: 'service: owned launchd plist changed before restart' }
    }
    const load = await runCommand('launchctl', ['load', '-w', plistPath])
    return load.ok
      ? { ok: true, message: 'com.aisy.agent restarted.' }
      : { ok: false, message: `service: start failed: ${load.message}` }
  }

  return {
    ok: false,
    message: "service: unsupported platform — run `aisy run` under tmux/your own supervisor",
  }
  }
}

async function nodeService(action: ServiceAction): Promise<ServiceResult> {
  const rawBin = process.argv[1] ?? ''
  let binPath = rawBin
  try {
    if (rawBin) binPath = realpathSync(rawBin)
  } catch {
    /* fall back to the raw path */
  }
  return makeNodeService({
    platform: process.platform,
    homeDir: homedir(),
    execPath: process.execPath,
    binPath,
    aisyHome: process.env['AISY_HOME'] ?? join(homedir(), '.aisy'),
    runCommand: runCmd,
  })(action)
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
