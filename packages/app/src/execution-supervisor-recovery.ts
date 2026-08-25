import {
  migrateExecutionSupervisorStateV1,
  withExecutionSupervisorStateChecksum,
  type ExecutionSupervisorManagerLease,
  type ExecutionSupervisorStateStore,
} from './supervisor-state.js'
import type { ExecutionSupervisorChildLivenessLease } from './execution-supervisor-liveness.js'

export type ExecutionSupervisorRestartBudgetRecoveryResult =
  | { kind: 'recovered'; revision: number }
  | {
      kind: 'refused'
      code:
        | 'SUPERVISOR_RECOVERY_MANAGER_NOT_QUIESCENT'
        | 'SUPERVISOR_RECOVERY_RUNTIME_NOT_QUIESCENT'
        | 'SUPERVISOR_RECOVERY_STATE_MISSING'
        | 'SUPERVISOR_RECOVERY_STATE_UNAVAILABLE'
        | 'SUPERVISOR_RECOVERY_COMMIT_AMBIGUOUS'
        | 'SUPERVISOR_RECOVERY_QUARANTINE_NOT_RECOVERABLE'
    }

/**
 * Acknowledges only restart-budget quarantine after both kernel-owned leases
 * prove that no manager or runtime can still mutate execution state.
 */
export async function recoverExecutionSupervisorRestartBudget(input: {
  state: ExecutionSupervisorStateStore
  signal: AbortSignal
}): Promise<ExecutionSupervisorRestartBudgetRecoveryResult> {
  let manager: ExecutionSupervisorManagerLease | null = null
  let runtime: ExecutionSupervisorChildLivenessLease | null = null
  try {
    try {
      manager = input.state.acquireManagerLease()
    } catch {
      return { kind: 'refused', code: 'SUPERVISOR_RECOVERY_MANAGER_NOT_QUIESCENT' }
    }
    if (!manager.isHeld()) {
      return { kind: 'refused', code: 'SUPERVISOR_RECOVERY_MANAGER_NOT_QUIESCENT' }
    }
    try {
      runtime = await input.state.acquireChildLivenessFence(input.signal)
    } catch {
      return { kind: 'refused', code: 'SUPERVISOR_RECOVERY_RUNTIME_NOT_QUIESCENT' }
    }
    if (!manager.isHeld() || !runtime.isHeld()) {
      return { kind: 'refused', code: 'SUPERVISOR_RECOVERY_RUNTIME_NOT_QUIESCENT' }
    }

    const loaded = input.state.load()
    if (loaded.kind === 'missing') {
      return { kind: 'refused', code: 'SUPERVISOR_RECOVERY_STATE_MISSING' }
    }
    if (loaded.kind === 'refused') {
      return { kind: 'refused', code: 'SUPERVISOR_RECOVERY_STATE_UNAVAILABLE' }
    }
    if (loaded.state.restart.quarantine?.code !== 'RESTART_BUDGET_EXHAUSTED') {
      return { kind: 'refused', code: 'SUPERVISOR_RECOVERY_QUARANTINE_NOT_RECOVERABLE' }
    }
    if (!manager.isHeld() || !runtime.isHeld()) {
      return { kind: 'refused', code: 'SUPERVISOR_RECOVERY_RUNTIME_NOT_QUIESCENT' }
    }

    const base = loaded.state.schemaVersion === 1
      ? migrateExecutionSupervisorStateV1(loaded.state)
      : loaded.state
    const recovered = withExecutionSupervisorStateChecksum({
      schemaVersion: 2,
      revision: base.revision + 1,
      manager: { ...base.manager, cleanShutdown: true },
      authority: base.authority,
      releaseReceipt: base.releaseReceipt,
      restart: {
        unexpectedExitMs: [],
        consecutiveUnexpectedExits: 0,
        quarantine: null,
      },
    })
    try {
      input.state.publish(recovered)
    } catch {
      // Atomic rename may have made the exact new revision visible before a
      // directory fsync failed. Under both still-held leases, seal that exact
      // candidate with one new revision; every other outcome stays fail-closed.
      const observed = input.state.load()
      if (observed.kind !== 'ready' || observed.state.schemaVersion !== 2 ||
        observed.state.revision !== recovered.revision ||
        observed.state.checksum !== recovered.checksum ||
        !manager.isHeld() || !runtime.isHeld()) {
        return { kind: 'refused', code: 'SUPERVISOR_RECOVERY_STATE_UNAVAILABLE' }
      }
      const sealed = withExecutionSupervisorStateChecksum({
        schemaVersion: 2,
        revision: recovered.revision + 1,
        manager: recovered.manager,
        authority: recovered.authority,
        releaseReceipt: recovered.releaseReceipt,
        restart: recovered.restart,
      })
      try {
        input.state.publish(sealed)
      } catch {
        return { kind: 'refused', code: 'SUPERVISOR_RECOVERY_COMMIT_AMBIGUOUS' }
      }
      return { kind: 'recovered', revision: sealed.revision }
    }
    return { kind: 'recovered', revision: recovered.revision }
  } finally {
    try { runtime?.release() } catch { /* the recovery result stays code-only */ }
    try { manager?.release() } catch { /* the recovery result stays code-only */ }
  }
}

export async function runExecutionSupervisorRecoveryCli(
  argv: readonly string[],
  deps: {
    recover: () => Promise<ExecutionSupervisorRestartBudgetRecoveryResult>
    stdout: (value: string) => void
    stderr: (value: string) => void
  },
): Promise<number> {
  if (argv.length !== 2 || argv[0] !== 'recover-restart-budget' ||
    argv[1] !== '--ack=RESTART_BUDGET_EXHAUSTED') {
    deps.stderr('usage: aisy supervisor recover-restart-budget ' +
      '--ack=RESTART_BUDGET_EXHAUSTED\n')
    return 64
  }
  let result: ExecutionSupervisorRestartBudgetRecoveryResult
  try {
    result = await deps.recover()
  } catch {
    deps.stderr('aisy: SUPERVISOR_RECOVERY_STATE_UNAVAILABLE\n')
    return 70
  }
  if (result.kind === 'refused') {
    deps.stderr(`aisy: ${result.code}\n`)
    return 70
  }
  deps.stdout(`Aisy supervisor recovery: restart budget acknowledged; revision=${result.revision}.\n`)
  return 0
}
