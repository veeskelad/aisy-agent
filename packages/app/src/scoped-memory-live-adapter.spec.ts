import { describe, expect, it, vi } from 'vitest'
import type { ScopedMemoryRouter, TurnContextLease } from '@aisy/core'

import {
  makeScopedMemoryLiveView,
  ScopedMemoryUnavailableError,
  type ProtectedLedgerFact,
} from './scoped-memory-live-adapter.js'

const lease = (overrides: Partial<TurnContextLease> = {}): TurnContextLease => ({
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'workspace-1',
  projectKind: 'workspace',
  sessionId: 'session-1',
  root: '/Users/operator/workspace',
  generation: 1,
  leaseId: 'lease-1',
  ...overrides,
})

function router(): ScopedMemoryRouter & Record<string, ReturnType<typeof vi.fn>> {
  return {
    searchAutomatic: vi.fn(async () => ({ hits: [{ hitId: 'h1', score: 1, scope: 'global' }] })),
    commitGlobal: vi.fn(async () => ({ status: 'COMMITTED' })),
    commitProject: vi.fn(async () => ({ status: 'COMMITTED' })),
    forgetGlobal: vi.fn(async () => undefined),
    forgetProject: vi.fn(async () => undefined),
  } as never
}

const record: ProtectedLedgerFact = {
  id: 'fact-1',
  text: 'Оператор предпочитает краткие ответы',
  factKey: 'a'.repeat(64),
  validAt: '2026-07-29T10:00:00Z',
  invalidAt: null,
  isHumanConfirmed: true,
  sourceAuthority: 9,
  confidence: 0.9,
  provenance: 'journal:event-1',
}

const ledger = (facts: ProtectedLedgerFact[] = [record]) => ({
  listLiveFacts: async () => facts,
  integrityCheck: () => ({ ok: true }),
})

describe('scoped memory live view (ADR-0074)', () => {
  it('routes commit and forget by the scope of the lease', async () => {
    const target = router()
    const view = makeScopedMemoryLiveView({ router: target, ledger: ledger() })

    await view.commit(lease(), { op: 'ADD', text: 'x' }, { withinSession: true })
    expect(target.commitGlobal).toHaveBeenCalledTimes(1)
    expect(target.commitProject).not.toHaveBeenCalled()

    await view.commit(
      lease({ projectKind: 'project', projectId: 'project-a' }),
      { op: 'ADD', text: 'y' },
      { withinSession: true },
    )
    expect(target.commitProject).toHaveBeenCalledTimes(1)

    await view.forget(lease(), 'fact-1', 'operator request', true)
    expect(target.forgetGlobal).toHaveBeenCalledTimes(1)
    await view.forget(lease({ projectKind: 'project' }), 'fact-1', 'operator request', true)
    expect(target.forgetProject).toHaveBeenCalledTimes(1)
  })

  it('passes the lease through to search and returns hits even when degraded', async () => {
    const target = router()
    target.searchAutomatic = vi.fn(async () => ({
      hits: [{ hitId: 'h1', score: 1, scope: 'global' }],
      degraded: 'PROJECT_MEMORY_UNAVAILABLE',
    })) as never
    const view = makeScopedMemoryLiveView({ router: target, ledger: ledger() })

    const hits = await view.search(lease(), 'запрос', { limit: 3 })
    expect(hits).toHaveLength(1)
    expect(target.searchAutomatic).toHaveBeenCalledWith(expect.objectContaining({ leaseId: 'lease-1' }), 'запрос', { limit: 3 })
  })

  it('projects ledger records to memory facts without inventing relationship edges', async () => {
    const view = makeScopedMemoryLiveView({ router: router(), ledger: ledger() })
    const facts = await view.listLive(lease())

    expect(facts).toEqual([{
      id: 'fact-1',
      text: 'Оператор предпочитает краткие ответы',
      factKey: 'a'.repeat(64),
      validAt: '2026-07-29T10:00:00Z',
      invalidAt: null,
      isHumanConfirmed: true,
      sourceAuthority: 9,
      confidence: 0.9,
      provenance: 'journal:event-1',
    }])
    expect(facts[0]).not.toHaveProperty('supersedes')
  })

  it('carries relationship edges that the ledger does hold', async () => {
    const view = makeScopedMemoryLiveView({
      router: router(),
      ledger: ledger([{ ...record, supersedes: 'b'.repeat(64), extends: 'c'.repeat(64) }]),
    })

    const [fact] = await view.listLive(lease())
    expect(fact?.supersedes).toBe('b'.repeat(64))
    expect(fact?.extends).toBe('c'.repeat(64))
    expect(fact).not.toHaveProperty('contradicts')
  })

  it('fails closed when protected memory is off instead of falling back', async () => {
    const view = makeScopedMemoryLiveView({ router: null, ledger: null })

    await expect(view.search(lease(), 'q')).rejects.toThrowError(ScopedMemoryUnavailableError)
    await expect(view.commit(lease(), { op: 'ADD', text: 'x' }, { withinSession: true }))
      .rejects.toThrowError(ScopedMemoryUnavailableError)
    await expect(view.forget(lease(), 'f', 'r', true)).rejects.toThrowError(ScopedMemoryUnavailableError)
    await expect(view.listLive(lease())).rejects.toThrowError(ScopedMemoryUnavailableError)
    expect(() => view.integrityCheck(lease())).toThrowError(ScopedMemoryUnavailableError)
  })

  it('refuses bulk reads without a real lease', async () => {
    const view = makeScopedMemoryLiveView({ router: router(), ledger: ledger() })

    await expect(view.listLive(lease({ leaseId: '' }))).rejects.toThrowError(ScopedMemoryUnavailableError)
    expect(() => view.integrityCheck(lease({ leaseId: '' }))).toThrowError(ScopedMemoryUnavailableError)
  })

  it('reports the ledger integrity verdict verbatim', () => {
    const view = makeScopedMemoryLiveView({
      router: router(),
      ledger: { listLiveFacts: async () => [], integrityCheck: () => ({ ok: false, detail: 'chain' }) },
    })

    expect(view.integrityCheck(lease())).toEqual({ ok: false, detail: 'chain' })
  })
})

describe('fact deduplication on the live commit path (ADR-0078)', () => {
  const existing = (text: string) => ({
    hits: [{ id: 'fact-7', hitId: 'h1', factKey: 'b'.repeat(64), text, score: 1, scope: 'global' }],
  })

  it('does not write a second record for a fact already in memory', async () => {
    const target = router()
    target.searchAutomatic = vi.fn(async () =>
      existing('Оператор работает в часовом поясе Europe/Moscow')) as never
    const view = makeScopedMemoryLiveView({ router: target, ledger: ledger() })

    const result = await view.commit(
      lease(),
      { op: 'ADD', text: 'оператор  работает В часовом поясе Europe/Moscow, летом Тбилиси' },
      { withinSession: true },
    )

    expect(result).toEqual({ status: 'DUPLICATE', factId: 'fact-7' })
    expect(target.commitGlobal).not.toHaveBeenCalled()
  })

  it('deduplicates a restarted logical remember with a new operation id', async () => {
    const target = router()
    target.searchAutomatic = vi.fn(async () =>
      existing('Оператор работает в часовом поясе Europe/Moscow')) as never
    const view = makeScopedMemoryLiveView({ router: target, ledger: ledger() })

    await expect(view.commit(
      lease(),
      { op: 'ADD', text: 'оператор работает в часовом поясе Europe/Moscow' },
      { withinSession: true, operationId: 'a'.repeat(64) },
    )).resolves.toEqual({ status: 'DUPLICATE', factId: 'fact-7' })
    expect(target.commitGlobal).not.toHaveBeenCalled()
  })

  it('routes an exact operation replay to the protected publication ledger', async () => {
    const operationId = 'a'.repeat(64)
    const target = router()
    target.searchAutomatic = vi.fn(async () => ({
      hits: [{
        id: operationId, hitId: operationId, factKey: 'b'.repeat(64),
        text: 'Оператор любит чай', score: 1, scope: 'global',
      }],
    })) as never
    const view = makeScopedMemoryLiveView({ router: target, ledger: ledger() })

    await expect(view.commit(
      lease(),
      { op: 'ADD', text: 'оператор любит чай' },
      { withinSession: true, operationId },
    )).resolves.toEqual({ status: 'COMMITTED' })
    expect(target.commitGlobal).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), { withinSession: true, operationId },
    )
  })

  it('commits a genuinely new fact even when search returns neighbours', async () => {
    const target = router()
    target.searchAutomatic = vi.fn(async () =>
      existing('Оператор работает в часовом поясе Europe/Moscow')) as never
    const view = makeScopedMemoryLiveView({ router: target, ledger: ledger() })

    const result = await view.commit(
      lease(),
      { op: 'ADD', text: 'Основной язык общения оператора — русский' },
      { withinSession: true },
    )

    expect(result).toEqual({ status: 'COMMITTED' })
    expect(target.commitGlobal).toHaveBeenCalledTimes(1)
  })

  it('never deduplicates an update or a delete — those name a specific fact', async () => {
    const target = router()
    target.searchAutomatic = vi.fn(async () => existing('что угодно')) as never
    const view = makeScopedMemoryLiveView({ router: target, ledger: ledger() })

    await view.commit(
      lease(),
      { op: 'UPDATE', targetId: 'fact-7', text: 'Оператор работает в часовом поясе Asia/Tbilisi' },
      { withinSession: true },
    )
    await view.commit(
      lease(),
      { op: 'DELETE', targetId: 'fact-7', humanConfirmed: true, reason: 'устарело' },
      { withinSession: true },
    )

    expect(target.commitGlobal).toHaveBeenCalledTimes(2)
    expect(target.searchAutomatic).not.toHaveBeenCalled()
  })
})
