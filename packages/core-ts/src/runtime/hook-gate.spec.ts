import { describe, it, expect } from 'vitest'
import { makeHookGate, type ApprovalDecision } from './hook-gate.js'
import { makeSafetyPolicy, makeGrantStore } from '../safety/index.js'
import type { GrantStore } from '../safety/index.js'
import type { HookCtx, ToolCall } from '../agent-loop/types.js'
import type { PendingAction } from '../gateway/index.js'

const OPERATOR: HookCtx = { provenance: 'operator', narrowed: false }

/** Records approve() calls and returns a scripted decision. */
function approver(decision: ApprovalDecision) {
  const seen: PendingAction[] = []
  return {
    seen,
    approve: async (action: PendingAction): Promise<ApprovalDecision> => {
      seen.push(action)
      return decision
    },
  }
}

function gate(opts?: { decision?: ApprovalDecision; grants?: GrantStore }) {
  const grants = opts?.grants ?? makeGrantStore()
  const a = approver(opts?.decision ?? { decision: 'rejected' })
  const hg = makeHookGate({ safety: makeSafetyPolicy({ grants }), grants, approve: a.approve })
  return { hg, grants, approve: a }
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { name, args }
}

describe('makeHookGate.pre', () => {
  it('Tier-0 (read_file) allows without an approval round-trip', async () => {
    const { hg, approve } = gate()
    expect(await hg.pre(call('read_file', { path: 'a' }), OPERATOR)).toBe('allow')
    expect(approve.seen).toHaveLength(0)
  })

  it('Tier-2 (bash) asks, and a confirmed decision allows', async () => {
    const { hg, approve } = gate({ decision: { decision: 'confirmed' } })
    expect(await hg.pre(call('bash', { cmd: 'npm test' }), OPERATOR)).toBe('allow')
    expect(approve.seen).toHaveLength(1)
    expect(approve.seen[0]!.tier).toBe(2)
  })

  it('Tier-2 rejected decision denies', async () => {
    const { hg } = gate({ decision: { decision: 'rejected' } })
    expect(await hg.pre(call('bash', { cmd: 'npm test' }), OPERATOR)).toBe('deny')
  })

  it('a confirmed session scope records a grant that suppresses the next card', async () => {
    const grants = makeGrantStore()
    const { hg, approve } = gate({ grants, decision: { decision: 'confirmed', scope: 'session' } })
    // first call asks + records the grant
    await hg.pre(call('bash', { cmd: 'a' }), OPERATOR)
    expect(grants.has('bash')).toBe(true)
    // second call is allowed by SafetyPolicy via the grant — no new approve()
    expect(await hg.pre(call('bash', { cmd: 'b' }), OPERATOR)).toBe('allow')
    expect(approve.seen).toHaveLength(1)
  })

  it('HARD_DENY denies before any approval round-trip', async () => {
    const { hg, approve } = gate({ decision: { decision: 'confirmed' } })
    expect(await hg.pre(call('bash', { cmd: 'rm -rf /' }), OPERATOR)).toBe('deny')
    expect(approve.seen).toHaveLength(0)
  })

  it('tainted args (untrusted provenance) deny before approval', async () => {
    const { hg, approve } = gate({ decision: { decision: 'confirmed' } })
    const untrusted: HookCtx = { provenance: 'untrusted', narrowed: true }
    expect(await hg.pre(call('bash', { cmd: 'echo hi' }), untrusted)).toBe('deny')
    expect(approve.seen).toHaveLength(0)
  })

  it('does NOT record a grant for a Tier-3 action even if a scope is returned', async () => {
    const grants = makeGrantStore()
    const { hg } = gate({ grants, decision: { decision: 'confirmed', scope: 'always' } })
    const out = await hg.pre(call('db.drop-database', { name: 'prod' }), OPERATOR)
    expect(out).toBe('allow')
    expect(grants.has('db.drop-database')).toBe(false)
  })
})
