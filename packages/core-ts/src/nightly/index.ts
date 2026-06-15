import { createHash } from 'node:crypto'

export type {
  ConsolidationRunner,
  ConsolidationDeps,
  NightlyConfig,
  LintPassResult,
  MorningCard,
  NightResult,
  Stage,
  MemOp,
  FactKey,
  Fact,
  Diff,
  QuarantinedDiff,
  Generator,
  Judge,
  JudgeVerdict,
  Validators,
  ValidatorId,
  ValidatorResult,
  StagedPatch,
  StagingArea,
  SkillDraft,
  RunLock,
  LockToken,
  NormalizedDayLog,
  NormalizedDayLogRecord,
  LintFinding,
  LintOrphan,
  LintStaleAnnotation,
  LintBrokenEdge,
  MorningCardItem,
  ResurrectionBlocked,
  HygieneReport,
  BackupStatus,
  VerificationMiss,
  CommitJournalEntry,
  CommitJournalState,
  SessionRecord,
  ArchiveStore,
  GitBackup,
  Hygiene,
  TraceProbe,
  EnvContext,
  LintInputs,
  CommitJournal,
} from './types.js'

import type {
  ConsolidationRunner,
  ConsolidationDeps,
  NightlyConfig,
  NightResult,
  MorningCard,
  MorningCardItem,
  ResurrectionBlocked,
  StagedPatch,
  StagingArea,
  LintPassResult,
  Stage,
  MemOp,
  FactKey,
  Fact,
  Diff,
  QuarantinedDiff,
  SkillDraft,
  NormalizedDayLog,
  NormalizedDayLogRecord,
  VerificationMiss,
  BackupStatus,
  HygieneReport,
} from './types.js'

// ---------------------------------------------------------------------------
// Determinism helpers (node:crypto; §3, ADR-0017/0029)
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Equivalence-class key as a stable string — paraphrase-safe (ADR-0030). */
function factKeyId(k: FactKey): string {
  return `${k.entity}‖${k.relation}‖${k.object}`
}

/** Trust/permanence fields the model output may never carry (CSO-C3, ADR-0029). */
const TRUST_FIELDS = ['is_human_confirmed', 'isHumanConfirmed', 'human_confirmed', 'permanence', 'trusted']

/** Strip every trust field; nightly never sets is_human_confirmed (AC-10-8/9). */
function stripTrustFields(op: MemOp): MemOp {
  const stripped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(op as Record<string, unknown>)) {
    if (TRUST_FIELDS.includes(key)) continue
    stripped[key] = value
  }
  return stripped as unknown as MemOp
}

function opFactKey(op: MemOp): FactKey | null {
  if (op.kind === 'ADD' || op.kind === 'UPDATE') return op.factKey
  return null
}

// ---------------------------------------------------------------------------
// In-memory staging area — the only write target during the night (§5, AC-10-14)
// ---------------------------------------------------------------------------

interface InternalStaged extends StagedPatch {
  /** The original op, retained for the promotion-path resurrection-guard re-run. */
  op?: MemOp
}

class NightlyError extends Error {}

// ---------------------------------------------------------------------------
// makeConsolidationRunner — deterministic orchestration (§5). The model appears
// only as the generator (drafts) and the blind judge (grades a quarantined diff);
// every irreversible step is code-gated, preconditioned, snapshot-reversible.
// ---------------------------------------------------------------------------

export function makeConsolidationRunner(deps: ConsolidationDeps): ConsolidationRunner {
  // Staging persists across run()/promote within one runner instance (the
  // hold-default: nothing is promoted until a human taps Approve — §8, AC-10-28).
  const memoryPatches: InternalStaged[] = []
  const skillPatches: InternalStaged[] = []
  const lintPatches: InternalStaged[] = []

  const emit = (event: string): void => deps.emit?.(event)

  // --- resurrection-guard invocation (logic owned by Memory 03; ADR-0030) ---
  // FactKey equivalence-class match catches paraphrases, not surface text
  // (AC-10-12). guardAvailable=false fails closed (AC-10-22).
  const tombstoneIds = (): Set<string> => new Set((deps.tombstones ?? []).map(factKeyId))

  const guardBlocks = (op: MemOp): boolean => {
    deps.onGuardCheck?.()
    const key = opFactKey(op)
    if (key === null) return false
    return tombstoneIds().has(factKeyId(key))
  }

  // --- the deterministic forget filter at ingestion (Stage 1; AC-10-2) ---
  const normalizedLog = (): NormalizedDayLog => {
    const raw = deps.rawDayLog ?? { date: '2026-06-11', records: [] }
    const isForgotten = deps.isForgotten
    if (!isForgotten) return raw
    return { date: raw.date, records: raw.records.filter((r) => !isForgotten(r)) }
  }

  // --- the live fact set: only invalid_at IS NULL reaches the generator (AC-10-3) ---
  const liveFacts = (): Fact[] => (deps.facts ?? []).filter((f) => f.invalidAt === null)

  // --- quarantine the diff before the judge ever reads it (CSO-M5; AC-10-7) ---
  const quarantine = (diff: Diff): QuarantinedDiff => ({
    quarantined: true,
    body: JSON.stringify(diff.added.concat(diff.updated).map(stripTrustFields)),
    diff,
  })

  const stageMemoryPatch = (op: MemOp, judged: boolean): void => {
    const body = JSON.stringify(stripTrustFields(op))
    const id = sha256(`memory:${body}:${memoryPatches.length}`)
    deps.stagingWrite?.(`staging/memory/${id}.patch`)
    memoryPatches.push({ id, kind: 'memory', body, hashAtAccept: sha256(body), judged, op })
  }

  const stageSkillPatch = (skill: SkillDraft): void => {
    const body = JSON.stringify(skill)
    const id = sha256(`skill:${body}:${skillPatches.length}`)
    deps.stagingWrite?.(`staging/skills/${id}`)
    skillPatches.push({ id, kind: 'skill', body, hashAtAccept: sha256(body), judged: true })
  }

  // --- Stage 1: content-addressed session archival (AC-10-1) ---
  const runArchival = (config: NightlyConfig, card: MorningCard): void => {
    const archive = deps.archive
    if (!archive) return
    const date = card.runDate
    for (const session of archive.sessions()) {
      const contentHash = sha256(session.transcript).slice(0, 16)
      const path = `${config.archiveDir}sessions/${date}/${contentHash}.md`
      // Content-addressed idempotency: a re-run never double-writes (AC-10-1).
      if (archive.has(path)) continue
      archive.write(path, session.transcript)
      archivedThisRun = true
      // Trace-based self-verification (AC-10-26, ADR-0017): probe the claim.
      if (deps.traceProbe && !deps.traceProbe.fileExists(path)) {
        card.verificationMisses.push({
          stage: 'archival',
          claimedEffect: `archive ${path}`,
          traceFailure: 'file absent at content-addressed path',
        })
      }
    }
  }

  // --- Stage 2: memory consolidation (generator→validators→guard→judge) ---
  const runConsolidation = async (log: NormalizedDayLog, card: MorningCard): Promise<void> => {
    let proposal: { ops: MemOp[]; diff: Diff }
    try {
      proposal = await deps.generator.proposeMemoryOps(log, liveFacts())
    } catch {
      // Provider/generator unavailable: skip stage 2 (degrade; §7).
      return
    }

    for (const rawOp of proposal.ops) {
      // STRIP is_human_confirmed from every op before anything else (CSO-C3).
      const op = stripTrustFields(rawOp)

      // Validators run BEFORE the judge; a failure drops the candidate (AC-10-4/5).
      const verdict = deps.validators.check(op)
      if (!verdict.ok) continue

      // Resurrection-guard runs BEFORE the judge; a match is blocked to the
      // "Tried to resurrect" card section, never passed to the judge (AC-10-10/12).
      if (guardBlocks(op)) {
        card.triedToResurrect.push({ op, reason: 'tombstone' })
        emit('night.resurrection.blocked')
        continue
      }

      // Judge reads ONLY the quarantined diff for this op (AC-10-6/7). A judge
      // that errors/times out is unavailable: hold the candidate unjudged in
      // staging, never auto-accept (AC-10-21; §7 fail-safe degrade).
      let verdictJudge: 'accept' | 'reject' | 'edit'
      try {
        verdictJudge = await deps.judge.grade(quarantine({ added: [op], removed: [], updated: [] }))
      } catch {
        stageMemoryPatch(op, false)
        continue
      }
      if (verdictJudge === 'accept') {
        emit('night.judge.accepted')
        stageMemoryPatch(op, true)
        card.memoryEdits.push(stagedItem(memoryPatches[memoryPatches.length - 1]!, summarizeOp(op)))
      }
    }
  }

  // --- Stage 2b: lint pass (generator-assisted; graceful degradation) ---
  const runLintPassInternal = async (): Promise<LintPassResult> => {
    const inputs = deps.lintInputs ?? { orphans: [], staleAnnotations: [], brokenEdges: [] }
    // Generator unavailability degrades the whole pass (AC-10-31).
    try {
      await deps.generator.draftSkills(normalizedLog())
    } catch {
      return {
        orphans: [],
        staleAnnotations: [],
        brokenEdges: [],
        skipped: true,
        skipReason: 'lint pass skipped: generator unavailable',
      }
    }
    // Remediation proposals are staged, never auto-promoted (AC-10-29).
    for (const orphan of inputs.orphans) {
      const body = JSON.stringify(orphan)
      const id = sha256(`lint-orphan:${body}:${lintPatches.length}`)
      deps.stagingWrite?.(`staging/lint/orphans/${id}`)
      lintPatches.push({ id, kind: 'lint-orphan', body, hashAtAccept: sha256(body), judged: false })
    }
    for (const stale of inputs.staleAnnotations) {
      const body = JSON.stringify(stale)
      const id = sha256(`lint-stale:${body}:${lintPatches.length}`)
      deps.stagingWrite?.(`staging/lint/stale/${id}`)
      lintPatches.push({ id, kind: 'lint-stale', body, hashAtAccept: sha256(body), judged: false })
    }
    for (const edge of inputs.brokenEdges) {
      const body = JSON.stringify(edge)
      const id = sha256(`lint-edge:${body}:${lintPatches.length}`)
      deps.stagingWrite?.(`staging/lint/broken-edges/${id}`)
      lintPatches.push({ id, kind: 'lint-broken-edge', body, hashAtAccept: sha256(body), judged: false })
    }
    // Broken edges are listed, never silently deleted (AC-10-30). No onDelete call.
    return {
      orphans: inputs.orphans,
      staleAnnotations: inputs.staleAnnotations,
      brokenEdges: inputs.brokenEdges,
      skipped: false,
    }
  }

  // --- Stage 3: skill hygiene (same generator→validators→judge discipline) ---
  const runSkillHygiene = async (log: NormalizedDayLog, card: MorningCard): Promise<void> => {
    let drafts: SkillDraft[]
    try {
      drafts = await deps.generator.draftSkills(log)
    } catch {
      return // generator down — degrade (§7)
    }
    for (const skill of drafts) {
      // Transient-origin skills are flagged for retirement, never auto-promoted
      // (ADR-0025; AC-10-23). This is advisory only — an informational card line
      // with no promotion path — so it carries no staged patch (omitting the
      // wrong sha256(skill.id) hash that made it un-approvable anyway).
      if (skill.provenance === 'transient') {
        card.skillChanges.push({
          summary: `flagged for retirement (transient provenance): ${skill.name}`,
        })
      }
      // has_check_section fails deterministically BEFORE the judge (AC-10-23).
      const verdict = deps.validators.check(skill)
      if (!verdict.ok) continue
      const verdictJudge = await deps.judge.grade({
        quarantined: true,
        body: JSON.stringify(skill),
        diff: { added: [], removed: [], updated: [] },
      })
      if (verdictJudge === 'accept') {
        stageSkillPatch(skill)
        card.skillChanges.push(stagedItem(skillPatches[skillPatches.length - 1]!, `skill: ${skill.name}`))
      }
    }
  }

  // Tracks whether crash-recovery already re-ran the prior crashed commit this
  // run. This is NOT a substitute for backing up NEW archival/hygiene work the
  // current run produces — those still need their own Stage-5 push (Eng-7).
  let recoveryPushedThisRun = false
  let hygieneRan = false
  let archivedThisRun = false

  // --- Stage 4: DB/disk hygiene (under Safety carve-out; AC-10-24) ---
  const runDiskHygiene = (card: MorningCard): void => {
    const h = deps.hygiene
    if (!h) return
    hygieneRan = true
    // Pre-VACUUM DB snapshot FIRST — reversibility before any destructive op.
    h.snapshot()
    const integrityOk = h.integrityCheck()
    const report: HygieneReport = {
      vacuumed: false,
      walCheckpointed: false,
      logRotated: false,
      dockerPruned: false,
      worktreePruned: false,
      dbIntegrityOk: integrityOk,
    }
    if (integrityOk) {
      h.vacuum(); report.vacuumed = true
      h.optimizeFts()
      h.walCheckpoint(); report.walCheckpointed = true
      h.rotateLogs(); report.logRotated = true
      h.dockerPrune(); report.dockerPruned = true
    }
    card.hygieneReport = report
  }

  // --- Stage 5: git-push backup (fast-forward only; never --force; AC-10-25) ---
  const runBackup = async (card: MorningCard): Promise<void> => {
    const git = deps.git
    if (!git) return
    // Only back up when the night produced durable repo work (archive/hygiene);
    // staged-but-unpromoted proposals are pushed by the promotion path, not here.
    // A recovery-only run (resumed a prior commit, produced no new durable work)
    // already pushed in recoverFromJournal — skip a pointless empty push (Eng-7).
    if (recoveryPushedThisRun && !archivedThisRun && !hygieneRan) return
    if (!archivedThisRun && !hygieneRan) return
    let attempt = 0
    let last: { ok: true; commitHash: string } | { ok: false; failureReason: string } | null = null
    // Retry on failure; non-fatal; always reported (§7). Never pass force.
    while (attempt < 2) {
      attempt++
      last = await git.commitAndPush()
      if (last.ok) break
    }
    if (last && last.ok) {
      card.backupStatus = { pushed: true, commitHash: last.commitHash, retried: attempt > 1 }
      emit('night.backup.pushed')
      // Read-back verification (AC-10-32): probe the remote ref advanced.
      if (deps.traceProbe && !deps.traceProbe.refAdvanced(last.commitHash)) {
        card.verificationMisses.push({
          stage: 'backup',
          claimedEffect: `push ${last.commitHash}`,
          traceFailure: 'remote ref did not advance',
        })
      }
    } else {
      card.backupStatus = {
        pushed: false,
        failureReason: last ? last.failureReason : 'unknown',
        retried: attempt > 1,
      }
      emit('night.backup.failed')
    }
  }

  // --- crash-recovery: resume an interrupted commit at the right step (Eng-7) ---
  const recoverFromJournal = async (card: MorningCard): Promise<void> => {
    const journal = deps.journal
    if (!journal) return
    for (const entry of journal.entries) {
      if (entry.state === 'reindexed' && entry.gitCommitHash === undefined) {
        // Crash after the memory txn, before git push: resume at git only,
        // do NOT re-run the txn; git commit/push is idempotent (AC-10-16).
        if (deps.git) {
          await deps.git.commitAndPush()
          recoveryPushedThisRun = true
        }
      } else if (entry.state === 'pending') {
        // Crash during the memory txn: SQLite rolled back. Re-attempt from the
        // start, re-passing the resurrection-guard (AC-10-17).
        if (guardBlocks(entry.op)) {
          card.triedToResurrect.push({ op: entry.op, reason: 'tombstone' })
          emit('night.resurrection.blocked')
        }
        // (A clean re-attempt would re-stage; the guard block stops here — no push.)
      }
    }
  }

  // ----- card / item helpers -----
  const summarizeOp = (op: MemOp): string =>
    op.kind === 'ADD' || op.kind === 'UPDATE' ? `${op.kind} ${factKeyId(op.factKey)}` : op.kind

  const stagedItem = (patch: StagedPatch, summary: string): MorningCardItem => ({
    patch: { id: patch.id, kind: patch.kind, body: patch.body, hashAtAccept: patch.hashAtAccept, judged: patch.judged },
    summary,
  })

  const emptyCard = (runDate: string): MorningCard => ({
    runDate,
    memoryEdits: [],
    triedToResurrect: [],
    skillChanges: [],
    lintReport: { orphans: [], staleAnnotations: [], brokenEdges: [], skipped: false },
    hygieneReport: {
      vacuumed: false,
      walCheckpointed: false,
      logRotated: false,
      dockerPruned: false,
      worktreePruned: false,
      dbIntegrityOk: true,
    },
    backupStatus: { pushed: false, retried: false },
    verificationMisses: [],
    cost: { generatorTokens: 0, judgeTokens: 0, lintPassTokens: 0, totalUsd: 0 },
  })

  return {
    async run(config: NightlyConfig): Promise<NightResult> {
      const runDate = deps.clock.now().toISOString().slice(0, 10)
      const card = emptyCard(runDate)

      // Least-privilege startup assertion — fail closed BEFORE any stage (AC-10-18).
      const env = deps.envContext
      if (env) {
        if (env.hasProdCreds) {
          throw new NightlyError('least-privilege violated: prod credentials present — fail-closed')
        }
        const beyondBackup = env.egressAllowlist.filter((h) => h !== config.backupRemote)
        if (beyondBackup.length > 0) {
          throw new NightlyError('least-privilege violated: egress exceeds backup remote — fail-closed')
        }
      }

      // Exclusive run lock — PID-reuse-safe (AC-10-19/20; CSO-H6).
      const acquired = deps.lock.acquire()
      if (!acquired.ok) {
        if (acquired.heldForMs > config.maxHeldMs) {
          // Held too long: alert, never blind-steal (AC-10-20).
          emit('night.lock.held_too_long')
          throw new NightlyError('night.lock.held_too_long: lock held past maxHeldMs; not auto-stolen')
        }
        // A live prior run holds it: abort, never run two nights concurrently (AC-10-19).
        emit('night.lock.contended')
        throw new NightlyError('night.lock.contended: prior run still alive — abort')
      }

      try {
        emit('night.started')
        // Crash recovery first: resume any interrupted commit idempotently (Eng-7).
        await recoverFromJournal(card)

        const log = normalizedLog()
        runArchival(config, card)                       // Stage 1
        await runConsolidation(log, card)               // Stage 2
        card.lintReport = await runLintPassInternal()   // Stage 2b
        await runSkillHygiene(log, card)                // Stage 3
        runDiskHygiene(card)                            // Stage 4
        await runBackup(card)                           // Stage 5

        emit('night.card.staged')
        const stagesCompleted: Stage[] = [
          'archival', 'consolidation', 'lint-pass', 'skill-hygiene', 'disk-hygiene', 'backup',
        ]
        return { runDate, stagesCompleted, card, lockToken: acquired.token }
      } finally {
        deps.lock.release(acquired.token)
      }
    },

    async runLintPass(): Promise<LintPassResult> {
      return runLintPassInternal()
    },

    async getStagedProposals(): Promise<StagingArea> {
      const strip = (p: InternalStaged): StagedPatch => ({
        id: p.id, kind: p.kind, body: p.body, hashAtAccept: p.hashAtAccept, judged: p.judged,
      })
      return {
        memoryPatches: memoryPatches.map(strip),
        skillPatches: skillPatches.map(strip),
        lintPatches: lintPatches.map(strip),
      }
    },

    // PROMOTION on the human Approve tap (via Safety 05). This component never
    // sets is_human_confirmed; it gates the commit deterministically (§5).
    async approveStagedItem(id: string): Promise<void> {
      const patch = [...memoryPatches, ...skillPatches, ...lintPatches].find((p) => p.id === id)
      if (!patch) throw new NightlyError(`no staged item ${id}`)

      // Judge gate is a safety control: an item that was never judged (e.g. judge
      // model unavailable → judged:false) must be held, never auto-accepted. Fail
      // closed before any commit/reindex (AC-10-21; §7 fail-safe degrade).
      if (!patch.judged) {
        throw new NightlyError('unjudged staged item — held; fail-closed (judge gate; no commit or reindex)')
      }

      // TOCTOU: the staged body must be byte-identical to the judge-accepted one
      // (hashAtPromote == hashAtAccept), else abort the item (AC-10-13).
      const currentBody = deps.currentBodyForPatch ? deps.currentBodyForPatch(patch.id, patch.body) : patch.body
      if (sha256(currentBody) !== patch.hashAtAccept) {
        throw new NightlyError('TOCTOU: hashAtPromote != hashAtAccept — item aborted to human review')
      }

      // Memory/resurrection-guard must be available — else fail closed (AC-10-22).
      if (deps.guardAvailable && !deps.guardAvailable()) {
        throw new NightlyError('resurrection-guard unavailable — fail-closed; no commit or reindex')
      }

      // Re-run the resurrection-guard on the promotion path, BEFORE reindex
      // (AC-10-11). A match blocks the item; nothing is reindexed or committed.
      if (patch.op && guardBlocks(patch.op)) {
        emit('night.resurrection.blocked')
        throw new NightlyError('resurrection-guard blocked at promotion — routed to human review')
      }

      // COMMIT ORDER (Eng-7): (1) atomic SQLite txn flips invalid_at + reindex,
      // (2) git commit/push only AFTER the txn durably commits (AC-10-15).
      const applyTxn = async (): Promise<void> => {
        deps.reindex?.(patch.id)
        deps.journal?.record({
          runDate: deps.clock.now().toISOString().slice(0, 10),
          stage: 'consolidation',
          op: patch.op ?? { kind: 'NOOP', factId: patch.id },
          factIds: [patch.id],
          snapshotRef: patch.hashAtAccept,
          reindexDone: true,
          state: 'reindexed',
        })
      }
      if (deps.memoryTxn) {
        await deps.memoryTxn(applyTxn)
      } else {
        await applyTxn()
      }
      if (deps.git) await deps.git.commitAndPush()
      emit('night.commit.applied')
    },
  }
}
