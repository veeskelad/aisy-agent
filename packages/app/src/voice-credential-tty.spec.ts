import { describe, expect, it, vi } from 'vitest'

import {
  readVoiceCredentialFromTty,
  VoiceCredentialTtyError,
  type VoiceCredentialTtyPort,
} from './voice-credential-tty.js'

function port(input: {
  bytes?: readonly number[]
  fail?: 'open' | 'snapshot' | 'hide' | 'read' | 'restore'
}) {
  const bytes = [...(input.bytes ?? [...Buffer.from('test-key'), 0x0a])]
  const calls: string[] = []
  const tty: VoiceCredentialTtyPort = {
    open() {
      calls.push('open')
      if (input.fail === 'open') throw new Error('fault')
      return 7
    },
    snapshot() {
      calls.push('snapshot')
      if (input.fail === 'snapshot') throw new Error('fault')
      return '1:2:3'
    },
    hideEcho() {
      calls.push('hide')
      if (input.fail === 'hide') throw new Error('fault')
    },
    restore() {
      calls.push('restore')
      if (input.fail === 'restore') throw new Error('fault')
    },
    write() { calls.push('write') },
    read(_descriptor, target, offset) {
      calls.push('read')
      if (input.fail === 'read') throw new Error('fault')
      const value = bytes.shift()
      if (value === undefined) return 0
      target[offset] = value
      return 1
    },
    close() { calls.push('close') },
  }
  return { tty, calls }
}

describe('voice credential controlling TTY', () => {
  it('restores exact state before returning an owned bounded byte buffer', () => {
    const h = port({})
    const result = readVoiceCredentialFromTty(h.tty)

    expect(Buffer.from(result).toString()).toBe('test-key')
    expect(h.calls.indexOf('restore')).toBeLessThan(h.calls.indexOf('close'))
    expect(h.calls.at(-1)).toBe('close')
    result.fill(0)
  })

  it.each(['read', 'restore'] as const)(
    'restores or returns no bytes when %s fails',
    (fail) => {
      const h = port({ fail })
      expect(() => readVoiceCredentialFromTty(h.tty)).toThrow(VoiceCredentialTtyError)
      expect(h.calls).toContain('restore')
      expect(h.calls.at(-1)).toBe('close')
    },
  )

  it.each([
    [[], 'empty'],
    [[...Buffer.from('abc def'), 0x0a], 'space'],
    [[...Buffer.alloc(8 * 1024 + 1, 0x61), 0x0a], 'oversized'],
  ] as const)('refuses %s input without returning partial bytes', (bytes, _label) => {
    const h = port({ bytes: bytes.length === 0 ? [0x0a] : bytes })
    expect(() => readVoiceCredentialFromTty(h.tty)).toThrow('CREDENTIAL_REFUSED')
    expect(h.calls).toContain('restore')
  })

  it('restores before surfacing an interrupted read', () => {
    const h = port({ fail: 'read' })
    const off = vi.spyOn(process, 'off')
    expect(() => readVoiceCredentialFromTty(h.tty)).toThrow('TTY_CANCELLED')
    expect(h.calls).toContain('restore')
    expect(off).toHaveBeenCalled()
    off.mockRestore()
  })
})
