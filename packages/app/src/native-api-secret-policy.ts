import { findProvider } from '@aisy/core'

export const NATIVE_API_SECRET_PROXY_REQUIRED = 'NATIVE_API_SECRET_PROXY_REQUIRED'

export interface NativeApiProviderSelection {
  provider: string
  model?: string
}

export interface NativeApiProviderConfig {
  default?: NativeApiProviderSelection
  tiers?: Readonly<{
    reasoning: NativeApiProviderSelection
    critique: NativeApiProviderSelection
    routine: NativeApiProviderSelection
  }>
  fallback?: NativeApiProviderSelection
  agents?: Readonly<Record<string, Readonly<{
    provider?: string
    model?: string
    budgetUsd?: number
  }>>>
}

/**
 * Until ADR-0087 has a production broker/backend/proxy, only known CLI-backed
 * subscriptions may enter the live provider graph. A key in legacy config is
 * deliberately not evidence that the opaque secret boundary exists.
 */
export function nativeApiProviderIds(
  config: NativeApiProviderConfig,
  defaultSelection: NativeApiProviderSelection,
): readonly string[] {
  const providers = [
    defaultSelection.provider,
    ...(config.tiers === undefined
      ? []
      : [
          config.tiers.reasoning.provider,
          config.tiers.critique.provider,
          config.tiers.routine.provider,
        ]),
    ...(config.fallback === undefined ? [] : [config.fallback.provider]),
    ...Object.values(config.agents ?? {})
      .flatMap(agent => agent.provider === undefined || agent.model === undefined
        ? []
        : [agent.provider]),
  ]

  return Object.freeze([...new Set(providers
    .filter(provider => findProvider(provider)?.kind !== 'cli'))].sort())
}
