import { isAbsolute } from 'node:path'
import { canonicalDescriptorHash } from '../mcp/index.js'
import { validateLegacyEraApproval } from '../mcp/transport-policy.js'
import type {
  McpAllowlistConfig,
  McpServerEntry,
  McpToolPolicy,
  RawDescriptor,
} from '../mcp/index.js'

export type ActiveMcpQuarantineReason =
  | 'invalid-manifest'
  | 'invalid-server'
  | 'duplicate-identity'
  | 'invalid-transport'
  | 'invalid-pin'
  | 'live-pin-mismatch'
  | 'invalid-hash'
  | 'invalid-descriptor'
  | 'descriptor-hash-mismatch'
  | 'invalid-policy'
  | 'invalid-era-approval'

export interface ActiveMcpManifestEntryV1 extends McpServerEntry {
  status: 'active' | 'archived'
  descriptors: RawDescriptor[]
}

export interface ActiveMcpManifestV1 {
  schemaVersion: 1
  servers: ActiveMcpManifestEntryV1[]
}

export interface ActiveMcpAllowlistPersistencePort {
  loadManifest(): unknown
  quarantine(name: string, reason: ActiveMcpQuarantineReason): void
}

export interface ActiveMcpAllowlist {
  names(): string[]
  snapshot(): McpAllowlistConfig
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HASH = /^[a-f0-9]{64}$/
const TOKEN_ENV = /^[A-Z][A-Z0-9_]{0,127}$/
const MANIFEST_KEYS = new Set(['schemaVersion', 'servers'])
const SERVER_KEYS = new Set([
  'name', 'transport', 'endpoint', 'command', 'pin', 'descriptorHash',
  'descriptors', 'tokenEnv', 'tools', 'status', 'legacyProtocol',
])
const DESCRIPTOR_KEYS = new Set([
  'name', 'description', 'inputSchema', 'title', 'outputSchema',
  'annotations', 'execution', 'icons', '_meta', 'rwClassInputs',
])
const EXECUTION_KEYS = new Set(['taskSupport'])
const POLICY_KEYS = new Set(['tool', 'tier', 'outboundSink', 'riskClass', 'summary'])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function safeJsonSize(value: unknown, maxBytes: number): boolean {
  try {
    const json = JSON.stringify(value)
    return typeof json === 'string' && Buffer.byteLength(json, 'utf8') <= maxBytes
  } catch {
    return false
  }
}

function validDescriptor(value: unknown): value is RawDescriptor {
  if (!record(value) || !exactKeys(value, DESCRIPTOR_KEYS) ||
    typeof value.name !== 'string' || !ID.test(value.name) ||
    typeof value.description !== 'string' || value.description.length > 8192 ||
    value.description.includes('\0') || !record(value.inputSchema) ||
    (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 256 || /[\r\n\0]/.test(value.title))) ||
    (value.outputSchema !== undefined && !record(value.outputSchema)) ||
    (value.annotations !== undefined && !record(value.annotations)) ||
    (value.execution !== undefined && (!record(value.execution) ||
      !exactKeys(value.execution, EXECUTION_KEYS) ||
      (value.execution.taskSupport !== undefined &&
        value.execution.taskSupport !== 'forbidden' &&
        value.execution.taskSupport !== 'optional' &&
        value.execution.taskSupport !== 'required'))) ||
    (value.icons !== undefined && (!Array.isArray(value.icons) || value.icons.length > 16 || !value.icons.every(record))) ||
    (value._meta !== undefined && !record(value._meta)) ||
    (value.rwClassInputs !== undefined && !record(value.rwClassInputs))) return false
  return safeJsonSize(value, 128 * 1024)
}

function validPolicy(value: unknown): value is McpToolPolicy {
  if (!record(value) || !exactKeys(value, POLICY_KEYS) ||
    typeof value.tool !== 'string' || !ID.test(value.tool) ||
    !Number.isInteger(value.tier) || (value.tier as number) < 0 || (value.tier as number) > 3 ||
    typeof value.outboundSink !== 'boolean' ||
    !['readOnly', 'destructive', 'idempotent'].includes(String(value.riskClass)) ||
    (value.summary !== null && (typeof value.summary !== 'string' ||
      value.summary.length === 0 || value.summary.length > 160 || /[\r\n\0]/.test(value.summary)))) return false
  if (value.riskClass === 'readOnly' && value.outboundSink) return false
  return value.riskClass !== 'destructive' || value.outboundSink
}

function validPin(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value === value.trim() && /^[^@\s*]+@[^@\s*]+$/.test(value) &&
    !/\blatest\b/i.test(value)
}

function validTransport(entry: Record<string, unknown>): boolean {
  if (entry.transport === 'stdio') {
    return entry.endpoint === undefined && Array.isArray(entry.command) &&
      entry.command.length > 0 && entry.command.length <= 32 &&
      entry.command.every(part => typeof part === 'string' && part.length > 0 &&
        part.length <= 4096 && !part.includes('\0')) &&
      isAbsolute(entry.command[0] as string)
  }
  if (entry.transport !== 'streamable-http' || entry.command !== undefined ||
    typeof entry.endpoint !== 'string' || entry.endpoint.length > 2048) return false
  try {
    const url = new URL(entry.endpoint)
    return url.protocol === 'https:' && url.username === '' && url.password === '' &&
      url.hash === '' && url.hostname.length > 0
  } catch {
    return false
  }
}

function cloneEntry(entry: ActiveMcpManifestEntryV1): McpServerEntry {
  return JSON.parse(JSON.stringify(entry)) as McpServerEntry
}

export function makeActiveMcpAllowlist(port: ActiveMcpAllowlistPersistencePort): ActiveMcpAllowlist {
  const active = new Map<string, ActiveMcpManifestEntryV1>()
  const quarantine = (name: string, reason: ActiveMcpQuarantineReason): void => {
    const key = ID.test(name) || name === '__manifest__' ? name : '__manifest__'
    try { port.quarantine(key, reason) } catch { /* fail-closed: invalid entry is never active */ }
  }

  let raw: unknown
  try { raw = port.loadManifest() } catch { raw = undefined }
  if (!record(raw) || !exactKeys(raw, MANIFEST_KEYS) || raw.schemaVersion !== 1 ||
    !Array.isArray(raw.servers) || raw.servers.length > 64) {
    quarantine('__manifest__', 'invalid-manifest')
  } else {
    const duplicateNames = new Set<string>()
    const seenNames = new Set<string>()
    for (const value of raw.servers) {
      if (!record(value) || typeof value.name !== 'string') continue
      if (seenNames.has(value.name)) duplicateNames.add(value.name)
      seenNames.add(value.name)
    }

    for (const value of raw.servers) {
      if (!record(value) || !exactKeys(value, SERVER_KEYS) ||
        typeof value.name !== 'string' || !ID.test(value.name) ||
        (value.status !== 'active' && value.status !== 'archived') ||
        (value.tokenEnv !== null && (typeof value.tokenEnv !== 'string' || !TOKEN_ENV.test(value.tokenEnv)))) {
        quarantine(record(value) && typeof value.name === 'string' ? value.name : '__manifest__', 'invalid-server')
        continue
      }
      if (duplicateNames.has(value.name)) {
        quarantine(value.name, 'duplicate-identity')
        continue
      }
      if (!validTransport(value)) {
        quarantine(value.name, 'invalid-transport')
        continue
      }
      // ADR-0067 §3: legacy era is only reachable through this human-owned field,
      // so a malformed approval must name its own failure rather than look like a
      // generally invalid server entry.
      if (Object.hasOwn(value, 'legacyProtocol') &&
        typeof validateLegacyEraApproval(value.legacyProtocol) === 'string') {
        quarantine(value.name, 'invalid-era-approval')
        continue
      }
      if (!validPin(value.pin)) {
        quarantine(value.name, 'invalid-pin')
        continue
      }
      if (typeof value.descriptorHash !== 'string' || !HASH.test(value.descriptorHash)) {
        quarantine(value.name, 'invalid-hash')
        continue
      }
      if (!Array.isArray(value.descriptors) || value.descriptors.length === 0 ||
        value.descriptors.length > 256 || !value.descriptors.every(validDescriptor)) {
        quarantine(value.name, 'invalid-descriptor')
        continue
      }
      const descriptors = value.descriptors as RawDescriptor[]
      const descriptorNames = descriptors.map(item => item.name)
      if (new Set(descriptorNames).size !== descriptorNames.length) {
        quarantine(value.name, 'duplicate-identity')
        continue
      }
      if (canonicalDescriptorHash(descriptors) !== value.descriptorHash) {
        quarantine(value.name, 'descriptor-hash-mismatch')
        continue
      }
      if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.length > 256 ||
        !value.tools.every(validPolicy)) {
        quarantine(value.name, 'invalid-policy')
        continue
      }
      const policies = value.tools as McpToolPolicy[]
      const policyNames = policies.map(policy => policy.tool)
      if (new Set(policyNames).size !== policyNames.length ||
        policyNames.some(name => !descriptorNames.includes(name))) {
        quarantine(value.name, 'invalid-policy')
        continue
      }
      if (value.status === 'active') active.set(value.name, value as unknown as ActiveMcpManifestEntryV1)
    }
  }

  const collisions = new Map<string, string[]>()
  for (const [server, entry] of active) {
    for (const policy of entry.tools) {
      const namespaced = `${server}.${policy.tool}`
      collisions.set(namespaced, [...(collisions.get(namespaced) ?? []), server])
    }
  }
  for (const servers of collisions.values()) {
    if (servers.length < 2) continue
    for (const server of servers) {
      active.delete(server)
      quarantine(server, 'duplicate-identity')
    }
  }

  return Object.freeze({
    names: () => [...active.keys()].sort(),
    snapshot: () => ({ servers: [...active.values()].map(cloneEntry) }),
  })
}
