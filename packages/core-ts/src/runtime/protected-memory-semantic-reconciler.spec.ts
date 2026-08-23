import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { EmbeddingDescriptor } from './hybrid-retrieval.js'
import { HybridRetrievalIntegrityError } from './hybrid-retrieval.js'
import type {
  ProtectedMemoryFactRecordV2,
  ProtectedMemoryScope,
} from './protected-memory-publication.js'
import {
  makeProtectedMemorySemanticReconciler,
  semanticDescriptorId,
} from './protected-memory-semantic-reconciler.js'

const scope: ProtectedMemoryScope = {
  kind: 'project', scopeId: 'project:alpha', projectId: 'alpha',
}
const descriptor: EmbeddingDescriptor = {
  provider: 'openrouter',
  modelId: 'vendor/model',
  modelRevision: 'rev-1',
  dimensions: 3,
  normalizationVersion: 'nfkc-v1',
  chunkerVersion: 'fact-v1',
}
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

function fact(id: string, text = `${id} canonical text`): ProtectedMemoryFactRecordV2 {
  return {
    schemaVersion: 2,
    operationId: sha256(`operation:${id}`),
    id,
    operatorId: 'telegram:42',
    profileId: 'default',
    scope: { kind: 'project', scopeId: 'project:alpha', projectId: 'alpha' },
    text,
    factKey: sha256(id),
    keyTokens: [id],
    validAt: '2026-07-29T10:00:00.000Z',
    invalidAt: null,
    isHumanConfirmed: false,
    sourceAuthority: 50,
    confidence: 0.9,
    provenance: `session:one:${id}`,
    sourcePath: `memory/facts/${sha256(id)}.md`,
    contentHash: sha256(text),
    published: true,
  }
}

function harness(input: {
  facts?: ProtectedMemoryFactRecordV2[]
  availability?: 'healthy' | 'unavailable' | 'revoked'
  indexDocument?: ReturnType<typeof vi.fn>
  events?: unknown[]
  emit?: (event: { kind: string }) => void
  order?: string[]
  recoveryError?: Error
} = {}) {
  const assertRecovered = vi.fn(async () => {
    input.order?.push('recovery')
    if (input.recoveryError) throw input.recoveryError
  })
  const listLiveFacts = vi.fn(async () => {
    input.order?.push('snapshot')
    return input.facts ?? [fact('one')]
  })
  const availability = vi.fn(async () => {
    input.order?.push('availability')
    return input.availability ?? 'healthy'
  })
  const indexDocument = input.indexDocument ?? vi.fn(async () => {
    input.order?.push('index')
    return 'INDEXED' as const
  })
  const removeFact = vi.fn()
  const reconciler = makeProtectedMemorySemanticReconciler({
    scope,
    descriptor,
    source: { assertRecovered, listLiveFacts },
    semantic: { availability, indexDocument, removeFact },
    emit: event => {
      input.events?.push(event)
      input.emit?.(event)
    },
  })
  return { reconciler, assertRecovered, listLiveFacts, availability, indexDocument, removeFact }
}

describe('protected memory semantic reconciler', () => {
  it('derives a stable descriptor id from every field in frozen JSON order', () => {
    const expected = sha256(JSON.stringify({
      provider: 'openrouter', modelId: 'vendor/model', modelRevision: 'rev-1',
      dimensions: 3, normalizationVersion: 'nfkc-v1', chunkerVersion: 'fact-v1',
    }))
    expect(semanticDescriptorId(descriptor)).toBe(expected)
    expect(semanticDescriptorId({ ...descriptor })).toBe(expected)
    const variants: EmbeddingDescriptor[] = [
      { ...descriptor, provider: 'other' },
      { ...descriptor, modelId: 'other/model' },
      { ...descriptor, modelRevision: 'rev-2' },
      { ...descriptor, dimensions: 4 },
      { ...descriptor, normalizationVersion: 'nfkc-v2' },
      { ...descriptor, chunkerVersion: 'fact-v2' },
    ]
    expect(variants.map(semanticDescriptorId)).not.toContain(expected)
  })

  it('recovers and validates the stable snapshot before provider I/O', async () => {
    const order: string[] = []
    const { reconciler } = harness({ order })

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      state: 'CURRENT', scanned: 1, indexed: 1, failed: 0,
    })
    expect(order).toEqual(['recovery', 'snapshot', 'availability', 'index'])

    const failed = harness({ recoveryError: new Error('private recovery detail') })
    await expect(failed.reconciler.reconcile()).resolves.toMatchObject({
      state: 'DEGRADED', failed: 1, scanned: 0,
    })
    expect(failed.listLiveFacts).not.toHaveBeenCalled()
    expect(failed.availability).not.toHaveBeenCalled()
  })

  it('maps canonical facts to exact fact-v1 candidates', async () => {
    const source = fact('fact-id', 'canonical text')
    const indexDocument = vi.fn(async () => 'INDEXED' as const)
    const { reconciler, removeFact } = harness({ facts: [source], indexDocument })

    await reconciler.reconcile()

    expect(indexDocument).toHaveBeenCalledWith({
      candidate: {
        hitId: 'fact-id',
        scope: 'project',
        scopeId: 'project:alpha',
        projectId: 'alpha',
        sourcePath: source.sourcePath,
        chunkId: 'fact-id',
        contentHash: source.contentHash,
        provenance: source.provenance,
        score: 0,
      },
      factKey: source.factKey,
      content: source.text,
    })
    expect(removeFact).not.toHaveBeenCalled()
  })

  it.each([
    ['unavailable', 'DEGRADED'],
    ['revoked', 'REVOKED'],
  ] as const)('does zero embedding work when semantic is %s', async (availability, state) => {
    const indexDocument = vi.fn()
    const { reconciler } = harness({ availability, indexDocument })

    await expect(reconciler.reconcile()).resolves.toMatchObject({ state, scanned: 1 })
    expect(indexDocument).not.toHaveBeenCalled()
  })

  it('counts sensitive skips without degrading canonical state', async () => {
    const indexDocument = vi.fn(async () => 'SKIPPED_SENSITIVE' as const)
    const { reconciler } = harness({ indexDocument })

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      state: 'CURRENT', sensitiveSkipped: 1, indexed: 0, failed: 0,
    })
  })

  it('redacts per-item failures, continues and reports degraded counts', async () => {
    const secret = 'private canonical bytes'
    const events: unknown[] = []
    const indexDocument = vi.fn()
      .mockRejectedValueOnce(new Error(secret))
      .mockResolvedValueOnce('CACHED')
    const { reconciler } = harness({
      facts: [fact('one', secret), fact('two')], indexDocument, events,
    })

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      state: 'DEGRADED', scanned: 2, cached: 1, failed: 1,
    })
    expect(indexDocument).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'memory.semantic_reconcile_item',
      code: 'ITEM_FAILED',
      itemRef: sha256('one'),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'memory.semantic_reconcile_completed',
      status: 'DEGRADED',
      code: 'DERIVATION_FAILED',
    }))
  })

  it('treats a live-filter race as stale and backfills it on the next request', async () => {
    const indexDocument = vi.fn()
      .mockRejectedValueOnce(new HybridRetrievalIntegrityError('DERIVED_FILTER_VIOLATION'))
      .mockResolvedValueOnce('INDEXED')
    const { reconciler } = harness({ indexDocument })

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      state: 'DEGRADED', staleSkipped: 1, failed: 0,
    })
    await expect(reconciler.reconcile()).resolves.toMatchObject({
      state: 'CURRENT', indexed: 1, staleSkipped: 0,
    })
  })

  it('rejects cross-scope snapshot items before provider availability or embedding', async () => {
    const foreign = fact('foreign')
    foreign.scope = { kind: 'project', scopeId: 'project:beta', projectId: 'beta' }
    const indexDocument = vi.fn()
    const { reconciler, availability } = harness({ facts: [foreign], indexDocument })

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      state: 'DEGRADED', scanned: 1, staleSkipped: 1,
    })
    expect(availability).toHaveBeenCalledOnce()
    expect(indexDocument).not.toHaveBeenCalled()
  })

  it('coalesces concurrent requests into one bounded follow-up scan', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const indexDocument = vi.fn(async () => {
      if (indexDocument.mock.calls.length === 1) await blocked
      return 'INDEXED' as const
    })
    const { reconciler, listLiveFacts } = harness({ indexDocument })

    reconciler.request()
    await vi.waitFor(() => expect(indexDocument).toHaveBeenCalledTimes(1))
    reconciler.request()
    reconciler.request()
    release()
    await reconciler.drain()

    expect(listLiveFacts).toHaveBeenCalledTimes(2)
    expect(indexDocument).toHaveBeenCalledTimes(2)
    expect(reconciler.state()).toBe('CURRENT')
  })

  it('relaunches a request injected at the pump completion boundary and drain waits for it', async () => {
    let injected = false
    let target!: ReturnType<typeof harness>
    target = harness({
      emit: event => {
        if (event.kind !== 'memory.semantic_reconcile_completed' || injected) return
        injected = true
        // First microtask runs before pump resumes from runOnce; the second
        // lands after it observed an empty queue but before its finalizer.
        queueMicrotask(() => queueMicrotask(() => target.reconciler.request()))
      },
    })

    await target.reconciler.reconcile()

    expect(target.listLiveFacts).toHaveBeenCalledTimes(2)
    expect(target.indexDocument).toHaveBeenCalledTimes(2)
    expect(target.reconciler.state()).toBe('CURRENT')
  })

  it('closes idempotently without starting queued work or leaking rejections', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const indexDocument = vi.fn(async () => {
      await blocked
      return 'INDEXED' as const
    })
    const { reconciler, listLiveFacts } = harness({ indexDocument })

    reconciler.request()
    await vi.waitFor(() => expect(indexDocument).toHaveBeenCalledOnce())
    reconciler.request()
    const first = reconciler.close()
    const second = reconciler.close()
    reconciler.request()
    release()
    await Promise.all([first, second, reconciler.drain()])

    expect(reconciler.state()).toBe('CLOSED')
    expect(listLiveFacts).toHaveBeenCalledOnce()
  })
})
