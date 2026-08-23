// One confirmation for a whole search.
//
// A researcher that opens ten pages would otherwise raise ten cards, and an
// operator who taps ten cards stops reading them. So the confirmation moves up
// one level: `deep_research` is tier 2 and the operator confirms the *search*,
// once. Inside it, page approvals are answered by code.
//
// What keeps that safe is not this file alone. The researcher runs under a
// read-only card whose only tier-2 tool is `fetch_url`, so "confirm what comes"
// cannot mean anything else — there is nothing else it could be asked to
// confirm. This file adds the two bounds the card cannot express: how many
// pages, and for how long. Both are counted here, in code, where the model
// cannot reach them.

import type { ApprovalDecision, PendingAction } from '@aisy/core'

export interface ResearchLimits {
  /** Pages the search may open in total. */
  maxPages: number
  /** How long the whole search may run, in milliseconds. */
  maxMs: number
}

export const DEFAULT_RESEARCH_LIMITS: ResearchLimits = Object.freeze({
  maxPages: 12,
  maxMs: 5 * 60_000,
})

export type ResearchStop = 'pages' | 'deadline' | 'step-up'

export interface ResearchApproval {
  /** The approve port handed to the researcher's runner. */
  approve: (action: PendingAction) => Promise<ApprovalDecision>
  /** Pages confirmed so far. */
  spent: () => number
  /** Why the search stopped being allowed to read, or null while it may. */
  stopped: () => ResearchStop | null
}

/**
 * Answers the researcher's approval round-trips within one operator tap.
 *
 * No decision carries a scope: a scope is what asks the safety layer to
 * *remember* the grant, and a remembered grant would outlive this search and
 * quietly cover the next one — exactly what the operator did not confirm.
 */
export function makeResearchApproval(
  limits: ResearchLimits,
  now: () => number,
  /** Fired after each confirmed page — the heartbeat the operator watches. */
  onPage?: (spent: number) => void,
): ResearchApproval {
  const maxPages = Number.isInteger(limits.maxPages) && limits.maxPages > 0 ? limits.maxPages : 0
  const maxMs = Number.isInteger(limits.maxMs) && limits.maxMs > 0 ? limits.maxMs : 0
  const deadline = now() + maxMs
  let spent = 0
  let stop: ResearchStop | null = null

  return {
    spent: () => spent,
    stopped: () => {
      if (stop === null && now() >= deadline) stop = 'deadline'
      return stop
    },
    approve: async (action: PendingAction): Promise<ApprovalDecision> => {
      // A step-up card is a human's decision by definition (money, tier 3,
      // permanent memory). One tap on "research this" is not that consent, and
      // the read-only card should never produce such an action in the first
      // place — if one appears, something changed, and it stops here.
      if (action.requiresStepUp || action.tier > 2) {
        stop = 'step-up'
        return { decision: 'rejected' }
      }
      if (spent >= maxPages) {
        stop = 'pages'
        return { decision: 'rejected' }
      }
      if (now() >= deadline) {
        stop = 'deadline'
        return { decision: 'rejected' }
      }
      spent += 1
      // The card is a side channel: a broken heartbeat must never veto a page.
      try { onPage?.(spent) } catch { /* the search matters, the card does not */ }
      return { decision: 'confirmed' }
    },
  }
}

/** The delegation plan for one question: a single read-only researcher task. */
export function researchPlan(question: string, cardName: string): string {
  return JSON.stringify({
    nodes: [{
      taskId: 'research',
      intent: question,
      assignedTo: cardName,
      scope: { owns: [], doNotTouch: [], taskClass: 'reasoning' },
      outputContract: 'Ответ по существу и список источников со ссылками.',
    }],
    edges: [],
  })
}

/** One sentence on why a search stopped early, or null when it ran its course. */
export function stopLine(stop: ResearchStop | null, spent: number): string | null {
  if (stop === 'pages') return `Исследование остановлено на лимите: ${spent} страниц.`
  if (stop === 'deadline') return 'Исследование остановлено по времени.'
  if (stop === 'step-up') return 'Исследование остановлено: шаг потребовал твоего решения.'
  return null
}

/** What the operator and the model see when a search ends early. */
export function stopNote(stop: ResearchStop | null, spent: number): string {
  const line = stopLine(stop, spent)
  return line === null ? '' : `\n\n(${line})`
}
