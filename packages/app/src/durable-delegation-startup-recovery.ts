import { existsSync } from 'node:fs'
import type { AgentCard, ResolvedWorkBinding } from '@aisy/core'
import {
  isGenuineExecutionSupervisorRecoveryContextV1,
} from './execution-supervisor-ipc.js'
import type {
  ExecutionStartupRecoveryContextV1,
  ExecutionStartupRecoveryPortV1,
  ExecutionStartupRecoveryStepResultV1,
} from './execution-startup-recovery-coordinator.js'
import {
  inspectNodeDurableDelegationRecovery,
} from './durable-delegation-runtime.js'
import { recoverNodeDelegationRunLockAfterQuiescence } from './delegation-persistence.js'
import type {
  DurableDelegationRunRegistryV1,
} from './durable-delegation-run-registry.js'

const HASH = /^[a-f0-9]{64}$/

function denied(code: string): ExecutionStartupRecoveryStepResultV1 {
  return Object.freeze({ kind: 'denied', code })
}

/**
 * Concrete dormant delegation step for the ADR-0071 startup envelope. It reads
 * only exact records from the code-owned registry and delegates raw state
 * validation to the exact-run inspector. No child/verifier port is accepted.
 */
export function makeDurableDelegationStartupRecoveryPortV1(input: Readonly<{
  registry: DurableDelegationRunRegistryV1
  resolveCard(name: string): AgentCard | undefined
  skillTouchedPaths(skill: string): string[]
  mcpWritable(server: string): boolean
  isBindingActive(binding: ResolvedWorkBinding): boolean
}>): ExecutionStartupRecoveryPortV1 {
  return Object.freeze({
    async recover(
      context: ExecutionStartupRecoveryContextV1,
    ): Promise<ExecutionStartupRecoveryStepResultV1> {
      if (!isGenuineExecutionSupervisorRecoveryContextV1(context) ||
        context.schemaVersion !== 1 || !HASH.test(context.bindingHash) || !context.isHeld()) {
        return denied('DELEGATION_RECOVERY_AUTHORITY_INVALID')
      }
      let records: ReturnType<DurableDelegationRunRegistryV1['listExact']>
      try { records = input.registry.listExact(context.bindingHash) } catch {
        return denied('DELEGATION_RECOVERY_REGISTRY_UNAVAILABLE')
      }
      if (!context.isHeld()) return denied('DELEGATION_RECOVERY_AUTHORITY_LOST')
      if (records.length === 0) return Object.freeze({ kind: 'none' })

      let continuation = false
      for (const record of records) {
        if (!context.isHeld() || record.bindingHash !== context.bindingHash) {
          return denied('DELEGATION_RECOVERY_AUTHORITY_LOST')
        }
        let runRoot: string
        try { runRoot = input.registry.runRoot(record) } catch {
          return denied('DELEGATION_RECOVERY_REGISTRY_UNAVAILABLE')
        }
        if (!existsSync(runRoot)) {
          if (record.phase === 'registered') continue
          return denied('DELEGATION_RECOVERY_RUN_MISSING')
        }
        if (record.phase === 'active') {
          try {
            recoverNodeDelegationRunLockAfterQuiescence({ runRoot, context })
          } catch {
            return denied('DELEGATION_RECOVERY_RUN_LOCK_INVALID')
          }
        }
        let inspected: ReturnType<typeof inspectNodeDurableDelegationRecovery>
        try {
          inspected = inspectNodeDurableDelegationRecovery({
            runRoot,
            binding: record.binding,
            plan: record.plan,
            resolveCard: input.resolveCard,
            skillTouchedPaths: input.skillTouchedPaths,
            mcpWritable: input.mcpWritable,
            isBindingActive: input.isBindingActive,
          })
        } catch {
          return denied('DELEGATION_RECOVERY_RUN_INVALID')
        }
        if (!context.isHeld()) return denied('DELEGATION_RECOVERY_AUTHORITY_LOST')
        if (record.phase === 'registered') {
          if (inspected.status !== 'none') {
            return denied('DELEGATION_RECOVERY_REGISTERED_STATE_PRESENT')
          }
          continue
        }
        if (inspected.status === 'none') {
          return denied('DELEGATION_RECOVERY_ACTIVE_STATE_MISSING')
        }
        if (inspected.status === 'continuation') continuation = true
      }
      return Object.freeze({
        kind: continuation ? 'continuation' : 'terminal',
        bindingHash: context.bindingHash,
      })
    },
  })
}
