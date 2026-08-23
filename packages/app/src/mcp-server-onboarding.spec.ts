// Approval is the only step here that grants anything, so what these check is
// the boundary: what a draft is allowed to contain, and that nothing reaches
// the manifest before an operator says so.

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpProcessHandle, RawDescriptor } from '@aisy/core'
import { describe, expect, it } from 'vitest'

import { makeNodeMcpAllowlistWriter } from './mcp-allowlist-store.js'
import { makeMcpServerOnboarding, McpOnboardingError } from './mcp-server-onboarding.js'
import type { McpRuntimeDeps } from './mcp-runtime.js'

const COMMAND = ['/usr/local/bin/tracker-mcp', '--stdio']

const descriptor = (name: string, annotations?: Record<string, unknown>): RawDescriptor => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: 'object', properties: {} },
  ...(annotations === undefined ? {} : { annotations }),
})

function fakeRuntime(options: {
  pin?: string
  descriptors?: RawDescriptor[]
  failOn?: 'pin' | 'descriptors'
} = {}) {
  const spawned: Array<{ command: string[]; env: Record<string, string> }> = []
  let terminated = 0
  const deps: McpRuntimeDeps = {
    spawnProcess: (command, env) => {
      spawned.push({ command, env })
      return { id: 'h1', env, terminate: () => { terminated += 1 } } as McpProcessHandle
    },
    resolvePin: async () => {
      if (options.failOn === 'pin') throw new Error('server died')
      return options.pin ?? 'tracker-mcp@2.1.0'
    },
    fetchDescriptors: async () => {
      if (options.failOn === 'descriptors') throw new Error('bad tools/list')
      return options.descriptors ?? [descriptor('read_issue', { readOnlyHint: true })]
    },
    invokeTool: async () => '',
  }
  return { deps, spawned, get terminated() { return terminated } }
}

function onboarding(options: Parameters<typeof fakeRuntime>[0] = {}, taken: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'aisy-mcp-'))
  const runtime = fakeRuntime(options)
  const writer = makeNodeMcpAllowlistWriter({ root })
  return {
    root,
    runtime,
    writer,
    subject: makeMcpServerOnboarding({
      runtime: runtime.deps,
      writer,
      resolveToken: (name) => name === 'TRACKER_TOKEN' ? 'secret' : null,
      taken: () => taken,
    }),
    manifest: () => JSON.parse(readFileSync(join(root, 'mcp-allowlist.json'), 'utf8')) as {
      servers: Array<Record<string, unknown>>
    },
  }
}

describe('what the operator types', () => {
  it('reads a name, an absolute command and an optional token variable', () => {
    const { subject } = onboarding()

    expect(subject.parse('  tracker /usr/local/bin/tracker-mcp --stdio TRACKER_TOKEN  ')).toEqual({
      name: 'tracker',
      command: ['/usr/local/bin/tracker-mcp', '--stdio'],
      tokenEnv: 'TRACKER_TOKEN',
    })
    expect(subject.parse('tracker /usr/local/bin/tracker-mcp')).toEqual({
      name: 'tracker', command: ['/usr/local/bin/tracker-mcp'], tokenEnv: null,
    })
  })

  it('refuses a command that is not an absolute path', () => {
    const { subject } = onboarding()

    // `npx some-server` would resolve through PATH at spawn time, which is a
    // different binary tomorrow than the one that was approved today.
    expect(() => subject.parse('tracker npx -y some-server'))
      .toThrowError(expect.objectContaining({ reason: 'INVALID_COMMAND' }))
  })

  it('refuses a name that would shadow an approved server', () => {
    const { subject } = onboarding({}, ['tracker'])

    expect(() => subject.parse('tracker /usr/local/bin/tracker-mcp'))
      .toThrowError(expect.objectContaining({ reason: 'NAME_TAKEN' }))
  })
})

describe('getting acquainted with a server', () => {
  it('produces a draft the manifest would accept, and writes nothing yet', async () => {
    const context = onboarding()

    const draft = await context.subject.discover({
      name: 'tracker', command: [...COMMAND], tokenEnv: null,
    })

    expect(draft).toMatchObject({
      name: 'tracker',
      pin: 'tracker-mcp@2.1.0',
      descriptorHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      // The summary is the server's own one-liner, kept because the operator
      // reads exactly it on the approval card and the agent reads exactly it
      // in the menu afterwards.
      tools: [{
        tool: 'read_issue', tier: 1, outboundSink: false, riskClass: 'readOnly',
        summary: 'does read_issue',
      }],
    })
    expect(context.writer.entries()).toEqual([])
    expect(context.runtime.terminated).toBe(1)
  })

  it('drops a description that is not one readable line', async () => {
    const context = onboarding({
      descriptors: [{
        name: 'read_issue',
        description: `line one\u0007\n${'x'.repeat(400)}`,
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      }],
    })

    const draft = await context.subject.discover({
      name: 'tracker', command: [...COMMAND], tokenEnv: null,
    })

    // No summary means the tool stays out of the agent's menu — better than
    // pasting 400 characters of server-authored text into the frozen prefix.
    expect(draft.tools[0]?.summary).toBeNull()
  })

  it('proposes a confirmation for a tool that claims nothing about itself', async () => {
    const context = onboarding({ descriptors: [descriptor('run_query')] })

    const draft = await context.subject.discover({ name: 'db', command: [...COMMAND], tokenEnv: null })

    expect(draft.tools[0]).toMatchObject({ tier: 2, outboundSink: true, riskClass: 'idempotent' })
  })

  it('proposes the strictest tier for a tool that announces it destroys things', async () => {
    const context = onboarding({ descriptors: [descriptor('drop_table', { destructiveHint: true })] })

    const draft = await context.subject.discover({ name: 'db', command: [...COMMAND], tokenEnv: null })

    expect(draft.tools[0]).toMatchObject({ tier: 3, outboundSink: true, riskClass: 'destructive' })
  })

  it('passes only the named token into the server, never into the draft', async () => {
    const context = onboarding()

    const draft = await context.subject.discover({
      name: 'tracker', command: [...COMMAND], tokenEnv: 'TRACKER_TOKEN',
    })

    expect(context.runtime.spawned[0]?.env).toEqual({ TRACKER_TOKEN: 'secret' })
    expect(JSON.stringify(draft)).not.toContain('secret')
  })

  it('stops before spawning when the named token is not in the vault', async () => {
    const context = onboarding()

    await expect(context.subject.discover({
      name: 'tracker', command: [...COMMAND], tokenEnv: 'MISSING_TOKEN',
    })).rejects.toMatchObject({ reason: 'TOKEN_UNRESOLVED' })
    expect(context.runtime.spawned).toEqual([])
  })

  it('refuses a server that will not name a version to pin', async () => {
    const context = onboarding({ pin: 'tracker-mcp@latest' })

    await expect(context.subject.discover({ name: 'tracker', command: [...COMMAND], tokenEnv: null }))
      .rejects.toMatchObject({ reason: 'INVALID_PIN' })
  })

  it('reports an unreachable server instead of a half-built draft', async () => {
    const context = onboarding({ failOn: 'descriptors' })

    await expect(context.subject.discover({ name: 'tracker', command: [...COMMAND], tokenEnv: null }))
      .rejects.toBeInstanceOf(McpOnboardingError)
    expect(context.runtime.terminated).toBe(1)
  })

  it('refuses a server that offers nothing', async () => {
    const context = onboarding({ descriptors: [] })

    await expect(context.subject.discover({ name: 'tracker', command: [...COMMAND], tokenEnv: null }))
      .rejects.toMatchObject({ reason: 'NO_TOOLS' })
  })
})

describe('approval', () => {
  it('records the approved server so the next start can load it', async () => {
    const context = onboarding()
    const draft = await context.subject.discover({
      name: 'tracker', command: [...COMMAND], tokenEnv: 'TRACKER_TOKEN',
    })

    context.subject.approve(draft)

    expect(context.manifest().servers).toEqual([expect.objectContaining({
      name: 'tracker',
      transport: 'stdio',
      command: COMMAND,
      pin: 'tracker-mcp@2.1.0',
      tokenEnv: 'TRACKER_TOKEN',
      status: 'active',
    })])
    // The hash and the descriptors that produced it travel together — the
    // rug-pull card needs the approved side to compare against.
    const [entry] = context.manifest().servers
    expect(entry?.['descriptorHash']).toBe(draft.descriptorHash)
    expect(entry?.['descriptors']).toHaveLength(1)
  })

  it('never writes a legacy-era approval on the operator’s behalf', async () => {
    const context = onboarding()
    const draft = await context.subject.discover({ name: 'tracker', command: [...COMMAND], tokenEnv: null })

    context.subject.approve(draft)

    expect(context.manifest().servers[0]).not.toHaveProperty('legacyProtocol')
  })
})
