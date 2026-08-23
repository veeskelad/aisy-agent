import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { HybridRetrievalHit, HybridRetrievalMode } from './hybrid-retrieval.js'
import type { ContextLeaseCoordinator, TurnContextLease } from './context-lease.js'
import type { ProjectRecordV2 } from './project-registry-v2.js'

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_QUERY_BYTES = 65_536
const MAX_RECEIPT_TTL_MS = 300_000

export interface CrossProjectSearchBinding {
  operatorId: string
  profileId: string
  workspaceProjectId: string
  workspaceSessionId: string
  generation: number
  queryHash: string
  mode: HybridRetrievalMode
  includeArchived: boolean
  limitPerProject: number
}

export interface CrossProjectSearchReceipt extends CrossProjectSearchBinding {
  receiptId: string
  expiresAt: string
  mac: string
}

export interface ExcerptReadBinding {
  operatorId: string
  profileId: string
  workspaceProjectId: string
  workspaceSessionId: string
  generation: number
  projectId: string
  sourcePath: string
  chunkId: string
  contentHash: string
}

export interface ExcerptReadCapability extends ExcerptReadBinding {
  capabilityId: string
  expiresAt: string
  mac: string
}

export interface CrossProjectNonceRecord {
  id: string
  kind: 'search' | 'excerpt'
  mac: string
  expiresAt: string
}

export interface CrossProjectNonceStore {
  issue(record: CrossProjectNonceRecord): void
  consume(id: string, kind: CrossProjectNonceRecord['kind'], mac: string): boolean
}

export interface CrossProjectSearchAuthority {
  issueSearch(input: {
    source: 'operator'
    nested: false
    binding: CrossProjectSearchBinding
    ttlMs: number
  }): CrossProjectSearchReceipt
  consumeSearch(
    receipt: CrossProjectSearchReceipt,
    expected: CrossProjectSearchBinding,
  ): void
  issueExcerpt(binding: ExcerptReadBinding, ttlMs: number): ExcerptReadCapability
  consumeExcerpt(
    capability: ExcerptReadCapability,
    expected: ExcerptReadBinding,
  ): void
}

export interface ProjectSearchHit extends HybridRetrievalHit {
  projectId: string
  projectName: string
  projectRank: number
  readCapability: ExcerptReadCapability
}

export interface CrossProjectSearchIndex {
  search(
    query: string,
    options: { mode: HybridRetrievalMode; limit: number },
  ): Promise<{ hits: HybridRetrievalHit[] }>
}

export interface WorkspaceProjectSearch {
  searchAllProjects(
    workspaceLease: TurnContextLease,
    receipt: CrossProjectSearchReceipt,
    query: string,
    options: {
      mode: HybridRetrievalMode
      includeArchived: boolean
      limitPerProject: number
    },
  ): Promise<ProjectSearchHit[]>
  openSearchHit(
    workspaceLease: TurnContextLease,
    capability: ExcerptReadCapability,
  ): Promise<string>
}

export class CrossProjectSearchError extends Error {
  constructor(public readonly code:
    | 'INVALID_SECRET'
    | 'INVALID_REQUEST'
    | 'OPERATOR_ORIGIN_REQUIRED'
    | 'NESTED_REQUEST_DENIED'
    | 'WORKSPACE_LEASE_REQUIRED'
    | 'BINDING_MISMATCH'
    | 'EXPIRED'
    | 'MAC_INVALID'
    | 'REPLAYED_OR_UNKNOWN'
    | 'PROJECT_LIMIT_EXCEEDED'
    | 'PROJECT_INDEX_UNAVAILABLE'
    | 'CROSS_SCOPE_HIT'
    | 'INVALID_HIT'
    | 'EXCERPT_MISMATCH',
  ) {
    super(code)
    this.name = 'CrossProjectSearchError'
  }
}

function clean(value: unknown, maxBytes = 4096): string {
  if (typeof value !== 'string') throw new CrossProjectSearchError('INVALID_REQUEST')
  const result = value.trim()
  if (result.length === 0 || result.includes('\0') || Buffer.byteLength(result, 'utf8') > maxBytes) {
    throw new CrossProjectSearchError('INVALID_REQUEST')
  }
  return result
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

export function normalizeCrossProjectQuery(query: string): string {
  if (typeof query !== 'string' || query.includes('\0') ||
    Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) {
    throw new CrossProjectSearchError('INVALID_REQUEST')
  }
  const normalized = query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und')
  if (normalized.length === 0) throw new CrossProjectSearchError('INVALID_REQUEST')
  return normalized
}

export function crossProjectQueryHash(query: string): string {
  return createHash('sha256').update(normalizeCrossProjectQuery(query), 'utf8').digest('hex')
}

function validateSearchBinding(raw: CrossProjectSearchBinding): CrossProjectSearchBinding {
  const binding: CrossProjectSearchBinding = {
    operatorId: clean(raw.operatorId),
    profileId: clean(raw.profileId),
    workspaceProjectId: clean(raw.workspaceProjectId),
    workspaceSessionId: clean(raw.workspaceSessionId),
    generation: raw.generation,
    queryHash: raw.queryHash,
    mode: raw.mode,
    includeArchived: raw.includeArchived,
    limitPerProject: raw.limitPerProject,
  }
  if (!Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
    !HASH.test(binding.queryHash) ||
    !['keyword', 'semantic', 'hybrid'].includes(binding.mode) ||
    typeof binding.includeArchived !== 'boolean' ||
    !Number.isSafeInteger(binding.limitPerProject) || binding.limitPerProject < 1 ||
    binding.limitPerProject > 20) {
    throw new CrossProjectSearchError('INVALID_REQUEST')
  }
  return binding
}

function validateExcerptBinding(raw: ExcerptReadBinding): ExcerptReadBinding {
  const binding: ExcerptReadBinding = {
    operatorId: clean(raw.operatorId),
    profileId: clean(raw.profileId),
    workspaceProjectId: clean(raw.workspaceProjectId),
    workspaceSessionId: clean(raw.workspaceSessionId),
    generation: raw.generation,
    projectId: clean(raw.projectId),
    sourcePath: clean(raw.sourcePath, 16_384),
    chunkId: clean(raw.chunkId),
    contentHash: raw.contentHash,
  }
  if (!Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
    !HASH.test(binding.contentHash) || !safeRelativePath(binding.sourcePath)) {
    throw new CrossProjectSearchError('INVALID_REQUEST')
  }
  return binding
}

function safeRelativePath(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false
  const parts = value.split('/')
  return parts.length > 0 && parts.every((part) =>
    part.length > 0 && part !== '.' && part !== '..' &&
    ![...part].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
  )
}

function searchFields(value: CrossProjectSearchBinding): unknown[] {
  return [
    'aisy.cross-project-search.v1', value.operatorId, value.profileId,
    value.workspaceProjectId, value.workspaceSessionId, value.generation,
    value.queryHash, value.mode, value.includeArchived, value.limitPerProject,
  ]
}

function excerptFields(value: ExcerptReadBinding): unknown[] {
  return [
    'aisy.cross-project-excerpt.v1', value.operatorId, value.profileId,
    value.workspaceProjectId, value.workspaceSessionId, value.generation,
    value.projectId, value.sourcePath, value.chunkId, value.contentHash,
  ]
}

function sameFields(left: readonly unknown[], right: readonly unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function safeMacEqual(left: string, right: string): boolean {
  if (!HASH.test(left) || !HASH.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export function makeCrossProjectSearchAuthority(deps: {
  secret: Buffer
  nonces: CrossProjectNonceStore
  nowMs(): number
  newId(): string
}): CrossProjectSearchAuthority {
  if (deps.secret.byteLength < 32) throw new CrossProjectSearchError('INVALID_SECRET')
  const secret = Buffer.from(deps.secret)
  const sign = (kind: 'search' | 'excerpt', fields: readonly unknown[], id: string, expiresAt: string) =>
    createHmac('sha256', secret)
      .update(JSON.stringify([kind, ...fields, id, expiresAt]), 'utf8')
      .digest('hex')
  const expiry = (ttlMs: number): string => {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_RECEIPT_TTL_MS) {
      throw new CrossProjectSearchError('INVALID_REQUEST')
    }
    return new Date(deps.nowMs() + ttlMs).toISOString()
  }
  const id = (): string => {
    const value = clean(deps.newId(), 128)
    if (!ID.test(value)) throw new CrossProjectSearchError('INVALID_REQUEST')
    return value
  }
  const assertUsable = (input: {
    kind: 'search' | 'excerpt'
    id: string
    expiresAt: string
    mac: string
    actualFields: readonly unknown[]
    expectedFields: readonly unknown[]
  }): void => {
    if (!sameFields(input.actualFields, input.expectedFields)) {
      throw new CrossProjectSearchError('BINDING_MISMATCH')
    }
    const expiresMs = Date.parse(input.expiresAt)
    if (!Number.isFinite(expiresMs)) throw new CrossProjectSearchError('INVALID_REQUEST')
    if (deps.nowMs() >= expiresMs) throw new CrossProjectSearchError('EXPIRED')
    const expectedMac = sign(input.kind, input.actualFields, input.id, input.expiresAt)
    if (!safeMacEqual(input.mac, expectedMac)) throw new CrossProjectSearchError('MAC_INVALID')
  }

  return Object.freeze<CrossProjectSearchAuthority>({
    issueSearch(input) {
      if (input.source !== 'operator') {
        throw new CrossProjectSearchError('OPERATOR_ORIGIN_REQUIRED')
      }
      if (input.nested !== false) throw new CrossProjectSearchError('NESTED_REQUEST_DENIED')
      const binding = validateSearchBinding(input.binding)
      const receiptId = id()
      const expiresAt = expiry(input.ttlMs)
      const mac = sign('search', searchFields(binding), receiptId, expiresAt)
      deps.nonces.issue({ id: receiptId, kind: 'search', mac, expiresAt })
      return Object.freeze({ ...binding, receiptId, expiresAt, mac })
    },

    consumeSearch(receipt, rawExpected) {
      const actual = validateSearchBinding(receipt)
      const expected = validateSearchBinding(rawExpected)
      assertUsable({
        kind: 'search',
        id: clean(receipt.receiptId, 128),
        expiresAt: receipt.expiresAt,
        mac: receipt.mac,
        actualFields: searchFields(actual),
        expectedFields: searchFields(expected),
      })
      if (!deps.nonces.consume(receipt.receiptId, 'search', receipt.mac)) {
        throw new CrossProjectSearchError('REPLAYED_OR_UNKNOWN')
      }
    },

    issueExcerpt(rawBinding, ttlMs) {
      const binding = validateExcerptBinding(rawBinding)
      const capabilityId = id()
      const expiresAt = expiry(ttlMs)
      const mac = sign('excerpt', excerptFields(binding), capabilityId, expiresAt)
      deps.nonces.issue({ id: capabilityId, kind: 'excerpt', mac, expiresAt })
      return Object.freeze({ ...binding, capabilityId, expiresAt, mac })
    },

    consumeExcerpt(capability, rawExpected) {
      const actual = validateExcerptBinding(capability)
      const expected = validateExcerptBinding(rawExpected)
      assertUsable({
        kind: 'excerpt',
        id: clean(capability.capabilityId, 128),
        expiresAt: capability.expiresAt,
        mac: capability.mac,
        actualFields: excerptFields(actual),
        expectedFields: excerptFields(expected),
      })
      if (!deps.nonces.consume(capability.capabilityId, 'excerpt', capability.mac)) {
        throw new CrossProjectSearchError('REPLAYED_OR_UNKNOWN')
      }
    },
  })
}

function leaseSearchBinding(
  lease: TurnContextLease,
  query: string,
  options: { mode: HybridRetrievalMode; includeArchived: boolean; limitPerProject: number },
): CrossProjectSearchBinding {
  return validateSearchBinding({
    operatorId: lease.operatorId,
    profileId: lease.profileId,
    workspaceProjectId: lease.projectId,
    workspaceSessionId: lease.sessionId,
    generation: lease.generation,
    queryHash: crossProjectQueryHash(query),
    mode: options.mode,
    includeArchived: options.includeArchived,
    limitPerProject: options.limitPerProject,
  })
}

function leaseExcerptBinding(
  lease: TurnContextLease,
  input: Pick<ExcerptReadBinding, 'projectId' | 'sourcePath' | 'chunkId' | 'contentHash'>,
): ExcerptReadBinding {
  return validateExcerptBinding({
    operatorId: lease.operatorId,
    profileId: lease.profileId,
    workspaceProjectId: lease.projectId,
    workspaceSessionId: lease.sessionId,
    generation: lease.generation,
    ...input,
  })
}

function validateProjectHit(project: ProjectRecordV2, hit: HybridRetrievalHit): void {
  if (hit.scope !== 'project' || hit.scopeId !== `project:${project.id}` ||
    hit.projectId !== project.id) {
    throw new CrossProjectSearchError('CROSS_SCOPE_HIT')
  }
  if ([hit.hitId, hit.sourcePath, hit.chunkId, hit.provenance]
    .some((value) => typeof value !== 'string' || value.length === 0) ||
    hit.sourcePath !== hit.sourcePath.trim() || hit.chunkId !== hit.chunkId.trim() ||
    !safeRelativePath(hit.sourcePath) || !HASH.test(hit.contentHash) ||
    !Number.isFinite(hit.score)) {
    throw new CrossProjectSearchError('INVALID_HIT')
  }
}

export function makeWorkspaceProjectSearch(deps: {
  leases: Pick<ContextLeaseCoordinator, 'reserveOperation'>
  authority: CrossProjectSearchAuthority
  listProjects(owner: { operatorId: string; profileId: string }, includeArchived: boolean): ProjectRecordV2[]
  projectIndex(projectId: string): CrossProjectSearchIndex | null
  readExcerpt(input: {
    projectId: string
    sourcePath: string
    chunkId: string
    contentHash: string
  }): Promise<{ content: string; contentHash: string }>
  maxProjects: number
  maxExcerptBytes: number
  capabilityTtlMs: number
}): WorkspaceProjectSearch {
  if (!Number.isSafeInteger(deps.maxProjects) || deps.maxProjects < 1 ||
    deps.maxProjects > 1_000 || !Number.isSafeInteger(deps.maxExcerptBytes) ||
    deps.maxExcerptBytes < 1 || deps.maxExcerptBytes > 1_048_576 ||
    !Number.isSafeInteger(deps.capabilityTtlMs) || deps.capabilityTtlMs < 1 ||
    deps.capabilityTtlMs > MAX_RECEIPT_TTL_MS) {
    throw new CrossProjectSearchError('INVALID_REQUEST')
  }
  const workspaceOnly = (lease: TurnContextLease): void => {
    if (lease.projectKind !== 'workspace') {
      throw new CrossProjectSearchError('WORKSPACE_LEASE_REQUIRED')
    }
  }

  return Object.freeze<WorkspaceProjectSearch>({
    async searchAllProjects(lease, receipt, query, options) {
      workspaceOnly(lease)
      const expected = leaseSearchBinding(lease, query, options)
      const operation = deps.leases.reserveOperation(lease)
      try {
        operation.beginIo()
        deps.authority.consumeSearch(receipt, expected)
        const projects = deps.listProjects({
          operatorId: lease.operatorId,
          profileId: lease.profileId,
        }, options.includeArchived)
          .filter((project) => project.kind === 'project' &&
            (options.includeArchived || project.archivedAt === undefined))
          .sort((left, right) => bytewise(left.id, right.id))
        if (projects.some((project, index) =>
          project.operatorId !== lease.operatorId || project.profileId !== lease.profileId ||
          (index > 0 && projects[index - 1]!.id === project.id))) {
          throw new CrossProjectSearchError('BINDING_MISMATCH')
        }
        if (projects.length > deps.maxProjects) {
          throw new CrossProjectSearchError('PROJECT_LIMIT_EXCEEDED')
        }
        const perProject = await Promise.all(projects.map(async (project) => {
          const index = deps.projectIndex(project.id)
          if (index === null) throw new CrossProjectSearchError('PROJECT_INDEX_UNAVAILABLE')
          let result: Awaited<ReturnType<CrossProjectSearchIndex['search']>>
          try {
            result = await index.search(query, {
              mode: options.mode,
              limit: options.limitPerProject,
            })
          } catch (error) {
            if (error instanceof CrossProjectSearchError) throw error
            throw new CrossProjectSearchError('PROJECT_INDEX_UNAVAILABLE')
          }
          if (!Array.isArray(result.hits) || result.hits.length > options.limitPerProject) {
            throw new CrossProjectSearchError('INVALID_HIT')
          }
          const hitKeys = new Set<string>()
          return result.hits.map((hit, index): ProjectSearchHit => {
            validateProjectHit(project, hit)
            const hitKey = `${hit.sourcePath}\0${hit.chunkId}`
            if (hitKeys.has(hitKey)) throw new CrossProjectSearchError('INVALID_HIT')
            hitKeys.add(hitKey)
            const binding = leaseExcerptBinding(lease, {
              projectId: project.id,
              sourcePath: hit.sourcePath,
              chunkId: hit.chunkId,
              contentHash: hit.contentHash,
            })
            return Object.freeze({
              ...hit,
              projectId: project.id,
              projectName: project.name,
              projectRank: index + 1,
              readCapability: deps.authority.issueExcerpt(binding, deps.capabilityTtlMs),
            })
          })
        }))
        return perProject.flat().sort((left, right) =>
          left.projectRank - right.projectRank || bytewise(left.projectId, right.projectId) ||
          bytewise(left.sourcePath, right.sourcePath) || bytewise(left.chunkId, right.chunkId),
        )
      } finally {
        operation.complete()
      }
    },

    async openSearchHit(lease, capability) {
      workspaceOnly(lease)
      const expected = leaseExcerptBinding(lease, capability)
      const operation = deps.leases.reserveOperation(lease)
      try {
        operation.beginIo()
        deps.authority.consumeExcerpt(capability, expected)
        const excerpt = await deps.readExcerpt({
          projectId: expected.projectId,
          sourcePath: expected.sourcePath,
          chunkId: expected.chunkId,
          contentHash: expected.contentHash,
        })
        if (excerpt.contentHash !== expected.contentHash ||
          sha256Text(excerpt.content) !== expected.contentHash ||
          Buffer.byteLength(excerpt.content, 'utf8') > deps.maxExcerptBytes) {
          throw new CrossProjectSearchError('EXCERPT_MISMATCH')
        }
        return excerpt.content
      } finally {
        operation.complete()
      }
    },
  })
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
