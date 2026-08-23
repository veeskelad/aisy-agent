# ADR-0028: Default-Quarantine for External Input (Classifier Escalates Only)

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** security

## Context
The safety layer routes external text through an input classifier that decides whether
content is an injection and should be quarantined. As designed, a `clean` verdict lets
content through without quarantine framing. That makes the classifier — a cheap model
with ~70%-class adherence — a single probabilistic chokepoint guarding the untrusted-input
edge. Its dangerous error is the **false negative**: an injection it misses (obfuscation,
encoding, multilingual payload, or an injection split across chunks below the
classification window) lands as trusted instructions. A single model deciding "this is
safe, skip the framing" is exactly the "ask the model to be careful" pattern the project's
thesis rejects. The classifier should make things *safer*, never be the thing safety
depends on.

## Decision
**All external text is quarantined by default. The classifier may only escalate, never
downgrade.**

1. **Default-untrusted.** Any content not originating from the operator's own typed turn
   is tagged `untrusted` at ingestion (tool output, fetched pages, MCP responses, file
   contents, voice transcripts, forwarded/attached Telegram content). This tag drives
   capability narrowing ([ADR-0027](./2026-06-11-capability-narrowing-untrusted-context.md))
   regardless of any classifier verdict.
2. **Escalate-only classifier.** The classifier's verdict can raise the response
   (add explicit injection framing, force a clarification, hard-block a send) but can
   **never** mark external text as `trusted` / no-framing. A compromised or fooled
   classifier can only over-quarantine (fail-safe), never under-quarantine.
3. **Unconditional deterministic transforms.** Before any external text reaches the
   model, code applies fixed transforms that do not depend on the classifier: strip
   markdown images and auto-loading resources, strip/neutralize foreign URLs, and defang
   known instruction-injection patterns. These run 100% of the time.
4. **Chunk-boundary handling.** External content is classified and framed in overlapping
   windows so an injection cannot hide by straddling a chunk boundary below the window
   size.

The classifier becomes an *advisory escalator* on top of a deterministic
quarantine-by-default floor, not the gate itself.

## Consequences
- **Positive:** Safety no longer hinges on the classifier catching every injection. The
  worst classifier failure is over-quarantine, which is merely inconvenient. The
  deterministic transforms defeat the whole image/URL-exfil class without model
  cooperation. Removes the single-chokepoint risk.
- **Neutral:** "Quarantined by default" means more content carries the `untrusted` tag,
  so capability narrowing ([ADR-0027](./2026-06-11-capability-narrowing-untrusted-context.md))
  fires more often. That is the intended posture.
- **Negative:** Treating all tool output as untrusted adds friction to benign flows (the
  agent must round-trip to the operator before acting on fetched content). The classifier
  still costs a model call per external block; on cost-sensitive paths it may be skipped
  entirely (default-quarantine still holds) rather than trusted.

## Alternatives considered
**Trust the classifier's `clean` verdict (original design).** One missed injection lands
as trusted instructions. Rejected — false negatives are unbounded and the failure is
silent.

**Pure deterministic filtering, no classifier.** Cheaper and fully deterministic, but
misses semantic injections the transforms can't pattern-match. The classifier adds value
as an escalator; it just must not be load-bearing.

**Heavier model as classifier.** Better recall, but still probabilistic and still a
chokepoint if trusted to downgrade. Cost rises without removing the structural flaw.

## References
- [ADR-0027](./2026-06-11-capability-narrowing-untrusted-context.md) — what quarantine triggers
- [ADR-0010](./2026-06-11-break-lethal-trifecta.md) — the outbound-strip transforms
- [ADR-0013](./2026-06-11-mcp-allowlist-pinning-hashing.md) — MCP output is external text too
- OWASP LLM01 (Prompt Injection); EchoLeak markdown-image exfiltration
