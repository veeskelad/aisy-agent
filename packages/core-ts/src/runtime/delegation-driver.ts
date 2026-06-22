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
  const { manager, runTask, onEvent } = deps
  const observations: TaskObservation[] = []
  const attempted = new Set<string>()

  for (;;) {
    // Filter to tasks that haven't been attempted yet.
    const ready = manager.readySet().filter(t => !attempted.has(t.taskId))
    if (ready.length === 0) break

    // Termination guard: if we have ready tasks but all were already attempted,
    // we're stuck (runTask failed to close them). Break to avoid infinite loop.
    // (The filter above already handles this — if ready is empty after filter, we break.)

    const batches = greedyDisjointBatches(ready)

    for (const batch of batches) {
      for (const t of batch) attempted.add(t.taskId)
      const results = await Promise.all(
        batch.map(t => runTask(manager.spawn(t.taskId), t)),
      )
      observations.push(...results)
    }

    // Advance state + record cascade-skips.
    const sched = manager.schedule()
    if (sched.cascadeSkipped.length > 0) {
      onEvent?.({ kind: 'cascade-skip', detail: sched.cascadeSkipped })
    }
  }

  return observations
}
