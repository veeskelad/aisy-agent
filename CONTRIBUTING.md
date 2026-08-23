# Contributing to Aisy

Thanks for your interest in contributing to **Aisy** — an open-source harness
(an "OS") wrapped around an LLM ("CPU"): a single-user personal agent with
durable file-based memory, skills, MCP, deterministic safety hooks, provider
routing, and a nightly self-improvement loop.

This document explains how to get changes merged. For environment setup and
how to run things locally, see [DEVELOPMENT.md](DEVELOPMENT.md). By
participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Code of Conduct

This project and everyone participating in it is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to
uphold it. Please report unacceptable behavior through the channels listed
there.

---

## Ways to contribute

- **Bug reports** — open an issue with a minimal reproduction, expected vs.
  actual behavior, and your environment (OS, Node/pnpm version, provider).
- **Bug fixes** — small, focused PRs are easiest to review and land fastest.
- **Features** — please open an issue or discussion first so we can agree on
  scope and design before you write code. Features that change architecture,
  dependencies, or security posture also need an ADR (see below).
- **Skills** — new agent skills are welcome. Read the
  [skill requirements](#skills) before opening a PR.
- **Docs** — improvements to README, this guide, DEVELOPMENT.md, or ADRs are
  always appreciated.

When in doubt, open an issue before investing significant effort. A short
conversation up front saves a lot of rework.

---

## Repository layout

Aisy is a **pnpm monorepo**. The core is TypeScript; Python is used only for
sidecars (e.g. Whisper voice, optional scoring).

```
aisy-harness/
├── packages/            # TypeScript workspace packages (core, hooks, router, memory, ...)
├── apps/                # entry points (Telegram, IDE/CLI bridge)
├── sidecars/            # Python sidecars (Whisper, optional scoring)
├── skills/              # SKILL.md skill definitions
├── docs/
│   └── decisions/       # Architecture Decision Records (ADRs)
├── CONTRIBUTING.md
├── DEVELOPMENT.md       # dev setup, how to run & debug locally
├── CODE_OF_CONDUCT.md
└── pnpm-workspace.yaml
```

Workspace packages live under `packages/` and `apps/` and are wired together
with pnpm workspaces. Cross-package imports use the workspace protocol
(`workspace:*`) — do not reference another package by relative path across
package boundaries.

---

## Development setup

Full instructions live in [DEVELOPMENT.md](DEVELOPMENT.md). In short:

```bash
pnpm install            # install all workspace dependencies
pnpm build              # build every package
pnpm test               # run the test suite
pnpm lint               # eslint + prettier check
```

Python sidecars have their own setup; see DEVELOPMENT.md for the
`sidecars/` toolchain (virtualenv, ruff, mypy).

---

## Branching and pull request workflow

We use a standard fork-and-PR / topic-branch workflow against `main`.

1. **Branch from `main`.** Never commit directly to `main`. Name branches
   descriptively:
   - `feat/<short-slug>` — new functionality
   - `fix/<short-slug>` — bug fixes
   - `docs/<short-slug>` — documentation
   - `chore/<short-slug>` — tooling, deps, refactors with no behavior change
2. **Keep PRs focused.** One logical change per PR. Split large work into a
   stack of small PRs rather than one giant diff.
3. **Open a draft early** if you want feedback before the work is finished.
4. **Fill in the PR template:** what changed, why, how it was tested, and any
   linked issues/ADRs (`Closes #123`).
5. **Keep your branch current** by rebasing on `main`; resolve conflicts on
   your branch, not in the merge.
6. **CI must be green.** Lint, type-check, and tests run on every PR and must
   pass before review completes.
7. **At least one maintainer approval** is required to merge. PRs are merged
   by squash unless a maintainer decides otherwise; the squash commit message
   must follow the conventions below.

---

## Commit and changeset conventions

### Commit messages

We follow **Conventional Commits**:

```
<type>(<optional scope>): <summary>

<optional body>

<optional footer>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`,
`build`, `ci`. Examples:

```
feat(memory): add bi-temporal valid_at/invalid_at to fact store
fix(router): trigger fallback only after 2 consecutive provider errors
docs(adr): record decision on file-based memory paradigm
```

Keep the summary in the imperative mood and under ~72 characters. Reference
issues in the footer (`Refs #123`, `Closes #123`).

### Changesets

This monorepo uses [Changesets](https://github.com/changesets/changesets) for
versioning and changelogs. **Any PR that changes the behavior of a published
package must include a changeset:**

```bash
pnpm changeset
```

Select the affected packages and the appropriate bump (patch / minor / major
per semver), then write a user-facing summary. Commit the generated file under
`.changeset/` as part of your PR. PRs that touch only internal tooling, tests,
or docs do not need a changeset, but adding an empty one is harmless if you're
unsure.

---

## Coding standards

Consistency is enforced by tooling so reviews can focus on substance. CI runs
all of the checks below; run them locally before pushing.

### TypeScript

- **ESLint** for linting and **Prettier** for formatting. Do not hand-format
  around the formatter — run it.
  ```bash
  pnpm lint          # eslint + prettier --check
  pnpm format        # prettier --write
  ```
- Strict TypeScript. No `any` unless justified with a comment; prefer precise
  types and exhaustive `switch` handling.
- Match the surrounding style. Don't reformat or refactor unrelated code in a
  feature PR.

### Python (sidecars)

- **Ruff** for linting and formatting, **mypy** for type checking.
  ```bash
  ruff check sidecars/
  ruff format sidecars/
  mypy sidecars/
  ```
- Type annotations are required on public functions.

### General principles

- **Simplicity first.** The minimum code that solves the problem; no
  speculative abstractions or unrequested configurability.
- **Surgical changes.** Touch only what the change requires. Remove orphans
  your own change creates; leave pre-existing dead code alone (mention it
  instead).
- **Safety belongs in code.** Irreversible/critical operations (delete,
  deploy, money, budgets, fallback) must be enforced by deterministic code
  hooks, never by prompt text alone. Don't weaken or bypass an existing
  HARD_DENY rule or other deterministic enforcement layer without an ADR and
  maintainer sign-off.

---

## Architecture Decision Records (ADRs)

**Consequential decisions require an ADR.** This is a hard rule, not a
suggestion. Before merging a change that involves any of the following, add an
ADR under `docs/decisions/`:

- Choice of technology, framework, runtime, or language
- Licensing decisions, or adopting a dependency with a non-trivial license
- Packaging / distribution model
- An architectural pattern with long-term consequences
- Adopting or dropping a major dependency
- Deprecation, supersedure, or a breaking change
- A security or privacy tradeoff

ADRs use the [MADR 3.0](https://adr.github.io/madr/) style. File naming:
`docs/decisions/YYYY-MM-DD-<slug>.md` — for example
[docs/decisions/2026-06-11-file-based-memory-fts5-bm25.md](docs/decisions/2026-06-11-file-based-memory-fts5-bm25.md).
Required sections: Title, Status, Date, Context, Decision, Consequences;
optional: Alternatives Considered, References. Update the ADR index
(`docs/decisions/INDEX.md`) in the same PR, latest entry first.

Examples of decisions already captured as ADRs:

- `docs/decisions/2026-06-11-file-based-memory-fts5-bm25.md` — file-based markdown +
  SQLite FTS5 as the memory basis (vector search is a flag-gated plugin, not
  the foundation).
- `docs/decisions/2026-06-11-deterministic-tool-hooks.md` — code hooks as
  the 100% enforcement layer for irreversible operations.

Not an ADR: bug fixes, refactors with no architectural impact, tactical
implementation details, temporary stopgaps, or config tweaks.

If you're unsure whether your change is "consequential," open the PR with a
note and a maintainer will tell you — it's cheaper than guessing wrong.

---

## Tests

**Tests are required.** PRs that change behavior must include tests.

- **Bug fixes** must add a test that reproduces the bug (fails before, passes
  after).
- **Features** must include tests covering the happy path and the meaningful
  edge cases.
- Deterministic safety logic (hooks, HARD_DENY rules, the loop guardian, the
  memory resurrection-guard) must have unit tests; these are the components we
  rely on for 100% enforcement, so they get the most scrutiny.

Run the suite locally before pushing:

```bash
pnpm test               # TypeScript tests
# sidecar tests: see DEVELOPMENT.md
```

Do not disable, skip, or weaken existing tests to get a PR green. If a test is
genuinely wrong, fix it in a clearly explained, separate commit.

---

## Contributing skills

Skills are defined in a `SKILL.md` file with YAML frontmatter. Every skill PR
must satisfy these requirements:

- **Frontmatter fields:** `name`, `description` (≤ 60 characters), `version`,
  `provenance`, and `triggers`.
- **Verification section (mandatory).** Every `SKILL.md` must include a
  `## Verification` section describing how to confirm the skill did what it
  claimed. A skill without a verification section will not be merged.
- **Menu discipline.** Only the menu (name + description) lives in the prompt;
  the full body loads on trigger. Keep descriptions tight and accurate so the
  trigger logic stays cheap and correct.
- **No auto-promotion to prod.** Agent-generated skills land in staging and
  wait for human approval; never wire a new or generated skill straight into
  the production path in the same change.

If a skill shells out, talks to MCP servers, or touches the network, call that
out explicitly in the PR — those paths get extra review for the lethal-trifecta
and tool-poisoning concerns described in the security docs.

---

## Security

Do not file security vulnerabilities as public issues. See
[SECURITY.md](SECURITY.md) for responsible disclosure. Changes that alter the
project's security posture (sandboxing, egress controls, secret handling, MCP
allowlisting, safety hooks) require both an ADR and explicit maintainer review.

---

## License

By contributing, you agree that your contributions will be licensed under the
project's [Apache-2.0 License](LICENSE). Make sure you have the right to submit
any code you contribute, and that it is your original work or appropriately
attributed.

---

## Questions

Open a [GitHub Discussion](../../discussions) or an issue. We'd rather answer a
question early than review a large PR that went the wrong direction. Thanks for
helping make Aisy better.
