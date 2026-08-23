import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { makeContextLeaseCoordinator } from './context-lease.js'
import { makeProtectedMemoryFileStore, type ProtectedMemoryFileFault } from './protected-memory-file-store.js'
import { makeProtectedMemoryScopeBarrier } from './protected-memory-scope-barrier.js'
import {
  makeProtectedMemoryPublicationService,
  ProtectedMemoryPublicationError,
  type ProtectedMemoryAuditEvent,
  type ProtectedMemoryScope,
} from './protected-memory-publication.js'
import {
  makeProtectedMemorySqliteStore,
  type ProtectedMemorySqliteFault,
  type ProtectedMemorySqliteStore,
} from './protected-memory-sqlite-store.js'

type Fault = ProtectedMemorySqliteFault | ProtectedMemoryFileFault

const roots: string[] = []
const scope: ProtectedMemoryScope = {
  kind: 'project',
  scopeId: 'project:project-a',
  projectId: 'project-a',
}
const publishRequest = {
  factId: 'operator-language',
  text: 'Оператор предпочитает ответы на русском языке.',
  provenance: 'session:session-a:turn:9',
  scope,
}
const keyTokens = ['operator', 'language']
const factKey = createHash('sha256').update(keyTokens.join('|')).digest('hex')

function names(db: Database.Database): Set<string> {
  return new Set((db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
  ).all() as Array<{ name: string }>).map((row) => row.name))
}

function makeFixture(fault?: Fault) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-protected-node-')))
  roots.push(root)
  const contentRoot = join(root, 'content')
  mkdirSync(contentRoot, { mode: 0o700 })
  const ledgerPath = join(root, 'db', 'ledger.sqlite')
  const keywordPath = join(root, 'db', 'keyword.sqlite')
  const stagingRoot = join(root, 'staging')
  const delivered = new Map<string, ProtectedMemoryAuditEvent>()
  let auditAttempts = 0
  let armed = fault
  const crash = (point: Fault): void => {
    if (point !== armed) return
    armed = undefined
    throw new Error(`crash:${point}`)
  }
  const auditSink = async (event: ProtectedMemoryAuditEvent): Promise<void> => {
    auditAttempts += 1
    const existing = delivered.get(event.eventId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(event)) throw new Error('audit conflict')
    delivered.set(event.eventId, structuredClone(event))
  }
  const open = (): {
    lease: ReturnType<ReturnType<typeof makeContextLeaseCoordinator>['acquire']>
    service: ReturnType<typeof makeProtectedMemoryPublicationService>
    store: ProtectedMemorySqliteStore
  } => {
    let id = 0
    const leases = makeContextLeaseCoordinator({ newId: () => `lease-op-${++id}-${Math.random()}` })
    const lease = leases.acquire({
      operatorId: 'telegram:42',
      profileId: 'default',
      projectId: 'project-a',
      projectKind: 'project',
      sessionId: 'session-a',
      root: contentRoot,
      generation: 7,
    })
    const store = makeProtectedMemorySqliteStore({
      ledgerPath,
      keywordPath,
      operatorId: 'telegram:42',
      profileId: 'default',
      scope,
      startedAt: '2026-07-27T04:00:00.000Z',
      deliverAuditOnce: auditSink,
      deliverDeletionAuditOnce: async () => undefined,
      deliverUpdateAuditOnce: async () => undefined,
      faultAt: (point) => crash(point),
    })
    const files = makeProtectedMemoryFileStore({
      contentRoot,
      stagingRoot,
      faultAt: (point) => crash(point),
    })
    const barrier = makeProtectedMemoryScopeBarrier({
      lockPath: join(root, 'db', 'scope-barrier.sqlite'),
      operatorId: 'telegram:42',
      profileId: 'default',
      scope,
      nowIso: () => '2026-07-27T04:00:30.000Z',
    })
    const service = makeProtectedMemoryPublicationService({
      leases,
      persistence: () => store,
      files: () => files,
      prepareFact: async () => ({
        factKey,
        keyTokens,
        validAt: '2026-07-27T04:01:00.000Z',
        isHumanConfirmed: true,
        sourceAuthority: 100,
        confidence: 1,
      }),
      withScopeExclusive: (boundLease, boundScope, run) =>
        barrier.withScopeExclusive(boundLease, boundScope, run),
      nowIso: () => '2026-07-27T04:02:00.000Z',
    })
    return { lease, service, store }
  }
  return {
    auditAttempts: () => auditAttempts,
    contentRoot,
    delivered,
    keywordPath,
    ledgerPath,
    open,
    root,
    stagingRoot,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('protected memory Node composition', () => {
  it('recovers idempotently across every real durable boundary', async () => {
    const faults: Fault[] = [
      'after-create-wal',
      'after-stage-link',
      'after-stage',
      'after-pending',
      'after-advance-wal',
      'after-link',
      'after-unlink-stage',
      'after-ledger-publish',
      'after-keyword-publish',
      'after-audit-delivery',
      'after-audit-mark',
      'after-delete-wal',
    ]
    for (const fault of faults) {
      const h = makeFixture(fault)
      const first = h.open()
      await expect(first.service.publishFact(first.lease, publishRequest))
        .rejects.toThrow(`crash:${fault}`)
      first.store.close()

      const restarted = h.open()
      const recovered = await restarted.service.recoverScope(restarted.lease, scope)
      const fact = recovered[0] ?? await restarted.service.publishFact(
        restarted.lease,
        publishRequest,
      )
      expect(fact).toMatchObject({ published: true, factKey, scope })
      await expect(restarted.service.assertScopeRecovered(restarted.lease, scope)).resolves.toBeUndefined()
      expect(restarted.store.integrityCheck()).toEqual({ ok: true })
      expect(h.delivered.size).toBe(1)
      expect(h.auditAttempts()).toBe(fault === 'after-audit-delivery' ? 2 : 1)
      expect(lstatSync(join(h.contentRoot, fact.sourcePath)).mode & 0o777).toBe(0o600)
      expect(readdirSync(h.stagingRoot)).toEqual([])
      restarted.store.close()
    }
  })

  it('blocks scope readers while a WAL requires recovery', async () => {
    const h = makeFixture('after-create-wal')
    const first = h.open()
    await expect(first.service.publishFact(first.lease, publishRequest))
      .rejects.toThrow('crash:after-create-wal')
    first.store.close()

    const restarted = h.open()
    await expect(restarted.service.assertScopeRecovered(restarted.lease, scope))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    await restarted.service.recoverScope(restarted.lease, scope)
    await expect(restarted.service.assertScopeRecovered(restarted.lease, scope)).resolves.toBeUndefined()
    restarted.store.close()
  })

  it('keeps the canonical ledger physically separate from the derived FTS index', async () => {
    const h = makeFixture()
    const runtime = h.open()
    await runtime.service.publishFact(runtime.lease, publishRequest)
    runtime.store.close()

    const ledger = new Database(h.ledgerPath, { readonly: true })
    const keyword = new Database(h.keywordPath, { readonly: true })
    try {
      const ledgerNames = names(ledger)
      const keywordNames = names(keyword)
      expect(ledgerNames.has('facts')).toBe(true)
      expect(ledgerNames.has('do_not_remember')).toBe(true)
      expect(ledgerNames.has('keyword_fts')).toBe(false)
      expect(ledgerNames.has('keyword_metadata')).toBe(false)
      expect(keywordNames.has('keyword_fts')).toBe(true)
      expect(keywordNames.has('keyword_metadata')).toBe(true)
      expect(keywordNames.has('facts')).toBe(false)
      expect(keywordNames.has('do_not_remember')).toBe(false)
      expect(keywordNames.has('memory_publication_wal')).toBe(false)
      expect(keywordNames.has('audit_outbox')).toBe(false)
      expect(lstatSync(h.ledgerPath).mode & 0o777).toBe(0o600)
      expect(lstatSync(h.keywordPath).mode & 0o777).toBe(0o600)
    } finally {
      ledger.close()
      keyword.close()
    }
  })

  it('refuses to reopen a physical ledger under another owner or profile', () => {
    const h = makeFixture()
    const initialized = h.open()
    initialized.store.close()

    expect(() => makeProtectedMemorySqliteStore({
      ledgerPath: h.ledgerPath,
      keywordPath: h.keywordPath,
      operatorId: 'telegram:99',
      profileId: 'default',
      scope,
      startedAt: '2026-07-27T04:00:00.000Z',
      deliverAuditOnce: async () => undefined,
      deliverDeletionAuditOnce: async () => undefined,
      deliverUpdateAuditOnce: async () => undefined,
    })).toThrowError(/SCOPE_MISMATCH/)
    expect(existsSync(h.keywordPath)).toBe(true)
  })

  it('does not create a derived index when an unbound migration candidate is opened', () => {
    const h = makeFixture()
    mkdirSync(join(h.root, 'db'), { mode: 0o700 })
    const candidate = new Database(h.ledgerPath)
    candidate.exec(`
      CREATE TABLE ledger_control (
        singleton INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        operator_id TEXT,
        profile_id TEXT,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        project_id TEXT
      );
      INSERT INTO ledger_control VALUES (
        1, 2, NULL, NULL, 'project', 'project:project-a', 'project-a'
      );
    `)
    candidate.close()
    chmodSync(h.ledgerPath, 0o600)

    expect(() => makeProtectedMemorySqliteStore({
      ledgerPath: h.ledgerPath,
      keywordPath: h.keywordPath,
      operatorId: 'telegram:42',
      profileId: 'default',
      scope,
      startedAt: '2026-07-27T04:00:00.000Z',
      deliverAuditOnce: async () => undefined,
      deliverDeletionAuditOnce: async () => undefined,
      deliverUpdateAuditOnce: async () => undefined,
    })).toThrowError(/SCOPE_MISMATCH/)
    expect(existsSync(h.keywordPath)).toBe(false)
  })

  it('fails closed when the derived keyword projection is tampered', async () => {
    const h = makeFixture()
    const first = h.open()
    const fact = await first.service.publishFact(first.lease, publishRequest)
    first.store.close()

    const keyword = new Database(h.keywordPath)
    keyword.prepare("UPDATE keyword_fts SET text = 'подмена' WHERE rowid = 1").run()
    keyword.close()

    const restarted = h.open()
    expect(restarted.store.integrityCheck()).toEqual({ ok: false, detail: 'PROJECTION' })
    await expect(restarted.service.publishFact(restarted.lease, publishRequest))
      .rejects.toMatchObject({ code: 'WAL_CONFLICT' })
    await expect(restarted.store.verifyPublished({ ...fact, published: false })).resolves.toBe(false)
    restarted.store.close()
  })

  it('rejects a fact present in the protected do-not-remember ledger', async () => {
    const h = makeFixture()
    const initialized = h.open()
    initialized.store.close()
    const ledger = new Database(h.ledgerPath)
    const forgetTs = '2026-07-27T04:03:00.000Z'
    const forgetReason = 'operator-forget-request'
    const forgetHash = createHash('sha256').update(
      `genesis‖${factKey}‖${keyTokens.join('|')}‖${forgetReason}‖${forgetTs}`,
    ).digest('hex')
    ledger.prepare(`
      INSERT INTO do_not_remember (
        fact_key, key_tokens, reason, is_human_confirmed, ts, prev_hash, row_hash
      ) VALUES (?, ?, ?, 1, ?, ?, ?)
    `).run(
      factKey,
      keyTokens.join('|'),
      forgetReason,
      forgetTs,
      'genesis',
      forgetHash,
    )
    ledger.prepare(`
      UPDATE ledger_control SET forget_count = 1, forget_head_hash = ?
      WHERE singleton = 1
    `).run(forgetHash)
    ledger.close()

    const runtime = h.open()
    await expect(runtime.service.publishFact(runtime.lease, publishRequest))
      .rejects.toMatchObject({ code: 'FORGOTTEN_FACT' })
    runtime.store.close()
  })

  it('detects a corrupted protected audit outbox after restart', async () => {
    const h = makeFixture()
    const first = h.open()
    await first.service.publishFact(first.lease, publishRequest)
    first.store.close()

    const ledger = new Database(h.ledgerPath)
    ledger.prepare("UPDATE audit_outbox SET event_hash = ?").run('e'.repeat(64))
    ledger.close()

    expect(() => h.open()).toThrowError(/CORRUPT_LEDGER/)
  })

  it('detects forget-list tail truncation through the protected chain anchor', () => {
    const h = makeFixture()
    const initialized = h.open()
    initialized.store.close()
    const reason = 'privacy-request'
    const ts = '2026-07-27T04:04:00.000Z'
    const rowHash = createHash('sha256').update(
      `genesis‖${factKey}‖${keyTokens.join('|')}‖${reason}‖${ts}`,
    ).digest('hex')
    const ledger = new Database(h.ledgerPath)
    ledger.prepare(`
      INSERT INTO do_not_remember (
        fact_key, key_tokens, reason, is_human_confirmed, ts, prev_hash, row_hash
      ) VALUES (?, ?, ?, 1, ?, 'genesis', ?)
    `).run(factKey, keyTokens.join('|'), reason, ts, rowHash)
    ledger.prepare(`
      UPDATE ledger_control SET forget_count = 1, forget_head_hash = ?
      WHERE singleton = 1
    `).run(rowHash)
    ledger.close()
    const healthy = h.open()
    healthy.store.close()

    const attacker = new Database(h.ledgerPath)
    attacker.prepare('DELETE FROM do_not_remember').run()
    attacker.close()

    expect(() => h.open()).toThrowError(/CORRUPT_LEDGER/)
  })
})
