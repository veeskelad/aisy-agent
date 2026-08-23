# Reference HTML and Screen Contract Matrix for Aisy

> **Историческая traceability baseline.** Статусы `CORE-ONLY`/`MISSING` ниже
> относятся к 2026-07-26. Текущий LIVE/dormant verdict находится в
> [production-матрице от 2026-08-23](./2026-08-23-production-readiness-matrix.md).

**Date:** 2026-07-26
**Status:** Implementation traceability baseline
**Source set:** all 24 `source_html/*.html` lessons, 59 embedded tutorial
screenshots, three video analyses, 72 selected UI frames, and the course
map.

This matrix treats the reference materials as a product contract, not as proof that
Aisy already implements the same behaviour. Status follows the evidence rules
in the live gap audit: **LIVE**, **DEGRADED**, **CORE-ONLY**, **MISSING**, or
**MANUAL/OUT-OF-RUNTIME**.

## Contract matrix

| Lesson / screen evidence | Product contract to carry into Aisy | Telegram surfaces and commands | Aisy status | Required proof |
|---|---|---|---|---|
| 01 — DigitalOcean payment (11 screens) | Human setup guidance for obtaining infrastructure and a provider token; never expose payment or recovery material to the model | Onboarding help link/card, not an agent tool | **MANUAL/OUT-OF-RUNTIME** | Documentation review; no secret appears in a model span or log |
| 02 — Buying crypto (24 screens) | Optional external funding guide for providers that require it; not an Aisy execution capability | Help content only | **MANUAL/OUT-OF-RUNTIME** | Clearly marked optional/manual and jurisdiction-neutral; no automated financial action |
| 03 — Two engines | Multiple brains can be connected simultaneously; one Aisy control plane owns the same tools, memory, policy and projects regardless of brain; switching an incompatible engine starts a new session but keeps prior sessions | Agent → Connection; `/settings`, `/status` | **DEGRADED** | Connect two brains, run the same tool scenario, switch, create a fresh session, resume the old one |
| 04 — Claude subscription token (2 screens) | Official Claude Code subscription path; validate the credential before activation; keep it out of model context; expose clean failure/retry | Connections → Claude subscription → paste token → validation card | **DEGRADED** | Telegram-only masked capture, live validation, restart survival, revocation, negative tests |
| 05 — OpenAI subscription (7 screens) | Official Codex device-code flow from a phone browser; show URL, short code, expiry/progress and completion; one account/server warning | Connections → OpenAI subscription → Start | **DEGRADED** | Real device-flow smoke plus timeout/cancel/retry tests; no code/token in model context |
| 06 — OpenRouter key (12 screens) | BYOK API-key connection with format check, masked storage, validation, balance/limit guidance and immediate availability | Connections → OpenRouter/API key | **DEGRADED** | Chat capture, provider validation, masked status, replacement/revoke and no-restart activation |
| 07 — System map | Three ownership zones: global operator workspace, isolated project roots, protected Aisy system state. A turn loads global DNA, active project context and one session, then runs tools and streams evidence | Main menu; project selection; settings/system status | **DEGRADED** | Filesystem and context isolation E2E; system secrets/state never model-readable |
| 08 — Communicating with agent | Live elapsed status, event/tool status, streaming answer, safe chunking, footer, approval buttons, forwarded-message batching, media ingestion, per-session queue, bounded retry and proactive messages | Continue/Stop; queue marker; status/footer | **DEGRADED** | Telegram E2E for status cadence, streaming, 1,800-char split, batching, queue, retry and cancel |
| 09 — Agent DNA | `/start`: connect brain → 5–7 minute conversational interview (text/voice) → generate SOUL, USER, MEMORY, MISSION, GOALS, PROJECTS, PREFERENCES, LEARNED → recap and operator confirmation | Onboarding chat and confirmation card | **CORE-ONLY** | Clean install reaches confirmed DNA and first successful tool turn entirely in Telegram |
| 10 — Agent tools | Internet/API, web search, memory, monitoring, files, terminal, git, browser, background work, schedules, tasks, approvals, snapshots, capability report and media delivery; tools are selected by the agent but action-required turns cannot dry-answer | Natural language; capability/status views | **DEGRADED** | Tool-family contract tests plus provider/Telegram behavioural suite and postcondition evidence |
| 11 — Agent boundaries | Kernel/process/filesystem boundary is authoritative; writable roots only; no privilege gain; resource caps; system secrets stripped; untrusted content narrows capabilities; service keys have least privilege | System status and denied-action explanation | **DEGRADED** | Red-team suite for traversal, symlink, subprocess, prompt injection, secret egress and resource caps |
| 12 — Control and permissions | Separate hard system wall from conversational approvals. Modes: without asking, confirm each file edit, plan first. Irreversible external actions remain explicitly approved. Modes persist and can change live | Agent → Work mode; Continue/Stop approval card | **DEGRADED** | Mode-specific behavioural tests; stale/wrong approval cannot authorize; terminal risk remains policy-gated |
| 13 — Settings and services | Connections, environment/service keys, multi-bot, timezone, timers, API budget, server state and system controls; Agent menu owns model, work mode and thinking depth. Secret changes apply without restart | Settings and Agent menus | **DEGRADED** | Every visible button has live behaviour; masked capture and doctor check; no “in development” dead end |
| 14 — Memory system | Global DNA, MEMORY (10 KiB hard, warning at 8 KiB), LEARNED, global daily journal, current task, tasks, global/project knowledge, deterministic save routing, self-diagnostics, keyword fallback and optional semantic/hybrid retrieval | “Remember”, “save to knowledge”, memory/context views | **DEGRADED** | Routing/isolation tests, same-session search, next-session prefix refresh, provenance, correction/forget and limit tests |
| 15 — Projects and tasks | New project creates isolated root/git/project memory/project knowledge and becomes active. Switching project changes context and session but keeps global identity. Long work uses plan, incremental verified steps, commits and `.current-task.md`; `/stop`, `/newtask`, `/undo`, `/clear` are non-destructive where promised | Projects → New/project/workspace; task commands | **DEGRADED** | Telegram create/switch/resume; zero project leakage; restart recovery; current-task lifecycle and undo proof |
| 16 — Timers | Natural-language daily/weekly/once schedules; durable state; timezone; 60-second scheduler; max 20; dedupe; once auto-disables; list/toggle/delete in menu; execution uses normal agent queue | Settings → Timers; natural-language creation | **DEGRADED** | Parsing matrix, restart/catch-up policy, dedupe, once-disable, budget debit and queue integration |
| 17 — Skills | Global and project-local SKILL.md discovery, selective loading, protected system skills, menu/card/content/toggle, conversational staged creation and crash-safe executable hooks | Skills menu; `/catalog` | **CORE-ONLY** | Live discovery/use trace, project visibility test, staged review, disable/reload and hook crash quarantine |
| 18 — MCP and services | HTTP/stdio MCP registry, presets, tool discovery, secrets, removal, process/resource visibility and policy allowlist/pinning. Service variables grouped with acquisition/least-privilege guidance | MCP → workspace → Add/preset/card/remove | **CORE-ONLY** | Connect preset, enumerate/call allowed tool, deny drift/unapproved write, remove/kill stdio, secret isolation |
| 19 — Voice and media | Voice/audio transcription preview; image vision; video = transcript + key frames; text documents stored and read; static stickers/GIF/albums; explicit size/format limits and graceful degradation | Native Telegram attachments | **MISSING** | Fixture E2E for each media type, album buffer, limits, failure path, project inbox/import provenance |
| 20 — Monitoring | Source registry and incremental collectors for YouTube, X, GitHub, public Telegram and RSS; per-source intervals/status/criteria; immediate first poll; normalized local storage; scoring and search | Monitoring → Sources/Digest/Search/Settings; `/sources` | **MISSING** | Deterministic collector fixtures, cursor/idempotency tests, status cards and source lifecycle E2E |
| 21 — Digest and scoring | Scheduled/manual evidence-linked digest; 24h then 48h fallback; per-source sections; critical/important/useful only; translation/why-useful; HTML mobile report; configurable time/size/destination/source limits/style; personalized global and per-source criteria; time decay and author diversity | Digest settings; `/digest`; platform buttons | **MISSING** | Golden digest, source links/evidence, ranking math, author cap, feedback effect and Telegram delivery |
| 22 — Monitoring store | Separate SQLite store with sources/items/digests, FTS5, status pipeline, retention/disk cap, keyword/semantic/hybrid search, derived embeddings and transcript fallback chain | Monitoring settings/search/stats | **MISSING** | Schema/migration, FTS/hybrid fixtures, retention/disk cleanup, rebuildable embeddings and provenance |
| 23 — VS Code tunnel (3 screens) | Telegram and development interface share files, global memory and durable session registry. `/connect` device flow; correct folder guidance; sessions started in either interface appear in `/sessions`; `/newtask` retains old session | `/connect`, `/sessions`, `/newtask` | **MISSING** | Cross-interface session create/resume test, tunnel expiry/reconnect, path selection and authorization isolation |
| 24 — Server access | Layered access: Telegram, browser IDE, SSH, recovery. SSH closed by default and scoped to operator key/IP. Recovery path documented before outage; system state observable without leaking credentials | Settings → System; `/connect`, `/recovery` | **MISSING** | Provisioning/security review, auth expiry, IP/key lifecycle, recovery drill and secret-safe delivery |

## Screen-derived Telegram navigation contract

The video frames confirm a main grid with:

1. New session
2. Sessions
3. Agent
4. Projects
5. Skills
6. MCP
7. Settings
8. Monitoring

The Agent screen contains Model, Thinking depth, Work mode, and Connection.
Settings contains Connections, Environment variables, My bots, Timezone,
Timers, API limit, Server state, and System. Monitoring contains Sources,
Digest, Search, Settings, and Help.

These reply-menu buttons are navigation only. During a free-text turn the reply
keyboard must be removed; `/menu` restores it. Inline approval/action buttons
remain attached only to the card they authorize and carry a one-time binding.

## Cross-cutting implementation order

1. Reliable action evidence and provider behavioural tests.
2. Reference-compatible global/project/session/file topology from ADR-0063.
3. Telegram onboarding and all three brain connection flows.
4. Sessions, project controls, attachment inbox/import and file routing.
5. Visible budgeted agents/sub-agents.
6. Memory routing, DNA, learning and scoped autonomy.
7. Monitoring store, collectors, scoring and digest.
8. Streaming/status/media/product polish.
9. Browser-IDE/server-access features after the core agent loop is proven.

## Release rule

A lesson row may move to **LIVE** only when its user flow is reachable from the
production Telegram/runtime composition and the named behavioural proof passes.
A menu label, isolated core implementation, mock-only unit test, or design
document is insufficient.
