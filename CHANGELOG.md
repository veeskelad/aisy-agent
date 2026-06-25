# Changelog

All notable changes to the Aisy Agent harness are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
Going forward, the contents of this file are generated from changesets.
Do not edit released sections by hand. Add a changeset entry alongside your
change instead; release tooling assembles the version sections below from those
entries. The "Unreleased" section may be hand-curated until the first tagged
release establishes the changeset baseline.
-->

## [Unreleased]

_No unreleased changes._

## [0.1.5] — 2026-06-25

### Fixed
- **`aisy update` no longer misreports "Running from source"** on a normal global
  install. `process.argv[1]` is the bin symlink (e.g. `/opt/homebrew/bin/aisy`), not the
  real file under `node_modules`; the check now resolves the symlink (realpath) and also
  inspects the module URL, so a symlinked global install correctly runs `npm i -g @latest`.

## [0.1.4] — 2026-06-25

### Changed
- **`aisy init` uses arrow-key selection** (↑/↓ + Enter) to choose the provider and
  model — no more typing numbers. Falls back to a numbered prompt when stdin is not a TTY.
- **Cleaner provider names** — dropped implementation jargon: `Gemini` (was "Gemini
  (OpenAI-compat)"), `Qwen` (was "Qwen (DashScope)"), `Other — OpenAI-compatible API
  (you provide the URL)` (was "Custom (OpenAI-compatible)"), `Claude CLI (no API key)`.

## [0.1.3] — 2026-06-25

More `aisy init` fixes + two requested features, all from dogfooding.

### Fixed
- **`aisy init` no longer crashes on a fresh machine** — `~/.aisy` is created before
  writing `providers.json` / `vault.json` (was a first-run `ENOENT`).
- **Clean CLI errors** — a failed command prints `aisy: <message>`, never a raw Node stack trace.
- **Visible key entry** — the API-key prompt masks input with `*` instead of hiding it entirely.

### Added
- **Model picker** — `aisy init` lists current models for the chosen provider; pick a
  number or type a custom model id.
- **Optional fallback provider** — `aisy init` can configure a backup provider; the agent
  fails over to it on a transient error (5xx / 429 / network) from the primary. 4xx client
  errors (bad key/request) propagate and are not masked.

## [0.1.2] — 2026-06-25

### Added
- **`aisy update`** — update the global install to the latest published version
  (`npm i -g @aisy/app@latest`); prints a `git pull && pnpm -r build` hint when run
  from a source checkout. Suggests `aisy doctor --post-upgrade` after updating.
- **Boot update notice** — `aisy run` prints a non-blocking "update available" line
  when a newer version is published (best-effort registry check; never blocks the bot).

## [0.1.1] — 2026-06-24

CLI/onboarding fixes from dogfooding 0.1.0.

### Fixed
- **`aisy init` simplified** — single provider (removed the reasoning/critique/routine
  tier prompts), **validated provider selection** (a bad pick re-asks instead of silently
  falling back to Anthropic), **Base URL** prompted only for the Custom (OpenAI-compatible)
  provider, **model** prompted right after the provider pre-filled with the catalog default,
  dropped the memory/db-path prompts. Known providers carry sensible default models.
- **Ctrl-C during `aisy init`** now exits quietly — no "Detected unsettled top-level await" warning.
- **English CLI** — onboarding and Telegram-pairing prompts are now English (the Telegram bot UI is unchanged).

## [0.1.0] — 2026-06-24

First pre-alpha release — the **text-first Telegram agent runs end-to-end**:
`aisy init` onboarding + terminal-side pairing (single-operator allowlist),
`aisy run` long-polling (works behind NAT), durable file memory (SQLite
FTS5/BM25 + durable forgetting), deterministic safety with tiered approvals,
scoped grants (`/grants`), outbound lockout, opt-in sandboxed `bash`, `/stop`
+ mid-turn budget cap, sub-agent delegation (`spawn_subagent`), nightly memory
consolidation (generator + independent judge → staging → human tap), proactive
triggers (`/remind` `/schedule` `/watch`), persistent `/goal` loops, prefix
caching with cache-aware cost accounting, a 9-provider catalog with per-agent
budgets, a CI gate, and a tag-driven npm-publish release pipeline + GitHub Release.

**Not yet (Roadmap):** voice input (Whisper sidecar), live Skills, MCP
integration, and session crash-resume mid-turn.

### Added

- Initial documentation and Architecture Decision Record (ADR) scaffolding for
  the Aisy Agent harness — a public, open-source "operating system" wrapped
  around a large language model. This first pass establishes the repository's
  public surface (root documentation, contribution guidelines, and decision
  records) ahead of the implementation.
- Core thesis documentation: the LLM is treated as a stateless probabilistic
  CPU, while the harness is the deterministic OS. Reversible and creative work
  is routed to the model; irreversible and critical operations (delete, deploy,
  money, budgets, fallback) are enforced by code.
- Decision records under `docs/decisions/` capturing the foundational
  architecture, including the harness-vs-model split, the file-based memory
  paradigm, the deterministic safety layer, provider routing, and the
  bi-temporal memory model that addresses memory-deletion correctness. See, for
  example, `docs/decisions/2026-06-11-own-agent-loop.md`,
  `docs/decisions/2026-06-11-file-based-memory-fts5-bm25.md`,
  `docs/decisions/2026-06-11-deterministic-tool-hooks.md`, and
  `docs/decisions/2026-06-11-durable-forgetting-tombstones.md`.
- Apache-2.0 license declaration and standard open-source project metadata.

### Changed

- Nothing yet.

### Deprecated

- Nothing yet.

### Removed

- Nothing yet.

### Fixed

- Nothing yet.

### Security

- Nothing yet.

[Unreleased]: https://github.com/aisy-agent/aisy-harness/commits/main
