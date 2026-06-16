// HookGate adapter (runtime).
//
// Bridges the agent-loop's HookGate to the deterministic SafetyPolicy + the
// scoped-grant store + the human approval round-trip. The loop awaits pre(), so
// the entire "ask" resolution lives here: on a Tier-2/3 `ask` verdict we build a
// PendingAction, hand it to the injected approve() port (the transport issues
// the card and waits for the tap), and return allow/deny to the loop. On a
// confirmed Tier-2 with a remembered scope we record the grant, so the next
// matching call is allowed by SafetyPolicy.evaluate without another card.

import { randomUUID } from 'node:crypto'
import type { HookGate, HookCtx, ToolCall as LoopToolCall } from '../agent-loop/types.js'
import type {
  SafetyPolicy,
  Verdict,
  GrantStore,
  GrantScope,
  ToolCall as SafetyToolCall,
  ContextSpan as SafetyContextSpan,
} from '../safety/index.js'
import type { PendingAction } from '../gateway/index.js'

export type ApprovalDecision =
  | { decision: 'confirmed'; scope?: GrantScope }
  | { decision: 'rejected' }

export interface HookGateDeps {
  safety: SafetyPolicy
  grants: GrantStore
  /** Human approval round-trip — the transport issues a card and awaits the tap. */
  approve(action: PendingAction): Promise<ApprovalDecision>
}

function toSafetyCall(call: LoopToolCall, ctx: HookCtx): SafetyToolCall {
  return {
    tool: call.name,
    args: call.args,
    argsTainted: ctx.provenance === 'untrusted',
  }
}

/** Narrowing is carried on HookCtx; surface it to SafetyPolicy as a synthetic span. */
function safetyCtx(ctx: HookCtx): SafetyContextSpan[] {
  return ctx.narrowed ? [{ text: '', provenance: 'untrusted', source: 'narrowed' }] : []
}

export function makeHookGate(deps: HookGateDeps): HookGate {
  return {
    async pre(call: LoopToolCall, ctx: HookCtx) {
      const verdict: Verdict = deps.safety.evaluate(toSafetyCall(call, ctx), safetyCtx(ctx))

      if (verdict.decision === 'allow') return 'allow'
      if (verdict.decision === 'deny') return 'deny'
      if (verdict.decision === 'modify') {
        return { modify: { name: verdict.rewritten.tool, args: verdict.rewritten.args } }
      }

      // verdict.decision === 'ask' — resolve via the human approval round-trip.
      const action: PendingAction = {
        actionId: randomUUID(),
        actionHash: verdict.card.actionHash,
        tier: verdict.tier,
        requiresStepUp: verdict.tier === 3,
        summary: verdict.card.actionSummary,
      }
      const result = await deps.approve(action)
      if (result.decision !== 'confirmed') return 'deny'

      // Remember the grant only for Tier-2 (Tier-3 is never grantable, ADR-0047).
      if (result.scope && action.tier === 2) {
        deps.grants.record(call.name, result.scope)
      }
      return 'allow'
    },

    async post(_call: LoopToolCall, _result: unknown): Promise<void> {
      // PostToolUse is a no-op for the MVP spine; redaction/observability hooks
      // attach here later.
    },
  }
}
