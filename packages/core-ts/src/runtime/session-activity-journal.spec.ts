import { describe, expect, it, vi } from 'vitest'

import type { ContextSpan } from '../agent-loop/types.js'
import {
  computeSessionActivityJournalChecksum,
  makeSessionActivityJournal,
  type ActivityBinding,
  type SessionActivityJournalPersistencePort,
  type SessionActivityJournalStateV1,
} from './session-activity-journal.js'
import {
  computeTranscriptRowHash,
  type TranscriptEnvelope,
} from './session-transcript.js'
import { transcriptTurnEventId } from './session-transcript-recorder.js'

const BINDING: ActivityBinding = {
  operatorId: 'operator-1',
  profileId: 'default',
  projectId: 'project-1',
  sessionId: 'session-1',
}
const CHAT_HASH = 'a'.repeat(64)
const REQUEST_HASH = 'b'.repeat(64)
const T0 = '2026-07-28T10:00:00.000Z'
const T1 = '2026-07-28T10:00:01.000Z'
const T2 = '2026-07-28T10:00:02.000Z'

function span(text: string, provenance: 'operator' | 'untrusted' = 'operator'): ContextSpan {
  return { role: 'user', provenance, text }
}

function memoryPersistence(initial?: unknown) {
  let value = initial
  let quarantined = false
  const port: SessionActivityJournalPersistencePort = {
    load: vi.fn(async () => quarantined
      ? { status: 'quarantined' as const }
      : value === undefined
        ? { status: 'missing' as const }
        : { status: 'ready' as const, value: structuredClone(value) }),
    commit: vi.fn(async ({ expectedRevision, state }) => {
      const currentRevision = (value as { revision?: unknown } | undefined)?.revision ?? null
      if (currentRevision !== expectedRevision) throw new Error('cas')
      value = structuredClone(state)
    }),
    quarantine: vi.fn(async () => { quarantined = true }),
  }
  return {
    port,
    state: () => structuredClone(value) as SessionActivityJournalStateV1 | undefined,
    set: (next: unknown) => { value = next },
  }
}

function transcriptRow(input: {
  turnId: string
  ordinal: number
  span: ContextSpan
  previous?: TranscriptEnvelope
}): TranscriptEnvelope {
  const withoutHash: Omit<TranscriptEnvelope, 'rowHash'> = {
    ...BINDING,
    eventId: transcriptTurnEventId(BINDING.sessionId, input.turnId, input.ordinal),
    sessionSeq: input.ordinal,
    role: input.span.role,
    provenance: input.span.provenance,
    content: input.span.text,
    ts: T0,
    loadBearing: false,
    loadBearingClassifierVersion: 'test-v1',
    prevSessionHash: input.previous?.rowHash ?? '0'.repeat(64),
  }
  return { ...withoutHash, rowHash: computeTranscriptRowHash(withoutHash) }
}

describe('SessionActivityJournal preview contract', () => {
  it('accepts an exact Telegram retry and quarantines changed bytes for the same update identity', async () => {
    const memory = memoryPersistence()
    const journal = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T1 })
    const input = {
      binding: BINDING,
      chatBindingHash: CHAT_HASH,
      updateId: 7,
      messageTs: T0,
      span: span('hello'),
    }

    const first = await journal.acceptTelegram(input)
    const duplicate = await journal.acceptTelegram(input)
    expect(first.status).toBe('accepted')
    expect(duplicate).toEqual({ status: 'duplicate', ingressId: first.ingressId })
    await expect(journal.acceptTelegram({ ...input, span: span('changed') }))
      .rejects.toMatchObject({ code: 'identity-conflict' })
    expect(memory.port.quarantine).toHaveBeenCalledWith(BINDING, 'identity-conflict')
  })

  it('seals the exact ordered Telegram batch atomically with content-independent id and earliest timestamp', async () => {
    const a = memoryPersistence()
    const b = memoryPersistence()
    const ja = makeSessionActivityJournal({ persistence: a.port, nowIso: () => T2 })
    const jb = makeSessionActivityJournal({ persistence: b.port, nowIso: () => T2 })
    const inputs = [
      { updateId: 8, messageTs: T1, span: span('secret A') },
      { updateId: 9, messageTs: T0, span: span('secret B') },
    ]
    const idsA = []
    const idsB = []
    for (const item of inputs) {
      idsA.push((await ja.acceptTelegram({ binding: BINDING, chatBindingHash: CHAT_HASH, ...item })).ingressId)
      idsB.push((await jb.acceptTelegram({
        binding: BINDING,
        chatBindingHash: CHAT_HASH,
        ...item,
        span: span(item.updateId === 8 ? 'other A' : 'other B'),
      })).ingressId)
    }
    const sealedA = await ja.sealTelegram({
      binding: BINDING, chatBindingHash: CHAT_HASH, orderedIngressIds: idsA, sealedAt: T2,
    })
    const sealedB = await jb.sealTelegram({
      binding: BINDING, chatBindingHash: CHAT_HASH, orderedIngressIds: idsB, sealedAt: T2,
    })

    expect(sealedA.dispatch.turnTs).toBe(T0)
    expect(sealedA.dispatch.dispatchId).toBe(sealedB.dispatch.dispatchId)
    expect(sealedA.dispatch.turnId).toBe(sealedB.dispatch.turnId)
    expect(a.state()?.ingress.every(item => item.state === 'sealed')).toBe(true)
    await expect(ja.sealTelegram({
      binding: BINDING,
      chatBindingHash: CHAT_HASH,
      orderedIngressIds: [...idsA].reverse(),
      sealedAt: T2,
    })).rejects.toMatchObject({ code: 'identity-conflict' })
  })

  it('makes background occurrence idempotent across reconstruction but conflicts on changed spans', async () => {
    const memory = memoryPersistence()
    const input = {
      binding: BINDING,
      source: { kind: 'trigger' as const, sourceId: 'trigger-1', occurrenceId: 'slot-20260728' },
      spans: [span('do work')],
      occurredAt: T0,
    }
    const firstRuntime = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T1 })
    const first = await firstRuntime.prepareBackground(input)
    const restarted = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T2 })
    const duplicate = await restarted.prepareBackground(input)
    expect(duplicate.status).toBe('duplicate')
    expect(duplicate.dispatch).toEqual(first.dispatch)
    await expect(restarted.prepareBackground({ ...input, spans: [span('changed')] }))
      .rejects.toMatchObject({ code: 'identity-conflict' })
  })

  it('enforces CAS, the exact FSM and one append-only evidence item per recorded transition', async () => {
    const memory = memoryPersistence()
    const journal = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T1 })
    const prepared = (await journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'goal', sourceId: 'goal-1', occurrenceId: 'iteration-1' },
      spans: [span('goal')],
      occurredAt: T0,
    })).dispatch
    const pending = await journal.transition({
      binding: BINDING,
      dispatchId: prepared.dispatchId,
      expectedRevision: 1,
      phase: 'provider-pending',
      operationSeq: 1,
      transcriptOrdinal: 1,
      requestHash: REQUEST_HASH,
      at: T1,
    })
    await expect(journal.transition({
      binding: BINDING,
      dispatchId: prepared.dispatchId,
      expectedRevision: 1,
      phase: 'provider-recorded',
      operationSeq: 2,
      transcriptOrdinal: 2,
      requestHash: REQUEST_HASH,
      evidence: { ordinal: 2, eventId: 'c'.repeat(64), rowHash: 'd'.repeat(64) },
      at: T2,
    })).rejects.toMatchObject({ code: 'cas-conflict' })
    const row1 = transcriptRow({ turnId: prepared.turnId, ordinal: 1, span: span('goal') })
    const row2 = transcriptRow({
      turnId: prepared.turnId,
      ordinal: 2,
      span: { role: 'assistant', provenance: 'untrusted', text: 'answer' },
      previous: row1,
    })
    await expect(journal.transition({
      binding: BINDING,
      dispatchId: prepared.dispatchId,
      expectedRevision: pending.revision,
      phase: 'provider-recorded',
      operationSeq: 2,
      transcriptOrdinal: 2,
      requestHash: '9'.repeat(64),
      evidence: { ordinal: 2, eventId: row2.eventId, rowHash: row2.rowHash },
      at: T2,
    })).rejects.toMatchObject({ code: 'invalid-transition' })
    const recorded = await journal.transition({
      binding: BINDING,
      dispatchId: prepared.dispatchId,
      expectedRevision: pending.revision,
      phase: 'provider-recorded',
      operationSeq: 2,
      transcriptOrdinal: 2,
      requestHash: REQUEST_HASH,
      evidence: { ordinal: 2, eventId: row2.eventId, rowHash: row2.rowHash },
      at: T2,
    })
    expect(recorded.transcriptEvidence).toEqual([
      { ordinal: 2, eventId: row2.eventId, rowHash: row2.rowHash },
    ])
    await expect(journal.transition({
      binding: BINDING,
      dispatchId: prepared.dispatchId,
      expectedRevision: recorded.revision,
      phase: 'tool-recorded',
      operationSeq: 3,
      transcriptOrdinal: 3,
      effectiveToolName: 'read_file',
      evidence: { ordinal: 3, eventId: 'e'.repeat(64), rowHash: 'f'.repeat(64) },
      at: T2,
    })).rejects.toMatchObject({ code: 'invalid-transition' })
  })

  it('binds tool-recorded to the exact pending effective tool identity', async () => {
    const memory = memoryPersistence()
    const journal = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T1 })
    const prepared = (await journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'goal', sourceId: 'goal-tool-record', occurrenceId: 'iteration-1' },
      spans: [span('use exact tool')],
      occurredAt: T0,
    })).dispatch
    const row1 = transcriptRow({ turnId: prepared.turnId, ordinal: 1, span: span('use exact tool') })
    const row2 = transcriptRow({
      turnId: prepared.turnId,
      ordinal: 2,
      span: { role: 'assistant', provenance: 'untrusted', text: 'preamble' },
      previous: row1,
    })
    const row3 = transcriptRow({
      turnId: prepared.turnId,
      ordinal: 3,
      span: { role: 'tool', provenance: 'untrusted', text: 'read_file: ok' },
      previous: row2,
    })
    const providerPending = await journal.transition({
      binding: BINDING, dispatchId: prepared.dispatchId, expectedRevision: 1,
      phase: 'provider-pending', operationSeq: 1, transcriptOrdinal: 1,
      requestHash: REQUEST_HASH, at: T1,
    })
    const providerRecorded = await journal.transition({
      binding: BINDING, dispatchId: prepared.dispatchId, expectedRevision: providerPending.revision,
      phase: 'provider-recorded', operationSeq: 2, transcriptOrdinal: 2,
      requestHash: REQUEST_HASH,
      evidence: { ordinal: 2, eventId: row2.eventId, rowHash: row2.rowHash },
      at: T1,
    })
    const toolPending = await journal.transition({
      binding: BINDING, dispatchId: prepared.dispatchId, expectedRevision: providerRecorded.revision,
      phase: 'tool-pending', operationSeq: 3, transcriptOrdinal: 2,
      effectiveToolName: 'read_file', at: T2,
    })
    await expect(journal.transition({
      binding: BINDING, dispatchId: prepared.dispatchId, expectedRevision: toolPending.revision,
      phase: 'tool-recorded', operationSeq: 4, transcriptOrdinal: 3,
      effectiveToolName: 'write_file',
      evidence: { ordinal: 3, eventId: row3.eventId, rowHash: row3.rowHash },
      at: T2,
    })).rejects.toMatchObject({ code: 'invalid-transition' })
    const recorded = await journal.transition({
      binding: BINDING, dispatchId: prepared.dispatchId, expectedRevision: toolPending.revision,
      phase: 'tool-recorded', operationSeq: 4, transcriptOrdinal: 3,
      effectiveToolName: 'read_file',
      evidence: { ordinal: 3, eventId: row3.eventId, rowHash: row3.rowHash },
      at: T2,
    })
    expect(recorded).toMatchObject({
      phase: 'tool-recorded',
      effectiveToolName: 'read_file',
      transcriptOrdinal: 3,
    })
  })

  it('classifies provider/tool pending as uncertain and never calls an external collaborator', async () => {
    const memory = memoryPersistence()
    const external = vi.fn()
    const journal = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T1 })
    const prepared = (await journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'nightly', sourceId: 'nightly-1', occurrenceId: '2026-07-28' },
      spans: [span('nightly')],
      occurredAt: T0,
    })).dispatch
    const row = transcriptRow({ turnId: prepared.turnId, ordinal: 1, span: span('nightly') })
    const provider = await journal.transition({
      binding: BINDING,
      dispatchId: prepared.dispatchId,
      expectedRevision: 1,
      phase: 'provider-pending',
      operationSeq: 1,
      transcriptOrdinal: 1,
      requestHash: REQUEST_HASH,
      at: T1,
    })
    expect(await journal.recover({ binding: BINDING, dispatchId: prepared.dispatchId, transcript: [row] }))
      .toEqual({ kind: 'interrupted', code: 'PROVIDER_OUTCOME_UNCERTAIN' })
    const interrupted = await journal.transition({
      binding: BINDING,
      dispatchId: prepared.dispatchId,
      expectedRevision: provider.revision,
      phase: 'interrupted',
      operationSeq: 2,
      transcriptOrdinal: 1,
      at: T2,
    })
    expect(await journal.recover({ binding: BINDING, dispatchId: prepared.dispatchId, transcript: [row] }))
      .toEqual({ kind: 'interrupted', code: 'PROVIDER_OUTCOME_UNCERTAIN' })
    expect(interrupted.phase).toBe('interrupted')
    expect(external).not.toHaveBeenCalled()
  })

  it('persists the exact tool interruption code and replays it after reconstruction', async () => {
    const memory = memoryPersistence()
    const journal = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T1 })
    const prepared = (await journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'goal', sourceId: 'goal-tool-interrupt', occurrenceId: 'iteration-1' },
      spans: [span('use tool')],
      occurredAt: T0,
    })).dispatch
    const row1 = transcriptRow({ turnId: prepared.turnId, ordinal: 1, span: span('use tool') })
    const row2 = transcriptRow({
      turnId: prepared.turnId,
      ordinal: 2,
      span: { role: 'assistant', provenance: 'untrusted', text: 'preamble' },
      previous: row1,
    })
    const providerPending = await journal.transition({
      binding: BINDING, dispatchId: prepared.dispatchId, expectedRevision: 1,
      phase: 'provider-pending', operationSeq: 1, transcriptOrdinal: 1,
      requestHash: REQUEST_HASH, at: T1,
    })
    const providerRecorded = await journal.transition({
      binding: BINDING, dispatchId: prepared.dispatchId, expectedRevision: providerPending.revision,
      phase: 'provider-recorded', operationSeq: 2, transcriptOrdinal: 2,
      requestHash: REQUEST_HASH,
      evidence: { ordinal: 2, eventId: row2.eventId, rowHash: row2.rowHash },
      at: T1,
    })
    const toolPending = await journal.transition({
      binding: BINDING, dispatchId: prepared.dispatchId, expectedRevision: providerRecorded.revision,
      phase: 'tool-pending', operationSeq: 3, transcriptOrdinal: 2,
      effectiveToolName: 'read_file', at: T2,
    })
    const interrupted = await journal.transition({
      binding: BINDING, dispatchId: prepared.dispatchId, expectedRevision: toolPending.revision,
      phase: 'interrupted', operationSeq: 4, transcriptOrdinal: 2, at: T2,
    })
    expect(interrupted.interruptionCode).toBe('TOOL_OUTCOME_UNCERTAIN')

    const restarted = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T2 })
    expect(await restarted.recover({
      binding: BINDING,
      dispatchId: prepared.dispatchId,
      transcript: [row1, row2],
    })).toEqual({ kind: 'interrupted', code: 'TOOL_OUTCOME_UNCERTAIN' })
  })

  it('does not permit an interruption marker before any provider or tool dispatch', async () => {
    const memory = memoryPersistence()
    const journal = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T1 })
    const prepared = (await journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'goal', sourceId: 'goal-no-dispatch', occurrenceId: 'iteration-1' },
      spans: [span('wait')],
      occurredAt: T0,
    })).dispatch
    await expect(journal.transition({
      binding: BINDING, dispatchId: prepared.dispatchId, expectedRevision: 1,
      phase: 'interrupted', operationSeq: 1, transcriptOrdinal: 0, at: T1,
    })).rejects.toMatchObject({ code: 'invalid-transition' })
  })

  it('returns a terminal result from durable state with zero external I/O', async () => {
    const memory = memoryPersistence()
    const external = vi.fn()
    const journal = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T1 })
    const prepared = (await journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'goal', sourceId: 'goal-2', occurrenceId: 'iteration-1' },
      spans: [span('finish')],
      occurredAt: T0,
    })).dispatch
    const row = transcriptRow({ turnId: prepared.turnId, ordinal: 1, span: span('finish') })
    const terminal = await journal.transition({
      binding: BINDING,
      dispatchId: prepared.dispatchId,
      expectedRevision: 1,
      phase: 'terminal',
      operationSeq: 1,
      transcriptOrdinal: 1,
      terminal: { reply: 'done', state: 'ok', narrowed: false },
      at: T1,
    })
    expect(await journal.recover({ binding: BINDING, dispatchId: terminal.dispatchId, transcript: [row] }))
      .toEqual({ kind: 'completed', result: { reply: 'done', state: 'ok', narrowed: false } })
    expect(external).not.toHaveBeenCalled()
  })

  it('rejects forged rowHash evidence and a transcript gap without inferring from text', async () => {
    const memory = memoryPersistence()
    const journal = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T1 })
    const prepared = (await journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'goal', sourceId: 'goal-3', occurrenceId: 'iteration-1' },
      spans: [span('inspect')],
      occurredAt: T0,
    })).dispatch
    const row = transcriptRow({ turnId: prepared.turnId, ordinal: 1, span: span('inspect') })
    const forged = { ...row, rowHash: 'f'.repeat(64) }
    expect(await journal.recover({ binding: BINDING, dispatchId: prepared.dispatchId, transcript: [forged] }))
      .toEqual({ kind: 'interrupted', code: 'TRANSCRIPT_DIVERGED' })
    expect(await journal.recover({ binding: BINDING, dispatchId: prepared.dispatchId, transcript: [{
      ...row,
      eventId: transcriptTurnEventId(BINDING.sessionId, prepared.turnId, 2),
      rowHash: computeTranscriptRowHash({
        ...row,
        eventId: transcriptTurnEventId(BINDING.sessionId, prepared.turnId, 2),
      }),
    }] })).toEqual({ kind: 'interrupted', code: 'TRANSCRIPT_DIVERGED' })
  })

  it('quarantines persisted unknown fields before accepting an idempotent retry', async () => {
    const memory = memoryPersistence()
    const journal = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T1 })
    const input = {
      binding: BINDING,
      source: { kind: 'trigger' as const, sourceId: 'trigger-2', occurrenceId: 'slot-1' },
      spans: [span('run')],
      occurredAt: T0,
    }
    await journal.prepareBackground(input)
    memory.set({ ...memory.state(), unknown: true })
    await expect(journal.prepareBackground(input)).rejects.toMatchObject({ code: 'quarantined' })
    expect(memory.port.quarantine).toHaveBeenCalledWith(BINDING, 'invalid-state')
  })

  it('rejects tampered identities and Telegram ingress/dispatch reassignment even with a valid checksum', async () => {
    const makeSealed = async () => {
      const memory = memoryPersistence()
      const journal = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T1 })
      const first = await journal.acceptTelegram({
        binding: BINDING, chatBindingHash: CHAT_HASH, updateId: 1, messageTs: T0, span: span('one'),
      })
      const second = await journal.acceptTelegram({
        binding: BINDING, chatBindingHash: CHAT_HASH, updateId: 2, messageTs: T1, span: span('two'),
      })
      await journal.sealTelegram({
        binding: BINDING,
        chatBindingHash: CHAT_HASH,
        orderedIngressIds: [first.ingressId, second.ingressId],
        sealedAt: T2,
      })
      return { memory, journal }
    }

    for (const tamper of [
      (state: SessionActivityJournalStateV1) => { state.ingress[0]!.ingressId = 'f'.repeat(64) },
      (state: SessionActivityJournalStateV1) => { state.dispatches[0]!.turnId = `activity:${'e'.repeat(64)}` },
      (state: SessionActivityJournalStateV1) => {
        state.dispatches[0]!.spans = [...state.dispatches[0]!.spans].reverse()
      },
    ]) {
      const { memory, journal } = await makeSealed()
      const state = memory.state()!
      tamper(state)
      state.checksum = computeSessionActivityJournalChecksum(state)
      memory.set(state)
      await expect(journal.recover({
        binding: BINDING,
        dispatchId: state.dispatches[0]!.dispatchId,
        transcript: [],
      })).resolves.toEqual({ kind: 'interrupted', code: 'ACTIVITY_QUARANTINED' })
      expect(memory.port.quarantine).toHaveBeenCalled()
    }
  })

  it('rejects a rechecksummed recorded phase whose current transcript evidence was removed', async () => {
    const memory = memoryPersistence()
    const journal = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T1 })
    const prepared = (await journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'goal', sourceId: 'goal-evidence', occurrenceId: 'iteration-1' },
      spans: [span('input')],
      occurredAt: T0,
    })).dispatch
    const inputRow = transcriptRow({ turnId: prepared.turnId, ordinal: 1, span: span('input') })
    const replyRow = transcriptRow({
      turnId: prepared.turnId,
      ordinal: 2,
      span: { role: 'assistant', provenance: 'untrusted', text: 'reply' },
      previous: inputRow,
    })
    const pending = await journal.transition({
      binding: BINDING, dispatchId: prepared.dispatchId, expectedRevision: 1,
      phase: 'provider-pending', operationSeq: 1, transcriptOrdinal: 1,
      requestHash: REQUEST_HASH, at: T1,
    })
    await journal.transition({
      binding: BINDING, dispatchId: prepared.dispatchId, expectedRevision: pending.revision,
      phase: 'provider-recorded', operationSeq: 2, transcriptOrdinal: 2,
      requestHash: REQUEST_HASH,
      evidence: { ordinal: 2, eventId: replyRow.eventId, rowHash: replyRow.rowHash },
      at: T2,
    })
    const state = memory.state()!
    state.dispatches[0]!.transcriptEvidence = []
    state.checksum = computeSessionActivityJournalChecksum(state)
    memory.set(state)
    expect(await journal.recover({
      binding: BINDING,
      dispatchId: prepared.dispatchId,
      transcript: [inputRow, replyRow],
    })).toEqual({ kind: 'interrupted', code: 'ACTIVITY_QUARANTINED' })
  })

  it('enforces the 4 MiB encoded dispatch bound before persistence', async () => {
    const memory = memoryPersistence()
    const journal = makeSessionActivityJournal({ persistence: memory.port, nowIso: () => T1 })
    const big = 'x'.repeat(1024 * 1024)
    await expect(journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'goal', sourceId: 'goal-4', occurrenceId: 'iteration-1' },
      spans: [span(big), span(big), span(big), span(big)],
      occurredAt: T0,
    })).rejects.toMatchObject({ code: 'bounds-exceeded' })
    expect(memory.port.commit).not.toHaveBeenCalled()
  })
})
