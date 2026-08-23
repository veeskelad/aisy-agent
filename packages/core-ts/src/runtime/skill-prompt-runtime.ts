import type { ContextSpan, TurnInput } from '../agent-loop/types.js'
import type { Skills } from '../skills/index.js'

export interface SkillPromptRuntime {
  prefixExtension(): Uint8Array
  augmentTurn(input: TurnInput): Promise<ContextSpan[]>
}

/** Menu is stable/frozen in the prefix; only matched bodies enter working context. */
export function makeSkillPromptRuntime(skills: Pick<Skills, 'menu' | 'matchTriggers' | 'loadBody'>): SkillPromptRuntime {
  return {
    prefixExtension() {
      const menu = [...skills.menu()].sort((a, b) => a.name.localeCompare(b.name))
      if (menu.length === 0) return new Uint8Array(0)
      const text = '\n\nДоступные проверенные навыки:\n' +
        menu.map(item => `- ${item.name}: ${item.description}`).join('\n')
      return new TextEncoder().encode(text)
    },

    async augmentTurn(input) {
      const request = input.spans
        .filter(span => span.role === 'user' && span.provenance === 'operator')
        .map(span => span.text)
        .join('\n')
      if (request.length === 0) return []
      const names = [...new Set(skills.matchTriggers(request))].sort()
      const spans: ContextSpan[] = []
      for (const name of names) {
        const body = await skills.loadBody(name)
        if (body.trim().length === 0) continue
        spans.push({
          role: 'system',
          provenance: 'operator',
          text: `[Навык: ${name}]\n${body}`,
        })
      }
      return spans
    },
  }
}
