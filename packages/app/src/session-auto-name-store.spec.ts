import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  makeMemorySessionAutoNameStore,
  makeNodeSessionAutoNameStore,
  recoverNodeSessionAutoNameStore,
  recoverSessionAutoNameStore,
  SessionAutoNameStoreError,
  type SessionAutoNameProposalV1,
} from './session-auto-name-store.js'

const PROPOSAL: SessionAutoNameProposalV1 = {
  schemaVersion: 1,
  projectId: 'project-a',
  sessionId: 'session-a',
  turnId: 'telegram:42:turn-a',
  expectedGeneration: 2,
  expectedLabelRevision: 1,
  name: 'План запуска',
  state: 'pending-delivery',
  createdAt: '2026-08-29T12:30:00.000Z',
}

describe('SessionAutoNameStore', () => {
  it('keeps at most one pending proposal per session and removes only the exact turn', () => {
    const store = makeMemorySessionAutoNameStore()
    store.put(PROPOSAL)
    store.put({ ...PROPOSAL, turnId: 'telegram:42:turn-b', name: 'Новый план' })

    expect(store.get(PROPOSAL.sessionId, PROPOSAL.turnId)).toBeNull()
    expect(store.get(PROPOSAL.sessionId, 'telegram:42:turn-b')).toMatchObject({ name: 'Новый план' })
    store.remove(PROPOSAL.sessionId, PROPOSAL.turnId)
    expect(store.snapshot().proposals).toHaveLength(1)
    store.removeSession(PROPOSAL.sessionId)
    expect(store.snapshot().proposals).toEqual([])
  })

  it('does not publish memory state when durable persistence fails', () => {
    const store = makeMemorySessionAutoNameStore({
      save: () => { throw new Error('injected persistence failure') },
    })
    expect(() => store.put(PROPOSAL)).toThrow('injected persistence failure')
    expect(store.snapshot().proposals).toEqual([])
  })

  it('writes a private atomic node snapshot and rejects malformed state', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-auto-name-'))
    const path = join(root, 'pending.json')
    const orphan = `${path}.tmp-99-00000000-0000-4000-8000-000000000099`
    writeFileSync(orphan, JSON.stringify({ schemaVersion: 1, proposals: [PROPOSAL] }))
    const store = makeNodeSessionAutoNameStore({ path })
    expect(existsSync(orphan)).toBe(false)
    store.put(PROPOSAL)

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      proposals: [{ sessionId: 'session-a', name: 'План запуска' }],
    })
    writeFileSync(path, '{"schemaVersion":1,"proposals":[{"name":"bad"}]}\n')
    expect(() => makeNodeSessionAutoNameStore({ path }))
      .toThrow(SessionAutoNameStoreError)
  })

  it('disables optional auto-name on corrupt read or recovery write failure', () => {
    expect(recoverSessionAutoNameStore(() => {
      throw new SessionAutoNameStoreError('CORRUPT_SESSION_AUTO_NAME_STORE')
    })).toBeNull()
    expect(recoverSessionAutoNameStore(() => makeMemorySessionAutoNameStore({
      initial: { schemaVersion: 1, proposals: [PROPOSAL] },
      save: () => { throw new Error('disk unavailable') },
    }))).toBeNull()
  })

  it('durably retires a corrupt canonical store before enabling deletion again', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-auto-name-recover-'))
    const path = join(root, 'pending.json')
    writeFileSync(path, '{"schemaVersion":1,"proposals":[{"sessionId":"session-a"}]}\n', {
      mode: 0o600,
    })

    const recovered = recoverNodeSessionAutoNameStore({ path })
    expect(recovered).not.toBeNull()
    expect(recovered!.snapshot()).toEqual({ schemaVersion: 1, proposals: [] })
    recovered!.put(PROPOSAL)
    recovered!.removeSession(PROPOSAL.sessionId)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schemaVersion: 1, proposals: [] })
  })
})
