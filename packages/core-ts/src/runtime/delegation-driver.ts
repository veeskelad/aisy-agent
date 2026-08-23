// delegation-driver.ts — Tier-3 sub-agent delegation driver (ADR-0039, Task C1).
//
// Drives a DelegationManager's schedule: runs independent (write-disjoint) ready
// tasks CONCURRENTLY and serializes write-overlapping ones.
//
// Overlap predicate: two tasks' `scope.owns` glob sets overlap if any glob in A
// equals any glob in B, OR if one glob is a structural prefix of the other at a
// path-segment boundary — delegating to the same `patternsMayOverlap` logic that
// the manager itself uses. Practically, `['a/**']` vs `['b/**']` do NOT overlap
// (different roots → same batch); `['shared/**']` vs `['shared/**']` DO overlap
// (identical → different batches). This mirrors the manager's own spawn-time
// disjointness assertion so the driver never attempts concurrent spawns the
// manager would reject.

import type { DelegationManager, DelegationHandle, DelegationTask, TaskObservation } from '../orchestration/index.js'

export interface DelegationDriverDeps {
  manager: DelegationManager
  runTask: (handle: DelegationHandle, task: DelegationTask) => Promise<TaskObservation>
  onEvent?: (e: { kind: string; detail: unknown }) => void
  signal?: AbortSignal
  /** Production compositions propagate adapter/persistence errors; no raw synthetic observation. */
  failClosed?: boolean
}

export type BoundedDelegationFailureCode =
  | 'POLICY_INVALID'
  | 'SPAWN_DENIED'
  | 'TASK_FAILED'

export class BoundedDelegationError extends Error {
  constructor(public readonly code: BoundedDelegationFailureCode) {
    super(code)
    this.name = 'BoundedDelegationError'
  }
}

export type BoundedDelegationEvent =
  | { readonly kind: 'task-denied'; readonly taskId: string; readonly code: 'SPAWN_DENIED' | 'TASK_FAILED' }
  | { readonly kind: 'cascade-skip'; readonly taskId: string }
  | { readonly kind: 'interrupted' }

export interface BoundedDelegationDriverDeps {
  manager: DelegationManager
  maxConcurrency: number
  signal?: AbortSignal
  runTask: (
    handle: DelegationHandle,
    task: DelegationTask,
    signal: AbortSignal,
  ) => Promise<TaskObservation>
  onEvent?: (event: BoundedDelegationEvent) => void
}

export type BoundedDelegationOutcome =
  | {
      readonly status: 'completed'
      readonly observations: readonly TaskObservation[]
    }
  | {
      readonly status: 'interrupted'
      readonly observations: readonly TaskObservation[]
      readonly pendingTaskIds: readonly string[]
    }
  | {
      readonly status: 'failed'
      readonly observations: readonly TaskObservation[]
      readonly taskId: string
      readonly code: 'SPAWN_DENIED' | 'TASK_FAILED'
    }

// ---------------------------------------------------------------------------
// Overlap predicate — mirrors orchestration/index.ts `patternsMayOverlap` so
// the driver's batching decision matches the manager's spawn-time guard.
// ---------------------------------------------------------------------------

function globRoot(glob: string): string {
  const idx = glob.search(/[*?]/)
  return idx === -1 ? glob : glob.slice(0, idx)
}

function patternsMayOverlap(a: string, b: string): boolean {
  if (a === b) return true
  const ra = globRoot(a)
  const rb = globRoot(b)
  const [shorter, longer] = ra.length <= rb.length ? [ra, rb] : [rb, ra]
  if (!longer.startsWith(shorter)) return false
  return longer.length === shorter.length || shorter.endsWith('/') || longer[shorter.length] === '/'
}

function ownsOverlap(ownsA: string[], ownsB: string[]): boolean {
  for (const a of ownsA) {
    for (const b of ownsB) {
      if (patternsMayOverlap(a, b)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Greedy disjoint batching.
//
// Tasks are partitioned into ordered batches. A task joins the CURRENT batch
// iff its scope.owns is write-disjoint from every task already in that batch.
// A task that would overlap any member of the current batch is deferred to the
// next batch. Each batch is then run with Promise.all (fully concurrent).
//
// Result: disjoint tasks share a batch (concurrent); overlapping tasks land in
// separate batches (serialized across batches).
// ---------------------------------------------------------------------------

function greedyDisjointBatches(tasks: DelegationTask[]): DelegationTask[][] {
  const batches: DelegationTask[][] = []

  for (const task of tasks) {
    let placed = false
    for (const batch of batches) {
      const fits = batch.every(b => !ownsOverlap(task.scope.owns, b.scope.owns))
      if (fits) {
        batch.push(task)
        placed = true
        break
      }
    }
    if (!placed) {
      batches.push([task])
    }
  }

  return batches
}

// ---------------------------------------------------------------------------
// runDelegation — main driver loop.
// ---------------------------------------------------------------------------

export async function runDelegation(deps: DelegationDriverDeps): Promise<TaskObservation[]> {
  const { manager, runTask, onEvent, signal, failClosed = false } = deps
  const observations: TaskObservation[] = []
  const attempted = new Set<string>()
  const aborted = (): boolean => signal?.aborted ?? false

  for (;;) {
    if (aborted()) break
    // Filter to tasks that haven't been attempted yet.
    const ready = manager.readySet().filter(t => !attempted.has(t.taskId))
    if (ready.length === 0) break

    // Termination guard: if we have ready tasks but all were already attempted,
    // we're stuck (runTask failed to close them). Break to avoid infinite loop.
    // (The filter above already handles this — if ready is empty after filter, we break.)

    const batches = greedyDisjointBatches(ready)

    for (const batch of batches) {
      if (aborted()) break
      for (const t of batch) attempted.add(t.taskId)
      const settled = await Promise.allSettled(
        batch.map(async (t) => {
          let handle
          try {
            handle = manager.spawn(t.taskId)
          } catch (err) {
            if (failClosed) throw err
            const msg = err instanceof Error ? err.message : String(err)
            onEvent?.({ kind: 'task-error', detail: { taskId: t.taskId, error: msg } })
            // spawn() threw (e.g. null assignedTo, unknown card) — synthesise a failed
            // observation so the manager can cascade-skip downstream tasks.
            return {
              delegationId: t.taskId,
              status: 'failed' as const,
              summary: msg,
              touched: [],
              result: null,
              cost: { iterations: 0, spendUsd: 0, wallMs: 0 },
            }
          }
          try {
            return await runTask(handle, t)
          } catch (err) {
            if (failClosed) throw err
            const msg = err instanceof Error ? err.message : String(err)
            onEvent?.({ kind: 'task-error', detail: { taskId: t.taskId, error: msg } })
            // Convert an uncaught runTask error into a proper delegation failure so
            // the manager cascade-skips downstream; the driver never leaves a task open.
            return handle.fail(msg, { iterations: 0, spendUsd: 0, wallMs: 0 })
          }
        }),
      )
      for (const r of settled) {
        if (r.status === 'rejected') throw r.reason
        observations.push(r.value)
      }
    }

    // Advance state + record cascade-skips.
    const sched = manager.schedule()
    if (sched.cascadeSkipped.length > 0) {
      onEvent?.({ kind: 'cascade-skip', detail: sched.cascadeSkipped })
    }
  }

  return observations
}

function frozenObservations(values: TaskObservation[]): readonly TaskObservation[] {
  return Object.freeze(values.map(value => Object.freeze(structuredClone(value))))
}

function safeBoundedEvent(
  sink: ((event: BoundedDelegationEvent) => void) | undefined,
  event: BoundedDelegationEvent,
): void {
  try { sink?.(event) } catch { /* observability is non-load-bearing */ }
}

/**
 * Additive production-preview scheduler. It preserves the legacy driver's DAG
 * semantics while adding an explicit concurrency ceiling and code-only errors.
 */
export async function runBoundedDelegation(
  deps: BoundedDelegationDriverDeps,
): Promise<BoundedDelegationOutcome> {
  if (!Number.isInteger(deps.maxConcurrency) || deps.maxConcurrency < 1 ||
    deps.maxConcurrency > 64) {
    throw new BoundedDelegationError('POLICY_INVALID')
  }
  const fallbackSignal = new AbortController().signal
  const signal = deps.signal ?? fallbackSignal
  const observations: TaskObservation[] = []
  const attempted = new Set<string>()
  const pendingTaskIds = (): readonly string[] => Object.freeze(
    deps.manager.dag().nodes
      .map(task => task.taskId)
      .filter(taskId => !observations.some(item => item.delegationId === `d-${taskId}`)),
  )
  const interrupted = (): BoundedDelegationOutcome => {
    safeBoundedEvent(deps.onEvent, { kind: 'interrupted' })
    return Object.freeze({
      status: 'interrupted' as const,
      observations: frozenObservations(observations),
      pendingTaskIds: pendingTaskIds(),
    })
  }

  // A repeated call on the same manager must replay manager-owned terminal
  // state instead of reporting an empty successful run. This is also the
  // hand-off point after an explicit manager.recover() on process restart.
  let replayedFailure: { taskId: string; code: 'TASK_FAILED' } | undefined
  for (const task of deps.manager.dag().nodes) {
    const terminal = deps.manager.terminalObservation(`d-${task.taskId}`)
    if (terminal === undefined) continue
    observations.push(terminal)
    attempted.add(task.taskId)
    if (terminal.status === 'failed') {
      replayedFailure ??= { taskId: task.taskId, code: 'TASK_FAILED' }
    }
  }
  if (replayedFailure !== undefined) {
    return Object.freeze({
      status: 'failed' as const,
      observations: frozenObservations(observations),
      taskId: replayedFailure.taskId,
      code: replayedFailure.code,
    })
  }

  for (;;) {
    if (signal.aborted) return interrupted()
    const ready = deps.manager.readySet().filter(task => !attempted.has(task.taskId))
    if (ready.length === 0) break
    const batches = greedyDisjointBatches(ready)

    for (const batch of batches) {
      for (let offset = 0; offset < batch.length; offset += deps.maxConcurrency) {
        if (signal.aborted) return interrupted()
        const chunk = batch.slice(offset, offset + deps.maxConcurrency)
        for (const task of chunk) attempted.add(task.taskId)
        const settled = await Promise.allSettled(chunk.map(async task => {
          let handle: DelegationHandle
          try {
            handle = deps.manager.spawn(task.taskId)
          } catch {
            return { kind: 'denied' as const, taskId: task.taskId, code: 'SPAWN_DENIED' as const }
          }
          const failTask = () => {
            const existing = deps.manager.terminalObservation(handle.delegationId)
            if (existing !== undefined) {
              return existing.status === 'failed'
                ? { kind: 'task-failure' as const, taskId: task.taskId, value: existing }
                : { kind: 'observation' as const, value: existing }
            }
            try {
              const failed = handle.fail('TASK_FAILED', { iterations: 0, spendUsd: 0, wallMs: 0 })
              const terminal = deps.manager.terminalObservation(handle.delegationId)
              if (terminal === undefined || JSON.stringify(terminal) !== JSON.stringify(failed)) {
                return { kind: 'interrupted' as const, taskId: task.taskId }
              }
              return { kind: 'task-failure' as const, taskId: task.taskId, value: terminal }
            } catch {
              // Persistence may have failed after external execution. Preserve
              // the active handle for explicit recovery; never claim terminal.
              return { kind: 'interrupted' as const, taskId: task.taskId }
            }
          }
          try {
            const returned = await deps.runTask(handle, task, signal)
            const terminal = deps.manager.terminalObservation(handle.delegationId)
            if (terminal === undefined) {
              if (signal.aborted) return { kind: 'interrupted' as const, taskId: task.taskId }
              return failTask()
            }
            // Only the manager-owned durable value is ever returned. A forged
            // adapter copy cannot override an already committed terminal.
            void returned
            return terminal.status === 'failed'
              ? { kind: 'task-failure' as const, taskId: task.taskId, value: terminal }
              : { kind: 'observation' as const, value: terminal }
          } catch {
            if (signal.aborted && deps.manager.terminalObservation(handle.delegationId) === undefined) {
              return { kind: 'interrupted' as const, taskId: task.taskId }
            }
            return failTask()
          }
        }))

        let denied: { taskId: string; code: 'SPAWN_DENIED' | 'TASK_FAILED' } | undefined
        let persistenceUncertain = false
        for (const result of settled) {
          // The task wrapper never rejects, but keep a code-only fail-closed guard
          // against an unexpected Promise implementation.
          if (result.status === 'rejected') {
            denied ??= { taskId: 'unknown', code: 'TASK_FAILED' }
            continue
          }
          if (result.value.kind === 'denied') {
            safeBoundedEvent(deps.onEvent, {
              kind: 'task-denied',
              taskId: result.value.taskId,
              code: result.value.code,
            })
            denied ??= { taskId: result.value.taskId, code: result.value.code }
            continue
          }
          if (result.value.kind === 'interrupted') {
            persistenceUncertain = true
            continue
          }
          if (result.value.kind === 'task-failure') {
            observations.push(result.value.value)
            safeBoundedEvent(deps.onEvent, {
              kind: 'task-denied', taskId: result.value.taskId, code: 'TASK_FAILED',
            })
            denied ??= { taskId: result.value.taskId, code: 'TASK_FAILED' }
            continue
          }
          observations.push(result.value.value)
        }
        if (persistenceUncertain) return interrupted()
        if (denied !== undefined) {
          if (signal.aborted) return interrupted()
          const scheduled = deps.manager.schedule()
          for (const taskId of scheduled.cascadeSkipped) {
            safeBoundedEvent(deps.onEvent, { kind: 'cascade-skip', taskId })
          }
          return Object.freeze({
            status: 'failed' as const,
            observations: frozenObservations(observations),
            taskId: denied.taskId,
            code: denied.code,
          })
        }
        if (signal.aborted) return interrupted()
      }
    }

    const scheduled = deps.manager.schedule()
    for (const taskId of scheduled.cascadeSkipped) {
      safeBoundedEvent(deps.onEvent, { kind: 'cascade-skip', taskId })
    }
  }

  // A manager may still own an active handle from an interrupted earlier call.
  // Such a task is absent from readySet(), but it is not terminal; never turn
  // that state into a false successful completion.
  if (pendingTaskIds().length > 0) return interrupted()
  return Object.freeze({
    status: 'completed' as const,
    observations: frozenObservations(observations),
  })
}
