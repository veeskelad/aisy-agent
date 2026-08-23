import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  makeConsolidationRunner,
  makeMemoryStore,
  makeMemoryValidators,
  type Generator,
  type LockToken,
  type NightlyConfig,
  type RunLock,
} from '@aisy/core'
import { afterEach, describe, expect, it } from 'vitest'

import { makeNightlyLiveSnapshotLoader } from './nightly-live-snapshot.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const config: NightlyConfig = {
  runAt: '03:30',
  maxHeldMs: 3_600_000,
  lintStaleDays: 90,
  backupRemote: '',
  stagingDir: 'staging/',
  archiveDir: 'archive/',
}

function lock(): RunLock {
  return {
    acquire(): { ok: true; token: LockToken } {
      return {
        ok: true,
        token: { pid: 1, bootId: 'test', startTime: 0, nonce: 'nightly', acquiredAt: 0 },
      }
    },
    release(): void {},
  }
}

describe('nightly live snapshot production composition', () => {
  it('sees a fact committed after the first run without rebuilding the runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-nightly-live-'))
    roots.push(root)
    const store = makeMemoryStore({
      memoryRoot: join(root, 'memory'),
      dbPath: join(root, 'memory.db'),
      emitEvent: async () => undefined,
      nowIso: () => '2026-07-28T12:00:00.000Z',
    })
    await store.rebuildFromFiles()

    const seen: string[][] = []
    const generator: Generator = {
      async proposeMemoryOps(_log, facts) {
        seen.push(facts.map((fact) => fact.id))
        const target = facts[0]
        if (target === undefined) {
          return { ops: [], diff: { added: [], removed: [], updated: [] } }
        }
        const update = {
          kind: 'UPDATE' as const,
          factId: target.id,
          factKey: target.factKey,
          text: 'обновлённый факт',
        }
        return { ops: [update], diff: { added: [], removed: [], updated: [update] } }
      },
      draftSkills: async () => [],
    }
    const runner = makeConsolidationRunner({
      clock: { now: () => new Date('2026-07-28T03:30:00.000Z') },
      generator,
      judge: { grade: async () => 'accept' },
      validators: makeMemoryValidators({ liveFactIds: new Set() }),
      lock: lock(),
      loadRunSnapshot: makeNightlyLiveSnapshotLoader({ listLive: () => store.listLive() }),
    })

    const before = await runner.run(config)
    const committed = await store.commit(
      { op: 'ADD', text: 'факт, появившийся после запуска процесса' },
      { withinSession: false },
    )
    expect(committed.status).toBe('COMMITTED')
    expect((await store.listLive()).map((fact) => fact.id)).toEqual([committed.factId])
    const after = await runner.run(config)

    expect(seen).toEqual([[], [committed.factId]])
    expect(before.card.memoryEdits).toEqual([])
    expect(after.card.memoryEdits).toHaveLength(1)
  }, 15_000)
})
