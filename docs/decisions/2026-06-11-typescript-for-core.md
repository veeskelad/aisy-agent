# ADR-0004: TypeScript for the Harness Core

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** language

## Context
The harness is the deterministic OS wrapped around a stateless probabilistic CPU (the LLM). Its job is overwhelmingly I/O orchestration, not computation: roughly 90% of the work is wiring together Telegram, provider HTTP APIs (Anthropic, OpenAI, DeepSeek), MCP servers, Docker sandboxes, and file/SQLite memory. The few CPU-bound pieces — Whisper voice transcription, optional embeddings/scoring — are isolated and bursty.

Constraints that shape the choice:
- Deterministic code hooks must hit 100% adherence (HARD_DENY regex, loop guardian, egress allowlist). Strong static types at the hook boundary catch shape errors before they reach a sandbox or a money op.
- MCP is first-class to the design (allowlist, version pinning, descriptor hashing). The official MCP SDK is TypeScript-first.
- Provider routing, KV-cache prefix management, and append-only history are all string/stream plumbing over async I/O.
- Python is still required for the ML sidecars; the question is only what the *core* is written in.

## Decision
Write the harness core in TypeScript on Node.js. Use Python exclusively for out-of-process sidecars (Whisper, optional embeddings/scoring) behind a stable adapter contract.

We adopt grammY for the Telegram layer, the official `@modelcontextprotocol/sdk` for MCP, and the vendor TS SDKs for provider calls. Node's single event loop matches an I/O-bound workload where thousands of concurrent awaits (API calls, MCP roundtrips, file reads) dominate; CPU-heavy ML never runs in-process, so the loop is never blocked.

## Consequences
- **Positive:** One language across hooks, router, memory, and MCP client. First-class MCP TS SDK with no FFI. Compile-time types at every safety boundary. Async I/O without thread-pool tuning; grammY is mature and well-typed.
- **Neutral:** ML stays in Python sidecars regardless of core language, so the polyglot split is intrinsic to the project, not a cost of this decision. pnpm monorepo already assumed.
- **Negative:** Whisper, embeddings, and any heavy numeric scoring run out-of-process, adding an IPC/contract surface and a second toolchain to maintain. Raw single-thread CPU throughput is worse than Go/Rust, accepted because the core does almost no CPU work.

## Alternatives considered
**Python monolith.** Tempting because the ML libraries are native, but the GIL serializes CPU work and forces process pools for the same isolation we'd get for free with sidecars; its MCP and Telegram tooling are thinner and less type-safe than the TS equivalents. The ML advantage doesn't help the 90% that is I/O glue.

**Go.** Excellent concurrency and single-binary deploy, but no first-class MCP SDK in 2026 means hand-rolling or wrapping the protocol — unacceptable when MCP security (descriptor hashing, version pinning) is central. Generics are also weaker for the discriminated-union shapes our hook boundaries use.

**Rust.** Best safety and performance, but over-engineering for I/O glue: borrow-checker friction and slow iteration buy throughput we don't need, since the core is await-bound, not compute-bound. We already use Rust where it earns its keep (RTK as an external CLI proxy), not for the orchestration core.

## References
- [ADR-0013](./2026-06-11-mcp-allowlist-pinning-hashing.md)
- [ADR-0012](./2026-06-11-docker-sandbox-default.md)
- grammY Telegram framework — https://grammy.dev
- Model Context Protocol TypeScript SDK — https://github.com/modelcontextprotocol/typescript-sdk
