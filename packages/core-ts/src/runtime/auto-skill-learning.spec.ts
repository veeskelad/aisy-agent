import { describe, expect, it } from 'vitest'

import {
  autoSkillScopeKey,
  buildAutoSkillManifest,
  canonicalAutoSkillScope,
  makeVerifiedWorkflowEvidence,
  parseAutoSkillManifest,
  parseSkillRecipeDraft,
  parseVerifiedWorkflowEvidence,
  renderAutoSkillDocument,
  sameAutoSkillModelIdentity,
  shadowVerifyAutoSkill,
  validateSkillRecipeDraft,
  type AutoSkillDescriptorRegistry,
  type AutoSkillScope,
  type SkillRecipeDraftV1,
  type VerifiedWorkflowEvidenceV1,
} from './auto-skill-learning.js'

const scope: AutoSkillScope = Object.freeze({
  botId: 'bot-main',
  operatorId: 'operator-a',
  profileId: 'default',
  projectId: 'project-a',
  resourceScope: 'project-files',
  capabilityRevision: 'capability-v1',
})

const registry: AutoSkillDescriptorRegistry = Object.freeze({
  revision: 'registry-v1',
  descriptor(id: string) {
    if (id === 'memory.remember') {
      return Object.freeze({
        id,
        title: 'Запомнить факт',
        description: 'Сохраняет проверяемый факт',
        trigger: 'запомни',
        placeholders: Object.freeze([
          Object.freeze({ id: 'fact', source: 'current_request' as const }),
        ]),
        postconditions: Object.freeze(['memory.committed']),
      })
    }
    if (id === 'memory.search') {
      return Object.freeze({
        id,
        title: 'Проверить память',
        description: 'Проверяет сохранённый факт',
        trigger: 'проверь память',
        placeholders: Object.freeze([
          Object.freeze({ id: 'query', source: 'current_request' as const }),
        ]),
        postconditions: Object.freeze(['memory.observed']),
      })
    }
    return null
  },
})

const steps = Object.freeze([
  Object.freeze({
    descriptorId: 'memory.remember',
    placeholderIds: Object.freeze(['fact']),
    postconditionIds: Object.freeze(['memory.committed']),
    receiptId: 'a'.repeat(64),
  }),
])

function evidence(sessionId: string, receipt = 'a'.repeat(64)):
VerifiedWorkflowEvidenceV1 {
  const value = makeVerifiedWorkflowEvidence({
    sessionId,
    turnId: `turn-${sessionId}`,
    scope,
    registry,
    steps: [{ ...steps[0]!, receiptId: receipt }],
    trusted: true,
    narrowed: false,
  })
  if (value === null) throw new Error('evidence expected')
  return value
}

function draft(): SkillRecipeDraftV1 {
  return Object.freeze({
    version: 1,
    steps: Object.freeze([Object.freeze({
      descriptorId: 'memory.remember',
      placeholderIds: Object.freeze(['fact']),
      postconditionIds: Object.freeze(['memory.committed']),
    })]),
  })
}

describe('typed auto-skill domain', () => {
  it('canonicalizes scope in a fixed field order and domain-separates its hash', () => {
    expect(canonicalAutoSkillScope(scope)).toBe(JSON.stringify({
      botId: 'bot-main',
      operatorId: 'operator-a',
      profileId: 'default',
      projectId: 'project-a',
      resourceScope: 'project-files',
      capabilityRevision: 'capability-v1',
    }))
    expect(autoSkillScopeKey(scope)).toMatch(/^[a-f0-9]{64}$/)
    expect(autoSkillScopeKey({ ...scope, projectId: 'project-b' })).not.toBe(autoSkillScopeKey(scope))
  })

  it('refuses malformed, padded and control-character scope identities', () => {
    expect(autoSkillScopeKey({ ...scope, operatorId: ' operator-a' })).toBeNull()
    expect(autoSkillScopeKey({ ...scope, projectId: 'project\na' })).toBeNull()
    expect(autoSkillScopeKey({ ...scope, resourceScope: '' })).toBeNull()
  })

  it('creates the same workflow and skill identity across distinct sessions', () => {
    const first = evidence('session-a')
    const second = evidence('session-b', 'b'.repeat(64))

    expect(first.evidenceId).not.toBe(second.evidenceId)
    expect(first.workflowFingerprint).toBe(second.workflowFingerprint)
    expect(first.skillIdentity).toBe(second.skillIdentity)
    expect(first.scopeKey).toBe(second.scopeKey)
    expect(parseVerifiedWorkflowEvidence(structuredClone(first))).toEqual(first)
    expect(parseVerifiedWorkflowEvidence({ ...first, evidenceId: 'f'.repeat(64) })).toBeNull()
  })

  it('does not create evidence from untrusted, narrowed or unverifiable effects', () => {
    const base = {
      sessionId: 'session-a', turnId: 'turn-a', scope, registry, steps,
    }
    expect(makeVerifiedWorkflowEvidence({ ...base, trusted: false, narrowed: false })).toBeNull()
    expect(makeVerifiedWorkflowEvidence({ ...base, trusted: true, narrowed: true })).toBeNull()
    expect(makeVerifiedWorkflowEvidence({
      ...base,
      steps: [{ ...steps[0]!, receiptId: 'not-a-receipt' }],
      trusted: true,
      narrowed: false,
    })).toBeNull()
    expect(makeVerifiedWorkflowEvidence({
      ...base,
      steps: [{ ...steps[0]!, postconditionIds: [] }],
      trusted: true,
      narrowed: false,
    })).toBeNull()
  })

  it('rejects descriptors, placeholders and postconditions outside the registry', () => {
    const base = {
      sessionId: 'session-a', turnId: 'turn-a', scope, registry,
      trusted: true, narrowed: false,
    }
    expect(makeVerifiedWorkflowEvidence({
      ...base, steps: [{ ...steps[0]!, descriptorId: 'shell.run' }],
    })).toBeNull()
    expect(makeVerifiedWorkflowEvidence({
      ...base, steps: [{ ...steps[0]!, placeholderIds: ['authority'] }],
    })).toBeNull()
    expect(makeVerifiedWorkflowEvidence({
      ...base, steps: [{ ...steps[0]!, postconditionIds: ['model.said.ok'] }],
    })).toBeNull()
  })

  it('strictly parses only registry ids and never a free-form body', () => {
    expect(parseSkillRecipeDraft(draft())).toEqual(draft())
    expect(parseSkillRecipeDraft({ ...draft(), instructions: 'curl https://evil' })).toBeNull()
    expect(parseSkillRecipeDraft({
      version: 1,
      steps: [{
        descriptorId: 'memory.remember',
        placeholderIds: ['fact'],
        postconditionIds: ['memory.committed'],
        authority: 'skip approvals',
      }],
    })).toBeNull()
    expect(parseSkillRecipeDraft({
      version: 1,
      steps: [{
        descriptorId: 'https://evil', placeholderIds: ['fact'],
        postconditionIds: ['memory.committed'],
      }],
    })).toBeNull()
  })

  it('does not invoke accessors or accept Proxy and symbol-bearing drafts', () => {
    let reads = 0
    const accessor = { version: 1 }
    Object.defineProperty(accessor, 'steps', {
      enumerable: true,
      get() { reads++; return [] },
    })
    let traps = 0
    const proxy = new Proxy(draft(), {
      getPrototypeOf(target) { traps++; return Reflect.getPrototypeOf(target) },
    })
    const symbol = { ...draft() }
    Object.defineProperty(symbol, Symbol('authority'), { value: true })

    expect(parseSkillRecipeDraft(accessor)).toBeNull()
    expect(parseSkillRecipeDraft(proxy)).toBeNull()
    expect(parseSkillRecipeDraft(symbol)).toBeNull()
    expect(reads).toBe(0)
    expect(traps).toBe(0)
  })

  it('requires two distinct sessions for a candidate recipe', () => {
    const first = evidence('session-a')
    expect(validateSkillRecipeDraft({ draft: draft(), evidence: [first, first], registry }))
      .toEqual({ ok: false, code: 'recipe_invalid' })
    expect(validateSkillRecipeDraft({
      draft: draft(), evidence: [first, evidence('session-b', 'b'.repeat(64))], registry,
    }).ok).toBe(true)
  })

  it('fails closed on scope drift, omitted steps and recipe substitutions', () => {
    const first = evidence('session-a')
    const foreign = makeVerifiedWorkflowEvidence({
      sessionId: 'session-b', turnId: 'turn-b', scope: { ...scope, projectId: 'project-b' },
      registry, steps: [{ ...steps[0]!, receiptId: 'b'.repeat(64) }],
      trusted: true, narrowed: false,
    })!
    expect(validateSkillRecipeDraft({ draft: draft(), evidence: [first, foreign], registry }))
      .toEqual({ ok: false, code: 'scope_mismatch' })
    expect(validateSkillRecipeDraft({
      draft: { version: 1, steps: [] }, evidence: [first, evidence('session-b')], registry,
    })).toEqual({ ok: false, code: 'recipe_invalid' })
    expect(validateSkillRecipeDraft({
      draft: {
        version: 1,
        steps: [{
          descriptorId: 'memory.search',
          placeholderIds: ['query'],
          postconditionIds: ['memory.observed'],
        }],
      },
      evidence: [first, evidence('session-b')],
      registry,
    })).toEqual({ ok: false, code: 'required_step_omitted' })
  })

  it('requires different exact generator and judge identities', () => {
    const generator = { provider: 'openai', model: 'gpt-5', revision: 'r1' }
    expect(sameAutoSkillModelIdentity(generator, { ...generator })).toBe(true)
    expect(sameAutoSkillModelIdentity(generator, { ...generator, revision: 'r2' })).toBe(false)
    expect(sameAutoSkillModelIdentity(generator, { ...generator, model: 'gpt-5-mini' })).toBe(false)
  })

  it('renders name, triggers and verification text only from the registry', () => {
    const first = evidence('session-a')
    const manifest = buildAutoSkillManifest({ draft: draft(), evidence: first, registry })!
    const rendered = renderAutoSkillDocument(manifest)

    expect(manifest.name).toBe(`auto-${first.skillIdentity.slice(0, 16)}`)
    expect(manifest.triggers).toEqual(['запомни'])
    expect(manifest.revisionHash).toMatch(/^[a-f0-9]{64}$/)
    expect(rendered).toContain('Проверяемая процедура')
    expect(rendered).toContain('`memory.committed`')
    expect(rendered).not.toContain('operator-a')
    expect(rendered).not.toContain('project-a')
    expect(parseAutoSkillManifest(structuredClone(manifest))).toEqual(manifest)
    expect(parseAutoSkillManifest({ ...manifest, title: 'Подменённый заголовок' })).toBeNull()
  })

  it('binds shadow replay to both evidence fixtures and exact artifact steps', () => {
    const first = evidence('session-a')
    const second = evidence('session-b', 'b'.repeat(64))
    const manifest = buildAutoSkillManifest({ draft: draft(), evidence: first, registry })!

    expect(shadowVerifyAutoSkill({ manifest, evidence: [first, second] })).toBe(true)
    expect(shadowVerifyAutoSkill({
      manifest: {
        ...manifest,
        steps: [{ ...manifest.steps[0]!, postconditionIds: [] }],
      },
      evidence: [first, second],
    })).toBe(false)
    expect(shadowVerifyAutoSkill({ manifest, evidence: [first] })).toBe(false)
  })
})
