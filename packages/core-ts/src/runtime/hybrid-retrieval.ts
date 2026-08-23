import { createHash } from 'node:crypto'

export const HYBRID_LEG_CAP = 20
export const HYBRID_RRF_K = 60

export type HybridRetrievalMode = 'keyword' | 'semantic' | 'hybrid'

export type RetrievalScope =
  | { kind: 'global'; scopeId: 'global' }
  | { kind: 'project'; scopeId: `project:${string}`; projectId: string }
  | { kind: 'monitoring'; scopeId: `monitoring:${string}`; monitorId: string }

export interface ScopedRetrievalCandidate {
  hitId: string
  scope: RetrievalScope['kind']
  scopeId: string
  projectId?: string
  sourcePath: string
  chunkId: string
  contentHash: string
  provenance: string
  score: number
}

export interface HybridRetrievalHit extends ScopedRetrievalCandidate {
  score: number
  componentRanks: Readonly<{
    keyword?: number
    semantic?: number
  }>
}

export type HybridRetrievalStatus =
  | 'OK'
  | 'SEMANTIC_UNAVAILABLE'
  | 'SENSITIVE_INPUT_LOCAL_ONLY'

export interface HybridRetrievalResult {
  requestedMode: HybridRetrievalMode
  effectiveMode: HybridRetrievalMode | 'none'
  status: HybridRetrievalStatus
  hits: HybridRetrievalHit[]
}

export interface KeywordRetrievalLeg {
  search(
    scope: RetrievalScope,
    query: string,
    options: { limit: number },
  ): Promise<ScopedRetrievalCandidate[]>
}

export interface SemanticRetrievalLeg {
  availability(scope: RetrievalScope): Promise<'healthy' | 'unavailable' | 'revoked'>
  search(
    scope: RetrievalScope,
    query: string,
    options: { limit: number },
  ): Promise<ScopedRetrievalCandidate[]>
}

export interface HybridRetrievalEvent {
  kind: 'memory.semantic_degraded' | 'memory.embedding_input_blocked'
  scopeId: string
  status: Exclude<HybridRetrievalStatus, 'OK'>
}

export class HybridRetrievalIntegrityError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_SCOPE'
      | 'CROSS_SCOPE_HIT'
      | 'INVALID_HIT'
      | 'DUPLICATE_HIT'
      | 'CONFLICTING_HIT'
      | 'DERIVED_FILTER_VIOLATION'
      | 'DERIVED_INDEX_CORRUPT',
  ) {
    super(code)
    this.name = 'HybridRetrievalIntegrityError'
  }
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function stableHitOrder(left: ScopedRetrievalCandidate, right: ScopedRetrievalCandidate): number {
  return bytewise(left.scopeId, right.scopeId) ||
    bytewise(left.sourcePath, right.sourcePath) ||
    bytewise(left.chunkId, right.chunkId)
}

function scopeIsValid(scope: RetrievalScope): boolean {
  if (scope.kind === 'global') return scope.scopeId === 'global'
  if (scope.kind === 'project') {
    return scope.projectId.length > 0 && scope.scopeId === `project:${scope.projectId}`
  }
  return scope.monitorId.length > 0 && scope.scopeId === `monitoring:${scope.monitorId}`
}

function candidateKey(hit: ScopedRetrievalCandidate): string {
  return [hit.scopeId, hit.sourcePath, hit.chunkId]
    .map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`)
    .join('|')
}

function validateCandidates(
  scope: RetrievalScope,
  hits: readonly ScopedRetrievalCandidate[],
): ScopedRetrievalCandidate[] {
  if (hits.length > HYBRID_LEG_CAP) {
    throw new HybridRetrievalIntegrityError('INVALID_HIT')
  }
  const seen = new Set<string>()
  return hits.map((source) => {
    if (source.scope !== scope.kind || source.scopeId !== scope.scopeId ||
      (scope.kind === 'project' && source.projectId !== scope.projectId) ||
      (scope.kind !== 'project' && source.projectId !== undefined)) {
      throw new HybridRetrievalIntegrityError('CROSS_SCOPE_HIT')
    }
    if ([source.hitId, source.sourcePath, source.chunkId, source.contentHash, source.provenance]
      .some((value) => value.length === 0) || !Number.isFinite(source.score)) {
      throw new HybridRetrievalIntegrityError('INVALID_HIT')
    }
    const key = candidateKey(source)
    if (seen.has(key)) throw new HybridRetrievalIntegrityError('DUPLICATE_HIT')
    seen.add(key)
    return Object.freeze({ ...source })
  })
}

function sameMetadata(left: ScopedRetrievalCandidate, right: ScopedRetrievalCandidate): boolean {
  return left.hitId === right.hitId && left.scope === right.scope &&
    left.projectId === right.projectId && left.contentHash === right.contentHash &&
    left.provenance === right.provenance
}

export function reciprocalRankFusion(
  keyword: readonly ScopedRetrievalCandidate[],
  semantic: readonly ScopedRetrievalCandidate[],
  options: { limit?: number; k?: number } = {},
): HybridRetrievalHit[] {
  const k = options.k ?? HYBRID_RRF_K
  const limit = options.limit ?? HYBRID_LEG_CAP
  if (!Number.isInteger(k) || k < 1 || !Number.isInteger(limit) || limit < 1 ||
    limit > HYBRID_LEG_CAP || keyword.length > HYBRID_LEG_CAP ||
    semantic.length > HYBRID_LEG_CAP) {
    throw new RangeError('invalid RRF bounds')
  }
  const fused = new Map<string, {
    hit: ScopedRetrievalCandidate
    score: number
    keyword?: number
    semantic?: number
  }>()
  const add = (leg: 'keyword' | 'semantic', hits: readonly ScopedRetrievalCandidate[]): void => {
    const seen = new Set<string>()
    hits.forEach((hit, index) => {
      const rank = index + 1
      const key = candidateKey(hit)
      if (seen.has(key)) throw new HybridRetrievalIntegrityError('DUPLICATE_HIT')
      seen.add(key)
      const current = fused.get(key)
      if (current && !sameMetadata(current.hit, hit)) {
        throw new HybridRetrievalIntegrityError('CONFLICTING_HIT')
      }
      const entry = current ?? { hit, score: 0 }
      entry.score += 1 / (k + rank)
      entry[leg] = rank
      fused.set(key, entry)
    })
  }
  add('keyword', keyword)
  add('semantic', semantic)

  return [...fused.values()]
    .sort((left, right) => {
      const bestLeft = Math.min(left.keyword ?? Number.POSITIVE_INFINITY, left.semantic ?? Number.POSITIVE_INFINITY)
      const bestRight = Math.min(right.keyword ?? Number.POSITIVE_INFINITY, right.semantic ?? Number.POSITIVE_INFINITY)
      return right.score - left.score || bestLeft - bestRight || stableHitOrder(left.hit, right.hit)
    })
    .slice(0, limit)
    .map((entry) => Object.freeze({
      ...entry.hit,
      score: entry.score,
      componentRanks: Object.freeze({
        ...(entry.keyword === undefined ? {} : { keyword: entry.keyword }),
        ...(entry.semantic === undefined ? {} : { semantic: entry.semantic }),
      }),
    }))
}

export type EmbeddingSensitivityReason =
  | 'PROTECTED_PATH'
  | 'CREDENTIAL_PATTERN'
  | 'HIGH_ENTROPY_TOKEN'

export interface EmbeddingSensitivityVerdict {
  safe: boolean
  reasons: EmbeddingSensitivityReason[]
}

const PROTECTED_PATH_PARTS = new Set([
  '.env', '.aws', '.kube', '.ssh', 'credentials', 'secrets', 'vault.json',
  'id_rsa', 'id_ed25519', 'private-key',
])

const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/,
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*\S+/i,
]

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let result = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    result -= probability * Math.log2(probability)
  }
  return result
}

function looksHighEntropy(value: string): boolean {
  if (value.length < 24) return false
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[+/_=-]/]
    .filter((pattern) => pattern.test(value)).length
  return classes >= 3 && shannonEntropy(value) >= 4
}

export function scanEmbeddingInput(input: {
  content: string
  sourcePath?: string
}): EmbeddingSensitivityVerdict {
  const reasons = new Set<EmbeddingSensitivityReason>()
  if (input.sourcePath !== undefined) {
    const parts = input.sourcePath.replaceAll('\\', '/').toLowerCase().split('/')
    if (parts.some((part) => PROTECTED_PATH_PARTS.has(part)) ||
      parts.some((part) => part.endsWith('.key') || part.endsWith('.pem'))) {
      reasons.add('PROTECTED_PATH')
    }
  }
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(input.content))) {
    reasons.add('CREDENTIAL_PATTERN')
  }
  const candidates = input.content.match(/[A-Za-z0-9+/_=-]{24,}/g) ?? []
  if (candidates.some(looksHighEntropy)) reasons.add('HIGH_ENTROPY_TOKEN')
  const ordered = [...reasons].sort()
  return { safe: ordered.length === 0, reasons: ordered }
}

export interface EmbeddingDescriptor {
  provider: string
  modelId: string
  modelRevision: string
  dimensions: number
  normalizationVersion: string
  chunkerVersion: string
}

export interface EmbeddingInput {
  content: string
  contentHash: string
  sourcePath?: string
}

export interface EmbeddingProvider {
  readonly descriptor: Readonly<EmbeddingDescriptor>
  health(): Promise<'healthy' | 'unavailable' | 'revoked'>
  embed(
    kind: 'query' | 'document',
    inputs: readonly EmbeddingInput[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]>
  revoke?(): void
}

export class SensitiveEmbeddingInputError extends Error {
  constructor(
    public readonly blocked: ReadonlyArray<{
      index: number
      reasons: EmbeddingSensitivityReason[]
    }>,
  ) {
    super('SENSITIVE_INPUT_LOCAL_ONLY')
    this.name = 'SensitiveEmbeddingInputError'
  }
}

export function embeddingCacheKey(
  descriptor: EmbeddingDescriptor,
  contentHash: string,
): string {
  const fields: Array<string | number> = [
    descriptor.provider,
    descriptor.modelId,
    descriptor.modelRevision,
    descriptor.dimensions,
    descriptor.normalizationVersion,
    descriptor.chunkerVersion,
    contentHash,
  ]
  return createHash('sha256').update(JSON.stringify(fields), 'utf8').digest('hex')
}

/** Blocks sensitive content before the wrapped provider and validates vectors. */
export function makeSensitiveEmbeddingProvider(input: {
  provider: EmbeddingProvider
  scan?: typeof scanEmbeddingInput
  emit?: (event: HybridRetrievalEvent) => void
}): EmbeddingProvider {
  const descriptor = Object.freeze({ ...input.provider.descriptor })
  if (!Number.isInteger(descriptor.dimensions) || descriptor.dimensions < 1 ||
    [descriptor.provider, descriptor.modelId, descriptor.modelRevision,
      descriptor.normalizationVersion, descriptor.chunkerVersion]
      .some((field) => field.length === 0)) {
    throw new Error('invalid embedding descriptor')
  }
  const scan = input.scan ?? scanEmbeddingInput
  return Object.freeze({
    descriptor,
    health: () => input.provider.health(),
    async embed(
      kind: 'query' | 'document',
      inputs: readonly EmbeddingInput[],
      signal?: AbortSignal,
    ) {
      const snapshot = inputs.map((item) => Object.freeze({ ...item }))
      if (snapshot.some((item) => item.contentHash.length === 0)) {
        throw new Error('invalid embedding input')
      }
      const blocked = snapshot
        .map((item, index) => ({ index, verdict: scan(item) }))
        .filter((item) => !item.verdict.safe)
        .map((item) => ({ index: item.index, reasons: item.verdict.reasons }))
      if (blocked.length > 0) {
        input.emit?.({
          kind: 'memory.embedding_input_blocked',
          scopeId: 'provider-boundary',
          status: 'SENSITIVE_INPUT_LOCAL_ONLY',
        })
        throw new SensitiveEmbeddingInputError(blocked)
      }
      const vectors = await input.provider.embed(kind, snapshot, signal)
      if (vectors.length !== snapshot.length || vectors.some((vector) =>
        vector.length !== descriptor.dimensions || vector.some((value) => !Number.isFinite(value)))) {
        throw new Error('invalid embedding response')
      }
      return vectors.map((vector) => Object.freeze([...vector]))
    },
    ...(input.provider.revoke === undefined
      ? {}
      : { revoke: () => input.provider.revoke?.() }),
  })
}

export function makeHybridRetrieval(input: {
  keyword: KeywordRetrievalLeg
  semantic?: SemanticRetrievalLeg
  scanQuery?: (input: { content: string }) => EmbeddingSensitivityVerdict
  emit?: (event: HybridRetrievalEvent) => void
}) {
  const scanQuery = input.scanQuery ?? scanEmbeddingInput
  const degraded = (
    scope: RetrievalScope,
    status: Exclude<HybridRetrievalStatus, 'OK'>,
  ): void => {
    input.emit?.({
      kind: status === 'SENSITIVE_INPUT_LOCAL_ONLY'
        ? 'memory.embedding_input_blocked'
        : 'memory.semantic_degraded',
      scopeId: scope.scopeId,
      status,
    })
  }

  return Object.freeze({
    async search(
      scope: RetrievalScope,
      query: string,
      options: { mode?: HybridRetrievalMode; limit?: number } = {},
    ): Promise<HybridRetrievalResult> {
      if (!scopeIsValid(scope)) throw new HybridRetrievalIntegrityError('INVALID_SCOPE')
      const mode = options.mode ?? 'hybrid'
      const limit = options.limit ?? HYBRID_LEG_CAP
      if (!Number.isInteger(limit) || limit < 1 || limit > HYBRID_LEG_CAP) {
        throw new RangeError('invalid retrieval limit')
      }
      const keyword = async (): Promise<ScopedRetrievalCandidate[]> => validateCandidates(
        scope,
        await input.keyword.search(scope, query, { limit: HYBRID_LEG_CAP }),
      )
      const sensitive = !scanQuery({ content: query }).safe

      if (mode === 'keyword') {
        const hits = (await keyword()).slice(0, limit).map((hit, index) => Object.freeze({
          ...hit,
          componentRanks: Object.freeze({ keyword: index + 1 }),
        }))
        return { requestedMode: mode, effectiveMode: 'keyword', status: 'OK', hits }
      }
      if (sensitive) {
        degraded(scope, 'SENSITIVE_INPUT_LOCAL_ONLY')
        if (mode === 'semantic') {
          return {
            requestedMode: mode,
            effectiveMode: 'none',
            status: 'SENSITIVE_INPUT_LOCAL_ONLY',
            hits: [],
          }
        }
        const hits = (await keyword()).slice(0, limit).map((hit, index) => Object.freeze({
          ...hit,
          componentRanks: Object.freeze({ keyword: index + 1 }),
        }))
        return {
          requestedMode: mode,
          effectiveMode: 'keyword',
          status: 'SENSITIVE_INPUT_LOCAL_ONLY',
          hits,
        }
      }

      const semantic = input.semantic
      if (semantic === undefined) {
        degraded(scope, 'SEMANTIC_UNAVAILABLE')
        if (mode === 'semantic') {
          return {
            requestedMode: mode,
            effectiveMode: 'none',
            status: 'SEMANTIC_UNAVAILABLE',
            hits: [],
          }
        }
        const hits = (await keyword()).slice(0, limit).map((hit, index) => Object.freeze({
          ...hit,
          componentRanks: Object.freeze({ keyword: index + 1 }),
        }))
        return {
          requestedMode: mode,
          effectiveMode: 'keyword',
          status: 'SEMANTIC_UNAVAILABLE',
          hits,
        }
      }
      let availability: Awaited<ReturnType<SemanticRetrievalLeg['availability']>>
      try {
        availability = await semantic.availability(scope)
      } catch {
        availability = 'unavailable'
      }
      if (availability !== 'healthy') {
        degraded(scope, 'SEMANTIC_UNAVAILABLE')
        if (mode === 'semantic') {
          return {
            requestedMode: mode,
            effectiveMode: 'none',
            status: 'SEMANTIC_UNAVAILABLE',
            hits: [],
          }
        }
        const hits = (await keyword()).slice(0, limit).map((hit, index) => Object.freeze({
          ...hit,
          componentRanks: Object.freeze({ keyword: index + 1 }),
        }))
        return {
          requestedMode: mode,
          effectiveMode: 'keyword',
          status: 'SEMANTIC_UNAVAILABLE',
          hits,
        }
      }

      if (mode === 'semantic') {
        try {
          const hits = validateCandidates(
            scope,
            await semantic.search(scope, query, { limit: HYBRID_LEG_CAP }),
          ).slice(0, limit).map((hit, index) => Object.freeze({
            ...hit,
            componentRanks: Object.freeze({ semantic: index + 1 }),
          }))
          return { requestedMode: mode, effectiveMode: 'semantic', status: 'OK', hits }
        } catch (error) {
          if (error instanceof HybridRetrievalIntegrityError) throw error
          degraded(scope, 'SEMANTIC_UNAVAILABLE')
          return {
            requestedMode: mode,
            effectiveMode: 'none',
            status: 'SEMANTIC_UNAVAILABLE',
            hits: [],
          }
        }
      }

      const [keywordResult, semanticResult] = await Promise.allSettled([
        keyword(),
        semantic.search(scope, query, { limit: HYBRID_LEG_CAP })
          .then((hits) => validateCandidates(scope, hits)),
      ])
      if (keywordResult.status === 'rejected') throw keywordResult.reason
      if (semanticResult.status === 'rejected') {
        if (semanticResult.reason instanceof HybridRetrievalIntegrityError) {
          throw semanticResult.reason
        }
        degraded(scope, 'SEMANTIC_UNAVAILABLE')
        const hits = keywordResult.value.slice(0, limit).map((hit, index) => Object.freeze({
          ...hit,
          componentRanks: Object.freeze({ keyword: index + 1 }),
        }))
        return {
          requestedMode: mode,
          effectiveMode: 'keyword',
          status: 'SEMANTIC_UNAVAILABLE',
          hits,
        }
      }
      return {
        requestedMode: mode,
        effectiveMode: 'hybrid',
        status: 'OK',
        hits: reciprocalRankFusion(keywordResult.value, semanticResult.value, { limit }),
      }
    },
  })
}
