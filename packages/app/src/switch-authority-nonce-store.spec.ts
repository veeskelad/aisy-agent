import { describe, expect, it } from 'vitest'
import { makeSwitchAuthority, type SwitchAuthorityNonceRecord } from '@aisy/core'
import {
  makeJsonSwitchAuthorityNonceStore,
  SwitchAuthorityNonceStoreError,
  type JsonSwitchAuthorityNonceStoreDeps,
} from './switch-authority-nonce-store.js'

const PATH = '/state/switch-authority-nonces.json'
const NOW = Date.parse('2026-07-26T21:00:00.000Z')
const MAC_A = 'a'.repeat(64)
const MAC_B = 'b'.repeat(64)

function record(receiptId: string, mac = MAC_A, offsetMs = 30_000): SwitchAuthorityNonceRecord {
  return {
    receiptId,
    mac,
    expiresAt: new Date(NOW + offsetMs).toISOString(),
  }
}

function memoryFs(initial?: string) {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set(PATH, initial)
  const calls: string[] = []
  let failSync = false
  const deps: JsonSwitchAuthorityNonceStoreDeps = {
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
      if (failSync) throw new Error('fsync failed')
    },
    renameFile: (from, to) => {
      calls.push(`rename:${from}->${to}`)
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    syncDirectory: (path) => { calls.push(`fsync-dir:${path}`) },
    nowMs: () => NOW,
  }
  return {
    calls,
    deps,
    files,
    failNextSync: () => { failSync = true },
  }
}

describe('makeJsonSwitchAuthorityNonceStore', () => {
  it('publishes issue and consume through durable atomic boundaries', () => {
    const fs = memoryFs()
    const store = makeJsonSwitchAuthorityNonceStore(fs.deps)

    store.issue(record('receipt-1'))
    expect(store.has('receipt-1', MAC_A)).toBe(true)
    expect(fs.calls).toEqual([
      `write:${PATH}.tmp`,
      `fsync:${PATH}.tmp`,
      `rename:${PATH}.tmp->${PATH}`,
      'fsync-dir:/state',
    ])

    fs.calls.length = 0
    expect(store.consume('receipt-1', MAC_A)).toBe(true)
    expect(store.has('receipt-1', MAC_A)).toBe(false)
    expect(fs.calls).toEqual([
      `write:${PATH}.tmp`,
      `fsync:${PATH}.tmp`,
      `rename:${PATH}.tmp->${PATH}`,
      'fsync-dir:/state',
    ])
  })

  it('survives restart and never revives a consumed authority receipt', () => {
    const fs = memoryFs()
    const secret = Buffer.alloc(32, 7)
    const first = makeSwitchAuthority({
      secret,
      nowMs: () => NOW,
      newId: () => 'receipt-restart',
      nonces: makeJsonSwitchAuthorityNonceStore(fs.deps),
    })
    const binding = {
      operatorId: 'telegram:42',
      profileId: 'default',
      targetProjectId: 'project-b',
      expectedGeneration: 3,
      sourceMessageHash: 'c'.repeat(64),
    }
    const receipt = first.issue(binding, 30_000)

    const afterIssueRestart = makeSwitchAuthority({
      secret,
      nowMs: () => NOW,
      newId: () => 'unused',
      nonces: makeJsonSwitchAuthorityNonceStore(fs.deps),
    })
    expect(afterIssueRestart.isIssued(receipt)).toBe(true)
    afterIssueRestart.consume(receipt, binding)

    const afterConsumeRestart = makeSwitchAuthority({
      secret,
      nowMs: () => NOW,
      newId: () => 'unused',
      nonces: makeJsonSwitchAuthorityNonceStore(fs.deps),
    })
    expect(afterConsumeRestart.isIssued(receipt)).toBe(false)
    expect(() => afterConsumeRestart.consume(receipt, binding)).toThrowError(
      expect.objectContaining({ code: 'REPLAYED_OR_UNKNOWN' }),
    )
  })

  it('keeps the issued record authoritative when consume fsync fails', () => {
    const fs = memoryFs()
    const store = makeJsonSwitchAuthorityNonceStore(fs.deps)
    store.issue(record('receipt-1'))
    const durableBefore = fs.files.get(PATH)
    fs.failNextSync()

    expect(() => store.consume('receipt-1', MAC_A)).toThrow('fsync failed')
    expect(store.has('receipt-1', MAC_A)).toBe(true)
    expect(fs.files.get(PATH)).toBe(durableBefore)

    const restarted = makeJsonSwitchAuthorityNonceStore({
      ...fs.deps,
      syncFile: () => {},
    })
    expect(restarted.has('receipt-1', MAC_A)).toBe(true)
  })

  it('does not expose a receipt when durable issue publication fails', () => {
    const fs = memoryFs()
    const store = makeJsonSwitchAuthorityNonceStore(fs.deps)
    fs.failNextSync()

    expect(() => store.issue(record('receipt-1'))).toThrow('fsync failed')
    expect(store.has('receipt-1', MAC_A)).toBe(false)
    expect(fs.files.has(PATH)).toBe(false)
    expect(makeJsonSwitchAuthorityNonceStore({
      ...fs.deps,
      syncFile: () => {},
    }).has('receipt-1', MAC_A)).toBe(false)
  })

  it('fails closed on malformed, duplicate, or invalid durable records', () => {
    for (const content of [
      '{',
      JSON.stringify({ version: 2, records: [] }),
      JSON.stringify({ version: 1, records: [{ receiptId: 'x', mac: 'bad', expiresAt: 'never' }] }),
      JSON.stringify({ version: 1, records: [record('same'), record('same', MAC_B)] }),
    ]) {
      expect(() => makeJsonSwitchAuthorityNonceStore(memoryFs(content).deps)).toThrowError(
        expect.objectContaining({ code: 'CORRUPT_NONCE_STORE' }),
      )
    }
  })

  it('rejects duplicate live ids and invalid new records without publishing', () => {
    const fs = memoryFs()
    const store = makeJsonSwitchAuthorityNonceStore(fs.deps)
    store.issue(record('receipt-1'))
    const published = fs.files.get(PATH)

    expect(() => store.issue(record('receipt-1', MAC_B))).toThrowError(
      new SwitchAuthorityNonceStoreError('DUPLICATE_RECEIPT_ID'),
    )
    expect(() => store.issue(record('expired', MAC_B, -1))).toThrowError(
      new SwitchAuthorityNonceStoreError('INVALID_NONCE_RECORD'),
    )
    expect(fs.files.get(PATH)).toBe(published)
  })

  it('never accepts a wrong MAC and prunes expired records on the next issue', () => {
    const initial = JSON.stringify({
      version: 1,
      records: [record('expired', MAC_A, -1)],
    })
    const fs = memoryFs(initial)
    const store = makeJsonSwitchAuthorityNonceStore(fs.deps)

    expect(store.has('expired', MAC_A)).toBe(false)
    store.issue(record('live', MAC_B))
    expect(store.has('live', MAC_A)).toBe(false)
    expect(store.has('live', MAC_B)).toBe(true)
    expect(fs.files.get(PATH)).not.toContain('expired')
  })
})
