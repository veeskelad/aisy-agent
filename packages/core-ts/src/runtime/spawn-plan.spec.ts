/**
 * spawn-plan.spec.ts — Tests for normalizeSpawnPlan.
 */

import { describe, it, expect } from 'vitest'
import { normalizeSpawnPlan } from './spawn-plan.js'

const DEFAULT_CARD = 'general'

describe('normalizeSpawnPlan', () => {

  // 1. Linear plan: {steps:[{intent:'a'},{intent:'b'}]} → 2 nodes, both assignedTo defaultCardName, edge s1→s2
  it('normalizes a linear {steps} plan into a 2-node DAG with default assignedTo', () => {
    const result = normalizeSpawnPlan({ steps: [{ intent: 'a' }, { intent: 'b' }] }, DEFAULT_CARD)

    expect(result.nodes).toHaveLength(2)
    expect(result.nodes[0]!.taskId).toBe('s1')
    expect(result.nodes[0]!.intent).toBe('a')
    expect(result.nodes[0]!.assignedTo).toBe(DEFAULT_CARD)
    expect(result.nodes[0]!.dependsOn).toEqual([])

    expect(result.nodes[1]!.taskId).toBe('s2')
    expect(result.nodes[1]!.intent).toBe('b')
    expect(result.nodes[1]!.assignedTo).toBe(DEFAULT_CARD)
    expect(result.nodes[1]!.dependsOn).toEqual(['s1'])

    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toEqual({ from: 's1', to: 's2' })
  })

  // 2. Single-intent object: {intent:'x'} → 1 node assignedTo default
  it('normalizes a single-intent object into a 1-node DAG with default assignedTo', () => {
    const result = normalizeSpawnPlan({ intent: 'x' }, DEFAULT_CARD)

    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]!.taskId).toBe('s1')
    expect(result.nodes[0]!.intent).toBe('x')
    expect(result.nodes[0]!.assignedTo).toBe(DEFAULT_CARD)
    expect(result.nodes[0]!.dependsOn).toEqual([])
    expect(result.edges).toHaveLength(0)
  })

  // 3. PlanDAG with one node missing assignedTo → gets default; node WITH assignedTo keeps it
  it('fills missing assignedTo in a PlanDAG node; preserves existing assignedTo', () => {
    const result = normalizeSpawnPlan({
      nodes: [
        { taskId: 'n1', intent: 'first', assignedTo: null },
        { taskId: 'n2', intent: 'second', assignedTo: 'specialist' },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    }, DEFAULT_CARD)

    expect(result.nodes).toHaveLength(2)
    // null assignedTo → default
    expect(result.nodes[0]!.assignedTo).toBe(DEFAULT_CARD)
    // explicit assignedTo → kept
    expect(result.nodes[1]!.assignedTo).toBe('specialist')
    expect(result.edges).toHaveLength(1)
  })

  // 4. Unrecognised object: {} → {nodes:[],edges:[]}
  it('returns empty DAG for an unrecognised object', () => {
    const result = normalizeSpawnPlan({}, DEFAULT_CARD)
    expect(result).toEqual({ nodes: [], edges: [] })
  })

  // Edge cases
  it('returns empty DAG for null', () => {
    expect(normalizeSpawnPlan(null, DEFAULT_CARD)).toEqual({ nodes: [], edges: [] })
  })

  it('returns empty DAG for a primitive', () => {
    expect(normalizeSpawnPlan(42, DEFAULT_CARD)).toEqual({ nodes: [], edges: [] })
  })

  it('fills all defaults for a minimal linear step (no intent)', () => {
    const result = normalizeSpawnPlan({ steps: [{}] }, DEFAULT_CARD)
    const node = result.nodes[0]!
    expect(node.intent).toBe('')
    expect(node.assignedTo).toBe(DEFAULT_CARD)
    expect(node.scope).toEqual({ owns: [], doNotTouch: [], taskClass: 'reasoning' })
    expect(node.budgetSlice).toEqual({ iterations: 12, spendUsd: 1 })
    expect(node.retryPolicy).toEqual({ maxReplans: 0, maxIterations: 12 })
    expect(node.outputContract).toBe('')
  })
})
