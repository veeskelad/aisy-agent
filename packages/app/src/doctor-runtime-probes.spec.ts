import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeContextLeaseCoordinator } from '@aisy/core'
import { makeNodeProtectedMemoryScopeRuntime } from './protected-memory-runtime.js'
import { makeProtectedMemoryDoctorPort, makeTranscriptionDoctorProbe } from './doctor-runtime-probes.js'
import { deepgramProxyProviderMetadata } from './deepgram-proxy-provider.js'
import { makeTranscriptionRegistry } from './transcription-registry.js'

const roots: string[] = []
const makeRoot = (prefix: string): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function openProtectedRuntime(root: string) {
  return makeNodeProtectedMemoryScopeRuntime({
    mode: 'preview',
    paths: {
      ledger: join(root, 'db', 'ledger.sqlite'),
      keyword: join(root, 'db', 'keyword.sqlite'),
      semantic: join(root, 'db', 'semantic.sqlite'),
      barrier: join(root, 'db', 'barrier.sqlite'),
      contentRoot: join(root, 'content'),
      stagingRoot: join(root, 'staging'),
    },
    operatorId: 'telegram:42',
    profileId: 'default',
    scope: { kind: 'global', scopeId: 'global' },
    leases: makeContextLeaseCoordinator({ newId: () => 'doctor-test-operation' }),
    descriptor: { provider: 'none' },
    nowIso: () => '2026-08-12T00:00:00.000Z',
    newFactId: () => 'doctor-test-fact',
    deliverPublicationAuditOnce: async () => undefined,
    deliverDeletionAuditOnce: async () => undefined,
    deliverUpdateAuditOnce: async () => undefined,
  })
}

function treeMetadata(root: string): string[] {
  const visit = (path: string): string[] => readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const child = join(path, entry.name)
      const info = statSync(child)
      const line = `${child.slice(root.length)}:${info.size}:${info.mode & 0o777}`
      return entry.isDirectory() ? [line, ...visit(child)] : [line]
    })
  return visit(root)
}

describe('production doctor runtime probes', () => {
  it('checks the protected global scope without changing its files', async () => {
    const root = makeRoot('aisy-doctor-memory-')
    const runtime = openProtectedRuntime(root)
    if (runtime.mode !== 'preview') throw new Error('preview expected')
    runtime.close()
    const before = treeMetadata(root)

    const result = await makeProtectedMemoryDoctorPort({
      mode: 'preview', root, operatorId: 'telegram:42', profileId: 'default',
    }).integrityCheck()

    expect(result).toEqual({ ok: true, repairable: false })
    expect(treeMetadata(root)).toEqual(before)
  })

  it('fails closed for a foreign protected-memory identity and never repairs it', async () => {
    const root = makeRoot('aisy-doctor-memory-foreign-')
    const runtime = openProtectedRuntime(root)
    if (runtime.mode !== 'preview') throw new Error('preview expected')
    runtime.close()

    const result = await makeProtectedMemoryDoctorPort({
      mode: 'preview', root, operatorId: 'telegram:99', profileId: 'default',
    }).integrityCheck()

    expect(result).toEqual({
      ok: false,
      detail: 'protected scoped memory integrity failed',
      repairable: false,
    })
  })

  it('does not create protected-memory state when it is absent', async () => {
    const base = makeRoot('aisy-doctor-memory-absent-')
    const root = join(base, 'missing')

    await expect(makeProtectedMemoryDoctorPort({
      mode: 'preview', root, operatorId: 'telegram:42', profileId: 'default',
    }).integrityCheck()).resolves.toMatchObject({ ok: false, repairable: false })
    expect(existsSync(root)).toBe(false)
  })

  it('reads the exact durable transcription choice and fails closed on corrupt bytes', () => {
    const root = makeRoot('aisy-doctor-transcription-')
    const path = join(root, 'transcription.json')
    const metadata = deepgramProxyProviderMetadata
    const provider = Object.freeze({
      ...metadata,
      transcribe: async (): Promise<never> => { throw new Error('unused') },
    })
    const registry = makeTranscriptionRegistry({ providers: [provider], path })
    expect(makeTranscriptionDoctorProbe({ path }).inspect()).toEqual({ state: 'unconfigured' })

    registry.select(metadata.id)
    expect(makeTranscriptionDoctorProbe({ path }).inspect()).toEqual({ state: 'ready' })

    writeFileSync(path, '{broken', { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
    expect(makeTranscriptionDoctorProbe({ path }).inspect()).toEqual({ state: 'corrupt' })
  })

  it('reports artifact, backend, key, proxy, outbox and consent without active I/O', () => {
    const root = makeRoot('aisy-doctor-voice-')
    const path = join(root, 'transcription.json')
    const artifactPath = join(root, 'voice.node')
    const statusPath = join(root, 'status.json')
    writeFileSync(artifactPath, 'native-artifact', { encoding: 'utf8', mode: 0o600 })
    writeFileSync(statusPath, JSON.stringify({
      schemaVersion: 1,
      backend: 'ready',
      key: 'ready',
      proxy: 'ready',
      outbox: 'ready',
    }), { encoding: 'utf8', mode: 0o600 })
    const registry = makeTranscriptionRegistry({
      providers: [Object.freeze({
        ...deepgramProxyProviderMetadata,
        transcribe: async (): Promise<never> => { throw new Error('unused') },
      })],
      path,
    })
    registry.select('deepgram-cloud')
    const before = treeMetadata(root)

    const result = makeTranscriptionDoctorProbe({
      path,
      voice: {
        artifactPath,
        controlSocketPath: join(root, 'control.sock'),
        bootstrapSocketPath: join(root, 'bootstrap.sock'),
        statusPath,
        attest: (candidate, kind) => kind === 'socket' || existsSync(candidate),
      },
    }).inspect()

    expect(result.state).toBe('ready')
    expect(result.components?.map(component => [component.id, component.state])).toEqual([
      ['artifact', 'ready'],
      ['backend', 'ready'],
      ['key', 'ready'],
      ['proxy', 'ready'],
      ['outbox', 'ready'],
      ['consent', 'ready'],
    ])
    expect(treeMetadata(root)).toEqual(before)
  })

  it('fails the public voice status projection closed on corrupt metadata', () => {
    const root = makeRoot('aisy-doctor-voice-corrupt-')
    const statusPath = join(root, 'status.json')
    writeFileSync(statusPath, '{broken', { encoding: 'utf8', mode: 0o600 })

    const result = makeTranscriptionDoctorProbe({
      path: join(root, 'transcription.json'),
      voice: {
        artifactPath: join(root, 'voice.node'),
        controlSocketPath: join(root, 'control.sock'),
        bootstrapSocketPath: join(root, 'bootstrap.sock'),
        statusPath,
        attest: () => true,
      },
    }).inspect()

    expect(result.components?.find(component => component.id === 'key')?.state).toBe('corrupt')
    expect(result.components?.find(component => component.id === 'proxy')?.state).toBe('corrupt')
    expect(result.components?.find(component => component.id === 'outbox')?.state).toBe('corrupt')
  })
})
