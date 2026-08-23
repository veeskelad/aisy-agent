import { describe, expect, it, vi } from 'vitest'

import type { BrainEvent, BrainTurn } from '../onboarding/brain-connections.js'
import {
  CLAUDE_CODE_PROTOCOL_PROFILE,
  CLAUDE_CODE_SUPPORTED_VERSION,
  type ClaudeSubscriptionAuth,
} from './claude-auth.js'
import {
  buildClaudeCodeRunArgs,
  ClaudeCodeDriverError,
  makeClaudeCodePreviewDriver,
  type ClaudeCodeProcessSession,
  type ClaudeCodeSessionStore,
} from './claude-code-driver.js'

const UPSTREAM = '00000000-0000-4000-8000-000000000001'
const OPERATION = '00000000-0000-4000-8000-000000000002'
const EVENT_IDS = Array.from({ length: 12 }, (_, index) =>
  `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)

const auth: ClaudeSubscriptionAuth = {
  detect: async () => ({ installed: true, version: CLAUDE_CODE_SUPPORTED_VERSION }),
  beginAuth: () => ({
    kind: 'browser',
    authorizationUri: 'https://claude.ai/',
    safeInstructions: 'manual',
  }),
  validate: async () => ({ ok: true, safeDetail: 'ready' }),
}

function turn(): BrainTurn {
  return {
    projectId: 'project-a',
    sessionId: 'session-a',
    request: {
      sessionId: 'session-a',
      prefixBytes: new TextEncoder().encode('immutable'),
      spans: [{ role: 'user', provenance: 'operator', text: 'hello' }],
    },
  }
}

function validEvents(reply = 'answer'): unknown[] {
  let id = 1
  const messageId = 'msg_000000000000000000000001'
  const outer = (value: Record<string, unknown>) => ({
    ...value,
    session_id: UPSTREAM,
    uuid: EVENT_IDS[id++],
  })
  return [
    {
      type: 'system', subtype: 'init', session_id: UPSTREAM,
      uuid: EVENT_IDS[0], cwd: '/private/project', model: 'claude-sonnet-4-5',
      permissionMode: 'plan', apiKeySource: 'none', claude_code_version: '2.1.220',
      output_style: 'default', tools: [], mcp_servers: [], plugins: [], plugin_errors: [],
      skills: [], slash_commands: [], agents: [],
    },
    outer({
      type: 'stream_event', parent_tool_use_id: null,
      event: {
        type: 'message_start',
        message: {
          id: messageId, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1 },
        },
      },
    }),
    outer({
      type: 'stream_event', parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    }),
    outer({
      type: 'stream_event', parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
    }),
    outer({
      type: 'stream_event', parent_tool_use_id: null,
      event: { type: 'content_block_stop', index: 0 },
    }),
    outer({
      type: 'stream_event', parent_tool_use_id: null,
      event: {
        type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      },
    }),
    outer({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } }),
    outer({
      type: 'assistant', parent_tool_use_id: null,
      message: {
        id: messageId, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 1 },
      },
    }),
    outer({
      type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: reply,
      duration_ms: 10, duration_api_ms: 8, permission_denials: [],
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 },
      total_cost_usd: 0.01,
    }),
  ]
}

async function collect(
  driver: ReturnType<typeof makeClaudeCodePreviewDriver>,
  signal = new AbortController().signal,
): Promise<BrainEvent[]> {
  const events: BrainEvent[] = []
  for await (const event of driver.run(turn(), signal)) events.push(event)
  return events
}

function harness(events: unknown[] = validEvents(), overrides: {
  auth?: ClaudeSubscriptionAuth
  sessions?: ClaudeCodeSessionStore
  capabilityProfile?: 'smoke-readonly' | 'confined-native' | 'aisy-bridge'
  exitCode?: number
  terminationError?: Error
  afterEvent?: (index: number) => void
} = {}) {
  const starts: Array<{ args: readonly string[]; stdin: string; cwd: string; configDir: string }> = []
  let completed = 0
  let quarantined = 0
  let began = 0
  const session: ClaudeCodeProcessSession = {
    async *events() {
      for (const [index, event] of events.entries()) {
        yield structuredClone(event)
        overrides.afterEvent?.(index)
      }
    },
    completion: Promise.resolve({ exitCode: overrides.exitCode ?? 0, signal: null }),
    terminate: vi.fn(async () => {
      if (overrides.terminationError) throw overrides.terminationError
    }),
  }
  const sessions: ClaudeCodeSessionStore = overrides.sessions ?? {
    async beginTurn(value) {
      began++
      return {
        projectId: value.projectId,
        sessionId: value.sessionId,
        upstreamSessionId: value.proposedUpstreamSessionId,
        operationId: value.proposedOperationId,
        protocolProfile: value.protocolProfile,
        capabilityProfile: value.capabilityProfile,
        cwd: value.cwd,
        configDir: value.configDir,
        resume: false,
      }
    },
    async completeTurn() { completed++ },
    async quarantineTurn() { quarantined++ },
  }
  const driver = makeClaudeCodePreviewDriver({
    auth: overrides.auth ?? auth,
    processes: {
      async start(value) { starts.push(value); return session },
    },
    sessions,
    model: 'claude-sonnet-4-5',
    capabilityProfile: overrides.capabilityProfile ?? 'smoke-readonly',
    runtimePaths: () => ({ cwd: '/private/project', configDir: '/private/profile' }),
    uuid: (() => {
      const values = [UPSTREAM, OPERATION]
      return () => values.shift() ?? UPSTREAM
    })(),
  })
  return {
    driver, starts,
    get completed() { return completed },
    get quarantined() { return quarantined },
    get began() { return began },
  }
}

describe('Claude Code dormant read-only driver', () => {
  it('streams the pinned toolless protocol and commits before terminal events', async () => {
    const h = harness()
    await expect(collect(h.driver)).resolves.toEqual([
      { type: 'started' },
      { type: 'thinking' },
      { type: 'text-delta', text: 'answer' },
      { type: 'usage', inputTokens: 4, outputTokens: 2, dollars: 0.01 },
      { type: 'completed', reply: 'answer' },
    ])
    expect(h.completed).toBe(1)
    expect(h.quarantined).toBe(0)
    expect(h.starts).toHaveLength(1)
    expect(h.starts[0]?.args).toEqual(buildClaudeCodeRunArgs({
      capabilityProfile: 'smoke-readonly',
      model: 'claude-sonnet-4-5',
      upstreamSessionId: UPSTREAM,
      resume: false,
    }))
    expect(h.starts[0]?.args).toEqual([
      '--safe-mode', '-p', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--max-turns', '1', '--permission-mode', 'plan',
      '--tools', '', '--disallowed-tools',
      'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task,Agent,Skill',
      '--disable-slash-commands', '--no-chrome', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--model', 'claude-sonnet-4-5',
      '--session-id', UPSTREAM,
    ])
    expect(h.starts[0]?.stdin).toBe('System:\nimmutable\n\nuser:\nhello')
  })

  it.each(['confined-native', 'aisy-bridge'] as const)(
    'rejects future profile %s before auth, store, and process I/O',
    async capabilityProfile => {
      const detect = vi.fn(auth.detect)
      const h = harness(validEvents(), { auth: { ...auth, detect }, capabilityProfile })
      await expect(collect(h.driver)).resolves.toEqual([{
        type: 'failed',
        errorCode: 'CLAUDE_ACTION_TURN_UNSUPPORTED',
        safeDetail: 'Claude action turns require an Aisy-owned capability bridge.',
      }])
      expect(detect).not.toHaveBeenCalled()
      expect(h.began).toBe(0)
      expect(h.starts).toHaveLength(0)
    },
  )

  it('rejects any init-time native capability and quarantines the exact lease', async () => {
    const events = validEvents()
    events[0] = { ...(events[0] as object), tools: ['Read'] }
    const h = harness(events)
    const result = await collect(h.driver)
    expect(result.at(-1)).toMatchObject({ type: 'failed', errorCode: 'CLAUDE_ISOLATION_FAILED' })
    expect(h.completed).toBe(0)
    expect(h.quarantined).toBe(1)
  })

  it('rejects a native tool block even if the CLI flags drift upstream', async () => {
    const events = validEvents()
    events[2] = {
      ...(events[2] as Record<string, unknown>),
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Read' } },
    }
    const h = harness(events)
    const result = await collect(h.driver)
    expect(result.at(-1)).toMatchObject({
      type: 'failed', errorCode: 'CLAUDE_NATIVE_CAPABILITY_REJECTED',
    })
    expect(h.quarantined).toBe(1)
  })

  it('does not emit completed when process completion or durable commit fails', async () => {
    const failedProcess = harness(validEvents(), { exitCode: 9 })
    const processEvents = await collect(failedProcess.driver)
    expect(processEvents.some(event => event.type === 'completed')).toBe(false)
    expect(processEvents.at(-1)).toMatchObject({ type: 'failed', errorCode: 'CLAUDE_PROCESS_FAILED' })

    const base = harness().driver
    void base
    const store: ClaudeCodeSessionStore = {
      async beginTurn(value) {
        return {
          projectId: value.projectId, sessionId: value.sessionId,
          upstreamSessionId: value.proposedUpstreamSessionId,
          operationId: value.proposedOperationId,
          protocolProfile: CLAUDE_CODE_PROTOCOL_PROFILE,
          capabilityProfile: value.capabilityProfile,
          cwd: value.cwd, configDir: value.configDir, resume: false,
        }
      },
      async completeTurn() { throw new Error('private store detail') },
      async quarantineTurn() {},
    }
    const commitFailure = harness(validEvents(), { sessions: store })
    const commitEvents = await collect(commitFailure.driver)
    expect(commitEvents.some(event => event.type === 'completed')).toBe(false)
    expect(JSON.stringify(commitEvents)).not.toContain('private store detail')
  })

  it.each([
    new Error('private supervisor failure'),
    new ClaudeCodeDriverError('CLAUDE_TERMINATION_UNCONFIRMED'),
  ])('maps any termination rejection to unconfirmed and quarantines the turn', async terminationError => {
    const events = validEvents()
    events[2] = { type: 'unexpected' }
    const h = harness(events, {
      terminationError,
    })
    expect((await collect(h.driver)).at(-1)).toEqual({
      type: 'failed',
      errorCode: 'CLAUDE_TERMINATION_UNCONFIRMED',
      safeDetail: 'Claude Code process termination could not be confirmed.',
    })
    expect(h.completed).toBe(0)
    expect(h.quarantined).toBe(1)
  })

  it('rejects duplicate event identity and unsupported runtime versions', async () => {
    const events = validEvents()
    ;(events[3] as Record<string, unknown>).uuid = (events[2] as Record<string, unknown>).uuid
    const duplicate = harness(events)
    expect((await collect(duplicate.driver)).at(-1)).toMatchObject({
      type: 'failed', errorCode: 'CLAUDE_EVENT_SEQUENCE_REJECTED',
    })

    const unsupported = harness(validEvents(), {
      auth: { ...auth, detect: async () => ({ installed: true, version: '2.1.221 (Claude Code)' }) },
    })
    await expect(collect(unsupported.driver)).resolves.toEqual([{
      type: 'failed', errorCode: 'CLAUDE_RUNTIME_UNSUPPORTED',
      safeDetail: 'Claude Code runtime version is not supported.',
    }])
  })

  it.each([
    ['subscription source', (events: unknown[]) => { (events[0] as Record<string, unknown>).apiKeySource = 'user' }, 'CLAUDE_ISOLATION_FAILED'],
    ['wire version', (events: unknown[]) => { (events[0] as Record<string, unknown>).claude_code_version = '2.1.221' }, 'CLAUDE_ISOLATION_FAILED'],
    ['working directory', (events: unknown[]) => { (events[0] as Record<string, unknown>).cwd = '/foreign' }, 'CLAUDE_ISOLATION_FAILED'],
    ['model', (events: unknown[]) => { (events[0] as Record<string, unknown>).model = 'foreign-model' }, 'CLAUDE_ISOLATION_FAILED'],
    ['permission mode', (events: unknown[]) => { (events[0] as Record<string, unknown>).permissionMode = 'default' }, 'CLAUDE_ISOLATION_FAILED'],
    ['skills', (events: unknown[]) => { (events[0] as Record<string, unknown>).skills = ['foreign'] }, 'CLAUDE_ISOLATION_FAILED'],
    ['slash commands', (events: unknown[]) => { (events[0] as Record<string, unknown>).slash_commands = ['status'] }, 'CLAUDE_ISOLATION_FAILED'],
    ['init UUID replay', (events: unknown[]) => {
      ;(events[1] as Record<string, unknown>).uuid = (events[0] as Record<string, unknown>).uuid
    }, 'CLAUDE_EVENT_SEQUENCE_REJECTED'],
    ['message start schema', (events: unknown[]) => {
      ;((events[1] as Record<string, unknown>).event as Record<string, unknown>).message = {}
    }, 'CLAUDE_EVENT_SEQUENCE_REJECTED'],
    ['message delta stop', (events: unknown[]) => {
      const event = (events[5] as Record<string, unknown>).event as Record<string, unknown>
      ;(event.delta as Record<string, unknown>).stop_reason = 'tool_use'
    }, 'CLAUDE_EVENT_SEQUENCE_REJECTED'],
    ['assistant origin', (events: unknown[]) => {
      ;(events[7] as Record<string, unknown>).parent_tool_use_id = 'foreign-tool'
    }, 'CLAUDE_EVENT_SEQUENCE_REJECTED'],
    ['assistant terminal stop', (events: unknown[]) => {
      const message = (events[7] as Record<string, unknown>).message as Record<string, unknown>
      message.stop_reason = 'max_tokens'
    }, 'CLAUDE_EVENT_SEQUENCE_REJECTED'],
    ['result permission denial', (events: unknown[]) => {
      ;(events[8] as Record<string, unknown>).permission_denials = [{ tool_name: 'Read' }]
    }, 'CLAUDE_EVENT_SEQUENCE_REJECTED'],
    ['result stop_reason', (events: unknown[]) => {
      ;(events[8] as Record<string, unknown>).stop_reason = 'end_turn'
    }, 'CLAUDE_EVENT_SEQUENCE_REJECTED'],
    ['result terminal_reason', (events: unknown[]) => {
      ;(events[8] as Record<string, unknown>).terminal_reason = 'end_turn'
    }, 'CLAUDE_EVENT_SEQUENCE_REJECTED'],
    ['result origin', (events: unknown[]) => {
      ;(events[8] as Record<string, unknown>).origin = 'interactive'
    }, 'CLAUDE_EVENT_SEQUENCE_REJECTED'],
    ['result deferred_tool_use', (events: unknown[]) => {
      ;(events[8] as Record<string, unknown>).deferred_tool_use = false
    }, 'CLAUDE_EVENT_SEQUENCE_REJECTED'],
    ['result modelUsage', (events: unknown[]) => {
      ;(events[8] as Record<string, unknown>).modelUsage = {}
    }, 'CLAUDE_EVENT_SEQUENCE_REJECTED'],
    ['result fast_mode_state', (events: unknown[]) => {
      ;(events[8] as Record<string, unknown>).fast_mode_state = 'off'
    }, 'CLAUDE_EVENT_SEQUENCE_REJECTED'],
    ['event after terminal', (events: unknown[]) => { events.push({ type: 'unexpected' }) }, 'CLAUDE_EVENT_SEQUENCE_REJECTED'],
  ] as const)('rejects pinned protocol drift in %s', async (_name, mutate, errorCode) => {
    const events = validEvents()
    mutate(events)
    expect((await collect(harness(events).driver)).at(-1)).toMatchObject({ type: 'failed', errorCode })
  })

  it('quarantines a turn interrupted after process I/O starts', async () => {
    const controller = new AbortController()
    const h = harness(validEvents(), {
      afterEvent(index) { if (index === 0) controller.abort() },
    })
    const events = await collect(h.driver, controller.signal)
    expect(events).toEqual([
      { type: 'started' },
      { type: 'failed', errorCode: 'CLAUDE_INTERRUPTED', safeDetail: 'Claude Code turn was interrupted.' },
    ])
    expect(h.completed).toBe(0)
    expect(h.quarantined).toBe(1)
  })

  it('builds only the implemented profile', () => {
    expect(buildClaudeCodeRunArgs({
      capabilityProfile: 'aisy-bridge', model: 'claude-sonnet-4-5',
      upstreamSessionId: UPSTREAM, resume: false,
    })).toEqual(new ClaudeCodeDriverError('CLAUDE_ACTION_TURN_UNSUPPORTED'))
  })
})
