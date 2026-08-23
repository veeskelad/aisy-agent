import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JOURNAL_MAX_BYTES, makeDailyJournal } from './daily-journal.js'

const roots: string[] = []
const NOW = '2026-07-29T14:35:00Z'

function root(): string {
  const created = mkdtempSync(join(tmpdir(), 'aisy-journal-'))
  roots.push(created)
  return created
}

const journal = (dir: string, now = NOW) => makeDailyJournal({ root: dir, nowIso: () => now })

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('daily journal (ADR-0079)', () => {
  it('reports nothing before anything is written', () => {
    expect(journal(root()).today()).toBeNull()
  })

  it('starts the day with its own heading and stamps entries with the time', () => {
    const dir = root()
    const log = journal(dir)

    log.append('починили деплой')
    log.append('   разобрали  падение теста  ')

    const text = readFileSync(join(dir, '2026-07-29.md'), 'utf8')
    expect(text).toBe('# 2026-07-29\n\n- 14:35 починили деплой\n- 14:35 разобрали падение теста\n')
    expect(log.today()).toBe(text)
  })

  it('does not write an empty entry', () => {
    const dir = root()
    journal(dir).append('   \n  ')
    expect(existsSync(join(dir, '2026-07-29.md'))).toBe(false)
  })

  it('keeps the end when a day outgrows the cap — that is where "I stopped" is', () => {
    const dir = root()
    writeFileSync(
      join(dir, '2026-07-29.md'),
      'старое\n'.repeat(2000) + '- 23:59 последняя запись дня\n',
    )

    const text = journal(dir).today() ?? ''
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(JOURNAL_MAX_BYTES + 8)
    expect(text).toContain('последняя запись дня')
    expect(text.startsWith('…\n')).toBe(true)
  })

  it('reads three days back but no further', () => {
    const dir = root()
    for (const date of ['2026-07-25', '2026-07-26', '2026-07-27', '2026-07-29']) {
      writeFileSync(join(dir, `${date}.md`), `# ${date}\n`)
    }
    const log = journal(dir)

    expect(log.read('2026-07-27')).toContain('2026-07-27')
    // Three days back is inside the window; the fourth is not.
    expect(log.read('2026-07-26')).toContain('2026-07-26')
    expect(log.read('2026-07-25')).toBe('out-of-window')
    expect(log.read('2026-07-28')).toBeNull()
  })

  it('refuses a future date', () => {
    expect(journal(root()).read('2026-07-30')).toBe('out-of-window')
  })

  it('never lets a date choose a path', () => {
    const dir = root()
    writeFileSync(join(dir, 'secret.md'), 'приватное')

    for (const bad of ['../secret', '2026-07-29/../../etc/passwd', '2026-7-29', '']) {
      expect(journal(dir).read(bad)).toBe('bad-date')
    }
  })

  it('does not cost a turn when the journal cannot be written', () => {
    const log = makeDailyJournal({ root: '/proc/nonexistent/aisy', nowIso: () => NOW })
    expect(() => log.append('что-то')).not.toThrow()
  })
})
