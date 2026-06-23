import { describe, it, expect } from 'vitest'
import { makeToolExecutor, type FsPort, type ExecuteToolDeps } from './execute-tool.js'
import type { ToolCall } from '../agent-loop/types.js'

function memFs(seed: Record<string, string> = {}): FsPort & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed))
  return {
    files,
    readFile: (p) => files.get(p) ?? '',
    writeFile: (p, c) => void files.set(p, c),
    listDir: (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => k.slice(p.length + 1)),
    exists: (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(p + '/')),
  }
}

const ROOT = '/work'
function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { name, args }
}
function exec(overrides?: Partial<ExecuteToolDeps>) {
  const fs = memFs({ '/work/a.txt': 'hello', '/work/sub/b.txt': 'world' })
  return makeToolExecutor({ fs, workspaceRoot: ROOT, ...overrides })
}

describe('makeToolExecutor', () => {
  it('read_file returns content within the workspace', async () => {
    const r = await exec()(call('read_file', { path: 'a.txt' }))
    expect(r).toEqual({ ok: true, output: 'hello' })
  })

  it('read_file rejects paths escaping the workspace', async () => {
    const r = await exec()(call('read_file', { path: '../../etc/passwd' }))
    expect(r.ok).toBe(false)
    expect(r.output).toContain('outside workspace')
  })

  it('read_file reports missing files', async () => {
    const r = await exec()(call('read_file', { path: 'nope.txt' }))
    expect(r.ok).toBe(false)
    expect(r.output).toContain('not found')
  })

  it('write_file writes under the workspace', async () => {
    const fs = memFs()
    const r = await makeToolExecutor({ fs, workspaceRoot: ROOT })(
      call('write_file', { path: 'out.txt', content: 'data' }),
    )
    expect(r.ok).toBe(true)
    expect(fs.files.get('/work/out.txt')).toBe('data')
  })

  it('write_file rejects an absolute escape', async () => {
    const r = await exec()(call('write_file', { path: '/etc/evil', content: 'x' }))
    expect(r.ok).toBe(false)
  })

  it('list_dir lists entries', async () => {
    const r = await exec()(call('list_dir', { path: 'sub' }))
    expect(r.ok).toBe(true)
    expect(r.output).toContain('b.txt')
  })

  it('bash reports unavailable without a sandbox port', async () => {
    const r = await exec()(call('bash', { cmd: 'ls' }))
    expect(r).toEqual({ ok: false, output: 'bash: sandbox unavailable' })
  })

  it('bash runs via the injected sandbox port and reports exit code', async () => {
    const e = exec({ runBash: async (cmd) => ({ stdout: `ran: ${cmd}`, stderr: '', exitCode: 0 }) })
    const r = await e(call('bash', { cmd: 'echo hi' }))
    expect(r.ok).toBe(true)
    expect(r.output).toContain('ran: echo hi')
    expect(r.output).toContain('(exit 0)')
  })

  it('bash marks non-zero exit as not ok', async () => {
    const e = exec({ runBash: async () => ({ stdout: '', stderr: 'boom', exitCode: 1 }) })
    const r = await e(call('bash', { cmd: 'false' }))
    expect(r.ok).toBe(false)
    expect(r.output).toContain('boom')
  })

  it('search_memory uses the injected port', async () => {
    const e = exec({ searchMemory: (q) => `hits for ${q}` })
    const r = await e(call('search_memory', { query: 'foo' }))
    expect(r).toEqual({ ok: true, output: 'hits for foo' })
  })

  it('unknown tools return a graceful unsupported result', async () => {
    const r = await exec()(call('telepathy', {}))
    expect(r.ok).toBe(false)
    expect(r.output).toContain('unsupported tool: telepathy')
  })

  it('spawn_subagent dispatches to the injected delegation runner and returns observations', async () => {
    const seen: string[] = []
    const e = exec({
      spawnSubagent: async (planJson) => {
        seen.push(planJson)
        return [{ delegationId: 'd1', status: 'completed', summary: 'ok', touched: [], result: null, cost: { iterations: 1, spendUsd: 0, wallMs: 1 } }]
      },
    })
    const r = await e(call('spawn_subagent', { plan: '{"steps":[{"intent":"do it"}]}' }))
    expect(r.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(r.output).toContain('completed')
  })

  it('spawn_subagent reports unavailable when no delegation runner is wired', async () => {
    const r = await exec()(call('spawn_subagent', { plan: '{}' }))
    expect(r.ok).toBe(false)
  })

  it('goal_done returns the sentinel and has no side effect', async () => {
    const fs = memFs()
    const writeSpy: string[] = []
    fs.writeFile = (p, c) => { writeSpy.push(p); void fs.files.set(p, c) }
    const bashCalls: string[] = []
    const e = makeToolExecutor({
      fs,
      workspaceRoot: ROOT,
      runBash: async (cmd) => { bashCalls.push(cmd); return { stdout: '', stderr: '', exitCode: 0 } },
    })
    const r = await e(call('goal_done', {}))
    expect(r.ok).toBe(true)
    expect(r.output).toBe('__goal_done__')
    expect(writeSpy).toHaveLength(0)
    expect(bashCalls).toHaveLength(0)
  })
})
