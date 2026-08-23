import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GLOBAL_DNA_PREFIX_FILES, makeMemoryStore } from '../memory/index.js'
import { makeGrantStore } from '../safety/index.js'
import { makeAgentRunner } from './agent-runner.js'
import { AGENT_PROTOCOL } from './agent-protocol.js'
import { makeMemoryPort } from './memory-adapter.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('global DNA live runtime integration', () => {
  it('keeps one real filesystem snapshot per session and refreshes a new session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-global-dna-runtime-'))
    roots.push(root)
    const memoryRoot = join(root, 'memory')
    mkdirSync(memoryRoot, { recursive: true })
    for (const name of GLOBAL_DNA_PREFIX_FILES) {
      writeFileSync(join(memoryRoot, name), `[${name}:v1]`, 'utf8')
    }
    const store = makeMemoryStore({
      memoryRoot,
      dbPath: join(root, 'memory.db'),
      nowIso: () => '2026-07-27T12:00:00.000Z',
      emitEvent: async () => {},
    })
    const requests: Array<{ sessionId: string; prefix: string }> = []
    const runner = makeAgentRunner({
      provider: {
        async complete(request) {
          requests.push({
            sessionId: request.sessionId,
            prefix: new TextDecoder().decode(request.prefixBytes),
          })
          return { reply: 'ok' }
        },
      },
      memory: makeMemoryPort(store, () => '2026-07-27T12:00:00.000Z'),
      grants: makeGrantStore(),
      executeTool: () => ({ ok: true }),
      approve: async () => ({ decision: 'rejected' }),
      guardian: { observe: () => ({ trip: false }), note: () => {} },
      sessionLog: { append: () => {}, resume: () => null },
    })
    const turn = (sessionId: string, text: string) => runner.handle({
      sessionId,
      spans: [{ role: 'user' as const, provenance: 'operator' as const, text }],
    })

    await turn('session-a', 'first')
    writeFileSync(join(memoryRoot, 'MISSION.md'), '[MISSION.md:v2]', 'utf8')
    await turn('session-a', 'second')
    await turn('session-b', 'new session')

    const expectedV1 = AGENT_PROTOCOL + GLOBAL_DNA_PREFIX_FILES
      .map(name => `[${name}:v1]`)
      .join('')
    expect(requests).toHaveLength(3)
    expect(requests[0]).toEqual({ sessionId: 'session-a', prefix: expectedV1 })
    expect(requests[1]).toEqual({ sessionId: 'session-a', prefix: expectedV1 })
    expect(requests[2]?.sessionId).toBe('session-b')
    expect(requests[2]?.prefix).toContain('[MISSION.md:v2]')
    expect(requests[2]?.prefix).not.toContain('[MISSION.md:v1]')
  })
})
