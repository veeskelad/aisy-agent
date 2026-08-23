// MCP transport policy (ADR-0067, spec 22 §"connect gauntlet").
// Pure, fail-closed validation that runs BEFORE any spawn or network contact.
// Nothing here activates a transport: it only decides what would be permitted.

import type { McpServerEntry, McpTransport, McpTransportRefusal } from './types.js'
import type { McpWirePolicy } from './wire-adapter.js'

export type { McpLegacyEraApproval, McpTransportRefusal } from './types.js'

export interface McpTransportPlan {
  readonly transport: McpTransport
  readonly wirePolicy: McpWirePolicy
  /** stdio only — exact argv, already validated. */
  readonly command: readonly string[] | null
  /** streamable-http only — canonical origin + path, no query/fragment/credentials. */
  readonly endpoint: string | null
  readonly host: string | null
}

export type McpTransportPlanResult =
  | { ok: true; plan: McpTransportPlan }
  | { ok: false; reason: McpTransportRefusal }

export interface McpTransportPolicyDeps {
  isEgressAllowed(host: string): boolean
}

const MAX_ARGV = 32
const MAX_ARG_BYTES = 4096
const UNSAFE_ARG = /[\0\r\n]/
const UNSAFE_BINARY = /[\0\r\n\t ]/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

function validCommand(command: readonly string[] | undefined): McpTransportRefusal | null {
  if (!Array.isArray(command) || command.length === 0 || command.length > MAX_ARGV) {
    return 'transport-mismatch'
  }
  // Indexed access only: a hostile `Symbol.iterator` must not get to return one
  // argv to the validator and another to spawn.
  const binary = command[0]
  if (typeof binary !== 'string' || !binary.startsWith('/') || binary.includes('/../') ||
    binary.endsWith('/..') || binary.includes('//')) {
    return 'command-not-absolute'
  }
  if (UNSAFE_BINARY.test(binary) || Buffer.byteLength(binary, 'utf8') > MAX_ARG_BYTES) {
    return 'command-unsafe'
  }
  for (let index = 1; index < command.length; index += 1) {
    const arg = command[index]
    if (typeof arg !== 'string' || UNSAFE_ARG.test(arg) || Buffer.byteLength(arg, 'utf8') > MAX_ARG_BYTES) {
      return 'command-unsafe'
    }
  }
  return null
}

function validEndpoint(
  endpoint: string | undefined,
  deps: McpTransportPolicyDeps,
): { host: string; canonical: string } | McpTransportRefusal {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) {
    return 'transport-mismatch'
  }
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return 'endpoint-host-invalid'
  }
  if (url.protocol !== 'https:') return 'endpoint-not-https'
  if (url.username !== '' || url.password !== '') return 'endpoint-has-credentials'
  // A token smuggled in the query string would leak into every request log.
  if (url.search !== '' || url.hash !== '') return 'endpoint-not-bare'
  // `URL` already lowercases and punycodes the host of a special scheme, so `url.host`
  // is exactly what the egress check and the canonical endpoint below agree on.
  if (url.hostname === '') return 'endpoint-host-invalid'
  if (!deps.isEgressAllowed(url.host)) return 'egress-blocked'
  return { host: url.host, canonical: `${url.origin}${url.pathname}` }
}

/** Modern-first: legacy is only reachable through a human-owned approval on the entry. */
export function validateLegacyEraApproval(value: unknown): McpWirePolicy | McpTransportRefusal {
  if (value === undefined || value === null) return { mode: 'modern-only' }
  if (typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    return 'legacy-not-approved'
  }
  // Own properties only, counted before they are read: destructuring walks the
  // prototype chain, so a polluted `Object.prototype` could otherwise approve an
  // empty object as a complete three-field manifest entry.
  const own = Object.keys(value)
  if (own.length !== 3) return 'legacy-not-approved'
  const approval = value as Record<string, unknown>
  const approved = Object.hasOwn(approval, 'approved') ? approval.approved : undefined
  const approvedBy = Object.hasOwn(approval, 'approvedBy') ? approval.approvedBy : undefined
  const approvedAt = Object.hasOwn(approval, 'approvedAt') ? approval.approvedAt : undefined
  if (approved !== true ||
    typeof approvedBy !== 'string' || approvedBy.trim() === '' || approvedBy.length > 256 ||
    typeof approvedAt !== 'string' || !ISO_INSTANT.test(approvedAt) ||
    !Number.isFinite(Date.parse(approvedAt))) {
    return 'legacy-not-approved'
  }
  return { mode: 'dual-era' }
}

/**
 * Validate one allowlist entry into a single-use transport plan.
 *
 * Fail-closed on every branch: an entry that does not match its declared transport,
 * carries a non-absolute binary, a non-https endpoint, credentials or a query string,
 * a host outside the egress allowlist, or a malformed legacy approval yields a refusal
 * and never reaches spawn or network contact.
 */
export function planMcpTransport(
  entry: McpServerEntry,
  deps: McpTransportPolicyDeps,
): McpTransportPlanResult {
  // Own property only: a polluted `Object.prototype.legacyProtocol` must not grant
  // legacy to an entry that never declared it.
  const era = validateLegacyEraApproval(
    Object.hasOwn(entry, 'legacyProtocol') ? entry.legacyProtocol : undefined,
  )
  if (typeof era === 'string') return { ok: false, reason: era }

  let command: readonly string[] | null = null
  let endpoint: string | null = null
  let host: string | null = null

  if (entry.transport === 'stdio') {
    if (entry.endpoint !== undefined) return { ok: false, reason: 'transport-mismatch' }
    // Read the property exactly once, then work on that snapshot: an accessor that
    // answers differently on a second read must not swap the argv after validation.
    const declared: unknown = entry.command
    const snapshot: unknown = Array.isArray(declared)
      ? Array.prototype.slice.call(declared)
      : declared
    const refusal = validCommand(snapshot as readonly string[] | undefined)
    if (refusal) return { ok: false, reason: refusal }
    command = Object.freeze(snapshot as string[])
  } else if (entry.transport === 'streamable-http') {
    if (entry.command !== undefined) return { ok: false, reason: 'transport-mismatch' }
    const resolved = validEndpoint(entry.endpoint, deps)
    if (typeof resolved === 'string') return { ok: false, reason: resolved }
    endpoint = resolved.canonical
    host = resolved.host
  } else {
    return { ok: false, reason: 'transport-mismatch' }
  }

  return {
    ok: true,
    plan: Object.freeze({
      transport: entry.transport,
      // TODO(transport activation): `wirePolicy` is the ONLY permitted source of the
      // protocol era. When stdio/Streamable HTTP is wired up, it must be handed to
      // `openMcpWireSession` — never derived from a server response (ADR-0067 §1, §5).
      wirePolicy: Object.freeze(era),
      command,
      endpoint,
      host,
    }),
  }
}
