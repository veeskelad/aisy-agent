import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'

const MAX_SECRET_BYTES = 8 * 1024

export class VoiceCredentialTtyError extends Error {
  constructor(readonly code:
    | 'TTY_UNAVAILABLE'
    | 'TTY_STATE_REFUSED'
    | 'TTY_CANCELLED'
    | 'CREDENTIAL_REFUSED') {
    super(code)
    this.name = 'VoiceCredentialTtyError'
  }
}

export interface VoiceCredentialTtyPort {
  open(): number
  snapshot(descriptor: number): string
  hideEcho(descriptor: number): void
  restore(descriptor: number, snapshot: string): void
  write(descriptor: number, text: string): void
  read(descriptor: number, target: Uint8Array, offset: number): number
  close(descriptor: number): void
}

function zero(value: Uint8Array): void {
  value.fill(0)
}

function stableSnapshot(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f:;]+$/i.test(value) || value.length > 4096) {
    throw new VoiceCredentialTtyError('TTY_STATE_REFUSED')
  }
  return value
}

function stty(descriptor: number, args: readonly string[], capture = false): string {
  const result = spawnSync('/bin/stty', [...args], {
    env: { LANG: 'C', LC_ALL: 'C' },
    stdio: [descriptor, capture ? 'pipe' : 'ignore', 'ignore'],
    encoding: capture ? 'utf8' : undefined,
    timeout: 5_000,
  })
  if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
    throw new VoiceCredentialTtyError('TTY_STATE_REFUSED')
  }
  return capture ? stableSnapshot(String(result.stdout).trim()) : ''
}

/** Exact `/dev/tty` adapter. It never reads stdin and invokes no shell. */
export function makeNodeVoiceCredentialTtyPort(): VoiceCredentialTtyPort {
  const port: VoiceCredentialTtyPort = {
    open() {
      let descriptor: number
      try {
        descriptor = openSync(
          '/dev/tty',
          constants.O_RDWR | (constants.O_NOCTTY ?? 0),
        )
      } catch {
        throw new VoiceCredentialTtyError('TTY_UNAVAILABLE')
      }
      const info = fstatSync(descriptor)
      if (!info.isCharacterDevice()) {
        closeSync(descriptor)
        throw new VoiceCredentialTtyError('TTY_UNAVAILABLE')
      }
      return descriptor
    },
    snapshot: descriptor => stty(descriptor, ['-g'], true),
    hideEcho: descriptor => { stty(descriptor, ['-echo']) },
    restore: (descriptor, snapshot) => { stty(descriptor, [stableSnapshot(snapshot)]) },
    write: (descriptor, text) => { writeSync(descriptor, text) },
    read: (descriptor, target, offset) => readSync(descriptor, target, offset, 1, null),
    close: descriptor => { closeSync(descriptor) },
  }
  return Object.freeze(port)
}

/**
 * Owns the input buffer and restores the exact terminal state before returning
 * any bytes to the caller. The caller becomes the owner only on success.
 */
export function readVoiceCredentialFromTty(
  port: VoiceCredentialTtyPort = makeNodeVoiceCredentialTtyPort(),
): Uint8Array {
  let descriptor = -1
  let snapshot: string | null = null
  let echoHidden = false
  let restored = false
  let cancelled = false
  const owned = new Uint8Array(MAX_SECRET_BYTES + 1)
  let length = 0
  const onSignal = (): void => { cancelled = true }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  try {
    descriptor = port.open()
    snapshot = stableSnapshot(port.snapshot(descriptor))
    // A failed adapter call may have changed termios before reporting failure.
    // Once mutation is attempted, restoration is mandatory.
    echoHidden = true
    port.hideEcho(descriptor)
    for (const signal of signals) process.once(signal, onSignal)
    try { port.write(descriptor, 'Deepgram API key: ') } catch {
      throw new VoiceCredentialTtyError('TTY_STATE_REFUSED')
    }
    while (!cancelled && length <= MAX_SECRET_BYTES) {
      let count: number
      try { count = port.read(descriptor, owned, length) } catch {
        if (cancelled) break
        throw new VoiceCredentialTtyError('TTY_CANCELLED')
      }
      if (count !== 1) throw new VoiceCredentialTtyError('TTY_CANCELLED')
      if (owned[length] === 0x0a) break
      length += 1
    }
    if (cancelled) throw new VoiceCredentialTtyError('TTY_CANCELLED')
    if (length < 1 || length > MAX_SECRET_BYTES || owned[length] !== 0x0a ||
      owned.subarray(0, length).some(byte => byte <= 0x20 || byte >= 0x7f)) {
      throw new VoiceCredentialTtyError('CREDENTIAL_REFUSED')
    }
    port.restore(descriptor, snapshot)
    restored = true
    echoHidden = false
    try { port.write(descriptor, '\n') } catch { /* state is already restored */ }
    const result = owned.slice(0, length)
    zero(owned)
    return result
  } catch (error) {
    zero(owned)
    throw error instanceof VoiceCredentialTtyError
      ? error
      : new VoiceCredentialTtyError('TTY_STATE_REFUSED')
  } finally {
    for (const signal of signals) process.off(signal, onSignal)
    if (descriptor >= 0 && echoHidden && !restored && snapshot !== null) {
      try {
        port.restore(descriptor, snapshot)
        restored = true
      } catch {
        // The caller receives no bytes when restoration cannot be proven.
      }
    }
    if (descriptor >= 0) {
      try { port.close(descriptor) } catch { /* descriptor ownership ends here */ }
    }
    if (!restored && snapshot !== null) zero(owned)
  }
}
