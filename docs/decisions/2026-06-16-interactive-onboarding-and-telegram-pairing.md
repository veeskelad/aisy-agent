# ADR-0049: Interactive Onboarding + Terminal Telegram Pairing

**Status:** Accepted
**Date:** 2026-06-16
**Tags:** onboarding, telegram, security, cli

## Context

`aisy init` was env-only: it read secrets from `process.env`, validated, and
seeded the vault — fine for CI, useless for a first-run human who has nothing in
the environment yet. And the operator `chat_id` had to be discovered and typed
by hand. We want a first-run wizard that prompts for what is missing and pairs
the Telegram chat, while keeping the env-driven path intact for automation.

The pairing carries a security constraint: a chat must never be granted access
because a channel message asked for it (prompt-injection). The trust decision
must be made terminal-side.

## Decision

**Interactive `aisy init` (TTY, default) over an injected `PromptPort`, with a
terminal pairing-code flow; `aisy setup` re-runs it.**

- **`PromptPort`** (`ask`/`secret`/`confirm`/`info`) — injected so the wizard is
  testable with a scripted double; the real adapter is readline (`secret()` mutes
  echo). Present + a TTY ⇒ interactive; absent or `--non-interactive`/`--yes` ⇒
  env-driven (unchanged; all prior onboarding tests pass).
- **Collect step in `init`** (before validation): for each *missing* required key
  (vault-set keys count as present and are skipped), prompt — provider keys and
  the bot token via `secret()`, paths via `ask()`. Collected values override env
  for the rest of init (validation + vault seed). A required key left empty fails
  validation as before — it cannot be silently skipped.
- **Terminal pairing** (`runTelegramPairing`): mint a code, show it **only in the
  terminal**, poll `telegramGetUpdates`, and pair the chat that **echoes that
  code** — race- and imposter-resistant, trust decided terminal-side. Falls back
  to manual `chat_id` entry on timeout or when `getUpdates` is unavailable. Pure
  over injected ports (prompt, getUpdates, clock, sleep, genCode) → deterministic
  tests.
- **`telegramGetUpdates`** added to `CredentialValidators` (optional); the node
  adapter calls the Bot API and extracts `{chatId, text, username}`.
- **`aisy setup [element]`** is an alias for interactive `init` (re-prompts what
  is missing). Because the node adapter merges the vault into `env`, already-set
  keys are skipped; a true per-element *force re-config* is a follow-on.

## Consequences

- **Positive:** A human can `aisy init` with an empty environment and be walked
  through provider keys + Telegram pairing; `aisy run` then works from the vault.
- **Positive:** Pairing is secure by construction (terminal-side code), matching
  the never-pair-from-a-channel-message rule.
- **Positive:** Additive — `PromptPort`/`telegramGetUpdates` are optional; the
  env-driven and CI paths are unchanged (606 core tests green, +10 new).
- **Fix:** the node fs adapter now `mkdirp`s a file's parent before writing —
  scaffolding `memory/constitution.md` before the memory dirs no longer crashes
  (latent bug, surfaced by the first real `aisy init`).
- **Follow-on:** per-element force re-config (`aisy setup telegram` re-pairing an
  already-set chat); the onboarding `--help` does not list `run`/`setup`.

## Alternatives considered

- **Manual `chat_id` only (Hermes-style):** simplest, but worse UX and no proof
  the operator controls the chat. Kept as the pairing fallback, not the default.
- **Capture-first-message + confirm:** racey (an imposter could message first);
  the code-echo flow is strictly stronger.
- **`aisy setup` as a distinct op with element filtering:** more code; deferred
  in favor of the init-alias for now.

## References

- ADR-0046 (`getIssuedCard`), ADR-0047 (scoped grants), ADR-0048 (runtime/app)
- `packages/core-ts/src/onboarding/interactive.ts` (`runTelegramPairing`),
  `onboarding/index.ts` (collect step), `runtime/onboarding-node.ts` (readline
  prompt + `telegramGetUpdates` + vault/env merge), `app/src/bin/aisy.ts` (setup)
