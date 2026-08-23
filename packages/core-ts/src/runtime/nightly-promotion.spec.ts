// Integration test: nightly promotion path — end-to-end from run() through
// approveStagedItem() into a REAL makeMemoryStore.
// Intended to fail on pre-fix code (commitOp absent) and pass after Fix 1a/1b.

import { describe, it, expect } from 'vitest'
import { makeMemoryStore } from '../memory/index.js'
import { makeConsolidationRunner } from '../nightly/index.js'
import {
  makeMemoryValidators,
  liveFactsForNightly,
  memOpToMemoryOp,
} from './nightly-adapters.js'
import type {
  Generator,
  Judge,
  RunLock,
  NightlyConfig,
  MemOp,
  Fact,
  LockToken,
} from '../nightly/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDirSeq = 0

function makeTempDeps() {
  const root = `/tmp/aisy-test-nightly-promo/${process.pid}-${Date.now()}-${++testDirSeq}`
  return {
    memoryRoot: root,
    dbPath: `${root}/index.db`,
    nowIso: () => new Date().toISOString(),
    emitEvent: async (_event: string, _payload: unknown) => {},
  }
}

function makeStubLock(): RunLock {
  return {
    acquire(): { ok: true; token: LockToken } | { ok: false; heldBy: LockToken; heldForMs: number } {
      return { ok: true, token: { pid: 1, bootId: 'boot', startTime: 0, nonce: 'n', acquiredAt: 0 } }
    },
    release(): void {},
  }
}

const defaultConfig: NightlyConfig = {
  runAt: '30 3 * * *',
  maxHeldMs: 3_600_000,
  lintStaleDays: 90,
  backupRemote: '',
  stagingDir: 'staging/',
  archiveDir: 'archive/',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('nightly-promotion integration (REAL memoryStore + commitOp)', () => {
  it('ADD op: run → getStagedProposals → approveStagedItem → fact is live in memoryStore', async () => {
    const storeDeps = makeTempDeps()
    const memoryStore = makeMemoryStore(storeDeps)

    const addedText = 'integration test fact — hello from nightly promo'
    const addOp: MemOp = {
      kind: 'ADD',
      factKey: { entity: 'test', relation: 'has', object: 'fact' },
      text: addedText,
    }

    // Stub generator proposes one ADD op
    const stubGenerator: Generator = {
      proposeMemoryOps: async (_log, _liveFacts) => ({
        ops: [addOp],
        diff: { added: [addOp], removed: [], updated: [] },
      }),
      draftSkills: async () => [],
    }

    // Stub judge accepts everything
    const stubJudge: Judge = {
      grade: async () => 'accept',
    }

    const liveFacts = await memoryStore.listLive().catch(() => [] as Awaited<ReturnType<typeof memoryStore.listLive>>)
    const nightlyFacts: Fact[] = liveFactsForNightly(liveFacts)

    const runner = makeConsolidationRunner({
      clock: { now: () => new Date() },
      generator: stubGenerator,
      judge: stubJudge,
      validators: makeMemoryValidators({ liveFactIds: new Set(liveFacts.map((f) => f.id)) }),
      lock: makeStubLock(),
      facts: nightlyFacts,
      commitOp: async (op) => {
        const mop = memOpToMemoryOp(op)
        if (!mop) return null
        if (mop.op === 'DELETE') {
          await memoryStore.forget(mop.targetId, mop.reason, mop.humanConfirmed)
          return mop.targetId
        }
        const r = await memoryStore.commit(mop, { withinSession: false })
        return r.factId ?? null
      },
    })

    // 1. run() stages one memory patch
    await runner.run(defaultConfig)
    const staging = await runner.getStagedProposals()
    expect(staging.memoryPatches).toHaveLength(1)
    expect(staging.memoryPatches[0]!.judged).toBe(true)

    // 2. approveStagedItem() commits to live memory
    const patchId = staging.memoryPatches[0]!.id
    await runner.approveStagedItem(patchId)

    // 3. fact is now in listLive()
    const live = await memoryStore.listLive()
    const found = live.find((f) => f.text === addedText)
    expect(found).toBeDefined()
    expect(found!.text).toBe(addedText)
  })

  it('DELETE op: approveStagedItem → target fact is gone from listLive()', async () => {
    const storeDeps = makeTempDeps()
    const memoryStore = makeMemoryStore(storeDeps)

    // Seed a fact to be deleted
    const seedResult = await memoryStore.commit(
      { op: 'ADD', text: 'fact to be nightly-deleted' },
      { withinSession: false },
    )
    expect(seedResult.status).toBe('COMMITTED')
    const seedId = seedResult.factId!

    const deleteOp: MemOp = {
      kind: 'DELETE',
      factId: seedId,
      reason: 'nightly consolidation decided to remove this fact',
    }

    const stubGenerator: Generator = {
      proposeMemoryOps: async () => ({
        ops: [deleteOp],
        diff: { added: [], removed: [seedId], updated: [] },
      }),
      draftSkills: async () => [],
    }

    const stubJudge: Judge = {
      grade: async () => 'accept',
    }

    const liveFacts = await memoryStore.listLive()
    const nightlyFacts: Fact[] = liveFactsForNightly(liveFacts)

    const runner = makeConsolidationRunner({
      clock: { now: () => new Date() },
      generator: stubGenerator,
      judge: stubJudge,
      validators: makeMemoryValidators({ liveFactIds: new Set(liveFacts.map((f) => f.id)) }),
      lock: makeStubLock(),
      facts: nightlyFacts,
      commitOp: async (op) => {
        const mop = memOpToMemoryOp(op)
        if (!mop) return null
        if (mop.op === 'DELETE') {
          await memoryStore.forget(mop.targetId, mop.reason, mop.humanConfirmed)
          return mop.targetId
        }
        const r = await memoryStore.commit(mop, { withinSession: false })
        return r.factId ?? null
      },
    })

    // run() stages the DELETE
    await runner.run(defaultConfig)
    const staging = await runner.getStagedProposals()
    expect(staging.memoryPatches).toHaveLength(1)
    expect(staging.memoryPatches[0]!.judged).toBe(true)

    // Before approval: fact is still live
    const beforeApproval = await memoryStore.listLive()
    expect(beforeApproval.find((f) => f.id === seedId)).toBeDefined()

    // Approve: DELETE is promoted → fact is gone
    await runner.approveStagedItem(staging.memoryPatches[0]!.id)

    const afterApproval = await memoryStore.listLive()
    expect(afterApproval.find((f) => f.id === seedId)).toBeUndefined()
  })
})
