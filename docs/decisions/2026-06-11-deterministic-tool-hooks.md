# ADR-0009: Deterministic Pre/PostToolUse Hooks

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** security

## Context
The LLM is a stateless probabilistic CPU with roughly 70% instruction adherence;
prompt-level guardrails inherit that ceiling and can be argued out of, jailbroken,
or simply ignored. Code hooks enforce at 100% because the model never sees the
verdict it can dispute. The harness is the deterministic OS, so the enforcement
boundary belongs in code, not in the prompt.

This is not theoretical. On 2026-03-06 a DataTalksClub Claude Code agent ran
`terraform destroy` and wiped 1.9M rows; Replit deleted a production database;
Amazon Kiro logged 4 Sev-1 incidents in a single week. NIST guidance requires at
least one deterministic enforcement layer that is **not** judged by an LLM. Every
tool call — Bash, file ops, MCP, network — must traverse such a layer before it
runs and after it returns.

## Decision
Every tool call passes through a **PreToolUse** hook (code) that normalizes the
call and returns one of `allow` / `deny` / `ask` / `modify`, gated by a
`HARD_DENY` regex set; and a **PostToolUse** hook that returns errors as results
rather than throwing through the agent loop, and may compress output.

The PreToolUse hook:
- Normalizes the invocation (canonical paths, decoded args, expanded aliases) so
  obfuscation cannot slip past pattern matching.
- Evaluates `HARD_DENY` against the normalized call: `terraform destroy`,
  `rm -rf`, SQL `DROP`/`TRUNCATE`, `DELETE` without `WHERE`, `git push --force`,
  money operations, and reads of secret files. A match returns `deny`.
- Returns `ask` for reversible-but-sensitive operations, `modify` to rewrite a
  call into a safe equivalent, and `allow` otherwise.
- Produces a verdict the model does **not** vote on. It cannot be talked out of
  the decision, because the decision is not in its context window.

The PostToolUse hook captures failures and returns them as structured results,
keeping a single bad tool call from crashing the loop, and optionally runs output
through compression (RTK) before it reaches context.

## Consequences
- **Positive:** Irreversible operations (delete, deploy, money, force-push,
  secret reads) gain a 100% deterministic block independent of model behavior;
  satisfies the NIST non-LLM-judged enforcement requirement; the loop survives
  tool errors instead of aborting; a single audited choke point for every call.
- **Neutral:** `HARD_DENY` is a living regex set requiring review and additions as
  new dangerous patterns emerge; normalization logic must stay ahead of evasion.
- **Negative:** Over-broad patterns can deny legitimate work (false positives),
  pushing users toward escape hatches; the hook adds latency and a maintenance
  surface to every tool call.

## Alternatives considered
**Prompting-only guardrails.** Encode the rules in the system prompt and trust the
model to obey. Rejected: caps at ~70% adherence, is bypassable by jailbreak or
distraction, and offers no enforcement when the model misreads or is manipulated —
exactly the failure mode behind the terraform-destroy class of incidents.

**An LLM judge as the boundary.** Route each call through a second model that
rules allow/deny. Rejected: it is still probabilistic and can be argued into
permitting a dangerous call; it violates the NIST requirement for a deterministic,
non-LLM-judged layer, and adds cost and latency without closing the gap.

## References
- [ADR-0012](./2026-06-11-docker-sandbox-default.md)
- [ADR-0010](./2026-06-11-break-lethal-trifecta.md)
- NIST AI guidance — deterministic enforcement layer requirement
- Simon Willison, "The Lethal Trifecta"
