import {
  makeToolExecutor,
  runtimeProviderTools,
  type ExecuteToolDeps,
} from '@aisy/core'

/**
 * Provider-visible tools for the live binary — the whole narrow-waist catalog.
 * `fetch_url` used to be cut out here, because there was no egress that could
 * be pointed at an arbitrary link. There is one now, so the rule is inverted:
 * the tool ships, and the port behind it must be the hardened one.
 */
export function liveProviderTools() {
  const tools = runtimeProviderTools()
  for (const tool of tools) Object.freeze(tool)
  Object.freeze(tools)
  return tools
}

/** The live executor may only be built with a fetch port supplied. */
export type LiveToolExecutorDeps = ExecuteToolDeps & Required<Pick<ExecuteToolDeps, 'fetchUrl'>>

export function makeLiveToolExecutor(deps: LiveToolExecutorDeps) {
  // A runtime check, not just a type: callers written in JavaScript, or using
  // casts, would otherwise build a live executor whose `fetch_url` silently
  // reports "unavailable" — a capability the operator was told exists.
  if (typeof deps.fetchUrl !== 'function') {
    throw new Error('live fetch_url port is required')
  }
  // The executor must not retain a caller-owned object: replacing fetchUrl
  // after construction would otherwise swap the hardened egress for anything.
  const snapshot: LiveToolExecutorDeps = { ...deps }
  if (typeof snapshot.fetchUrl !== 'function') {
    throw new Error('live fetch_url port is required')
  }
  return makeToolExecutor(Object.freeze(snapshot))
}
