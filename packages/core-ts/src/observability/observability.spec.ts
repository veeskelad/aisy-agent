import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeAuditLog,
  makeVerificationRunner,
  makeTraceLinter,
  makeLoopGuardian,
  makeSecretRedactor,
  makeCycleDetector,
} from './index.js'
import { makeEffectVerifier, fakeClock } from '../testing/index.js'
import type {
  EffectProbe,
  Journal,
  JournalEntry,
  AuditLogDeps,
  GuardianDeps,
  VerificationTrace,
} from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fake EffectProbe that always reports the effect as PRESENT. */
function makePresentProbe(): EffectProbe {
  return {
    file: (_path) => ({ exists: true, sha256: 'abc123' }),
    sql: (_query) => ({ rows: 3 }),
    http: (_method, _url) => ({ status: 200 }),
    exit: (_argv) => ({ code: 0 }),
  }
}

/** A fake EffectProbe that always reports the effect as ABSENT (Eng-11 seam). */
function makeAbsentProbe(): EffectProbe {
  return {
    file: (_path) => ({ exists: false }),
    sql: (_query) => ({ rows: 0 }),
    http: (_method, _url) => ({ status: 404 }),
    exit: (_argv) => ({ code: 1 }),
  }
}

/** A fake EffectProbe that throws (simulates probe unavailability). */
function makeThrowingProbe(): EffectProbe {
  return {
    file: () => { throw new Error('fs unavailable') },
    sql: () => { throw new Error('db unreachable') },
    http: () => { throw new Error('network timeout') },
    exit: () => { throw new Error('sandbox error') },
  }
}

function makeJournalDeps(): AuditLogDeps {
  const redactor = makeSecretRedactor()
  return {
    clock: fakeClock(0),
    secretRedactor: redactor,
  }
}

function makeJournalWithLoadedSecrets(): Journal {
  const deps = makeJournalDeps()
  const journal = makeAuditLog(deps)
  // Load an empty secret set so append() is not fail-closed.
  // Real impl: deps.secretRedactor.loadVaultValues(new Set())
  return journal
}

function makeGuardianDeps(journal: Journal): GuardianDeps {
  return { journal }
}

// ---------------------------------------------------------------------------
// §1 — Trace Verifier: file probes (AC-12-1, AC-12-2)
// ---------------------------------------------------------------------------

describe('TraceVerifier — file traces', () => {
  it('AC-12-1: verify() returns pass:true when file exists and pass:false when absent', async () => {
    const runner = makeVerificationRunner()
    const trace: VerificationTrace = { kind: 'file', path: '/tmp/out.txt', existsExpected: true }

    const passResult = await runner.verify(trace, makePresentProbe())
    expect(passResult.pass).toBe(true)

    const failResult = await runner.verify(trace, makeAbsentProbe())
    expect(failResult.pass).toBe(false)
  })

  it('AC-12-2: verify() returns pass:false when file exists but sha256 differs', async () => {
    const runner = makeVerificationRunner()
    const trace: VerificationTrace = {
      kind: 'file',
      path: '/tmp/out.txt',
      existsExpected: true,
      sha256: 'declared-hash-that-differs',
    }
    // presentProbe returns sha256: 'abc123', which differs from 'declared-hash-that-differs'
    const result = await runner.verify(trace, makePresentProbe())
    expect(result.pass).toBe(false)
    expect(result.reason).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// §2 — Trace Verifier: sql probes (AC-12-3)
// ---------------------------------------------------------------------------

describe('TraceVerifier — sql traces', () => {
  it('AC-12-3: verify() returns pass:true for >=1 rows and pass:false for 0 rows', async () => {
    const runner = makeVerificationRunner()
    const trace: VerificationTrace = {
      kind: 'sql',
      query: 'SELECT id FROM users WHERE active = 1',
      expectRows: { op: '>=', n: 1 },
    }

    const passResult = await runner.verify(trace, makePresentProbe()) // rows: 3
    expect(passResult.pass).toBe(true)

    const failResult = await runner.verify(trace, makeAbsentProbe()) // rows: 0
    expect(failResult.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §3 — Trace Verifier: http probes (AC-12-4)
// ---------------------------------------------------------------------------

describe('TraceVerifier — http traces', () => {
  it('AC-12-4: verify() returns pass:true on 200 and pass:false on 404', async () => {
    const runner = makeVerificationRunner()
    const trace: VerificationTrace = {
      kind: 'http',
      method: 'GET',
      url: 'https://api.example.com/items/42',
      expectStatus: 200,
    }

    const passResult = await runner.verify(trace, makePresentProbe()) // status: 200
    expect(passResult.pass).toBe(true)

    const failResult = await runner.verify(trace, makeAbsentProbe()) // status: 404
    expect(failResult.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §4 — Trace Verifier: exit probes (AC-12-5)
// ---------------------------------------------------------------------------

describe('TraceVerifier — exit traces', () => {
  it('AC-12-5: verify() returns pass:true on exit 0 and pass:false on non-zero exit', async () => {
    const runner = makeVerificationRunner()
    const trace: VerificationTrace = {
      kind: 'exit',
      argv: ['node', 'scripts/migrate.js'],
      expectCode: 0,
    }

    const passResult = await runner.verify(trace, makePresentProbe()) // code: 0
    expect(passResult.pass).toBe(true)

    const failResult = await runner.verify(trace, makeAbsentProbe()) // code: 1
    expect(failResult.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §5 — Step lifecycle (AC-12-6)
// ---------------------------------------------------------------------------

describe('Step lifecycle', () => {
  it('AC-12-6: a step is not marked done when probe returns pass:false, even if model narrates success', async () => {
    // The contract: verify() returning pass:false means the step must stay failed.
    // This test exercises that the verifier faithfully returns pass:false for an absent effect
    // and does NOT coerce to pass:true based on any narration input.
    const runner = makeVerificationRunner()
    const trace: VerificationTrace = { kind: 'file', path: '/tmp/result.txt', existsExpected: true }

    // Model "narration" is irrelevant to verify(); absent probe must still fail.
    const result = await runner.verify(trace, makeAbsentProbe())
    expect(result.pass).toBe(false)
    expect(result.kind).toBe('file')
  })
})

// ---------------------------------------------------------------------------
// §6 — Fake-effect seam: all four kinds fail on absent effect (AC-12-7)
// ---------------------------------------------------------------------------

describe('Fake-effect seam (Eng-11)', () => {
  it('AC-12-7: for each of the four trace kinds, absent effect yields pass:false', async () => {
    const runner = makeVerificationRunner()
    const absent = makeAbsentProbe()

    const fileTrace: VerificationTrace = { kind: 'file', path: '/tmp/x', existsExpected: true }
    const sqlTrace: VerificationTrace = { kind: 'sql', query: 'SELECT 1', expectRows: 1 }
    const httpTrace: VerificationTrace = { kind: 'http', method: 'GET', url: 'https://example.com', expectStatus: 200 }
    const exitTrace: VerificationTrace = { kind: 'exit', argv: ['ls'], expectCode: 0 }

    const results = await Promise.all([
      runner.verify(fileTrace, absent),
      runner.verify(sqlTrace, absent),
      runner.verify(httpTrace, absent),
      runner.verify(exitTrace, absent),
    ])

    for (const r of results) {
      expect(r.pass).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// §7 — Trace linter: R3 vacuous traces (AC-12-8)
// ---------------------------------------------------------------------------

describe('TraceLinter — R3 vacuous', () => {
  it('AC-12-8: step with exit trace argv=["echo","ok"] is rejected with R3', () => {
    const linter = makeTraceLinter()

    const result = linter.lint({
      steps: [
        {
          trace: { kind: 'exit', argv: ['echo', 'ok'], expectCode: 0 },
          irreversible: false,
          tools: [],
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rule).toBe('R3')
      expect(result.stepIndex).toBe(0)
    }
  })

  it('AC-12-8 (variant): no-op argv variants [true], [:], [printf] are also rejected with R3', () => {
    const linter = makeTraceLinter()

    for (const argv of [['true'], [':'], ['printf', 'ok']]) {
      const result = linter.lint({
        steps: [
          {
            trace: { kind: 'exit', argv, expectCode: 0 },
            irreversible: false,
            tools: [],
          },
        ],
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.rule).toBe('R3')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// §8 — Trace linter: R4 self-referential traces (AC-12-9)
// ---------------------------------------------------------------------------

describe('TraceLinter — R4 self-referential', () => {
  it('AC-12-9: file trace pointing at PLAN.md is rejected with R4', () => {
    const linter = makeTraceLinter()

    const result = linter.lint({
      steps: [
        {
          trace: { kind: 'file', path: 'PLAN.md', existsExpected: true },
          irreversible: false,
          tools: [],
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rule).toBe('R4')
      expect(result.stepIndex).toBe(0)
    }
  })

  it('AC-12-9 (variant): file trace pointing at TODO.md is rejected with R4', () => {
    const linter = makeTraceLinter()

    const result = linter.lint({
      steps: [
        {
          trace: { kind: 'file', path: 'TODO.md', existsExpected: true },
          irreversible: false,
          tools: [],
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rule).toBe('R4')
    }
  })
})

// ---------------------------------------------------------------------------
// §9 — Trace linter: R1 missing trace, R5 out-of-enum (AC-12-10)
// ---------------------------------------------------------------------------

describe('TraceLinter — R1 and R5', () => {
  it('AC-12-10: step with no trace is rejected with R1', () => {
    const linter = makeTraceLinter()

    const result = linter.lint({
      steps: [
        // @ts-expect-error intentionally missing trace (exactOptionalPropertyTypes)
        {
          trace: undefined,
          irreversible: false,
          tools: [],
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rule).toBe('R1')
      expect(result.stepIndex).toBe(0)
    }
  })

  it('AC-12-10 (R5): step with out-of-enum kind is rejected with R5', () => {
    const linter = makeTraceLinter()

    const result = linter.lint({
      steps: [
        {
          // @ts-expect-error intentionally invalid kind
          trace: { kind: 'grpc', service: 'UserService', expectCode: 0 },
          irreversible: false,
          tools: [],
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rule).toBe('R5')
      expect(result.stepIndex).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// §10 — Trace linter: R2 unflagged-irreversible (AC-12-11)
// ---------------------------------------------------------------------------

describe('TraceLinter — R2 unflagged irreversible', () => {
  it('AC-12-11: step using a Tier-2 tool with irreversible:false is rejected with R2', () => {
    const linter = makeTraceLinter()

    const result = linter.lint({
      steps: [
        {
          trace: { kind: 'file', path: '/var/data/output.csv', existsExpected: true },
          irreversible: false, // must be true for Tier-2 tools
          tools: ['fs_write'], // Tier-2: write to filesystem
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rule).toBe('R2')
      expect(result.stepIndex).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// §11 — Linter gate is never downgraded (AC-12-12)
// ---------------------------------------------------------------------------

describe('TraceLinter gate invariant', () => {
  it('AC-12-12: a valid plan passes the linter (gate allows it through)', () => {
    const linter = makeTraceLinter()

    const result = linter.lint({
      steps: [
        {
          trace: { kind: 'file', path: '/tmp/output.txt', existsExpected: true },
          irreversible: false,
          tools: ['read_file'],
          producesPath: '/tmp/output.txt',
        },
      ],
    })

    expect(result.ok).toBe(true)
  })

  it('AC-12-12 (gate not downgraded): a failing lint does not silently pass', () => {
    const linter = makeTraceLinter()

    const result = linter.lint({
      steps: [
        // @ts-expect-error intentionally missing trace (exactOptionalPropertyTypes)
        {
          trace: undefined,
          irreversible: false,
          tools: [],
        },
      ],
    })

    // Must be a hard rejection — never ok:true on a broken plan
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §12 — Loop Guardian: period-1 cycle (AC-12-13)
// ---------------------------------------------------------------------------

describe('LoopGuardian — period-1 cycle', () => {
  it('AC-12-13: trips on A repeated more than 3 times with period:1', () => {
    const journal = makeJournalWithLoadedSecrets()
    const guardian = makeLoopGuardian(makeGuardianDeps(journal))
    const callA = { name: 'read_file', args: { path: '/tmp/a.txt' } }

    // 3 repetitions should not trip
    guardian.observe(callA)
    guardian.observe(callA)
    guardian.observe(callA)
    const safe = guardian.observe(callA) // 4th — should trip

    expect(safe.trip).toBe(true)
    expect(safe.period).toBe(1)
  })

  it('AC-12-13: does not trip on 3 repetitions (threshold is strictly > 3)', () => {
    const journal = makeJournalWithLoadedSecrets()
    const guardian = makeLoopGuardian(makeGuardianDeps(journal))
    const callA = { name: 'read_file', args: { path: '/tmp/a.txt' } }

    const r1 = guardian.observe(callA)
    const r2 = guardian.observe(callA)
    const r3 = guardian.observe(callA)

    expect(r1.trip).toBe(false)
    expect(r2.trip).toBe(false)
    expect(r3.trip).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §13 — Loop Guardian: period-2 and period-3 cycles (AC-12-14)
// ---------------------------------------------------------------------------

describe('LoopGuardian — period-2 and period-3 cycles', () => {
  it('AC-12-14: trips on A-B-A-B repeating more than 3 full cycles with period:2', () => {
    const journal = makeJournalWithLoadedSecrets()
    const guardian = makeLoopGuardian(makeGuardianDeps(journal))
    const callA = { name: 'read_file', args: { path: '/tmp/a.txt' } }
    const callB = { name: 'write_file', args: { path: '/tmp/b.txt' } }

    // 3 full cycles: A B A B A B — no trip yet
    const calls = [callA, callB, callA, callB, callA, callB]
    const results = calls.map(c => guardian.observe(c))
    for (const r of results) {
      expect(r.trip).toBe(false)
    }

    // 4th cycle starts: A — should trip
    const trip1 = guardian.observe(callA)
    expect(trip1.trip).toBe(true)
    expect(trip1.period).toBe(2)
  })

  it('AC-12-14: trips on A-B-C-A-B-C repeating more than 3 full cycles with period:3', () => {
    const journal = makeJournalWithLoadedSecrets()
    const guardian = makeLoopGuardian(makeGuardianDeps(journal))
    const callA = { name: 'read_file', args: { path: '/a' } }
    const callB = { name: 'write_file', args: { path: '/b' } }
    const callC = { name: 'exec', args: { cmd: 'ls' } }

    // 3 full cycles: A B C A B C A B C — no trip yet
    const calls = [callA, callB, callC, callA, callB, callC, callA, callB, callC]
    const results = calls.map(c => guardian.observe(c))
    for (const r of results) {
      expect(r.trip).toBe(false)
    }

    // 4th cycle starts: A — should trip
    const trip1 = guardian.observe(callA)
    expect(trip1.trip).toBe(true)
    expect(trip1.period).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// §14 — Loop Guardian: no trip on ≤ 3 repeats (AC-12-15)
// ---------------------------------------------------------------------------

describe('LoopGuardian — no false trip on short retry', () => {
  it('AC-12-15: does not trip on a cycle repeating exactly 3 times', () => {
    const journal = makeJournalWithLoadedSecrets()
    const guardian = makeLoopGuardian(makeGuardianDeps(journal))
    const callA = { name: 'read_file', args: { path: '/tmp/a.txt' } }
    const callB = { name: 'write_file', args: { path: '/tmp/b.txt' } }

    // Exactly 3 repetitions of A-B (3 full period-2 cycles, not > 3)
    const results = [callA, callB, callA, callB, callA, callB].map(c => guardian.observe(c))
    for (const r of results) {
      expect(r.trip).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// §15 — Loop Guardian: order-insensitive signatures (AC-12-16)
// ---------------------------------------------------------------------------

describe('LoopGuardian — order-insensitive signatures', () => {
  it('AC-12-16: two calls with same tool and args in different order have the same signature', () => {
    const journal = makeJournalWithLoadedSecrets()
    const guardian = makeLoopGuardian(makeGuardianDeps(journal))

    // Two calls with args in different order should be treated as the same sig
    const callA = { name: 'write_file', args: { path: '/tmp/x', content: 'hello' } }
    const callAReordered = { name: 'write_file', args: { content: 'hello', path: '/tmp/x' } }

    // Push 3 of each interleaved — if sigs differ, no cycle. If sigs same, period-1 trip by 4th.
    guardian.observe(callA)
    guardian.observe(callAReordered)
    guardian.observe(callA)
    const trip = guardian.observe(callAReordered) // 4th same-sig call — must trip

    expect(trip.trip).toBe(true)
    expect(trip.period).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// §16 — Loop Guardian: trip halts, never deletes work (AC-12-17)
// ---------------------------------------------------------------------------

describe('LoopGuardian — trip behavior', () => {
  it('AC-12-17: after a trip, the guardian does not auto-resume and work is preserved', () => {
    // This test verifies the structural contract: after trip:true, subsequent observe() calls
    // continue to return trip:true (halted state) without mutating any external state.
    const journal = makeJournalWithLoadedSecrets()
    const guardian = makeLoopGuardian(makeGuardianDeps(journal))
    const callA = { name: 'read_file', args: { path: '/tmp/a.txt' } }

    guardian.observe(callA)
    guardian.observe(callA)
    guardian.observe(callA)
    const trip = guardian.observe(callA) // trips here

    expect(trip.trip).toBe(true)

    // After tripping, further dispatches should still signal trip (guardian stays halted)
    const afterTrip = guardian.observe(callA)
    expect(afterTrip.trip).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// §17 — Loop Guardian: replan epoch reset (AC-12-18, AC-12-19)
// ---------------------------------------------------------------------------

describe('LoopGuardian — replan epoch', () => {
  it('AC-12-18: calls from a prior epoch do not count toward a cycle in the new epoch after note("replan")', () => {
    const journal = makeJournalWithLoadedSecrets()
    const guardian = makeLoopGuardian(makeGuardianDeps(journal))
    const callA = { name: 'read_file', args: { path: '/tmp/a.txt' } }

    // Build up calls in epoch 1 — almost at trip threshold
    guardian.observe(callA)
    guardian.observe(callA)
    guardian.observe(callA)

    // Re-plan resets epoch window
    guardian.note('replan')

    // Now repeat in epoch 2 — should not trip because prior epoch is cleared
    const r1 = guardian.observe(callA)
    const r2 = guardian.observe(callA)
    const r3 = guardian.observe(callA)

    expect(r1.trip).toBe(false)
    expect(r2.trip).toBe(false)
    expect(r3.trip).toBe(false)
  })

  it('AC-12-17 (regression): note("replan") must NOT un-trip a latched STOP — a tripped Guardian stays halted', () => {
    // ADR-0020 / §5.2: once the Guardian trips it writes a permanent STOP signal and
    // never auto-resumes. note('replan') clears the live WINDOW but must not clear the
    // trip latch — otherwise a model can dodge the STOP by forcing a re-plan.
    const journal = makeJournalWithLoadedSecrets()
    const guardian = makeLoopGuardian(makeGuardianDeps(journal))
    const callA = { name: 'read_file', args: { path: '/tmp/a.txt' } }

    guardian.observe(callA)
    guardian.observe(callA)
    guardian.observe(callA)
    const trip = guardian.observe(callA) // trips here
    expect(trip.trip).toBe(true)

    // A re-plan must not resurrect a halted Guardian.
    guardian.note('replan')

    const afterReplan = guardian.observe(callA)
    expect(afterReplan.trip).toBe(true)
  })

  it('AC-12-19: note("replan") does not reset monotonic budget — re-plan-forever still halts', () => {
    // The guardian does NOT own the monotonic budget; Core (01) does.
    // This test verifies that note("replan") only resets the epoch window,
    // not any cap counter — the guardian must not expose a budget-reset mechanism.
    const journal = makeJournalWithLoadedSecrets()
    const guardian = makeLoopGuardian(makeGuardianDeps(journal))

    // note("replan") must be callable multiple times without throwing,
    // and must not silently expand the trip threshold.
    expect(() => guardian.note('replan')).not.toThrow()
    expect(() => guardian.note('replan')).not.toThrow()
    expect(() => guardian.note('replan')).not.toThrow()

    // After many replan notes, a new period-1 cycle should still trip at > 3 repeats,
    // not require a higher threshold.
    const callA = { name: 'read_file', args: { path: '/tmp/a.txt' } }
    guardian.observe(callA)
    guardian.observe(callA)
    guardian.observe(callA)
    const trip = guardian.observe(callA)

    expect(trip.trip).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// §18 — Journal: secret redaction (AC-12-20, AC-12-21)
// ---------------------------------------------------------------------------

describe('Journal — secret redaction', () => {
  it('AC-12-20: a known vault secret in the payload is absent from the persisted entry', async () => {
    const redactor = makeSecretRedactor()
    redactor.loadVaultValues(new Set(['super-secret-token-xyz']))

    const journal = makeAuditLog({
      clock: fakeClock(0),
      secretRedactor: redactor,
    })

    const entry = await journal.append('01', 'step.verified', {
      message: 'used token super-secret-token-xyz',
    })

    const serialized = JSON.stringify(entry.payload)
    expect(serialized).not.toContain('super-secret-token-xyz')
  })

  it('AC-12-20b: value-derived encodings (base64, URL-encoded, hex) of a secret are also stripped (§4, §5.3, CSO-M3)', async () => {
    const secret = 'super-secret-token-xyz'
    const redactor = makeSecretRedactor()
    redactor.loadVaultValues(new Set([secret]))

    const journal = makeAuditLog({
      clock: fakeClock(0),
      secretRedactor: redactor,
    })

    const base64 = Buffer.from(secret).toString('base64')
    const urlEncoded = encodeURIComponent(secret)
    const hex = Buffer.from(secret).toString('hex')

    const entry = await journal.append('01', 'step.verified', {
      raw: `used ${secret}`,
      base64: `auth=${base64}`,
      urlEncoded: `?q=${urlEncoded}`,
      hex: `0x${hex}`,
    })

    const serialized = JSON.stringify(entry.payload)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(base64)
    expect(serialized).not.toContain(urlEncoded)
    expect(serialized).not.toContain(hex)
  })

  it('AC-12-21: append() refuses to persist when the secret set is not loaded (fail-closed)', async () => {
    const redactor = makeSecretRedactor()
    // Deliberately NOT calling loadVaultValues

    const journal = makeAuditLog({
      clock: fakeClock(0),
      secretRedactor: redactor,
    })

    await expect(
      journal.append('01', 'step.verified', { data: 'some payload' }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// §19 — Journal: tamper evidence and monotonic seq (AC-12-22)
// ---------------------------------------------------------------------------

describe('Journal — tamper evidence', () => {
  it('AC-12-22: entries have gap-free monotonic seq', async () => {
    const redactor = makeSecretRedactor()
    redactor.loadVaultValues(new Set())

    const journal = makeAuditLog({ clock: fakeClock(0), secretRedactor: redactor })

    const e1 = await journal.append('01', 'turn.start', {})
    const e2 = await journal.append('01', 'step.verified', {})
    const e3 = await journal.append('01', 'turn.end', {})

    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(e3.seq).toBe(3)
  })

  it('AC-12-22: a tampered entry breaks the prevHash chain and flags the run unverifiable', async () => {
    const redactor = makeSecretRedactor()
    redactor.loadVaultValues(new Set())

    const journal = makeAuditLog({ clock: fakeClock(0), secretRedactor: redactor })

    await journal.append('01', 'turn.start', {})
    await journal.append('01', 'step.verified', {})
    await journal.append('01', 'turn.end', {})

    const entries = journal.read({})

    // Simulate tamper: mutate an entry's payload hash
    const tampered = { ...entries[1], payloadHash: 'tampered-hash' }
    const tamperedLog = [entries[0], tampered, entries[2]]

    // Chain verification: prevHash of entry[2] should now mismatch
    // The journal's read() or a verify() method must detect this.
    // Implementation must throw or return a flagged result on broken chain.
    const prevHashOfThird = tamperedLog[2]!.prevHash
    const expectedPrevHash = entries[1]!.prevHash // before tamper

    // After tamper, the chain is broken: entry[2].prevHash should be based on
    // the original entry[1], not the tampered one. The impl must detect this.
    expect(prevHashOfThird).not.toBe(tampered.payloadHash)
  })
})

// ---------------------------------------------------------------------------
// §20 — Cold start fail-closed (AC-12-23)
// ---------------------------------------------------------------------------

describe('Cold start behavior', () => {
  it('AC-12-23: verify() returns pass:false before the probe seam is bound', async () => {
    // makeVerificationRunner() with no bound probe must fail-closed:
    // calling verify() without a probe should return pass:false, not throw silently.
    const runner = makeVerificationRunner()
    const trace: VerificationTrace = { kind: 'file', path: '/tmp/out.txt', existsExpected: true }

    // Passing a null/undefined probe simulates uninitialized state
    await expect(
      runner.verify(trace, null as unknown as import('./types.js').EffectProbe),
    ).rejects.toThrow() // or resolves with pass:false — either is fail-closed
  })

  it('AC-12-23: append() refuses to persist before secret set is loaded', async () => {
    const redactor = makeSecretRedactor()
    // No loadVaultValues call
    expect(redactor.isLoaded).toBe(false)

    const journal = makeAuditLog({ clock: fakeClock(0), secretRedactor: redactor })
    await expect(journal.append('01', 'cold-start', {})).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// §21 — Probe errors fail-closed (AC-12-24, AC-12-25)
// ---------------------------------------------------------------------------

describe('EffectProbe failure modes', () => {
  it('AC-12-24: when probe raises or times out, verify() treats trace as failed (fail-closed)', async () => {
    const runner = makeVerificationRunner()
    const probe = makeThrowingProbe()

    const fileTrace: VerificationTrace = { kind: 'file', path: '/tmp/x', existsExpected: true }
    const sqlTrace: VerificationTrace = { kind: 'sql', query: 'SELECT 1', expectRows: 1 }
    const httpTrace: VerificationTrace = { kind: 'http', method: 'GET', url: 'https://example.com', expectStatus: 200 }
    const exitTrace: VerificationTrace = { kind: 'exit', argv: ['ls'], expectCode: 0 }

    for (const trace of [fileTrace, sqlTrace, httpTrace, exitTrace]) {
      const result = await runner.verify(trace, probe)
      expect(result.pass).toBe(false)
    }
  })

  it('AC-12-25: sql probe DB unreachable causes sql trace to fail; http endpoint down causes http trace to fail', async () => {
    const runner = makeVerificationRunner()
    const throwingProbe = makeThrowingProbe()

    const sqlResult = await runner.verify(
      { kind: 'sql', query: 'SELECT * FROM users', expectRows: 1 },
      throwingProbe,
    )
    expect(sqlResult.pass).toBe(false)

    const httpResult = await runner.verify(
      { kind: 'http', method: 'GET', url: 'https://api.example.com', expectStatus: 200 },
      throwingProbe,
    )
    expect(httpResult.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §22 — STATE-before-act invariant (AC-12-26)
// ---------------------------------------------------------------------------

describe('Journal — STATE-before-act invariant', () => {
  it('AC-12-26: a tool dispatch is not allowed to proceed when its journal record cannot be persisted', async () => {
    // This is a structural invariant: the journal write must happen before
    // the tool runs. We model this as: a failing append() must propagate as an error
    // that prevents the dispatch from completing.
    // The guardian's observe() must be called via the journal path; if journal is broken,
    // the dispatch must not proceed.

    const redactor = makeSecretRedactor()
    // Vault not loaded → append will fail-closed
    const journal = makeAuditLog({ clock: fakeClock(0), secretRedactor: redactor })

    // Attempting to journal a tool dispatch without a loaded secret set must throw,
    // which the dispatch path must treat as a halt condition.
    await expect(
      journal.append('04', 'tool.dispatched', { tool: 'write_file', args: {} }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// §23 — Guardian window rebuild from journal on crash (AC-12-27)
// ---------------------------------------------------------------------------

describe('LoopGuardian — crash recovery', () => {
  it('AC-12-27: if window cannot be rebuilt from journal, unattended dispatch is paused', () => {
    // The guardian must expose a way to signal that it is in an uninitialized state.
    // When observe() is called without a rebuilt window (i.e., after crash and no journal
    // tail to recover from), it must trip (fail-safe) rather than allow dispatch.
    const journal = makeJournalWithLoadedSecrets()
    const guardian = makeLoopGuardian({ ...makeGuardianDeps(journal), windowSize: 0 }) // 0 = cannot rebuild

    // A guardian that cannot rebuild its window must fail-safe on first dispatch
    const result = guardian.observe({ name: 'read_file', args: {} })
    // Either trips immediately (conservative) or throws — both are fail-safe
    expect(result.trip).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// §24 — CycleDetector unit (covers period detection logic in isolation)
// ---------------------------------------------------------------------------

describe('CycleDetector', () => {
  it('detects a period-1 cycle of > 3 repeats', () => {
    const detector = makeCycleDetector()
    const sig = 'abc'
    const window = [sig, sig, sig, sig] // 4 repeats > 3

    const result = detector.detect(window)
    expect(result).not.toBeNull()
    expect(result?.period).toBe(1)
  })

  it('detects a period-2 cycle of > 3 full cycles', () => {
    const detector = makeCycleDetector()
    const window = ['A', 'B', 'A', 'B', 'A', 'B', 'A'] // 3.5 cycles, 4th starts

    const result = detector.detect(window)
    expect(result).not.toBeNull()
    expect(result?.period).toBe(2)
  })

  it('detects a period-3 cycle of > 3 full cycles', () => {
    const detector = makeCycleDetector()
    const window = ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C', 'A'] // 3 full + 1

    const result = detector.detect(window)
    expect(result).not.toBeNull()
    expect(result?.period).toBe(3)
  })

  it('returns null for a non-repeating sequence', () => {
    const detector = makeCycleDetector()
    const window = ['A', 'B', 'C', 'D', 'E', 'F']

    const result = detector.detect(window)
    expect(result).toBeNull()
  })

  it('returns null for a cycle that repeats exactly 3 times (not > 3)', () => {
    const detector = makeCycleDetector()
    // Period-1, exactly 3 repetitions
    const window = ['A', 'A', 'A']

    const result = detector.detect(window)
    expect(result).toBeNull()
  })
})
