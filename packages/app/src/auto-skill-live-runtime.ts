import {
  autoSkillScopeKey,
  makeMemoryRememberReceipt,
  makeVerifiedWorkflowEvidence,
  parseMemoryRememberReceipt,
  parseRememberFactArgs,
  renderMemoryAcknowledgement,
  type AutoSkillDescriptorRegistry,
  type AutoSkillScope,
  type ContextSpan,
  type ModelRequest,
  type ModelProgressSink,
  type ModelResponse,
  type ProviderAdapter,
  type ToolCall,
  type ToolExecutionContext,
  type VerifiedWorkflowObserver,
  type VerifiedWorkflowStepObservation,
} from '@aisy/core'

import type { NodeAutoSkillStoreV2 } from './auto-skill-store.js'
import type { AutoSkillWorkerResult } from './auto-skill-worker.js'

export const MEMORY_AUTO_SKILL_REGISTRY: AutoSkillDescriptorRegistry = Object.freeze({
  revision: 'memory-receipt-v1',
  descriptor(id: string) {
    return id === 'memory.remember'
      ? Object.freeze({
          id,
          title: 'Запоминание факта',
          description: 'Запоминает факт по явной просьбе оператора',
          trigger: 'запомни',
          placeholders: Object.freeze([
            Object.freeze({ id: 'fact', source: 'current_request' as const }),
          ]),
          postconditions: Object.freeze(['memory.committed']),
        })
      : null
  },
})

export interface AutoSkillLiveRuntime {
  readonly observer: VerifiedWorkflowObserver
  confirmReply(input: { evidenceId: string; sessionId: string; turnId: string }): void
  claimSource(input: { sessionId?: string; projectId?: string }): void
  completeSourceForget(input: { sessionId?: string; projectId?: string }): void
  plan(request: Pick<ModelRequest, 'sessionId' | 'turnId' | 'toolOrdinalBase' | 'spans'>): Readonly<{
    revisionHash: string
    calls: readonly ToolCall[]
  }> | null
  observeInvocation(call: ToolCall, context: ToolExecutionContext, result: unknown): void
  lateContext(spans: readonly ContextSpan[]): readonly ContextSpan[]
  recoverStartup(): number
  drainAfterReply(): Promise<void>
  doctor(): ReturnType<NodeAutoSkillStoreV2['doctor']>
}

/** Feature-gate helper kept pure so canary-off can prove zero factory/store I/O. */
export function selectAutoSkillCanary<T>(enabled: boolean, create: () => T): T | null {
  return enabled ? create() : null
}

/**
 * Puts a typed manifest, not rendered Markdown, on the execution path. The
 * first round can be satisfied by a code-owned exact plan; synthesis and every
 * non-matching request continue through the configured provider.
 */
export function makeAutoSkillPlanningProvider(input: {
  provider: ProviderAdapter
  runtime: Pick<AutoSkillLiveRuntime, 'plan'>
}): ProviderAdapter {
  return Object.freeze({
    async complete(
      request: ModelRequest,
      signal?: AbortSignal,
      onProgress?: ModelProgressSink,
    ): Promise<ModelResponse> {
      const plan = input.runtime.plan(request)
      if (plan === null) return input.provider.complete(request, signal, onProgress)
      return Object.freeze({
        reply: '',
        toolCalls: plan.calls.map(call => ({ ...call, args: { ...call.args } })),
      })
    },
  })
}

export function makeAutoSkillLiveRuntime(input: {
  store: NodeAutoSkillStoreV2
  scope: AutoSkillScope
  registry?: AutoSkillDescriptorRegistry
  worker: { drainOne(): Promise<AutoSkillWorkerResult> }
  notify(text: string): Promise<void>
  sourceArchived?(source: Readonly<{ kind: 'session' | 'project'; id: string }>): boolean
  emit?(event: string, payload: Readonly<Record<string, unknown>>): void
}): AutoSkillLiveRuntime {
  const registry = input.registry ?? MEMORY_AUTO_SKILL_REGISTRY
  const scopeKey = autoSkillScopeKey(input.scope)
  if (scopeKey === null) throw new Error('AUTO_SKILL_SCOPE_INVALID')
  let drain: Promise<void> | null = null
  const plannedInvocations = new Map<string, Readonly<{
    revisionHash: string
    call: ToolCall
    expectedOrdinal: number
  }>>()
  const invocationKey = (sessionId: string, turnId: string): string =>
    `${sessionId.length}:${sessionId}${turnId.length}:${turnId}`

  const observer: VerifiedWorkflowObserver = Object.freeze({
    capture(call: ToolCall, context: ToolExecutionContext, result: unknown) {
      if (call.name !== 'remember' || typeof result !== 'object' || result === null) return null
      const fact = parseRememberFactArgs(call.args)
      const raw = result as Record<string, unknown>
      const receipt = parseMemoryRememberReceipt(raw['mutationReceipt'])
      if (fact === null || receipt === null || raw['ok'] !== true || raw['verified'] !== true ||
        raw['output'] !== renderMemoryAcknowledgement(receipt.fact) || receipt.fact !== fact.fact) {
        return null
      }
      const expected = makeMemoryRememberReceipt(fact, context)
      if (expected === null || expected.operationId !== receipt.operationId ||
        expected.receiptId !== receipt.receiptId || expected.turnId !== receipt.turnId) return null
      return Object.freeze({
        descriptorId: 'memory.remember',
        placeholderIds: Object.freeze(['fact']),
        postconditionIds: Object.freeze(['memory.committed']),
        receiptId: receipt.receiptId,
      })
    },
    commit(observation: Readonly<{
      sessionId: string
      turnId: string
      steps: readonly VerifiedWorkflowStepObservation[]
    }>) {
      const evidence = makeVerifiedWorkflowEvidence({
        sessionId: observation.sessionId,
        turnId: observation.turnId,
        scope: input.scope,
        registry,
        steps: observation.steps,
        trusted: true,
        narrowed: false,
      })
      if (evidence === null) throw new Error('AUTO_SKILL_EVIDENCE_INVALID')
      const outcome = input.store.stage(evidence)
      input.emit?.('auto_skill.evidence_observed', {
        outcome: outcome.kind,
        workflowFingerprint: evidence.workflowFingerprint,
      })
      return Object.freeze({ evidenceId: evidence.evidenceId })
    },
  })

  const recoverForgetClaims = (): number => {
    const recovered = input.store.recoverForgetClaims(input.sourceArchived)
    if (recovered > 0) input.emit?.('auto_skill.forget_recovered', { recovered })
    return recovered
  }

  const runDrain = async (): Promise<void> => {
    try {
      recoverForgetClaims()
      for (let index = 0; index < 16; index++) {
        const result = await input.worker.drainOne()
        input.emit?.('auto_skill.worker', { outcome: result.kind })
        if (result.kind === 'idle' || result.kind === 'deferred') break
      }
      for (let index = 0; index < 16; index++) {
        const notification = input.store.claimNotification()
        if (notification === null) break
        try {
          await input.notify(`Я запомнил этот способ работы как навык: ${notification.title}.`)
          input.store.completeNotification(notification.id, 'sent')
        } catch {
          input.store.completeNotification(notification.id, 'ambiguous')
        }
      }
    } finally {
      drain = null
    }
  }

  return Object.freeze({
    observer,
    confirmReply(identity: { evidenceId: string; sessionId: string; turnId: string }) {
      const outcome = input.store.confirmReply(identity)
      input.emit?.('auto_skill.reply_confirmed', { outcome: outcome.kind })
    },
    claimSource(selector: { sessionId?: string; projectId?: string }) {
      const claim = input.store.claimBySource(selector)
      input.emit?.('auto_skill.source_forget_claimed', { affected: claim.affected })
    },
    completeSourceForget(selector: { sessionId?: string; projectId?: string }) {
      const claim = input.store.claimBySource(selector)
      input.store.purgeClaim(claim.claimId)
      input.emit?.('auto_skill.source_forgotten', { affected: claim.affected })
    },
    plan(request: Pick<ModelRequest, 'sessionId' | 'turnId' | 'toolOrdinalBase' | 'spans'>) {
      if (request.turnId === undefined) return null
      let operatorIndex = -1
      for (let index = 0; index < request.spans.length; index++) {
        const span = request.spans[index]!
        if (span.role === 'user') {
          if (span.provenance !== 'operator') operatorIndex = -1
          else operatorIndex = index
        }
      }
      if (operatorIndex < 0 || request.spans.slice(operatorIndex + 1)
        .some(span => span.role === 'assistant' || span.role === 'tool')) return null
      const text = request.spans[operatorIndex]!.text.normalize('NFKC').trim()
      const match = /^(?:пожалуйста[\s,]+)?запомни(?:[\s,]+что)?\s+(.+)$/iu.exec(text)
      const fact = match?.[1]?.trim() ?? ''
      if (fact.length === 0 || /^(?:я|мне|мой|моя|мои)(?:\s|$)/iu.test(fact) ||
        /(?:^|\s)(?:и\s+(?:делегируй|поручи|запусти|создай|исправь)|and\s+(?:delegate|run|create|fix))(?:\s|$)/iu
          .test(fact) || parseRememberFactArgs({ fact }) === null) return null
      const candidates = input.store.activeForScope(scopeKey).filter(item =>
        item.manifest.triggers.some(trigger => text.toLocaleLowerCase('ru-RU')
          .startsWith(trigger.toLocaleLowerCase('ru-RU'))) &&
        item.manifest.steps.length === 1 &&
        item.manifest.steps[0]?.descriptorId === 'memory.remember' &&
        JSON.stringify(item.manifest.steps[0]?.placeholderIds) === JSON.stringify(['fact']) &&
        JSON.stringify(item.manifest.steps[0]?.postconditionIds) ===
          JSON.stringify(['memory.committed']))
      if (candidates.length !== 1) return null
      const call = Object.freeze({
        name: 'remember', args: Object.freeze({ fact }), sourceSpanProvenance: 'operator' as const,
      })
      const key = invocationKey(request.sessionId, request.turnId)
      plannedInvocations.set(key, Object.freeze({
        revisionHash: candidates[0]!.manifest.revisionHash,
        call,
        expectedOrdinal: (request.toolOrdinalBase ?? 0) + 1,
      }))
      while (plannedInvocations.size > 128) {
        const oldest = plannedInvocations.keys().next().value as string | undefined
        if (oldest === undefined) break
        plannedInvocations.delete(oldest)
      }
      return Object.freeze({
        revisionHash: candidates[0]!.manifest.revisionHash,
        calls: Object.freeze([call]),
      })
    },
    observeInvocation(call: ToolCall, context: ToolExecutionContext, result: unknown) {
      if (context.turnId === undefined) return
      const key = invocationKey(context.sessionId, context.turnId)
      const planned = plannedInvocations.get(key)
      if (planned === undefined || call.name !== planned.call.name ||
        context.ordinal !== planned.expectedOrdinal ||
        JSON.stringify(call.args) !== JSON.stringify(planned.call.args)) return
      plannedInvocations.delete(key)
      if (typeof result !== 'object' || result === null) return
      const raw = result as Record<string, unknown>
      // Transport/provider/policy failures are transient. Demotion is reserved
      // for a claimed success whose exact code-owned postcondition receipt is
      // missing or inconsistent with the planned revision-bound invocation.
      if (raw['ok'] !== true) return
      const fact = parseRememberFactArgs(call.args)
      const receipt = parseMemoryRememberReceipt(raw['mutationReceipt'])
      const expected = fact === null ? null : makeMemoryRememberReceipt(fact, context)
      if (fact !== null && receipt !== null && expected !== null && raw['verified'] === true &&
        raw['output'] === renderMemoryAcknowledgement(receipt.fact) &&
        receipt.fact === fact.fact && receipt.operationId === expected.operationId &&
        receipt.receiptId === expected.receiptId && receipt.turnId === expected.turnId) return
      input.store.permanentFailure(planned.revisionHash, 'postcondition_mismatch')
      input.emit?.('auto_skill.revision_demoted', {
        revisionHash: planned.revisionHash,
        failure: 'postcondition_mismatch',
      })
    },
    lateContext(spans: readonly ContextSpan[]) {
      const request = spans
        .filter(span => span.role === 'user' && span.provenance === 'operator')
        .map(span => span.text)
        .join('\n')
        .toLocaleLowerCase('ru-RU')
      if (request.length === 0) return Object.freeze([])
      return Object.freeze(input.store.activeForScope(scopeKey)
        .filter(item => item.manifest.triggers.some(trigger =>
          request.includes(trigger.toLocaleLowerCase('ru-RU'))))
        .map(item => Object.freeze({
          role: 'system' as const,
          provenance: 'learned-procedure' as const,
          text: `[Приватный проверенный навык: ${item.manifest.name}]\n${item.renderedSkill}`,
        })))
    },
    recoverStartup: recoverForgetClaims,
    drainAfterReply() {
      drain ??= runDrain()
      return drain
    },
    doctor: () => input.store.doctor(),
  })
}
