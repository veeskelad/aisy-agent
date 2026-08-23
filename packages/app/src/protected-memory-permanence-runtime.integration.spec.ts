import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeContextLeaseCoordinator,
  makeGateway,
  type ContextLeaseCoordinator,
  type MemoryPermanenceAuditEvent,
  type ProtectedMemoryScope,
  type TurnContextLease,
} from '@aisy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { makeNodeMemoryPermanenceRuntime } from './memory-permanence-runtime.js'
import {
  makeNodeProtectedMemoryPreviewRouter,
  makeNodeProtectedMemoryScopeRuntime,
  type NodeProtectedMemoryScopeRuntime,
} from './protected-memory-runtime.js'

const NOW = Date.parse('2026-07-27T12:00:00.000Z')
const NOW_ISO = new Date(NOW).toISOString()
const PROJECT_SCOPE: ProtectedMemoryScope = {
  kind: 'project', scopeId: 'project:project-a', projectId: 'project-a',
}
const GLOBAL_SCOPE: ProtectedMemoryScope = { kind: 'global', scopeId: 'global' }
const roots: string[] = []
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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

function leaseCoordinator(root: string): {
  leases: ContextLeaseCoordinator
  lease: TurnContextLease
} {
  let operation = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-operation-${++operation}` })
  return {
    leases,
    lease: leases.acquire({
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      projectKind: 'project', sessionId: 'session-a', root,
      generation: 4,
    }),
  }
}

function scopeRuntime(input: {
  root: string
  scope: ProtectedMemoryScope
  leases: ContextLeaseCoordinator
  newFactId(): string
}): Exclude<NodeProtectedMemoryScopeRuntime, { mode: 'off' }> {
  mkdirSync(paths(input.root).contentRoot, { recursive: true, mode: 0o700 })
  const runtime = makeNodeProtectedMemoryScopeRuntime({
    mode: 'preview',
    paths: paths(input.root),
    operatorId: 'telegram:42',
    profileId: 'default',
    scope: input.scope,
    leases: input.leases,
    descriptor: {
      provider: 'openrouter', modelId: 'test', modelRevision: '1', dimensions: 2,
      normalizationVersion: 'nfkc-v1', chunkerVersion: 'fact-v1',
    },
    nowIso: () => NOW_ISO,
    newFactId: input.newFactId,
    async prepareFact({ text }) {
      const keyTokens = text.normalize('NFKC').toLowerCase().split(/\s+/u)
      return {
        factKey: sha256(keyTokens.join('|')),
        keyTokens,
        validAt: NOW_ISO,
        isHumanConfirmed: false,
        sourceAuthority: 100,
        confidence: 1,
      }
    },
    deliverPublicationAuditOnce: async () => undefined,
    deliverDeletionAuditOnce: async () => undefined,
    deliverUpdateAuditOnce: async () => undefined,
  })
  if (runtime.mode !== 'preview') throw new Error('preview runtime expected')
  return runtime
}

describe('protected memory permanence runtime integration', () => {
  it('forgets an exact verified Project fact through Gateway step-up and survives restart', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-protected-permanence-')))
    roots.push(root)
    const projectRoot = join(root, 'project')
    const globalRoot = join(root, 'global')
    const noncePath = join(root, 'authority', 'nonces.json')
    const audits: MemoryPermanenceAuditEvent[] = []
    const gateway = makeGateway({
      getAllowedChatId: async () => 42,
      getBotToken: async () => 'unused',
      isReady: () => true,
      transcribeVoice: async () => '',
      isOutboundLocked: () => false,
      isSafetyAvailable: () => true,
      now: () => NOW,
      mintNonce: () => 'permanence-nonce',
      verifyStepUp: (proof) => proof === 'operator-step-up',
    })
    const authority = makeNodeMemoryPermanenceRuntime({
      secret: Buffer.alloc(32, 9),
      noncePath,
      nowMs: () => NOW,
      newActionId: () => 'permanence-action',
      newReceiptId: () => 'permanence-receipt',
      async approve(_lease, action) {
        const cardId = await gateway.issueCard(action)
        const card = gateway.getIssuedCard(cardId)
        if (!card) return { decision: 'rejected' }
        const result = await gateway.handleCardTap({
          cardId, nonce: card.nonce, presentedActionHash: card.actionHash,
          chatId: 42, stepUpProof: 'operator-step-up',
        })
        if (result.decision !== 'confirmed' || !result.proof) {
          return { decision: 'rejected' }
        }
        return { decision: 'confirmed', proof: result.proof }
      },
      deliverAuditOnce: async (event) => { audits.push(structuredClone(event)) },
    })

    const firstContext = leaseCoordinator(projectRoot)
    let factId = 0
    const firstGlobal = scopeRuntime({
      root: globalRoot, scope: GLOBAL_SCOPE, leases: firstContext.leases,
      newFactId: () => `global-${++factId}`,
    })
    const firstProject = scopeRuntime({
      root: projectRoot, scope: PROJECT_SCOPE, leases: firstContext.leases,
      newFactId: () => `project-${++factId}`,
    })
    const firstRouter = makeNodeProtectedMemoryPreviewRouter({
      leases: firstContext.leases,
      globalRuntime: firstGlobal,
      projectRuntime: (projectId) => projectId === 'project-a' ? firstProject : null,
      newFactId: () => `fact-${++factId}`,
      provenanceFor: ({ lease, scope, op }) => `${lease.sessionId}:${scope.scopeId}:${op.op}`,
      authorizeHumanConfirmedDelete: (request) =>
        authority.authorizeHumanConfirmedDelete(request),
    })
    if (!firstRouter) throw new Error('preview router expected')

    let targetSourcePath = ''
    try {
      const added = await firstRouter.commitProject(
        firstContext.lease,
        { op: 'ADD', text: 'Секрет проекта для удаления' },
        { withinSession: true },
      )
      if (added.status !== 'COMMITTED' || !added.factId) throw new Error('committed fact expected')
      const factId = added.factId
      const target = await firstProject.store.loadTargetById(factId)
      if (!target) throw new Error('published target expected')
      targetSourcePath = target.fact.sourcePath

      await firstRouter.forgetProject(
        firstContext.lease,
        factId,
        'Оператор потребовал забыть навсегда',
        true,
      )
      await expect(firstRouter.searchAutomatic(
        firstContext.lease, 'секрет проекта',
      )).resolves.toEqual({
        requestedMode: 'hybrid',
        effectiveMode: 'keyword',
        status: 'SEMANTIC_UNAVAILABLE',
        semanticDegraded: 'SEMANTIC_UNAVAILABLE',
        hits: [],
      })
      expect(await firstProject.files.verifyAbsent({ sourcePath: targetSourcePath })).toBe(true)
      expect(audits).toEqual([expect.objectContaining({
        factId,
        targetOperationId: target.fact.operationId,
        factKey: target.fact.factKey,
        sourcePath: target.fact.sourcePath,
        contentHash: target.fact.contentHash,
        stepUpVerified: true,
      })])
      expect(readFileSync(noncePath, 'utf8')).toContain('"status": "consumed"')
    } finally {
      firstProject.close()
      firstGlobal.close()
    }

    const restartedContext = leaseCoordinator(projectRoot)
    const restartedGlobal = scopeRuntime({
      root: globalRoot, scope: GLOBAL_SCOPE, leases: restartedContext.leases,
      newFactId: () => 'unused-global',
    })
    const restartedProject = scopeRuntime({
      root: projectRoot, scope: PROJECT_SCOPE, leases: restartedContext.leases,
      newFactId: () => 'unused-project',
    })
    const restartedRouter = makeNodeProtectedMemoryPreviewRouter({
      leases: restartedContext.leases,
      globalRuntime: restartedGlobal,
      projectRuntime: () => restartedProject,
      newFactId: () => 'unused',
      provenanceFor: () => 'unused',
      authorizeHumanConfirmedDelete: async () => { throw new Error('must not authorize a read') },
    })
    if (!restartedRouter) throw new Error('restarted preview router expected')
    try {
      await expect(restartedRouter.searchAutomatic(
        restartedContext.lease, 'секрет проекта',
      )).resolves.toEqual({
        requestedMode: 'hybrid',
        effectiveMode: 'keyword',
        status: 'SEMANTIC_UNAVAILABLE',
        semanticDegraded: 'SEMANTIC_UNAVAILABLE',
        hits: [],
      })
      expect(await restartedProject.files.verifyAbsent({ sourcePath: targetSourcePath })).toBe(true)
      expect(restartedProject.store.integrityCheck()).toEqual({ ok: true })
    } finally {
      restartedProject.close()
      restartedGlobal.close()
    }
  })
})
