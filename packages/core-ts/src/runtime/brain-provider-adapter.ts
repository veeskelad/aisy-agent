import type {
  ModelProgressEvent,
  ModelProgressSink,
  ModelRequest,
  ModelResponse,
  ProviderAdapter,
  ProviderError,
  TurnUsage,
} from '../agent-loop/types.js'
import type { BrainDriver, BrainEvent } from '../onboarding/brain-connections.js'

const MAX_REPLY_BYTES = 4 * 1024 * 1024
const DEFAULT_TERMINAL_CLOSE_TIMEOUT_MS = 1_000
const MAX_TERMINAL_CLOSE_TIMEOUT_MS = 60_000
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/

class BrainProviderError extends Error implements ProviderError {
  readonly kind = 'server-error' as const

  constructor(code: string) {
    super(code)
    this.name = 'BrainProviderError'
  }
}

function usageOf(event: Extract<BrainEvent, { type: 'usage' }>): TurnUsage {
  if (!Number.isSafeInteger(event.inputTokens) || event.inputTokens < 0 ||
    !Number.isSafeInteger(event.outputTokens) || event.outputTokens < 0 ||
    (event.dollars !== undefined && (!Number.isFinite(event.dollars) || event.dollars < 0))) {
    throw new BrainProviderError('BRAIN_USAGE_REJECTED')
  }
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    dollars: event.dollars ?? 0,
  }
}

async function forward(
  event: BrainEvent,
  sink: ModelProgressSink | undefined,
): Promise<void> {
  if (sink === undefined) return
  if (event.type === 'started' || event.type === 'thinking' ||
    event.type === 'text-delta' || event.type === 'tool-requested' ||
    event.type === 'tool-result' || event.type === 'usage') {
    await sink(event satisfies ModelProgressEvent)
  }
}

async function nextDriverEvent(
  iterator: AsyncIterator<BrainEvent>,
): Promise<IteratorResult<BrainEvent>> {
  try {
    return await iterator.next()
  } catch {
    throw new BrainProviderError('BRAIN_DRIVER_FAILED')
  }
}

async function nextAfterTerminal(
  iterator: AsyncIterator<BrainEvent>,
  timeoutMs: number,
): Promise<{ kind: 'next'; result: IteratorResult<BrainEvent> } | { kind: 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ kind: 'timeout' }>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })
  try {
    return await Promise.race([
      nextDriverEvent(iterator).then(result => ({ kind: 'next' as const, result })),
      timeout,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function closeIterator(iterator: AsyncIterator<BrainEvent>, timeoutMs: number): Promise<void> {
  if (iterator.return === undefined) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const closed = Promise.resolve(iterator.return()).then(() => undefined, () => undefined)
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs)
    })
    await Promise.race([closed, timeout])
  } catch { /* cleanup is best-effort and never exposes driver detail */ } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Adapts a supervised, read-only subscription brain to the owned agent loop.
 * Native tool/approval events are rejected here: action-capable runtimes must
 * use the typed Aisy capability bridge instead of executing a second opaque loop.
 */
function makeBrainProviderAdapter(input: {
  driver: BrainDriver
  projectId: string
  terminalCloseTimeoutMs?: number
}, allowAisyCapabilities: boolean): ProviderAdapter {
  if (!SAFE_ID.test(input.projectId)) throw new Error('INVALID_BRAIN_PROVIDER_CONFIG')
  const terminalCloseTimeoutMs = input.terminalCloseTimeoutMs ?? DEFAULT_TERMINAL_CLOSE_TIMEOUT_MS
  if (!Number.isInteger(terminalCloseTimeoutMs) || terminalCloseTimeoutMs < 1 ||
    terminalCloseTimeoutMs > MAX_TERMINAL_CLOSE_TIMEOUT_MS) {
    throw new Error('INVALID_BRAIN_PROVIDER_CONFIG')
  }

  return Object.freeze<ProviderAdapter>({
    async complete(
      request: ModelRequest,
      signal?: AbortSignal,
      onProgress?: ModelProgressSink,
    ): Promise<ModelResponse> {
      const effectiveSignal = signal ?? new AbortController().signal
      let reply: string | null = null
      let terminalError: BrainProviderError | null = null
      let usage: TurnUsage | undefined
      let streamedBytes = 0
      let phase: 'idle' | 'started' | 'terminal' = 'idle'
      let usageSeen = false

      let iterable: AsyncIterable<BrainEvent>
      let iterator: AsyncIterator<BrainEvent>
      try {
        iterable = input.driver.run({
          request,
          projectId: input.projectId,
          sessionId: request.sessionId,
        }, effectiveSignal)
        iterator = iterable[Symbol.asyncIterator]()
      } catch {
        throw new BrainProviderError('BRAIN_DRIVER_FAILED')
      }

      let iteratorDone = false
      try {
        for (;;) {
          const step = await nextDriverEvent(iterator)
          if (step.done) {
            iteratorDone = true
            break
          }
          const event = step.value
          if (effectiveSignal.aborted) throw new BrainProviderError('BRAIN_TURN_INTERRUPTED')
          if (event.type === 'approval-required' ||
            (!allowAisyCapabilities &&
              (event.type === 'tool-requested' || event.type === 'tool-result'))) {
            throw new BrainProviderError('BRAIN_NATIVE_CAPABILITY_REJECTED')
          }
          if (event.type === 'started') {
            if (phase !== 'idle') throw new BrainProviderError('BRAIN_EVENT_SEQUENCE_REJECTED')
            phase = 'started'
            await forward(event, onProgress)
            continue
          }
          // Detection/auth/session failures happen before a model turn exists,
          // so the driver has no truthful `started` event to emit.
          if (event.type === 'failed' && phase === 'idle') {
            terminalError = new BrainProviderError(
              SAFE_ERROR_CODE.test(event.errorCode) ? event.errorCode : 'BRAIN_TURN_FAILED',
            )
            phase = 'terminal'
          }
          if (phase !== 'started') {
            if (phase !== 'terminal') throw new BrainProviderError('BRAIN_EVENT_SEQUENCE_REJECTED')
          } else if (event.type === 'failed') {
            terminalError = new BrainProviderError(
              SAFE_ERROR_CODE.test(event.errorCode) ? event.errorCode : 'BRAIN_TURN_FAILED',
            )
            phase = 'terminal'
          } else if (event.type === 'completed') {
            if (Buffer.byteLength(event.reply, 'utf8') > MAX_REPLY_BYTES) {
              throw new BrainProviderError('BRAIN_OUTPUT_REJECTED')
            }
            reply = event.reply
            phase = 'terminal'
          } else {
            if (event.type === 'text-delta') {
              streamedBytes += Buffer.byteLength(event.text, 'utf8')
              if (streamedBytes > MAX_REPLY_BYTES) {
                throw new BrainProviderError('BRAIN_OUTPUT_REJECTED')
              }
            }
            if (event.type === 'usage') {
              if (usageSeen) throw new BrainProviderError('BRAIN_EVENT_SEQUENCE_REJECTED')
              usageSeen = true
              usage = usageOf(event)
            }
            await forward(event, onProgress)
          }

          if (phase === 'terminal') {
            const closed = await nextAfterTerminal(iterator, terminalCloseTimeoutMs)
            if (closed.kind === 'timeout') {
              throw new BrainProviderError('BRAIN_EVENT_STREAM_NOT_CLOSED')
            }
            if (!closed.result.done) {
              throw new BrainProviderError('BRAIN_EVENT_SEQUENCE_REJECTED')
            }
            iteratorDone = true
            break
          }
        }
      } finally {
        if (!iteratorDone) await closeIterator(iterator, terminalCloseTimeoutMs)
      }

      if (phase !== 'terminal') throw new BrainProviderError('BRAIN_STREAM_ENDED')
      if (terminalError !== null) throw terminalError
      if (reply === null) throw new BrainProviderError('BRAIN_EVENT_SEQUENCE_REJECTED')
      return { reply, ...(usage === undefined ? {} : { usage }) }
    },
  })
}

export function makeReadOnlyBrainProviderAdapter(input: {
  driver: BrainDriver
  projectId: string
  terminalCloseTimeoutMs?: number
}): ProviderAdapter {
  return makeBrainProviderAdapter(input, false)
}

/** Allows only capability events already executed through the Aisy bridge. */
export function makeAisyCapabilityBrainProviderAdapter(input: {
  driver: BrainDriver
  projectId: string
  terminalCloseTimeoutMs?: number
}): ProviderAdapter {
  return makeBrainProviderAdapter(input, true)
}
