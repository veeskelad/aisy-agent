// Registry of the bots served by one installation (ADR-0076).
//
// A bot is the unit of identity and memory: separate token, chat, memory root,
// sessions and settings; shared server, secrets and project files. The registry
// holds only the routing facts — never a token value, which stays in the vault.

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export type BotRegistryRefusal =
  | 'invalid-bot'
  | 'duplicate-id'
  | 'duplicate-chat'
  | 'duplicate-token-ref'
  | 'unknown-bot'

export class BotRegistryError extends Error {
  constructor(readonly reason: BotRegistryRefusal) {
    super(`bot registry refused: ${reason}`)
    this.name = 'BotRegistryError'
  }
}

export interface BotRecord {
  /** Stable identity used in every durable binding of this bot's work. */
  id: string
  /** Operator-facing name, e.g. "Копирайтер". */
  name: string
  /** Env variable holding the token; the value itself never enters the registry. */
  tokenEnv: string
  /** The single chat this bot answers in. */
  chatId: number
  /** Optional role note shown to the operator. */
  role?: string
  createdAt: string
  archivedAt?: string
}

interface BotRegistryStateV1 {
  schemaVersion: 1
  bots: BotRecord[]
}

export interface BotRegistry {
  list(includeArchived?: boolean): BotRecord[]
  /** The bot a message belongs to, resolved by the token env it arrived on. */
  byTokenEnv(tokenEnv: string): BotRecord | null
  byId(botId: string): BotRecord | null
  /** First bot of the installation — owner of records written before multi-bot. */
  primary(): BotRecord | null
  add(input: { name: string; tokenEnv: string; chatId: number; role?: string }): BotRecord
  archive(botId: string): BotRecord
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const TOKEN_ENV = /^[A-Z][A-Z0-9_]{0,127}$/
const MAX_BOTS = 32
const MAX_STATE_BYTES = 256 * 1024

function validRecord(value: unknown): value is BotRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as BotRecord
  return typeof record.id === 'string' && ID.test(record.id) &&
    typeof record.name === 'string' && record.name.trim() !== '' && record.name.length <= 128 &&
    typeof record.tokenEnv === 'string' && TOKEN_ENV.test(record.tokenEnv) &&
    Number.isSafeInteger(record.chatId) &&
    (record.role === undefined || (typeof record.role === 'string' && record.role.length <= 256)) &&
    typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt)) &&
    (record.archivedAt === undefined ||
      (typeof record.archivedAt === 'string' && Number.isFinite(Date.parse(record.archivedAt))))
}

export function makeBotRegistry(input: {
  path: string
  nowIso?: () => string
  newId?: () => string
}): BotRegistry {
  const nowIso = input.nowIso ?? (() => new Date().toISOString())
  const newId = input.newId ?? (() => randomUUID())

  const read = (): BotRecord[] => {
    if (!existsSync(input.path)) return []
    try {
      if (statSync(input.path).size > MAX_STATE_BYTES) return []
      const parsed = JSON.parse(readFileSync(input.path, 'utf8')) as BotRegistryStateV1
      if (typeof parsed !== 'object' || parsed === null || parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.bots)) return []
      const accepted: BotRecord[] = []
      const ids = new Set<string>()
      for (const record of parsed.bots) {
        // A malformed entry is dropped, never partially trusted: routing by a
        // half-valid record would answer in the wrong chat.
        if (!validRecord(record) || ids.has(record.id)) continue
        ids.add(record.id)
        accepted.push({ ...record })
      }
      return accepted
    } catch {
      return []
    }
  }

  const write = (bots: readonly BotRecord[]): void => {
    const directory = dirname(input.path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    const temporary = `${input.path}.tmp-${process.pid}-${randomUUID()}`
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, bots }, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    const descriptor = openSync(temporary, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
    renameSync(temporary, input.path)
  }

  const live = (bots: readonly BotRecord[]): BotRecord[] =>
    bots.filter((bot) => bot.archivedAt === undefined)

  return {
    list(includeArchived = false) {
      const bots = read()
      return (includeArchived ? bots : live(bots)).map((bot) => ({ ...bot }))
    },

    byTokenEnv(tokenEnv: string) {
      if (typeof tokenEnv !== 'string' || !TOKEN_ENV.test(tokenEnv)) return null
      return live(read()).find((bot) => bot.tokenEnv === tokenEnv) ?? null
    },

    byId(botId: string) {
      if (typeof botId !== 'string' || !ID.test(botId)) return null
      return read().find((bot) => bot.id === botId) ?? null
    },

    primary() {
      // Creation order is the tie-breaker, so "the first bot" stays the same bot
      // across restarts even after others are added or archived.
      const bots = [...live(read())].sort((left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id))
      return bots[0] ?? null
    },

    add({ name, tokenEnv, chatId, role }) {
      const bots = read()
      if (bots.length >= MAX_BOTS) throw new BotRegistryError('invalid-bot')
      const record: BotRecord = {
        id: newId(),
        name,
        tokenEnv,
        chatId,
        ...(role === undefined ? {} : { role }),
        createdAt: nowIso(),
      }
      if (!validRecord(record)) throw new BotRegistryError('invalid-bot')
      if (bots.some((bot) => bot.id === record.id)) throw new BotRegistryError('duplicate-id')
      // Two bots on one chat would race for the same conversation; two bots on
      // one token are the same bot twice.
      if (live(bots).some((bot) => bot.chatId === record.chatId)) {
        throw new BotRegistryError('duplicate-chat')
      }
      if (live(bots).some((bot) => bot.tokenEnv === record.tokenEnv)) {
        throw new BotRegistryError('duplicate-token-ref')
      }
      write([...bots, record])
      return { ...record }
    },

    archive(botId: string) {
      const bots = read()
      const target = bots.find((bot) => bot.id === botId)
      if (!target) throw new BotRegistryError('unknown-bot')
      // Archiving never deletes: the bot's memory and journal stay addressable.
      const archived: BotRecord = { ...target, archivedAt: nowIso() }
      write(bots.map((bot) => (bot.id === botId ? archived : bot)))
      return archived
    },
  }
}
