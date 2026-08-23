import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export type MonitoringTelegramSendLedgerErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_STATE'
  | 'STATE_FULL'
  | 'PAYLOAD_MISMATCH'
  | 'AMBIGUOUS_SEND'
  | 'INVALID_RECEIPT'

export class MonitoringTelegramSendLedgerError extends Error {
  constructor(readonly code: MonitoringTelegramSendLedgerErrorCode) {
    super(code)
    this.name = 'MonitoringTelegramSendLedgerError'
  }
}

interface SendingEntry {
  key: string
  chatId: number
  payloadHash: string
  status: 'sending'
}

interface SentEntry {
  key: string
  chatId: number
  payloadHash: string
  status: 'sent'
  messageId: number
}

type SendEntry = SendingEntry | SentEntry

interface SendState {
  schemaVersion: 1
  entries: SendEntry[]
}

export interface MonitoringTelegramSendLedger {
  send(input: {
    idempotencyKey: string
    chatId: number
    html: string
    transport(): Promise<{ messageId: number }>
  }): Promise<{ messageId: number }>
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const HASH = /^[a-f0-9]{64}$/
const MAX_HTML_BYTES = 32 * 1024
const MAX_ENTRIES = 2_000

function invalidState(): never {
  throw new MonitoringTelegramSendLedgerError('INVALID_STATE')
}

function parseState(raw: string): SendState {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return invalidState() }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidState()
  const state = value as Record<string, unknown>
  if (Object.keys(state).sort().join(',') !== 'entries,schemaVersion' ||
    state['schemaVersion'] !== 1 || !Array.isArray(state['entries']) ||
    state['entries'].length > MAX_ENTRIES) return invalidState()
  const entries: SendEntry[] = []
  const seen = new Set<string>()
  for (const rawEntry of state['entries']) {
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) return invalidState()
    const entry = rawEntry as Record<string, unknown>
    const baseValid = typeof entry['key'] === 'string' && KEY.test(entry['key']) &&
      typeof entry['chatId'] === 'number' && Number.isSafeInteger(entry['chatId']) && entry['chatId'] !== 0 &&
      typeof entry['payloadHash'] === 'string' && HASH.test(entry['payloadHash']) &&
      (entry['status'] === 'sending' || entry['status'] === 'sent') && !seen.has(entry['key'])
    if (!baseValid) return invalidState()
    seen.add(entry['key'] as string)
    if (entry['status'] === 'sending') {
      if (Object.keys(entry).sort().join(',') !== 'chatId,key,payloadHash,status') return invalidState()
      entries.push({
        key: entry['key'] as string,
        chatId: entry['chatId'] as number,
        payloadHash: entry['payloadHash'] as string,
        status: 'sending',
      })
    } else {
      if (Object.keys(entry).sort().join(',') !== 'chatId,key,messageId,payloadHash,status' ||
        typeof entry['messageId'] !== 'number' || !Number.isSafeInteger(entry['messageId']) ||
        entry['messageId'] <= 0) return invalidState()
      entries.push({
        key: entry['key'] as string,
        chatId: entry['chatId'] as number,
        payloadHash: entry['payloadHash'] as string,
        status: 'sent',
        messageId: entry['messageId'],
      })
    }
  }
  return { schemaVersion: 1, entries }
}

function payloadHash(chatId: number, html: string): string {
  return createHash('sha256').update(JSON.stringify([
    'aisy.monitoring-telegram-send.v1', chatId, html,
  ])).digest('hex')
}

/**
 * Durable at-most-once fence around Telegram sendMessage.
 *
 * A crash after the remote side may have accepted a message is deliberately
 * ambiguous: the same key will never be sent again automatically. A successful
 * receipt is cached so a crash before the monitoring DB update can recover it
 * without repeating Telegram I/O.
 */
export function makeNodeMonitoringTelegramSendLedger(input: {
  path: string
  newTempId?: () => string
}): MonitoringTelegramSendLedger {
  const newTempId = input.newTempId ?? randomUUID
  mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 })
  let state = existsSync(input.path)
    ? parseState(readFileSync(input.path, 'utf8'))
    : { schemaVersion: 1 as const, entries: [] }
  if (existsSync(input.path)) chmodSync(input.path, 0o600)

  const save = (candidate: SendState): void => {
    const temporary = `${input.path}.${newTempId()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(candidate, null, 2) + '\n', {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      })
      renameSync(temporary, input.path)
      chmodSync(input.path, 0o600)
      state = candidate
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* absent or already renamed */ }
      throw error
    }
  }

  return Object.freeze<MonitoringTelegramSendLedger>({
    async send({ idempotencyKey, chatId, html, transport }) {
      if (!KEY.test(idempotencyKey) || !Number.isSafeInteger(chatId) || chatId === 0 ||
        typeof html !== 'string' || html.length === 0 ||
        Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES || typeof transport !== 'function') {
        throw new MonitoringTelegramSendLedgerError('INVALID_INPUT')
      }
      const hash = payloadHash(chatId, html)
      const existing = state.entries.find((entry) => entry.key === idempotencyKey)
      if (existing !== undefined) {
        if (existing.chatId !== chatId || existing.payloadHash !== hash) {
          throw new MonitoringTelegramSendLedgerError('PAYLOAD_MISMATCH')
        }
        if (existing.status === 'sent') return { messageId: existing.messageId }
        throw new MonitoringTelegramSendLedgerError('AMBIGUOUS_SEND')
      }

      const sending = state.entries.filter((entry) => entry.status === 'sending')
      const sent = state.entries.filter((entry) => entry.status === 'sent')
      if (sending.length >= MAX_ENTRIES) {
        throw new MonitoringTelegramSendLedgerError('STATE_FULL')
      }
      const keepSent = sent.slice(Math.max(0, sent.length - (MAX_ENTRIES - sending.length - 1)))
      save({
        schemaVersion: 1,
        entries: [...sending, ...keepSent, { key: idempotencyKey, chatId, payloadHash: hash, status: 'sending' }],
      })

      const receipt = await transport()
      if (!Number.isSafeInteger(receipt.messageId) || receipt.messageId <= 0) {
        throw new MonitoringTelegramSendLedgerError('INVALID_RECEIPT')
      }
      const completed: SentEntry = {
        key: idempotencyKey, chatId, payloadHash: hash, status: 'sent', messageId: receipt.messageId,
      }
      save({
        schemaVersion: 1,
        entries: state.entries.map((entry) => entry.key === idempotencyKey ? completed : entry),
      })
      return { messageId: completed.messageId }
    },
  })
}
