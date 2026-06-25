// Failover provider adapter (runtime).
//
// Wraps a primary and a fallback ProviderAdapter. On a TRANSIENT error from the
// primary (network, HTTP 5xx, 429, timeout/abort), retries once with the fallback.
// Non-transient errors (4xx client errors, etc.) propagate immediately without
// trying the fallback.

import type { ProviderAdapter, ProviderError } from '../agent-loop/types.js'

/** Returns true when the error is transient and a retry via fallback is worthwhile. */
function isTransient(err: unknown): boolean {
  if (err instanceof Error) {
    const pe = err as Partial<ProviderError>
    if (pe.kind === 'rate-limit' || pe.kind === 'timeout') {
      return true
    }
    // server-error covers both 5xx and 4xx in the adapters. Only fail over on a
    // genuine 5xx, or when there is no HTTP status (network-level throw). A 4xx
    // (bad key, bad request) is the operator's config — retrying the fallback
    // would mask it, so propagate.
    if (pe.kind === 'server-error') {
      return pe.httpStatus === undefined || pe.httpStatus >= 500
    }
    // Network-level errors (DNS, connection refused, etc.) surfaced as plain
    // fetch throws (TypeError: Failed to fetch / ECONNREFUSED) or as AbortError.
    const name = err.name
    if (name === 'TypeError' || name === 'AbortError' || name === 'TimeoutError') {
      return true
    }
  }
  return false
}

/**
 * Wraps `primary` with a one-retry failover to `fallback`.
 *
 * - Primary success → return result, fallback is never called.
 * - Primary TRANSIENT error → call fallback.complete() and return its result.
 * - Primary non-transient error → propagate immediately (fallback NOT called).
 */
export function makeFailoverProvider(
  primary: ProviderAdapter,
  fallback: ProviderAdapter,
): ProviderAdapter {
  return {
    async complete(req, signal) {
      try {
        return await primary.complete(req, signal)
      } catch (err) {
        if (isTransient(err)) {
          return fallback.complete(req, signal)
        }
        throw err
      }
    },
  }
}
