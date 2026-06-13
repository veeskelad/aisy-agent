# ADR-0012: Docker Sandbox as Default

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** security

## Context
Agent code execution is the highest-blast-radius surface in the harness. A 2026
survey of AI coding agents found 6 of 7 ran with no sandbox at all, and all 7
were vulnerable to prompt injection — meaning untrusted input could steer them
into arbitrary command execution. The incidents are concrete: DataTalksClub's
Claude Code ran `terraform destroy` and wiped 1.9M rows (2026-03-06), Replit
deleted a production database, and Amazon Kiro logged 4 Sev-1 events in a single
week.

HARD_DENY regex hooks stop known irreversible commands at the OS layer, but
regex is a denylist — it cannot anticipate every dangerous invocation. We need a
second, structural barrier so that even a successful injection lands in an
environment where destructive action is physically impossible: no prod
credentials, no network, no host filesystem, no persistence. This is the
defense-in-depth NIST asks for — at least one deterministic enforcement layer
not judged by an LLM.

Constraints: single-user personal agent on a modest VPS; must not block normal
reversible/creative work; must keep an auditable trail of any egress.

## Decision
By default, all agent-initiated code runs inside a one-shot Docker sandbox; the
container has no path to production and no unsupervised network. Network access,
when needed, flows only through an explicit egress proxy backed by an allowlist
that logs every request.

Container baseline:
- `--network none`, `--read-only` root, `tmpfs` for scratch
- `--cap-drop ALL`, `--security-opt no-new-privileges`
- `--pids-limit`, memory and CPU caps to bound runaway loops
- non-root user; only the agent's **own** worktree mounted (nothing else)
- one-shot lifecycle: fresh container per task, destroyed on exit
- gVisor (`runsc`) runtime added wherever the VPS kernel/host permits, for
  syscall-level isolation on top of namespaces

Egress, when a task legitimately needs the network, is granted by switching the
container onto a bridge whose only route is the egress proxy; the proxy enforces
a per-task domain allowlist and writes a request log. This also satisfies the
lethal-trifecta rule: the outbound channel is constrained outside the agent
process, so private data plus untrusted input can no longer combine into free
exfiltration.

## Consequences
- **Positive:** Injection blast radius collapses — even if the model *wanted*
  `terraform destroy`, there are physically no prod creds inside the box.
  Deterministic, not LLM-judged. Every egress request is allowlisted and logged.
  One-shot lifecycle means no state survives to be poisoned across tasks.
- **Neutral:** Adds a sandbox-orchestration component and an egress proxy to
  operate and monitor. Running cost (VPS $20 + API + monitoring) lands at
  roughly $90-220/month depending on usage.
- **Negative:** Container spin-up adds latency per task; some legitimate tools
  (new outbound hosts, extra mounts) require an explicit allowlist edit, adding
  friction. gVisor is unavailable on some constrained/nested-virt VPS hosts, so
  isolation strength varies by deployment.

## Alternatives considered
**Host execution** (run agent commands directly on the VPS): zero isolation
overhead, but this is exactly the configuration that left 6 of 7 surveyed agents
exploitable — one injection reaches real credentials and the host filesystem.
Rejected outright.

**Privileged or persistent containers** (long-lived container, `--privileged`
or broad caps for convenience): nearly host-equivalent risk — privileged
containers can escape to the host, and persistence lets a poisoned state or
planted file survive between tasks, defeating the one-shot guarantee. Rejected.

## References
- [Simon Willison — the lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)
- [gVisor (runsc) sandbox runtime](https://gvisor.dev/)
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
- Related: [ADR-0009](./2026-06-11-deterministic-tool-hooks.md)
