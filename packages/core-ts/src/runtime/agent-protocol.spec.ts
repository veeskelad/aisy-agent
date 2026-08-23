import { describe, expect, it } from 'vitest'
import { AGENT_PROTOCOL } from './agent-protocol.js'

describe('AGENT_PROTOCOL network guidance', () => {
  it('directs the agent to web_search without advertising disabled fetch_url', () => {
    expect(AGENT_PROTOCOL).toContain('web_search')
    expect(AGENT_PROTOCOL).not.toContain('fetch_url')
  })
})
