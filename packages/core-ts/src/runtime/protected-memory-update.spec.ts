import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  parseProtectedMemoryUpdateAuditEvent,
  parseProtectedMemoryUpdateWal,
  type ProtectedMemoryUpdateAuditEvent,
  type ProtectedMemoryUpdateWalV1,
} from './protected-memory-update.js'
import type { ProtectedMemoryFactRecordV2, ProtectedMemoryScope } from './protected-memory-publication.js'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const scope: ProtectedMemoryScope = {
  kind: 'project', scopeId: 'project:project-a', projectId: 'project-a',
}

function fact(input: {
  id: string
  operationId: string
  text: string
  factKey: string
  published: boolean
  supersedes?: string
}): ProtectedMemoryFactRecordV2 {
  return {
    schemaVersion: 2,
    operationId: input.operationId,
    id: input.id,
    operatorId: 'telegram:42',
    profileId: 'default',
    scope,
    text: input.text,
    factKey: input.factKey,
    keyTokens: input.id === 'old-fact' ? ['old'] : ['new'],
    validAt: '2026-07-27T07:00:00.000Z',
    invalidAt: null,
    isHumanConfirmed: false,
    sourceAuthority: 50,
    confidence: 0.9,
    provenance: `session:session-a:${input.id}`,
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    sourcePath: `memory/facts/${sha256(input.id)}.md`,
    contentHash: sha256(input.text),
    published: input.published,
  }
}

const target = fact({
  id: 'old-fact', operationId: sha256('old-operation'), text: 'old',
  factKey: sha256('old'), published: true,
})
const operationId = sha256('update-operation')
const replacement = fact({
  id: 'new-fact', operationId, text: 'new', factKey: sha256('new'),
  published: false, supersedes: target.factKey,
})
const wal: ProtectedMemoryUpdateWalV1 = {
  schemaVersion: 1,
  operationId,
  operatorId: target.operatorId,
  profileId: target.profileId,
  sessionId: 'session-a',
  generation: 7,
  scope,
  phase: 'PREPARED',
  target,
  fact: replacement,
  supersededAt: '2026-07-27T07:04:00.000Z',
  createdAt: '2026-07-27T07:04:00.000Z',
  updatedAt: '2026-07-27T07:04:00.000Z',
}
const audit: ProtectedMemoryUpdateAuditEvent = {
  eventId: operationId,
  kind: 'memory.superseded',
  operationId,
  operatorId: target.operatorId,
  profileId: target.profileId,
  scopeId: scope.scopeId,
  projectId: scope.projectId,
  sessionId: 'session-a',
  previousOperationId: target.operationId,
  previousFactId: target.id,
  previousFactKey: target.factKey,
  previousSourcePath: target.sourcePath,
  previousContentHash: target.contentHash,
  factId: replacement.id,
  factKey: replacement.factKey,
  sourcePath: replacement.sourcePath,
  contentHash: replacement.contentHash,
  provenance: replacement.provenance,
  supersededAt: wal.supersededAt,
  ts: wal.createdAt,
}

describe('protected memory update schemas', () => {
  it('accepts only the exact update WAL schema and target relation', () => {
    expect(parseProtectedMemoryUpdateWal(wal)).toEqual(wal)
    expect(parseProtectedMemoryUpdateWal({ ...wal, trusted: true })).toBeNull()
    expect(parseProtectedMemoryUpdateWal({ ...wal, phase: 'DONE' })).toBeNull()
    expect(parseProtectedMemoryUpdateWal({
      ...wal,
      fact: { ...wal.fact, supersedes: sha256('foreign') },
    })).toBeNull()
  })

  it('accepts only an exact, scope-bound supersede audit event', () => {
    expect(parseProtectedMemoryUpdateAuditEvent(audit)).toEqual(audit)
    expect(parseProtectedMemoryUpdateAuditEvent({ ...audit, kind: 'memory.committed' })).toBeNull()
    expect(parseProtectedMemoryUpdateAuditEvent({ ...audit, projectId: 'project-b' })).toBeNull()
    expect(parseProtectedMemoryUpdateAuditEvent({ ...audit, extra: true })).toBeNull()
  })
})
