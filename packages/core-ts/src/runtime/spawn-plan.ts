// spawn-plan.ts — normalizes an unknown parsed plan into a PlanDAG with every
// node having a non-null assignedTo. Used by the app layer so that linear
// {steps} plans (and single-intent objects) can be safely passed to
// makeDelegationManager without triggering the null-card spawn error.

import type { PlanDAG, DelegationTask } from '../orchestration/index.js'

// Default scope/budget/contract/retry values for nodes where fields are absent.
const DEFAULT_SCOPE = { owns: [] as string[], doNotTouch: [] as string[], taskClass: 'reasoning' as const }
const DEFAULT_BUDGET = { iterations: 12, spendUsd: 1 }
const DEFAULT_RETRY = { maxReplans: 0, maxIterations: 12 }

function defaultNode(overrides: Partial<DelegationTask> & { taskId: string; intent: string; assignedTo: string; dependsOn: string[] }): DelegationTask {
  return {
    scope: DEFAULT_SCOPE,
    budgetSlice: DEFAULT_BUDGET,
    outputContract: '',
    retryPolicy: DEFAULT_RETRY,
    ...overrides,
  }
}

/**
 * Normalize an unknown parsed value into a PlanDAG with every node having a
 * non-null assignedTo set to `defaultCardName` when the node omits it.
 *
 * Accepted shapes:
 *  - PlanDAG   `{ nodes: [...], edges?: [...] }`
 *  - Linear    `{ steps: [{intent?}, ...] }`
 *  - Single    `{ intent: string, ... }`
 *  - Anything else → `{ nodes: [], edges: [] }`
 */
export function normalizeSpawnPlan(parsed: unknown, defaultCardName: string): PlanDAG {
  if (parsed === null || typeof parsed !== 'object') {
    return { nodes: [], edges: [] }
  }

  const p = parsed as Record<string, unknown>

  // ── PlanDAG: has an array `.nodes` ─────────────────────────────────────────
  if (Array.isArray(p['nodes'])) {
    const rawNodes = p['nodes'] as unknown[]
    const edges = Array.isArray(p['edges'])
      ? (p['edges'] as Array<{ from: string; to: string }>)
      : []

    const nodes: DelegationTask[] = rawNodes.map((raw, i) => {
      const n = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const taskId = typeof n['taskId'] === 'string' ? n['taskId'] : `t${i + 1}`
      const intent = typeof n['intent'] === 'string' ? n['intent'] : ''
      const assignedTo = typeof n['assignedTo'] === 'string' ? n['assignedTo'] : defaultCardName
      const dependsOn = Array.isArray(n['dependsOn']) ? (n['dependsOn'] as string[]) : []

      const scope = (n['scope'] !== null && typeof n['scope'] === 'object')
        ? (n['scope'] as { owns?: string[]; doNotTouch?: string[]; taskClass?: 'reasoning' | 'critique' | 'routine' })
        : {}
      const budgetSlice = (n['budgetSlice'] !== null && typeof n['budgetSlice'] === 'object')
        ? (n['budgetSlice'] as { iterations?: number; spendUsd?: number })
        : {}
      const retryPolicy = (n['retryPolicy'] !== null && typeof n['retryPolicy'] === 'object')
        ? (n['retryPolicy'] as { maxReplans?: number; maxIterations?: number })
        : {}

      return defaultNode({
        taskId,
        intent,
        assignedTo,
        dependsOn,
        scope: {
          owns: Array.isArray(scope['owns']) ? (scope['owns'] as string[]) : [],
          doNotTouch: Array.isArray(scope['doNotTouch']) ? (scope['doNotTouch'] as string[]) : [],
          taskClass: scope['taskClass'] ?? 'reasoning',
        },
        budgetSlice: {
          iterations: typeof budgetSlice['iterations'] === 'number' ? budgetSlice['iterations'] : 12,
          spendUsd: typeof budgetSlice['spendUsd'] === 'number' ? budgetSlice['spendUsd'] : 1,
        },
        outputContract: typeof n['outputContract'] === 'string' ? n['outputContract'] : '',
        retryPolicy: {
          maxReplans: typeof retryPolicy['maxReplans'] === 'number' ? retryPolicy['maxReplans'] : 0,
          maxIterations: typeof retryPolicy['maxIterations'] === 'number' ? retryPolicy['maxIterations'] : 12,
        },
      })
    })

    return { nodes, edges }
  }

  // ── Linear plan: has an array `.steps` ─────────────────────────────────────
  if (Array.isArray(p['steps'])) {
    const rawSteps = p['steps'] as unknown[]
    const nodes: DelegationTask[] = rawSteps.map((raw, i) => {
      const s = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const taskId = `s${i + 1}`
      const intent = typeof s['intent'] === 'string' ? s['intent'] : ''
      return defaultNode({
        taskId,
        intent,
        assignedTo: defaultCardName,
        dependsOn: i > 0 ? [`s${i}`] : [],
      })
    })
    const edges = nodes.slice(1).map((n, i) => ({ from: `s${i + 1}`, to: n.taskId }))
    return { nodes, edges }
  }

  // ── Single task: has a string `.intent` ────────────────────────────────────
  if (typeof p['intent'] === 'string') {
    const node = defaultNode({
      taskId: 's1',
      intent: p['intent'],
      assignedTo: defaultCardName,
      dependsOn: [],
    })
    return { nodes: [node], edges: [] }
  }

  // ── Unrecognised ───────────────────────────────────────────────────────────
  return { nodes: [], edges: [] }
}
