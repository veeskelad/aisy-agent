import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'

const ID = /^[a-z][a-z0-9._-]{0,95}$/u
const HASH = /^[a-f0-9]{64}$/u
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,512}$/u
const MAX_STEPS = 16

export interface AutoSkillScope {
  readonly botId: string | null
  readonly operatorId: string
  readonly profileId: string
  readonly projectId: string
  readonly resourceScope: string
  readonly capabilityRevision: string
}

export interface AutoSkillPlaceholderDescriptor {
  readonly id: string
  readonly source: 'current_request' | 'verified_scope_metadata'
}

export interface AutoSkillDescriptor {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly trigger: string
  readonly placeholders: readonly AutoSkillPlaceholderDescriptor[]
  readonly postconditions: readonly string[]
}

export interface AutoSkillDescriptorRegistry {
  readonly revision: string
  descriptor(id: string): AutoSkillDescriptor | null
}

export interface VerifiedWorkflowStepV1 {
  readonly descriptorId: string
  readonly placeholderIds: readonly string[]
  readonly postconditionIds: readonly string[]
  readonly receiptId: string
}

export interface VerifiedWorkflowEvidenceV1 {
  readonly schemaVersion: 1
  readonly evidenceId: string
  readonly sessionId: string
  readonly turnId: string
  readonly scope: AutoSkillScope
  readonly scopeKey: string
  readonly workflowFingerprint: string
  readonly skillIdentity: string
  readonly registryRevision: string
  readonly steps: readonly VerifiedWorkflowStepV1[]
  readonly trusted: true
  readonly narrowed: false
}

export interface SkillRecipeStepV1 {
  readonly descriptorId: string
  readonly placeholderIds: readonly string[]
  readonly postconditionIds: readonly string[]
}

export interface SkillRecipeDraftV1 {
  readonly version: 1
  readonly steps: readonly SkillRecipeStepV1[]
}

export interface AutoSkillManifestV1 {
  readonly schemaVersion: 1
  readonly skillIdentity: string
  readonly scopeKey: string
  readonly registryRevision: string
  readonly revisionHash: string
  readonly name: string
  readonly title: string
  readonly description: string
  readonly triggers: readonly string[]
  readonly steps: readonly SkillRecipeStepV1[]
}

export interface AutoSkillModelIdentity {
  readonly provider: string
  readonly model: string
  readonly revision: string
}

export interface SkillRecipeGeneratorPort {
  readonly identity: AutoSkillModelIdentity
  generate(input: Readonly<{
    evidence: readonly VerifiedWorkflowEvidenceV1[]
    allowedDescriptorIds: readonly string[]
  }>): Promise<unknown>
}

export interface SkillRecipeJudgePort {
  readonly identity: AutoSkillModelIdentity
  judge(input: Readonly<{
    manifest: AutoSkillManifestV1
    renderedSkill: string
  }>): Promise<{ accepted: boolean }>
}

export type AutoSkillValidationCode =
  | 'recipe_invalid'
  | 'descriptor_missing'
  | 'placeholder_missing'
  | 'postcondition_mismatch'
  | 'required_step_omitted'
  | 'scope_mismatch'

export type AutoSkillValidationResult =
  | { readonly ok: true; readonly draft: SkillRecipeDraftV1 }
  | { readonly ok: false; readonly code: AutoSkillValidationCode }

function hash(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}\n${value}`).digest('hex')
}

function safeIdentity(value: string | null): boolean {
  return value === null || (value.length <= 512 && value === value.trim() && SAFE_TEXT.test(value))
}

function exactDataObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) return null
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
  const actual = Object.keys(descriptors)
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))) return null
  for (const key of actual) {
    const descriptor = descriptors[key]!
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
      descriptor.set !== undefined || descriptor.enumerable !== true) return null
  }
  return Object.fromEntries(actual.map(key => [key, descriptors[key]!.value]))
}

function exactStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_STEPS ||
    Object.getOwnPropertySymbols(value).length !== 0) return null
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
  const allowed = new Set([...value.keys()].map(String).concat('length'))
  if (Object.keys(descriptors).some(key => !allowed.has(key))) return null
  const out: string[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined || descriptor.set !== undefined ||
      typeof descriptor.value !== 'string' || !ID.test(descriptor.value)) return null
    out.push(descriptor.value)
  }
  return Object.freeze(out)
}

function exactUnknownArray(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value) || utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype || value.length === 0 ||
    value.length > MAX_STEPS || Object.getOwnPropertySymbols(value).length !== 0) return null
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
  const allowed = new Set([...value.keys()].map(String).concat('length'))
  if (Object.keys(descriptors).some(key => !allowed.has(key))) return null
  const out: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined || descriptor.set !== undefined) return null
    out.push(descriptor.value)
  }
  return Object.freeze(out)
}

function exactSafeTextArray(value: unknown): readonly string[] | null {
  const raw = exactUnknownArray(value)
  if (raw === null || raw.some(item => typeof item !== 'string' ||
    !SAFE_TEXT.test(item) || item !== item.trim())) return null
  return Object.freeze(raw as string[])
}

export function canonicalAutoSkillScope(scope: AutoSkillScope): string | null {
  if (!safeIdentity(scope.botId) || !safeIdentity(scope.operatorId) ||
    !safeIdentity(scope.profileId) || !safeIdentity(scope.projectId) ||
    !safeIdentity(scope.resourceScope) || !safeIdentity(scope.capabilityRevision) ||
    scope.operatorId === '' || scope.profileId === '' || scope.projectId === '' ||
    scope.resourceScope === '' || scope.capabilityRevision === '') return null
  return JSON.stringify({
    botId: scope.botId,
    operatorId: scope.operatorId,
    profileId: scope.profileId,
    projectId: scope.projectId,
    resourceScope: scope.resourceScope,
    capabilityRevision: scope.capabilityRevision,
  })
}

export function autoSkillScopeKey(scope: AutoSkillScope): string | null {
  const canonical = canonicalAutoSkillScope(scope)
  return canonical === null ? null : hash('aisy-auto-skill-scope/v1', canonical)
}

function canonicalSteps(steps: readonly VerifiedWorkflowStepV1[]): string {
  return JSON.stringify(steps.map(step => ({
    descriptorId: step.descriptorId,
    placeholderIds: [...step.placeholderIds],
    postconditionIds: [...step.postconditionIds],
  })))
}

function validStep(step: VerifiedWorkflowStepV1, registry: AutoSkillDescriptorRegistry): boolean {
  if (!ID.test(step.descriptorId) || !HASH.test(step.receiptId) ||
    step.placeholderIds.length > MAX_STEPS || step.postconditionIds.length > MAX_STEPS ||
    new Set(step.placeholderIds).size !== step.placeholderIds.length ||
    new Set(step.postconditionIds).size !== step.postconditionIds.length ||
    step.placeholderIds.some(id => !ID.test(id)) ||
    step.postconditionIds.some(id => !ID.test(id))) return false
  const descriptor = registry.descriptor(step.descriptorId)
  if (descriptor === null) return false
  const placeholders = new Set(descriptor.placeholders.map(item => item.id))
  const postconditions = new Set(descriptor.postconditions)
  return step.placeholderIds.every(id => placeholders.has(id)) &&
    step.postconditionIds.length > 0 &&
    step.postconditionIds.every(id => postconditions.has(id))
}

export function makeVerifiedWorkflowEvidence(input: Readonly<{
  sessionId: string
  turnId: string
  scope: AutoSkillScope
  registry: AutoSkillDescriptorRegistry
  steps: readonly VerifiedWorkflowStepV1[]
  trusted: boolean
  narrowed: boolean
}>): VerifiedWorkflowEvidenceV1 | null {
  if (!input.trusted || input.narrowed || !safeIdentity(input.sessionId) ||
    !safeIdentity(input.turnId) || input.sessionId.length === 0 || input.turnId.length === 0 ||
    !ID.test(input.registry.revision) || input.steps.length === 0 ||
    input.steps.length > MAX_STEPS || input.steps.some(step => !validStep(step, input.registry))) {
    return null
  }
  const scopeKey = autoSkillScopeKey(input.scope)
  if (scopeKey === null) return null
  const steps = Object.freeze(input.steps.map(step => Object.freeze({
    descriptorId: step.descriptorId,
    placeholderIds: Object.freeze([...step.placeholderIds]),
    postconditionIds: Object.freeze([...step.postconditionIds]),
    receiptId: step.receiptId,
  })))
  const canonical = canonicalSteps(steps)
  const workflowFingerprint = hash(
    'aisy-auto-skill-workflow/v1',
    JSON.stringify([scopeKey, input.registry.revision, canonical]),
  )
  const skillIdentity = hash(
    'aisy-auto-skill-identity/v2',
    // Stable procedure identity: registry revision, placeholder slots and
    // postconditions belong to the revision fingerprint. Keeping them out of
    // this key lets a verified v2 candidate retain a durable previous pointer
    // and roll back to v1 instead of appearing as an unrelated skill.
    JSON.stringify([scopeKey, steps.map(step => step.descriptorId)]),
  )
  const evidenceId = hash(
    'aisy-auto-skill-evidence/v1',
    JSON.stringify([input.sessionId, input.turnId, scopeKey, workflowFingerprint,
      steps.map(step => step.receiptId)]),
  )
  return Object.freeze({
    schemaVersion: 1,
    evidenceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    scope: Object.freeze({ ...input.scope }),
    scopeKey,
    workflowFingerprint,
    skillIdentity,
    registryRevision: input.registry.revision,
    steps,
    trusted: true,
    narrowed: false,
  })
}

export function parseVerifiedWorkflowEvidence(value: unknown): VerifiedWorkflowEvidenceV1 | null {
  const root = exactDataObject(value, [
    'schemaVersion', 'evidenceId', 'sessionId', 'turnId', 'scope', 'scopeKey',
    'workflowFingerprint', 'skillIdentity', 'registryRevision', 'steps',
    'trusted', 'narrowed',
  ])
  if (root === null || root['schemaVersion'] !== 1 || root['trusted'] !== true ||
    root['narrowed'] !== false || typeof root['sessionId'] !== 'string' ||
    typeof root['turnId'] !== 'string' || !safeIdentity(root['sessionId']) ||
    !safeIdentity(root['turnId']) || root['sessionId'].length === 0 ||
    root['turnId'].length === 0 || typeof root['registryRevision'] !== 'string' ||
    !ID.test(root['registryRevision']) || typeof root['evidenceId'] !== 'string' ||
    !HASH.test(root['evidenceId']) || typeof root['scopeKey'] !== 'string' ||
    !HASH.test(root['scopeKey']) || typeof root['workflowFingerprint'] !== 'string' ||
    !HASH.test(root['workflowFingerprint']) || typeof root['skillIdentity'] !== 'string' ||
    !HASH.test(root['skillIdentity'])) return null
  const rawScope = exactDataObject(root['scope'], [
    'botId', 'operatorId', 'profileId', 'projectId', 'resourceScope', 'capabilityRevision',
  ])
  if (rawScope === null || (rawScope['botId'] !== null && typeof rawScope['botId'] !== 'string') ||
    typeof rawScope['operatorId'] !== 'string' || typeof rawScope['profileId'] !== 'string' ||
    typeof rawScope['projectId'] !== 'string' || typeof rawScope['resourceScope'] !== 'string' ||
    typeof rawScope['capabilityRevision'] !== 'string') return null
  const scope: AutoSkillScope = Object.freeze({
    botId: rawScope['botId'] as string | null,
    operatorId: rawScope['operatorId'],
    profileId: rawScope['profileId'],
    projectId: rawScope['projectId'],
    resourceScope: rawScope['resourceScope'],
    capabilityRevision: rawScope['capabilityRevision'],
  })
  if (autoSkillScopeKey(scope) !== root['scopeKey']) return null
  const rawSteps = exactUnknownArray(root['steps'])
  if (rawSteps === null) return null
  const steps: VerifiedWorkflowStepV1[] = []
  for (const rawStep of rawSteps) {
    const step = exactDataObject(rawStep, [
      'descriptorId', 'placeholderIds', 'postconditionIds', 'receiptId',
    ])
    if (step === null || typeof step['descriptorId'] !== 'string' ||
      !ID.test(step['descriptorId']) || typeof step['receiptId'] !== 'string' ||
      !HASH.test(step['receiptId'])) return null
    const placeholderIds = exactStringArray(step['placeholderIds'])
    const postconditionIds = exactStringArray(step['postconditionIds'])
    if (placeholderIds === null || postconditionIds === null || postconditionIds.length === 0 ||
      new Set(placeholderIds).size !== placeholderIds.length ||
      new Set(postconditionIds).size !== postconditionIds.length) return null
    steps.push(Object.freeze({
      descriptorId: step['descriptorId'], placeholderIds, postconditionIds,
      receiptId: step['receiptId'],
    }))
  }
  const frozenSteps = Object.freeze(steps)
  const canonical = canonicalSteps(frozenSteps)
  const workflowFingerprint = hash(
    'aisy-auto-skill-workflow/v1',
    JSON.stringify([root['scopeKey'], root['registryRevision'], canonical]),
  )
  const skillIdentity = hash(
    'aisy-auto-skill-identity/v2',
    JSON.stringify([root['scopeKey'], frozenSteps.map(step => step.descriptorId)]),
  )
  const evidenceId = hash(
    'aisy-auto-skill-evidence/v1',
    JSON.stringify([root['sessionId'], root['turnId'], root['scopeKey'], workflowFingerprint,
      frozenSteps.map(step => step.receiptId)]),
  )
  if (root['workflowFingerprint'] !== workflowFingerprint ||
    root['skillIdentity'] !== skillIdentity || root['evidenceId'] !== evidenceId) return null
  return Object.freeze({
    schemaVersion: 1,
    evidenceId,
    sessionId: root['sessionId'],
    turnId: root['turnId'],
    scope,
    scopeKey: root['scopeKey'],
    workflowFingerprint,
    skillIdentity,
    registryRevision: root['registryRevision'],
    steps: frozenSteps,
    trusted: true,
    narrowed: false,
  })
}

export function parseSkillRecipeDraft(value: unknown): SkillRecipeDraftV1 | null {
  const root = exactDataObject(value, ['version', 'steps'])
  if (root === null || root['version'] !== 1) return null
  const rawSteps = exactUnknownArray(root['steps'])
  if (rawSteps === null) return null
  const steps: SkillRecipeStepV1[] = []
  for (const raw of rawSteps) {
    const step = exactDataObject(raw, ['descriptorId', 'placeholderIds', 'postconditionIds'])
    if (step === null || typeof step['descriptorId'] !== 'string' ||
      !ID.test(step['descriptorId'])) return null
    const placeholderIds = exactStringArray(step['placeholderIds'])
    const postconditionIds = exactStringArray(step['postconditionIds'])
    if (placeholderIds === null || postconditionIds === null) return null
    steps.push(Object.freeze({ descriptorId: step['descriptorId'], placeholderIds, postconditionIds }))
  }
  return Object.freeze({ version: 1, steps: Object.freeze(steps) })
}

export function validateSkillRecipeDraft(input: Readonly<{
  draft: unknown
  evidence: readonly VerifiedWorkflowEvidenceV1[]
  registry: AutoSkillDescriptorRegistry
}>): AutoSkillValidationResult {
  const draft = parseSkillRecipeDraft(input.draft)
  if (draft === null || input.evidence.length < 2) return { ok: false, code: 'recipe_invalid' }
  const first = input.evidence[0]!
  if (input.evidence.some(item => item.scopeKey !== first.scopeKey ||
    item.skillIdentity !== first.skillIdentity || item.workflowFingerprint !== first.workflowFingerprint)) {
    return { ok: false, code: 'scope_mismatch' }
  }
  if (new Set(input.evidence.map(item => item.sessionId)).size < 2) {
    return { ok: false, code: 'recipe_invalid' }
  }
  if (draft.steps.length !== first.steps.length) {
    return { ok: false, code: 'required_step_omitted' }
  }
  for (let index = 0; index < draft.steps.length; index++) {
    const candidate = draft.steps[index]!
    const expected = first.steps[index]!
    const descriptor = input.registry.descriptor(candidate.descriptorId)
    if (descriptor === null) return { ok: false, code: 'descriptor_missing' }
    if (candidate.descriptorId !== expected.descriptorId) {
      return { ok: false, code: 'required_step_omitted' }
    }
    if (JSON.stringify(candidate.placeholderIds) !== JSON.stringify(expected.placeholderIds)) {
      return { ok: false, code: 'placeholder_missing' }
    }
    if (JSON.stringify(candidate.postconditionIds) !== JSON.stringify(expected.postconditionIds)) {
      return { ok: false, code: 'postcondition_mismatch' }
    }
    const allowedPlaceholders = new Set(descriptor.placeholders.map(item => item.id))
    if (candidate.placeholderIds.some(id => !allowedPlaceholders.has(id))) {
      return { ok: false, code: 'placeholder_missing' }
    }
    const allowedPostconditions = new Set(descriptor.postconditions)
    if (candidate.postconditionIds.some(id => !allowedPostconditions.has(id))) {
      return { ok: false, code: 'postcondition_mismatch' }
    }
  }
  return { ok: true, draft }
}

export function sameAutoSkillModelIdentity(
  left: AutoSkillModelIdentity,
  right: AutoSkillModelIdentity,
): boolean {
  return left.provider === right.provider && left.model === right.model &&
    left.revision === right.revision
}

export function buildAutoSkillManifest(input: Readonly<{
  draft: SkillRecipeDraftV1
  evidence: VerifiedWorkflowEvidenceV1
  registry: AutoSkillDescriptorRegistry
}>): AutoSkillManifestV1 | null {
  const descriptors = input.draft.steps.map(step => input.registry.descriptor(step.descriptorId))
  if (descriptors.some(item => item === null)) return null
  const known = descriptors as AutoSkillDescriptor[]
  const base = {
    schemaVersion: 1 as const,
    skillIdentity: input.evidence.skillIdentity,
    scopeKey: input.evidence.scopeKey,
    registryRevision: input.registry.revision,
    name: `auto-${input.evidence.skillIdentity.slice(0, 16)}`,
    title: known.map(item => item.title).join(' → '),
    description: known.map(item => item.description).join('; '),
    triggers: Object.freeze([...new Set(known.map(item => item.trigger))].sort()),
    steps: input.draft.steps,
  }
  const revisionHash = hash('aisy-auto-skill-revision/v1', JSON.stringify(base))
  return Object.freeze({ ...base, revisionHash })
}

export function parseAutoSkillManifest(value: unknown): AutoSkillManifestV1 | null {
  const root = exactDataObject(value, [
    'schemaVersion', 'skillIdentity', 'scopeKey', 'registryRevision', 'revisionHash',
    'name', 'title', 'description', 'triggers', 'steps',
  ])
  if (root === null || root['schemaVersion'] !== 1 ||
    typeof root['skillIdentity'] !== 'string' || !HASH.test(root['skillIdentity']) ||
    typeof root['scopeKey'] !== 'string' || !HASH.test(root['scopeKey']) ||
    typeof root['registryRevision'] !== 'string' || !ID.test(root['registryRevision']) ||
    typeof root['revisionHash'] !== 'string' || !HASH.test(root['revisionHash']) ||
    typeof root['name'] !== 'string' || !ID.test(root['name']) ||
    typeof root['title'] !== 'string' || !SAFE_TEXT.test(root['title']) ||
    typeof root['description'] !== 'string' || !SAFE_TEXT.test(root['description'])) return null
  const triggers = exactSafeTextArray(root['triggers'])
  const parsedDraft = parseSkillRecipeDraft({ version: 1, steps: root['steps'] })
  if (triggers === null || triggers.length === 0 || parsedDraft === null) return null
  const base = {
    schemaVersion: 1 as const,
    skillIdentity: root['skillIdentity'],
    scopeKey: root['scopeKey'],
    registryRevision: root['registryRevision'],
    name: root['name'],
    title: root['title'],
    description: root['description'],
    triggers,
    steps: parsedDraft.steps,
  }
  const revisionHash = hash('aisy-auto-skill-revision/v1', JSON.stringify(base))
  return root['revisionHash'] === revisionHash
    ? Object.freeze({ ...base, revisionHash })
    : null
}

export function renderAutoSkillDocument(manifest: AutoSkillManifestV1): string {
  const lines = [
    '---',
    `name: ${manifest.name}`,
    `description: ${manifest.description}`,
    '---',
    '',
    `# ${manifest.title}`,
    '',
    'Проверяемая процедура; разрешения определяются runtime для каждого вызова.',
    '',
  ]
  manifest.steps.forEach((step, index) => {
    lines.push(`${index + 1}. Выполнить descriptor \`${step.descriptorId}\`.`)
    lines.push(`   Проверка: ${step.postconditionIds.map(id => `\`${id}\``).join(', ')}.`)
  })
  return `${lines.join('\n')}\n`
}

export function shadowVerifyAutoSkill(input: Readonly<{
  manifest: AutoSkillManifestV1
  evidence: readonly VerifiedWorkflowEvidenceV1[]
}>): boolean {
  if (input.evidence.length < 2) return false
  const planned = JSON.stringify(input.manifest.steps)
  return input.evidence.slice(0, 2).every(item => item.skillIdentity === input.manifest.skillIdentity &&
    item.scopeKey === input.manifest.scopeKey &&
    JSON.stringify(item.steps.map(step => ({
      descriptorId: step.descriptorId,
      placeholderIds: step.placeholderIds,
      postconditionIds: step.postconditionIds,
    }))) === planned)
}
