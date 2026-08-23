# ADR-0102: Agent-Loop Tool-Result Synthesis Round

**Status:** Accepted
**Date:** 2026-07-11
**Tags:** agent-loop, runtime, tools

## Context

On the free-form tool path (`ModelResponse.toolCalls`, no inline `plan`), the agent
loop dispatched each tool for its side-effect and then returned
`reply: response.reply` — the text of the **same** model turn that *requested* the
tools. Two facts made this a user-visible defect:

- `dispatch()` returned `void`; the tool's `result` was passed to `hookGate.post()`
  and then discarded. Tool output never re-entered the conversation.
- There was no post-tool model call on the success path, so the model never saw the
  tool results.

For information-retrieval requests ("what's in this folder?", "count the test files")
the model's pre-tool text is only a preamble ("Let me look…"), so the operator
received the preamble instead of an answer. Requests needing no tools worked, because
their single model turn already contained the full answer. This produced the
"great personality, but childish on real tasks" behaviour and was reproducible across
`deepseek-chat` and `deepseek-reasoner` (i.e. not a single provider's fault). The
OpenAI-compatible adapter never emits `plan`, so every openai-compat turn takes this
path — the defect affected all such providers.

Constraint: the loop is safety-critical (ADR-0017 plan+probe, ADR-0026 dispatch gate,
ADR-0027 provenance). Gated/blocked dispatches, the ambiguity floor, the Tier-3
approval gate, and the plan path must keep their exact current semantics.

## Decision

After the free-form tool path dispatches `response.toolCalls`, if **at least one tool
actually executed** (was not gated, narrowed-blocked, or quarantine-blocked), run one
**synthesis round**: re-invoke the model with the original spans plus the assistant
preamble and one `role: "tool"` span per executed tool (`"<name>: <output>"`), and
return that round's `reply`.

Scope decisions:
- **Only the free-form `toolCalls` path.** The plan path (ADR-0017) is unchanged —
  it closes steps on external probes, not model synthesis.
- **Executed-only.** Gated/blocked tools contribute no tool span; if every tool was
  blocked, no synthesis round fires and behaviour is byte-identical to before
  (preserves AC-01-7/20/21).
- **Single round in v1.** Tool calls emitted by the synthesis response are not
  re-dispatched. A tool → observe → decide-next-tool chain that needs the *result of
  A to choose B* is a follow-up (a bounded agentic loop). Tools the model emits
  *together* in one response are all dispatched, so most retrieval/aggregation tasks
  are covered.
- Tool-result spans are labelled `provenance: "untrusted"` (tool output is external
  data, never the operator speaking); this is inert for mid-turn control flow but
  honest per ADR-0027.

## Consequences

- **Positive:** retrieval/aggregation prompts now return a real answer synthesised
  from tool output. Closes the top "harness responds heavily" complaint. `dispatch()`
  now surfaces its result to the caller.
- **Neutral:** one extra model call per turn that executed ≥1 tool (usage already
  accumulates across model calls, so cost is reported correctly). New `dispatch()`
  return type `{ executed, result? }`; plan-path callers ignore it.
- **Negative:** multi-hop tool chains that depend on intermediate results still stop
  after the first batch in v1. Synthesis context includes raw tool output (truncated
  to a cap) — larger prompts on tool-heavy turns.

## Alternatives considered

- **Unbounded agentic loop (dispatch until no toolCalls).** Correct end-state, but a
  repeating provider (incl. our test fakes) loops to the tool-call cap; larger blast
  radius on the safety-critical loop. Deferred to a follow-up with an explicit round cap.
- **Fix in the provider adapter.** The adapter is stateless per call; it cannot own a
  multi-round conversation. The loop is the right layer.
- **Do nothing / rely on a stronger model.** A strong model sometimes front-loads the
  answer, masking the gap, but the loop still structurally drops tool output — not a fix.

## References

- Related ADRs: [ADR-0017](./INDEX.md) (plan+probe), [ADR-0026](./INDEX.md) (dispatch gate),
  [ADR-0027](./INDEX.md) (provenance), [ADR-0051](./2026-06-17-loop-control-abort-and-mid-turn-budget.md) (usage accumulation).
- `packages/core-ts/src/agent-loop/index.ts` (`dispatch`, free-form tool path),
  `packages/core-ts/src/runtime/provider-anthropic.ts` (`spansToMessages`, `tool` role).
