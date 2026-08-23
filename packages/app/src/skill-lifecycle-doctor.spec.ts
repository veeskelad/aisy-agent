import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeNodeSkillLifecycleDoctor, makeSkillLifecycleDoctor } from './skill-lifecycle-doctor.js'
import { makeNodeSkillTelemetryStore } from './skill-telemetry-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const absentPromotion = () => ({
  status: 'absent' as const, pending: 0, committing: 0, promoted: 0, quarantined: 0,
})
const absentTelemetry = () => ({ status: 'absent' as const, rows: 0 })

describe('skill lifecycle doctor', () => {
  it('returns frozen stable readiness codes with blocking recovery precedence', () => {
    const recovery = makeSkillLifecycleDoctor({
      inspectPromotion: () => ({ status: 'ready', pending: 1, committing: 1, promoted: 0, quarantined: 0 }),
      inspectTelemetry: absentTelemetry,
      activeCount: () => 1,
    }).inspect()
    expect(recovery).toEqual({
      code: 'SKILLS_RECOVERY_REQUIRED', ready: false, blocking: true,
      counts: { active: 1, pending: 1, committing: 1, promoted: 0, quarantined: 0, telemetryRows: 0 },
    })
    expect(Object.isFrozen(recovery)).toBe(true)
    expect(Object.isFrozen(recovery.counts)).toBe(true)
  })

  it('reports telemetry corruption as non-blocking degraded serving', () => {
    expect(makeSkillLifecycleDoctor({
      inspectPromotion: absentPromotion,
      inspectTelemetry: () => ({ status: 'corrupt', rows: 0 }),
      activeCount: () => 2,
    }).inspect()).toMatchObject({
      code: 'SKILLS_TELEMETRY_DEGRADED', ready: true, blocking: false,
    })
  })

  it('distinguishes an empty healthy lifecycle from a ready one', () => {
    expect(makeSkillLifecycleDoctor({
      inspectPromotion: absentPromotion, inspectTelemetry: absentTelemetry, activeCount: () => 0,
    }).inspect().code).toBe('SKILLS_EMPTY')
    expect(makeSkillLifecycleDoctor({
      inspectPromotion: absentPromotion, inspectTelemetry: absentTelemetry, activeCount: () => 1,
    }).inspect().code).toBe('SKILLS_READY')
  })

  it('is read-only and redacts paths and persisted payload bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-skill-doctor-'))
    roots.push(root)
    const promotionPath = join(root, 'promotion.json')
    const telemetryPath = join(root, 'telemetry.json')
    writeFileSync(promotionPath, '{broken', { mode: 0o600 })
    const telemetry = makeNodeSkillTelemetryStore({ path: telemetryPath })
    telemetry.recordLoad('inspect', '2026-07-28T00:00:00.000Z')
    const beforePromotion = readFileSync(promotionPath)
    const beforeTelemetry = readFileSync(telemetryPath)
    const promotionMtime = statSync(promotionPath).mtimeMs
    const telemetryMtime = statSync(telemetryPath).mtimeMs

    const report = makeNodeSkillLifecycleDoctor({ promotionPath, telemetryPath, activeCount: () => 0 }).inspect()
    expect(report.code).toBe('SKILLS_STAGE_CORRUPT')
    expect(readFileSync(promotionPath)).toEqual(beforePromotion)
    expect(readFileSync(telemetryPath)).toEqual(beforeTelemetry)
    expect(statSync(promotionPath).mtimeMs).toBe(promotionMtime)
    expect(statSync(telemetryPath).mtimeMs).toBe(telemetryMtime)
    expect(JSON.stringify(report)).not.toContain(root)
    expect(JSON.stringify(report)).not.toContain('broken')
  })
})
