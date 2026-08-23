import {
  makeContextLeaseCoordinator,
  makeSessionTranscript,
  type FrozenSnapshot,
  type TranscriptBinding,
} from '@aisy/core'
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeNodeSessionTranscriptPersistence } from './session-transcript-store.js'
import {
  makeNodeLeaseBoundTranscriptDayLogSource,
  TranscriptDayLogSourceError,
} from './transcript-day-log-runtime.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const bindingA: TranscriptBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
}
const bindingB: TranscriptBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-b',
  sessionId: 'session-b',
}
const frozen: FrozenSnapshot = {
  prefixBytes: new TextEncoder().encode('prefix'),
  prefixHash: 'caller-value',
  breakpoints: [],
  takenAt: '2026-07-28T00:00:00.000Z',
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-transcript-day-log-'))
  roots.push(value)
  return value
}

function coordinator(binding: TranscriptBinding) {
  let id = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-${binding.projectId}-${++id}` })
  const lease = leases.acquire({
    ...binding,
    projectKind: 'project',
    root: `/Users/operator/projects/${binding.projectId}`,
    generation: 1,
  })
  return { leases, lease }
}

async function seed(dir: string, binding: TranscriptBinding, content: string): Promise<void> {
  const transcript = makeSessionTranscript({
    persistence: makeNodeSessionTranscriptPersistence({ root: dir }),
    classifyLoadBearing: () => ({ loadBearing: false, classifierVersion: 'rules-v1' }),
  })
  await transcript.createExactSession(binding, frozen, '2026-07-28T00:00:00.000Z')
  await transcript.append({
    ...binding,
    eventId: `event-${binding.sessionId}`,
    role: 'user',
    provenance: 'operator',
    content,
    ts: '2026-07-28T12:00:00.000Z',
  })
}

describe('lease-bound transcript day-log source', () => {
  it('keeps exact Project/Session isolation and survives a fresh runtime', async () => {
    const dir = root()
    await seed(dir, bindingA, 'project-a-only')
    await seed(dir, bindingB, 'project-b-only')

    const firstAuthority = coordinator(bindingA)
    const first = makeNodeLeaseBoundTranscriptDayLogSource({
      root: dir,
      binding: bindingA,
      ...firstAuthority,
    })
    expect(await first.load('2026-07-28')).toMatchObject({
      records: [{ payload: { content: 'project-a-only' } }],
    })

    const restartedAuthority = coordinator(bindingA)
    const restarted = makeNodeLeaseBoundTranscriptDayLogSource({
      root: dir,
      binding: bindingA,
      ...restartedAuthority,
    })
    const log = await restarted.load('2026-07-28')
    expect(JSON.stringify(log)).not.toContain('project-b-only')
    expect(log.records).toHaveLength(1)
  })

  it('captures root and binding before lazy filesystem I/O', async () => {
    const originalRoot = root()
    const redirectedRoot = join(root(), 'must-not-exist')
    await seed(originalRoot, bindingA, 'frozen-authority')
    const authority = coordinator(bindingA)
    const config = {
      root: originalRoot,
      binding: { ...bindingA },
      ...authority,
    }
    const source = makeNodeLeaseBoundTranscriptDayLogSource(config)
    config.root = redirectedRoot
    config.binding.projectId = 'project-b'

    expect(await source.load('2026-07-28')).toMatchObject({
      records: [{ payload: { content: 'frozen-authority' } }],
    })
    expect(existsSync(redirectedRoot)).toBe(false)
  })

  it('rejects mismatched and stale leases before transcript I/O', async () => {
    const mismatchDir = join(root(), 'mismatch-must-not-exist')
    const mismatchAuthority = coordinator(bindingA)
    expect(() => makeNodeLeaseBoundTranscriptDayLogSource({
      root: mismatchDir,
      binding: bindingB,
      ...mismatchAuthority,
    })).toThrow(TranscriptDayLogSourceError)
    expect(existsSync(mismatchDir)).toBe(false)

    const staleDir = join(root(), 'stale-must-not-exist')
    const staleAuthority = coordinator(bindingA)
    const source = makeNodeLeaseBoundTranscriptDayLogSource({
      root: staleDir,
      binding: bindingA,
      ...staleAuthority,
    })
    await staleAuthority.leases.quiesceAndClose(staleAuthority.lease)
    await expect(source.load('2026-07-28')).rejects.toMatchObject({
      code: 'TRANSCRIPT_DAY_LOG_UNAVAILABLE',
      message: 'TRANSCRIPT_DAY_LOG_UNAVAILABLE',
    })
    expect(existsSync(staleDir)).toBe(false)
  })

  it('redacts transcript corruption behind a stable code-only error', async () => {
    const dir = root()
    await seed(dir, bindingA, 'safe')
    appendFileSync(join(dir, 'transcript-v2.jsonl'), '{private-corruption-detail}\n')
    const authority = coordinator(bindingA)
    const source = makeNodeLeaseBoundTranscriptDayLogSource({ root: dir, binding: bindingA, ...authority })

    await expect(source.load('2026-07-28')).rejects.toMatchObject({
      code: 'TRANSCRIPT_DAY_LOG_UNAVAILABLE',
      message: 'TRANSCRIPT_DAY_LOG_UNAVAILABLE',
    })
  })
})
