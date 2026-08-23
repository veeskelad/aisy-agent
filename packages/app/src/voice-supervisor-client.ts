import type {
  DeepgramProxyPort,
  DeepgramProxyResult,
} from './deepgram-proxy-provider.js'
import type {
  ExecutionSupervisorFrame,
  ExecutionSupervisorFrameType,
} from './execution-supervisor-ipc.js'

const HASH = /^[a-f0-9]{64}$/
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

type SessionFrame = Extract<ExecutionSupervisorFrame, { sessionId: string }>

interface VoiceSupervisorClientOptions {
  readonly sessionId: string
  readonly timeoutMs: number
  readonly dispatchTimeoutMs: number
  readonly newRequestId: () => string
  readonly nowMs: () => number
  readonly exchange: (
    frame: SessionFrame,
    expected: ExecutionSupervisorFrameType,
    timeoutMs: number,
  ) => Promise<ExecutionSupervisorFrame>
}

function request(
  options: VoiceSupervisorClientOptions,
  type: SessionFrame['type'],
  fields: Record<string, unknown>,
  timeoutMs = options.timeoutMs,
): SessionFrame {
  const requestId = options.newRequestId()
  const now = options.nowMs()
  if (!REQUEST_ID.test(requestId) || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('VOICE_SUPERVISOR_UNAVAILABLE')
  }
  return {
    version: 3,
    type,
    requestId,
    deadlineAtMs: now + timeoutMs,
    sessionId: options.sessionId,
    ...fields,
  } as SessionFrame
}

/** Child-side relay. It never exposes the parent broker channel or media root. */
export function makeVoiceSupervisorClient(options: VoiceSupervisorClientOptions): DeepgramProxyPort {
  const tickets = new Map<string, string>()
  const permits = new Map<string, string>()
  const port: DeepgramProxyPort = {
    async stageMedia(input) {
      if (input.signal.aborted || !HASH.test(input.mediaBindingHash)) {
        return { ok: false as const, code: 'PROTOCOL_REFUSED' as const }
      }
      const reply = await options.exchange(request(options, 'voice-stage', {
        mediaBindingHash: input.mediaBindingHash,
        relativePath: input.relativePath,
        expectedSha256: input.expectedSha256,
        expectedSizeBytes: input.expectedSizeBytes,
        maxBytes: input.maxBytes,
        contentType: input.contentType,
        language: input.language ?? null,
      }), 'voice-stage-ack', options.timeoutMs)
      if (reply.type !== 'voice-stage-ack' || reply.mediaBindingHash !== input.mediaBindingHash) {
        throw new Error('VOICE_SUPERVISOR_UNAVAILABLE')
      }
      if (!reply.ok) return { ok: false as const, code: reply.code! }
      tickets.set(reply.mediaTicket!, input.mediaBindingHash)
      return { ok: true as const, mediaTicket: reply.mediaTicket! }
    },

    async cancelMedia(input) {
      const mediaBindingHash = tickets.get(input.mediaTicket)
      if (mediaBindingHash === undefined) throw new Error('VOICE_SUPERVISOR_UNAVAILABLE')
      tickets.delete(input.mediaTicket)
      const reply = await options.exchange(request(options, 'voice-cancel-media', {
        mediaBindingHash,
        mediaTicket: input.mediaTicket,
      }), 'voice-cancel-media-ack', options.timeoutMs)
      if (reply.type !== 'voice-cancel-media-ack' ||
        reply.mediaBindingHash !== mediaBindingHash || !reply.ok) {
        throw new Error('VOICE_SUPERVISOR_UNAVAILABLE')
      }
    },

    async prepare(input) {
      const mediaBindingHash = tickets.get(input.mediaTicket)
      if (input.signal.aborted || mediaBindingHash === undefined) {
        return { ok: false as const, code: 'PROTOCOL_REFUSED' as const }
      }
      const reply = await options.exchange(request(options, 'voice-prepare', {
        mediaBindingHash,
        mediaTicket: input.mediaTicket,
        reservationRecoveryKey: input.reservationRecoveryKey,
      }), 'voice-prepare-ack', options.timeoutMs)
      if (reply.type !== 'voice-prepare-ack' || reply.mediaBindingHash !== mediaBindingHash) {
        throw new Error('VOICE_SUPERVISOR_UNAVAILABLE')
      }
      if (!reply.ok) return { ok: false as const, code: reply.code! }
      tickets.delete(input.mediaTicket)
      permits.set(reply.dispatchPermitId!, mediaBindingHash)
      return { ok: true as const, dispatchPermitId: reply.dispatchPermitId! }
    },

    async cancelPrepared(input) {
      const mediaBindingHash = permits.get(input.dispatchPermitId)
      if (mediaBindingHash === undefined) return 'ambiguous'
      permits.delete(input.dispatchPermitId)
      const reply = await options.exchange(request(options, 'voice-cancel-prepared', {
        mediaBindingHash,
        dispatchPermitId: input.dispatchPermitId,
      }), 'voice-cancel-prepared-ack', options.timeoutMs)
      if (reply.type !== 'voice-cancel-prepared-ack' ||
        reply.mediaBindingHash !== mediaBindingHash) return 'ambiguous'
      return reply.outcome
    },

    async dispatch(input) {
      const mediaBindingHash = permits.get(input.dispatchPermitId)
      if (input.signal.aborted || mediaBindingHash === undefined) {
        return { ok: false as const, code: 'PROTOCOL_REFUSED' as const, dispatch: 'none' as const }
      }
      // A lost reply is ambiguous. Burn local authority before the exchange.
      permits.delete(input.dispatchPermitId)
      const reply = await options.exchange(request(options, 'voice-dispatch', {
        mediaBindingHash,
        dispatchPermitId: input.dispatchPermitId,
      }, options.dispatchTimeoutMs), 'voice-dispatch-ack', options.dispatchTimeoutMs)
      if (reply.type !== 'voice-dispatch-ack' || reply.mediaBindingHash !== mediaBindingHash) {
        throw new Error('VOICE_SUPERVISOR_UNAVAILABLE')
      }
      if (!reply.ok) return Object.freeze({
        ok: false, code: reply.code!, dispatch: reply.dispatch!,
      }) satisfies DeepgramProxyResult
      return Object.freeze({
        ok: true,
        transcript: reply.transcript!,
        ...(reply.language === null ? {} : { language: reply.language }),
        durationMs: reply.durationMs!,
      }) satisfies DeepgramProxyResult
    },
  }
  return Object.freeze(port)
}
