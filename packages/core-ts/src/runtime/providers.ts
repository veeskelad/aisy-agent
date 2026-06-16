// Provider catalog + factory (runtime).
//
// One place that enumerates supported providers and builds the right adapter by
// kind. Most providers are OpenAI-compatible (one HTTP adapter); Anthropic has a
// native adapter; CLI providers shell out. All implement the agent-loop's
// ProviderAdapter.complete. makeTieredProvider maps reasoning/critique/routine to
// (possibly different) adapters behind one complete() — single-model ⇒ all equal.

import type { ProviderAdapter } from '../agent-loop/types.js'
import type { RouteTier } from '../provider/types.js'
import { makeAnthropicProvider, type AnthropicTool } from './provider-anthropic.js'
import { makeOpenAICompatProvider, type ModelPrice } from './provider-openai.js'
import { makeCliProvider } from './provider-cli.js'

export type ProviderKind = 'anthropic' | 'openai-compat' | 'cli'

export interface ProviderEntry {
  id: string
  label: string
  kind: ProviderKind
  /** OpenAI-compat default base URL (custom entries leave this unset). */
  defaultBaseUrl?: string
  /** Vault/env key name; absent for CLI providers (no API key). */
  keyEnv?: string
  defaultModels?: string[]
  /** argv for CLI providers. */
  cliCommand?: string[]
}

export const PROVIDER_CATALOG: readonly ProviderEntry[] = [
  { id: 'anthropic', label: 'Anthropic (Claude API)', kind: 'anthropic', keyEnv: 'AISY_PROVIDER_ANTHROPIC_KEY', defaultModels: ['claude-sonnet-4-6', 'claude-opus-4-8'] },
  { id: 'openai', label: 'OpenAI', kind: 'openai-compat', defaultBaseUrl: 'https://api.openai.com/v1', keyEnv: 'AISY_PROVIDER_OPENAI_KEY' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai-compat', defaultBaseUrl: 'https://api.deepseek.com/v1', keyEnv: 'AISY_PROVIDER_DEEPSEEK_KEY' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai-compat', defaultBaseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'AISY_PROVIDER_OPENROUTER_KEY' },
  { id: 'qwen', label: 'Qwen (DashScope)', kind: 'openai-compat', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyEnv: 'AISY_PROVIDER_QWEN_KEY' },
  { id: 'glm', label: 'GLM (Zhipu)', kind: 'openai-compat', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'AISY_PROVIDER_GLM_KEY' },
  { id: 'gemini', label: 'Gemini (OpenAI-compat)', kind: 'openai-compat', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'AISY_PROVIDER_GEMINI_KEY' },
  { id: 'openai-compat', label: 'Custom (OpenAI-compatible)', kind: 'openai-compat', keyEnv: 'AISY_PROVIDER_CUSTOM_KEY' },
  { id: 'claude-cli', label: 'Claude CLI (subprocess, no key)', kind: 'cli', cliCommand: ['claude', '-p'] },
]

export function findProvider(id: string): ProviderEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id)
}

export interface BuildProviderConfig {
  provider: string
  model: string
  apiKey?: string
  baseUrl?: string
  tools?: AnthropicTool[]
  price?: ModelPrice
}

/** Build a single ProviderAdapter from a catalog id + config. */
export function buildProvider(cfg: BuildProviderConfig): ProviderAdapter {
  const entry = findProvider(cfg.provider)
  if (!entry) throw new Error(`unknown provider: ${cfg.provider}`)

  switch (entry.kind) {
    case 'anthropic':
      return makeAnthropicProvider({
        apiKey: cfg.apiKey ?? '',
        model: cfg.model,
        ...(cfg.tools ? { tools: cfg.tools } : {}),
        ...(cfg.baseUrl ? { apiBase: cfg.baseUrl } : {}),
      })
    case 'openai-compat': {
      const baseUrl = cfg.baseUrl ?? entry.defaultBaseUrl
      if (!baseUrl) throw new Error(`provider ${cfg.provider} needs a baseUrl`)
      return makeOpenAICompatProvider({
        apiKey: cfg.apiKey ?? '',
        model: cfg.model,
        baseUrl,
        ...(cfg.tools ? { tools: cfg.tools } : {}),
        ...(cfg.price ? { price: cfg.price } : {}),
      })
    }
    case 'cli':
      return makeCliProvider({
        command: entry.cliCommand ?? ['claude', '-p'],
        ...(cfg.model ? { model: cfg.model } : {}),
      })
  }
}

export type TierAdapters = Record<RouteTier, ProviderAdapter>

/**
 * Wrap per-tier adapters behind one complete(): classify the request → delegate.
 * With a single model, pass the same adapter for all tiers (classify is moot).
 */
export function makeTieredProvider(
  byTier: TierAdapters,
  classify?: (req: Parameters<ProviderAdapter['complete']>[0]) => RouteTier,
): ProviderAdapter {
  const pick = classify ?? ((): RouteTier => 'reasoning')
  return {
    complete: (req) => byTier[pick(req)].complete(req),
  }
}
