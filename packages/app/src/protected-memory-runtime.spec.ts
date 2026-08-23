import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deriveDeterministicMemoryFactKey,
  makeContextLeaseCoordinator,
  type ProtectedMemoryScope,
} from '@aisy/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeNodeProtectedMemoryPreviewRouter,
  makeNodeProtectedMemoryScopeRuntime,
  parseProtectedMemoryPreviewMode,
  parseProtectedMemorySemanticConfig,
  ProtectedMemoryRuntimeError,
} from './protected-memory-runtime.js'

const roots: string[] = []
const children = new Set<ChildProcess>()
const scope: ProtectedMemoryScope = {
  kind: 'project', scopeId: 'project:project-a', projectId: 'project-a',
}
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const semanticDescriptor = {
  provider: 'openrouter' as const,
  modelId: 'openai/text-embedding-3-small',
  modelRevision: '2026-07-29',
  dimensions: 2,
  normalizationVersion: 'nfkc-v1',
  chunkerVersion: 'fact-v1',
}

function paths(root: string) {
  return {
    ledger: join(root, 'db', 'ledger.sqlite'),
    keyword: join(root, 'db', 'keyword.sqlite'),
    semantic: join(root, 'db', 'semantic.sqlite'),
    barrier: join(root, 'db', 'barrier.sqlite'),
    contentRoot: join(root, 'content'),
    stagingRoot: join(root, 'staging'),
  }
}

afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => { child.once('exit', () => resolve()) })
  }))
  children.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function sentinelLines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
}

async function waitUntil(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('fixture timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function startAisyWithSemanticConfig(input: {
  mode?: 'off' | 'preview'
  provider?: string
  modelId?: string
  modelRevision?: string
  dimensions?: string
}): {
  child: ChildProcess
  protectedRoot: string
  sentinel: string
  stderr(): string
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-protected-bin-')))
  roots.push(root)
  const base = join(root, 'home')
  const workspace = join(root, 'workspace')
  const protectedRoot = join(root, 'protected-memory')
  const sentinel = join(root, 'external-fetch.log')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  if ((input.mode ?? 'preview') === 'preview' &&
    (input.provider === undefined || input.provider === 'none')) {
    mkdirSync(join(protectedRoot, 'content'), { recursive: true, mode: 0o700 })
  }
  writeFileSync(join(base, 'providers.json'), JSON.stringify({
    default: { provider: 'claude-cli', model: 'sonnet' },
  }), { mode: 0o600 })
  let stderr = ''
  const semanticEnv = Object.fromEntries(Object.entries({
    AISY_EMBEDDING_PROVIDER: input.provider,
    AISY_EMBEDDING_MODEL: input.modelId,
    AISY_EMBEDDING_REVISION: input.modelRevision,
    AISY_EMBEDDING_DIMENSIONS: input.dimensions,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const child = spawn(process.execPath, [
    '--import', fileURLToPath(new URL('../test-fixtures/external-fetch-sentinel.mjs', import.meta.url)),
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    '--experimental-loader', fileURLToPath(new URL('../test-fixtures/typescript-source-loader.mjs', import.meta.url)),
    fileURLToPath(new URL('./bin/aisy.ts', import.meta.url)),
    'run',
  ], {
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      TMPDIR: tmpdir(),
      TZ: process.env['TZ'] ?? 'UTC',
      NO_COLOR: '1',
      HOME: base,
      AISY_HOME: base,
      AISY_WORKSPACE: workspace,
      XDG_STATE_HOME: join(root, 'state'),
      AISY_TELEGRAM_BOT_TOKEN: '123:fixture-token',
      AISY_TELEGRAM_CHAT_ID: '123',
      AISY_SESSION_JOURNAL: '0',
      AISY_PROTECTED_MEMORY: input.mode ?? 'preview',
      AISY_PROTECTED_MEMORY_ROOT: protectedRoot,
      AISY_EXTERNAL_FETCH_SENTINEL: sentinel,
      ...semanticEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return { child, protectedRoot, sentinel, stderr: () => stderr }
}

describe('protected memory semantic config', () => {
  it('returns immutable exact snapshots for keyword-only and OpenRouter modes', () => {
    const none = parseProtectedMemorySemanticConfig({ provider: 'none' })
    const source = { ...semanticDescriptor }
    const openrouter = parseProtectedMemorySemanticConfig(source)
    source.modelRevision = 'mutated-after-parse'

    expect(none).toEqual({ provider: 'none' })
    expect(Object.isFrozen(none)).toBe(true)
    expect(openrouter).toEqual(semanticDescriptor)
    expect(Object.isFrozen(openrouter)).toBe(true)
  })

  it('rejects an incomplete OpenRouter config with the stable typed error', () => {
    expect(() => parseProtectedMemorySemanticConfig({ provider: 'openrouter' }))
      .toThrowError(ProtectedMemoryRuntimeError)
    try {
      parseProtectedMemorySemanticConfig({ provider: 'openrouter' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_SEMANTIC_DESCRIPTOR' })
    }
  })

  it('boots keyword-only far enough for external startup without a semantic database', async () => {
    const runtime = startAisyWithSemanticConfig({ provider: 'none' })
    await waitUntil(() => sentinelLines(runtime.sentinel).length > 0 ||
      runtime.child.exitCode !== null || runtime.child.signalCode !== null)

    if (sentinelLines(runtime.sentinel).length === 0) {
      throw new Error(`aisy exited before external sentinel: ${runtime.stderr()}`)
    }
    expect(sentinelLines(runtime.sentinel).length).toBeGreaterThan(0)
    expect(existsSync(join(runtime.protectedRoot, 'db', 'semantic.sqlite'))).toBe(false)
  })

  it('fails incomplete OpenRouter config before protected artifacts or external I/O', async () => {
    const runtime = startAisyWithSemanticConfig({ provider: 'openrouter' })
    await waitUntil(() => runtime.child.exitCode !== null || runtime.child.signalCode !== null)

    expect(runtime.child.exitCode).toBe(1)
    expect(runtime.stderr()).toContain(
      'aisy: некорректная конфигурация семантической памяти.\n',
    )
    expect(existsSync(runtime.protectedRoot)).toBe(false)
    expect(sentinelLines(runtime.sentinel)).toEqual([])
  }, 15_000)

  it('keeps off as an unconditional rollback despite stale invalid OpenRouter config', async () => {
    const runtime = startAisyWithSemanticConfig({
      mode: 'off',
      provider: 'openrouter',
    })
    await waitUntil(() => sentinelLines(runtime.sentinel).length > 0 ||
      runtime.child.exitCode !== null || runtime.child.signalCode !== null)

    if (sentinelLines(runtime.sentinel).length === 0) {
      throw new Error(`aisy exited before external sentinel: ${runtime.stderr()}`)
    }
    expect(runtime.stderr()).not.toContain('некорректная конфигурация семантической памяти')
    expect(existsSync(runtime.protectedRoot)).toBe(false)
    expect(sentinelLines(runtime.sentinel).some((line) =>
      line.includes('openrouter.ai') || line.includes('/embeddings'))).toBe(false)
  })
})

describe('protected memory preview runtime', () => {
  it('accepts only explicit off/preview modes', () => {
    expect(parseProtectedMemoryPreviewMode(undefined)).toBe('off')
    expect(parseProtectedMemoryPreviewMode('off')).toBe('off')
    expect(parseProtectedMemoryPreviewMode('preview')).toBe('preview')
    expect(() => parseProtectedMemoryPreviewMode('live')).toThrowError(/INVALID_MODE/)
    expect(() => parseProtectedMemoryPreviewMode('1')).toThrowError(/INVALID_MODE/)
  })

  it('creates no files or directories while the feature is off', () => {
    const root = join(tmpdir(), `aisy-protected-off-${Date.now()}-${Math.random()}`)
    const runtime = makeNodeProtectedMemoryScopeRuntime({
      mode: 'off',
      paths: paths(root),
      operatorId: 'telegram:42',
      profileId: 'default',
      scope,
      leases: makeContextLeaseCoordinator({ newId: () => 'unused-operation' }),
      descriptor: { provider: 'invalid-but-off' } as never,
      nowIso: () => '2026-07-27T08:00:00.000Z',
      newFactId: () => 'unused',
      prepareFact: async () => { throw new Error('unused') },
      deliverPublicationAuditOnce: async () => undefined,
      deliverDeletionAuditOnce: async () => undefined,
      deliverUpdateAuditOnce: async () => undefined,
    })
    expect(runtime).toEqual({ mode: 'off' })
    expect(existsSync(root)).toBe(false)
    expect(makeNodeProtectedMemoryPreviewRouter({
      leases: makeContextLeaseCoordinator({ newId: () => 'unused-router-operation' }),
      globalRuntime: runtime,
      projectRuntime: () => { throw new Error('must not resolve a Project while off') },
      newFactId: () => 'unused',
      provenanceFor: () => 'unused',
      authorizeHumanConfirmedDelete: async () => false,
    })).toBeNull()
  })

  it('creates its own content root on a first run instead of refusing to start', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-protected-first-run-')))
    roots.push(root)
    const runtimePaths = paths(root)
    // Deliberately no mkdir here: this is what a fresh AISY_HOME looks like.
    expect(existsSync(runtimePaths.contentRoot)).toBe(false)

    const runtime = makeNodeProtectedMemoryScopeRuntime({
      mode: 'preview',
      paths: runtimePaths,
      operatorId: 'telegram:42',
      profileId: 'default',
      scope,
      leases: makeContextLeaseCoordinator({ newId: () => 'first-run-operation' }),
      descriptor: { provider: 'none' },
      nowIso: () => '2026-08-05T08:00:00.000Z',
      newFactId: () => 'first-run-fact',
      prepareFact: async () => { throw new Error('unused') },
      deliverPublicationAuditOnce: async () => undefined,
      deliverDeletionAuditOnce: async () => undefined,
      deliverUpdateAuditOnce: async () => undefined,
    })

    expect(runtime.mode).toBe('preview')
    expect(existsSync(runtimePaths.contentRoot)).toBe(true)
    expect(statSync(runtimePaths.contentRoot).mode & 0o777).toBe(0o700)
    if (runtime.mode === 'preview') runtime.close()
  })

  it('runs keyword-only preview without creating a semantic database across restart', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-protected-keyword-only-')))
    roots.push(root)
    const runtimePaths = paths(root)
    mkdirSync(runtimePaths.contentRoot, { recursive: true, mode: 0o700 })
    let operationId = 0
    const leases = makeContextLeaseCoordinator({
      newId: () => `keyword-operation-${++operationId}`,
    })
    const lease = leases.acquire({
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      projectKind: 'project', sessionId: 'session-keyword', root: runtimePaths.contentRoot,
      generation: 1,
    })
    let factId = 0
    const open = () => makeNodeProtectedMemoryScopeRuntime({
      mode: 'preview',
      paths: runtimePaths,
      operatorId: lease.operatorId,
      profileId: lease.profileId,
      scope,
      leases,
      descriptor: { provider: 'none' },
      nowIso: () => '2026-07-29T12:00:00.000Z',
      newFactId: () => `keyword-fact-${++factId}`,
      deliverPublicationAuditOnce: async () => undefined,
      deliverDeletionAuditOnce: async () => undefined,
      deliverUpdateAuditOnce: async () => undefined,
    })

    const first = open()
    if (first.mode !== 'preview') throw new Error('preview runtime expected')
    expect(first.semantic).toBeNull()
    expect(existsSync(runtimePaths.semantic)).toBe(false)
    const original = await first.publication.publishFact(lease, {
      factId: 'keyword-original',
      text: 'Состояние только в keyword индексе.',
      provenance: 'session:keyword:turn:1',
      scope,
    })
    await expect(first.store.searchKeyword('состояние', 8)).resolves.toMatchObject([
      { fact: { id: original.id } },
    ])
    const updated = await first.update.updateFact(lease, {
      targetFactId: original.id,
      text: 'Обновлённое keyword состояние.',
      provenance: 'session:keyword:turn:2',
      scope,
    })
    expect(updated.status).toBe('SUPERSEDED')
    if (updated.status !== 'SUPERSEDED') throw new Error('updated fact expected')
    await expect(first.deletion.deleteFact(lease, {
      factId: updated.fact.id,
      reason: 'keyword-only cleanup',
      humanConfirmed: true,
      scope,
    })).resolves.toMatchObject({ status: 'DELETED' })
    first.close()
    first.close()
    expect(existsSync(runtimePaths.semantic)).toBe(false)

    const restarted = open()
    if (restarted.mode !== 'preview') throw new Error('preview runtime expected')
    expect(restarted.semantic).toBeNull()
    await expect(restarted.store.listLiveFacts()).resolves.toEqual([])
    expect(existsSync(runtimePaths.semantic)).toBe(false)
    restarted.close()
  })

  it.each([
    [{ provider: 'none', modelId: 'keyword-only' }],
    [{ provider: 'openrouter' }],
    [{ ...semanticDescriptor, modelId: '' }],
    [{ ...semanticDescriptor, modelId: 'x'.repeat(257) }],
    [{ ...semanticDescriptor, modelRevision: '\u0000' }],
    [{ ...semanticDescriptor, chunkerVersion: 'fact\nversion' }],
    [{ ...semanticDescriptor, dimensions: 0 }],
    [{ ...semanticDescriptor, dimensions: 1.5 }],
    [{ ...semanticDescriptor, dimensions: 65_537 }],
    [{ ...semanticDescriptor, extra: true }],
    [{ ...semanticDescriptor, provider: 'other' }],
  ])('refuses invalid semantic descriptor before creating any artifacts: %j', (descriptor) => {
    const root = join(tmpdir(), `aisy-protected-invalid-${Date.now()}-${Math.random()}`)

    expect(() => makeNodeProtectedMemoryScopeRuntime({
      mode: 'preview',
      paths: paths(root),
      operatorId: 'telegram:42',
      profileId: 'default',
      scope,
      leases: makeContextLeaseCoordinator({ newId: () => 'invalid-operation' }),
      descriptor: descriptor as never,
      nowIso: () => '2026-07-29T12:00:00.000Z',
      newFactId: () => 'invalid-fact',
      deliverPublicationAuditOnce: async () => undefined,
      deliverDeletionAuditOnce: async () => undefined,
      deliverUpdateAuditOnce: async () => undefined,
    })).toThrowError(ProtectedMemoryRuntimeError)
    try {
      makeNodeProtectedMemoryScopeRuntime({
        mode: 'preview', paths: paths(root), operatorId: 'telegram:42', profileId: 'default',
        scope, leases: makeContextLeaseCoordinator({ newId: () => 'invalid-operation-2' }),
        descriptor: descriptor as never, nowIso: () => '2026-07-29T12:00:00.000Z',
        newFactId: () => 'invalid-fact-2', deliverPublicationAuditOnce: async () => undefined,
        deliverDeletionAuditOnce: async () => undefined,
        deliverUpdateAuditOnce: async () => undefined,
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_SEMANTIC_DESCRIPTOR' })
    }
    expect(existsSync(root)).toBe(false)
  })

  it('opens sqlite-vec only for a complete OpenRouter descriptor and validates it on restart', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-protected-semantic-restart-')))
    roots.push(root)
    const runtimePaths = paths(root)
    mkdirSync(runtimePaths.contentRoot, { recursive: true, mode: 0o700 })
    const leases = makeContextLeaseCoordinator({ newId: () => 'semantic-operation' })
    const open = (descriptor = semanticDescriptor) => makeNodeProtectedMemoryScopeRuntime({
      mode: 'preview', paths: runtimePaths, operatorId: 'telegram:42', profileId: 'default',
      scope, leases, descriptor, nowIso: () => '2026-07-29T12:00:00.000Z',
      newFactId: () => 'semantic-fact', deliverPublicationAuditOnce: async () => undefined,
      deliverDeletionAuditOnce: async () => undefined,
      deliverUpdateAuditOnce: async () => undefined,
    })

    const first = open()
    if (first.mode !== 'preview') throw new Error('preview runtime expected')
    expect(first.semantic).not.toBeNull()
    expect(existsSync(runtimePaths.semantic)).toBe(true)
    first.close()

    const restarted = open()
    if (restarted.mode !== 'preview') throw new Error('preview runtime expected')
    expect(restarted.semantic?.state()).toBe('healthy')
    restarted.close()

    expect(() => open({ ...semanticDescriptor, modelRevision: 'different' }))
      .toThrowError(/DESCRIPTOR_MISMATCH/)
  })

  it('routes real protected global plus exact-Project memory in preview', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-protected-router-preview-')))
    roots.push(root)
    const globalPaths = paths(join(root, 'global'))
    const projectPaths = paths(join(root, 'project-a'))
    mkdirSync(globalPaths.contentRoot, { recursive: true, mode: 0o700 })
    mkdirSync(projectPaths.contentRoot, { recursive: true, mode: 0o700 })
    let operationId = 0
    const leases = makeContextLeaseCoordinator({ newId: () => `router-operation-${++operationId}` })
    const lease = leases.acquire({
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      projectKind: 'project', sessionId: 'session-router', root: projectPaths.contentRoot,
      generation: 2,
    })
    const descriptor = semanticDescriptor
    const makeRuntime = (
      runtimeScope: ProtectedMemoryScope,
      runtimePaths: ReturnType<typeof paths>,
      idPrefix: string,
    ) => makeNodeProtectedMemoryScopeRuntime({
      mode: 'preview',
      paths: runtimePaths,
      operatorId: lease.operatorId,
      profileId: lease.profileId,
      scope: runtimeScope,
      leases,
      descriptor,
      nowIso: () => '2026-07-27T10:00:00.000Z',
      newFactId: () => `${idPrefix}-replacement`,
      prepareFact: async ({ text }) => {
        const keyTokens = text.normalize('NFKC').toLowerCase().split(/\s+/u)
        return {
          factKey: sha256(keyTokens.join('|')),
          keyTokens,
          validAt: '2026-07-27T10:00:00.000Z',
          isHumanConfirmed: false,
          sourceAuthority: 50,
          confidence: 0.9,
        }
      },
      deliverPublicationAuditOnce: async () => undefined,
      deliverDeletionAuditOnce: async () => undefined,
      deliverUpdateAuditOnce: async () => undefined,
    })
    const globalScope: ProtectedMemoryScope = { kind: 'global', scopeId: 'global' }
    const globalRuntime = makeRuntime(globalScope, globalPaths, 'global')
    const projectRuntime = makeRuntime(scope, projectPaths, 'project')
    if (globalRuntime.mode !== 'preview' || projectRuntime.mode !== 'preview') {
      throw new Error('preview runtimes expected')
    }
    let factId = 0
    const router = makeNodeProtectedMemoryPreviewRouter({
      leases,
      globalRuntime,
      projectRuntime: (projectId) => projectId === 'project-a' ? projectRuntime : null,
      newFactId: () => `router-fact-${++factId}`,
      provenanceFor: ({ lease: activeLease, op, scope: activeScope }) =>
        `${activeLease.sessionId}:${activeScope.scopeId}:${op.op}`,
      authorizeHumanConfirmedDelete: async () => false,
    })
    if (!router) throw new Error('protected preview router expected')
    try {
      await router.commitGlobal(
        lease,
        { op: 'ADD', text: 'Общее состояние системы' },
        { withinSession: true },
      )
      await router.commitProject(
        lease,
        { op: 'ADD', text: 'Проектное состояние системы' },
        { withinSession: true },
      )

      await expect(router.searchAutomatic(lease, 'состояние')).resolves.toMatchObject({
        requestedMode: 'hybrid',
        effectiveMode: 'keyword',
        status: 'SEMANTIC_UNAVAILABLE',
        semanticDegraded: 'SEMANTIC_UNAVAILABLE',
        hits: [
          { id: 'router-fact-1', scope: 'global', componentRanks: { keyword: 1 } },
          {
            id: 'router-fact-2',
            scope: 'project',
            projectId: 'project-a',
            componentRanks: { keyword: 1 },
          },
        ],
      })
      await expect(globalRuntime.store.listLiveFacts()).resolves.toHaveLength(1)
      await expect(projectRuntime.store.listLiveFacts()).resolves.toHaveLength(1)
      expect((await projectRuntime.store.listLiveFacts())[0]?.factKey).toBe(
        deriveDeterministicMemoryFactKey('Проектное состояние системы').factKey,
      )
      expect(globalRuntime.store.integrityCheck()).toEqual({ ok: true })
      expect(projectRuntime.store.integrityCheck()).toEqual({ ok: true })
    } finally {
      projectRuntime.close()
      globalRuntime.close()
    }
  })

  it('composes preview ADD → UPDATE → FORGET with unified recovery and live-vector verification', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-protected-preview-')))
    roots.push(root)
    const runtimePaths = paths(root)
    mkdirSync(runtimePaths.contentRoot, { mode: 0o700 })
    let nextId = 0
    const leases = makeContextLeaseCoordinator({ newId: () => `preview-operation-${++nextId}` })
    const lease = leases.acquire({
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      projectKind: 'project', sessionId: 'session-a', root: runtimePaths.contentRoot,
      generation: 7,
    })
    let replacementId = 0
    const runtime = makeNodeProtectedMemoryScopeRuntime({
      mode: 'preview',
      paths: runtimePaths,
      operatorId: lease.operatorId,
      profileId: lease.profileId,
      scope,
      leases,
      descriptor: semanticDescriptor,
      nowIso: () => '2026-07-27T08:00:00.000Z',
      newFactId: () => `replacement-${++replacementId}`,
      prepareFact: async ({ text }) => {
        const tokens = text.includes('новое') ? ['status', 'new'] : ['status', 'old']
        return {
          factKey: sha256(tokens.join('|')),
          keyTokens: tokens,
          validAt: '2026-07-27T08:00:00.000Z',
          isHumanConfirmed: false,
          sourceAuthority: 50,
          confidence: 0.9,
        }
      },
      deliverPublicationAuditOnce: async () => undefined,
      deliverDeletionAuditOnce: async () => undefined,
      deliverUpdateAuditOnce: async () => undefined,
    })
    if (runtime.mode !== 'preview') throw new Error('preview runtime expected')
    if (runtime.semantic === null) throw new Error('semantic runtime expected')
    await expect(runtime.recovery.recoverScope(lease, scope)).resolves.toEqual({
      recovered: 'none', operations: 0,
    })
    const original = await runtime.publication.publishFact(lease, {
      factId: 'status-old', text: 'Старое состояние.', provenance: 'session:a:turn:1', scope,
    })
    await expect(runtime.store.searchKeyword('старое', 8)).resolves.toMatchObject([
      { fact: { id: original.id, published: true } },
    ])
    const cacheKey = sha256(`cache:${original.contentHash}`)
    runtime.semantic.putCached('document', cacheKey, [0.25, 0.75])
    expect(original.operationId).not.toBe(original.id)
    await runtime.semantic.upsert({
      candidate: {
        hitId: original.id,
        scope: 'project',
        scopeId: scope.scopeId,
        projectId: scope.projectId,
        sourcePath: original.sourcePath,
        chunkId: original.id,
        contentHash: original.contentHash,
        provenance: original.provenance,
        score: 1,
      },
      factKey: original.factKey,
      cacheKey,
    }, [0.25, 0.75])
    const updated = await runtime.update.updateFact(lease, {
      targetFactId: original.id,
      text: 'Это новое состояние.',
      provenance: 'session:a:turn:2',
      scope,
    })
    expect(updated.status).toBe('SUPERSEDED')
    if (updated.status !== 'SUPERSEDED') throw new Error('updated fact expected')
    await expect(runtime.store.searchKeyword('новое', 8)).resolves.toMatchObject([
      { fact: { id: updated.fact.id, published: true } },
    ])
    expect(runtime.semantic.hasFact(original.factKey)).toBe(false)
    expect(runtime.semantic.getCached(cacheKey)).toBeNull()
    await expect(runtime.deletion.deleteFact(lease, {
      factId: updated.fact.id,
      reason: 'Подтверждённое удаление',
      humanConfirmed: true,
      scope,
    })).resolves.toMatchObject({ status: 'DELETED', humanConfirmed: true })
    await expect(runtime.store.searchKeyword('новое', 8)).resolves.toEqual([])
    await expect(runtime.store.listLiveFacts()).resolves.toEqual([])
    await expect(runtime.recovery.assertScopeRecovered(lease, scope)).resolves.toBeUndefined()
    expect(runtime.store.integrityCheck()).toEqual({ ok: true })
    runtime.close()
  })
})
