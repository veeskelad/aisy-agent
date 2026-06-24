import { describe, it, expect } from 'vitest'
import { runTelegramPairing, type PairingDeps } from './interactive.js'
import type { PromptPort, TelegramPairUpdate } from './types.js'

function scriptedPrompt(answers: string[] = []): PromptPort & { info: (m: string) => void; infos: string[] } {
  let i = 0
  const infos: string[] = []
  return {
    infos,
    ask: async () => answers[i++] ?? '',
    secret: async () => answers[i++] ?? '',
    confirm: async () => true,
    info: (m: string) => void infos.push(m),
  }
}

/** Fake clock advanced only by sleep(), so timeouts are deterministic. */
function fakeClockDeps(over: Partial<PairingDeps> = {}): PairingDeps {
  let t = 0
  return {
    prompt: scriptedPrompt(),
    clock: () => t,
    genCode: () => 'AISY-TEST',
    sleep: async (ms) => {
      t += ms
    },
    pollIntervalMs: 1000,
    maxWaitMs: 5000,
    ...over,
  }
}

describe('runTelegramPairing', () => {
  it('falls back to manual entry when getUpdates is absent', async () => {
    const prompt = scriptedPrompt(['424242'])
    const id = await runTelegramPairing('tok', { ...fakeClockDeps(), prompt })
    expect(id).toBe('424242')
  })

  it('captures the chat that echoes the pairing code', async () => {
    const prompt = scriptedPrompt()
    const updates: TelegramPairUpdate[] = [{ chatId: 999, text: 'AISY-TEST', username: 'op' }]
    const id = await runTelegramPairing('tok', {
      ...fakeClockDeps(),
      prompt,
      getUpdates: async () => ({ ok: true, updates }),
    })
    expect(id).toBe('999')
    expect(prompt.infos.some((m) => m.includes('@op'))).toBe(true)
  })

  it('ignores messages that do not match the code', async () => {
    const prompt = scriptedPrompt(['fallback-id'])
    const id = await runTelegramPairing('tok', {
      ...fakeClockDeps(),
      prompt,
      getUpdates: async () => ({ ok: true, updates: [{ chatId: 1, text: 'hello' }] }),
    })
    // never matches → times out → manual entry
    expect(id).toBe('fallback-id')
  })

  it('matches the code only after it arrives (polls until then)', async () => {
    const prompt = scriptedPrompt()
    let calls = 0
    const id = await runTelegramPairing('tok', {
      ...fakeClockDeps(),
      prompt,
      getUpdates: async () => {
        calls++
        return calls >= 3 ? { ok: true, updates: [{ chatId: 7, text: 'AISY-TEST' }] } : { ok: true, updates: [] }
      },
    })
    expect(id).toBe('7')
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  it('times out to manual entry when the code never arrives', async () => {
    const prompt = scriptedPrompt(['manual-77'])
    const id = await runTelegramPairing('tok', {
      ...fakeClockDeps(),
      prompt,
      getUpdates: async () => ({ ok: true, updates: [] }),
    })
    expect(id).toBe('manual-77')
    expect(prompt.infos.some((m) => m.includes('manually'))).toBe(true)
  })

  it('returns null when manual entry is left empty', async () => {
    const prompt = scriptedPrompt([''])
    const id = await runTelegramPairing('tok', { ...fakeClockDeps(), prompt })
    expect(id).toBeNull()
  })

  it('survives a getUpdates error and keeps polling', async () => {
    const prompt = scriptedPrompt()
    let calls = 0
    const id = await runTelegramPairing('tok', {
      ...fakeClockDeps(),
      prompt,
      getUpdates: async () => {
        calls++
        if (calls === 1) throw new Error('network')
        return { ok: true, updates: [{ chatId: 5, text: 'AISY-TEST' }] }
      },
    })
    expect(id).toBe('5')
  })
})
