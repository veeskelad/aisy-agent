# Development

This guide gets the Aisy harness building, testing, and running on your machine.
It covers prerequisites, the install/build/test loop, how to run the TypeScript
core and the Python sidecars, how to bring up the Docker sandbox, and how the
repository is laid out.

> **Status: pre-alpha.** The harness is being specified before it is written, so
> some commands below describe the target workflow. Where a package is still a
> stub, the command will be a no-op rather than an error — the scripts and
> workspace wiring are in place so the loop works end to end as code lands.

If anything here is wrong or out of date, that's a bug — please open an issue or
a PR. For how to contribute changes, see [CONTRIBUTING.md](CONTRIBUTING.md); for
reporting vulnerabilities, see [SECURITY.md](SECURITY.md).

---

## 1. Prerequisites

The monorepo is TypeScript-first with Python confined to process-isolated
sidecars
([ADR-0003](docs/decisions/2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md)).
You need the Node toolchain to do anything; you only need the Python toolchain to
work on the sidecars, and Docker only to run the agent sandbox.

| Tool | Version | Needed for | Notes |
|------|---------|------------|-------|
| **Node.js** | 22 LTS (≥ 20.11) | everything | Use the version in [`.nvmrc`](.nvmrc); `nvm use` picks it up. |
| **pnpm** | ≥ 9 | everything | The only supported package manager (workspaces). Install via `corepack enable && corepack prepare pnpm@latest --activate`. |
| **Python** | 3.11+ | sidecars only | Whisper voice transcription + optional scoring classifier. |
| **uv** | ≥ 0.4 | sidecars only | Fast, reproducible Python envs. Poetry also works if you prefer it. |
| **Docker** | ≥ 24 | running the agent / sandbox | The agent runs untrusted code in a one-shot container ([ADR-0012](docs/decisions/2026-06-11-docker-sandbox-default.md)). |
| **Git** | any recent | everything | Memory is markdown in git; the dev loop assumes it. |

Optional but recommended:

- **ffmpeg** — required by the Whisper sidecar to decode audio. Install from your
  OS package manager (`brew install ffmpeg`, `apt install ffmpeg`).
- **gVisor (`runsc`)** — stronger syscall-level sandbox isolation where the host
  kernel permits it. The sandbox falls back to the standard Docker runtime when
  it is absent.

> **Why pnpm and not npm/yarn?** The repo is a pnpm workspace; using another
> manager will produce a wrong lockfile and break cross-package linking. See
> [ADR-0003](docs/decisions/2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md).

---

## 2. Clone, install, build, test

```bash
# 1. Clone
git clone https://github.com/<org>/aisy-harness.git
cd aisy-harness

# 2. Pin Node and enable pnpm
nvm use                 # reads .nvmrc
corepack enable         # makes the pinned pnpm available

# 3. Install all JS/TS workspace deps (one lockfile for the whole repo)
pnpm install

# 4. Build every package, in dependency order
pnpm build

# 5. Run the full test suite (TS + Python)
pnpm test
```

`pnpm install` installs dependencies for all four workspace packages at once.
`pnpm build` and `pnpm test` are repo-root scripts that fan out across the
workspace (build ordering is handled by the task runner), so you rarely run a
per-package command directly.

### Configure your environment

Runtime configuration (provider API keys, the Telegram token, paths) comes from a
local `.env`. Copy the template and fill it in:

```bash
cp .env.example .env
$EDITOR .env
```

`.env` and `secrets/` are git-ignored and must never be committed — they hold the
keys the safety layer is built to protect. Provider keys live behind the vault,
not in the live prompt.

### Common per-package commands

You can scope any script to one package with pnpm's `--filter`:

```bash
pnpm --filter @aisy/core-ts build        # build just the core
pnpm --filter @aisy/core-ts test         # test just the core
pnpm --filter @aisy/core-ts test --watch # vitest watch mode
pnpm --filter @aisy/sdk-ts  build        # build the TS SDK
```

### Lint, format, typecheck

```bash
pnpm lint        # ESLint across TS packages
pnpm format      # Prettier (write)
pnpm typecheck   # tsc --noEmit across the workspace
```

Run these before opening a PR; CI runs the same checks.

---

## 3. Running the core

The core is the stateless agent loop, prompt assembly, memory, hooks, routing —
the deterministic "OS" around the model
([ADR-0004](docs/decisions/2026-06-11-typescript-for-core.md),
[ADR-0005](docs/decisions/2026-06-11-own-agent-loop.md)). During development you
typically run it in watch mode so changes reload automatically:

```bash
# From the repo root
pnpm dev                                  # runs the core in watch/reload mode

# Or scope it explicitly
pnpm --filter @aisy/core-ts dev
```

To run the built artifact (what production runs):

```bash
pnpm --filter @aisy/core-ts build
pnpm --filter @aisy/core-ts start
```

The core reads `.env` for provider keys and the Telegram gateway token. With no
gateway token set it runs against a local stdin/CLI loop, which is the quickest
way to exercise the agent without wiring up Telegram. Memory, daily logs, and the
session journal are written under `data/` (git-ignored) by default.

---

## 4. Running the Python sidecars

Sidecars are process-isolated Python services the core talks to over a local
boundary — currently Whisper voice transcription and an optional scoring
classifier
([ADR-0003](docs/decisions/2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md)).
They are managed with `uv` and have their own toolchain, independent of the JS
workspace.

```bash
# From the sidecars package
cd packages/sidecars-py

# Create the env and install (uv reads pyproject.toml + uv.lock)
uv sync

# Run a sidecar (entry points are defined in pyproject.toml)
uv run aisy-sidecar-whisper        # voice transcription service
uv run aisy-sidecar-score          # optional scoring/classifier service
```

Using Poetry instead:

```bash
cd packages/sidecars-py
poetry install
poetry run aisy-sidecar-whisper
```

The Whisper sidecar needs **ffmpeg** on the `PATH` to decode audio. The first run
downloads the Whisper model weights; pick the model size with an env var (e.g.
`AISY_WHISPER_MODEL=base`) to trade accuracy for speed and memory.

The core launches and supervises these sidecars in normal operation; you run them
by hand only when developing or debugging a sidecar in isolation.

---

## 5. Bringing up the Docker sandbox

All agent-initiated code runs inside a **one-shot Docker container** with no path
to production and no unsupervised network. This is a structural safety barrier,
not a convenience — even a successful prompt injection lands somewhere
destructive action is physically impossible
([ADR-0012](docs/decisions/2026-06-11-docker-sandbox-default.md)). You need a
running Docker daemon for the agent to execute any tool that runs code.

Build the sandbox image once (and again whenever its definition changes):

```bash
pnpm sandbox:build        # builds the agent sandbox image
```

The container baseline the harness enforces at launch:

- `--network none`, `--read-only` root filesystem, `tmpfs` for scratch
- `--cap-drop ALL`, `--security-opt no-new-privileges`
- `--pids-limit` plus memory/CPU caps to bound runaway loops
- non-root user; **only** the agent's own worktree is mounted, nothing else
- one-shot lifecycle: a fresh container per task, destroyed on exit
- gVisor (`runsc`) runtime added automatically where the host permits

When a task legitimately needs the network, egress flows only through an explicit
**allowlist-backed proxy** that logs every request — never the open internet.

Smoke-test that your Docker setup satisfies these constraints before running the
agent:

```bash
pnpm sandbox:doctor       # verifies daemon, image, runtime, and caps
```

If `sandbox:doctor` reports gVisor is unavailable, that's fine on constrained or
nested-virt hosts — the agent runs under the standard runtime with namespaces and
caps, just without syscall-level isolation. Never relax these flags to "make
something work": disabling the sandbox is the exact configuration that produced
the real-world data-loss incidents the design exists to prevent.

---

## 6. Test suites

Tests live next to the code in each package. The root `pnpm test` runs both the
TypeScript and Python suites; you can also run them individually.

### TypeScript — vitest

```bash
pnpm test                                  # all TS tests in the workspace
pnpm --filter @aisy/core-ts test           # one package
pnpm --filter @aisy/core-ts test --watch   # watch mode
pnpm --filter @aisy/core-ts test --coverage # with coverage report
```

Run a single file or test by name:

```bash
pnpm --filter @aisy/core-ts test src/memory/forget.test.ts
pnpm --filter @aisy/core-ts test -t "tombstoned facts are never resurrected"
```

Safety-critical paths — HARD_DENY hooks, the durable-forgetting/resurrection
guard, the loop guardian, the injection classifier — are deterministic by
construction and must be covered by deterministic tests. They are not graded by a
model; they are asserted in code.

### Python — pytest

```bash
cd packages/sidecars-py
uv run pytest                       # all sidecar tests
uv run pytest -k whisper            # filter by name
uv run pytest --cov                 # with coverage
```

With Poetry: `poetry run pytest`.

CI runs both suites plus lint, format-check, and typecheck on every PR. Keep them
green locally before pushing.

---

## 7. Project structure

```
aisy-harness/
├── packages/
│   ├── core-ts/        # the harness core (TypeScript): agent loop, memory,
│   │   └── src/        #   hooks, routing, gateway — the deterministic "OS"
│   ├── sidecars-py/    # Python sidecars: Whisper voice, optional scoring
│   ├── sdk-ts/         # TypeScript client SDK (versioned independently)
│   └── sdk-py/         # Python client SDK (versioned independently)
├── docs/
│   ├── decisions/      # ADRs (MADR 3.0) — the "why" behind every choice
│   ├── specs/          # one spec per component (12 components)
│   ├── concepts/       # deep dives: memory, safety, MCP, skills, nightly loop
│   ├── guides/         # quick-start, deployment, operations
│   └── examples/       # runnable examples
├── .github/workflows/  # CI: build, test, lint, typecheck
├── README.md           # start here
├── VISION.md           # the thesis: model = CPU, harness = OS
├── ARCHITECTURE.md     # high-level map and message flow
├── DEVELOPMENT.md      # this file
├── CONTRIBUTING.md     # how to propose changes
├── SECURITY.md         # reporting vulnerabilities
└── LICENSE             # Apache-2.0
```

Notes on the layout:

- **The TS/Python split is a hard boundary.** TypeScript owns the deterministic
  core and all safety hooks; Python is confined to process-isolated sidecars,
  matching the sandbox model. New deterministic-safety code belongs in
  `core-ts`, never a sidecar
  ([ADR-0003](docs/decisions/2026-06-11-monorepo-pnpm-ts-core-py-sidecars.md)).
- **The two SDKs version independently** of the core so adopters get a stable
  public contract decoupled from internal churn.
- **Git-ignored at runtime:** `.env`, `secrets/`, `data/`, `*.db`, and
  `/worktrees/`. The memory database and session logs live under `data/`; never
  commit them.

### The component map

The harness decomposes into twelve components, each with a spec under
`docs/specs/` — core/agent loop, gateway, memory, tools & hooks, safety, skills,
MCP, personality, provider routing, nightly consolidation, orchestration, and
observability. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full table and how
a message flows through them, and
[docs/decisions/INDEX.md](docs/decisions/INDEX.md) for the decisions behind each.

---

## 8. Where to go next

- **Understand the design first:** [VISION.md](VISION.md) →
  [ARCHITECTURE.md](ARCHITECTURE.md)
- **Decisions and their rationale:**
  [docs/decisions/INDEX.md](docs/decisions/INDEX.md)
- **Contributing changes:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **Reporting a vulnerability:** [SECURITY.md](SECURITY.md)
