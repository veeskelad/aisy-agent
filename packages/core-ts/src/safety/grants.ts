// Scoped approval grant store (ADR-0047).
//
// Remembers "session" / "always" approvals per base tool so repeated low-risk
// actions stop prompting. Session grants are in-memory (process lifetime);
// always grants are persisted via an injected port. This store ONLY answers
// "is this tool granted" — the safety verdict layer decides whether a grant is
// allowed to suppress a card (never for Tier-3, never over a deny).

import type { GrantScope, GrantStore, GrantPersistencePort } from './types.js'

export interface GrantStoreDeps {
  /** Persistence for always grants. Absent ⇒ always grants are in-memory only. */
  persistence?: GrantPersistencePort
}

export function makeGrantStore(deps: GrantStoreDeps = {}): GrantStore {
  const session = new Set<string>()
  const always = new Set<string>(deps.persistence?.loadAlways() ?? [])

  const persist = (): void => deps.persistence?.saveAlways([...always])

  return {
    has(tool: string): boolean {
      return session.has(tool) || always.has(tool)
    },

    record(tool: string, scope: GrantScope): void {
      if (scope === 'always') {
        // Promote: an always grant supersedes a session grant for the tool.
        session.delete(tool)
        if (!always.has(tool)) {
          always.add(tool)
          persist()
        }
        return
      }
      // session: skip if already covered by a durable always grant.
      if (!always.has(tool)) session.add(tool)
    },

    revoke(tool: string): void {
      session.delete(tool)
      if (always.delete(tool)) persist()
    },

    revokeAll(): void {
      session.clear()
      if (always.size > 0) {
        always.clear()
        persist()
      }
    },

    list(): { tool: string; scope: GrantScope }[] {
      const out: { tool: string; scope: GrantScope }[] = []
      for (const t of always) out.push({ tool: t, scope: 'always' })
      for (const t of session) if (!always.has(t)) out.push({ tool: t, scope: 'session' })
      return out
    },
  }
}
