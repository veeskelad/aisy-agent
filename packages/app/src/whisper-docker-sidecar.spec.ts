import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  makeDockerWhisperTranscriber,
  whisperDockerArgv,
  WhisperSidecarError,
  type WhisperAudioRequest,
  type WhisperDockerCommandPort,
  type WhisperDockerCommandResult,
  type WhisperDockerLimits,
} from './whisper-docker-sidecar.js'

const IMAGE = `registry.example/aisy/whisper@sha256:${'a'.repeat(64)}`
const LIMITS: WhisperDockerLimits = {
  memoryBytes: 2 * 1024 * 1024 * 1024,
  cpuMillicores: 2_000,
  pids: 64,
  wallTimeMs: 120_000,
}
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function audioFixture(): WhisperAudioRequest {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-whisper-')))
  roots.push(root)
  const payload = Buffer.from('OggS voice bytes')
  writeFileSync(join(root, 'voice.ogg'), payload)
  return {
    audioRoot: root,
    relativePath: 'voice.ogg',
    expectedSha256: createHash('sha256').update(payload).digest('hex'),
    expectedSizeBytes: payload.byteLength,
    maxBytes: 1024 * 1024,
    language: 'ru',
  }
}

function option(args: readonly string[], name: string): string {
  const value = args.find(arg => arg.startsWith(`${name}=`))
  if (value === undefined) throw new Error(`missing ${name}`)
  return value.slice(name.length + 1)
}

function ok(stdout = ''): WhisperDockerCommandResult {
  return { exitCode: 0, stdout, stderr: '' }
}

function inspectFromCreate(
  create: readonly string[],
  state: { exitCode: number; oomKilled: boolean },
  mutate?: (value: Record<string, unknown>) => void,
): string {
  const mountArg = option(create, '--mount')
  const source = /source=([^,]+)/.exec(mountArg)?.[1]
  const value: Record<string, unknown> = {
    Config: {
      Image: create.at(-1),
      User: option(create, '--user'),
      OpenStdin: true,
      Env: create.filter(arg => arg.startsWith('--env=')).map(arg => arg.slice('--env='.length)),
      Labels: Object.fromEntries(create.filter(arg => arg.startsWith('--label='))
        .map(arg => arg.slice('--label='.length).split(/=(.*)/s).slice(0, 2))),
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges=true', 'seccomp=builtin'],
      IpcMode: 'none',
      Memory: Number(option(create, '--memory')),
      MemorySwap: Number(option(create, '--memory-swap')),
      NanoCpus: Number(option(create, '--cpus')) * 1_000_000_000,
      PidsLimit: Number(option(create, '--pids-limit')),
      Binds: null,
      Tmpfs: {
        '/tmp': 'rw,nosuid,nodev,noexec,size=67108864,mode=0700',
      },
    },
    Mounts: [{
      Type: 'bind', Source: source, Destination: '/input', RW: false, Propagation: 'rprivate',
    }],
    State: { Running: false, ExitCode: state.exitCode, OOMKilled: state.oomKilled },
  }
  mutate?.(value)
  return JSON.stringify([value])
}

function dockerFake(input: {
  response?: (requestId: string) => WhisperDockerCommandResult
  mutateInspect?: (value: Record<string, unknown>) => void
  timedOut?: boolean
  oomKilled?: boolean
  cleanupFails?: boolean
  createAmbiguous?: boolean
  version?: string
} = {}): { docker: WhisperDockerCommandPort; calls: string[][]; stdins: string[] } {
  const calls: string[][] = []
  const stdins: string[] = []
  let create: string[] = []
  let startExit = 0
  const docker: WhisperDockerCommandPort = {
    async run(args, options) {
      const command = [...args]
      calls.push(command)
      if (typeof options.stdin === 'string') stdins.push(options.stdin)
      if (command[0] === 'version') return ok(`${input.version ?? '29.6.0'}\n`)
      if (command[0] === 'container' && command[1] === 'create') {
        create = command
        if (input.createAmbiguous === true) {
          return { exitCode: 137, stdout: '', stderr: '', aborted: true }
        }
        return ok('container-id')
      }
      if (command[0] === 'container' && command[1] === 'inspect') {
        let raw = inspectFromCreate(create, {
          exitCode: input.oomKilled === true ? 137 : startExit,
          oomKilled: input.oomKilled === true,
        })
        if (input.mutateInspect !== undefined) {
          const parsed = JSON.parse(raw) as Array<Record<string, unknown>>
          input.mutateInspect(parsed[0]!)
          raw = JSON.stringify(parsed)
        }
        return ok(raw)
      }
      if (command[0] === 'container' && command[1] === 'start') {
        if (input.timedOut === true) return { exitCode: 137, stdout: '', stderr: '', timedOut: true }
        const request = JSON.parse(options.stdin ?? '{}') as { requestId?: string }
        const response = input.response?.(request.requestId ?? '') ?? ok(JSON.stringify({
          version: 1,
          requestId: request.requestId,
          ok: true,
          data: { text: 'Привет из Whisper', language: 'ru', durationMs: 1250 },
        }))
        startExit = response.exitCode
        return response
      }
      if (command[0] === 'container' && command[1] === 'rm') {
        return input.cleanupFails === true ? { exitCode: 1, stdout: '', stderr: '' } : ok()
      }
      return { exitCode: 1, stdout: '', stderr: '' }
    },
  }
  return { docker, calls, stdins }
}

function transcriber(docker: WhisperDockerCommandPort) {
  let request = 0
  return makeDockerWhisperTranscriber({
    docker,
    imageDigest: IMAGE,
    limits: LIMITS,
    newRequestId: () => `voice-${++request}`,
  })
}

describe('Whisper Docker sidecar', () => {
  it('builds and verifies an exact no-network, read-only, quota-bound container', async () => {
    const request = audioFixture()
    const fake = dockerFake()

    const result = await transcriber(fake.docker).transcribe(request)

    expect(result).toEqual({
      text: 'Привет из Whisper', provenance: 'untrusted', channel: 'voice',
      language: 'ru', durationMs: 1250,
    })
    const create = fake.calls.find(call => call[0] === 'container' && call[1] === 'create')!
    expect(create).toEqual(expect.arrayContaining([
      '--interactive', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges=true', '--security-opt=seccomp=builtin',
      '--ipc=none', '--user=65532:65532', `--memory=${LIMITS.memoryBytes}`,
      `--memory-swap=${LIMITS.memoryBytes}`, '--pids-limit=64', '--cpus=2.000', IMAGE,
    ]))
    expect(create.some(value => value.includes('docker.sock') || value.startsWith('--publish') ||
      value === '--privileged')).toBe(false)
    expect(JSON.stringify(create)).not.toMatch(/TOKEN|SECRET|PASSWORD|CREDENTIAL|SSH_AUTH_SOCK/)
    expect(fake.stdins).toHaveLength(1)
    expect(JSON.parse(fake.stdins[0]!)).toMatchObject({ root: '/input', path: 'voice.ogg' })
    expect(fake.calls.at(-1)?.slice(0, 3)).toEqual(['container', 'rm', '--force'])
  })

  it('refuses a weakened inspect before worker start and destroys the owned container', async () => {
    const fake = dockerFake({
      mutateInspect(value) {
        ;(value.HostConfig as Record<string, unknown>).NetworkMode = 'bridge'
      },
    })

    await expect(transcriber(fake.docker).transcribe(audioFixture()))
      .rejects.toEqual(new WhisperSidecarError('SANDBOX_DENIED'))
    expect(fake.calls.some(call => call[0] === 'container' && call[1] === 'start')).toBe(false)
    expect(fake.calls.at(-1)?.slice(0, 3)).toEqual(['container', 'rm', '--force'])
  })

  it('maps timeout and OOM to stable codes and always cleans up', async () => {
    const timeout = dockerFake({ timedOut: true })
    await expect(transcriber(timeout.docker).transcribe(audioFixture()))
      .rejects.toEqual(new WhisperSidecarError('TIMEOUT'))
    expect(timeout.calls.at(-1)?.[1]).toBe('rm')

    const oom = dockerFake({
      oomKilled: true,
      response: () => ({ exitCode: 137, stdout: '', stderr: '' }),
    })
    await expect(transcriber(oom.docker).transcribe(audioFixture()))
      .rejects.toEqual(new WhisperSidecarError('QUOTA_EXCEEDED'))
    expect(oom.calls.at(-1)?.[1]).toBe('rm')
  })

  it('recovers an ambiguously-created exact-policy container before returning abort', async () => {
    const ambiguous = dockerFake({ createAmbiguous: true })
    await expect(transcriber(ambiguous.docker).transcribe(audioFixture()))
      .rejects.toEqual(new WhisperSidecarError('ABORTED'))
    expect(ambiguous.calls.map(call => call.slice(0, 2))).toEqual([
      ['version', '--format={{.Server.Version}}'],
      ['container', 'create'],
      ['container', 'inspect'],
      ['container', 'rm'],
    ])
  })

  it('accepts only code-only worker failures and never leaks raw diagnostics', async () => {
    const fake = dockerFake({
      response: requestId => ({
        exitCode: 2,
        stdout: JSON.stringify({
          version: 1, requestId, ok: false, error: { code: 'MODEL_UNAVAILABLE' },
        }),
        stderr: 'secret backend details',
      }),
    })
    await expect(transcriber(fake.docker).transcribe(audioFixture()))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: 'MODEL_UNAVAILABLE' })
  })

  it('fails closed on malformed response and cleanup uncertainty', async () => {
    const malformed = dockerFake({ response: () => ok('{"raw":"surprise"}') })
    await expect(transcriber(malformed.docker).transcribe(audioFixture()))
      .rejects.toEqual(new WhisperSidecarError('PROTOCOL_ERROR'))

    const cleanup = dockerFake({ cleanupFails: true })
    await expect(transcriber(cleanup.docker).transcribe(audioFixture()))
      .rejects.toEqual(new WhisperSidecarError('CLEANUP_FAILED'))
  })

  it('rejects invalid request and incompatible Docker before creating a container', async () => {
    const invalid = dockerFake()
    await expect(transcriber(invalid.docker).transcribe({
      ...audioFixture(), relativePath: '../voice.ogg',
    })).rejects.toEqual(new WhisperSidecarError('INVALID_PATH'))
    expect(invalid.calls).toEqual([])

    const old = dockerFake({ version: '23.0.6' })
    await expect(transcriber(old.docker).transcribe(audioFixture()))
      .rejects.toEqual(new WhisperSidecarError('DOCKER_INCOMPATIBLE'))
    expect(old.calls).toHaveLength(1)
  })

  it('is stateless and re-verifies the exact file on every request', async () => {
    const fake = dockerFake()
    const sidecar = transcriber(fake.docker)
    const request = audioFixture()

    const first = await sidecar.transcribe(request)
    const second = await sidecar.transcribe(request)

    expect(second).toEqual(first)
    expect(fake.calls.filter(call => call[0] === 'container' && call[1] === 'create')).toHaveLength(2)
    expect(fake.calls.filter(call => call[0] === 'container' && call[1] === 'rm')).toHaveLength(2)
  })

  it('allows only one resource-heavy container at a time', async () => {
    const request = audioFixture()
    let release!: () => void
    const gate = new Promise<void>(resolvePromise => { release = resolvePromise })
    const base = dockerFake()
    const docker: WhisperDockerCommandPort = {
      async run(args, options) {
        if (args[0] === 'container' && args[1] === 'start') await gate
        return base.docker.run(args, options)
      },
    }
    const sidecar = transcriber(docker)
    const first = sidecar.transcribe(request)
    while (!base.calls.some(call => call[0] === 'container' && call[1] === 'create')) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1))
    }
    await expect(sidecar.transcribe(request))
      .rejects.toEqual(new WhisperSidecarError('QUOTA_EXCEEDED'))
    release()
    await expect(first).resolves.toMatchObject({ provenance: 'untrusted', channel: 'voice' })
  })

  it('exposes a deterministic argv builder with no activation side effect', () => {
    const request = audioFixture()
    const argv = whisperDockerArgv({
      imageDigest: IMAGE,
      requestId: 'voice-1',
      request: {
        hostRoot: request.audioRoot,
        relativePath: request.relativePath,
        expectedSha256: request.expectedSha256,
        expectedSizeBytes: request.expectedSizeBytes,
        maxBytes: request.maxBytes,
        language: 'ru',
      },
      limits: LIMITS,
    })
    expect(argv.create.at(-1)).toBe(IMAGE)
    expect(argv.start.slice(0, 2)).toEqual(['container', 'start'])
  })
})
