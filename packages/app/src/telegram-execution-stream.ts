import type { TurnProgressEvent, TurnResult } from '@aisy/core'
import {
  renderExecution,
  type ExecutionState,
  type ToolView,
} from '@aisy/telegram-gw'
import {
  makeTelegramExecutionCheckpoint,
  type TelegramExecutionCheckpointV1,
  type TelegramExecutionCheckpointStore,
} from './telegram-execution-checkpoint.js'

export interface TelegramExecutionStreamOutput {
  sendText(html: string): Promise<number>
  editText(messageId: number, html: string): Promise<void>
}

export interface TelegramExecutionStream {
  /** Publish prepared/pending without Telegram I/O. */
  prepare(): Promise<void>
  /** Close a prepared turn as a clean no-output cancellation. */
  cancel(): Promise<void>
  start(): Promise<void>
  handle(event: TurnProgressEvent): Promise<void>
  complete(result: TurnResult): Promise<void>
  fail(): Promise<void>
  stop(): Promise<void>
}

const DEFAULT_EDIT_INTERVAL_MS = 500
/** Refresh cadence while nothing is happening — the clock still has to move. */
const DEFAULT_HEARTBEAT_MS = 2_000
/** Older steps scroll off; the card must stay readable on a phone. */
const MAX_HISTORY = 6
const SAFE_CAPABILITY = /^[a-z][a-z0-9_.:-]{0,127}$/

function displaySessionId(sessionId: string): string {
  return sessionId.length <= 64 ? sessionId : `${sessionId.slice(0, 63)}…`
}

function displayCapability(name: string): string {
  return SAFE_CAPABILITY.test(name) ? name : 'unknown'
}

function terminalStatus(result: TurnResult): NonNullable<ExecutionState['status']> {
  if (result.state === 'ok') return 'completed'
  if (result.state === 'awaiting-approval' || result.state === 'awaiting-clarification') {
    return 'awaiting'
  }
  return result.haltReason === 'stopped' ? 'stopped' : 'failed'
}

/** Code-owned execution status. Model arguments, results, reasoning and errors
 *  never enter this view; a locked turn renders only generic lifecycle text. */
export function makeTelegramExecutionStream(input: {
  sessionId: string
  /** Shown instead of the session id: a project name, or nothing for the
   *  shared workspace. A uuid answered a question nobody asked. */
  scope?: string
  /** How often the card refreshes while nothing happens, so the stopwatch on
   *  screen keeps moving during a long silent think. */
  heartbeatMs?: number
  /** Explicit operator debug mode; ordinary Telegram stays redacted by default. */
  debug?: boolean
  output: TelegramExecutionStreamOutput
  signal: AbortSignal
  editIntervalMs?: number
  nowMs?: () => number
  checkpoint?: {
    store: TelegramExecutionCheckpointStore
    bindingHash: string
    ownerId: string
    /** Exact checkpoint adopted under a supervisor recovery lease. */
    resume?: TelegramExecutionCheckpointV1
    nowIso?: () => string
    assertAuthorityHeld?: () => boolean
  }
}): TelegramExecutionStream {
  const interval = input.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS
  const heartbeatMs = input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  if (!Number.isFinite(interval) || interval < 0) throw new Error('INVALID_EXECUTION_STREAM_INTERVAL')
  const nowMs = input.nowMs ?? Date.now
  const resume = input.checkpoint?.resume
  if (resume !== undefined && (input.checkpoint === undefined ||
    resume.bindingHash !== input.checkpoint.bindingHash ||
    resume.ownerId !== input.checkpoint.ownerId || resume.phase === 'terminal' ||
    resume.state.status !== 'running')) {
    throw new Error('EXECUTION_CHECKPOINT_RESUME_INVALID')
  }
  const state: ExecutionState = resume === undefined
    ? {
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        steps: [],
        history: [],
        thinking: true,
        status: 'running',
      }
    : structuredClone(resume.state)
  const startedAt = new Map<number, number>()
  const turnStartedAt = nowMs()
  let phaseStartedAt = turnStartedAt
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let locked = resume?.locked ?? true
  let prepared = resume !== undefined
  let started = false
  let stopped = false
  let terminal = false
  let messageId: number | null = resume?.messageId ?? null
  let lastHtml = ''
  let lastWriteAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let tail: Promise<void> = Promise.resolve()
  let checkpointRevision = resume?.revision ?? 0

  const checkpointNow = input.checkpoint?.nowIso ?? (() => new Date().toISOString())

  /**
   * What survives a restart. Deliberately less than what is on screen: the
   * durable record carries lifecycle, not display. Command echoes and the
   * activity log are model-derived text and stay in memory only — a recovery
   * card that replays them would be publishing them from disk.
   */
  const redacted = (): ExecutionState => {
    const { history: _log, elapsedMs: _turn, phaseMs: _phase, note: _note, ...rest } = state
    const tool = rest.tool === undefined ? undefined : {
      name: rest.tool.name,
      ...(rest.tool.kind === undefined ? {} : { kind: rest.tool.kind }),
      ...(rest.tool.status === undefined ? {} : { status: rest.tool.status }),
      ...(rest.tool.elapsedMs === undefined ? {} : { elapsedMs: rest.tool.elapsedMs }),
    }
    return { ...rest, ...(tool === undefined ? {} : { tool }) }
  }

  const checkpoint = (
    phase: 'prepared' | 'bound' | 'terminal',
    delivery: 'pending' | 'delivered',
    nextMessageId: number | null,
  ) => {
    if (input.checkpoint === undefined) return null
    return makeTelegramExecutionCheckpoint({
      bindingHash: input.checkpoint.bindingHash,
      ownerId: input.checkpoint.ownerId,
      revision: checkpointRevision + 1,
      phase,
      delivery,
      ...(nextMessageId === null ? {} : { messageId: nextMessageId }),
      locked,
      state: redacted(),
      updatedAt: checkpointNow(),
    })
  }

  const saveCheckpoint = (
    phase: 'prepared' | 'bound' | 'terminal',
    delivery: 'pending' | 'delivered',
    nextMessageId: number | null,
  ): void => {
    if (input.checkpoint?.assertAuthorityHeld?.() === false) {
      throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
    }
    const next = checkpoint(phase, delivery, nextMessageId)
    if (next === null || input.checkpoint === undefined) return
    if (checkpointRevision === 0) input.checkpoint.store.begin(next)
    else {
      input.checkpoint.store.replace(next, {
        ownerId: input.checkpoint.ownerId,
        revision: checkpointRevision,
        bindingHash: input.checkpoint.bindingHash,
      })
    }
    checkpointRevision = next.revision
  }

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const stopHeartbeat = (): void => {
    if (heartbeat !== null) clearInterval(heartbeat)
    heartbeat = null
  }

  const startHeartbeat = (): void => {
    if (heartbeat !== null || heartbeatMs <= 0) return
    heartbeat = setInterval(() => {
      if (stopped || terminal || input.signal.aborted) { stopHeartbeat(); return }
      void queueFlush()
    }, heartbeatMs)
    heartbeat.unref?.()
  }

  const flush = async (): Promise<void> => {
    if (!started || stopped || (input.signal.aborted && !terminal)) return
    // Stamped at render time, not at event time: the operator is watching a
    // clock, and a clock that only moves when something happens is a lie.
    state.elapsedMs = Math.max(0, nowMs() - turnStartedAt)
    state.phaseMs = Math.max(0, nowMs() - phaseStartedAt)
    const html = renderExecution(state, { debug: input.debug === true }).html
    if (html === lastHtml) return
    const phase = terminal ? 'terminal' : messageId === null ? 'prepared' : 'bound'
    saveCheckpoint(phase, 'pending', messageId)
    if (input.checkpoint?.assertAuthorityHeld?.() === false) {
      throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
    }
    if (messageId === null) {
      const sentMessageId = await input.output.sendText(html)
      if (!Number.isSafeInteger(sentMessageId) || sentMessageId < 1) {
        throw new Error('INVALID_EXECUTION_MESSAGE_ID')
      }
      messageId = sentMessageId
    } else await input.output.editText(messageId, html)
    // Authority can disappear while awaiting Telegram. Preserve pending so a
    // replacement reconciles the ambiguous delivery window.
    if (input.checkpoint?.assertAuthorityHeld?.() === false) {
      throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
    }
    saveCheckpoint(terminal ? 'terminal' : 'bound', 'delivered', messageId)
    lastHtml = html
    lastWriteAt = nowMs()
  }

  const queueFlush = (strict = false): Promise<void> => {
    const current = tail.then(flush)
    tail = current.catch(() => undefined)
    return strict ? current : tail
  }

  const schedule = (immediate = false): Promise<void> => {
    if (immediate || interval === 0 || messageId === null || nowMs() - lastWriteAt >= interval) {
      clearTimer()
      return queueFlush()
    }
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null
        void queueFlush()
      }, Math.max(0, interval - (nowMs() - lastWriteAt)))
    }
    return tail
  }

  // Bridge calls are keyed by an opaque toolCallId; the card's elapsed-time
  // bookkeeping is keyed by a number, so they get a local sequence each.
  const bridgeSequences = new Map<string, number>()
  const bridgeNames = new Map<number, string>()
  let nextBridgeSequence = 1_000_000

  const tool = (
    event: Extract<TurnProgressEvent, {
      type: 'tool-pending' | 'tool-started' | 'tool-completed' | 'tool-denied' | 'tool-failed'
    }>,
    status: NonNullable<ToolView['status']>,
  ): void => {
    const elapsedMs = status === 'completed' || status === 'failed' || status === 'denied'
      ? Math.max(0, nowMs() - (startedAt.get(event.sequence) ?? nowMs()))
      : undefined
    const view: ToolView = {
      name: displayCapability(event.name),
      kind: event.category,
      status,
      ...(event.arg === undefined ? {} : { arg: event.arg }),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    }
    if (status === 'running') startedAt.set(event.sequence, nowMs())
    if (status === 'completed' || status === 'denied' || status === 'failed') {
      startedAt.delete(event.sequence)
      // Finished work moves into the log and stops being "current": the point
      // of the card is the sequence of steps, not only the latest one.
      const history = state.history ?? (state.history = [])
      history.push(view)
      if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY)
      delete state.tool
    } else {
      state.tool = view
    }
    phaseStartedAt = nowMs()
  }

  return Object.freeze<TelegramExecutionStream>({
    async prepare() {
      if (stopped || prepared) return
      if (input.signal.aborted) throw new Error('EXECUTION_STREAM_ABORTED')
      saveCheckpoint('prepared', 'pending', null)
      prepared = true
    },

    async cancel() {
      if (stopped || terminal) return
      clearTimer()
      stopHeartbeat()
      terminal = true
      state.status = 'stopped'
      state.thinking = false
      delete state.tool
      delete state.action
      saveCheckpoint('terminal', 'delivered', null)
    },

    async start() {
      if (stopped || started) return
      if (input.signal.aborted) throw new Error('EXECUTION_STREAM_ABORTED')
      if (!prepared) {
        saveCheckpoint('prepared', 'pending', null)
        prepared = true
      }
      started = true
      clearTimer()
      startHeartbeat()
      await queueFlush(true)
    },

    async handle(event) {
      if (stopped || input.signal.aborted) return
      if (event.type === 'outbound-lockout') {
        locked = event.locked
        if (locked) {
          delete state.tool
          delete state.action
          startedAt.clear()
          await schedule(true)
        }
        return
      }
      if (event.type === 'turn-started') {
        if (!started) { started = true; startHeartbeat() }
        await schedule(true)
        return
      }
      if (event.type === 'turn-usage') {
        state.usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          dollars: event.dollars,
        }
        await schedule()
        return
      }
      if (event.type === 'action-contract') {
        if (locked) return
        state.action = { kind: event.kind, status: 'required' }
        await schedule()
        return
      }
      if (event.type === 'action-recovery') {
        if (locked) return
        state.action = {
          kind: event.kind,
          status: 'recovering',
          missing: event.missing,
        }
        await schedule()
        return
      }
      if (locked) return
      // A subscription brain runs its own loop, so its calls arrive as
      // provider-owned tool-requested/tool-result instead of the loop's
      // lifecycle events. They are executed by Aisy all the same, so the card
      // must show them — otherwise the operator sees a silent turn.
      if (event.type === 'tool-requested' || event.type === 'tool-result') {
        const known = bridgeSequences.get(event.toolCallId)
        const sequence = known ?? nextBridgeSequence++
        if (known === undefined) bridgeSequences.set(event.toolCallId, sequence)
        const name = event.type === 'tool-requested' ? event.name : (bridgeNames.get(sequence) ?? 'tool')
        if (event.type === 'tool-requested') bridgeNames.set(sequence, event.name)
        tool(
          { type: 'tool-started', sequence, name, category: 'tool' },
          event.type === 'tool-requested' ? 'running' : 'completed',
        )
        if (event.type === 'tool-result') {
          bridgeSequences.delete(event.toolCallId)
          bridgeNames.delete(sequence)
        }
        await schedule()
        return
      }
      if (event.type === 'tool-pending') tool(event, 'pending')
      else if (event.type === 'tool-started') tool(event, 'running')
      else if (event.type === 'tool-completed') tool(event, 'completed')
      else if (event.type === 'tool-denied') tool(event, 'denied')
      else if (event.type === 'tool-failed') tool(event, 'failed')
      else return
      await schedule()
    },

    async complete(result) {
      if (!started || stopped) return
      clearTimer()
      stopHeartbeat()
      terminal = true
      // A locked turn deliberately drops action identity, but it must not also
      // erase the only trustworthy bit of terminal state. Reuse the existing
      // schema-compatible failed status so old checkpoints cannot turn an
      // unverified action into a durable success receipt after rollback.
      state.status = locked && result.state === 'ok' && result.actionStatus === 'unverified'
        ? 'failed'
        : terminalStatus(result)
      state.thinking = false
      if (locked) {
        delete state.tool
        delete state.action
      } else if (result.actionContractKind && result.actionStatus) {
        state.action = {
          kind: result.actionContractKind,
          status: result.actionStatus,
        }
      }
      await queueFlush(true)
    },

    async fail() {
      if (stopped || (!started && !prepared)) return
      clearTimer()
      stopHeartbeat()
      terminal = true
      state.status = 'failed'
      state.thinking = false
      if (locked) {
        delete state.tool
        delete state.action
      }
      if (!started) {
        saveCheckpoint('terminal', 'delivered', null)
        return
      }
      await queueFlush(true)
    },

    async stop() {
      stopped = true
      clearTimer()
      stopHeartbeat()
      await tail
    },
  })
}
