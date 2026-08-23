import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { makeAutonomyLedger, workflowKey, type DemonstrationInput } from '@aisy/core'

import { makeNodeAutonomyEvidenceStore } from './autonomy-evidence-store.js'

const root = mkdtempSync(join(tmpdir(), 'aisy-autonomy-'))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const KEY = workflowKey([{ tool: 'bash', argClass: 'git-commit', resourceMask: 'repo' }])

function demo(sessionId: string): DemonstrationInput {
  return {
    workflowKey: KEY,
    scope: { projectId: 'p1', tool: 'bash', resourcePattern: 'repo' },
    tier: 2,
    binding: { operatorId: 'op', projectId: 'p1', sessionId },
    evidence: { transcriptRef: 'ref-1' },
    outcome: 'confirmed',
    provenance: 'operator',
  }
}

describe('node evidence store', () => {
  it('переживает рестарт: новый ledger видит записанное старым', () => {
    const path = join(root, 'restart', 'evidence.jsonl')
    const store = makeNodeAutonomyEvidenceStore({ path })
    const first = makeAutonomyLedger({ persistence: store, nowIso: () => '2026-08-12T10:00:00Z' })
    expect(first.observe(demo('s1'))).toBe('recorded')

    // «Рестарт» — новый store и новый ledger над тем же файлом.
    const reopened = makeAutonomyLedger({
      persistence: makeNodeAutonomyEvidenceStore({ path }),
      nowIso: () => '2026-08-12T11:00:00Z',
    })

    expect(reopened.corrupted()).toBe(false)
    expect(reopened.candidates()[0]!.stats.confirmed).toBe(1)
  })

  it('rewrite стирает забытое из файла физически', () => {
    const path = join(root, 'forget', 'evidence.jsonl')
    const store = makeNodeAutonomyEvidenceStore({ path })
    const ledger = makeAutonomyLedger({ persistence: store, nowIso: () => '2026-08-12T10:00:00Z' })
    ledger.observe(demo('s1'))
    ledger.observe({
      ...demo('s2'),
      scope: { projectId: 'p2', tool: 'bash', resourcePattern: 'repo' },
      binding: { operatorId: 'op', projectId: 'p2', sessionId: 's2' },
    })

    ledger.forget({ projectId: 'p1' })

    const bytes = readFileSync(path, 'utf8')
    expect(bytes).not.toContain('"p1"')
    expect(bytes).toContain('"p2"')
  })

  it('битый файл уходит в карантин целиком, а не удаляется', () => {
    const path = join(root, 'corrupt', 'evidence.jsonl')
    const store = makeNodeAutonomyEvidenceStore({ path })
    store.append('{"kind":"demonstration"')

    const ledger = makeAutonomyLedger({ persistence: store, nowIso: () => '2026-08-12T10:00:00Z' })
    expect(ledger.corrupted()).toBe(true)

    const moved = store.quarantine()
    expect(moved).not.toBeNull()
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(moved!, 'utf8')).toContain('"demonstration"')

    // После карантина дорога чиста: свежий ledger работает.
    const fresh = makeAutonomyLedger({
      persistence: makeNodeAutonomyEvidenceStore({ path }),
      nowIso: () => '2026-08-12T10:00:00Z',
    })
    expect(fresh.corrupted()).toBe(false)
    expect(fresh.observe(demo('s1'))).toBe('recorded')
  })

  it('пустой store спокойно отдаёт пустоту, карантинить нечего', () => {
    const store = makeNodeAutonomyEvidenceStore({ path: join(root, 'empty', 'evidence.jsonl') })

    expect(store.load()).toEqual([])
    expect(store.quarantine()).toBeNull()
  })
})
