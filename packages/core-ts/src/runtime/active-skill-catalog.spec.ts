import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeActiveSkillCatalog, type ActiveSkillManifestV1, type ActiveSkillQuarantineReason } from './active-skill-catalog.js'

const SKILL = `---
name: deploy-preview
description: Deploy a verified preview
version: 2
provenance: human
triggers:
  - deploy preview
---
## steps
Deploy it.

## verification
Check HTTP 200.`

function manifest(overrides: Partial<ActiveSkillManifestV1['skills'][number]> = {}): ActiveSkillManifestV1 {
  return {
    schemaVersion: 1,
    skills: [{
      name: 'deploy-preview',
      version: 2,
      sha256: createHash('sha256').update(SKILL).digest('hex'),
      trustSource: 'user',
      traceVerified: true,
      status: 'active',
      touchedPaths: ['dist/report.json'],
      ...overrides,
    }],
  }
}

describe('makeActiveSkillCatalog', () => {
  it('serves only hash-pinned, trace-verified active skills with lazy bodies', async () => {
    const catalog = makeActiveSkillCatalog({
      loadManifest: () => manifest(),
      readSkill: () => SKILL,
      quarantine: () => {},
    })
    expect(catalog.menu()).toEqual([{ name: 'deploy-preview', description: 'Deploy a verified preview' }])
    expect(catalog.matchTriggers('please deploy preview')).toEqual(['deploy-preview'])
    expect(await catalog.loadBody('deploy-preview')).toContain('Check HTTP 200')
    expect(catalog.touchedPaths('deploy-preview')).toEqual(['dist/report.json'])
  })

  it.each([
    ['unverified', manifest({ traceVerified: false }), SKILL],
    ['hash-mismatch', manifest({ sha256: '0'.repeat(64) }), SKILL],
    ['identity-mismatch', manifest({ version: 3 }), SKILL],
  ] as const)('quarantines %s records and excludes them from the menu', (reason, state, body) => {
    const quarantined: Array<{ name: string; reason: ActiveSkillQuarantineReason }> = []
    const catalog = makeActiveSkillCatalog({
      loadManifest: () => state,
      readSkill: () => body,
      quarantine: (name, why) => { quarantined.push({ name, reason: why }) },
    })
    expect(catalog.menu()).toEqual([])
    expect(quarantined).toContainEqual({ name: 'deploy-preview', reason })
  })

  it('keeps archived skills recoverable but non-runnable', () => {
    const catalog = makeActiveSkillCatalog({
      loadManifest: () => manifest({ status: 'archived' }),
      readSkill: () => { throw new Error('must not read archived body') },
      quarantine: () => {},
    })
    expect(catalog.names()).toEqual([])
  })

  it.each(['../outside', 'safe/../outside', 'safe\\..\\outside', '/absolute', './relative', 'safe//file'])
  ('rejects unsafe touched path %s', (touchedPath) => {
    const quarantined: Array<{ name: string; reason: ActiveSkillQuarantineReason }> = []
    const catalog = makeActiveSkillCatalog({
      loadManifest: () => manifest({ touchedPaths: [touchedPath] }),
      readSkill: () => SKILL,
      quarantine: (name, reason) => { quarantined.push({ name, reason }) },
    })
    expect(catalog.names()).toEqual([])
    expect(catalog.touchedPaths('deploy-preview')).toEqual([])
    expect(quarantined).toContainEqual({ name: 'deploy-preview', reason: 'invalid-manifest' })
  })

  it.each([
    ['invalid manifest', { schemaVersion: 2, skills: [] }, '__manifest__', 'invalid-manifest'],
    ['anonymous entry', { schemaVersion: 1, skills: [null] }, '__manifest__', 'invalid-manifest'],
    ['duplicate name', { schemaVersion: 1, skills: [manifest().skills[0], manifest().skills[0]] }, 'deploy-preview', 'invalid-manifest'],
  ] as const)('fails closed for %s', (_label, state, expectedName, expectedReason) => {
    const quarantined: Array<{ name: string; reason: ActiveSkillQuarantineReason }> = []
    const catalog = makeActiveSkillCatalog({
      loadManifest: () => state,
      readSkill: () => SKILL,
      quarantine: (name, reason) => { quarantined.push({ name, reason }) },
    })
    expect(catalog.names()).toEqual([])
    expect(quarantined).toContainEqual({ name: expectedName, reason: expectedReason })
  })

  it.each([
    ['oversized body', `${SKILL}\n${'x'.repeat(256 * 1024)}`],
    ['missing verification', SKILL.replace('## verification', '## evidence')],
  ])('rejects an invalid skill: %s', (_label, body) => {
    const quarantined: Array<{ name: string; reason: ActiveSkillQuarantineReason }> = []
    const state = manifest({ sha256: createHash('sha256').update(body).digest('hex') })
    expect(makeActiveSkillCatalog({
      loadManifest: () => state,
      readSkill: () => body,
      quarantine: (name, reason) => { quarantined.push({ name, reason }) },
    }).names()).toEqual([])
    expect(quarantined).toContainEqual({ name: 'deploy-preview', reason: 'invalid-skill' })
  })
})
