import { describe, it, expect } from 'vitest'
import { makeDockerBash, dockerRunArgs, type DockerResult } from './sandbox-bash.js'

const base = { image: 'aisy/sandbox:1', workspaceRoot: '/work/proj' }

describe('dockerRunArgs', () => {
  it('applies the ADR-0012 hardening flags', () => {
    const args = dockerRunArgs(base, 'ls')
    for (const flag of [
      '--rm',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--network=none',
      '--read-only',
      '--pids-limit=256',
    ]) {
      expect(args).toContain(flag)
    }
  })

  it('mounts the workspace read-write at /work and sets the workdir', () => {
    const args = dockerRunArgs(base, 'ls')
    expect(args).toContain('/work/proj:/work')
    const wIdx = args.indexOf('-w')
    expect(args[wIdx + 1]).toBe('/work')
  })

  it('adds the gVisor runtime only when enabled', () => {
    expect(dockerRunArgs({ ...base, gvisor: true }, 'ls')).toContain('--runtime=runsc')
    expect(dockerRunArgs(base, 'ls')).not.toContain('--runtime=runsc')
  })

  it('wraps the command with a timeout when configured', () => {
    const args = dockerRunArgs({ ...base, timeoutSec: 30 }, 'sleep 99')
    expect(args[args.length - 1]).toContain('timeout 30s')
  })

  it('passes the image and a shell command', () => {
    const args = dockerRunArgs(base, 'echo hi')
    expect(args).toContain('aisy/sandbox:1')
    expect(args).toContain('sh')
    expect(args[args.length - 1]).toContain('echo hi')
  })
})

describe('makeDockerBash', () => {
  it('runs the built argv via the injected docker runner and returns its result', async () => {
    const seen: string[][] = []
    const runDocker = async (args: string[]): Promise<DockerResult> => {
      seen.push(args)
      return { stdout: 'ok', stderr: '', exitCode: 0 }
    }
    const bash = makeDockerBash({ ...base, runDocker })
    const r = await bash('echo hi')
    expect(r).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 })
    expect(seen[0]![0]).toBe('run')
    expect(seen[0]!).toContain('aisy/sandbox:1')
  })

  it('propagates a non-zero exit', async () => {
    const bash = makeDockerBash({ ...base, runDocker: async () => ({ stdout: '', stderr: 'nope', exitCode: 2 }) })
    expect(await bash('false')).toEqual({ stdout: '', stderr: 'nope', exitCode: 2 })
  })
})
