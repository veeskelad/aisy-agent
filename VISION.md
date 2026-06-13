# Vision

## The problem

Personal AI harnesses today force a bad trade. The mature ones (OpenClaw-class)
give you channels, cron, and plug-ins, but their loop guards miss simple
cycles, their background jobs fail silently, and their memory is an injection
surface. The ambitious ones (Hermes-class) grow skills and remember everything,
but they learn only from successes, let the model grade its own homework, and
write to production memory with the approval gates off. Both leave the hardest
parts — durable portable memory, deterministic safety, and *verified*
self-improvement — for you to build yourself.

And both share one structural flaw: they ask the language model to be careful.
A model follows instructions about 70% of the time. For deleting data, moving
money, or deploying, 70% is not a reliability number — it is a category error.

## The thesis

**The language model is a CPU; the harness is the OS.**

The model is a powerful, stateless processor: it reasons well, forgets
everything, can err on any step, and knows no boundaries. Everything else —
memory, permissions, scheduling, logging, model switching — is the operating
system we build around it. From this follows the single rule the whole system
rests on:

> Reversible and creative work goes to the model. Irreversible and critical
> work is decided by code.

Code hooks run 100% of the time; prompt rules run ~70%. So deletion, deploy,
money, budgets, and fallback never depend on whether the model noticed an
instruction.

## What Aisy is

Aisy Agent is an open-source harness for a **single user's** personal agent,
reachable from Telegram or an IDE, that:

- **Remembers durably and portably** — memory is markdown files in git, indexed
  by SQLite FTS5/BM25. It is human-readable, editable, and survives a change of
  LLM. Deletions *stick*: a forget-list and tombstones mean "forget this" is
  permanent, and the nightly consolidation can never resurrect it.
- **Is safe by construction** — deterministic hooks, a sandbox with no network,
  secrets in a vault, and a broken lethal trifecta. The model cannot be talked
  past the boundary because the boundary is not the model.
- **Improves itself, but verifiably** — a nightly loop drafts new skills and
  facts with a cheap generator, validates them with a *separate* judge and
  deterministic checks, and ships nothing to production without passing
  verification and (at first) a human tap.
- **Survives model and provider churn** — a router picks the right model per
  task and falls back on sustained provider errors; the agent's identity lives
  in a file, not in a vendor.

## Who it is for

Technical individuals and builders who want to run their own autonomous agent
and keep control of its memory, its permissions, and its bills. People who would
rather read a markdown file than trust a black box.

## Non-goals

- Not a multi-tenant SaaS. Aisy is single-user by design; one shared memory file
  across users is exactly the leak we avoid.
- Not a model or a fine-tune. Aisy wraps models; it does not train them.
- Not a no-code product. Everything stays a file you can edit and a log you can
  read — but day-0 is guided and validated (`aisy init` + `aisy doctor` + a
  first-run conversation), not a raw config-editing cliff. See
  [ADR-0034](docs/decisions/2026-06-11-onboarding-operations-layer.md).
- Not "set it and forget it from day one." A useful agent takes weeks of
  shaping; Aisy is the substrate that makes that shaping durable.

## How Aisy differs

| Dimension | OpenClaw-class | Hermes-class | **Aisy** |
|---|---|---|---|
| Memory | files, but an injection surface | full archive, self-poisoning | files + FTS5/BM25, tombstones, durable forgetting |
| Self-learning | minimal | learns only successes, self-judged | generator + separate judge + deterministic validators + human gate |
| Safety boundary | prompt + partial guard | "the OS is the only boundary" | deterministic hooks + sandbox + broken trifecta |
| Loop control | period-1 only | — | period 1/2/3, repeat cap |
| Identity | config | per-agent | portable SOUL.md, survives LLM swap |
| Cost control | weak | expensive background loop | budgets in code, cheap nightly tier, KV-cache |

## Principles

1. **Code decides the irreversible.** Always. See
   [ADR-0009](docs/decisions/2026-06-11-deterministic-tool-hooks.md).
2. **Memory is a file you can read and a deletion that stays deleted.** See
   [ADR-0006](docs/decisions/2026-06-11-file-based-memory-fts5-bm25.md) and
   [ADR-0023](docs/decisions/2026-06-11-durable-forgetting-tombstones.md).
3. **Never trust a model's "done."** Verify against real traces. See
   [ADR-0017](docs/decisions/2026-06-11-external-verification-by-traces.md).
4. **Learn from failure, not just success — and never self-grade.** See
   [ADR-0016](docs/decisions/2026-06-11-generator-judge-self-learning.md).
5. **Identity outlives the model.** See
   [ADR-0001](docs/decisions/2026-06-11-adopt-aisy-brand-and-file-naming.md).

See the [ROADMAP](ROADMAP.md) for how this gets built, and
[ARCHITECTURE](ARCHITECTURE.md) for how it fits together.
