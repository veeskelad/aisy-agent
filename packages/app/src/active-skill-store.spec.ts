import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeActiveSkillCatalog } from '@aisy/core'
import { makeNodeActiveSkillPersistence } from './active-skill-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const skill = `---
name: inspect
description: Inspect safely
version: 1
provenance: human
triggers:
  - inspect
---
## steps
Read it.
## verification
Record evidence.`

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-skills-'))
  roots.push(value)
  mkdirSync(join(value, 'skills', 'inspect'), { recursive: true })
  writeFileSync(join(value, 'skills', 'inspect', 'SKILL.md'), skill)
  return value
}

function emptyRoot(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-skills-empty-'))
  roots.push(value)
  return value
}

function activation(operationId = 'activate-one') {
  return {
    operationId,
    name: 'inspect',
    version: 1,
    sha256: createHash('sha256').update(skill).digest('hex'),
    trustSource: 'user' as const,
    touchedPaths: [],
    skillText: skill,
    baseVersion: null,
    baseHash: null,
  }
}

describe('Node active skill persistence', () => {
  it('loads a pinned active skill and persists quarantine across restart', () => {
    const dir = root()
    const manifest = {
      schemaVersion: 1,
      skills: [{
        name: 'inspect', version: 1,
        sha256: createHash('sha256').update(skill).digest('hex'),
        trustSource: 'user', traceVerified: true, status: 'active', touchedPaths: [],
      }],
    }
    writeFileSync(join(dir, 'skills-manifest.json'), JSON.stringify(manifest))
    const port = makeNodeActiveSkillPersistence({ root: dir, nowIso: () => '2026-07-27T00:00:00.000Z' })
    expect(makeActiveSkillCatalog(port).names()).toEqual(['inspect'])

    writeFileSync(join(dir, 'skills', 'inspect', 'SKILL.md'), skill + '\ntampered')
    expect(makeActiveSkillCatalog(port).names()).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'skills-quarantine.json'), 'utf8')).records.inspect.reason)
      .toBe('hash-mismatch')
    expect(statSync(join(dir, 'skills-quarantine.json')).mode & 0o777).toBe(0o600)
    writeFileSync(join(dir, 'skills', 'inspect', 'SKILL.md'), skill)
    expect(makeActiveSkillCatalog(makeNodeActiveSkillPersistence({ root: dir })).names()).toEqual([])
  })

  it('rejects path traversal before reading a skill', () => {
    const port = makeNodeActiveSkillPersistence({ root: root() })
    expect(() => port.readSkill('../outside')).toThrow(/unsafe skill name/)
  })

  it('quarantines a corrupt manifest across restart without exposing partial skills', () => {
    const dir = root()
    writeFileSync(join(dir, 'skills-manifest.json'), '{broken')
    const first = makeActiveSkillCatalog(makeNodeActiveSkillPersistence({
      root: dir,
      nowIso: () => '2026-07-27T00:00:00.000Z',
    }))
    expect(first.names()).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'skills-quarantine.json'), 'utf8')).records.__manifest__)
      .toMatchObject({ reason: 'invalid-manifest' })

    const valid = { schemaVersion: 1, skills: [] }
    writeFileSync(join(dir, 'skills-manifest.json'), JSON.stringify(valid))
    expect(makeActiveSkillCatalog(makeNodeActiveSkillPersistence({ root: dir })).names()).toEqual([])
  })

  it('publishes SKILL.md plus manifest through the activation WAL and can roll back', () => {
    const dir = emptyRoot()
    const port = makeNodeActiveSkillPersistence({ root: dir })
    port.activate(activation())
    expect(makeActiveSkillCatalog(port).names()).toEqual(['inspect'])
    expect(JSON.parse(readFileSync(join(dir, 'skills-activation.json'), 'utf8')).phase).toBe('committed')

    expect(port.rollback('activate-one')).toBe(true)
    expect(makeActiveSkillCatalog(makeNodeActiveSkillPersistence({ root: dir })).names()).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'skills-activation.json'), 'utf8')).phase).toBe('rolled-back')
  })

  it('restores the exact previous manifest and SKILL.md bytes on update rollback', () => {
    const dir = emptyRoot()
    const port = makeNodeActiveSkillPersistence({ root: dir })
    port.activate(activation('activate-v1'))
    const updated = skill.replace('version: 1', 'version: 2') + '\nupdated'
    port.activate({
      ...activation('activate-v2'), version: 2, skillText: updated,
      sha256: createHash('sha256').update(updated).digest('hex'),
      baseVersion: 1,
      baseHash: createHash('sha256').update(skill).digest('hex'),
    })
    expect(readFileSync(join(dir, 'skills', 'inspect', 'SKILL.md'), 'utf8')).toBe(updated)

    expect(port.rollback('activate-v2')).toBe(true)
    expect(readFileSync(join(dir, 'skills', 'inspect', 'SKILL.md'), 'utf8')).toBe(skill)
    expect(JSON.parse(readFileSync(join(dir, 'skills-manifest.json'), 'utf8')).skills[0].version).toBe(1)
    expect(makeActiveSkillCatalog(makeNodeActiveSkillPersistence({ root: dir })).names()).toEqual(['inspect'])
  })

  it('reserves an exact base revision and rejects a stale sibling operation', () => {
    const dir = emptyRoot()
    const port = makeNodeActiveSkillPersistence({ root: dir })
    expect(port.prepare(activation('operation-one'))).toBe('prepared')
    expect(port.prepare(activation('operation-two'))).toBe('revision_conflict')
    expect(() => port.activate(activation('operation-two'))).toThrow('REVISION_CONFLICT')
    expect(port.rollback('operation-one')).toBe(true)
    expect(makeActiveSkillCatalog(makeNodeActiveSkillPersistence({ root: dir })).names()).toEqual([])
  })

  it('does not overwrite a user edit made after compare-and-prepare', () => {
    const dir = emptyRoot()
    const port = makeNodeActiveSkillPersistence({ root: dir })
    expect(port.prepare(activation())).toBe('prepared')
    mkdirSync(join(dir, 'skills', 'inspect'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'inspect', 'SKILL.md'), 'user-owned edit')

    expect(() => port.activate(activation())).toThrow('REVISION_CONFLICT')
    expect(readFileSync(join(dir, 'skills', 'inspect', 'SKILL.md'), 'utf8')).toBe('user-owned edit')
  })

  it('rolls back a crash before manifest publication on restart', () => {
    const dir = emptyRoot()
    const crashing = makeNodeActiveSkillPersistence({
      root: dir,
      onActivationPhase: phase => { if (phase === 'skill-written') throw new Error('simulated crash') },
    })
    expect(() => crashing.activate(activation())).toThrow(/simulated crash/)

    const restarted = makeNodeActiveSkillPersistence({ root: dir })
    expect(makeActiveSkillCatalog(restarted).names()).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'skills-activation.json'), 'utf8')).phase).toBe('rolled-back')
  })

  it('preserves a newer user edit during restart recovery after skill write', () => {
    const dir = emptyRoot()
    const crashing = makeNodeActiveSkillPersistence({
      root: dir,
      onActivationPhase: phase => { if (phase === 'skill-written') throw new Error('simulated crash') },
    })
    expect(() => crashing.activate(activation())).toThrow(/simulated crash/)
    const target = join(dir, 'skills', 'inspect', 'SKILL.md')
    writeFileSync(target, 'newer user edit')

    const restarted = makeNodeActiveSkillPersistence({ root: dir })
    expect(readFileSync(target, 'utf8')).toBe('newer user edit')
    expect(JSON.parse(readFileSync(join(dir, 'skills-activation.json'), 'utf8')).phase).toBe('rolled-back')
    expect(makeActiveSkillCatalog(restarted).names()).toEqual([])
  })

  it('completes a crash after durable manifest publication on restart', () => {
    const dir = emptyRoot()
    const crashing = makeNodeActiveSkillPersistence({
      root: dir,
      onActivationPhase: phase => { if (phase === 'manifest-written') throw new Error('simulated crash') },
    })
    expect(() => crashing.activate(activation())).toThrow(/simulated crash/)

    const restarted = makeNodeActiveSkillPersistence({ root: dir })
    expect(makeActiveSkillCatalog(restarted).names()).toEqual(['inspect'])
    expect(JSON.parse(readFileSync(join(dir, 'skills-activation.json'), 'utf8')).phase).toBe('committed')
  })
})
