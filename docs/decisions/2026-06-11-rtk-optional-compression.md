# ADR-0022: rtk as Optional Compression Layer

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** performance, dependency

## Context
Tool output is one of the largest sources of context bloat in the harness. Commands like
`git status`/`git diff`, test runners, linters, and directory listings routinely emit
hundreds to thousands of tokens of low-signal text (timestamps, file modes, progress noise,
repeated paths). Every byte of this lands in the model's context window, competing with the
always-loaded stable prefix (~9-10k tokens) and the daily/working memory we actually want
the CPU to reason over. Trimming it deterministically in code is squarely the OS's job, not
the model's.

rtk (Rust Token Killer, Apache-2.0) is an existing CLI proxy that compresses tool output by
roughly 60-90% before it reaches context. It is fast, deterministic, and already battle-tested
as a transparent shim. Two constraints shape how we adopt it: it is pre-1.0, so its
compression contract may change between releases; and there is a name collision on crates.io
(a different `rtk`, Rust Type Kit), so installing by package name is unsafe.

## Decision
Integrate rtk as an **optional, feature-flagged PostToolUse compression layer** that shrinks
tool output before it enters context, and **always falls back to raw, uncompressed output on
any error** (non-zero exit, malformed output, binary not found, timeout).

- **Placement:** a PostToolUse hook. It sees the raw tool result and emits the compressed
  form. Compression never participates in any safety or enforcement decision — those run on
  the pre-tool path and on raw text.
- **Fail-open:** the layer is a pure size optimization. On any error or unexpected output it
  passes the original bytes through unchanged. A broken rtk must never break a tool call.
- **Version pinning:** pin an exact rtk version; treat a version bump as a reviewable change,
  since the pre-1.0 contract may shift.
- **Install path:** install from git or Homebrew, never `cargo install rtk` (crates.io name
  collision). Verify the resolved binary on startup.
- **Flag-gated and off by default** in the open-source distribution so the harness has zero
  hard dependency on a third-party pre-1.0 tool.

## Consequences
- **Positive:** 60-90% smaller tool output frees context for memory and reasoning; more
  effective tokens per session; deterministic, no extra LLM calls; reuses a maintained tool
  instead of us building one.
- **Neutral:** an optional external binary in the toolchain; users who skip the flag get
  unchanged behavior; the pin must be bumped deliberately.
- **Negative:** a pre-1.0 dependency whose contract may change; an install footgun from the
  crates.io collision; an extra process in the tool path (mitigated by fail-open and the flag).

## Alternatives considered
**Hard dependency on rtk.** Making rtk mandatory would couple a public, Apache-2.0 harness to
a pre-1.0 tool with an unstable contract and an install collision. The 60-90% win is real but
not worth a non-optional third-party requirement; a feature flag captures the upside without
the lock-in.

**Build our own compressor now.** A bespoke tool-output compressor is non-trivial to get right
across git, test, and linter formats, and rtk already exists, is licensed Apache-2.0, and is
proven. Reimplementing it now would violate Simplicity First for no current benefit; we can
revisit if rtk's pre-1.0 churn becomes a maintenance burden.

## References
- [ADR-0009](./2026-06-11-deterministic-tool-hooks.md) — deterministic hooks that gate tool output before context injection
- rtk (Rust Token Killer), Apache-2.0: https://github.com/ranfdev/rtk
