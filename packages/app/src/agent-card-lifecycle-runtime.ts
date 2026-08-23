import {
  AgentCardRegistryError,
  agentCardLifecycleAction,
  parseAgentCard,
  type AgentCard,
  type AgentCardBinding,
  type AgentCardCatalogEntry,
  type AgentCardLifecycleEnvelope,
  type AgentCardLifecyclePlanInput,
  type AgentCardRegistry,
  type AgentCardRevision,
  type AgentCardStatus,
  type AgentCardTarget,
  type ApprovalDecision,
  type PendingAction,
} from '@aisy/core'
import type { AgentCardLegacyImportPort } from './agent-card-legacy-import.js'

const MAX_DRAFT_BYTES = 64 * 1024
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
type Approver = (action: PendingAction) => Promise<ApprovalDecision>

export type AgentCardLifecycleRuntimeErrorCode =
  | 'AGENT_CARD_DRAFT_INVALID'
  | 'AGENT_CARD_NOT_ACTIVE'
  | 'AGENT_CARD_HISTORY_EMPTY'
  | 'AGENT_CARD_HISTORY_EXISTS'
  | 'AGENT_CARD_PROJECT_SCOPE_UNAVAILABLE'
  | 'AGENT_CARD_BINDING_STALE'
  | 'AGENT_CARD_STATE_STALE'
  | 'AGENT_CARD_NAME_MISMATCH'
  | 'AGENT_CARD_LEGACY_UNAVAILABLE'
  | 'AGENT_CARD_APPROVAL_REJECTED'
  | 'AGENT_CARD_APPROVAL_PROOF_INVALID'

export class AgentCardLifecycleRuntimeError extends Error {
  constructor(readonly code: AgentCardLifecycleRuntimeErrorCode) {
    super(code)
    this.name = 'AgentCardLifecycleRuntimeError'
  }
}

export interface AgentCardCatalogView {
  readonly configuredName: string
  readonly cutoverActive: boolean
  readonly currentBinding: AgentCardBinding
  readonly projectScopeAvailable: boolean
  readonly legacyImportAvailable: boolean
  readonly workspace: readonly AgentCardCatalogEntry[]
  readonly project: readonly AgentCardCatalogEntry[]
}

export interface AgentCardLifecycleView {
  readonly target: AgentCardTarget
  readonly active: null | Readonly<{ revision: number; status: 'active'; hashPrefix: string }>
  readonly history: readonly Readonly<{
    revision: number
    status: AgentCardStatus
    hashPrefix: string
  }>[]
}

export interface AgentCardLifecycleRuntime {
  catalog(): AgentCardCatalogView
  detail(target: AgentCardTarget): AgentCardLifecycleView
  createDraft(input: { markdown: string; binding: AgentCardBinding; approve: Approver }): Promise<AgentCardRevision>
  publishDraft(input: { target: AgentCardTarget; markdown: string; approve: Approver }): Promise<AgentCardRevision>
  archive(input: { target: AgentCardTarget; approve: Approver }): Promise<AgentCardRevision>
  rollback(input: { target: AgentCardTarget; approve: Approver }): Promise<AgentCardRevision>
  importLegacy(input: { target: AgentCardTarget; approve: Approver }): Promise<AgentCardRevision>
}

function plainValues(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.keys(descriptors).length !== keys.length) return null
    const allowed = new Set(keys)
    const out: Record<string, unknown> = {}
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!allowed.has(key) || !('value' in descriptor)) return null
      out[key] = descriptor.value
    }
    return out
  } catch {
    return null
  }
}

function bindingSnapshot(value: unknown): AgentCardBinding | null {
  const workspace = plainValues(value, ['scope'])
  if (workspace?.['scope'] === 'workspace') return Object.freeze({ scope: 'workspace' })
  const project = plainValues(value, ['scope', 'projectId'])
  if (project?.['scope'] !== 'project' || typeof project['projectId'] !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(project['projectId'])) return null
  return Object.freeze({ scope: 'project', projectId: project['projectId'] })
}

function targetSnapshot(value: unknown): AgentCardTarget | null {
  const raw = plainValues(value, ['binding', 'name'])
  const binding = raw ? bindingSnapshot(raw['binding']) : null
  if (!raw || !binding || typeof raw['name'] !== 'string' || !NAME.test(raw['name'])) return null
  return Object.freeze({ binding, name: raw['name'] })
}

function bindingKey(binding: AgentCardBinding): string {
  return binding.scope === 'workspace' ? 'workspace' : `project\u0000${binding.projectId}`
}

function parseDraft(markdown: unknown): AgentCard {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown, 'utf8') > MAX_DRAFT_BYTES) {
    throw new AgentCardLifecycleRuntimeError('AGENT_CARD_DRAFT_INVALID')
  }
  try {
    return parseAgentCard(markdown)
  } catch {
    throw new AgentCardLifecycleRuntimeError('AGENT_CARD_DRAFT_INVALID')
  }
}

function translateRegistryError(error: unknown): never {
  if (error instanceof AgentCardRegistryError) {
    if (error.reason === 'history-exists') {
      throw new AgentCardLifecycleRuntimeError('AGENT_CARD_HISTORY_EXISTS')
    }
    if (error.reason === 'history-empty' || error.reason === 'rollback-source-missing') {
      throw new AgentCardLifecycleRuntimeError('AGENT_CARD_HISTORY_EMPTY')
    }
    if (error.reason === 'not-active' || error.reason === 'already-archived') {
      throw new AgentCardLifecycleRuntimeError('AGENT_CARD_NOT_ACTIVE')
    }
    if (error.reason === 'head-mismatch') {
      throw new AgentCardLifecycleRuntimeError('AGENT_CARD_STATE_STALE')
    }
  }
  throw error
}

function lifecycleSummary(envelope: AgentCardLifecycleEnvelope): string {
  const verbs: Record<AgentCardLifecycleEnvelope['operation'], string> = {
    create: 'Создать',
    publish: 'Опубликовать',
    rollback: 'Откатить',
    'import-legacy': 'Импортировать старую',
    archive: 'Архивировать',
  }
  const scope = envelope.target.binding.scope === 'workspace' ? 'Workspace' : 'Project'
  return `${verbs[envelope.operation]} Agent Card ${envelope.target.name}@${envelope.result.revision} ` +
    `в ${scope}, отпечаток ${envelope.result.hash.slice(0, 12)}`
}

export function makeAgentCardLifecycleRuntime(input: {
  registry: AgentCardRegistry
  configuredName: string
  cutoverActive: boolean
  currentBinding: () => AgentCardBinding
  approvedBy: string
  legacy?: AgentCardLegacyImportPort
  nowIso?: () => string
  emit?: (event: string, payload: Readonly<Record<string, unknown>>) => void
}): AgentCardLifecycleRuntime {
  const nowIso = input.nowIso ?? (() => new Date().toISOString())
  const current = (): AgentCardBinding => {
    const binding = bindingSnapshot(input.currentBinding())
    if (!binding) throw new AgentCardLifecycleRuntimeError('AGENT_CARD_PROJECT_SCOPE_UNAVAILABLE')
    return binding
  }

  const checkedBinding = (rawBinding: AgentCardBinding): AgentCardBinding => {
    const binding = bindingSnapshot(rawBinding)
    if (!binding) throw new AgentCardLifecycleRuntimeError('AGENT_CARD_BINDING_STALE')
    if (binding.scope === 'workspace') return binding
    const selected = current()
    if (selected.scope !== 'project' || bindingKey(selected) !== bindingKey(binding)) {
      throw new AgentCardLifecycleRuntimeError('AGENT_CARD_BINDING_STALE')
    }
    return binding
  }

  const checkedTarget = (rawTarget: AgentCardTarget): AgentCardTarget => {
    const target = targetSnapshot(rawTarget)
    if (!target) throw new AgentCardLifecycleRuntimeError('AGENT_CARD_NAME_MISMATCH')
    return Object.freeze({ binding: checkedBinding(target.binding), name: target.name })
  }

  const commit = async (
    planInput: AgentCardLifecyclePlanInput,
    approve: Approver,
  ): Promise<AgentCardRevision> => {
    let envelope: AgentCardLifecycleEnvelope
    try {
      envelope = input.registry.planLifecycle(planInput)
    } catch (error) {
      translateRegistryError(error)
    }
    const exact = agentCardLifecycleAction(envelope)
    const decision = await approve({
      ...exact,
      tier: 3,
      requiresStepUp: true,
      summary: lifecycleSummary(envelope),
    })
    if (decision.decision !== 'confirmed') {
      throw new AgentCardLifecycleRuntimeError('AGENT_CARD_APPROVAL_REJECTED')
    }
    const proof = decision.proof
    if (!proof || proof.stepUpVerified !== true || proof.actionId !== exact.actionId ||
      proof.actionHash !== exact.actionHash) {
      throw new AgentCardLifecycleRuntimeError('AGENT_CARD_APPROVAL_PROOF_INVALID')
    }
    let result: AgentCardRevision
    try {
      result = input.registry.commitLifecycle({
        envelope,
        ...('card' in planInput ? { card: planInput.card } : {}),
        approval: { envelope, approvedBy: input.approvedBy, proof },
      })
    } catch (error) {
      translateRegistryError(error)
    }
    const eventNames: Record<AgentCardLifecycleEnvelope['operation'], string> = {
      create: 'agent_card.created',
      publish: 'agent_card.published',
      rollback: 'agent_card.rolled_back',
      'import-legacy': 'agent_card.legacy_imported',
      archive: 'agent_card.archived',
    }
    try {
      input.emit?.(eventNames[envelope.operation], Object.freeze({
        scope: result.binding.scope,
        ...(result.binding.scope === 'project' ? { projectId: result.binding.projectId } : {}),
        name: result.name,
        revision: result.revision,
        status: result.status,
        hashPrefix: result.hash.slice(0, 12),
        at: nowIso(),
      }))
    } catch {
      // Audit is intentionally non-load-bearing after the durable commit.
    }
    return result
  }

  const exactDetail = (rawTarget: AgentCardTarget): AgentCardLifecycleView => {
    const target = checkedTarget(rawTarget)
    const history = input.registry.history(target.binding, target.name)
    const active = history.find(item => item.status === 'active') ?? null
    return Object.freeze({
      target,
      active: active === null ? null : Object.freeze({
        revision: active.revision,
        status: 'active' as const,
        hashPrefix: active.hash.slice(0, 12),
      }),
      history: Object.freeze(history.map(item => Object.freeze({
        revision: item.revision,
        status: item.status,
        hashPrefix: item.hash.slice(0, 12),
      }))),
    })
  }

  const runtime: AgentCardLifecycleRuntime = {
    catalog() {
      const selected = current()
      return Object.freeze({
        configuredName: input.configuredName,
        cutoverActive: input.cutoverActive,
        currentBinding: selected,
        projectScopeAvailable: selected.scope === 'project',
        legacyImportAvailable: input.legacy !== undefined,
        workspace: input.registry.catalog({ scope: 'workspace' }),
        project: selected.scope === 'project' ? input.registry.catalog(selected) : Object.freeze([]),
      })
    },

    detail: exactDetail,

    async createDraft({ markdown, binding, approve }) {
      const exactBinding = checkedBinding(binding)
      const card = parseDraft(markdown)
      return commit({
        operation: 'create',
        target: { binding: exactBinding, name: card.name },
        card,
      }, approve)
    },

    async publishDraft(request) {
      const target = checkedTarget(request.target)
      const card = parseDraft(request.markdown)
      if (card.name !== target.name) {
        throw new AgentCardLifecycleRuntimeError('AGENT_CARD_NAME_MISMATCH')
      }
      return commit({ operation: 'publish', target, card }, request.approve)
    },

    async archive({ target: rawTarget, approve }) {
      const target = checkedTarget(rawTarget)
      return commit({ operation: 'archive', target }, approve)
    },

    async rollback({ target: rawTarget, approve }) {
      const target = checkedTarget(rawTarget)
      return commit({ operation: 'rollback', target }, approve)
    },

    async importLegacy({ target: rawTarget, approve }) {
      const target = checkedTarget(rawTarget)
      if (!input.legacy) throw new AgentCardLifecycleRuntimeError('AGENT_CARD_LEGACY_UNAVAILABLE')
      const markdown = await input.legacy.readExact(target.name)
      const rechecked = checkedTarget(target)
      const card = parseDraft(markdown)
      if (card.name !== rechecked.name) {
        throw new AgentCardLifecycleRuntimeError('AGENT_CARD_NAME_MISMATCH')
      }
      return commit({ operation: 'import-legacy', target: rechecked, card }, approve)
    },
  }
  return Object.freeze(runtime)
}
