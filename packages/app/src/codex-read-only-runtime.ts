import {
  makeCodexAppServerReadOnlyDriver,
  makeReadOnlyBrainProviderAdapter,
  makeCodexSubscriptionAuth,
  makeNodeCodexAppServerSessionFactory,
  makeNodeCodexAuthProcessPort,
  makeSqliteCodexThreadStore,
  type BrainDriver,
  type ProviderAdapter,
  type CodexAppServerSpawnPort,
  type CodexAuthProcessPort,
} from '@aisy/core'

export interface NodeCodexReadOnlyRuntime {
  driver: BrainDriver
  /** Owned-loop provider seam with structured progress; native capabilities
   *  remain denied until the typed bridge is explicitly composed. */
  provider(projectId: string): ProviderAdapter
  close(): void
}

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

/**
 * Production Node composition for the disabled-by-default Codex read-only
 * runtime. The live CLI does not call this factory until activation is approved.
 */
export function makeNodeCodexReadOnlyRuntime(input: {
  codexExecutable: string
  hostCwd: string
  threadDbPath: string
  model: string
  projectRoot(projectId: string): string | null
  environment?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  authProcessPort?: CodexAuthProcessPort
  spawnPort?: CodexAppServerSpawnPort
}): NodeCodexReadOnlyRuntime {
  if (!SAFE_MODEL.test(input.model)) throw new Error('INVALID_CODEX_RUNTIME_CONFIG')

  const sessions = makeNodeCodexAppServerSessionFactory({
    codexExecutable: input.codexExecutable,
    hostCwd: input.hostCwd,
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.requestTimeoutMs ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
    ...(input.spawnPort ? { spawnPort: input.spawnPort } : {}),
  })
  const authProcessPort = input.authProcessPort ?? makeNodeCodexAuthProcessPort({
    codexExecutable: input.codexExecutable,
    ...(input.environment ? { environment: input.environment } : {}),
  })
  const threads = makeSqliteCodexThreadStore({ dbPath: input.threadDbPath })
  let closed = false
  try {
    const driver = makeCodexAppServerReadOnlyDriver({
      auth: makeCodexSubscriptionAuth(authProcessPort),
      sessions,
      threads,
      model: input.model,
      projectRoot: input.projectRoot,
    })
    return Object.freeze({
      driver,
      provider: (projectId: string) => makeReadOnlyBrainProviderAdapter({ driver, projectId }),
      close() {
        if (closed) return
        closed = true
        threads.close()
      },
    })
  } catch (error) {
    threads.close()
    throw error
  }
}
