import { createHash } from 'node:crypto'
import type {
  AgentLoop,
  AgentLoopDeps,
  FrozenSnapshot,
  ModelResponse,
  Plan,
  PlanStep,
  ProviderError,
  ToolCall,
  TurnInput,
  TurnResult,
  VerificationTrace,
} from './types.js'

export type {
  AgentLoop,
  AgentLoopDeps,
  ContextSpan,
  FrozenSnapshot,
  HookCtx,
  HookGate,
  LogEntry,
  LoopGuardian,
  MemoryPort,
  ModelRequest,
  ModelResponse,
  Plan,
  PlanStep,
  ProviderAdapter,
  ProviderError,
  Provenance,
  SessionLog,
  ToolCall,
  TurnInput,
  TurnResult,
  TurnState,
  VerificationTrace,
  VerificationTraceExit,
  VerificationTraceFile,
  VerificationTraceHTTP,
  VerificationTraceSQL,
  Clock,
} from './types.js'

// ---------------------------------------------------------------------------
// Internal control flow
// ---------------------------------------------------------------------------

type HaltReason = NonNullable<TurnResult['haltReason']>

/** Internal control-flow signal: unwinds to runTurn's boundary, never escapes it. */
class Halt extends Error {
  constructor(public readonly reason: HaltReason) {
    super(`halt: ${reason}`)
    this.name = 'Halt'
  }
}

// ---------------------------------------------------------------------------
// Plan linter — deterministic rules R1–R5 (spec 01 §4.4, ADR-0026)
// ---------------------------------------------------------------------------

const TRACE_KINDS = new Set(['file', 'sql', 'http', 'exit'])
/** R3: exit probes that assert nothing about the world. */
const VACUOUS_ARGV0 = new Set(['echo', 'true', ':', 'printf'])
/** R4: traces that read back the plan's own assertion. */
const SELF_REFERENTIAL_FILES = ['PLAN.md', 'TODO.md']
/** R2: tool-name hints for irreversible (Tier ≥ 2) operations. */
const IRREVERSIBLE_TOOL_HINTS = ['rm', 'drop', 'force_push', 'send_money']

type LintRule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5'
type LintResult = { ok: true } | { ok: false; rule: LintRule }

function lintPlan(plan: Plan): LintResult {
  for (const step of plan.steps) {
    const trace = step.trace as VerificationTrace | undefined
    // R1 — missing trace
    if (!trace) return { ok: false, rule: 'R1' }
    // R5 — out-of-enum kind
    if (!TRACE_KINDS.has((trace as { kind: string }).kind)) return { ok: false, rule: 'R5' }
    // R3 — vacuous trace
    if (trace.kind === 'exit' && VACUOUS_ARGV0.has(trace.argv[0] ?? '')) {
      return { ok: false, rule: 'R3' }
    }
    if (
      trace.kind === 'http' &&
      // loopback / unspecified hosts: IPv4 (127.0.0.1, 0.0.0.0), localhost, IPv6 (::1, [::1]).
      /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|(?:^|[:/@])::1(?:$|[:/])/.test(trace.url) &&
      ['GET', 'HEAD'].includes(trace.method.toUpperCase())
    ) {
      return { ok: false, rule: 'R3' }
    }
    // R4 — self-referential trace
    if (
      trace.kind === 'file' &&
      SELF_REFERENTIAL_FILES.some(f => trace.path === f || trace.path.endsWith(`/${f}`))
    ) {
      return { ok: false, rule: 'R4' }
    }
    // R2 — unflagged irreversible
    if (
      !step.irreversible &&
      step.tools.some(t => IRREVERSIBLE_TOOL_HINTS.some(h => t.toLowerCase().includes(h)))
    ) {
      return { ok: false, rule: 'R2' }
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic sha256 over the JSON of the payload (spec §4.2). djb2 was 32-bit
 * and collision-prone, which is unsafe for a payload-identity hash in a
 * tamper-evident log; sha256 removes the practical collision risk.
 */
function payloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload) ?? '', 'utf8').digest('hex')
}

/** Within-session forget protocol trigger — operator-typed, deterministic. */
const FORGET_RE = /^forget[:\s]+(.+)$/i

function coldStartSnapshot(takenAt: string): FrozenSnapshot {
  return { prefixBytes: new Uint8Array(0), prefixHash: 'cold-start', breakpoints: [], takenAt }
}

interface SessionState {
  snapshot: FrozenSnapshot | null
  coldStart: boolean
  loaded: boolean
  narrowed: boolean
  totalReplans: number
  totalToolCalls: number
  /** §5.1 step 2: refs the operator forgot this session; code blocks them from tool args. */
  quarantinedRefs: Set<string>
}

// ---------------------------------------------------------------------------
// makeAgentLoop
// ---------------------------------------------------------------------------

export function makeAgentLoop(deps: AgentLoopDeps): AgentLoop {
  const sessions = new Map<string, SessionState>()
  const maxReplans = deps.maxReplans ?? 2
  let seq = 0

  const log = (kind: string, payload: unknown): void => {
    deps.sessionLog.append({
      seq: ++seq,
      ts: deps.clock.now(),
      kind,
      payloadHash: payloadHash(payload),
      payload,
    })
  }

  const session = (id: string): SessionState => {
    let s = sessions.get(id)
    if (!s) {
      s = { snapshot: null, coldStart: false, loaded: false, narrowed: false, totalReplans: 0, totalToolCalls: 0, quarantinedRefs: new Set() }
      sessions.set(id, s)
    }
    return s
  }

  return {
    async runTurn(input: TurnInput): Promise<TurnResult> {
      const s = session(input.sessionId)

      // Resume: replay the durable log to find the next un-verified step.
      const resumed = deps.sessionLog.resume(input.sessionId)
      const startStep = resumed?.status === 'in-progress' ? resumed.nextStepIndex : 0

      log('turn.start', { sessionId: input.sessionId })

      // Frozen snapshot — read once per session (ADR-0007); within-session
      // writes never mutate it. Cold start degrades to a minimal prefix.
      if (!s.loaded) {
        try {
          s.snapshot = await deps.memory.snapshot()
        } catch {
          s.snapshot = coldStartSnapshot(deps.clock.now())
          s.coldStart = true
        }
        s.loaded = true
        log('snapshot.frozen', { prefixHash: s.snapshot.prefixHash, coldStart: s.coldStart })
      }
      const snapshot = s.snapshot!
      // ADR-0019: at most 4 cache breakpoints survive prompt assembly.
      const breakpoints = snapshot.breakpoints.slice(0, 4)

      log('prompt.assembled', { prefixHash: snapshot.prefixHash, breakpoints: breakpoints.length })

      // ADR-0027: provenance is code-assigned at ingestion and never read from
      // model output. Narrowing clears ONLY on a clean operator turn — a turn
      // with no operator span (e.g. tool-only) keeps the prior narrowed state.
      if (input.spans.some(sp => sp.provenance === 'untrusted')) {
        s.narrowed = true
      } else if (input.spans.some(sp => sp.provenance === 'operator')) {
        s.narrowed = false
      }

      // Within-session forget protocol — deterministic, code-only. An
      // operator-typed forget is human-confirmed (resurrection-guard keys on it).
      for (const span of input.spans) {
        if (span.provenance !== 'operator') continue
        const m = FORGET_RE.exec(span.text.trim())
        if (m?.[1]) {
          const ref = m[1].trim()
          await deps.memory.forget(ref, true)
          // §5.1 step 2: quarantine the ref for the rest of the session so it can never be
          // surfaced, quoted, or laundered into a tool argument — even from the frozen prefix.
          s.quarantinedRefs.add(ref)
          log('forget.requested', { ref })
        }
      }

      const callModel = async (): Promise<ModelResponse> => {
        // Eng-7 durability: the recorded intent is fsync'd BEFORE the dispatch.
        log('step.intent', { kind: 'model-call' })
        try {
          return await deps.provider.complete({
            sessionId: input.sessionId,
            prefixBytes: snapshot.prefixBytes,
            spans: input.spans,
          })
        } catch (err) {
          if ((err as Partial<ProviderError>).kind === 'all-exhausted') {
            log('provider.exhausted', {})
            throw new Halt('all-providers-down')
          }
          throw err
        }
      }

      // §5.3 cap precedence #2: a re-plan resets the Guardian window but never
      // the monotonic totalReplans budget (anti-evasion).
      const enterReplan = (haltReason: HaltReason): void => {
        deps.guardian.note('replan')
        s.totalReplans++
        log('replan.entered', { totalReplans: s.totalReplans })
        if (s.totalReplans > maxReplans) throw new Halt(haltReason)
      }

      const dispatch = async (call: ToolCall): Promise<void> => {
        s.totalToolCalls++
        if (deps.maxTotalToolCalls !== undefined && s.totalToolCalls > deps.maxTotalToolCalls) {
          throw new Halt('cap-exceeded')
        }
        // §5.3 cap precedence #1: Guardian evaluated on EVERY dispatch, before the call runs.
        const verdictG = deps.guardian.observe(call)
        if (verdictG.trip) {
          log('guardian.tripped', { period: verdictG.period, tool: call.name })
          throw new Halt('loop-guardian')
        }
        const ctx = {
          provenance: call.sourceSpanProvenance ?? ('operator' as const),
          narrowed: s.narrowed,
        }
        const verdict = await deps.hookGate.pre(call, ctx)
        if (verdict === 'deny' || verdict === 'ask') {
          log('tool.gated', { tool: call.name, verdict })
          return
        }
        const effective = typeof verdict === 'object' ? verdict.modify : call
        // ADR-0027 motivated-call block: args derived from an untrusted span
        // never dispatch while narrowed — code-enforced, even past an 'allow'.
        if (s.narrowed && effective.sourceSpanProvenance === 'untrusted') {
          log('tool.blocked', { tool: effective.name, reason: 'untrusted-args' })
          return
        }
        // §5.1 step 2: a forgotten ref must never be laundered into a tool argument this
        // session — code-enforced quarantine, independent of provenance or any 'allow' gate.
        if (s.quarantinedRefs.size > 0) {
          const argsStr = JSON.stringify(effective.args) ?? ''
          for (const ref of s.quarantinedRefs) {
            if (argsStr.includes(ref)) {
              log('tool.blocked', { tool: effective.name, reason: 'quarantined-ref' })
              return
            }
          }
        }
        log('step.intent', { tool: effective.name })
        const result = deps.executeTool ? await deps.executeTool(effective) : undefined
        log('step.result', { tool: effective.name })
        await deps.hookGate.post(effective, result)
      }

      const runProbe = async (trace: VerificationTrace): Promise<boolean> =>
        deps.probeRunner ? await deps.probeRunner(trace) : true

      const clarification = (response: ModelResponse): TurnResult => {
        log('clarification.raised', { interpretations: response.interpretationCount })
        return { reply: response.reply, state: 'awaiting-clarification' }
      }

      try {
        let response = await callModel()

        // Plan-lint loop: a failing plan forces a re-plan, never a downgraded gate.
        let plan: Plan | undefined
        for (;;) {
          // Deterministic ambiguity floor (ADR-0026): >1 interpretation always
          // halts for clarification; the advisory score can never lower it.
          if ((response.interpretationCount ?? 0) > 1) return clarification(response)
          plan = response.plan
          if (!plan) break
          const lint = lintPlan(plan)
          log('plan.linted', lint.ok ? { ok: true } : { ok: false, rule: lint.rule })
          if (lint.ok) break
          // §5.3/§7: a re-plan that overflows the monotonic budget halts with cap-exceeded
          // regardless of the proximate trigger; the lint rule is preserved in plan.linted.
          enterReplan('cap-exceeded')
          response = await callModel()
        }

        // Tier-3 gate (ADR-0026/ADR-0011): irreversible plan waits for approval. The token
        // is bound to this exact plan's hash so a swapped plan cannot reuse a prior token
        // (§5, AC-01-17). Absent or mismatched token → awaiting-approval, zero dispatch.
        if (plan && plan.steps.some(st => st.irreversible)) {
          const planHash = payloadHash(plan)
          if (input.approvalToken !== planHash) {
            log('plan.gate', { tier: 3 })
            return { reply: response.reply, state: 'awaiting-approval', planHash }
          }
        }

        if (plan) {
          // Execute plan steps from the resume point; a step closes only on a
          // passing external probe (ADR-0017), never on the model's say-so.
          // Plan steps carry tool names only; argument elaboration happens at
          // the Tools layer (04) — here the dispatch gate is what matters.
          let i = startStep
          while (plan && i < plan.steps.length) {
            const step: PlanStep = plan.steps[i]!
            for (const tool of step.tools) {
              await dispatch({ name: tool, args: {} })
            }
            if (await runProbe(step.trace)) {
              log('step.verified', { stepIndex: i })
              i++
            } else {
              log('step.failed', { stepIndex: i })
              enterReplan('cap-exceeded')
              response = await callModel()
              if ((response.interpretationCount ?? 0) > 1) return clarification(response)
              if (response.plan) {
                const lint = lintPlan(response.plan)
                log('plan.linted', lint.ok ? { ok: true } : { ok: false, rule: lint.rule })
                if (!lint.ok) throw new Halt('plan-lint-failed')
                plan = response.plan
                // A replanned plan is a wholly new execution context: restart at step 0 so a
                // shorter new plan is never silently skipped (the resume cursor only applies
                // to the initial plan load).
                i = 0
              } else {
                // Re-plan carried no plan: exit plan mode rather than retrying
                // the already-failed plan; the new response continues free-form.
                plan = undefined
              }
            }
          }
        }
        if (!plan) {
          for (const call of response.toolCalls ?? []) {
            await dispatch(call)
          }
        }

        log('turn.end', { state: 'ok' })
        return { reply: response.reply, state: 'ok' }
      } catch (err) {
        if (err instanceof Halt) {
          log('turn.end', { state: 'halted', haltReason: err.reason })
          return { reply: '', state: 'halted', haltReason: err.reason }
        }
        throw err
      }
    },
  }
}
