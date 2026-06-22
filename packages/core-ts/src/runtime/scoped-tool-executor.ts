// Sub-agent scope enforcement (runtime, ADR-0052).
//
// Wraps a base tool executor so a delegated sub-agent can only call tools its
// AgentCard permits, and can only WRITE inside its delegation's owned lane
// (owns minus doNotTouch). Reads/non-write tools pass through once the card
// permits the tool. The DelegationManager already enforces write-disjointness
// across delegations at spawn; this is the per-call runtime guard.

import { globMatches } from '../orchestration/index.js'
import type { ToolCall } from '../agent-loop/types.js'
import type { ToolResult } from './execute-tool.js'

export interface ScopedToolExecutorDeps {
  base: (call: ToolCall) => Promise<ToolResult>
  permitsTool: (name: string) => boolean
  owns: string[]
  doNotTouch: string[]
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file'])

function pathArg(call: ToolCall): string | undefined {
  const p = (call.args as { path?: unknown }).path
  return typeof p === 'string' ? p : undefined
}

export function makeScopedToolExecutor(
  deps: ScopedToolExecutorDeps,
): (call: ToolCall) => Promise<ToolResult> {
  const inOwnedLane = (p: string): boolean =>
    deps.owns.some((g) => globMatches(g, p)) &&
    !deps.doNotTouch.some((g) => globMatches(g, p))

  return async (call: ToolCall): Promise<ToolResult> => {
    if (!deps.permitsTool(call.name)) {
      return { ok: false, output: `tool '${call.name}' is not on this sub-agent's card` }
    }
    if (WRITE_TOOLS.has(call.name)) {
      const p = pathArg(call)
      if (p === undefined || !inOwnedLane(p)) {
        return { ok: false, output: `write tool '${call.name}' needs a path inside this sub-agent's owned scope` }
      }
    }
    return deps.base(call)
  }
}
