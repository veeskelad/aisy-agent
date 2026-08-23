import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeJsonMemoryPermanenceNonceStore,
  makeNodeMemoryPermanenceNonceStore,
  MemoryPermanenceNonceStoreError,
  type JsonMemoryPermanenceNonceStoreDeps,
} from './memory-permanence-nonce-store.js'

const PATH = '/state/memory-permanence-nonces.json'
const NOW = Date.parse('2026-07-27T12:00:00.000Z')
const MAC_A = 'a'.repeat(64)
const MAC_B = 'b'.repeat(64)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function record(receiptId: string, mac = MAC_A, offsetMs = 60_000) {
  return { receiptId, mac, expiresAt: new Date(NOW + offsetMs).toISOString() }
}

function memoryFs(initial?: string) {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set(PATH, initial)
  const calls: string[] = []
  let failAt: 'file' | 'directory' | undefined
  const deps: JsonMemoryPermanenceNonceStoreDeps = {
    path: PATH,
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) ?? '',
    writeFileExclusive: (path, content) => {
      if (files.has(path)) throw new Error('exclusive temp exists')
      calls.push(`write:${path}`)
      files.set(path, content)
    },
    syncFile: (path) => {
      calls.push(`fsync:${path}`)
      if (failAt === 'file') throw new Error('file fsync failed')
    },
    renameFile: (from, to) => {
      calls.push(`rename:${from}->${to}`)
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    syncDirectory: (path) => {
      calls.push(`fsync-dir:${path}`)
      if (failAt === 'directory') throw new Error('directory fsync failed')
    },
    nowMs: () => NOW,
  }
  return {
    calls,
    deps,
    files,
    failNext: (where: 'file' | 'directory') => { failAt = where },
  }
}

describe('MemoryPermanenceNonceStore', () => {
  it('durably publishes issue then a retained consumed tombstone', () => {
    const fs = memoryFs()
    const store = makeJsonMemoryPermanenceNonceStore(fs.deps)

    store.issue(record('receipt-a'))
    expect(fs.calls).toEqual([
      `write:${PATH}.tmp`,
      `fsync:${PATH}.tmp`,
      `rename:${PATH}.tmp->${PATH}`,
      'fsync-dir:/state',
    ])

    fs.calls.length = 0
    expect(store.consume('receipt-a', MAC_A)).toBe(true)
    expect(store.consume('receipt-a', MAC_A)).toBe(false)
    expect(fs.calls).toEqual([
      `write:${PATH}.tmp`,
      `fsync:${PATH}.tmp`,
      `rename:${PATH}.tmp->${PATH}`,
      'fsync-dir:/state',
    ])
    expect(JSON.parse(fs.files.get(PATH) ?? '{}')).toEqual({
      version: 1,
      records: [{
        ...record('receipt-a'),
        status: 'consumed',
        consumedAt: new Date(NOW).toISOString(),
      }],
    })
  })

  it('survives restart and never revives or reissues a consumed live receipt', () => {
    const fs = memoryFs()
    const first = makeJsonMemoryPermanenceNonceStore(fs.deps)
    first.issue(record('receipt-a'))
    expect(first.consume('receipt-a', MAC_A)).toBe(true)

    const restarted = makeJsonMemoryPermanenceNonceStore(fs.deps)
    expect(restarted.consume('receipt-a', MAC_A)).toBe(false)
    expect(() => restarted.issue(record('receipt-a', MAC_B))).toThrowError(
      new MemoryPermanenceNonceStoreError('DUPLICATE_RECEIPT_ID'),
    )
  })

  it('prunes expired tombstones but never accepts an expired or wrong-MAC receipt', () => {
    const fs = memoryFs(JSON.stringify({
      version: 1,
      records: [{
        ...record('expired', MAC_A, -1),
        status: 'consumed',
        consumedAt: new Date(NOW - 2).toISOString(),
      }],
    }))
    const store = makeJsonMemoryPermanenceNonceStore(fs.deps)
    expect(store.consume('expired', MAC_A)).toBe(false)
    store.issue(record('live', MAC_B))
    expect(store.consume('live', MAC_A)).toBe(false)
    expect(store.consume('live', MAC_B)).toBe(true)
    expect(fs.files.get(PATH)).not.toContain('expired')
  })

  it('does not expose issue before file fsync and stays consumed after post-rename failure', () => {
    const issueFs = memoryFs()
    const issueStore = makeJsonMemoryPermanenceNonceStore(issueFs.deps)
    issueFs.failNext('file')
    expect(() => issueStore.issue(record('receipt-a'))).toThrow('file fsync failed')
    expect(issueFs.files.has(PATH)).toBe(false)

    const consumeFs = memoryFs()
    const consumeStore = makeJsonMemoryPermanenceNonceStore(consumeFs.deps)
    consumeStore.issue(record('receipt-a'))
    consumeFs.failNext('directory')
    expect(() => consumeStore.consume('receipt-a', MAC_A)).toThrow('directory fsync failed')
    expect(consumeStore.consume('receipt-a', MAC_A)).toBe(false)
    expect(makeJsonMemoryPermanenceNonceStore({
      ...consumeFs.deps,
      syncDirectory: () => {},
    }).consume('receipt-a', MAC_A)).toBe(false)
  })

  it('fails closed on malformed schema, extra keys, duplicate ids, and oversized state', () => {
    const candidates = [
      '{',
      JSON.stringify({ version: 2, records: [] }),
      JSON.stringify({ version: 1, records: [{ ...record('a'), status: 'unknown' }] }),
      JSON.stringify({ version: 1, records: [{ ...record('a'), status: 'issued', extra: true }] }),
      JSON.stringify({ version: 1, records: [
        { ...record('same'), status: 'issued' },
        { ...record('same', MAC_B), status: 'issued' },
      ] }),
      ' '.repeat(4 * 1024 * 1024 + 1),
    ]
    for (const content of candidates) {
      expect(() => makeJsonMemoryPermanenceNonceStore(memoryFs(content).deps)).toThrowError(
        expect.objectContaining({ code: 'CORRUPT_NONCE_STORE' }),
      )
    }
  })

  it('rejects invalid new records and clocks without publishing', () => {
    const fs = memoryFs()
    const store = makeJsonMemoryPermanenceNonceStore(fs.deps)
    expect(() => store.issue(record('bad id'))).toThrowError(
      expect.objectContaining({ code: 'INVALID_NONCE_RECORD' }),
    )
    expect(() => store.issue(record('expired', MAC_A, -1))).toThrowError(
      expect.objectContaining({ code: 'INVALID_NONCE_RECORD' }),
    )
    const badClock = makeJsonMemoryPermanenceNonceStore({ ...fs.deps, nowMs: () => Number.NaN })
    expect(() => badClock.issue(record('clock'))).toThrowError(
      expect.objectContaining({ code: 'INVALID_NONCE_RECORD' }),
    )
    expect(fs.files.has(PATH)).toBe(false)
  })

  it('uses private durable node paths and rejects symlinked or public state', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-memory-permanence-')))
    roots.push(root)
    const path = join(root, 'private', 'nonces.json')
    const store = makeNodeMemoryPermanenceNonceStore({ path, nowMs: () => NOW })
    store.issue(record('receipt-a'))
    expect(store.consume('receipt-a', MAC_A)).toBe(true)
    expect(statSync(join(root, 'private')).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toContain('"status": "consumed"')

    const outside = join(root, 'outside.json')
    writeFileSync(outside, '{}', { mode: 0o600 })
    const linked = join(root, 'linked.json')
    symlinkSync(outside, linked)
    expect(() => makeNodeMemoryPermanenceNonceStore({ path: linked })).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_STORE_PATH' }),
    )

    const publicPath = join(root, 'public.json')
    writeFileSync(publicPath, JSON.stringify({ version: 1, records: [] }), { mode: 0o644 })
    chmodSync(publicPath, 0o644)
    expect(() => makeNodeMemoryPermanenceNonceStore({ path: publicPath })).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_STORE_PATH' }),
    )
  })
})
