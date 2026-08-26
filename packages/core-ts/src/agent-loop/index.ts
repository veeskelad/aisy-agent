import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import {
  actionEvidence,
  actionRecoveryInstruction,
  classifyActionContract,
  evaluateActionContract,
  readProviderActionEvidence,
  readProviderToolExecutions,
} from './action-contract.js'
import type { ActionEvidence } from './action-contract.js'
import {
  makeMemoryRememberReceipt,
  parseMemoryRememberReceipt,
  parseRememberFactArgs,
  renderMemoryAcknowledgement,
} from '../runtime/memory-receipt.js'
import type {
  ActionContractKind,
  AgentLoop,
  AgentLoopDeps,
  ContextSpan,
  FrozenSnapshot,
  ModelRequest,
  ModelResponse,
  TurnProgressEvent,
  Plan,
  PlanStep,
  ProviderError,
  ToolCall,
  ToolExecutionContext,
  TurnInput,
  TurnResult,
  VerificationTrace,
  VerifiedWorkflowStepObservation,
} from './types.js'

export type {
  ActionCompletionStatus,
  ActionContractKind,
  ActionMissingEvidence,
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
  ModelProgressEvent,
  ModelProgressSink,
  ModelResponse,
  Plan,
  PlanStep,
  ProviderAdapter,
  ProviderError,
  Provenance,
  SessionLog,
  TranscriptRecorder,
  TranscriptRecordRequest,
  TranscriptHistoryRequest,
  TranscriptSessionStartRequest,
  ToolCall,
  ToolExecutionContext,
  TurnInput,
  TurnProgressEvent,
  TurnProgressSink,
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

const toolExecutionContextAuthorities = new WeakMap<object, string>()

function memoryAcknowledgement(
  call: ToolCall,
  context: ToolExecutionContext,
  result: unknown,
):
{ receiptId: string; output: string } | null {
  if (call.name !== 'remember' || typeof result !== 'object' || result === null ||
    utilTypes.isProxy(result) || Object.getPrototypeOf(result) !== Object.prototype ||
    Object.getOwnPropertySymbols(result).length !== 0) return null
  const descriptors = Object.getOwnPropertyDescriptors(result) as Record<string, PropertyDescriptor>
  const keys = Object.keys(descriptors)
  const expected = ['ok', 'output', 'verified', 'mutationReceipt']
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(descriptors, key))) {
    return null
  }
  for (const key of keys) {
    const descriptor = descriptors[key]!
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
      descriptor.set !== undefined) return null
  }
  if (descriptors['ok']!.value !== true || descriptors['verified']!.value !== true) return null
  const receipt = parseMemoryRememberReceipt(descriptors['mutationReceipt']!.value)
  const fact = parseRememberFactArgs(call.args)
  const expectedReceipt = fact === null ? null : makeMemoryRememberReceipt(fact, context)
  if (receipt === null || fact === null || expectedReceipt === null ||
    receipt.operationId !== expectedReceipt.operationId ||
    receipt.receiptId !== expectedReceipt.receiptId ||
    receipt.turnId !== expectedReceipt.turnId || receipt.fact !== fact.fact) return null
  const output = renderMemoryAcknowledgement(receipt.fact)
  return descriptors['output']!.value === output ? { receiptId: receipt.receiptId, output } : null
}

const FALSE_ROLE_PREFIX = /(?:поддельн\p{L}*|fake|forged)/iu
const SYSTEM_ROLE_REFERENCE = /(?:system\s*:\s*-?\s*(?:reply|message|instruction|реплик\p{L}*|сообщен\p{L}*|инструкц\p{L}*)?|system\s+(?:reply|message|role|instruction)|системн\p{L}*\s+(?:реплик\p{L}*|сообщен\p{L}*|инструкц\p{L}*|рол\p{L}*))/iu

function claimsFalseSystemRole(text: string): boolean {
  const falseRole = FALSE_ROLE_PREFIX.exec(text)
  const systemRole = SYSTEM_ROLE_REFERENCE.exec(text)
  if (falseRole === null || systemRole === null) return false
  if (falseRole.index < systemRole.index) {
    const between = text.slice(falseRole.index + falseRole[0].length, systemRole.index)
    return /^[\s,.;:!—–‑-]*(?:(?:embedded|встроенн\p{L}*)[\s,.;:!—–‑-]*)?$/iu.test(between)
  }
  const between = text.slice(systemRole.index + systemRole[0].length, falseRole.index)
  return /^[\s,.;:!—–‑-]*(?:(?:was|is|were|был\p{L}*|оказал\p{L}*|являл\p{L}*)[\s,.;:!—–‑-]*)?$/iu.test(between)
}

function hasPromptInjectionSignal(text: string): boolean {
  return /\bsystem\s*:|prompt\s+injection|инъекц\p{L}*\s+промпт/iu.test(text) ||
    claimsFalseSystemRole(text)
}

function inboundSpanGroundsPromptInjectionClaim(span: ContextSpan): boolean {
  return (span.role === 'user' || span.provenance === 'untrusted') &&
    hasPromptInjectionSignal(span.text)
}

function synthesisSpanGroundsPromptInjectionClaim(span: ContextSpan): boolean {
  return span.role === 'tool' && hasPromptInjectionSignal(span.text)
}

function terminalReplyWithMemoryAcknowledgements(
  reply: string,
  acknowledgements: readonly string[],
  promptInjectionClaimGrounded: boolean,
): string {
  if (acknowledgements.length === 0) return reply
  let body = reply
  for (const acknowledgement of acknowledgements) {
    body = body.split(acknowledgement).join('')
  }
  const acknowledgedFacts = acknowledgements
    .filter(acknowledgement => acknowledgement.startsWith('Запомнил, что '))
    .map(acknowledgement => acknowledgement.slice('Запомнил, что '.length))
  body = body.replace(
    /\s*(?:факт сохран[её]н|память (?:сохранена|обновлена)|сохранил(?:а)? факт)(?:\s|:|$)[^\r\n]*/gimu,
    '',
  )
  if (!promptInjectionClaimGrounded) {
    body = body.split(/\r?\n/u)
      .filter(line => !claimsFalseSystemRole(line))
      .join('\n')
  }
  body = body.split(/\r?\n/u)
    .filter(line => {
      if (/^\s*(?:[-*•]\s*)?(?:факт сохран[её]н|память (?:сохранена|обновлена)|сохранил(?:а)? факт)(?:\s|:|$)/iu.test(line)) return false
      const memoryStatus = line.match(/^\s*(?:[-*•]\s*)?память\s*:\s*(.*)$/iu)?.[1]?.trim()
      if (memoryStatus === undefined) return true
      if (/^(?:[«"'][\s\S]*[»"']|пусто|(?:факт\s+)?(?:сохран\p{L}*|обновл\p{L}*|записан\p{L}*))\.?$/iu.test(memoryStatus)) return false
      return !acknowledgedFacts.some(fact => memoryStatus.includes(fact))
    })
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return [body, ...acknowledgements].filter(part => part.length > 0).join('\n\n')
}

/** Only AgentLoop can register the exact model-requested tool for this object. */
export function isGenuineToolExecutionContextFor(
  value: unknown,
  requestedToolName: string,
): value is ToolExecutionContext {
  return typeof value === 'object' && value !== null &&
    toolExecutionContextAuthorities.get(value) === requestedToolName
}

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

/** Max chars of a single tool result fed into a synthesis-round span (ADR-0102), so
 *  one large file read cannot blow up the follow-up prompt. */
const TOOL_RESULT_CAP = 8000

/** Upper bound on synthesis rounds (ADR-0102) — the iterative dispatch→observe→answer
 *  loop stops here even if the model keeps requesting tools. dispatch's
 *  maxTotalToolCalls guard is the finer-grained cap; this bounds pathological repeats. */
const MAX_SYNTHESIS_ROUNDS = 6

/** Render a tool result as text for a synthesis-round `tool` span (ADR-0102). Handles
 *  the runtime ToolResult shape ({ ok, output }), plain strings, and arbitrary values. */
function toolResultText(result: unknown): string {
  const cap = (s: string): string =>
    s.length > TOOL_RESULT_CAP ? `${s.slice(0, TOOL_RESULT_CAP)}\n…[truncated]` : s
  if (result == null) return ''
  if (typeof result === 'string') return cap(result)
  if (typeof result === 'object' && 'output' in (result as Record<string, unknown>)) {
    const o = (result as { output?: unknown }).output
    return cap(typeof o === 'string' ? o : JSON.stringify(o) ?? '')
  }
  try {
    return cap(JSON.stringify(result) ?? '')
  } catch {
    return String(result)
  }
}

/** A typed executor denial/failure is terminal but not successful. Untyped
 *  values preserve the legacy success contract. */
function toolResultSucceeded(result: unknown): boolean {
  return !(typeof result === 'object' && result !== null &&
    'ok' in result && (result as { ok?: unknown }).ok === false)
}

/** Argument keys worth showing an operator watching a turn run. */
const ARG_DIGEST_KEYS = ['command', 'cmd', 'script', 'path', 'file', 'url', 'query', 'objective', 'name', 'tool']
const MAX_ARG_DIGEST = 120

/**
 * A short, code-sanitized echo of what a tool was asked to do — the command,
 * the path, the query. The rest of the arguments stay out of the view.
 *
 * The value comes from the model, so it is treated as text and nothing else:
 * one known key, strings only, control characters stripped, length bounded. It
 * is shown, never parsed or acted on. Without it a running turn is a spinner
 * with a tool name on it, which tells the operator nothing about what is
 * happening on their machine.
 */
function argDigest(args: Record<string, unknown> | undefined): { arg?: string } {
  if (args === null || typeof args !== 'object') return {}
  for (const key of ARG_DIGEST_KEYS) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value !== 'string' || value.length === 0) continue
    const clean = value.replace(/[\p{C}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
    if (clean.length === 0) continue
    return { arg: clean.length <= MAX_ARG_DIGEST ? clean : `${clean.slice(0, MAX_ARG_DIGEST - 1)}…` }
  }
  return {}
}

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
  transcriptStarted: boolean
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
      s = { snapshot: null, coldStart: false, loaded: false, narrowed: false, totalReplans: 0, totalToolCalls: 0, transcriptStarted: false, quarantinedRefs: new Set() }
      sessions.set(id, s)
    }
    return s
  }

  return {
    async runTurn(input: TurnInput): Promise<TurnResult> {
      const transcriptRecorder = deps.transcriptRecorder
      const turnId = input.turnId
      const turnTs = input.turnTs
      if (transcriptRecorder !== undefined &&
        (typeof turnId !== 'string' || turnId.length === 0 ||
          typeof turnTs !== 'string' || turnTs.length === 0)) {
        throw new Error('transcript recorder requires stable turnId and turnTs')
      }
      let transcriptOrdinal = 0
      let toolInvocationOrdinal = 0
      const recordSpan = async (span: ContextSpan): Promise<void> => {
        if (transcriptRecorder === undefined) return
        transcriptOrdinal += 1
        await transcriptRecorder.record({
          sessionId: input.sessionId,
          turnId: turnId!,
          turnTs: turnTs!,
          ordinal: transcriptOrdinal,
          span: { ...span },
        })
      }
      const s = session(input.sessionId)
      const emitProgress = async (event: TurnProgressEvent): Promise<void> => {
        if (input.onProgress === undefined) return
        try {
          await input.onProgress(event)
        } catch {
          // Progress is observational. A broken transport must not alter model,
          // tool, memory, or safety decisions made by the loop.
          log('progress.sink.failed', { eventType: event.type })
        }
      }

      // Resume: replay the durable log to find the next un-verified step.
      const resumed = deps.sessionLog.resume(input.sessionId, turnId)
      const startStep = resumed?.status === 'in-progress' ? resumed.nextStepIndex : 0
      toolInvocationOrdinal = resumed?.status === 'in-progress'
        ? resumed.toolOrdinalHighWater
        : 0
      if (!Number.isSafeInteger(toolInvocationOrdinal) || toolInvocationOrdinal < 0) {
        throw new Error('session log tool ordinal high-water invalid')
      }
      let durableNextStepIndex = startStep
      let durableToolOrdinalHighWater = toolInvocationOrdinal
      const checkpoint = (status: 'in-progress' | 'complete'): void => {
        if (turnId === undefined) return
        log('turn.checkpoint', {
          sessionId: input.sessionId,
          turnId,
          status,
          nextStepIndex: durableNextStepIndex,
          toolOrdinalHighWater: durableToolOrdinalHighWater,
        })
      }
      const checkpointAttempt = (ordinal: number): void => {
        if (!Number.isSafeInteger(ordinal) || ordinal <= durableToolOrdinalHighWater) {
          throw new Error('provider tool ordinal checkpoint invalid')
        }
        durableToolOrdinalHighWater = ordinal
        checkpoint('in-progress')
      }
      checkpoint('in-progress')

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
        if (deps.prefixExtension !== undefined) {
          try {
            const extension = await deps.prefixExtension()
            if (extension.byteLength > 0) {
              const base = s.snapshot.prefixBytes
              const combined = new Uint8Array(base.byteLength + extension.byteLength)
              combined.set(base, 0)
              combined.set(extension, base.byteLength)
              s.snapshot = {
                ...s.snapshot,
                prefixBytes: combined,
                prefixHash: createHash('sha256').update(combined).digest('hex'),
              }
            }
          } catch {
            // A broken optional menu must not make the base agent unavailable.
          }
        }
        s.loaded = true
        log('snapshot.frozen', { prefixHash: s.snapshot.prefixHash, coldStart: s.coldStart })
      }
      let snapshot = s.snapshot!
      if (transcriptRecorder !== undefined && !s.transcriptStarted) {
        const authoritative = await transcriptRecorder.start({
          sessionId: input.sessionId,
          frozen: {
            prefixBytes: snapshot.prefixBytes.slice(),
            prefixHash: snapshot.prefixHash,
            breakpoints: [...snapshot.breakpoints],
            takenAt: snapshot.takenAt,
          },
        })
        s.snapshot = {
          prefixBytes: authoritative.prefixBytes.slice(),
          prefixHash: authoritative.prefixHash,
          breakpoints: [...authoritative.breakpoints],
          takenAt: authoritative.takenAt,
        }
        snapshot = s.snapshot
        s.transcriptStarted = true
      }
      const historySpans = transcriptRecorder === undefined
        ? []
        : await transcriptRecorder.history({ sessionId: input.sessionId })
      for (const span of input.spans) await recordSpan(span)

      // Narrowing asks one question: did untrusted material enter this session
      // from outside. The agent's own replies are in history and are
      // provenance-untrusted by construction — model output is never
      // operator-authored — but they are not an ingested source. Counting them
      // latches the lockout on the first answer of every session and never
      // releases it, so the operator ends up approving the agent's own previous
      // sentence. If external material really did arrive, the row it arrived
      // through is still here and still narrows the turn.
      // Only history is filtered: whatever the transport hands in as this
      // turn's input is ingested content whatever role it claims, and a caller
      // must not be able to slip untrusted text past narrowing by labelling it
      // as an assistant span.
      const ingestedSpans = [
        ...historySpans.filter(sp => sp.role !== 'assistant'),
        ...input.spans,
      ]

      // ADR-0019: at most 4 cache breakpoints survive prompt assembly.
      const breakpoints = snapshot.breakpoints.slice(0, 4)

      log('prompt.assembled', { prefixHash: snapshot.prefixHash, breakpoints: breakpoints.length })

      // ADR-0027: provenance is code-assigned at ingestion and never read from
      // model output. Narrowing clears ONLY on a clean operator turn — a turn
      // with no operator span (e.g. tool-only) keeps the prior narrowed state.
      if (ingestedSpans.some(sp => sp.provenance === 'untrusted')) {
        s.narrowed = true
      } else if (input.spans.some(sp => sp.provenance === 'operator')) {
        s.narrowed = false
      }
      // The transport starts fail-closed and may stream only after this
      // code-owned verdict. Providers never control outbound-lockout state.
      await emitProgress({ type: 'outbound-lockout', locked: s.narrowed })
      await emitProgress({ type: 'turn-started' })

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

      // Accumulate provider usage across (possibly multiple) model calls.
      let usageIn = 0
      let usageOut = 0
      let usageDollars = 0

      const actionContract = classifyActionContract(input.spans)
      const actionRequired = actionContract.kind !== 'answer-only'
      const actionEvidenceLog: ActionEvidence[] = []
      let turnEffectObserved = false
      const memoryAcknowledgements = new Map<string, string>()
      let promptInjectionClaimGrounded = input.spans.some(span =>
        inboundSpanGroundsPromptInjectionClaim(span))
      const verifiedWorkflowSteps: VerifiedWorkflowStepObservation[] = []
      let verifiedWorkflowDelivery: { evidenceId: string } | undefined
      let verifiedWorkflowEligible = true
      const executionBelongsToTurn = (context: ToolExecutionContext): boolean =>
        context.sessionId === input.sessionId && context.turnId === turnId &&
        Number.isSafeInteger(context.ordinal) && (context.ordinal ?? 0) > 0
      const observeVerifiedExecution = (
        call: ToolCall,
        context: ToolExecutionContext,
        result: unknown,
      ): void => {
        if (deps.verifiedWorkflow === undefined || !verifiedWorkflowEligible) return
        if (!toolResultSucceeded(result) || !executionBelongsToTurn(context) ||
          (call.sourceSpanProvenance ?? 'operator') !== 'operator') {
          verifiedWorkflowEligible = false
          return
        }
        try {
          const step = deps.verifiedWorkflow.capture(call, context, result)
          if (step === null) {
            verifiedWorkflowEligible = false
            return
          }
          verifiedWorkflowSteps.push(step)
        } catch {
          verifiedWorkflowEligible = false
        }
      }
      log('action.contract', actionContract)
      if (actionContract.kind !== 'answer-only') {
        await emitProgress({ type: 'action-contract', kind: actionContract.kind })
      }

      const actionContractSpan: ContextSpan[] = actionRequired
        ? [{
            role: 'system',
            provenance: 'operator',
            text: actionRecoveryInstruction(
              actionContract,
              evaluateActionContract(actionContract, actionEvidenceLog),
            ),
          }]
        : []
      for (const span of actionContractSpan) await recordSpan(span)

      const callModel = async (extraSpans: ContextSpan[] = []): Promise<ModelResponse> => {
        // Eng-7 durability: the recorded intent is fsync'd BEFORE the dispatch.
        log('step.intent', { kind: 'model-call' })
        // ADR-0077: context pulled right before the provider call, for this call
        // only. It follows the turn spans and never touches the stable prefix.
        const lateSpans = deps.lateContext === undefined
          ? []
          : await deps.lateContext({ at: 'pre-provider', spans: [...input.spans, ...extraSpans] })
        if (!promptInjectionClaimGrounded) {
          promptInjectionClaimGrounded = extraSpans.some(span =>
            synthesisSpanGroundsPromptInjectionClaim(span)) || lateSpans.some(span =>
            inboundSpanGroundsPromptInjectionClaim(span))
        }
        const bufferedTextDeltas: Extract<TurnProgressEvent, { type: 'text-delta' }>[] = []
        try {
          const modelRequest: ModelRequest = {
            sessionId: input.sessionId,
            ...(turnId === undefined ? {} : { turnId }),
            toolOrdinalBase: toolInvocationOrdinal,
            prefixBytes: snapshot.prefixBytes,
            // ADR-0102: a synthesis round appends the assistant preamble + tool
            // results after the turn's spans so the model can answer from them.
            spans: [...historySpans, ...input.spans, ...actionContractSpan, ...extraSpans, ...lateSpans],
          }
          // The in-process authority must not enter serializable provider payloads.
          // Non-enumerability keeps structuredClone/JSON adapters compatible while
          // supervised provider loops can still await it immediately pre-effect.
          Object.defineProperty(modelRequest, 'markToolAttempt', {
            value: checkpointAttempt,
            enumerable: false,
          })
          const r = await deps.provider.complete(
            modelRequest,
            input.signal,
            (event) => {
              if (event.type === 'tool-requested') turnEffectObserved = true
              if (event.type !== 'text-delta') return emitProgress(event)
              bufferedTextDeltas.push(event)
              return Promise.resolve()
            },
          )
          await recordSpan({
            role: 'assistant',
            provenance: 'untrusted',
            text: r.reply,
          })
          const providerEvidence = readProviderActionEvidence(r)
          const providerExecutions = readProviderToolExecutions(r)
          if (r.plan !== undefined || (r.toolCalls?.length ?? 0) > 0 ||
            providerExecutions.length > 0 || providerEvidence.length > 0) {
            turnEffectObserved = true
          }
          actionEvidenceLog.push(...providerEvidence)
          for (const execution of providerExecutions) {
            if (!promptInjectionClaimGrounded &&
              hasPromptInjectionSignal(toolResultText(execution.result))) {
              promptInjectionClaimGrounded = true
            }
            if (!executionBelongsToTurn(execution.context) ||
              execution.context.ordinal <= toolInvocationOrdinal ||
              execution.context.ordinal > durableToolOrdinalHighWater) {
              verifiedWorkflowEligible = false
              continue
            }
            toolInvocationOrdinal = execution.context.ordinal
            const acknowledgement = memoryAcknowledgement(
              execution.call,
              execution.context,
              execution.result,
            )
            if (acknowledgement !== null) {
              memoryAcknowledgements.set(acknowledgement.receiptId, acknowledgement.output)
            }
            observeVerifiedExecution(execution.call, execution.context, execution.result)
          }
          if (!actionRequired && !turnEffectObserved) {
            for (const event of bufferedTextDeltas) await emitProgress(event)
          }
          if (r.usage) {
            usageIn += r.usage.inputTokens
            usageOut += r.usage.outputTokens
            usageDollars += r.usage.dollars
            await emitProgress({
              type: 'turn-usage',
              inputTokens: usageIn,
              outputTokens: usageOut,
              dollars: usageDollars,
            })
          }
          // ADR-0051 mid-turn budget: consult the injected probe with the turn's
          // running usage; a positive verdict halts before any further dispatch.
          if (deps.budgetCheck) {
            const capped = await deps.budgetCheck({
              sessionId: input.sessionId,
              inputTokens: usageIn,
              outputTokens: usageOut,
              dollars: usageDollars,
            })
            if (capped) throw new Halt('budget-capped')
          }
          return r
        } catch (err) {
          // A Halt raised in the try (budget) is control flow, not an error — re-throw as-is.
          if (err instanceof Halt) throw err
          // A /stop abort surfaces as a fetch/spawn rejection; map it to a clean
          // halt so the transport stays quiet (the /stop handler already acked).
          if (input.signal?.aborted) throw new Halt('stopped')
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

      const dispatch = async (
        call: ToolCall,
      ): Promise<{ executed: boolean; result?: unknown; span?: ContextSpan }> => {
        turnEffectObserved = true
        // ADR-0051: /stop interrupts between tool calls too, not only at model calls.
        if (input.signal?.aborted) throw new Halt('stopped')
        // Count every model-requested position, including a call later denied by
        // policy. This keeps the next allowed call's identity stable if policy
        // state changes between an interrupted attempt and its replay.
        toolInvocationOrdinal += 1
        checkpointAttempt(toolInvocationOrdinal)
        const executionContext: ToolExecutionContext = Object.freeze({
          sessionId: input.sessionId,
          ...(turnId === undefined ? {} : { turnId }),
          ordinal: toolInvocationOrdinal,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
        toolExecutionContextAuthorities.set(executionContext, call.name)
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
        const sequence = s.totalToolCalls
        const category = call.name === 'spawn_subagent' ? 'subagent' as const : 'tool' as const
        const requestedProgress = { sequence, name: call.name, category, ...argDigest(call.args) }
        await emitProgress({ type: 'tool-pending', ...requestedProgress })
        let dispatchCall = call
        if (deps.preToolDispatch !== undefined) {
          let decision: Awaited<ReturnType<NonNullable<typeof deps.preToolDispatch>>>
          try {
            decision = await deps.preToolDispatch(call, executionContext)
          } catch {
            decision = Object.freeze({
              kind: 'intercept' as const,
              result: Object.freeze({ ok: false, output: 'TOOL_PREFLIGHT_FAILED' }),
            })
          }
          if (decision.kind === 'intercept') {
            await emitProgress({ type: 'tool-started', ...requestedProgress })
            const intercepted = await deps.hookGate.post(call, decision.result)
            log('step.result', { tool: call.name, preflight: true })
            await emitProgress({
              type: toolResultSucceeded(intercepted) ? 'tool-completed' : 'tool-failed',
              ...requestedProgress,
            })
            actionEvidenceLog.push(actionEvidence(call, intercepted))
            observeVerifiedExecution(call, executionContext, intercepted)
            const span: ContextSpan = {
              role: 'tool',
              provenance: 'untrusted',
              text: `${call.name}: ${toolResultText(intercepted)}`,
            }
            await recordSpan(span)
            return { executed: true, result: intercepted, span }
          }
          if (decision.call.name !== call.name) {
            await emitProgress({ type: 'tool-denied', ...requestedProgress, reason: 'policy' })
            return { executed: false }
          }
          dispatchCall = decision.call
        }
        const ctx = {
          provenance: dispatchCall.sourceSpanProvenance ?? ('operator' as const),
          narrowed: s.narrowed,
        }
        const verdict = await deps.hookGate.pre(dispatchCall, ctx)
        if (verdict === 'deny' || verdict === 'ask') {
          log('tool.gated', { tool: call.name, verdict })
          await emitProgress({ type: 'tool-denied', ...requestedProgress, reason: 'policy' })
          return { executed: false }
        }
        const effective = typeof verdict === 'object' ? verdict.modify : dispatchCall
        const effectiveProgress = {
          sequence,
          name: effective.name,
          category: effective.name === 'spawn_subagent' ? 'subagent' as const : 'tool' as const,
          ...argDigest(effective.args),
        }
        // ADR-0027 motivated-call block: args derived from an untrusted span
        // never dispatch while narrowed — code-enforced, even past an 'allow'.
        if (s.narrowed && effective.sourceSpanProvenance === 'untrusted') {
          log('tool.blocked', { tool: effective.name, reason: 'untrusted-args' })
          await emitProgress({ type: 'tool-denied', ...effectiveProgress, reason: 'untrusted-args' })
          return { executed: false }
        }
        // §5.1 step 2: a forgotten ref must never be laundered into a tool argument this
        // session — code-enforced quarantine, independent of provenance or any 'allow' gate.
        if (s.quarantinedRefs.size > 0) {
          const argsStr = JSON.stringify(effective.args) ?? ''
          for (const ref of s.quarantinedRefs) {
            if (argsStr.includes(ref)) {
              log('tool.blocked', { tool: effective.name, reason: 'quarantined-ref' })
              await emitProgress({ type: 'tool-denied', ...effectiveProgress, reason: 'quarantined-ref' })
              return { executed: false }
            }
          }
        }
        log('step.intent', { tool: effective.name, ordinal: toolInvocationOrdinal })
        await emitProgress({ type: 'tool-started', ...effectiveProgress })
        let result: unknown
        try {
          result = deps.executeTool
            ? await deps.executeTool(effective, executionContext)
            : undefined
        } catch (error) {
          let propagate = false
          try {
            propagate = deps.propagateToolInterruption?.(
              error,
              effective,
              executionContext,
            ) === true
          } catch {
            // A broken classifier cannot downgrade an unknown executor failure
            // into privileged control flow.
          }
          if (propagate) throw error
          result = {
            ok: false,
            output: error instanceof Error ? error.message : 'tool executor failed',
          }
        }
        result = await deps.hookGate.post(effective, result)
        if (deps.postToolDispatch !== undefined) {
          try {
            await deps.postToolDispatch(effective, executionContext, result)
          } catch {
            result = { ok: false, output: 'TOOL_POST_DISPATCH_FAILED' }
          }
        }
        log('step.result', { tool: effective.name })
        await emitProgress({
          type: toolResultSucceeded(result) ? 'tool-completed' : 'tool-failed',
          ...effectiveProgress,
        })
        actionEvidenceLog.push(actionEvidence(effective, result))
        observeVerifiedExecution(effective, executionContext, result)
        const acknowledgement = memoryAcknowledgement(effective, executionContext, result)
        if (acknowledgement !== null) {
          memoryAcknowledgements.set(acknowledgement.receiptId, acknowledgement.output)
        }
        const span: ContextSpan = {
          role: 'tool',
          provenance: 'untrusted',
          text: `${effective.name}: ${toolResultText(result)}`,
        }
        await recordSpan(span)
        return { executed: true, result, span }
      }

      const runProbe = async (trace: VerificationTrace): Promise<boolean> =>
        deps.probeRunner ? await deps.probeRunner(trace) : true

      const clarification = (response: ModelResponse): TurnResult => {
        log('clarification.raised', { interpretations: response.interpretationCount })
        checkpoint('complete')
        return { reply: response.reply, state: 'awaiting-clarification' }
      }

      try {
        let response = await callModel()
        let planVerified = false

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
            checkpoint('complete')
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
            durableNextStepIndex = i
            const step: PlanStep = plan.steps[i]!
            for (const tool of step.tools) {
              await dispatch({ name: tool, args: {} })
            }
            if (await runProbe(step.trace)) {
              log('step.verified', { stepIndex: i })
              i++
              durableNextStepIndex = i
              checkpoint('in-progress')
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
                durableNextStepIndex = 0
                checkpoint('in-progress')
              } else {
                // Re-plan carried no plan: exit plan mode rather than retrying
                // the already-failed plan; the new response continues free-form.
                plan = undefined
              }
            }
          }
          planVerified = plan !== undefined && plan.steps.length > 0 && i >= plan.steps.length
          // An empty plan is not evidence for an action-required turn. Route it
          // through the same single recovery path as a prose-only response.
          if (actionRequired && !planVerified && plan?.steps.length === 0) plan = undefined
        }
        if (!plan) {
          // ADR-0102: free-form tool path. Dispatch requested tools and feed their
          // results back as a synthesis round so the model answers from the output
          // instead of returning only its pre-tool preamble. A bounded loop supports
          // iterative tool use (dispatch → observe → decide next tool) without a
          // runaway: it stops when the model stops requesting tools, when a round
          // executes nothing (all gated/blocked → keep the current reply), or at
          // MAX_SYNTHESIS_ROUNDS. dispatch's own maxTotalToolCalls guard still applies.
          const convo: ContextSpan[] = []
          let rounds = 0
          const runToolRounds = async (): Promise<void> => {
            while ((response.toolCalls?.length ?? 0) > 0 && rounds < MAX_SYNTHESIS_ROUNDS) {
              const toolResultSpans: ContextSpan[] = []
              let executedAny = false
              for (const call of response.toolCalls ?? []) {
                const d = await dispatch(call)
                if (d.executed) {
                  executedAny = true
                  toolResultSpans.push(d.span!)
                }
              }
              if (!executedAny) break
              if (response.reply.trim().length > 0) {
                convo.push({ role: 'assistant', provenance: 'untrusted', text: response.reply })
              }
              convo.push(...toolResultSpans)
              response = await callModel(convo)
              rounds++
            }
          }

          await runToolRounds()

          let actionVerdict = evaluateActionContract(actionContract, actionEvidenceLog)
          if (!actionVerdict.satisfied && actionContract.kind !== 'answer-only') {
            log('action.recovery', { kind: actionContract.kind, missing: actionVerdict.missing })
            if (actionVerdict.missing !== 'none') {
              await emitProgress({
                type: 'action-recovery',
                kind: actionContract.kind,
                missing: actionVerdict.missing,
              })
            }
            const recoverySpan: ContextSpan = {
              role: 'system',
              provenance: 'operator',
              text: actionRecoveryInstruction(actionContract, actionVerdict),
            }
            await recordSpan(recoverySpan)
            convo.push(recoverySpan)
            response = await callModel(convo)
            await runToolRounds()
            actionVerdict = evaluateActionContract(actionContract, actionEvidenceLog)
          }

          if (!actionVerdict.satisfied) {
            log('action.unverified', { kind: actionContract.kind, missing: actionVerdict.missing })
            log('turn.end', { state: 'ok', actionStatus: 'unverified' })
            checkpoint('complete')
            const failureReply = 'Не удалось подтвердить выполнение: отсутствует проверяемое доказательство результата.'
            await recordSpan({ role: 'assistant', provenance: 'operator', text: failureReply })
            return {
              reply: failureReply,
              state: 'ok',
              narrowed: s.narrowed,
              actionContractKind: actionContract.kind as Exclude<ActionContractKind, 'answer-only'>,
              actionStatus: 'unverified',
              ...(usageIn > 0 || usageOut > 0
                ? { usage: { inputTokens: usageIn, outputTokens: usageOut, dollars: usageDollars } }
                : {}),
            }
          }
        }

        const actionVerdict = evaluateActionContract(actionContract, actionEvidenceLog, planVerified)
        if (deps.verifiedWorkflow !== undefined && actionRequired && actionVerdict.satisfied &&
          verifiedWorkflowEligible && verifiedWorkflowSteps.length > 0 && !s.narrowed &&
          turnId !== undefined) {
          try {
            const delivery = await deps.verifiedWorkflow.commit({
              sessionId: input.sessionId,
              turnId,
              steps: Object.freeze([...verifiedWorkflowSteps]),
            })
            if (typeof delivery === 'object' && delivery !== null &&
              Object.getPrototypeOf(delivery) === Object.prototype &&
              Object.keys(delivery).length === 1 &&
              typeof delivery.evidenceId === 'string' &&
              /^[a-f0-9]{64}$/u.test(delivery.evidenceId)) {
              verifiedWorkflowDelivery = Object.freeze({ evidenceId: delivery.evidenceId })
            }
            log('verified-workflow.committed', { steps: verifiedWorkflowSteps.length })
          } catch {
            // Learning is observational. A failed private-state transaction may
            // suppress a candidate, but never turns verified user work into a
            // false failure or retries its effects.
            log('verified-workflow.failed', { steps: verifiedWorkflowSteps.length })
          }
        }
        log('turn.end', {
          state: 'ok',
          ...(actionRequired
            ? { actionStatus: actionVerdict.satisfied ? 'verified' : 'unverified' }
            : {}),
        })
        checkpoint('complete')
        return {
          reply: terminalReplyWithMemoryAcknowledgements(
            response.reply,
            [...memoryAcknowledgements.values()],
            promptInjectionClaimGrounded,
          ),
          state: 'ok',
          narrowed: s.narrowed,
          ...(actionRequired
            ? {
                actionContractKind: actionContract.kind as Exclude<ActionContractKind, 'answer-only'>,
                actionStatus: actionVerdict.satisfied ? 'verified' as const : 'unverified' as const,
              }
            : {}),
          ...(usageIn > 0 || usageOut > 0
            ? { usage: { inputTokens: usageIn, outputTokens: usageOut, dollars: usageDollars } }
            : {}),
          ...(verifiedWorkflowDelivery === undefined ? {} : { verifiedWorkflowDelivery }),
        }
      } catch (err) {
        if (err instanceof Halt) {
          log('turn.end', { state: 'halted', haltReason: err.reason })
          checkpoint('complete')
          return {
            reply: '',
            state: 'halted',
            haltReason: err.reason,
            narrowed: s.narrowed,
            ...(usageIn > 0 || usageOut > 0
              ? { usage: { inputTokens: usageIn, outputTokens: usageOut, dollars: usageDollars } }
              : {}),
          }
        }
        throw err
      }
    },
  }
}
