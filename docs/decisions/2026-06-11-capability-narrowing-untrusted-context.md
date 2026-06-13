# ADR-0027: Capability Narrowing When Untrusted Content Is in Context

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** security, architecture

## Context
[ADR-0010](./2026-06-11-break-lethal-trifecta.md) commits to breaking the lethal
trifecta (private data + untrusted input + outbound channel) per sensitive flow, and
the safety layer mentions "capability narrowing" while processing quarantined content.
But the mechanism is asserted, not specified, and the trifecta is only half-broken in
practice: only secrets go to the vault, while `USER.md`, `MEMORY.md`, daily logs, and
FTS5 hits sit in the *same context window* as quarantined untrusted text (a fetched web
page, an MCP result, a forwarded Telegram post, a voice transcript). An indirect
injection in that untrusted span can therefore read private memory and try to drive it
to an outbound channel. "Be careful while handling untrusted content" is a prompt
instruction — the ~70% surface this project exists to escape. Capability narrowing must
be a deterministic code mode, not a behavior we hope the model exhibits.

## Decision
When any span tagged `untrusted` is present in the assembled context, the harness
enters a **narrowed capability mode** enforced in the Pre/PostToolUse hooks
([ADR-0009](./2026-06-11-deterministic-tool-hooks.md)), independent of the model:

1. **Provenance tagging.** Every content span carries a provenance label set by code at
   ingestion: `operator` (the user's own typed turn), `untrusted` (tool output, fetched
   pages, MCP responses, voice transcripts, forwarded/attached content per
   [ADR-0028](./2026-06-11-default-quarantine-external-input.md)). The model never sets
   its own provenance.
2. **Outbound lockout.** While any `untrusted` span is in context, all outbound-channel
   tools are disabled in code: Telegram `send`, outbound HTTP, `git push`, and any MCP
   tool classified as a write/side-effecting sink. This breaks the outbound leg of the
   trifecta deterministically.
3. **Tier reduction.** Tier-2 and Tier-3 tools ([ADR-0011](./2026-06-11-autonomy-gradient.md))
   are dropped to ask-only while untrusted content is in context; the narrowed set is
   effectively Tier-0/1 (read + worktree-local).
4. **Motivated-call blocking.** A tool call whose arguments derive from an `untrusted`
   span (tracked by provenance) is blocked at PreToolUse even if the tool itself is
   allowed — defense against an injection that launders attacker data through an
   otherwise-permitted call.
5. **Exit.** Narrowed mode clears only on a subsequent `operator` turn that does not
   itself carry untrusted content. Processing untrusted content and then acting on it
   requires the human to come back into the loop.

The narrowing is a property of the loop and hooks, not of the prompt. The model may
reason over untrusted content freely; it simply cannot reach an outbound or irreversible
tool while doing so.

## Consequences
- **Positive:** The lethal trifecta is broken deterministically per flow — an injection
  in untrusted content cannot exfiltrate private memory because the outbound leg is gone
  while that content is in context. Closes the gap behind the EchoLeak/indirect-injection
  class without relying on the model. Provenance tagging also feeds [ADR-0028](./2026-06-11-default-quarantine-external-input.md)
  and the MCP confused-deputy defense.
- **Neutral:** Provenance is a new field threaded through context assembly (Component 1)
  and enforced in hooks (Component 4/5). Plan Mode ([ADR-0026](./2026-06-11-plan-mode-clarification-verified-todo.md))
  reads it as an input to the ambiguity/clarification gate.
- **Negative:** A legitimate flow that needs to act on fetched content in one turn (e.g.
  "summarize this page and post it") now requires a second operator turn after the
  untrusted content was processed. This is the intended cost; it is surfaced as a
  proactive approval card rather than a silent block. Mis-tagging `operator` content as
  `untrusted` over-narrows (annoying but fail-safe); the reverse must never happen, so the
  tagger is security-critical and reviewed on every new ingestion path.

## Alternatives considered
**Prompt the model to drop its own capabilities near untrusted content.** The 70%
surface; an injection can talk it back out. Rejected as the enforcement mechanism.

**Vault everything private, not just secrets.** Putting all of `USER.md`/`MEMORY.md`
behind a tool would gut the always-loaded memory model ([ADR-0006](./2026-06-11-file-based-memory-fts5-bm25.md))
and the KV-cache prefix ([ADR-0019](./2026-06-11-stable-prefix-kv-cache.md)). Narrowing
the *outbound* leg is cheaper and equally sufficient to break the trifecta.

**Separate sub-agent with no memory for untrusted content.** Viable and stronger in
isolation, but heavier; kept as a future option for high-risk corpora. The in-loop
narrowing is the day-one default.

## References
- [ADR-0010](./2026-06-11-break-lethal-trifecta.md) — the trifecta this enforces per flow
- [ADR-0028](./2026-06-11-default-quarantine-external-input.md) — what counts as untrusted
- [ADR-0009](./2026-06-11-deterministic-tool-hooks.md) — the hook layer that enforces it
- [ADR-0011](./2026-06-11-autonomy-gradient.md) — the tiers being reduced
- Simon Willison, "The lethal trifecta"; EchoLeak-class indirect-injection exfiltration
