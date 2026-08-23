import { createHash } from 'node:crypto'
import type {
  AgentCard,
  DelegationHandle,
  DelegationTask,
} from '../orchestration/index.js'
import type { AnthropicTool } from './provider-anthropic.js'
import { resolvedWorkBinding, type ResolvedWorkBinding } from './work-binding.js'
import type { ToolTier } from './tool-catalog.js'
import { isChildExecutableRuntimeTool, runtimeToolDefinition } from './tool-catalog.js'

export type AgentCapabilityErrorCode =
  | 'INVALID_CARD'
  | 'UNKNOWN_TOOL'
  | 'UNAVAILABLE_SKILL'
  | 'UNAVAILABLE_MCP'
  | 'DUPLICATE_TOOL_SCHEMA'

export class AgentCapabilityError extends Error {
  constructor(
    public readonly code: AgentCapabilityErrorCode,
    public readonly references: string[],
  ) {
    super(`${code}: ${references.join(', ')}`)
    this.name = 'AgentCapabilityError'
  }
}

export interface AgentCapabilityMatrix {
  cardName: string
  tools: AnthropicTool[]
  toolTiers: Readonly<Record<string, 0 | 1 | 2 | 3>>
  skills: string[]
  mcpServers: string[]
  maxIterations: number
  contextStrategy: 'compact' | 'full'
}

export type DelegationAuthorityErrorCode =
  | 'AUTHORITY_INVALID'
  | 'IDENTITY_MISMATCH'
  | 'CAPABILITY_MISMATCH'
  | 'AUTHORITY_CHECKPOINT_MISMATCH'
  | 'DEPTH_EXCEEDED'
  | 'CONCURRENCY_INVALID'
  | 'BUDGET_INVALID'

export class DelegationAuthorityError extends Error {
  constructor(public readonly code: DelegationAuthorityErrorCode) {
    super(code)
    this.name = 'DelegationAuthorityError'
  }
}

export type DelegationAuthorityHandle = Pick<
  DelegationHandle,
  | 'delegationId'
  | 'taskId'
  | 'binding'
  | 'card'
  | 'owns'
  | 'writableMcp'
  | 'permitsTool'
  | 'permitsMcp'
>

export interface DelegationExecutionIdentityV1 {
  readonly delegationId: string
  readonly taskId: string
  readonly childSessionId: string
  readonly binding: Readonly<ResolvedWorkBinding>
}

export interface DelegationExecutionLimitsV1 {
  readonly depth: 1
  readonly maxDepth: 1
  readonly maxConcurrency: number
  readonly maxIterations: number
  readonly maxReplans: number
  readonly spendUsd: number
}

export interface DelegationExecutionAuthorityV1 {
  readonly schemaVersion: 1
  readonly identity: DelegationExecutionIdentityV1
  readonly dna: {
    readonly body: string
    readonly provenance: AgentCard['provenance']
    readonly sha256: string
  }
  readonly capabilities: Readonly<AgentCapabilityMatrix>
  readonly scope: {
    readonly owns: readonly string[]
    readonly doNotTouch: readonly string[]
    readonly writableMcp: readonly string[]
  }
  readonly limits: DelegationExecutionLimitsV1
  readonly capabilityHash: string
  readonly authorityHash: string
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DelegationAuthorityError('AUTHORITY_INVALID')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new DelegationAuthorityError('AUTHORITY_INVALID')
  if (seen.has(value)) throw new DelegationAuthorityError('AUTHORITY_INVALID')
  seen.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, seen)).join(',')}]`
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DelegationAuthorityError('AUTHORITY_INVALID')
    }
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function domainHash(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`aisy:${domain}:v1\0`, 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex')
}

function cloneFrozenJson<T>(value: T): T {
  // canonicalJson is also the strict JSON-value preflight. structuredClone by
  // itself would accept values (Date, Map, cycles) that a provider schema must
  // never contain.
  canonicalJson(value)
  const cloned = structuredClone(value)
  const pending: object[] = []
  if (cloned !== null && typeof cloned === 'object') pending.push(cloned)
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const nested of Object.values(current)) {
      if (nested !== null && typeof nested === 'object') pending.push(nested)
    }
    Object.freeze(current)
  }
  return cloned
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right)
  } catch {
    return false
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string') &&
    new Set(value).size === value.length
}

/**
 * Recompute every authority hash and return a defensive deep-frozen snapshot.
 * Callers must use the returned value; the input object is never trusted.
 */
export function validateDelegationExecutionAuthority(
  value: unknown,
): DelegationExecutionAuthorityV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DelegationAuthorityError('AUTHORITY_INVALID')
  }
  const raw = value as Record<string, unknown>
  if (!exactKeys(raw, [
    'schemaVersion', 'identity', 'dna', 'capabilities', 'scope', 'limits',
    'capabilityHash', 'authorityHash',
  ]) || raw['schemaVersion'] !== 1 || typeof raw['capabilityHash'] !== 'string' ||
    typeof raw['authorityHash'] !== 'string') {
    throw new DelegationAuthorityError('AUTHORITY_INVALID')
  }
  const identityRaw = raw['identity']
  const dnaRaw = raw['dna']
  const capabilitiesRaw = raw['capabilities']
  const scopeRaw = raw['scope']
  const limitsRaw = raw['limits']
  if (typeof identityRaw !== 'object' || identityRaw === null || Array.isArray(identityRaw) ||
    typeof dnaRaw !== 'object' || dnaRaw === null || Array.isArray(dnaRaw) ||
    typeof capabilitiesRaw !== 'object' || capabilitiesRaw === null || Array.isArray(capabilitiesRaw) ||
    typeof scopeRaw !== 'object' || scopeRaw === null || Array.isArray(scopeRaw) ||
    typeof limitsRaw !== 'object' || limitsRaw === null || Array.isArray(limitsRaw)) {
    throw new DelegationAuthorityError('AUTHORITY_INVALID')
  }
  const identityRecord = identityRaw as Record<string, unknown>
  const dnaRecord = dnaRaw as Record<string, unknown>
  const capabilitiesRecord = capabilitiesRaw as Record<string, unknown>
  const scopeRecord = scopeRaw as Record<string, unknown>
  const limitsRecord = limitsRaw as Record<string, unknown>
  if (!exactKeys(identityRecord, ['delegationId', 'taskId', 'childSessionId', 'binding']) ||
    !exactKeys(dnaRecord, ['body', 'provenance', 'sha256']) ||
    !exactKeys(capabilitiesRecord, [
      'cardName', 'tools', 'toolTiers', 'skills', 'mcpServers', 'maxIterations', 'contextStrategy',
    ]) || !exactKeys(scopeRecord, ['owns', 'doNotTouch', 'writableMcp']) ||
    !exactKeys(limitsRecord, [
      'depth', 'maxDepth', 'maxConcurrency', 'maxIterations', 'maxReplans', 'spendUsd',
    ])) {
    throw new DelegationAuthorityError('AUTHORITY_INVALID')
  }
  if (typeof identityRecord['delegationId'] !== 'string' ||
    typeof identityRecord['taskId'] !== 'string' ||
    identityRecord['childSessionId'] !== identityRecord['delegationId'] ||
    identityRecord['delegationId'] !== `d-${identityRecord['taskId']}` ||
    typeof dnaRecord['body'] !== 'string' || dnaRecord['body'].trim().length === 0 ||
    (dnaRecord['provenance'] !== 'builtin' && dnaRecord['provenance'] !== 'user' &&
      dnaRecord['provenance'] !== 'community') || typeof dnaRecord['sha256'] !== 'string' ||
    typeof capabilitiesRecord['cardName'] !== 'string' ||
    !Array.isArray(capabilitiesRecord['tools']) ||
    typeof capabilitiesRecord['toolTiers'] !== 'object' ||
    capabilitiesRecord['toolTiers'] === null || Array.isArray(capabilitiesRecord['toolTiers']) ||
    !stringArray(capabilitiesRecord['skills']) || !stringArray(capabilitiesRecord['mcpServers']) ||
    !Number.isInteger(capabilitiesRecord['maxIterations']) ||
    (capabilitiesRecord['maxIterations'] as number) < 1 ||
    (capabilitiesRecord['maxIterations'] as number) > 200 ||
    (capabilitiesRecord['contextStrategy'] !== 'compact' &&
      capabilitiesRecord['contextStrategy'] !== 'full') ||
    !stringArray(scopeRecord['owns']) || !stringArray(scopeRecord['doNotTouch']) ||
    !stringArray(scopeRecord['writableMcp']) || limitsRecord['depth'] !== 1 ||
    limitsRecord['maxDepth'] !== 1 || !Number.isInteger(limitsRecord['maxConcurrency']) ||
    (limitsRecord['maxConcurrency'] as number) < 1 || (limitsRecord['maxConcurrency'] as number) > 64 ||
    !Number.isInteger(limitsRecord['maxIterations']) || (limitsRecord['maxIterations'] as number) < 1 ||
    !Number.isInteger(limitsRecord['maxReplans']) || (limitsRecord['maxReplans'] as number) < 0 ||
    typeof limitsRecord['spendUsd'] !== 'number' || !Number.isFinite(limitsRecord['spendUsd']) ||
    (limitsRecord['spendUsd'] as number) < 0) {
    throw new DelegationAuthorityError('AUTHORITY_INVALID')
  }
  if ((limitsRecord['maxIterations'] as number) >
    (capabilitiesRecord['maxIterations'] as number)) {
    throw new DelegationAuthorityError('BUDGET_INVALID')
  }

  let binding: ResolvedWorkBinding
  let tools: AnthropicTool[]
  try {
    if (typeof identityRecord['binding'] !== 'object' || identityRecord['binding'] === null ||
      Array.isArray(identityRecord['binding']) ||
      !exactKeys(identityRecord['binding'] as Record<string, unknown>, [
        'operatorId', 'profileId', 'projectId', 'sessionId', 'scope',
      ])) {
      throw new DelegationAuthorityError('AUTHORITY_INVALID')
    }
    binding = resolvedWorkBinding(identityRecord['binding'])
    tools = (capabilitiesRecord['tools'] as unknown[]).map(item => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new DelegationAuthorityError('AUTHORITY_INVALID')
      }
      const tool = item as Record<string, unknown>
      if (!exactKeys(tool, ['name', 'description', 'input_schema']) ||
        typeof tool['name'] !== 'string' || typeof tool['description'] !== 'string' ||
        typeof tool['input_schema'] !== 'object' || tool['input_schema'] === null ||
        Array.isArray(tool['input_schema'])) {
        throw new DelegationAuthorityError('AUTHORITY_INVALID')
      }
      return cloneFrozenJson(tool) as unknown as AnthropicTool
    })
  } catch {
    throw new DelegationAuthorityError('AUTHORITY_INVALID')
  }
  const toolTiers = cloneFrozenJson(capabilitiesRecord['toolTiers']) as Record<string, 0 | 1 | 2 | 3>
  const toolNames = tools.map(tool => tool.name)
  if (new Set(toolNames).size !== toolNames.length ||
    !sameValue([...toolNames].sort(), Object.keys(toolTiers).sort()) ||
    Object.values(toolTiers).some(tier => !Number.isInteger(tier) || tier < 0 || tier > 3) ||
    toolNames.some(name => {
      const definition = runtimeToolDefinition(name)
      const tool = tools.find(candidate => candidate.name === name)
      return definition === undefined || tool === undefined || toolTiers[name]! < definition.tier ||
        tool.description !== definition.description ||
        !sameValue(tool.input_schema, definition.input_schema)
    }) ||
    toolNames.some(name => !isChildExecutableRuntimeTool(name)) ||
    (scopeRecord['writableMcp'] as string[]).some(server =>
      !(capabilitiesRecord['mcpServers'] as string[]).includes(server))) {
    throw new DelegationAuthorityError('CAPABILITY_MISMATCH')
  }
  const capabilities = Object.freeze({
    cardName: capabilitiesRecord['cardName'] as string,
    tools: Object.freeze(tools) as unknown as AnthropicTool[],
    toolTiers,
    skills: Object.freeze([...(capabilitiesRecord['skills'] as string[])]) as unknown as string[],
    mcpServers: Object.freeze([...(capabilitiesRecord['mcpServers'] as string[])]) as unknown as string[],
    maxIterations: capabilitiesRecord['maxIterations'] as number,
    contextStrategy: capabilitiesRecord['contextStrategy'] as 'compact' | 'full',
  })
  const dnaBase = {
    cardName: capabilities.cardName,
    body: dnaRecord['body'],
    provenance: dnaRecord['provenance'],
  }
  const dnaSha256 = domainHash('delegation-dna', dnaBase)
  const capabilitiesValue = {
    cardName: capabilities.cardName,
    tools: capabilities.tools,
    toolTiers: capabilities.toolTiers,
    skills: capabilities.skills,
    mcpServers: capabilities.mcpServers,
    maxIterations: capabilities.maxIterations,
    contextStrategy: capabilities.contextStrategy,
  }
  const capabilityHash = domainHash('delegation-capabilities', capabilitiesValue)
  const identity = Object.freeze({
    delegationId: identityRecord['delegationId'] as string,
    taskId: identityRecord['taskId'] as string,
    childSessionId: identityRecord['childSessionId'] as string,
    binding: Object.freeze({ ...binding }),
  })
  const dna = Object.freeze({
    body: dnaRecord['body'] as string,
    provenance: dnaRecord['provenance'] as AgentCard['provenance'],
    sha256: dnaSha256,
  })
  const scope = Object.freeze({
    owns: Object.freeze([...(scopeRecord['owns'] as string[])]),
    doNotTouch: Object.freeze([...(scopeRecord['doNotTouch'] as string[])]),
    writableMcp: Object.freeze([...(scopeRecord['writableMcp'] as string[])]),
  })
  const limits = Object.freeze({
    depth: 1 as const,
    maxDepth: 1 as const,
    maxConcurrency: limitsRecord['maxConcurrency'] as number,
    maxIterations: limitsRecord['maxIterations'] as number,
    maxReplans: limitsRecord['maxReplans'] as number,
    spendUsd: limitsRecord['spendUsd'] as number,
  })
  const authorityHash = domainHash('delegation-authority', {
    schemaVersion: 1,
    identity,
    dnaSha256,
    capabilityHash,
    scope,
    limits,
  })
  if (dnaRecord['sha256'] !== dnaSha256 || raw['capabilityHash'] !== capabilityHash ||
    raw['authorityHash'] !== authorityHash) {
    throw new DelegationAuthorityError('AUTHORITY_CHECKPOINT_MISMATCH')
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    identity,
    dna,
    capabilities,
    scope,
    limits,
    capabilityHash,
    authorityHash,
  })
}

/**
 * Resolve an AgentCard exclusively against code-owned live registries. Missing
 * references reject the whole card before provider/model I/O; they are never
 * silently widened or advertised as decorative capabilities.
 */
export function resolveAgentCapabilityMatrix(input: {
  card: AgentCard
  toolCatalog: readonly AnthropicTool[]
  activeSkills: ReadonlySet<string>
  activeMcpServers: ReadonlySet<string>
  /** Code-owned floor. AgentCard values may tighten it, never lower it. */
  minimumToolTiers?: Readonly<Record<string, ToolTier>>
}): AgentCapabilityMatrix {
  const { card } = input
  if (card.instructions.trim().length === 0 || !Number.isInteger(card.maxIterations) ||
    card.maxIterations < 1 || card.maxIterations > 200) {
    throw new AgentCapabilityError('INVALID_CARD', [card.name])
  }

  const catalog = new Map<string, AnthropicTool>()
  const duplicates = new Set<string>()
  for (const tool of input.toolCatalog) {
    if (catalog.has(tool.name)) duplicates.add(tool.name)
    catalog.set(tool.name, tool)
  }
  if (duplicates.size > 0) {
    throw new AgentCapabilityError('DUPLICATE_TOOL_SCHEMA', [...duplicates].sort())
  }

  const toolNames = Object.keys(card.toolTiers)
  const invalidTiers = toolNames.filter(name => {
    const tier = card.toolTiers[name]
    return !Number.isInteger(tier) || tier! < 0 || tier! > 3
  })
  if (invalidTiers.length > 0) throw new AgentCapabilityError('INVALID_CARD', invalidTiers.sort())
  const unknownTools = toolNames.filter(name => !catalog.has(name))
  if (unknownTools.length > 0) throw new AgentCapabilityError('UNKNOWN_TOOL', unknownTools.sort())

  const unavailableSkills = card.skills.filter(name => !input.activeSkills.has(name))
  if (unavailableSkills.length > 0) {
    throw new AgentCapabilityError('UNAVAILABLE_SKILL', [...new Set(unavailableSkills)].sort())
  }
  const unavailableMcp = card.mcpAllowlist.filter(name => !input.activeMcpServers.has(name))
  if (unavailableMcp.length > 0) {
    throw new AgentCapabilityError('UNAVAILABLE_MCP', [...new Set(unavailableMcp)].sort())
  }

  const toolTiers: Record<string, 0 | 1 | 2 | 3> = {}
  for (const name of toolNames.sort()) {
    const requested = card.toolTiers[name] as ToolTier
    const minimum = input.minimumToolTiers?.[name]
    toolTiers[name] = minimum === undefined ? requested : Math.max(requested, minimum) as ToolTier
  }
  const tools = input.toolCatalog
    .filter(tool => toolNames.includes(tool.name))
    .map(tool => cloneFrozenJson(tool))
  return Object.freeze({
    cardName: card.name,
    tools: Object.freeze(tools) as unknown as AnthropicTool[],
    toolTiers: Object.freeze(toolTiers),
    skills: Object.freeze([...card.skills]) as unknown as string[],
    mcpServers: Object.freeze([...card.mcpAllowlist]) as unknown as string[],
    maxIterations: card.maxIterations,
    contextStrategy: card.contextStrategy,
  })
}

/** Child providers see only capabilities that the scoped executor can run. */
export function resolveChildAgentCapabilityMatrix(
  input: Parameters<typeof resolveAgentCapabilityMatrix>[0],
): AgentCapabilityMatrix {
  const matrix = resolveAgentCapabilityMatrix(input)
  const tools = matrix.tools.filter(tool => isChildExecutableRuntimeTool(tool.name))
  const allowed = new Set(tools.map(tool => tool.name))
  const toolTiers = Object.freeze(Object.fromEntries(
    Object.entries(matrix.toolTiers).filter(([name]) => allowed.has(name)),
  ) as Record<string, 0 | 1 | 2 | 3>)
  return Object.freeze({
    ...matrix,
    tools: Object.freeze([...tools]) as unknown as AnthropicTool[],
    toolTiers,
  })
}

/**
 * Freeze the complete code-owned authority for one depth-1 delegation. This is
 * additive and deliberately does not select a live concurrency default.
 */
export function resolveDelegationExecutionAuthority(input: {
  handle: DelegationAuthorityHandle
  task: DelegationTask
  matrix: AgentCapabilityMatrix
  maxConcurrency: number
}): DelegationExecutionAuthorityV1 {
  const { handle, task, matrix } = input
  if (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1 ||
    input.maxConcurrency > 64) {
    throw new DelegationAuthorityError('CONCURRENCY_INVALID')
  }
  if (handle.delegationId !== `d-${task.taskId}` || handle.taskId !== task.taskId ||
    task.assignedTo === null || task.assignedTo !== handle.card.name) {
    throw new DelegationAuthorityError('IDENTITY_MISMATCH')
  }

  let binding: ResolvedWorkBinding
  try {
    binding = resolvedWorkBinding(handle.binding)
  } catch {
    throw new DelegationAuthorityError('IDENTITY_MISMATCH')
  }

  const card = handle.card
  const cardToolNames = Object.keys(card.toolTiers).sort()
  const matrixToolNames = matrix.tools.map(tool => tool.name).sort()
  if (matrix.cardName !== card.name ||
    !sameValue(Object.keys(matrix.toolTiers).sort(), matrixToolNames) ||
    matrixToolNames.some(name => !cardToolNames.includes(name) ||
      matrix.toolTiers[name]! < card.toolTiers[name]! || !isChildExecutableRuntimeTool(name)) ||
    !sameValue(matrix.skills, card.skills) || !sameValue(matrix.mcpServers, card.mcpAllowlist) ||
    matrix.maxIterations !== card.maxIterations || matrix.contextStrategy !== card.contextStrategy ||
    matrix.tools.some(tool => {
      const definition = runtimeToolDefinition(tool.name)
      return definition === undefined || matrix.toolTiers[tool.name]! < definition.tier ||
        tool.description !== definition.description ||
        !sameValue(tool.input_schema, definition.input_schema)
    }) ||
    !sameValue(handle.owns, task.scope.owns) ||
    handle.writableMcp.some(server => !matrix.mcpServers.includes(server)) ||
    matrixToolNames.some(name => !handle.permitsTool(name)) ||
    handle.writableMcp.some(server => !handle.permitsMcp(server))) {
    throw new DelegationAuthorityError('CAPABILITY_MISMATCH')
  }

  if (!Number.isInteger(task.retryPolicy.maxIterations) || task.retryPolicy.maxIterations < 1 ||
    !Number.isInteger(task.retryPolicy.maxReplans) || task.retryPolicy.maxReplans < 0 ||
    !Number.isInteger(task.budgetSlice.iterations) || task.budgetSlice.iterations < 1 ||
    typeof task.budgetSlice.spendUsd !== 'number' || !Number.isFinite(task.budgetSlice.spendUsd) ||
    task.budgetSlice.spendUsd < 0) {
    throw new DelegationAuthorityError('BUDGET_INVALID')
  }

  // The accepted ADR-0052 runtime is depth-1. A future nesting policy is a new
  // contract; this authority cannot represent or smuggle a deeper child.
  const depth = 1 as const
  const maxDepth = 1 as const
  if (depth > maxDepth) throw new DelegationAuthorityError('DEPTH_EXCEEDED')

  let frozenMatrix: AgentCapabilityMatrix
  try {
    const childCard: AgentCard = { ...card, toolTiers: { ...matrix.toolTiers } }
    frozenMatrix = resolveAgentCapabilityMatrix({
      card: childCard,
      toolCatalog: matrix.tools,
      activeSkills: new Set(matrix.skills),
      activeMcpServers: new Set(matrix.mcpServers),
      minimumToolTiers: matrix.toolTiers,
    })
  } catch {
    throw new DelegationAuthorityError('CAPABILITY_MISMATCH')
  }
  const identity = Object.freeze({
    delegationId: handle.delegationId,
    taskId: task.taskId,
    childSessionId: handle.delegationId,
    binding: Object.freeze({ ...binding }),
  })
  const dnaBase = {
    cardName: card.name,
    body: card.instructions,
    provenance: card.provenance,
  }
  const dna = Object.freeze({
    body: card.instructions,
    provenance: card.provenance,
    sha256: domainHash('delegation-dna', dnaBase),
  })
  const capabilitiesValue = {
    cardName: frozenMatrix.cardName,
    tools: frozenMatrix.tools,
    toolTiers: frozenMatrix.toolTiers,
    skills: frozenMatrix.skills,
    mcpServers: frozenMatrix.mcpServers,
    maxIterations: frozenMatrix.maxIterations,
    contextStrategy: frozenMatrix.contextStrategy,
  }
  const capabilityHash = domainHash('delegation-capabilities', capabilitiesValue)
  const scope = Object.freeze({
    owns: Object.freeze([...handle.owns]),
    doNotTouch: Object.freeze([...task.scope.doNotTouch]),
    writableMcp: Object.freeze([...handle.writableMcp]),
  })
  const limits = Object.freeze({
    depth,
    maxDepth,
    maxConcurrency: input.maxConcurrency,
    maxIterations: Math.min(
      card.maxIterations,
      frozenMatrix.maxIterations,
      task.retryPolicy.maxIterations,
      task.budgetSlice.iterations,
    ),
    maxReplans: task.retryPolicy.maxReplans,
    spendUsd: task.budgetSlice.spendUsd,
  })
  const authorityHash = domainHash('delegation-authority', {
    schemaVersion: 1,
    identity,
    dnaSha256: dna.sha256,
    capabilityHash,
    scope,
    limits,
  })
  return Object.freeze({
    schemaVersion: 1 as const,
    identity,
    dna,
    capabilities: frozenMatrix,
    scope,
    limits,
    capabilityHash,
    authorityHash,
  })
}
