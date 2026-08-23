import { describe, it, expect } from 'vitest'
import { makeScopedToolExecutor } from './scoped-tool-executor.js'
import type { ToolCall, ToolExecutionContext } from '../agent-loop/types.js'
import type { ToolResult } from './execute-tool.js'

const okBase = async (call: ToolCall): Promise<ToolResult> => ({ ok: true, output: `ran ${call.name}` })

describe('makeScopedToolExecutor', () => {
  it('refuses a tool not permitted by the card', async () => {
    const exec = makeScopedToolExecutor({ base: okBase, permitsTool: (n) => n === 'read_file', owns: ['src/**'], doNotTouch: [] })
    const r = await exec({ name: 'bash', args: { cmd: 'ls' } })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('bash')
  })

  it('refuses a write outside the owned lane', async () => {
    const exec = makeScopedToolExecutor({ base: okBase, permitsTool: () => true, owns: ['src/feature/**'], doNotTouch: [] })
    const r = await exec({ name: 'write_file', args: { path: 'src/other/x.ts', content: 'x' } })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('scope')
  })

  it('refuses a write inside doNotTouch even if inside owns', async () => {
    const exec = makeScopedToolExecutor({ base: okBase, permitsTool: () => true, owns: ['src/**'], doNotTouch: ['src/secrets/**'] })
    const r = await exec({ name: 'write_file', args: { path: 'src/secrets/k.ts', content: 'x' } })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('scope')
  })

  it('refuses a write tool with no path arg', async () => {
    const exec = makeScopedToolExecutor({ base: okBase, permitsTool: () => true, owns: ['src/**'], doNotTouch: [] })
    const r = await exec({ name: 'write_file', args: {} })
    expect(r.ok).toBe(false)
  })

  it('allows a permitted write inside the owned lane', async () => {
    const exec = makeScopedToolExecutor({ base: okBase, permitsTool: () => true, owns: ['src/feature/**'], doNotTouch: [] })
    const r = await exec({ name: 'write_file', args: { path: 'src/feature/x.ts', content: 'x' } })
    expect(r.ok).toBe(true)
  })

  it('denies opaque, durable and unknown tools even when the card permits them', async () => {
    const exec = makeScopedToolExecutor({
      base: okBase, permitsTool: () => true, owns: ['src/**'], doNotTouch: [],
    })
    await expect(exec({ name: 'bash', args: { cmd: 'touch src/x' } })).resolves.toMatchObject({ ok: false })
    await expect(exec({
      name: 'clone_public_repository', args: { url: 'https://example.test/repo.git' },
    })).resolves.toMatchObject({ ok: false })
    await expect(exec({ name: 'remember', args: { text: 'durable mutation' } }))
      .resolves.toMatchObject({ ok: false })
    await expect(exec({ name: 'spawn_subagent', args: { plan: '{}' } }))
      .resolves.toMatchObject({ ok: false })
    await expect(exec({ name: 'future_custom_tool', args: {} }))
      .resolves.toMatchObject({ ok: false })
  })

  it('passes non-write permitted tools straight through', async () => {
    const exec = makeScopedToolExecutor({ base: okBase, permitsTool: () => true, owns: [], doNotTouch: [] })
    const r = await exec({ name: 'read_file', args: { path: 'anything.ts' } })
    expect(r.ok).toBe(true)
  })

  it('forwards the exact genuine tool context without cloning or reconstruction', async () => {
    const controller = new AbortController()
    const context = Object.freeze({
      sessionId: 'child-session',
      turnId: 'turn-1',
      ordinal: 7,
      signal: controller.signal,
    }) satisfies ToolExecutionContext
    let seen: ToolExecutionContext | undefined
    const exec = makeScopedToolExecutor({
      base: async (_call, received) => {
        seen = received
        return { ok: true, output: 'done' }
      },
      permitsTool: () => true,
      owns: [],
      doNotTouch: [],
    })

    await expect(exec({ name: 'read_file', args: { path: 'anything.ts' } }, context))
      .resolves.toEqual({ ok: true, output: 'done' })
    expect(seen).toBe(context)
    expect(seen?.signal).toBe(controller.signal)
  })
})
