import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  makeNodeVoiceCredentialControl,
  parseVoiceCredentialSetCommand,
  runVoiceCredentialSetCommand,
  VoiceCredentialControlError,
} from './voice-credential-control.js'

const roots: string[] = []
const servers: Server[] = []
const INSTALLATION = 'a'.repeat(64)
const REQUEST_ID = 'b'.repeat(32)
const HANDLE = `handle_${'c'.repeat(32)}`
const CODE = `code_${'d'.repeat(32)}`
const KEY = Buffer.from('control-key-sentinel')

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
  })))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function binding() {
  return {
    installationHash: INSTALLATION,
    operatorId: 'telegram:42',
    profileId: 'default',
    providerId: 'deepgram-cloud' as const,
  }
}

async function fixture(
  reply: (request: unknown[], secret: Buffer) => unknown[],
) {
  const root = mkdtempSync(join(tmpdir(), 'aisy-voice-control-'))
  roots.push(root)
  const path = join(root, 'control.sock')
  const requests: Array<{ request: unknown[]; secret: Buffer }> = []
  const server = createServer(socket => {
    let buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.byteLength < 4) return
      const headerBytes = buffer.readUInt32BE(0)
      if (buffer.byteLength < headerBytes + 4) return
      const request = JSON.parse(buffer.subarray(4, headerBytes + 4).toString()) as unknown[]
      const secretBytes = Number(request[4])
      if (buffer.byteLength !== headerBytes + 4 + secretBytes) return
      const secret = Buffer.from(buffer.subarray(headerBytes + 4))
      requests.push({ request, secret })
      const response = Buffer.from(JSON.stringify(reply(request, secret)))
      const prefix = Buffer.alloc(4)
      prefix.writeUInt32BE(response.byteLength)
      socket.end(Buffer.concat([prefix, response]))
      buffer.fill(0)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  return {
    requests,
    client: makeNodeVoiceCredentialControl({
      socketPath: path,
      newRequestId: () => REQUEST_ID,
      attestSocket: () => undefined,
    }),
  }
}

describe('voice credential control client', () => {
  it('uses exact public frames for begin and inspect', async () => {
    const h = await fixture(request => {
      const operation = request[2]
      return operation === 'begin'
        ? ['aisy.voice.control.v1', REQUEST_ID, 'ok', [
            'challenge', CODE, '2026-08-14T12:00:00.000Z',
          ]]
        : ['aisy.voice.control.v1', REQUEST_ID, 'ok', ['ready', HANDLE, 3]]
    })

    await expect(h.client.begin(binding())).resolves.toEqual({
      code: CODE,
      expiresAt: '2026-08-14T12:00:00.000Z',
    })
    await expect(h.client.inspect(binding())).resolves.toEqual({
      state: 'ready', handle: HANDLE, revision: 3,
    })
    expect(h.requests.map(item => item.request[2])).toEqual(['begin', 'inspect'])
    expect(h.requests.every(item => item.secret.byteLength === 0)).toBe(true)
  })

  it('keeps secret bytes outside the JSON header and accepts only typed ready', async () => {
    const h = await fixture((request, secret) => {
      expect(request[2]).toBe('submit')
      expect(JSON.stringify(request)).not.toContain(KEY.toString())
      expect(secret).toEqual(KEY)
      return ['aisy.voice.control.v1', REQUEST_ID, 'ok', ['ready', HANDLE, 1]]
    })
    const secret = new Uint8Array(KEY)

    await expect(h.client.submit({ code: CODE, secret })).resolves.toEqual({
      state: 'ready', handle: HANDLE, revision: 1,
    })
    secret.fill(0)
  })

  it('rejects malformed or rich responses without exposing their detail', async () => {
    const h = await fixture(() => [
      'aisy.voice.control.v1', REQUEST_ID, 'ok', ['ready', HANDLE, 1, 'rich-detail'],
    ])
    await expect(h.client.inspect(binding())).rejects.toMatchObject({
      code: 'CONTROL_PROTOCOL_REFUSED',
    })
  })
})

describe('exact voice credential CLI grammar and ownership', () => {
  it('accepts only the exact set command', () => {
    expect(parseVoiceCredentialSetCommand([
      'voice', 'credential', 'set', `--code=${CODE}`,
    ])).toBe(CODE)
    for (const argv of [
      ['voice', 'credential', 'set', CODE],
      ['voice', 'credential', 'set', `--code=${CODE}`, 'extra'],
      ['voice', 'credential', 'get', `--code=${CODE}`],
      ['voice', 'credential', 'set', '--code=short'],
    ]) {
      expect(() => parseVoiceCredentialSetCommand(argv)).toThrow(VoiceCredentialControlError)
    }
  })

  it('zeroizes its exact TTY buffer after success and submit failure', async () => {
    for (const fails of [false, true]) {
      const secret = new Uint8Array(KEY)
      const submit = vi.fn(async () => {
        expect(secret).toEqual(new Uint8Array(KEY))
        if (fails) throw new Error('refused')
        return { state: 'ready' as const, handle: HANDLE, revision: 1 }
      })
      const promise = runVoiceCredentialSetCommand({
        argv: ['voice', 'credential', 'set', `--code=${CODE}`],
        readSecret: () => secret,
        ingress: { submit },
      })
      if (fails) await expect(promise).rejects.toThrow('refused')
      else await expect(promise).resolves.toMatchObject({ state: 'ready' })
      expect(secret).toEqual(new Uint8Array(KEY.byteLength))
    }
  })

  it('rejects argv before reading TTY or opening control transport', async () => {
    const readSecret = vi.fn(() => new Uint8Array(KEY))
    const submit = vi.fn()
    await expect(runVoiceCredentialSetCommand({
      argv: ['voice', 'credential', 'set', '--unknown'],
      readSecret,
      ingress: { submit },
    })).rejects.toThrow('INVALID_COMMAND')
    expect(readSecret).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })
})
