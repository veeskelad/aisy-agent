import { createHash } from 'node:crypto'

import { planMcpTransport } from './transport-policy.js'
import type {
  ConnectResult,
  McpManager,
  McpManagerDeps,
  McpMenuLine,
  McpServerEntry,
  McpToolPolicy,
  RawDescriptor,
  ResolvedMcpCall,
  UntrustedResultSpan,
} from './types.js'

export type {
  McpTransport,
  McpServerEntry,
  McpToolPolicy,
  ConnectResult,
  McpMenuLine,
  RawDescriptor,
  ResolvedMcpCall,
  UntrustedResultSpan,
  DiffCard,
  DescriptorDiff,
  McpClient,
  McpAllowlistConfig,
  McpDescriptorHash,
  McpEvent,
  McpManagerDeps,
  McpProcessHandle,
  McpManager,
} from './types.js'

export {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  McpWireError,
  openMcpWireSession,
} from './wire-adapter.js'
export { planMcpTransport, validateLegacyEraApproval } from './transport-policy.js'
export type {
  McpLegacyEraApproval,
  McpTransportPlan,
  McpTransportPlanResult,
  McpTransportPolicyDeps,
  McpTransportRefusal,
} from './transport-policy.js'
export type {
  McpProtocolEra,
  McpSdkClientPlan,
  McpSdkClientPort,
  McpWireCallResult,
  McpWireErrorCode,
  McpWireEvent,
  McpWirePolicy,
  McpWireSession,
  OpenMcpWireSessionOptions,
} from './wire-adapter.js'

// ---------------------------------------------------------------------------
// Canonical descriptor hashing (ADR-0013, CSO-M2)
// sha256 over every accepted descriptor field, tools sorted
// by name, object keys deep-sorted — byte-stable for identical descriptors.
// ---------------------------------------------------------------------------

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export function canonicalDescriptorHash(tools: RawDescriptor[]): string {
  const canonical = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => {
      const descriptor: Record<string, unknown> = {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        rwClassInputs: t.rwClassInputs ?? {},
      }
      if (t.title !== undefined) descriptor.title = t.title
      if (t.outputSchema !== undefined) descriptor.outputSchema = t.outputSchema
      if (t.annotations !== undefined) descriptor.annotations = t.annotations
      if (t.execution !== undefined) descriptor.execution = t.execution
      if (t.icons !== undefined) descriptor.icons = t.icons
      if (t._meta !== undefined) descriptor._meta = t._meta
      return sortDeep(descriptor)
    })
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// makeMCPManager — the deterministic connect gauntlet + call path (ADR-0013).
// Pure code; no model decision anywhere on this surface.
// ---------------------------------------------------------------------------

export function makeMCPManager(deps: McpManagerDeps): McpManager {
  const entryFor = (name: string): McpServerEntry | undefined =>
    deps.allowlist?.servers.find(s => s.name === name)

  /** Per-process minimal-scope env: ONLY the server's own token (CSO-M4). */
  const envFor = (entry: McpServerEntry): Record<string, string> | 'unresolved' => {
    if (entry.tokenEnv === null) return {}
    const token = deps.resolveToken(entry.tokenEnv)
    if (token === null) return 'unresolved'
    return { [entry.tokenEnv]: token }
  }

  const immutableArgs = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('mcp call args must be a JSON object')
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('mcp call args must be a plain JSON object')
    }
    const visit = (item: unknown, depth: number): void => {
      if (depth > 32) throw new Error('mcp call args exceed nesting limit')
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return
      if (typeof item === 'number') {
        if (!Number.isFinite(item)) throw new Error('mcp call args must contain finite numbers')
        return
      }
      if (Array.isArray(item)) {
        for (const nested of item) visit(nested, depth + 1)
        return
      }
      if (typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) {
        throw new Error('mcp call args must contain only JSON values')
      }
      for (const [key, nested] of Object.entries(item as Record<string, unknown>)) {
        if (key.length === 0 || key.length > 256 || key.includes('\0')) {
          throw new Error('mcp call args contain an invalid key')
        }
        visit(nested, depth + 1)
      }
    }
    visit(value, 0)
    let encoded: string
    try {
      encoded = JSON.stringify(value)
    } catch {
      throw new Error('mcp call args must be JSON serializable')
    }
    if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw new Error('mcp call args exceed 64 KiB')
    const copy = JSON.parse(encoded) as Record<string, unknown>
    const freeze = (item: unknown): void => {
      if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return
      for (const nested of Object.values(item as Record<string, unknown>)) freeze(nested)
      Object.freeze(item)
    }
    freeze(copy)
    return copy
  }

  /** Resolves the policy AND the entry it came from: with duplicate server names the
   *  transport must not be taken from a different entry than the tool policy. */
  const resolveEntryCall = (
    namespaced: string,
    args: unknown,
  ): { call: ResolvedMcpCall; entry: McpServerEntry } => {
    if (!deps.allowlist) throw new Error('cold start: MCP allowlist not loaded — call_mcp refused')
    const dot = namespaced.indexOf('.')
    if (dot <= 0 || dot >= namespaced.length - 1) {
      throw new Error(`malformed mcp call '${namespaced}' — expected non-empty server.tool`)
    }
    let entry: McpServerEntry | undefined
    let policy: McpToolPolicy | undefined
    for (const candidate of deps.allowlist.servers) {
      const prefix = `${candidate.name}.`
      if (!namespaced.startsWith(prefix)) continue
      const toolName = namespaced.slice(prefix.length)
      const match = candidate.tools.find(t => t.tool === toolName)
      if (match) {
        if (policy) throw new Error(`ambiguous mcp call '${namespaced}' — matches multiple allowlist policies`)
        entry = candidate
        policy = match
      }
    }
    if (!entry || !policy) throw new Error(`mcp tool '${namespaced}' has no allowlist policy`)
    return {
      entry,
      call: Object.freeze({
        server: entry.name,
        tool: policy.tool,
        args: immutableArgs(args),
        outboundSink: policy.outboundSink,
        tier: policy.tier,
        riskClass: policy.riskClass,
      }),
    }
  }

  const resolveCall = (namespaced: string, args: unknown): ResolvedMcpCall =>
    resolveEntryCall(namespaced, args).call

  return {
    verifyHash(entry: McpServerEntry, live: RawDescriptor[]): boolean {
      return canonicalDescriptorHash(live) === entry.descriptorHash
    },

    // Connect gauntlet: allowlist -> pin present -> hash present -> egress ->
    // token -> spawn -> live pin -> tools/list -> hash verify -> menu.
    // Every refusal happens BEFORE the next side effect (fail-closed).
    async connect(name: string): Promise<ConnectResult> {
      const entry = entryFor(name)
      if (!entry) {
        deps.emit('mcp.refused', { server: name, reason: 'not-allowlisted' })
        return { kind: 'refused', reason: 'not-allowlisted' }
      }
      if (!entry.pin) {
        deps.emit('mcp.refused', { server: name, reason: 'no-pin' })
        return { kind: 'refused', reason: 'no-pin' }
      }
      if (!entry.descriptorHash) {
        deps.emit('mcp.refused', { server: name, reason: 'no-hash' })
        return { kind: 'refused', reason: 'no-hash' }
      }
      // Transport policy (ADR-0067) runs BEFORE any spawn or network contact:
      // exact argv or https endpoint, egress allowlist, and the era decision.
      const planned = planMcpTransport(entry, { isEgressAllowed: host => deps.isEgressAllowed(host) })
      if (!planned.ok) {
        deps.emit('mcp.refused', { server: name, reason: planned.reason })
        return { kind: 'refused', reason: planned.reason }
      }
      // Fail-closed on unresolved tokens — never a shared/fallback credential.
      const env = envFor(entry)
      if (env === 'unresolved') {
        deps.emit('mcp.refused', { server: name, reason: 'token-unresolved' })
        return { kind: 'refused', reason: 'token-unresolved' }
      }

      const handle = deps.spawnProcess(
        planned.plan.command ? [...planned.plan.command] : [planned.plan.endpoint as string],
        env,
      )
      try {
        // Live version must equal the pin BEFORE tools/list is trusted.
        const livePin = await deps.resolvePin(handle)
        if (livePin !== entry.pin) {
          deps.emit('mcp.refused', { server: name, reason: 'pin-mismatch' })
          return { kind: 'refused', reason: 'pin-mismatch' }
        }

        const live = await deps.fetchDescriptors(handle)
        const liveHash = canonicalDescriptorHash(live)
        if (liveHash !== entry.descriptorHash) {
          // Rug-pull defense: server disabled until an operator approves the diff.
          // The card carries BOTH the previously-approved (pinned) descriptors and
          // the new (live) set, so the operator can see exactly what changed.
          const diffCard = {
            server: name,
            oldHash: entry.descriptorHash,
            newHash: liveHash,
            descriptorDiff: { previous: entry.descriptors ?? [], live },
          }
          deps.emit('mcp.disabled_hash_mismatch', { server: name })
          deps.emit('mcp.diff_card_emitted', diffCard)
          return { kind: 'disabled', reason: 'hash-mismatch', diffCard }
        }

        // Menu derivation: human-authored summary verbatim; null -> quarantined
        // generation; generation failure -> tool OMITTED (never raw description).
        const menu: McpMenuLine[] = []
        for (const policy of entry.tools) {
          let summary = policy.summary
          if (summary === null) {
            const descriptor = live.find(t => t.name === policy.tool)
            // Entering the quarantined-generation path is observable regardless of
            // outcome — a silent generator failure must still reach Observability.
            deps.emit('mcp.summary_quarantined', { server: name, tool: policy.tool })
            summary = descriptor ? await deps.generateSummary(descriptor) : null
          }
          if (summary === null) continue
          menu.push({
            name: `${name}.${policy.tool}`,
            summary,
            rw: policy.outboundSink ? 'write' : 'read',
            tier: policy.tier,
          })
        }

        deps.emit('mcp.connected', { server: name })
        return { kind: 'connected', menu }
      } finally {
        // One-shot gauntlet process; the call path spawns its own.
        handle.terminate()
      }
    },

    resolve: resolveCall,

    // Resolve + invoke. `outboundSink`/`tier` always come from the human
    // policy; capability narrowing and the motivated-call block run in code.
    async call(
      namespaced: string,
      args: Record<string, unknown>,
      argProvenance: 'operator' | 'untrusted' = 'operator',
    ): Promise<UntrustedResultSpan> {
      const { call: resolved, entry } = resolveEntryCall(namespaced, args)
      const server = resolved.server
      const tool = resolved.tool

      // ADR-0027: while an untrusted span is in context, outbound sinks are locked.
      if (resolved.outboundSink && deps.hasUntrustedSpan?.()) {
        throw new Error(`mcp call '${namespaced}' denied: outbound locked (untrusted span in context)`)
      }
      // Motivated-call block: untrusted-derived args never reach a sink.
      if (resolved.outboundSink && argProvenance === 'untrusted') {
        throw new Error(`mcp call '${namespaced}' denied: motivated call blocked (untrusted args on outbound sink)`)
      }

      // Transport policy is re-derived per request, not only at connect (spec §8
      // "Egress redirection"). A prior verdict is never reusable authority — after a
      // restart or a mutated allowlist the entry must pass the gauntlet again.
      const planned = planMcpTransport(entry, { isEgressAllowed: host => deps.isEgressAllowed(host) })
      if (!planned.ok) {
        deps.emit('mcp.refused', { server, reason: planned.reason })
        throw new Error(`mcp call '${namespaced}' denied: transport policy '${planned.reason}'`)
      }

      if (!entry.pin) {
        deps.emit('mcp.refused', { server, reason: 'no-pin' })
        throw new Error(`mcp server '${server}' has no exact pin — fail-closed`)
      }
      if (!entry.descriptorHash) {
        deps.emit('mcp.refused', { server, reason: 'no-hash' })
        throw new Error(`mcp server '${server}' has no descriptor hash — fail-closed`)
      }

      const env = envFor(entry)
      if (env === 'unresolved') throw new Error(`mcp server '${server}' token unresolved — fail-closed`)

      const handle = deps.spawnProcess(
        planned.plan.command ? [...planned.plan.command] : [planned.plan.endpoint as string],
        env,
      )
      try {
        // Re-run the full identity gauntlet on this same handle immediately
        // before invocation. A prior startup connect is never reusable authority.
        const livePin = await deps.resolvePin(handle)
        if (livePin !== entry.pin) {
          deps.emit('mcp.refused', { server, reason: 'pin-mismatch' })
          throw new Error(`mcp server '${server}' pin mismatch — fail-closed`)
        }
        const live = await deps.fetchDescriptors(handle)
        const liveHash = canonicalDescriptorHash(live)
        if (liveHash !== entry.descriptorHash) {
          const diffCard = {
            server,
            oldHash: entry.descriptorHash,
            newHash: liveHash,
            descriptorDiff: { previous: entry.descriptors ?? [], live },
          }
          deps.emit('mcp.disabled_hash_mismatch', { server })
          deps.emit('mcp.diff_card_emitted', diffCard)
          throw new Error(`mcp server '${server}' descriptor hash mismatch — disabled`)
        }
        deps.onResolved?.(resolved)
        const text = deps.invokeTool ? await deps.invokeTool(handle, resolved) : ''
        // Every result enters context as untrusted (ADR-0028); the classifier is
        // advisory and lives in Safety (05) — absent here, the result is
        // quarantined, never admitted as trusted.
        deps.emit('mcp.result_quarantined', { server, tool })
        return { provenance: 'untrusted', text, server }
      } finally {
        handle.terminate()
      }
    },
  }
}
