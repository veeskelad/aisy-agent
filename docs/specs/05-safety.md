# Component 05: Safety — Specification

**Status:** Draft
**Component:** 05 / 12
**Related ADRs:** ADR-0009, ADR-0010, ADR-0011, ADR-0012, ADR-0027, ADR-0028, ADR-0029
**Depends on:** Tools & Hooks (04), MCP (07), Nightly Consolidation (10)

> The deterministic enforcement boundary between the model's intent and the world's
> state: it decides, in code, what actually executes, what external text the model is
> allowed to act on, and how a human authorizes anything irreversible.

## 1. Purpose

Safety is the set of deterministic gates that sit between the model's *proposal* and the
*effect*. The model is a stateless probabilistic CPU at roughly 70% instruction
adherence; a prompt-level "be careful" inherits that ceiling and can be argued out of,
jailbroken, or ignored. This component moves every irreversible or critical decision into
code that holds at 100% and that the model never gets to vote on, because the verdict is
not in its context window.

The split is reversibility. Reversible and creative work (drafting, reasoning over a
quarantined web page, proposing a tool call) belongs to the model. Irreversible and
critical work (running a destructive command, opening an outbound channel while untrusted
text is in context, confirming a permanent deletion) is owned here in deterministic code.
Safety is Aisy's answer to the NIST requirement of at least one enforcement layer that is
not judged by an LLM.

This component owns the *policy and verdict* of safety: HARD_DENY, the autonomy tiers,
quarantine/capability-narrowing mode, the egress-body controls, the sandbox posture
contract, the human-confirmation handler, and the nightly Tier-3 carve-out. It does not
own the *plumbing* that carries verdicts to execution — that is Tools & Hooks (04).

## 2. Responsibilities

This component **owns**:

- The `HARD_DENY` rule set and the normalization that feeds it (ADR-0009).
- The four-tier autonomy classifier and the Tier-3 red-card gate (ADR-0011).
- **Narrowed capability mode**: the deterministic state entered when any `untrusted`
  span is in context, and the exact set of tools that drop (ADR-0027).
- **Default-quarantine policy**: every external span is `untrusted` by default; the
  injection classifier may only escalate; the unconditional input transforms; the
  chunk-boundary windowing (ADR-0028).
- **Egress data-side controls**: outbound-body size/entropy/secret-pattern scanning,
  read-only-destination enforcement, and the no-free-text-in-query-string rule while
  untrusted content is in context (ADR-0010).
- The **sandbox security contract**: required Docker/gVisor invariants, the mount
  allowlist, the per-task egress-bridge lifecycle, and the degraded-security gate when
  gVisor is absent (ADR-0012).
- The **human-confirmation handler**: the only writer of `is_human_confirmed` and other
  trust/permanence flags, bound to a human tap on a hash-pinned diff with a nonce
  (ADR-0029).
- The **nightly Tier-3 carve-out**: the bounded allowlist of irreversible maintenance ops
  that may run unattended without a red card, each precondition-gated and
  reversible-by-snapshot.
- **Secret redaction** applied to every sink (logs, audit journal, morning card, model
  context, outbound bodies).

This component **does not**:

- Execute tools or shell the actual `PreToolUse`/`PostToolUse` hook runtime — **Tools &
  Hooks (04)** owns hook dispatch, output compression, and tool execution; Safety supplies
  the policy and verdict those hooks enforce.
- Tag provenance during context assembly — **Core / Agent Loop (01)** sets the
  `operator` / `untrusted` label at ingestion; Safety *consumes* it and fails closed if it
  is missing.
- Allowlist, pin, or hash MCP descriptors — **MCP (07)** owns that; Safety classifies MCP
  output as external text and classifies MCP tools as read vs write/side-effecting sinks.
- Author or judge memory operations — **Nightly Consolidation (10)** authors candidate
  ops; Safety only strips trust flags from them and gates the unattended maintenance set.
- Run the egress proxy network daemon — that is operated alongside the sandbox; Safety
  defines the allowlist contract and the data-side body checks it must apply.

## 3. Interfaces

Conceptual API surface. These signatures are illustrative, not binding, and stay inside
the narrow-waist tool philosophy (ADR-0014): Safety exposes verdicts, not new tools.

```ts
// illustrative, not binding

type Provenance = 'operator' | 'untrusted'

interface ContextSpan {
  text: string
  provenance: Provenance        // set by Core (01); Safety never sets it
  source: string                // mcp:<server> | url:<host> | file:<path> | voice | telegram
}

type Verdict =
  | { decision: 'allow' }
  | { decision: 'deny'; rule: string; reason: string }
  | { decision: 'ask'; tier: 0 | 1 | 2 | 3; card: ConfirmationCard }
  | { decision: 'modify'; rewritten: ToolCall }

interface SafetyPolicy {
  // Pre-execution verdict for a resolved tool call, given current context provenance.
  evaluate(call: ToolCall, ctx: ContextSpan[]): Verdict
  // True when any span in ctx is `untrusted` -> narrowed capability mode is active.
  isNarrowed(ctx: ContextSpan[]): boolean
}

interface InputGuard {
  // Unconditional deterministic transforms, run 100% of the time before the model sees text.
  defang(span: ContextSpan): ContextSpan          // strip images/auto-resources, neutralize URLs, defang injection patterns
  // Advisory escalation only; can raise quarantine, never downgrade to trusted.
  classify(span: ContextSpan): 'clean' | 'suspicious' | 'injection'
}

interface EgressGuard {
  // Data-side scan of an outbound body before it leaves the proxy.
  inspectBody(req: OutboundRequest, ctx: ContextSpan[]): { decision: 'allow' | 'deny'; reason?: string }
}

interface ApprovalHandler {
  // The ONLY setter of is_human_confirmed / permanence flags.
  confirm(nonce: string, actionHash: string, secondFactor?: string): ApprovalResult
}

interface SecretRedactor {
  redact(text: string): string                    // applied to every sink
}
```

Events emitted: `safety.denied`, `safety.narrowed.enter`, `safety.narrowed.exit`,
`safety.tier3.held`, `safety.egress.blocked`, `safety.approval.bound`,
`safety.approval.rejected`. Events consumed: `tool.proposed` (from 04), `context.assembled`
(from 01), `mcp.descriptor.changed` (from 07), `nightly.maintenance.requested` (from 10).

## 4. Data structures

- **HARD_DENY rule set** — an ordered list of `{ id, pattern, category }` evaluated
  against the *normalized* call. Categories: infra destruction, filesystem destruction,
  DB destruction (`DROP`/`TRUNCATE`/`DELETE`-without-`WHERE`), history rewrite
  (`git push --force`), money ops, secret-file reads. Living artifact; security-reviewed
  on every new tool (ADR-0009).

- **Tier table** — `{ toolPattern -> tier 0|1|2|3 }`. Tier is a property of the action
  class, never the model's confidence. Security-critical: a miscategorized irreversible op
  silently bypasses the red card, so the table is reviewed on every new tool (ADR-0011).

- **Provenance label** — `operator | untrusted` per span, read-only to Safety. A missing
  or unparsable label is treated as `untrusted` (fail-safe).

- **Narrowed-mode drop set** — the fixed list of tools disabled while any `untrusted` span
  is in context: Telegram `send`, outbound HTTP, `git push`, and every MCP tool classified
  as a write/side-effecting sink; Tier-2 and Tier-3 tools drop to ask-only (ADR-0027).

- **Egress allowlist entry** — `{ host, methods, mode: 'read-only' | 'read-write' }`. A
  `read-only` destination may never be a write sink. Enforced outside the agent process
  (ADR-0010).

- **Approval record** — `{ nonce, actionHash, factId?, op, tapTimestamp, secondFactorOk,
  stagedHashAtAccept, stagedHashAtPromote }`. Append-only audit binding of tap to action
  (ADR-0029).

- **Nightly Tier-3 carve-out allowlist** — the bounded, parameterized set of irreversible
  maintenance ops permitted unattended: `VACUUM`, `FTS5 optimize`, `WAL checkpoint(TRUNCATE)`,
  log rotation, scoped `docker prune`, merged/abandoned worktree prune, and fast-forward
  `git push`. Each entry carries its precondition predicate and its reversible-by-snapshot
  flag (Eng-13).

- **Outbound-body scan profile** — thresholds for size, Shannon entropy, and a
  secret-pattern set (API-key/token/PEM/credential shapes) applied to outbound request
  bodies and query strings (ADR-0010, CSO-M3).

No structure here is on the KV-cache stable prefix; verdicts are computed per turn and are
not part of the cached prompt (ADR-0019 is unaffected by this component).

## 5. Behavior & control flow

Two deterministic pipelines: the **inbound guard** (runs before the model sees external
text) and the **action guard** (runs before any tool executes). A third path is the
**approval handler** invoked by a human tap.

```
INBOUND GUARD (deterministic, 100%)
  external span arrives
    -> Core tags provenance (operator | untrusted)         [Core/01, not Safety]
    -> if untrusted:
         defang() : strip markdown images + auto-loading resources   [unconditional]
                    neutralize/strip foreign URLs                     [unconditional]
                    defang known injection patterns                   [unconditional]
         classify() in OVERLAPPING WINDOWS (chunk-boundary safe)      [advisory]
             clean      -> stays untrusted (no downgrade)
             suspicious -> add injection framing
             injection  -> hard injection framing + force clarification
    -> span enters context still tagged `untrusted`

ACTION GUARD (deterministic, 100%)
  resolved tool call + current context
    -> normalize call (canonical paths, decoded args, expanded aliases)
    -> HARD_DENY match? --yes--> DENY (logged + diff card)            [ADR-0009]
    -> isNarrowed(ctx)?  (any untrusted span present)                 [ADR-0027]
         yes -> tool in drop set?        --yes--> DENY (outbound lockout)
                tool args derive from untrusted span? --yes--> DENY (motivated-call block)
                else Tier-2/3 -> ASK; Tier-0/1 -> allow
         no  -> tier gate by global autonomy level                   [ADR-0011]
                  Tier 0 -> allow
                  Tier 1 -> allow (worktree, reversible)
                  Tier 2 -> allow if autonomy >= Delegation else ASK
                  Tier 3 -> ALWAYS ASK via red card (no skip-permissions)
    -> on allow: forward to sandbox (04 executes)                    [ADR-0012]
    -> on outbound HTTP: EgressGuard.inspectBody()                   [ADR-0010]
```

Capability-narrowing exit (ADR-0027): narrowed mode clears **only** on a subsequent
`operator` turn that does not itself carry untrusted content. Processing untrusted content
and then acting on it requires the human back in the loop; the cost is surfaced as a
proactive approval card, never a silent block.

Egress data-side scan (ADR-0010, CSO-H1). For any outbound request the proxy lets through
the host allowlist, the body and query string are additionally scanned in code:

```
EgressGuard.inspectBody(req, ctx):
  if destination.mode == 'read-only' and req.method writes/has body -> DENY
  if scan(req.body): size > limit OR entropy > threshold OR secret-pattern hit -> DENY
  if isNarrowed(ctx) and req.queryString contains free-text user data -> DENY
  else allow
```

Human confirmation (ADR-0029). The model proposes a fact or deletion; Safety strips any
`is_human_confirmed` (or other trust/permanence) field from model/generator/judge output
before staging. The flag is then set **only** here, by the deterministic handler:

```
ApprovalHandler.confirm(nonce, actionHash, secondFactor):
  reject if nonce already used (replay) or stale
  reject if actionHash != pending action's hash
  re-verify stagedHashAtPromote == stagedHashAtAccept  -> mismatch aborts to human review (TOCTOU)
  if action is Tier-3 / money / memory-permanence:
       require valid secondFactor (passphrase/TOTP/retype) -> else REJECT
  set is_human_confirmed; append {tap -> action} audit binding
```

Nightly Tier-3 carve-out (Eng-13). The nightly job (10) requests maintenance ops; Safety
only permits those on the bounded carve-out allowlist, each gated by its precondition and
preceded by the pre-VACUUM DB snapshot so a corrupted op is reversible. Anything not on the
list — including any `--force` push — is denied exactly as in a live session; HARD_DENY
stays active at night.

## 6. Dependencies

- **Internal:**
  - **Core / Agent Loop (01)** — sets provenance per span at ingestion; Safety consumes it.
  - **Tools & Hooks (04)** — runs `PreToolUse`/`PostToolUse`; Safety supplies the verdict
    those hooks enforce (ADR-0009, ADR-0014).
  - **MCP (07)** — provides the read-vs-write/side-effecting classification of each MCP
    tool that the narrowed drop set and egress mode rely on (ADR-0013).
  - **Nightly Consolidation (10)** — requests unattended maintenance; Safety gates it via
    the carve-out allowlist and strips trust flags from generated memory ops.
  - **Gateway (02)** — renders the red Tier-3 confirmation card and routes the human tap
    back to the approval handler.
- **External:**
  - **Docker + gVisor (`runsc`)** sandbox runtime — ADR-0012.
  - **Egress proxy** (allowlist daemon outside the agent process) — ADR-0010, ADR-0012.
  - **Injection classifier** model (DeepSeek V4-Flash class) — ADR-0028 (advisory only).

## 7. Failure & degraded modes (mandatory)

| Failure | Detection | Behavior | Recovery |
|---|---|---|---|
| **Cold start** — policy/rule-set or tier table not yet loaded | Action guard sees uninitialized policy | **Fail-closed**: deny every Tier-2/3 call and all outbound until policy loaded; Tier-0 reads allowed | Auto-allow resumes once HARD_DENY set, tier table, and drop set are loaded and self-checked |
| **Provenance label missing/unparsable on a span** | Core did not set `operator`/`untrusted` | **Fail-safe**: treat span as `untrusted` -> narrowed mode engages | Re-ingest with valid provenance on next operator turn |
| **Injection classifier unavailable / times out** (CSO-C2) | No verdict within budget | **Degrade, never downgrade**: skip classify; default-quarantine and unconditional transforms still hold; span stays `untrusted` | Classifier returns later; quarantine floor never depended on it |
| **PreToolUse hook errors or times out** | Hook runtime (04) returns error/no verdict | **Fail-closed**: action denied, logged | Operator retries; verdict recomputed |
| **Untrusted + private co-occurrence** (CSO-C1) | `isNarrowed(ctx)` true | Outbound lockout: drop set (Telegram send, HTTP, `git push`, write/side-effecting MCP) disabled; Tier-2/3 -> ask | Operator turn without untrusted content clears narrowed mode (ADR-0027) |
| **Motivated tool call** — args derive from an untrusted span | Provenance taint tracking on call args | **Fail-closed**: blocked at PreToolUse even if tool itself allowed | Operator re-issues from a trusted turn (ADR-0027) |
| **Egress host on allowlist but body carries secret/high-entropy/oversized data** (CSO-H1, CSO-M3) | `EgressGuard.inspectBody` scan hit | **Fail-closed**: outbound request denied + logged with redacted reason | Operator reviews; resend without sensitive payload |
| **Write attempted to a read-only egress destination** (CSO-H1) | Destination `mode == 'read-only'` + write/body present | **Fail-closed**: denied | Add explicit human-approved read-write allowlist entry |
| **Free-text user data in query string while untrusted content in context** (CSO-H1) | `isNarrowed` + query-string scan | **Fail-closed**: denied | Move to a trusted turn |
| **Egress proxy unavailable** (ADR-0010, ADR-0012) | Proxy connection refused/timeout | **Fail-closed**: no outbound; sandbox is `--network none` so tools cannot bypass | Restore proxy; egress bridge re-established per task |
| **gVisor (`runsc`) absent on host** (CSO-M1) | Runtime probe at sandbox start | **Degrade to documented lower security level**: run namespace/cap-drop/seccomp only; **gate high-risk tools off** in this mode | Restore gVisor-capable host to re-enable high-risk tools |
| **`docker.sock` or disallowed mount requested** (CSO-M1) | Mount-spec check against allowlist | **Fail-closed**: container not started | Fix task to use only the agent's own worktree mount |
| **Egress bridge not torn down after task** (CSO-M1) | Per-task teardown assertion | **Fail-closed**: task marked failed; bridge force-removed | Deterministic teardown re-run; next task gets a fresh bridge |
| **Approval replay / stale tap** (ADR-0029) | Nonce already used or expired | **Reject**: no flag set | New card with fresh nonce issued |
| **Staging-area swap between judge-accept and promote (TOCTOU)** (ADR-0029) | `stagedHashAtPromote != stagedHashAtAccept` | **Abort**: route to human review; no promotion | Re-stage and re-approve |
| **Second factor missing on permanence/Tier-3 approval** (ADR-0029) | Handler step-up check | **Reject**: flag not set | Re-approve with valid second factor; lost factor -> documented out-of-band operator reset |
| **Nightly op not on carve-out allowlist or precondition fails** (Eng-13) | Carve-out predicate check | **Fail-closed**: op skipped, reported on morning card; HARD_DENY active | Operator runs it under explicit live-session approval |
| **HARD_DENY rule-set load corrupt** | Self-check on load fails | **Fail-closed**: deny all non-Tier-0 until a valid set loads | Reload last-known-good rule set |

## 8. Security & threat model

Threats mapped to deterministic mitigations. "Code" means enforced 100% in this component
or the hooks it drives; "Model" means advisory only and never load-bearing.

| Threat (STRIDE / OWASP-LLM) | Deterministic mitigation | Enforced by |
|---|---|---|
| **Indirect prompt injection drives exfiltration** (OWASP LLM01; CSO-C1) | Capability narrowing: while any `untrusted` span is in context, the drop set (Telegram send, outbound HTTP, `git push`, write/side-effecting MCP) is disabled and Tier-2/3 drop to ask-only (ADR-0027) | Code |
| **Classifier false negative becomes trusted instructions** (CSO-C2) | Default-quarantine: all external text is `untrusted` by default; classifier escalates only, never downgrades; unconditional image/URL strip + injection defang run 100% of the time; overlapping-window classification defeats chunk-boundary hiding (ADR-0028) | Code (transforms) + Model (advisory escalate) |
| **Spoofed `is_human_confirmed` to mint/permanently-delete a fact** (Tampering/Spoofing; OWASP LLM03; CSO-C3) | Field stripped from all model/generator/judge output; set only by the deterministic handler bound to a human tap on a hash-pinned diff, with per-action nonce, staging hash re-verify (TOCTOU), and step-up second factor for permanence (ADR-0029) | Code |
| **Allowlisted host abused as exfil sink / write sink** (Exfiltration; CSO-H1) | Data-side egress: outbound-body size/entropy/secret-pattern scan; read-only destinations cannot be write sinks; no free-text user data in query strings while untrusted content is in context (ADR-0010) | Code |
| **Container escape to host / privilege escalation** (Elevation; CSO-M1) | Never mount `/var/run/docker.sock`; default-deny mounts with the agent's own-worktree-only allowlist; `cap-drop ALL` + `no-new-privileges` + seccomp profile + user-namespace remap; gVisor when present, and high-risk tools gated off when absent; per-task egress bridge torn down deterministically (ADR-0012) | Code |
| **Irreversible damage from a single tool call** (Repudiation/Destruction) | HARD_DENY blocks `rm -rf`, `DROP`/`TRUNCATE`, `DELETE`-without-`WHERE`, `terraform destroy`, force-push, money ops, secret reads — no skip-permissions, no model vote (ADR-0009); Tier-3 always asks via red card (ADR-0011) | Code |
| **Secret leakage to a log/journal/card/context/outbound sink** (Info disclosure; CSO-M3) | `SecretRedactor` applied to every sink before write/send; secret-shaped patterns redacted in logs, audit journal, morning card, model context, and outbound bodies (ADR-0010) | Code |
| **Unattended nightly maintenance wipes data with no recovery** (Destruction; Eng-13) | Only the bounded carve-out allowlist runs unattended; each op precondition-gated and preceded by a pre-VACUUM DB snapshot (reversible); `--force` push forbidden; HARD_DENY stays active at night | Code |
| **Motivated call laundering attacker data through an allowed tool** (LLM01) | Provenance taint on call args: a call whose args derive from an `untrusted` span is blocked at PreToolUse even if the tool is otherwise allowed (ADR-0027) | Code |

What the model is trusted with: reasoning over quarantined content, proposing tool calls,
drafting. What it is **never** trusted with: granting a capability, setting a trust flag,
opening an outbound channel while untrusted text is present, or downgrading quarantine.

## 9. Acceptance criteria (mandatory)

Each criterion is a single objectively verifiable assertion for a Phase-3 test.

1. **AC-05-1** — A normalized call matching any HARD_DENY pattern (`rm -rf`,
   `DROP`/`TRUNCATE`, `DELETE` without `WHERE`, `terraform destroy`, `git push --force`,
   a money-op call, a secret-file read) returns `decision: 'deny'` with the matched
   `rule` id, and the tool does not execute. (ADR-0009)
2. **AC-05-2** — An obfuscated variant of a HARD_DENY command (alias/encoded/relative
   path) is normalized first and still returns `deny`. (ADR-0009)
3. **AC-05-3** — With no untrusted span in context and global autonomy below Delegation,
   a Tier-2 call returns `ask`; a Tier-3 call returns `ask` via the red card regardless of
   autonomy level and cannot be set to auto by any flag. (ADR-0011)
4. **AC-05-4** — With at least one `untrusted` span in context, `isNarrowed()` returns
   true and every tool in the drop set (Telegram `send`, outbound HTTP, `git push`, a
   write/side-effecting MCP tool) returns `deny`; the same calls return `allow`/`ask`
   when no untrusted span is present. (CSO-C1, ADR-0027)
5. **AC-05-5** — A tool call whose arguments are derived from an `untrusted` span is
   blocked at PreToolUse even when the tool itself is on the allowed set. (CSO-C1, ADR-0027)
6. **AC-05-6** — Narrowed mode clears only after an `operator` turn carrying no untrusted
   content; an `operator` turn that itself carries an untrusted span keeps narrowed mode
   active. (ADR-0027)
7. **AC-05-7** — Every external (non-operator) span is tagged `untrusted` at ingestion;
   a span with a missing/unparsable provenance label is treated as `untrusted`. (CSO-C2,
   ADR-0028)
8. **AC-05-8** — The injection classifier returning `clean` does not change a span's tag
   from `untrusted` to `trusted` and does not remove quarantine framing; only `suspicious`/
   `injection` verdicts escalate. (CSO-C2, ADR-0028)
9. **AC-05-9** — `defang()` removes markdown images and auto-loading resources, neutralizes
   foreign URLs, and defangs known injection patterns on 100% of untrusted spans, including
   when the classifier is unavailable. (CSO-C2, ADR-0028)
10. **AC-05-10** — An injection payload split across two adjacent chunks below the
    classification window is still flagged because classification runs in overlapping
    windows. (CSO-C2, ADR-0028)
11. **AC-05-11** — An `is_human_confirmed` (or other trust/permanence) field present in
    generator/judge/model output is stripped before staging and is absent from the staged
    artifact. (CSO-C3, ADR-0029)
12. **AC-05-12** — `is_human_confirmed` is set only by `ApprovalHandler.confirm`, which
    appends an audit record binding the tap (nonce) to the exact `factId`/`op`; no other
    code path sets the flag. (CSO-C3, ADR-0029)
13. **AC-05-13** — A replayed or stale nonce, or an `actionHash` that does not match the
    pending action, is rejected and sets no flag. (CSO-C3, ADR-0029)
14. **AC-05-14** — When `stagedHashAtPromote` differs from `stagedHashAtAccept`, promotion
    aborts and routes to human review with no flag set. (CSO-C3, ADR-0029)
15. **AC-05-15** — A Tier-3 / money / memory-permanence approval with no valid second
    factor is rejected; the same with a valid second factor succeeds. (CSO-C3, ADR-0029)
16. **AC-05-16** — An outbound request to an allowlisted host whose body trips the
    size, entropy, or secret-pattern scan is denied and logged. (CSO-H1, ADR-0010)
17. **AC-05-17** — A write request (or request carrying a body) to an egress destination
    whose `mode` is `read-only` is denied. (CSO-H1, ADR-0010)
18. **AC-05-18** — While any `untrusted` span is in context, an outbound request carrying
    free-text user data in its query string is denied. (CSO-H1, ADR-0010)
19. **AC-05-19** — Sandbox start aborts (container not created) if the mount spec requests
    `/var/run/docker.sock` or any path outside the agent's own-worktree allowlist. (CSO-M1,
    ADR-0012)
20. **AC-05-20** — A started sandbox container reports `cap-drop ALL`, `no-new-privileges`,
    an applied seccomp profile, and user-namespace remap. (CSO-M1, ADR-0012)
21. **AC-05-21** — When the `runsc` probe reports gVisor absent, the system records the
    degraded security level and every tool marked high-risk returns `deny`. (CSO-M1,
    ADR-0012)
22. **AC-05-22** — The per-task egress bridge is torn down after task completion; a task
    whose teardown assertion fails is marked failed and the bridge is force-removed. (CSO-M1,
    ADR-0012)
23. **AC-05-23** — A nightly maintenance op not on the carve-out allowlist (or whose
    precondition predicate is false) is skipped, reported on the morning card, and not
    executed; a `--force` push at night is denied. (Eng-13)
24. **AC-05-24** — Each carve-out op that runs unattended (`VACUUM`, `FTS5 optimize`,
    `WAL checkpoint`, log rotation, scoped `docker prune`, worktree prune, fast-forward
    `git push`) has its pre-VACUUM DB snapshot committed before it runs, so the op is
    reversible by snapshot. (Eng-13)
25. **AC-05-25** — Secret-shaped values are redacted by `SecretRedactor` in every sink —
    application logs, the append-only audit journal, the morning approval card, the model
    context, and outbound bodies — verified by injecting a known secret pattern and
    asserting it appears in none of them. (CSO-M3, ADR-0010)
26. **AC-05-26** — Cold start: before the policy/rule-set and tier table are loaded, every
    Tier-2/3 call and all outbound requests return `deny`; auto-allow resumes only after
    the rule set, tier table, and drop set are loaded and self-checked. (§7 cold start)
27. **AC-05-27** — A PreToolUse hook error or timeout results in `deny` (fail-closed), not
    `allow`. (ADR-0009, §7)
28. **AC-05-28** — When the egress proxy is unavailable, no outbound request succeeds, and
    a sandboxed tool (running `--network none`) cannot open an outbound socket to bypass it.
    (ADR-0010, ADR-0012, §7)

## 10. Open questions

- **Separate no-memory sub-agent for high-risk corpora.** ADR-0027 keeps in-loop narrowing
  as the day-one default and lists a memory-less sub-agent as a stronger future option for
  high-risk untrusted corpora. Deferred to a later milestone.
- **Cryptographic per-fact signing vs flag + audit binding.** ADR-0029 keeps the
  deterministic handler + audit binding for day one and lists user-key signing as a future
  hardening option. Deferred.
- **Lost second-factor recovery.** ADR-0029 specifies an operator-level out-of-band reset
  documented in SECURITY; the exact reset procedure is owned by SECURITY, not this spec.

## 11. References

- ADRs:
  - [ADR-0009 — Deterministic Pre/PostToolUse hooks](../decisions/2026-06-11-deterministic-tool-hooks.md)
  - [ADR-0010 — Break the lethal trifecta via separation](../decisions/2026-06-11-break-lethal-trifecta.md)
  - [ADR-0011 — Autonomy gradient (tiers 0–3)](../decisions/2026-06-11-autonomy-gradient.md)
  - [ADR-0012 — Docker sandbox as default](../decisions/2026-06-11-docker-sandbox-default.md)
  - [ADR-0027 — Capability narrowing when untrusted content is in context](../decisions/2026-06-11-capability-narrowing-untrusted-context.md)
  - [ADR-0028 — Default-quarantine for external input](../decisions/2026-06-11-default-quarantine-external-input.md)
  - [ADR-0029 — Human-confirmation provenance and approval integrity](../decisions/2026-06-11-human-confirmation-provenance-binding.md)
- Concept docs:
  - [Safety layer](../concepts/safety-layer.md)
  - [MCP integration](../concepts/mcp-integration.md)
  - [Nightly consolidation](../concepts/nightly-consolidation.md)
</content>
</invoke>
