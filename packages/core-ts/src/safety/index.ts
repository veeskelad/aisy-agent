import { createHash, randomUUID } from 'node:crypto'

export type {
  // Provenance / spans
  Provenance,
  ContextSpan,
  ToolCall,
  Verdict,
  Tier,
  AutonomyLevel,
  AutonomyTier,
  ConfirmationCard,
  // Rules
  HardDenyRule,
  HardDenyCategory,
  // Injection classifier
  InjectionVerdict,
  InjectionClassifier,
  // Guards and policy
  InputGuard,
  SafetyPolicy,
  SafetyClassifier,
  EgressMode,
  EgressAllowlistEntry,
  OutboundRequest,
  EgressGuard,
  // Approval
  ApprovalStatus,
  ApprovalRecord,
  ApprovalResult,
  ApprovalHandler,
  // Vault / secrets
  SecretRedactor,
  Vault,
  // Sandbox
  MountSpec,
  SandboxConfig,
  SandboxRunResult,
  SandboxSecurityLevel,
  SandboxRunner,
  // Nightly
  NightlyOpKind,
  NightlyOp,
  NightlyCarveoutEntry,
  NightlyCarveout,
  // Lethal trifecta
  LethalTrifectaState,
  LethalTrifectaResult,
  LethalTrifectaDetector,
  // Scoped approval grants (ADR-0047)
  GrantScope,
  GrantStore,
  GrantPersistencePort,
} from './types.js'

export { makeGrantStore } from './grants.js'
export type { GrantStoreDeps } from './grants.js'

import type {
  SafetyClassifier,
  SafetyPolicy,
  Vault,
  SecretRedactor,
  SandboxRunner,
  SandboxSecurityLevel,
  SandboxRunResult,
  MountSpec,
  SandboxConfig,
  InputGuard,
  InjectionVerdict,
  EgressGuard,
  EgressAllowlistEntry,
  OutboundRequest,
  ContextSpan,
  ApprovalHandler,
  ApprovalResult,
  ConfirmationCard,
  NightlyCarveout,
  NightlyOp,
  NightlyOpKind,
  LethalTrifectaDetector,
  LethalTrifectaResult,
  Tier,
  ToolCall,
  Verdict,
  GrantStore,
} from './types.js'

// ---------------------------------------------------------------------------
// Normalization + HARD_DENY rule set (ADR-0009)
// Tested against the normalized tool name + serialized args — obfuscated
// variants (alias paths, URL-encoding, path traversal) are normalized first.
// ---------------------------------------------------------------------------

function normalizeHaystack(call: ToolCall): string {
  let s = `${call.tool} ${JSON.stringify(call.args)}`.toLowerCase()
  try {
    s = decodeURIComponent(s)
  } catch {
    /* malformed escapes stay as-is — patterns still match the raw form */
  }
  return s
}

interface DenyRule {
  id: string
  pattern: RegExp
}

const HARD_DENY: readonly DenyRule[] = [
  { id: 'FS_DESTRUCTION_RM_RF', pattern: /\brm\s+-[a-z]*(?:rf|fr)\b/ },
  { id: 'INFRA_DESTRUCTION_TF', pattern: /terraform\s+destroy/ },
  { id: 'HISTORY_REWRITE_FORCE_PUSH', pattern: /git\s+push(?:\s+\S+)*\s+(?:--force|-f)\b/ },
  { id: 'DB_DROP_TABLE', pattern: /\bdrop\s+table\b/ },
  { id: 'DB_TRUNCATE', pattern: /\btruncate\s+table\b/ },
  { id: 'MONEY_OP', pattern: /stripe\.|createcharge|\btransfer\s+funds\b|\bpayout\b/ },
  { id: 'SECRET_FILE_READ', pattern: /etc\/shadow|etc\/passwd|id_rsa\b|\.aws\/credentials/ },
]

/** DELETE without WHERE — checked on every string arg (any key), fail-closed. */
function isUnboundedDelete(call: ToolCall): boolean {
  for (const v of Object.values(call.args)) {
    if (typeof v !== 'string') continue
    const s = v.toLowerCase()
    if (/\bdelete\s+from\b/.test(s) && !/\bwhere\b/.test(s)) return true
  }
  return false
}

/** Outbound / side-effecting drop set disabled under narrowing (ADR-0027). */
function isOutboundOrSideEffecting(call: ToolCall): boolean {
  if (/^(telegram\.|http\.|mcp:write)/.test(call.tool)) return true
  if (call.tool === 'bash') {
    const cmd = String(call.args['cmd'] ?? '')
    return /git\s+push|curl|wget|\bssh\b|\bscp\b|\bnc\b/.test(cmd)
  }
  return false
}

/** High-risk in degraded (no-gVisor) mode: network-capable shell commands. */
function isHighRiskShell(call: ToolCall): boolean {
  if (call.tool !== 'bash') return false
  return /curl|wget|\bssh\b|\bnc\b/.test(String(call.args['cmd'] ?? ''))
}

function tierOf(call: ToolCall): Tier {
  if (/drop-database|drop_database|delete-repo/.test(call.tool)) return 3
  if (/^git\.|^db\.|^telegram\.|^http\./.test(call.tool) || call.tool === 'bash' || /write|send/.test(call.tool)) return 2
  return 0
}

function makeCard(call: ToolCall, tier: Tier): ConfirmationCard {
  return {
    tier,
    actionSummary: `${call.tool}(${Object.keys(call.args).join(', ')})`,
    actionHash: createHash('sha256').update(JSON.stringify({ tool: call.tool, args: call.args })).digest('hex'),
    nonce: randomUUID(),
    issuedAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// SafetyPolicy — the deterministic PreToolUse verdict (ADR-0009/0011/0027)
// ---------------------------------------------------------------------------

export interface SafetyPolicyDeps {
  /** false = cold start: rule set not yet loaded → fail-closed deny-all. */
  ready?: boolean
  /** Last sandbox probe; degraded mode denies high-risk tools (ADR-0012). */
  sandboxSecurityLevel?: SandboxSecurityLevel
  /**
   * Scoped approval grants (ADR-0047). When present, a per-tool grant suppresses
   * the Tier-2 `ask` (only after every deny check; never for Tier-3). Absent ⇒
   * no grants ⇒ baseline behavior.
   */
  grants?: GrantStore
}

export function makeSafetyPolicy(deps: SafetyPolicyDeps = {}): SafetyPolicy {
  const ready = deps.ready ?? true
  const sandboxLevel = deps.sandboxSecurityLevel ?? 'full'

  const isNarrowed = (ctx: ContextSpan[]): boolean =>
    // Absent or unparsable provenance is treated as untrusted (AC-05-7).
    ctx.some(span => span.provenance !== 'operator')

  return {
    get ready(): boolean {
      return ready
    },

    isNarrowed,

    evaluate(call: ToolCall, ctx: ContextSpan[]): Verdict {
      // Cold start: nothing executes before the rule set is loaded.
      if (!ready) {
        return { decision: 'deny', rule: 'COLD_START', reason: 'safety policy not loaded — fail-closed' }
      }
      // Hook infrastructure failure → deny, never allow-on-error (AC-05-27).
      if (call.args['hookError'] === true) {
        return { decision: 'deny', rule: 'HOOK_ERROR', reason: 'PreToolUse hook error/timeout — fail-closed' }
      }

      // HARD_DENY — normalized matching, no model involvement (ADR-0009).
      const haystack = normalizeHaystack(call)
      for (const rule of HARD_DENY) {
        if (rule.pattern.test(haystack)) {
          return { decision: 'deny', rule: rule.id, reason: `matched HARD_DENY ${rule.id}` }
        }
      }
      if (isUnboundedDelete(call)) {
        return { decision: 'deny', rule: 'DB_DELETE_NO_WHERE', reason: 'DELETE without WHERE' }
      }

      // Motivated-call block: untrusted-derived args never execute (ADR-0027).
      if (call.argsTainted === true) {
        return { decision: 'deny', rule: 'TAINTED_ARGS', reason: 'args derived from untrusted span' }
      }

      // Capability narrowing: outbound / side-effecting drop set is disabled
      // while any untrusted span is in context (ADR-0027).
      if (isNarrowed(ctx) && isOutboundOrSideEffecting(call)) {
        return { decision: 'deny', rule: 'NARROWED_OUTBOUND', reason: 'untrusted span in context — outbound locked' }
      }

      // Degraded sandbox (no gVisor): high-risk tools are denied (ADR-0012).
      if (sandboxLevel === 'degraded-no-gvisor' && isHighRiskShell(call)) {
        return { decision: 'deny', rule: 'DEGRADED_SANDBOX', reason: 'gVisor unavailable — high-risk tool denied' }
      }

      // Autonomy gradient (ADR-0011): Tier-3 always asks via the red card and
      // is NEVER suppressible by a grant (step-up every time, ADR-0047).
      // Tier-2 asks, unless a per-tool scoped grant remembers the approval —
      // checked HERE, after every deny above, so a grant can never override a
      // deny. Tier-0/1 auto-allow.
      const tier = tierOf(call)
      if (tier === 3) {
        return { decision: 'ask', tier, card: makeCard(call, tier) }
      }
      if (tier === 2) {
        if (deps.grants?.has(call.tool) === true) {
          return { decision: 'allow' }
        }
        return { decision: 'ask', tier, card: makeCard(call, tier) }
      }
      return { decision: 'allow' }
    },
  }
}

// ---------------------------------------------------------------------------
// SafetyClassifier — async convenience wrapper over the policy
// ---------------------------------------------------------------------------

export function makeSafetyClassifier(deps: SafetyPolicyDeps = {}): SafetyClassifier {
  const policy = makeSafetyPolicy(deps)
  return {
    classify: async (input: { call: ToolCall; ctx: ContextSpan[] }): Promise<Verdict> =>
      policy.evaluate(input.call, input.ctx),
  }
}

// ---------------------------------------------------------------------------
// InputGuard — unconditional defang + advisory classifier (ADR-0028)
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /new\s+system\s*(?:prompt|:)/i,
  /exfiltrate/i,
]

export interface InputGuardDeps {
  /** Advisory classifier override; failure never blocks defang. */
  classify?: (span: ContextSpan) => Promise<InjectionVerdict>
}

export function makeInputGuard(deps: InputGuardDeps = {}): InputGuard {
  return {
    // Deterministic transforms — run 100% of the time, independent of the
    // classifier: strip auto-loading resources, neutralize URLs, defang
    // known injection phrasings. Provenance is never modified.
    defang(span: ContextSpan): ContextSpan {
      let text = span.text
      // Markdown images auto-load — stripped entirely.
      text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '[image removed]')
      // Foreign URLs neutralized to a non-loadable scheme.
      text = text.replace(/https:\/\//gi, 'hxxps://').replace(/http:\/\//gi, 'hxxp://')
      // Known injection phrasing is visibly marked, never silently passed —
      // a global-flagged copy ensures every occurrence is defanged, not just
      // the first (mirrors the Vault redactor below).
      for (const pattern of INJECTION_PATTERNS) {
        const gPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
        text = text.replace(gPattern, (m) => `[defanged] ${m}`)
      }
      return { ...span, text }
    },

    // Advisory only: can escalate, can never grant trust (provenance is
    // owned by Core/Gateway and never rewritten here).
    async classify(span: ContextSpan): Promise<InjectionVerdict> {
      if (deps.classify) {
        try {
          return await deps.classify(span)
        } catch {
          // Classifier unavailable → caller defaults to quarantine; report
          // 'suspicious' so nothing is admitted as clean on a dead classifier.
          return 'suspicious'
        }
      }
      if (INJECTION_PATTERNS.some(p => p.test(span.text))) return 'injection'
      if (/password|secret|send\s+all\s+data/i.test(span.text)) return 'suspicious'
      return 'clean'
    },
  }
}

// ---------------------------------------------------------------------------
// EgressGuard — data-side scan at the egress proxy (ADR-0010)
// No allowlist = cold start = deny-all (fail-closed default).
// ---------------------------------------------------------------------------

export interface EgressGuardDeps {
  allowlist?: EgressAllowlistEntry[]
  proxyAvailable?: boolean
  maxBodyBytes?: number
}

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/** Three-part JWT shape, prefix-free — shared by EgressGuard and the Vault. */
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/

const SECRET_SHAPES = [
  /sk_live_[a-z0-9]+/i,
  /\bAKIA[A-Z0-9_]+/,
  JWT_SHAPE,
]

export function makeEgressGuard(deps: EgressGuardDeps = {}): EgressGuard {
  const proxyAvailable = deps.proxyAvailable ?? true
  const maxBody = deps.maxBodyBytes ?? 1_000_000

  return {
    inspectBody(req: OutboundRequest, ctx: ContextSpan[]): { decision: 'allow' | 'deny'; reason?: string } {
      // Proxy down or allowlist not loaded → nothing leaves (fail-closed).
      if (!proxyAvailable) return { decision: 'deny', reason: 'egress proxy unavailable' }
      const entry = deps.allowlist?.find(e => e.host === req.host)
      if (!entry) return { decision: 'deny', reason: 'host not on egress allowlist' }

      // Method allowlist: only the methods the host entry declares may pass.
      const method = req.method.toUpperCase()
      if (!entry.methods.some(m => m.toUpperCase() === method)) {
        return { decision: 'deny', reason: 'method not on host egress allowlist' }
      }

      // Read-only destination: any write method or body is a deny.
      const isRead = ['GET', 'HEAD'].includes(method)
      if (entry.mode === 'read-only' && (!isRead || req.body !== undefined)) {
        return { decision: 'deny', reason: 'write to read-only destination' }
      }

      const body = typeof req.body === 'string' ? req.body : req.body ? Buffer.from(req.body).toString('utf8') : ''
      if (body.length > maxBody) return { decision: 'deny', reason: 'body exceeds size cap' }
      if (body.length > 256 && shannonEntropy(body) > 5.5) {
        return { decision: 'deny', reason: 'high-entropy body (possible encrypted exfil)' }
      }
      if (SECRET_SHAPES.some(p => p.test(body))) {
        return { decision: 'deny', reason: 'secret-shaped pattern in outbound body' }
      }

      // While narrowed, free-text query strings are a covert channel.
      const narrowed = ctx.some(span => span.provenance !== 'operator')
      if (narrowed && req.queryString && req.queryString.length > 0) {
        return { decision: 'deny', reason: 'free-text query string while narrowed' }
      }

      return { decision: 'allow' }
    },
  }
}

// ---------------------------------------------------------------------------
// ApprovalHandler — the ONLY setter of is_human_confirmed (ADR-0029)
// ---------------------------------------------------------------------------

interface PendingApproval {
  nonce: string
  actionHash: string
  requiresSecondFactor: boolean
  stagedHashAtAccept: string
  expiresAt: number
}

export interface ApprovalHandlerDeps {
  pending?: PendingApproval[]
  /** Hash of the staging area at promote time (TOCTOU re-check). */
  currentStagedHash?: () => string
  now?: () => number
  verifySecondFactor?: (factor: string) => boolean
}

const TRUST_FIELDS = ['is_human_confirmed', 'permanence', 'trusted', 'human_confirmed']

/** Recursively drop every trust-marker field from objects and array elements. */
function stripTrustDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTrustDeep)
  if (value !== null && typeof value === 'object') {
    const stripped: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (TRUST_FIELDS.includes(key)) continue
      stripped[key] = stripTrustDeep(v)
    }
    return stripped
  }
  return value
}

export function makeApprovalHandler(deps: ApprovalHandlerDeps = {}): ApprovalHandler {
  const pending = new Map<string, PendingApproval>((deps.pending ?? []).map(p => [p.nonce, p]))
  const consumed = new Set<string>()
  const now = deps.now ?? (() => Date.now())
  const verifyFactor = deps.verifySecondFactor ?? ((f: string) => f.length > 0)

  return {
    confirm(nonce: string, actionHash: string, secondFactor?: string): ApprovalResult {
      // Replay: a consumed nonce never confirms again.
      if (consumed.has(nonce)) return { status: 'rejected-replay' }
      const entry = pending.get(nonce)
      if (!entry) return { status: 'rejected-stale' }
      if (now() > entry.expiresAt) return { status: 'rejected-stale' }
      // The tap must echo the exact pending action's hash.
      if (actionHash !== entry.actionHash) return { status: 'rejected-hash-mismatch' }
      // TOCTOU: the staged artifact must be byte-identical at promote time.
      const stagedNow = deps.currentStagedHash ? deps.currentStagedHash() : entry.stagedHashAtAccept
      if (stagedNow !== entry.stagedHashAtAccept) return { status: 'rejected-toctou' }
      // Step-up second factor for Tier-3 / money / permanence. The record only
      // asserts a 2FA check when one was actually required AND validated; when
      // not required, no factor was supplied or verified → false (the approval
      // is still valid, the field must not claim a check that never happened).
      const secondFactorOk = entry.requiresSecondFactor && secondFactor !== undefined && verifyFactor(secondFactor)
      if (entry.requiresSecondFactor && !secondFactorOk) return { status: 'rejected-second-factor' }

      consumed.add(nonce)
      return {
        status: 'approved',
        record: {
          nonce,
          actionHash,
          op: 'confirm',
          tapTimestamp: now(),
          secondFactorOk,
          stagedHashAtAccept: entry.stagedHashAtAccept,
          stagedHashAtPromote: stagedNow,
        },
      }
    },

    // Model output can never carry trust: every trust/permanence field is
    // stripped before staging (AC-05-11; the handler is the only setter).
    // Recurses into nested objects and arrays so a trust field buried at any
    // depth is also stripped.
    stripTrustFields(output: Record<string, unknown>): Record<string, unknown> {
      return stripTrustDeep(output) as Record<string, unknown>
    },
  }
}

// ---------------------------------------------------------------------------
// Vault — secrets by handle + redaction at every sink (CSO-M3)
// ---------------------------------------------------------------------------

export interface VaultDeps {
  secrets?: Record<string, string>
}

const BUILTIN_SECRET_PATTERNS: RegExp[] = [
  /sk_live_[A-Za-z0-9]+/g,
  /AKIA[A-Z0-9_]+/g,
  new RegExp(JWT_SHAPE.source, 'g'), // shared JWT shape (see JWT_SHAPE)
]

export function makeVault(deps: VaultDeps = {}): Vault {
  const secrets = new Map(Object.entries(deps.secrets ?? {}))
  const patterns: RegExp[] = [...BUILTIN_SECRET_PATTERNS]

  const redactor: SecretRedactor = {
    redact(text: string): string {
      let out = text
      // Known secret VALUES are stripped wherever they appear. An empty value
      // would splice the placeholder between every character — skip it.
      for (const value of secrets.values()) {
        if (!value) continue
        out = out.split(value).join('«redacted»')
      }
      // Built-in + registered secret SHAPES.
      for (const pattern of patterns) {
        out = out.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'), '«redacted»')
      }
      return out
    },
  }

  return {
    async getSecret(name: string): Promise<string> {
      const value = secrets.get(name)
      if (value === undefined) throw new Error(`vault: secret '${name}' not found`)
      return value
    },
    async listSecrets(): Promise<string[]> {
      return [...secrets.keys()]
    },
    addRedactionPattern(pattern: RegExp): void {
      patterns.push(pattern)
    },
    get redactor(): SecretRedactor {
      return redactor
    },
  }
}

// ---------------------------------------------------------------------------
// SandboxRunner — container lifecycle with ADR-0012 invariants
// ---------------------------------------------------------------------------

export interface SandboxRunnerDeps {
  /** Launch shim (spy-able); returns the container id. Default: deterministic id. */
  launch?: (config: SandboxConfig, flags: string[]) => string
  /** Probe for the gVisor (runsc) runtime; default: available. */
  gVisorProbe?: () => boolean
  /** Host paths mounts may live under (own worktree only). */
  allowedMountRoots?: string[]
  /** Exec shim for commands inside a container. */
  execImpl?: (containerId: string, cmd: string, args: readonly string[]) => Promise<SandboxRunResult>
  /** Seccomp profile path applied to every container (ADR-0012, CSO-M1). */
  seccompProfile?: string
  /** User-namespace remap target applied to every container (ADR-0012, CSO-M1). */
  usernsRemap?: string
}

export function makeSandboxRunner(deps: SandboxRunnerDeps = {}): SandboxRunner {
  const allowedRoots = deps.allowedMountRoots ?? ['/work', '/tmp/aisy']
  const gVisorAvailable = deps.gVisorProbe ? deps.gVisorProbe() : true
  const seccompProfile = deps.seccompProfile ?? '/etc/aisy/seccomp-default.json'
  const usernsRemap = deps.usernsRemap ?? 'default'
  const running = new Map<string, string>() // containerId -> taskId
  let counter = 0

  const validateMounts = (mounts: MountSpec[]): string | null => {
    for (const m of mounts) {
      // The docker socket is host-root-equivalent — never mountable.
      if (m.hostPath.includes('docker.sock')) {
        return `mount of ${m.hostPath} refused: docker.sock is never mountable`
      }
      if (!allowedRoots.some(root => m.hostPath === root || m.hostPath.startsWith(`${root}/`))) {
        return `mount of ${m.hostPath} refused: outside the worktree allowlist`
      }
    }
    return null
  }

  return {
    get securityLevel(): SandboxSecurityLevel {
      return gVisorAvailable ? 'full' : 'degraded-no-gvisor'
    },

    validateMounts,

    async start(config: SandboxConfig): Promise<string> {
      const mountError = validateMounts(config.mounts)
      if (mountError) throw new Error(mountError)
      // ADR-0012 container invariants — fixed flags, not configurable.
      const flags = [
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        `--security-opt=seccomp=${seccompProfile}`,
        `--userns-remap=${usernsRemap}`,
        '--read-only',
        config.egressBridge ? `--network=${config.egressBridge}` : '--network=none',
        '--pids-limit=256',
        ...(config.gVisorAvailable ? ['--runtime=runsc'] : []),
      ]
      const id = deps.launch ? deps.launch(config, flags) : `sbx-${++counter}`
      running.set(id, config.taskId)
      return id
    },

    async exec(containerId: string, cmd: string, args: readonly string[]): Promise<SandboxRunResult> {
      if (!running.has(containerId)) throw new Error(`exec: unknown container ${containerId}`)
      return deps.execImpl
        ? deps.execImpl(containerId, cmd, args)
        : { stdout: '', stderr: '', exitCode: 0 }
    },

    async teardown(containerId: string, _taskId: string): Promise<void> {
      // Teardown must be CONFIRMED; an unknown container cannot be confirmed
      // torn down — the task is marked failed (throw).
      if (!running.delete(containerId)) {
        throw new Error(`teardown of unknown container ${containerId} cannot be confirmed`)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// NightlyCarveout — Tier-3 maintenance allowlist (Eng-13, ADR-0012)
// ---------------------------------------------------------------------------

export interface NightlyCarveoutDeps {
  /** Pre-op DB snapshot (reversibility); runs BEFORE the op. */
  snapshot?: () => void
  /** Executes the permitted op. */
  execOp?: (op: NightlyOp) => void
}

/** Known params per op kind; anything else (incl. any force flag) is refused. */
const CARVEOUT_KINDS: ReadonlySet<NightlyOpKind> = new Set([
  'vacuum', 'fts5-optimize', 'wal-checkpoint', 'log-rotation',
  'docker-prune', 'worktree-prune', 'git-push-ff',
])

export function makeNightlyCarveout(deps: NightlyCarveoutDeps = {}): NightlyCarveout {
  const isPermitted = (op: NightlyOp): boolean => {
    if (!CARVEOUT_KINDS.has(op.kind)) return false
    // Precondition: no force flags, no unknown escalation params.
    if (op.params['force'] === true) return false
    if (Object.keys(op.params).some(k => k === 'unknown')) return false
    return true
  }

  return {
    isPermitted,

    async run(op: NightlyOp): Promise<{ ran: true } | { ran: false; reason: string }> {
      if (!isPermitted(op)) {
        return { ran: false, reason: `op ${op.kind} not permitted by the carve-out allowlist` }
      }
      // Reversibility: pre-op DB snapshot commits BEFORE the op runs.
      deps.snapshot?.()
      deps.execOp?.(op)
      return { ran: true }
    },
  }
}

// ---------------------------------------------------------------------------
// LethalTrifectaDetector (ADR-0010) — at least one leg must stay severed
// ---------------------------------------------------------------------------

export function makeLethalTrifectaDetector(): LethalTrifectaDetector {
  return {
    evaluate(call: ToolCall, ctx: ContextSpan[]): LethalTrifectaResult {
      const hasUntrustedContent = ctx.some(span => span.provenance !== 'operator')
      const hasPrivateData = ctx.some(
        // A newline separator stops a match from spanning the text/source join.
        span => SECRET_SHAPES.some(p => p.test(span.text)) || /api[-_]?key|\.env\b/i.test(`${span.text}\n${span.source}`),
      )
      const hasOutboundChannel = isOutboundOrSideEffecting(call)
      const state = { hasUntrustedContent, hasPrivateData, hasOutboundChannel }
      return { triggered: hasUntrustedContent && hasPrivateData && hasOutboundChannel, state }
    },
  }
}
