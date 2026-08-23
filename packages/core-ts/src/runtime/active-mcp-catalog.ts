import type {
  McpAllowlistConfig,
  McpManager,
  McpMenuLine,
  ResolvedMcpCall,
  UntrustedResultSpan,
} from '../mcp/index.js'
import type { ActiveMcpAllowlist, ActiveMcpQuarantineReason } from './active-mcp-allowlist.js'

export interface ActiveMcpCatalog {
  names(): string[]
  menu(): McpMenuLine[]
  ownerOf(namespaced: string): string | null
  resolve(namespaced: string, args: unknown): ResolvedMcpCall
  call(
    namespaced: string,
    args: Record<string, unknown>,
    argProvenance?: 'operator' | 'untrusted',
  ): Promise<UntrustedResultSpan>
}

export interface ActiveMcpCatalogDeps {
  allowlist: ActiveMcpAllowlist
  makeManager(snapshot: McpAllowlistConfig): McpManager
  quarantine(name: string, reason: ActiveMcpQuarantineReason): void
}

/**
 * Runs the deterministic connect gauntlet once at startup and freezes the
 * resulting server/tool menu. Every call is still re-verified by McpManager.
 */
export async function connectActiveMcpCatalog(deps: ActiveMcpCatalogDeps): Promise<ActiveMcpCatalog> {
  const snapshot = deps.allowlist.snapshot()
  const manager = deps.makeManager(snapshot)
  const activeServers = new Set<string>()
  const activeTools = new Map<string, string>()
  const menu: McpMenuLine[] = []

  for (const name of deps.allowlist.names()) {
    try {
      const result = await manager.connect(name)
      if (result.kind === 'connected') {
        if (result.menu.length === 0) continue
        const candidate: McpMenuLine[] = []
        const candidateNames = new Set<string>()
        let valid = true
        for (const item of result.menu) {
          try {
            const resolved = manager.resolve(item.name, {})
            if (resolved.server !== name || `${resolved.server}.${resolved.tool}` !== item.name ||
              item.tier !== resolved.tier ||
              item.rw !== (resolved.outboundSink ? 'write' : 'read') ||
              candidateNames.has(item.name) || activeTools.has(item.name)) {
              valid = false
              break
            }
            candidateNames.add(item.name)
            candidate.push({ ...item })
          } catch {
            valid = false
            break
          }
        }
        if (!valid) {
          deps.quarantine(name, 'invalid-policy')
          continue
        }
        activeServers.add(name)
        for (const item of candidate) {
          activeTools.set(item.name, name)
          menu.push(item)
        }
      } else if (result.kind === 'disabled') {
        deps.quarantine(name, 'descriptor-hash-mismatch')
      } else if (result.reason === 'pin-mismatch') {
        deps.quarantine(name, 'live-pin-mismatch')
      }
    } catch {
      // A transiently unavailable server remains inactive for this startup.
      // It is not durable-authority and cannot be called through this catalog.
    }
  }
  menu.sort((a, b) => a.name.localeCompare(b.name))

  const catalog: ActiveMcpCatalog = {
    names: () => [...activeServers].sort(),
    menu: () => menu.map(item => ({ ...item })),
    ownerOf: (namespaced) => activeTools.get(namespaced) ?? null,
    resolve(namespaced, args) {
      const owner = activeTools.get(namespaced)
      if (owner === undefined) {
        throw new Error(`MCP tool '${namespaced}' is not active in the frozen startup catalog`)
      }
      const resolved = manager.resolve(namespaced, args)
      if (resolved.server !== owner || `${resolved.server}.${resolved.tool}` !== namespaced) {
        throw new Error(`MCP tool '${namespaced}' changed ownership after startup`)
      }
      return resolved
    },
    async call(namespaced, args, argProvenance = 'operator') {
      const resolved = catalog.resolve(namespaced, args)
      return manager.call(namespaced, resolved.args, argProvenance)
    },
  }
  return Object.freeze(catalog)
}
