// The screen's job is that a tap only ever does what the card in front of the
// operator says — and that approving is the single step which writes.

import { describe, expect, it, vi } from 'vitest'

import { makeTelegramMcpControls } from './telegram-mcp-controls.js'
import { McpOnboardingError, type McpServerDraft } from './mcp-server-onboarding.js'
import type { McpAllowlistWriter } from './mcp-allowlist-store.js'
import type { ActiveMcpManifestEntryV1 } from '@aisy/core'

const DRAFT: McpServerDraft = {
  name: 'tracker',
  command: ['/usr/local/bin/tracker-mcp'],
  tokenEnv: null,
  pin: 'tracker-mcp@2.1.0',
  descriptorHash: 'a'.repeat(64),
  descriptors: [{ name: 'read_issue', description: 'read', inputSchema: { type: 'object' } }],
  tools: [{ tool: 'read_issue', tier: 1, outboundSink: false, riskClass: 'readOnly', summary: null }],
}

function entry(overrides: Partial<ActiveMcpManifestEntryV1> = {}): ActiveMcpManifestEntryV1 {
  return {
    name: 'tracker',
    transport: 'stdio',
    command: ['/usr/local/bin/tracker-mcp'],
    pin: 'tracker-mcp@2.1.0',
    descriptorHash: 'a'.repeat(64),
    descriptors: [...DRAFT.descriptors],
    tokenEnv: null,
    tools: [...DRAFT.tools],
    status: 'active',
    ...overrides,
  }
}

function controls(options: {
  entries?: ActiveMcpManifestEntryV1[]
  discover?: () => Promise<McpServerDraft>
} = {}) {
  const stored = [...(options.entries ?? [])]
  const writer: McpAllowlistWriter = {
    entries: () => stored,
    upsert: vi.fn((item) => { stored.push(item) }),
    setStatus: vi.fn((name, status) => {
      const index = stored.findIndex(item => item.name === name)
      if (index >= 0) stored[index] = { ...stored[index]!, status }
    }),
    remove: vi.fn((name) => {
      const index = stored.findIndex(item => item.name === name)
      if (index >= 0) stored.splice(index, 1)
    }),
  }
  const onboarding = {
    parse: (text: string) => ({
      name: text.split(/\s+/u)[0] ?? '', command: ['/usr/local/bin/tracker-mcp'], tokenEnv: null,
    }),
    discover: options.discover ?? (async () => DRAFT),
    approve: vi.fn(),
  }
  let tokens = 0
  return {
    writer,
    onboarding,
    stored,
    subject: makeTelegramMcpControls({
      writer,
      onboarding,
      newTokenId: () => `t${String(++tokens)}`,
    }),
  }
}

/** The callback data behind the button whose label starts with `label`. */
function button(view: { buttons: Array<Array<{ text: string; data: string }>> }, label: string): string {
  const found = view.buttons.flat().find(item => item.text.startsWith(label))
  if (found === undefined) throw new Error(`no button labelled ${label}`)
  return found.data
}

describe('the MCP screen', () => {
  it('explains what MCP is when there is nothing to list', () => {
    const view = controls().subject.open()

    expect(view.text).toContain('MCP-серверов пока нет')
    expect(() => button(view, '➕')).not.toThrow()
  })

  it('names each approved server without claiming it is connected', () => {
    const view = controls({ entries: [entry()] }).subject.open()

    expect(view.text).toContain('tracker')
    expect(view.text).toContain('одобрен')
    expect(view.text).not.toContain('на связи')
  })

  it('asks for a server line, then shows what the server answered', async () => {
    const context = controls()
    const asked = await context.subject.handle(button(context.subject.open(), '➕'))
    expect(asked.kind).toBe('await-server')

    const shown = await context.subject.add('tracker /usr/local/bin/tracker-mcp')

    expect(shown.kind).toBe('view')
    if (shown.kind !== 'view') return
    expect(shown.view.text).toContain('tracker-mcp@2.1.0')
    expect(shown.view.text).toContain('read_issue')
    expect(context.onboarding.approve).not.toHaveBeenCalled()
  })

  it('writes nothing until the operator approves, and everything when they do', async () => {
    const context = controls()
    const shown = await context.subject.add('tracker /usr/local/bin/tracker-mcp')
    if (shown.kind !== 'view') throw new Error('expected a draft card')

    expect(context.onboarding.approve).not.toHaveBeenCalled()
    await context.subject.handle(button(shown.view, '✅'))

    expect(context.onboarding.approve).toHaveBeenCalledWith(DRAFT)
  })

  it('discards a draft the operator refused', async () => {
    const context = controls()
    const shown = await context.subject.add('tracker /usr/local/bin/tracker-mcp')
    if (shown.kind !== 'view') throw new Error('expected a draft card')

    await context.subject.handle(button(shown.view, '✖️'))

    expect(context.onboarding.approve).not.toHaveBeenCalled()
  })

  it('says why a server was not added, in the operator’s terms', async () => {
    const context = controls({
      discover: async () => { throw new McpOnboardingError('TOKEN_UNRESOLVED') },
    })

    const outcome = await context.subject.add('tracker /usr/local/bin/tracker-mcp')

    expect(outcome).toMatchObject({ kind: 'notice' })
    if (outcome.kind !== 'notice') return
    expect(outcome.text).toContain('хранилище ключей')
  })

  it('turns a server off without forgetting its approval', async () => {
    const context = controls({ entries: [entry()] })
    const card = await context.subject.handle(button(context.subject.open(), '🔌'))
    if (card.kind !== 'view') throw new Error('expected a server card')

    await context.subject.handle(button(card.view, '⏸'))

    expect(context.writer.setStatus).toHaveBeenCalledWith('tracker', 'archived')
    expect(context.writer.remove).not.toHaveBeenCalled()
  })

  it('asks before deleting an approval', async () => {
    const context = controls({ entries: [entry()] })
    const card = await context.subject.handle(button(context.subject.open(), '🔌'))
    if (card.kind !== 'view') throw new Error('expected a server card')

    const confirm = await context.subject.handle(button(card.view, '🗑'))
    if (confirm.kind !== 'view') throw new Error('expected a confirmation')
    expect(context.writer.remove).not.toHaveBeenCalled()

    await context.subject.handle(button(confirm.view, '🗑 Да'))
    expect(context.writer.remove).toHaveBeenCalledWith('tracker')
  })

  it('treats a tap from an older card as stale rather than acting on it', async () => {
    const context = controls({ entries: [entry()] })
    const first = context.subject.open()
    const token = button(first, '🔌')
    context.subject.open() // re-render: the previous card's tokens are gone

    const outcome = await context.subject.handle(token)

    expect(outcome.kind).toBe('stale')
  })

  it('never lets a callback from another screen through', async () => {
    const context = controls({ entries: [entry()] })

    expect((await context.subject.handle('skill:whatever')).kind).toBe('stale')
  })
})
