import { describe, expect, it } from 'vitest'

import { makeTelegramSkillControls } from './telegram-skill-controls.js'
import type { SkillFolderEntry, SkillFolderPort, SkillInstallResult } from './active-skill-store.js'

function entry(name: string, over: Partial<SkillFolderEntry> = {}): SkillFolderEntry {
  return {
    name,
    version: 1,
    description: `Что делает ${name}`,
    enabled: true,
    trustSource: 'user',
    problem: null,
    ...over,
  }
}

function harness(initial: SkillFolderEntry[] = [], install?: () => SkillInstallResult) {
  let rows = [...initial]
  const calls: string[] = []
  let token = 0
  const folder: SkillFolderPort = {
    list: () => rows.map((row) => ({ ...row })),
    setEnabled(name, enabled) {
      calls.push(`setEnabled:${name}:${enabled}`)
      const row = rows.find((candidate) => candidate.name === name)
      if (!row) return false
      row.enabled = enabled
      return true
    },
    remove(name) {
      calls.push(`remove:${name}`)
      const before = rows.length
      rows = rows.filter((candidate) => candidate.name !== name)
      return rows.length !== before
    },
    install: install ?? (() => ({
      ok: true, name: 'inspect', version: 1, previousVersion: null, versionRaised: false,
    })),
  }
  return {
    calls,
    folder,
    controls: makeTelegramSkillControls({
      folder,
      newTokenId: () => `t${++token}`,
      pageSize: 2,
    }),
  }
}

const buttonTexts = (view: { buttons: { text: string }[][] }): string[] =>
  view.buttons.flat().map((button) => button.text)

const dataFor = (view: { buttons: { text: string; data: string }[][] }, label: string): string =>
  view.buttons.flat().find((button) => button.text.includes(label))!.data

describe('skills screen', () => {
  it('pages through the folder instead of dumping it into one message', () => {
    const h = harness([entry('alpha'), entry('beta'), entry('gamma')])

    const first = h.controls.open()
    expect(buttonTexts(first)).toEqual(['✅ alpha', '✅ beta', '1/2', '▶️', '⬇️ Установить навык'])

    const second = h.controls.handle(dataFor(first, '▶️'))
    expect(second.kind).toBe('view')
    if (second.kind !== 'view') return
    expect(buttonTexts(second.view)).toEqual(['✅ gamma', '◀️', '2/2', '⬇️ Установить навык'])
  })

  it('never puts a skill name into callback data', () => {
    const h = harness([entry('alpha')])

    const view = h.controls.open()

    // The name comes from a file the operator may have written; only a minted
    // token crosses back through Telegram.
    for (const button of view.buttons.flat()) {
      expect(button.data.startsWith('skill:')).toBe(true)
      expect(button.data).not.toContain('alpha')
    }
  })

  it('opens a card with the description and the state', () => {
    const h = harness([entry('alpha', { version: 4, trustSource: 'builtin', enabled: false })])

    const outcome = h.controls.handle(dataFor(h.controls.open(), 'alpha'))

    expect(outcome.kind).toBe('view')
    if (outcome.kind !== 'view') return
    expect(outcome.view.text).toContain('Версия 4 · builtin · ⏸ выключен')
    expect(outcome.view.text).toContain('Что делает alpha')
    expect(buttonTexts(outcome.view)).toEqual(['▶️ Включить', '🗑 Удалить', '⬅️ К списку'])
  })

  it('switches a skill off and shows the new state on the same card', () => {
    const h = harness([entry('alpha')])
    const card = h.controls.handle(dataFor(h.controls.open(), 'alpha'))
    if (card.kind !== 'view') throw new Error('card')

    const toggled = h.controls.handle(dataFor(card.view, 'Выключить'))

    expect(h.calls).toEqual(['setEnabled:alpha:false'])
    expect(toggled.kind).toBe('view')
    if (toggled.kind !== 'view') return
    expect(toggled.view.text).toContain('⏸ выключен')
    expect(buttonTexts(toggled.view)).toContain('▶️ Включить')
  })

  it('asks before deleting, and one tap on the card does not delete', () => {
    const h = harness([entry('alpha'), entry('beta')])
    const card = h.controls.handle(dataFor(h.controls.open(), 'alpha'))
    if (card.kind !== 'view') throw new Error('card')

    const confirm = h.controls.handle(dataFor(card.view, 'Удалить'))
    if (confirm.kind !== 'view') throw new Error('confirm')
    expect(h.calls).toEqual([])
    expect(confirm.view.text).toContain('Удалить навык «alpha»?')

    const cancelled = h.controls.handle(dataFor(confirm.view, 'Отмена'))
    expect(h.calls).toEqual([])
    if (cancelled.kind !== 'view') throw new Error('cancelled')
    expect(cancelled.view.text).toContain('🧩 alpha')
  })

  it('deletes on the second tap and comes back to the list', () => {
    const h = harness([entry('alpha'), entry('beta')])
    const card = h.controls.handle(dataFor(h.controls.open(), 'alpha'))
    if (card.kind !== 'view') throw new Error('card')
    const confirm = h.controls.handle(dataFor(card.view, 'Удалить'))
    if (confirm.kind !== 'view') throw new Error('confirm')

    const done = h.controls.handle(dataFor(confirm.view, 'Да, удалить'))

    expect(h.calls).toEqual(['remove:alpha'])
    if (done.kind !== 'view') throw new Error('done')
    expect(buttonTexts(done.view)).toEqual(['✅ beta', '⬇️ Установить навык'])
  })

  it('treats a button from a card that predates a change as stale', () => {
    const h = harness([entry('alpha')])
    const stale = h.controls.open()
    h.controls.open() // the operator opened the list again; the old tokens died

    const outcome = h.controls.handle(dataFor(stale, 'alpha'))

    expect(outcome.kind).toBe('stale')
    expect(h.calls).toEqual([])
  })

  it('reports what happened to the folder after an install, with the fresh list', () => {
    const h = harness([], () => ({
      ok: true, name: 'alpha', version: 3, previousVersion: 2, versionRaised: true,
    }))

    const outcome = h.controls.install('---\nname: alpha\n---\n')

    if (outcome.kind !== 'view') throw new Error('view')
    expect(outcome.view.text).toContain('обновлён: 2 → 3')
    expect(outcome.view.text).toContain('В файле стояла старая версия')
  })

  it('explains a refused file instead of silently ignoring it', () => {
    const rejected = harness([], () => ({ ok: false, errorCode: 'NO_VERIFICATION' }))
    expect(rejected.controls.install('nope')).toEqual({
      kind: 'notice',
      text: '❌ В файле нет раздела «## Verification» — без него навык не запускается.',
    })

    const conflict = harness([], () => ({ ok: false, errorCode: 'REVISION_CONFLICT' }))
    const outcome = conflict.controls.install('nope')
    expect(outcome.kind === 'notice' && outcome.text).toContain('Удали навык в списке')
  })

  it('shows a broken skill as a problem rather than as working', () => {
    const h = harness([entry('alpha', { problem: 'hash-mismatch', description: '' })])

    const list = h.controls.open()
    expect(list.text).toContain('с проблемой 1')
    expect(buttonTexts(list)).toContain('⚠️ alpha')

    const card = h.controls.handle(dataFor(list, 'alpha'))
    if (card.kind !== 'view') throw new Error('card')
    expect(card.view.text).toContain('файл правили вручную')
    expect(card.view.text).toContain('Описание не читается.')
  })

  it('stays usable when the folder itself cannot be read', () => {
    const h = harness([entry('alpha')])
    const controls = makeTelegramSkillControls({
      folder: { ...h.folder, list: () => { throw new Error('broken manifest') } },
      newTokenId: () => 'x',
    })

    const view = controls.open()

    expect(view.text).toContain('повреждён')
    expect(buttonTexts(view)).toEqual(['⬇️ Как установить'])
  })

  it('tells an operator with an empty folder how to fill it', () => {
    const view = harness().controls.open()

    expect(view.text).toContain('Папка пустая')
    expect(view.text).toContain('SKILL.md')
  })
})
