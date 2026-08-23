// Per-bot state layout (ADR-0076).
//
// A bot owns its memory, journal and sessions; the installation owns secrets,
// projects and the server. The first bot keeps the historical paths so an
// existing installation needs no migration — records written before multi-bot
// belong to it by definition.

import { createHash } from 'node:crypto'
import { join } from 'node:path'

export interface BotStateRoots {
  /** Protected scoped memory of this bot. */
  protectedMemory: string
  /** DNA and daily notes of this bot. */
  memory: string
  /** Session journal of this bot. */
  journal: string
  /** Knowledge zone of this bot's Workspace. */
  knowledge: string
}

const BOT_DIR = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Resolve where one bot keeps its state.
 *
 * `primaryBotId` gets the legacy layout verbatim: an installation that upgrades
 * into multi-bot must find its memory exactly where it left it. Every other bot
 * lives under a derived directory — the id is data, and data does not choose a
 * path in the file system.
 */
export function botStateRoots(input: {
  base: string
  botId: string | null
  primaryBotId: string | null
  /** Overrides from configuration, applied to the primary bot only. */
  overrides?: Partial<BotStateRoots>
}): BotStateRoots {
  const legacy: BotStateRoots = {
    protectedMemory: input.overrides?.protectedMemory ?? join(input.base, 'protected-memory'),
    memory: input.overrides?.memory ?? join(input.base, 'memory'),
    journal: input.overrides?.journal ?? join(input.base, 'journal'),
    knowledge: input.overrides?.knowledge ?? join(input.base, 'knowledge'),
  }

  const botId = input.botId
  if (botId === null || botId === '' || botId === input.primaryBotId) return legacy

  const directory = BOT_DIR.test(botId)
    ? botId
    : createHash('sha256').update(botId).digest('hex').slice(0, 32)
  const root = join(input.base, 'bots', directory)
  return {
    protectedMemory: join(root, 'protected-memory'),
    memory: join(root, 'memory'),
    journal: join(root, 'journal'),
    knowledge: join(root, 'knowledge'),
  }
}
