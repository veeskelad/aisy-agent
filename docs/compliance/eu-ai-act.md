# EU AI Act — Aisy Operator-Obligation Mapping

This page maps Aisy's harness to the operator (deployer) obligations of the EU AI Act,
whose relevant provisions become applicable **August 2026**. It records, per obligation,
where Aisy meets it today and where a gap remains.

> **Not legal advice.** This is an engineering self-assessment for planning purposes only;
> it is not a legal opinion and does not establish conformity. Confirm applicability and
> sufficiency with qualified counsel before relying on it.

## Mapping

| Operator obligation | Status | Where in Aisy |
|---|---|---|
| Immutable trace / event logs | ✅ covered | [Component 12 Observability](../specs/12-observability-verification.md) — hash-chained append-only journal |
| Approval records (who / when / on what basis) | ✅ covered | [Component 02 Gateway](../specs/02-gateway-connectivity.md) approval cards + [Component 05 Safety](../specs/05-safety.md) approval handler (who/when/basis bound to each tap) |
| PII / secret masking at ingestion | ✅ covered | [Component 05 Safety](../specs/05-safety.md) — deterministic redaction at ingestion |
| Sandbox & credential-boundary documentation | ✅ covered | [Component 05 Safety](../specs/05-safety.md) / [ADR-0012](../decisions/2026-06-11-docker-sandbox-default.md) (Docker sandbox default) |
| Dataset lineage of evaluators | ⚠️ partial | [ADR-0037](../decisions/2026-06-11-eval-and-red-team-harness.md) — eval & red-team harness defined; evaluator dataset lineage not yet recorded |
| Benchmark audit trails | ⚠️ partial | [ADR-0037](../decisions/2026-06-11-eval-and-red-team-harness.md) — golden-trajectory replay + pass^k defined; full benchmark audit trail not yet produced |
| Operator runbooks | ❌ gap | `docs/guides/` is currently empty — no operator runbooks yet |

## Legend

- ✅ **covered** — an existing component/ADR meets the obligation as specified.
- ⚠️ **partial** — the mechanism is specified but the obligation is not yet fully discharged.
- ❌ **gap** — no current coverage; tracked work item.
