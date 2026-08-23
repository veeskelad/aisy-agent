import { createHash, randomUUID } from 'node:crypto'
import type { SkillActivationPort } from './active-skill-store.js'
import type {
  SkillPromotionStageRecord,
  SkillPromotionStore,
} from './skill-promotion-store.js'

export interface SkillPromotionCandidateInput {
  stageId: string
  name: string
  candidateVersion: number
  artifactHash: string
  artifactBase64: string
  triggerContext: { request: string; sessionId: string }
  traceEvidence: SkillPromotionStageRecord['traceEvidence']
}

export interface SkillPromotionApproval {
  stageId: string
  artifactHash: string
  actionHash: string
  traceEvidenceId: string
  nonce: string
  stepUpSatisfied: boolean
  humanTapAuditId: string
  approvedAt: string
}

export type SkillPromotionFailureReason =
  | 'no_pending_action'
  | 'approval_mismatch'
  | 'hash_mismatch'
  | 'replayed_nonce'
  | 'stepup_missing'
  | 'not_trace_verified'
  | 'trace_evidence_mismatch'
  | 'commit_failed'
  | 'audit_failed'
  | 'recovery_required'
  | 'quarantined'
  | 'revision_conflict'

export type SkillPromotionRuntimeResult =
  | { ok: true; commit: string; version: number; recovered?: true }
  | { ok: false; reason: SkillPromotionFailureReason }

export interface SkillPromotionGitPort {
  commit(input: {
    idempotencyKey: string
    message: string
    files: Record<string, string>
  }): Promise<string>
  inspect(idempotencyKey: string): Promise<
    | { status: 'absent' }
    | { status: 'committed'; commit: string }
    | { status: 'unknown' }
  >
}

export interface SkillPromotionNoncePort {
  consume(nonce: string, actionHash: string): boolean
}

export interface SkillPromotionTracePort {
  verify(input: {
    stageId: string
    name: string
    artifactHash: string
    revision: number
    evidenceId: string
  }): Promise<boolean>
}

export interface SkillPromotionRiskPort {
  classify(input: { name: string; artifactHash: string; artifactBytes: Uint8Array }):
    SkillPromotionStageRecord['riskProof'] | null
}

export interface SkillPromotionAuthorityPort {
  authorize(input: { name: string; artifactHash: string; artifactBytes: Uint8Array }):
    SkillPromotionStageRecord['authorityProof'] | null
}

export interface SkillPromotionRuntime {
  stage(input: SkillPromotionCandidateInput):
    | { ok: true; stage: SkillPromotionStageRecord }
    | { ok: false; reason: 'invalid_stage' | 'revision_conflict' }
  promote(stageId: string, approval: SkillPromotionApproval): Promise<SkillPromotionRuntimeResult>
  recover(): Promise<SkillPromotionRuntimeResult[]>
}

function exactIso(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function activationInput(record: SkillPromotionStageRecord) {
  return {
    operationId: record.actionHash,
    name: record.name,
    version: record.candidateVersion,
    sha256: record.artifactHash,
    trustSource: record.authorityProof.trustSource,
    touchedPaths: [...record.authorityProof.touchedPaths],
    skillText: Buffer.from(record.artifactBase64, 'base64').toString('utf8'),
    baseVersion: record.baseVersion,
    baseHash: record.baseArtifactHash,
  }
}

function computeDiff(base: string | null, candidate: string): string {
  const before = base === null ? [] : base.replace(/\r\n/g, '\n').split('\n')
  const after = candidate.replace(/\r\n/g, '\n').split('\n')
  return ['--- base', '+++ candidate', ...before.map(line => `-${line}`), ...after.map(line => `+${line}`)].join('\n')
}

function candidateMetadata(
  text: string,
  name: string,
  version: number,
): { provenance: SkillPromotionStageRecord['candidateProvenance'] } | null {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return null
  const closing = normalized.indexOf('\n---\n', 4)
  if (closing < 4) return null
  const lines = normalized.slice(4, closing).split('\n')
  const allowed = new Set(['name', 'description', 'version', 'provenance', 'triggers'])
  const keys: string[] = []
  const values = new Map<string, string>()
  const triggers: string[] = []
  let inTriggers = false
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const key = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (key) {
      if (!allowed.has(key[1]!)) return null
      keys.push(key[1]!)
      values.set(key[1]!, key[2]!.trim())
      inTriggers = key[1] === 'triggers'
      if (inTriggers && key[2]!.trim().length > 0) return null
      continue
    }
    const trigger = /^\s*-\s*(.*)$/.exec(line)
    if (!inTriggers || !trigger || trigger[1]!.trim().length === 0) return null
    triggers.push(trigger[1]!.trim())
  }
  if (new Set(keys).size !== allowed.size || keys.length !== allowed.size || triggers.length === 0) return null
  const description = values.get('description') ?? ''
  const provenance = values.get('provenance')
  if (values.get('name') !== name || Number(values.get('version')) !== version ||
    !Number.isInteger(version) || version < 1 || description.length === 0 || description.length > 60 ||
    !['human', 'agent-authored', 'imported'].includes(provenance ?? '') ||
    !/(^|\n)##\s+verification\b/i.test(normalized.slice(closing + 5))) {
    return null
  }
  return { provenance: provenance as SkillPromotionStageRecord['candidateProvenance'] }
}

export function makeSkillPromotionRuntime(deps: {
  store: SkillPromotionStore
  git: SkillPromotionGitPort
  nonces: SkillPromotionNoncePort
  trace: SkillPromotionTracePort
  risk: SkillPromotionRiskPort
  authority: SkillPromotionAuthorityPort
  activation: SkillActivationPort
  claimId?: () => string
  nowIso?: () => string
}): SkillPromotionRuntime {
  const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
  const safeCommit = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/
  const claimId = deps.claimId ?? (() => `claim-${randomUUID()}`)
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())

  const find = (stageId: string): SkillPromotionStageRecord | undefined =>
    deps.store.snapshot().stages.find(stage => stage.stageId === stageId)

  const quarantineAndReleaseReservation = (
    record: SkillPromotionStageRecord,
    reason: string,
  ): SkillPromotionRuntimeResult => {
    let released = false
    try { released = deps.activation.rollback(record.actionHash) } catch { released = false }
    if (!released) return { ok: false, reason: 'recovery_required' }
    try {
      return deps.store.quarantine(record.stageId, reason)
        ? { ok: false, reason: 'quarantined' }
        : { ok: false, reason: 'recovery_required' }
    } catch {
      return { ok: false, reason: 'recovery_required' }
    }
  }

  const finalize = (record: SkillPromotionStageRecord, claim: NonNullable<SkillPromotionStageRecord['claim']>): SkillPromotionRuntimeResult => {
    const receipt = record.externalCommit
    if (!receipt) return { ok: false, reason: 'recovery_required' }
    try {
      deps.activation.activate(activationInput(record))
    } catch {
      return { ok: false, reason: 'recovery_required' }
    }
    try {
      if (!deps.store.markPromoted(record.stageId, claim.claimId, receipt.commit)) return { ok: false, reason: 'audit_failed' }
    } catch {
      return { ok: false, reason: 'audit_failed' }
    }
    return { ok: true, commit: receipt.commit, version: record.candidateVersion }
  }

  const recoverOne = async (record: SkillPromotionStageRecord): Promise<SkillPromotionRuntimeResult> => {
    if (record.state !== 'committing' || !record.claim) return { ok: false, reason: 'no_pending_action' }
    if (record.externalCommit) {
      const result = finalize(record, record.claim)
      return result.ok ? { ...result, recovered: true } : result
    }
    let external: Awaited<ReturnType<SkillPromotionGitPort['inspect']>>
    try { external = await deps.git.inspect(record.actionHash) } catch {
      return { ok: false, reason: 'recovery_required' }
    }
    if (external.status === 'unknown') {
      return quarantineAndReleaseReservation(record, 'ambiguous-external-commit')
    }
    if (external.status === 'absent') {
      try {
        if (!deps.activation.rollback(record.actionHash)) return { ok: false, reason: 'recovery_required' }
        return deps.store.release(record.stageId, record.claim.claimId)
          ? { ok: false, reason: 'commit_failed' } : { ok: false, reason: 'recovery_required' }
      } catch {
        return { ok: false, reason: 'recovery_required' }
      }
    }
    if (!safeCommit.test(external.commit)) {
      return quarantineAndReleaseReservation(record, 'invalid-external-commit')
    }
    const receipt = { idempotencyKey: record.actionHash, commit: external.commit, recordedAt: nowIso() }
    try {
      if (!deps.store.recordExternalCommit(record.stageId, record.claim.claimId, receipt)) {
        return { ok: false, reason: 'recovery_required' }
      }
    } catch { return { ok: false, reason: 'recovery_required' } }
    const committed = find(record.stageId)
    if (!committed?.claim || !committed.externalCommit) return { ok: false, reason: 'recovery_required' }
    const result = finalize(committed, committed.claim)
    return result.ok ? { ...result, recovered: true } : result
  }

  return Object.freeze<SkillPromotionRuntime>({
    stage(input) {
      const decoded = Buffer.from(input.artifactBase64, 'base64')
      const text = decoded.toString('utf8')
      const metadata = candidateMetadata(text, input.name, input.candidateVersion)
      if (decoded.toString('base64') !== input.artifactBase64 ||
        createHash('sha256').update(decoded).digest('hex') !== input.artifactHash ||
        !metadata ||
        input.traceEvidence.skillName !== input.name ||
        input.traceEvidence.artifactHash !== input.artifactHash ||
        input.traceEvidence.revision !== input.candidateVersion || !exactIso(input.traceEvidence.verifiedAt)) {
        return { ok: false, reason: 'invalid_stage' }
      }
      let current: ReturnType<SkillActivationPort['current']>
      try { current = deps.activation.current(input.name) } catch {
        return { ok: false, reason: 'revision_conflict' }
      }
      if (input.candidateVersion !== (current?.version ?? 0) + 1) return { ok: false, reason: 'revision_conflict' }
      let riskProof: SkillPromotionStageRecord['riskProof'] | null = null
      let authorityProof: SkillPromotionStageRecord['authorityProof'] | null = null
      try {
        riskProof = deps.risk.classify({ name: input.name, artifactHash: input.artifactHash, artifactBytes: decoded })
        authorityProof = deps.authority.authorize({ name: input.name, artifactHash: input.artifactHash, artifactBytes: decoded })
      } catch { return { ok: false, reason: 'invalid_stage' } }
      if (!riskProof || riskProof.artifactHash !== input.artifactHash || !authorityProof ||
        authorityProof.skillName !== input.name || authorityProof.artifactHash !== input.artifactHash) {
        return { ok: false, reason: 'invalid_stage' }
      }
      const computedDiff = computeDiff(current?.skillText ?? null, text)
      try {
        return { ok: true, stage: deps.store.putPending({
          ...input,
          baseVersion: current?.version ?? null,
          baseArtifactHash: current?.hash ?? null,
          candidateProvenance: metadata.provenance,
          computedDiff,
          computedDiffHash: createHash('sha256').update(computedDiff, 'utf8').digest('hex'),
          riskProof,
          authorityProof,
        }) }
      } catch {
        return { ok: false, reason: 'invalid_stage' }
      }
    },

    async promote(stageId, approval) {
      const record = find(stageId)
      if (!record) return { ok: false, reason: 'no_pending_action' }
      if (record.state === 'quarantined' || record.state === 'rolled_back') return { ok: false, reason: 'quarantined' }
      if (record.state === 'committing') return { ok: false, reason: 'recovery_required' }
      if (record.state !== 'pending') return { ok: false, reason: 'no_pending_action' }
      if (approval.stageId !== stageId || approval.actionHash !== record.actionHash) {
        return { ok: false, reason: 'approval_mismatch' }
      }
      if (approval.artifactHash !== record.artifactHash) return { ok: false, reason: 'hash_mismatch' }
      if (!record.traceEvidence.evidenceId) return { ok: false, reason: 'not_trace_verified' }
      if (approval.traceEvidenceId !== record.traceEvidence.evidenceId ||
        record.traceEvidence.artifactHash !== record.artifactHash ||
        record.traceEvidence.revision !== record.candidateVersion) {
        return { ok: false, reason: 'trace_evidence_mismatch' }
      }
      if (record.riskProof.classification === 'irreversible' && !approval.stepUpSatisfied) {
        return { ok: false, reason: 'stepup_missing' }
      }
      if (!exactIso(approval.approvedAt) || !safeId.test(approval.humanTapAuditId) || !safeId.test(approval.nonce)) {
        return { ok: false, reason: 'approval_mismatch' }
      }
      let traceVerified = false
      try {
        traceVerified = await deps.trace.verify({
          stageId, name: record.name, artifactHash: record.artifactHash,
          revision: record.candidateVersion, evidenceId: record.traceEvidence.evidenceId,
        })
      } catch { traceVerified = false }
      if (!traceVerified) return { ok: false, reason: 'not_trace_verified' }
      try {
        if (deps.activation.validate && !deps.activation.validate(activationInput(record))) {
          return deps.store.quarantine(stageId, 'invalid-active-artifact')
            ? { ok: false, reason: 'quarantined' }
            : { ok: false, reason: 'recovery_required' }
        }
      } catch {
        return { ok: false, reason: 'recovery_required' }
      }
      try {
        if (!deps.nonces.consume(approval.nonce, record.actionHash)) {
          return { ok: false, reason: 'replayed_nonce' }
        }
      } catch {
        return { ok: false, reason: 'replayed_nonce' }
      }
      const claim = {
        claimId: claimId(), actionHash: record.actionHash,
        humanTapAuditId: approval.humanTapAuditId, approvedAt: approval.approvedAt,
        stepUpSatisfied: approval.stepUpSatisfied,
      }
      try {
        if (!deps.store.claim(stageId, claim)) return { ok: false, reason: 'no_pending_action' }
      } catch {
        return { ok: false, reason: 'recovery_required' }
      }
      const committing = find(stageId)
      if (!committing?.claim) return { ok: false, reason: 'recovery_required' }
      let prepared: ReturnType<SkillActivationPort['prepare']>
      try { prepared = deps.activation.prepare(activationInput(committing)) } catch {
        return { ok: false, reason: 'recovery_required' }
      }
      if (prepared === 'revision_conflict') {
        try { deps.store.quarantine(stageId, 'revision-conflict') } catch { return { ok: false, reason: 'recovery_required' } }
        return { ok: false, reason: 'revision_conflict' }
      }

      let commit: string
      try {
        commit = await deps.git.commit({
          idempotencyKey: record.actionHash,
          message: `skill: promote ${record.name} v${record.candidateVersion} (tap ${approval.humanTapAuditId})`,
          files: { [`skills/${record.name}/SKILL.md`]: Buffer.from(record.artifactBase64, 'base64').toString('utf8') },
        })
      } catch {
        return recoverOne(committing)
      }
      if (!safeCommit.test(commit)) {
        return quarantineAndReleaseReservation(committing, 'invalid-external-commit')
      }
      const receipt = { idempotencyKey: record.actionHash, commit, recordedAt: nowIso() }
      try {
        if (!deps.store.recordExternalCommit(stageId, committing.claim.claimId, receipt)) {
          return { ok: false, reason: 'recovery_required' }
        }
      } catch { return { ok: false, reason: 'recovery_required' } }
      const committed = find(stageId)
      if (!committed?.claim || !committed.externalCommit) return { ok: false, reason: 'recovery_required' }
      return finalize(committed, committed.claim)
    },

    async recover() {
      const committing = deps.store.snapshot().stages.filter(stage => stage.state === 'committing')
      const results: SkillPromotionRuntimeResult[] = []
      for (const record of committing) results.push(await recoverOne(record))
      return results
    },
  })
}
