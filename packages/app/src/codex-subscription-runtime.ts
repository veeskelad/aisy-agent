import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'

import {
  actionEvidence,
  attachProviderActionEvidence,
  attachProviderToolExecutions,
  makeAisyCapabilityBrainProviderAdapter,
  makeCodexAppServerCapabilityDriver,
  makeCodexSubscriptionAuth,
  makeNodeCodexAppServerSessionFactory,
  makeNodeCodexAuthProcessPort,
  makeSqliteCodexThreadStore,
  type ActionEvidence,
  type CodexAppServerSpawnPort,
  type CodexAuthProcessPort,
  type ModelToolRuntimeContext,
  type ProviderAdapter,
  type ProviderToolExecution,
} from '@aisy/core'

import {
  startAisyMcpBridge,
  type McpBridgeResult,
  type McpBridgeToolDefinition,
} from './mcp-bridge-server.js'

const MANAGED_CONFIG = '# Aisy-owned Codex home. Runtime settings are supplied per thread.\n'
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function snapshotTools(value: readonly McpBridgeToolDefinition[]): readonly McpBridgeToolDefinition[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('INVALID_CODEX_TOOL_CATALOG')
  const tools: McpBridgeToolDefinition[] = []
  for (const tool of value) {
    if (!record(tool) || typeof tool.name !== 'string' || !SAFE_ID.test(tool.name) ||
      typeof tool.description !== 'string' || tool.description.length > 4096 ||
      !record(tool.input_schema)) {
      throw new Error('INVALID_CODEX_TOOL_CATALOG')
    }
    let encoded: string
    let schema: Record<string, unknown>
    try {
      encoded = JSON.stringify(tool.input_schema)
      schema = structuredClone(tool.input_schema)
    } catch {
      throw new Error('INVALID_CODEX_TOOL_CATALOG')
    }
    if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) {
      throw new Error('INVALID_CODEX_TOOL_CATALOG')
    }
    tools.push(Object.freeze({
      name: tool.name,
      description: tool.description,
      input_schema: Object.freeze(schema),
    }))
  }
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) {
    throw new Error('INVALID_CODEX_TOOL_CATALOG')
  }
  return Object.freeze(tools)
}

function assertPrivateCodexHome(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path) {
    throw new Error('INVALID_CODEX_HOME')
  }
  const directory = lstatSync(path)
  const owner = typeof process.getuid !== 'function' || directory.uid === process.getuid()
  if (!directory.isDirectory() || directory.isSymbolicLink() || !owner ||
    (directory.mode & 0o077) !== 0) {
    throw new Error('INSECURE_CODEX_HOME')
  }
  const configPath = join(path, 'config.toml')
  const config = lstatSync(configPath)
  const configOwner = typeof process.getuid !== 'function' || config.uid === process.getuid()
  if (!config.isFile() || config.isSymbolicLink() || !configOwner ||
    (config.mode & 0o077) !== 0 || readFileSync(configPath, 'utf8') !== MANAGED_CONFIG) {
    throw new Error('INSECURE_CODEX_HOME')
  }
}

export function prepareNodeCodexSubscriptionHome(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path) throw new Error('INVALID_CODEX_HOME')
  if (existsSync(path)) {
    const current = lstatSync(path)
    const owner = typeof process.getuid !== 'function' || current.uid === process.getuid()
    if (!current.isDirectory() || current.isSymbolicLink() || !owner) {
      throw new Error('INSECURE_CODEX_HOME')
    }
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  chmodSync(path, 0o700)
  const configPath = join(path, 'config.toml')
  if (!existsSync(configPath)) {
    writeFileSync(configPath, MANAGED_CONFIG, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  }
  assertPrivateCodexHome(path)
}

export function codexSubscriptionEnvironment(
  codexHome: string,
  source: NodeJS.ProcessEnv = process.env,
): Readonly<NodeJS.ProcessEnv> {
  prepareNodeCodexSubscriptionHome(codexHome)
  return Object.freeze({ ...source, CODEX_HOME: codexHome })
}

function assertPrivateCodexWorkspace(path: string): void {
  const directory = lstatSync(path)
  const owner = typeof process.getuid !== 'function' || directory.uid === process.getuid()
  if (realpathSync(path) !== path || !directory.isDirectory() || directory.isSymbolicLink() ||
    !owner || (directory.mode & 0o077) !== 0 || readdirSync(path).length !== 0) {
    throw new Error('INSECURE_CODEX_WORKSPACE')
  }
}

export function makeRefreshingNodeCodexAuthProcessPort(input: {
  resolveExecutable(): string | null
  codexHome: string
  environment?: NodeJS.ProcessEnv
}): CodexAuthProcessPort {
  const current = (): CodexAuthProcessPort | null => {
    const executable = input.resolveExecutable()
    if (executable === null) return null
    try {
      return makeNodeCodexAuthProcessPort({
        codexExecutable: executable,
        environment: codexSubscriptionEnvironment(
          input.codexHome,
          input.environment ?? process.env,
        ),
      })
    } catch {
      return null
    }
  }
  return Object.freeze({
    run: (command: string, args: string[]) => current()?.run(command, args) ??
      Promise.resolve({ exitCode: 127, output: '' }),
    start: (command: string, args: string[], onChunk: (chunk: string) => void) =>
      current()?.start(command, args, onChunk) ?? {
        completed: Promise.resolve({ exitCode: 127 }),
        stop: () => {},
      },
  })
}

export interface NodeCodexSubscriptionProviderInput {
  projectId: string
  model?: string
  tools: readonly McpBridgeToolDefinition[]
  invokeTool(
    call: { name: string; args: Record<string, unknown> },
    signal: AbortSignal,
    context: ModelToolRuntimeContext,
  ): Promise<McpBridgeResult>
}

export interface NodeCodexSubscriptionRuntime {
  provider(input: NodeCodexSubscriptionProviderInput): ProviderAdapter
  close(): void
}

/**
 * Live-capable Codex subscription composition. The dedicated CODEX_HOME keeps
 * user plugins/MCP/hooks out; the only action surface is a per-turn Aisy bridge.
 */
export function makeNodeCodexSubscriptionRuntime(input: {
  codexExecutable: string
  codexHome: string
  threadDbPath: string
  projectRoot(projectId: string): string | null
  environment?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  authProcessPort?: CodexAuthProcessPort
  spawnPort?: CodexAppServerSpawnPort
}): NodeCodexSubscriptionRuntime {
  const projectRoot = input.projectRoot
  const codexHome = input.codexHome
  const environment = codexSubscriptionEnvironment(
    codexHome,
    input.environment ?? process.env,
  )
  const brainCwd = join(codexHome, 'empty-workspace')
  if (!existsSync(brainCwd)) mkdirSync(brainCwd, { mode: 0o700 })
  assertPrivateCodexWorkspace(brainCwd)
  const rawSessions = makeNodeCodexAppServerSessionFactory({
    codexExecutable: input.codexExecutable,
    hostCwd: brainCwd,
    environment,
    ...(input.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: input.requestTimeoutMs }),
    ...(input.spawnPort === undefined ? {} : { spawnPort: input.spawnPort }),
  })
  const sessions = Object.freeze({
    open() {
      assertPrivateCodexHome(codexHome)
      assertPrivateCodexWorkspace(brainCwd)
      return rawSessions.open()
    },
  })
  const authProcessPort = input.authProcessPort ?? makeNodeCodexAuthProcessPort({
    codexExecutable: input.codexExecutable,
    environment,
  })
  const auth = makeCodexSubscriptionAuth(authProcessPort)
  const threads = makeSqliteCodexThreadStore({ dbPath: input.threadDbPath })
  let closed = false

  return Object.freeze({
    provider(providerInput: NodeCodexSubscriptionProviderInput) {
      if (closed || !SAFE_ID.test(providerInput.projectId) ||
        (providerInput.model !== undefined && !SAFE_ID.test(providerInput.model))) {
        throw new Error('CODEX_RUNTIME_CLOSED')
      }
      const tools = snapshotTools(providerInput.tools)
      const names = tools.map(tool => tool.name)
      const invokeTool = providerInput.invokeTool
      const evidenceByTurn = new Map<string, {
        evidence: ActionEvidence[]
        executions: ProviderToolExecution[]
      }>()
      const evidenceKey = (request: { sessionId: string; turnId?: string }): string =>
        `${request.sessionId}\0${request.turnId ?? ''}`
      const ordinalByTurn = new Map<string, number>()
      const nextOrdinal = (request: {
        sessionId: string
        turnId?: string
        toolOrdinalBase?: number
      }): number => {
        const key = evidenceKey(request)
        const next = Math.max(ordinalByTurn.get(key) ?? 0, request.toolOrdinalBase ?? 0) + 1
        if (!Number.isSafeInteger(next)) throw new Error('PROVIDER_TOOL_ORDINAL_EXHAUSTED')
        if (!ordinalByTurn.has(key) && ordinalByTurn.size >= 10_000) {
          ordinalByTurn.delete(ordinalByTurn.keys().next().value as string)
        }
        ordinalByTurn.set(key, next)
        return next
      }
      const driver = makeCodexAppServerCapabilityDriver({
        auth,
        sessions,
        threads,
        ...(providerInput.model === undefined ? {} : { model: providerInput.model }),
        projectRoot: projectId => {
          const selected = projectRoot(projectId)
          return selected !== null && isAbsolute(selected) && normalize(selected) === selected
            ? brainCwd
            : null
        },
        capabilityBridges: {
          async open(turn, signal) {
            if (signal.aborted) throw new Error('CODEX_TURN_INTERRUPTED')
            const attestations = evidenceByTurn.get(evidenceKey(turn.request))
            if (attestations === undefined) throw new Error('CODEX_TURN_EVIDENCE_UNAVAILABLE')
            const bridge = await startAisyMcpBridge({
              serverName: 'aisy',
              tools,
              requireCodexTurnBinding: true,
              invoke: async call => {
                const ordinal = nextOrdinal(turn.request)
                await turn.request.markToolAttempt?.(ordinal)
                const context = Object.freeze({
                  sessionId: turn.request.sessionId,
                  ...(turn.request.turnId === undefined ? {} : { turnId: turn.request.turnId }),
                  ordinal,
                })
                let result
                try {
                  result = await invokeTool(call, signal, context)
                } catch (error) {
                  attestations.executions.push({
                    call,
                    context,
                    result: { ok: false, output: 'TOOL_EXECUTION_FAILED' },
                  })
                  throw error
                }
                attestations.executions.push({
                  call,
                  context,
                  result: {
                    ok: !result.isError,
                    output: result.text,
                    ...(result.receipt === true ? { verified: true } : {}),
                    ...(result.mutationReceipt === undefined
                      ? {}
                      : { mutationReceipt: result.mutationReceipt }),
                  },
                })
                return result
              },
              onResult: (call, result) => {
                attestations.evidence.push(actionEvidence(
                  { name: call.name, args: call.args },
                  { ok: !result.isError, ...(result.receipt === true ? { verified: true } : {}) },
                ))
              },
            })
            return Object.freeze({
              url: bridge.url,
              token: bridge.token,
              serverName: 'aisy' as const,
              toolNames: Object.freeze([...names]),
              bindTurn: (threadId: string, turnId: string) => {
                bridge.bindCodexTurn(threadId, turnId)
              },
              close: () => bridge.close(),
            })
          },
        },
      })
      const adapter = makeAisyCapabilityBrainProviderAdapter({
        driver,
        projectId: providerInput.projectId,
      })
      return Object.freeze<ProviderAdapter>({
        async complete(request, signal, onProgress) {
          const key = evidenceKey(request)
          if (evidenceByTurn.has(key)) throw new Error('CODEX_TURN_ALREADY_ACTIVE')
          const attestations = {
            evidence: [] as ActionEvidence[],
            executions: [] as ProviderToolExecution[],
          }
          evidenceByTurn.set(key, attestations)
          try {
            const response = await adapter.complete(request, signal, onProgress)
            return attachProviderToolExecutions(
              attachProviderActionEvidence(response, attestations.evidence),
              attestations.executions,
            )
          } finally {
            evidenceByTurn.delete(key)
          }
        },
      })
    },
    close() {
      if (closed) return
      closed = true
      threads.close()
    },
  })
}
