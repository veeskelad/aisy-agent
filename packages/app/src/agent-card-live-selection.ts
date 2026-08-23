import type { AgentCard, AgentCardBinding, AgentCardRegistry, CardResolver } from '@aisy/core'

/**
 * Explicit cutover seam for ADR-0069. With the gate off, behaviour is exactly
 * the legacy file resolver. With it on, a non-builtin card can come only from
 * the exact durable binding; absence/archive never falls back to a file.
 */
export function selectAgentCardForRun(input: {
  name: string
  registryCutover: boolean
  binding: AgentCardBinding
  registry: Pick<AgentCardRegistry, 'resolveActive'>
  legacy: Pick<CardResolver, 'resolve'>
  /** Reserved built-in names, which never live in the registry. */
  builtinNames?: readonly string[]
}): AgentCard | undefined {
  if (!input.registryCutover || (input.builtinNames ?? []).includes(input.name)) {
    return input.legacy.resolve(input.name)
  }
  return input.registry.resolveActive(input.name, input.binding)?.card
}
