import { describe, expect, it } from 'vitest'
import type { PendingAction } from '@aisy/core'
import {
  decodeDurableTurnCallback,
  encodeDurableTurnCallback,
  makeTelegramTurnAuthority,
  runTelegramBoundGoalTurn,
  runTelegramRuntimeTurn,
  resolveTelegramSessionId,
  withTelegramTurnRuntime,
  type SessionApprovalFactory,
  type TelegramTurnRuntime,
} from './bot.js'

const BINDING = {
  operatorId: 'operator-1',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'goal-system-a',
  scope: 'project' as const,
}

describe('resolveTelegramSessionId', () => {
  it('uses the durable project session id when supplied', () => {
    expect(resolveTelegramSessionId(42, 'project-session-7')).toBe('project-session-7')
  })

  it('preserves the legacy chat-id fallback', () => {
    expect(resolveTelegramSessionId(42)).toBe('42')
  })
})

describe('makeTelegramTurnAuthority', () => {
  it('derives stable content-independent authority for an exact Telegram batch', () => {
    const sources = [
      { updateId: 105, unixSeconds: Date.parse('2026-07-27T00:20:05.000Z') / 1000 },
      { updateId: 106, unixSeconds: Date.parse('2026-07-27T00:20:03.000Z') / 1000 },
    ]

    const first = makeTelegramTurnAuthority(42, sources)
    const retry = makeTelegramTurnAuthority(42, structuredClone(sources))

    expect(retry).toEqual(first)
    expect(first.turnId).toMatch(/^telegram:42:[a-f0-9]{64}$/)
    expect(first.turnTs).toBe('2026-07-27T00:20:03.000Z')
  })

  it('changes identity when batch membership or ordering changes', () => {
    const a = { updateId: 105, unixSeconds: 1_785_116_403 }
    const b = { updateId: 106, unixSeconds: 1_785_116_405 }

    expect(makeTelegramTurnAuthority(42, [a, b]).turnId)
      .not.toBe(makeTelegramTurnAuthority(42, [b, a]).turnId)
    expect(makeTelegramTurnAuthority(42, [a]).turnId)
      .not.toBe(makeTelegramTurnAuthority(42, [a, b]).turnId)
  })

  it('rejects missing or invalid transport metadata', () => {
    expect(() => makeTelegramTurnAuthority(42, [])).toThrow('TELEGRAM_TURN_AUTHORITY_INVALID')
    expect(() => makeTelegramTurnAuthority(42, [{ updateId: -1, unixSeconds: 1 }]))
      .toThrow('TELEGRAM_TURN_AUTHORITY_INVALID')
    expect(() => makeTelegramTurnAuthority(42, [
      { updateId: 1, unixSeconds: 1 },
      { updateId: 1, unixSeconds: 2 },
    ])).toThrow('TELEGRAM_TURN_AUTHORITY_INVALID')
  })
})

describe('durable turn callback codec', () => {
  it('round-trips a bounded opaque actor and nonce under Telegram limit', () => {
    const encoded = encodeDurableTurnCallback('a1AbCdEfGh', 'Zx_1234567890', 'retry-once')
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(64)
    expect(decodeDurableTurnCallback(encoded)).toEqual({
      actorId: 'a1AbCdEfGh', nonce: 'Zx_1234567890', decision: 'retry-once',
    })
  })

  it('rejects oversized, structural and unknown callback data', () => {
    expect(() => encodeDurableTurnCallback('a'.repeat(25), 'nonce', 'cancel'))
      .toThrow('DURABLE_TURN_CALLBACK_INVALID')
    expect(decodeDurableTurnCallback('dt:actor:nonce:x')).toBeNull()
    expect(decodeDurableTurnCallback('dt:actor:nonce:r:extra')).toBeNull()
  })
})

describe('runTelegramRuntimeTurn', () => {
  it('passes the exact transport authority to AgentRunner', async () => {
    const seen: unknown[] = []
    const turnRuntime: TelegramTurnRuntime = {
      sessionId: 'session-a',
      runner: {
        handle: async (input) => {
          seen.push(input)
          return { state: 'ok', reply: 'done', narrowed: false }
        },
      },
    }
    const authority = makeTelegramTurnAuthority(42, [{
      updateId: 105,
      unixSeconds: Date.parse('2026-07-27T00:20:03.000Z') / 1000,
    }])
    const signal = new AbortController().signal

    await expect(runTelegramRuntimeTurn({
      runtime: turnRuntime,
      authority,
      spans: [{ role: 'user', provenance: 'operator', text: 'hello' }],
      signal,
    })).resolves.toMatchObject({ state: 'ok', reply: 'done' })
    expect(seen).toEqual([{
      sessionId: 'session-a',
      ...authority,
      spans: [{ role: 'user', provenance: 'operator', text: 'hello' }],
      signal,
    }])
  })
})

function runtime(sessionId: string, release?: () => Promise<void>): TelegramTurnRuntime {
  return {
    sessionId,
    runner: { handle: async () => ({ state: 'ok', reply: '', narrowed: false }) },
    ...(release === undefined ? {} : { release }),
  }
}

const approvals: SessionApprovalFactory = (sessionId) => async (_action: PendingAction) => ({
  decision: sessionId.length > 0 ? 'confirmed' : 'rejected',
})

describe('withTelegramTurnRuntime', () => {
  it('uses the freshly acquired runtime instead of the legacy session', async () => {
    const seen: string[] = []
    const result = await withTelegramTurnRuntime({
      acquire: async (approvalForSession) => {
        const decision = await approvalForSession('session-v2')({} as PendingAction)
        expect(decision).toEqual({ decision: 'confirmed' })
        return runtime('session-v2')
      },
      approvalForSession: approvals,
      legacy: runtime('legacy-chat-id'),
      run: async (turn) => {
        seen.push(turn.sessionId)
        return turn.sessionId
      },
    })

    expect(result).toBe('session-v2')
    expect(seen).toEqual(['session-v2'])
  })

  it('releases the exact runtime after success and after runner failure', async () => {
    const released: string[] = []
    const acquire = async () => runtime('session-v2', async () => { released.push('session-v2') })

    await expect(withTelegramTurnRuntime({
      acquire,
      approvalForSession: approvals,
      run: async () => 'ok',
    })).resolves.toBe('ok')
    await expect(withTelegramTurnRuntime({
      acquire,
      approvalForSession: approvals,
      run: async () => { throw new Error('provider failed') },
    })).rejects.toThrow('provider failed')
    expect(released).toEqual(['session-v2', 'session-v2'])
  })

  it('releases an invalid acquired runtime and never falls back to legacy', async () => {
    let released = false
    let legacyRan = false

    await expect(withTelegramTurnRuntime({
      acquire: async () => runtime(' ', async () => { released = true }),
      approvalForSession: approvals,
      legacy: runtime('legacy'),
      run: async (turn) => {
        legacyRan = turn.sessionId === 'legacy'
      },
    })).rejects.toThrow('TURN_RUNTIME_INVALID')
    expect(released).toBe(true)
    expect(legacyRan).toBe(false)
  })

  it('propagates acquisition failure without invoking legacy work', async () => {
    let ran = false
    await expect(withTelegramTurnRuntime({
      acquire: async () => { throw new Error('registry unavailable') },
      approvalForSession: approvals,
      legacy: runtime('legacy'),
      run: async () => { ran = true },
    })).rejects.toThrow('registry unavailable')
    expect(ran).toBe(false)
  })

  it('preserves legacy mode when no dynamic resolver is configured', async () => {
    await expect(withTelegramTurnRuntime({
      approvalForSession: approvals,
      legacy: runtime('legacy-session'),
      run: async (turn) => turn.sessionId,
    })).resolves.toBe('legacy-session')
  })
})

describe('runTelegramBoundGoalTurn', () => {
  it('uses only the supplied binding/session, reads goal_done claim, and releases', async () => {
    const seen: unknown[] = []
    let released = false
    let claimed = true

    const result = await runTelegramBoundGoalTurn({
      binding: BINDING,
      acquire: async (binding, _approval, options) => {
        seen.push({ binding, options })
        return {
          sessionId: BINDING.sessionId,
          runner: {
            handle: async (turn) => {
              seen.push(turn)
              return { state: 'ok', reply: 'done', narrowed: false }
            },
          },
          takeClaimedDone: () => {
            const value = claimed
            claimed = false
            return value
          },
          release: async () => { released = true },
        }
      },
      approvalForSession: approvals,
      objective: 'finish project A',
      feedback: 'continue',
      signal: new AbortController().signal,
    })

    expect(seen[0]).toEqual({ binding: BINDING, options: { goal: true } })
    expect(seen[1]).toEqual(expect.objectContaining({
      sessionId: BINDING.sessionId,
      spans: [expect.objectContaining({ text: expect.stringContaining('continue') })],
    }))
    expect(result).toMatchObject({
      claimedDone: true,
      sessionId: BINDING.sessionId,
      result: { state: 'ok', reply: 'done' },
    })
    expect(released).toBe(true)
  })

  it('never invokes a model when exact binding acquisition fails', async () => {
    let modelCalled = false
    await expect(runTelegramBoundGoalTurn({
      binding: BINDING,
      acquire: async () => { throw new Error('archived') },
      approvalForSession: approvals,
      objective: 'must not run',
      signal: new AbortController().signal,
    })).rejects.toThrow('archived')
    expect(modelCalled).toBe(false)
    void modelCalled
  })
})
