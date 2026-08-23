import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  makeOperatorProfileWriter,
  mergeProfileBlock,
  renderProfileBlock,
} from './operator-profile.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function profilePath(body?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'aisy-profile-'))
  roots.push(root)
  const path = join(root, 'USER.md')
  if (body !== undefined) writeFileSync(path, body, 'utf8')
  return path
}

const PROFILE = [
  { topic: 'name' as const, facts: ['зовут Иван, Москва'] },
  { topic: 'work' as const, facts: ['делает харнесс', 'пишет на TypeScript'] },
]

describe('rendering the profile block', () => {
  it('lists every fact under the topic it answers', () => {
    const block = renderProfileBlock(PROFILE)

    expect(block).toContain('- зовут Иван, Москва')
    expect(block).toContain('- пишет на TypeScript')
    expect(block).toContain('как обращаться')
  })

  it('renders nothing when a topic was closed without a fact', () => {
    expect(renderProfileBlock([{ topic: 'style', facts: [] }])).toBe('')
  })
})

describe('merging into a file the operator owns', () => {
  it('appends the block, keeping what was written by hand', () => {
    const merged = mergeProfileBlock('# User\n\n- Name: заполню сам\n', renderProfileBlock(PROFILE))

    expect(merged).toContain('- Name: заполню сам')
    expect(merged).toContain('зовут Иван')
  })

  it('replaces the previous block instead of stacking a second one', () => {
    const first = mergeProfileBlock('# User\n', renderProfileBlock(PROFILE))
    const second = mergeProfileBlock(first, renderProfileBlock([
      { topic: 'name', facts: ['зовут Иван, Берлин'] },
    ]))

    expect(second.match(/aisy:profile:begin/gu)).toHaveLength(1)
    expect(second).toContain('Берлин')
    expect(second).not.toContain('Москва')
  })

  it('leaves a file with a stray opening marker untouched rather than truncating it', () => {
    const body = '# User\n\n<!-- aisy:profile:begin -->\nважный текст оператора\n'
    const merged = mergeProfileBlock(body, renderProfileBlock(PROFILE))

    expect(merged).toContain('важный текст оператора')
  })

  it('removes the block when nothing is known any more', () => {
    const withBlock = mergeProfileBlock('# User\n', renderProfileBlock(PROFILE))
    const cleared = mergeProfileBlock(withBlock, '')

    expect(cleared).toBe('# User\n')
  })
})

describe('the writer', () => {
  it('fills a file the scaffold left as an empty questionnaire', () => {
    const path = profilePath('# User\n\n- Name / how to address you:\n')
    makeOperatorProfileWriter({ path }).refresh(PROFILE)

    const body = readFileSync(path, 'utf8')
    expect(body).toContain('- Name / how to address you:')
    expect(body).toContain('зовут Иван, Москва')
  })

  it('creates the file when the scaffold never ran', () => {
    const path = profilePath()
    makeOperatorProfileWriter({ path }).refresh(PROFILE)

    expect(readFileSync(path, 'utf8')).toContain('зовут Иван, Москва')
  })

  it('writes nothing when the rendered result would not change', () => {
    const path = profilePath('# User\n')
    const writer = makeOperatorProfileWriter({ path })
    writer.refresh(PROFILE)
    const first = readFileSync(path, 'utf8')

    writer.refresh(PROFILE)

    expect(readFileSync(path, 'utf8')).toBe(first)
  })

  it('reports a failed write instead of throwing into the turn', () => {
    const failures: string[] = []
    makeOperatorProfileWriter({
      path: '/USER.md',
      onError: (detail) => failures.push(detail),
    }).refresh(PROFILE)

    expect(failures).toHaveLength(1)
  })
})
