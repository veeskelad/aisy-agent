export interface CredentialTerminalInput {
  readonly isTTY?: boolean
  readonly isRaw?: boolean
  isPaused(): boolean
  setRawMode(enabled: boolean): void
  setEncoding?(encoding: null): void
  resume(): void
  pause(): void
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

export interface CredentialTerminalOutput {
  readonly isTTY?: boolean
  write(value: string): unknown
}

export interface CredentialTerminalPrompt {
  readSecret(prompt: string): Promise<Uint8Array>
}

export class CredentialTerminalError extends Error {
  constructor(public readonly code:
    | 'CREDENTIAL_TTY_REQUIRED'
    | 'CREDENTIAL_PROMPT_BUSY'
    | 'CREDENTIAL_INPUT_CANCELLED'
    | 'CREDENTIAL_INPUT_INVALID'
    | 'CREDENTIAL_INPUT_TOO_LARGE'
    | 'CREDENTIAL_TERMINAL_FAILED') {
    super(code)
    this.name = 'CredentialTerminalError'
  }
}

const MAX_SECRET_BYTES = 16 * 1024
const SAFE_PROMPT = /^[^\u0000-\u001F\u007F]{1,100}$/u

/**
 * Raw TTY credential reader. It writes no echo, bullets, stars or length
 * metadata. Returned bytes are owned by the caller and must be zeroed.
 */
export function makeCredentialTerminalPrompt(input: {
  stdin: CredentialTerminalInput
  stdout: CredentialTerminalOutput
}): CredentialTerminalPrompt {
  let reading = false

  return Object.freeze({
    async readSecret(prompt: string): Promise<Uint8Array> {
      if (reading) throw new CredentialTerminalError('CREDENTIAL_PROMPT_BUSY')
      if (input.stdin.isTTY !== true || input.stdout.isTTY !== true) {
        throw new CredentialTerminalError('CREDENTIAL_TTY_REQUIRED')
      }
      if (!SAFE_PROMPT.test(prompt)) {
        throw new CredentialTerminalError('CREDENTIAL_INPUT_INVALID')
      }

      reading = true
      const wasRaw = input.stdin.isRaw === true
      const wasPaused = input.stdin.isPaused()
      const working = Buffer.alloc(MAX_SECRET_BYTES)
      let length = 0

      return new Promise<Uint8Array>((resolve, reject) => {
        let settled = false

        const restore = (): boolean => {
          let restored = true
          try { input.stdin.off('data', onData) } catch { restored = false }
          try { input.stdin.setRawMode(wasRaw) } catch { restored = false }
          if (wasPaused) {
            try { input.stdin.pause() } catch { restored = false }
          }
          working.fill(0)
          reading = false
          return restored
        }

        const newline = (): void => {
          try { input.stdout.write('\n') } catch { /* terminal recovery still runs */ }
        }

        const fail = (code: CredentialTerminalError['code']): void => {
          if (settled) return
          settled = true
          newline()
          const restored = restore()
          reject(new CredentialTerminalError(restored ? code : 'CREDENTIAL_TERMINAL_FAILED'))
        }

        const finish = (): void => {
          if (settled) return
          settled = true
          const result = Buffer.from(working.subarray(0, length))
          newline()
          const restored = restore()
          if (!restored) {
            result.fill(0)
            reject(new CredentialTerminalError('CREDENTIAL_TERMINAL_FAILED'))
          } else {
            resolve(result)
          }
        }

        const onData = (raw: Buffer | string): void => {
          const chunk = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw
          try {
            for (const byte of chunk) {
              if (byte === 3 || byte === 27) {
                fail('CREDENTIAL_INPUT_CANCELLED')
                return
              }
              if (byte === 10 || byte === 13) {
                finish()
                return
              }
              if (byte === 8 || byte === 127) {
                if (length > 0) working[--length] = 0
                continue
              }
              if (byte < 32) {
                fail('CREDENTIAL_INPUT_INVALID')
                return
              }
              if (length >= MAX_SECRET_BYTES) {
                fail('CREDENTIAL_INPUT_TOO_LARGE')
                return
              }
              working[length++] = byte
            }
          } catch {
            fail('CREDENTIAL_TERMINAL_FAILED')
          } finally {
            if (Buffer.isBuffer(raw)) raw.fill(0)
            if (chunk !== raw) chunk.fill(0)
          }
        }

        try {
          input.stdin.setEncoding?.(null)
          input.stdin.setRawMode(true)
          input.stdout.write(`${prompt}: `)
          input.stdin.on('data', onData)
          input.stdin.resume()
        } catch {
          settled = true
          newline()
          restore()
          reject(new CredentialTerminalError('CREDENTIAL_TERMINAL_FAILED'))
        }
      })
    },
  })
}

export function makeNodeCredentialTerminalPrompt(): CredentialTerminalPrompt {
  return makeCredentialTerminalPrompt({
    stdin: process.stdin as unknown as CredentialTerminalInput,
    stdout: process.stdout,
  })
}
