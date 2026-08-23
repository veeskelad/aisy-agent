// Tier-7 Phase E — parse the mode token from /goal commands.
// Kept in its own module so it can be unit-tested independently of the bin.

import type { GoalMode, VerificationTrace } from '@aisy/core'

// ---------------------------------------------------------------------------
// parseProbe — inline duplicate of the helper in aisy.ts (not exported there).
// file:<path> or http:<url>; returns null on parse failure.
// ---------------------------------------------------------------------------

function parseProbe(p: string): VerificationTrace | null {
  if (p.startsWith('file:')) {
    const path = p.slice('file:'.length)
    if (!path) return null
    return { kind: 'file', path, existsExpected: true }
  }
  if (p.startsWith('http:')) {
    const url = p.slice('http:'.length)
    if (!url) return null
    return { kind: 'http', method: 'GET', url, expectStatus: 200 }
  }
  return null
}

// ---------------------------------------------------------------------------
// parseGoalMode — converts the raw trailing token to a GoalMode, or null.
//
// Accepted forms:
//   'until'             → { kind:'until' }
//   'until:<probe>'     → { kind:'until', probe: ... } or null on bad probe
//   'every:<spec>'      → { kind:'every', intervalMs } — relative: 10m/2h/1d,
//                          named: @hourly/@daily
//   'budget:<n>'        → { kind:'budget', dollarCeiling } if n contains '.',
//                          else { kind:'budget', tokenCeiling: Number(n) }
// ---------------------------------------------------------------------------

export function parseGoalMode(raw: string): GoalMode | null {
  if (raw === 'until') return { kind: 'until' }

  if (raw.startsWith('until:')) {
    const after = raw.slice('until:'.length)
    const probe = parseProbe(after)
    if (probe === null) return null
    return { kind: 'until', probe }
  }

  if (raw.startsWith('every:')) {
    const spec = raw.slice('every:'.length)
    if (spec === '@hourly') return { kind: 'every', intervalMs: 3_600_000 }
    if (spec === '@daily')  return { kind: 'every', intervalMs: 86_400_000 }
    const rel = /^(\d+)(m|h|d)$/.exec(spec)
    if (rel) {
      const n = Number(rel[1])
      const unit = rel[2]!
      const intervalMs = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000
      return { kind: 'every', intervalMs }
    }
    return null
  }

  if (raw.startsWith('budget:')) {
    const n = raw.slice('budget:'.length)
    if (!n) return null
    const parsed = Number(n)
    if (isNaN(parsed)) return null
    if (n.includes('.')) return { kind: 'budget', dollarCeiling: parsed }
    return { kind: 'budget', tokenCeiling: parsed }
  }

  return null
}
