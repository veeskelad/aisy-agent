import { mkdirSync } from 'node:fs'

import {
  deriveDeterministicMemoryFactKey,
  makeProtectedMemoryDeletionService,
  makeProtectedMemoryFileStore,
  makeProtectedMemoryPublicationService,
  makeProtectedMemoryRecoveryGate,
  makeProtectedMemoryScopeBarrier,
  makeProtectedMemorySemanticDeletionPort,
  makeProtectedScopedMemoryRouter,
  makeProtectedMemorySqliteStore,
  makeProtectedMemoryUpdateService,
  makeSqliteVecSemanticStore,
  type ContextLeaseCoordinator,
  type EmbeddingDescriptor,
  type PreparedMemoryFactMetadata,
  type ProtectedMemoryAuditEvent,
  type ProtectedMemoryDeletionAuditEvent,
  type ProtectedMemoryDeletionDerivedPort,
  type ProtectedMemoryScope,
  type ProtectedScopedMemoryRuntime,
  type ProtectedMemoryUpdateAuditEvent,
  type ScopedMemoryEvent,
  type ScopedMemoryRouter,
  type TurnContextLease,
} from '@aisy/core'

export type ProtectedMemoryPreviewMode = 'off' | 'preview'

export class ProtectedMemoryRuntimeError extends Error {
  constructor(public readonly code: 'INVALID_MODE' | 'INVALID_SEMANTIC_DESCRIPTOR') {
    super(code)
    this.name = 'ProtectedMemoryRuntimeError'
  }
}

export type ProtectedMemorySemanticConfig =
  | Readonly<{ provider: 'none' }>
  | Readonly<{
      provider: 'openrouter'
      modelId: string
      modelRevision: string
      dimensions: number
      normalizationVersion: string
      chunkerVersion: string
    }>

const SEMANTIC_DESCRIPTOR_KEYS = Object.freeze([
  'provider',
  'modelId',
  'modelRevision',
  'dimensions',
  'normalizationVersion',
  'chunkerVersion',
] as const)

function descriptorText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 256 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
}

export function parseProtectedMemorySemanticConfig(value: unknown): ProtectedMemorySemanticConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtectedMemoryRuntimeError('INVALID_SEMANTIC_DESCRIPTOR')
  }
  let record: Record<string, unknown>
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >
    const keys = Reflect.ownKeys(descriptors).filter((key) => descriptors[key]?.enumerable === true)
    if (keys.some((key) => typeof key !== 'string') || keys.some((key) => {
      const descriptor = descriptors[key]
      return descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
    })) {
      throw new Error('invalid descriptor')
    }
    record = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) record[key] = structuredClone(descriptors[key]!.value)
  } catch {
    throw new ProtectedMemoryRuntimeError('INVALID_SEMANTIC_DESCRIPTOR')
  }
  const keys = Object.keys(record)
  if (record['provider'] === 'none') {
    if (keys.length !== 1 || keys[0] !== 'provider') {
      throw new ProtectedMemoryRuntimeError('INVALID_SEMANTIC_DESCRIPTOR')
    }
    return Object.freeze({ provider: 'none' })
  }
  if (record['provider'] !== 'openrouter' || keys.length !== SEMANTIC_DESCRIPTOR_KEYS.length ||
    keys.some((key) => !SEMANTIC_DESCRIPTOR_KEYS.includes(
      key as (typeof SEMANTIC_DESCRIPTOR_KEYS)[number],
    )) || !descriptorText(record['modelId']) || !descriptorText(record['modelRevision']) ||
    !descriptorText(record['normalizationVersion']) || !descriptorText(record['chunkerVersion']) ||
    !Number.isSafeInteger(record['dimensions']) || (record['dimensions'] as number) < 1 ||
    (record['dimensions'] as number) > 65_536) {
    throw new ProtectedMemoryRuntimeError('INVALID_SEMANTIC_DESCRIPTOR')
  }
  return Object.freeze({
    provider: 'openrouter',
    modelId: record['modelId'],
    modelRevision: record['modelRevision'],
    dimensions: record['dimensions'],
    normalizationVersion: record['normalizationVersion'],
    chunkerVersion: record['chunkerVersion'],
  }) as ProtectedMemorySemanticConfig
}

function sameProtectedScope(left: ProtectedMemoryScope, right: ProtectedMemoryScope): boolean {
  return left.kind === right.kind && left.scopeId === right.scopeId &&
    (left.kind !== 'project' || (right.kind === 'project' && left.projectId === right.projectId))
}

function makeKeywordOnlyDerivedPort(scope: ProtectedMemoryScope): ProtectedMemoryDeletionDerivedPort {
  const expectedScope = structuredClone(scope)
  const assertScope = (requested: ProtectedMemoryScope): void => {
    if (!sameProtectedScope(expectedScope, requested)) throw new Error('SCOPE_MISMATCH')
  }
  return Object.freeze<ProtectedMemoryDeletionDerivedPort>({
    async purge(request) { assertScope(request.scope) },
    async verifyPurged(request) {
      assertScope(request.scope)
      return true
    },
  })
}

function asScopedMemoryRuntime(
  runtime: Extract<NodeProtectedMemoryScopeRuntime, { mode: 'preview' }>,
): ProtectedScopedMemoryRuntime {
  const { semantic, ...base } = runtime
  return semantic === null ? base : { ...base, semantic }
}

export function parseProtectedMemoryPreviewMode(value: string | undefined): ProtectedMemoryPreviewMode {
  if (value === undefined || value === '' || value === 'off') return 'off'
  if (value === 'preview') return 'preview'
  throw new ProtectedMemoryRuntimeError('INVALID_MODE')
}

export type NodeProtectedMemoryScopeRuntime =
  | { mode: 'off' }
  | {
    mode: 'preview'
    scope: ProtectedMemoryScope
    publication: ReturnType<typeof makeProtectedMemoryPublicationService>
    deletion: ReturnType<typeof makeProtectedMemoryDeletionService>
    update: ReturnType<typeof makeProtectedMemoryUpdateService>
    recovery: ReturnType<typeof makeProtectedMemoryRecoveryGate>
    store: ReturnType<typeof makeProtectedMemorySqliteStore>
    files: ReturnType<typeof makeProtectedMemoryFileStore>
    semantic: ReturnType<typeof makeSqliteVecSemanticStore> | null
    withScopeExclusive<T>(lease: TurnContextLease, run: () => Promise<T>): Promise<T>
    close(): void
  }

export function makeNodeProtectedMemoryPreviewRouter(input: {
  leases: ContextLeaseCoordinator
  globalRuntime: NodeProtectedMemoryScopeRuntime
  projectRuntime(projectId: string): NodeProtectedMemoryScopeRuntime | null
  newFactId(): string
  provenanceFor(input: {
    lease: TurnContextLease
    op: Parameters<ScopedMemoryRouter['commitGlobal']>[1]
    scope: ProtectedMemoryScope
  }): string
  authorizeHumanConfirmedDelete(input: {
    lease: TurnContextLease
    factId: string
    targetOperationId: string
    factKey: string
    sourcePath: string
    contentHash: string
    reason: string
    scope: ProtectedMemoryScope
  }): Promise<boolean>
  emit?: (event: ScopedMemoryEvent) => void
}): ScopedMemoryRouter | null {
  if (input.globalRuntime.mode === 'off') return null
  return makeProtectedScopedMemoryRouter({
    leases: input.leases,
    globalRuntime: () => input.globalRuntime.mode === 'preview'
      ? asScopedMemoryRuntime(input.globalRuntime)
      : null,
    projectRuntime: (projectId) => {
      const runtime = input.projectRuntime(projectId)
      return runtime?.mode === 'preview' ? asScopedMemoryRuntime(runtime) : null
    },
    newFactId: input.newFactId,
    provenanceFor: input.provenanceFor,
    authorizeHumanConfirmedDelete: input.authorizeHumanConfirmedDelete,
    ...(input.emit === undefined ? {} : { emit: input.emit }),
  })
}

/**
 * Builds the complete protected-memory Node composition without exposing it to
 * model tools or replacing legacy Memory. `preview` is intentionally the only
 * enabled mode until the operator approves migration binding and live cutover.
 */
export function makeNodeProtectedMemoryScopeRuntime(input: {
  mode: ProtectedMemoryPreviewMode
  paths: {
    ledger: string
    keyword: string
    semantic: string
    barrier: string
    contentRoot: string
    stagingRoot: string
  }
  operatorId: string
  profileId: string
  scope: ProtectedMemoryScope
  leases: ContextLeaseCoordinator
  descriptor: ProtectedMemorySemanticConfig
  nowIso(): string
  newFactId(): string
  prepareFact?(input: {
    lease: TurnContextLease
    scope: ProtectedMemoryScope
    factId: string
    text: string
    provenance: string
  }): Promise<PreparedMemoryFactMetadata>
  deliverPublicationAuditOnce(event: ProtectedMemoryAuditEvent): Promise<void>
  deliverDeletionAuditOnce(event: ProtectedMemoryDeletionAuditEvent): Promise<void>
  deliverUpdateAuditOnce(event: ProtectedMemoryUpdateAuditEvent): Promise<void>
}): NodeProtectedMemoryScopeRuntime {
  if (input.mode === 'off') return Object.freeze({ mode: 'off' })
  const descriptor = parseProtectedMemorySemanticConfig(input.descriptor)
  const prepareFact: NonNullable<typeof input.prepareFact> = async (request) => {
    const normalized = deriveDeterministicMemoryFactKey(request.text)
    const metadata = input.prepareFact === undefined
      ? {
        validAt: input.nowIso(),
        isHumanConfirmed: false,
        sourceAuthority: null,
        confidence: null,
      }
      : await input.prepareFact(request)
    return {
      ...metadata,
      factKey: normalized.factKey,
      keyTokens: normalized.keyTokens,
    }
  }
  const store = makeProtectedMemorySqliteStore({
    ledgerPath: input.paths.ledger,
    keywordPath: input.paths.keyword,
    operatorId: input.operatorId,
    profileId: input.profileId,
    scope: input.scope,
    startedAt: input.nowIso(),
    deliverAuditOnce: input.deliverPublicationAuditOnce,
    deliverDeletionAuditOnce: input.deliverDeletionAuditOnce,
    deliverUpdateAuditOnce: input.deliverUpdateAuditOnce,
  })
  let semantic: ReturnType<typeof makeSqliteVecSemanticStore> | null = null
  try {
    // The store refuses to invent its own content root — a missing root there
    // could mean an unmounted volume, not a first run. Owning the layout is
    // this composition's job, so create it privately before handing it over.
    mkdirSync(input.paths.contentRoot, { recursive: true, mode: 0o700 })
    const files = makeProtectedMemoryFileStore({
      contentRoot: input.paths.contentRoot,
      stagingRoot: input.paths.stagingRoot,
    })
    const barrier = makeProtectedMemoryScopeBarrier({
      lockPath: input.paths.barrier,
      operatorId: input.operatorId,
      profileId: input.profileId,
      scope: input.scope,
      nowIso: input.nowIso,
    })
    if (descriptor.provider === 'openrouter') {
      semantic = makeSqliteVecSemanticStore({
        dbPath: input.paths.semantic,
        scope: input.scope,
        descriptor: descriptor as EmbeddingDescriptor,
        verifyLive: (record) => store.verifySemanticRecord(record),
      })
    }
    const derived = semantic === null
      ? makeKeywordOnlyDerivedPort(input.scope)
      : makeProtectedMemorySemanticDeletionPort({ scope: input.scope, store: semantic })
    const withScopeExclusive = <T>(
      lease: TurnContextLease,
      scope: ProtectedMemoryScope,
      run: () => Promise<T>,
    ): Promise<T> => barrier.withScopeExclusive(lease, scope, run)
    const publication = makeProtectedMemoryPublicationService({
      leases: input.leases,
      persistence: () => store,
      files: () => files,
      prepareFact,
      withScopeExclusive,
      nowIso: input.nowIso,
    })
    const deletion = makeProtectedMemoryDeletionService({
      leases: input.leases,
      persistence: () => store,
      files: () => files,
      derived: () => derived,
      withScopeExclusive,
      nowIso: input.nowIso,
    })
    const update = makeProtectedMemoryUpdateService({
      leases: input.leases,
      persistence: () => store,
      files: () => files,
      derived: () => derived,
      prepareFact,
      newFactId: input.newFactId,
      withScopeExclusive,
      nowIso: input.nowIso,
    })
    const recovery = makeProtectedMemoryRecoveryGate({
      leases: input.leases,
      persistence: () => store,
      publication,
      deletion,
      update,
      withScopeExclusive,
    })
    let closed = false
    const runtime = {
      mode: 'preview' as const,
      scope: structuredClone(input.scope),
      publication,
      deletion,
      update,
      recovery,
      store,
      files,
      semantic,
      withScopeExclusive<T>(lease: TurnContextLease, run: () => Promise<T>) {
        return withScopeExclusive(lease, input.scope, run)
      },
      close() {
        if (closed) return
        closed = true
        let firstError: unknown
        try {
          try { semantic?.close() } catch (error) { firstError = error }
        } finally {
          try { store.close() } catch (error) { firstError ??= error }
          semantic = null
        }
        if (firstError !== undefined) throw firstError
      },
    }
    return Object.freeze(runtime)
  } catch (error) {
    try {
      try { semantic?.close() } catch { /* preserve the construction error */ }
    } finally {
      try { store.close() } catch { /* preserve the construction error */ }
    }
    throw error
  }
}
