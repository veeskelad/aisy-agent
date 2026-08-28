import { describe, it, expect, vi } from 'vitest'
import { makeHookGate, makePostToolUseProcessor, type ApprovalDecision } from './hook-gate.js'
import { makeSafetyPolicy, makeGrantStore } from '../safety/index.js'
import type { GrantStore } from '../safety/index.js'
import type { HookCtx, ToolCall } from '../agent-loop/types.js'
import type { PendingAction } from '../gateway/index.js'
import { makeMemoryRememberReceipt } from './memory-receipt.js'

const OPERATOR: HookCtx = { provenance: 'operator', narrowed: false }
const GRANT_BINDING = {
  operatorId: 'operator',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 's1',
  scope: 'project' as const,
}

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

function gate(opts?: {
  decision?: ApprovalDecision
  grants?: GrantStore
  approve?: Parameters<typeof makeHookGate>[0]['approve']
  resolveSafetyCall?: Parameters<typeof makeHookGate>[0]['resolveSafetyCall']
  completeSafetyCall?: Parameters<typeof makeHookGate>[0]['completeSafetyCall']
  learnedAutonomy?: Parameters<typeof makeHookGate>[0]['learnedAutonomy']
  observeApproval?: Parameters<typeof makeHookGate>[0]['observeApproval']
}) {
  const grants = opts?.grants ?? makeGrantStore()
  const a = approver(opts?.decision ?? { decision: 'rejected' })
  const hg = makeHookGate({
    safety: makeSafetyPolicy({ grants, grantBinding: GRANT_BINDING }),
    grants,
    grantBinding: GRANT_BINDING,
    approve: opts?.approve ?? a.approve,
    ...(opts?.resolveSafetyCall === undefined ? {} : { resolveSafetyCall: opts.resolveSafetyCall }),
    ...(opts?.completeSafetyCall === undefined ? {} : { completeSafetyCall: opts.completeSafetyCall }),
    ...(opts?.learnedAutonomy === undefined ? {} : { learnedAutonomy: opts.learnedAutonomy }),
    ...(opts?.observeApproval === undefined ? {} : { observeApproval: opts.observeApproval }),
  })
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
    const { hg, approve, grants } = gate({ decision: { decision: 'confirmed' } })
    expect(await hg.pre(call('bash', { cmd: 'npm test' }), OPERATOR)).toBe('allow')
    expect(approve.seen).toHaveLength(1)
    expect(approve.seen[0]!.tier).toBe(2)
    expect(grants.hasSimilar({ tool: 'bash', args: { cmd: 'npm test' } }, 2, GRANT_BINDING))
      .toBe(true)
  })

  it('runs the exact confirmed call when durable similar-grant persistence fails', async () => {
    const base = makeGrantStore()
    const grants: GrantStore = {
      ...base,
      recordSimilar: () => { throw new Error('disk unavailable') },
    }
    const { hg } = gate({ grants, decision: { decision: 'confirmed' } })

    expect(await hg.pre(call('bash', { cmd: 'npm test' }), OPERATOR)).toBe('allow')
    expect(base.hasSimilar({ tool: 'bash', args: { cmd: 'npm test' } }, 2, GRANT_BINDING))
      .toBe(false)
  })

  it('Tier-2 rejected decision denies', async () => {
    const { hg } = gate({ decision: { decision: 'rejected' } })
    expect(await hg.pre(call('bash', { cmd: 'npm test' }), OPERATOR)).toBe('deny')
  })

  it('a confirmed session scope records a grant that suppresses the next card', async () => {
    const grants = makeGrantStore()
    const { hg, approve } = gate({ grants, decision: { decision: 'confirmed', scope: 'session' } })
    // first call asks + records the grant
    await hg.pre(call('bash', { cmd: 'pnpm test' }), OPERATOR)
    expect(grants.hasSimilar({ tool: 'bash', args: { cmd: 'pnpm test' } }, 2, GRANT_BINDING)).toBe(true)
    // second call is allowed by SafetyPolicy via the grant — no new approve()
    expect(await hg.pre(call('bash', { cmd: 'pnpm   test' }), OPERATOR)).toBe('allow')
    expect(approve.seen).toHaveLength(1)
  })

  it('binds the remembered matcher to the pre-approval args snapshot', async () => {
    const grants = makeGrantStore()
    const candidate = call('bash', { cmd: 'pnpm test' })
    const { hg } = gate({
      grants,
      approve: async () => {
        candidate.args['cmd'] = 'git push origin master'
        return { decision: 'confirmed', scope: 'session' }
      },
    })
    expect(await hg.pre(candidate, OPERATOR)).toBe('allow')
    expect(grants.hasSimilar({ tool: 'bash', args: { cmd: 'pnpm test' } }, 2, GRANT_BINDING)).toBe(true)
    expect(grants.hasSimilar({ tool: 'bash', args: { cmd: 'git push origin master' } }, 2, GRANT_BINDING)).toBe(false)
  })

  it('treats a forged remembered scope as one-shot when no safe matcher exists', async () => {
    const grants = makeGrantStore()
    const complex = call('bash', { cmd: 'pnpm test && echo done' })
    const { hg, approve } = gate({
      grants,
      decision: { decision: 'confirmed', scope: 'always' },
    })
    expect(await hg.pre(complex, OPERATOR)).toBe('allow')
    expect(approve.seen[0]?.canRememberSimilar).toBe(false)
    expect(grants.hasSimilar({ tool: 'bash', args: { cmd: 'pnpm test && echo done' } }, 2, GRANT_BINDING)).toBe(false)
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
    expect(grants.has('db.drop-database', GRANT_BINDING)).toBe(false)
  })

  it('evaluates a concrete MCP tier before the generic call_mcp wrapper can execute', async () => {
    const { hg, approve } = gate({
      decision: { decision: 'confirmed' },
      resolveSafetyCall: (loopCall) => ({
        tool: 'mcp:write:tracker.publish',
        args: loopCall.args['args'] as Record<string, unknown>,
        policyTier: 3,
        outboundSink: true,
      }),
    })
    expect(await hg.pre(call('call_mcp', {
      tool: 'tracker.publish', args: { message: 'hello' },
    }), OPERATOR)).toBe('allow')
    expect(approve.seen).toHaveLength(1)
    expect(approve.seen[0]!.tier).toBe(3)
    expect(approve.seen[0]!.summary).toContain('mcp:write:tracker.publish')
  })

  it('denies an outbound MCP tool under narrowing even when its policy tier is low', async () => {
    const { hg, approve } = gate({
      decision: { decision: 'confirmed' },
      resolveSafetyCall: () => ({
        tool: 'mcp:write:tracker.notify', args: { message: 'x' }, policyTier: 1, outboundSink: true,
      }),
    })
    expect(await hg.pre(call('call_mcp'), { provenance: 'operator', narrowed: true })).toBe('deny')
    expect(approve.seen).toHaveLength(0)
  })

  it('records remembered approval against the concrete MCP capability, not call_mcp', async () => {
    const grants = makeGrantStore()
    const { hg } = gate({
      grants,
      decision: { decision: 'confirmed', scope: 'session' },
      resolveSafetyCall: () => ({
        tool: 'mcp:write:tracker.update', args: {}, policyTier: 2, outboundSink: true,
      }),
    })
    expect(await hg.pre(call('call_mcp'), OPERATOR)).toBe('allow')
    expect(grants.hasSimilar({
      tool: 'mcp:write:tracker.update', args: {}, policyTier: 2, outboundSink: true,
    }, 2, GRANT_BINDING)).toBe(true)
    expect(grants.has('call_mcp', GRANT_BINDING)).toBe(false)
  })

  it('fails closed when dynamic policy resolution throws', async () => {
    const { hg, approve } = gate({
      decision: { decision: 'confirmed' },
      resolveSafetyCall: () => { throw new Error('hidden MCP tool') },
    })
    expect(await hg.pre(call('call_mcp'), OPERATOR)).toBe('deny')
    expect(approve.seen).toHaveLength(0)
  })

  it('commits a dynamic binding only after final allow and clears it on rejection', async () => {
    const allowed: boolean[] = []
    const resolver = () => ({
      tool: 'mcp:write:tracker.update', args: {}, policyTier: 2 as const, outboundSink: true,
    })
    const confirmed = gate({
      decision: { decision: 'confirmed' },
      resolveSafetyCall: resolver,
      completeSafetyCall: (_call, _safety, value) => { allowed.push(value) },
    })
    const rejected = gate({
      decision: { decision: 'rejected' },
      resolveSafetyCall: resolver,
      completeSafetyCall: (_call, _safety, value) => { allowed.push(value) },
    })

    expect(await confirmed.hg.pre(call('call_mcp'), OPERATOR)).toBe('allow')
    expect(await rejected.hg.pre(call('call_mcp'), OPERATOR)).toBe('deny')
    expect(allowed).toEqual([true, false])
  })

  it('clears a pending dynamic binding when Safety evaluation throws', async () => {
    const grants = makeGrantStore()
    const completeSafetyCall = vi.fn()
    const hg = makeHookGate({
      safety: {
        ready: true,
        isNarrowed: () => false,
        evaluate: () => { throw new Error('policy unavailable') },
      },
      grants,
      approve: async () => ({ decision: 'confirmed' }),
      resolveSafetyCall: () => ({
        tool: 'mcp:write:tracker.update', args: {}, policyTier: 2, outboundSink: true,
      }),
      completeSafetyCall,
    })

    expect(await hg.pre(call('call_mcp'), OPERATOR)).toBe('deny')
    expect(completeSafetyCall).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ tool: 'mcp:write:tracker.update' }), false,
    )
  })
})

describe('выученная автономия в гейте (AC-24-6, AC-24-7)', () => {
  const UNTRUSTED: HookCtx = { provenance: 'untrusted', narrowed: false }
  const NARROWED: HookCtx = { provenance: 'operator', narrowed: true }

  it('покрытый грантом Tier-2 проходит без карточки', async () => {
    const { hg, approve } = gate({ learnedAutonomy: () => true })

    expect(await hg.pre(call('bash', { command: 'git status' }), OPERATOR)).toBe('allow')
    expect(approve.seen).toHaveLength(0)
  })

  it('непокрытый вызов идёт к оператору как раньше', async () => {
    const { hg, approve } = gate({
      decision: { decision: 'confirmed' },
      learnedAutonomy: () => false,
    })

    expect(await hg.pre(call('bash', { command: 'git status' }), OPERATOR)).toBe('allow')
    expect(approve.seen).toHaveLength(1)
  })

  it('грант не заглушает Tier-3: красная карточка всегда (AC-24-7)', async () => {
    const seen: PendingAction[] = []
    const { hg } = gate({
      learnedAutonomy: () => true,
      approve: async (action) => { seen.push(action); return { decision: 'rejected' } },
    })

    // drop-database — Tier 3; никакая выученная автономия его не покрывает.
    expect(await hg.pre(call('db.drop-database', { name: 'prod' }), OPERATOR)).toBe('deny')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.tier).toBe(3)
    expect(seen[0]!.requiresStepUp).toBe(true)
  })

  it('в narrowed-ходе грант не действует: доказательства были не про это', async () => {
    const seen: PendingAction[] = []
    const { hg } = gate({
      learnedAutonomy: () => true,
      approve: async (action) => { seen.push(action); return { decision: 'rejected' } },
    })

    expect(await hg.pre(call('bash', { command: 'git status' }), NARROWED)).toBe('deny')
    expect(seen).toHaveLength(1)
  })

  it('untrusted-provenance не покрывается грантом', async () => {
    const { hg } = gate({
      learnedAutonomy: () => true,
      approve: async () => ({ decision: 'rejected' }),
    })

    expect(await hg.pre(call('bash', { command: 'git status' }), UNTRUSTED)).toBe('deny')
  })

  it('бросок порта — не «да»: вызов идёт к оператору', async () => {
    const seen: PendingAction[] = []
    const { hg } = gate({
      learnedAutonomy: () => { throw new Error('store unavailable') },
      approve: async (action) => { seen.push(action); return { decision: 'confirmed' } },
    })

    expect(await hg.pre(call('bash', { command: 'git status' }), OPERATOR)).toBe('allow')
    expect(seen).toHaveLength(1)
  })

  it('грант никогда не отменяет deny', async () => {
    const { hg, approve } = gate({ learnedAutonomy: () => true })

    // HARD_DENY остаётся отказом при любом гранте: deny проверяется раньше.
    expect(await hg.pre(call('bash', { command: 'rm -rf /данные' }), OPERATOR)).toBe('deny')
    expect(approve.seen).toHaveLength(0)
  })
})

describe('deterministic PostToolUse', () => {
  it('preserves an exact verified memory receipt for the production acknowledgement', async () => {
    const receipt = makeMemoryRememberReceipt(
      { fact: 'ты предпочитаешь краткие отчёты' },
      { sessionId: 'session-1', turnId: 'turn-1', ordinal: 1 },
    )
    expect(receipt).not.toBeNull()
    const post = makePostToolUseProcessor({ secretValues: () => [] })

    await expect(post(call('remember'), {
      ok: true,
      output: 'Запомнил, что ты предпочитаешь краткие отчёты',
      verified: true,
      mutationReceipt: receipt,
    })).resolves.toEqual({
      ok: true,
      output: 'Запомнил, что ты предпочитаешь краткие отчёты',
      verified: true,
      mutationReceipt: receipt,
    })
  })

  it('drops the receipt when redaction changes the acknowledgement', async () => {
    const receipt = makeMemoryRememberReceipt(
      { fact: 'мой секрет secret-value' },
      { sessionId: 'session-1', turnId: 'turn-2', ordinal: 1 },
    )
    const post = makePostToolUseProcessor({ secretValues: () => ['secret-value'] })

    await expect(post(call('remember'), {
      ok: true,
      output: 'Запомнил, что мой секрет secret-value',
      verified: true,
      mutationReceipt: receipt,
    })).resolves.toEqual({
      ok: true,
      output: 'Запомнил, что мой секрет «redacted»',
    })
  })

  it('withholds output when the live PostToolUse dependency was omitted', async () => {
    const grants = makeGrantStore()
    const hg = makeHookGate({
      safety: makeSafetyPolicy({ grants }),
      grants,
      approve: async () => ({ decision: 'rejected' }),
    })
    const result = await hg.post(call('read_file'), { ok: true, output: 'raw-secret' })
    expect(result).toEqual({
      ok: false,
      output: 'tool result withheld (redaction or filter unavailable)',
    })
  })

  it('wraps errors, redacts secrets, removes control sequences and compresses last', async () => {
    const order: string[] = []
    const post = makePostToolUseProcessor({
      secretValues: () => { order.push('redact'); return ['vault-value'] },
      filterOutput: (text) => { order.push('filter'); return text },
      compress: async (text) => { order.push('compress'); return { text: `z:${text}`, compressed: true } },
    })
    const result = await post(call('read_file'), {
      ok: false,
      output: '\u001b[31mvault-value\u001b[0m failed',
    })
    expect(order).toEqual(['redact', 'filter', 'compress'])
    expect(result).toEqual({ ok: false, output: 'z:Tool error: «redacted» failed' })
  })

  it.each(['redaction', 'filter'] as const)('fails closed when %s is unavailable', async (stage) => {
    const post = makePostToolUseProcessor({
      secretValues: () => {
        if (stage === 'redaction') throw new Error('down')
        return []
      },
      filterOutput: () => {
        if (stage === 'filter') throw new Error('down')
        return 'safe'
      },
    })
    const result = await post(call('read_file'), { ok: true, output: 'raw-secret' })
    expect(result).toEqual({
      ok: false,
      output: 'tool result withheld (redaction or filter unavailable)',
    })
    expect(result.output).not.toContain('raw-secret')
  })

  it('compression failure preserves already sanitized bytes', async () => {
    const post = makePostToolUseProcessor({
      secretValues: () => ['secret'],
      compress: async () => { throw new Error('optional down') },
    })
    await expect(post(call('read_file'), { ok: true, output: 'secret\u0000ok' }))
      .resolves.toEqual({ ok: true, output: '«redacted»ok' })
  })

  it('rejects compressor output that reintroduces a secret', async () => {
    const post = makePostToolUseProcessor({
      secretValues: () => ['secret'],
      compress: async () => ({ text: 'compressed secret', compressed: true }),
    })
    await expect(post(call('read_file'), { ok: true, output: 'safe' }))
      .resolves.toEqual({ ok: true, output: 'safe' })
  })
})

describe('наблюдение ответов оператора (спека 24, AC-24-1)', () => {
  type Seen = Array<{ tool: string; tier: 1 | 2; outcome: 'confirmed' | 'rejected' }>

  const observed = (): { seen: Seen; port: NonNullable<Parameters<typeof makeHookGate>[0]['observeApproval']> } => {
    const seen: Seen = []
    return {
      seen,
      port: (input) => {
        seen.push({ tool: input.call.name, tier: input.tier, outcome: input.outcome })
      },
    }
  }

  it('видит и подтверждение, и отказ — оба являются ответом человека', async () => {
    const yes = observed()
    const { hg: allowGate } = gate({
      decision: { decision: 'confirmed' }, observeApproval: yes.port,
    })
    expect(await allowGate.pre(call('bash', { cmd: 'npm test' }), OPERATOR)).toBe('allow')

    const no = observed()
    const { hg: denyGate } = gate({
      decision: { decision: 'rejected' }, observeApproval: no.port,
    })
    expect(await denyGate.pre(call('bash', { cmd: 'npm test' }), OPERATOR)).toBe('deny')

    expect(yes.seen).toEqual([{ tool: 'bash', tier: 2, outcome: 'confirmed' }])
    expect(no.seen).toEqual([{ tool: 'bash', tier: 2, outcome: 'rejected' }])
  })

  it('не наблюдает Tier-3: такой процесс не обучается никаким числом подтверждений', async () => {
    const spy = observed()
    const { hg } = gate({ decision: { decision: 'rejected' }, observeApproval: spy.port })

    expect(await hg.pre(call('db.drop-database', { name: 'prod' }), OPERATOR)).toBe('deny')
    expect(spy.seen).toEqual([])
  })

  it('не наблюдает то, что оператору не показывали', async () => {
    const spy = observed()
    const { hg } = gate({ observeApproval: spy.port })

    // Tier-0 проходит без карточки — ответа человека здесь не было.
    expect(await hg.pre(call('read_file', { path: 'a' }), OPERATOR)).toBe('allow')
    expect(spy.seen).toEqual([])
  })

  it('падение наблюдателя не меняет решение по вызову', async () => {
    const { hg } = gate({
      decision: { decision: 'confirmed' },
      observeApproval: () => { throw new Error('store down') },
    })

    expect(await hg.pre(call('bash', { cmd: 'npm test' }), OPERATOR)).toBe('allow')
  })

  it('вызов, покрытый выученным грантом, демонстрацией не становится', async () => {
    const spy = observed()
    const { hg, approve } = gate({ learnedAutonomy: () => true, observeApproval: spy.port })

    expect(await hg.pre(call('bash', { cmd: 'git status' }), OPERATOR)).toBe('allow')
    // Иначе автономия подтверждала бы сама себя: грант молча продлевал бы
    // собственные доказательства, и отозвать его стало бы нечем.
    expect(approve.seen).toHaveLength(0)
    expect(spy.seen).toEqual([])
  })
})
