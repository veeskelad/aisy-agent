// Sub-agent runner factory (runtime, ADR-0052).
//
// Builds a card-scoped child AgentRunner for one delegation: a FRESH empty
// GrantStore (parent grants are never inherited — tier-2/3 re-prompt), the
// card's tools gated via the scoped executor, a fresh Loop Guardian, and the
// card's maxIterations as the tool-call cap. Parent narrowing is inherited by
// forcing the sub-agent's span provenance to untrusted.

import { makeAgentRunner, type AgentRunnerDeps, type AgentRunner } from './agent-runner.js'
import { makeGrantStore } from '../safety/index.js'
import { makeScopedToolExecutor } from './scoped-tool-executor.js'
import { makeGuardian } from './guardian.js'
import type {
  ProviderAdapter,
  MemoryPort,
  SessionLog,
  ToolCall,
  ToolExecutionContext,
  TurnInput,
  TurnResult,
} from '../agent-loop/types.js'
import type { ApprovalDecision } from './hook-gate.js'
import type { PendingAction } from '../gateway/index.js'
import type { DelegationHandle } from '../orchestration/index.js'
import type { ShardEntry } from '../orchestration/index.js'
import type { ToolResult } from './execute-tool.js'
import type { SkillPromptRuntime } from './skill-prompt-runtime.js'
import {
  DelegationAuthorityError,
  validateDelegationExecutionAuthority,
  type DelegationExecutionAuthorityV1,
} from './agent-capabilities.js'

export type SubAgentRunnerHandle = Pick<
  DelegationHandle,
  'binding' | 'card' | 'owns' | 'permitsTool'
>

export interface SubAgentRunnerDeps {
  handle: SubAgentRunnerHandle
  provider: ProviderAdapter
  baseExecuteTool: (call: ToolCall, context?: ToolExecutionContext) => Promise<ToolResult>
  approve: (action: PendingAction) => Promise<ApprovalDecision>
  memory: MemoryPort
  sessionLog: SessionLog
  parentNarrowed: boolean
  doNotTouch: string[]
  budgetCheck?: AgentRunnerDeps['budgetCheck']
  propagateToolInterruption?: AgentRunnerDeps['propagateToolInterruption']
  postToolUse?: AgentRunnerDeps['postToolUse']
  skillPromptRuntime?: SkillPromptRuntime
}

export interface DelegationAuthorityJournal {
  /** Manager-only append for the one reserved authority record. */
  appendAuthoritySeal(authorityHash: string): ShardEntry
  shard(): ShardEntry[]
  /** Manager-owned verification of seq/prevHash/content hashes. */
  verifyShardChain(): boolean
}

export interface BoundSubAgentRunner extends AgentRunner {
  readonly authority: DelegationExecutionAuthorityV1
}

export interface BoundSubAgentRunnerDeps {
  authority: DelegationExecutionAuthorityV1
  authorityJournal: DelegationAuthorityJournal
  /** Liveness/revocation check from the current DelegationHandle. */
  permitsTool: (name: string) => boolean
  /** The provider can only be built from the authority's frozen schemas. */
  providerFactory: (tools: readonly import('./provider-anthropic.js').AnthropicTool[]) => ProviderAdapter
  baseExecuteTool: (call: ToolCall, context?: ToolExecutionContext) => Promise<ToolResult>
  approve: (action: PendingAction) => Promise<ApprovalDecision>
  memory: MemoryPort
  sessionLog: SessionLog
  parentNarrowed: boolean
  budgetCheck: NonNullable<AgentRunnerDeps['budgetCheck']>
  skillPromptRuntimeFactory?: (allowedSkills: ReadonlySet<string>) => SkillPromptRuntime
  postToolUse?: AgentRunnerDeps['postToolUse']
}

const AUTHORITY_SEAL_KIND = 'runtime.agent-authority.v1'

function validAuthoritySeal(value: unknown, authorityHash: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).sort().join(',') === 'authorityHash,schemaVersion' &&
    record['schemaVersion'] === 1 && record['authorityHash'] === authorityHash
}

function sealAuthority(
  journal: DelegationAuthorityJournal,
  authority: DelegationExecutionAuthorityV1,
): void {
  let entries: ShardEntry[]
  try {
    entries = journal.shard()
    if (!journal.verifyShardChain()) {
      throw new DelegationAuthorityError('AUTHORITY_CHECKPOINT_MISMATCH')
    }
  } catch {
    throw new DelegationAuthorityError('AUTHORITY_CHECKPOINT_MISMATCH')
  }
  let seals = entries.filter(entry => entry.kind === AUTHORITY_SEAL_KIND)
  if (seals.length === 0) {
    // A non-empty legacy/partially executed shard cannot be silently promoted
    // into this authority era after work has already happened.
    if (entries.length !== 0) {
      throw new DelegationAuthorityError('AUTHORITY_CHECKPOINT_MISMATCH')
    }
    try {
      journal.appendAuthoritySeal(authority.authorityHash)
      entries = journal.shard()
      if (!journal.verifyShardChain()) {
        throw new DelegationAuthorityError('AUTHORITY_CHECKPOINT_MISMATCH')
      }
    } catch {
      throw new DelegationAuthorityError('AUTHORITY_CHECKPOINT_MISMATCH')
    }
    seals = entries.filter(entry => entry.kind === AUTHORITY_SEAL_KIND)
  }
  const seal = seals[0]
  if (seals.length !== 1 || seal?.seq !== 1 || seal.prevHash !== '0'.repeat(64) ||
    seal.delegationId !== authority.identity.delegationId ||
    !validAuthoritySeal(seal.payload, authority.authorityHash)) {
    throw new DelegationAuthorityError('AUTHORITY_CHECKPOINT_MISMATCH')
  }
}

export function makeSubAgentRunner(deps: SubAgentRunnerDeps): AgentRunner {
  // Fresh, empty grant store: the sub-agent inherits NO approvals from the parent.
  const grants = makeGrantStore()

  const scoped = makeScopedToolExecutor({
    base: deps.baseExecuteTool,
    permitsTool: deps.handle.permitsTool.bind(deps.handle),
    owns: deps.handle.owns,
    doNotTouch: deps.doNotTouch,
  })

  // The sub-agent runs its own agent-loop, so it needs its own agent-loop guardian
  // (observe/note shape). The DelegationHandle.guardian is the orchestration-layer
  // guardian (check/reset) — a different, incompatible type. Build a fresh one.
  const guardian = makeGuardian()

  const runner = makeAgentRunner({
    provider: deps.provider,
    memory: deps.memory,
    grants,
    grantBinding: deps.handle.binding,
    executeTool: scoped,
    approve: deps.approve,
    guardian,
    sessionLog: deps.sessionLog,
    maxTotalToolCalls: deps.handle.card.maxIterations,
    ...(deps.budgetCheck !== undefined ? { budgetCheck: deps.budgetCheck } : {}),
    ...(deps.propagateToolInterruption === undefined
      ? {}
      : { propagateToolInterruption: deps.propagateToolInterruption }),
    ...(deps.postToolUse === undefined ? {} : { postToolUse: deps.postToolUse }),
    toolTiers: deps.handle.card.toolTiers as Readonly<Record<string, 0 | 1 | 2 | 3>>,
    ...(deps.skillPromptRuntime === undefined ? {} : {
      prefixExtension: deps.skillPromptRuntime.prefixExtension,
      augmentTurn: deps.skillPromptRuntime.augmentTurn,
    }),
  })

  return {
    handle: (input: TurnInput): Promise<TurnResult> => {
      // Inherit parent narrowing: a narrowed parent forces the sub-agent's spans
      // to untrusted provenance so the loop narrows and the motivated-call block applies.
      const inheritedSpans = deps.parentNarrowed
        ? input.spans.map((s) => ({ ...s, provenance: 'untrusted' as const }))
        : input.spans
      const spans = [
        {
          role: 'system' as const,
          // Imported/community DNA can guide the model but is never promoted
          // to operator trust: it starts the child narrowed by construction.
          provenance: deps.handle.card.provenance === 'community'
            ? 'untrusted' as const
            : 'operator' as const,
          text: deps.handle.card.instructions,
        },
        ...inheritedSpans,
      ]
      return runner.handle({ ...input, spans })
    },
  }
}

/**
 * Additive, offline production contract. It seals the exact authority before a
 * provider is even constructed and never reads mutable card/matrix state again.
 */
export function makeBoundSubAgentRunner(deps: BoundSubAgentRunnerDeps): BoundSubAgentRunner {
  const authority = validateDelegationExecutionAuthority(deps.authority)
  sealAuthority(deps.authorityJournal, authority)

  const allowedTools = new Set(authority.capabilities.tools.map(tool => tool.name))
  const allowedSkills = new Set(authority.capabilities.skills)
  let resolvedProvider: ProviderAdapter | undefined
  const provider: ProviderAdapter = {
    complete: (request, signal, onProgress) => {
      // Factory construction is deferred until after handle() validates the
      // sealed child session identity. A misrouted turn therefore cannot even
      // initialize a provider adapter.
      resolvedProvider ??= deps.providerFactory(authority.capabilities.tools)
      return resolvedProvider.complete(request, signal, onProgress)
    },
  }
  const scoped = makeScopedToolExecutor({
    base: deps.baseExecuteTool,
    permitsTool: name => allowedTools.has(name) && deps.permitsTool(name),
    owns: [...authority.scope.owns],
    doNotTouch: [...authority.scope.doNotTouch],
  })
  const skillPromptRuntime = deps.skillPromptRuntimeFactory?.(allowedSkills)
  const runner = makeAgentRunner({
    provider,
    memory: deps.memory,
    grants: makeGrantStore(),
    grantBinding: authority.identity.binding,
    executeTool: async (call, context) => {
      if (!allowedTools.has(call.name) || !deps.permitsTool(call.name)) {
        return { ok: false, output: 'capability denied' }
      }
      return scoped(call, context)
    },
    approve: deps.approve,
    guardian: makeGuardian(),
    sessionLog: deps.sessionLog,
    maxReplans: authority.limits.maxReplans,
    maxTotalToolCalls: authority.limits.maxIterations,
    budgetCheck: async usage => {
      if (!Number.isFinite(usage.dollars) || usage.dollars < 0 ||
        usage.dollars > authority.limits.spendUsd) return true
      return deps.budgetCheck(usage)
    },
    ...(deps.postToolUse === undefined ? {} : { postToolUse: deps.postToolUse }),
    toolTiers: authority.capabilities.toolTiers,
    ...(skillPromptRuntime === undefined ? {} : {
      prefixExtension: skillPromptRuntime.prefixExtension,
      augmentTurn: skillPromptRuntime.augmentTurn,
    }),
  })
  const dna = Object.freeze({
    role: 'system' as const,
    provenance: authority.dna.provenance === 'community'
      ? 'untrusted' as const
      : 'operator' as const,
    text: authority.dna.body,
  })

  return Object.freeze({
    authority,
    handle: async (input: TurnInput): Promise<TurnResult> => {
      // The child transcript/session identity is part of the sealed authority;
      // reject routing drift before memory, provider, or tool I/O.
      if (input.sessionId !== authority.identity.childSessionId) {
        throw new DelegationAuthorityError('IDENTITY_MISMATCH')
      }
      const inheritedSpans = deps.parentNarrowed
        ? input.spans.map(span => ({ ...span, provenance: 'untrusted' as const }))
        : input.spans
      return runner.handle({ ...input, spans: [dna, ...inheritedSpans] })
    },
  })
}
