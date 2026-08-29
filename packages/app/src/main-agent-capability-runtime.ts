import {
  makeSkillPromptRuntime,
  resolveAgentCapabilityMatrix,
  type AgentCard,
  type AgentCapabilityMatrix,
  type AgentRunner,
  type AnthropicTool,
  type SkillPromptRuntime,
  type ToolCall,
  type ToolExecutionContext,
  type ToolResult,
  type ToolTier,
  type TurnInput,
} from '@aisy/core'

interface ActiveSkillsView {
  menu(): Array<{ name: string; description: string }>
  matchTriggers(request: string): string[]
  loadBody(name: string): Promise<string>
}

export interface MainAgentCapabilityRuntime {
  card: Readonly<AgentCard>
  matrix: AgentCapabilityMatrix
  skillPromptRuntime: SkillPromptRuntime
  bindToolExecutor(
    base: (call: ToolCall, context?: ToolExecutionContext) => Promise<ToolResult>,
  ): (call: ToolCall, context?: ToolExecutionContext) => Promise<ToolResult>
  wrapRunner(runner: AgentRunner): AgentRunner
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item)
    return Object.freeze(value)
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) freezeJson(item)
    return Object.freeze(value)
  }
  return value
}

/**
 * Resolves one explicitly selected main AgentCard into immutable, code-owned
 * runtime boundaries. The provider receives matrix.tools at the composition
 * root; this helper independently constrains Skills, executor calls and DNA.
 */
export function makeMainAgentCapabilityRuntime(input: {
  card: AgentCard
  toolCatalog: readonly AnthropicTool[]
  activeSkills: ActiveSkillsView
  activeSkillNames: ReadonlySet<string>
  activeMcpServers: ReadonlySet<string>
  minimumToolTiers?: Readonly<Record<string, ToolTier>>
  /** Platform conversation controls remain available to the main agent even
   * when an older AgentCard predates them. They are code-owned closed tools,
   * not workload capabilities delegated by the card. */
  platformToolNames?: ReadonlySet<string>
}): MainAgentCapabilityRuntime {
  const card: AgentCard = Object.freeze({
    ...input.card,
    skills: Object.freeze([...input.card.skills]) as unknown as string[],
    mcpAllowlist: Object.freeze([...input.card.mcpAllowlist]) as unknown as string[],
    toolTiers: Object.freeze({ ...input.card.toolTiers }) as Record<string, number>,
  })
  const resolved = resolveAgentCapabilityMatrix({
    card,
    toolCatalog: input.toolCatalog,
    activeSkills: input.activeSkillNames,
    activeMcpServers: input.activeMcpServers,
    ...(input.minimumToolTiers === undefined ? {} : { minimumToolTiers: input.minimumToolTiers }),
  })
  const platformTools = input.toolCatalog.filter((tool) =>
    input.platformToolNames?.has(tool.name) === true &&
    !resolved.tools.some((candidate) => candidate.name === tool.name))
  const resolvedTools = [...resolved.tools, ...platformTools]
  const resolvedTiers = { ...resolved.toolTiers }
  for (const tool of platformTools) {
    const tier = input.minimumToolTiers?.[tool.name]
    if (tier === undefined) throw new Error('PLATFORM_TOOL_TIER_UNAVAILABLE')
    resolvedTiers[tool.name] = tier
  }
  const matrix: AgentCapabilityMatrix = Object.freeze({
    ...resolved,
    tools: Object.freeze(resolvedTools.map((tool) => Object.freeze({
      ...tool,
      input_schema: freezeJson(structuredClone(tool.input_schema)) as Record<string, unknown>,
    }))) as unknown as AnthropicTool[],
    toolTiers: Object.freeze(resolvedTiers),
    skills: Object.freeze([...resolved.skills]) as unknown as string[],
    mcpServers: Object.freeze([...resolved.mcpServers]) as unknown as string[],
  })
  const allowedTools = new Set(matrix.tools.map((tool) => tool.name))
  const allowedSkills = new Set(matrix.skills)
  const skillPromptRuntime = makeSkillPromptRuntime({
    menu: () => input.activeSkills.menu().filter((item) => allowedSkills.has(item.name)),
    matchTriggers: (request) => input.activeSkills
      .matchTriggers(request)
      .filter((name) => allowedSkills.has(name)),
    loadBody: (name) => allowedSkills.has(name)
      ? input.activeSkills.loadBody(name)
      : Promise.resolve(''),
  })
  const dna = Object.freeze({
    role: 'system' as const,
    provenance: card.provenance === 'community' ? 'untrusted' as const : 'operator' as const,
    text: card.instructions,
  })

  return Object.freeze<MainAgentCapabilityRuntime>({
    card,
    matrix,
    skillPromptRuntime,
    bindToolExecutor(base) {
      return async (call, context) => {
        if (!allowedTools.has(call.name)) {
          return { ok: false, output: 'capability denied' }
        }
        return base(call, context)
      }
    },
    wrapRunner(runner) {
      return Object.freeze({
        handle: (turn: TurnInput) => runner.handle({
          ...turn,
          spans: [dna, ...turn.spans],
        }),
      })
    },
  })
}
