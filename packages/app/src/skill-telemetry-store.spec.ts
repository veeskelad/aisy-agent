import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inspectNodeSkillTelemetryStore,
  makeJsonSkillTelemetryStore,
  makeNodeSkillTelemetryStore,
  type JsonSkillTelemetryStoreDeps,
} from './skill-telemetry-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function memory(initial?: string): { deps: JsonSkillTelemetryStoreDeps; read: () => string | undefined } {
  let content = initial
  return {
    deps: { exists: () => content !== undefined, read: () => content ?? '', saveAtomic: value => { content = value } },
    read: () => content,
  }
}

describe('skill telemetry sidecar', () => {
  it('persists hit/outcome metrics across restart with a derived failure rate', () => {
    const fs = memory()
    const first = makeJsonSkillTelemetryStore(fs.deps)
    first.recordLoad('inspect', '2026-07-28T00:00:00.000Z')
    first.recordOutcome('inspect', 'failed', '2026-07-28T00:01:00.000Z')
    first.recordOutcome('inspect', 'passed', '2026-07-28T00:02:00.000Z')

    expect(makeJsonSkillTelemetryStore(memory(fs.read()).deps).snapshot()).toEqual([{
      name: 'inspect', hitCount: 1, lastUsedAt: '2026-07-28T00:02:00.000Z',
      runCount: 2, failureCount: 1, failureRate: 0.5, lastOutcome: 'passed',
    }])
  })

  it('serializes repeated updates without lost counters', () => {
    const fs = memory()
    const store = makeJsonSkillTelemetryStore(fs.deps)
    for (let index = 0; index < 100; index++) {
      store.recordLoad('inspect', `2026-07-28T00:${String(index % 60).padStart(2, '0')}:00.000Z`)
    }
    expect(makeJsonSkillTelemetryStore(memory(fs.read()).deps).snapshot()[0]?.hitCount).toBe(100)
  })

  it('updates only the private sidecar and leaves SKILL.md bytes exactly unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-skill-telemetry-'))
    roots.push(root)
    const skillPath = join(root, 'skills', 'inspect', 'SKILL.md')
    mkdirSync(join(root, 'skills', 'inspect'), { recursive: true })
    const skillBytes = Buffer.from('exact\r\nSKILL.md\nbytes', 'utf8')
    writeFileSync(skillPath, skillBytes)
    const before = createHash('sha256').update(readFileSync(skillPath)).digest('hex')
    const telemetryPath = join(root, 'private', 'skill-telemetry.json')
    const store = makeNodeSkillTelemetryStore({ path: telemetryPath })
    store.recordLoad('inspect', '2026-07-28T00:00:00.000Z')
    const after = createHash('sha256').update(readFileSync(skillPath)).digest('hex')

    expect(after).toBe(before)
    expect(statSync(telemetryPath).mode & 0o777).toBe(0o600)
    expect(inspectNodeSkillTelemetryStore(telemetryPath)).toEqual({ status: 'ready', rows: 1 })
  })

  it('quarantines corrupt sidecar state and remains a fail-open no-op after restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-skill-telemetry-corrupt-'))
    roots.push(root)
    const path = join(root, 'private', 'skill-telemetry.json')
    mkdirSync(join(root, 'private'), { recursive: true, mode: 0o700 })
    writeFileSync(path, '{broken', { mode: 0o600 })
    const store = makeNodeSkillTelemetryStore({ path })

    expect(store.health()).toBe('quarantined')
    expect(() => store.recordLoad('inspect', '2026-07-28T00:00:00.000Z')).not.toThrow()
    expect(store.snapshot()).toEqual([])
    expect(inspectNodeSkillTelemetryStore(path)).toEqual({ status: 'corrupt', rows: 0 })
    expect(JSON.parse(readFileSync(path + '.quarantine', 'utf8'))).toEqual({ schemaVersion: 1, reason: 'corrupt' })
  })
})
