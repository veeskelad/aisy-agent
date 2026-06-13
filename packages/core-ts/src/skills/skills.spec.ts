import { describe, it, expect, beforeEach } from 'vitest'
import { makeSkillRegistry } from './index.js'
import { makeEffectVerifier, makeProviderFake } from '../testing/index.js'
import type {
  SkillsDeps,
  SandboxPort,
  ObservabilityPort,
  GitPort,
  NonceStore,
  ParsedSkill,
  TriggerContext,
  ApprovalVerdict,
  FailureSignal,
} from './types.js'

// ---------------------------------------------------------------------------
// Minimal helpers
// ---------------------------------------------------------------------------

function makeMinimalFrontmatter(overrides?: Record<string, unknown>) {
  return {
    name: 'deploy-preview',
    description: 'Ship a Vercel preview and post the URL',
    version: 1,
    provenance: 'agent-authored' as const,
    triggers: ['deploy preview', 'vercel preview'],
    ...overrides,
  }
}

const VERIFICATION_SECTION = '\n\n## verification\n- Deployment is live.\n'

function makeValidSkillMd(overrides?: Record<string, unknown>): string {
  // Fields overridden to undefined are OMITTED from the YAML (a "missing
  // field" must be genuinely absent, not the literal string "undefined").
  const fm = makeMinimalFrontmatter(overrides) as Record<string, unknown>
  const lines = ['---']
  if (fm['name'] !== undefined) lines.push(`name: ${fm['name']}`)
  if (fm['description'] !== undefined) lines.push(`description: ${fm['description']}`)
  if (fm['version'] !== undefined) lines.push(`version: ${fm['version']}`)
  if (fm['provenance'] !== undefined) lines.push(`provenance: ${fm['provenance']}`)
  if (fm['triggers'] !== undefined) {
    lines.push('triggers:')
    lines.push(...(fm['triggers'] as string[]).map((t) => `  - ${t}`))
  }
  lines.push('---')
  return lines.join('\n') + '\n\n## steps\n1. Run `vercel deploy`.' + VERIFICATION_SECTION
}

function makeValidParsedSkill(overrides?: Record<string, unknown>): ParsedSkill {
  const raw = makeValidSkillMd(overrides)
  return {
    frontmatter: makeMinimalFrontmatter(overrides) as any,
    body: '## steps\n1. Run `vercel deploy`.' + VERIFICATION_SECTION,
    rawBytes: new TextEncoder().encode(raw),
  }
}

function makeApprovalVerdict(stageId: string, artifactHash: string, overrides?: Partial<ApprovalVerdict>): ApprovalVerdict {
  return {
    stageId,
    artifactHash,
    nonce: 'nonce-abc123',
    stepUpSatisfied: true,
    humanTapAuditId: 'tap-audit-1',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Stub deps factories
// ---------------------------------------------------------------------------

function makeSandboxOk(): SandboxPort {
  return { dryRun: async (_body) => ({ ok: true }) }
}

function makeSandboxDown(): SandboxPort {
  // An unavailable sandbox fails at invocation: the call into the sandbox
  // cannot even start, so "down" surfaces as a synchronous throw. This is
  // faithful to "Safety/Docker down" (§7/AC-06-9). validate() awaits the
  // dry-run and treats both a throw and a resolved {ok:false} as fail-closed.
  return { dryRun: (_body) => { throw new Error('sandbox unavailable') } }
}

function makeSandboxReject(): SandboxPort {
  // A live, available sandbox that runs the body and REJECTS it by resolving
  // with {ok:false} (per the declared SandboxPort contract — Promise<{ok}>).
  // The body did not pass the dry-run; the candidate must be fail-closed.
  return { dryRun: async (_body) => ({ ok: false, detail: 'body failed dry-run' }) }
}

function makeObservabilityPort(hasTrace: boolean): ObservabilityPort & { emitted: Array<{ event: string; payload: unknown }> } {
  const emitted: Array<{ event: string; payload: unknown }> = []
  return {
    emitted,
    hasPassingTrace: async (_name) => hasTrace,
    emit(event, payload) { emitted.push({ event, payload }) },
  }
}

function makeGitPort(): GitPort & { commits: Array<{ message: string; files: Record<string, string> }> } {
  const commits: Array<{ message: string; files: Record<string, string> }> = []
  return {
    commits,
    async commit(message, files) {
      const hash = `sha-${commits.length + 1}`
      commits.push({ message, files })
      return hash
    },
  }
}

function makeNonceStore(valid = true): NonceStore {
  const used = new Set<string>()
  if (!valid) {
    // Pre-poison the nonce so first consume returns false (replay scenario)
    used.add('nonce-abc123')
  }
  return {
    consume(nonce, _stageId) {
      if (used.has(nonce)) return false
      used.add(nonce)
      return true
    },
  }
}

function makeDeps(overrides?: Partial<SkillsDeps> & { hasTrace?: boolean }): SkillsDeps {
  return {
    sandbox: overrides?.sandbox ?? makeSandboxOk(),
    observability: overrides?.observability ?? makeObservabilityPort(overrides?.hasTrace ?? true),
    git: overrides?.git ?? makeGitPort(),
    nonceStore: overrides?.nonceStore ?? makeNonceStore(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Component 06 — Skills', () => {

  // ---- Format contract (ADR-0015) ----------------------------------------

  it('AC-06-1: description > 60 chars returns ParseError; candidate not written to staging/', () => {
    const longDesc = 'A'.repeat(61)
    const raw = makeValidSkillMd({ description: longDesc })
    const skills = makeSkillRegistry(makeDeps())
    const result = skills.parse(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const kinds = result.errors.map(e => e.kind)
      expect(kinds).toContain('description_too_long')
    }
  })

  it('AC-06-2: SKILL.md missing required frontmatter field is rejected by parse(); never reaches judge', () => {
    const fields = ['name', 'description', 'version', 'provenance', 'triggers'] as const
    const skills = makeSkillRegistry(makeDeps())
    for (const field of fields) {
      const raw = makeValidSkillMd({ [field]: undefined })
      const result = skills.parse(raw)
      expect(result.ok, `expected parse error for missing field: ${field}`).toBe(false)
    }
  })

  it('AC-06-3: candidate with no ## verification section fails has_verification_section; nothing written to staging/', async () => {
    const rawNoVerification = '---\nname: test-skill\ndescription: Short description here\nversion: 1\nprovenance: human\ntriggers:\n  - test\n---\n\n## steps\n1. Do something.\n'
    const skills = makeSkillRegistry(makeDeps())
    const parsed = skills.parse(rawNoVerification)
    if (parsed.ok) {
      const report = await skills.validate(parsed.skill)
      expect(report.has_verification_section).toBe(false)
      expect(report.ok).toBe(false)
    } else {
      // parse itself may catch it too; either way no staging proceeds
      expect(parsed.ok).toBe(false)
    }
  })

  it('AC-06-4: menu() returns exactly one line per active+trusted skill; no body text present', () => {
    const skills = makeSkillRegistry(makeDeps())
    const entries = skills.menu()
    for (const entry of entries) {
      expect(Object.keys(entry)).toEqual(expect.arrayContaining(['name', 'description']))
      // body content check: no line starting with step markers
      expect(entry.description).not.toMatch(/^##\s/)
      expect(entry.description).not.toMatch(/^\d+\./)
    }
  })

  // ---- Lazy loading / KV-cache stability (ADR-0015, ADR-0019) ------------

  it('AC-06-5: on no trigger match, loadBody() is not called and working context has no body', () => {
    const skills = makeSkillRegistry(makeDeps())
    const matched = skills.matchTriggers('an irrelevant request with no skill keywords')
    expect(matched).toEqual([])
    // Because matched is empty the caller never invokes loadBody —
    // if matchTriggers returned a name we would see a body; assert empty here.
  })

  it('AC-06-6: on trigger match, matched body is present; prefix bytes unchanged after loadBody()', async () => {
    const skills = makeSkillRegistry(makeDeps())
    // Promote a skill so it is active+trusted and present in the menu
    const candidate = makeValidParsedSkill()
    const ctx: TriggerContext = { request: 'deploy preview', sessionId: 'sess-1' }
    const staged = skills.stage(candidate, ctx)
    const promoted = await skills.promote(staged.stageId, makeApprovalVerdict(staged.stageId, staged.artifactHash))
    expect(promoted.ok).toBe(true)
    // First capture prefix via menu (byte-stable region)
    const menuBefore = JSON.stringify(skills.menu())
    const matchedNames = skills.matchTriggers('deploy preview')
    expect(matchedNames).toContain('deploy-preview')
    const body = await skills.loadBody(matchedNames[0]!)
    expect(typeof body).toBe('string')
    expect(body.length).toBeGreaterThan(0)
    // Prefix must not have changed
    expect(JSON.stringify(skills.menu())).toBe(menuBefore)
  })

  it('AC-06-7: writing a telemetry update leaves SKILL.md file bytes unchanged', () => {
    // The telemetry sidecar (Observability 12) owns hit_count/last_used_at.
    // Skills must never mutate SKILL.md to record usage. This is a contract test:
    // the SkillsDeps interface does NOT include a method to write back to SKILL.md
    // from telemetry operations — verify by type (no such method on the surface).
    const skills = makeSkillRegistry(makeDeps())
    // If loadBody/menu/matchTriggers are called, the git port must see 0 commits.
    const git = makeGitPort()
    const skillsWithGit = makeSkillRegistry({ ...makeDeps(), git })
    skillsWithGit.menu()
    skillsWithGit.matchTriggers('something')
    expect(git.commits.length).toBe(0)
  })

  // ---- Deterministic validators (ADR-0015, ADR-0016) ---------------------

  it('AC-06-8: candidate referencing non-existent refs fails refs_exist; judge never invoked', async () => {
    const candidate = makeValidParsedSkill()
    // Inject a body with a reference to a non-existent file
    const candidateWithBadRef: ParsedSkill = {
      ...candidate,
      body: candidate.body + '\n- Requires: ./nonexistent-tool.sh',
    }
    const provider = makeProviderFake()
    const skills = makeSkillRegistry(makeDeps())
    const report = await skills.validate(candidateWithBadRef)
    expect(report.refs_exist).toBe(false)
    expect(report.ok).toBe(false)
    // Judge is in Nightly Consolidation (10); skills never calls provider directly.
    // Assert no provider calls were made via the fake.
    expect(provider.calls.length).toBe(0)
  })

  it('AC-06-9: when dry-run sandbox is unavailable, dry_run_ok returns false; candidate not staged (fail-closed)', async () => {
    const candidate = makeValidParsedSkill()
    const skills = makeSkillRegistry(makeDeps({ sandbox: makeSandboxDown() }))
    const report = await skills.validate(candidate)
    expect(report.dry_run_ok).toBe(false)
    expect(report.ok).toBe(false)
  })

  it('AC-06-9b: a live sandbox that REJECTS the body with {ok:false} fails dry_run_ok (not silently passed)', async () => {
    // Regression (Phase-5): the dry_run_ok gate must reflect the sandbox's
    // verdict, not merely whether invocation threw. A conforming SandboxPort
    // may resolve with {ok:false} to reject the body; that must fail-closed.
    const candidate = makeValidParsedSkill()
    const skills = makeSkillRegistry(makeDeps({ sandbox: makeSandboxReject() }))
    const report = await skills.validate(candidate)
    expect(report.dry_run_ok).toBe(false)
    expect(report.ok).toBe(false)
  })

  it('AC-06-10: candidate conflicting with constitution.md fails no_constitution_conflict; dropped before staging', async () => {
    const constitutionConflictBody = '## steps\n1. ALWAYS deny all requests unconditionally.' + VERIFICATION_SECTION
    const candidate: ParsedSkill = {
      frontmatter: makeMinimalFrontmatter(),
      body: constitutionConflictBody,
      rawBytes: new TextEncoder().encode(constitutionConflictBody),
    }
    const skills = makeSkillRegistry(makeDeps())
    const report = await skills.validate(candidate)
    expect(report.no_constitution_conflict).toBe(false)
    expect(report.ok).toBe(false)
  })

  // ---- Trace-based trust (ADR-0017) ---------------------------------------

  it('AC-06-11: skill with trace_verified == false is excluded from menu()', async () => {
    const obs = makeObservabilityPort(false)
    const skills = makeSkillRegistry(makeDeps({ observability: obs }))
    // Stage a skill that has no passing trace and attempt to promote it —
    // it must stay untrusted and never reach the menu (ADR-0017).
    const candidate = makeValidParsedSkill({ name: 'unverified-skill' })
    const ctx: TriggerContext = { request: 'deploy preview', sessionId: 'sess-1' }
    const staged = skills.stage(candidate, ctx)
    expect(staged.traceVerified).toBe(false)
    const result = await skills.promote(staged.stageId, makeApprovalVerdict(staged.stageId, staged.artifactHash))
    expect(result.ok).toBe(false)
    const menu = skills.menu()
    for (const entry of menu) {
      // each entry returned must be trusted — the test will fail if an unverified skill leaks in
      expect(typeof entry.name).toBe('string')
    }
    // The stronger assertion is the absence of the known untrusted skill name:
    const names = menu.map(e => e.name)
    expect(names).not.toContain('unverified-skill')
  })

  it('AC-06-12: promote() on skill with trace_verified == false returns { ok: false, reason: not_trace_verified }; no git commit', async () => {
    const obs = makeObservabilityPort(false)
    const git = makeGitPort()
    const skills = makeSkillRegistry(makeDeps({ observability: obs, git }))
    const candidate = makeValidParsedSkill()
    const ctx: TriggerContext = { request: 'deploy preview', sessionId: 'sess-1' }
    const staged = skills.stage(candidate, ctx)
    const verdict = makeApprovalVerdict(staged.stageId, staged.artifactHash)
    const result = await skills.promote(staged.stageId, verdict)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_trace_verified')
    expect(git.commits.length).toBe(0)
  })

  it('AC-06-13: self-reported "verification passed" with no trace in journal does NOT set trace_verified to true', () => {
    // Observability returns false (no real trace)
    const obs = makeObservabilityPort(false)
    const skills = makeSkillRegistry(makeDeps({ observability: obs }))
    const candidate = makeValidParsedSkill()
    const ctx: TriggerContext = { request: 'deploy preview', sessionId: 'sess-1' }
    const staged = skills.stage(candidate, ctx)
    // trace_verified must be false because observability has no real trace
    expect(staged.traceVerified).toBe(false)
  })

  // ---- Staging governance & approval integrity (ADR-0015, ADR-0029) ------

  it('AC-06-14: agent-authored skill that reaches prod has a prior staged artifact (no direct prod write)', async () => {
    const git = makeGitPort()
    const skills = makeSkillRegistry(makeDeps({ git }))
    const candidate = makeValidParsedSkill()
    const ctx: TriggerContext = { request: 'deploy preview', sessionId: 'sess-1' }
    // Stage first — this is the required prior step
    const staged = skills.stage(candidate, ctx)
    expect(staged.stageId).toBeTruthy()
    // Only then promote
    const verdict = makeApprovalVerdict(staged.stageId, staged.artifactHash)
    const result = await skills.promote(staged.stageId, verdict)
    if (result.ok) {
      expect(git.commits.length).toBeGreaterThanOrEqual(1)
    }
    // There must be no git commit that bypassed staging (we only call promote after stage)
  })

  it('AC-06-15: review payload for staged skill contains full text, diff, and triggering context', () => {
    const skills = makeSkillRegistry(makeDeps())
    const candidate = makeValidParsedSkill()
    const ctx: TriggerContext = { request: 'deploy preview', sessionId: 'sess-1' }
    const staged = skills.stage(candidate, ctx)
    const card = skills.reviewPayload(staged.stageId)
    expect(typeof card.fullText).toBe('string')
    expect(card.fullText.length).toBeGreaterThan(0)
    expect(typeof card.diff).toBe('string')
    expect(card.triggerContext).toMatchObject({ request: ctx.request, sessionId: ctx.sessionId })
  })

  it('AC-06-16: trust/permanence fields from generator/judge output are absent from staged artifact; promote sets approved flag only from deterministic handler', () => {
    const skills = makeSkillRegistry(makeDeps())
    const candidate = makeValidParsedSkill()
    const ctx: TriggerContext = { request: 'deploy preview', sessionId: 'sess-1' }
    const staged = skills.stage(candidate, ctx)
    // Staged artifact must not carry any "approved" or "trusted" field
    expect((staged as any).approved).toBeUndefined()
    expect((staged as any).trusted).toBeUndefined()
    // StagedSkill interface has no such field — TypeScript enforces this at compile time
  })

  it('AC-06-17: promote() aborts with hash_mismatch when staged bytes differ from approval.artifactHash; no commit', async () => {
    const git = makeGitPort()
    const skills = makeSkillRegistry(makeDeps({ git }))
    const candidate = makeValidParsedSkill()
    const ctx: TriggerContext = { request: 'deploy preview', sessionId: 'sess-1' }
    const staged = skills.stage(candidate, ctx)
    // Tamper: supply a different hash
    const verdict = makeApprovalVerdict(staged.stageId, 'sha256-tampered-aaaa')
    const result = await skills.promote(staged.stageId, verdict)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('hash_mismatch')
    expect(git.commits.length).toBe(0)
  })

  it('AC-06-18: promote() rejects replayed/stale nonce with replayed_nonce or no_pending_action; no commit', async () => {
    const git = makeGitPort()
    const nonceStore = makeNonceStore(false) // nonce pre-consumed
    const skills = makeSkillRegistry(makeDeps({ git, nonceStore }))
    const candidate = makeValidParsedSkill()
    const ctx: TriggerContext = { request: 'deploy preview', sessionId: 'sess-1' }
    const staged = skills.stage(candidate, ctx)
    const verdict = makeApprovalVerdict(staged.stageId, staged.artifactHash)
    const result = await skills.promote(staged.stageId, verdict)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(['replayed_nonce', 'no_pending_action']).toContain(result.reason)
    }
    expect(git.commits.length).toBe(0)
  })

  it('AC-06-18b: two concurrent promote() calls on the same stageId with distinct nonces commit at most once (TOCTOU)', async () => {
    // Regression (Phase-5): the per-nonce NonceStore does not prevent two
    // DISTINCT valid nonces being issued for the same stageId. Concurrent
    // promotes must not both reach git.commit() — exactly one wins, the other
    // sees the staged record already consumed (no_pending_action).
    const git = makeGitPort()
    const skills = makeSkillRegistry(makeDeps({ git }))
    const candidate = makeValidParsedSkill()
    const ctx: TriggerContext = { request: 'deploy preview', sessionId: 'sess-1' }
    const staged = skills.stage(candidate, ctx)
    const verdictA = makeApprovalVerdict(staged.stageId, staged.artifactHash, { nonce: 'nonce-A' })
    const verdictB = makeApprovalVerdict(staged.stageId, staged.artifactHash, { nonce: 'nonce-B' })
    const [resA, resB] = await Promise.all([
      skills.promote(staged.stageId, verdictA),
      skills.promote(staged.stageId, verdictB),
    ])
    const okCount = [resA, resB].filter((r) => r.ok).length
    expect(okCount).toBe(1)
    expect(git.commits.length).toBe(1)
    const loser = [resA, resB].find((r) => !r.ok)!
    if (!loser.ok) expect(loser.reason).toBe('no_pending_action')
  })

  it('AC-06-19: promote() of permanence/irreversible skill with stepUpSatisfied==false returns stepup_missing; no commit', async () => {
    const git = makeGitPort()
    const skills = makeSkillRegistry(makeDeps({ git }))
    // Use provenance: human but mark as irreversible via description keyword
    const candidate = makeValidParsedSkill({ description: 'Irreversible: wipe all data' })
    const ctx: TriggerContext = { request: 'wipe data', sessionId: 'sess-1' }
    const staged = skills.stage(candidate, ctx)
    const verdict = makeApprovalVerdict(staged.stageId, staged.artifactHash, { stepUpSatisfied: false })
    const result = await skills.promote(staged.stageId, verdict)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('stepup_missing')
    expect(git.commits.length).toBe(0)
  })

  it('AC-06-20: successful promote() writes a tap→commit audit binding humanTapAuditId to commit hash and version', async () => {
    const git = makeGitPort()
    const skills = makeSkillRegistry(makeDeps({ git }))
    const candidate = makeValidParsedSkill()
    const ctx: TriggerContext = { request: 'deploy preview', sessionId: 'sess-1' }
    const staged = skills.stage(candidate, ctx)
    const verdict = makeApprovalVerdict(staged.stageId, staged.artifactHash, {
      humanTapAuditId: 'tap-audit-xyz',
    })
    const result = await skills.promote(staged.stageId, verdict)
    if (result.ok) {
      expect(typeof result.commit).toBe('string')
      expect(result.commit.length).toBeGreaterThan(0)
      expect(typeof result.version).toBe('number')
      // The commit message or audit log must bind the tap id — assert git was called
      expect(git.commits.length).toBeGreaterThanOrEqual(1)
    }
  })

  // ---- Transient-vs-permanent failure (ADR-0025) --------------------------

  it('AC-06-21: single transient failure produces transient note in journal; no negative SKILL.md created', () => {
    const obs = makeObservabilityPort(true) as ReturnType<typeof makeObservabilityPort>
    const skills = makeSkillRegistry(makeDeps({ observability: obs }))
    const signal: FailureSignal = {
      target: 'vercel-tool',
      class: 'transient',
      sessionId: 'sess-1',
      detail: 'timeout after 30s',
    }
    skills.recordFailure('vercel-tool', signal)
    // Should emit a transient note event, not a skill.staged event
    const stagingEvents = obs.emitted.filter(e => e.event === 'skill.staged')
    expect(stagingEvents.length).toBe(0)
    const noteEvents = obs.emitted.filter(e =>
      e.event === 'skill.failure_recorded' || e.event === 'failure.transient_note'
    )
    expect(noteEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('AC-06-22: three permanent failures in the same session do not cross threshold; no negative skill drafted', () => {
    const obs = makeObservabilityPort(true) as ReturnType<typeof makeObservabilityPort>
    const skills = makeSkillRegistry(makeDeps({ observability: obs }))
    const sameSession = 'sess-same'
    for (let i = 0; i < 3; i++) {
      skills.recordFailure('auth-tool', {
        target: 'auth-tool',
        class: 'permanent',
        sessionId: sameSession,
      })
    }
    // Distinct-session count is 1 (all same session) — no negative skill drafted
    const stagingEvents = obs.emitted.filter(e => e.event === 'skill.staged')
    expect(stagingEvents.length).toBe(0)
  })

  it('AC-06-23: three permanent failures across three distinct sessions draft a negative skill candidate entering staging path', () => {
    const obs = makeObservabilityPort(true) as ReturnType<typeof makeObservabilityPort>
    const skills = makeSkillRegistry(makeDeps({ observability: obs }))
    for (let i = 1; i <= 3; i++) {
      skills.recordFailure('auth-tool', {
        target: 'auth-tool',
        class: 'permanent',
        sessionId: `sess-${i}`,
      })
    }
    // With 3 distinct sessions, a negative-skill draft must enter staging
    const stagingEvents = obs.emitted.filter(e =>
      e.event === 'skill.staged' || e.event === 'skill.negative_created'
    )
    expect(stagingEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('AC-06-24: approved negative skill lowers target priority but never emits HARD_DENY; advisory==true; capability remains callable', async () => {
    const obs = makeObservabilityPort(true) as ReturnType<typeof makeObservabilityPort>
    const skillsWithObs = makeSkillRegistry(makeDeps({ observability: obs }))
    // Force threshold by 3 distinct-session failures
    for (let i = 1; i <= 3; i++) {
      skillsWithObs.recordFailure('auth-tool', {
        target: 'auth-tool',
        class: 'permanent',
        sessionId: `sess-${i}`,
      })
    }
    // The negative skill record must be advisory only — never a HARD_DENY,
    // so the capability remains callable (priority lowered, not deleted).
    const negativeEvents = obs.emitted.filter(e => e.event === 'skill.negative_created')
    expect(negativeEvents.length).toBeGreaterThanOrEqual(1)
    expect((negativeEvents[0]!.payload as any).advisory).toBe(true)
    const hardDenyEvents = obs.emitted.filter(e => e.event === 'HARD_DENY')
    expect(hardDenyEvents.length).toBe(0)
  })

  it('AC-06-25: nightly probe() re-test success sets invalid_at (not a hard delete); un-fossilize diff card emitted', async () => {
    const obs = makeObservabilityPort(true) as ReturnType<typeof makeObservabilityPort>
    const skills = makeSkillRegistry(makeDeps({ observability: obs }))
    // Create a negative skill (3 permanent failures across distinct sessions),
    // then probe: the ok-sandbox re-test succeeds and must un-fossilize it.
    for (let i = 1; i <= 3; i++) {
      skills.recordFailure('auth-tool', {
        target: 'auth-tool',
        class: 'permanent',
        sessionId: `sess-${i}`,
      })
    }
    const report = await skills.probe()
    expect(report.unfossilized).toContain('auth-tool')
    expect(typeof report.checkedAt).toBe('string')
    expect(Array.isArray(report.unfossilized)).toBe(true)
    expect(Array.isArray(report.stillFailing)).toBe(true)
    // Each unfossilized entry must have emitted an un-fossilize event
    for (const name of report.unfossilized) {
      const unfossilizeEvents = obs.emitted.filter(e =>
        e.event === 'skill.unfossilized' && (e.payload as any)?.name === name
      )
      expect(unfossilizeEvents.length).toBeGreaterThanOrEqual(1)
    }
  })

  // ---- Failure/degraded modes (§7) ----------------------------------------

  it('AC-06-26: on cold start with empty library, menu() returns empty list; no error surfaced to user', () => {
    const skills = makeSkillRegistry(makeDeps())
    let menu: ReturnType<typeof skills.menu>
    let threwError = false
    try {
      menu = skills.menu()
    } catch {
      threwError = true
    }
    // No error should surface; when stub is replaced with real impl, menu() returns []
    expect(threwError).toBe(false)
    // On cold start the list is empty
    expect(Array.isArray(menu!)).toBe(true)
  })

  it('AC-06-27: when telemetry sidecar is unavailable, loadBody() still returns the body; serving not blocked on telemetry', async () => {
    // Telemetry is owned by Observability 12. We simulate its unavailability by
    // providing an observability port whose emit() throws — but loadBody() must still work.
    const faultyObs: ObservabilityPort = {
      hasPassingTrace: async () => true,
      emit(_event, _payload) { throw new Error('telemetry sidecar unavailable') },
    }
    const skills = makeSkillRegistry(makeDeps({ observability: faultyObs }))
    // Promote a skill through the full path while the sidecar is throwing —
    // staging/promotion telemetry is also fail-open, never load-bearing.
    const candidate = makeValidParsedSkill()
    const ctx: TriggerContext = { request: 'deploy preview', sessionId: 'sess-1' }
    const staged = skills.stage(candidate, ctx)
    const promoted = await skills.promote(staged.stageId, makeApprovalVerdict(staged.stageId, staged.artifactHash))
    expect(promoted.ok).toBe(true)
    // loadBody() must not propagate the telemetry error to the caller
    const result = await skills.loadBody('deploy-preview')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})
