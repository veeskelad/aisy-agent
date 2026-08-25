import {
  ContextLeaseError,
  makeLeaseBoundToolExecutor,
  makeMemoryRememberReceipt,
  parseRememberFactArgs,
  renderMemoryAcknowledgement,
  WorkBindingError,
  workBindingFromLease,
  type AgentRunner,
  type ApprovalDecision,
  type AttachmentDestination,
  type ConfinementPort,
  type ContextLeaseCoordinator,
  type LayeredContextAssembler,
  type PendingAction,
  type ProjectFileManifestV1,
  type ProjectRegistryV2Owner,
  type ProjectService,
  type ScopedMemoryRouter,
  type ToolCall,
  type ToolExecutionContext,
  type ToolResult,
  type TurnContextLease,
  type ResolvedWorkBinding,
  type WorkBindingScope,
} from '@aisy/core'
import type {
  SessionApprovalFactory,
  TelegramTurnRuntime,
} from './bot.js'

export interface InteractiveTurnRuntimeFactory {
  acquire(approvalForSession: SessionApprovalFactory): Promise<TelegramTurnRuntime>
  captureBinding(scope?: WorkBindingScope | 'context'): Promise<ResolvedWorkBinding>
}

export interface BackgroundTurnRuntimeFactory {
  acquire(
    binding: ResolvedWorkBinding,
    approvalForSession: SessionApprovalFactory,
    options?: { goal?: boolean },
  ): Promise<TelegramTurnRuntime>
}

export interface InteractiveTurnRuntimeDeps {
  owner: ProjectRegistryV2Owner
  service: ProjectService
  leases: ContextLeaseCoordinator
  confinement: ConfinementPort
  scopedMemory: ScopedMemoryRouter
  buildRunner(input: {
    lease: TurnContextLease
    /** Exact context for GrantStore lookup/recording in this runner. */
    grantBinding: ResolvedWorkBinding
    approve: (action: PendingAction) => Promise<ApprovalDecision>
    executeTool: (call: ToolCall, context?: ToolExecutionContext) => Promise<ToolResult>
  }): AgentRunner
  /** Preview-safe ADR-0063 layers 2/3; omission preserves the current runtime. */
  layeredContext?: LayeredContextAssembler
  executeNonContextTool(lease: TurnContextLease, call: ToolCall): Promise<ToolResult>
  runBash?: (
    lease: TurnContextLease,
    command: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  spawnSubagent?: (lease: TurnContextLease, planJson: string) => Promise<unknown>
  importAttachment?: (
    lease: TurnContextLease,
    fileId: string,
    destination: AttachmentDestination,
  ) => Promise<ProjectFileManifestV1>
}

function arg(call: ToolCall, key: string): string {
  const value = call.args[key]
  return typeof value === 'string' ? value : ''
}

function recallText(hits: Awaited<ReturnType<ScopedMemoryRouter['searchAutomatic']>>['hits']): string {
  return hits.map((hit) => `• ${hit.text}`).join('\n')
}

function searchText(hits: Awaited<ReturnType<ScopedMemoryRouter['searchAutomatic']>>['hits']): string {
  if (hits.length === 0) return 'Память: ничего не найдено.'
  return hits.map((hit) => {
    const scope = hit.scope === 'project' ? 'project' : 'global'
    return `• [${scope}:${hit.factKey}] ${hit.text}`
  }).join('\n')
}

async function makeLeaseTurnRuntime(input: {
  deps: InteractiveTurnRuntimeDeps
  lease: TurnContextLease
  approvalForSession: SessionApprovalFactory
  validate?: () => void
  grantBinding: ResolvedWorkBinding
  goal?: boolean
}): Promise<TelegramTurnRuntime> {
  const { deps, lease, approvalForSession, validate } = input
  const turnOperation = deps.leases.reserveOperation(lease)
  try {
    turnOperation.beginIo()
  } catch (error) {
    turnOperation.complete()
    await deps.service.releaseTurnContext(lease)
    throw error
  }
  let released = false
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    turnOperation.complete()
    await deps.service.releaseTurnContext(lease)
  }
  try {
    let claimedDone = false
    const committedRememberReceipts = new Map<string, ToolResult>()
    const rawApprove = approvalForSession(lease.sessionId)
    const approve = async (action: PendingAction): Promise<ApprovalDecision> => {
      const decision = await rawApprove(action)
      if (decision.decision !== 'confirmed') return decision
      try {
        validate?.()
        const validation = deps.leases.reserveOperation(lease)
        validation.complete()
        return decision
      } catch (error) {
        if (error instanceof ContextLeaseError) return { decision: 'rejected' }
        throw error
      }
    }

    const scopedFallback = async (
      call: ToolCall,
      context?: ToolExecutionContext,
    ): Promise<ToolResult> => {
      if (input.goal === true && call.name === 'goal_done') {
        claimedDone = true
        return { ok: true, output: 'acknowledged' }
      }
      if (call.name === 'search_memory') {
        try {
          const result = await deps.scopedMemory.searchAutomatic(lease, arg(call, 'query'), {
            limit: 8,
          })
          return { ok: true, output: searchText(result.hits) }
        } catch (error) {
          if (error instanceof ContextLeaseError) throw error
          return { ok: false, output: 'search_memory: unavailable' }
        }
      }
      if (call.name === 'remember') {
        const remembered = parseRememberFactArgs(call.args)
        if (remembered === null) {
          return { ok: false, output: 'remember: exactly one valid fact or text required' }
        }
        const receipt = makeMemoryRememberReceipt(remembered, context)
        if (receipt === null) return { ok: false, output: 'remember: execution identity required' }
        const replay = committedRememberReceipts.get(receipt.receiptId)
        if (replay !== undefined) return replay
        try {
          const commit = lease.projectKind === 'project'
            ? deps.scopedMemory.commitProject(
                lease,
                { op: 'ADD', text: remembered.fact },
                { withinSession: true },
              )
            : deps.scopedMemory.commitGlobal(
                lease,
                { op: 'ADD', text: remembered.fact },
                { withinSession: true },
              )
          const result = await commit
          if (result.status === 'COMMITTED') {
            const committed = Object.freeze<ToolResult>({
              ok: true,
              output: renderMemoryAcknowledgement(remembered.fact),
              verified: true,
              mutationReceipt: receipt,
            })
            committedRememberReceipts.set(receipt.receiptId, committed)
            return committed
          }
          if (result.status === 'BLOCKED') {
            return { ok: false, output: 'Эта информация ранее удалена из памяти.' }
          }
          if (result.status === 'ROUTED_TO_REVIEW') {
            return { ok: true, output: 'Похоже на ранее удалённое — отправил на проверку.' }
          }
          return { ok: false, output: 'remember: unexpected status' }
        } catch (error) {
          if (error instanceof ContextLeaseError) throw error
          return { ok: false, output: 'remember: unavailable' }
        }
      }
      if (call.name === 'spawn_subagent') {
        if (!deps.spawnSubagent) {
          return { ok: false, output: 'spawn_subagent: lease-bound delegation unavailable' }
        }
        const plan = arg(call, 'plan')
        if (plan.length === 0) {
          return { ok: false, output: 'spawn_subagent: plan must be a JSON string' }
        }
        try {
          return { ok: true, output: JSON.stringify(await deps.spawnSubagent(lease, plan)) }
        } catch (error) {
          if (error instanceof ContextLeaseError) throw error
          return { ok: false, output: 'spawn_subagent: failed' }
        }
      }
      if (call.name === 'import_attachment') {
        if (!deps.importAttachment) {
          return { ok: false, output: 'import_attachment: lease-bound implementation unavailable' }
        }
        const fileId = arg(call, 'fileId')
        const destination = arg(call, 'destination')
        if (fileId.length === 0 ||
          (destination !== 'project-file' && destination !== 'knowledge')) {
          return {
            ok: false,
            output: 'import_attachment: fileId and destination(project-file|knowledge) required',
          }
        }
        try {
          const validation = deps.leases.reserveOperation(lease)
          validation.complete()
          const manifest = await deps.importAttachment(lease, fileId, destination)
          return {
            ok: true,
            output: JSON.stringify({
              relativePath: manifest.relativePath,
              sha256: manifest.sha256,
              sizeBytes: manifest.sizeBytes,
              provenance: manifest.provenance,
              published: manifest.published,
            }),
          }
        } catch (error) {
          if (error instanceof ContextLeaseError) throw error
          return { ok: false, output: 'import_attachment: failed' }
        }
      }
      if (call.name === 'project.switch') {
        return { ok: false, output: `${call.name}: lease-bound implementation unavailable` }
      }
      return deps.executeNonContextTool(lease, call)
    }
    const leaseExecutor = makeLeaseBoundToolExecutor({
      lease,
      confinement: deps.confinement,
      fallback: scopedFallback,
      ...(deps.runBash === undefined ? {} : { runBash: deps.runBash }),
    })
    const executeTool = async (
      call: ToolCall,
      context?: ToolExecutionContext,
    ): Promise<ToolResult> => {
      validate?.()
      if (call.name === 'remember') {
        try {
          return await scopedFallback(call, context)
        } catch (error) {
          if (error instanceof ContextLeaseError) {
            return { ok: false, output: `remember: ${error.code}` }
          }
          return { ok: false, output: 'remember: unavailable' }
        }
      }
      return leaseExecutor(call)
    }
    const baseRunner = deps.buildRunner({
      lease,
      grantBinding: input.grantBinding,
      approve,
      executeTool,
    })
    const runner = deps.layeredContext === undefined
      ? baseRunner
      : Object.freeze<AgentRunner>({
          handle: async turn => {
            const extra = await deps.layeredContext!.augmentTurn(lease, turn)
            return baseRunner.handle({ ...turn, spans: [...turn.spans, ...extra] })
          },
        })
    return {
      sessionId: lease.sessionId,
      runner,
      takeClaimedDone: () => {
        const result = claimedDone
        claimedDone = false
        return result
      },
      recall: async (query) => {
        try {
          validate?.()
          return recallText((await deps.scopedMemory.searchAutomatic(lease, query, {
            limit: 5,
          })).hits)
        } catch (error) {
          if (error instanceof ContextLeaseError) throw error
          return ''
        }
      },
      release,
    }
  } catch (error) {
    await release()
    throw error
  }
}

/**
 * Creates one immutable interactive runtime from the persisted active context.
 * Context-sensitive tools never fall through to the legacy executor.
 */
export function makeInteractiveTurnRuntimeFactory(
  deps: InteractiveTurnRuntimeDeps,
): InteractiveTurnRuntimeFactory {
  return Object.freeze<InteractiveTurnRuntimeFactory>({
    async acquire(approvalForSession) {
      const lease = deps.service.acquireTurnContext(deps.owner)
      return makeLeaseTurnRuntime({
        deps,
        lease,
        grantBinding: workBindingFromLease(lease, lease.projectKind),
        approvalForSession,
      })
    },

    async captureBinding(scope = 'context') {
      const lease = deps.service.acquireTurnContext(deps.owner)
      try {
        const resolvedScope = scope === 'context' ? lease.projectKind : scope
        return deps.service.captureWorkBinding(lease, resolvedScope)
      } finally {
        await deps.service.releaseTurnContext(lease)
      }
    },
  })
}

/** Resolves a durable binding without consulting the interactive selection. */
export function makeBackgroundTurnRuntimeFactory(
  deps: InteractiveTurnRuntimeDeps,
): BackgroundTurnRuntimeFactory {
  return Object.freeze<BackgroundTurnRuntimeFactory>({
    async acquire(binding, approvalForSession, options) {
      const lease = deps.service.acquireBoundContext(binding)
      const validate = (): void => {
        try {
          deps.service.assertBoundContext(lease, binding)
        } catch (error) {
          if (error instanceof WorkBindingError) throw new ContextLeaseError('STALE_CONTEXT')
          throw error
        }
      }
      return makeLeaseTurnRuntime({
        deps,
        lease,
        grantBinding: binding,
        approvalForSession,
        validate,
        ...(options?.goal === undefined ? {} : { goal: options.goal }),
      })
    },
  })
}
