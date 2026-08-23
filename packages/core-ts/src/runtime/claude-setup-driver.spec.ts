import { describe, expect, it } from 'vitest'

import { makeClaudeSubscriptionAuthSpike } from './claude-auth.js'
import { makeClaudeSubscriptionSetupDriver } from './claude-setup-driver.js'

function driverWith(runs: Array<{ argv: string[]; exitCode: number; output: string }>) {
  const seen: string[][] = []
  const processPort = {
    async run(command: string, args: string[]) {
      seen.push([command, ...args])
      const match = runs.find((entry) => entry.argv.join(' ') === [command, ...args].join(' '))
      if (!match) throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
      return { exitCode: match.exitCode, output: match.output }
    },
  }
  const driver = makeClaudeSubscriptionSetupDriver({
    auth: makeClaudeSubscriptionAuthSpike(processPort),
    processPort,
    install: async () => ({ installed: false, safeDetail: 'установка вручную' }),
  })
  return { driver, seen }
}

describe('claude subscription setup driver', () => {
  it('describes a subscription connection served by the Claude Code runtime', () => {
    const { driver } = driverWith([])

    expect(driver.connectionId).toBe('claude-subscription')
    expect(driver.provider).toBe('anthropic')
    expect(driver.authMode).toBe('subscription')
    expect(driver.runtime).toBe('claude-code')
  })

  it('detects the installed CLI and points the operator at the official flow', async () => {
    const { driver } = driverWith([
      { argv: ['claude', '--version'], exitCode: 0, output: '2.1.220 (Claude Code)' },
    ])

    expect(await driver.detect()).toMatchObject({ installed: true })
    const challenge = await driver.beginAuth()
    // Aisy never asks for the password itself; the CLI owns the credential.
    expect(challenge.kind).toBe('browser')
    if (challenge.kind === 'browser') {
      expect(challenge.safeInstructions.length).toBeGreaterThan(0)
    }
  })

  it('revokes the connection through the official logout', async () => {
    const { driver, seen } = driverWith([
      { argv: ['claude', 'auth', 'logout'], exitCode: 0, output: '' },
    ])

    expect(await driver.revoke()).toMatchObject({ ok: true })
    expect(seen).toEqual([['claude', 'auth', 'logout']])
  })

  it('reports a failed logout instead of claiming the connection is closed', async () => {
    const { driver } = driverWith([
      { argv: ['claude', 'auth', 'logout'], exitCode: 1, output: 'not signed in' },
    ])

    expect(await driver.revoke()).toMatchObject({
      ok: false,
      errorCode: 'CLAUDE_LOGOUT_REJECTED',
    })
  })

  it('reports a crashed logout as a failure, not a success', async () => {
    const driver = makeClaudeSubscriptionSetupDriver({
      auth: makeClaudeSubscriptionAuthSpike({ async run() { throw new Error('no binary') } }),
      processPort: { async run() { throw new Error('no binary') } },
      install: async () => ({ installed: false, safeDetail: 'установка вручную' }),
    })

    expect(await driver.revoke()).toMatchObject({
      ok: false,
      errorCode: 'CLAUDE_LOGOUT_FAILED',
    })
  })
})
