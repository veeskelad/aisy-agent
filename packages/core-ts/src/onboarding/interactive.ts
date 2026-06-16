// Interactive onboarding helpers — terminal Telegram pairing (ADR-0049 design).
//
// Pairing is trust-decided terminal-side: a code is shown only in the terminal,
// and only the chat that echoes it is paired — resistant to a race or an
// imposter messaging the bot. Falls back to manual chat_id entry on timeout or
// when getUpdates is unavailable. Pure over injected ports (prompt, getUpdates,
// clock, sleep, genCode) so it is deterministic in tests.

import type { PromptPort, TelegramPairUpdate } from './types.js'

export interface PairingDeps {
  prompt: PromptPort
  /** Poll Telegram for recent updates. Absent ⇒ manual entry only. */
  getUpdates?: (token: string) => Promise<{ ok: boolean; updates?: TelegramPairUpdate[] }>
  /** Monotonic clock in ms (injected for deterministic timeout). */
  clock: () => number
  /** Mint the pairing code (injected so tests can pin it). */
  genCode: () => string
  /** Sleep between polls; tests advance the fake clock here. */
  sleep: (ms: number) => Promise<void>
  pollIntervalMs?: number
  maxWaitMs?: number
}

async function manualEntry(prompt: PromptPort): Promise<string | null> {
  const id = (await prompt.ask('Введи свой chat_id (узнать: напиши @userinfobot)')).trim()
  return id.length > 0 ? id : null
}

/**
 * Pair the operator chat. Returns the chat_id (string) or null if the operator
 * provides nothing.
 */
export async function runTelegramPairing(token: string, deps: PairingDeps): Promise<string | null> {
  if (!deps.getUpdates) return manualEntry(deps.prompt)

  const code = deps.genCode()
  const pollInterval = deps.pollIntervalMs ?? 2000
  const maxWait = deps.maxWaitMs ?? 120_000
  deps.prompt.info(`Открой бот в Telegram и отправь ему этот код: ${code}`)

  const started = deps.clock()
  while (deps.clock() - started < maxWait) {
    let res: { ok: boolean; updates?: TelegramPairUpdate[] }
    try {
      res = await deps.getUpdates(token)
    } catch {
      res = { ok: false }
    }
    if (res.ok && res.updates) {
      const hit = res.updates.find((u) => u.text.trim() === code)
      if (hit) {
        const who = hit.username ? `@${hit.username}` : `chat ${hit.chatId}`
        deps.prompt.info(`Связано с ${who} (id ${hit.chatId}).`)
        return String(hit.chatId)
      }
    }
    await deps.sleep(pollInterval)
  }

  deps.prompt.info('Не дождался кода — введи chat_id вручную.')
  return manualEntry(deps.prompt)
}
