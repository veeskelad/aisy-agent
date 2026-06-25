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
  { id: 'anthropic', label: 'Anthropic (Claude API)', kind: 'anthropic', keyEnv: 'AISY_PROVIDER_ANTHROPIC_KEY', defaultModels: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] },
  { id: 'openai', label: 'OpenAI', kind: 'openai-compat', defaultBaseUrl: 'https://api.openai.com/v1', keyEnv: 'AISY_PROVIDER_OPENAI_KEY', defaultModels: ['gpt-4o', 'gpt-4.1', 'o3', 'o4-mini'] },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai-compat', defaultBaseUrl: 'https://api.deepseek.com/v1', keyEnv: 'AISY_PROVIDER_DEEPSEEK_KEY', defaultModels: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai-compat', defaultBaseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'AISY_PROVIDER_OPENROUTER_KEY' },
  { id: 'qwen', label: 'Qwen', kind: 'openai-compat', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyEnv: 'AISY_PROVIDER_QWEN_KEY', defaultModels: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  { id: 'glm', label: 'GLM (Zhipu)', kind: 'openai-compat', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'AISY_PROVIDER_GLM_KEY', defaultModels: ['glm-4-plus', 'glm-4'] },
  { id: 'gemini', label: 'Gemini', kind: 'openai-compat', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'AISY_PROVIDER_GEMINI_KEY', defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'] },
  { id: 'openai-compat', label: 'Other — OpenAI-compatible API (you provide the URL)', kind: 'openai-compat', keyEnv: 'AISY_PROVIDER_CUSTOM_KEY' },
  { id: 'claude-cli', label: 'Claude CLI (no API key)', kind: 'cli', cliCommand: ['claude', '-p'] },
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
  /** Emit cache_control breakpoints on system + last message. Default true. */
  prefixCache?: boolean
  /**
   * Injected fetch implementation for testing. Passed through to the underlying
   * adapter when provided (both adapters accept fetchImpl in their deps).
   */
  fetchImpl?: typeof fetch
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
        prefixCache: cfg.prefixCache ?? true,
        ...(cfg.tools ? { tools: cfg.tools } : {}),
        ...(cfg.baseUrl ? { apiBase: cfg.baseUrl } : {}),
        ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
      })
    case 'openai-compat': {
      const baseUrl = cfg.baseUrl ?? entry.defaultBaseUrl
      if (!baseUrl) throw new Error(`provider ${cfg.provider} needs a baseUrl`)
      const cache: 'auto' | 'breakpoints' =
        (cfg.prefixCache ?? true) && entry.id === 'openrouter' ? 'breakpoints' : 'auto'
      return makeOpenAICompatProvider({
        apiKey: cfg.apiKey ?? '',
        model: cfg.model,
        baseUrl,
        cache,
        ...(cfg.tools ? { tools: cfg.tools } : {}),
        ...(cfg.price ? { price: cfg.price } : {}),
        ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
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
    complete: (req, signal) => byTier[pick(req)].complete(req, signal),
  }
}
