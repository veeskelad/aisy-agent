// Server access control (ADR-0086).
//
// Only operations the operator described in configuration can run, each one
// confirmed and audited, and anything that opens a door closes itself on a
// timer. The agent never composes a command here.

import { createHash } from 'node:crypto'

export type ServerAccessOperation = 'open-ssh' | 'close-ssh' | 'add-key' | 'remove-key' | 'tunnel'

export type ServerAccessRefusal =
  | 'not-configured'
  | 'untrusted-caller'
  | 'not-approved'
  | 'bad-key'
  | 'private-key-refused'
  | 'command-failed'

export interface ServerAccessCommand {
  /** Argv exactly as the operator wrote it; `{key}` is substituted verbatim. */
  argv: readonly string[]
}

export interface ServerAccessConfig {
  operations: Partial<Record<ServerAccessOperation, ServerAccessCommand>>
  /** How long an opened door stays open, in seconds. */
  ttlSeconds?: number
}

export interface ServerAccessResult {
  operation: ServerAccessOperation
  at: string
  /** Present for key operations: identifies the device without being usable. */
  fingerprint?: string
  /** Present for operations that expire on their own. */
  expiresAt?: string
  output: string
}

export interface ServerAccessRunner {
  run(argv: readonly string[]): Promise<{ ok: boolean; output: string }>
}

export interface ServerAccess {
  available(): readonly ServerAccessOperation[]
  request(input: {
    operation: ServerAccessOperation
    /** Only an operator may ask; untrusted context is refused before approval. */
    provenance: 'operator' | 'untrusted'
    approve: () => Promise<boolean>
    publicKey?: string
  }): Promise<ServerAccessResult | ServerAccessRefusal>
  /** Close whatever the TTL has outlived. Called by the scheduler each tick. */
  expire(): Promise<readonly ServerAccessOperation[]>
}

/** Key types worth accepting; anything else is a curiosity, not a credential. */
const KEY_TYPES = new Set(['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'sk-ssh-ed25519@openssh.com'])
const BASE64 = /^[A-Za-z0-9+/]+={0,3}$/
const DEFAULT_TTL_SECONDS = 60 * 60
/** Doors that close themselves. */
const EXPIRING: ReadonlySet<ServerAccessOperation> = new Set(['open-ssh', 'tunnel'])
const CLOSER: Partial<Record<ServerAccessOperation, ServerAccessOperation>> = {
  'open-ssh': 'close-ssh',
}

export function publicKeyFingerprint(key: string): string {
  const body = key.trim().split(/\s+/)[1] ?? ''
  return `SHA256:${createHash('sha256').update(Buffer.from(body, 'base64')).digest('base64').replace(/=+$/, '')}`
}

/**
 * Validate a public key as data.
 *
 * A private key is refused before anything else and never echoed: one sent by
 * mistake must not also end up written down.
 */
export function checkPublicKey(key: string): true | 'bad-key' | 'private-key-refused' {
  if (/-----BEGIN[\w ]*PRIVATE KEY-----/.test(key)) return 'private-key-refused'
  const parts = key.trim().split(/\s+/)
  const type = parts[0] ?? ''
  const body = parts[1] ?? ''
  if (!KEY_TYPES.has(type)) return 'bad-key'
  if (body.length < 32 || body.length > 4096 || !BASE64.test(body)) return 'bad-key'
  // The comment is free text but must not smuggle newlines into authorized_keys.
  if (/[\r\n\0]/.test(key)) return 'bad-key'
  return true
}

export function makeServerAccess(deps: {
  config: ServerAccessConfig | null
  runner: ServerAccessRunner
  nowIso: () => string
  audit: (event: string, payload: Record<string, unknown>) => void
}): ServerAccess {
  const operations = deps.config?.operations ?? {}
  const ttlMs = Math.max(60, deps.config?.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000
  /** operation → when it must be closed. */
  const openUntil = new Map<ServerAccessOperation, number>()

  const execute = async (
    operation: ServerAccessOperation,
    key?: string,
  ): Promise<{ ok: boolean; output: string }> => {
    const command = operations[operation]
    if (command === undefined) return { ok: false, output: 'not-configured' }
    const argv = command.argv.map((part) => (part === '{key}' ? key ?? '' : part))
    return deps.runner.run(argv)
  }

  return {
    available: () => Object.keys(operations) as ServerAccessOperation[],

    async request(input) {
      // An untrusted caller is refused before a card is even issued: a forwarded
      // message must not be able to put an approval in front of the operator.
      if (input.provenance !== 'operator') {
        deps.audit('server.access_refused', { operation: input.operation, reason: 'untrusted-caller' })
        return 'untrusted-caller'
      }
      if (operations[input.operation] === undefined) return 'not-configured'

      let fingerprint: string | undefined
      if (input.operation === 'add-key' || input.operation === 'remove-key') {
        const verdict = checkPublicKey(input.publicKey ?? '')
        if (verdict !== true) {
          // The refused key is not echoed anywhere, including the audit line.
          deps.audit('server.access_refused', { operation: input.operation, reason: verdict })
          return verdict
        }
        fingerprint = publicKeyFingerprint(input.publicKey ?? '')
      }

      if (!(await input.approve())) {
        deps.audit('server.access_refused', {
          operation: input.operation,
          reason: 'not-approved',
          ...(fingerprint === undefined ? {} : { fingerprint }),
        })
        return 'not-approved'
      }

      const result = await execute(input.operation, input.publicKey)
      const at = deps.nowIso()
      if (!result.ok) {
        deps.audit('server.access_failed', { operation: input.operation, at })
        return 'command-failed'
      }

      let expiresAt: string | undefined
      if (EXPIRING.has(input.operation)) {
        const until = Date.parse(at) + ttlMs
        openUntil.set(input.operation, until)
        expiresAt = new Date(until).toISOString()
      }

      deps.audit('server.access_granted', {
        operation: input.operation,
        at,
        // The fingerprint identifies the device; the key itself never lands here.
        ...(fingerprint === undefined ? {} : { fingerprint }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      })
      return {
        operation: input.operation,
        at,
        ...(fingerprint === undefined ? {} : { fingerprint }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        output: result.output,
      }
    },

    async expire() {
      const now = Date.parse(deps.nowIso())
      const closed: ServerAccessOperation[] = []
      for (const [operation, until] of [...openUntil]) {
        if (until > now) continue
        openUntil.delete(operation)
        const closer = CLOSER[operation] ?? operation
        // Expiry is the runtime's own decision and needs no approval: closing a
        // door is the safe direction.
        const result = await execute(closer, undefined)
        deps.audit(result.ok ? 'server.access_expired' : 'server.access_expiry_failed', {
          operation,
          closedWith: closer,
          at: deps.nowIso(),
        })
        if (result.ok) closed.push(operation)
      }
      return closed
    },
  }
}
