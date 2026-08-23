import { TELEGRAM_TEXT_LIMIT } from './render.js'

export interface SkillCatalogViewEntry {
  name: string
  summary?: string
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return normalized.slice(0, maxLength - 1).trimEnd() + '…'
}

/** Render only active Skill menu metadata; SKILL.md bodies never enter this view. */
export function renderSkillCatalog(entries: readonly SkillCatalogViewEntry[]): string {
  if (entries.length === 0) return '🧩 Навыки\nАктивных навыков нет.'

  const ordered = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  const header = `🧩 Навыки\nАктивных навыков: ${ordered.length}.`
  const parts = [header]
  let length = header.length
  let rendered = 0

  for (const entry of ordered) {
    const name = compact(entry.name, 140) || 'без имени'
    const summary = entry.summary === undefined ? '' : compact(entry.summary, 160)
    const line = `• ${name}` + (summary.length === 0 ? '' : ` — ${summary}`)
    const omittedAfter = ordered.length - rendered - 1
    const footerLength = omittedAfter > 0 ? `\n… Ещё ${omittedAfter}.`.length : 0
    if (length + 1 + line.length + footerLength > TELEGRAM_TEXT_LIMIT) break
    parts.push(line)
    length += 1 + line.length
    rendered += 1
  }

  const omitted = ordered.length - rendered
  if (omitted > 0) parts.push(`… Ещё ${omitted}.`)
  return parts.join('\n')
}
