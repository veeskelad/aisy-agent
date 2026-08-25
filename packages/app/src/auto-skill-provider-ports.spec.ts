import {
  makeVerifiedWorkflowEvidence,
  type AutoSkillDescriptorRegistry,
  type ProviderAdapter,
} from '@aisy/core'
import { describe, expect, it, vi } from 'vitest'

import {
  makeProviderSkillRecipeGenerator,
  makeProviderSkillRecipeJudge,
} from './auto-skill-provider-ports.js'

const registry: AutoSkillDescriptorRegistry = Object.freeze({
  revision: 'registry-v1',
  descriptor: (id: string) => id === 'memory.remember' ? {
    id, title: 'Запоминание факта', description: 'Запоминает факт', trigger: 'запомни',
    placeholders: [{ id: 'fact', source: 'current_request' as const }],
    postconditions: ['memory.committed'],
  } : null,
})

const evidence = makeVerifiedWorkflowEvidence({
  sessionId: 'private-session-a', turnId: 'private-turn-a',
  scope: {
    botId: 'bot-a', operatorId: 'operator-a', profileId: 'default',
    projectId: 'project-a', resourceScope: 'project-workspace',
    capabilityRevision: 'capability-v1',
  },
  registry,
  steps: [{
    descriptorId: 'memory.remember', placeholderIds: ['fact'],
    postconditionIds: ['memory.committed'], receiptId: 'a'.repeat(64),
  }],
  trusted: true, narrowed: false,
})!

describe('provider auto-skill ports', () => {
  it('sends only a bounded redacted trace and accepts strict recipe JSON', async () => {
    const seen = vi.fn()
    const provider: ProviderAdapter = {
      complete: async request => {
        seen(request)
        return { reply: '{"version":1,"steps":[{"descriptorId":"memory.remember","placeholderIds":["fact"],"postconditionIds":["memory.committed"]}]}' }
      },
    }
    const generator = makeProviderSkillRecipeGenerator({
      provider, providerId: 'provider-a', model: 'model-a',
    })

    await expect(generator.generate({
      evidence: [evidence, { ...evidence, sessionId: 'private-session-b' }],
      allowedDescriptorIds: ['memory.remember'],
    })).resolves.toMatchObject({ version: 1 })
    const serialized = JSON.stringify(seen.mock.calls[0]?.[0])
    expect(serialized).not.toContain('private-session-a')
    expect(serialized).not.toContain('private-turn-a')
    expect(serialized).not.toContain(evidence.steps[0]!.receiptId)
  })

  it('rejects Markdown, tool calls and extra judge fields', async () => {
    const markdown: ProviderAdapter = {
      complete: async () => ({ reply: '```json\n{"version":1,"steps":[]}\n```' }),
    }
    await expect(makeProviderSkillRecipeGenerator({
      provider: markdown, providerId: 'p', model: 'm',
    }).generate({ evidence: [evidence], allowedDescriptorIds: ['memory.remember'] }))
      .rejects.toThrow('AUTO_SKILL_MODEL_OUTPUT_INVALID')

    const toolCall: ProviderAdapter = {
      complete: async () => ({
        reply: '{"accepted":true}', toolCalls: [{ name: 'bash', args: {} }],
      }),
    }
    await expect(makeProviderSkillRecipeJudge({
      provider: toolCall, providerId: 'judge', model: 'model-b',
    }).judge({
      manifest: {
        schemaVersion: 1, skillIdentity: evidence.skillIdentity,
        scopeKey: evidence.scopeKey, registryRevision: registry.revision,
        revisionHash: 'b'.repeat(64), name: 'auto-test', title: 'Тест',
        description: 'Тест', triggers: ['запомни'], steps: [],
      },
      renderedSkill: 'safe',
    })).rejects.toThrow('AUTO_SKILL_MODEL_TOOL_REJECTED')

    const extra: ProviderAdapter = {
      complete: async () => ({ reply: '{"accepted":true,"reason":"ok"}' }),
    }
    await expect(makeProviderSkillRecipeJudge({
      provider: extra, providerId: 'judge', model: 'model-b',
    }).judge({
      manifest: {
        schemaVersion: 1, skillIdentity: evidence.skillIdentity,
        scopeKey: evidence.scopeKey, registryRevision: registry.revision,
        revisionHash: 'b'.repeat(64), name: 'auto-test', title: 'Тест',
        description: 'Тест', triggers: ['запомни'], steps: [],
      },
      renderedSkill: 'safe',
    })).rejects.toThrow('AUTO_SKILL_JUDGE_OUTPUT_INVALID')
  })

  it('keeps same provider and model as the same fail-closed identity', () => {
    const provider: ProviderAdapter = { complete: async () => ({ reply: '{}' }) }
    const generator = makeProviderSkillRecipeGenerator({
      provider, providerId: 'same', model: 'same-model',
    })
    const judge = makeProviderSkillRecipeJudge({
      provider, providerId: 'same', model: 'same-model',
    })
    expect(generator.identity).toEqual(judge.identity)
  })
})
