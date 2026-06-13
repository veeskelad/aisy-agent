# Component 04: Tools & Hooks — Specification

**Status:** Draft
**Component:** 04 / 12
**Related ADRs:** ADR-0009, ADR-0014, ADR-0022, ADR-0027
**Depends on:** Safety (05), Core / Agent Loop (01), Observability & Verification (12)

> The narrow-waist tool set and the deterministic Pre/PostToolUse choke point every
> tool call must traverse before it runs and after it returns.

## 1. Purpose

Tools & Hooks is the deterministic boundary between the model's *intent* to act and
the *effect* on the world. The model proposes a tool call (a ~70% probabilistic
decision); this component disposes — it normalizes the call, runs it through a
code-only verdict gate (`allow` / `deny` / `ask` / `modify`), executes the allowed
call, and post-processes the result (secret redaction, output filtering, optional
compression) before any bytes re-enter context.

Two things live here, and both are pure deterministic OS:

- **The narrow waist** (ADR-0014): a small, byte-stable base tool set (< 20 tools)
  that sits inside the KV-cached stable prefix. Capability grows through skills and
  MCP behind the waist, never by enlarging this list. **Design principle — one tool,
  one job:** if a human cannot say which tool fits a request, the model cannot either;
  overlapping or vaguely-scoped tools degrade the ~70% selection step before any gate runs.
- **The hooks** (ADR-0009): the PreToolUse and PostToolUse layers that wrap every
  call. PreToolUse returns a verdict the model never votes on. PostToolUse turns
  errors into results, redacts secrets, and may compress.

The component owns *mechanism*; the *policy content* (the HARD_DENY regex set,
quarantine, tier classification, vault value set, egress allowlist) is owned by
Safety (05) and consumed here. This separation is deliberate: the hooks are the
enforcement surface, Safety is the rule source.

## 2. Responsibilities

**Owns:**

- The base tool registry — the < 20 universal tools exposed to the model (ADR-0014),
  emitted as a byte-stable definition block for the KV-cache prefix (ADR-0019).
- **Schema enforcement at decode**: a tool call's args are validated against the
  tool's declared input schema *at decode time* — constrained decoding makes a
  malformed call (wrong types, missing required fields, invalid enum values)
  unrepresentable, so it is rejected before it can ever reach normalization or
  dispatch. The execution-time validation is a defense-in-depth backstop, not the
  first line.
- **Per-tool risk annotations** (`readOnly` / `destructive` / `idempotent` booleans),
  declared on each tool definition *complementing* the existing `tier` + `outboundSink`,
  and read by the permission layer to route the verdict (e.g. a `destructive` tool never
  silently `allow`s, an `idempotent` retry is safe to auto-resolve).
- **Deferred schema loading**: tool *names* stay visible in the menu at all times; the
  full input schema for a tool loads on demand at selection/call time, so a large skill/MCP
  surface does not consume the context window with rarely-used schemas. The narrow waist
  (< 20) already bounds the base tools; deferred loading applies to the skill- and
  MCP-exposed tools behind the waist.
- The PreToolUse pipeline: argument normalization (canonical paths, decoded args,
  expanded aliases), invocation of the Safety verdict, provenance/capability checks,
  and the final `allow` / `deny` / `ask` / `modify` decision per call.
- The PostToolUse pipeline: error-to-result wrapping, deterministic secret
  redaction, output filtering, and optional rtk compression — in that order.
- Capability-mode enforcement at the hook layer when untrusted content is in context
  (ADR-0027): outbound lockout, Tier-2/3 reduction to ask-only, and
  motivated-call blocking by provenance.
- The rtk integration surface: feature flag, version pin, startup binary
  verification, and fail-open fallback to raw output (ADR-0022).
- Dispatch of an allowed call to its executor (sandbox for `bash`, file ops for
  read/write/edit, the egress proxy for web fetch, the MCP client for MCP tools).

**Does not do (boundary — owner named):**

- **Define HARD_DENY patterns, tiers, quarantine, vault value set, or the egress
  allowlist.** Owned by **Safety (05)**; this component calls Safety for the verdict
  and the redaction value set and enforces the answer.
- **Run the Docker/gVisor sandbox or the egress proxy.** Owned by **Safety (05)**;
  this component hands an allowed `bash` call to the sandbox and a fetch to the
  proxy.
- **Set provenance labels on context spans.** Owned by **Core (01)** at context
  assembly per ADR-0027/ADR-0028; this component *reads* provenance to decide
  capability mode and motivated-call blocking.
- **Assemble the prompt, freeze the snapshot, or run Plan Mode.** Owned by **Core
  (01)**.
- **Author or trigger skills, or connect/pin MCP servers.** Owned by **Skills (06)**
  and **MCP (07)**; this component only dispatches an already-resolved MCP/skill
  call through the same hook path.
- **Write the audit journal.** Owned by **Observability (12)**; this component emits
  a structured event per decision for that journal.

## 3. Interfaces

```ts
// illustrative, not binding

// ---- The narrow-waist base tool set (ADR-0014). Count is invariant: < 20. ----
export type BaseToolName =
  | "bash"            // run in the sandbox (Safety 05); never on host
  | "read_file"
  | "write_file"
  | "edit_file"
  | "list_dir"
  | "search_memory"  // FTS5/BM25 read, Tier-0
  | "fetch_web"      // via egress proxy (Safety 05)
  | "send_message"   // outbound channel (Telegram) — outbound-tagged
  | "git"            // wrapper; push/force gated by HARD_DENY + outbound tag
  | "call_mcp"       // single entry to all MCP tools (MCP 07)
  | "call_skill"     // single entry to skill bodies (Skills 06)
  // ... total registered base tools MUST be < 20

export interface ToolCall {
  tool: BaseToolName
  args: Record<string, unknown>
  // provenance of every arg, threaded from Core (01) context assembly
  argProvenance: Record<string, Provenance> // never set by the model
}

export type Provenance = "operator" | "untrusted"

export type PreVerdict =
  | { kind: "allow"; call: NormalizedCall }
  | { kind: "deny"; reason: string; rule: string }
  | { kind: "ask"; tier: 2 | 3; card: ApprovalCard }
  | { kind: "modify"; call: NormalizedCall; note: string }

export interface Hooks {
  // PreToolUse: deterministic, 100%. Model does not see or vote on the verdict.
  preToolUse(call: ToolCall, ctx: ContextState): Promise<PreVerdict>

  // PostToolUse: error->result, redact, filter, optional compress. Returns the
  // exact bytes that will enter context.
  postToolUse(call: NormalizedCall, raw: ToolResult): Promise<ContextSafeResult>
}

export interface ContextState {
  hasUntrustedSpan: boolean            // any span tagged untrusted in context
  activeTier: 0 | 1 | 2 | 3
}

export interface ContextSafeResult {
  ok: boolean
  text: string          // redacted, filtered, possibly compressed
  redacted: boolean     // true if any vault value was masked
  compressed: boolean   // true only if rtk ran and succeeded
}

// rtk compression boundary (ADR-0022). Pure size optimization; fail-open.
export interface Compressor {
  // returns raw input unchanged on ANY error (non-zero exit, malformed, missing
  // binary, timeout); never throws into the loop.
  compress(input: string): Promise<{ text: string; compressed: boolean }>
  verifyBinary(): { ok: boolean; resolvedPath: string; version: string }
}
```

Errors a hook may surface (always as a `PreVerdict` or `ContextSafeResult`, never a
thrown exception through the loop):

- `deny` with `rule` — a HARD_DENY match, an outbound-lockout block, or a
  motivated-call block.
- `ask` — a Tier-2/3 action needing human approval (card emitted to Gateway).
- `ContextSafeResult{ ok:false }` — the underlying tool failed; the error is
  returned as a result so the loop survives (ADR-0009).

Events emitted to Observability (12): `tool.pre_verdict`, `tool.denied`,
`tool.blocked_motivated`, `tool.outbound_locked`, `tool.redacted`,
`tool.compressed`, `tool.rtk_fallback`.

## 4. Data structures

**Base tool registry (byte-stable).** The registry serializes to a deterministic,
byte-identical definition block that lives in the KV-cached stable prefix
(ADR-0019). Field order, whitespace, and tool order are fixed; the serialized form
is hashed and the hash is asserted in CI so any change is a reviewed event. The
registry carries, per tool, an `outboundSink: boolean` flag and a default `tier`
(0–3) used by capability narrowing (ADR-0027) and the autonomy gradient (ADR-0011,
owned by Safety), plus explicit risk annotations `readOnly` / `destructive` /
`idempotent` (booleans) that *complement* `tier` + `outboundSink` and that the
permission layer routes on.

**Tool count invariant.** `count(baseTools) < 20` is a hard, test-asserted
invariant (ADR-0014). New capability is added as a skill or MCP server, never as a
registry entry; widening the waist requires a new ADR.

**NormalizedCall.** The output of PreToolUse normalization: canonicalized absolute
paths, decoded/unescaped argument strings, expanded shell aliases. The verdict and
all downstream redaction run on this form so obfuscation cannot slip past matching.

**PreVerdict / PostToolUse decision record.** Each decision serializes to one
append-only event (tool, normalized args hash, verdict, rule id, provenance summary,
redaction count, compression flag) handed to Observability (12). The model's context
never contains the verdict object — only the tool result (or a deny notice).

**rtk pin descriptor.** A pinned exact rtk version string plus the expected resolved
binary path/source (git or Homebrew, never `cargo install`). Read at startup by
`verifyBinary()`; a mismatch disables compression (fail-open to raw).

## 5. Behavior & control flow

Every tool call traverses the same path. Boxes marked **[code]** are deterministic;
the model only appears at the very top (it *proposed* the call).

```
        model proposes a ToolCall  (~70% decision — selection only)
                     |
                     v
  +------------------------------------------------+
  | PreToolUse  [code, 100%]                        |
  |  1. normalize args (paths, decode, aliases)     |
  |  2. capability mode (ADR-0027) [code]:          |
  |       if ctx.hasUntrustedSpan:                  |
  |         - tool.outboundSink? -> DENY (locked)   |
  |         - tool.tier in {2,3}? -> force ASK      |
  |         - any arg.provenance == untrusted        |
  |           AND tool side-effecting -> DENY        |
  |           (motivated-call block)                 |
  |  3. Safety.verdict(normalizedCall) [HARD_DENY]   |
  |       -> allow / deny / ask / modify             |
  |  4. fail-closed: hook error/timeout -> DENY      |
  +------------------------------------------------+
         | allow / modify        | deny / ask
         v                       v
  dispatch to executor     return to loop as result/card
  (sandbox | file op |          (no execution)
   egress proxy | MCP)
         |
         v  raw ToolResult (or thrown error)
  +------------------------------------------------+
  | PostToolUse  [code, 100%] — fixed order:        |
  |  1. error -> result   (ADR-0009: loop survives) |
  |  2. secret redaction  (CSO-M3): mask every       |
  |       known vault value in the text             |
  |  3. output filter (Safety 05): strip md images, |
  |       defang foreign URLs, re-classify           |
  |  4. rtk compress (ADR-0022) [flag, fail-open]:   |
  |       on ANY error -> raw bytes unchanged        |
  +------------------------------------------------+
                     |
                     v
        ContextSafeResult enters model context
```

**Ordering guarantees (load-bearing):**

- **Schema validity precedes everything.** A tool call's args are constrained against
  the tool's declared input schema at decode time, so a malformed/over-typed arg set
  (wrong types, missing required fields, invalid enums) is rejected before it can reach
  PreToolUse normalization or dispatch — the loop never sees a syntactically invalid
  call as an executable one.
- Capability narrowing (step 2) runs **before** the HARD_DENY verdict (step 3) so an
  untrusted-context outbound or motivated call is denied even if the bare tool would
  otherwise be allowed.
- Secret redaction (PostToolUse step 2) runs **before** compression (step 4): the
  redaction pass operates on raw text, and compression must never be able to reorder
  bytes such that a masked value re-emerges. Redaction also runs before the result is
  handed to anything else, so no un-redacted tool result ever exists in context.
- Compression is **last and optional**: it never participates in any safety decision,
  it only shrinks already-safe text, and it fails open to the (already redacted,
  already filtered) raw bytes.
- **Fail-closed on the pre path, fail-open on the compression sub-step only.** A hook
  error or timeout in PreToolUse or in redaction/filtering denies/aborts the call. An
  error in rtk passes the raw safe bytes through.

**Output sanitization and write semantics (§5).** All model-originated output is
sanitized of ANSI / control escape sequences in the PostToolUse output filter (step 3)
before it reaches any sink — a Telegram message, a log, or the terminal — so no raw
control sequence is ever rendered ([ADR-0037](../decisions/2026-06-11-eval-and-red-team-harness.md)).
On the write path, a destructive file write is distinguishable from an append: a
destructive overwrite of a memory file requires explicit confirmation, and an append
never truncates existing content.

**Deterministic vs model:** every box above is code. The model's only role is the
initial proposal and reasoning over the returned result. No verdict, redaction, or
mode decision is delegated to a model call.

## 6. Dependencies

- **Internal:**
  - **Safety (05)** — provides `verdict(normalizedCall)` (HARD_DENY, tiers,
    `ask`/`modify`), the vault value set for redaction, the output filter, the
    sandbox executor for `bash`, and the egress proxy for `fetch_web`. This component
    enforces Safety's answers; it does not define them.
  - **Core / Agent Loop (01)** — proposes tool calls, supplies per-span and per-arg
    **provenance** (ADR-0027/ADR-0028) and the `ContextState` (`hasUntrustedSpan`,
    `activeTier`), and consumes the byte-stable tool-definition block for the KV-cache
    prefix (ADR-0019). Provenance is set by Core; never by the model.
  - **Observability & Verification (12)** — receives one structured decision event per
    call (verdict, rule, redaction count, compression flag, fallback flag).
  - **MCP (07)** and **Skills (06)** — resolve `call_mcp` / `call_skill` targets;
    their resolved calls re-enter this same hook path (no bypass).
- **External:**
  - **rtk (Rust Token Killer), Apache-2.0** — optional PostToolUse compressor,
    feature-flagged, exact-version-pinned, installed from git or Homebrew (never
    `cargo install rtk` — crates.io name collision), verified at startup, fail-open
    (ADR-0022).

**Risk-finding requirements landed in §6 mechanism:**

- **Finding 4 — Narrow waist (ADR-0014):** the base registry is the only place tools
  are added, and `count < 20` is enforced as a CI invariant; capability growth routes
  to Skills (06) / MCP (07).
- **Finding 3 — rtk fallback (ADR-0022):** rtk is an external, optional dependency
  with a pinned version and startup binary verification, integrated only at
  PostToolUse step 4.

## 7. Failure & degraded modes (mandatory)

| Failure | Detection | Behavior | Recovery |
|---|---|---|---|
| **Cold start** (hooks not yet initialized, Safety verdict source not loaded) | Startup readiness check before first tool dispatch | **Fail-closed**: no tool executes until PreToolUse + Safety verdict source are live; the loop may reason but cannot act | Block tool dispatch until init completes; surface "tools initializing"; resume on ready |
| **Safety (05) verdict unavailable** (HARD_DENY source/timeout) | Verdict call errors or exceeds timeout | **Fail-closed**: PreToolUse returns `deny` for the call (no allow-on-error path) | Retry once; if still down, keep denying tool calls and emit `tool.denied(rule=safety_unavailable)`; reads remain blocked too — no skip-permissions |
| **Untrusted span present, model attempts outbound tool** (ADR-0027) | `ctx.hasUntrustedSpan && tool.outboundSink` at PreToolUse step 2 | **Fail-closed**: `deny` (outbound lockout); emit `tool.outbound_locked` | Clears only on a subsequent `operator` turn with no untrusted content; surfaced as a proactive approval card, not a silent failure |
| **Tool args derive from an untrusted span** (motivated call, ADR-0027) | Any `argProvenance == untrusted` on a side-effecting tool | **Fail-closed**: `deny` (motivated-call block); emit `tool.blocked_motivated` | Requires a fresh operator turn that re-issues the call from operator-provenance args |
| **Vault value set (redaction source) unavailable** (CSO-M3) | Redaction lookup errors/times out at PostToolUse step 2 | **Fail-closed**: do **not** let the un-redacted result enter context; return `ok:false` error result instead | Retry the redaction fetch; once available, the call can be re-run; tool output is never admitted unredacted |
| **Output filter (Safety) unavailable** | Filter call errors at PostToolUse step 3 | **Fail-closed**: return error result; raw tool output is not admitted | Retry; block result admission until the filter is back |
| **rtk binary missing / wrong version / not on pin** (ADR-0022) | `verifyBinary()` mismatch at startup | **Degrade (fail-open)**: compression disabled for the session; raw (redacted, filtered) output used | Operator pins/installs correct version from git or Homebrew; re-verify on next start |
| **rtk runtime error** (non-zero exit, malformed output, timeout, binary not found) | PostToolUse step 4 catches the error | **Degrade (fail-open)**: pass the original safe bytes through unchanged; emit `tool.rtk_fallback` | None needed — call already succeeded; investigate rtk separately |
| **Underlying tool fails** (bash non-zero, fetch error, MCP error) | Executor returns error / throws | **Degrade**: PostToolUse step 1 wraps the error as a structured result; loop survives (ADR-0009) | Model sees the error result and can retry or change approach |
| **Sandbox (Safety 05) unavailable** for `bash` | Dispatch to sandbox errors | **Fail-closed**: `bash` calls denied (no host execution fallback) | Block `bash`; non-sandboxed tools (read, search_memory) may continue |

## 8. Security & threat model

This component is security-relevant: it is the deterministic enforcement surface for
every tool call. All mitigations below are **code**, 100% adherence; the model is
never the judge.

| Threat (STRIDE / OWASP-LLM) | Vector | Deterministic mitigation (code) | Enforcing ADR |
|---|---|---|---|
| **Elevation / irreversible action** (LLM06 excessive agency) | Model proposes `rm -rf`, `terraform destroy`, `DROP`, `git push --force`, money op, secret read | PreToolUse normalizes then runs Safety HARD_DENY on the normalized call; match -> `deny`, model does not vote; fail-closed on hook error | ADR-0009 |
| **Information disclosure via exfiltration** (LLM02; lethal trifecta outbound leg) | Injection in an untrusted span drives private memory to an outbound tool | **Outbound lockout**: while any untrusted span is in context, all `outboundSink` tools (`send_message`, outbound `git push`, outbound `fetch_web`, write-classified MCP) are denied in code | ADR-0027 |
| **Confused deputy / data laundering** (LLM01 prompt injection) | Injection launders attacker-controlled data through an otherwise-allowed tool | **Motivated-call block**: any tool whose args carry `untrusted` provenance is denied at PreToolUse even if the tool is allowed | ADR-0027 |
| **Privilege creep under untrusted content** | Tier-2/3 tool used while untrusted content is in context | **Tier reduction**: Tier-2/3 forced to ask-only; effective set is Tier-0/1 (read + worktree-local) until a clean operator turn | ADR-0027, ADR-0011 |
| **Secret leakage into context** (LLM02; CSO-M3) | A tool result (error text, file dump, MCP response) contains a known vault secret | **Deterministic secret-redaction pass**: PostToolUse masks every value in the known vault value set before the result enters context; runs before compression; fail-closed if the value set is unavailable | ADR-0009 (PostToolUse), CSO-M3 |
| **Tampering with the enforcement boundary** | Obfuscated args (encoded paths, aliases) evade pattern matching | Normalization to a canonical form (paths, decoded args, expanded aliases) precedes every verdict and the redaction pass | ADR-0009 |
| **Spoofing provenance** | Model claims its own (operator) provenance to escape narrowing | Provenance is set only by Core (01) at ingestion; the model cannot set `argProvenance`; hooks read it as code | ADR-0027, ADR-0028 |
| **Cache-poisoning / attack surface growth** | Bloating the tool list to add capability enlarges the trusted prefix and selection surface | Narrow waist: `count < 20` CI invariant; byte-stable definition block hashed in CI; growth only via skills/MCP | ADR-0014 |
| **Compression as an injection/leak channel** | A compromised or buggy compressor mangles or re-exposes redacted output | rtk is last, optional, and never part of a safety decision; it runs strictly **after** redaction+filter and **fails open to the already-safe bytes**; pinned version verified at startup | ADR-0022 |

**Enforced by code vs by the model:** the verdict, capability mode, motivated-call
block, redaction, filtering, normalization, and the tool-count invariant are all
code (100%). The model only selects which base tool to propose and reasons over the
returned, already-safe result.

## 9. Acceptance criteria (mandatory)

Each is a single objectively verifiable assertion for a Phase-3 test.

**Narrow waist (Finding 4, ADR-0014):**

1. **AC-04-1** — A test that counts registered base tools asserts the count is `< 20`;
   adding a 20th base tool to the registry fixture makes the test fail.
2. **AC-04-2** — Re-serializing the base tool-definition block produces bytes identical
   to the committed golden hash; changing any tool field, order, or whitespace changes
   the hash and fails the CI assertion.
3. **AC-04-3** — Adding a new capability via a skill or MCP server fixture leaves the
   base tool count unchanged (the new capability is reachable only through `call_skill`
   / `call_mcp`, not a new registry entry).

**PreToolUse verdict & fail-closed (ADR-0009):**

4. **AC-04-4** — A `bash` call resolving to `rm -rf /` (and an obfuscated/aliased
   variant) returns `PreVerdict.kind == "deny"` with a populated `rule`, and the
   executor is never invoked (sandbox dispatch spy records zero calls).
5. **AC-04-5** — When the Safety verdict source is stubbed to throw or time out,
   PreToolUse returns `deny` for the call (no allow-on-error path), including for
   read-only tools.

**Capability narrowing — outbound lockout (Finding 1, ADR-0027):**

6. **AC-04-6** — With `ctx.hasUntrustedSpan == true`, a `send_message` (and an outbound
   `git push`) call returns `deny`, emits `tool.outbound_locked`, and the outbound
   executor is not invoked.
7. **AC-04-7** — With `ctx.hasUntrustedSpan == false` (a clean operator turn after the
   untrusted span left context), the same `send_message` call returns `allow`
   (lockout clears only on a clean operator turn).

**Capability narrowing — motivated-call block & tier reduction (Finding 1, ADR-0027):**

8. **AC-04-8** — A side-effecting tool call with at least one `argProvenance ==
   "untrusted"` returns `deny` with `tool.blocked_motivated`, even when the same tool
   with all-operator args returns `allow`.
9. **AC-04-9** — With an untrusted span in context, a Tier-2 or Tier-3 tool call returns
   `ask` (forced), never `allow`; a Tier-0 read tool with operator-provenance args still
   returns `allow`.

**Secret redaction (Finding 2, CSO-M3):**

10. **AC-04-10** — Given a tool result whose text contains a value present in the known
    vault value set, the `ContextSafeResult.text` returned by PostToolUse contains the
    masked form and not the original value, and `redacted == true`.
11. **AC-04-11** — In the PostToolUse pipeline, the redaction pass executes before
    compression: with rtk enabled, the compressed output still contains no vault value
    (a test asserting a vault value appears in compressed output fails).
12. **AC-04-12** — When the vault value set is unavailable, PostToolUse returns an error
    result (`ok == false`) and does not admit the un-redacted tool output into context.

**rtk fallback & pinning (Finding 3, ADR-0022):**

13. **AC-04-13** — With rtk forced to fail (non-zero exit / malformed output / missing
    binary / timeout), `postToolUse` returns the original (redacted, filtered) bytes
    unchanged with `compressed == false`, emits `tool.rtk_fallback`, and the call still
    succeeds (no exception reaches the loop).
14. **AC-04-14** — `verifyBinary()` returns `ok == false` when the resolved rtk version
    does not equal the pinned version, and compression is disabled for the session while
    tool calls continue to succeed on raw output.
15. **AC-04-15** — A test asserts the rtk install path is git or Homebrew and rejects a
    `cargo install rtk` resolution (crates.io name-collision guard).

**PostToolUse error survival (ADR-0009):**

16. **AC-04-16** — When an underlying tool throws (e.g. `bash` non-zero exit, MCP error),
    `postToolUse` returns a structured result with `ok == false` and the agent loop
    continues to the next turn (no exception propagates through the loop).

**Ordering invariant (§5):**

17. **AC-04-17** — A trace of a single tool call shows PostToolUse steps execute in the
    order error-wrap -> redact -> filter -> compress; reordering redact after compress in
    a test harness causes AC-04-11 to fail.

**Output sanitization & write semantics (§5):**

18. **AC-04-18** — model output containing ANSI/control escape sequences is sanitized before
    it reaches any sink (Telegram, log, terminal); no raw control sequence is rendered.
    *(ADR-0037)*
19. **AC-04-19** — a destructive overwrite of a memory file is distinguishable from an append,
    requires confirmation, and an append never truncates existing content.

**Schema enforcement at decode (§2 / §5):**

20. **AC-04-20** — A tool call whose args violate the tool's declared input schema (wrong
    type, missing required field, or an invalid enum value) is rejected at decode time and
    is never dispatched; a malformed/over-typed arg set never reaches PreToolUse normalization
    (a dispatch spy records zero calls for the malformed candidate).

**Risk annotations route the verdict (§2 / §4):**

21. **AC-04-21** — Each base tool definition carries `readOnly` / `destructive` /
    `idempotent` annotations alongside `tier` + `outboundSink`, and the permission layer
    routes on them: a `destructive` tool never resolves to a silent `allow`, while a
    `readOnly` tool with operator-provenance args is not gated on those annotations.

**Deferred schema loading (§2):**

22. **AC-04-22** — A tool's name is present in the menu while its full input schema is
    absent from the assembled prompt until the tool is selected/called; loading a large
    skill/MCP surface leaves the base tool count `< 20` and does not place those tools'
    full schemas in the stable prefix.

## 10. Open questions

- **Provenance granularity for `bash` heredocs / piped inline data.** Whether arg-level
  provenance is sufficient or sub-arg span tagging is needed for shell payloads that
  embed untrusted text. Deferred; resolution tracked with ADR-0027 follow-ups and
  ADR-0028 (default quarantine of external input).
- **Whether `modify` rewrites should themselves be re-classified for provenance.**
  Currently `modify` produces an operator-equivalent safe call; whether a modify that
  touches untrusted-derived args should still trip the motivated-call block is open.
- **A second `cargo`-named binary collision check at runtime, not just startup.** rtk's
  pre-1.0 status (ADR-0022) may warrant per-call binary identity assertion if churn
  proves disruptive; deferred until rtk churn is observed.

## 11. References

- ADRs:
  - [ADR-0009 — Deterministic Pre/PostToolUse hooks](../decisions/2026-06-11-deterministic-tool-hooks.md)
  - [ADR-0014 — Narrow-waist tool set (<20)](../decisions/2026-06-11-narrow-waist-tool-set.md)
  - [ADR-0022 — rtk optional compression layer](../decisions/2026-06-11-rtk-optional-compression.md)
  - [ADR-0027 — Capability narrowing under untrusted context](../decisions/2026-06-11-capability-narrowing-untrusted-context.md)
  - [ADR-0011 — Autonomy gradient (tiers 0–3)](../decisions/2026-06-11-autonomy-gradient.md)
  - [ADR-0012 — Docker sandbox default](../decisions/2026-06-11-docker-sandbox-default.md)
  - [ADR-0019 — Stable prefix KV-cache](../decisions/2026-06-11-stable-prefix-kv-cache.md)
  - [ADR-0028 — Default quarantine of external input](../decisions/2026-06-11-default-quarantine-external-input.md)
  - [ADR-0037 — Eval and red-team harness](../decisions/2026-06-11-eval-and-red-team-harness.md)
- Concept docs:
  - [Safety layer](../concepts/safety-layer.md)
  - [MCP integration](../concepts/mcp-integration.md)
