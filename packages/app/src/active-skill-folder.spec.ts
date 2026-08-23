// The folder half of the skill store: what the operator does from the phone —
// list, switch off, install a sent SKILL.md, delete. The activation WAL is
// covered by active-skill-store.spec.ts; here the subject is the visible state.

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeActiveSkillCatalog } from '@aisy/core'
import { makeNodeActiveSkillPersistence } from './active-skill-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function document(input: { name?: string; version?: number; body?: string } = {}): string {
  return [
    '---',
    `name: ${input.name ?? 'inspect'}`,
    'description: Inspect safely',
    `version: ${input.version ?? 1}`,
    'provenance: human',
    'triggers:',
    '  - inspect',
    '---',
    '## steps',
    input.body ?? 'Read it.',
    '## verification',
    'Record evidence.',
  ].join('\n')
}

function store() {
  const root = mkdtempSync(join(tmpdir(), 'aisy-skill-folder-'))
  roots.push(root)
  const port = makeNodeActiveSkillPersistence({ root, nowIso: () => '2026-08-07T00:00:00.000Z' })
  return {
    root,
    port,
    /** What the agent would actually be served after the operator's action. */
    served: (): string[] => makeActiveSkillCatalog(
      makeNodeActiveSkillPersistence({ root, nowIso: () => '2026-08-07T00:00:00.000Z' }),
    ).names(),
  }
}

describe('skill folder', () => {
  it('installs a sent document and serves it to the agent', () => {
    const h = store()

    const result = h.port.install(document())

    expect(result).toEqual({
      ok: true, name: 'inspect', version: 1, previousVersion: null, versionRaised: false,
    })
    expect(h.port.list()).toEqual([{
      name: 'inspect',
      version: 1,
      description: 'Inspect safely',
      enabled: true,
      trustSource: 'user',
      problem: null,
    }])
    expect(h.served()).toEqual(['inspect'])
  })

  it('raises the version when the operator resends an edited file unchanged in version', () => {
    const h = store()
    h.port.install(document())

    // The realistic update: edit the body on a laptop, send it, forget the
    // version line. A stored body whose hash no longer matches its entry would
    // be quarantined on the next boot.
    const updated = h.port.install(document({ body: 'Read it twice.' }))

    expect(updated).toEqual({
      ok: true, name: 'inspect', version: 2, previousVersion: 1, versionRaised: true,
    })
    expect(readFileSync(join(h.root, 'skills', 'inspect', 'SKILL.md'), 'utf8'))
      .toContain('Read it twice.')
    expect(h.served()).toEqual(['inspect'])
    expect(h.port.list()[0]?.version).toBe(2)
  })

  it('takes an explicit higher version as written', () => {
    const h = store()
    h.port.install(document())

    expect(h.port.install(document({ version: 7, body: 'Read it thrice.' }))).toEqual({
      ok: true, name: 'inspect', version: 7, previousVersion: 1, versionRaised: false,
    })
  })

  it('says nothing changed instead of writing the same bytes again', () => {
    const h = store()
    h.port.install(document())

    expect(h.port.install(document())).toEqual({ ok: false, errorCode: 'ALREADY_INSTALLED' })
  })

  it('does not keep raising the version when the same file is sent twice', () => {
    const h = store()
    h.port.install(document())
    // The first resend is a real edit and gets version 2 written into the file.
    expect(h.port.install(document({ body: 'Read it twice.' })).ok).toBe(true)

    // The operator's copy still says version 1; nothing in it changed since.
    expect(h.port.install(document({ body: 'Read it twice.' }))).toEqual({
      ok: false, errorCode: 'ALREADY_INSTALLED',
    })
    expect(h.port.list()[0]?.version).toBe(2)
  })

  it('refuses a document the runtime would then refuse to serve', () => {
    const h = store()

    expect(h.port.install('привет, это не навык')).toEqual({
      ok: false, errorCode: 'NOT_A_SKILL', detail: 'заголовок: missing or unterminated --- fence',
    })
    // No Verification section is exactly what the catalog quarantines, so it is
    // caught here where the operator can still be told why.
    const noVerification = document().replace(/## verification[\s\S]*$/i, '')
    expect(h.port.install(noVerification)).toEqual({ ok: false, errorCode: 'NO_VERIFICATION' })
    expect(h.port.install('x'.repeat(300 * 1024))).toEqual({ ok: false, errorCode: 'TOO_LARGE' })
    expect(h.port.list()).toEqual([])
  })

  it('switches a skill off without deleting it, and back on', () => {
    const h = store()
    h.port.install(document())

    expect(h.port.setEnabled('inspect', false)).toBe(true)
    expect(h.port.list()[0]?.enabled).toBe(false)
    expect(h.served()).toEqual([])
    expect(existsSync(join(h.root, 'skills', 'inspect', 'SKILL.md'))).toBe(true)

    expect(h.port.setEnabled('inspect', true)).toBe(true)
    expect(h.served()).toEqual(['inspect'])
    expect(h.port.setEnabled('missing', false)).toBe(false)
  })

  it('refuses to adopt a hand-edited file and leaves the way out through delete', () => {
    const h = store()
    h.port.install(document())
    writeFileSync(join(h.root, 'skills', 'inspect', 'SKILL.md'), document() + '\ntampered')
    expect(h.served()).toEqual([])
    expect(h.port.list()[0]?.problem).toBe('hash-mismatch')

    // A hand-edited file no longer matches its entry: the store must not
    // silently adopt bytes it never authorised.
    expect(h.port.install(document({ body: 'Fixed.' }))).toEqual({
      ok: false, errorCode: 'REVISION_CONFLICT',
    })

    // Re-enabling re-runs the judgement, and the file is still broken.
    h.port.setEnabled('inspect', true)
    expect(h.served()).toEqual([])

    // Delete clears the quarantine record too, so the same name installs clean.
    expect(h.port.remove('inspect')).toBe(true)
    expect(h.port.install(document({ body: 'Fixed.' })).ok).toBe(true)
    expect(h.served()).toEqual(['inspect'])
  })

  it('deletes the entry before the file, so a crash cannot leave a dangling entry', () => {
    const h = store()
    h.port.install(document())

    expect(h.port.remove('inspect')).toBe(true)
    expect(h.port.list()).toEqual([])
    expect(existsSync(join(h.root, 'skills', 'inspect'))).toBe(false)
    expect(JSON.parse(readFileSync(join(h.root, 'skills-manifest.json'), 'utf8')).skills).toEqual([])
    expect(h.port.remove('inspect')).toBe(false)
    expect(h.served()).toEqual([])
  })

  it('keeps the write grants of the slot when the body is replaced', () => {
    const h = store()
    const text = document()
    h.port.activate({
      operationId: 'seed',
      name: 'inspect',
      version: 1,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      trustSource: 'builtin',
      touchedPaths: ['notes/inbox.md'],
      skillText: text,
      baseVersion: null,
      baseHash: null,
    })

    expect(h.port.install(document({ body: 'Read it twice.' })).ok).toBe(true)

    const entry = JSON.parse(readFileSync(join(h.root, 'skills-manifest.json'), 'utf8')).skills[0]
    expect(entry.touchedPaths).toEqual(['notes/inbox.md'])
    expect(entry.trustSource).toBe('builtin')
  })

  it('reports a deleted skill file rather than pretending the folder is fine', () => {
    const h = store()
    h.port.install(document())
    rmSync(join(h.root, 'skills', 'inspect', 'SKILL.md'))

    const rows = h.port.list()

    expect(rows[0]?.description).toBe('')
    expect(rows[0]?.name).toBe('inspect')
  })
})
