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
