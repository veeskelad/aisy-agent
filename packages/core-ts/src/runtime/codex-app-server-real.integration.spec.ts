import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { makeNodeCodexAppServerSessionFactory } from './codex-app-server-node.js'
import { makeCodexSubscriptionAuth, makeNodeCodexAuthProcessPort } from './codex-auth.js'

const enabled = process.env['AISY_CODEX_REAL_SMOKE'] === '1'
const executable = process.env['AISY_CODEX_EXECUTABLE']

describe.skipIf(!enabled)('Codex app-server real process compatibility', () => {
  it('performs the pinned version check and stable stdio handshake without an account', async () => {
    if (!executable) throw new Error('AISY_CODEX_EXECUTABLE_REQUIRED')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-codex-real-smoke-')))
    const codexHome = join(root, 'codex-home')
    mkdirSync(codexHome, { mode: 0o700 })
    const environment = {
      HOME: root,
      CODEX_HOME: codexHome,
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      NO_COLOR: '1',
    }
    const auth = makeCodexSubscriptionAuth(makeNodeCodexAuthProcessPort({
      codexExecutable: executable,
      environment,
      timeoutMs: 10_000,
    }))
    await expect(auth.detect()).resolves.toEqual({
      installed: true,
      version: 'codex-cli 0.144.5',
    })

    const session = await makeNodeCodexAppServerSessionFactory({
      codexExecutable: executable,
      hostCwd: root,
      environment,
      requestTimeoutMs: 10_000,
    }).open()
    try {
      await expect(session.request('initialize', {
        clientInfo: { name: 'aisy-smoke', title: 'Aisy compatibility smoke', version: '0.1.14' },
      })).resolves.toEqual(expect.objectContaining({ userAgent: expect.any(String) }))
      await expect(session.notify('initialized', {})).resolves.toBeUndefined()
    } finally {
      await session.close()
    }
  }, 20_000)
})
