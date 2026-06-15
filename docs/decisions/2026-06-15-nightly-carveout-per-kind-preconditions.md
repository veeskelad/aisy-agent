# ADR-0042: NightlyCarveout Per-Kind Preconditions (AC-05-23)

**Status:** Proposed
**Date:** 2026-06-15
**Tags:** safety, nightly, maintenance

## Context

`makeNightlyCarveout` (safety component, `CARVEOUT_KINDS` allowlist) gates
Tier-3 maintenance ops (`vacuum`, `fts5-optimize`, `wal-checkpoint`,
`log-rotation`, `docker-prune`, `worktree-prune`, `git-push-ff`). The current
`isPermitted` check is uniform: every op in the set is allowed as long as
`force !== true` and no `unknown` key exists in params.

AC-05-23 requires *per-kind preconditions* — each op kind may be safe only under
specific conditions (e.g., `vacuum` requires WAL mode off or a prior checkpoint;
`docker-prune` must not run during an active build; `git-push-ff` must confirm
the target branch is fast-forward only). Without per-kind guards, the carveout
is an implicit no-op precondition (always true) which defeats the intent.

The type `NightlyCarveoutDeps.snapshot` is injected but never actually checked
against the op kind — it is called unconditionally before every op regardless of
whether that op is destructive or idempotent.

Options: (a) implement per-kind precondition callbacks, (b) add a
`PRECONDITIONS` map of `NightlyOpKind → (params, deps) => string | null` where
`string` means "failed: reason", (c) remove the type and defer to Nightly
(component 12) which already has judged promotion, (d) document the current
behaviour as deliberately coarse-grained and close AC-05-23 as won't-fix.

## Decision

**Add a `PRECONDITIONS` map (option b) in a follow-on implementation task;
close this ADR as Proposed until that task ships.**

The precondition map will have type:

```typescript
type Precondition = (
  op: NightlyOp,
  deps: NightlyCarveoutDeps
) => string | null   // null = ok, string = blocked reason
```

Initial entries:
- `vacuum`: blocked if `op.params['mode'] === 'truncate'` (risky on WAL).
- `git-push-ff`: blocked if `op.params['remote']` is absent (missing target =
  ambiguous).
- All others: `null` (coarse-grained; refine when a concrete incident motivates).

`snapshot` becomes per-kind: only `vacuum`, `docker-prune`, and `log-rotation`
trigger it; `fts5-optimize`/`wal-checkpoint` are idempotent and don't need
snapshot overhead.

Do NOT remove the type. `NightlyCarveout` is the correct boundary between the
safety layer and the maintenance scheduler; removing it would push per-kind gating
into the nightly component which is already complex enough.

## Consequences

- **Positive:** AC-05-23 is satisfied once the precondition map is implemented;
  `isPermitted` becomes auditable per kind.
- **Positive:** `snapshot` overhead is eliminated for idempotent ops.
- **Neutral:** The `PRECONDITIONS` map must be extended whenever a new
  `NightlyOpKind` is added to `CARVEOUT_KINDS`. Convention: every addition
  requires a comment justifying `null` (coarse-grained) vs a real guard.
- **Negative:** This ADR is Proposed and the implementation is deferred — the
  current production behavior is coarse-grained until the follow-on task ships.

## Alternatives considered

**Option c — defer to Nightly judged-promotion:** Nightly's judge gate (the
`approveStagedItem` fail-closed guard added in B1) governs content promotion, not
maintenance-op safety. These are separate concerns. Mixing them would make the
judge responsible for infrastructure decisions. Rejected.

**Option d — close AC-05-23 as won't-fix:** The carveout is load-bearing for
ADR-0012; coarse-grained preconditions are a known risk. Closing as won't-fix
with documentation is acceptable for now but leaves a concrete gap. Deferred
implementation is preferable to won't-fix.

## References

- AC-05-23 (spec §Eng-13, NightlyCarveout per-kind preconditions)
- [ADR-0012 Tier-3 Maintenance Allowlist](./2026-06-10-tier3-maintenance-allowlist.md) *(if exists)*
- `packages/core-ts/src/safety/index.ts` — `makeNightlyCarveout`, `CARVEOUT_KINDS`
