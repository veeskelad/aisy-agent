import { describe, expect, it } from 'vitest'
import {
  CorruptBrainBootstrapState,
  type BrainBootstrapState,
} from '@aisy/core'
import {
  BrainBootstrapStoreError,
  makeJsonBrainBootstrapStore,
  type JsonBrainBootstrapStoreDeps,
} from './brain-bootstrap-store.js'

const CHOOSE: BrainBootstrapState = {
  version: 1,
  phase: 'CHOOSE_BRAIN',
  revision: 1,
  updatedAt: '2026-07-26T00:00:00.000Z',
}

const VALIDATING: BrainBootstrapState = {
  version: 1,
  phase: 'VALIDATING_AUTH',
  revision: 3,
  updatedAt: '2026-07-26T00:00:01.000Z',
  selectedBrain: {
    connectionId: 'openai-api',
    provider: 'openai',
    authMode: 'api-key',
    runtime: 'native-api',
    status: 'validating',
  },
}

const READY: BrainBootstrapState = {
  ...VALIDATING,
  phase: 'BRAIN_READY',
  revision: 4,
  updatedAt: '2026-07-26T00:00:02.000Z',
  selectedBrain: { ...VALIDATING.selectedBrain!, status: 'ready' },
}

interface FileEntry {
  content: string
  mode: number
}

function harness(initial?: BrainBootstrapState) {
  const files = new Map<string, FileEntry>()
  const directories = new Set(['/state'])
  const symlinks = new Set<string>()
  const operations: string[] = []
  let nonce = 0
  let fail: ((operation: string) => boolean) | undefined
  if (initial !== undefined) {
    files.set('/state/bootstrap.json', {
      content: JSON.stringify(initial, null, 2) + '\n',
      mode: 0o600,
    })
  }

  const record = (operation: string): void => {
    operations.push(operation)
    if (fail?.(operation) === true) throw new Error('injected fault')
  }
  const kind: JsonBrainBootstrapStoreDeps['kind'] = (path) => {
    if (symlinks.has(path)) return 'symlink'
    if (files.has(path)) return 'file'
    if (directories.has(path)) return 'directory'
    return 'missing'
  }
  const deps: JsonBrainBootstrapStoreDeps = {
    path: '/state/bootstrap.json',
    kind,
    mode: (path) => files.get(path)?.mode,
    readFile: (path) => {
      record(`read:${path}`)
      const entry = files.get(path)
      if (!entry) throw new Error('missing')
      return entry.content
    },
    writeFileExclusive: (path, content) => {
      record(`write-exclusive:${path}`)
      if (kind(path) !== 'missing') {
        const error = new Error('exists') as NodeJS.ErrnoException
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, { content, mode: 0o600 })
    },
    syncFile: (path) => record(`sync-file:${path}`),
    renameFile: (from, to) => {
      record(`rename:${from}->${to}`)
      const entry = files.get(from)
      if (!entry) throw new Error('missing source')
      files.set(to, entry)
      files.delete(from)
    },
    syncDirectory: (path) => record(`sync-dir:${path}`),
    removeFile: (path) => {
      record(`remove:${path}`)
      files.delete(path)
      symlinks.delete(path)
    },
    newNonce: () => `nonce-${++nonce}`,
  }
  return {
    deps,
    files,
    operations,
    symlinks,
    store: makeJsonBrainBootstrapStore(deps),
    failOnce(match: (operation: string) => boolean) {
      let used = false
      fail = (operation) => {
        if (used || !match(operation)) return false
        used = true
        return true
      }
    },
  }
}

describe('durable JSON Brain bootstrap store', () => {
  it('returns null without creating state merely by loading', async () => {
    const h = harness()
    await expect(h.store.load()).resolves.toBeNull()
    expect(h.files.size).toBe(0)
  })

  it('loads only exact, private, schema-valid state', async () => {
    const h = harness(READY)
    await expect(h.store.load()).resolves.toEqual(READY)

    h.files.get('/state/bootstrap.json')!.content = JSON.stringify({ ...READY, secret: 'forbidden' })
    await expect(h.store.load()).rejects.toBeInstanceOf(CorruptBrainBootstrapState)

    h.files.get('/state/bootstrap.json')!.content = JSON.stringify(READY)
    h.files.get('/state/bootstrap.json')!.mode = 0o644
    await expect(h.store.load()).rejects.toMatchObject({
      code: 'BRAIN_BOOTSTRAP_UNSAFE_PATH',
    })
  })

  it('publishes revision 1 through exclusive lock, fsync, rename and directory fsync', async () => {
    const h = harness()
    await h.store.save(CHOOSE)

    expect(JSON.parse(h.files.get('/state/bootstrap.json')!.content)).toEqual(CHOOSE)
    expect(h.files.get('/state/bootstrap.json')!.mode).toBe(0o600)
    expect(h.operations).toContain('write-exclusive:/state/bootstrap.json.lock')
    expect(h.operations).toContain('sync-file:/state/bootstrap.json.tmp-nonce-1')
    expect(h.operations).toContain(
      'rename:/state/bootstrap.json.tmp-nonce-1->/state/bootstrap.json',
    )
    expect(h.operations.filter((value) => value === 'sync-dir:/state').length).toBeGreaterThanOrEqual(3)
    expect(h.files.has('/state/bootstrap.json.lock')).toBe(false)
  })

  it('serializes writers and rejects stale or divergent revisions', async () => {
    const held = harness(VALIDATING)
    held.files.set('/state/bootstrap.json.lock', { content: 'foreign\n', mode: 0o600 })
    await expect(held.store.save(READY)).rejects.toMatchObject({
      code: 'BRAIN_BOOTSTRAP_LOCK_HELD',
    })
    expect(JSON.parse(held.files.get('/state/bootstrap.json')!.content)).toEqual(VALIDATING)

    const stale = harness(CHOOSE)
    await expect(stale.store.save(READY)).rejects.toMatchObject({
      code: 'BRAIN_BOOTSTRAP_REVISION_CONFLICT',
    })
  })

  it.each([
    'write-exclusive:/state/bootstrap.json.lock',
    'sync-file:/state/bootstrap.json.lock',
    'write-exclusive:/state/bootstrap.json.tmp-nonce-1',
    'sync-file:/state/bootstrap.json.tmp-nonce-1',
    'rename:/state/bootstrap.json.tmp-nonce-1->/state/bootstrap.json',
  ])('keeps the prior revision selectable when %s fails', async (boundary) => {
    const h = harness(VALIDATING)
    h.failOnce((operation) => operation === boundary)

    await expect(h.store.save(READY)).rejects.toBeInstanceOf(BrainBootstrapStoreError)
    expect(JSON.parse(h.files.get('/state/bootstrap.json')!.content)).toEqual(VALIDATING)
    expect(h.files.has('/state/bootstrap.json.lock')).toBe(false)
  })

  it('retries idempotently after an ambiguous post-rename directory fsync failure', async () => {
    const h = harness(VALIDATING)
    let syncCount = 0
    h.failOnce((operation) => operation === 'sync-dir:/state' && ++syncCount === 2)

    await expect(h.store.save(READY)).rejects.toMatchObject({
      code: 'BRAIN_BOOTSTRAP_WRITE_FAILED',
    })
    expect(JSON.parse(h.files.get('/state/bootstrap.json')!.content)).toEqual(READY)
    await expect(h.store.save(READY)).resolves.toBeUndefined()
  })

  it('fails closed when durable lock cleanup fails after publication', async () => {
    const h = harness(VALIDATING)
    h.failOnce((operation) => operation === 'remove:/state/bootstrap.json.lock')

    await expect(h.store.save(READY)).rejects.toMatchObject({
      code: 'BRAIN_BOOTSTRAP_CLEANUP_FAILED',
    })
    expect(JSON.parse(h.files.get('/state/bootstrap.json')!.content)).toEqual(READY)
    expect(h.files.has('/state/bootstrap.json.lock')).toBe(true)
    await expect(h.store.save(READY)).rejects.toMatchObject({
      code: 'BRAIN_BOOTSTRAP_LOCK_HELD',
    })
  })

  it('fails closed on malformed JSON and symlink targets', async () => {
    const malformed = harness(READY)
    malformed.files.get('/state/bootstrap.json')!.content = '{broken'
    await expect(malformed.store.load()).rejects.toBeInstanceOf(CorruptBrainBootstrapState)

    const linked = harness()
    linked.symlinks.add('/state/bootstrap.json')
    await expect(linked.store.load()).rejects.toMatchObject({
      code: 'BRAIN_BOOTSTRAP_UNSAFE_PATH',
    })
  })
})
