import type {
  ActiveMcpAllowlistPersistencePort,
  ActiveMcpManifestEntryV1,
  ActiveMcpQuarantineReason,
} from '@aisy/core'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

interface McpQuarantineStateV1 {
  schemaVersion: 1
  records: Record<string, { reason: ActiveMcpQuarantineReason; quarantinedAt: string }>
}

const MAX_MANIFEST_BYTES = 1024 * 1024

function safeName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error('unsafe MCP server name')
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function saveAtomic(path: string, content: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  syncPath(temporary)
  renameSync(temporary, path)
  syncPath(directory)
}

/** Writes what an operator approved. Reading it back is the allowlist's job,
 *  and it re-validates everything — this side never grants trust, it records a
 *  decision. */
export interface McpAllowlistWriter {
  entries(): ActiveMcpManifestEntryV1[]
  /** Replaces the entry with this name, clearing any quarantine it carried. */
  upsert(entry: ActiveMcpManifestEntryV1): void
  /** Flips `status`; an archived server is inert but keeps its approval. */
  setStatus(name: string, status: 'active' | 'archived'): void
  remove(name: string): void
}

export function makeNodeMcpAllowlistWriter(input: { root: string }): McpAllowlistWriter {
  const manifestPath = join(input.root, 'mcp-allowlist.json')
  const quarantinePath = join(input.root, 'mcp-quarantine.json')

  const read = (): ActiveMcpManifestEntryV1[] => {
    if (!existsSync(manifestPath)) return []
    try {
      if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) return []
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { servers?: unknown }
      return Array.isArray(raw.servers) ? raw.servers as ActiveMcpManifestEntryV1[] : []
    } catch {
      // A corrupt manifest is quarantined wholesale on load; rewriting from an
      // empty list is the only honest recovery — the alternative is appending to
      // a file nobody can parse.
      return []
    }
  }

  const write = (servers: ActiveMcpManifestEntryV1[]): void => {
    if (servers.length > 64) throw new Error('MCP allowlist holds at most 64 servers')
    saveAtomic(manifestPath, JSON.stringify({ schemaVersion: 1, servers }, null, 2) + '\n')
  }

  /** A name that was quarantined stays archived on load until the record goes. */
  const clearQuarantine = (name: string): void => {
    if (!existsSync(quarantinePath)) return
    try {
      const state = JSON.parse(readFileSync(quarantinePath, 'utf8')) as McpQuarantineStateV1
      if (state.records?.[name] === undefined) return
      delete state.records[name]
      saveAtomic(quarantinePath, JSON.stringify(state, null, 2) + '\n')
    } catch { /* an unreadable quarantine file is rebuilt by the next refusal */ }
  }

  return {
    entries: read,
    upsert(entry) {
      safeName(entry.name)
      write([...read().filter(item => item.name !== entry.name), entry])
      clearQuarantine(entry.name)
    },
    setStatus(name, status) {
      safeName(name)
      write(read().map(item => item.name === name ? { ...item, status } : item))
      if (status === 'active') clearQuarantine(name)
    },
    remove(name) {
      safeName(name)
      write(read().filter(item => item.name !== name))
      clearQuarantine(name)
    },
  }
}

export function makeNodeMcpAllowlistPersistence(input: {
  root: string
  nowIso?: () => string
}): ActiveMcpAllowlistPersistencePort {
  mkdirSync(input.root, { recursive: true, mode: 0o700 })
  chmodSync(input.root, 0o700)
  const manifestPath = join(input.root, 'mcp-allowlist.json')
  const quarantinePath = join(input.root, 'mcp-quarantine.json')
  const nowIso = input.nowIso ?? (() => new Date().toISOString())

  const empty = (): McpQuarantineStateV1 => ({ schemaVersion: 1, records: {} })
  const invalid = (): McpQuarantineStateV1 => ({
    schemaVersion: 1,
    records: { __manifest__: { reason: 'invalid-manifest', quarantinedAt: nowIso() } },
  })
  const loadQuarantine = (): McpQuarantineStateV1 => {
    if (!existsSync(quarantinePath)) return empty()
    try {
      if (statSync(quarantinePath).size > MAX_MANIFEST_BYTES) return invalid()
      const value = JSON.parse(readFileSync(quarantinePath, 'utf8')) as McpQuarantineStateV1
      return value.schemaVersion === 1 && value.records && typeof value.records === 'object'
        ? value
        : invalid()
    } catch {
      return invalid()
    }
  }

  return {
    loadManifest() {
      if (!existsSync(manifestPath)) return { schemaVersion: 1, servers: [] }
      if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) throw new Error('MCP allowlist manifest too large')
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
      const quarantine = loadQuarantine()
      if (quarantine.records['__manifest__']) return { schemaVersion: 1, servers: [] }
      if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { servers?: unknown }).servers)) return raw
      return {
        ...(raw as Record<string, unknown>),
        servers: (raw as { servers: unknown[] }).servers.map(value => {
          if (typeof value !== 'object' || value === null) return value
          const name = (value as { name?: unknown }).name
          return typeof name === 'string' && quarantine.records[name]
            ? { ...value, status: 'archived' }
            : value
        }),
      }
    },
    quarantine(name, reason) {
      if (name !== '__manifest__') safeName(name)
      const state = loadQuarantine()
      state.records[name] = { reason, quarantinedAt: nowIso() }
      saveAtomic(quarantinePath, JSON.stringify(state, null, 2) + '\n')
    },
  }
}

