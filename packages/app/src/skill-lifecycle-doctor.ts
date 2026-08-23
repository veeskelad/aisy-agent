import { inspectNodeSkillPromotionStore, type SkillPromotionStoreInspection } from './skill-promotion-store.js'
import { inspectNodeSkillTelemetryStore, type SkillTelemetryInspection } from './skill-telemetry-store.js'

export type SkillLifecycleDoctorCode =
  | 'SKILLS_READY'
  | 'SKILLS_EMPTY'
  | 'SKILLS_STAGE_CORRUPT'
  | 'SKILLS_RECOVERY_REQUIRED'
  | 'SKILLS_QUARANTINED'
  | 'SKILLS_TELEMETRY_DEGRADED'

export interface SkillLifecycleDoctorReport {
  code: SkillLifecycleDoctorCode
  ready: boolean
  blocking: boolean
  counts: Readonly<{
    active: number
    pending: number
    committing: number
    promoted: number
    quarantined: number
    telemetryRows: number
  }>
}

export function makeSkillLifecycleDoctor(input: {
  inspectPromotion(): SkillPromotionStoreInspection
  inspectTelemetry(): SkillTelemetryInspection
  activeCount(): number
}): { inspect(): Readonly<SkillLifecycleDoctorReport> } {
  return Object.freeze({
    inspect(): Readonly<SkillLifecycleDoctorReport> {
      let promotion: SkillPromotionStoreInspection
      let telemetry: SkillTelemetryInspection
      let active = 0
      let inspectorFailed = false
      try { promotion = input.inspectPromotion() } catch {
        promotion = { status: 'corrupt', pending: 0, committing: 0, promoted: 0, quarantined: 0 }
        inspectorFailed = true
      }
      try { telemetry = input.inspectTelemetry() } catch {
        telemetry = { status: 'corrupt', rows: 0 }
      }
      try {
        const raw = input.activeCount()
        if (!Number.isFinite(raw) || raw < 0) inspectorFailed = true
        else active = Math.trunc(raw)
      } catch { inspectorFailed = true }
      const counts = Object.freeze({
        active,
        pending: promotion.pending,
        committing: promotion.committing,
        promoted: promotion.promoted,
        quarantined: promotion.quarantined,
        telemetryRows: telemetry.rows,
      })
      let code: SkillLifecycleDoctorCode
      let ready = true
      let blocking = false
      if (inspectorFailed || promotion.status === 'corrupt' || promotion.status === 'unsafe') {
        code = 'SKILLS_STAGE_CORRUPT'; ready = false; blocking = true
      } else if (promotion.committing > 0) {
        code = 'SKILLS_RECOVERY_REQUIRED'; ready = false; blocking = true
      } else if (promotion.quarantined > 0) {
        code = 'SKILLS_QUARANTINED'; ready = false; blocking = true
      } else if (telemetry.status === 'corrupt' || telemetry.status === 'unsafe') {
        code = 'SKILLS_TELEMETRY_DEGRADED'
      } else if (active === 0 && promotion.pending === 0 && promotion.promoted === 0) {
        code = 'SKILLS_EMPTY'
      } else {
        code = 'SKILLS_READY'
      }
      return Object.freeze({ code, ready, blocking, counts })
    },
  })
}

export function makeNodeSkillLifecycleDoctor(input: {
  promotionPath: string
  telemetryPath: string
  activeCount(): number
}): { inspect(): Readonly<SkillLifecycleDoctorReport> } {
  return makeSkillLifecycleDoctor({
    inspectPromotion: () => inspectNodeSkillPromotionStore(input.promotionPath),
    inspectTelemetry: () => inspectNodeSkillTelemetryStore(input.telemetryPath),
    activeCount: input.activeCount,
  })
}
