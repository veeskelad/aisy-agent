import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { dirname } from 'node:path'
import type {
  SwitchAuthorityNonceRecord,
  SwitchAuthorityNonceStore,
} from '@aisy/core'

interface SwitchAuthorityNonceFile {
  version: 1
  records: SwitchAuthorityNonceRecord[]
}

export interface JsonSwitchAuthorityNonceStoreDeps {
  path: string
  exists(path: string): boolean
  readFile(path: string): string
  writeFileExclusive(path: string, content: string): void
  syncFile(path: string): void
  renameFile(from: string, to: string): void
  syncDirectory(path: string): void
  nowMs(): number
}

export class SwitchAuthorityNonceStoreError extends Error {
  constructor(
    public readonly code:
      | 'CORRUPT_NONCE_STORE'
      | 'INVALID_NONCE_RECORD'
      | 'DUPLICATE_RECEIPT_ID',
  ) {
    super(code)
    this.name = 'SwitchAuthorityNonceStoreError'
  }
}

const MAC = /^[a-f0-9]{64}$/
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/

function now(deps: JsonSwitchAuthorityNonceStoreDeps): number {
  const value = deps.nowMs()
  if (!Number.isFinite(value)) throw new SwitchAuthorityNonceStoreError('INVALID_NONCE_RECORD')
  return value
}

function validateRecord(input: unknown): SwitchAuthorityNonceRecord {
  if (input === null || typeof input !== 'object') {
    throw new SwitchAuthorityNonceStoreError('INVALID_NONCE_RECORD')
  }
  const candidate = input as Partial<SwitchAuthorityNonceRecord>
  if (typeof candidate.receiptId !== 'string' ||
    candidate.receiptId.length < 1 || candidate.receiptId.length > 200 ||
    candidate.receiptId !== candidate.receiptId.trim() || CONTROL_CHAR.test(candidate.receiptId) ||
    typeof candidate.mac !== 'string' || !MAC.test(candidate.mac) ||
    typeof candidate.expiresAt !== 'string') {
    throw new SwitchAuthorityNonceStoreError('INVALID_NONCE_RECORD')
  }
  const expiresAt = Date.parse(candidate.expiresAt)
  if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== candidate.expiresAt) {
    throw new SwitchAuthorityNonceStoreError('INVALID_NONCE_RECORD')
  }
  return {
    receiptId: candidate.receiptId,
    mac: candidate.mac,
    expiresAt: candidate.expiresAt,
  }
}

function validateFile(input: unknown): SwitchAuthorityNonceRecord[] {
  if (input === null || typeof input !== 'object') {
    throw new SwitchAuthorityNonceStoreError('CORRUPT_NONCE_STORE')
  }
  const candidate = input as Partial<SwitchAuthorityNonceFile>
  if (candidate.version !== 1 || !Array.isArray(candidate.records)) {
    throw new SwitchAuthorityNonceStoreError('CORRUPT_NONCE_STORE')
  }
  const ids = new Set<string>()
  return candidate.records.map((item) => {
    let record: SwitchAuthorityNonceRecord
    try {
      record = validateRecord(item)
    } catch {
      throw new SwitchAuthorityNonceStoreError('CORRUPT_NONCE_STORE')
    }
    if (ids.has(record.receiptId)) {
      throw new SwitchAuthorityNonceStoreError('CORRUPT_NONCE_STORE')
    }
    ids.add(record.receiptId)
    return record
  })
}

function macMatches(left: string, right: string): boolean {
  if (!MAC.test(left) || !MAC.test(right)) return false
  const leftBytes = Buffer.from(left, 'hex')
  const rightBytes = Buffer.from(right, 'hex')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function makeJsonSwitchAuthorityNonceStore(
  deps: JsonSwitchAuthorityNonceStoreDeps,
): SwitchAuthorityNonceStore {
  const tempPath = deps.path + '.tmp'
  let records: SwitchAuthorityNonceRecord[] = []
  if (deps.exists(deps.path)) {
    try {
      records = validateFile(JSON.parse(deps.readFile(deps.path)) as unknown)
    } catch (error) {
      if (error instanceof SwitchAuthorityNonceStoreError) throw error
      throw new SwitchAuthorityNonceStoreError('CORRUPT_NONCE_STORE')
    }
  }

  const publish = (next: SwitchAuthorityNonceRecord[]): void => {
    const file: SwitchAuthorityNonceFile = {
      version: 1,
      records: next
        .map((item) => ({ ...item }))
        .sort((left, right) => left.receiptId.localeCompare(right.receiptId)),
    }
    deps.writeFileExclusive(tempPath, JSON.stringify(file, null, 2) + '\n')
    deps.syncFile(tempPath)
    deps.renameFile(tempPath, deps.path)
    deps.syncDirectory(dirname(deps.path))
    records = file.records
  }

  return {
    issue(input) {
      const record = validateRecord(input)
      const currentTime = now(deps)
      if (Date.parse(record.expiresAt) <= currentTime) {
        throw new SwitchAuthorityNonceStoreError('INVALID_NONCE_RECORD')
      }
      const live = records.filter((item) => Date.parse(item.expiresAt) > currentTime)
      if (live.some((item) => item.receiptId === record.receiptId)) {
        throw new SwitchAuthorityNonceStoreError('DUPLICATE_RECEIPT_ID')
      }
      publish([...live, record])
    },

    has(receiptId, mac) {
      const currentTime = now(deps)
      const record = records.find((item) => item.receiptId === receiptId)
      return record !== undefined && Date.parse(record.expiresAt) > currentTime &&
        macMatches(record.mac, mac)
    },

    consume(receiptId, mac) {
      const currentTime = now(deps)
      const index = records.findIndex((item) => item.receiptId === receiptId)
      const record = records[index]
      if (record === undefined || Date.parse(record.expiresAt) <= currentTime ||
        !macMatches(record.mac, mac)) {
        return false
      }
      publish(records.filter((_, candidateIndex) => candidateIndex !== index))
      return true
    },
  }
}

function syncPath(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function makeNodeSwitchAuthorityNonceStore(input: {
  path: string
  nowMs?: () => number
}): SwitchAuthorityNonceStore {
  const directory = dirname(input.path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return makeJsonSwitchAuthorityNonceStore({
    path: input.path,
    exists: (path) => existsSync(path),
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFileExclusive: (path, content) => writeFileSync(path, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    }),
    syncFile: syncPath,
    renameFile: (from, to) => renameSync(from, to),
    syncDirectory: syncPath,
    nowMs: input.nowMs ?? Date.now,
  })
}
