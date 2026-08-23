import { createHash } from 'node:crypto'
import { connect as nodeConnect, type Socket } from 'node:net'

import type { NativeBrokerProviderId } from './provider-broker-fetch.js'

const MAX_CONTROL_BYTES = 64 * 1024
const MAX_MATERIAL_BYTES = 8 * 1024
const FRAME_HEADER = 0x48
const FRAME_DATA = 0x44
const FRAME_END = 0x45
const FRAME_ERROR = 0x58
const CODE = /^[A-Za-z0-9_-]{24,96}$/
const HASH = /^[a-f0-9]{64}$/
const APPROVAL = /^[A-Za-z0-9_-]{20,160}$/

export const PROVIDER_ADMIN_SOCKET_PATH = '/run/aisy/provider/admin.sock'

export class ProviderLifecycleControlError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'ProviderLifecycleControlError'
  }
}

export interface ProviderLifecycleBinding {
  operatorId: string
  profileId: string
  providerId: NativeBrokerProviderId
}

export interface ProviderLifecycleControlPort {
  begin(binding: ProviderLifecycleBinding): Promise<{ code: string; expiresAt: string }>
  inspect(binding: ProviderLifecycleBinding): Promise<
    | { state: 'unconfigured' | 'unavailable' }
    | { state: 'ready'; handle: string; revision: number }
  >
  revoke(binding: ProviderLifecycleBinding, approvalId: string): Promise<{ state: 'unconfigured' }>
  submit(input: { code: string; material: Uint8Array }): Promise<{
    state: 'ready'
    handle: string
    revision: number
  }>
}

export interface ProviderLifecycleControlOptions {
  socketPath?: string
  connect?: (path: string) => Socket
  timeoutMs?: number
}

function controlBytes(value: unknown): Buffer {
  const raw = Buffer.from(JSON.stringify(value), 'utf8')
  if (raw.byteLength < 1 || raw.byteLength > MAX_CONTROL_BYTES) {
    throw new ProviderLifecycleControlError('CONTROL_BOUNDS')
  }
  return raw
}

function frame(kind: number, payload: Uint8Array = new Uint8Array()): Buffer {
  if (!Number.isSafeInteger(kind) || kind < 0 || kind > 255 || payload.byteLength > MAX_CONTROL_BYTES) {
    throw new ProviderLifecycleControlError('CONTROL_BOUNDS')
  }
  const output = Buffer.allocUnsafe(5 + payload.byteLength)
  output.writeUInt32BE(payload.byteLength + 1, 0)
  output[4] = kind
  Buffer.from(payload).copy(output, 5)
  return output
}

function framePrefix(kind: number, length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MATERIAL_BYTES) {
    throw new ProviderLifecycleControlError('MATERIAL_BOUNDS')
  }
  const output = Buffer.allocUnsafe(5)
  output.writeUInt32BE(length + 1, 0)
  output[4] = kind
  return output
}

function decodeObject(raw: Buffer): Record<string, unknown> {
  if (raw.byteLength < 1 || raw.byteLength > MAX_CONTROL_BYTES) {
    throw new ProviderLifecycleControlError('CONTROL_BOUNDS')
  }
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new ProviderLifecycleControlError('MALFORMED_FRAME')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderLifecycleControlError('MALFORMED_FRAME')
  }
  return value as Record<string, unknown>
}

function errorCode(raw: Buffer): string {
  const value = decodeObject(raw)
  return Object.keys(value).sort().join(',') === 'attempted,code,schemaVersion' &&
    value['schemaVersion'] === 1 && typeof value['code'] === 'string' &&
    /^[A-Z][A-Z0-9_]{2,63}$/.test(value['code']) && value['attempted'] === false
    ? value['code']
    : 'MALFORMED_FRAME'
}

function makeReader(socket: Socket): () => Promise<{ kind: number; payload: Buffer }> {
  let pending = Buffer.alloc(0)
  let terminalError: ProviderLifecycleControlError | null = null
  const waiters: Array<{
    resolve: (value: { kind: number; payload: Buffer }) => void
    reject: (error: ProviderLifecycleControlError) => void
  }> = []
  const frames: Array<{ kind: number; payload: Buffer }> = []

  const flush = (): void => {
    while (waiters.length > 0 && frames.length > 0) waiters.shift()!.resolve(frames.shift()!)
    if (terminalError !== null) {
      while (waiters.length > 0) waiters.shift()!.reject(terminalError)
    }
  }
  socket.on('data', (chunk: Buffer) => {
    pending = pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk])
    while (pending.byteLength >= 4) {
      const size = pending.readUInt32BE(0)
      if (size < 1 || size > MAX_CONTROL_BYTES + 1) {
        terminalError = new ProviderLifecycleControlError('CONTROL_BOUNDS')
        socket.destroy()
        flush()
        return
      }
      if (pending.byteLength < size + 4) return
      frames.push({ kind: pending[4]!, payload: Buffer.from(pending.subarray(5, size + 4)) })
      pending = pending.subarray(size + 4)
    }
    flush()
  })
  socket.once('error', () => {
    terminalError = new ProviderLifecycleControlError('CONTROL_UNAVAILABLE')
    flush()
  })
  socket.once('close', () => {
    if (terminalError === null && waiters.length > 0) {
      terminalError = new ProviderLifecycleControlError('CONTROL_CHANNEL_LOST')
      flush()
    }
  })
  return async () => await new Promise((resolve, reject) => {
    if (frames.length > 0) resolve(frames.shift()!)
    else if (terminalError !== null) reject(terminalError)
    else waiters.push({ resolve, reject })
  })
}

async function connected(socket: Socket, timeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new ProviderLifecycleControlError('CONTROL_BOUNDS')
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProviderLifecycleControlError('CONTROL_TIMEOUT')), timeoutMs)
    timer.unref()
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('error', () => {
      clearTimeout(timer)
      reject(new ProviderLifecycleControlError('CONTROL_UNAVAILABLE'))
    })
  })
}

async function withDeadline<T>(
  socket: Socket,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new ProviderLifecycleControlError('CONTROL_BOUNDS')
  }
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          socket.destroy()
          reject(new ProviderLifecycleControlError('CONTROL_TIMEOUT'))
        }, timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function write(socket: Socket, value: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(value, error => error === undefined || error === null
      ? resolve()
      : reject(new ProviderLifecycleControlError('CONTROL_UNAVAILABLE')))
  })
}

function exactBinding(binding: ProviderLifecycleBinding): void {
  if (
    typeof binding.operatorId !== 'string' || binding.operatorId.length < 1 ||
    Buffer.byteLength(binding.operatorId) > 256 || /[\u0000-\u001f]/.test(binding.operatorId) ||
    typeof binding.profileId !== 'string' || binding.profileId.length < 1 ||
    Buffer.byteLength(binding.profileId) > 256 || /[\u0000-\u001f]/.test(binding.profileId) ||
    !['openai', 'anthropic', 'openrouter', 'deepseek', 'qwen', 'glm', 'gemini'].includes(binding.providerId)
  ) throw new ProviderLifecycleControlError('BINDING_REFUSED')
}

async function response(
  read: () => Promise<{ kind: number; payload: Buffer }>,
): Promise<Record<string, unknown>> {
  const first = await read()
  if (first.kind === FRAME_ERROR) throw new ProviderLifecycleControlError(errorCode(first.payload))
  if (first.kind !== FRAME_HEADER) throw new ProviderLifecycleControlError('MALFORMED_FRAME')
  const value = decodeObject(first.payload)
  const end = await read()
  if (end.kind !== FRAME_END || end.payload.byteLength !== 0) {
    throw new ProviderLifecycleControlError('MALFORMED_FRAME')
  }
  return value
}

export function makeNodeProviderLifecycleControl(
  options: ProviderLifecycleControlOptions = {},
): ProviderLifecycleControlPort {
  const socketPath = options.socketPath ?? PROVIDER_ADMIN_SOCKET_PATH
  const connect = options.connect ?? (path => nodeConnect(path))
  const timeoutMs = options.timeoutMs ?? 45_000

  const request = async (value: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const socket = connect(socketPath)
    const read = makeReader(socket)
    try {
      return await withDeadline(socket, timeoutMs, async () => {
        await connected(socket, Math.min(timeoutMs, 5_000))
        await write(socket, frame(FRAME_HEADER, controlBytes(value)))
        return await response(read)
      })
    } finally {
      socket.destroy()
    }
  }

  const port: ProviderLifecycleControlPort = {
    async begin(binding: ProviderLifecycleBinding) {
      exactBinding(binding)
      const value = await request({ schemaVersion: 1, action: 'begin', ...binding })
      if (Object.keys(value).sort().join(',') !== 'code,expiresAtMs,schemaVersion,state' ||
        value['schemaVersion'] !== 1 || value['state'] !== 'issued' || typeof value['code'] !== 'string' ||
        !CODE.test(value['code']) || !Number.isSafeInteger(value['expiresAtMs']) || Number(value['expiresAtMs']) < 1) {
        throw new ProviderLifecycleControlError('MALFORMED_FRAME')
      }
      return { code: value['code'], expiresAt: new Date(Number(value['expiresAtMs'])).toISOString() }
    },
    async inspect(binding: ProviderLifecycleBinding) {
      exactBinding(binding)
      const value = await request({ schemaVersion: 1, action: 'inspect', ...binding })
      if (value['schemaVersion'] !== 1 || typeof value['state'] !== 'string') {
        throw new ProviderLifecycleControlError('MALFORMED_FRAME')
      }
      if ((value['state'] === 'unconfigured' || value['state'] === 'unavailable') &&
        Object.keys(value).sort().join(',') === 'schemaVersion,state') {
        return { state: value['state'] === 'unconfigured' ? 'unconfigured' : 'unavailable' }
      }
      if (value['state'] === 'ready' && Object.keys(value).sort().join(',') === 'handle,revision,schemaVersion,state' &&
        typeof value['handle'] === 'string' && HASH.test(value['handle']) &&
        Number.isSafeInteger(value['revision']) && Number(value['revision']) > 0) {
        return { state: 'ready', handle: value['handle'], revision: Number(value['revision']) }
      }
      throw new ProviderLifecycleControlError('MALFORMED_FRAME')
    },
    async revoke(binding: ProviderLifecycleBinding, approvalId: string) {
      exactBinding(binding)
      if (!APPROVAL.test(approvalId)) throw new ProviderLifecycleControlError('APPROVAL_REFUSED')
      const value = await request({ schemaVersion: 1, action: 'revoke', ...binding, approvalId })
      if (Object.keys(value).sort().join(',') !== 'schemaVersion,state' ||
        value['schemaVersion'] !== 1 || value['state'] !== 'unconfigured') {
        throw new ProviderLifecycleControlError('MALFORMED_FRAME')
      }
      return { state: 'unconfigured' }
    },
    async submit(input: { code: string; material: Uint8Array }) {
      if (!CODE.test(input.code) || !(input.material instanceof Uint8Array) ||
        input.material.byteLength < 1 || input.material.byteLength > MAX_MATERIAL_BYTES ||
        input.material.some(value => value <= 0x20 || value >= 0x7f)) {
        throw new ProviderLifecycleControlError('MATERIAL_REFUSED')
      }
      const socket = connect(socketPath)
      const read = makeReader(socket)
      try {
        return await withDeadline(socket, timeoutMs, async () => {
          await connected(socket, Math.min(timeoutMs, 5_000))
          await write(socket, frame(FRAME_HEADER, controlBytes({
            schemaVersion: 1,
            action: 'submit',
            code: input.code,
            materialLength: input.material.byteLength,
            materialSha256: createHash('sha256').update(input.material).digest('hex'),
          })))
          const claimed = await read()
          if (claimed.kind === FRAME_ERROR) throw new ProviderLifecycleControlError(errorCode(claimed.payload))
          const claimValue = claimed.kind === FRAME_HEADER ? decodeObject(claimed.payload) : null
          if (claimValue === null || Object.keys(claimValue).sort().join(',') !== 'schemaVersion,state' ||
            claimValue['schemaVersion'] !== 1 || claimValue['state'] !== 'claimed') {
            throw new ProviderLifecycleControlError('MALFORMED_FRAME')
          }
          await write(socket, framePrefix(FRAME_DATA, input.material.byteLength))
          await write(socket, input.material)
          await write(socket, frame(FRAME_END))
          const value = await response(read)
          if (Object.keys(value).sort().join(',') !== 'handle,revision,schemaVersion,state' ||
            value['schemaVersion'] !== 1 || value['state'] !== 'ready' ||
            typeof value['handle'] !== 'string' || !HASH.test(value['handle']) ||
            !Number.isSafeInteger(value['revision']) || Number(value['revision']) < 1) {
            throw new ProviderLifecycleControlError('MALFORMED_FRAME')
          }
          return { state: 'ready', handle: value['handle'], revision: Number(value['revision']) }
        })
      } finally {
        socket.destroy()
      }
    },
  }
  return Object.freeze(port)
}

export async function runProviderMaterialSetCommand(input: {
  argv: readonly string[]
  readMaterial: () => Uint8Array | Promise<Uint8Array>
  ingress: Pick<ProviderLifecycleControlPort, 'submit'>
}): Promise<{ state: 'ready'; handle: string; revision: number }> {
  if (input.argv.length !== 4 || input.argv[0] !== 'provider' || input.argv[1] !== 'credential' ||
    input.argv[2] !== 'set' || !input.argv[3]?.startsWith('--code=')) {
    throw new ProviderLifecycleControlError('INVALID_COMMAND')
  }
  const code = input.argv[3].slice('--code='.length)
  if (!CODE.test(code)) throw new ProviderLifecycleControlError('INVALID_COMMAND')
  const material = await input.readMaterial()
  try {
    return await input.ingress.submit({ code, material })
  } finally {
    material.fill(0)
  }
}
