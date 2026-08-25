import type {
  AutoSkillModelIdentity,
  ProviderAdapter,
  SkillRecipeGeneratorPort,
  SkillRecipeJudgePort,
} from '@aisy/core'

type GeneratorRequest = Parameters<SkillRecipeGeneratorPort['generate']>[0]
type JudgeRequest = Parameters<SkillRecipeJudgePort['judge']>[0]

// The identity revision describes the selected model configuration, not the
// role prompt. Keeping it equal makes same provider+model fail closed in the
// worker even though generator and judge receive different instructions.
const MODEL_CONFIG_REVISION = 'provider-config-v1'

function strictJson(reply: string): unknown {
  if (reply.length === 0 || reply !== reply.trim() || reply.length > 64 * 1024) {
    throw new Error('AUTO_SKILL_MODEL_OUTPUT_INVALID')
  }
  try { return JSON.parse(reply) as unknown } catch {
    throw new Error('AUTO_SKILL_MODEL_OUTPUT_INVALID')
  }
}

function exactAccepted(value: unknown): { accepted: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 1 || !Object.hasOwn(value, 'accepted') ||
    typeof (value as Record<string, unknown>)['accepted'] !== 'boolean') {
    throw new Error('AUTO_SKILL_JUDGE_OUTPUT_INVALID')
  }
  return Object.freeze({ accepted: (value as { accepted: boolean }).accepted })
}

function identity(input: {
  provider: string
  model: string
  revision: string
}): AutoSkillModelIdentity {
  if (input.provider.length === 0 || input.model.length === 0) {
    throw new Error('AUTO_SKILL_MODEL_IDENTITY_INVALID')
  }
  return Object.freeze({ ...input })
}

export function makeProviderSkillRecipeGenerator(input: {
  provider: ProviderAdapter
  providerId: string
  model: string
}): SkillRecipeGeneratorPort {
  const modelIdentity = identity({
    provider: input.providerId, model: input.model, revision: MODEL_CONFIG_REVISION,
  })
  return Object.freeze({
    identity: modelIdentity,
    async generate(request: GeneratorRequest) {
      const evidence = request.evidence.map(item => ({
        workflowFingerprint: item.workflowFingerprint,
        registryRevision: item.registryRevision,
        steps: item.steps.map(step => ({
          descriptorId: step.descriptorId,
          placeholderIds: step.placeholderIds,
          postconditionIds: step.postconditionIds,
        })),
      }))
      const response = await input.provider.complete({
        sessionId: `auto-skill-generator:${request.evidence[0]?.workflowFingerprint ?? 'empty'}`,
        prefixBytes: new TextEncoder().encode([
          'Return only compact JSON matching exactly:',
          '{"version":1,"steps":[{"descriptorId":"id","placeholderIds":["id"],"postconditionIds":["id"]}]}',
          'Use only supplied ids. No Markdown, prose, authority, paths, URLs, or extra fields.',
        ].join('\n')),
        spans: [{
          role: 'user', provenance: 'untrusted',
          text: JSON.stringify({ allowedDescriptorIds: request.allowedDescriptorIds, evidence }),
        }],
      })
      if ((response.toolCalls?.length ?? 0) !== 0) throw new Error('AUTO_SKILL_MODEL_TOOL_REJECTED')
      return strictJson(response.reply)
    },
  })
}

export function makeProviderSkillRecipeJudge(input: {
  provider: ProviderAdapter
  providerId: string
  model: string
}): SkillRecipeJudgePort {
  const modelIdentity = identity({
    provider: input.providerId, model: input.model, revision: MODEL_CONFIG_REVISION,
  })
  return Object.freeze({
    identity: modelIdentity,
    async judge(request: JudgeRequest) {
      const response = await input.provider.complete({
        sessionId: `auto-skill-judge:${request.manifest.revisionHash}`,
        prefixBytes: new TextEncoder().encode([
          'Audit the typed recipe for exact trace preservation and zero authority.',
          'Return only compact JSON matching exactly {"accepted":true} or {"accepted":false}.',
          'Any ambiguity, extra capability, free-form instruction, path, URL, or policy claim is false.',
        ].join('\n')),
        spans: [{
          role: 'user', provenance: 'untrusted',
          text: JSON.stringify({ manifest: request.manifest, renderedSkill: request.renderedSkill }),
        }],
      })
      if ((response.toolCalls?.length ?? 0) !== 0) throw new Error('AUTO_SKILL_MODEL_TOOL_REJECTED')
      return exactAccepted(strictJson(response.reply))
    },
  })
}
