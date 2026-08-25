import { describe, expect, it } from 'vitest'
import {
  makeContextLeaseCoordinator,
  makeMemoryRememberReceipt,
  type AgentRunner,
  type ApprovalDecision,
  type ConfinementPort,
  type AttachmentDestination,
  type ProjectService,
  type ResolvedWorkBinding,
  type ScopedMemoryRouter,
  type ToolCall,
  type ToolExecutionContext,
  type ToolResult,
  type TurnContextLease,
  type TurnInput,
} from '@aisy/core'
import { makeInteractiveTurnRuntimeFactory } from './interactive-turn-runtime.js'
import type { SessionApprovalFactory } from './bot.js'

const CONTEXT = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  projectKind: 'project' as const,
  sessionId: 'session-a',
  root: '/Users/operator/projects/a',
  generation: 7,
}
const EXECUTION_CONTEXT: ToolExecutionContext = Object.freeze({
  sessionId: CONTEXT.sessionId,
  turnId: 'turn-a',
  ordinal: 1,
})

function remembered(fact: string, context = EXECUTION_CONTEXT): ToolResult {
  const mutationReceipt = makeMemoryRememberReceipt({ fact }, context)
  if (mutationReceipt === null) throw new Error('test receipt expected')
  return {
    ok: true,
    output: `Запомнил, что ${fact}`,
    verified: true,
    mutationReceipt,
  }
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { name, args }
}

function setup(options: {
  workspace?: boolean
  failBuild?: boolean
  importAttachment?: boolean
  importFailure?: boolean
  layeredContext?: boolean
} = {}) {
  let id = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++id}` })
  const acquired: TurnContextLease[] = []
  const released: TurnContextLease[] = []
  const activeContext = options.workspace
    ? {
        ...CONTEXT,
        projectId: 'workspace-a',
        projectKind: 'workspace' as const,
        root: '/Users/operator/workspace',
      }
    : CONTEXT
  const service = {
    acquireTurnContext: () => {
      const lease = leases.acquire(activeContext)
      acquired.push(lease)
      return lease
    },
    releaseTurnContext: async (lease: TurnContextLease) => {
      released.push(lease)
      await leases.quiesceAndClose(lease)
    },
  } as unknown as ProjectService

  const confinementCalls: Array<{ kind: string; lease: TurnContextLease; value: string }> = []
  const confinement: ConfinementPort = {
    readText: async (lease, path) => {
      confinementCalls.push({ kind: 'read', lease, value: path })
      return 'file content'
    },
    writeText: async (lease, path, text) => {
      confinementCalls.push({ kind: 'write', lease, value: `${path}:${text}` })
      return Buffer.byteLength(text)
    },
    editText: async (lease, path, oldText, newText, options) => {
      confinementCalls.push({
        kind: 'edit',
        lease,
        value: `${path}:${oldText}:${newText}:${options?.replaceAll === true}`,
      })
      return { bytes: Buffer.byteLength(newText), replacements: 1 }
    },
    list: async (lease, path) => {
      confinementCalls.push({ kind: 'list', lease, value: path ?? '.' })
      return ['a.txt']
    },
    scan: async () => ({ entries: 0, files: 0, directories: 0, totalBytes: 0 }),
  }
  const memoryCalls: Array<{ kind: string; lease: TurnContextLease; value: string }> = []
  const validateMemoryLease = (lease: TurnContextLease): void => {
    const operation = leases.reserveOperation(lease)
    operation.complete()
  }
  const scopedMemory: ScopedMemoryRouter = {
    searchAutomatic: async (lease, query) => {
      validateMemoryLease(lease)
      memoryCalls.push({ kind: 'search', lease, value: query })
      return {
        requestedMode: 'keyword',
        effectiveMode: 'keyword',
        status: 'OK',
        hits: [{
          id: 'fact-1',
          factKey: 'fact-key',
          text: 'project fact',
          score: -1,
          scope: lease.projectKind === 'project' ? 'project' : 'global',
          ...(lease.projectKind === 'project' ? { projectId: lease.projectId } : {}),
          componentRanks: { keyword: 1 },
        }],
      }
    },
    commitGlobal: async (lease, op) => {
      validateMemoryLease(lease)
      memoryCalls.push({
        kind: 'commit-global',
        lease,
        value: 'text' in op ? op.text : op.targetId,
      })
      return { status: 'COMMITTED' }
    },
    commitProject: async (lease, op) => {
      validateMemoryLease(lease)
      memoryCalls.push({
        kind: 'commit-project',
        lease,
        value: 'text' in op ? op.text : op.targetId,
      })
      return { status: 'COMMITTED' }
    },
    forgetGlobal: async () => {},
    forgetProject: async () => {},
  }
  const fallbackCalls: Array<{ lease: TurnContextLease; call: ToolCall }> = []
  const importCalls: Array<{
    lease: TurnContextLease
    fileId: string
    destination: AttachmentDestination
  }> = []
  const handled: TurnInput[] = []
  const built: Array<{
    lease: TurnContextLease
    grantBinding: ResolvedWorkBinding
    approve: (action: never) => Promise<ApprovalDecision>
    executeTool: (toolCall: ToolCall, context?: ToolExecutionContext) => Promise<ToolResult>
  }> = []
  const factory = makeInteractiveTurnRuntimeFactory({
    owner: { operatorId: CONTEXT.operatorId, profileId: CONTEXT.profileId },
    service,
    leases,
    confinement,
    scopedMemory,
    buildRunner: (input) => {
      if (options.failBuild) throw new Error('runner build failed')
      built.push(input as never)
      return {
        handle: async turnInput => {
          handled.push(turnInput)
          return { state: 'ok', reply: '', narrowed: false }
        },
      } satisfies AgentRunner
    },
    executeNonContextTool: async (lease, toolCall) => {
      fallbackCalls.push({ lease, call: toolCall })
      return { ok: true, output: `fallback:${toolCall.name}` }
    },
    ...(options.layeredContext === true ? {
      layeredContext: {
        augmentTurn: async (lease: TurnContextLease, input: TurnInput) => [{
          role: 'user' as const,
          provenance: 'untrusted' as const,
          text: `${lease.projectId}:${input.spans[0]?.text ?? ''}`,
        }],
      },
    } : {}),
    ...(options.importAttachment === true ? {
      importAttachment: async (
        lease: TurnContextLease,
        fileId: string,
        destination: AttachmentDestination,
      ) => {
        importCalls.push({ lease, fileId, destination })
        if (options.importFailure) throw new Error('sensitive worker failure')
        return {
          schemaVersion: 1 as const,
          operationId: 'a'.repeat(64),
          fileId,
          operatorId: lease.operatorId,
          profileId: lease.profileId,
          projectId: lease.projectId,
          sessionId: lease.sessionId,
          source: 'telegram' as const,
          relativePath: destination === 'knowledge'
            ? `knowledge/imports/${fileId}`
            : `imports/${fileId}`,
          originalName: '<untrusted prompt injection>',
          sha256: 'b'.repeat(64),
          sizeBytes: 42,
          provenance: 'untrusted' as const,
          provenanceRef: 'telegram:update:1',
          createdAt: '2026-07-27T12:00:00.000Z',
          importedFromFileId: fileId,
          published: true,
        }
      },
    } : {}),
  })
  return {
    acquired,
    built,
    confinementCalls,
    factory,
    fallbackCalls,
    handled,
    importCalls,
    leases,
    memoryCalls,
    released,
  }
}

const confirmed: SessionApprovalFactory = () => async () => ({ decision: 'confirmed' })

describe('makeInteractiveTurnRuntimeFactory', () => {
  it('acquires a distinct immutable lease for every turn and releases it idempotently', async () => {
    const state = setup()
    const first = await state.factory.acquire(confirmed)
    await first.release?.()
    await first.release?.()
    const second = await state.factory.acquire(confirmed)

    expect(first.sessionId).toBe(CONTEXT.sessionId)
    expect(second.sessionId).toBe(CONTEXT.sessionId)
    expect(state.acquired.map((lease) => lease.leaseId)).toEqual(['lease-1', 'lease-3'])
    expect(state.acquired.every((lease) => lease.root === CONTEXT.root)).toBe(true)
    expect(state.built[0]?.grantBinding).toEqual({
      operatorId: CONTEXT.operatorId,
      profileId: CONTEXT.profileId,
      projectId: CONTEXT.projectId,
      sessionId: CONTEXT.sessionId,
      scope: 'project',
    })
    expect(state.released).toEqual([state.acquired[0]])
    expect(state.leases.status(state.acquired[0]!)).toBe('closed')
    await second.release?.()
  })

  it('routes file, scoped memory, and non-context tools through the exact lease', async () => {
    const state = setup()
    const runtime = await state.factory.acquire(confirmed)
    const execute = state.built[0]!.executeTool

    await expect(execute(call('read_file', { path: 'README.md' }))).resolves.toEqual({
      ok: true,
      output: 'file content',
    })
    await expect(execute(call('edit_file', {
      path: 'README.md', oldText: 'old', newText: 'new',
    }))).resolves.toMatchObject({ ok: true })
    await expect(execute(call('search_memory', { query: 'project' }))).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining('[project:fact-key]'),
    })
    await expect(execute(
      call('remember', { fact: 'ты помнишь меня' }),
      EXECUTION_CONTEXT,
    )).resolves.toEqual(remembered('ты помнишь меня'))
    await expect(execute(call('web_search', { query: 'Aisy' }))).resolves.toEqual({
      ok: true,
      output: 'fallback:web_search',
    })

    const lease = state.acquired[0]!
    expect(state.confinementCalls.slice(0, 2)).toEqual([
      expect.objectContaining({ kind: 'read', lease }),
      expect.objectContaining({ kind: 'edit', lease }),
    ])
    expect(state.memoryCalls.map((item) => item.kind)).toEqual(['search', 'commit-project'])
    expect(state.memoryCalls.every((item) => item.lease === lease)).toBe(true)
    expect(state.fallbackCalls).toEqual([{ lease, call: call('web_search', { query: 'Aisy' }) }])
    await runtime.release?.()
  })

  it('routes Workspace remember to global memory only', async () => {
    const state = setup({ workspace: true })
    const runtime = await state.factory.acquire(confirmed)

    await state.built[0]!.executeTool(
      call('remember', { fact: 'global fact' }),
      EXECUTION_CONTEXT,
    )

    expect(state.memoryCalls.map((item) => item.kind)).toEqual(['commit-global'])
    await runtime.release?.()
  })

  it('binds lazy layered context to the exact turn lease', async () => {
    const state = setup({ layeredContext: true })
    const runtime = await state.factory.acquire(confirmed)

    await runtime.runner.handle({
      sessionId: CONTEXT.sessionId,
      spans: [{ role: 'user', provenance: 'operator', text: 'question' }],
    })

    expect(state.handled[0]?.spans).toEqual([
      { role: 'user', provenance: 'operator', text: 'question' },
      { role: 'user', provenance: 'untrusted', text: 'project-a:question' },
    ])
    await runtime.release?.()
  })

  it('fails context-sensitive tools closed instead of sending them to fallback', async () => {
    const state = setup()
    const runtime = await state.factory.acquire(confirmed)
    const execute = state.built[0]!.executeTool

    for (const name of ['bash', 'spawn_subagent', 'import_attachment', 'project.switch']) {
      const result = await execute(call(name, name === 'spawn_subagent' ? { plan: '{}' } : {}))
      expect(result.ok).toBe(false)
    }
    expect(state.fallbackCalls).toEqual([])
    await runtime.release?.()
  })

  it('imports only a code-owned destination through the exact lease and returns safe metadata', async () => {
    const state = setup({ importAttachment: true })
    const runtime = await state.factory.acquire(confirmed)
    const execute = state.built[0]!.executeTool

    await expect(execute(call('import_attachment', {
      fileId: 'upload-1', destination: 'knowledge',
    }))).resolves.toEqual({
      ok: true,
      output: JSON.stringify({
        relativePath: 'knowledge/imports/upload-1',
        sha256: 'b'.repeat(64),
        sizeBytes: 42,
        provenance: 'untrusted',
        published: true,
      }),
    })
    expect(state.importCalls).toEqual([{
      lease: state.acquired[0], fileId: 'upload-1', destination: 'knowledge',
    }])
    expect((await execute(call('import_attachment', {
      fileId: 'upload-2', destination: '../escape',
    }))).ok).toBe(false)
    expect(state.importCalls).toHaveLength(1)
    await runtime.release?.()
  })

  it('redacts attachment import implementation failures from the tool result', async () => {
    const state = setup({ importAttachment: true, importFailure: true })
    const runtime = await state.factory.acquire(confirmed)
    await expect(state.built[0]!.executeTool(call('import_attachment', {
      fileId: 'upload-1', destination: 'project-file',
    }))).resolves.toEqual({ ok: false, output: 'import_attachment: failed' })
    await runtime.release?.()
  })

  it('uses scoped recall from the same lease and returns no cross-scope fallback', async () => {
    const state = setup()
    const runtime = await state.factory.acquire(confirmed)

    await expect(runtime.recall?.('what')).resolves.toBe('• project fact')
    expect(state.memoryCalls).toEqual([expect.objectContaining({
      kind: 'search',
      lease: state.acquired[0],
      value: 'what',
    })])
    await runtime.release?.()
  })

  it('releases the lease when runner construction fails', async () => {
    const state = setup({ failBuild: true })

    await expect(state.factory.acquire(confirmed)).rejects.toThrow('runner build failed')
    expect(state.released).toEqual([state.acquired[0]])
    expect(state.leases.status(state.acquired[0]!)).toBe('closed')
  })

  it('rejects an approval when the turn lease became cancelling', async () => {
    const state = setup()
    const runtime = await state.factory.acquire(confirmed)
    const lease = state.acquired[0]!
    const closing = state.leases.quiesceAndClose(lease)

    await expect(state.built[0]!.approve({} as never)).resolves.toEqual({ decision: 'rejected' })
    await runtime.release?.()
    await closing
    expect(state.leases.status(lease)).toBe('closed')
  })

  it('surfaces stale context for scoped memory before touching its store', async () => {
    const state = setup({ importAttachment: true })
    const runtime = await state.factory.acquire(confirmed)
    const lease = state.acquired[0]!
    const closing = state.leases.quiesceAndClose(lease)
    const execute = state.built[0]!.executeTool

    await expect(execute(call('search_memory', { query: 'old project' }))).resolves.toEqual({
      ok: false,
      output: 'search_memory: STALE_CONTEXT',
    })
    await expect(execute(call('remember', { text: 'old project fact' }), EXECUTION_CONTEXT)).resolves.toEqual({
      ok: false,
      output: 'remember: STALE_CONTEXT',
    })
    await expect(execute(call('import_attachment', {
      fileId: 'upload-1', destination: 'project-file',
    }))).resolves.toEqual({
      ok: false,
      output: 'import_attachment: STALE_CONTEXT',
    })
    expect(state.memoryCalls).toEqual([])
    expect(state.importCalls).toEqual([])
    await runtime.release?.()
    await closing
  })
})
