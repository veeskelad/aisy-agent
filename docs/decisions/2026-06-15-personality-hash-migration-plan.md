# ADR-0043: Personality SHA-256 Domain-Separator and Hash Migration Plan

**Status:** Proposed
**Date:** 2026-06-15
**Tags:** personality, security, migration

## Context

The personality component hashes each constitution+soul concatenation with a
bare SHA-256 (`createHash('sha256').update(input).digest('hex')`) to produce
the identity fingerprint (spec §4.3, ADR-0004). No domain separator prefixes
the input; the raw bytes of the constitution text are fed directly to the hash.

This creates two risks:
1. **Cross-context collision:** a sha256 computed over a constitution could
   theoretically collide with a sha256 computed over a different data type
   (e.g., a memory-fact payload or an agent-card id) if those ever appear in the
   same verification surface. Without domain separation, the type of the hashed
   value is not encoded.
2. **No migration path:** if the hash algorithm must change (e.g., SHA-256 is
   deprecated in a future FIPS revision, or we want a keyed HMAC for intra-node
   verification), all stored fingerprints become stale with no way for a reader
   to know which algorithm produced them.

The B1 review classified this as a DECISION because: (a) adding a domain
separator is a breaking change to existing stored fingerprints; (b) a migration
plan is an architectural choice, not a bug fix.

## Decision

**Add a `hashVersion` field to the constitution fingerprint record, and prefix
the SHA-256 input with a domain separator starting from `hashVersion: 2`.**

Schema (stored alongside the fingerprint):
```typescript
interface ConstitutionFingerprint {
  digest: string;      // hex SHA-256
  hashVersion: 1 | 2; // 1 = legacy bare, 2 = domain-separated
}
```

Domain separator for v2: `"aisy.personality.constitution:v2:"` prepended to
the UTF-8 bytes before hashing. Example:
```
sha256("aisy.personality.constitution:v2:" + constitutionText + soulText)
```

Migration:
- `makePersonality` reads stored fingerprints. If `hashVersion` is absent or
  `1`, it re-computes under v2 and stores both (grace period of one boot).
- After the grace period, failing to match v2 raises `ConstitutionError`.
- New installations start at v2 directly.

This ADR does NOT change the current code immediately. Implementation happens in
a follow-on task that can be scheduled independently of the personality component
freeze.

## Consequences

- **Positive:** Cross-context collision risk is eliminated; a sha256 over
  constitution text is unambiguous.
- **Positive:** Future algorithm migration has a versioned path; `hashVersion`
  can be extended to `3` without breaking deployed instances.
- **Neutral:** One-boot grace-period re-computation adds ~1 ms startup cost for
  migrating instances (constitution text is small; SHA-256 is fast).
- **Negative:** Stored fingerprints at `hashVersion: 1` (all current
  deployments) must be migrated; any deployment that reads a v2 fingerprint
  with an old binary will raise `ConstitutionError` until upgraded.

## Alternatives considered

**HMAC instead of SHA-256:** Provides authentication in addition to collision
resistance but requires key management. Out of scope for the current single-user
model — a local secret adds complexity without a network attacker to stop.
Deferred; `hashVersion: 3` can introduce HMAC later.

**No domain separator, add only `hashVersion`:** Records the algorithm in use
but doesn't prevent cross-context collisions. Partial fix. Rejected.

**Leave bare SHA-256 as-is:** Low concrete risk today (no other component hashes
the same text). Acceptable as a won't-fix, but the migration path gets harder
as more fingerprints accumulate. Rejected given low migration cost.

## References

- ADR-0004 (Constitution integrity and identity fingerprint)
- Spec §4.3 (personality/identity fingerprint)
- `packages/core-ts/src/personality/index.ts` — `sha256()` at line ~70
- NIST SP 800-107 §6 (domain separation for SHA family)
