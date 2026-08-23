# ADR-0001: Adopt "Aisy" Brand & File-Naming Conventions

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** naming, meta

## Context
This project is a public, open-source Apache-2.0 harness — a deterministic "OS"
wrapping a stateless probabilistic LLM "CPU" — reachable from Telegram/IDE with
durable file-based memory, skills, and MCP. As a public artifact it must:

- present a single, unambiguous public identity, and
- interoperate with the surrounding agent ecosystem (Cursor, Claude Code,
  GitHub Copilot) rather than inventing bespoke conventions.

Two pre-existing problems force a decision. First, an internal working name
leaked into drafts; a public OSS repo needs one canonical brand to avoid
contributor and user confusion. Second, the memory and persona files were
borrowed loosely from anima_sdk (`SELF_MODEL.md`, `STATE/TODO/NOTES/LESSONS/
DECISIONS/INBOX.md`) and ad-hoc config, which does not line up with the emerging
`agents.md` convention that the ecosystem tools auto-discover.

## Decision
The public brand is **"Aisy"** everywhere; the internal codename is dropped from
all repo-visible text. We adopt ecosystem-standard file names for memory and
config so the project is compatible with Cursor / Claude Code / Copilot out of
the box.

Naming scheme:

- **Static files in git (config/persona, UPPERCASE or normative-lowercase):**
  - `AGENTS.md` — dev-agent instructions, the `agents.md` standard.
  - `SOUL.md` — persona file, replacing anima_sdk's `SELF_MODEL.md`.
  - `GUARDRAILS.md` — human-readable safety invariants (deterministic hooks
    remain the 100% enforcement layer; this file documents them).
  - `constitution.md` — normative frame, part of the always-loaded stable
    prefix.
- **Runtime memory files:**
  - `MEMORY.md` (index), `USER.md` (profile) — always-loaded stable prefix.
  - `skills/<name>/SKILL.md` — skill definition.
  - `STATE.md` / `TODO.md` / `NOTES.md` / `LESSONS.md` / `DECISIONS.md` /
    `INBOX.md` — per-step inter-loop state (anima_sdk pattern).
  - `logs/YYYY-MM-DD.md` — daily logs.
- **Casing:** UPPERCASE for memory/config files; lowercase `YYYY-MM-DD` for
  logs. `constitution.md` stays lowercase by convention as the normative frame.
- **Frontmatter:** YAML frontmatter only on `SKILL.md` (name, description ≤60
  chars, version, provenance, triggers). Other files carry no frontmatter.

## Consequences
- **Positive:** `AGENTS.md` is auto-discovered by ecosystem tools, so external
  contributors and IDE agents get correct instructions with zero setup. One
  brand removes naming ambiguity across docs, code, and community. Standard
  names lower the onboarding cost for anyone who has seen anima_sdk or
  `agents.md`.
- **Neutral:** Casing is a convention, not enforced by code; a lint check can be
  added later if drift appears. `SOUL.md`/`GUARDRAILS.md` are project-specific
  names layered on top of the `agents.md` standard, not part of it.
- **Negative:** A one-time rename of `SELF_MODEL.md` → `SOUL.md` and removal of
  the codename touches existing drafts and any path references. The
  always-loaded prefix is byte-sensitive (KV-cache relies on a byte-identical
  prefix for up to ~90% input savings), so renames must land before the prefix
  is frozen for a session.

## Alternatives considered
**Bespoke, non-standard file names.** A fully custom scheme (e.g. `persona.md`,
`agent-rules.md`) would read cleanly but forfeits ecosystem interop: Cursor,
Claude Code, and Copilot would not auto-discover instructions, and every
contributor would have to learn local conventions. Rejected — interop is the
whole point of a public OSS harness.

**Keeping both the internal codename and "Aisy".** Carrying the codename in
non-public files while branding "Aisy" publicly invites leaks (one already
happened in drafts) and confuses contributors reading the repo. A single public
identity is cheaper to maintain than a translation layer. Rejected for brand
confusion.

## References
- agents.md convention: https://agents.md
- anima_sdk (Rai220, MIT) — persona/state file pattern: https://github.com/Rai220/anima_sdk
