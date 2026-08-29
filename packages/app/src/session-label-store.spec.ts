import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  makeMemorySessionLabelStore,
  makeNodeSessionLabelStore,
  SessionLabelStoreError,
} from './session-label-store.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('session label store', () => {
  it('treats missing legacy metadata as explicit without writing it', () => {
    const store = makeMemorySessionLabelStore()

    expect(store.get('legacy-session')).toBeNull()
    expect(store.snapshot()).toEqual({ schemaVersion: 1, labels: [] })
  })

  it('marks a new session temporary idempotently and never downgrades an explicit name', () => {
    const store = makeMemorySessionLabelStore({
      nowIso: () => '2026-08-29T10:00:00.000Z',
    })

    expect(store.markTemporary('session-a')).toMatchObject({
      sessionId: 'session-a', kind: 'temporary', revision: 1,
    })
    expect(store.markTemporary('session-a')).toMatchObject({
      sessionId: 'session-a', kind: 'temporary', revision: 1,
    })
    expect(store.markExplicit('session-a', 1)).toMatchObject({
      sessionId: 'session-a', kind: 'explicit', revision: 2,
    })
    expect(() => store.markTemporary('session-a')).toThrowError(
      new SessionLabelStoreError('SESSION_LABEL_EXPLICIT'),
    )
  })

  it('uses revision CAS so a late auto-name cannot overwrite an explicit rename', () => {
    const store = makeMemorySessionLabelStore()
    store.markTemporary('session-a')
    store.markExplicit('session-a', 1)

    expect(() => store.markExplicit('session-a', 1)).toThrowError(
      new SessionLabelStoreError('STALE_SESSION_LABEL_REVISION'),
    )
    expect(store.get('session-a')).toMatchObject({ kind: 'explicit', revision: 2 })
  })

  it('does not publish label metadata when durable persistence fails', () => {
    const store = makeMemorySessionLabelStore({
      save: () => { throw new Error('injected label store failure') },
    })

    expect(() => store.markTemporary('session-a')).toThrow('injected label store failure')
    expect(store.get('session-a')).toBeNull()
  })

  it('persists private atomic JSON and fails closed on corrupt bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-session-labels-'))
    roots.push(root)
    const path = join(root, 'labels.json')
    const store = makeNodeSessionLabelStore({
      path,
      nowIso: () => '2026-08-29T10:00:00.000Z',
    })

    store.markTemporary('session-a')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      labels: [{ sessionId: 'session-a', kind: 'temporary', revision: 1 }],
    })

    writeFileSync(path, '{"schemaVersion":1,"labels":[{"sessionId":"session-a"}]}\n', {
      mode: 0o600,
    })
    expect(() => makeNodeSessionLabelStore({ path })).toThrowError(
      new SessionLabelStoreError('CORRUPT_SESSION_LABEL_STORE'),
    )

    writeFileSync(path, '{"schemaVersion":1,"labels":[],"unexpected":true}\n', { mode: 0o600 })
    expect(() => makeNodeSessionLabelStore({ path })).toThrowError(
      new SessionLabelStoreError('CORRUPT_SESSION_LABEL_STORE'),
    )
  })
})
