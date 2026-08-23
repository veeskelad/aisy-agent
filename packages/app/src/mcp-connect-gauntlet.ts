import type { ActiveMcpAllowlist } from '@aisy/core'

export type McpProductionPreviewDoctorCode =
  | 'MCP_OFFLINE_NAMES_AVAILABLE'
  | 'MCP_OFFLINE_NAMES_EMPTY'
  | 'MCP_OFFLINE_NAMES_UNAVAILABLE'

export interface McpProductionPreviewDoctorVerdict {
  readonly code: McpProductionPreviewDoctorCode
  readonly readyForTransportDecision: boolean
  readonly configuredServerCount: number
  readonly activeServerCount: 0
  readonly frozenConfiguredNames: readonly string[]
  readonly transportActive: false
}

export interface McpProductionPreviewDoctorEvent {
  readonly type: 'mcp.production_preview.offline_names_projection'
  readonly code: McpProductionPreviewDoctorCode
  readonly configuredServerCount: number
  readonly activeServerCount: 0
  readonly transportActive: false
}

export interface McpProductionPreviewDoctor {
  inspect(): McpProductionPreviewDoctorVerdict
}

const SERVER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_SERVERS = 64

function readConfiguredNames(
  allowlist: Pick<ActiveMcpAllowlist, 'names'>,
): readonly string[] | null {
  try {
    const candidate: unknown = allowlist.names()
    if (!Array.isArray(candidate) || candidate.length > MAX_SERVERS ||
      candidate.some(name => typeof name !== 'string' || !SERVER_NAME.test(name)) ||
      new Set(candidate).size !== candidate.length) return null
    return Object.freeze([...candidate].sort((left, right) =>
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))))
  } catch {
    return null
  }
}

/**
 * Read-only production preview of safe configured server names supplied by
 * the allowlist view. It never probes, connects, or activates an MCP transport.
 */
export function makeMcpProductionPreviewDoctor(input: Readonly<{
  allowlist: Pick<ActiveMcpAllowlist, 'names'>
  emit?: (event: McpProductionPreviewDoctorEvent) => void
}>): McpProductionPreviewDoctor {
  const names = readConfiguredNames(input.allowlist)
  const code: McpProductionPreviewDoctorCode = names === null
    ? 'MCP_OFFLINE_NAMES_UNAVAILABLE'
    : names.length === 0
      ? 'MCP_OFFLINE_NAMES_EMPTY'
      : 'MCP_OFFLINE_NAMES_AVAILABLE'
  const frozenConfiguredNames = names ?? Object.freeze([] as string[])
  const verdict: McpProductionPreviewDoctorVerdict = Object.freeze({
    code,
    readyForTransportDecision: false,
    configuredServerCount: frozenConfiguredNames.length,
    activeServerCount: 0,
    frozenConfiguredNames,
    transportActive: false,
  })
  const event: McpProductionPreviewDoctorEvent = Object.freeze({
    type: 'mcp.production_preview.offline_names_projection',
    code,
    configuredServerCount: verdict.configuredServerCount,
    activeServerCount: 0,
    transportActive: false,
  })
  try { input.emit?.(event) } catch { /* derived observability must not affect readiness */ }

  return Object.freeze({ inspect: () => verdict })
}
