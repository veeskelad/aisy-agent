// packages/core-ts/src/runtime/nightly-adapters.spec.ts
import { describe, it, expect } from 'vitest'
import {
  makeFileRunLock,
  makeMemoryValidators,
  liveFactsForNightly,
  memOpToMemoryOp,
} from './nightly-adapters.js'
import type { MemoryFact } from '../memory/index.js'
import type { MemOp, SkillDraft } from '../nightly/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FsState = Map<string, string>

function makeFakeFs(initial: FsState = new Map()) {
  const store: FsState = new Map(initial)
  return {
    store,
    readFile: (p: string) => {
      const v = store.get(p)
      if (v === undefined) { const e = new Error(`ENOENT: ${p}`); (e as NodeJS.ErrnoException).code = 'ENOENT'; throw e }
      return v
    },
    writeFile: (p: string, s: string) => { store.set(p, s) },
    exists: (p: string) => store.has(p),
    removeFile: (p: string) => { store.delete(p) },
  }
}

const BASE_DEPS = {
  pid: 42,
  bootId: 'boot-abc',
  startTime: 100,
  lockPath: '/tmp/aisy-test.lock',
}

// ---------------------------------------------------------------------------
// makeFileRunLock
// ---------------------------------------------------------------------------

describe('makeFileRunLock', () => {
  it('acquire on empty lockfile succeeds and writes a token', () => {
    const fs = makeFakeFs()
    const now = () => 1000
    const lock = makeFileRunLock({ ...BASE_DEPS, ...fs, now, maxHeldMs: 7_200_000 })
    const result = lock.acquire()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.token.pid).toBe(42)
    expect(result.token.bootId).toBe('boot-abc')
    expect(result.token.startTime).toBe(100)
    expect(typeof result.token.nonce).toBe('string')
    expect(result.token.acquiredAt).toBe(1000)
    expect(fs.store.has('/tmp/aisy-test.lock')).toBe(true)
  })

  it('acquire when a live lock is held returns ok:false with heldBy and heldForMs', () => {
    const fs = makeFakeFs()
    const now = () => 1000
    const lock = makeFileRunLock({ ...BASE_DEPS, ...fs, now, maxHeldMs: 7_200_000 })
    // First acquire
    const first = lock.acquire()
    expect(first.ok).toBe(true)
    // Second acquire at t=2000
    const now2 = () => 2000
    const lock2 = makeFileRunLock({ ...BASE_DEPS, ...fs, now: now2, maxHeldMs: 7_200_000 })
    const second = lock2.acquire()
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.heldForMs).toBe(1000) // 2000 - 1000
    expect(second.heldBy.pid).toBe(42)
  })

  it('acquire takes over a stale lock (acquiredAt older than maxHeldMs)', () => {
    const fs = makeFakeFs()
    // First lock at t=0
    const lock1 = makeFileRunLock({ ...BASE_DEPS, ...fs, now: () => 0, maxHeldMs: 5000 })
    lock1.acquire()
    // Second lock at t=6000 (past maxHeldMs=5000)
    const lock2 = makeFileRunLock({ ...BASE_DEPS, ...fs, now: () => 6000, maxHeldMs: 5000 })
    const result = lock2.acquire()
    expect(result.ok).toBe(true)
  })

  it('acquire on a corrupt lockfile treats it as stale and takes over', () => {
    const fs = makeFakeFs(new Map([['/tmp/aisy-test.lock', '{not valid json]]']]))
    const lock = makeFileRunLock({ ...BASE_DEPS, ...fs, now: () => 9999, maxHeldMs: 7_200_000 })
    const result = lock.acquire()
    expect(result.ok).toBe(true)
  })

  it('release with matching nonce removes the lockfile', () => {
    const fs = makeFakeFs()
    const lock = makeFileRunLock({ ...BASE_DEPS, ...fs, now: () => 1000, maxHeldMs: 7_200_000 })
    const result = lock.acquire()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    lock.release(result.token)
    expect(fs.store.has('/tmp/aisy-test.lock')).toBe(false)
  })

  it('release with mismatched nonce is a no-op (does not remove the file)', () => {
    const fs = makeFakeFs()
    const lock = makeFileRunLock({ ...BASE_DEPS, ...fs, now: () => 1000, maxHeldMs: 7_200_000 })
    const result = lock.acquire()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const wrongToken = { ...result.token, nonce: 'wrong-nonce' }
    lock.release(wrongToken)
    expect(fs.store.has('/tmp/aisy-test.lock')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// makeMemoryValidators
// ---------------------------------------------------------------------------

describe('makeMemoryValidators', () => {
  const liveFactIds = new Set(['fact-1', 'fact-2'])
  const validators = makeMemoryValidators({ liveFactIds })

  it('UPDATE with unknown factId fails with refs_exist', () => {
    const op: MemOp = { kind: 'UPDATE', factId: 'unknown-id', factKey: { entity: 'e', relation: 'r', object: 'o' }, text: 'hello' }
    const result = validators.check(op)
    expect(result.ok).toBe(false)
    expect(result.failed).toContain('refs_exist')
  })

  it('DELETE with unknown factId fails with refs_exist', () => {
    const op: MemOp = { kind: 'DELETE', factId: 'unknown-id', reason: 'stale' }
    const result = validators.check(op)
    expect(result.ok).toBe(false)
    expect(result.failed).toContain('refs_exist')
  })

  it('ADD with empty text fails', () => {
    const op: MemOp = { kind: 'ADD', factKey: { entity: 'e', relation: 'r', object: 'o' }, text: '' }
    const result = validators.check(op)
    expect(result.ok).toBe(false)
    expect(result.failed).toBeDefined()
    expect((result.failed ?? []).length).toBeGreaterThan(0)
  })

  it('ADD with valid text passes', () => {
    const op: MemOp = { kind: 'ADD', factKey: { entity: 'e', relation: 'r', object: 'o' }, text: 'I live in Berlin' }
    const result = validators.check(op)
    expect(result.ok).toBe(true)
    expect(result.failed).toBeUndefined()
  })

  it('UPDATE with known factId passes', () => {
    const op: MemOp = { kind: 'UPDATE', factId: 'fact-1', factKey: { entity: 'e', relation: 'r', object: 'o' }, text: 'updated text' }
    const result = validators.check(op)
    expect(result.ok).toBe(true)
    expect(result.failed).toBeUndefined()
  })

  it('SkillDraft (no kind field) passes', () => {
    const draft: SkillDraft = { id: 's1', name: 'my-skill', body: '# body\n## Check\n- ok', provenance: 'session', hasCheckSection: true }
    const result = validators.check(draft)
    expect(result.ok).toBe(true)
    expect(result.failed).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// liveFactsForNightly
// ---------------------------------------------------------------------------

describe('liveFactsForNightly', () => {
  it('maps MemoryFact[] to nightly Fact[] correctly', () => {
    const facts: MemoryFact[] = [
      {
        id: 'f1',
        text: 'I live in Berlin',
        factKey: 'abc123',
        validAt: '2026-01-01T00:00:00Z',
        invalidAt: null,
        isHumanConfirmed: false,
        sourceAuthority: null,
        confidence: null,
        provenance: 'commit',
      },
      {
        id: 'f2',
        text: 'My name is Alex',
        factKey: 'def456',
        validAt: '2026-01-02T00:00:00Z',
        invalidAt: '2026-06-01T00:00:00Z',
        isHumanConfirmed: true,
        sourceAuthority: null,
        confidence: null,
        provenance: 'commit',
      },
    ]
    const nightlyFacts = liveFactsForNightly(facts)
    expect(nightlyFacts).toHaveLength(2)

    const f1 = nightlyFacts[0]!
    expect(f1.id).toBe('f1')
    expect(f1.text).toBe('I live in Berlin')
    expect(f1.factKey).toEqual({ entity: 'f1', relation: 'memory', object: 'abc123' })
    expect(f1.invalidAt).toBeNull()
    expect(f1.isHumanConfirmed).toBe(false)

    const f2 = nightlyFacts[1]!
    expect(f2.invalidAt).toBe('2026-06-01T00:00:00Z')
    expect(f2.isHumanConfirmed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// memOpToMemoryOp
// ---------------------------------------------------------------------------

describe('memOpToMemoryOp', () => {
  it('ADD maps to {op:ADD, text}', () => {
    const op: MemOp = { kind: 'ADD', factKey: { entity: 'e', relation: 'r', object: 'o' }, text: 'hello' }
    const result = memOpToMemoryOp(op)
    expect(result).not.toBeNull()
    expect(result!.op).toBe('ADD')
    if (result?.op === 'ADD') {
      expect(result.text).toBe('hello')
    }
  })

  it('UPDATE maps to {op:UPDATE, targetId, text}', () => {
    const op: MemOp = { kind: 'UPDATE', factId: 'fact-9', factKey: { entity: 'e', relation: 'r', object: 'o' }, text: 'updated' }
    const result = memOpToMemoryOp(op)
    expect(result).not.toBeNull()
    expect(result!.op).toBe('UPDATE')
    if (result?.op === 'UPDATE') {
      expect(result.targetId).toBe('fact-9')
      expect(result.text).toBe('updated')
    }
  })

  it('DELETE maps to {op:DELETE, targetId, humanConfirmed:false, reason}', () => {
    const op: MemOp = { kind: 'DELETE', factId: 'fact-5', reason: 'obsolete' }
    const result = memOpToMemoryOp(op)
    expect(result).not.toBeNull()
    expect(result!.op).toBe('DELETE')
    if (result?.op === 'DELETE') {
      expect(result.targetId).toBe('fact-5')
      expect(result.humanConfirmed).toBe(false)
      expect(result.reason).toBe('obsolete')
    }
  })

  it('NOOP maps to null', () => {
    const op: MemOp = { kind: 'NOOP', factId: 'fact-3' }
    const result = memOpToMemoryOp(op)
    expect(result).toBeNull()
  })
})
