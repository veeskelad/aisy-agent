import { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  makeProviderBrokerFetch,
} from './provider-broker-fetch.js'

class FakeSocket extends Duplex {
  readonly written: Buffer[] = []

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
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

function openai(socket: FakeSocket): typeof fetch {
  return makeProviderBrokerFetch({
    providerId: 'openai',
    timeoutMs: 5_000,
    connect: path => {
      expect(path).toBe('/run/aisy/provider/control.sock')
      queueMicrotask(() => socket.connect())
      return socket as unknown as Socket
    },
  })
}

describe('provider broker fetch', () => {
  it('uses an exact descriptor and streams framed response bytes', async () => {
    const socket = new FakeSocket()
    const pending = openai(socket)('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ',
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: '{"model":"gpt-test"}',
    })
    await new Promise(resolve => setImmediate(resolve))

    const sent = Buffer.concat(socket.written)
    expect(sent.includes(Buffer.from('api.openai.com'))).toBe(false)
    expect(sent.includes(Buffer.from('authorization'))).toBe(false)
    expect(sent.includes(Buffer.from('openai.chat-completions.v1'))).toBe(true)

    const head = control('H', {
      schemaVersion: 1,
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const data = frame('D', Buffer.from('{"ok":true}'))
    const end = frame('E')
    const attempted = frame('A')
    socket.serverWrite(attempted.subarray(0, 3))
    socket.serverWrite(Buffer.concat([attempted.subarray(3), head, data.subarray(0, 7)]))
    socket.serverWrite(Buffer.concat([data.subarray(7), end]))

    const response = await pending
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('rejects custom targets and caller-provided authorization before connect', async () => {
    let connections = 0
    const fetchImpl = makeProviderBrokerFetch({
      providerId: 'openai',
      connect: () => {
        connections += 1
        return new FakeSocket() as unknown as Socket
      },
    })
    await expect(fetchImpl('https://internal.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })).rejects.toMatchObject({ code: 'TARGET_REFUSED', attempted: false })
    await expect(fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer caller-material', 'content-type': 'application/json' },
      body: '{}',
    })).rejects.toMatchObject({ code: 'CALLER_AUTH_REFUSED', attempted: false })
    expect(connections).toBe(0)
  })

  it('preserves the broker attempted bit on a stable refusal', async () => {
    const socket = new FakeSocket()
    const pending = openai(socket)('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ', 'content-type': 'application/json' },
      body: '{}',
    })
    await new Promise(resolve => setImmediate(resolve))
    socket.serverWrite(control('X', {
      schemaVersion: 1,
      code: 'PROVIDER_TRANSPORT_REFUSED',
      attempted: true,
    }))
    await expect(pending).rejects.toMatchObject({
      code: 'PROVIDER_TRANSPORT_REFUSED',
      attempted: true,
      attemptId: expect.stringMatching(/^request_[A-Za-z0-9_-]{32}$/),
    })
  })
})
