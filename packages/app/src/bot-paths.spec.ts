import { describe, expect, it } from 'vitest'
import { join } from 'node:path'

import { botStateRoots } from './bot-paths.js'

const BASE = '/Users/operator/.aisy'

describe('per-bot state layout (ADR-0076)', () => {
  it('keeps the historical layout for the primary bot, so no migration is needed', () => {
    const roots = botStateRoots({ base: BASE, botId: 'bot-1', primaryBotId: 'bot-1' })

    expect(roots).toEqual({
      protectedMemory: join(BASE, 'protected-memory'),
      memory: join(BASE, 'memory'),
      journal: join(BASE, 'journal'),
      knowledge: join(BASE, 'knowledge'),
    })
  })

  it('treats an installation without any registered bot as the primary one', () => {
    const roots = botStateRoots({ base: BASE, botId: null, primaryBotId: null })
    expect(roots.memory).toBe(join(BASE, 'memory'))
  })

  it('gives every other bot its own separate roots', () => {
    const second = botStateRoots({ base: BASE, botId: 'bot-2', primaryBotId: 'bot-1' })

    expect(second.protectedMemory).toBe(join(BASE, 'bots', 'bot-2', 'protected-memory'))
    expect(second.journal).toBe(join(BASE, 'bots', 'bot-2', 'journal'))
    // Nothing of the second bot may land inside the primary bot's memory.
    expect(second.memory.startsWith(join(BASE, 'memory'))).toBe(false)
  })

  it('never lets a bot id choose a path in the file system', () => {
    const hostile = botStateRoots({
      base: BASE,
      botId: '../../etc/passwd',
      primaryBotId: 'bot-1',
    })

    expect(hostile.memory.startsWith(join(BASE, 'bots'))).toBe(true)
    expect(hostile.memory).not.toContain('..')
    expect(hostile.memory).not.toContain('etc')
  })

  it('separates two bots completely', () => {
    const a = botStateRoots({ base: BASE, botId: 'bot-2', primaryBotId: 'bot-1' })
    const b = botStateRoots({ base: BASE, botId: 'bot-3', primaryBotId: 'bot-1' })

    for (const key of ['protectedMemory', 'memory', 'journal', 'knowledge'] as const) {
      expect(a[key]).not.toBe(b[key])
    }
  })

  it('applies configuration overrides to the primary bot only', () => {
    const overrides = { memory: '/custom/memory' }
    expect(botStateRoots({ base: BASE, botId: 'bot-1', primaryBotId: 'bot-1', overrides }).memory)
      .toBe('/custom/memory')
    // A secondary bot must not silently share the operator's custom root.
    expect(botStateRoots({ base: BASE, botId: 'bot-2', primaryBotId: 'bot-1', overrides }).memory)
      .toBe(join(BASE, 'bots', 'bot-2', 'memory'))
  })
})
