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
import type { CrossProjectNonceRecord, CrossProjectNonceStore } from '@aisy/core'

interface CrossProjectNonceFileV1 {
  version: 1
  records: CrossProjectNonceRecord[]
}

export interface JsonCrossProjectNonceStoreDeps {
  path: string
  exists(path: string): boolean
  readFile(path: string): string
  writeFileExclusive(path: string, content: string): void
  syncFile(path: string): void
  renameFile(from: string, to: string): void
  syncDirectory(path: string): void
  nowMs(): number
}

export class CrossProjectNonceStoreError extends Error {
  constructor(public readonly code:
    | 'CORRUPT_NONCE_STORE'
    | 'INVALID_NONCE_RECORD'
    | 'DUPLICATE_NONCE_ID'
    | 'UNSAFE_STORE_PATH',
  ) {
    super(code)
    this.name = 'CrossProjectNonceStoreError'
  }
}

const MAC = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const RECORD_KEYS = new Set(['id', 'kind', 'mac', 'expiresAt'])

function validateRecord(value: unknown): CrossProjectNonceRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CrossProjectNonceStoreError('INVALID_NONCE_RECORD')
  }
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate)
  if (keys.length !== RECORD_KEYS.size || keys.some((key) => !RECORD_KEYS.has(key)) ||
    typeof candidate['id'] !== 'string' || !ID.test(candidate['id']) ||
    (candidate['kind'] !== 'search' && candidate['kind'] !== 'excerpt') ||
    typeof candidate['mac'] !== 'string' || !MAC.test(candidate['mac']) ||
    typeof candidate['expiresAt'] !== 'string') {
    throw new CrossProjectNonceStoreError('INVALID_NONCE_RECORD')
  }
  const expiresAt = Date.parse(candidate['expiresAt'])
  if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== candidate['expiresAt']) {
    throw new CrossProjectNonceStoreError('INVALID_NONCE_RECORD')
  }
  return {
    id: candidate['id'],
    kind: candidate['kind'],
    mac: candidate['mac'],
    expiresAt: candidate['expiresAt'],
  }
}

function recordKey(record: Pick<CrossProjectNonceRecord, 'id' | 'kind'>): string {
  return `${record.kind}\0${record.id}`
}

function validateFile(value: unknown): CrossProjectNonceRecord[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CrossProjectNonceStoreError('CORRUPT_NONCE_STORE')
  }
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).length !== 2 || candidate['version'] !== 1 ||
    !Array.isArray(candidate['records'])) {
    throw new CrossProjectNonceStoreError('CORRUPT_NONCE_STORE')
  }
  const ids = new Set<string>()
  return candidate['records'].map((value) => {
    let record: CrossProjectNonceRecord
    try { record = validateRecord(value) } catch {
      throw new CrossProjectNonceStoreError('CORRUPT_NONCE_STORE')
    }
    const key = recordKey(record)
    if (ids.has(key)) throw new CrossProjectNonceStoreError('CORRUPT_NONCE_STORE')
    ids.add(key)
    return record
  })
}

function macMatches(left: string, right: string): boolean {
  if (!MAC.test(left) || !MAC.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export function makeJsonCrossProjectNonceStore(
  deps: JsonCrossProjectNonceStoreDeps,
): CrossProjectNonceStore {
  const temporary = deps.path + '.tmp'
  let records: CrossProjectNonceRecord[] = []
  if (deps.exists(deps.path)) {
    try {
      records = validateFile(JSON.parse(deps.readFile(deps.path)) as unknown)
    } catch (error) {
      if (error instanceof CrossProjectNonceStoreError) throw error
      throw new CrossProjectNonceStoreError('CORRUPT_NONCE_STORE')
    }
  }
  const currentTime = (): number => {
    const value = deps.nowMs()
    if (!Number.isFinite(value)) throw new CrossProjectNonceStoreError('INVALID_NONCE_RECORD')
    return value
  }
  const publish = (next: CrossProjectNonceRecord[]): void => {
    const file: CrossProjectNonceFileV1 = {
      version: 1,
      records: next.map((record) => ({ ...record })).sort((left, right) =>
        recordKey(left).localeCompare(recordKey(right))),
    }
    deps.writeFileExclusive(temporary, JSON.stringify(file, null, 2) + '\n')
    deps.syncFile(temporary)
    deps.renameFile(temporary, deps.path)
    deps.syncDirectory(dirname(deps.path))
    records = file.records
  }

  return Object.freeze<CrossProjectNonceStore>({
    issue(value) {
      const record = validateRecord(value)
      const now = currentTime()
      if (Date.parse(record.expiresAt) <= now) {
        throw new CrossProjectNonceStoreError('INVALID_NONCE_RECORD')
      }
      const live = records.filter((item) => Date.parse(item.expiresAt) > now)
      if (live.some((item) => recordKey(item) === recordKey(record))) {
        throw new CrossProjectNonceStoreError('DUPLICATE_NONCE_ID')
      }
      publish([...live, record])
    },

    consume(id, kind, mac) {
      const now = currentTime()
      const index = records.findIndex((record) => record.id === id && record.kind === kind)
      const record = records[index]
      if (!record || Date.parse(record.expiresAt) <= now || !macMatches(record.mac, mac)) {
        return false
      }
      publish(records.filter((_, candidate) => candidate !== index))
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
    throw new CrossProjectNonceStoreError('UNSAFE_STORE_PATH')
  }
  chmodSync(path, 0o700)
}

export function makeNodeCrossProjectNonceStore(input: {
  path: string
  nowMs?: () => number
}): CrossProjectNonceStore {
  const path = resolve(input.path)
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertPrivateDirectory(directory)
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      realpathSync(path) !== path || (stat.mode & 0o077) !== 0) {
      throw new CrossProjectNonceStoreError('UNSAFE_STORE_PATH')
    }
  }
  return makeJsonCrossProjectNonceStore({
    path,
    exists: existsSync,
    readFile: (value) => readFileSync(value, 'utf8'),
    writeFileExclusive: (value, content) => writeFileSync(value, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    }),
    syncFile: syncPath,
    renameFile: renameSync,
    syncDirectory: syncPath,
    nowMs: input.nowMs ?? Date.now,
  })
}
