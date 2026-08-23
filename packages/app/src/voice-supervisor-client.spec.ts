import { describe, expect, it, vi } from 'vitest'

import type { ExecutionSupervisorFrame } from './execution-supervisor-ipc.js'
import { makeVoiceSupervisorClient } from './voice-supervisor-client.js'

const HASH = 'a'.repeat(64)
const SESSION = 's'.repeat(43)
const TICKET = 'm'.repeat(43)
const PERMIT = 'p'.repeat(43)
const RECOVERY = 'r'.repeat(43)

function harness(replies: ExecutionSupervisorFrame[]) {
  let sequence = 0
  const sent: ExecutionSupervisorFrame[] = []
  const exchange = vi.fn(async (frame: ExecutionSupervisorFrame) => {
    sent.push(frame)
    const reply = replies.shift()
    if (reply === undefined) throw new Error('lost')
    return { ...reply, requestId: frame.requestId, deadlineAtMs: frame.deadlineAtMs }
  })
  const port = makeVoiceSupervisorClient({
    sessionId: SESSION,
    timeoutMs: 60_000,
    dispatchTimeoutMs: 120_000,
    newRequestId: () => `voice-${++sequence}`,
    nowMs: () => 1_000,
    exchange,
  })
  return { port, sent, exchange }
}

const view = Object.freeze({
  audioRoot: '/private/media', relativePath: 'voice.ogg', expectedSha256: HASH,
  expectedSizeBytes: 10, maxBytes: 10, contentType: 'audio/ogg' as const,
  language: 'ru', mediaBindingHash: HASH, signal: new AbortController().signal,
})

function reply(value: Readonly<{ type: ExecutionSupervisorFrame['type'] }> &
Record<string, unknown>): ExecutionSupervisorFrame {
  return { version: 3, requestId: 'placeholder', deadlineAtMs: 61_000,
    sessionId: SESSION, ...value } as ExecutionSupervisorFrame
}

describe('voice supervisor child relay', () => {
  it('relays exact stage/prepare/dispatch without exposing the media root', async () => {
    const h = harness([
      reply({ type: 'voice-stage-ack', mediaBindingHash: HASH, ok: true,
        mediaTicket: TICKET, code: null }),
      reply({ type: 'voice-prepare-ack', mediaBindingHash: HASH, ok: true,
        dispatchPermitId: PERMIT, code: null }),
      reply({ type: 'voice-dispatch-ack', mediaBindingHash: HASH, ok: true,
        transcript: 'готово', language: 'ru', durationMs: 500, code: null, dispatch: null }),
    ])

    await expect(h.port.stageMedia(view)).resolves.toEqual({ ok: true, mediaTicket: TICKET })
    await expect(h.port.prepare({ mediaTicket: TICKET, reservationRecoveryKey: RECOVERY,
      signal: view.signal })).resolves.toEqual({ ok: true, dispatchPermitId: PERMIT })
    await expect(h.port.dispatch({ dispatchPermitId: PERMIT, signal: view.signal }))
      .resolves.toEqual({ ok: true, transcript: 'готово', language: 'ru', durationMs: 500 })

    expect(h.sent.map(frame => frame.type)).toEqual([
      'voice-stage', 'voice-prepare', 'voice-dispatch',
    ])
    expect(h.sent.map(frame => frame.deadlineAtMs)).toEqual([61_000, 61_000, 121_000])
    expect(JSON.stringify(h.sent)).not.toContain(view.audioRoot)
    expect(h.sent.every(frame => 'sessionId' in frame && frame.sessionId === SESSION)).toBe(true)
  })

  it('binds tickets and permits locally and burns dispatch before a lost reply', async () => {
    const h = harness([
      reply({ type: 'voice-stage-ack', mediaBindingHash: HASH, ok: true,
        mediaTicket: TICKET, code: null }),
      reply({ type: 'voice-prepare-ack', mediaBindingHash: HASH, ok: true,
        dispatchPermitId: PERMIT, code: null }),
    ])
    await h.port.stageMedia(view)
    await h.port.prepare({ mediaTicket: TICKET, reservationRecoveryKey: RECOVERY,
      signal: view.signal })

    await expect(h.port.dispatch({ dispatchPermitId: PERMIT, signal: view.signal }))
      .rejects.toThrow('lost')
    await expect(h.port.dispatch({ dispatchPermitId: PERMIT, signal: view.signal }))
      .resolves.toEqual({ ok: false, code: 'PROTOCOL_REFUSED', dispatch: 'none' })
    expect(h.exchange).toHaveBeenCalledTimes(3)
  })

  it('refuses foreign local authority without sending a frame', async () => {
    const h = harness([])
    await expect(h.port.prepare({ mediaTicket: TICKET, reservationRecoveryKey: RECOVERY,
      signal: view.signal })).resolves.toEqual({ ok: false, code: 'PROTOCOL_REFUSED' })
    await expect(h.port.cancelPrepared({ dispatchPermitId: PERMIT })).resolves.toBe('ambiguous')
    expect(h.sent).toEqual([])
  })
})
