import { describe, expect, it } from 'vitest'
import {
  makeCrossProjectSearchAuthority,
  type CrossProjectNonceRecord,
  type CrossProjectSearchBinding,
} from '@aisy/core'
import {
  CrossProjectNonceStoreError,
  makeJsonCrossProjectNonceStore,
  type JsonCrossProjectNonceStoreDeps,
} from './cross-project-nonce-store.js'

const PATH = '/state/cross-project-nonces.json'
const NOW = Date.parse('2026-07-27T12:00:00.000Z')

function memoryFs(initial?: string) {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set(PATH, initial)
  const calls: string[] = []
  const deps: JsonCrossProjectNonceStoreDeps = {
    path: PATH,
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) ?? '',
    writeFileExclusive: (path, content) => {
      if (files.has(path)) throw new Error('exclusive temp exists')
      calls.push(`write:${path}`)
      files.set(path, content)
    },
    syncFile: (path) => calls.push(`fsync:${path}`),
    renameFile: (from, to) => {
      calls.push(`rename:${from}->${to}`)
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    syncDirectory: (path) => calls.push(`fsync-dir:${path}`),
    nowMs: () => NOW,
  }
  return { calls, deps, files }
}

function binding(): CrossProjectSearchBinding {
  return {
    operatorId: 'telegram:42',
    profileId: 'default',
    workspaceProjectId: 'workspace-1',
    workspaceSessionId: 'session-1',
    generation: 7,
    queryHash: 'a'.repeat(64),
    mode: 'hybrid',
    includeArchived: false,
    limitPerProject: 10,
  }
}

describe('JsonCrossProjectNonceStore', () => {
  it('publishes issue and consume through atomic durable boundaries', () => {
    const fs = memoryFs()
    const store = makeJsonCrossProjectNonceStore(fs.deps)
    const record: CrossProjectNonceRecord = {
      id: 'receipt-1',
      kind: 'search',
      mac: 'a'.repeat(64),
      expiresAt: new Date(NOW + 30_000).toISOString(),
    }

    store.issue(record)
    expect(store.consume(record.id, record.kind, record.mac)).toBe(true)
    expect(store.consume(record.id, record.kind, record.mac)).toBe(false)
    expect(fs.calls).toEqual([
      `write:${PATH}.tmp`, `fsync:${PATH}.tmp`, `rename:${PATH}.tmp->${PATH}`,
      'fsync-dir:/state',
      `write:${PATH}.tmp`, `fsync:${PATH}.tmp`, `rename:${PATH}.tmp->${PATH}`,
      'fsync-dir:/state',
    ])
  })

  it('keeps search receipt and excerpt capability one-use across process restarts', () => {
    const fs = memoryFs()
    const secret = Buffer.alloc(32, 4)
    let id = 0
    const authority = () => makeCrossProjectSearchAuthority({
      secret,
      nowMs: () => NOW,
      newId: () => `nonce-${++id}`,
      nonces: makeJsonCrossProjectNonceStore(fs.deps),
    })
    const first = authority()
    const receipt = first.issueSearch({
      source: 'operator', nested: false, binding: binding(), ttlMs: 30_000,
    })
    const capability = first.issueExcerpt({
      operatorId: 'telegram:42',
      profileId: 'default',
      workspaceProjectId: 'workspace-1',
      workspaceSessionId: 'session-1',
      generation: 7,
      projectId: 'project-a',
      sourcePath: 'docs/a.md',
      chunkId: 'chunk-1',
      contentHash: 'b'.repeat(64),
    }, 30_000)

    const afterIssueRestart = authority()
    afterIssueRestart.consumeSearch(receipt, binding())
    afterIssueRestart.consumeExcerpt(capability, capability)

    const afterConsumeRestart = authority()
    expect(() => afterConsumeRestart.consumeSearch(receipt, binding())).toThrowError(
      expect.objectContaining({ code: 'REPLAYED_OR_UNKNOWN' }),
    )
    expect(() => afterConsumeRestart.consumeExcerpt(capability, capability)).toThrowError(
      expect.objectContaining({ code: 'REPLAYED_OR_UNKNOWN' }),
    )
  })

  it('keeps search and excerpt namespaces distinct even for the same id', () => {
    const fs = memoryFs()
    const store = makeJsonCrossProjectNonceStore(fs.deps)
    const expiresAt = new Date(NOW + 30_000).toISOString()
    store.issue({ id: 'same', kind: 'search', mac: 'a'.repeat(64), expiresAt })
    store.issue({ id: 'same', kind: 'excerpt', mac: 'b'.repeat(64), expiresAt })

    expect(store.consume('same', 'search', 'b'.repeat(64))).toBe(false)
    expect(store.consume('same', 'excerpt', 'b'.repeat(64))).toBe(true)
    expect(store.consume('same', 'search', 'a'.repeat(64))).toBe(true)
  })

  it('fails closed on malformed or duplicate durable state', () => {
    const valid = {
      id: 'same', kind: 'search', mac: 'a'.repeat(64),
      expiresAt: new Date(NOW + 30_000).toISOString(),
    }
    for (const content of [
      '{',
      JSON.stringify({ version: 2, records: [] }),
      JSON.stringify({ version: 1, records: [{ ...valid, extra: true }] }),
      JSON.stringify({ version: 1, records: [valid, valid] }),
    ]) {
      expect(() => makeJsonCrossProjectNonceStore(memoryFs(content).deps)).toThrowError(
        expect.objectContaining({ code: 'CORRUPT_NONCE_STORE' }),
      )
    }
  })

  it('rejects expired and duplicate live nonce records without widening state', () => {
    const fs = memoryFs()
    const store = makeJsonCrossProjectNonceStore(fs.deps)
    const live: CrossProjectNonceRecord = {
      id: 'same', kind: 'search', mac: 'a'.repeat(64),
      expiresAt: new Date(NOW + 30_000).toISOString(),
    }
    store.issue(live)
    const durable = fs.files.get(PATH)

    expect(() => store.issue({ ...live, mac: 'b'.repeat(64) })).toThrowError(
      new CrossProjectNonceStoreError('DUPLICATE_NONCE_ID'),
    )
    expect(() => store.issue({
      ...live, id: 'expired', expiresAt: new Date(NOW - 1).toISOString(),
    })).toThrowError(new CrossProjectNonceStoreError('INVALID_NONCE_RECORD'))
    expect(fs.files.get(PATH)).toBe(durable)
  })
})
