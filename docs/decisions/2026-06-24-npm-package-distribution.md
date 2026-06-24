# ADR-0056: npm-Package Distribution (primary)

- **Status:** Accepted
- **Date:** 2026-06-24
- **Tags:** packaging, devex, distribution
- **Supersedes (in part):** ADR-0035 (Install & Packaging) — its rejection of an `npm i -g` path
- **Related:** ADR-0003 (monorepo pnpm), ADR-0002 (Apache-2.0), ADR-0019/0050 (provider surface)

## Context

ADR-0035 chose a one-liner bootstrap script + Docker/Compose and explicitly
**rejected `npm i -g` only**, for two reasons: (1) the harness would bundle a
**Python Whisper sidecar** for voice, which npm can't ship cleanly, and (2) to
avoid Leon's pinned-binary GLIBC/ABI failure class.

Two facts changed for the 0.1.0 release:

1. **0.1.0 is pure Node/TS.** Voice is deferred, so there is no Python sidecar in
   the runtime — reason (1) does not apply to 0.1.0.
2. **Voice no longer implies a bundled sidecar.** Multimodal providers can accept
   audio directly, and an operator who wants local transcription can install
   Whisper on their own server. So voice is a provider/integration concern, not a
   packaged component Aisy must distribute.

Surveyed peers that won adoption (OpenClaw, Hermes) ship as installable packages;
an `npx`/`npm i -g` entry is the lowest-friction, most familiar path for a
Node CLI.

## Decision

**npm is the primary distribution for 0.1.0.** Publish the workspace packages to
npm; the operator installs the CLI with `npm i -g @aisy/app` (or `npx @aisy/app`),
then `aisy init` → `aisy run`.

- All three packages publish (`@aisy/core`, `@aisy/telegram-gw`, `@aisy/app`),
  `private` removed, `publishConfig.access: public`, `files: ["dist"]`. The
  workspace keeps source-pointing `types`/`exports` for the internal typecheck;
  `publishConfig` swaps in `dist`-pointing declarations only in the published
  package. pnpm rewrites `workspace:*` deps to the real version on publish.
- A tag-driven `release.yml` runs the gates, then `pnpm -r publish` (needs the
  `@aisy` npm org + an `NPM_TOKEN` secret) and cuts a GitHub Release.
- **The Docker/Compose *deployment* path is removed** (`Dockerfile` +
  `docker-compose.yml` deleted). Its original rationale — bundling the Node core
  with the Python Whisper sidecar — died with the voice decision, the image was
  untested (it had rotted to a stale `@aisy/core` entrypoint), and `npm i -g` +
  systemd covers "run as a service on a VPS" more simply (documented in the
  README). `scripts/install.sh` stays as the **from-source** path for a dev loop.
- **Docker is retained only as the opt-in bash-sandbox runtime** (`AISY_SANDBOX_IMAGE`
  → `makeDockerBash`) — a tool-execution concern, orthogonal to how the app is
  distributed. ADR-0035's "build-from-source over pinned binaries" principle still
  governs native deps (`better-sqlite3`). Re-introducing a deployment image is an
  ADR-0035/0056 revisit trigger if a Python sidecar or container-deploy demand returns.

## Consequences

- **Positive:** one-command install matching peer norms; no Docker required for
  the common case; works on any host with Node 22+.
- **Neutral:** three scoped packages become public API at 0.x (semver-unstable —
  acceptable for pre-alpha); requires owning the `@aisy` npm org.
- **Negative:** publishing internal libs (`core`, `telegram-gw`) exposes surface
  we must keep at least minimally stable; a future Python sidecar would re-open
  the bundling question (Docker path remains for that).

## Alternatives considered

- **Bundle all deps into one `aisy` package** (esbuild/tsup): a single
  dependency-free CLI tarball. Rejected for 0.1.0 — adds a bundler + obscures the
  layering; the standard pnpm multi-package publish is simpler and correct.
- **Keep Docker/script only (ADR-0035 as-is):** higher friction than peers for a
  pure-Node app; rejected as the *primary* path, retained as a secondary one.
- **Pinned platform binaries (Leon's model):** still rejected (GLIBC/ABI hell).

## References

- ADR-0035 (Install & Packaging — the prior decision this revises)
- `packages/*/package.json` (publishConfig), `.github/workflows/release.yml`,
  `README.md` Quickstart, `CHANGELOG.md` [0.1.0]
