import { timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { MemoryPermanenceNonceRecord, MemoryPermanenceNonceStore } from '@aisy/core'

interface IssuedRecord extends MemoryPermanenceNonceRecord {
  status: 'issued'
}

interface ConsumedRecord extends MemoryPermanenceNonceRecord {
  status: 'consumed'
  consumedAt: string
}

type DurableRecord = IssuedRecord | ConsumedRecord

interface MemoryPermanenceNonceFileV1 {
  version: 1
  records: DurableRecord[]
}

export interface JsonMemoryPermanenceNonceStoreDeps {
  path: string
  exists(path: string): boolean
  readFile(path: string): string
  writeFileExclusive(path: string, content: string): void
  syncFile(path: string): void
  renameFile(from: string, to: string): void
  syncDirectory(path: string): void
  nowMs(): number
}

export class MemoryPermanenceNonceStoreError extends Error {
  constructor(public readonly code:
    | 'CORRUPT_NONCE_STORE'
    | 'INVALID_NONCE_RECORD'
    | 'DUPLICATE_RECEIPT_ID'
    | 'UNSAFE_STORE_PATH',
  ) {
    super(code)
    this.name = 'MemoryPermanenceNonceStoreError'
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAC = /^[a-f0-9]{64}$/
const ISSUED_KEYS = new Set(['receiptId', 'mac', 'expiresAt', 'status'])
const CONSUMED_KEYS = new Set([...ISSUED_KEYS, 'consumedAt'])
const MAX_RECORDS = 10_000
const MAX_STORE_BYTES = 4 * 1024 * 1024
const MAX_DATE_MS = 8_640_000_000_000_000

function validIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function currentTime(deps: JsonMemoryPermanenceNonceStoreDeps): number {
  const value = deps.nowMs()
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
    throw new MemoryPermanenceNonceStoreError('INVALID_NONCE_RECORD')
  }
  return value
}

function validateRecord(value: unknown): DurableRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryPermanenceNonceStoreError('INVALID_NONCE_RECORD')
  }
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate)
  const expected = candidate['status'] === 'consumed' ? CONSUMED_KEYS : ISSUED_KEYS
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key)) ||
    typeof candidate['receiptId'] !== 'string' || !ID.test(candidate['receiptId']) ||
    typeof candidate['mac'] !== 'string' || !MAC.test(candidate['mac']) ||
    !validIso(candidate['expiresAt']) ||
    (candidate['status'] !== 'issued' && candidate['status'] !== 'consumed')) {
    throw new MemoryPermanenceNonceStoreError('INVALID_NONCE_RECORD')
  }
  if (candidate['status'] === 'consumed') {
    if (!validIso(candidate['consumedAt']) ||
      Date.parse(candidate['consumedAt']) > Date.parse(candidate['expiresAt'])) {
      throw new MemoryPermanenceNonceStoreError('INVALID_NONCE_RECORD')
    }
    return {
      receiptId: candidate['receiptId'],
      mac: candidate['mac'],
      expiresAt: candidate['expiresAt'],
      status: 'consumed',
      consumedAt: candidate['consumedAt'],
    }
  }
  return {
    receiptId: candidate['receiptId'],
    mac: candidate['mac'],
    expiresAt: candidate['expiresAt'],
    status: 'issued',
  }
}

function validateFile(value: unknown): DurableRecord[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryPermanenceNonceStoreError('CORRUPT_NONCE_STORE')
  }
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).length !== 2 || candidate['version'] !== 1 ||
    !Array.isArray(candidate['records']) || candidate['records'].length > MAX_RECORDS) {
    throw new MemoryPermanenceNonceStoreError('CORRUPT_NONCE_STORE')
  }
  const ids = new Set<string>()
  return candidate['records'].map((item) => {
    let record: DurableRecord
    try { record = validateRecord(item) } catch {
      throw new MemoryPermanenceNonceStoreError('CORRUPT_NONCE_STORE')
    }
    if (ids.has(record.receiptId)) {
      throw new MemoryPermanenceNonceStoreError('CORRUPT_NONCE_STORE')
    }
    ids.add(record.receiptId)
    return record
  })
}

function macMatches(left: string, right: string): boolean {
  if (!MAC.test(left) || !MAC.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export function makeJsonMemoryPermanenceNonceStore(
  deps: JsonMemoryPermanenceNonceStoreDeps,
): MemoryPermanenceNonceStore {
  const temporary = deps.path + '.tmp'
  let records: DurableRecord[] = []
  if (deps.exists(deps.path)) {
    try {
      const content = deps.readFile(deps.path)
      if (Buffer.byteLength(content, 'utf8') > MAX_STORE_BYTES) {
        throw new MemoryPermanenceNonceStoreError('CORRUPT_NONCE_STORE')
      }
      records = validateFile(JSON.parse(content) as unknown)
    } catch (error) {
      if (error instanceof MemoryPermanenceNonceStoreError) throw error
      throw new MemoryPermanenceNonceStoreError('CORRUPT_NONCE_STORE')
    }
  }

  const publish = (next: DurableRecord[]): void => {
    const file: MemoryPermanenceNonceFileV1 = {
      version: 1,
      records: next.map((record) => ({ ...record })).sort(
        (left, right) => left.receiptId.localeCompare(right.receiptId),
      ),
    }
    const content = JSON.stringify(file, null, 2) + '\n'
    if (Buffer.byteLength(content, 'utf8') > MAX_STORE_BYTES) {
      throw new MemoryPermanenceNonceStoreError('INVALID_NONCE_RECORD')
    }
    deps.writeFileExclusive(temporary, content)
    deps.syncFile(temporary)
    deps.renameFile(temporary, deps.path)
    records = file.records
    deps.syncDirectory(dirname(deps.path))
  }

  return Object.freeze<MemoryPermanenceNonceStore>({
    issue(input) {
      let base: DurableRecord
      try { base = validateRecord({ ...input, status: 'issued' }) } catch {
        throw new MemoryPermanenceNonceStoreError('INVALID_NONCE_RECORD')
      }
      const now = currentTime(deps)
      if (Date.parse(base.expiresAt) <= now) {
        throw new MemoryPermanenceNonceStoreError('INVALID_NONCE_RECORD')
      }
      const live = records.filter((record) => Date.parse(record.expiresAt) > now)
      if (live.some((record) => record.receiptId === base.receiptId)) {
        throw new MemoryPermanenceNonceStoreError('DUPLICATE_RECEIPT_ID')
      }
      publish([...live, base])
    },

    consume(receiptId, mac) {
      if (!ID.test(receiptId) || !MAC.test(mac)) return false
      const now = currentTime(deps)
      const index = records.findIndex((record) => record.receiptId === receiptId)
      const record = records[index]
      if (!record || record.status !== 'issued' || Date.parse(record.expiresAt) <= now ||
        !macMatches(record.mac, mac)) return false
      const consumed: ConsumedRecord = {
        ...record,
        status: 'consumed',
        consumedAt: new Date(now).toISOString(),
      }
      const next = records.slice()
      next[index] = consumed
      publish(next)
      return true
    },
  })
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)) {
    throw new MemoryPermanenceNonceStoreError('UNSAFE_STORE_PATH')
  }
  chmodSync(path, 0o700)
}

function assertSafeFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
    stat.size > MAX_STORE_BYTES || realpathSync(path) !== path || (stat.mode & 0o077) !== 0) {
    throw new MemoryPermanenceNonceStoreError('UNSAFE_STORE_PATH')
  }
}

export function makeNodeMemoryPermanenceNonceStore(input: {
  path: string
  nowMs?: () => number
}): MemoryPermanenceNonceStore {
  const path = resolve(input.path)
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertPrivateDirectory(directory)
  if (existsSync(path)) assertSafeFile(path)
  if (existsSync(path + '.tmp')) throw new MemoryPermanenceNonceStoreError('UNSAFE_STORE_PATH')
  return makeJsonMemoryPermanenceNonceStore({
    path,
    exists: existsSync,
    readFile: (value) => readFileSync(value, 'utf8'),
    writeFileExclusive: (value, content) => writeFileSync(value, content, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    }),
    syncFile: syncPath,
    renameFile: renameSync,
    syncDirectory: syncPath,
    nowMs: input.nowMs ?? Date.now,
  })
}
