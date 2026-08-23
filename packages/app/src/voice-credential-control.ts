import { randomBytes } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { dirname, isAbsolute, normalize } from 'node:path'
import { isProxy } from 'node:util/types'

const HASH = /^[a-f0-9]{64}$/
const OPAQUE = /^[A-Za-z0-9_-]{20,160}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{32}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/
const MAX_FRAME_BYTES = 64 * 1024
const MAX_SECRET_BYTES = 8 * 1024
const PROTOCOL = 'aisy.voice.control.v1'

export type VoiceCredentialBinding = Readonly<{
  installationHash: string
  operatorId: string
  profileId: string
  providerId: 'deepgram-cloud'
}>

export type VoiceCredentialInspection =
  | Readonly<{ state: 'unconfigured' | 'enrolling' | 'unavailable' }>
  | Readonly<{ state: 'ready'; handle: string; revision: number }>

export type VoiceCredentialRevokeResult =
  | Readonly<{ state: 'revoked'; revision: number }>
  | Readonly<{ state: 'pending'; revision: number }>

export interface VoiceCredentialControlPort {
  begin(input: VoiceCredentialBinding): Promise<{ code: string; expiresAt: string }>
  inspect(input: VoiceCredentialBinding): Promise<VoiceCredentialInspection>
  revoke(input: VoiceCredentialBinding): Promise<VoiceCredentialRevokeResult>
}

export interface VoiceCredentialIngressPort {
  submit(input: Readonly<{ code: string; secret: Uint8Array }>): Promise<
    Readonly<{ state: 'ready'; handle: string; revision: number }>
  >
}

export class VoiceCredentialControlError extends Error {
  constructor(readonly code:
    | 'INVALID_COMMAND'
    | 'CONTROL_UNAVAILABLE'
    | 'CONTROL_PROTOCOL_REFUSED'
    | 'CHALLENGE_REFUSED'
    | 'CREDENTIAL_REFUSED'
    | 'REVOCATION_PENDING') {
    super(code)
    this.name = 'VoiceCredentialControlError'
  }
}

type Connect = (path: string) => Socket

function fail(code: VoiceCredentialControlError['code']): never {
  throw new VoiceCredentialControlError(code)
}

function binding(value: unknown): VoiceCredentialBinding {
  if (value === null || typeof value !== 'object' || isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) fail('CONTROL_PROTOCOL_REFUSED')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' ||
    !['installationHash', 'operatorId', 'profileId', 'providerId'].includes(key)) ||
    Object.values(descriptors).some(descriptor => !('value' in descriptor)) ||
    !HASH.test(String(descriptors.installationHash?.value)) ||
    !SAFE_ID.test(String(descriptors.operatorId?.value)) ||
    !SAFE_ID.test(String(descriptors.profileId?.value)) ||
    descriptors.providerId?.value !== 'deepgram-cloud') {
    fail('CONTROL_PROTOCOL_REFUSED')
  }
  return Object.freeze({
    installationHash: descriptors.installationHash!.value as string,
    operatorId: descriptors.operatorId!.value as string,
    profileId: descriptors.profileId!.value as string,
    providerId: 'deepgram-cloud',
  })
}

function exactSecret(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || isProxy(value) || value.byteLength < 1 ||
    value.byteLength > MAX_SECRET_BYTES || value.some(byte => byte <= 0x20 || byte >= 0x7f)) {
    fail('CREDENTIAL_REFUSED')
  }
  return value
}

function exactCode(value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE.test(value)) fail('CHALLENGE_REFUSED')
  return value
}

function attestRootVoiceControlSocketUnsafe(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0') ||
    realpathSync(path) !== path) fail('CONTROL_UNAVAILABLE')
  const socket = lstatSync(path)
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== 0 ||
    (socket.mode & 0o007) !== 0) fail('CONTROL_UNAVAILABLE')
  let current = dirname(path)
  for (;;) {
    const info = lstatSync(current)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 ||
      (info.mode & 0o022) !== 0) fail('CONTROL_UNAVAILABLE')
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

export function attestRootVoiceControlSocket(path: string): void {
  try {
    attestRootVoiceControlSocketUnsafe(path)
  } catch (error) {
    if (error instanceof VoiceCredentialControlError) throw error
    fail('CONTROL_UNAVAILABLE')
  }
}

function encodeHeader(
  requestId: string,
  operation: 'begin' | 'inspect' | 'submit' | 'revoke',
  payload: readonly unknown[],
  secretBytes: number,
): Buffer {
  const body = Buffer.from(JSON.stringify([
    PROTOCOL, requestId, operation, payload, secretBytes,
  ]), 'utf8')
  if (body.byteLength > MAX_FRAME_BYTES) fail('CONTROL_PROTOCOL_REFUSED')
  const prefix = Buffer.allocUnsafe(4)
  prefix.writeUInt32BE(body.byteLength)
  return Buffer.concat([prefix, body])
}

function decodeResponse(raw: Buffer, requestId: string): readonly unknown[] {
  let value: unknown
  try { value = JSON.parse(raw.toString('utf8')) } catch { return fail('CONTROL_PROTOCOL_REFUSED') }
  if (!Array.isArray(value) || value.length !== 4 || value[0] !== PROTOCOL ||
    value[1] !== requestId || (value[2] !== 'ok' && value[2] !== 'error') ||
    !Array.isArray(value[3])) fail('CONTROL_PROTOCOL_REFUSED')
  const payload = value[3]
  if (value[2] === 'error') {
    if (payload.length !== 1 || typeof payload[0] !== 'string') fail('CONTROL_PROTOCOL_REFUSED')
    const mapped: Record<string, VoiceCredentialControlError['code']> = {
      CHALLENGE_REFUSED: 'CHALLENGE_REFUSED',
      CREDENTIAL_REFUSED: 'CREDENTIAL_REFUSED',
      REVOCATION_PENDING: 'REVOCATION_PENDING',
    }
    throw new VoiceCredentialControlError(mapped[payload[0]] ?? 'CONTROL_UNAVAILABLE')
  }
  return payload
}

function writeSocket(socket: Socket, value: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    socket.write(bytes, (error?: Error | null) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function exchange(input: {
  socketPath: string
  timeoutMs: number
  requestId: string
  operation: 'begin' | 'inspect' | 'submit' | 'revoke'
  payload: readonly unknown[]
  secret?: Uint8Array
  attest: (path: string) => void
  connect: Connect
}): Promise<readonly unknown[]> {
  input.attest(input.socketPath)
  const secret = input.secret === undefined ? undefined : exactSecret(input.secret)
  const header = encodeHeader(
    input.requestId,
    input.operation,
    input.payload,
    secret?.byteLength ?? 0,
  )
  return new Promise((resolve, reject) => {
    let settled = false
    let expectedBytes: number | null = null
    let received = Buffer.alloc(0)
    const socket = input.connect(input.socketPath)
    const finish = (error: VoiceCredentialControlError | null, value?: readonly unknown[]): void => {
      if (settled) return
      settled = true
      socket.destroy()
      received.fill(0)
      if (error !== null) reject(error)
      else resolve(value ?? [])
    }
    socket.setTimeout(input.timeoutMs)
    socket.once('timeout', () => finish(new VoiceCredentialControlError('CONTROL_UNAVAILABLE')))
    socket.once('error', () => finish(new VoiceCredentialControlError('CONTROL_UNAVAILABLE')))
    socket.on('data', (chunk: Buffer) => {
      if (settled || received.byteLength + chunk.byteLength > MAX_FRAME_BYTES + 4) {
        finish(new VoiceCredentialControlError('CONTROL_PROTOCOL_REFUSED'))
        return
      }
      received = Buffer.concat([received, chunk])
      if (expectedBytes === null && received.byteLength >= 4) {
        expectedBytes = received.readUInt32BE(0)
        if (expectedBytes < 2 || expectedBytes > MAX_FRAME_BYTES) {
          finish(new VoiceCredentialControlError('CONTROL_PROTOCOL_REFUSED'))
          return
        }
      }
      if (expectedBytes !== null && received.byteLength === expectedBytes + 4) {
        try { finish(null, decodeResponse(received.subarray(4), input.requestId)) } catch (error) {
          finish(error instanceof VoiceCredentialControlError
            ? error
            : new VoiceCredentialControlError('CONTROL_PROTOCOL_REFUSED'))
        }
      } else if (expectedBytes !== null && received.byteLength > expectedBytes + 4) {
        finish(new VoiceCredentialControlError('CONTROL_PROTOCOL_REFUSED'))
      }
    })
    socket.once('connect', () => {
      void (async () => {
        try {
          await writeSocket(socket, header)
          if (secret !== undefined) await writeSocket(socket, secret)
        } catch {
          finish(new VoiceCredentialControlError('CONTROL_UNAVAILABLE'))
        } finally {
          header.fill(0)
        }
      })()
    })
  })
}

function ready(payload: readonly unknown[]): Readonly<{
  state: 'ready'; handle: string; revision: number
}> {
  if (payload.length !== 3 || payload[0] !== 'ready' ||
    typeof payload[1] !== 'string' || !OPAQUE.test(payload[1]) ||
    !Number.isSafeInteger(payload[2]) || Number(payload[2]) < 1) {
    fail('CONTROL_PROTOCOL_REFUSED')
  }
  return Object.freeze({ state: 'ready', handle: payload[1], revision: Number(payload[2]) })
}

export function makeNodeVoiceCredentialControl(input: {
  socketPath: string
  timeoutMs?: number
  newRequestId?: () => string
  attestSocket?: (path: string) => void
  connect?: Connect
}): VoiceCredentialControlPort & VoiceCredentialIngressPort {
  const timeoutMs = input.timeoutMs ?? 5_000
  const newRequestId = input.newRequestId ?? (() => randomBytes(24).toString('base64url'))
  const attest = input.attestSocket ?? attestRootVoiceControlSocket
  const connect = input.connect ?? ((path: string) => createConnection({ path }))
  if (!isAbsolute(input.socketPath) || normalize(input.socketPath) !== input.socketPath ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    fail('CONTROL_UNAVAILABLE')
  }
  const call = async (
    operation: 'begin' | 'inspect' | 'submit' | 'revoke',
    payload: readonly unknown[],
    secret?: Uint8Array,
  ): Promise<readonly unknown[]> => {
    const requestId = newRequestId()
    if (!REQUEST_ID.test(requestId)) fail('CONTROL_UNAVAILABLE')
    return await exchange({
      socketPath: input.socketPath,
      timeoutMs,
      requestId,
      operation,
      payload,
      ...(secret === undefined ? {} : { secret }),
      attest,
      connect,
    })
  }
  return Object.freeze({
    async begin(raw: unknown) {
      const exact = binding(raw)
      const payload = await call('begin', [
        exact.installationHash, exact.operatorId, exact.profileId, exact.providerId,
      ])
      if (payload.length !== 3 || payload[0] !== 'challenge' ||
        typeof payload[1] !== 'string' || !OPAQUE.test(payload[1]) ||
        typeof payload[2] !== 'string' || !Number.isFinite(Date.parse(payload[2]))) {
        fail('CONTROL_PROTOCOL_REFUSED')
      }
      return Object.freeze({ code: payload[1], expiresAt: payload[2] })
    },
    async inspect(raw: unknown) {
      const exact = binding(raw)
      const payload = await call('inspect', [
        exact.installationHash, exact.operatorId, exact.profileId, exact.providerId,
      ])
      if (payload.length === 2 && payload[0] === 'state' &&
        ['unconfigured', 'enrolling', 'unavailable'].includes(String(payload[1]))) {
        return Object.freeze({ state: payload[1] as 'unconfigured' | 'enrolling' | 'unavailable' })
      }
      return ready(payload)
    },
    async submit(raw: unknown) {
      if (raw === null || typeof raw !== 'object' || isProxy(raw) ||
        Object.getPrototypeOf(raw) !== Object.prototype ||
      Reflect.ownKeys(raw).length !== 2 ||
      Reflect.ownKeys(raw).some(key => key !== 'code' && key !== 'secret')) {
        fail('CREDENTIAL_REFUSED')
      }
    const exact = raw as Readonly<{ code: unknown; secret: unknown }>
    return ready(await call('submit', [exactCode(exact.code)], exactSecret(exact.secret)))
    },
    async revoke(raw: unknown) {
      const exact = binding(raw)
      const payload = await call('revoke', [
        exact.installationHash, exact.operatorId, exact.profileId, exact.providerId,
      ])
      if (payload.length !== 2 ||
        (payload[0] !== 'revoked' && payload[0] !== 'pending') ||
        !Number.isSafeInteger(payload[1]) || Number(payload[1]) < 1) {
        fail('CONTROL_PROTOCOL_REFUSED')
      }
      return Object.freeze({
        state: payload[0] as 'revoked' | 'pending',
        revision: Number(payload[1]),
      })
    },
  })
}

export function parseVoiceCredentialSetCommand(argv: readonly string[]): string {
  if (argv.length !== 4 || argv[0] !== 'voice' || argv[1] !== 'credential' ||
    argv[2] !== 'set' || !argv[3]?.startsWith('--code=')) fail('INVALID_COMMAND')
  return exactCode(argv[3].slice('--code='.length))
}

/** Parses first, reads a restored TTY second, opens the control socket last. */
export async function runVoiceCredentialSetCommand(input: {
  argv: readonly string[]
  readSecret: () => Uint8Array
  ingress: VoiceCredentialIngressPort
}): Promise<Readonly<{ state: 'ready'; handle: string; revision: number }>> {
  const code = parseVoiceCredentialSetCommand(input.argv)
  const secret = input.readSecret()
  try {
    exactSecret(secret)
    return await input.ingress.submit({ code, secret })
  } finally {
    secret.fill(0)
  }
}
