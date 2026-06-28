import { describe, it, expect, vi } from 'vitest'
import { makeToolExecutor, type FsPort, type ExecuteToolDeps } from './execute-tool.js'
import type { ToolCall } from '../agent-loop/types.js'
import type { Memory, CommitResult } from '../memory/index.js'

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

function fakeMemory(commitResult: CommitResult): Memory {
  return {
    search: async () => [],
    load: async () => '',
    readFrozenSnapshot: async () => ({ bytes: Buffer.from(''), sha256: '' }),
    commit: async () => commitResult,
    forget: async () => {},
    reindex: async () => {},
    rebuildFromFiles: async () => {},
    listLive: async () => [],
    serializeMemoryIndex: async () => ({ content: '', sha256: '' }),
    integrityCheck: async () => ({ ok: true }) as never,
  }
}

describe('makeToolExecutor — remember tool', () => {
  it('calls commit with the text and withinSession:true, returns Запомнил on COMMITTED', async () => {
    const commitSpy = vi.fn(async (): Promise<CommitResult> => ({ status: 'COMMITTED' }))
    const memory: Memory = { ...fakeMemory({ status: 'COMMITTED' }), commit: commitSpy }
    const e = exec({ memory })
    const r = await e(call('remember', { text: 'User prefers Russian replies' }))
    expect(r).toEqual({ ok: true, output: 'Запомнил.' })
    expect(commitSpy).toHaveBeenCalledOnce()
    expect(commitSpy).toHaveBeenCalledWith(
      { op: 'ADD', text: 'User prefers Russian replies' },
      { withinSession: true },
    )
  })

  it('returns BLOCKED message on BLOCKED status', async () => {
    const e = exec({ memory: fakeMemory({ status: 'BLOCKED' }) })
    const r = await e(call('remember', { text: 'some fact' }))
    expect(r).toEqual({ ok: false, output: 'Эта информация ранее удалена из памяти.' })
  })

  it('returns review message on ROUTED_TO_REVIEW status', async () => {
    const e = exec({ memory: fakeMemory({ status: 'ROUTED_TO_REVIEW' }) })
    const r = await e(call('remember', { text: 'some fact' }))
    expect(r).toEqual({ ok: true, output: 'Похоже на ранее удалённое — отправил на проверку.' })
  })

  it('rejects empty text', async () => {
    const e = exec({ memory: fakeMemory({ status: 'COMMITTED' }) })
    const r = await e(call('remember', { text: '' }))
    expect(r).toEqual({ ok: false, output: 'remember: text required' })
  })

  it('rejects whitespace-only text', async () => {
    const e = exec({ memory: fakeMemory({ status: 'COMMITTED' }) })
    const r = await e(call('remember', { text: '   ' }))
    expect(r).toEqual({ ok: false, output: 'remember: text required' })
  })

  it('reports unavailable when memory dep is absent', async () => {
    const r = await exec()(call('remember', { text: 'hello' }))
    expect(r).toEqual({ ok: false, output: 'remember: unavailable' })
  })

  it('surfaces a short error message when commit throws instead of crashing', async () => {
    const memory: Memory = {
      ...fakeMemory({ status: 'COMMITTED' }),
      commit: async () => { throw new Error('disk full') },
    }
    const e = exec({ memory })
    const r = await e(call('remember', { text: 'some fact' }))
    expect(r.ok).toBe(false)
    expect(r.output).toContain('disk full')
  })
})
