import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Update, UserFromGetMe } from 'grammy/types'
import {
  makeFreshProjectRegistryV2,
  makeGateway,
  type AgentRunner,
  type ProjectRegistryStateV2,
  type ProtectedMemoryScope,
  type ToolCall,
} from '@aisy/core'
import { makeTelegramBot } from './bot.js'
import { makeNodeAttachmentImportRuntime } from './attachment-import-runtime.js'
import {
  makeNodeAttachmentAwareInteractiveTurnRuntimeFactory,
  makeNodeProjectRuntimeFromRegistry,
} from './project-service-runtime.js'
import { makeNodeProjectRegistryV2Store } from './project-registry-v2-store.js'
import {
  makeNodeProtectedMemoryPreviewRouter,
  makeNodeProtectedMemoryScopeRuntime,
  type NodeProtectedMemoryScopeRuntime,
} from './protected-memory-runtime.js'
import { makeTelegramProjectControls } from './telegram-project-controls.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const NOW = Date.parse('2026-07-27T09:00:00.000Z')
const pythonExecutable = resolve(process.cwd(), '../sidecars-py/.venv/bin/python')
const attachmentWorker = resolve(process.cwd(), '../sidecars-py/aisy_sidecars/attachment_worker.py')
const confinementWorker = resolve(process.cwd(), '../sidecars-py/aisy_sidecars/confinement_worker.py')
const roots: string[] = []
type OpenProtectedMemory = Extract<NodeProtectedMemoryScopeRuntime, { mode: 'preview' }>

const BOT_INFO: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: 'Aisy',
  username: 'aisy_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function textUpdate(updateId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(NOW / 1000) + updateId,
      chat: { id: 42, type: 'private', first_name: 'Operator' },
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      text,
    },
  }
}

function callbackUpdate(updateId: number, data: string): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      chat_instance: 'test',
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      data,
      message: {
        message_id: updateId,
        date: Math.floor(NOW / 1000) + updateId,
        chat: { id: 42, type: 'private', first_name: 'Operator' },
        text: 'Где я работаю',
      },
    },
  }
}

interface ApiCall {
  method: string
  payload: unknown
}

function sentTexts(calls: ApiCall[], from = 0): string[] {
  return calls.slice(from)
    .filter((call) => call.method === 'sendMessage')
    .map((call) => String((call.payload as { text?: unknown }).text ?? ''))
}

async function waitForText(calls: ApiCall[], from: number, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 1_500; attempt++) {
    if (sentTexts(calls, from).some((text) => text.includes(expected))) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  throw new Error(`Telegram reply not observed: ${expected}; got=${sentTexts(calls, from).join(' | ')}`)
}

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex')

describe.runIf(
  existsSync(pythonExecutable) && existsSync(attachmentWorker) && existsSync(confinementWorker),
)('Telegram Project runtime integration', () => {
  it('keeps two Projects, their Sessions, Files and scoped memory isolated through restart', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-telegram-project-e2e-')))
    roots.push(root)
    const homeRoot = join(root, 'home')
    const projectsRoot = join(homeRoot, 'projects')
    const workspaceRoot = join(homeRoot, 'workspace')
    const projectRootA = join(projectsRoot, 'project-a')
    const projectRootB = join(projectsRoot, 'project-b')
    const controlRoot = join(homeRoot, '.aisy')
    const inboxRoot = join(controlRoot, 'inbox')
    const registryPath = join(controlRoot, 'projects-v2.json')
    const authorityStatePath = join(controlRoot, 'authority', 'switch-state.json')
    for (const directory of [
      workspaceRoot,
      projectRootA,
      projectRootB,
      join(inboxRoot, 'records'),
      join(inboxRoot, 'objects'),
    ]) mkdirSync(directory, { recursive: true, mode: 0o700 })

    const policy = {
      homeRoot,
      projectsRoot,
      protectedRoots: [controlRoot],
    }
    let registryId = 0
    const fresh = makeFreshProjectRegistryV2({
      ...OWNER,
      workspaceRoot,
      nowIso: () => new Date(NOW).toISOString(),
      newId: () => `fresh-${++registryId}`,
      policy,
    })
    const workspace = fresh.projects[0]!
    const workspaceSession = fresh.sessions[0]!
    const state: ProjectRegistryStateV2 = {
      version: 2,
      projects: [
        workspace,
        {
          id: 'project-a', ...OWNER, kind: 'project', origin: 'created',
          name: 'Project A', slug: 'project-a', root: projectRootA,
          createdAt: new Date(NOW).toISOString(),
        },
        {
          id: 'project-b', ...OWNER, kind: 'project', origin: 'created',
          name: 'Project B', slug: 'project-b', root: projectRootB,
          createdAt: new Date(NOW).toISOString(),
        },
      ],
      sessions: [
        workspaceSession,
        {
          id: 'session-a', projectId: 'project-a', name: 'Session A', status: 'active',
          createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
        },
        {
          id: 'session-b', projectId: 'project-b', name: 'Session B', status: 'active',
          createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
        },
      ],
      selections: [{ ...OWNER, projectId: 'project-a', sessionId: 'session-a', generation: 1 }],
    }
    makeNodeProjectRegistryV2Store({ path: registryPath, policy }).saveAtomic(state)

    const payload = Buffer.from('вложение только проекта A', 'utf8')
    writeFileSync(join(inboxRoot, 'objects', 'upload-1'), payload, { mode: 0o600 })
    writeFileSync(join(inboxRoot, 'records', 'upload-1.json'), JSON.stringify({
      schemaVersion: 1,
      fileId: 'upload-1',
      ...OWNER,
      sessionId: 'session-a',
      source: 'telegram',
      originalName: '../../outside.txt',
      sha256: sha256(payload),
      sizeBytes: payload.byteLength,
      provenanceRef: 'telegram:update:500',
      receivedAt: new Date(NOW).toISOString(),
    }), { mode: 0o600 })

    let receiptId = 0
    let leaseId = 0
    let requestId = 0
    const makeProjectRuntime = () => {
      const options = {
        registryPath,
        registryPolicy: policy,
        projectsRoot,
        controlRoot,
        nowMs: () => NOW,
        nowIso: () => new Date(NOW).toISOString(),
        newRegistryId: () => `registry-${++registryId}`,
        newReceiptId: () => `receipt-${++receiptId}`,
        newLeaseId: () => `lease-${++leaseId}`,
        newProvisioningId: () => `provision-${++requestId}`,
        pythonExecutable,
        confinementWorkerPath: confinementWorker,
        newConfinementRequestId: () => `confinement-${++requestId}`,
      }
      Object.defineProperties(options, {
        [['authority', 'Secret'].join('')]: {
          value: new Uint8Array(32).fill(9), enumerable: true,
        },
        [['nonce', 'Path'].join('')]: {
          value: authorityStatePath, enumerable: true,
        },
      })
      return makeNodeProjectRuntimeFromRegistry(
        options as Parameters<typeof makeNodeProjectRuntimeFromRegistry>[0],
      )
    }

    const descriptor = {
      provider: 'openrouter' as const, modelId: 'test', modelRevision: '1', dimensions: 2,
      normalizationVersion: 'nfkc-v1', chunkerVersion: 'fact-v1',
    }
    const memoryPaths = (stateRoot: string, contentRoot: string) => ({
      ledger: join(stateRoot, 'ledger.sqlite'),
      keyword: join(stateRoot, 'keyword.sqlite'),
      semantic: join(stateRoot, 'semantic.sqlite'),
      barrier: join(stateRoot, 'barrier.sqlite'),
      contentRoot,
      stagingRoot: join(stateRoot, 'staging'),
    })
    let factId = 0
    const openScopes: OpenProtectedMemory[] = []
    const makeScope = (
      projectRuntime: ReturnType<typeof makeProjectRuntime>,
      scope: ProtectedMemoryScope,
      paths: ReturnType<typeof memoryPaths>,
    ) => {
      const runtime = makeNodeProtectedMemoryScopeRuntime({
        mode: 'preview',
        paths,
        ...OWNER,
        scope,
        leases: projectRuntime.leases,
        descriptor,
        nowIso: () => new Date(NOW).toISOString(),
        newFactId: () => `replacement-${++factId}`,
        prepareFact: async ({ text }) => {
          const keyTokens = text.normalize('NFKC').toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? []
          return {
            factKey: sha256(keyTokens.join('|')),
            keyTokens,
            validAt: new Date(NOW).toISOString(),
            isHumanConfirmed: false,
            sourceAuthority: 50,
            confidence: 0.9,
          }
        },
        deliverPublicationAuditOnce: async () => undefined,
        deliverDeletionAuditOnce: async () => undefined,
        deliverUpdateAuditOnce: async () => undefined,
      })
      if (runtime.mode !== 'preview') throw new Error('preview memory runtime expected')
      openScopes.push(runtime)
      return runtime
    }

    const seenBindings: Array<{ projectId: string; sessionId: string }> = []
    const compose = (projectRuntime: ReturnType<typeof makeProjectRuntime>) => {
      const globalMemory = makeScope(
        projectRuntime,
        { kind: 'global', scopeId: 'global' },
        memoryPaths(join(controlRoot, 'memory', 'global'), workspaceRoot),
      )
      const memoryA = makeScope(
        projectRuntime,
        { kind: 'project', scopeId: 'project:project-a', projectId: 'project-a' },
        memoryPaths(join(controlRoot, 'memory', 'projects', 'project-a'), projectRootA),
      )
      const memoryB = makeScope(
        projectRuntime,
        { kind: 'project', scopeId: 'project:project-b', projectId: 'project-b' },
        memoryPaths(join(controlRoot, 'memory', 'projects', 'project-b'), projectRootB),
      )
      const scopedMemory = makeNodeProtectedMemoryPreviewRouter({
        leases: projectRuntime.leases,
        globalRuntime: globalMemory,
        projectRuntime: (projectId) => projectId === 'project-a'
          ? memoryA
          : projectId === 'project-b' ? memoryB : null,
        newFactId: () => `fact-${++factId}`,
        provenanceFor: ({ lease, op, scope }) =>
          `${lease.sessionId}:${lease.generation}:${scope.scopeId}:${op.op}`,
        authorizeHumanConfirmedDelete: async () => false,
      })
      if (!scopedMemory) throw new Error('protected memory router expected')
      const attachments = makeNodeAttachmentImportRuntime({
        runtime: projectRuntime,
        controlRoot,
        inboxRoot,
        pythonExecutable,
        workerPath: attachmentWorker,
        maxAttachmentBytes: 1024 * 1024,
        newRequestId: () => `attachment-${++requestId}`,
        nowIso: () => new Date(NOW).toISOString(),
      })
      const turns = makeNodeAttachmentAwareInteractiveTurnRuntimeFactory({
        runtime: projectRuntime,
        attachments,
        deps: {
          owner: OWNER,
          scopedMemory,
          buildRunner: ({ lease, executeTool }) => ({
            async handle(turn) {
              seenBindings.push({ projectId: lease.projectId, sessionId: turn.sessionId })
              const text = turn.spans.filter((span) => span.role === 'user').at(-1)?.text ?? ''
              let call: ToolCall
              if (text.startsWith('remember:')) {
                call = { name: 'remember', args: { fact: text.slice('remember:'.length) } }
              } else if (text.startsWith('search:')) {
                call = { name: 'search_memory', args: { query: text.slice('search:'.length) } }
              } else if (text.startsWith('import:')) {
                call = {
                  name: 'import_attachment',
                  args: { fileId: text.slice('import:'.length), destination: 'project-file' },
                }
              } else if (text.startsWith('read:')) {
                call = { name: 'read_file', args: { path: text.slice('read:'.length) } }
              } else {
                call = { name: 'unknown', args: {} }
              }
              const result = await executeTool(call, {
                sessionId: turn.sessionId,
                turnId: turn.turnId ?? `test:${turn.sessionId}:${text}`,
                ordinal: 1,
              })
              return { state: 'ok', reply: result.output, narrowed: false }
            },
          }) satisfies AgentRunner,
          executeNonContextTool: async (_lease, call) => ({
            ok: false, output: `${call.name}: unsupported in test`,
          }),
        },
      })
      let callbackId = 0
      const controls = makeTelegramProjectControls({
        runtime: projectRuntime,
        owner: OWNER,
        newTokenId: () => `context-${++callbackId}`,
        displayRoot: (path) => path.replace(homeRoot, '$HOME'),
      })
      const gateway = makeGateway({
        getAllowedChatId: async () => 42,
        getBotToken: async () => 'unused',
        isReady: () => true,
        transcribeVoice: async () => '',
        isOutboundLocked: () => false,
        isSafetyAvailable: () => true,
      })
      const calls: ApiCall[] = []
      const { bot } = makeTelegramBot({
        token: 'test-token',
        allowedChatId: 42,
        gateway,
        acquireTurnRuntime: (approval) => turns.acquire(approval),
        projectControls: controls,
        model: 'test-model',
        debounceMs: 1,
        registerCommands: false,
      })
      bot.botInfo = BOT_INFO
      bot.api.config.use(async (_previous, method, payloadForCall) => {
        calls.push({ method, payload: payloadForCall })
        return { ok: true, result: true } as never
      })
      return { bot, calls, projectRuntime, globalMemory, memoryA, memoryB }
    }

    let updateId = 0
    const send = async (
      composition: ReturnType<typeof compose>,
      command: string,
      expected: string,
    ) => {
      const from = composition.calls.length
      await composition.bot.handleUpdate(textUpdate(++updateId, command))
      await waitForText(composition.calls, from, expected)
    }
    const switchTo = async (
      composition: ReturnType<typeof compose>,
      label: string,
    ) => {
      const from = composition.calls.length
      await composition.bot.handleUpdate(textUpdate(++updateId, '📁 Проекты'))
      const menuCall = composition.calls.slice(from).find((call) =>
        call.method === 'sendMessage' &&
        String((call.payload as { text?: unknown }).text ?? '').startsWith('Где я работаю'))
      if (!menuCall) throw new Error('project menu not observed')
      const keyboard = (menuCall.payload as {
        reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
      }).reply_markup.inline_keyboard
      const button = keyboard.flat().find((candidate) => candidate.text.includes(label))
      if (!button) throw new Error(`project button not observed: ${label}`)
      await composition.bot.handleUpdate(callbackUpdate(++updateId, button.callback_data))
    }

    try {
      const first = compose(makeProjectRuntime())
    await send(first, 'remember:Проектный маяк Альфа', 'Запомнил, что Проектный маяк Альфа')
      await send(first, 'import:upload-1', '"relativePath":"imports/upload-1"')
      await send(first, 'read:imports/upload-1', payload.toString('utf8'))

      await send(first, 'работаем над Project B', '✅ Контекст: Project B')
      expect(first.projectRuntime.registry.getActive(OWNER)).toMatchObject({
        projectId: 'project-b', sessionId: 'session-b', generation: 2,
      })
      await send(first, 'search:Альфа', 'Память: ничего не найдено.')
      await send(first, 'read:imports/upload-1', 'read_file:')
      expect(sentTexts(first.calls).at(-1)).not.toContain(payload.toString('utf8'))
    await send(first, 'remember:Проектный маяк Гамма', 'Запомнил, что Проектный маяк Гамма')
      await send(first, 'search:Гамма', 'Проектный маяк Гамма')

      await switchTo(first, 'Workspace')
      expect(first.projectRuntime.registry.getActive(OWNER)).toMatchObject({
        projectId: workspace.id, sessionId: workspaceSession.id, generation: 3,
      })
      await send(first, 'search:Альфа', 'Память: ничего не найдено.')
      await send(first, 'search:Гамма', 'Память: ничего не найдено.')
      await send(first, 'read:imports/upload-1', 'read_file:')

      for (const runtime of [first.globalMemory, first.memoryA, first.memoryB]) runtime.close()
      const restarted = compose(makeProjectRuntime())
      expect(restarted.projectRuntime.registry.getActive(OWNER)).toMatchObject({
        projectId: workspace.id, sessionId: workspaceSession.id, generation: 3,
      })
      await send(restarted, 'switch to Project A', '✅ Контекст: Project A')
      expect(restarted.projectRuntime.registry.getActive(OWNER)).toMatchObject({
        projectId: 'project-a', sessionId: 'session-a', generation: 4,
      })
      await send(restarted, 'search:Альфа', 'Проектный маяк Альфа')
      await send(restarted, 'search:Гамма', 'Память: ничего не найдено.')
      await send(restarted, 'read:imports/upload-1', payload.toString('utf8'))
      expect(seenBindings).toEqual(expect.arrayContaining([
        { projectId: 'project-a', sessionId: 'session-a' },
        { projectId: 'project-b', sessionId: 'session-b' },
        { projectId: workspace.id, sessionId: workspaceSession.id },
      ]))
      await expect(restarted.memoryA.store.listLiveFacts()).resolves.toHaveLength(1)
      await expect(restarted.memoryB.store.listLiveFacts()).resolves.toHaveLength(1)
      await expect(restarted.globalMemory.store.listLiveFacts()).resolves.toHaveLength(0)
    } finally {
      for (const runtime of openScopes.splice(0)) {
        try { runtime.close() } catch { /* already closed */ }
      }
    }
  }, 30_000)
})
