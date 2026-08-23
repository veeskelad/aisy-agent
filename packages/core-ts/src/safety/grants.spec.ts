import { describe, expect, it } from 'vitest'
import { GrantStoreError, makeGrantStore } from './grants.js'
import type {
  GrantBinding,
  GrantPersistencePort,
  GrantPersistenceStateV2,
  GrantPersistenceStateV3,
} from './types.js'

const PROJECT_A: GrantBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a1',
  scope: 'project',
}
const PROJECT_A_SESSION_2: GrantBinding = { ...PROJECT_A, sessionId: 'session-a2' }
const PROJECT_B: GrantBinding = { ...PROJECT_A, projectId: 'project-b', sessionId: 'session-b1' }
const WORKSPACE: GrantBinding = { ...PROJECT_A, projectId: 'workspace', scope: 'workspace' }

function fakePersistence(initial?: unknown): {
  port: GrantPersistencePort
  saved: Array<GrantPersistenceStateV2 | GrantPersistenceStateV3>
  current: () => unknown
} {
  let state = initial
  const saved: Array<GrantPersistenceStateV2 | GrantPersistenceStateV3> = []
  return {
    saved,
    current: () => state,
    port: {
      load: () => state,
      save: (next) => {
        state = structuredClone(next)
        saved.push(structuredClone(next))
      },
    },
  }
}

describe('makeGrantStore — context-bound grants v2', () => {
  it('starts empty and refuses to create or use an unscoped grant', () => {
    const grants = makeGrantStore()
    expect(grants.has('bash')).toBe(false)
    expect(() => grants.record('bash', 'always')).toThrowError(
      expect.objectContaining<Partial<GrantStoreError>>({ code: 'INVALID_BINDING' }),
    )
    expect(grants.list()).toEqual([])
  })

  it('keeps session grants in memory and matches only the exact session', () => {
    const persistence = fakePersistence()
    const grants = makeGrantStore({ persistence: persistence.port })
    grants.record('bash', 'session', PROJECT_A)

    expect(grants.has('bash', PROJECT_A)).toBe(true)
    expect(grants.has('bash', PROJECT_A_SESSION_2)).toBe(false)
    expect(grants.has('bash', PROJECT_B)).toBe(false)
    expect(persistence.saved).toEqual([])
    expect(grants.list()).toEqual([{
      tool: 'bash',
      scope: 'session',
      kind: 'legacy-tool',
      binding: { ...PROJECT_A, scope: 'session' },
      status: 'active',
    }])
  })

  it('persists an always grant with a project binding and restores it after restart', () => {
    const persistence = fakePersistence()
    makeGrantStore({
      persistence: persistence.port,
      nowIso: () => '2026-07-27T01:00:00.000Z',
    }).record('write_file', 'always', PROJECT_A)

    expect(persistence.saved).toEqual([{
      schemaVersion: 2,
      grants: [{
        schemaVersion: 2,
        tool: 'write_file',
        scope: 'always',
        binding: {
          operatorId: 'telegram:42',
          profileId: 'default',
          projectId: 'project-a',
          scope: 'project',
        },
        createdAt: '2026-07-27T01:00:00.000Z',
      }],
    }])

    const restarted = makeGrantStore({ persistence: persistence.port })
    expect(restarted.has('write_file', PROJECT_A_SESSION_2)).toBe(true)
    expect(restarted.has('write_file', PROJECT_B)).toBe(false)
    expect(restarted.has('write_file', WORKSPACE)).toBe(false)
  })

  it('does not widen an always grant registered by session-bound work', () => {
    const sessionBound: GrantBinding = { ...PROJECT_A, scope: 'session' }
    const persistence = fakePersistence()
    const grants = makeGrantStore({ persistence: persistence.port })
    grants.record('bash', 'always', sessionBound)

    expect(grants.has('bash', sessionBound)).toBe(true)
    expect(grants.has('bash', PROJECT_A_SESSION_2)).toBe(false)
    const saved = persistence.saved[0]
    expect(saved?.schemaVersion).toBe(2)
    if (saved?.schemaVersion !== 2) throw new Error('expected v2 state')
    expect(saved.grants[0]?.binding.scope).toBe('session')
  })

  it('keeps Workspace and Project grants separate', () => {
    const grants = makeGrantStore()
    grants.record('bash', 'always', WORKSPACE)
    expect(grants.has('bash', WORKSPACE)).toBe(true)
    expect(grants.has('bash', PROJECT_A)).toBe(false)
  })

  it('disables a grant when its bound context is archived before lookup', () => {
    const archived = new Set<string>()
    const grants = makeGrantStore({
      isBindingUsable: (binding) => !archived.has(binding.projectId),
    })
    grants.record('bash', 'session', PROJECT_A)
    archived.add(PROJECT_A.projectId)

    expect(grants.has('bash', PROJECT_A)).toBe(false)
    expect(grants.list()).toEqual([expect.objectContaining({
      tool: 'bash',
      status: 'disabled',
      disabledReason: 'context-unavailable',
    })])
  })

  it('quarantines legacy unscoped tools instead of treating them as global', () => {
    const persistence = fakePersistence({ always: ['bash', 'git', 'bash'] })
    const grants = makeGrantStore({ persistence: persistence.port })

    expect(grants.has('bash', PROJECT_A)).toBe(false)
    expect(grants.has('bash', WORKSPACE)).toBe(false)
    expect(grants.list()).toEqual([
      { tool: 'bash', scope: 'always', status: 'disabled', disabledReason: 'legacy-unscoped' },
      { tool: 'git', scope: 'always', status: 'disabled', disabledReason: 'legacy-unscoped' },
    ])

    grants.record('read_file', 'always', PROJECT_A)
    expect(persistence.saved[0]).toMatchObject({
      schemaVersion: 2,
      quarantinedLegacyTools: ['bash', 'git'],
    })
  })

  it('quarantines invalid v2 records while retaining valid bound records', () => {
    const persistence = fakePersistence({
      schemaVersion: 2,
      grants: [
        {
          schemaVersion: 2,
          tool: 'bash',
          scope: 'always',
          binding: { operatorId: 'x' },
          createdAt: '2026-07-27T01:00:00.000Z',
        },
        {
          schemaVersion: 2,
          tool: 'read_file',
          scope: 'always',
          binding: { ...PROJECT_A, sessionId: undefined },
          createdAt: '2026-07-27T01:00:00.000Z',
        },
      ],
    })
    const grants = makeGrantStore({ persistence: persistence.port })
    expect(grants.has('bash', PROJECT_A)).toBe(false)
    expect(grants.has('read_file', PROJECT_A_SESSION_2)).toBe(true)

    grants.record('git', 'always', PROJECT_A)
    expect(persistence.saved[0]?.invalidRecordCount).toBe(1)
  })

  it('revokes only matching-context grants when a binding is supplied', () => {
    const persistence = fakePersistence()
    const grants = makeGrantStore({ persistence: persistence.port })
    grants.record('bash', 'always', PROJECT_A)
    grants.record('bash', 'always', PROJECT_B)
    grants.revoke('bash', PROJECT_A)

    expect(grants.has('bash', PROJECT_A)).toBe(false)
    expect(grants.has('bash', PROJECT_B)).toBe(true)
    const saved = persistence.saved.at(-1)
    expect(saved?.schemaVersion).toBe(2)
    if (saved?.schemaVersion !== 2) throw new Error('expected v2 state')
    expect(saved.grants).toHaveLength(1)
  })

  it('revokeAll clears all active grants but preserves legacy quarantine', () => {
    const persistence = fakePersistence({ always: ['bash'] })
    const grants = makeGrantStore({ persistence: persistence.port })
    grants.record('git', 'always', PROJECT_A)
    grants.record('write_file', 'session', PROJECT_A)
    grants.revokeAll()

    expect(grants.has('git', PROJECT_A)).toBe(false)
    expect(grants.list()).toEqual([
      { tool: 'bash', scope: 'always', status: 'disabled', disabledReason: 'legacy-unscoped' },
    ])
    expect(persistence.saved.at(-1)).toMatchObject({ grants: [], quarantinedLegacyTools: ['bash'] })
  })

  it('persists a narrow file matcher without storing the path or content', () => {
    const persistence = fakePersistence()
    const original = makeGrantStore({
      persistence: persistence.port,
      nowIso: () => '2026-08-09T03:00:00.000Z',
    })
    original.recordSimilar({
      tool: 'write_file', args: { path: 'src/private-name.ts', content: 'secret payload' },
    }, 2, 'always', PROJECT_A)

    const saved = JSON.stringify(persistence.current())
    expect(saved).not.toContain('src/private-name.ts')
    expect(saved).not.toContain('secret payload')
    expect(persistence.current()).toMatchObject({ schemaVersion: 3 })

    const restarted = makeGrantStore({ persistence: persistence.port })
    expect(restarted.hasSimilar({
      tool: 'write_file', args: { path: 'src/private-name.ts', content: 'different bytes' },
    }, 2, PROJECT_A_SESSION_2)).toBe(true)
    expect(restarted.hasSimilar({
      tool: 'write_file', args: { path: 'src/other.ts', content: 'different bytes' },
    }, 2, PROJECT_A_SESSION_2)).toBe(false)
    expect(restarted.hasSimilar({
      tool: 'write_file', args: { path: 'src/private-name.ts', content: 'different bytes' },
    }, 2, PROJECT_B)).toBe(false)
  })

  it('matches only the same simple Bash operation and operands', () => {
    const grants = makeGrantStore()
    grants.recordSimilar({ tool: 'bash', args: { cmd: 'pnpm test --filter app' } }, 2, 'session', PROJECT_A)

    expect(grants.hasSimilar({ tool: 'bash', args: { cmd: 'pnpm   test --filter app' } }, 2, PROJECT_A)).toBe(true)
    expect(grants.hasSimilar({ tool: 'bash', args: { cmd: 'pnpm test --filter core' } }, 2, PROJECT_A)).toBe(false)
    expect(grants.hasSimilar({ tool: 'bash', args: { cmd: 'pnpm build --filter app' } }, 2, PROJECT_A)).toBe(false)
  })

  it('grants a page fetch per domain, not per link, and never across domains', () => {
    const persistence = fakePersistence()
    const grants = makeGrantStore({ persistence: persistence.port })
    grants.recordSimilar({
      tool: 'fetch_url', args: { url: 'https://Example.com/blog/post?token=abc' },
    }, 2, 'always', PROJECT_A)

    // The path may carry a token; only the host is remembered.
    expect(JSON.stringify(persistence.current())).not.toContain('token=abc')
    expect(grants.hasSimilar({
      tool: 'fetch_url', args: { url: 'https://example.com/another/page' },
    }, 2, PROJECT_A)).toBe(true)
    expect(grants.hasSimilar({
      tool: 'fetch_url', args: { url: 'https://cdn.example.com/page' },
    }, 2, PROJECT_A)).toBe(false)
    expect(grants.hasSimilar({
      tool: 'fetch_url', args: { url: 'https://example.com/page' },
    }, 2, PROJECT_B)).toBe(false)
  })

  it('offers no page-fetch matcher for anything that is not an https url', () => {
    const grants = makeGrantStore()
    for (const url of ['http://example.com', 'file:///etc/passwd', 'not a url', '']) {
      expect(grants.canRememberSimilar({ tool: 'fetch_url', args: { url } }, 2)).toBe(false)
    }
    expect(grants.canRememberSimilar({ tool: 'fetch_url', args: { url: 'https://example.com' } }, 2))
      .toBe(true)
  })

  it('supports bounded nested MCP JSON but still requires an exact argument hash', () => {
    const grants = makeGrantStore()
    const approved = {
      tool: 'mcp:write:tracker.update',
      args: { issue: { id: 'A-1', labels: ['bug', 'ready'] }, notify: false },
    }
    grants.recordSimilar(approved, 2, 'session', PROJECT_A)
    expect(grants.hasSimilar({
      tool: approved.tool,
      args: { notify: false, issue: { labels: ['bug', 'ready'], id: 'A-1' } },
    }, 2, PROJECT_A)).toBe(true)
    expect(grants.hasSimilar({
      tool: approved.tool,
      args: { notify: false, issue: { labels: ['bug', 'ready'], id: 'A-2' } },
    }, 2, PROJECT_A)).toBe(false)
  })

  it('never offers a matcher for shell composition, delegation or tier 3', () => {
    const grants = makeGrantStore()
    expect(grants.canRememberSimilar({ tool: 'bash', args: { cmd: 'pnpm test && curl example.com' } }, 2)).toBe(false)
    expect(grants.canRememberSimilar({ tool: 'bash', args: { cmd: 'pnpm test\ncurl example.com' } }, 2)).toBe(false)
    expect(grants.canRememberSimilar({ tool: 'bash', args: { cmd: 'env API_TOKEN=secret curl example.com' } }, 2)).toBe(false)
    expect(grants.canRememberSimilar({ tool: 'spawn_subagent', args: { plan: '{}' } }, 2)).toBe(false)
    expect(grants.canRememberSimilar({ tool: 'write_file', args: { path: 'a', content: 'b' } }, 3)).toBe(false)
  })

  it('rejects Proxy/accessor call shapes and revokes durable similar rules', () => {
    const persistence = fakePersistence()
    const grants = makeGrantStore({ persistence: persistence.port })
    const proxy = new Proxy({ tool: 'write_file', args: { path: 'a', content: 'b' } }, {})
    expect(grants.canRememberSimilar(proxy, 2)).toBe(false)
    const getter = Object.defineProperty({}, 'tool', { enumerable: true, get: () => 'write_file' }) as never
    expect(grants.canRememberSimilar(getter, 2)).toBe(false)

    grants.recordSimilar({ tool: 'write_file', args: { path: 'a', content: 'b' } }, 2, 'always', PROJECT_A)
    grants.revoke('write_file', PROJECT_A)
    expect(grants.hasSimilar({ tool: 'write_file', args: { path: 'a', content: 'c' } }, 2, PROJECT_A)).toBe(false)
  })

  it('disables a durable matcher after the code-owned policy revision changes', () => {
    const persistence = fakePersistence()
    const call = { tool: 'write_file', args: { path: 'a', content: 'b' } }
    makeGrantStore({ persistence: persistence.port, policyRevision: 'policy-a' })
      .recordSimilar(call, 2, 'always', PROJECT_A)

    const restarted = makeGrantStore({ persistence: persistence.port, policyRevision: 'policy-b' })
    expect(restarted.hasSimilar(call, 2, PROJECT_A)).toBe(false)
    expect(restarted.list(PROJECT_A)).toEqual([
      expect.objectContaining({
        kind: 'similar', status: 'disabled', disabledReason: 'policy-revision-mismatch',
      }),
    ])
  })

  it('does not activate a durable matcher when persistence fails', () => {
    const call = { tool: 'write_file', args: { path: 'a', content: 'b' } }
    const grants = makeGrantStore({
      persistence: { load: () => undefined, save: () => { throw new Error('disk full') } },
    })
    expect(() => grants.recordSimilar(call, 2, 'always', PROJECT_A)).toThrow('disk full')
    expect(grants.hasSimilar(call, 2, PROJECT_A)).toBe(false)
  })
})
