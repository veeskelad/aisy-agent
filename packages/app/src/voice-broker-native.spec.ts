import { fstatSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isVoiceBrokerNativePort,
  makeVoiceBrokerNativePort,
  withVoiceMediaDescriptor,
} from './voice-broker-native.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-native-voice-')))
  roots.push(value)
  return value
}

describe('voice broker native boundary', () => {
  it('accepts the bootstrap discriminator emitted by the broker', () => {
    const source = readFileSync(new URL('../native/aisy_voice_broker_bridge.c', import.meta.url), 'utf8')

    expect(source).toContain("payload != 'A'")
  })

  it('brands only the exact wrapped bridge and preserves method receivers', async () => {
    const receiver = { held: true }
    const raw = {
      isHeld() { return this === raw && receiver.held },
      async stageMedia() { return { ok: true as const, mediaTicket: 'm'.repeat(43) } },
      async cancelMedia() { return true },
      async prepare() { return { ok: true as const, dispatchPermitId: 'p'.repeat(43) } },
      async cancelPrepared() { return 'cancelled' as const },
      async dispatch() { return { ok: true as const, transcript: 'ok', durationMs: 1 } },
      close() { receiver.held = false },
    }
    const bridge = makeVoiceBrokerNativePort(raw)

    expect(isVoiceBrokerNativePort(raw)).toBe(false)
    expect(isVoiceBrokerNativePort(bridge)).toBe(true)
    expect(bridge.isHeld()).toBe(true)
    bridge.close()
    expect(bridge.isHeld()).toBe(false)
  })

  it('opens one exact private descriptor and always closes it after await', async () => {
    const mediaRoot = root()
    writeFileSync(join(mediaRoot, 'voice.ogg'), Buffer.alloc(8, 1), { mode: 0o600 })
    let descriptor = -1

    await expect(withVoiceMediaDescriptor({
      mediaRoot, relativePath: 'voice.ogg', expectedSha256: 'a'.repeat(64),
      expectedSizeBytes: 8, maxBytes: 8,
      async use(fd) { descriptor = fd; return 'used' },
    })).resolves.toBe('used')
    expect(() => fstatSync(descriptor)).toThrow()
  })

  it('refuses hardlinks, traversal and size drift before bridge use', async () => {
    const mediaRoot = root()
    writeFileSync(join(mediaRoot, 'voice.ogg'), Buffer.alloc(8, 1), { mode: 0o600 })
    linkSync(join(mediaRoot, 'voice.ogg'), join(mediaRoot, 'alias.ogg'))
    const use = vi.fn()

    await expect(withVoiceMediaDescriptor({
      mediaRoot, relativePath: 'voice.ogg', expectedSha256: 'a'.repeat(64),
      expectedSizeBytes: 8, maxBytes: 8, use,
    })).rejects.toThrow('VOICE_MEDIA_UNSAFE')
    await expect(withVoiceMediaDescriptor({
      mediaRoot, relativePath: '../voice.ogg', expectedSha256: 'a'.repeat(64),
      expectedSizeBytes: 8, maxBytes: 8, use,
    })).rejects.toThrow('VOICE_MEDIA_INVALID')
    expect(use).not.toHaveBeenCalled()
  })
})
