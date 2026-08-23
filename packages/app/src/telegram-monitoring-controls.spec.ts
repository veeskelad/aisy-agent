import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  makeMonitoringEngine,
  makeMonitoringStore,
  type MonitoringCollector,
  type ResolvedWorkBinding,
} from '@aisy/core'
import { describe, expect, it, vi } from 'vitest'
import {
  makeTelegramMonitoringControls,
  type TelegramMonitoringButton,
  type TelegramMonitoringOutcome,
} from './telegram-monitoring-controls.js'

const BINDING: ResolvedWorkBinding = Object.freeze({
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'project',
})
const PRINCIPAL = Object.freeze({ chatId: 42, userId: 42 })

function button(outcome: TelegramMonitoringOutcome | { buttons: TelegramMonitoringButton[][] }, text: string) {
  const rows = 'buttons' in outcome
    ? outcome.buttons
    : outcome.kind === 'view' ? outcome.view.buttons : []
  const found = rows.flat().find((item) => item.text.includes(text))
  if (!found) throw new Error(`missing button ${text}`)
  return found
}

function setup() {
  const store = makeMonitoringStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'aisy-monitoring-ui-')), 'monitoring.db'),
  })
  const collector: MonitoringCollector = { collect: vi.fn(async () => ({ items: [] })) }
  const resolveBinding = vi.fn((binding: ResolvedWorkBinding) => {
    if (binding.projectId !== BINDING.projectId) throw new Error('foreign')
  })
  let sourceId = 0
  let token = 0
  const engine = makeMonitoringEngine({
    store,
    collectors: { rss: collector, web: collector },
    resolveBinding,
    nowIso: () => '2026-08-12T08:00:00.000Z',
    newId: () => 'digest-id',
  })
  const controls = makeTelegramMonitoringControls({
    engine,
    store,
    binding: BINDING,
    resolveBinding,
    newSourceId: () => `source-${++sourceId}`,
    newTokenId: () => `token-${++token}`,
    nowMs: () => Date.parse('2026-08-12T08:00:00.000Z'),
  })
  return { controls, engine, store, resolveBinding }
}

function startAdd(setupResult: ReturnType<typeof setup>, kind: 'RSS' | 'Web', messageId = 100) {
  const view = setupResult.controls.open({ principal: PRINCIPAL, messageId })
  const add = button(view, `➕ ${kind}`)
  const prompt = setupResult.controls.handle({
    data: add.data, principal: PRINCIPAL, messageId,
  })
  expect(prompt).toMatchObject({ kind: 'prompt', messageId })
  return prompt
}

describe('Telegram monitoring source controls', () => {
  it('adds RSS with an exact-domain grant and never renders path, query or criteria', () => {
    const h = setup()
    startAdd(h, 'RSS')

    const added = h.controls.handleText({
      principal: PRINCIPAL,
      text: 'https://news.example.com/private/feed.xml?topic=infra\nТолько срочные релизы',
    })

    expect(added).toMatchObject({ kind: 'view', messageId: 100 })
    if (!added || added.kind !== 'view') throw new Error('view expected')
    expect(added.view.text).toContain('news.example.com')
    expect(added.view.text).not.toContain('/private')
    expect(added.view.text).not.toContain('topic=infra')
    expect(added.view.text).not.toContain('срочные')
    expect(h.store.getSourceEgressDomain('source-1')).toBe('news.example.com')
    expect(h.store.getSource('source-1')).toMatchObject({
      kind: 'rss', criteria: 'Только срочные релизы', pollIntervalMs: 15 * 60_000,
    })
  })

  it('keeps the grant on pause/resume and revokes it only after confirmed remove', () => {
    const h = setup()
    startAdd(h, 'Web')
    const added = h.controls.handleText({ principal: PRINCIPAL, text: 'https://status.example.org/incidents' })
    if (!added || added.kind !== 'view') throw new Error('view expected')

    const pause = button(added, 'Пауза')
    const paused = h.controls.handle({ data: pause.data, principal: PRINCIPAL, messageId: 100 })
    expect(h.store.getSource('source-1')).toMatchObject({ status: 'paused' })
    expect(h.store.getSourceEgressDomain('source-1')).toBe('status.example.org')
    if (paused.kind !== 'view') throw new Error('view expected')

    const resume = button(paused, 'Возобновить')
    const resumed = h.controls.handle({ data: resume.data, principal: PRINCIPAL, messageId: 100 })
    expect(h.store.getSource('source-1')).toMatchObject({ status: 'active' })
    expect(h.store.getSourceEgressDomain('source-1')).toBe('status.example.org')
    if (resumed.kind !== 'view') throw new Error('view expected')

    const remove = button(resumed, 'Удалить')
    const confirmation = h.controls.handle({ data: remove.data, principal: PRINCIPAL, messageId: 100 })
    expect(h.store.getSourceEgressDomain('source-1')).toBe('status.example.org')
    if (confirmation.kind !== 'view') throw new Error('confirmation expected')
    const confirmed = button(confirmation, 'Да, удалить')
    expect(h.controls.handle({ data: confirmed.data, principal: PRINCIPAL, messageId: 100 }))
      .toMatchObject({ kind: 'view' })
    expect(h.store.getSource('source-1')).toBeNull()
    expect(h.store.getSourceEgressDomain('source-1')).toBeNull()
  })

  it('spends callback before mutation and rejects replay, foreign principal and wrong message', () => {
    const h = setup()
    const view = h.controls.open({ principal: PRINCIPAL, messageId: 100 })
    const add = button(view, '➕ RSS')

    expect(h.controls.handle({
      data: add.data, principal: { chatId: 42, userId: 77 }, messageId: 100,
    })).toMatchObject({ kind: 'stale' })
    expect(h.controls.handle({
      data: add.data, principal: PRINCIPAL, messageId: 101,
    })).toMatchObject({ kind: 'stale' })
    expect(h.controls.handle({
      data: add.data, principal: PRINCIPAL, messageId: 100,
    })).toMatchObject({ kind: 'prompt' })
    expect(h.controls.handle({
      data: add.data, principal: PRINCIPAL, messageId: 100,
    })).toMatchObject({ kind: 'stale' })
  })

  it('fails closed on invalid URL and consumes the form once', () => {
    const h = setup()
    startAdd(h, 'Web')
    expect(h.controls.handleText({
      principal: PRINCIPAL, text: 'https://example.com:8443/page',
    })).toMatchObject({ kind: 'notice' })
    expect(h.controls.handleText({
      principal: PRINCIPAL, text: 'https://example.com/page',
    })).toBeNull()
    expect(h.store.listSources(BINDING)).toEqual([])
  })

  it('does not eat ordinary text after form expiry or explicit screen change', () => {
    const h = setup()
    startAdd(h, 'RSS')
    h.controls.cancelForm()
    expect(h.controls.handleText({ principal: PRINCIPAL, text: 'обычный вопрос' })).toBeNull()
  })

  it('resolves exact binding before every screen and mutation', () => {
    const h = setup()
    startAdd(h, 'RSS')
    const added = h.controls.handleText({ principal: PRINCIPAL, text: 'https://example.com/feed' })
    if (!added || added.kind !== 'view') throw new Error('view expected')
    h.resolveBinding.mockImplementation(() => { throw new Error('archived') })

    const pause = button(added, 'Пауза')
    expect(h.controls.handle({ data: pause.data, principal: PRINCIPAL, messageId: 100 }))
      .toMatchObject({ kind: 'notice' })
    expect(h.store.getSource('source-1')).toMatchObject({ status: 'active' })
  })
})
