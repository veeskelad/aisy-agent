// Debug mode tail (plan §10). Produces the technical block appended to the live
// execution post when debug is on. Pure: assembled from accumulated diagnostics.

import { escapeHtml } from './render.js'

export interface ProvenanceLine {
  spanId: string
  kind: 'operator' | 'untrusted'
  note?: string
}

export interface DebugInfo {
  provenance?: ProvenanceLine[]
  guardian?: { cycle: number; rulesChecked: number; violations: number }
  mcp?: { servers: string[]; last?: string }
  memory?: { episodic: number; semanticK: number }
  journalCount?: number
}

/** Render the debug tail. Returns '' when there is nothing to show. */
export function renderDebugTail(info: DebugInfo): string {
  const lines: string[] = []

  if (info.provenance && info.provenance.length > 0) {
    const parts = info.provenance.map((p) => {
      const note = p.note ? ` (${escapeHtml(p.note)})` : ''
      return `${escapeHtml(p.spanId)}: ${p.kind}${note}`
    })
    lines.push(`🔍 Провенанс: ${parts.join(' · ')}`)
  }

  if (info.guardian) {
    lines.push(
      `🛡️ Safety: Guardian #${info.guardian.cycle} · rules:${info.guardian.rulesChecked} · violations:${info.guardian.violations}`,
    )
  }

  if (info.mcp) {
    const last = info.mcp.last ? ` (last: ${escapeHtml(info.mcp.last)})` : ''
    lines.push(`🔌 MCP: ${info.mcp.servers.map(escapeHtml).join(' · ')}${last}`)
  }

  if (info.memory) {
    lines.push(`📊 Memory: episodic ${info.memory.episodic} · semantic k=${info.memory.semanticK}`)
  }

  if (typeof info.journalCount === 'number') {
    lines.push(`💾 Журнал: ${info.journalCount} событий`)
  }

  return lines.join('\n')
}
