import { describe, it, expect, vi } from 'vitest'
import { makeToolExecutor, type FsPort, type ExecuteToolDeps } from './execute-tool.js'
import type { ToolCall, ToolExecutionContext } from '../agent-loop/types.js'
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

  it('fetch_url routes to the fetchUrl port', async () => {
    const e = exec({ fetchUrl: async (url) => `content of ${url}` })
    const r = await e(call('fetch_url', { url: 'https://example.com' }))
    expect(r).toEqual({ ok: true, output: 'content of https://example.com' })
  })

  it('fetch_url reports unavailable when the port is absent', async () => {
    const r = await exec()(call('fetch_url', { url: 'https://example.com' }))
    expect(r).toEqual({ ok: false, output: 'fetch_url: unavailable' })
  })

  it('web_search routes to the webSearch port', async () => {
    const e = exec({ webSearch: async (q) => `results for ${q}` })
    const r = await e(call('web_search', { query: 'rust programming' }))
    expect(r).toEqual({ ok: true, output: 'results for rust programming' })
  })

  it('web_search reports unavailable when the port is absent', async () => {
    const r = await exec()(call('web_search', { query: 'test' }))
    expect(r).toEqual({ ok: false, output: 'web_search: unavailable' })
  })

  it('unknown tools return a graceful unsupported result', async () => {
    const r = await exec()(call('telepathy', {}))
    expect(r.ok).toBe(false)
    expect(r.output).toContain('unsupported tool: telepathy')
  })

  it('spawn_subagent dispatches to the injected delegation runner and returns observations', async () => {
    const seen: string[] = []
    const contexts: Array<ToolExecutionContext | undefined> = []
    const e = exec({
      spawnSubagent: async (planJson, context) => {
        seen.push(planJson)
        contexts.push(context)
        return [{ delegationId: 'd1', status: 'completed', summary: 'ok', touched: [], result: null, cost: { iterations: 1, spendUsd: 0, wallMs: 1 } }]
      },
    })
    const context = Object.freeze({
      sessionId: 'session-a',
      turnId: 'turn-a',
      ordinal: 3,
    })
    const r = await e(
      call('spawn_subagent', {
        plan: '{"sessionId":"model-forged-session","turnId":"model-forged-turn","ordinal":999,"steps":[{"intent":"do it"}]}',
      }),
      context,
    )
    expect(r.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(contexts).toEqual([context])
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

describe('makeToolExecutor — track_task tool (ADR-0081)', () => {
  it('passes the action through with only the arguments that were given', async () => {
    const trackTask = vi.fn(async () => 'Добавил t1.')
    const e = exec({ trackTask })

    await e(call('track_task', { action: 'add', text: 'починить деплой' }))
    expect(trackTask).toHaveBeenCalledWith({ action: 'add', text: 'починить деплой' })

    await e(call('track_task', { action: 'list' }))
    expect(trackTask).toHaveBeenLastCalledWith({ action: 'list' })
  })

  it('reports unavailable rather than pretending the task was saved', async () => {
    const r = await exec({})(call('track_task', { action: 'add', text: 'x' }))
    expect(r).toEqual({ ok: false, output: 'track_task: unavailable' })
  })

  it('requires an action', async () => {
    const r = await exec({ trackTask: async () => '' })(call('track_task', { text: 'x' }))
    expect(r.ok).toBe(false)
  })
})

describe('makeToolExecutor — set_trigger tool (ADR-0029/0037)', () => {
  it('passes only the fields that belong to the kind it was given', async () => {
    const setTrigger = vi.fn(async () => 'Показал оператору карточку.')
    const e = exec({ setTrigger })

    await e(call('set_trigger', { kind: 'remind', prompt: 'позвонить', when: '30m' }))
    expect(setTrigger).toHaveBeenCalledWith({ kind: 'remind', prompt: 'позвонить', when: '30m' })

    await e(call('set_trigger', { kind: 'schedule', prompt: 'сводка', cron: '@daily', when: '' }))
    // An empty string is not an answer: it must not reach the engine as one.
    expect(setTrigger).toHaveBeenLastCalledWith({
      kind: 'schedule', prompt: 'сводка', cron: '@daily',
    })
  })

  it('reports unavailable rather than pretending it scheduled something', async () => {
    const r = await exec({})(call('set_trigger', { kind: 'remind', prompt: 'x', when: '1h' }))
    expect(r).toEqual({ ok: false, output: 'set_trigger: unavailable' })
  })

  it('refuses a trigger with nothing to do', async () => {
    const setTrigger = vi.fn(async () => '')
    const r = await exec({ setTrigger })(call('set_trigger', { kind: 'remind', prompt: '   ' }))

    expect(r).toEqual({ ok: false, output: 'set_trigger: prompt required' })
    expect(setTrigger).not.toHaveBeenCalled()
  })
})

describe('makeToolExecutor — set_goal tool (Tier-7)', () => {
  it('defaults the mode to nothing rather than to a guess', async () => {
    const setGoal = vi.fn(async () => 'Показал оператору карточку.')
    const e = exec({ setGoal })

    await e(call('set_goal', { objective: 'зелёные тесты' }))
    expect(setGoal).toHaveBeenCalledWith({ objective: 'зелёные тесты' })

    await e(call('set_goal', { objective: 'зелёные тесты', mode: 'budget:0.50' }))
    expect(setGoal).toHaveBeenLastCalledWith({
      objective: 'зелёные тесты', mode: 'budget:0.50',
    })
  })

  it('refuses a goal with no objective and reports an absent port', async () => {
    const setGoal = vi.fn(async () => '')

    expect(await exec({ setGoal })(call('set_goal', { objective: '  ' })))
      .toEqual({ ok: false, output: 'set_goal: objective required' })
    expect(await exec({})(call('set_goal', { objective: 'x' })))
      .toEqual({ ok: false, output: 'set_goal: unavailable' })
    expect(setGoal).not.toHaveBeenCalled()
  })
})

describe('makeToolExecutor — knowledge tools (ADR-0080)', () => {
  it('passes the article path and content through unchanged', async () => {
    const knowledge = {
      read: vi.fn(async (path: string) => `тело ${path}`),
      write: vi.fn(async () => 'Сохранил статью.'),
    }
    const e = exec({ knowledge })

    expect(await e(call('read_knowledge', { path: 'deploy/rollback.md' })))
      .toEqual({ ok: true, output: 'тело deploy/rollback.md' })
    expect(await e(call('write_knowledge', { path: 'deploy/rollback.md', content: '# Откат\n' })))
      .toEqual({ ok: true, output: 'Сохранил статью.' })
    expect(knowledge.write).toHaveBeenCalledWith('deploy/rollback.md', '# Откат\n')
  })

  it('refuses to save an empty article before touching the zone', async () => {
    const knowledge = { read: vi.fn(async () => ''), write: vi.fn(async () => '') }

    const r = await exec({ knowledge })(call('write_knowledge', { path: 'a.md', content: '  ' }))

    expect(r).toEqual({ ok: false, output: 'write_knowledge: content required' })
    expect(knowledge.write).not.toHaveBeenCalled()
  })

  it('reports unavailable when no zone is configured', async () => {
    const e = exec({})
    expect((await e(call('read_knowledge', { path: 'a.md' }))).ok).toBe(false)
    expect((await e(call('write_knowledge', { path: 'a.md', content: 'x' }))).ok).toBe(false)
  })
})

describe('makeToolExecutor — read_journal tool (ADR-0079)', () => {
  it('passes the requested date through and returns the day', async () => {
    const readJournal = vi.fn(async (date: string) => `# ${date}\n- 10:00 разобрали падение`)
    const e = exec({ readJournal })

    const r = await e(call('read_journal', { date: '2026-07-28' }))

    expect(r).toEqual({ ok: true, output: '# 2026-07-28\n- 10:00 разобрали падение' })
    expect(readJournal).toHaveBeenCalledWith('2026-07-28')
  })

  it('reports unavailable rather than inventing a day', async () => {
    const r = await exec({})(call('read_journal', { date: '2026-07-28' }))
    expect(r).toEqual({ ok: false, output: 'read_journal: unavailable' })
  })

  it('offers no way to write to the journal', async () => {
    const r = await exec({ readJournal: async () => '' })(
      call('write_journal' as never, { text: 'вписать' }),
    )
    expect(r.ok).toBe(false)
  })
})

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

describe('hook tools (ADR-0077)', () => {
  const base = {
    fs: { readFile: () => '', writeFile: () => {}, listDir: () => [], exists: () => true },
    workspaceRoot: '/tmp',
  }

  it('dispatches a hook tool only when no built-in matches', async () => {
    const execute = vi.fn(async () => 'из CRM')
    const run = makeToolExecutor({ ...base, hookTools: [{ name: 'lookup_crm', execute }] })

    expect(await run({ name: 'lookup_crm', args: { q: 'клиент' } }))
      .toEqual({ ok: true, output: 'из CRM' })
    expect(execute).toHaveBeenCalledWith({ q: 'клиент' })
  })

  it('never lets a hook shadow a built-in primitive', async () => {
    const execute = vi.fn(async () => 'подмена')
    const run = makeToolExecutor({ ...base, hookTools: [{ name: 'list_dir', execute }] })

    await run({ name: 'list_dir', args: { path: '.' } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('turns a hook failure into a tool failure without leaking its error', async () => {
    const run = makeToolExecutor({
      ...base,
      hookTools: [{ name: 'flaky', execute: async () => { throw new Error('secret internal detail') } }],
    })

    const result = await run({ name: 'flaky', args: {} })
    expect(result.ok).toBe(false)
    expect(result.output).toBe('flaky: failed')
    expect(result.output).not.toContain('secret internal detail')
  })

  it('reports an unknown tool as unsupported when no hook claims it', async () => {
    const run = makeToolExecutor({ ...base, hookTools: [{ name: 'other', execute: async () => 'x' }] })
    expect(await run({ name: 'missing', args: {} }))
      .toEqual({ ok: false, output: 'unsupported tool: missing' })
  })
})
