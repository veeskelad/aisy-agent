import { createHash, randomBytes } from 'node:crypto'
import { connect as nodeConnect, type Socket } from 'node:net'

const MAX_CONTROL_BYTES = 64 * 1024
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_REQUEST_BYTES = 8 * 1024 * 1024

const FRAME_HEADER = 0x48
const FRAME_DATA = 0x44
const FRAME_END = 0x45
const FRAME_ERROR = 0x58
const FRAME_ATTEMPTED = 0x41

export type NativeBrokerProviderId =
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'deepseek'
  | 'qwen'
  | 'glm'
  | 'gemini'

const TARGETS: Readonly<Record<NativeBrokerProviderId, Readonly<{
  url: string
  descriptorId: string
  placeholderHeader: 'authorization' | 'x-api-key'
  placeholderValue: string
}>>> = Object.freeze({
  openai: Object.freeze({
    url: 'https://api.openai.com/v1/chat/completions',
    descriptorId: 'openai.chat-completions.v1',
    placeholderHeader: 'authorization',
    placeholderValue: 'Bearer ',
  }),
  anthropic: Object.freeze({
    url: 'https://api.anthropic.com/v1/messages',
    descriptorId: 'anthropic.messages.v1',
    placeholderHeader: 'x-api-key',
    placeholderValue: '',
  }),
  openrouter: Object.freeze({
    url: 'https://openrouter.ai/api/v1/chat/completions',
    descriptorId: 'openrouter.chat-completions.v1',
    placeholderHeader: 'authorization',
    placeholderValue: 'Bearer ',
  }),
  deepseek: Object.freeze({
    url: 'https://api.deepseek.com/v1/chat/completions',
    descriptorId: 'deepseek.chat-completions.v1',
    placeholderHeader: 'authorization',
    placeholderValue: 'Bearer ',
  }),
  qwen: Object.freeze({
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    descriptorId: 'qwen.chat-completions.v1',
    placeholderHeader: 'authorization',
    placeholderValue: 'Bearer ',
  }),
  glm: Object.freeze({
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    descriptorId: 'glm.chat-completions.v1',
    placeholderHeader: 'authorization',
    placeholderValue: 'Bearer ',
  }),
  gemini: Object.freeze({
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    descriptorId: 'gemini.chat-completions.v1',
    placeholderHeader: 'authorization',
    placeholderValue: 'Bearer ',
  }),
})

export class ProviderBrokerFetchError extends Error {
  constructor(
    public readonly code: string,
    public readonly attempted: boolean,
    public readonly attemptId?: string,
  ) {
    super(code)
    this.name = 'ProviderBrokerFetchError'
  }
}

export interface ProviderBrokerFetchOptions {
  providerId: NativeBrokerProviderId
  socketPath?: string
  connect?: (path: string) => Socket
  timeoutMs?: number
}

function frame(kind: number, payload: Uint8Array = new Uint8Array()): Buffer {
  if (!Number.isSafeInteger(kind) || kind < 0 || kind > 255 || payload.byteLength > MAX_FRAME_BYTES) {
    throw new ProviderBrokerFetchError('FRAME_BOUNDS', false)
  }
  const output = Buffer.allocUnsafe(5 + payload.byteLength)
  output.writeUInt32BE(payload.byteLength + 1, 0)
  output[4] = kind
  Buffer.from(payload).copy(output, 5)
  return output
}

function jsonBytes(value: unknown): Buffer {
  const result = Buffer.from(JSON.stringify(value), 'utf8')
  if (result.byteLength === 0 || result.byteLength > MAX_CONTROL_BYTES) {
    throw new ProviderBrokerFetchError('FRAME_BOUNDS', false)
  }
  return result
}

function requestBody(body: RequestInit['body']): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  throw new ProviderBrokerFetchError('REQUEST_BODY_REFUSED', false)
}

function projectedHeaders(input: RequestInit['headers'], target: (typeof TARGETS)[NativeBrokerProviderId]):
Readonly<Record<string, string>> {
  const headers = new Headers(input)
  const projected: Record<string, string> = {}
  for (const [rawName, value] of headers.entries()) {
    const name = rawName.toLowerCase()
    if (name === target.placeholderHeader) {
      if (value !== target.placeholderValue.trim()) {
        throw new ProviderBrokerFetchError('CALLER_AUTH_REFUSED', false)
      }
      continue
    }
    if (name === 'content-type') {
      if (value.toLowerCase() !== 'application/json') {
        throw new ProviderBrokerFetchError('CONTENT_TYPE_REFUSED', false)
      }
      continue
    }
    if (name === 'anthropic-version') continue
    if (name === 'accept') projected[name] = value
  }
  return Object.freeze(projected)
}

function decodeControl(raw: Uint8Array): Record<string, unknown> {
  if (raw.byteLength === 0 || raw.byteLength > MAX_CONTROL_BYTES) {
    throw new ProviderBrokerFetchError('FRAME_BOUNDS', false)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw).toString('utf8'))
  } catch {
    throw new ProviderBrokerFetchError('MALFORMED_FRAME', false)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderBrokerFetchError('MALFORMED_FRAME', false)
  }
  return value as Record<string, unknown>
}

function responseMeta(raw: Uint8Array): { status: number; headers: Headers } {
  const value = decodeControl(raw)
  if (Object.keys(value).sort().join(',') !== 'headers,schemaVersion,status' || value['schemaVersion'] !== 1 ||
    !Number.isSafeInteger(value['status']) || Number(value['status']) < 100 || Number(value['status']) > 599 ||
    value['headers'] === null || typeof value['headers'] !== 'object' || Array.isArray(value['headers'])) {
    throw new ProviderBrokerFetchError('MALFORMED_FRAME', false)
  }
  const entries = Object.entries(value['headers'] as Record<string, unknown>)
  if (entries.length > 1 || entries.some(([name, item]) =>
    name !== 'content-type' || typeof item !== 'string' || item.length > 256 || /[\r\n]/.test(item))) {
    throw new ProviderBrokerFetchError('MALFORMED_FRAME', false)
  }
  return { status: Number(value['status']), headers: new Headers(entries as [string, string][]) }
}

function errorMeta(raw: Uint8Array): ProviderBrokerFetchError {
  const value = decodeControl(raw)
  if (Object.keys(value).sort().join(',') !== 'attempted,code,schemaVersion' || value['schemaVersion'] !== 1 ||
    typeof value['code'] !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(value['code']) ||
    typeof value['attempted'] !== 'boolean') {
    return new ProviderBrokerFetchError('MALFORMED_FRAME', false)
  }
  return new ProviderBrokerFetchError(value['code'], value['attempted'])
}

export function makeProviderBrokerFetch(options: ProviderBrokerFetchOptions): typeof fetch {
  const target = TARGETS[options.providerId]
  const socketPath = options.socketPath ?? '/run/aisy/provider/control.sock'
  const connect = options.connect ?? ((path: string) => nodeConnect(path))
  const timeoutMs = options.timeoutMs ?? 60_000

  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== target.url || (init?.method ?? 'GET').toUpperCase() !== 'POST') {
      throw new ProviderBrokerFetchError('TARGET_REFUSED', false)
    }
    const body = requestBody(init?.body)
    if (body.byteLength === 0 || body.byteLength > MAX_REQUEST_BYTES) {
      throw new ProviderBrokerFetchError('REQUEST_BOUNDS', false)
    }
    const headers = projectedHeaders(init?.headers, target)
    const requestId = `request_${randomBytes(24).toString('base64url')}`
    const header = jsonBytes({
      schemaVersion: 1,
      requestId,
      descriptorId: target.descriptorId,
      method: 'POST',
      contentType: 'application/json',
      bodyLength: body.byteLength,
      bodySha256: createHash('sha256').update(body).digest('hex'),
      deadlineMs: timeoutMs,
      headers,
    })

    return await new Promise<Response>((resolve, reject) => {
      const socket = connect(socketPath)
      let pending = Buffer.alloc(0)
      let responseResolved = false
      let attempted = false
      let terminal = false
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null
      const stream = new ReadableStream<Uint8Array>({
        start(value) { controller = value },
        pull() { socket.resume() },
        cancel() { terminal = true; socket.destroy() },
      })
      const fail = (error: ProviderBrokerFetchError): void => {
        if (terminal) return
        terminal = true
        socket.destroy()
        if (responseResolved) controller?.error(error)
        else reject(error)
      }
      const timer = setTimeout(() => fail(new ProviderBrokerFetchError('TIMEOUT', attempted, requestId)), timeoutMs)
      timer.unref()
      const abort = (): void => fail(new ProviderBrokerFetchError('ABORTED', attempted, requestId))
      if (init?.signal?.aborted) abort()
      else init?.signal?.addEventListener('abort', abort, { once: true })

      socket.once('connect', () => {
        socket.write(frame(FRAME_HEADER, header))
        for (let offset = 0; offset < body.byteLength; offset += 64 * 1024) {
          socket.write(frame(FRAME_DATA, body.subarray(offset, Math.min(offset + 64 * 1024, body.byteLength))))
        }
        socket.write(frame(FRAME_END))
      })
      socket.on('data', (chunk: Buffer) => {
        if (terminal) return
        pending = pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk])
        while (pending.byteLength >= 4) {
          const size = pending.readUInt32BE(0)
          if (size < 1 || size > MAX_FRAME_BYTES + 1) return fail(new ProviderBrokerFetchError('FRAME_BOUNDS', false))
          if (pending.byteLength < size + 4) return
          const kind = pending[4]!
          const payload = pending.subarray(5, size + 4)
          pending = pending.subarray(size + 4)
          if (kind === FRAME_ERROR) {
            const error = errorMeta(payload)
            return fail(new ProviderBrokerFetchError(error.code, error.attempted, requestId))
          }
          if (!responseResolved) {
            if (kind === FRAME_ATTEMPTED && payload.byteLength === 0 && !attempted) {
              attempted = true
              continue
            }
            if (kind !== FRAME_HEADER) return fail(new ProviderBrokerFetchError('MALFORMED_FRAME', false))
            try {
              const meta = responseMeta(payload)
              responseResolved = true
              resolve(new Response(stream, { status: meta.status, headers: meta.headers }))
            } catch (error) {
              const failure = error as ProviderBrokerFetchError
              return fail(new ProviderBrokerFetchError(failure.code, failure.attempted, requestId))
            }
            continue
          }
          if (kind === FRAME_DATA && payload.byteLength > 0) {
            controller?.enqueue(Buffer.from(payload))
            if ((controller?.desiredSize ?? 1) <= 0) socket.pause()
          } else if (kind === FRAME_END && payload.byteLength === 0) {
            terminal = true
            clearTimeout(timer)
            init?.signal?.removeEventListener('abort', abort)
            controller?.close()
            socket.end()
          } else {
            return fail(new ProviderBrokerFetchError('MALFORMED_FRAME', true, requestId))
          }
        }
      })
      socket.once('error', () => fail(new ProviderBrokerFetchError('BROKER_UNAVAILABLE', attempted, requestId)))
      socket.once('close', () => {
        if (!terminal) fail(new ProviderBrokerFetchError('BROKER_CHANNEL_LOST', attempted, requestId))
      })
    })
  }
}
