import type { SkillCatalogViewEntry } from '@aisy/telegram-gw'
import type { SkillTelemetryStore } from './skill-telemetry-store.js'

export interface ActiveSkillMenuEntry {
  name: string
  description: string
}

/** Freeze the active Skill metadata and optional main-AgentCard intersection. */
export function makeConfiguredSkillMenuSource(input: {
  entries: readonly ActiveSkillMenuEntry[]
  allowedSkillNames: Iterable<string> | null
}): () => SkillCatalogViewEntry[] {
  const allowed = input.allowedSkillNames === null ? null : new Set(input.allowedSkillNames)
  const configured = Object.freeze(input.entries
    .filter((entry) => allowed === null || allowed.has(entry.name))
    .map((entry): SkillCatalogViewEntry => ({
      name: entry.name,
      summary: entry.description,
    })))

  return () => configured.map((entry) => ({
    name: entry.name,
    ...(entry.summary === undefined ? {} : { summary: entry.summary }),
  }))
}

/**
 * Telemetry is deliberately downstream of the byte-stable body read. A sidecar
 * failure is swallowed after the body is available, so serving never depends on
 * observational state and SKILL.md is never opened for writing here.
 */
export function makeTelemetrySkillBodyLoader(input: {
  loadBody(name: string): Promise<string>
  telemetry: Pick<SkillTelemetryStore, 'recordLoad'>
  nowIso?: () => string
}): (name: string) => Promise<string> {
  const nowIso = input.nowIso ?? (() => new Date().toISOString())
  return async name => {
    const body = await input.loadBody(name)
    if (body.length === 0) return body
    try { input.telemetry.recordLoad(name, nowIso()) } catch { /* telemetry is fail-open */ }
    return body
  }
}
