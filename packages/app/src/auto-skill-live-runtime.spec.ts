import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  autoSkillScopeKey,
  makeMemoryRememberReceipt,
  parseRememberFactArgs,
  renderMemoryAcknowledgement,
  type AutoSkillScope,
  type ToolExecutionContext,
} from '@aisy/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assertAutoSkillSourceLifecycleAvailable,
  makeAutoSkillLiveRuntime,
  makeAutoSkillPlanningProvider,
  MEMORY_AUTO_SKILL_REGISTRY,
  selectAutoSkillCanary,
} from './auto-skill-live-runtime.js'
import { makeNodeAutoSkillStoreV2 } from './auto-skill-store.js'
import { makeAutoSkillWorker } from './auto-skill-worker.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const scope: AutoSkillScope = Object.freeze({
  botId: 'bot-main', operatorId: 'operator-a', profileId: 'default',
  projectId: 'project-a', resourceScope: 'project-workspace',
  capabilityRevision: 'capability-v1',
})

function fixture(selectedScope: AutoSkillScope = scope) {
  const root = mkdtempSync(join(tmpdir(), 'aisy-auto-skill-live-'))
  roots.push(root)
  const store = makeNodeAutoSkillStoreV2({ root })
  const draft = {
    version: 1 as const,
    steps: [{
      descriptorId: 'memory.remember', placeholderIds: ['fact'],
      postconditionIds: ['memory.committed'],
    }],
  }
  const notify = vi.fn(async (_text: string) => undefined)
  const worker = makeAutoSkillWorker({
    store,
    registry: MEMORY_AUTO_SKILL_REGISTRY,
    generator: {
      identity: { provider: 'generator', model: 'model-a', revision: 'config-v1' },
      generate: async () => draft,
    },
    judge: {
      identity: { provider: 'judge', model: 'model-b', revision: 'config-v1' },
      judge: async () => ({ accepted: true }),
    },
  })
  const runtime = makeAutoSkillLiveRuntime({ store, scope: selectedScope, worker, notify })
  return { root, store, runtime, notify }
}

function observe(runtime: ReturnType<typeof fixture>['runtime'], sessionId: string, fact: string) {
  const context: ToolExecutionContext = {
    sessionId, turnId: `turn-${sessionId}`, ordinal: 1,
  }
  const normalized = parseRememberFactArgs({ fact })
  if (normalized === null) throw new Error('valid remember fact expected')
  const receipt = makeMemoryRememberReceipt(normalized, context)!
  const step = runtime.observer.capture(
    { name: 'remember', args: { fact } },
    context,
    {
      ok: true,
      output: renderMemoryAcknowledgement(normalized.fact),
      verified: true,
      mutationReceipt: receipt,
    },
  )
  expect(step).not.toBeNull()
  const delivery = runtime.observer.commit({
    sessionId, turnId: context.turnId!, steps: [step!],
  })
  if (typeof delivery !== 'object' || delivery === null || !('evidenceId' in delivery) ||
    typeof delivery.evidenceId !== 'string') {
    throw new Error('delivery binding expected')
  }
  return {
    sessionId: context.sessionId,
    turnId: context.turnId!,
    ordinal: context.ordinal,
    evidenceId: delivery.evidenceId,
  }
}

describe('LIVE typed auto-skill runtime', () => {
  it('performs zero construction I/O when the canary is off', () => {
    const create = vi.fn(() => fixture().runtime)
    expect(selectAutoSkillCanary(false, create)).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it('pauses only the optional canary behind a certified rollback barrier', () => {
    const paused = vi.fn()
    const create = vi.fn(() => fixture().runtime)

    expect(selectAutoSkillCanary(false, create, {
      rollbackBarrier: 'certified', onRollbackBarrier: paused,
    })).toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(paused).toHaveBeenCalledOnce()

    expect(selectAutoSkillCanary(true, create, {
      rollbackBarrier: 'certified', onRollbackBarrier: paused,
    })).toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(paused).toHaveBeenCalledTimes(2)
  })

  it('does not hide an unsafe rollback barrier or ordinary store corruption', () => {
    expect(() => selectAutoSkillCanary(false, vi.fn(), {
      rollbackBarrier: 'unsafe', onRollbackBarrier: vi.fn(),
    })).toThrow('AUTO_SKILL_ROLLBACK_BARRIER_INVALID')
    expect(() => selectAutoSkillCanary(true, () => {
      throw new Error('AUTO_SKILL_STORE_CORRUPT')
    }, { rollbackBarrier: 'absent', onRollbackBarrier: vi.fn() }))
      .toThrow('AUTO_SKILL_STORE_CORRUPT')
  })

  it('blocks source lifecycle while the certified rollback pause is active', () => {
    expect(() => assertAutoSkillSourceLifecycleAvailable(true))
      .toThrow('AUTO_SKILL_ROLLBACK_BARRIER')
    expect(() => assertAutoSkillSourceLifecycleAvailable(false)).not.toThrow()
  })

  it('activates only after two sessions, then exposes a learned-procedure overlay after reply', async () => {
    const h = fixture()
    const first = observe(h.runtime, 'session-a', 'пользователь предпочитает краткие отчёты')
    expect(h.store.doctor()).toMatchObject({ evidence: 0, pendingReply: 1, active: 0 })
    h.runtime.confirmReply(first)
    await h.runtime.drainAfterReply()
    expect(h.store.doctor().active).toBe(0)
    expect(h.notify).not.toHaveBeenCalled()

    const second = observe(h.runtime, 'session-b', 'ты любишь получать уведомления')
    h.runtime.confirmReply(second)
    await h.runtime.drainAfterReply()

    expect(h.store.doctor().active).toBe(1)
    expect(h.notify).toHaveBeenCalledWith(
      'Я запомнил этот способ работы как навык: Запоминание факта.',
    )
    const overlay = h.runtime.lateContext([
      { role: 'user', provenance: 'operator', text: 'Запомни ещё один факт' },
    ])
    expect(overlay).toHaveLength(1)
    expect(overlay[0]).toMatchObject({ role: 'system', provenance: 'learned-procedure' })
    expect(overlay[0]?.text).toContain('memory.remember')

    const plan = h.runtime.plan({
      sessionId: 'session-c', turnId: 'turn-c',
      spans: [{ role: 'user', provenance: 'operator', text: 'Запомни, что ты любишь чай' }],
    })
    expect(plan).toMatchObject({ calls: [{
      name: 'remember', args: { fact: 'ты любишь чай' }, sourceSpanProvenance: 'operator',
    }] })
    expect(h.runtime.plan({
      sessionId: 'session-c', turnId: 'turn-c',
      spans: [{ role: 'user', provenance: 'operator', text: 'Запомни, что я люблю чай' }],
    })).toBeNull()

    const base = { complete: vi.fn(async () => ({ reply: 'ответ модели' })) }
    const provider = makeAutoSkillPlanningProvider({ provider: base, runtime: h.runtime })
    await expect(provider.complete({
      sessionId: 'session-c', turnId: 'turn-c', prefixBytes: new Uint8Array(),
      spans: [{ role: 'user', provenance: 'operator', text: 'Запомни, что ты любишь чай' }],
    })).resolves.toMatchObject({ reply: '', toolCalls: [{ name: 'remember' }] })
    expect(base.complete).not.toHaveBeenCalled()
    await expect(provider.complete({
      sessionId: 'session-c', turnId: 'turn-c', prefixBytes: new Uint8Array(),
      spans: [
        { role: 'user', provenance: 'operator', text: 'Запомни, что ты любишь чай' },
        { role: 'tool', provenance: 'untrusted', text: 'remember: ok' },
      ],
    })).resolves.toMatchObject({ reply: 'ответ модели' })
    expect(base.complete).toHaveBeenCalledOnce()

    h.runtime.observeInvocation(
      plan!.calls[0]!,
      { sessionId: 'session-c', turnId: 'turn-c', ordinal: 1 },
      { ok: false, output: 'temporary backend failure' },
    )
    expect(h.store.doctor().active).toBe(1)

    const failingPlan = h.runtime.plan({
      sessionId: 'session-d', turnId: 'turn-d',
      toolOrdinalBase: 3,
      spans: [{ role: 'user', provenance: 'operator', text: 'Запомни, что ты любишь кофе' }],
    })
    h.runtime.observeInvocation(
      failingPlan!.calls[0]!,
      { sessionId: 'session-d', turnId: 'turn-d', ordinal: 3 },
      { ok: true, output: 'успех без receipt', verified: true },
    )
    expect(h.store.doctor().active).toBe(1)
    h.runtime.observeInvocation(
      failingPlan!.calls[0]!,
      { sessionId: 'session-d', turnId: 'turn-d', ordinal: 4 },
      { ok: true, output: 'успех без receipt', verified: true },
    )
    expect(h.store.doctor().active).toBe(0)
    expect(h.runtime.plan({
      sessionId: 'session-e', turnId: 'turn-e',
      spans: [{ role: 'user', provenance: 'operator', text: 'Запомни, что ты любишь воду' }],
    })).toBeNull()
  })

  it('removes a learned overlay when a linked source session is forgotten', async () => {
    const h = fixture()
    const first = observe(h.runtime, 'session-a', 'первый синтетический факт')
    const second = observe(h.runtime, 'session-b', 'второй синтетический факт')
    h.runtime.confirmReply(first)
    h.runtime.confirmReply(second)
    await h.runtime.drainAfterReply()
    expect(h.store.doctor()).toMatchObject({ active: 1, evidence: 2 })

    h.runtime.claimSource({ sessionId: 'session-a' })
    expect(h.runtime.lateContext([
      { role: 'user', provenance: 'operator', text: 'запомни факт' },
    ])).toEqual([])
    h.runtime.completeSourceForget({ sessionId: 'session-a' })

    expect(h.runtime.lateContext([
      { role: 'user', provenance: 'operator', text: 'запомни факт' },
    ])).toEqual([])
    expect(h.store.doctor()).toMatchObject({ active: 0, evidence: 0, forgetClaimed: 0 })
  })

  it('recovers only claims whose source is already archived during canary-on startup', async () => {
    const h = fixture()
    const first = observe(h.runtime, 'session-a', 'первый синтетический факт')
    const second = observe(h.runtime, 'session-b', 'второй синтетический факт')
    h.runtime.confirmReply(first)
    h.runtime.confirmReply(second)
    await h.runtime.drainAfterReply()
    h.runtime.claimSource({ sessionId: 'session-a' })

    const notArchived = makeAutoSkillLiveRuntime({
      store: makeNodeAutoSkillStoreV2({ root: h.root }), scope,
      worker: { drainOne: async () => ({ kind: 'idle' as const }) },
      notify: async () => undefined,
      sourceArchived: () => false,
    })
    expect(notArchived.recoverStartup()).toBe(0)
    expect(notArchived.doctor().forgetClaimed).toBe(1)

    const archived = makeAutoSkillLiveRuntime({
      store: makeNodeAutoSkillStoreV2({ root: h.root }), scope,
      worker: { drainOne: async () => ({ kind: 'idle' as const }) },
      notify: async () => undefined,
      sourceArchived: source => source.kind === 'session' && source.id === 'session-a',
    })
    expect(archived.recoverStartup()).toBe(1)
    expect(archived.doctor()).toMatchObject({ active: 0, evidence: 0, forgetClaimed: 0 })
  })

  it('does not expose Project A activation in Project B', async () => {
    const h = fixture()
    const first = observe(h.runtime, 'session-a', 'первый факт')
    const second = observe(h.runtime, 'session-b', 'второй факт')
    h.runtime.confirmReply(first)
    h.runtime.confirmReply(second)
    await h.runtime.drainAfterReply()

    const projectB = { ...scope, projectId: 'project-b' }
    const isolated = makeAutoSkillLiveRuntime({
      store: h.store,
      scope: projectB,
      worker: { drainOne: async () => ({ kind: 'idle' as const }) },
      notify: async () => undefined,
    })
    expect(autoSkillScopeKey(projectB)).not.toBe(autoSkillScopeKey(scope))
    expect(isolated.lateContext([
      { role: 'user', provenance: 'operator', text: 'запомни факт' },
    ])).toEqual([])
  })

  it('rejects a forged receipt or a receipt bound to another execution position', () => {
    const h = fixture()
    const context = { sessionId: 'session-a', turnId: 'turn-a', ordinal: 1 }
    const receipt = makeMemoryRememberReceipt({ fact: 'факт' }, context)!
    expect(h.runtime.observer.capture(
      { name: 'remember', args: { fact: 'другой факт' } },
      context,
      { ok: true, output: renderMemoryAcknowledgement('факт'), verified: true, mutationReceipt: receipt },
    )).toBeNull()
    expect(h.runtime.observer.capture(
      { name: 'remember', args: { fact: 'факт' } },
      { ...context, ordinal: 2 },
      { ok: true, output: renderMemoryAcknowledgement('факт'), verified: true, mutationReceipt: receipt },
    )).toBeNull()
  })
})
