import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import {
  CodexAuthDriverError,
  makeNodeCodexAuthProcessPort,
  makeCodexSubscriptionAuth,
  parseCodexDeviceChallenge,
  type CodexAuthProcessPort,
  type CodexStreamingCommand,
} from './codex-auth.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Codex subscription authentication', () => {
  it('parses only the safe HTTPS device URL and user code', () => {
    expect(parseCodexDeviceChallenge(
      '\u001b[36mOpen https://auth.openai.com/activate\u001b[0m\nEnter code ABCD-EFGH',
    )).toEqual({
      kind: 'device-code',
      verificationUri: 'https://auth.openai.com/activate',
      userCode: 'ABCD-EFGH',
    })
    expect(parseCodexDeviceChallenge('no challenge here')).toBeNull()
  })

  it('detects the official CLI without exposing raw failure output', async () => {
    const processPort: CodexAuthProcessPort = {
      run: async () => ({ exitCode: 1, output: 'local environment detail' }),
      start: () => { throw new Error('unused') },
    }
    await expect(makeCodexSubscriptionAuth(processPort).detect()).resolves.toEqual({ installed: false })
  })

  it('extracts only the official version when stderr contains a sandbox warning', async () => {
    const processPort: CodexAuthProcessPort = {
      run: async () => ({
        exitCode: 0,
        output: 'codex-cli 0.144.5\nWARNING: local path and environment detail',
      }),
      start: () => { throw new Error('unused') },
    }
    const result = await makeCodexSubscriptionAuth(processPort).detect()
    expect(result).toEqual({ installed: true, version: 'codex-cli 0.144.5' })
    expect(JSON.stringify(result)).not.toContain('local path')
  })

  it('starts the official device-auth command and resolves before login completes', async () => {
    const done = deferred<{ exitCode: number }>()
    const seen: string[][] = []
    let emit: (chunk: string) => void = () => {}
    const processPort: CodexAuthProcessPort = {
      run: async () => ({ exitCode: 0, output: 'ok' }),
      start: (command, args, onChunk): CodexStreamingCommand => {
        seen.push([command, ...args])
        emit = onChunk
        return { completed: done.promise, stop: () => {} }
      },
    }
    const auth = makeCodexSubscriptionAuth(processPort)
    const challengePromise = auth.beginAuth()
    emit('Visit https://auth.openai.com/activate and enter WXYZ-1234')
    await expect(challengePromise).resolves.toMatchObject({ userCode: 'WXYZ-1234' })
    expect(seen).toEqual([['codex', 'login', '--device-auth']])
    done.resolve({ exitCode: 0 })
  })

  it('fails with a stable code when no challenge is produced', async () => {
    const done = deferred<{ exitCode: number }>()
    const processPort: CodexAuthProcessPort = {
      run: async () => ({ exitCode: 0, output: '' }),
      start: (_command, _args, onChunk) => {
        onChunk('unexpected output containing local paths')
        return { completed: done.promise, stop: () => {} }
      },
    }
    const result = makeCodexSubscriptionAuth(processPort).beginAuth()
    done.resolve({ exitCode: 1 })
    await expect(result).rejects.toEqual(
      new CodexAuthDriverError('DEVICE_AUTH_CHALLENGE_UNAVAILABLE'),
    )
  })

  it('waits for device auth then validates with codex login status', async () => {
    const done = deferred<{ exitCode: number }>()
    const runs: string[][] = []
    const processPort: CodexAuthProcessPort = {
      run: async (command, args) => {
        runs.push([command, ...args])
        return { exitCode: 0, output: 'Logged in using ChatGPT' }
      },
      start: (_command, _args, onChunk) => {
        onChunk('https://auth.openai.com/activate CODE-1234')
        return { completed: done.promise, stop: () => {} }
      },
    }
    const auth = makeCodexSubscriptionAuth(processPort)
    await auth.beginAuth()
    const validation = auth.validate()
    done.resolve({ exitCode: 0 })
    await expect(validation).resolves.toEqual({
      ok: true,
      safeDetail: 'Codex authentication is active.',
    })
    expect(runs).toEqual([['codex', 'login', 'status']])
  })

  it('returns a redaction-safe result when status is not authenticated', async () => {
    const processPort: CodexAuthProcessPort = {
      run: async () => ({ exitCode: 1, output: 'sensitive local status detail' }),
      start: () => { throw new Error('unused') },
    }
    const result = await makeCodexSubscriptionAuth(processPort).validate()
    expect(result).toEqual({
      ok: false,
      safeDetail: 'Codex is not authenticated.',
      errorCode: 'CODEX_NOT_AUTHENTICATED',
    })
    expect(JSON.stringify(result)).not.toContain('sensitive local status detail')
  })

  it('revokes only through the official logout command and hides raw output', async () => {
    const calls: string[][] = []
    const processPort: CodexAuthProcessPort = {
      run: async (command, args) => {
        calls.push([command, ...args])
        return { exitCode: 1, output: 'local account detail' }
      },
      start: () => { throw new Error('unused') },
    }

    const result = await makeCodexSubscriptionAuth(processPort).revoke()

    expect(calls).toEqual([['codex', 'logout']])
    expect(result).toEqual({
      ok: false,
      safeDetail: 'Codex authentication could not be revoked.',
      errorCode: 'CODEX_LOGOUT_FAILED',
    })
    expect(JSON.stringify(result)).not.toContain('local account detail')
  })

  it('binds auth commands to one canonical executable and sanitized environment', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-codex-auth-')))
    const executable = join(root, 'codex')
    writeFileSync(executable, `#!/bin/sh
if [ -n "$OPENAI_API_KEY" ] || [ -n "$ANTHROPIC_API_KEY" ]; then exit 91; fi
if [ "$1" = "--version" ]; then echo "codex-cli 0.144.5"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then
  echo "Visit https://auth.openai.com/activate and enter SAFE-1234"
  exit 0
fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "logout" ]; then exit 0; fi
exit 92
`, { mode: 0o700 })
    chmodSync(executable, 0o700)
    const port = makeNodeCodexAuthProcessPort({
      codexExecutable: executable,
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        OPENAI_API_KEY: 'must-not-be-inherited',
        ANTHROPIC_API_KEY: 'must-not-be-inherited',
      },
    })
    const auth = makeCodexSubscriptionAuth(port)

    await expect(auth.detect()).resolves.toEqual({
      installed: true,
      version: 'codex-cli 0.144.5',
    })
    await expect(auth.beginAuth()).resolves.toMatchObject({ userCode: 'SAFE-1234' })
    await expect(auth.validate()).resolves.toMatchObject({ ok: true })
    await expect(auth.revoke()).resolves.toMatchObject({ ok: true })
    await expect(port.run('codex', ['exec', 'unapproved'])).resolves.toEqual({
      exitCode: 1,
      output: '',
    })
    await expect(port.start('other', ['login', '--device-auth'], () => {}).completed)
      .resolves.toEqual({ exitCode: 1 })
  })

  it('rejects non-canonical, group-writable, or invalid-timeout auth configuration', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-codex-auth-invalid-')))
    const executable = join(root, 'codex')
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 })
    chmodSync(executable, 0o700)
    expect(() => makeNodeCodexAuthProcessPort({ codexExecutable: 'codex' })).toThrow(
      expect.objectContaining({ code: 'INVALID_AUTH_CONFIG' }),
    )
    expect(() => makeNodeCodexAuthProcessPort({
      codexExecutable: executable,
      timeoutMs: 999,
    })).toThrow(expect.objectContaining({ code: 'INVALID_AUTH_CONFIG' }))
    chmodSync(executable, 0o770)
    expect(() => makeNodeCodexAuthProcessPort({ codexExecutable: executable })).toThrow(
      expect.objectContaining({ code: 'INVALID_AUTH_CONFIG' }),
    )
  })
})
