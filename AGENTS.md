# AGENTS.md

Instructions for AI coding agents (Claude Code, Cursor, Copilot, etc.) working
**on the Aisy Agent codebase**. This is the [agents.md](https://agents.md)
standard file; it is about developing the repo, not the runtime persona (that is
`SOUL.md` in a deployed instance).

## What this project is

Aisy Agent is a personal LLM harness — an "OS around the model." Core in
TypeScript, Python only for sidecars. Read [VISION.md](VISION.md) and
[ARCHITECTURE.md](ARCHITECTURE.md) before non-trivial work.

## Ground rules

- **Brand:** the project is **Aisy**; keep the name consistent across code,
  docs, and commits.
- **Decisions need ADRs.** Any consequential architectural change ships with an
  ADR in `docs/decisions/` (MADR 3.0, filename `YYYY-MM-DD-kebab-slug.md`) and a
  row in `docs/decisions/INDEX.md`. Check the index before proposing something
  that may conflict with an existing decision.
- **Code decides the irreversible.** Safety boundaries are deterministic code,
  not prompts. Do not move a HARD_DENY check, sandbox flag, or budget into a
  place where an LLM can bypass it.
- **Docs are English.** All public docs, comments, and ADRs in English.

## Repository layout

```
packages/core-ts/      # harness core (TypeScript)  — agent-loop, hooks, memory, models, mcp, skills, safety
packages/sidecars-py/  # Python sidecars (Whisper, optional scoring)
packages/sdk-ts/  sdk-py/   # client SDKs
docs/decisions/        # ADRs (the why)
docs/specs/            # component specs (the what)
docs/concepts/         # deep dives
```

## Working conventions

- **Match the surrounding code.** Comment density, naming, and idiom.
- **Surgical changes.** Touch only what the task needs; do not refactor adjacent
  code or delete pre-existing dead code unless asked.
- **Simplicity first.** Minimum code that solves the problem; no speculative
  abstractions or config that was not requested.
- **Tests trace to specs.** Each component spec carries acceptance criteria;
  every criterion gets a test. TS uses vitest, Python uses pytest.
- **Commit messages** are imperative and scoped; reference the ADR or spec when
  relevant. Do not commit unless asked.

## Build & test (placeholders until tooling lands)

```bash
pnpm install          # workspace deps
pnpm -r build         # build all packages
pnpm -r test          # vitest across TS packages
uv run pytest         # Python sidecar tests
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for full setup.

## Before you finish

- Re-read changed files and verify against the task.
- If you changed 3+ files, run a review pass.
- If you made a consequential decision, propose an ADR — do not create it
  silently.
