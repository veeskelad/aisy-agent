# Security Policy

Aisy is a single-user personal agent: an LLM ("CPU") wrapped in a deterministic
harness ("OS"). Because the agent can read your files, run tools, browse the web,
talk to MCP servers, and act on your behalf, security is a first-class concern of
this project rather than an afterthought.

This document describes our threat model, the layered defenses the harness ships,
which versions we support, and how to report a vulnerability responsibly.

## Core security principle

The LLM is a stateless, probabilistic component with roughly 70% adherence to
instructions. The harness is deterministic code with 100% adherence. We never
delegate an irreversible or critical decision to the model alone.

- **Reversible / creative work** (drafting, summarizing, proposing) → the model.
- **Irreversible / critical work** (delete, deploy, money, budgets, fallback,
  egress) → enforced by code.

Every sensitive flow is guarded by **at least one deterministic enforcement layer
that is not judged by an LLM**, consistent with NIST guidance. Prompt-level rules
are defense-in-depth, not the control of record.

## Threat model

The harness is designed to resist the following classes of attack. Each maps to
one or more architectural decisions recorded under `docs/decisions/`.

### 1. The lethal trifecta

The combination of (a) access to **private data**, (b) exposure to **untrusted
input**, and (c) an **outbound channel** is sufficient for data exfiltration. For
every sensitive flow we break at least one leg of the trifecta:

- Secrets live in a vault, never in the prompt or working memory.
- The egress allowlist is enforced **outside** the agent process.
- Outbound content is sanitized: markdown images, auto-loading resources, and
  foreign/untrusted URLs are stripped before any channel send.

See `docs/decisions/2026-06-11-break-lethal-trifecta.md` (ADR-0010).

### 2. Prompt injection — direct and indirect

- **Direct**: a user or operator message that tries to override the constitution
  or safety hooks.
- **Indirect**: malicious instructions embedded in tool output, fetched web
  pages, file contents, email, or MCP responses ("the document told me to").

Mitigation: all external text — including MCP output — passes through an input
classifier before it can influence tool selection, and irreversible actions are
gated by deterministic hooks that a successful injection still cannot bypass.

See `docs/decisions/2026-06-11-break-lethal-trifecta.md` (ADR-0010).

### 3. MCP tool poisoning and rug-pull

Roughly 5.5% of surveyed MCP servers carry malicious instructions inside tool
descriptions. A "rug-pull" server serves a clean descriptor on first connect and
swaps in a malicious one later.

Mitigation:

- **Allowlist only** — no ambient discovery of arbitrary servers.
- **Version pinning** of every MCP dependency.
- **Hashing tool descriptors on connect**; a changed hash disables the server and
  emits a human-reviewable diff card instead of silently trusting the new text.
- **Per-process, minimal-scope tokens** for each server.
- MCP output is treated as untrusted text and run through the input classifier.

See `docs/decisions/2026-06-11-mcp-allowlist-pinning-hashing.md` (ADR-0013).

### 4. Memory poisoning and resurrection of deleted facts

The harness has durable, file-based memory. Two risks:

- **Poisoning**: untrusted input being consolidated into long-term memory as if
  it were a confirmed fact.
- **Resurrection**: a fact the user explicitly deleted reappearing because
  append-only logs, nightly consolidation, or a stale index/snapshot re-derived
  it.

Mitigation: bi-temporal facts (`valid_at` / `invalid_at`, `is_human_confirmed`),
soft-delete with tombstones, an explicit `do_not_remember` forget-list, FTS5
queries that always filter `WHERE invalid_at IS NULL AND id NOT IN do_not_remember`
and reindex on change, and a **resurrection-guard** validator that blocks any
consolidation commit re-introducing a tombstoned or forbidden fact (routing it to
human review). Contradiction priority is human-confirmed > recency >
source-authority > confidence; human-confirmed deletions are permanent.

See `docs/decisions/2026-06-11-durable-forgetting-tombstones.md`
(ADR-0023).

### 5. Runaway loops and cost blow-ups

An agent stuck repeating tool calls can burn budget and trigger destructive
retries overnight. The loop guardian detects cycles of period 1, 2, and 3 in a
sliding window of recent tool calls and caps repeats at 3. (A guard that only
catches period-1 misses A-B-A-B patterns — a known, expensive failure mode.)
Provider routing fails over only after **two consecutive** errors (hysteresis),
never on the first timeout.

See `docs/decisions/2026-06-11-loop-guardian.md` (ADR-0020).

## Layered defenses

No single layer is trusted on its own. Defenses are ordered from deterministic
(strongest) to probabilistic (advisory):

| Layer | Type | Enforces |
|-------|------|----------|
| **Code hooks** | Deterministic (100%) | `HARD_DENY` regex blocks `terraform destroy`, `rm -rf`, `DROP`/`TRUNCATE`, `DELETE` without `WHERE`, `git` force-push, money operations, and reading secret files. No skip-permissions on irreversible ops. |
| **Sandbox** | Deterministic | Docker, `network: none`, read-only FS, `cap_drop: ALL`, `no-new-privileges`, one-shot containers. |
| **Vault** | Deterministic | Secrets never enter the prompt or memory; injected per-process with minimal scope. |
| **Egress allowlist** | Deterministic | Outbound destinations enforced outside the agent process. |
| **MCP pinning + hashing** | Deterministic | Version-pinned, descriptor-hashed, allowlisted servers only. |
| **Input classifier** | Probabilistic (advisory) | Screens all external/untrusted text, including MCP output, before it can steer tool use. |
| **Constitution / prompt rules** | Probabilistic (~70%) | Behavioral guidance; defense-in-depth, never the sole control. |

Agent-created skills are written to **staging** and require human approval before
they can run in production — they never reach prod automatically.

## Supported versions

Security fixes are provided for the latest minor release. Pre-1.0, the public
contract may change between minor versions; pin your dependency.

| Version | Supported |
|---------|-----------|
| Latest minor (`0.x`) | ✅ |
| Previous minors | ❌ (upgrade to receive fixes) |

We will publish a formal support window once Aisy reaches `1.0`.

## Reporting a vulnerability

**Please do not open public issues, pull requests, or discussions for security
vulnerabilities.** Public disclosure before a fix is available puts every user at
risk.

Instead, report privately through one of:

- GitHub's **"Report a vulnerability"** flow under the repository's **Security**
  tab (preferred — uses a private advisory).
- Email: `security@<MAINTAINER_DOMAIN>` *(placeholder — replace with the
  maintainer's real address before publishing the repo)*.

Please include, where possible:

- A description of the vulnerability and its impact.
- Affected version(s) and configuration.
- Reproduction steps or a proof of concept.
- Any suggested remediation.

### Our commitment (SLA)

| Stage | Target |
|-------|--------|
| Acknowledge receipt | within **3 business days** |
| Initial assessment & severity | within **7 business days** |
| Fix or mitigation for High/Critical | within **30 days** of confirmation |
| Coordinated public disclosure | by mutual agreement, typically within **90 days** |

We follow **coordinated (responsible) disclosure**. We will keep you updated on
progress, credit you in the advisory and release notes unless you prefer to remain
anonymous, and we ask that you give us reasonable time to ship a fix before any
public write-up.

### Safe harbor

Good-faith security research conducted against your own instance — without
accessing or exfiltrating other people's data, degrading service, or violating
applicable law — is welcome and will not be pursued. This is a single-user
personal agent; please test only on infrastructure you own.

## Scope

In scope: the harness code, its safety hooks, the sandbox configuration, memory
handling, provider routing, and MCP integration shipped in this repository.

Out of scope: vulnerabilities in upstream LLM providers, third-party MCP servers,
or your own host/OS configuration — though we appreciate a heads-up so we can add
defensive guidance or pinning.
