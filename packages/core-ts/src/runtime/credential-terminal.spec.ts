import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import {
  CredentialTerminalError,
  makeCredentialTerminalPrompt,
  type CredentialTerminalInput,
} from './credential-terminal.js'

class FakeInput extends EventEmitter implements CredentialTerminalInput {
  isTTY = true
  isRaw = false
  paused = true
  rawTransitions: boolean[] = []
  failEnableOnce = false

  isPaused(): boolean { return this.paused }
  setRawMode(enabled: boolean): void {
    if (enabled && this.failEnableOnce) {
      this.failEnableOnce = false
      throw new Error('injected raw-mode failure')
    }
    this.isRaw = enabled
    this.rawTransitions.push(enabled)
  }
  setEncoding(_encoding: null): void {}
  resume(): void { this.paused = false }
  pause(): void { this.paused = true }
  override on(event: 'data', listener: (chunk: Buffer | string) => void): this {
    return super.on(event, listener)
  }
  override off(event: 'data', listener: (chunk: Buffer | string) => void): this {
    return super.off(event, listener)
  }
}

function harness() {
  const stdin = new FakeInput()
  const output: string[] = []
  const prompt = makeCredentialTerminalPrompt({
    stdin,
    stdout: { isTTY: true, write: (value) => { output.push(value) } },
  })
  return { stdin, output, prompt }
}

describe('raw credential terminal prompt', () => {
  it('reads bytes without echoing content, stars or length metadata', async () => {
    const h = harness()
    const pending = h.prompt.readSecret('API credential')
    const chunk = Buffer.from('test-credential-value\r')
    h.stdin.emit('data', chunk)
    const secret = await pending

    expect(new TextDecoder().decode(secret)).toBe('test-credential-value')
    expect(h.output.join('')).toBe('API credential: \n')
    expect(h.output.join('')).not.toContain('*')
    expect([...chunk]).toEqual(new Array(chunk.length).fill(0))
    expect(h.stdin.rawTransitions).toEqual([true, false])
    expect(h.stdin.paused).toBe(true)
    secret.fill(0)
  })

  it('supports byte backspace without printing edit feedback', async () => {
    const h = harness()
    const pending = h.prompt.readSecret('API credential')
    h.stdin.emit('data', Buffer.from([97, 98, 99, 127, 100, 13]))
    const secret = await pending
    expect(new TextDecoder().decode(secret)).toBe('abd')
    expect(h.output.join('')).toBe('API credential: \n')
    secret.fill(0)
  })

  it('restores terminal state on cancellation and blocks concurrent prompts', async () => {
    const h = harness()
    const pending = h.prompt.readSecret('API credential')
    await expect(h.prompt.readSecret('API credential')).rejects.toMatchObject({
      code: 'CREDENTIAL_PROMPT_BUSY',
    })
    h.stdin.emit('data', Buffer.from([3]))
    await expect(pending).rejects.toMatchObject({ code: 'CREDENTIAL_INPUT_CANCELLED' })
    expect(h.stdin.rawTransitions).toEqual([true, false])
    expect(h.stdin.paused).toBe(true)
  })

  it('requires an interactive input and output TTY', async () => {
    const h = harness()
    h.stdin.isTTY = false
    await expect(h.prompt.readSecret('API credential')).rejects
      .toBeInstanceOf(CredentialTerminalError)
    expect(h.output).toEqual([])
  })

  it('clears busy state and fails closed when terminal initialization throws', async () => {
    const h = harness()
    h.stdin.failEnableOnce = true
    await expect(h.prompt.readSecret('API credential')).rejects.toMatchObject({
      code: 'CREDENTIAL_TERMINAL_FAILED',
    })

    const retry = h.prompt.readSecret('API credential')
    h.stdin.emit('data', Buffer.from('retry-value\r'))
    const value = await retry
    expect(new TextDecoder().decode(value)).toBe('retry-value')
    value.fill(0)
  })

  it('rejects control characters and overlong values without echo', async () => {
    const invalid = harness()
    const invalidPending = invalid.prompt.readSecret('API credential')
    invalid.stdin.emit('data', Buffer.from([97, 9]))
    await expect(invalidPending).rejects.toMatchObject({ code: 'CREDENTIAL_INPUT_INVALID' })

    const oversized = harness()
    const oversizedPending = oversized.prompt.readSecret('API credential')
    oversized.stdin.emit('data', Buffer.alloc(16 * 1024 + 1, 97))
    await expect(oversizedPending).rejects.toMatchObject({ code: 'CREDENTIAL_INPUT_TOO_LARGE' })
    expect(invalid.output.join('')).not.toContain('*')
    expect(oversized.output.join('')).not.toContain('*')
  })
})
