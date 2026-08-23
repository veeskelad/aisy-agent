// The four I/O seams the MCP manager leaves to the app: start a server, read
// its identity, read its tool descriptors, invoke one tool.
//
// The manager runs its whole gauntlet — pin, descriptor hash, then the call —
// against one handle, and that ordering only means anything if all three reach
// the *same* server process. So a handle owns exactly one process and exactly
// one wire session: the session's own budget is one `tools/list` and one
// `tools/call`, which is precisely what the gauntlet spends. Opening a second
// process per step would verify one server and call another.
//
// The era is a property of the allowlist entry, never of the answer a server
// gives: `2025-11-25` is the legacy era and ADR-0067 makes it reachable only
// through a human-approved `legacyProtocol` field. `spawnProcess` is handed a
// command rather than an entry, so the entry is found back by that exact
// command — the same argv the transport policy already validated.

import {
  MCP_MODERN_PROTOCOL_VERSION,
  openMcpWireSession,
  type McpAllowlistConfig,
  type McpProcessHandle,
  type McpServerEntry,
  type McpWireEvent,
  type McpWirePolicy,
  type McpWireSession,
  type RawDescriptor,
  type ResolvedMcpCall,
} from '@aisy/core'

import { makeMcpStdioClient, type McpStdioClientPort } from './mcp-stdio-client.js'

export class McpRuntimeError extends Error {
  constructor(readonly reason:
    | 'UNKNOWN_HANDLE'
    | 'TRANSPORT_UNSUPPORTED'
    | 'IDENTITY_MISSING',
  ) {
    super(reason)
    this.name = 'McpRuntimeError'
  }
}

export interface McpRuntimeInput {
  /** Read at spawn time, not captured: the allowlist can change under us. */
  allowlist: () => McpAllowlistConfig | null
  emit?: (event: McpWireEvent, payload: Record<string, unknown>) => void
  requestTimeoutMs?: number
  /** Test seam: replaces the real stdio client. */
  createClient?: typeof makeMcpStdioClient
}

/** Exactly the manager dependencies this module owns. */
export interface McpRuntimeDeps {
  spawnProcess(command: string[], env: Record<string, string>): McpProcessHandle
  resolvePin(handle: McpProcessHandle): Promise<string>
  fetchDescriptors(handle: McpProcessHandle): Promise<RawDescriptor[]>
  invokeTool(handle: McpProcessHandle, call: ResolvedMcpCall): Promise<string>
}

interface LiveServer {
  readonly command: readonly string[]
  readonly env: Record<string, string>
  readonly policy: McpWirePolicy
  client: McpStdioClientPort | null
  session: McpWireSession | null
  terminated: boolean
}

function sameCommand(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((part, index) => part === b[index])
}

/**
 * The era a server is allowed to speak, taken from its allowlist entry. An
 * unknown command gets the strict answer: a server nobody wrote down cannot
 * have had its legacy era approved.
 */
function policyFor(entry: McpServerEntry | undefined): McpWirePolicy {
  return entry?.legacyProtocol?.approved === true ? { mode: 'dual-era' } : { mode: 'modern-only' }
}

export function makeMcpRuntime(input: McpRuntimeInput): McpRuntimeDeps {
  const create = input.createClient ?? makeMcpStdioClient
  const live = new Map<string, LiveServer>()
  let seq = 0

  const stateOf = (handle: McpProcessHandle): LiveServer => {
    const state = live.get(handle.id)
    if (state === undefined || state.terminated) throw new McpRuntimeError('UNKNOWN_HANDLE')
    return state
  }

  /** One session per handle: opened on first use, reused by every later step. */
  const session = async (state: LiveServer): Promise<McpWireSession> => {
    if (state.session !== null) return state.session
    const opened = await openMcpWireSession({
      policy: state.policy,
      createClient: plan => {
        state.client = create({
          command: state.command,
          env: state.env,
          ...(input.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: input.requestTimeoutMs }),
        })(plan)
        return state.client
      },
      ...(input.emit === undefined ? {} : { emit: input.emit }),
    })
    state.session = opened
    return opened
  }

  return {
    spawnProcess(command: string[], env: Record<string, string>): McpProcessHandle {
      const entry = input.allowlist()?.servers.find(candidate =>
        candidate.transport === 'stdio' && sameCommand(candidate.command, command))
      // HTTP servers reach this seam as a single-element command holding the
      // endpoint. There is no streamable-HTTP transport in this build yet, and
      // pretending otherwise would spawn a binary named like a URL.
      if (entry === undefined && !command[0]?.startsWith('/')) {
        throw new McpRuntimeError('TRANSPORT_UNSUPPORTED')
      }
      seq += 1
      const id = `mcp-${String(seq)}`
      const state: LiveServer = {
        command: [...command],
        env: { ...env },
        policy: policyFor(entry),
        client: null,
        session: null,
        terminated: false,
      }
      live.set(id, state)
      return Object.freeze({
        id,
        env: { ...env },
        terminate(): void {
          state.terminated = true
          live.delete(id)
          // Closing the session closes the client, which ends the process. It is
          // best-effort: the manager calls this from a `finally`, and a failure
          // to reap must not replace the error that got us here.
          const ending = state.session?.close() ?? state.client?.close()
          void ending?.catch(() => {})
        },
      })
    },

    async resolvePin(handle: McpProcessHandle): Promise<string> {
      const state = stateOf(handle)
      await session(state)
      const identity = state.client?.serverIdentity() ?? null
      // No identity, no pin: the manager compares this against a human-written
      // value, and inventing one here would make that comparison meaningless.
      if (identity === null) throw new McpRuntimeError('IDENTITY_MISSING')
      return `${identity.name}@${identity.version}`
    },

    async fetchDescriptors(handle: McpProcessHandle): Promise<RawDescriptor[]> {
      return await (await session(stateOf(handle))).listDescriptors()
    },

    async invokeTool(handle: McpProcessHandle, call: ResolvedMcpCall): Promise<string> {
      const result = await (await session(stateOf(handle))).callTool(call.tool, call.args)
      // A tool that reports failure still answers in text; the manager wraps
      // every result as untrusted either way, so the marker is for the model's
      // benefit, not a trust decision.
      return result.isError ? `[tool error] ${result.text}` : result.text
    },
  }
}

export { MCP_MODERN_PROTOCOL_VERSION }
