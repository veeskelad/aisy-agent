import { describe, expect, it } from 'vitest'
import {
  NATIVE_API_SECRET_PROXY_REQUIRED,
  nativeApiProviderIds,
} from './native-api-secret-policy.js'

describe('native API production secret policy', () => {
  it('allows only a subscription-only graph', () => {
    expect(nativeApiProviderIds({
      default: { provider: 'claude-subscription', model: 'sonnet' },
      fallback: { provider: 'codex-subscription', model: 'default' },
      agents: {
        main: { provider: 'claude-subscription', model: 'sonnet', budgetUsd: 5 },
      },
    }, { provider: 'claude-subscription', model: 'sonnet' })).toEqual([])
  })

  it('finds native API providers in every executable routing position', () => {
    expect(nativeApiProviderIds({
      default: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      tiers: {
        reasoning: { provider: 'openai', model: 'o3' },
        critique: { provider: 'openrouter', model: 'model' },
        routine: { provider: 'claude-subscription', model: 'haiku' },
      },
      fallback: { provider: 'deepseek', model: 'deepseek-chat' },
      agents: {
        researcher: { provider: 'gemini', model: 'gemini-2.5-pro' },
        partialOverride: { provider: 'qwen' },
        budgetOnly: { budgetUsd: 2 },
      },
    }, { provider: 'anthropic', model: 'claude-sonnet-4-6' })).toEqual([
      'anthropic',
      'deepseek',
      'gemini',
      'openai',
      'openrouter',
    ])
  })

  it('fails unknown providers closed and exposes only a stable public code', () => {
    expect(nativeApiProviderIds({}, { provider: 'unknown-provider', model: 'x' }))
      .toEqual(['unknown-provider'])
    expect(NATIVE_API_SECRET_PROXY_REQUIRED).toBe('NATIVE_API_SECRET_PROXY_REQUIRED')
  })
})
