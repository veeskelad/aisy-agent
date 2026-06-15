import { createHash } from 'node:crypto'

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

// ---------------------------------------------------------------------------
// Canonical descriptor hashing (ADR-0013, CSO-M2)
// sha256 over name + description + inputSchema + rwClassInputs, tools sorted
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
    .map(t => sortDeep({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      rwClassInputs: t.rwClassInputs ?? {},
    }))
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

  const hostOf = (endpoint: string): string => {
    try {
      return new URL(endpoint).host
    } catch {
      return endpoint
    }
  }

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
      // HTTP endpoints must be on the Safety egress allowlist BEFORE any contact.
      if (entry.transport === 'streamable-http' && entry.endpoint) {
        if (!deps.isEgressAllowed(hostOf(entry.endpoint))) {
          deps.emit('mcp.refused', { server: name, reason: 'egress-blocked' })
          return { kind: 'refused', reason: 'egress-blocked' }
        }
      }
      // Fail-closed on unresolved tokens — never a shared/fallback credential.
      const env = envFor(entry)
      if (env === 'unresolved') {
        deps.emit('mcp.refused', { server: name, reason: 'token-unresolved' })
        return { kind: 'refused', reason: 'token-unresolved' }
      }

      const handle = deps.spawnProcess(entry.command ?? [entry.endpoint ?? ''], env)
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

    // Resolve + invoke. `outboundSink`/`tier` always come from the human
    // policy; capability narrowing and the motivated-call block run in code.
    async call(
      namespaced: string,
      args: Record<string, unknown>,
      argProvenance: 'operator' | 'untrusted' = 'operator',
    ): Promise<UntrustedResultSpan> {
      if (!deps.allowlist) throw new Error('cold start: MCP allowlist not loaded — call_mcp refused')
      // The name is the menu's `${server}.${tool}` join. Both server names and
      // tool names may legitimately contain '.', so a naive indexOf('.') split
      // is ambiguous and can mis-route to the wrong policy (or fail closed on a
      // valid call). Resolve authoritatively against the allowlist: find the
      // (entry, policy) pair whose `${entry.name}.${policy.tool}` equals the
      // namespaced name. Reject when the parse is ambiguous or yields an empty
      // server/tool segment (fail-closed) — never silently bypass the policy.
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
      const server = entry.name
      const tool = policy.tool

      // ADR-0027: while an untrusted span is in context, outbound sinks are locked.
      if (policy.outboundSink && deps.hasUntrustedSpan?.()) {
        throw new Error(`mcp call '${namespaced}' denied: outbound locked (untrusted span in context)`)
      }
      // Motivated-call block: untrusted-derived args never reach a sink.
      if (policy.outboundSink && argProvenance === 'untrusted') {
        throw new Error(`mcp call '${namespaced}' denied: motivated call blocked (untrusted args on outbound sink)`)
      }

      // Egress is enforced per request, not only at connect (spec §8 "Egress
      // redirection"). The call path spawns its own process and may run with no
      // prior connect(), so re-check the endpoint host before any contact.
      if (entry.transport === 'streamable-http' && entry.endpoint && !deps.isEgressAllowed(hostOf(entry.endpoint))) {
        throw new Error(`mcp call '${namespaced}' denied: egress blocked for '${entry.endpoint}'`)
      }

      const env = envFor(entry)
      if (env === 'unresolved') throw new Error(`mcp server '${server}' token unresolved — fail-closed`)

      const resolved: ResolvedMcpCall = {
        server,
        tool,
        args,
        outboundSink: policy.outboundSink,
        tier: policy.tier,
      }
      deps.onResolved?.(resolved)

      const handle = deps.spawnProcess(entry.command ?? [entry.endpoint ?? ''], env)
      try {
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
