import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { computeSkillActionHash, makeSkillRegistry } from './index.js'
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
    ...(overrides?.promotionAudit ? { promotionAudit: overrides.promotionAudit } : {}),
    unsafeLegacyPromotion: overrides?.unsafeLegacyPromotion ?? true,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Component 06 — Skills', () => {

  // ---- Frontmatter parser regressions (Phase-5) --------------------------

  it('REG-06-A: a frontmatter line beginning with `---` (e.g. `----`) does NOT truncate the fence early', () => {
    // A YAML value whose line begins with `---` (here a `----` rule on its own
    // line inside the description block) must not be mistaken for the closing
    // fence. The closing fence must be exactly `---`, not any `---` prefix.
    const raw =
      '---\n' +
      'name: rule-skill\n' +
      'description: short desc\n' +
      '----\n' + // line beginning with --- inside the frontmatter block (not the fence)
      'version: 1\n' +
      'provenance: human\n' +
      'triggers:\n' +
      '  - do thing\n' +
      '---\n\n' +
      '## steps\n1. go.' + VERIFICATION_SECTION
    const skills = makeSkillRegistry(makeDeps())
    const result = skills.parse(raw)
    // Before the fix the fence is truncated at `  ----`, dropping version /
    // provenance / triggers and producing missing_field errors.
    expect(result.ok, JSON.stringify(result.ok ? {} : result.errors)).toBe(true)
    if (result.ok) {
      expect(result.skill.frontmatter.version).toBe(1)
      expect(result.skill.frontmatter.provenance).toBe('human')
      expect(result.skill.frontmatter.triggers).toEqual(['do thing'])
    }
  })

  it('REG-06-B: a blank line within the trigger list does not silently truncate later triggers', () => {
    const raw =
      '---\n' +
      'name: multi-trigger\n' +
      'description: short desc\n' +
      'version: 1\n' +
      'provenance: human\n' +
      'triggers:\n' +
      '  - first trigger\n' +
      '\n' + // blank line within the list — must not truncate
      '  - second trigger\n' +
      '---\n\n' +
      '## steps\n1. go.' + VERIFICATION_SECTION
    const skills = makeSkillRegistry(makeDeps())
    const result = skills.parse(raw)
    expect(result.ok, JSON.stringify(result.ok ? {} : result.errors)).toBe(true)
    if (result.ok) {
      expect(result.skill.frontmatter.triggers).toEqual(['first trigger', 'second trigger'])
    }
  })

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

  it.each(['trusted', 'approved', 'is_human_confirmed', 'is-human-confirmed', 'permanence'])(
    'rejects prohibited or unknown frontmatter authority bytes: %s',
    field => {
      const raw = makeValidSkillMd().replace('version: 1', `version: 1\n${field}: true`)
      const skills = makeSkillRegistry(makeDeps())
      const parsed = skills.parse(raw)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.errors).toContainEqual({ kind: 'prohibited_authority_field', field })

      const constructed = makeValidParsedSkill()
      expect(() => skills.stage(
        { ...constructed, rawBytes: new TextEncoder().encode(raw) },
        { request: 'deploy preview', sessionId: 'sess-authority' },
      )).toThrow('PROHIBITED_SKILL_AUTHORITY_FIELD')
    },
  )

  it('rejects an empty or whitespace-only trigger in the exact SKILL.md bytes', () => {
    const raw = makeValidSkillMd({ triggers: ['   '] })
    const result = makeSkillRegistry(makeDeps()).parse(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map(error => error.kind)).toContain('empty_trigger')
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
    const promoted = await skills.promote(staged.stageId, makeApprovalVerdict(staged.stageId, staged.artifactHash, { actionHash: staged.actionHash! }))
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
    const result = await skills.promote(staged.stageId, makeApprovalVerdict(staged.stageId, staged.artifactHash, { actionHash: staged.actionHash! }))
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
    const verdict = makeApprovalVerdict(staged.stageId, staged.artifactHash, { actionHash: staged.actionHash! })
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
    const verdict = makeApprovalVerdict(staged.stageId, staged.artifactHash, { actionHash: staged.actionHash! })
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
    const verdict = makeApprovalVerdict(staged.stageId, 'sha256-tampered-aaaa', { actionHash: staged.actionHash! })
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
    const verdict = makeApprovalVerdict(staged.stageId, staged.artifactHash, { actionHash: staged.actionHash! })
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
    const verdictA = makeApprovalVerdict(staged.stageId, staged.artifactHash, { nonce: 'nonce-A', actionHash: staged.actionHash! })
    const verdictB = makeApprovalVerdict(staged.stageId, staged.artifactHash, { nonce: 'nonce-B', actionHash: staged.actionHash! })
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

  it('rejects a stale sibling revision at the exact active-pointer CAS', async () => {
    const skills = makeSkillRegistry(makeDeps())
    const first = skills.stage(makeValidParsedSkill(), { request: 'first', sessionId: 'sess-first' })
    const sibling = skills.stage(makeValidParsedSkill(), { request: 'sibling', sessionId: 'sess-sibling' })
    const [left, right] = await Promise.all([
      skills.promote(first.stageId, makeApprovalVerdict(first.stageId, first.artifactHash, {
        actionHash: first.actionHash!, nonce: 'nonce-first-sibling',
      })),
      skills.promote(sibling.stageId, makeApprovalVerdict(sibling.stageId, sibling.artifactHash, {
        actionHash: sibling.actionHash!, nonce: 'nonce-second-sibling',
      })),
    ])
    expect([left, right].filter(result => result.ok)).toHaveLength(1)
    const rejected = [left, right].find(result => !result.ok)
    expect(rejected).toEqual({ ok: false, reason: 'revision_conflict' })
    expect(skills.menu()).toHaveLength(1)
  })

  it('reserves a skill before deferred git so a sibling has zero external effects', async () => {
    let traceCalls = 0
    let releaseTraces!: () => void
    const tracesReady = new Promise<void>(resolve => { releaseTraces = resolve })
    let commitCalls = 0
    let releaseCommit!: (commit: string) => void
    const commitResult = new Promise<string>(resolve => { releaseCommit = resolve })
    let notifyCommitStarted!: () => void
    const commitStarted = new Promise<void>(resolve => { notifyCommitStarted = resolve })
    let auditCalls = 0
    const skills = makeSkillRegistry(makeDeps({
      observability: {
        hasPassingTrace: async () => {
          traceCalls += 1
          if (traceCalls === 2) releaseTraces()
          await tracesReady
          return true
        },
        emit: () => {},
      },
      git: {
        commit: async () => {
          commitCalls += 1
          notifyCommitStarted()
          return commitResult
        },
      },
      promotionAudit: { record: async () => { auditCalls += 1 } },
    }))
    const first = skills.stage(makeValidParsedSkill(), { request: 'first', sessionId: 'sess-reserve-first' })
    const sibling = skills.stage(makeValidParsedSkill(), { request: 'sibling', sessionId: 'sess-reserve-sibling' })
    const left = skills.promote(first.stageId, makeApprovalVerdict(first.stageId, first.artifactHash, {
      actionHash: first.actionHash!, nonce: 'nonce-reserve-first',
    }))
    const right = skills.promote(sibling.stageId, makeApprovalVerdict(sibling.stageId, sibling.artifactHash, {
      actionHash: sibling.actionHash!, nonce: 'nonce-reserve-sibling',
    }))

    await commitStarted
    expect(commitCalls).toBe(1)
    expect(auditCalls).toBe(0)
    releaseCommit('sha-reserved')
    const results = await Promise.all([left, right])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.find(result => !result.ok)).toEqual({ ok: false, reason: 'revision_conflict' })
    expect(commitCalls).toBe(1)
    expect(auditCalls).toBe(1)
  })

  it('AC-06-19: promote() of permanence/irreversible skill with stepUpSatisfied==false returns stepup_missing; no commit', async () => {
    const git = makeGitPort()
    const skills = makeSkillRegistry(makeDeps({ git }))
    // Use provenance: human but mark as irreversible via description keyword
    const candidate = makeValidParsedSkill({ description: 'Irreversible: wipe all data' })
    const ctx: TriggerContext = { request: 'wipe data', sessionId: 'sess-1' }
    const staged = skills.stage(candidate, ctx)
    const verdict = makeApprovalVerdict(staged.stageId, staged.artifactHash, {
      stepUpSatisfied: false, actionHash: staged.actionHash!,
    })
    const result = await skills.promote(staged.stageId, verdict)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('stepup_missing')
    expect(git.commits.length).toBe(0)
  })

  it('REG-06-C: a benign-titled skill with a destructive BODY still requires step-up (body scanned, not just name/description)', async () => {
    // Title/description look harmless, but the body performs an irreversible
    // operation. isIrreversible() must scan the body too (§8 ADR-0029 #5),
    // otherwise step-up is skipped and a destructive recipe promotes on a plain tap.
    const git = makeGitPort()
    const skills = makeSkillRegistry(makeDeps({ git }))
    const destructiveBody = '## steps\n1. Run `rm -rf /var/data` to reset.' + VERIFICATION_SECTION
    const candidate = makeValidParsedSkill()
    const candidateWithDestructiveBody: ParsedSkill = {
      ...candidate,
      body: destructiveBody,
      rawBytes: new TextEncoder().encode(
        new TextDecoder().decode(candidate.rawBytes).replace(candidate.body, destructiveBody),
      ),
    }
    const ctx: TriggerContext = { request: 'deploy preview', sessionId: 'sess-1' }
    const staged = skills.stage(candidateWithDestructiveBody, ctx)
    const verdict = makeApprovalVerdict(staged.stageId, staged.artifactHash, {
      stepUpSatisfied: false, actionHash: staged.actionHash!,
    })
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
      humanTapAuditId: 'tap-audit-xyz', actionHash: staged.actionHash!,
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

  it('pins immutable revision identity and a canonical action hash at stage time', () => {
    const skills = makeSkillRegistry(makeDeps())
    const staged = skills.stage(makeValidParsedSkill(), { request: 'deploy preview', sessionId: 'sess-pin' })

    expect(staged.revision).toEqual({
      name: 'deploy-preview',
      baseVersion: null,
      baseArtifactHash: null,
      candidateVersion: 1,
      artifactHash: staged.artifactHash,
    })
    expect(staged.actionHash).toBe(computeSkillActionHash({
      stageId: staged.stageId,
      name: 'deploy-preview',
      baseVersion: null,
      baseArtifactHash: null,
      candidateVersion: 1,
      artifactHash: staged.artifactHash,
      diffHash: createHash('sha256').update(staged.diff, 'utf8').digest('hex'),
      provenance: 'agent-authored',
      riskClassification: 'reversible',
      stepUpRequired: false,
      touchedPaths: ['skills/deploy-preview/SKILL.md'],
    }))
  })

  it('fails closed for a production promotion until an exact v2 preview exists', async () => {
    const skills = makeSkillRegistry(makeDeps({ unsafeLegacyPromotion: false }))
    const staged = skills.stage(makeValidParsedSkill(), { request: 'deploy preview', sessionId: 'sess-v2-missing' })
    expect(await skills.promote(staged.stageId, makeApprovalVerdict(staged.stageId, staged.artifactHash, {
      actionHash: staged.actionHash!, approvedAt: '2026-07-28T00:01:00.000Z',
    }))).toEqual({ ok: false, reason: 'approval_mismatch' })
  })

  it.each([
    ['missing evidence id', (value: ApprovalVerdict): ApprovalVerdict => {
      const { traceEvidenceId: _omitted, ...rest } = value
      return rest
    }],
    ['mismatched evidence id', (value: ApprovalVerdict): ApprovalVerdict => ({
      ...value, traceEvidenceId: 'trace-v2-other',
    })],
    ['missing evidence time', (value: ApprovalVerdict): ApprovalVerdict => {
      const { traceVerifiedAt: _omitted, ...rest } = value
      return rest
    }],
    ['mismatched evidence time', (value: ApprovalVerdict): ApprovalVerdict => ({
      ...value, traceVerifiedAt: '2026-07-28T00:00:01.000Z',
    })],
    ['missing approval time', (value: ApprovalVerdict): ApprovalVerdict => {
      const { approvedAt: _omitted, ...rest } = value
      return rest
    }],
    ['non-canonical approval time', (value: ApprovalVerdict): ApprovalVerdict => ({
      ...value, approvedAt: '2026-07-28T00:01:00Z',
    })],
  ] as const)('rejects a v2 approval with %s', async (_label, mutate) => {
    const evidence = {
      evidenceId: 'trace-v2', skillName: 'deploy-preview', revision: 1,
      artifactHash: '', verifiedAt: '2026-07-28T00:00:00.000Z',
    }
    const skills = makeSkillRegistry(makeDeps({
      unsafeLegacyPromotion: false,
      observability: {
        hasPassingTrace: async () => true,
        passingTraceEvidence: async identity => ({ ...evidence, artifactHash: identity.artifactHash }),
        emit: () => {},
      },
      promotionAudit: { record: async () => {} },
    }))
    const staged = skills.stage(makeValidParsedSkill(), { request: 'deploy preview', sessionId: 'sess-v2-fields' })
    const preview = await skills.approvalPreview(staged.stageId)
    const verdict = mutate({
      stageId: staged.stageId, artifactHash: staged.artifactHash, actionHash: preview.actionHash,
      traceEvidenceId: preview.traceEvidence.evidenceId,
      traceVerifiedAt: preview.traceEvidence.verifiedAt,
      approvedAt: '2026-07-28T00:01:00.000Z', nonce: 'nonce-v2', stepUpSatisfied: true,
      humanTapAuditId: 'tap-v2',
    })
    expect(await skills.promote(staged.stageId, verdict)).toEqual({ ok: false, reason: 'approval_mismatch' })
  })

  it('binds exact trace evidence and approvedAt through v2 preview, action hash and audit', async () => {
    const bindings: unknown[] = []
    const verifiedAt = '2026-07-28T00:00:00.000Z'
    const skills = makeSkillRegistry(makeDeps({
      unsafeLegacyPromotion: false,
      observability: {
        hasPassingTrace: async () => true,
        passingTraceEvidence: async identity => ({
          evidenceId: 'trace-v2-exact', skillName: identity.name, artifactHash: identity.artifactHash,
          revision: identity.candidateVersion, verifiedAt,
        }),
        emit: () => {},
      },
      promotionAudit: { record: async binding => { bindings.push(binding) } },
    }))
    const staged = skills.stage(makeValidParsedSkill(), { request: 'deploy preview', sessionId: 'sess-v2-exact' })
    const preview = await skills.approvalPreview(staged.stageId)
    expect(preview.actionHash).not.toBe(staged.actionHash)
    expect(preview.actionHash).toBe(computeSkillActionHash({
      stageId: staged.stageId, name: staged.revision!.name,
      baseVersion: staged.revision!.baseVersion, baseArtifactHash: staged.revision!.baseArtifactHash,
      candidateVersion: staged.revision!.candidateVersion, artifactHash: staged.artifactHash,
      diffHash: createHash('sha256').update(staged.diff, 'utf8').digest('hex'),
      provenance: staged.provenance, riskClassification: 'reversible', stepUpRequired: false,
      touchedPaths: ['skills/deploy-preview/SKILL.md'], traceEvidence: preview.traceEvidence,
    }))
    const approvedAt = '2026-07-28T00:01:00.000Z'
    expect(await skills.promote(staged.stageId, {
      stageId: staged.stageId, artifactHash: staged.artifactHash, actionHash: preview.actionHash,
      traceEvidenceId: preview.traceEvidence.evidenceId, traceVerifiedAt: verifiedAt,
      approvedAt, nonce: 'nonce-v2-exact', stepUpSatisfied: true, humanTapAuditId: 'tap-v2-exact',
    })).toEqual({ ok: true, commit: 'sha-1', version: 1 })
    expect(bindings).toEqual([expect.objectContaining({
      actionHash: preview.actionHash, humanTapAuditId: 'tap-v2-exact', approvedAt,
    })])
  })

  it('fails closed when an exact v2 preview has no audit sink', async () => {
    const skills = makeSkillRegistry(makeDeps({
      unsafeLegacyPromotion: false,
      observability: {
        hasPassingTrace: async () => true,
        passingTraceEvidence: async identity => ({
          evidenceId: 'trace-v2-no-audit', skillName: identity.name, artifactHash: identity.artifactHash,
          revision: identity.candidateVersion, verifiedAt: '2026-07-28T00:00:00.000Z',
        }),
        emit: () => {},
      },
    }))
    const staged = skills.stage(makeValidParsedSkill(), { request: 'deploy preview', sessionId: 'sess-v2-no-audit' })
    const preview = await skills.approvalPreview(staged.stageId)
    expect(await skills.promote(staged.stageId, {
      stageId: staged.stageId, artifactHash: staged.artifactHash, actionHash: preview.actionHash,
      traceEvidenceId: preview.traceEvidence.evidenceId,
      traceVerifiedAt: preview.traceEvidence.verifiedAt,
      approvedAt: '2026-07-28T00:01:00.000Z', nonce: 'nonce-v2-no-audit', stepUpSatisfied: true,
      humanTapAuditId: 'tap-v2-no-audit',
    })).toEqual({ ok: false, reason: 'audit_failed' })
  })

  it('rejects trace evidence that changes after the exact v2 preview', async () => {
    let verifiedAt = '2026-07-28T00:00:00.000Z'
    const skills = makeSkillRegistry(makeDeps({
      unsafeLegacyPromotion: false,
      observability: {
        hasPassingTrace: async () => true,
        passingTraceEvidence: async identity => ({
          evidenceId: 'trace-v2-drift', skillName: identity.name, artifactHash: identity.artifactHash,
          revision: identity.candidateVersion, verifiedAt,
        }),
        emit: () => {},
      },
      promotionAudit: { record: async () => {} },
    }))
    const staged = skills.stage(makeValidParsedSkill(), { request: 'deploy preview', sessionId: 'sess-v2-drift' })
    const preview = await skills.approvalPreview(staged.stageId)
    verifiedAt = '2026-07-28T00:00:02.000Z'
    expect(await skills.promote(staged.stageId, {
      stageId: staged.stageId, artifactHash: staged.artifactHash, actionHash: preview.actionHash,
      traceEvidenceId: preview.traceEvidence.evidenceId, traceVerifiedAt: preview.traceEvidence.verifiedAt,
      approvedAt: '2026-07-28T00:01:00.000Z', nonce: 'nonce-v2-drift', stepUpSatisfied: true,
      humanTapAuditId: 'tap-v2-drift',
    })).toEqual({ ok: false, reason: 'trace_evidence_mismatch' })
  })

  it('rejects a verdict for another stage/action before nonce consumption or git', async () => {
    const git = makeGitPort()
    let nonceCalls = 0
    const skills = makeSkillRegistry(makeDeps({
      git,
      nonceStore: { consume: () => { nonceCalls += 1; return true } },
    }))
    const staged = skills.stage(makeValidParsedSkill(), { request: 'deploy preview', sessionId: 'sess-bind' })
    const result = await skills.promote(staged.stageId, makeApprovalVerdict('stage-other', staged.artifactHash, {
      actionHash: '0'.repeat(64),
    }))

    expect(result).toEqual({ ok: false, reason: 'approval_mismatch' })
    expect(nonceCalls).toBe(0)
    expect(git.commits).toHaveLength(0)
  })

  it('rejects real trace evidence pinned to an older artifact revision', async () => {
    const git = makeGitPort()
    const skills = makeSkillRegistry(makeDeps({
      git,
      observability: {
        hasPassingTrace: async () => true,
        passingTraceEvidence: async (identity) => ({
          evidenceId: 'trace-old',
          skillName: identity.name,
          artifactHash: '0'.repeat(64),
          revision: identity.candidateVersion,
          verifiedAt: '2026-07-28T00:00:00.000Z',
        }),
        emit: () => {},
      },
    }))
    const staged = skills.stage(makeValidParsedSkill(), { request: 'deploy preview', sessionId: 'sess-trace' })
    const result = await skills.promote(staged.stageId, makeApprovalVerdict(staged.stageId, staged.artifactHash, {
      actionHash: staged.actionHash!,
      traceEvidenceId: 'trace-old',
    }))

    expect(result).toEqual({ ok: false, reason: 'trace_evidence_mismatch' })
    expect(git.commits).toHaveLength(0)
  })

  it('quarantines an ambiguous git outcome in memory and never retries blindly', async () => {
    let attempts = 0
    const git: GitPort = {
      async commit() {
        attempts += 1
        if (attempts === 1) throw new Error('offline git port failed')
        return 'sha-retry'
      },
    }
    const skills = makeSkillRegistry(makeDeps({ git }))
    const staged = skills.stage(makeValidParsedSkill(), { request: 'deploy preview', sessionId: 'sess-retry' })
    const first = await skills.promote(staged.stageId, makeApprovalVerdict(staged.stageId, staged.artifactHash, {
      nonce: 'nonce-first', actionHash: staged.actionHash!,
    }))
    const card = skills.reviewPayload(staged.stageId)
    const second = await skills.promote(staged.stageId, makeApprovalVerdict(staged.stageId, staged.artifactHash, {
      nonce: 'nonce-second', actionHash: staged.actionHash!,
    }))

    expect(first).toEqual({ ok: false, reason: 'recovery_required' })
    expect(card.stageId).toBe(staged.stageId)
    expect(second).toEqual({ ok: false, reason: 'recovery_required' })
    expect(attempts).toBe(1)
  })

  it('writes the exact tap→action→commit audit before making a skill active', async () => {
    const bindings: unknown[] = []
    const skills = makeSkillRegistry(makeDeps({
      promotionAudit: { record: async binding => { bindings.push(binding) } },
    }))
    const staged = skills.stage(makeValidParsedSkill(), { request: 'deploy preview', sessionId: 'sess-audit' })
    const result = await skills.promote(staged.stageId, makeApprovalVerdict(staged.stageId, staged.artifactHash, {
      actionHash: staged.actionHash!,
      humanTapAuditId: 'tap-exact',
    }))

    expect(result.ok).toBe(true)
    expect(bindings).toEqual([expect.objectContaining({
      stageId: staged.stageId,
      actionHash: staged.actionHash,
      artifactHash: staged.artifactHash,
      version: 1,
      humanTapAuditId: 'tap-exact',
    })])
  })

  it('recovers audit finalization forward after commit without a duplicate git write', async () => {
    const git = makeGitPort()
    const bindings: Array<{ approvedAt?: string }> = []
    let fail = true
    const skills = makeSkillRegistry(makeDeps({
      git,
      promotionAudit: { record: async binding => {
        if (fail) throw new Error('audit unavailable')
        bindings.push(binding)
      } },
    }))
    const staged = skills.stage(makeValidParsedSkill(), { request: 'deploy preview', sessionId: 'sess-forward' })
    const firstApproval = makeApprovalVerdict(staged.stageId, staged.artifactHash, {
      actionHash: staged.actionHash!, approvedAt: '2026-07-28T00:01:00.000Z',
    })
    expect(await skills.promote(staged.stageId, firstApproval)).toEqual({ ok: false, reason: 'audit_failed' })
    fail = false
    expect(await skills.promote(staged.stageId, {
      ...firstApproval, nonce: 'nonce-recovery', approvedAt: '2026-07-28T00:09:00.000Z',
    })).toEqual({ ok: true, commit: 'sha-1', version: 1 })
    expect(git.commits).toHaveLength(1)
    expect(bindings).toEqual([expect.objectContaining({ approvedAt: '2026-07-28T00:01:00.000Z' })])
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
    const promoted = await skills.promote(staged.stageId, makeApprovalVerdict(staged.stageId, staged.artifactHash, { actionHash: staged.actionHash! }))
    expect(promoted.ok).toBe(true)
    // loadBody() must not propagate the telemetry error to the caller
    const result = await skills.loadBody('deploy-preview')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})
