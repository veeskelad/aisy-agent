// Minimal probeRunner for trigger watch probes (Tier-4 D1).
// Handles file/http/exit kinds. SQL probes deferred to v2 → always false.
// A probe must never crash the tick — any throw returns false.

import type { VerificationTrace } from '@aisy/core'

export interface TriggerProbeRunnerDeps {
  exists: (p: string) => boolean
  fetchImpl?: typeof fetch
  runBash?: (cmd: string) => Promise<{ exitCode: number }>
}

export function makeTriggerProbeRunner(
  deps: TriggerProbeRunnerDeps,
): (trace: VerificationTrace) => Promise<boolean> {
  return async function probeRunner(trace: VerificationTrace): Promise<boolean> {
    try {
      switch (trace.kind) {
        case 'file':
          return deps.exists(trace.path)

        case 'http': {
          if (!deps.fetchImpl) return false
          try {
            const res = await deps.fetchImpl(trace.url, { method: trace.method })
            return res.status === trace.expectStatus
          } catch {
            return false
          }
        }

        case 'exit': {
          if (!deps.runBash) return false
          const cmd = trace.argv.join(' ')
          const result = await deps.runBash(cmd)
          return result.exitCode === trace.expectCode
        }

        case 'sql':
          // SQL watch probes deferred to v2 — always false
          return false

        default:
          return false
      }
    } catch {
      return false
    }
  }
}
