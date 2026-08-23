import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BotRegistryError, makeBotRegistry } from './bot-registry-store.js'

const roots: string[] = []

function registryPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'aisy-bots-'))
  roots.push(root)
  return join(root, 'bots.json')
}

function registry(path: string, startId = 0) {
  let id = startId
  let tick = 0
  return makeBotRegistry({
    path,
    newId: () => `bot-${++id}`,
    nowIso: () => `2026-07-29T10:0${tick++}:00Z`,
  })
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('bot registry (ADR-0076)', () => {
  it('registers bots and routes an incoming message by its token env', () => {
    const path = registryPath()
    const store = registry(path)
    store.add({ name: 'Стратег', tokenEnv: 'AISY_TELEGRAM_BOT_TOKEN', chatId: 42 })
    store.add({ name: 'Копирайтер', tokenEnv: 'AISY_COPYWRITER_TOKEN', chatId: 43, role: 'тексты' })

    expect(store.byTokenEnv('AISY_COPYWRITER_TOKEN')?.name).toBe('Копирайтер')
    expect(store.byTokenEnv('AISY_TELEGRAM_BOT_TOKEN')?.chatId).toBe(42)
    expect(store.byTokenEnv('AISY_UNKNOWN')).toBeNull()
  })

  it('never puts two live bots on the same chat or the same token', () => {
    const store = registry(registryPath())
    store.add({ name: 'Стратег', tokenEnv: 'AISY_A', chatId: 42 })

    expect(() => store.add({ name: 'Другой', tokenEnv: 'AISY_B', chatId: 42 }))
      .toThrowError(expect.objectContaining({ reason: 'duplicate-chat' }))
    expect(() => store.add({ name: 'Другой', tokenEnv: 'AISY_A', chatId: 43 }))
      .toThrowError(expect.objectContaining({ reason: 'duplicate-token-ref' }))
  })

  it('keeps the primary bot stable across restarts and archiving of others', () => {
    const path = registryPath()
    const store = registry(path)
    const first = store.add({ name: 'Стратег', tokenEnv: 'AISY_A', chatId: 42 })
    const second = store.add({ name: 'Копирайтер', tokenEnv: 'AISY_B', chatId: 43 })

    expect(store.primary()?.id).toBe(first.id)
    store.archive(second.id)
    // Restart: a fresh registry over the same file must agree on the primary.
    expect(registry(path, 10).primary()?.id).toBe(first.id)
  })

  it('archives without deleting, so the bot memory stays addressable', () => {
    const path = registryPath()
    const store = registry(path)
    const bot = store.add({ name: 'Дизайнер', tokenEnv: 'AISY_D', chatId: 44 })

    const archived = store.archive(bot.id)
    expect(archived.archivedAt).toBeDefined()
    expect(store.list()).toHaveLength(0)
    expect(store.list(true)).toHaveLength(1)
    expect(store.byId(bot.id)?.name).toBe('Дизайнер')
    // An archived bot no longer receives messages…
    expect(store.byTokenEnv('AISY_D')).toBeNull()
    // …and its token may be reused by a replacement bot.
    expect(() => store.add({ name: 'Дизайнер 2', tokenEnv: 'AISY_D', chatId: 44 })).not.toThrow()
  })

  it('refuses a malformed bot before writing anything', () => {
    const store = registry(registryPath())

    expect(() => store.add({ name: '   ', tokenEnv: 'AISY_A', chatId: 42 }))
      .toThrowError(expect.objectContaining({ reason: 'invalid-bot' }))
    expect(() => store.add({ name: 'Бот', tokenEnv: 'lowercase', chatId: 42 }))
      .toThrowError(BotRegistryError)
    expect(() => store.add({ name: 'Бот', tokenEnv: 'AISY_A', chatId: 1.5 }))
      .toThrowError(BotRegistryError)
    expect(store.list()).toEqual([])
  })

  it('drops a half-valid record instead of routing on it', () => {
    const path = registryPath()
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      bots: [
        { id: 'bot-1', name: 'Хороший', tokenEnv: 'AISY_A', chatId: 42, createdAt: '2026-07-29T10:00:00Z' },
        { id: 'bot-2', name: 'Битый', tokenEnv: 'нижний регистр', chatId: 43, createdAt: '2026-07-29T10:01:00Z' },
      ],
    }), { mode: 0o600 })

    const store = registry(path, 100)
    expect(store.list().map(bot => bot.id)).toEqual(['bot-1'])
  })

  it('treats corrupt or oversized state as an empty registry', () => {
    const corrupt = registryPath()
    writeFileSync(corrupt, '{ not json', { mode: 0o600 })
    expect(makeBotRegistry({ path: corrupt }).list()).toEqual([])

    const huge = registryPath()
    writeFileSync(huge, 'x'.repeat(256 * 1024 + 1), { mode: 0o600 })
    expect(makeBotRegistry({ path: huge }).list()).toEqual([])
  })

  it('writes the registry privately and holds no token values', () => {
    const path = registryPath()
    const store = registry(path)
    store.add({ name: 'Стратег', tokenEnv: 'AISY_TELEGRAM_BOT_TOKEN', chatId: 42 })

    expect(statSync(path).mode & 0o777).toBe(0o600)
    // Only the variable name is stored; the secret itself lives in the vault.
    // A real Telegram token looks like `123456789:AA...`, so its shape must not
    // appear anywhere in the persisted registry.
    const persisted = readFileSync(path, 'utf8')
    expect(persisted).toContain('AISY_TELEGRAM_BOT_TOKEN')
    expect(/\d{6,}:[A-Za-z0-9_-]{20,}/.test(persisted)).toBe(false)
    expect(Object.keys(store.list()[0] ?? {})).not.toContain('token')
  })
})
