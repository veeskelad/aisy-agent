import { describe, expect, it, vi } from 'vitest'

import {
  CLAUDE_CODE_SUPPORTED_VERSION,
  CLAUDE_SUBSCRIPTION_AUTH_INSTRUCTIONS,
  buildClaudeAuthSmokeCommand,
  makeClaudeSubscriptionAuthSpike,
  parseClaudeAuthSmoke,
} from './claude-auth.js'

describe('Claude subscription authentication boundary', () => {
  it('returns only a manual official login instruction for the dedicated profile', () => {
    const auth = makeClaudeSubscriptionAuthSpike({
      run: async () => ({ exitCode: 0, output: CLAUDE_CODE_SUPPORTED_VERSION }),
    })
    expect(auth.beginAuth()).toEqual({
      kind: 'browser',
      authorizationUri: 'https://claude.ai/',
      safeInstructions: CLAUDE_SUBSCRIPTION_AUTH_INSTRUCTIONS,
    })
    expect(CLAUDE_SUBSCRIPTION_AUTH_INSTRUCTIONS).toContain('CLAUDE_CONFIG_DIR')
    expect(CLAUDE_SUBSCRIPTION_AUTH_INSTRUCTIONS).toContain('`auth login`')
    expect(CLAUDE_SUBSCRIPTION_AUTH_INSTRUCTIONS).not.toContain('--claudeai')
    expect(CLAUDE_SUBSCRIPTION_AUTH_INSTRUCTIONS).not.toMatch(/setup-token/i)
  })

  it('builds an exact one-turn, toolless, empty-MCP smoke command', () => {
    const argv = buildClaudeAuthSmokeCommand()
    expect(argv.slice(0, 3)).toEqual(['claude', '--safe-mode', '-p'])
    expect(argv).toContain('json')
    expect(argv).toContain('plan')
    expect(argv).toContain('--tools')
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv).toContain('{"mcpServers":{}}')
    expect(argv).toContain('--no-session-persistence')
    expect(argv.join(' ')).not.toContain('dangerously-skip-permissions')
    expect(argv).toEqual([
      'claude', '--safe-mode', '-p',
      'Reply with exactly AISY_CLAUDE_AUTH_OK. Do not inspect files and do not call tools.',
      '--output-format', 'json', '--max-turns', '1', '--permission-mode', 'plan',
      '--tools', '', '--disallowed-tools',
      'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task,Agent,Skill',
      '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ])
  })

  it('accepts only a successful one-turn result with the exact marker', () => {
    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'AISY_CLAUDE_AUTH_OK',
      num_turns: 1,
      session_id: 'opaque-session',
    })
    expect(parseClaudeAuthSmoke({ exitCode: 0, output })).toEqual({
      ok: true,
      safeDetail: 'Claude Code subscription authentication is active.',
    })
    expect(parseClaudeAuthSmoke({ exitCode: 0, output: output.replace('num_turns":1', 'num_turns":2') }).ok)
      .toBe(false)
  })

  it('fails closed without returning raw CLI output', () => {
    const raw = 'local account detail that must not surface'
    const result = parseClaudeAuthSmoke({ exitCode: 0, output: raw })
    expect(result.errorCode).toBe('CLAUDE_SMOKE_INVALID_JSON')
    expect(JSON.stringify(result)).not.toContain(raw)
    expect(parseClaudeAuthSmoke({ exitCode: 0, output: 'x'.repeat(16 * 1024 + 1) }).errorCode)
      .toBe('CLAUDE_SMOKE_OUTPUT_REJECTED')
  })

  it('accepts only the exact pinned version', async () => {
    const exact = makeClaudeSubscriptionAuthSpike({
      run: async () => ({ exitCode: 0, output: `${CLAUDE_CODE_SUPPORTED_VERSION}\n` }),
    })
    await expect(exact.detect()).resolves.toEqual({
      installed: true,
      version: CLAUDE_CODE_SUPPORTED_VERSION,
    })
    const other = makeClaudeSubscriptionAuthSpike({
      run: async () => ({ exitCode: 0, output: '2.1.221 (Claude Code)' }),
    })
    await expect(other.detect()).resolves.toEqual({ installed: true, version: '2.1.221 (Claude Code)' })
  })

  it('uses auth status exit semantics and discards its undocumented JSON fields', async () => {
    const run = vi.fn(async (_command: string, _args: string[]) => ({
      exitCode: 0,
      output: JSON.stringify({ futureField: { ignored: true } }),
    }))
    const auth = makeClaudeSubscriptionAuthSpike({ run })
    await expect(auth.validate()).resolves.toEqual({
      ok: true,
      safeDetail: 'Claude Code authentication is active.',
    })
    expect(run).toHaveBeenCalledWith('claude', ['auth', 'status'])

    const absent = makeClaudeSubscriptionAuthSpike({
      run: async () => ({ exitCode: 1, output: '{"detail":"must not surface"}' }),
    })
    await expect(absent.validate()).resolves.toMatchObject({
      ok: false,
      errorCode: 'CLAUDE_NOT_AUTHENTICATED',
    })
    const malformed = makeClaudeSubscriptionAuthSpike({
      run: async () => ({ exitCode: 0, output: 'private malformed output' }),
    })
    const result = await malformed.validate()
    expect(result.errorCode).toBe('CLAUDE_AUTH_STATUS_INVALID')
    expect(JSON.stringify(result)).not.toContain('private malformed output')
  })
})
