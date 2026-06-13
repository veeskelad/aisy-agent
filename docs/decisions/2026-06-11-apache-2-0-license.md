# ADR-0002: Apache-2.0 License

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** license

## Context
Aisy is a public open-source harness others will build on: skills, MCP servers,
provider adapters, and hooks are all extension points meant to attract third-party
contributions and downstream forks. For a framework, the licensing choice is not
just about copyright — the explicit patent grant matters. MIT conveys no patent
rights, leaving both us and our users exposed to patent claims from contributors;
Apache-2.0 grants a royalty-free patent license and includes a defensive
termination clause if a user initiates patent litigation.

The agent ecosystem is split along exactly this line. MIT camp: OpenHands,
LangGraph, CrewAI. Apache-2.0 camp: Letta, Goose. Our own dependencies straddle
the divide — anima_sdk (Rai220) is MIT, RTK (Rust Token Killer) is Apache-2.0.
Both are inbound-compatible with Apache-2.0 as the outbound license.

We also want to keep a commercial path open for any future closed `/ee`
(enterprise edition) without relicensing the public core or re-asking every
contributor. Permissive licensing on the core enables that dual-license model.

## Decision
License the public core under **Apache-2.0**, and keep a dual-license path open:
Apache-2.0 for the public core plus a separate commercial license for any future
closed `/ee` modules. Require a DCO sign-off on contributions so the core stays
permissively licensed and re-licensable for the enterprise path.

## Consequences
- **Positive:** Explicit patent grant protects Aisy and its users; defensive
  termination deters patent aggressors. Compatible with both MIT (anima_sdk) and
  Apache-2.0 (RTK) inbound. Aligns with the Letta/Goose framework norm. Permissive
  core leaves the closed `/ee` commercial path fully open.
- **Neutral:** NOTICE file and per-file license headers become a maintenance
  obligation. Apache-2.0 is more verbose than MIT but well understood by tooling.
- **Negative:** Permissive licensing permits closed-source SaaS forks of Aisy with
  no obligation to contribute back — the classic "AWS strip-mine" risk that
  copyleft would have blocked.

## Alternatives considered
**MIT** — simplest and matches anima_sdk, but conveys no patent grant. For a
framework that takes external contributions and is built upon by others, the
absence of a patent license is a real exposure, not a theoretical one. Rejected
on the patent grant alone.

**AGPL-3.0** — strong copyleft would close the SaaS-fork loophole by forcing
network-served modifications to be published. But copyleft materially deters
adoption of a framework: downstream builders fear license contamination of their
own agents and skills, and corporate legal teams routinely block AGPL
dependencies. The adoption cost outweighs the fork protection for a project whose
value depends on a broad extension ecosystem. Noted as a possible future relicense
if closed SaaS forks become a concrete threat.

## References
- [ADR-0004](./2026-06-11-typescript-for-core.md)
- Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0
- Developer Certificate of Origin: https://developercertificate.org/
- Letta (Apache-2.0): https://github.com/letta-ai/letta
- Goose (Apache-2.0): https://github.com/block/goose
