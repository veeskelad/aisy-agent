# Operations runbook

Day-2 operations for a running Aisy harness. (Closes the EU AI Act "operator
runbooks" obligation; see [../compliance/eu-ai-act.md](../compliance/eu-ai-act.md).)

## Health & triage

| Symptom | First step | Then |
|---|---|---|
| Anything off | `aisy doctor` | fix red checks; `--fix` applies only safe, non-destructive repairs |
| Agent silent on Telegram | `doctor` `telegram` row | token valid? exactly one allowlisted `chat_id`? |
| "memory" check fails | `doctor` `memory` | corrupt index → `aisy doctor --fix` rebuilds via `rebuildFromFiles()` |
| Costs look high | `/usage` in chat | budgets are code-enforced (spec 09); raise ceilings deliberately |
| Bug report needed | `aisy diagnostics` | writes a **redacted** bundle (no secrets, no fact bodies) to share |

## Routine

- **Nightly consolidation** runs ~03:30 local: archives logs, consolidates memory
  (generator → separate judge → staging), runs hygiene, pushes the git backup,
  and stages a **morning approval card**. Nothing is promoted to live memory
  without your tap.
- **Backups**: fast-forward-only push each night; failures are reported on the
  morning card, never silent. Verify `AISY_BACKUP_REMOTE` reachability monthly.
- **Forgetting**: "forget this" is permanent — a hash-chained forget-list +
  tombstones; the nightly loop can never resurrect it. There is no un-forget
  except a human re-adding the fact by hand.

## Incident playbook

| Incident | Action |
|---|---|
| Suspected prompt injection | injection is contained by design (untrusted spans lock outbound + Tier-2/3; lethal trifecta broken). Review the journal (`aisy diagnostics`); the trace is immutable & hash-chained. |
| Runaway loop | the Loop Guardian (period 1/2/3) + global budget cap halt it; the trip is journaled. Inspect, then re-plan. |
| Corrupt SQLite index | `doctor` reports it loud (`CorruptIndexError`, never wrong/empty); `--fix` → `rebuildFromFiles()` re-applies the forget invariant. |
| Lost/rotated credential | update `.env`/vault, `aisy doctor` to confirm reachability. |
| Restore from backup | see [deployment.md](deployment.md#secrets--backup). |

## Audit & records (EU AI Act-relevant)

- **Immutable trace**: every model/tool/approval call is in the append-only,
  hash-chained Observability journal — tamper-evident, survives compaction
  (compaction is a view, not a write — ADR-0040).
- **Approval records**: every confirmation card tap records who/when/action-hash
  (spec 02/05, ADR-0029).
- **PII/secrets**: redacted at the journal sink and in diagnostics bundles.
