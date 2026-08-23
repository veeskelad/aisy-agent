import { describe, expect, it, vi } from 'vitest'

import {
  collectHookContext,
  loadExtensionHooks,
  type ExtensionHookModule,
  type HookTool,
} from './extension-hooks.js'

const tool = (overrides: Partial<HookTool> = {}): HookTool => ({
  name: 'lookup_crm',
  description: 'Ищет клиента в CRM',
  effect: 'read',
  tier: 1,
  inputSchema: { type: 'object' },
  execute: async () => 'ok',
  ...overrides,
})

function modules(map: Record<string, ExtensionHookModule>) {
  return async (file: string): Promise<ExtensionHookModule> => {
    const found = map[file]
    if (found === undefined) throw new Error(`no module: ${file}`)
    return found
  }
}

describe('extension hooks (ADR-0077)', () => {
  it('loads hooks in the given order and collects their tools', async () => {
    const order: string[] = []
    const result = await loadExtensionHooks({
      files: ['10-crm.mjs', '20-notes.mjs'],
      importModule: modules({
        '10-crm.mjs': { install: (ctx) => { order.push('crm'); ctx.registerTool(tool()) } },
        '20-notes.mjs': {
          install: (ctx) => { order.push('notes'); ctx.registerTool(tool({ name: 'save_note_ext' })) },
        },
      }),
    })

    expect(order).toEqual(['crm', 'notes'])
    expect(result.tools.map(item => item.name)).toEqual(['lookup_crm', 'save_note_ext'])
    expect(result.failed).toEqual([])
    expect(result.disabled).toBe(false)
  })

  it('ignores files parked with an underscore prefix', async () => {
    const install = vi.fn()
    const result = await loadExtensionHooks({
      files: ['_10-disabled.mjs', 'hooks/_20-also-off.mjs'],
      importModule: modules({ '_10-disabled.mjs': { install }, 'hooks/_20-also-off.mjs': { install } }),
    })

    expect(install).not.toHaveBeenCalled()
    expect(result.tools).toEqual([])
  })

  it('refuses a tool that does not declare effect and tier', async () => {
    const result = await loadExtensionHooks({
      files: ['bad.mjs'],
      importModule: modules({
        'bad.mjs': { install: (ctx) => { ctx.registerTool({ ...tool(), effect: undefined as never }) } },
      }),
    })

    expect(result.tools).toEqual([])
    expect(result.failed).toEqual([{ file: 'bad.mjs', reason: 'invalid-tool' }])
  })

  it('keeps working hooks when one throws, and frees its tool names', async () => {
    const result = await loadExtensionHooks({
      files: ['10-broken.mjs', '20-good.mjs'],
      importModule: modules({
        '10-broken.mjs': {
          install: (ctx) => {
            ctx.registerTool(tool({ name: 'shared_name' }))
            throw new Error('boom')
          },
        },
        // The later hook may take the name the failed one had claimed.
        '20-good.mjs': { install: (ctx) => { ctx.registerTool(tool({ name: 'shared_name' })) } },
      }),
    })

    expect(result.failed).toEqual([{ file: '10-broken.mjs', reason: 'load-failed' }])
    expect(result.tools.map(item => item.name)).toEqual(['shared_name'])
  })

  it('refuses a duplicate tool name across hooks', async () => {
    const result = await loadExtensionHooks({
      files: ['10-a.mjs', '20-b.mjs'],
      importModule: modules({
        '10-a.mjs': { install: (ctx) => { ctx.registerTool(tool()) } },
        '20-b.mjs': { install: (ctx) => { ctx.registerTool(tool()) } },
      }),
    })

    expect(result.tools).toHaveLength(1)
    expect(result.failed).toEqual([{ file: '20-b.mjs', reason: 'duplicate-tool' }])
  })

  it('refuses registration after install returned', async () => {
    let escaped: { registerTool: (t: HookTool) => void } | null = null
    const result = await loadExtensionHooks({
      files: ['sneaky.mjs'],
      importModule: modules({ 'sneaky.mjs': { install: (ctx) => { escaped = ctx } } }),
    })

    expect(result.tools).toEqual([])
    expect(() => escaped?.registerTool(tool()))
      .toThrowError(expect.objectContaining({ reason: 'registration-after-install' }))
  })

  it('disables the whole mechanism after repeated failures', async () => {
    const onDisabled = vi.fn()
    const result = await loadExtensionHooks({
      files: ['10-a.mjs'],
      importModule: modules({ '10-a.mjs': { install: (ctx) => { ctx.registerTool(tool()) } } }),
      previousFailures: 5,
      onDisabled,
    })

    expect(result).toEqual({ tools: [], providers: [], failed: [], disabled: true })
    expect(onDisabled).toHaveBeenCalledWith(5)
  })
})

describe('hook context providers (ADR-0077)', () => {
  const provider = (at: 'pre-prompt' | 'post-tool' | 'pre-provider', text: string | null) => ({
    at,
    name: `provider-${at}`,
    provide: async () => text,
  })

  it('collects only providers bound to this moment of the turn', async () => {
    const fragments = await collectHookContext({
      providers: [provider('pre-prompt', 'ранний контекст'), provider('pre-provider', 'поздний контекст')],
      at: 'pre-prompt',
      query: 'вопрос',
    })

    expect(fragments).toEqual([
      { name: 'provider-pre-prompt', text: 'ранний контекст', provenance: 'untrusted' },
    ])
  })

  it('marks every fragment untrusted regardless of its source', async () => {
    const fragments = await collectHookContext({
      providers: [provider('post-tool', 'данные из внешнего сервиса')],
      at: 'post-tool',
      query: 'q',
    })

    expect(fragments[0]?.provenance).toBe('untrusted')
  })

  it('skips a failing or oversized provider instead of failing the turn', async () => {
    const fragments = await collectHookContext({
      providers: [
        { at: 'pre-prompt', name: 'throws', provide: async () => { throw new Error('down') } },
        { at: 'pre-prompt', name: 'huge', provide: async () => 'x'.repeat(64 * 1024) },
        provider('pre-prompt', 'нормальный'),
      ],
      at: 'pre-prompt',
      query: 'q',
      maxFragmentBytes: 1024,
    })

    expect(fragments.map(fragment => fragment.name)).toEqual(['provider-pre-prompt'])
  })

  it('treats an empty or null fragment as nothing to add', async () => {
    const fragments = await collectHookContext({
      providers: [provider('pre-prompt', null), provider('post-tool', '')],
      at: 'pre-prompt',
      query: 'q',
    })

    expect(fragments).toEqual([])
  })
})
