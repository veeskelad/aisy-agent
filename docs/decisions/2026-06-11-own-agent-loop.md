# ADR-0005: Own Agent Loop (not a third-party SDK)

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** architecture

## Context
Aisy's core thesis is that the LLM is a ~70%-adherence probabilistic CPU and the
harness is the deterministic 100% OS. That guarantee lives entirely in the loop:
deterministic Pre/PostToolUse hooks (HARD_DENY regex for `rm -rf`, `terraform
destroy`, `DROP/TRUNCATE`, force-push, money ops — the same class of action that
wiped 1.9M rows at DataTalksClub on 2026-03-06 and deleted Replit's prod DB),
the loop guardian (cycle detection of period 1/2/3; OpenClaw's guard saw only
period-1 and burned hundreds overnight on A-B-A-B), and the memory
resurrection-guard.

Three properties are non-negotiable and all live in loop internals:
1. **Deterministic hooks** gating every tool call (NIST: at least one enforcement
   layer not judged by an LLM).
2. **Byte-stable KV-cache prefix** — identical prefix all session, append-only
   history, frozen memory snapshot → up to ~90% input savings across ≤4 Anthropic
   cache breakpoints.
3. **Task-based provider routing** — Opus 4.8 for critic/hard code, Sonnet 4.6 as
   workhorse, V4-Flash for nightly/monitoring; fallback on 2 consecutive errors
   (hysteresis), session survives.

A turnkey SDK owns the loop and therefore owns exactly these three surfaces,
hiding the bytes we must control.

## Decision
Build our own agent loop in TypeScript rather than adopt a turnkey agent SDK,
because deterministic Pre/PostToolUse hooks, byte-stable KV-cache prefix control,
and task-based provider routing are Aisy's core value and any SDK would abstract
them away. We borrow loop *shapes* — not code — from anima_sdk: the nested
step→loop→meta_loop structure and the "generations" idea (dead-end → fresh
generation carrying only constitution + lessons).

## Consequences
- **Positive:** Full control of the prefix bytes (KV-cache stays valid), hooks run
  as code with 100% enforcement, the router is ours to tune per task/price, and we
  can pin/replace providers without fighting an SDK's abstractions.
- **Positive:** No third-party lock-in; the loop stays auditable and Apache-2.0
  clean (anima_sdk ideas borrowed, not its MIT bash code).
- **Neutral:** We still consume vendor streaming APIs and the MCP spec directly;
  the stream-json parser shape is adapted from anima_sdk.
- **Negative:** +2-3 weeks of build, plus owning our own MCP-integration debugging
  (connection, descriptor hashing, tool-poisoning allowlist) that an SDK would
  partly provide.

## Alternatives considered
**Claude Agent SDK** — best ergonomics for Anthropic, but it owns the loop: custom
deterministic hooks are harder to inject, prefix-byte control for KV-cache is
indirect, and it pulls us toward Anthropic lock-in against our multi-provider
router. Lost on control.

**Vercel AI SDK** — excellent streaming and genuine multi-provider support, but no
native durable memory, no MCP integration, and no Pre/PostToolUse hook model. We'd
rebuild the three core surfaces on top of it anyway. Lost on missing core.

**LangGraph.js** — powerful graph orchestration but heavy and opinionated; its
state/checkpoint model fights our file-based markdown + FTS5 memory and frozen-
snapshot prefix discipline. Too much framework for a single-user harness. Lost on
weight and fit.

## References
- ADR on hooks/safety: [ADR-0009](./2026-06-11-deterministic-tool-hooks.md)
- ADR on provider routing: [ADR-0018](./2026-06-11-model-router-hysteresis-fallback.md)
- anima_sdk (Rai220, MIT): https://github.com/Rai220/anima_sdk
- Model Context Protocol: https://modelcontextprotocol.io
- Simon Willison, "lethal trifecta": https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
