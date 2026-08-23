import { describe, expect, it } from 'vitest'
import type {
  AgentCard,
  AgentRunner,
  AnthropicTool,
  ToolCall,
  ToolExecutionContext,
  ToolResult,
  TurnInput,
} from '@aisy/core'
import { makeMainAgentCapabilityRuntime } from './main-agent-capability-runtime.js'

const tools: AnthropicTool[] = [
  { name: 'read_file', description: 'read', input_schema: {} },
  { name: 'write_file', description: 'write', input_schema: {} },
]

function card(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'main',
    instructions: 'Ты основной агент Aisy.',
    skills: ['review-code'],
    mcpAllowlist: [],
    toolTiers: { read_file: 0 },
    maxIterations: 17,
    contextStrategy: 'full',
    provenance: 'user',
    ...overrides,
  }
}

function runtime(value = card()) {
  return makeMainAgentCapabilityRuntime({
    card: value,
    toolCatalog: tools,
    activeSkillNames: new Set(['review-code', 'deploy']),
    activeMcpServers: new Set(),
    minimumToolTiers: { read_file: 0, write_file: 2 },
    activeSkills: {
      menu: () => [
        { name: 'review-code', description: 'Проверка кода' },
        { name: 'deploy', description: 'Деплой' },
      ],
      matchTriggers: () => ['review-code', 'deploy'],
      loadBody: async (name) => `body:${name}`,
    },
  })
}

describe('makeMainAgentCapabilityRuntime', () => {
  it('exposes exactly card tools and Skills to the live composition', async () => {
    const resolved = runtime()

    expect(resolved.matrix.tools.map((tool) => tool.name)).toEqual(['read_file'])
    expect(resolved.matrix.maxIterations).toBe(17)
    expect(Object.isFrozen(resolved.matrix)).toBe(true)
    expect(Object.isFrozen(resolved.matrix.tools)).toBe(true)
    expect(Object.isFrozen(resolved.matrix.tools[0]?.input_schema)).toBe(true)
    expect(new TextDecoder().decode(resolved.skillPromptRuntime.prefixExtension()))
      .toContain('review-code')
    expect(new TextDecoder().decode(resolved.skillPromptRuntime.prefixExtension()))
      .not.toContain('deploy')
    await expect(resolved.skillPromptRuntime.augmentTurn({
      sessionId: 's1',
      spans: [{ role: 'user', provenance: 'operator', text: 'проверь' }],
    })).resolves.toEqual([
      expect.objectContaining({ text: '[Навык: review-code]\nbody:review-code' }),
    ])
  })

  it('denies an off-card tool before the base executor', async () => {
    const calls: ToolCall[] = []
    const base = async (call: ToolCall): Promise<ToolResult> => {
      calls.push(call)
      return { ok: true, output: 'executed' }
    }
    const execute = runtime().bindToolExecutor(base)

    await expect(execute({ name: 'write_file', args: {} })).resolves.toEqual({
      ok: false,
      output: 'capability denied',
    })
    await expect(execute({ name: 'read_file', args: {} })).resolves.toEqual({
      ok: true,
      output: 'executed',
    })
    expect(calls.map((call) => call.name)).toEqual(['read_file'])
  })

  it('forwards execution identity only for an allowed tool', async () => {
    const contexts: Array<ToolExecutionContext | undefined> = []
    const execute = runtime().bindToolExecutor(async (_call, context) => {
      contexts.push(context)
      return { ok: true, output: 'executed' }
    })
    const context = Object.freeze({ sessionId: 's1', turnId: 'turn-1', ordinal: 2 })

    await execute({ name: 'write_file', args: {} }, context)
    await execute({ name: 'read_file', args: {} }, context)

    expect(contexts).toEqual([context])
  })

  it('does not let main AgentCard lower the global tool tier', () => {
    const resolved = runtime(card({
      skills: [],
      toolTiers: { write_file: 0 },
    }))
    expect(resolved.matrix.toolTiers).toEqual({ write_file: 2 })
  })

  it('prepends immutable DNA and narrows community provenance', async () => {
    const turns: TurnInput[] = []
    const runner: AgentRunner = {
      handle: async (turn) => {
        turns.push(turn)
        return { state: 'ok', reply: 'ok', narrowed: false }
      },
    }
    const value = card({ provenance: 'community', instructions: 'Community DNA' })
    const resolved = runtime(value)
    const wrapped = resolved.wrapRunner(runner)
    value.instructions = 'mutated after composition'

    await wrapped.handle({
      sessionId: 's1',
      spans: [{ role: 'user', provenance: 'operator', text: 'task' }],
    })

    expect(turns[0]?.spans[0]).toEqual({
      role: 'system',
      provenance: 'untrusted',
      text: 'Community DNA',
    })
  })

  it('fails closed on unavailable references before a runtime is returned', () => {
    expect(() => runtime(card({ skills: ['missing'] }))).toThrow(
      expect.objectContaining({ code: 'UNAVAILABLE_SKILL' }),
    )
  })
})
