import type { MonitoringDigest } from '@aisy/core'
import { escapeHtml, escapeHtmlAttribute, TELEGRAM_TEXT_LIMIT } from './render.js'

export type MonitoringDigestViewErrorCode = 'INVALID_LIMIT' | 'INVALID_EVIDENCE_URL'

export class MonitoringDigestViewError extends Error {
  constructor(readonly code: MonitoringDigestViewErrorCode) {
    super(code)
    this.name = 'MonitoringDigestViewError'
  }
}

export interface MonitoringDigestView {
  html: string
  text: string
  visibleLength: number
  renderedItems: number
  omittedItems: number
}

const CATEGORY_LABELS = {
  critical: 'Критично',
  important: 'Важно',
  useful: 'Полезно',
  noise: 'Шум',
} as const

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return normalized.slice(0, maxLength - 1).trimEnd() + '…'
}

function primaryEvidenceUrl(raw: string): string {
  try {
    const parsed = new URL(raw)
    const authorityStart = raw.indexOf('://') + 3
    const authority = raw.slice(authorityStart).split(/[/?#]/, 1)[0] ?? ''
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.origin === 'null' || authority.includes('@')) {
      throw new MonitoringDigestViewError('INVALID_EVIDENCE_URL')
    }
    return parsed.toString()
  } catch (error) {
    if (error instanceof MonitoringDigestViewError) throw error
    throw new MonitoringDigestViewError('INVALID_EVIDENCE_URL')
  }
}

function itemView(
  item: MonitoringDigest['items'][number],
  index: number,
  primaryUrl: string,
): { html: string; text: string } {
  const title = compact(item.title, 160) || 'Без заголовка'
  const summary = compact(item.summary, 320)
  const whyUseful = compact(item.whyUseful, 220)
  const heading = `${index + 1}. ${CATEGORY_LABELS[item.category]}: ${title}`
  const textParts = [heading]
  const htmlParts = [`<b>${escapeHtml(heading)}</b>`]
  if (summary.length > 0 && summary !== title) {
    textParts.push(summary)
    htmlParts.push(escapeHtml(summary))
  }
  if (whyUseful.length > 0) {
    const why = `Почему полезно: ${whyUseful}`
    textParts.push(why)
    htmlParts.push(escapeHtml(why))
  }
  textParts.push('Источник')
  htmlParts.push(`<a href="${escapeHtmlAttribute(primaryUrl)}">Источник</a>`)
  return { html: htmlParts.join('\n'), text: textParts.join('\n') }
}

/** Render a bounded Russian digest while retaining a primary evidence link per shown item. */
export function renderMonitoringDigest(
  digest: MonitoringDigest,
  options?: { limit?: number },
): MonitoringDigestView {
  const limit = options?.limit ?? TELEGRAM_TEXT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > TELEGRAM_TEXT_LIMIT) {
    throw new MonitoringDigestViewError('INVALID_LIMIT')
  }

  const primaryUrls = digest.items.map((item) => primaryEvidenceUrl(item.primaryUrl))
  const title = '📡 Дайджест Aisy'
  const period = `Период: ${digest.windowStart} — ${digest.windowEnd}`
  const textParts = [title, period]
  const htmlParts = [`<b>${escapeHtml(title)}</b>`, escapeHtml(period)]
  let visibleLength = textParts.join('\n').length
  let renderedItems = 0

  if (digest.items.length === 0) {
    const empty = 'Новых материалов за этот период нет.'
    textParts.push('', empty)
    htmlParts.push('', escapeHtml(empty))
    const text = textParts.join('\n')
    return { html: htmlParts.join('\n'), text, visibleLength: text.length, renderedItems: 0, omittedItems: 0 }
  }

  for (const [index, item] of digest.items.entries()) {
    const section = itemView(item, index, primaryUrls[index]!)
    const omittedAfter = digest.items.length - index - 1
    const reservedFooter = omittedAfter > 0 ? `\n\n… Ещё ${omittedAfter} в следующем сообщении.`.length : 0
    const separatorLength = 2
    if (visibleLength + separatorLength + section.text.length + reservedFooter > limit) break
    textParts.push('', section.text)
    htmlParts.push('', section.html)
    visibleLength += separatorLength + section.text.length
    renderedItems += 1
  }

  const omittedItems = digest.items.length - renderedItems
  if (omittedItems > 0) {
    const footer = `… Ещё ${omittedItems} в следующем сообщении.`
    textParts.push('', footer)
    htmlParts.push('', escapeHtml(footer))
  }
  const text = textParts.join('\n')
  return { html: htmlParts.join('\n'), text, visibleLength: text.length, renderedItems, omittedItems }
}
