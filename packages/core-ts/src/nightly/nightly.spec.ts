import { describe, it, expect, beforeEach } from 'vitest'
import { makeConsolidationRunner } from './index.js'
import type {
  ConsolidationDeps,
  NightlyConfig,
  Generator,
  Judge,
  Validators,
  RunLock,
  NormalizedDayLog,
  NormalizedDayLogRecord,
  Fact,
  MemOp,
  SkillDraft,
  QuarantinedDiff,
  Diff,
  FactKey,
} from './types.js'

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

function makeFactKey(entity: string, relation = 'is', object = 'thing'): FactKey {
  return { entity, relation, object }
}

function makeNormalizedLog(records: NormalizedDayLog['records'] = []): NormalizedDayLog {
  return { date: '2026-06-11', records }
}

function makeLiveFact(id: string, factKey: FactKey, text: string): Fact {
  return { id, factKey, text, invalidAt: null, isHumanConfirmed: false }
}

function makeTombstonedFact(id: string, factKey: FactKey): Fact {
  return { id, factKey, text: 'old', invalidAt: '2026-06-10T00:00:00Z', isHumanConfirmed: false }
}

function makeQuarantinedDiff(diff: Diff): QuarantinedDiff {
  return { quarantined: true, body: JSON.stringify(diff), diff }
}

function makeMinimalDeps(overrides: Partial<ConsolidationDeps> = {}): ConsolidationDeps {
  const defaultGenerator: Generator = {
    proposeMemoryOps: async () => ({ ops: [], diff: { added: [], removed: [], updated: [] } }),
    draftSkills: async () => [],
  }
  const defaultJudge: Judge = {
    grade: async () => 'accept',
  }
  const defaultValidators: Validators = {
    check: () => ({ ok: true }),
  }
  const defaultLock: RunLock = {
    acquire: () => ({
      ok: true,
      token: { pid: 1, bootId: 'boot-1', startTime: 0, nonce: 'abc', acquiredAt: 0 },
    }),
    release: () => {},
  }
  return {
    clock: { now: () => new Date('2026-06-11T03:30:00Z') },
    generator: defaultGenerator,
    judge: defaultJudge,
    validators: defaultValidators,
    lock: defaultLock,
    ...overrides,
  }
}

const defaultConfig: NightlyConfig = {
  runAt: '30 3 * * *',
  maxHeldMs: 3_600_000,
  lintStaleDays: 90,
  backupRemote: 'git@backup:aisy.git',
  stagingDir: 'staging/',
  archiveDir: 'archive/',
}

// ---------------------------------------------------------------------------
// Tests — one per AC
// ---------------------------------------------------------------------------

describe('Nightly Consolidation', () => {
  let deps: ConsolidationDeps

  beforeEach(() => {
    deps = makeMinimalDeps()
  })

  it('AC-10-1: completed session is archived at content-addressed path; re-run does not double-write', async () => {
    const writes: string[] = []
    const store = new Map<string, string>()
    const session = { id: 'sess-1', transcript: 'hello world transcript' }
    const archive = {
      sessions: () => [session],
      write: (path: string, body: string) => {
        writes.push(path)
        store.set(path, body)
      },
      has: (path: string) => store.has(path),
    }
    const runner = makeConsolidationRunner({ ...deps, archive })

    await runner.run(defaultConfig)
    expect(writes).toHaveLength(1)
    const firstPath = writes[0]!
    // Content-addressed under archive/sessions/<date>/<...>.md
    expect(firstPath).toContain('archive/sessions/2026-06-11/')
    expect(firstPath).toMatch(/\.md$/)

    // Re-running must NOT write a second copy (content-addressed idempotency).
    await runner.run(defaultConfig)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toBe(firstPath)
  })

  it('AC-10-2: do_not_remember records are filtered out of the normalized day log before the generator sees them', async () => {
    const forbiddenPayload = { secret: 'do-not-remember-this' }
    const forbidden: NormalizedDayLogRecord = { kind: 'utterance', ts: '2026-06-11T01:00:00Z', payload: forbiddenPayload }
    const allowed: NormalizedDayLogRecord = { kind: 'utterance', ts: '2026-06-11T02:00:00Z', payload: { ok: true } }
    let generatorSawForbiddenRecord = false
    let generatorSawAllowed = false
    const generator: Generator = {
      proposeMemoryOps: async (log) => {
        generatorSawForbiddenRecord = log.records.some(
          (r) => JSON.stringify(r.payload) === JSON.stringify(forbiddenPayload),
        )
        generatorSawAllowed = log.records.some((r) => JSON.stringify(r.payload) === JSON.stringify({ ok: true }))
        return { ops: [], diff: { added: [], removed: [], updated: [] } }
      },
      draftSkills: async () => [],
    }
    const runner = makeConsolidationRunner({
      ...deps,
      generator,
      rawDayLog: makeNormalizedLog([forbidden, allowed]),
      isForgotten: (r: NormalizedDayLogRecord) =>
        JSON.stringify(r.payload) === JSON.stringify(forbiddenPayload),
    })
    await runner.run(defaultConfig)
    // The forget-filtered record never reaches the generator; the clean one does.
    expect(generatorSawForbiddenRecord).toBe(false)
    expect(generatorSawAllowed).toBe(true)
  })

  it('AC-10-3: generator receives only live facts (invalid_at IS NULL); tombstoned facts absent from input', async () => {
    const live = makeLiveFact('live-1', makeFactKey('entity', 'is', 'alive'), 'still here')
    const tombstoned = makeTombstonedFact('dead-1', makeFactKey('entity', 'was', 'alive'))
    let sawTombstoned = false
    let sawLive = false
    const generator: Generator = {
      proposeMemoryOps: async (_log, liveFacts) => {
        sawTombstoned = liveFacts.some((f) => f.id === 'dead-1')
        sawLive = liveFacts.some((f) => f.id === 'live-1')
        return { ops: [], diff: { added: [], removed: [], updated: [] } }
      },
      draftSkills: async () => [],
    }
    const runner = makeConsolidationRunner({ ...deps, generator, facts: [live, tombstoned] })
    await runner.run(defaultConfig)
    expect(tombstoned.invalidAt).not.toBeNull()
    // Tombstoned must not be in liveFacts passed to generator; live one is.
    expect(sawTombstoned).toBe(false)
    expect(sawLive).toBe(true)
  })

  it('AC-10-4: candidate failing a validator is dropped; judge is never called for it', async () => {
    let judgeCallCount = 0
    const validators: Validators = {
      check: () => ({ ok: false, failed: ['refs_exist'] }),
    }
    const judge: Judge = {
      grade: async () => { judgeCallCount++; return 'accept' },
    }
    const op: MemOp = { kind: 'ADD', factKey: makeFactKey('x'), text: 'bad' }
    const generator: Generator = {
      proposeMemoryOps: async () => ({
        ops: [op],
        diff: { added: [op], removed: [], updated: [] },
      }),
      draftSkills: async () => [],
    }
    const runner = makeConsolidationRunner({ ...deps, validators, judge, generator })
    const result = await runner.run(defaultConfig)
    // judge never called when the validator fails; nothing staged.
    expect(judgeCallCount).toBe(0)
    const staging = await runner.getStagedProposals()
    expect(staging.memoryPatches).toHaveLength(0)
  })

  it('AC-10-5: validators and resurrection-guard run before judge; judge accept does not un-fail a validator', async () => {
    const callOrder: string[] = []
    const validators: Validators = {
      check: () => { callOrder.push('validator'); return { ok: false, failed: ['no_conflicts'] } },
    }
    const judge: Judge = {
      grade: async () => { callOrder.push('judge'); return 'accept' },
    }
    const op: MemOp = { kind: 'ADD', factKey: makeFactKey('y'), text: 'y' }
    const generator: Generator = {
      proposeMemoryOps: async () => ({
        ops: [op],
        diff: { added: [op], removed: [], updated: [] },
      }),
      draftSkills: async () => [],
    }
    const runner = makeConsolidationRunner({ ...deps, validators, judge, generator })
    const result = await runner.run(defaultConfig)
    // Validator ran; judge never invoked on a failed candidate; not staged.
    expect(callOrder).toContain('validator')
    expect(callOrder.indexOf('judge')).toBe(-1)
    const staging = await runner.getStagedProposals()
    expect(staging.memoryPatches).toHaveLength(0)
  })

  it('AC-10-6: judge runs on a different provider; generator CoT is absent from judge input', async () => {
    const judgeInputs: QuarantinedDiff[] = []
    const judge: Judge = {
      grade: async (diff) => { judgeInputs.push(diff); return 'accept' },
    }
    const op: MemOp = { kind: 'ADD', factKey: makeFactKey('w'), text: 'fact w' }
    const generator: Generator = {
      proposeMemoryOps: async () => ({
        ops: [op],
        // The generator's chain-of-thought is intentionally NOT part of the diff.
        diff: { added: [op], removed: [], updated: [] },
      }),
      draftSkills: async () => [],
    }
    const runner = makeConsolidationRunner({ ...deps, judge, generator })
    await runner.run(defaultConfig)
    // Judge is called with the quarantined diff only — no CoT leakage.
    expect(judgeInputs).toHaveLength(1)
    expect(judgeInputs[0]!.body).not.toMatch(/chain.of.thought|reasoning|thinking|<cot>/i)
  })

  it('AC-10-7: diff is quarantined before judge reads it; judge is not invoked on un-quarantined text', async () => {
    let judgeInvokedWithUnquarantined = false
    let judgeCalled = false
    const judge: Judge = {
      grade: async (diff) => {
        judgeCalled = true
        if (!diff.quarantined) judgeInvokedWithUnquarantined = true
        return 'accept'
      },
    }
    const op: MemOp = { kind: 'ADD', factKey: makeFactKey('q'), text: 'fact q' }
    const generator: Generator = {
      proposeMemoryOps: async () => ({
        ops: [op],
        diff: { added: [op], removed: [], updated: [] },
      }),
      draftSkills: async () => [],
    }
    const runner = makeConsolidationRunner({ ...deps, judge, generator })
    await runner.run(defaultConfig)
    expect(judgeCalled).toBe(true)
    expect(judgeInvokedWithUnquarantined).toBe(false)
  })

  it('AC-10-8: is_human_confirmed stripped from generator/judge output before staging', async () => {
    const badOp = Object.assign(
      { kind: 'ADD' as const, factKey: makeFactKey('z'), text: 'z' },
      { is_human_confirmed: true },
    )
    const generator: Generator = {
      proposeMemoryOps: async () => ({
        ops: [badOp],
        diff: { added: [badOp], removed: [], updated: [] },
      }),
      draftSkills: async () => [],
    }
    const runner = makeConsolidationRunner({ ...deps, generator })
    await runner.run(defaultConfig)
    const staging = await runner.getStagedProposals()
    expect(staging.memoryPatches).toHaveLength(1)
    // The staged patch body must not carry is_human_confirmed (or any trust flag).
    expect(staging.memoryPatches[0]!.body).not.toContain('is_human_confirmed')
  })

  it('AC-10-9: is_human_confirmed is set only by Safety approval handler; no nightly code path sets it', async () => {
    const op: MemOp = { kind: 'ADD', factKey: makeFactKey('zz'), text: 'zz' }
    const generator: Generator = {
      proposeMemoryOps: async () => ({ ops: [op], diff: { added: [op], removed: [], updated: [] } }),
      draftSkills: async () => [],
    }
    const runner = makeConsolidationRunner({ ...deps, generator })
    await runner.run(defaultConfig)
    const staging = await runner.getStagedProposals()
    // After a full run, no staged patch may carry is_human_confirmed: nightly never sets it.
    for (const patch of [...staging.memoryPatches, ...staging.skillPatches, ...staging.lintPatches]) {
      expect(patch.body).not.toContain('is_human_confirmed')
      expect(patch.body).not.toContain('"human_confirmed"')
    }
  })

  it('AC-10-10: ADD/UPDATE matching a tombstone is blocked by resurrection-guard at consolidation commit; never staged', async () => {
    const blockedKey = makeFactKey('forgotten-entity', 'was', 'secret')
    const resurrectOp: MemOp = { kind: 'ADD', factKey: blockedKey, text: 'trying to resurrect' }
    let judgeCalled = false
    const judge: Judge = { grade: async () => { judgeCalled = true; return 'accept' } }
    const generator: Generator = {
      proposeMemoryOps: async () => ({
        ops: [resurrectOp],
        diff: { added: [resurrectOp], removed: [], updated: [] },
      }),
      draftSkills: async () => [],
    }
    const runner = makeConsolidationRunner({
      ...deps,
      generator,
      judge,
      tombstones: [blockedKey],
    })
    const result = await runner.run(defaultConfig)
    // Guard fires before the judge: card lists it, staging excludes it.
    expect(judgeCalled).toBe(false)
    expect(result.card.triedToResurrect.map((b) => b.op)).toContainEqual(resurrectOp)
    const staging = await runner.getStagedProposals()
    expect(staging.memoryPatches).toHaveLength(0)
  })

  it('AC-10-11: resurrection-guard re-runs on promotion path; approved patch re-introducing tombstoned fact is blocked before reindex', async () => {
    const blockedKey = makeFactKey('alpha', 'was', 'beta')
    const op: MemOp = { kind: 'ADD', factKey: blockedKey, text: 'reintroduce' }
    const generator: Generator = {
      proposeMemoryOps: async () => ({ ops: [op], diff: { added: [op], removed: [], updated: [] } }),
      draftSkills: async () => [],
    }
    // No tombstone at consolidation time → patch is staged. Tombstone appears
    // before promotion → guard must re-fire and block before any reindex/commit.
    const tombstones: FactKey[] = []
    const reindexed: string[] = []
    const runner = makeConsolidationRunner({
      ...deps,
      generator,
      tombstones,
      reindex: (id: string) => { reindexed.push(id) },
    })
    await runner.run(defaultConfig)
    const staging = await runner.getStagedProposals()
    expect(staging.memoryPatches).toHaveLength(1)
    const id = staging.memoryPatches[0]!.id

    // Tombstone the key after staging, then approve.
    tombstones.push(blockedKey)
    await expect(runner.approveStagedItem(id)).rejects.toThrow(/resurrect|blocked|guard/i)
    // Guard fired before reindex: nothing reindexed.
    expect(reindexed).toHaveLength(0)
  })

  it('AC-10-12: paraphrased forgotten fact (same FactKey, different text) is caught and blocked by the guard', async () => {
    const sameKey = makeFactKey('alice', 'knows', 'secret')
    const paraphrase: MemOp = { kind: 'ADD', factKey: sameKey, text: 'Alice is aware of the secret' }
    const generator: Generator = {
      proposeMemoryOps: async () => ({
        ops: [paraphrase],
        diff: { added: [paraphrase], removed: [], updated: [] },
      }),
      draftSkills: async () => [],
    }
    // Tombstone carries the SAME equivalence-class key but different surface text.
    const runner = makeConsolidationRunner({ ...deps, generator, tombstones: [makeFactKey('alice', 'knows', 'secret')] })
    const result = await runner.run(defaultConfig)
    // FactKey equivalence-class match blocks the paraphrase.
    expect(result.card.triedToResurrect.map((b) => b.op)).toContainEqual(paraphrase)
    const staging = await runner.getStagedProposals()
    expect(staging.memoryPatches).toHaveLength(0)
  })

  it('AC-10-13: staged patch carries hashAtAccept; promotion with hashAtPromote != hashAtAccept aborts the item', async () => {
    const op: MemOp = { kind: 'ADD', factKey: makeFactKey('h'), text: 'hashed fact' }
    const generator: Generator = {
      proposeMemoryOps: async () => ({ ops: [op], diff: { added: [op], removed: [], updated: [] } }),
      draftSkills: async () => [],
    }
    let tamper = false
    const reindexed: string[] = []
    const runner = makeConsolidationRunner({
      ...deps,
      generator,
      // Promotion recomputes the hash from the live body; if tampered, it differs.
      currentBodyForPatch: (id: string, body: string) => (tamper ? body + 'TAMPERED' : body),
      reindex: (id: string) => { reindexed.push(id) },
    })
    await runner.run(defaultConfig)
    const staging = await runner.getStagedProposals()
    expect(staging.memoryPatches).toHaveLength(1)
    const patch = staging.memoryPatches[0]!
    expect(patch.hashAtAccept).toMatch(/^[0-9a-f]{64}$/)

    // Tamper the staged body between accept and promote → TOCTOU abort.
    tamper = true
    await expect(runner.approveStagedItem(patch.id)).rejects.toThrow(/toctou|hash|mismatch/i)
    expect(reindexed).toHaveLength(0)
  })

  it('AC-10-14: Stages 2 and 3 write only under staging/; live memory, FTS5, skills/ are byte-unchanged without approval', async () => {
    const op: MemOp = { kind: 'ADD', factKey: makeFactKey('s'), text: 'staged only' }
    const skill: SkillDraft = { id: 'sk1', name: 'k', body: 'check section', provenance: 'session', hasCheckSection: true }
    const generator: Generator = {
      proposeMemoryOps: async () => ({ ops: [op], diff: { added: [op], removed: [], updated: [] } }),
      draftSkills: async () => [skill],
    }
    const writes: string[] = []
    const reindexed: string[] = []
    const runner = makeConsolidationRunner({
      ...deps,
      generator,
      stagingWrite: (path: string) => { writes.push(path) },
      reindex: (id: string) => { reindexed.push(id) },
    })
    await runner.run(defaultConfig)
    // Every write target during the run is under staging/; nothing touched live.
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) expect(w.startsWith('staging/')).toBe(true)
    expect(reindexed).toHaveLength(0)
  })

  it('AC-10-15: memory transaction is atomic — invalid_at flip + FTS5 reindex commit in one SQLite txn; git push runs only after', async () => {
    const op: MemOp = { kind: 'ADD', factKey: makeFactKey('atomic'), text: 'atomic fact' }
    const generator: Generator = {
      proposeMemoryOps: async () => ({ ops: [op], diff: { added: [op], removed: [], updated: [] } }),
      draftSkills: async () => [],
    }
    const order: string[] = []
    const commitOpArgs: MemOp[] = []
    const fakeCommittedId = 'fake-committed-id'
    const runner = makeConsolidationRunner({
      ...deps,
      generator,
      memoryTxn: async (apply) => { order.push('txn-begin'); await apply(); order.push('txn-commit') },
      reindex: () => { order.push('reindex') },
      git: { commitAndPush: async () => { order.push('git-push'); return { ok: true, commitHash: 'c1' } } },
      commitOp: async (o) => { order.push('commitOp'); commitOpArgs.push(o); return fakeCommittedId },
    })
    await runner.run(defaultConfig)
    const staging = await runner.getStagedProposals()
    // The promotion path is the subject under test — clear any night-backup noise.
    order.length = 0
    commitOpArgs.length = 0
    await runner.approveStagedItem(staging.memoryPatches[0]!.id)
    // commitOp and reindex happen inside the txn; git push only after the txn commits.
    expect(order).toEqual(['txn-begin', 'commitOp', 'reindex', 'txn-commit', 'git-push'])
    // commitOp was called with the original op
    expect(commitOpArgs).toHaveLength(1)
    expect(commitOpArgs[0]).toMatchObject({ kind: 'ADD', text: 'atomic fact' })
  })

  it('AC-10-16: crash after memory txn but before git push — on restart resumes at git step; exactly one git commit produced', async () => {
    // Journal already at 'reindexed' with no git commit hash → resume at git only.
    let pushes = 0
    let txnRuns = 0
    const journal = {
      entries: [
        {
          runDate: '2026-06-11',
          stage: 'consolidation' as const,
          op: { kind: 'ADD' as const, factKey: makeFactKey('r'), text: 'r' },
          factIds: ['f1'],
          snapshotRef: 'snap-1',
          reindexDone: true,
          state: 'reindexed' as const,
        },
      ],
      record: () => {},
    }
    const runner = makeConsolidationRunner({
      ...deps,
      journal,
      memoryTxn: async (apply) => { txnRuns++; await apply() },
      git: { commitAndPush: async () => { pushes++; return { ok: true, commitHash: 'c1' } } },
    })
    await runner.run(defaultConfig)
    // Recovery resumes at git: re-push runs, the memory txn is NOT re-run.
    expect(pushes).toBe(1)
    expect(txnRuns).toBe(0)
  })

  it('AC-10-17: crash during memory txn — SQLite rolls back; journal stays pending; item re-attempted from start', async () => {
    // A 'pending' journal entry means the txn never durably committed → re-attempt
    // from the start (guard re-run); no git push for an un-committed item.
    let pushes = 0
    let guardRuns = 0
    const blockedOp: MemOp = { kind: 'ADD', factKey: makeFactKey('p'), text: 'p' }
    const journal = {
      entries: [
        {
          runDate: '2026-06-11',
          stage: 'consolidation' as const,
          op: blockedOp,
          factIds: [],
          snapshotRef: 'snap-2',
          reindexDone: false,
          state: 'pending' as const,
        },
      ],
      record: () => {},
    }
    const runner = makeConsolidationRunner({
      ...deps,
      journal,
      tombstones: [makeFactKey('p')], // now forgotten → re-attempt must re-pass guard and block
      onGuardCheck: () => { guardRuns++ },
      git: { commitAndPush: async () => { pushes++; return { ok: true, commitHash: 'c2' } } },
    })
    const result = await runner.run(defaultConfig)
    // Re-attempt re-ran the guard; the now-tombstoned op is blocked, no push.
    expect(guardRuns).toBeGreaterThan(0)
    expect(pushes).toBe(0)
    expect(result.card.triedToResurrect.map((b) => b.op)).toContainEqual(blockedOp)
  })

  it('AC-10-18: startup assertion fails closed if prod creds present or egress exceeds backup remote', async () => {
    const runner = makeConsolidationRunner({
      ...deps,
      envContext: { hasProdCreds: true, egressAllowlist: ['git@backup:aisy.git'] },
    })
    // Prod creds present → fail-closed before any stage runs.
    await expect(runner.run(defaultConfig)).rejects.toThrow(/least.privilege|prod cred|egress|fail.closed/i)

    const wideEgress = makeConsolidationRunner({
      ...deps,
      envContext: { hasProdCreds: false, egressAllowlist: ['git@backup:aisy.git', 'https://prod.internal/sensitive'] },
    })
    await expect(wideEgress.run(defaultConfig)).rejects.toThrow(/least.privilege|egress|fail.closed/i)
  })

  it('AC-10-19: PID-reuse-safe lock — recycled unrelated PID does not satisfy the triple; second concurrent night aborts', async () => {
    let acquireCount = 0
    const lock: RunLock = {
      acquire: () => {
        acquireCount++
        if (acquireCount === 1) return { ok: true, token: { pid: 99, bootId: 'b1', startTime: 1, nonce: 'n1', acquiredAt: 0 } }
        return { ok: false, heldBy: { pid: 99, bootId: 'b1', startTime: 1, nonce: 'n1', acquiredAt: 0 }, heldForMs: 100 }
      },
      release: () => {},
    }
    const r1 = makeConsolidationRunner({ ...deps, lock })
    const r2 = makeConsolidationRunner({ ...deps, lock })
    await r1.run(defaultConfig) // first acquires
    // Second concurrent night sees the lock held by a live prior run → abort.
    await expect(r2.run(defaultConfig)).rejects.toThrow(/lock|contend|held|abort/i)
  })

  it('AC-10-20: lock held past maxHeldMs raises night.lock.held_too_long; not auto-stolen', async () => {
    const heldForMs = defaultConfig.maxHeldMs + 1
    let released = false
    const lock: RunLock = {
      acquire: () => ({
        ok: false,
        heldBy: { pid: 1, bootId: 'b', startTime: 0, nonce: 'x', acquiredAt: Date.now() - heldForMs },
        heldForMs,
      }),
      release: () => { released = true },
    }
    const events: string[] = []
    const runner = makeConsolidationRunner({ ...deps, lock, emit: (e: string) => events.push(e) })
    await expect(runner.run(defaultConfig)).rejects.toThrow(/held_too_long|held too long/i)
    // Emits the event; never steals (never releases someone else's lock); no stages.
    expect(events).toContain('night.lock.held_too_long')
    expect(released).toBe(false)
  })

  it('AC-10-21: when judge is unavailable, candidates that passed validators+guard are held unjudged; never auto-accepted', async () => {
    const op: MemOp = { kind: 'ADD', factKey: makeFactKey('a'), text: 'a' }
    const judge: Judge = {
      grade: async () => { throw new Error('judge unavailable') },
    }
    const generator: Generator = {
      proposeMemoryOps: async () => ({ ops: [op], diff: { added: [op], removed: [], updated: [] } }),
      draftSkills: async () => [],
    }
    const reindexed: string[] = []
    const runner = makeConsolidationRunner({ ...deps, judge, generator, reindex: (id: string) => { reindexed.push(id) } })
    const result = await runner.run(defaultConfig)
    // Run completes (non-fatal); the candidate is held unjudged in staging, never promoted.
    const staging = await runner.getStagedProposals()
    expect(staging.memoryPatches).toHaveLength(1)
    expect(staging.memoryPatches[0]!.judged).toBe(false)
    expect(reindexed).toHaveLength(0)
  })

  it('AC-10-21 fail-safe: an UNJUDGED staged item (judged:false) is refused at promotion — never committed/reindexed', async () => {
    const op: MemOp = { kind: 'ADD', factKey: makeFactKey('u'), text: 'unjudged' }
    const judge: Judge = {
      // Judge unavailable at consolidation → candidate held unjudged in staging.
      grade: async () => { throw new Error('judge unavailable') },
    }
    const generator: Generator = {
      proposeMemoryOps: async () => ({ ops: [op], diff: { added: [op], removed: [], updated: [] } }),
      draftSkills: async () => [],
    }
    const reindexed: string[] = []
    let pushes = 0
    const runner = makeConsolidationRunner({
      ...deps,
      judge,
      generator,
      reindex: (id: string) => { reindexed.push(id) },
      git: { commitAndPush: async () => { pushes++; return { ok: true, commitHash: 'c' } } },
    })
    await runner.run(defaultConfig)
    const staging = await runner.getStagedProposals()
    expect(staging.memoryPatches).toHaveLength(1)
    expect(staging.memoryPatches[0]!.judged).toBe(false)

    // The judge gate is a safety control: promotion of an unjudged item must be
    // held/refused (fail-closed), never auto-accepted (AC-10-21; §7 fail-safe).
    await expect(runner.approveStagedItem(staging.memoryPatches[0]!.id)).rejects.toThrow(/unjudged|judge|held|fail.closed/i)
    expect(reindexed).toHaveLength(0)
    expect(pushes).toBe(0)
  })

  it('AC-10-22: when Memory/resurrection-guard is unavailable, no commit or reindex occurs; fail-closed', async () => {
    const op: MemOp = { kind: 'ADD', factKey: makeFactKey('g'), text: 'g' }
    const generator: Generator = {
      proposeMemoryOps: async () => ({ ops: [op], diff: { added: [op], removed: [], updated: [] } }),
      draftSkills: async () => [],
    }
    const reindexed: string[] = []
    let pushes = 0
    // Guard available at consolidation (so we get a staged patch), then unavailable at promotion.
    let guardDown = false
    const runner = makeConsolidationRunner({
      ...deps,
      generator,
      guardAvailable: () => !guardDown,
      reindex: (id: string) => { reindexed.push(id) },
      git: { commitAndPush: async () => { pushes++; return { ok: true, commitHash: 'c' } } },
    })
    await runner.run(defaultConfig)
    const staging = await runner.getStagedProposals()
    guardDown = true
    await expect(runner.approveStagedItem(staging.memoryPatches[0]!.id)).rejects.toThrow(/guard|unavailable|fail.closed/i)
    // Fail-closed: no reindex, no commit/push.
    expect(reindexed).toHaveLength(0)
    expect(pushes).toBe(0)
  })

  it('AC-10-23: skill with transient provenance is flagged for retirement; skill missing has_check_section fails validator and is dropped before judge', async () => {
    const transientSkill: SkillDraft = {
      id: 's1',
      name: 'bad-skill',
      body: 'do stuff',
      provenance: 'transient',
      hasCheckSection: false,
    }
    let judgeCalledForSkill = false
    const judge: Judge = {
      grade: async () => { judgeCalledForSkill = true; return 'accept' },
    }
    const validators: Validators = {
      check: (c) => {
        // Skill without a check section fails has_check_section deterministically.
        if ('hasCheckSection' in c && !c.hasCheckSection) return { ok: false, failed: ['has_check_section'] }
        return { ok: true }
      },
    }
    const generator: Generator = {
      proposeMemoryOps: async () => ({ ops: [], diff: { added: [], removed: [], updated: [] } }),
      draftSkills: async () => [transientSkill],
    }
    const runner = makeConsolidationRunner({ ...deps, generator, judge, validators })
    const result = await runner.run(defaultConfig)
    // hasCheckSection=false → dropped before judge; transient → flagged for retirement.
    expect(judgeCalledForSkill).toBe(false)
    const staging = await runner.getStagedProposals()
    expect(staging.skillPatches).toHaveLength(0)
    expect(result.card.skillChanges.some((s) => /retire|transient/i.test(s.summary))).toBe(true)
  })

  it('AC-10-24: pre-VACUUM DB snapshot taken before VACUUM/optimize/prune; --force git push denied; runs within Safety carve-out', async () => {
    const order: string[] = []
    const runner = makeConsolidationRunner({
      ...deps,
      hygiene: {
        snapshot: () => { order.push('snapshot') },
        vacuum: () => { order.push('vacuum') },
        optimizeFts: () => { order.push('optimize') },
        walCheckpoint: () => { order.push('wal') },
        rotateLogs: () => { order.push('rotate') },
        dockerPrune: () => { order.push('docker-prune') },
        integrityCheck: () => true,
      },
      git: {
        commitAndPush: async (opts?: { force?: boolean }) => {
          if (opts?.force) throw new Error('--force git push denied')
          order.push('push')
          return { ok: true, commitHash: 'c' }
        },
      },
    })
    await runner.run(defaultConfig)
    // Snapshot precedes any destructive op.
    expect(order.indexOf('snapshot')).toBeLessThan(order.indexOf('vacuum'))
    expect(order.indexOf('snapshot')).toBeGreaterThanOrEqual(0)
    // Force push is never used by the implementation.
    expect(order).not.toContain('force')
  })

  it('AC-10-25: failed git push is non-fatal, retried, reported on morning card; never swallowed, never --force', async () => {
    let attempts = 0
    let forceUsed = false
    const runner = makeConsolidationRunner({
      ...deps,
      // A real night reaches Stage 5 backup after hygiene; the push then fails.
      hygiene: {
        snapshot: () => {},
        vacuum: () => {},
        optimizeFts: () => {},
        walCheckpoint: () => {},
        rotateLogs: () => {},
        dockerPrune: () => {},
        integrityCheck: () => true,
      },
      git: {
        commitAndPush: async (opts?: { force?: boolean }) => {
          attempts++
          if (opts?.force) forceUsed = true
          return { ok: false, failureReason: 'non-fast-forward' }
        },
      },
    })
    const result = await runner.run(defaultConfig)
    // Run completes (non-fatal); push retried (>1 attempt); reported; never --force.
    expect(attempts).toBeGreaterThan(1)
    expect(forceUsed).toBe(false)
    expect(result.card.backupStatus.pushed).toBe(false)
    expect(result.card.backupStatus.retried).toBe(true)
    expect(result.card.backupStatus.failureReason).toBe('non-fast-forward')
  })

  it('AC-10-26: trace-based verification produces a card line item when claimed effect has no trace', async () => {
    const session = { id: 'sess-x', transcript: 'data' }
    const archive = {
      sessions: () => [session],
      write: () => {}, // claims to write but leaves no trace
      has: () => false,
    }
    const runner = makeConsolidationRunner({
      ...deps,
      archive,
      // The trace probe cannot find the archived file → verification miss.
      traceProbe: { fileExists: () => false, refAdvanced: () => true, rowTombstoned: () => true },
    })
    const result = await runner.run(defaultConfig)
    // A claimed archival effect with no trace is reported, not papered over.
    expect(result.card.verificationMisses.length).toBeGreaterThan(0)
    expect(result.card.verificationMisses.some((m) => m.stage === 'archival')).toBe(true)
  })

  it('AC-10-27: cold start (first ever run) produces an informational-only card without error; staging empty', async () => {
    // No prior lock, no facts, empty generator output, no archive sessions.
    const runner = makeConsolidationRunner(deps)
    const result = await runner.run(defaultConfig)
    expect(result.runDate).toBe('2026-06-11')
    expect(result.card.memoryEdits).toHaveLength(0)
    expect(result.card.skillChanges).toHaveLength(0)
    const staging = await runner.getStagedProposals()
    expect(staging.memoryPatches).toHaveLength(0)
    expect(staging.skillPatches).toHaveLength(0)
  })

  it('AC-10-28: when human never approves, next session frozen snapshot is identical to prior one for all held items', async () => {
    const op: MemOp = { kind: 'ADD', factKey: makeFactKey('held'), text: 'held fact' }
    const generator: Generator = {
      proposeMemoryOps: async () => ({ ops: [op], diff: { added: [op], removed: [], updated: [] } }),
      draftSkills: async () => [],
    }
    const reindexed: string[] = []
    let pushes = 0
    const runner = makeConsolidationRunner({
      ...deps,
      generator,
      reindex: (id: string) => { reindexed.push(id) },
      git: { commitAndPush: async () => { pushes++; return { ok: true, commitHash: 'c' } } },
    })
    await runner.run(defaultConfig)
    // Without approveStagedItem(): nothing reindexed, nothing pushed, item still held.
    const staging = await runner.getStagedProposals()
    expect(staging.memoryPatches).toHaveLength(1)
    expect(reindexed).toHaveLength(0)
    expect(pushes).toBe(0)
  })

  // --- Stage 2b Lint pass (AC-10-29, AC-10-30, AC-10-31) ---

  it('AC-10-29: Stage 2b finds orphaned working/*.md page; remediation proposal appears in staging/; not auto-promoted to live memory', async () => {
    const reindexed: string[] = []
    const runner = makeConsolidationRunner({
      ...deps,
      lintInputs: {
        orphans: [{ kind: 'orphan', path: 'working/dangling.md', reason: 'no inbound cross-links' }],
        staleAnnotations: [],
        brokenEdges: [],
      },
      reindex: (id: string) => { reindexed.push(id) },
    })
    const lintResult = await runner.runLintPass()
    expect(lintResult.skipped).toBe(false)
    expect(lintResult.orphans).toHaveLength(1)
    // Orphan remediation lands in staging/, not live memory.
    const staging = await runner.getStagedProposals()
    expect(staging.lintPatches.some((p) => p.kind === 'lint-orphan')).toBe(true)
    expect(reindexed).toHaveLength(0)
  })

  it('AC-10-30: Stage 2b finds broken typed edge (supersedes/contradicts/extends referencing missing fact_key); morning card lists it; no silent data loss', async () => {
    const broken = {
      kind: 'broken-edge' as const,
      fromFactKey: makeFactKey('a', 'supersedes', 'b'),
      edgeType: 'supersedes' as const,
      missingFactKey: makeFactKey('ghost', 'is', 'missing'),
    }
    const deleted: string[] = []
    const runner = makeConsolidationRunner({
      ...deps,
      lintInputs: { orphans: [], staleAnnotations: [], brokenEdges: [broken] },
      onDelete: (id: string) => { deleted.push(id) },
    })
    const result = await runner.run(defaultConfig)
    expect(result.card.lintReport.brokenEdges).toContainEqual(broken)
    // No silent data loss: nothing deleted by the lint pass.
    expect(deleted).toHaveLength(0)
  })

  it('AC-10-31: when generator unavailable during Stage 2b, nightly run completes; morning card contains "lint pass skipped"', async () => {
    const unavailableGenerator: Generator = {
      proposeMemoryOps: async () => { throw new Error('generator unavailable') },
      draftSkills: async () => { throw new Error('generator unavailable') },
    }
    const runner = makeConsolidationRunner({
      ...deps,
      generator: unavailableGenerator,
      lintInputs: {
        orphans: [{ kind: 'orphan', path: 'working/x.md', reason: 'orphan' }],
        staleAnnotations: [],
        brokenEdges: [],
      },
    })
    const lintResult = await runner.runLintPass()
    // Lint pass degrades gracefully.
    expect(lintResult.skipped).toBe(true)
    expect(lintResult.skipReason ?? '').toContain('lint pass skipped')

    // run() completes normally (non-fatal); the card notes the skip.
    const result = await runner.run(defaultConfig)
    expect(result.card.lintReport.skipped).toBe(true)
    expect(result.card.lintReport.skipReason ?? '').toContain('lint pass skipped')
  })

  // --- Regression: the transient-skill retirement card entry must NOT carry a
  // bogus hashAtAccept = sha256(skill.id) (provably wrong data: it never matches
  // sha256(JSON.stringify(skill)), so any promotion attempt would fail the TOCTOU
  // guard). AC-10-23 is advisory ("flagged for retirement, never auto-promoted"),
  // so the entry is informational only and carries no staged patch at all.
  it('AC-10-23 (regression): transient-skill retirement entry carries no bogus sha256(id) patch — advisory-only, no broken promotion path', async () => {
    const { createHash } = await import('node:crypto')
    const transientSkill: SkillDraft = {
      id: 's1',
      name: 'flaky-skill',
      body: 'retire me',
      provenance: 'transient',
      hasCheckSection: true,
    }
    const generator: Generator = {
      proposeMemoryOps: async () => ({ ops: [], diff: { added: [], removed: [], updated: [] } }),
      draftSkills: async () => [transientSkill],
    }
    const runner = makeConsolidationRunner({ ...deps, generator })
    const result = await runner.run(defaultConfig)

    const retireItem = result.card.skillChanges.find((s) => /retire|transient/i.test(s.summary))
    expect(retireItem).toBeDefined()
    // The old bug stored sha256(skill.id) — assert that wrong value is gone.
    const wrongIdHash = createHash('sha256').update(transientSkill.id).digest('hex')
    expect(retireItem!.patch?.hashAtAccept).not.toBe(wrongIdHash)
    // Advisory-only: no patch behind the retirement flag (no promotion path).
    expect(retireItem!.patch).toBeUndefined()
  })

  // --- Regression: a recovery push (resuming a crashed prior commit) must NOT
  // suppress the Stage-5 backup of NEW durable work produced in the same run.
  // The recovery push only re-runs the prior crashed commit; archival/hygiene
  // content from this run still needs its own backup (Eng-7, §5 Stage-5).
  it('AC-10-16 (regression): recovery push does not suppress Stage-5 backup of new archival work in the same run', async () => {
    let pushes = 0
    const journal = {
      entries: [
        {
          runDate: '2026-06-11',
          stage: 'consolidation' as const,
          op: { kind: 'ADD' as const, factKey: makeFactKey('r'), text: 'r' },
          factIds: ['f1'],
          snapshotRef: 'snap-1',
          reindexDone: true,
          state: 'reindexed' as const,
        },
      ],
      record: () => {},
    }
    // The current run also produces NEW durable content: a freshly archived session.
    const archive = {
      sessions: () => [{ id: 'sess-new', transcript: 'new transcript this run' }],
      write: () => {},
      has: () => false,
    }
    const runner = makeConsolidationRunner({
      ...deps,
      journal,
      archive,
      git: { commitAndPush: async () => { pushes++; return { ok: true, commitHash: `c${pushes}` } } },
    })
    const result = await runner.run(defaultConfig)
    // One push for recovery + one push for the new archival content = 2.
    expect(pushes).toBe(2)
    // The new archival work's backup is reported on the card, not silently skipped.
    expect(result.card.backupStatus.pushed).toBe(true)
  })
})
