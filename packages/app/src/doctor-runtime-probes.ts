// Read-only production-topology probes for `aisy doctor`.

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import Database from 'better-sqlite3'

import type { OnboardingMemoryPort, TranscriptionReadinessProbe } from '@aisy/core'
import { deepgramProxyProviderMetadata } from './deepgram-proxy-provider.js'
import { inspectTranscriptionRegistry } from './transcription-registry.js'

function privateDatabase(path: string): boolean {
  try {
    const canonical = resolve(path)
    const directory = dirname(canonical)
    const directoryInfo = lstatSync(directory)
    const info = lstatSync(canonical)
    const uid = process.getuid?.()
    return typeof uid === 'number' && directoryInfo.isDirectory() &&
      !directoryInfo.isSymbolicLink() && realpathSync(directory) === directory &&
      directoryInfo.uid === uid && (directoryInfo.mode & 0o077) === 0 &&
      info.isFile() && !info.isSymbolicLink() && info.nlink === 1 &&
      realpathSync(canonical) === canonical && info.uid === uid && (info.mode & 0o077) === 0
  } catch {
    return false
  }
}

function openReadOnly(path: string): Database.Database {
  if (!privateDatabase(path)) throw new Error('UNSAFE_DATABASE')
  const before = lstatSync(path)
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 0 })
  try {
    db.pragma('query_only = ON')
    const after = lstatSync(path)
    if (!privateDatabase(path) || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('DATABASE_SUBSTITUTED')
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function integrityOk(db: Database.Database): boolean {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check?: unknown }>
  return rows.length === 1 && rows[0]?.integrity_check === 'ok'
}

function sameRows(left: readonly unknown[], right: readonly unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

type VoiceComponentState = 'ready' | 'unconfigured' | 'unavailable' | 'corrupt'
type VoicePathKind = 'file' | 'socket'

function rootOwnedVoicePath(path: string, kind: VoicePathKind): boolean {
  try {
    if (!isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path) return false
    const info = lstatSync(path)
    const uid = process.getuid?.()
    const gid = process.getgid?.()
    const permissionsSafe = kind === 'file'
      ? (info.mode & 0o022) === 0
      : info.gid === gid && (info.mode & 0o777) === 0o660
    if (info.isSymbolicLink() || info.uid !== 0 || !permissionsSafe ||
      (kind === 'file' ? !info.isFile() : !info.isSocket()) ||
      (kind === 'socket' && typeof uid !== 'number')) return false
    let current = dirname(path)
    for (;;) {
      const parentInfo = lstatSync(current)
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== 0 ||
        (parentInfo.mode & 0o022) !== 0) return false
      const parent = dirname(current)
      if (parent === current) return true
      current = parent
    }
  } catch {
    return false
  }
}

function readVoiceStatus(input: {
  path: string
  attest: (path: string, kind: VoicePathKind) => boolean
}): Readonly<{
  backend: VoiceComponentState
  key: VoiceComponentState
  proxy: VoiceComponentState
  outbox: VoiceComponentState
}> | null | 'corrupt' {
  if (!existsSync(input.path)) return null
  if (!input.attest(input.path, 'file')) return 'corrupt'
  try {
    const before = lstatSync(input.path)
    if (before.size < 2 || before.size > 8 * 1024) return 'corrupt'
    const value = JSON.parse(readFileSync(input.path, 'utf8')) as unknown
    const after = lstatSync(input.path)
    if (before.dev !== after.dev || before.ino !== after.ino || value === null ||
      typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return 'corrupt'
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    const expected = ['schemaVersion', 'backend', 'key', 'proxy', 'outbox']
    const state = (candidate: unknown): candidate is VoiceComponentState =>
      typeof candidate === 'string' &&
      ['ready', 'unconfigured', 'unavailable', 'corrupt'].includes(candidate)
    if (keys.length !== expected.length || keys.some(key => !expected.includes(key)) ||
      record['schemaVersion'] !== 1 || !state(record['backend']) || !state(record['key']) ||
      !state(record['proxy']) || !state(record['outbox'])) return 'corrupt'
    return Object.freeze({
      backend: record['backend'],
      key: record['key'],
      proxy: record['proxy'],
      outbox: record['outbox'],
    })
  } catch {
    return 'corrupt'
  }
}

/** Checks the global protected-memory ledger, keyword projection and scope
 * barrier without creating a directory, DB, WAL or recovery record. */
export function makeProtectedMemoryDoctorPort(input: {
  mode: string | undefined
  root: string
  operatorId: string
  profileId: string
}): OnboardingMemoryPort {
  return Object.freeze({
    async rebuildFromFiles(): Promise<void> {
      // ADR-0074 removed file-authoritative rebuild from the LIVE topology.
    },
    async integrityCheck() {
      if ((input.mode ?? 'preview') !== 'preview') {
        return { ok: false, detail: 'protected scoped memory disabled', repairable: false }
      }
      const ledgerPath = join(input.root, 'db', 'ledger.sqlite')
      const keywordPath = join(input.root, 'db', 'keyword.sqlite')
      const barrierPath = join(input.root, 'db', 'barrier.sqlite')
      if (![ledgerPath, keywordPath, barrierPath].every(existsSync)) {
        return { ok: false, detail: 'protected scoped memory not initialized', repairable: false }
      }
      let ledger: Database.Database | null = null
      let keyword: Database.Database | null = null
      let barrier: Database.Database | null = null
      try {
        ledger = openReadOnly(ledgerPath)
        keyword = openReadOnly(keywordPath)
        barrier = openReadOnly(barrierPath)
        if (!integrityOk(ledger) || !integrityOk(keyword) || !integrityOk(barrier)) throw new Error()
        const ledgerControl = ledger.prepare(`
          SELECT schema_version, operator_id, profile_id, scope_kind, scope_id, project_id
          FROM ledger_control WHERE singleton = 1
        `).get() as Record<string, unknown> | undefined
        const keywordControl = keyword.prepare(`
          SELECT schema_version, operator_id, profile_id, scope_kind, scope_id, project_id
          FROM keyword_control WHERE singleton = 1
        `).get() as Record<string, unknown> | undefined
        const barrierControl = barrier.prepare(`
          SELECT schema_version, operator_id, profile_id, scope_kind, scope_id, project_id
          FROM barrier_control WHERE singleton = 1
        `).get() as Record<string, unknown> | undefined
        const identity = (row: Record<string, unknown> | undefined, version: number): boolean =>
          row?.['schema_version'] === version && row['operator_id'] === input.operatorId &&
          row['profile_id'] === input.profileId && row['scope_kind'] === 'global' &&
          row['scope_id'] === 'global' && row['project_id'] === null
        if (!identity(ledgerControl, 2) || !identity(keywordControl, 1) ||
          !identity(barrierControl, 1)) throw new Error()
        const published = ledger.prepare(`
          SELECT operation_id, id AS fact_id, fact_key, source_path, content_hash, provenance
          FROM facts
          WHERE published = 1 AND invalid_at IS NULL
          ORDER BY operation_id
        `).all()
        const projected = keyword.prepare(`
          SELECT operation_id, fact_id, fact_key, source_path, content_hash, provenance
          FROM keyword_metadata
          ORDER BY operation_id
        `).all()
        if (!sameRows(published, projected)) throw new Error()
        const pending = ledger.prepare(`
          SELECT
            (SELECT COUNT(*) FROM memory_publication_wal) +
            (SELECT COUNT(*) FROM memory_deletion_wal) +
            (SELECT COUNT(*) FROM memory_update_wal) AS count
        `).get() as { count?: unknown } | undefined
        if (pending?.count !== 0) throw new Error()
        return { ok: true, repairable: false }
      } catch {
        return { ok: false, detail: 'protected scoped memory integrity failed', repairable: false }
      } finally {
        try { barrier?.close() } catch { /* read-only result already fixed */ }
        try { keyword?.close() } catch { /* read-only result already fixed */ }
        try { ledger?.close() } catch { /* read-only result already fixed */ }
      }
    },
    liveFactCount(): number { return 0 },
  })
}

export function makeTranscriptionDoctorProbe(input: {
  path: string
  voice?: Readonly<{
    artifactPath: string
    controlSocketPath: string
    bootstrapSocketPath: string
    statusPath: string
    attest?: (path: string, kind: VoicePathKind) => boolean
  }>
}): TranscriptionReadinessProbe {
  const provider = Object.freeze({
    ...deepgramProxyProviderMetadata,
    transcribe: async (): Promise<never> => { throw new Error('DOCTOR_READ_ONLY') },
  })
  return Object.freeze({
    inspect: () => {
      const consent = inspectTranscriptionRegistry({ providers: [provider], path: input.path })
      if (input.voice === undefined) return consent
      const attest = input.voice.attest ?? rootOwnedVoicePath
      const artifactReady = attest(input.voice.artifactPath, 'file')
      const socketsReady = attest(input.voice.controlSocketPath, 'socket') &&
        attest(input.voice.bootstrapSocketPath, 'socket')
      const status = readVoiceStatus({ path: input.voice.statusPath, attest })
      const statusState = (key: 'backend' | 'key' | 'proxy' | 'outbox'): VoiceComponentState =>
        status === null ? 'unavailable' : status === 'corrupt' ? 'corrupt' : status[key]
      return Object.freeze({
        ...consent,
        components: Object.freeze([
          Object.freeze({
            id: 'artifact' as const,
            state: artifactReady ? 'ready' as const : 'unavailable' as const,
            detail: artifactReady ? 'Root-owned voice artifact проверен' : 'Voice artifact недоступен или небезопасен',
          }),
          Object.freeze({
            id: 'backend' as const,
            state: socketsReady ? statusState('backend') : 'unavailable' as const,
            detail: socketsReady && statusState('backend') === 'ready'
              ? 'Control и bootstrap sockets готовы'
              : 'Voice backend или его sockets недоступны',
          }),
          Object.freeze({
            id: 'key' as const,
            state: statusState('key'),
            detail: statusState('key') === 'ready'
              ? 'Зашифрованный Deepgram key готов'
              : 'Deepgram key не готов; расшифрование doctor не выполняет',
          }),
          Object.freeze({
            id: 'proxy' as const,
            state: statusState('proxy'),
            detail: statusState('proxy') === 'ready' ? 'Root proxy готов' : 'Root proxy недоступен',
          }),
          Object.freeze({
            id: 'outbox' as const,
            state: statusState('outbox'),
            detail: statusState('outbox') === 'ready' ? 'Recovery outbox чист' : 'Recovery outbox требует внимания',
          }),
          Object.freeze({
            id: 'consent' as const,
            state: consent.state === 'ready' ? 'ready' as const
              : consent.state === 'unconfigured' ? 'unconfigured' as const : 'corrupt' as const,
            detail: consent.state === 'ready'
              ? 'Согласие на cloud-транскрипцию выбрано'
              : 'Согласие на cloud-транскрипцию не готово',
          }),
        ]),
      })
    },
  })
}
