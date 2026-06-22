import { describe, it, expect } from 'vitest'
import { makeScopedToolExecutor } from './scoped-tool-executor.js'
import type { ToolCall } from '../agent-loop/types.js'
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

  it('passes non-write permitted tools straight through', async () => {
    const exec = makeScopedToolExecutor({ base: okBase, permitsTool: () => true, owns: [], doNotTouch: [] })
    const r = await exec({ name: 'read_file', args: { path: 'anything.ts' } })
    expect(r.ok).toBe(true)
  })
})
