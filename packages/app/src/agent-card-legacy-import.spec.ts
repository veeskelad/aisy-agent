import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ConfinementWorkerRequest } from '@aisy/core'
import {
  AgentCardLegacyImportError,
  makeAgentCardLegacyImportPort,
} from './agent-card-legacy-import.js'

const roots: string[] = []
const CARD = '# researcher\n\nTrusted card.'

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-legacy-card-')))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('AgentCard legacy import port', () => {
  it('sends one exact bounded read request without listing the directory', async () => {
    const requests: ConfinementWorkerRequest[] = []
    const agentsRoot = root()
    const identity = lstatSync(agentsRoot, { bigint: true })
    const port = makeAgentCardLegacyImportPort({
      root: agentsRoot,
      newId: () => 'legacy-1',
      process: { run: async request => {
        requests.push(request)
        return {
          version: 1,
          requestId: 'legacy-1',
          ok: true,
          data: { text: CARD, bytes: Buffer.byteLength(CARD) },
        }
      } },
    })

    await expect(port.readExact('researcher')).resolves.toBe(CARD)
    expect(requests).toEqual([{
      version: 1,
      requestId: 'legacy-1',
      root: agentsRoot,
      op: 'read',
      path: 'researcher.md',
      maxBytes: 65536,
      expectedRootDevice: identity.dev.toString(),
      expectedRootInode: identity.ino.toString(),
    }])
  })

  it('rejects unsafe names before process I/O', async () => {
    let calls = 0
    const port = makeAgentCardLegacyImportPort({
      root: root(),
      newId: () => 'legacy-2',
      process: { run: async () => {
        calls += 1
        throw new Error('must not run')
      } },
    })
    for (const name of ['../escape', 'a/b', 'general', 'UPPER', '']) {
      await expect(port.readExact(name)).rejects.toEqual(new AgentCardLegacyImportError('INVALID_NAME'))
    }
    expect(calls).toBe(0)
  })

  it.each([
    ['mismatched request id', { version: 1, requestId: 'other', ok: true, data: { text: CARD, bytes: 27 } }],
    ['extended envelope', { version: 1, requestId: 'legacy-3', ok: true, data: { text: CARD, bytes: 27 }, extra: true }],
    ['malformed data', { version: 1, requestId: 'legacy-3', ok: true, data: { text: CARD, bytes: -1 } }],
    ['wrong byte count', { version: 1, requestId: 'legacy-3', ok: true, data: { text: CARD, bytes: 1 } }],
  ])('fails closed for %s', async (_label, response) => {
    const port = makeAgentCardLegacyImportPort({
      root: root(),
      newId: () => 'legacy-3',
      process: { run: async () => response },
    })
    await expect(port.readExact('researcher')).rejects.toEqual(
      new AgentCardLegacyImportError('PROTOCOL_ERROR'),
    )
  })

  it('maps worker and process failures to stable redacted errors', async () => {
    const denied = makeAgentCardLegacyImportPort({
      root: root(),
      newId: () => 'legacy-4',
      process: { run: async () => ({
        version: 1,
        requestId: 'legacy-4',
        ok: false,
        error: { code: 'PATH_CHANGED' },
      }) },
    })
    await expect(denied.readExact('researcher')).rejects.toEqual(
      new AgentCardLegacyImportError('PATH_CHANGED'),
    )

    const failed = makeAgentCardLegacyImportPort({
      root: root(),
      newId: () => 'legacy-5',
      process: { run: async () => { throw new Error('private path') } },
    })
    const promise = failed.readExact('researcher')
    await expect(promise).rejects.toEqual(new AgentCardLegacyImportError('PROCESS_FAILED'))
    await expect(promise).rejects.not.toThrow(/private|researcher/)
  })
})
