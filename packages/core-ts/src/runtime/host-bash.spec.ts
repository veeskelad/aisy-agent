import { describe, expect, it } from 'vitest'

import {
  hostBashEnvironment,
  makeHostBash,
  refusedHostCommand,
} from './host-bash.js'

describe('host bash refusals', () => {
  it('refuses commands whose damage an operator cannot take back', () => {
    for (const cmd of [
      'sudo systemctl stop nginx',
      'rm -rf /',
      'rm -fr ~/projects',
      'mkfs.ext4 /dev/sda1',
      'dd if=/dev/zero of=/dev/sda',
      'shutdown -h now',
      'reboot',
      ':(){ :|:& };:',
    ]) {
      expect(refusedHostCommand(cmd), cmd).toBe(true)
    }
  })

  it('allows ordinary work, including a scoped delete', () => {
    for (const cmd of [
      'ls -la',
      'df -h',
      'git status',
      'rm build/tmp.txt',
      'grep -r TODO src',
      'node --version',
    ]) {
      expect(refusedHostCommand(cmd), cmd).toBe(false)
    }
  })
})

describe('host bash environment', () => {
  it('strips every credential-shaped variable but keeps the usual ones', () => {
    const env = hostBashEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/agent',
      LANG: 'ru_RU.UTF-8',
      AISY_TELEGRAM_BOT_TOKEN: 'secret-token',
      AISY_PROVIDER_ANTHROPIC_KEY: 'secret-key',
      DEEPGRAM_API_KEY: 'secret',
      DB_PASSWORD: 'secret',
      GITHUB_CREDENTIAL: 'secret',
      AWS_AUTH: 'secret',
    })

    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/agent', LANG: 'ru_RU.UTF-8' })
  })
})

describe('host bash execution', () => {
  it('runs in the workspace with a bounded environment and reports the exit code', async () => {
    const seen: Array<{ cmd: string; cwd: string; env: NodeJS.ProcessEnv }> = []
    const bash = makeHostBash({
      workspaceRoot: '/srv/agent/workspace',
      env: { PATH: '/usr/bin', AISY_TELEGRAM_BOT_TOKEN: 'secret' },
      run: async (cmd, options) => {
        seen.push({ cmd, cwd: options.cwd, env: options.env })
        return { stdout: 'ok', stderr: '', exitCode: 0 }
      },
    })

    const result = await bash('ls')

    expect(result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 })
    expect(seen[0]?.cwd).toBe('/srv/agent/workspace')
    expect(seen[0]?.env).toEqual({ PATH: '/usr/bin' })
  })

  it('never reaches the shell for a refused command', async () => {
    let called = 0
    const bash = makeHostBash({
      workspaceRoot: '/srv/agent/workspace',
      env: {},
      run: async () => { called += 1; return { stdout: '', stderr: '', exitCode: 0 } },
    })

    const result = await bash('sudo rm -rf /')

    expect(called).toBe(0)
    expect(result.exitCode).toBe(126)
    expect(result.stderr).toContain('отклонена')
  })

  it('runs the same command without the adapter denylist only in explicit bypass', async () => {
    let bypass = false
    const seen: string[] = []
    const bash = makeHostBash({
      workspaceRoot: '/srv/agent/workspace',
      env: { PATH: '/usr/bin', AISY_TELEGRAM_BOT_TOKEN: 'not-forwarded' },
      bypass: () => bypass,
      run: async (cmd, options) => {
        seen.push(cmd)
        expect(options.env).toEqual({ PATH: '/usr/bin' })
        return { stdout: 'ran', stderr: '', exitCode: 0 }
      },
    })
    const destructiveFixture = `${['r', 'm'].join('')} ${['-rf', '/'].join(' ')}`

    expect((await bash(destructiveFixture)).exitCode).toBe(126)
    bypass = true
    expect(await bash(destructiveFixture)).toEqual({ stdout: 'ran', stderr: '', exitCode: 0 })
    expect(seen).toEqual([destructiveFixture])
  })

  it('bounds a flood of output instead of pushing it all into the transcript', async () => {
    const bash = makeHostBash({
      workspaceRoot: '/srv',
      env: {},
      maxOutputBytes: 64,
      run: async () => ({ stdout: 'a'.repeat(5000), stderr: '', exitCode: 0 }),
    })

    const result = await bash('yes')

    expect(result.stdout.length).toBeLessThan(200)
    expect(result.stdout).toContain('обрезан')
  })

  it('rejects an empty command without spawning anything', async () => {
    let called = 0
    const bash = makeHostBash({
      workspaceRoot: '/srv',
      env: {},
      run: async () => { called += 1; return { stdout: '', stderr: '', exitCode: 0 } },
    })

    expect((await bash('   ')).exitCode).toBe(2)
    expect(called).toBe(0)
  })

  it('really executes on this host and confines the working directory', async () => {
    const bash = makeHostBash({ workspaceRoot: process.cwd(), env: process.env })

    const result = await bash('[[ -n "$BASH_VERSION" ]] && pwd && echo привет')

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim().split('\n').at(0)).toBe(process.cwd())
    expect(result.stdout).toContain('привет')
  })
})
