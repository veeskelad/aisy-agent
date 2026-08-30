import { describe, expect, it, vi } from 'vitest'

import { makeGrantStore } from '../safety/index.js'
import {
  bindCodexCapabilityBridge,
  CodexCapabilityBridgeError,
} from './codex-capability-bridge.js'
import { makeCodexCapabilityExecutor } from './codex-capability-executor.js'

const binding = {
  operatorId: 'operator-a', profileId: 'profile-a', projectId: 'project-a',
  sessionId: 'session-a', scope: 'project' as const,
}

function request(itemId: string, tool: string, args: Record<string, unknown>) {
  return { threadId: 'thread-a', turnId: 'turn-a', itemId, tool, arguments: args }
}

function harness(input?: {
  context?: { provenance: 'operator' | 'untrusted'; narrowed: boolean }
  approve?: ReturnType<typeof vi.fn>
  unsafeHostBashBypass?: () => boolean
}) {
  const grants = makeGrantStore()
  const effects: string[] = []
  const approve = input?.approve ?? vi.fn(async () => ({
    decision: 'confirmed' as const,
    scope: 'session' as const,
  }))
  const execute = makeCodexCapabilityExecutor({
    grants,
    approve,
    executeTool: async (activeBinding, call) => {
      effects.push(`${activeBinding.projectId}:${call.name}:${JSON.stringify(call.args)}`)
      return { ok: true, output: `executed:${call.name}` }
    },
    ...(input?.unsafeHostBashBypass === undefined
      ? {}
      : { unsafeHostBashBypass: input.unsafeHostBashBypass }),
  })
  const events: Array<{ type: string; reason?: string }> = []
  const bridge = bindCodexCapabilityBridge({
    binding,
    threadId: 'thread-a',
    turnId: 'turn-a',
    context: input?.context ?? { provenance: 'operator', narrowed: false },
    allowedTools: new Set(['read_file', 'bash']),
    isBindingActive: () => true,
    execute,
    onEvent: event => { events.push(event) },
  })
  return { approve, bridge, effects, events, grants }
}

describe('Codex capability Safety/Approval executor integration', () => {
  it('applies the strict Project overlay to subscription tool calls', async () => {
    const effects: string[] = []
    const execute = makeCodexCapabilityExecutor({
      grants: makeGrantStore(),
      approve: async () => ({ decision: 'confirmed' }),
      narrowPolicy: () => ({ decision: 'deny' }),
      executeTool: async () => { effects.push('effect'); return { ok: true, output: 'read' } },
    })

    await expect(execute(
      binding,
      { name: 'read_file', args: { path: 'README.md' }, sourceSpanProvenance: 'operator' },
      { provenance: 'operator', narrowed: false },
      new AbortController().signal,
    )).resolves.toEqual({ ok: false, output: 'CAPABILITY_DENIED' })
    expect(effects).toEqual([])
  })

  it('makes subscription policy relaxation Tier-3 and never rememberable', async () => {
    const approvals: unknown[] = []
    const effects: string[] = []
    const execute = makeCodexCapabilityExecutor({
      grants: makeGrantStore(),
      approve: async (_binding, action) => {
        approvals.push(action)
        return { decision: 'confirmed' }
      },
      executeTool: async (_binding, call) => {
        effects.push(call.name)
        return { ok: true, output: 'relaxed' }
      },
      describePolicyRelaxation: (_binding, _call, context) =>
        context.sessionId === 'session-a' ? { scope: 'project' } : null,
    })

    await expect(execute(
      binding,
      {
        name: 'configure_agent',
        args: { operation: 'policy.relax-project', target: 'current', value: 'read-only' },
        sourceSpanProvenance: 'operator',
      },
      { provenance: 'operator', narrowed: false },
      new AbortController().signal,
      { sessionId: 'session-a', turnId: 'turn-a' },
    )).resolves.toEqual({ ok: true, output: 'relaxed' })
    expect(approvals).toEqual([
      expect.objectContaining({
        tier: 3,
        requiresStepUp: true,
        canRememberSimilar: false,
        summary: 'Ослабить настройку «только чтение» для всего проекта. После этого агент получит больше свободы.',
      }),
    ])
    expect(effects).toEqual(['configure_agent'])
  })

  it('forwards the transport-owned operator turn context only to the approved executor', async () => {
    const seen: unknown[] = []
    const execute = makeCodexCapabilityExecutor({
      grants: makeGrantStore(),
      approve: async () => ({ decision: 'rejected' }),
      executeTool: async (_binding, _call, _signal, runtimeContext) => {
        seen.push(runtimeContext)
        return { ok: true, output: 'read' }
      },
    })
    const runtimeContext = Object.freeze({
      sessionId: 'operator-session', turnId: 'operator-turn', ordinal: 7,
    })

    await expect(execute(
      binding,
      { name: 'read_file', args: { path: 'README.md' }, sourceSpanProvenance: 'operator' },
      { provenance: 'operator', narrowed: false },
      new AbortController().signal,
      runtimeContext,
    )).resolves.toEqual({ ok: true, output: 'read' })
    expect(seen).toEqual([runtimeContext])
  })

  it.each([
    { name: 'read_file', args: { path: 'README.md' } },
    { name: 'write_file', args: { path: 'out.txt', content: 'x' } },
    { name: 'list_dir', args: { path: '.' } },
  ])('carries subscription ordinal through policy for $name', async (tool) => {
    const policyContexts: unknown[] = []
    const execute = makeCodexCapabilityExecutor({
      grants: makeGrantStore(),
      approve: async () => ({ decision: 'confirmed' }),
      narrowPolicy: (_binding, request) => {
        policyContexts.push(request.ctx)
        return { decision: 'unchanged' }
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })
    await expect(execute(
      binding,
      { ...tool, sourceSpanProvenance: 'operator' },
      { provenance: 'operator', narrowed: false },
      new AbortController().signal,
      { sessionId: 'session-a', turnId: 'turn-a', ordinal: 9 },
    )).resolves.toEqual({ ok: true, output: 'ok' })
    expect(policyContexts).toEqual([expect.objectContaining({
      sessionId: 'session-a', turnId: 'turn-a', ordinal: 9,
    })])
  })

  it('executes a clean read through the real safety gate without approval', async () => {
    const h = harness()
    await expect(h.bridge.invoke(request('read-1', 'read_file', { path: 'README.md' })))
      .resolves.toEqual({ ok: true, output: 'executed:read_file' })
    expect(h.approve).not.toHaveBeenCalled()
    expect(h.effects).toEqual(['project-a:read_file:{"path":"README.md"}'])
  })

  it.each([
    { name: 'remember', args: { fact: 'ты предпочитаешь краткие ответы' } },
    { name: 'spawn_subagent', args: { plan: '{"intent":"вычислить 23 × 29"}' } },
  ])('executes reversible $name without a redundant approval', async (tool) => {
    const approve = vi.fn(async () => ({ decision: 'rejected' as const }))
    const effects: string[] = []
    const execute = makeCodexCapabilityExecutor({
      grants: makeGrantStore(),
      approve,
      executeTool: async (_binding, call) => {
        effects.push(call.name)
        return { ok: true, output: `executed:${call.name}` }
      },
    })

    await expect(execute(
      binding,
      { ...tool, sourceSpanProvenance: 'operator' },
      { provenance: 'operator', narrowed: false },
      new AbortController().signal,
      { sessionId: 'session-a', turnId: 'turn-a', ordinal: 1 },
    )).resolves.toEqual({ ok: true, output: `executed:${tool.name}` })
    expect(approve).not.toHaveBeenCalled()
    expect(effects).toEqual([tool.name])
  })

  it.each([
    { name: 'remember', args: { fact: 'ты предпочитаешь краткие ответы' } },
    { name: 'spawn_subagent', args: { plan: '{"intent":"вычислить 23 × 29"}' } },
  ])('applies the live confirm-mode tier overlay to subscription $name', async (tool) => {
    const approve = vi.fn(async (_binding, action) => {
      expect(action).toMatchObject({ tier: 2, requiresStepUp: false })
      return { decision: 'confirmed' as const }
    })
    const execute = makeCodexCapabilityExecutor({
      grants: makeGrantStore(),
      approve,
      toolTierFloor: () => 2,
      executeTool: async (_binding, call) => ({ ok: true, output: `executed:${call.name}` }),
    })

    await expect(execute(
      binding,
      { ...tool, sourceSpanProvenance: 'operator' },
      { provenance: 'operator', narrowed: false },
      new AbortController().signal,
      { sessionId: 'session-a', turnId: 'turn-a', ordinal: 1 },
    )).resolves.toEqual({ ok: true, output: `executed:${tool.name}` })
    expect(approve).toHaveBeenCalledTimes(1)
  })

  it('remembers only a similar Tier-2 call in the exact binding', async () => {
    const h = harness()
    await expect(h.bridge.invoke(request('bash-1', 'bash', { cmd: 'pnpm test' })))
      .resolves.toEqual({ ok: true, output: 'executed:bash' })
    await expect(h.bridge.invoke(request('bash-2', 'bash', { cmd: 'pnpm   test' })))
      .resolves.toEqual({ ok: true, output: 'executed:bash' })
    expect(h.approve).toHaveBeenCalledTimes(1)
    expect(h.approve.mock.calls[0]?.[0]).toEqual(binding)
    const remembered = { tool: 'bash', args: { cmd: 'pnpm test' } }
    expect(h.grants.hasSimilar(remembered, 2, binding)).toBe(true)
    expect(h.grants.hasSimilar(remembered, 2, { ...binding, sessionId: 'foreign' })).toBe(false)

    await expect(h.bridge.invoke(request('bash-3', 'bash', { cmd: 'pnpm typecheck' })))
      .resolves.toEqual({ ok: true, output: 'executed:bash' })
    expect(h.approve).toHaveBeenCalledTimes(2)
    expect(h.effects).toHaveLength(3)
  })

  it('blocks HARD_DENY before approval and before the real effect', async () => {
    const h = harness()
    const destructiveFixture = `${['r', 'm'].join('')} ${['-rf', '/'].join(' ')}`
    await expect(h.bridge.invoke(request('bash-denied', 'bash', { cmd: destructiveFixture })))
      .resolves.toEqual({ ok: false, output: 'CAPABILITY_DENIED' })
    expect(h.approve).not.toHaveBeenCalled()
    expect(h.effects).toEqual([])
    expect(h.events.at(-1)).toMatchObject({ type: 'denied', reason: 'CAPABILITY_DENIED' })
  })

  it('bypasses denial and approval only for exact Bash when the operator mode is active', async () => {
    const h = harness({ unsafeHostBashBypass: () => true })
    const destructiveFixture = `${['r', 'm'].join('')} ${['-rf', '/'].join(' ')}`

    await expect(h.bridge.invoke(request('bash-bypass', 'bash', { cmd: destructiveFixture })))
      .resolves.toEqual({ ok: true, output: 'executed:bash' })
    expect(h.approve).not.toHaveBeenCalled()
    expect(h.effects).toEqual([
      `project-a:bash:${JSON.stringify({ cmd: destructiveFixture })}`,
    ])
  })

  it('fails closed when code-owned turn provenance is untrusted', async () => {
    const h = harness({ context: { provenance: 'untrusted', narrowed: true } })
    await expect(h.bridge.invoke(request('read-tainted', 'read_file', { path: 'README.md' })))
      .resolves.toEqual({ ok: false, output: 'CAPABILITY_DENIED' })
    expect(h.approve).not.toHaveBeenCalled()
    expect(h.effects).toEqual([])
  })

  it('does not execute after abort during the human approval round-trip', async () => {
    let release!: () => void
    let observed!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const seen = new Promise<void>(resolve => { observed = resolve })
    const approve = vi.fn(async () => {
      observed()
      await pending
      return { decision: 'confirmed' as const }
    })
    const controller = new AbortController()
    const grants = makeGrantStore()
    const effects: string[] = []
    const bridge = bindCodexCapabilityBridge({
      binding, threadId: 'thread-a', turnId: 'turn-a',
      context: { provenance: 'operator', narrowed: false },
      allowedTools: new Set(['bash']), signal: controller.signal,
      isBindingActive: () => true,
      execute: makeCodexCapabilityExecutor({
        grants, approve,
        executeTool: async () => {
          effects.push('effect')
          return { ok: true, output: 'executed' }
        },
      }),
    })
    const invocation = bridge.invoke(request('bash-abort', 'bash', { cmd: 'pnpm test' }))
    await seen
    controller.abort()
    release()
    await expect(invocation).rejects.toEqual(
      new CodexCapabilityBridgeError('CAPABILITY_BRIDGE_CLOSED'),
    )
    expect(effects).toEqual([])
  })
})
