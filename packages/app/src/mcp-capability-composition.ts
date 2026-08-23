// Turning approved MCP servers into a capability the model can actually use.
//
// Everything below already existed separately: the allowlist the operator
// approved from the phone, the manager that re-verifies pin and descriptor hash
// on every connect, the frozen startup catalogue, the capability runtime that
// owns tier resolution and result quarantine. What was missing is the wiring —
// so the MCP screen could connect a server that the agent could never call.
//
// The connect gauntlet runs once, at startup, before the model exists. A server
// that is unreachable, that changed its version or its tool set, or that offers
// a tool the operator never approved, simply does not become part of this
// process's catalogue: nothing is retried later behind the operator's back.

import {
  connectActiveMcpCatalog,
  makeMCPManager,
  type ActiveMcpAllowlist,
  type ActiveMcpQuarantineReason,
  type InputGuard,
  type McpCapabilityRuntime,
  type RawDescriptor,
} from '@aisy/core'
import { makeMcpCapabilityRuntime } from '@aisy/core'

import type { McpRuntimeDeps } from './mcp-runtime.js'

export interface McpCapabilityCompositionInput {
  allowlist: ActiveMcpAllowlist
  runtime: McpRuntimeDeps
  inputGuard: InputGuard
  resolveToken(envName: string): string | null
  quarantine(name: string, reason: ActiveMcpQuarantineReason): void
  emit(event: string, payload: Record<string, unknown>): void
  /** ADR-0027 narrowing, read per call — never captured at startup. */
  hasUntrustedSpan?(): boolean
}

export interface ConnectedMcpCapability {
  capability: McpCapabilityRuntime
  /** Servers that survived the gauntlet, in catalogue order. */
  servers: string[]
}

/**
 * Connects every approved server and returns the capability, or null when
 * nothing is live — no servers configured, none reachable, or none offering a
 * tool the model may see. Null means `call_mcp` is not published at all, which
 * is the honest answer: a tool that always fails is worse than no tool.
 */
export async function connectMcpCapability(
  input: McpCapabilityCompositionInput,
): Promise<ConnectedMcpCapability | null> {
  if (input.allowlist.names().length === 0) return null

  let catalog: Awaited<ReturnType<typeof connectActiveMcpCatalog>>
  try {
    catalog = await connectActiveMcpCatalog({
      allowlist: input.allowlist,
      makeManager: (snapshot) => makeMCPManager({
        allowlist: snapshot,
        // There is no streamable-HTTP transport in this build; the stdio path
        // never asks, and "no" is the right answer to a question that would
        // only be reached by an endpoint nobody can serve.
        isEgressAllowed: () => false,
        resolveToken: input.resolveToken,
        emit: (event, payload) => {
          input.emit(event, (payload ?? {}) as Record<string, unknown>)
        },
        // No generation pass exists. A tool whose description the operator did
        // not approve stays out of the menu rather than reaching the model as
        // text the server wrote.
        generateSummary: async (_descriptor: RawDescriptor) => null,
        spawnProcess: input.runtime.spawnProcess,
        resolvePin: input.runtime.resolvePin,
        fetchDescriptors: input.runtime.fetchDescriptors,
        invokeTool: input.runtime.invokeTool,
        ...(input.hasUntrustedSpan === undefined
          ? {}
          : { hasUntrustedSpan: input.hasUntrustedSpan }),
      }),
      quarantine: input.quarantine,
    })
  } catch (error) {
    input.emit('mcp.catalog_unavailable', { detail: String(error) })
    return null
  }

  const servers = catalog.names()
  if (servers.length === 0) return null

  try {
    const capability = await makeMcpCapabilityRuntime({
      catalog,
      allowedServers: servers,
      inputGuard: input.inputGuard,
      emit: (event) => { input.emit(event.type, { ...event }) },
    })
    // A catalogue with servers but no visible tool is the same dead end as no
    // catalogue: publishing the wrapper would give the model a tool whose menu
    // is empty.
    if (capability.menu().length === 0) return null
    return { capability, servers }
  } catch (error) {
    input.emit('mcp.capability_unavailable', { detail: String(error) })
    return null
  }
}
