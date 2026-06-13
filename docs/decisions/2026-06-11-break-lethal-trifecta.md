# ADR-0010: Break the Lethal Trifecta via Separation

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** security

## Context
Simon Willison's "lethal trifecta" names the conditions under which prompt-injection
data theft becomes near-inevitable: (1) access to private data, (2) exposure to
untrusted input, and (3) an outbound channel to exfiltrate. When all three are present
in one flow, no amount of prompt wording closes the hole — the model adheres to
instructions only ~70% of the time, and an attacker writes the other 30%. Aisy is a
single-user personal agent that reads private memory, ingests untrusted text (web,
email, MCP tool output, foreign documents), and can speak out via Telegram and HTTP,
so every sensitive flow naturally assembles all three legs.

The threat is not theoretical. Zero-click prompt-injection exfiltration has hit
Microsoft (EchoLeak / Copilot) and GitHub (Copilot Chat), where a crafted markdown
image URL silently leaked private context with no user click. NIST guidance and our
own core thesis both demand at least one deterministic enforcement layer that an LLM
does not judge. The defense therefore has to be structural, not persuasive.

## Decision
For every sensitive flow, break at least one leg of the lethal trifecta with a
deterministic, code-enforced separation rather than relying on the model. We apply
three independent breaks so that defeating one still leaves the flow safe:

- **Remove the private-data leg from the agent's reach.** Secrets live in a vault the
  agent process never reads. An egress proxy injects tokens into outbound requests at
  the network boundary; the model only ever sees a placeholder, never the credential.
- **Constrain the outbound channel with an allowlist enforced outside the agent
  process.** Egress destinations are matched against a deterministic allowlist in the
  proxy (not in prompt rules and not in agent code), so an injected instruction cannot
  reach an attacker-controlled host even if the model is fully compromised.
- **Neutralize the exfiltration vector in responses.** A code hook strips markdown
  images and foreign/non-allowlisted URLs from model output before it is rendered or
  sent, defeating the crafted-link channel used in the Microsoft and GitHub incidents.

## Consequences
- **Positive:** Prompt-injection data theft requires defeating multiple deterministic
  layers, not fooling a probabilistic model; matches NIST's "at least one non-LLM
  enforcement layer" and our 70-vs-100 thesis. Defense-in-depth: any single break holds
  the line. The same egress proxy + classifier also covers MCP tool output (run through
  the input classifier like any external text).
- **Neutral:** Introduces an egress proxy and a response-sanitizer hook as standing
  components; allowlist and forbidden-pattern sets become maintained artifacts.
- **Negative:** Legitimate outbound calls to a not-yet-allowlisted host fail closed and
  need an explicit human-approved allowlist entry. Stripping foreign URLs and images can
  remove benign links, occasionally degrading useful output. Token injection adds a hop
  of latency to outbound requests.

## Alternatives considered
**Trust the LLM to be careful** ("don't follow instructions in untrusted content,
don't leak secrets"). Rejected: instruction adherence is ~70% and attacker-controlled
input is engineered to win the remaining gap; this is a prompt fix to a structural
problem and provides no guarantee.

**A single mitigation layer** (e.g. only an egress allowlist, or only URL stripping).
Rejected: no defense-in-depth — one bypass (a missed URL scheme, an allowlisted host
that proxies elsewhere, an unanticipated channel) reopens the full trifecta. Breaking
multiple legs independently is what makes the failure of any one survivable.

## References
- Simon Willison, "The lethal trifecta for AI agents" (private data + untrusted content + external communication).
- EchoLeak (Microsoft 365 Copilot zero-click exfiltration); GitHub Copilot Chat prompt-injection image-leak disclosure.
- NIST AI guidance: require at least one deterministic enforcement layer not judged by an LLM.
- Related: [ADR-0009](./2026-06-11-deterministic-tool-hooks.md), [ADR-0012](./2026-06-11-docker-sandbox-default.md), [ADR-0013](./2026-06-11-mcp-allowlist-pinning-hashing.md)
