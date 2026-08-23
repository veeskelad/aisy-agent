import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeGrantStore, RUNTIME_TOOL_CATALOG, type GrantBinding } from '@aisy/core'

import { makeExecutionModeGrantStore, makeExecutionModeStore } from './execution-mode.js'

const roots: string[] = []

function statePath(): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-mode-')))
  roots.push(created)
  return join(created, 'execution-mode.json')
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('execution modes (ADR-0083)', () => {
  it('defaults to auto and adds nothing beyond the catalog', () => {
    const store = makeExecutionModeStore({ path: statePath() })

    expect(store.get()).toBe('auto')
    expect(store.toolTiers()).toEqual({})
    expect(store.ignoreGrants()).toBe(false)
  })

  it('survives a restart — the operator who asked to be asked stays asked', () => {
    const path = statePath()
    makeExecutionModeStore({ path }).set('confirm')

    expect(makeExecutionModeStore({ path }).get()).toBe('confirm')
  })

  it('keeps bypass active across restart until the operator leaves it', () => {
    const path = statePath()
    const first = makeExecutionModeStore({ path })
    first.set('bypass')

    const restarted = makeExecutionModeStore({ path })
    expect(restarted.get()).toBe('bypass')
    expect(restarted.bypassesHostBash()).toBe(true)

    restarted.set('auto')
    expect(makeExecutionModeStore({ path }).get()).toBe('auto')
  })

  it('raises every acting tool to the confirmation tier, and only those', () => {
    const store = makeExecutionModeStore({ path: statePath() })
    store.set('confirm')

    const tiers = store.toolTiers()
    for (const tool of RUNTIME_TOOL_CATALOG) {
      const acting = ['write', 'execute', 'delegate'].includes(tool.effect)
      expect(tiers[tool.name] === 2).toBe(acting)
    }
  })

  it('never lowers a tier below what the catalog already demands', () => {
    const store = makeExecutionModeStore({ path: statePath() })
    store.set('confirm')

    for (const [name, tier] of Object.entries(store.toolTiers())) {
      const definition = RUNTIME_TOOL_CATALOG.find((tool) => tool.name === name)
      expect(tier).toBeGreaterThanOrEqual(definition?.tier ?? 0)
    }
  })

  it('ignores grants in confirm — "we asked an hour ago" is not an answer', () => {
    const store = makeExecutionModeStore({ path: statePath() })
    store.set('confirm')
    expect(store.ignoreGrants()).toBe(true)
    expect(store.ignoreSimilarGrants()).toBe(true)

    store.set('auto')
    // Grants are ignored, not revoked: auto restores them without re-issuing.
    expect(store.ignoreGrants()).toBe(false)
    expect(store.ignoreSimilarGrants()).toBe(false)
  })

  it('persists plan, keeps tiers and ignores legacy tool-wide grants', () => {
    const path = statePath()
    const store = makeExecutionModeStore({ path })
    store.set('plan')

    expect(store.get()).toBe('plan')
    expect(store.toolTiers()).toEqual({})
    expect(store.ignoreGrants()).toBe(true)
    expect(store.ignoreSimilarGrants()).toBe(false)
    // Как режим называется словами — вопрос к UX-слою (MODE_TEXT), а не к
    // хранилищу: два источника одного текста и разошлись в прошлый раз.
    expect(makeExecutionModeStore({ path }).get()).toBe('plan')
  })

  it('uses narrow similar grants in plan but ignores them in confirm', () => {
    const binding: GrantBinding = {
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      sessionId: 'session-a', scope: 'project',
    }
    const call = { tool: 'write_file', args: { path: 'src/a.ts', content: 'next' } }
    const grants = makeGrantStore()
    grants.record('write_file', 'session', binding)
    grants.recordSimilar(call, 2, 'session', binding)
    const mode = makeExecutionModeStore({ path: statePath() })
    const overlay = makeExecutionModeGrantStore(grants, mode)

    mode.set('plan')
    expect(overlay.has('write_file', binding)).toBe(false)
    expect(overlay.hasSimilar({
      tool: 'write_file', args: { path: 'src/a.ts', content: 'other' },
    }, 2, binding)).toBe(true)

    mode.set('confirm')
    expect(overlay.hasSimilar(call, 2, binding)).toBe(false)
    expect(overlay.canRememberSimilar(call, 2)).toBe(false)
  })

  it('does not activate bypass when its durable state cannot be written', () => {
    const path = statePath()
    const store = makeExecutionModeStore({ path })
    mkdirSync(path)

    expect(() => store.set('bypass')).toThrow()
    expect(store.get()).toBe('auto')
    expect(store.bypassesHostBash()).toBe(false)
    expect(makeExecutionModeStore({ path }).get()).toBe('auto')
  })

  it('keeps a durable safe marker across a failed exit so restart cannot resurrect bypass', () => {
    const path = statePath()
    const store = makeExecutionModeStore({ path })
    store.set('bypass')
    unlinkSync(path)
    mkdirSync(path)

    expect(() => store.set('auto')).toThrow()
    expect(store.get()).toBe('auto')
    expect(store.bypassesHostBash()).toBe(false)
    expect(makeExecutionModeStore({ path }).get()).toBe('auto')
  })

  it('keeps failed bypass entry inactive in this process and after restart', () => {
    const path = statePath()
    mkdirSync(path)
    const store = makeExecutionModeStore({ path })

    expect(() => store.set('bypass')).toThrow()
    expect(store.get()).toBe('auto')
    expect(makeExecutionModeStore({ path }).get()).toBe('auto')
  })

  it('never restores bypass from a future schema, symlink, broad file or fallback', () => {
    const future = statePath()
    writeFileSync(future, JSON.stringify({ schemaVersion: 999, mode: 'bypass' }), { mode: 0o600 })
    expect(makeExecutionModeStore({ path: future }).get()).toBe('auto')

    const broad = statePath()
    writeFileSync(broad, JSON.stringify({ schemaVersion: 2, mode: 'bypass' }), { mode: 0o600 })
    chmodSync(broad, 0o644)
    expect(makeExecutionModeStore({ path: broad }).get()).toBe('auto')

    const link = statePath()
    const target = `${link}.target`
    writeFileSync(target, JSON.stringify({ schemaVersion: 2, mode: 'bypass' }), { mode: 0o600 })
    symlinkSync(target, link)
    expect(makeExecutionModeStore({ path: link }).get()).toBe('auto')

    expect(makeExecutionModeStore({ path: statePath(), fallback: 'bypass' }).get()).toBe('auto')
  })

  it('keeps exact legacy non-bypass preferences without allowing legacy bypass', () => {
    const path = statePath()
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, mode: 'confirm' }), { mode: 0o600 })
    expect(makeExecutionModeStore({ path }).get()).toBe('confirm')

    const impossibleLegacy = statePath()
    writeFileSync(
      impossibleLegacy,
      JSON.stringify({ schemaVersion: 1, mode: 'bypass' }),
      { mode: 0o600 },
    )
    expect(makeExecutionModeStore({ path: impossibleLegacy }).get()).toBe('auto')
  })

  it('falls back instead of refusing to start on a corrupted file', () => {
    const path = statePath()
    writeFileSync(path, 'не json')

    expect(makeExecutionModeStore({ path, fallback: 'confirm' }).get()).toBe('confirm')
  })

  it('rejects a stored value that is not a mode', () => {
    const path = statePath()
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, mode: 'yolo' }))

    expect(makeExecutionModeStore({ path }).get()).toBe('auto')
  })
})
