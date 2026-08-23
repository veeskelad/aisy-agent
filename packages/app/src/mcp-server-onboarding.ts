// Adding an MCP server, from the phone.
//
// The manifest demands a pin, a descriptor hash and a human-authored policy for
// every single tool — so "paste a URL and go" cannot exist here by design. What
// can exist is this: connect once in a get-acquainted mode, read what the
// server says it is and what it offers, and hand the operator a card to approve
// or refuse. Approval is the only thing that writes.
//
// Nothing on this path grants trust. The draft it produces is re-validated in
// full by `makeActiveMcpAllowlist` on the next start, and the strict gauntlet —
// pin equality, descriptor hash equality, rug-pull diff — runs on every later
// connect. This is the one moment where a human, not code, decides.

import {
  canonicalDescriptorHash,
  type ActiveMcpManifestEntryV1,
  type McpToolPolicy,
  type RawDescriptor,
} from '@aisy/core'

import type { McpRuntimeDeps } from './mcp-runtime.js'
import type { McpAllowlistWriter } from './mcp-allowlist-store.js'

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TOKEN_ENV = /^[A-Z][A-Z0-9_]{0,127}$/

export type McpOnboardingFailure =
  | 'INVALID_NAME'
  | 'NAME_TAKEN'
  | 'INVALID_COMMAND'
  | 'INVALID_TOKEN_ENV'
  | 'TOKEN_UNRESOLVED'
  | 'UNREACHABLE'
  | 'NO_TOOLS'
  | 'INVALID_PIN'

export class McpOnboardingError extends Error {
  constructor(readonly reason: McpOnboardingFailure, readonly detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`)
    this.name = 'McpOnboardingError'
  }
}

export interface McpServerDraft {
  readonly name: string
  readonly command: readonly string[]
  readonly tokenEnv: string | null
  readonly pin: string
  readonly descriptorHash: string
  readonly descriptors: readonly RawDescriptor[]
  /** Proposed, never applied: the operator approves these or nothing happens. */
  readonly tools: readonly McpToolPolicy[]
}

export interface McpServerOnboarding {
  /** Parses what the operator typed into a command, or says why it cannot. */
  parse(text: string): { name: string; command: string[]; tokenEnv: string | null }
  discover(input: { name: string; command: string[]; tokenEnv: string | null }): Promise<McpServerDraft>
  approve(draft: McpServerDraft): void
}

export interface McpServerOnboardingInput {
  runtime: McpRuntimeDeps
  writer: McpAllowlistWriter
  resolveToken(envName: string): string | null
  /** Existing server names — a new one may not shadow an approved one. */
  taken(): readonly string[]
  emit?(event: string, payload: Record<string, unknown>): void
}

/**
 * A first guess at the policy, from the server's own annotation hints. It is a
 * guess on purpose: the hints are descriptor text, which is never authority for
 * a tier. They shape what the operator is *shown*; approving is what makes it
 * real, and a wrong guess costs a tap to fix, not a silent escalation.
 */
/**
 * The one line about a tool the model will be allowed to read. It comes from
 * the server's own description, so it is attacker-authored text: bounded to one
 * short line, control characters refused outright, and — decisively — the
 * operator reads exactly this string on the approval card before it becomes
 * authority. Anything that does not fit is dropped, and a tool with no summary
 * never appears in the model's menu.
 */
export function toolSummary(description: unknown): string | null {
  if (typeof description !== 'string') return null
  const oneLine = description.replace(/\s+/gu, ' ').trim()
  if (oneLine.length === 0 || oneLine.length > 160 ||
    /[\u0000-\u001f\u007f]/u.test(oneLine)) return null
  return oneLine
}

function proposePolicy(descriptor: RawDescriptor): McpToolPolicy {
  const hints = descriptor.annotations ?? {}
  const summary = toolSummary(descriptor.description)
  if (hints['readOnlyHint'] === true) {
    return { tool: descriptor.name, tier: 1, outboundSink: false, riskClass: 'readOnly', summary }
  }
  if (hints['destructiveHint'] === true) {
    return { tool: descriptor.name, tier: 3, outboundSink: true, riskClass: 'destructive', summary }
  }
  // No hint means no claim of safety. Tier 2 with a sink is the answer that
  // costs a confirmation tap instead of trusting an unannotated write.
  return { tool: descriptor.name, tier: 2, outboundSink: true, riskClass: 'idempotent', summary }
}

export function makeMcpServerOnboarding(input: McpServerOnboardingInput): McpServerOnboarding {
  return {
    parse(text: string) {
      // `<name> <absolute-command> [args…] [TOKEN_ENV]` — the token is named,
      // never pasted: its value belongs in the vault, not in a chat message.
      const parts = text.trim().split(/\s+/u).filter(part => part.length > 0)
      const [name, ...rest] = parts
      if (name === undefined || !NAME.test(name)) throw new McpOnboardingError('INVALID_NAME')
      if (input.taken().includes(name)) throw new McpOnboardingError('NAME_TAKEN')
      const tokenEnv = rest.length > 1 && TOKEN_ENV.test(rest[rest.length - 1]!)
        ? rest.pop()!
        : null
      if (rest.length === 0 || !rest[0]!.startsWith('/')) {
        throw new McpOnboardingError('INVALID_COMMAND')
      }
      if (rest.length > 32 || rest.some(part => part.length > 4096 || part.includes('\0'))) {
        throw new McpOnboardingError('INVALID_COMMAND')
      }
      return { name, command: rest, tokenEnv }
    },

    async discover(request) {
      if (!NAME.test(request.name)) throw new McpOnboardingError('INVALID_NAME')
      if (request.tokenEnv !== null && !TOKEN_ENV.test(request.tokenEnv)) {
        throw new McpOnboardingError('INVALID_TOKEN_ENV')
      }
      let env: Record<string, string> = {}
      if (request.tokenEnv !== null) {
        const token = input.resolveToken(request.tokenEnv)
        if (token === null) throw new McpOnboardingError('TOKEN_UNRESOLVED', request.tokenEnv)
        env = { [request.tokenEnv]: token }
      }

      // Outside the gauntlet on purpose: there is no pin to compare against yet.
      // This is the only connect in the system that runs without one, and it
      // ends in a card, never in a granted capability.
      const handle = input.runtime.spawnProcess([...request.command], env)
      try {
        const pin = await input.runtime.resolvePin(handle)
        const descriptors = await input.runtime.fetchDescriptors(handle)
        if (descriptors.length === 0) throw new McpOnboardingError('NO_TOOLS')
        // The manifest refuses a pin without an exact `name@version`, and a
        // server that will not name a version cannot be pinned to one.
        if (!/^[^@\s*]+@[^@\s*]+$/.test(pin) || /\blatest\b/iu.test(pin)) {
          throw new McpOnboardingError('INVALID_PIN', pin)
        }
        input.emit?.('mcp.discovery_completed', {
          server: request.name, pin, tools: descriptors.length,
        })
        return Object.freeze({
          name: request.name,
          command: Object.freeze([...request.command]),
          tokenEnv: request.tokenEnv,
          pin,
          descriptorHash: canonicalDescriptorHash([...descriptors]),
          descriptors: Object.freeze(descriptors),
          tools: Object.freeze(descriptors.map(proposePolicy)),
        })
      } catch (error) {
        if (error instanceof McpOnboardingError) throw error
        throw new McpOnboardingError('UNREACHABLE', error instanceof Error ? error.message : undefined)
      } finally {
        handle.terminate()
      }
    },

    approve(draft) {
      const entry: ActiveMcpManifestEntryV1 = {
        name: draft.name,
        transport: 'stdio',
        command: [...draft.command],
        pin: draft.pin,
        descriptorHash: draft.descriptorHash,
        descriptors: draft.descriptors.map(item => structuredClone(item)),
        tokenEnv: draft.tokenEnv,
        tools: draft.tools.map(policy => ({ ...policy })),
        status: 'active',
      }
      input.writer.upsert(entry)
      input.emit?.('mcp.server_approved', {
        server: draft.name, pin: draft.pin, tools: draft.tools.length,
      })
    },
  }
}
