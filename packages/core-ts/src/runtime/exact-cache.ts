import { createHash } from 'node:crypto'
import type { ProviderAdapter, ModelRequest, ModelResponse } from '../agent-loop/types.js'

export interface ExactCacheStore {
  get(key: string): ModelResponse | undefined
  set(key: string, value: ModelResponse): void
}

export function makeMemoryExactCacheStore(): ExactCacheStore {
  const m = new Map<string, ModelResponse>()
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) }
}

function keyOf(namespace: string, req: ModelRequest): string {
  const h = createHash('sha256')
  h.update(namespace); h.update('\0')
  h.update(Buffer.from(req.prefixBytes)); h.update('\0')
  h.update(JSON.stringify(req.spans))
  return h.digest('hex')
}

/** Content-addressed exact-response cache. ONLY for deterministic, non-stateful
 *  paths (eval-replay, nightly re-run). NEVER wrap the live agent loop (ADR-0055). */
export function makeExactCache(inner: ProviderAdapter, store: ExactCacheStore, namespace: string): ProviderAdapter {
  return {
    async complete(req, signal) {
      const key = keyOf(namespace, req)
      const hit = store.get(key)
      if (hit) return hit
      const res = await inner.complete(req, signal)
      store.set(key, res)
      return res
    },
  }
}
