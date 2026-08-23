import { describe, expect, it } from 'vitest'
import type { ToolCall } from '../agent-loop/types.js'
import { ConfinementError, type ConfinementPort } from './confinement.js'
import { ContextLeaseError } from './context-lease.js'
import { makeLeaseBoundToolExecutor } from './lease-bound-tool-executor.js'
import type { TurnContextLease } from './context-lease.js'

const LEASE: TurnContextLease = Object.freeze({
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  projectKind: 'project',
  sessionId: 'session-a',
  root: '/Users/operator/projects/a',
  generation: 7,
  leaseId: 'lease-a',
})

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { name, args }
}

function setup(overrides: Partial<ConfinementPort> = {}) {
  const calls: Array<{ kind: string; lease: TurnContextLease; value: string }> = []
  const confinement: ConfinementPort = {
    readText: async (lease, path) => {
      calls.push({ kind: 'read', lease, value: path })
      return 'content'
    },
    writeText: async (lease, path, text) => {
      calls.push({ kind: 'write', lease, value: `${path}:${text}` })
      return Buffer.byteLength(text)
    },
    editText: async (lease, path, oldText, newText, options) => {
      calls.push({
        kind: 'edit',
        lease,
        value: `${path}:${oldText}:${newText}:${options?.replaceAll === true}`,
      })
      return { bytes: Buffer.byteLength(newText), replacements: 1 }
    },
    list: async (lease, path) => {
      calls.push({ kind: 'list', lease, value: path ?? '.' })
      return ['a.txt', 'docs']
    },
    scan: async () => ({ entries: 0, files: 0, directories: 0, totalBytes: 0 }),
    ...overrides,
  }
  const fallbackCalls: ToolCall[] = []
  const executor = makeLeaseBoundToolExecutor({
    lease: LEASE,
    confinement,
    fallback: async (toolCall) => {
      fallbackCalls.push(toolCall)
      return { ok: true, output: `fallback:${toolCall.name}` }
    },
  })
  return { calls, confinement, fallbackCalls, executor }
}

describe('makeLeaseBoundToolExecutor', () => {
  it('routes read, write, edit, and list through the exact turn lease', async () => {
    const { executor, calls, fallbackCalls } = setup()

    await expect(executor(call('read_file', { path: 'a.txt' }))).resolves.toEqual({
      ok: true,
      output: 'content',
    })
    await expect(executor(call('write_file', { path: 'b.txt', content: 'Привет' })))
      .resolves.toEqual({ ok: true, output: 'wrote 12 bytes' })
    await expect(executor(call('edit_file', {
      path: 'b.txt', oldText: 'Привет', newText: 'Готово', replaceAll: false,
    }))).resolves.toEqual({
      ok: true,
      output: 'edited 1 occurrence(s); 12 bytes',
    })
    await expect(executor(call('list_dir'))).resolves.toEqual({
      ok: true,
      output: 'a.txt\ndocs',
    })

    expect(calls.map((item) => item.kind)).toEqual(['read', 'write', 'edit', 'list'])
    expect(calls.every((item) => item.lease === LEASE)).toBe(true)
    expect(fallbackCalls).toEqual([])
  })

  it('never lets file tools fall through after a confinement denial', async () => {
    const { executor, fallbackCalls } = setup({
      readText: async () => { throw new ConfinementError('SYMLINK_DENIED') },
    })

    await expect(executor(call('read_file', { path: 'escape' }))).resolves.toEqual({
      ok: false,
      output: 'read_file: SYMLINK_DENIED',
    })
    expect(fallbackCalls).toEqual([])
  })

  it('returns code-only edit precondition failures without fallback or content', async () => {
    const { executor, fallbackCalls } = setup({
      editText: async () => { throw new ConfinementError('AMBIGUOUS_MATCH') },
    })

    await expect(executor(call('edit_file', {
      path: 'a.txt', oldText: 'private old text', newText: 'new text',
    }))).resolves.toEqual({ ok: false, output: 'edit_file: AMBIGUOUS_MATCH' })
    expect(fallbackCalls).toEqual([])
  })

  it('rejects malformed edit arguments before confinement I/O', async () => {
    const { executor, calls, fallbackCalls } = setup()

    await expect(executor(call('edit_file', {
      path: 'a.txt', oldText: 'old', replaceAll: 'yes',
    }))).resolves.toEqual({ ok: false, output: 'edit_file: INVALID_ARGUMENTS' })
    expect(calls).toEqual([])
    expect(fallbackCalls).toEqual([])
  })

  it('redacts unexpected file-port failures', async () => {
    const { executor } = setup({
      writeText: async () => { throw new Error('/private/operator/path') },
    })

    await expect(executor(call('write_file', { path: 'a.txt', content: 'x' })))
      .resolves.toEqual({ ok: false, output: 'write_file: FILE_TOOL_FAILED' })
  })

  it('keeps bash unavailable without a root-only sandbox port', async () => {
    const { executor, fallbackCalls } = setup()

    await expect(executor(call('bash', { cmd: 'pwd' }))).resolves.toEqual({
      ok: false,
      output: 'bash: root-only sandbox unavailable',
    })
    expect(fallbackCalls).toEqual([])
  })

  it('binds an injected sandbox call to the same immutable lease', async () => {
    const seen: Array<[TurnContextLease, string]> = []
    const { confinement } = setup()
    const executor = makeLeaseBoundToolExecutor({
      lease: LEASE,
      confinement,
      fallback: async () => ({ ok: false, output: 'unused' }),
      runBash: async (lease, command) => {
        seen.push([lease, command])
        return { stdout: lease.root, stderr: '', exitCode: 0 }
      },
    })

    const result = await executor(call('bash', { cmd: 'pwd' }))
    expect(result).toEqual({ ok: true, output: `${LEASE.root}\n(exit 0)` })
    expect(seen).toEqual([[LEASE, 'pwd']])
  })

  it('delegates non-file tools to the existing executor', async () => {
    const { executor, fallbackCalls } = setup()

    await expect(executor(call('search_memory', { query: 'Aisy' }))).resolves.toEqual({
      ok: true,
      output: 'fallback:search_memory',
    })
    expect(fallbackCalls).toEqual([call('search_memory', { query: 'Aisy' })])
  })

  it('maps asynchronous fallback rejection to a stable context code', async () => {
    const { confinement } = setup()
    const executor = makeLeaseBoundToolExecutor({
      lease: LEASE,
      confinement,
      fallback: async () => { throw new ContextLeaseError('STALE_CONTEXT') },
    })

    await expect(executor(call('search_memory'))).resolves.toEqual({
      ok: false,
      output: 'search_memory: STALE_CONTEXT',
    })
  })
})
