import { describe, expect, it } from 'vitest'

import {
  decodeAgentCardCallback,
  encodeAgentCardCallback,
  renderAgentCardCatalog,
  renderAgentCardDetail,
  type TokenizedAgentCardCatalog,
  type TokenizedAgentCardDetail,
} from './agent-card-catalog-view.js'

const token = (index: number) => `token_${String(index).padStart(10, '0')}`

function catalogFixture(counts: { workspace: number; project: number }): TokenizedAgentCardCatalog {
  const entries = (prefix: string, count: number, offset: number) => Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-${index}`,
    activeRevision: index + 1,
    latestRevision: index + 1,
    latestHashPrefix: 'abcdef012345',
    latestStatus: 'active' as const,
    selectToken: token(offset + index),
  }))
  return {
    configuredName: 'main',
    cutoverActive: false,
    workspace: {
      page: 1, totalPages: 2, entries: entries('workspace', Math.min(counts.workspace, 8), 1),
      nextToken: token(30),
    },
    project: {
      page: 1, totalPages: 2, entries: entries('project', Math.min(counts.project, 8), 10),
      nextToken: token(31),
    },
    createWorkspaceToken: token(40),
    importWorkspaceToken: token(41),
    createProjectToken: token(42),
    importProjectToken: token(43),
  }
}

function detailFixture(marker: string): TokenizedAgentCardDetail {
  return {
    name: 'researcher',
    scopeLabel: 'Текущий проект',
    active: { revision: 2, hashPrefix: 'abcdef012345' },
    history: [
      { revision: 1, status: 'superseded', hashPrefix: '111111111111' },
      { revision: 2, status: 'active', hashPrefix: 'abcdef012345' },
    ],
    catalogToken: token(50),
    publishToken: token(51),
    archiveToken: token(52),
    rollbackToken: token(53),
    // Compile-time excess-property escape verifies that renderers ignore DNA-like input.
    ...({ marker, projectId: 'project-a' } as Record<string, string>),
  }
}

describe('AgentCard callback codec and pure views', () => {
  it('round-trips strict bounded callbacks', () => {
    const encoded = encodeAgentCardCallback({ verb: 'select', token: token(1) })
    expect(encoded).toBe(`ac:v1:select:${token(1)}`)
    expect(decodeAgentCardCallback(encoded)).toEqual({ verb: 'select', token: token(1) })
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(64)
  })

  it.each([
    'ac:v1:unknown:token_0000000001',
    'ac:v1:select:short',
    'ac:v1:select:token+0000000001',
    'ac:v1:select:token_0000000001:extra',
    `ac:v1:select:${'a'.repeat(55)}`,
    'cfg:open:agent-cards',
  ])('rejects malformed callback %s', (value) => {
    expect(decodeAgentCardCallback(value)).toBeNull()
  })

  it('renders independent bounded Workspace and current Project pages', () => {
    const view = renderAgentCardCatalog(catalogFixture({ workspace: 9, project: 9 }))
    expect(view.text).toContain('Общая папка · 1/2')
    expect(view.text).toContain('Текущий проект · 1/2')
    expect(view.text.match(/в работе версия/g)?.length).toBeLessThanOrEqual(16)
    expect(view.text).toContain('не меняет личность, с которой я запускаюсь')
    expect(view.text).toContain('переключения и перезапуска')
  })

  it('keeps raw identities and DNA out of callbacks and text', () => {
    const view = renderAgentCardDetail(detailFixture('PRIVATE-DNA-MARKER'))
    const corpus = JSON.stringify(view)
    expect(corpus).not.toContain('project-a')
    expect(corpus).not.toContain('PRIVATE-DNA-MARKER')
    expect(view.buttons.flat().every(button => Buffer.byteLength(button.data) <= 64)).toBe(true)
  })

  it('escapes operator-visible names and bounds detail history to eight revisions', () => {
    const view = renderAgentCardDetail({
      ...detailFixture('unused'),
      name: '<researcher&>',
      history: Array.from({ length: 12 }, (_, index) => ({
        revision: index + 1,
        status: index === 11 ? 'active' as const : 'superseded' as const,
        hashPrefix: 'abcdef012345',
      })),
    })
    expect(view.text).toContain('&lt;researcher&amp;&gt;')
    expect(view.text).not.toContain('<researcher&>')
    expect(view.text.match(/• \d+ · /g)).toHaveLength(8)
  })
})
