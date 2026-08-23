# ADR-0013: MCP Allowlist + Version Pinning + Descriptor Hashing

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** security, mcp

## Context
MCP tool descriptions are read by the model but rarely by the human. This asymmetry
is exploitable: about 5.5% of surveyed MCP servers carry malicious instructions
embedded in tool descriptions (tool poisoning). The model treats a descriptor as
trusted system text, so a poisoned `description` can inject commands, exfiltrate
context, or jump ahead of other tools ("line-jumping"). A second class of attack is
the rug-pull: a server serves a clean descriptor on first connect, passes review,
then swaps in a malicious one on a later version or live re-fetch.

Aisy connects external MCP servers to a single-user agent that holds private memory
and has outbound channels — exactly the lethal-trifecta surface where one poisoned
tool can turn a routine session into data exfiltration. We need deterministic,
code-level controls, not model judgment, since prompt rules hold at ~70% while code
hooks hold at 100%. This complements the input-classification boundary defined in
ADR-0010, which already treats all external text as untrusted.

## Decision
Connect MCP servers only from a curated allowlist, pin each server to an exact
version, hash every server's tool descriptors on connect, run each server in its own
minimal-scope process, and route all MCP output through the same input classifier as
any other external text.

- **Allowlist only.** No open discovery, no marketplace auto-install. A server enters
  the allowlist via explicit human review; everything else is refused at connect.
- **Version pinning.** Each allowlisted server is pinned to an exact version/digest.
  An unpinned or mismatched version is refused (blocks supply-chain swaps).
- **Descriptor hashing.** On connect, hash the full set of tool descriptors. A changed
  hash after an update disables the server and emits a diff card for human review
  instead of silently trusting new instructions (defeats rug-pull and line-jumping).
- **Per-process isolation.** Each server runs in its own process with a minimal-scope
  token, so a compromised server cannot reach another server's credentials or scope.
- **Classify output.** MCP tool results pass through the input classifier (strip
  foreign URLs/markdown images, flag injection patterns) like any untrusted text.

## Consequences
- **Positive:** Tool poisoning and rug-pulls are caught deterministically at the code
  layer, not left to the ~70%-reliable model. Version pinning closes the supply-chain
  swap path. Per-process isolation contains blast radius to a single server.
- **Neutral:** A new server requires a one-time human allowlisting step; legitimate
  descriptor updates require approving a diff card before the server resumes.
- **Negative:** Operational friction on every upgrade; maintenance of the allowlist,
  pins, and stored hashes. The classifier adds latency to MCP responses.

## Alternatives considered
**Open marketplace / auto-install.** Convenient discovery but inherits poisoned
registries and unvetted descriptors directly into the prompt — the exact 5.5%
tool-poisoning surface we are trying to remove. Rejected.

**No pinning (track latest).** Simpler, but a server can ship a clean version for
review and push a malicious one as "latest," giving a supply-chain swap with no gate.
Rejected; pinning is the cheapest defense against this.

**Single shared process for all servers.** Lower overhead, but one compromised server
sees every other server's tokens and scope, collapsing isolation. Rejected in favor
of minimal-scope per-process tokens.

## References
- [ADR-0010](./2026-06-11-break-lethal-trifecta.md) — Break the Lethal Trifecta via Separation (untrusted input classification)
- Invariant Labs, "Tool Poisoning Attacks" (MCP), 2025
- Simon Willison, "The lethal trifecta for AI agents," 2025
