import { describe, expect, it } from 'vitest'

import {
  makeSessionActivityJournal,
  type ActivityBinding,
  type SessionActivityJournalStateV1,
  type SessionActivityPersistenceLoad,
  type SessionActivityJournalPersistencePort,
} from '@aisy/core'
import {
  makeTelegramChatBindingHash,
  makeTelegramTurnActivityCoordinator,
  TelegramTurnActivityError,
  type TelegramTransportBindingV1,
} from './bot-streaming-activity-coordinator.js'

function memoryPersistence(): SessionActivityJournalPersistencePort {
  const states = new Map<string, SessionActivityJournalStateV1>()
  const quarantined = new Set<string>()
  const key = (binding: ActivityBinding) => JSON.stringify(binding)
  return {
    async load(binding): Promise<SessionActivityPersistenceLoad> {
      const state = states.get(key(binding))
      if (quarantined.has(key(binding))) return { status: 'quarantined' }
      return state === undefined ? { status: 'missing' } : { status: 'ready', value: structuredClone(state) }
    },
    async commit(input) { states.set(key(input.binding), structuredClone(input.state)) },
    async quarantine(binding) { quarantined.add(key(binding)) },
  }
}

const BASE: ActivityBinding = {
  operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a', sessionId: 'session-a',
}
const CHAT = makeTelegramChatBindingHash({ botPublicId: 'aisy-bot', chatId: 42, operatorId: BASE.operatorId })
const BINDING: TelegramTransportBindingV1 = { ...BASE, chatBindingHash: CHAT }

describe('Telegram turn activity coordinator preview', () => {
  it('accepts and seals exact ordered ingress with full Project binding', async () => {
    const coordinator = makeTelegramTurnActivityCoordinator({
      journal: makeSessionActivityJournal({ persistence: memoryPersistence(), nowIso: () => '2026-07-28T10:00:00.000Z' }),
    })
    const second = await coordinator.accept({
      binding: BINDING, updateId: 2, messageTs: '2026-07-28T09:02:00.000Z',
      span: { role: 'user', provenance: 'operator', text: 'второе' },
    })
    const first = await coordinator.accept({
      binding: BINDING, updateId: 1, messageTs: '2026-07-28T09:01:00.000Z',
      span: { role: 'user', provenance: 'operator', text: 'первое' },
    })
    const sealed = await coordinator.seal({
      binding: BINDING, orderedIngressIds: [first.ingressId, second.ingressId],
      sealedAt: '2026-07-28T10:00:00.000Z',
    })
    expect(sealed.dispatch.binding).toEqual(BASE)
    expect(sealed.dispatch.source).toEqual({ kind: 'telegram', chatBindingHash: CHAT, updateIds: [1, 2] })
    expect(sealed.dispatch.turnTs).toBe('2026-07-28T09:01:00.000Z')
    expect(sealed.dispatch.spans.map(span => span.text)).toEqual(['первое', 'второе'])
  })

  it('keeps equal session ids in different Projects isolated', async () => {
    const persistence = memoryPersistence()
    const coordinator = makeTelegramTurnActivityCoordinator({
      journal: makeSessionActivityJournal({ persistence, nowIso: () => '2026-07-28T10:00:00.000Z' }),
    })
    await coordinator.accept({
      binding: BINDING, updateId: 1, messageTs: '2026-07-28T09:01:00.000Z',
      span: { role: 'user', provenance: 'operator', text: 'A' },
    })
    await expect(coordinator.accept({
      binding: { ...BINDING, projectId: 'project-b' }, updateId: 1,
      messageTs: '2026-07-28T09:01:00.000Z',
      span: { role: 'user', provenance: 'operator', text: 'B' },
    })).resolves.toMatchObject({ status: 'accepted' })
  })

  it('maps changed retry bytes to a stable identity-conflict code', async () => {
    const coordinator = makeTelegramTurnActivityCoordinator({
      journal: makeSessionActivityJournal({ persistence: memoryPersistence(), nowIso: () => '2026-07-28T10:00:00.000Z' }),
    })
    const input = {
      binding: BINDING, updateId: 1, messageTs: '2026-07-28T09:01:00.000Z',
      span: { role: 'user' as const, provenance: 'operator' as const, text: 'A' },
    }
    await expect(coordinator.accept(input)).resolves.toMatchObject({ status: 'accepted' })
    await expect(coordinator.accept(input)).resolves.toMatchObject({ status: 'duplicate' })
    await expect(coordinator.accept({ ...input, span: { ...input.span, text: 'B' } }))
      .rejects.toEqual(new TelegramTurnActivityError('INGRESS_IDENTITY_CONFLICT'))
  })

  it('rejects recovery through a different Telegram chat binding', async () => {
    const coordinator = makeTelegramTurnActivityCoordinator({
      journal: makeSessionActivityJournal({ persistence: memoryPersistence(), nowIso: () => '2026-07-28T10:00:00.000Z' }),
    })
    const accepted = await coordinator.accept({
      binding: BINDING, updateId: 1, messageTs: '2026-07-28T09:01:00.000Z',
      span: { role: 'user', provenance: 'operator', text: 'A' },
    })
    const sealed = await coordinator.seal({
      binding: BINDING, orderedIngressIds: [accepted.ingressId], sealedAt: '2026-07-28T10:00:00.000Z',
    })
    await expect(coordinator.recover({
      binding: { ...BINDING, chatBindingHash: 'f'.repeat(64) },
      dispatchId: sealed.dispatch.dispatchId, updateIds: [1], transcript: [],
    })).rejects.toEqual(new TelegramTurnActivityError('BINDING_MISMATCH'))
  })
})
