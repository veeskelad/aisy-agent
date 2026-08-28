import {
  makeAgentRunner,
  makeContextLeaseCoordinator,
  makeGrantStore,
  makeSessionTranscript,
  TranscriptLeaseBindingError,
  type FrozenSnapshot,
  type ModelRequest,
  type ModelResponse,
  type ProviderAdapter,
  type TranscriptBinding,
} from '@aisy/core'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeNodeSessionTranscriptPersistence } from './session-transcript-store.js'
import { makeNodeLeaseBoundSessionTranscriptRecorder } from './session-transcript-runtime.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const binding: TranscriptBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
}
const frozen: FrozenSnapshot = {
  prefixBytes: new TextEncoder().encode('base-prefix'),
  prefixHash: 'memory-port-value',
  breakpoints: [4],
  takenAt: '2026-07-27T01:00:00.000Z',
}
const extension = new TextEncoder().encode('skills-menu')

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-transcript-runtime-'))
  roots.push(value)
  return value
}

function transcript(dir: string) {
  return makeSessionTranscript({
    persistence: makeNodeSessionTranscriptPersistence({ root: dir }),
    classifyLoadBearing: () => ({ loadBearing: false, classifierVersion: 'rules-v1' }),
  })
}

function scriptedProvider(responses: ModelResponse[]) {
  const queue = [...responses]
  const requests: ModelRequest[] = []
  const provider: ProviderAdapter = {
    async complete(request) {
      requests.push({
        ...request,
        prefixBytes: request.prefixBytes.slice(),
        spans: structuredClone(request.spans),
      })
      const response = queue.shift()
      if (!response) throw new Error('missing scripted response')
      return response
    },
  }
  return { provider, requests }
}

function runner(
  dir: string,
  responses: ModelResponse[],
  candidateFrozen: FrozenSnapshot = frozen,
  candidateExtension: Uint8Array = extension,
  augmentationProvenance: 'operator' | 'learned-procedure' = 'operator',
) {
  const provider = scriptedProvider(responses)
  let leaseId = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-operation-${++leaseId}` })
  const lease = leases.acquire({
    ...binding,
    projectKind: 'project',
    root: '/Users/operator/projects/project-a',
    generation: 7,
  })
  const transcriptRecorder = makeNodeLeaseBoundSessionTranscriptRecorder({
    root: dir,
    binding,
    lease,
    leases,
    budget: { windowTokens: 100_000, compactAtFraction: 0.8 },
    classifyLoadBearing: () => ({ loadBearing: false, classifierVersion: 'rules-v1' }),
    summarize: async () => { throw new Error('compaction is not expected in this fixture') },
    estimateTokens: text => text.length,
  })
  return {
    lease,
    leases,
    provider,
    runner: makeAgentRunner({
      provider: provider.provider,
      memory: {
        snapshot: async () => ({
          ...candidateFrozen,
          prefixBytes: candidateFrozen.prefixBytes.slice(),
          breakpoints: [...candidateFrozen.breakpoints],
        }),
        forget: async () => {},
      },
      grants: makeGrantStore(),
      executeTool: () => ({ ok: true, output: 'contents' }),
      approve: async () => ({ decision: 'rejected' }),
      guardian: { observe: () => ({ trip: false }), note: () => {} },
      sessionLog: { append: () => {}, resume: () => null },
      transcriptRecorder,
      // Production runners always install the deterministic PostToolUse
      // boundary. This composition fixture must do the same: omitting it is a
      // deliberate fail-closed mode that withholds the raw tool result.
      postToolUse: { secretValues: () => [] },
      prefixExtension: () => candidateExtension.slice(),
      augmentTurn: async () => [{
        role: 'system',
        provenance: augmentationProvenance,
        text: 'triggered-skill',
      }],
      clock: { now: () => '2026-07-27T01:00:00.000Z' },
    }),
  }
}

describe('AgentRunner session transcript runtime', () => {
  it('rejects mismatched composition without touching transcript storage', () => {
    const dir = join(root(), 'must-not-exist')
    let leaseId = 0
    const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++leaseId}` })
    const lease = leases.acquire({
      ...binding,
      projectKind: 'project',
      root: '/Users/operator/projects/project-a',
      generation: 7,
    })

    expect(() => makeNodeLeaseBoundSessionTranscriptRecorder({
      root: dir,
      binding: { ...binding, projectId: 'project-b' },
      lease,
      leases,
      budget: { windowTokens: 100_000, compactAtFraction: 0.8 },
      classifyLoadBearing: () => ({ loadBearing: false, classifierVersion: 'rules-v1' }),
      summarize: async () => '',
      estimateTokens: text => text.length,
    })).toThrow(TranscriptLeaseBindingError)
    expect(existsSync(dir)).toBe(false)
  })

  it('captures binding before lazy storage creation', async () => {
    const dir = join(root(), 'lazy-binding')
    let leaseId = 0
    const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++leaseId}` })
    const lease = leases.acquire({
      ...binding,
      projectKind: 'project',
      root: '/Users/operator/projects/project-a',
      generation: 7,
    })
    const mutableBinding = { ...binding }
    const recorder = makeNodeLeaseBoundSessionTranscriptRecorder({
      root: dir,
      binding: mutableBinding,
      lease,
      leases,
      budget: { windowTokens: 100_000, compactAtFraction: 0.8 },
      classifyLoadBearing: () => ({ loadBearing: false, classifierVersion: 'rules-v1' }),
      summarize: async () => '',
      estimateTokens: text => text.length,
    })
    expect(existsSync(dir)).toBe(false)
    mutableBinding.projectId = 'project-b'

    await recorder.start({ sessionId: binding.sessionId, frozen })

    await expect(transcript(dir).manifest(binding)).resolves.toMatchObject(binding)
  })

  it('binds the manifest to the actual model prefix and continues the chain after restart', async () => {
    const dir = root()
    const first = runner(dir, [
      { reply: 'reading', toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
      { reply: 'done-1' },
    ])
    await first.runner.handle({
      sessionId: binding.sessionId,
      turnId: 'telegram-update-1',
      turnTs: '2026-07-27T01:02:03.000Z',
      spans: [{ role: 'user', provenance: 'operator', text: 'hello' }],
    })

    const second = runner(
      dir,
      [{ reply: 'done-2' }],
      {
        ...frozen,
        prefixBytes: new TextEncoder().encode('changed-memory-after-restart'),
        takenAt: '2026-07-27T01:03:00.000Z',
      },
      new TextEncoder().encode('changed-skills-menu'),
    )
    await second.runner.handle({
      sessionId: binding.sessionId,
      turnId: 'telegram-update-2',
      turnTs: '2026-07-27T01:03:03.000Z',
      spans: [{ role: 'user', provenance: 'operator', text: 'again' }],
    })

    const reopened = transcript(dir)
    const manifest = await reopened.manifest(binding)
    const rows = await reopened.read(binding)
    const expectedPrefix = Buffer.concat([Buffer.from(frozen.prefixBytes), Buffer.from(extension)])

    expect(Buffer.from(manifest.frozenPrefix!.bytesBase64, 'base64')).toEqual(expectedPrefix)
    expect(manifest.frozenPrefix!.prefixHash)
      .toBe(createHash('sha256').update(expectedPrefix).digest('hex'))
    expect(first.provider.requests.every(request => Buffer.from(request.prefixBytes).equals(expectedPrefix)))
      .toBe(true)
    expect(second.provider.requests.every(request => Buffer.from(request.prefixBytes).equals(expectedPrefix)))
      .toBe(true)
    expect(second.provider.requests[0]!.spans.slice(0, 5)).toEqual([
      { role: 'user', provenance: 'operator', text: 'hello' },
      { role: 'system', provenance: 'operator', text: 'triggered-skill' },
      { role: 'assistant', provenance: 'untrusted', text: 'reading' },
      { role: 'tool', provenance: 'untrusted', text: 'read_file: contents' },
      { role: 'assistant', provenance: 'untrusted', text: 'done-1' },
    ])
    expect(rows.map(row => [row.sessionSeq, row.role, row.provenance, row.content])).toEqual([
      [1, 'user', 'operator', 'hello'],
      [2, 'system', 'operator', 'triggered-skill'],
      [3, 'assistant', 'untrusted', 'reading'],
      [4, 'tool', 'untrusted', 'read_file: contents'],
      [5, 'assistant', 'untrusted', 'done-1'],
      [6, 'user', 'operator', 'again'],
      [7, 'system', 'operator', 'triggered-skill'],
      [8, 'assistant', 'untrusted', 'done-2'],
    ])
    expect(manifest.nextSessionSeq).toBe(9)
    expect(manifest.hashHead).toBe(rows.at(-1)!.rowHash)
  })

  it('AC-01-66 runs a Telegram turn with a non-transcript learned-procedure overlay', async () => {
    const dir = root()
    const active = runner(
      dir,
      [{ reply: 'done' }],
      frozen,
      extension,
      'learned-procedure',
    )

    await expect(active.runner.handle({
      sessionId: binding.sessionId,
      turnId: 'telegram-update-learned',
      turnTs: '2026-07-27T01:02:03.000Z',
      spans: [{ role: 'user', provenance: 'operator', text: 'hey' }],
    })).resolves.toMatchObject({ state: 'ok', reply: 'done' })

    expect(active.provider.requests[0]!.spans).toContainEqual({
      role: 'system',
      provenance: 'learned-procedure',
      text: 'triggered-skill',
    })
    await expect(transcript(dir).read(binding)).resolves.toMatchObject([
      { role: 'user', provenance: 'operator', content: 'hey' },
      { role: 'assistant', provenance: 'untrusted', content: 'done' },
    ])
  })
})
