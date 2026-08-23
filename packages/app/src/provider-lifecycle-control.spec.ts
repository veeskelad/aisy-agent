import type { Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import {
  makeNodeProviderLifecycleControl,
  ProviderLifecycleControlError,
  runProviderMaterialSetCommand,
} from './provider-lifecycle-control.js'

class FakeSocket extends Duplex {
  readonly written: Buffer[] = []

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.written.push(Buffer.from(chunk))
    callback()
  }

  connect(): void {
    this.emit('connect')
  }

  serverWrite(value: Buffer): void {
    this.push(value)
  }
}

function frame(kind: string, payload: Uint8Array = new Uint8Array()): Buffer {
  const result = Buffer.alloc(5 + payload.byteLength)
  result.writeUInt32BE(payload.byteLength + 1, 0)
  result.write(kind, 4, 'ascii')
  Buffer.from(payload).copy(result, 5)
  return result
}

function control(kind: string, value: object): Buffer {
  return frame(kind, Buffer.from(JSON.stringify(value)))
}

function port(socket: FakeSocket) {
  return makeNodeProviderLifecycleControl({
    timeoutMs: 5_000,
    connect: path => {
      expect(path).toBe('/run/aisy/provider/admin.sock')
      queueMicrotask(() => socket.connect())
      return socket as unknown as Socket
    },
  })
}

describe('provider lifecycle control', () => {
  it('claims a one-use code before sending material and accepts only redacted result', async () => {
    const socket = new FakeSocket()
    const material = Buffer.from('provider-test-material')
    const pending = port(socket).submit({
      code: 'provider_code_abcdefghijklmnopqrstuvwx',
      material,
    })
    await new Promise(resolve => setImmediate(resolve))

    const beforeClaim = Buffer.concat(socket.written)
    expect(beforeClaim.includes(material)).toBe(false)
    expect(beforeClaim.includes(Buffer.from('materialSha256'))).toBe(true)
    socket.serverWrite(control('H', { schemaVersion: 1, state: 'claimed' }))
    await new Promise(resolve => setImmediate(resolve))
    expect(Buffer.concat(socket.written).includes(material)).toBe(true)

    socket.serverWrite(Buffer.concat([
      control('H', {
        schemaVersion: 1,
        state: 'ready',
        handle: 'c'.repeat(64),
        revision: 2,
      }),
      frame('E'),
    ]))
    await expect(pending).resolves.toEqual({
      state: 'ready',
      handle: 'c'.repeat(64),
      revision: 2,
    })
  })

  it('validates begin response and rejects raw provider material in command arguments', async () => {
    const socket = new FakeSocket()
    const pending = port(socket).begin({
      operatorId: 'operator-1',
      profileId: 'profile-1',
      providerId: 'openai',
    })
    await new Promise(resolve => setImmediate(resolve))
    socket.serverWrite(Buffer.concat([
      control('H', {
        schemaVersion: 1,
        state: 'issued',
        code: 'provider_code_abcdefghijklmnopqrstuvwx',
        expiresAtMs: 1_234_567,
      }),
      frame('E'),
    ]))
    await expect(pending).resolves.toEqual({
      code: 'provider_code_abcdefghijklmnopqrstuvwx',
      expiresAt: '1970-01-01T00:20:34.567Z',
    })

    let reads = 0
    await expect(runProviderMaterialSetCommand({
      argv: ['provider', 'credential', 'set', '--code=provider_code_abcdefghijklmnopqrstuvwx', 'raw-value'],
      readMaterial: () => {
        reads += 1
        return new Uint8Array([65])
      },
      ingress: { submit: async () => ({ state: 'ready', handle: 'd'.repeat(64), revision: 1 }) },
    })).rejects.toBeInstanceOf(ProviderLifecycleControlError)
    expect(reads).toBe(0)
  })

  it('zeroizes the owned TTY buffer after success and failure', async () => {
    for (const fails of [false, true]) {
      const material = new Uint8Array(Buffer.from('provider-test-material'))
      const pending = runProviderMaterialSetCommand({
        argv: ['provider', 'credential', 'set', '--code=provider_code_abcdefghijklmnopqrstuvwx'],
        readMaterial: () => material,
        ingress: {
          submit: async input => {
            expect(input.material).toBe(material)
            if (fails) throw new ProviderLifecycleControlError('VALIDATION_REFUSED')
            return { state: 'ready', handle: 'e'.repeat(64), revision: 1 }
          },
        },
      })
      if (fails) await expect(pending).rejects.toMatchObject({ code: 'VALIDATION_REFUSED' })
      else await expect(pending).resolves.toMatchObject({ revision: 1 })
      expect(material.every(value => value === 0)).toBe(true)
    }
  })

  it('enforces one total deadline while waiting for the broker response', async () => {
    vi.useFakeTimers()
    try {
      const socket = new FakeSocket()
      const lifecycle = makeNodeProviderLifecycleControl({
        timeoutMs: 100,
        connect: () => {
          queueMicrotask(() => socket.connect())
          return socket as unknown as Socket
        },
      })
      const pending = lifecycle.inspect({
        operatorId: 'operator-1',
        profileId: 'profile-1',
        providerId: 'openai',
      })
      const rejected = expect(pending).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(100)

      await rejected
      expect(socket.destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
