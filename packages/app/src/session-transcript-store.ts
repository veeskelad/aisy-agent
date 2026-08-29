import {
  computeTranscriptRowHash,
  parseSessionTranscriptManifest,
  transcriptUpdatedAt,
  TranscriptCommitUncertainError,
  type SessionTranscriptManifestV1,
  type SessionTranscriptPersistencePort,
  type TranscriptCommit,
  type TranscriptEnvelope,
  type TranscriptQuarantineReason,
} from '@aisy/core'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

interface TranscriptQuarantineMarkerV1 {
  schemaVersion: 1
  sessionId: string
  reason: TranscriptQuarantineReason
  quarantinedAt: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
const HASH = /^[a-f0-9]{64}$/
const MAX_CONTROL_BYTES = 8 * 1024 * 1024
const MAX_ROW_BYTES = 2 * 1024 * 1024
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024
const WAL_KEYS = new Set(['expectedNextSessionSeq', 'expectedHashHead', 'row', 'nextManifest'])
const ROW_KEYS = new Set([
  'eventId', 'operatorId', 'profileId', 'projectId', 'sessionId', 'sessionSeq',
  'role', 'provenance', 'content', 'ts', 'loadBearing',
  'loadBearingClassifierVersion', 'prevSessionHash', 'rowHash',
])

interface TranscriptMaintenanceGate {
  enterWriter(): () => void
  beginExclusive(): Promise<() => void>
}

const transcriptGates = new Map<string, TranscriptMaintenanceGate>()

function gateFor(root: string): TranscriptMaintenanceGate {
  const existing = transcriptGates.get(root)
  if (existing !== undefined) return existing
  let writers = 0
  let exclusive = false
  let exclusivePending = false
  let releaseDrain: (() => void) | null = null
  const gate: TranscriptMaintenanceGate = {
    enterWriter() {
      if (exclusive || exclusivePending) {
        throw new Error('TRANSCRIPT_MAINTENANCE_IN_PROGRESS')
      }
      writers += 1
      let released = false
      return () => {
        if (released) return
        released = true
        writers -= 1
        if (writers === 0 && releaseDrain !== null) {
          const resolve = releaseDrain
          releaseDrain = null
          resolve()
        }
      }
    },
    async beginExclusive() {
      if (exclusive || exclusivePending) throw new Error('TRANSCRIPT_MAINTENANCE_BUSY')
      exclusivePending = true
      if (writers !== 0) {
        await new Promise<void>((resolve) => { releaseDrain = resolve })
      }
      exclusive = true
      exclusivePending = false
      let released = false
      return () => {
        if (released) return
        released = true
        exclusive = false
      }
    },
  }
  transcriptGates.set(root, gate)
  return gate
}

export interface NodeSessionTranscriptMaintenance {
  currentHead(sessionId: string): Promise<string>
  purgeSession(
    sessionId: string,
    afterRewrite?: () => void,
  ): Promise<{ removedRows: number; retainedRows: number }>
  removeSessionControls(sessionId: string): Promise<void>
}

function hasExactKeys(value: object, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.size && actual.every(key => keys.has(key))
}

function safeId(value: string): void {
  if (!ID.test(value)) throw new Error('unsafe transcript identifier')
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function saveAtomic(path: string, content: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  syncPath(temporary)
  renameSync(temporary, path)
  syncPath(directory)
}

function createAtomic(path: string, content: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const temporary = `${path}.create-${process.pid}-${randomUUID()}`
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  syncPath(temporary)
  try {
    linkSync(temporary, path)
    syncPath(directory)
  } finally {
    unlinkSync(temporary)
  }
}

function readBounded(path: string, maxBytes: number): string {
  if (statSync(path).size > maxBytes) throw new Error('transcript state exceeds safety limit')
  return readFileSync(path, 'utf8')
}

function sameBinding(a: SessionTranscriptManifestV1, b: SessionTranscriptManifestV1): boolean {
  return a.operatorId === b.operatorId && a.profileId === b.profileId &&
    a.projectId === b.projectId && a.sessionId === b.sessionId
}

function validWal(value: unknown, sessionId: string): value is TranscriptCommit {
  if (typeof value !== 'object' || value === null) return false
  const wal = value as TranscriptCommit
  if (!hasExactKeys(value, WAL_KEYS) ||
    !Number.isSafeInteger(wal.expectedNextSessionSeq) || wal.expectedNextSessionSeq < 1 ||
    !HASH.test(wal.expectedHashHead) || typeof wal.row !== 'object' || wal.row === null ||
    !hasExactKeys(wal.row, ROW_KEYS) ||
    typeof wal.nextManifest !== 'object' || wal.nextManifest === null ||
    Buffer.byteLength(JSON.stringify(wal.row), 'utf8') > MAX_ROW_BYTES) return false
  return wal.row.sessionId === sessionId && wal.nextManifest.sessionId === sessionId &&
    wal.row.sessionSeq === wal.expectedNextSessionSeq &&
    wal.row.prevSessionHash === wal.expectedHashHead &&
    computeTranscriptRowHash(wal.row) === wal.row.rowHash &&
    wal.nextManifest.nextSessionSeq === wal.expectedNextSessionSeq + 1 &&
    wal.nextManifest.hashHead === wal.row.rowHash
}

function validManifestTransition(
  current: SessionTranscriptManifestV1,
  wal: TranscriptCommit,
): 'expected' | 'committed' | null {
  const expected = {
    ...current,
    nextSessionSeq: wal.expectedNextSessionSeq + 1,
    hashHead: wal.row.rowHash,
    // The same rule the service used to build this commit — shared, not
    // restated: two copies of it drifting apart is a CAS conflict on every turn.
    updatedAt: transcriptUpdatedAt(current, wal.row.ts),
  }
  if (current.nextSessionSeq === wal.expectedNextSessionSeq &&
    current.hashHead === wal.expectedHashHead &&
    isDeepStrictEqual(expected, wal.nextManifest)) return 'expected'
  if (isDeepStrictEqual(current, wal.nextManifest)) return 'committed'
  return null
}

export function makeNodeSessionTranscriptPersistence(input: {
  root: string
  nowIso?: () => string
  faultAt?: (point: 'after-wal' | 'after-row' | 'after-manifest') => void
  /**
   * Writer lease (ADR-0068). When supplied, ownership is re-checked before every
   * read or write, so a second process cannot touch the shared journal. Absent by
   * default: activation is a separate composition step.
   */
  lease?: { assertOwned(): void }
}): SessionTranscriptPersistencePort {
  const owned = (): void => { input.lease?.assertOwned() }
  const gate = gateFor(input.root)
  const asWriter = <T>(operation: () => T): T => {
    const leave = gate.enterWriter()
    try { return operation() } finally { leave() }
  }
  owned()
  mkdirSync(input.root, { recursive: true, mode: 0o700 })
  chmodSync(input.root, 0o700)
  const sessionsRoot = join(input.root, 'sessions')
  const transcriptPath = join(input.root, 'transcript-v2.jsonl')
  const nowIso = input.nowIso ?? (() => new Date().toISOString())
  mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 })
  chmodSync(sessionsRoot, 0o700)

  const paths = (sessionId: string) => {
    safeId(sessionId)
    const directory = join(sessionsRoot, sessionId)
    return {
      directory,
      manifest: join(directory, 'manifest.json'),
      wal: join(directory, 'append.wal.json'),
      quarantine: join(directory, 'quarantine.json'),
    }
  }

  const quarantineSync = (
    sessionId: string,
    reason: TranscriptQuarantineReason,
  ): void => {
    const target = paths(sessionId)
    const marker: TranscriptQuarantineMarkerV1 = {
      schemaVersion: 1,
      sessionId,
      reason,
      quarantinedAt: nowIso(),
    }
    saveAtomic(target.quarantine, JSON.stringify(marker, null, 2) + '\n')
  }

  const assertNotQuarantined = (sessionId: string): void => {
    if (existsSync(paths(sessionId).quarantine)) throw new Error('session transcript is quarantined')
  }

  const readManifestRaw = (sessionId: string): SessionTranscriptManifestV1 | null => {
    const path = paths(sessionId).manifest
    if (!existsSync(path)) return null
    return JSON.parse(readBounded(path, MAX_CONTROL_BYTES)) as SessionTranscriptManifestV1
  }

  const readTranscriptText = (): string => {
    if (!existsSync(transcriptPath)) return ''
    return readBounded(transcriptPath, MAX_TRANSCRIPT_BYTES)
  }

  const parseRows = (text = readTranscriptText()): TranscriptEnvelope[] => {
    const rows: TranscriptEnvelope[] = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      if (Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) throw new Error('transcript row exceeds safety limit')
      rows.push(JSON.parse(line) as TranscriptEnvelope)
    }
    return rows
  }

  const appendRow = (row: TranscriptEnvelope): void => {
    const line = JSON.stringify(row) + '\n'
    if (Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) throw new Error('transcript row exceeds safety limit')
    if (existsSync(transcriptPath) && statSync(transcriptPath).size + Buffer.byteLength(line, 'utf8') > MAX_TRANSCRIPT_BYTES) {
      throw new Error('transcript journal exceeds safety limit')
    }
    const descriptor = openSync(transcriptPath, 'a', 0o600)
    try {
      writeFileSync(descriptor, line, { encoding: 'utf8' })
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    chmodSync(transcriptPath, 0o600)
    syncPath(input.root)
  }

  const repairWalOwnedTail = (wal: TranscriptCommit): void => {
    if (!existsSync(transcriptPath)) return
    const text = readTranscriptText()
    if (text.length === 0 || text.endsWith('\n')) return
    const boundary = text.lastIndexOf('\n') + 1
    const fragment = text.slice(boundary)
    const expected = JSON.stringify(wal.row)
    if (!expected.startsWith(fragment)) throw new Error('partial transcript tail is not owned by WAL')
    const descriptor = openSync(transcriptPath, 'r+')
    try {
      ftruncateSync(descriptor, Buffer.byteLength(text.slice(0, boundary), 'utf8'))
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }

  const recoverSession = (sessionId: string): void => {
    const target = paths(sessionId)
    assertNotQuarantined(sessionId)
    if (!existsSync(target.wal)) return
    try {
      const walRaw = JSON.parse(readBounded(target.wal, MAX_CONTROL_BYTES)) as unknown
      if (!validWal(walRaw, sessionId)) throw new Error('invalid transcript WAL')
      const wal = walRaw
      repairWalOwnedTail(wal)
      const current = readManifestRaw(sessionId)
      if (!current) throw new Error('manifest missing during WAL recovery')
      if (!sameBinding(current, wal.nextManifest)) throw new Error('binding mismatch during WAL recovery')
      const transition = validManifestTransition(current, wal)
      if (transition === null) throw new Error('manifest CAS mismatch during WAL recovery')
      const existing = parseRows().find(row => row.eventId === wal.row.eventId)
      if (existing && existing.rowHash !== wal.row.rowHash) throw new Error('event id conflict during WAL recovery')
      if (!existing) appendRow(wal.row)

      if (transition === 'expected') saveAtomic(target.manifest, JSON.stringify(wal.nextManifest, null, 2) + '\n')
      unlinkSync(target.wal)
      syncPath(target.directory)
    } catch (error) {
      quarantineSync(sessionId, 'commit-conflict')
      throw error
    }
  }

  asWriter(() => {
    owned()
    for (const name of readdirSync(sessionsRoot)) {
      if (!ID.test(name)) continue
      try { recoverSession(name) } catch { /* marker is the durable startup result */ }
    }
  })

  return {
    async loadManifest(sessionId) {
      return asWriter(() => {
        owned()
        safeId(sessionId)
        recoverSession(sessionId)
        assertNotQuarantined(sessionId)
        return readManifestRaw(sessionId)
      })
    },
    async listRows(sessionId) {
      return asWriter(() => {
        owned()
        safeId(sessionId)
        recoverSession(sessionId)
        assertNotQuarantined(sessionId)
        return parseRows().filter(row => row.sessionId === sessionId)
      })
    },
    async findEvent(eventId) {
      return asWriter(() => {
        owned()
        safeId(eventId)
        return parseRows().find(row => row.eventId === eventId) ?? null
      })
    },
    async createManifest(manifest) {
      asWriter(() => {
        owned()
        safeId(manifest.sessionId)
        const target = paths(manifest.sessionId)
        assertNotQuarantined(manifest.sessionId)
        createAtomic(target.manifest, JSON.stringify(manifest, null, 2) + '\n')
      })
    },
    async commit(commit) {
      asWriter(() => {
        owned()
        safeId(commit.row.sessionId)
        const target = paths(commit.row.sessionId)
        recoverSession(commit.row.sessionId)
        assertNotQuarantined(commit.row.sessionId)
        if (!validWal(commit, commit.row.sessionId)) throw new Error('invalid transcript commit')
        const current = readManifestRaw(commit.row.sessionId)
        if (!current || !sameBinding(current, commit.nextManifest) ||
          validManifestTransition(current, commit) !== 'expected') {
          throw new Error('transcript manifest CAS conflict')
        }
        const existing = parseRows().find(row => row.eventId === commit.row.eventId)
        if (existing && existing.rowHash !== commit.row.rowHash) throw new Error('transcript event id conflict')

        let walPublished = false
        try {
          saveAtomic(target.wal, JSON.stringify(commit, null, 2) + '\n')
          walPublished = true
          input.faultAt?.('after-wal')
          if (!existing) appendRow(commit.row)
          input.faultAt?.('after-row')
          saveAtomic(target.manifest, JSON.stringify(commit.nextManifest, null, 2) + '\n')
          input.faultAt?.('after-manifest')
          unlinkSync(target.wal)
          syncPath(target.directory)
        } catch (error) {
          if (walPublished) throw new TranscriptCommitUncertainError()
          throw error
        }
      })
    },
    async quarantine(sessionId, reason) {
      asWriter(() => {
        owned()
        safeId(sessionId)
        quarantineSync(sessionId, reason)
      })
    },
  }
}

export function makeNodeSessionTranscriptMaintenance(input: {
  root: string
  lease?: { assertOwned(): void }
}): NodeSessionTranscriptMaintenance {
  const gate = gateFor(input.root)
  const transcriptPath = join(input.root, 'transcript-v2.jsonl')
  const sessionsRoot = join(input.root, 'sessions')
  const owned = (): void => { input.lease?.assertOwned() }

  return Object.freeze<NodeSessionTranscriptMaintenance>({
    async currentHead(sessionId) {
      safeId(sessionId)
      owned()
      const releaseWriter = gate.enterWriter()
      try {
        const manifestPath = join(sessionsRoot, sessionId, 'manifest.json')
        if (!existsSync(manifestPath)) throw new Error('SESSION_TRANSCRIPT_MANIFEST_MISSING')
        let manifest: SessionTranscriptManifestV1
      try {
          const parsed = parseSessionTranscriptManifest(
            JSON.parse(readBounded(manifestPath, MAX_CONTROL_BYTES)) as unknown,
          )
          if (parsed === null) throw new Error('invalid manifest')
          manifest = parsed
        } catch {
          throw new Error('SESSION_TRANSCRIPT_MANIFEST_CORRUPT')
        }
        const targetDirectory = join(sessionsRoot, sessionId)
        if (manifest.sessionId !== sessionId ||
          existsSync(join(targetDirectory, 'append.wal.json')) ||
          existsSync(join(targetDirectory, 'quarantine.json'))) {
          throw new Error('SESSION_TRANSCRIPT_MANIFEST_CORRUPT')
        }
        return manifest.hashHead
      } finally {
        releaseWriter()
      }
    },
    async purgeSession(sessionId, afterRewrite) {
      safeId(sessionId)
      owned()
      const release = await gate.beginExclusive()
      try {
        let removedRows = 0
        let retainedRows = 0
        if (existsSync(transcriptPath)) {
          const text = readBounded(transcriptPath, MAX_TRANSCRIPT_BYTES)
          if (text.length !== 0 && !text.endsWith('\n')) {
            throw new Error('SESSION_TRANSCRIPT_CORRUPT')
          }
          const retained: string[] = []
          for (const line of text.split('\n')) {
            if (line.length === 0) continue
            if (Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) {
              throw new Error('SESSION_TRANSCRIPT_CORRUPT')
            }
            let row: TranscriptEnvelope
            try {
              row = JSON.parse(line) as TranscriptEnvelope
              if (typeof row !== 'object' || row === null || !hasExactKeys(row, ROW_KEYS) ||
                typeof row.sessionId !== 'string' || !ID.test(row.sessionId) ||
                typeof row.rowHash !== 'string' || !HASH.test(row.rowHash) ||
                computeTranscriptRowHash(row) !== row.rowHash) {
                throw new Error('invalid row')
              }
            } catch {
              throw new Error('SESSION_TRANSCRIPT_CORRUPT')
            }
            if (row.sessionId === sessionId) removedRows += 1
            else {
              retained.push(line)
              retainedRows += 1
            }
          }
          saveAtomic(transcriptPath, retained.length === 0 ? '' : retained.join('\n') + '\n')
        }
        afterRewrite?.()
        return { removedRows, retainedRows }
      } finally {
        release()
      }
    },
    async removeSessionControls(sessionId) {
      safeId(sessionId)
      owned()
      const release = await gate.beginExclusive()
      try {
        const directory = join(sessionsRoot, sessionId)
        if (!existsSync(directory)) return
        if (lstatSync(directory).isSymbolicLink()) {
          throw new Error('SESSION_TRANSCRIPT_CONTROLS_UNSAFE')
        }
        rmSync(directory, { recursive: true, force: false })
        syncPath(sessionsRoot)
      } finally {
        release()
      }
    },
  })
}
