// Спека 24 писалась целиком и покрывалась тестами по частям, а живая сборка
// звала из неё половину: журнал доказательств не создавался нигде, каскад
// забывания и нормативный демоушен не вызывались ниоткуда. Тесты ядра этого не
// видят — они проверяют функции, а не то, что кто-то их зовёт.
//
// Отсюда лексический страж по исходнику композиции: он падает, когда проводку
// снимают, и это единственный детерминированный способ отличить «компонент
// написан» от «компонент работает».

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const cli = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')

describe('обучаемая автономность собрана в живой композиции', () => {
  it('создаёт журнал доказательств, реестр грантов и порт для HookGate', () => {
    expect(cli).toContain('makeAutonomyLedger({')
    expect(cli).toContain('makeLearnedGrantRegistry({')
    expect(cli).toContain('makeLearnedAutonomyPort({')
    expect(cli).toContain('observeApproval: observeApprovalForAutonomy')
  })

  it('гасит автономию через ядро, а не собранной вручную парой вызовов', () => {
    // Порядок нормативен (спека 24 §7): сначала отзыв гранта, потом демоушен
    // доказательств. Ручная пара в композиции делала обратное — осиротевший
    // грант опаснее осиротевшей записи.
    expect(cli).toContain('demoteLearnedAutonomy({')
    expect(cli).not.toContain("autonomyLedger.demote(entry.workflowKey")
  })

  it('запускает каскад забывания архивацией проекта или сессии (AC-24-10)', () => {
    expect(cli).toContain('forgetLearnedAutonomy({')
    // Каскад висит на событиях сервиса проектов — иначе разрешение переживёт
    // проект, ради которого набиралось.
    expect(cli).toContain('emit: (event) => { forgetAutonomyOn(event) }')
    expect(cli).toContain("event.kind === 'project.archived'")
    expect(cli).toContain("event.kind === 'session.archived'")
  })
})
