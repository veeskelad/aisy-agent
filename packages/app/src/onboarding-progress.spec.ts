import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  makeOnboardingProgress,
  ONBOARDING_TOPICS,
} from './onboarding-progress.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function progressPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'aisy-onboarding-'))
  roots.push(root)
  return join(root, 'onboarding-progress.json')
}

describe('onboarding progress', () => {
  it('starts with every topic missing', () => {
    expect(makeOnboardingProgress({ path: progressPath() }).missing())
      .toEqual([...ONBOARDING_TOPICS])
  })

  it('closes a topic and keeps it closed across a restart', () => {
    const path = progressPath()
    makeOnboardingProgress({ path }).cover('work')

    expect(makeOnboardingProgress({ path }).missing()).not.toContain('work')
  })

  it('reports missing topics in brief order', () => {
    const progress = makeOnboardingProgress({ path: progressPath() })
    progress.cover('projects')
    progress.cover('name')

    expect(progress.missing()).toEqual(['work', 'style', 'autonomy', 'expectations'])
  })

  it('ignores a topic the model invented', () => {
    const progress = makeOnboardingProgress({ path: progressPath() })
    progress.cover('favourite-colour')

    expect(progress.missing()).toEqual([...ONBOARDING_TOPICS])
  })

  it('is done only when all six are answered', () => {
    const progress = makeOnboardingProgress({ path: progressPath() })
    for (const topic of ONBOARDING_TOPICS) progress.cover(topic)

    expect(progress.missing()).toEqual([])
  })

  it('reads a corrupt file as nothing learned, rather than as done', () => {
    const path = progressPath()
    writeFileSync(path, '{ this is not json', 'utf8')

    expect(makeOnboardingProgress({ path }).missing()).toEqual([...ONBOARDING_TOPICS])
  })

  it('drops junk entries instead of trusting the whole file', () => {
    const path = progressPath()
    writeFileSync(path, JSON.stringify({ version: 1, covered: ['work', 42, 'nope'] }), 'utf8')

    expect(makeOnboardingProgress({ path }).missing()).not.toContain('work')
    expect(makeOnboardingProgress({ path }).missing()).toHaveLength(5)
  })

  it('writes the file atomically, leaving no partial state behind', () => {
    const path = progressPath()
    makeOnboardingProgress({ path }).cover('style', 'пишет коротко')

    expect(JSON.parse(readFileSync(path, 'utf8')))
      .toEqual({ version: 1, covered: ['style'], facts: { style: ['пишет коротко'] } })
  })

  it('survives an unwritable path without losing the in-memory answer', () => {
    const progress = makeOnboardingProgress({ path: '/onboarding-progress.json' })
    progress.cover('autonomy')

    expect(progress.missing()).not.toContain('autonomy')
  })
})

describe('the profile behind the topics', () => {
  it('keeps the facts that answered each topic, in brief order', () => {
    const progress = makeOnboardingProgress({ path: progressPath() })
    progress.cover('work', 'делает харнесс для агентов')
    progress.cover('name', 'зовут Иван, Москва')

    expect(progress.profile()).toEqual([
      { topic: 'name', facts: ['зовут Иван, Москва'] },
      { topic: 'work', facts: ['делает харнесс для агентов'] },
    ])
  })

  it('accumulates several facts under one topic', () => {
    const progress = makeOnboardingProgress({ path: progressPath() })
    progress.cover('projects', 'проект A')
    progress.cover('projects', 'проект B')

    expect(progress.profile()[0]?.facts).toEqual(['проект A', 'проект B'])
  })

  it('does not repeat the same answer twice', () => {
    const progress = makeOnboardingProgress({ path: progressPath() })
    progress.cover('style', 'коротко')
    progress.cover('style', '  коротко  ')

    expect(progress.profile()[0]?.facts).toEqual(['коротко'])
  })

  it('survives a restart with its facts', () => {
    const path = progressPath()
    makeOnboardingProgress({ path }).cover('autonomy', 'читать можно молча')

    expect(makeOnboardingProgress({ path }).profile())
      .toEqual([{ topic: 'autonomy', facts: ['читать можно молча'] }])
  })

  it('closes a topic even when the fact is unusable', () => {
    const progress = makeOnboardingProgress({ path: progressPath() })
    progress.cover('expectations', '   ')

    expect(progress.missing()).not.toContain('expectations')
    expect(progress.profile()).toEqual([{ topic: 'expectations', facts: [] }])
  })

  it('clips a fact that arrived as a paragraph', () => {
    const progress = makeOnboardingProgress({ path: progressPath() })
    progress.cover('work', 'я'.repeat(500))

    expect(progress.profile()[0]?.facts[0]).toHaveLength(300)
  })

  it('bounds how much one topic can accumulate', () => {
    const progress = makeOnboardingProgress({ path: progressPath() })
    for (let index = 0; index < 12; index += 1) progress.cover('projects', `проект ${index}`)

    expect(progress.profile()[0]?.facts).toHaveLength(8)
    expect(progress.profile()[0]?.facts[0]).toBe('проект 4')
  })
})
