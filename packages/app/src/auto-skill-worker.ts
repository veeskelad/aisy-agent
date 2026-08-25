import {
  buildAutoSkillManifest,
  parseSkillRecipeDraft,
  renderAutoSkillDocument,
  sameAutoSkillModelIdentity,
  shadowVerifyAutoSkill,
  validateSkillRecipeDraft,
  type AutoSkillDescriptorRegistry,
  type SkillRecipeGeneratorPort,
  type SkillRecipeJudgePort,
} from '@aisy/core'

import type { NodeAutoSkillStoreV2 } from './auto-skill-store.js'

export type AutoSkillWorkerResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'deferred'; readonly jobId: string }
  | { readonly kind: 'quarantined'; readonly jobId: string; readonly reason: string }
  | { readonly kind: 'activated'; readonly jobId: string; readonly revisionHash: string }

export function makeAutoSkillWorker(input: {
  store: NodeAutoSkillStoreV2
  registry: AutoSkillDescriptorRegistry
  generator: SkillRecipeGeneratorPort
  judge: SkillRecipeJudgePort
}): { drainOne(): Promise<AutoSkillWorkerResult> } {
  const quarantine = (jobId: string, reason: string): AutoSkillWorkerResult => {
    input.store.quarantine(jobId, reason)
    return { kind: 'quarantined', jobId, reason }
  }

  return Object.freeze({
    async drainOne(): Promise<AutoSkillWorkerResult> {
      let job = input.store.nextWork()
      if (job === null) return { kind: 'idle' }
      const evidence = input.store.evidenceFor(job.jobId)

      if (sameAutoSkillModelIdentity(input.generator.identity, input.judge.identity)) {
        return quarantine(job.jobId, 'judge_identity_conflict')
      }

      if (job.phase === 'queued') {
        let generated: unknown
        try {
          generated = await input.generator.generate({
            evidence,
            allowedDescriptorIds: Object.freeze(evidence[0].steps.map(step => step.descriptorId)),
          })
        } catch {
          return { kind: 'deferred', jobId: job.jobId }
        }
        const draft = parseSkillRecipeDraft(generated)
        if (draft === null) return quarantine(job.jobId, 'recipe_invalid')
        job = input.store.advanceJob({
          jobId: job.jobId, expected: 'queued', next: 'generated', draft,
        })
      }

      if (job.phase === 'generated') {
        const validation = validateSkillRecipeDraft({
          draft: job.draft,
          evidence,
          registry: input.registry,
        })
        if (!validation.ok) return quarantine(job.jobId, validation.code)
        job = input.store.advanceJob({
          jobId: job.jobId,
          expected: 'generated',
          next: 'validated',
          draft: validation.draft,
        })
      }

      if (job.phase === 'validated') {
        const manifest = job.draft === undefined ? null : buildAutoSkillManifest({
          draft: job.draft,
          evidence: evidence[0],
          registry: input.registry,
        })
        if (manifest === null) return quarantine(job.jobId, 'descriptor_missing')
        const renderedSkill = renderAutoSkillDocument(manifest)
        let verdict: { accepted: boolean }
        try {
          verdict = await input.judge.judge({ manifest, renderedSkill })
        } catch {
          return { kind: 'deferred', jobId: job.jobId }
        }
        if (verdict.accepted !== true) return quarantine(job.jobId, 'judge_rejected')
        if (!shadowVerifyAutoSkill({ manifest, evidence })) {
          return quarantine(job.jobId, 'shadow_replay_mismatch')
        }
        job = input.store.advanceJob({
          jobId: job.jobId, expected: 'validated', next: 'shadow_verified',
        })
      }

      if (job.phase === 'shadow_verified') {
        if (job.draft === undefined) return quarantine(job.jobId, 'recipe_missing')
        const manifest = buildAutoSkillManifest({
          draft: job.draft,
          evidence: evidence[0],
          registry: input.registry,
        })
        if (manifest === null) return quarantine(job.jobId, 'descriptor_missing')
        const revision = input.store.prepare({
          jobId: job.jobId,
          manifest,
          renderedSkill: renderAutoSkillDocument(manifest),
        })
        job = { ...job, phase: 'prepared', revisionHash: revision.revisionHash }
      }

      if (job.phase === 'prepared' && job.revisionHash !== undefined) {
        const revision = input.store.activate(job.jobId, job.revisionHash)
        return {
          kind: 'activated',
          jobId: job.jobId,
          revisionHash: revision.revisionHash,
        }
      }

      return { kind: 'deferred', jobId: job.jobId }
    },
  })
}
