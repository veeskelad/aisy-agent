import type { McpAllowlistConfig } from '@aisy/core'
import type { McpCatalogViewEntry } from '@aisy/telegram-gw'

interface ConfiguredMcpMenuEntry extends Omit<McpCatalogViewEntry, 'active'> {
  server: string
}

/** Freeze the validated policy projection without retaining descriptors or connection fields. */
export function makeConfiguredMcpMenuSource(input: {
  snapshot: McpAllowlistConfig
  activeServerNames(): Iterable<string>
}): () => McpCatalogViewEntry[] {
  const configured = Object.freeze(input.snapshot.servers.flatMap((server) =>
    server.tools.map((policy): ConfiguredMcpMenuEntry => ({
      server: server.name,
      name: `${server.name}.${policy.tool}`,
      ...(policy.summary === null ? {} : { summary: policy.summary }),
      rw: policy.outboundSink ? 'write' : 'read',
      tier: policy.tier,
    }))))

  return () => {
    const active = new Set(input.activeServerNames())
    return configured.map((entry) => ({
      name: entry.name,
      ...(entry.summary === undefined ? {} : { summary: entry.summary }),
      rw: entry.rw,
      tier: entry.tier,
      active: active.has(entry.server),
    }))
  }
}
