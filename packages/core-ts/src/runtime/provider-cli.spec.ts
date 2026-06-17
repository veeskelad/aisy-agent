import { describe, it, expect } from 'vitest'
import { makeCliProvider, promptFromSpans } from './provider-cli.js'
import type { ContextSpan, ModelRequest } from '../agent-loop/types.js'

function span(role: ContextSpan['role'], text: string): ContextSpan {
  return { role, text, provenance: 'operator' }
}
function req(spans: ContextSpan[]): ModelRequest {
  return { sessionId: 's', prefixBytes: new Uint8Array(), spans }
}

describe('promptFromSpans', () => {
  it('renders a role-labelled transcript', () => {
    const p = promptFromSpans([span('system', 'be nice'), span('user', 'hi')], '')
    expect(p).toBe('System: be nice\n\nUser: hi')
  })

  it('prepends the prefix', () => {
    expect(promptFromSpans([span('user', 'hi')], 'CTX')).toBe('CTX\n\nUser: hi')
  })
})

describe('makeCliProvider.complete', () => {
  it('runs the command with the prompt on stdin and returns stdout as reply', async () => {
    const seen: { argv: string[]; input: string }[] = []
    const provider = makeCliProvider({
      command: ['claude', '-p'],
      run: async (argv, input) => {
        seen.push({ argv, input })
        return { stdout: '  the answer\n', exitCode: 0 }
      },
    })
    const res = await provider.complete(req([span('user', 'question')]))
    expect(res.reply).toBe('the answer')
    expect(res.toolCalls).toBeUndefined()
    expect(seen[0]!.argv).toEqual(['claude', '-p'])
    expect(seen[0]!.input).toContain('User: question')
  })

  it('appends --model when configured', async () => {
    const seen: string[][] = []
    const provider = makeCliProvider({
      command: ['claude', '-p'],
      model: 'opus',
      run: async (argv) => {
        seen.push(argv)
        return { stdout: 'ok', exitCode: 0 }
      },
    })
    await provider.complete(req([span('user', 'x')]))
    expect(seen[0]).toEqual(['claude', '-p', '--model', 'opus'])
  })

  it('throws a ProviderError on a non-zero exit', async () => {
    const provider = makeCliProvider({
      command: ['claude'],
      run: async () => ({ stdout: '', exitCode: 1 }),
    })
    await expect(provider.complete(req([span('user', 'x')]))).rejects.toMatchObject({ kind: 'server-error' })
  })

  it('forwards the abort signal to the injected run', async () => {
    let seen: AbortSignal | undefined
    const p = makeCliProvider({
      command: ['claude', '-p'],
      run: async (_argv, _input, signal) => { seen = signal; return { stdout: 'hi', exitCode: 0 } },
    })
    const controller = new AbortController()
    await p.complete({ sessionId: 's', prefixBytes: new Uint8Array(0), spans: [] }, controller.signal)
    expect(seen).toBe(controller.signal)
  })
})
