import {
  makeSessionTranscript,
  parseSessionTranscriptManifest,
  TranscriptCommitUncertainError,
  type FrozenSnapshot,
  type TranscriptBinding,
} from '@aisy/core'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeNodeSessionTranscriptMaintenance,
  makeNodeSessionTranscriptPersistence,
} from './session-transcript-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const binding: TranscriptBinding = {
  operatorId: 'telegram:42', profileId: 'default',
  projectId: 'project-a', sessionId: 'session-a',
}
const frozen: FrozenSnapshot = {
  prefixBytes: new TextEncoder().encode('constitution'),
  prefixHash: 'ignored', breakpoints: [], takenAt: '2026-07-27T00:00:00.000Z',
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-transcript-'))
  roots.push(value)
  return value
}

function transcript(dir: string, faultAt?: (point: 'after-wal' | 'after-row' | 'after-manifest') => void) {
  return makeSessionTranscript({
    persistence: makeNodeSessionTranscriptPersistence({
      root: dir,
      ...(faultAt === undefined ? {} : { faultAt }),
    }),
    classifyLoadBearing: () => ({ loadBearing: false, classifierVersion: 'rules-v1' }),
  })
}

const appendInput = {
  ...binding,
  eventId: 'event-1',
  role: 'user' as const,
  provenance: 'operator' as const,
  content: 'full private dialogue',
  ts: '2026-07-27T00:00:01.000Z',
}

describe('Node session transcript persistence', () => {
  it('persists exact content, manifest head and restrictive modes across restart', async () => {
    const dir = root()
    const first = transcript(dir)
    await first.createExactSession(binding, frozen, frozen.takenAt)
    const appended = await first.append(appendInput)

    const second = transcript(dir)
    expect(await second.read(binding)).toEqual([appended.row])
    expect(await second.manifest(binding)).toMatchObject({
      nextSessionSeq: 2,
      hashHead: appended.row.rowHash,
      resumeCapability: 'exact-v2',
    })
    expect(statSync(join(dir, 'transcript-v2.jsonl')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'sessions', binding.sessionId, 'manifest.json')).mode & 0o777).toBe(0o600)
  })

  it('accepts a turn stamped before the session was created, and reloads after it', async () => {
    // The service and this store each build the next manifest and compare them
    // byte for byte. A turn from before the session exists is where the two
    // computations used to disagree — the commit was refused, the session
    // quarantined, and every later turn died with it.
    const dir = root()
    const first = transcript(dir)
    await first.createExactSession(binding, frozen, '2026-07-27T00:00:10.000Z')

    const appended = await first.append({ ...appendInput, ts: '2026-07-27T00:00:08.000Z' })

    const manifest = await first.manifest(binding)
    expect(manifest.updatedAt).toBe('2026-07-27T00:00:10.000Z')
    expect(appended.row.ts).toBe('2026-07-27T00:00:08.000Z')
    // Reloading is the half that failed second: a manifest that fails its own
    // validity check reads as corrupt, not as out of order.
    const second = transcript(dir)
    expect((await second.manifest(binding)).nextSessionSeq).toBe(2)
    expect((await second.append({ ...appendInput, eventId: 'event-2', ts: '2026-07-27T00:00:09.000Z' })).status)
      .toBe('appended')
    expect(existsSync(join(dir, 'sessions', binding.sessionId, 'quarantine.json'))).toBe(false)
  })

  it.each(['after-wal', 'after-row', 'after-manifest'] as const)
  ('recovers exactly once after crash point %s', async (point) => {
    const dir = root()
    let armed = true
    const first = transcript(dir, (current) => {
      if (armed && current === point) { armed = false; throw new Error(`crash:${point}`) }
    })
    await first.createExactSession(binding, frozen, frozen.takenAt)
    await expect(first.append(appendInput)).rejects.toBeInstanceOf(TranscriptCommitUncertainError)
    expect(existsSync(join(dir, 'sessions', binding.sessionId, 'append.wal.json'))).toBe(true)

    const recovered = transcript(dir)
    expect(await recovered.read(binding)).toHaveLength(1)
    expect((await recovered.manifest(binding)).nextSessionSeq).toBe(2)
    expect(existsSync(join(dir, 'sessions', binding.sessionId, 'append.wal.json'))).toBe(false)
    expect(readFileSync(join(dir, 'transcript-v2.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect((await recovered.append(appendInput)).status).toBe('duplicate')
  })

  it('repairs only a WAL-owned partial final line', async () => {
    const dir = root()
    const first = transcript(dir, (point) => { if (point === 'after-wal') throw new Error('crash') })
    await first.createExactSession(binding, frozen, frozen.takenAt)
    await expect(first.append(appendInput)).rejects.toBeInstanceOf(TranscriptCommitUncertainError)
    const wal = JSON.parse(readFileSync(join(dir, 'sessions', binding.sessionId, 'append.wal.json'), 'utf8'))
    const expected = JSON.stringify(wal.row)
    appendFileSync(join(dir, 'transcript-v2.jsonl'), expected.slice(0, 37))

    const recovered = transcript(dir)
    expect(await recovered.read(binding)).toHaveLength(1)
    expect(readFileSync(join(dir, 'transcript-v2.jsonl'), 'utf8')).toBe(expected + '\n')
  })

  it('quarantines a foreign partial tail without truncating it', async () => {
    const dir = root()
    const first = transcript(dir, (point) => { if (point === 'after-wal') throw new Error('crash') })
    await first.createExactSession(binding, frozen, frozen.takenAt)
    await expect(first.append(appendInput)).rejects.toBeInstanceOf(TranscriptCommitUncertainError)
    const transcriptPath = join(dir, 'transcript-v2.jsonl')
    appendFileSync(transcriptPath, 'foreign-partial')

    const before = readFileSync(transcriptPath, 'utf8')
    const recovered = transcript(dir)
    await expect(recovered.read(binding)).rejects.toThrow(/quarantined/i)
    expect(readFileSync(transcriptPath, 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(join(dir, 'sessions', binding.sessionId, 'quarantine.json'), 'utf8')).reason)
      .toBe('commit-conflict')
  })

  it('quarantines a WAL with hidden row authority before publishing its row', async () => {
    const dir = root()
    const first = transcript(dir, (point) => { if (point === 'after-wal') throw new Error('crash') })
    await first.createExactSession(binding, frozen, frozen.takenAt)
    await expect(first.append(appendInput)).rejects.toBeInstanceOf(TranscriptCommitUncertainError)
    const walPath = join(dir, 'sessions', binding.sessionId, 'append.wal.json')
    const wal = JSON.parse(readFileSync(walPath, 'utf8'))
    wal.row.hiddenAuthority = true
    writeFileSync(walPath, JSON.stringify(wal, null, 2) + '\n')

    makeNodeSessionTranscriptPersistence({ root: dir })

    expect(existsSync(join(dir, 'transcript-v2.jsonl'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'sessions', binding.sessionId, 'manifest.json'), 'utf8')).nextSessionSeq)
      .toBe(1)
    expect(JSON.parse(readFileSync(join(dir, 'sessions', binding.sessionId, 'quarantine.json'), 'utf8')).reason)
      .toBe('commit-conflict')
  })

  it('rejects unsafe session identifiers before filesystem access', async () => {
    const dir = root()
    const store = makeNodeSessionTranscriptPersistence({ root: dir })
    await expect(store.loadManifest('../outside')).rejects.toThrow(/unsafe transcript identifier/)
    expect(existsSync(join(dir, 'outside'))).toBe(false)
  })

  it('rewrites only the deleted Session rows and removes controls in a later phase', async () => {
    const dir = root()
    const service = transcript(dir)
    const other = { ...binding, sessionId: 'session-b' }
    await service.createExactSession(binding, frozen, frozen.takenAt)
    await service.createExactSession(other, frozen, frozen.takenAt)
    await service.append(appendInput)
    await service.append({
      ...appendInput,
      ...other,
      eventId: 'event-b-1',
      content: 'other session survives',
    })
    const maintenance = makeNodeSessionTranscriptMaintenance({ root: dir })
    const persistence = makeNodeSessionTranscriptPersistence({ root: dir })
    const persistedManifest = await persistence.loadManifest(binding.sessionId)
    expect(await maintenance.currentHead(binding.sessionId))
      .toBe(parseSessionTranscriptManifest(persistedManifest)?.hashHead)
    let interleavedRead: Promise<unknown> | null = null

    await expect(maintenance.purgeSession(binding.sessionId, () => {
      interleavedRead = persistence.loadManifest(other.sessionId)
    })).resolves
      .toEqual({ removedRows: 1, retainedRows: 1 })
    await expect(interleavedRead).rejects.toThrow('TRANSCRIPT_MAINTENANCE_IN_PROGRESS')
    const bytes = readFileSync(join(dir, 'transcript-v2.jsonl'), 'utf8')
    expect(bytes).not.toContain('full private dialogue')
    expect(bytes).toContain('other session survives')
    expect(existsSync(join(dir, 'sessions', binding.sessionId, 'manifest.json'))).toBe(true)
    expect(existsSync(join(dir, 'sessions', other.sessionId, 'manifest.json'))).toBe(true)

    await maintenance.removeSessionControls(binding.sessionId)
    expect(existsSync(join(dir, 'sessions', binding.sessionId))).toBe(false)
    expect(existsSync(join(dir, 'sessions', other.sessionId, 'manifest.json'))).toBe(true)
    await expect(transcript(dir).append({
      ...appendInput,
      ...other,
      eventId: 'event-b-2',
      content: 'append after purge',
    })).resolves.toMatchObject({ status: 'appended' })
  })

  it('keeps transcript bytes unchanged when any row is corrupt', async () => {
    const dir = root()
    const path = join(dir, 'transcript-v2.jsonl')
    writeFileSync(path, '{"sessionId":"session-a","content":"private"}\n', { mode: 0o600 })
    const before = readFileSync(path, 'utf8')

    await expect(makeNodeSessionTranscriptMaintenance({ root: dir })
      .purgeSession('session-a')).rejects.toThrow('SESSION_TRANSCRIPT_CORRUPT')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('drains the current writer before exclusive maintenance and blocks interleaving', async () => {
    const dir = root()
    const maintenance = makeNodeSessionTranscriptMaintenance({ root: dir })
    let pendingPurge: Promise<unknown> | null = null
    const service = transcript(dir, (point) => {
      if (point !== 'after-wal') return
      pendingPurge = maintenance.purgeSession(binding.sessionId)
    })
    await service.createExactSession(binding, frozen, frozen.takenAt)

    await expect(service.append(appendInput)).resolves.toMatchObject({ status: 'appended' })
    await expect(pendingPurge).resolves.toEqual({ removedRows: 1, retainedRows: 0 })
    expect(readFileSync(join(dir, 'transcript-v2.jsonl'), 'utf8')).toBe('')
  })
})
