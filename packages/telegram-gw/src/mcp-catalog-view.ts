import { TELEGRAM_TEXT_LIMIT } from './render.js'
import { askLevel } from './settings-tree.js'

export interface McpCatalogViewEntry {
  name: string
  summary?: string
  rw: 'read' | 'write'
  tier: 0 | 1 | 2 | 3
  active: boolean
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return normalized.slice(0, maxLength - 1).trimEnd() + '…'
}

/** Render only human-owned MCP policy fields; raw descriptors and connection data never enter this view. */
export function renderMcpCatalog(entries: readonly McpCatalogViewEntry[]): string {
  if (entries.length === 0) {
    return '🔌 MCP\nСерверы не настроены.'
  }

  const ordered = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  const active = ordered.filter((item) => item.active).length
  const header = active === 0
    ? `🔌 MCP\nИнструментов настроено: ${ordered.length}, но связь не поднята.`
    : `🔌 MCP\nАктивно инструментов: ${active} из ${ordered.length}.`
  const parts = [header]
  let length = header.length
  let rendered = 0

  for (const entry of ordered) {
    const name = compact(entry.name, 140) || 'без имени'
    const access = entry.rw === 'read' ? 'чтение' : 'запись'
    const status = entry.active ? 'активен' : 'не подключён'
    const summary = entry.summary === undefined ? '' : compact(entry.summary, 160)
    const line = `• ${name} · ${access} · ${askLevel(entry.tier)} · ${status}` +
      (summary.length === 0 ? '' : `\n  ${summary}`)
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
