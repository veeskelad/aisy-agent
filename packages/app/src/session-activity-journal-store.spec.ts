import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  makeSessionActivityJournal,
  SessionActivityPersistenceError,
  type ActivityBinding,
  type SessionActivityJournalStateV1,
} from '@aisy/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  makeNodeSessionActivityJournalPersistence,
  SESSION_ACTIVITY_STORE_PREVIEW_ONLY,
  sessionActivityBindingStorageKey,
} from './session-activity-journal-store.js'

const BINDING: ActivityBinding = {
  operatorId: 'operator-1',
  profileId: 'default',
  projectId: 'project-1',
  sessionId: 'session-1',
}
const T0 = '2026-07-28T10:00:00.000Z'
const T1 = '2026-07-28T10:00:01.000Z'
const roots: string[] = []

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'aisy-activity-'))
  chmodSync(path, 0o700)
  roots.push(path)
  return path
}

function statePath(base: string, binding = BINDING): string {
  return join(base, sessionActivityBindingStorageKey(binding), 'activity-journal-v1.json')
}

function quarantinePath(base: string, binding = BINDING): string {
  return join(base, sessionActivityBindingStorageKey(binding), 'activity-journal-v1.quarantine.json')
}

function journal(base: string, binding = BINDING) {
  const persistence = makeNodeSessionActivityJournalPersistence({ root: base })
  return {
    persistence,
    journal: makeSessionActivityJournal({ persistence, nowIso: () => T1 }),
    binding,
  }
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    try { chmodSync(path, 0o700) } catch { /* already absent */ }
    try {
      for (const name of readdirSync(path)) {
        try { chmodSync(join(path, name), 0o700) } catch { /* file or symlink */ }
      }
    } catch { /* absent */ }
    rmSync(path, { recursive: true, force: true })
  }
})

describe('Node SessionActivityJournal preview store', () => {
  it('survives restart with stable background turn authority and private atomic files', async () => {
    const base = root()
    const first = journal(base)
    const prepared = await first.journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'trigger', sourceId: 'trigger-1', occurrenceId: 'slot-1' },
      spans: [{ role: 'user', provenance: 'operator', text: 'run' }],
      occurredAt: T0,
    })
    const restarted = journal(base)
    const duplicate = await restarted.journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'trigger', sourceId: 'trigger-1', occurrenceId: 'slot-1' },
      spans: [{ role: 'user', provenance: 'operator', text: 'run' }],
      occurredAt: T0,
    })

    expect(duplicate.status).toBe('duplicate')
    expect(duplicate.dispatch).toEqual(prepared.dispatch)
    expect(await restarted.journal.recover({
      binding: BINDING,
      dispatchId: duplicate.dispatch.dispatchId,
      transcript: [],
    })).toMatchObject({ kind: 'ready' })
    expect(lstatSync(base).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(base, sessionActivityBindingStorageKey(BINDING))).mode & 0o777).toBe(0o700)
    expect(lstatSync(statePath(base)).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(base, sessionActivityBindingStorageKey(BINDING))))
      .toEqual(['activity-journal-v1.json'])
  })

  it('uses the full exact binding for storage isolation even when sessionId is identical', async () => {
    const base = root()
    const foreign: ActivityBinding = { ...BINDING, operatorId: 'operator-2', projectId: 'project-2' }
    const a = journal(base, BINDING)
    const b = journal(base, foreign)
    await a.journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'goal', sourceId: 'goal-a', occurrenceId: 'iteration-1' },
      spans: [{ role: 'user', provenance: 'operator', text: 'A' }],
      occurredAt: T0,
    })
    await b.journal.prepareBackground({
      binding: foreign,
      source: { kind: 'goal', sourceId: 'goal-b', occurrenceId: 'iteration-1' },
      spans: [{ role: 'user', provenance: 'operator', text: 'B' }],
      occurredAt: T0,
    })

    expect(sessionActivityBindingStorageKey(BINDING)).not.toBe(sessionActivityBindingStorageKey(foreign))
    expect(JSON.parse(readFileSync(statePath(base, BINDING), 'utf8')).binding).toEqual(BINDING)
    expect(JSON.parse(readFileSync(statePath(base, foreign), 'utf8')).binding).toEqual(foreign)
    await a.persistence.quarantine(BINDING, 'invalid-state')
    expect((await b.persistence.load(foreign)).status).toBe('ready')
  })

  it('durably quarantines corrupt JSON without rewriting the corrupt state bytes', async () => {
    const base = root()
    const first = journal(base)
    await first.journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'goal', sourceId: 'goal-1', occurrenceId: 'iteration-1' },
      spans: [{ role: 'user', provenance: 'operator', text: 'run' }],
      occurredAt: T0,
    })
    writeFileSync(statePath(base), '{broken', { encoding: 'utf8', mode: 0o600 })
    const before = readFileSync(statePath(base))
    const restarted = makeNodeSessionActivityJournalPersistence({ root: base })

    expect(await restarted.load(BINDING)).toEqual({ status: 'quarantined' })
    expect(readFileSync(statePath(base))).toEqual(before)
    expect(lstatSync(quarantinePath(base)).mode & 0o777).toBe(0o600)
    expect(await restarted.load(BINDING)).toEqual({ status: 'quarantined' })
  })

  it('fails closed on symlink and non-private state files', async () => {
    for (const unsafe of ['symlink', 'permissions'] as const) {
      const base = root()
      const directory = join(base, sessionActivityBindingStorageKey(BINDING))
      mkdirSync(directory, { mode: 0o700 })
      const path = statePath(base)
      if (unsafe === 'symlink') {
        const target = join(base, 'outside.json')
        writeFileSync(target, '{}', { mode: 0o600 })
        symlinkSync(target, path)
      } else {
        writeFileSync(path, '{}', { mode: 0o644 })
      }
      const persistence = makeNodeSessionActivityJournalPersistence({ root: base })
      expect(await persistence.load(BINDING)).toEqual({ status: 'quarantined' })
      expect(exists(quarantinePath(base))).toBe(true)
    }
  })

  it('bounds reads at 8 MiB and keeps the oversized state untouched', async () => {
    const base = root()
    const directory = join(base, sessionActivityBindingStorageKey(BINDING))
    mkdirSync(directory, { mode: 0o700 })
    const oversized = 'x'.repeat(8 * 1024 * 1024 + 1)
    writeFileSync(statePath(base), oversized, { mode: 0o600 })
    const persistence = makeNodeSessionActivityJournalPersistence({ root: base })

    expect(await persistence.load(BINDING)).toEqual({ status: 'quarantined' })
    expect(lstatSync(statePath(base)).size).toBe(Buffer.byteLength(oversized))
  })

  it('lets Core quarantine rechecksummed semantic unknown fields after restart', async () => {
    const base = root()
    const first = journal(base)
    const input = {
      binding: BINDING,
      source: { kind: 'goal' as const, sourceId: 'goal-unknown', occurrenceId: 'iteration-1' },
      spans: [{ role: 'user' as const, provenance: 'operator' as const, text: 'run' }],
      occurredAt: T0,
    }
    await first.journal.prepareBackground(input)
    const raw = JSON.parse(readFileSync(statePath(base), 'utf8')) as SessionActivityJournalStateV1 & {
      unknown?: boolean
    }
    raw.unknown = true
    writeFileSync(statePath(base), JSON.stringify(raw), { encoding: 'utf8', mode: 0o600 })
    const restarted = journal(base)

    await expect(restarted.journal.prepareBackground(input)).rejects.toMatchObject({ code: 'quarantined' })
    expect(exists(quarantinePath(base))).toBe(true)
  })

  it('reports observed-byte CAS conflict distinctly from unavailable persistence', async () => {
    const base = root()
    const runtime = journal(base)
    await runtime.journal.prepareBackground({
      binding: BINDING,
      source: { kind: 'goal', sourceId: 'goal-cas', occurrenceId: 'iteration-1' },
      spans: [{ role: 'user', provenance: 'operator', text: 'run' }],
      occurredAt: T0,
    })
    const loaded = await runtime.persistence.load(BINDING)
    expect(loaded.status).toBe('ready')
    const state = (loaded as { status: 'ready'; value: SessionActivityJournalStateV1 }).value
    writeFileSync(statePath(base), JSON.stringify({ ...state, extra: true }), { mode: 0o600 })
    await expect(runtime.persistence.commit({
      binding: BINDING,
      expectedRevision: state.revision,
      state: { ...state, revision: state.revision + 1 },
    })).rejects.toEqual(expect.objectContaining<Partial<SessionActivityPersistenceError>>({
      code: 'cas-conflict',
    }))
  })

  it('is explicitly preview-only and has no production composition import', () => {
    expect(SESSION_ACTIVITY_STORE_PREVIEW_ONLY).toBe(true)
    const liveSource = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')
    expect(liveSource).not.toContain('session-activity-journal-store')
  })
})

function exists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}
