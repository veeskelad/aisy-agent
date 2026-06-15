import { describe, it, expect } from 'vitest'
import { renderDebugTail } from './debug-view.js'

describe('renderDebugTail', () => {
  it('returns empty string for no info', () => {
    expect(renderDebugTail({})).toBe('')
  })

  it('renders provenance with kinds and notes', () => {
    const out = renderDebugTail({
      provenance: [
        { spanId: 'span_001', kind: 'operator' },
        { spanId: 'span_002', kind: 'untrusted', note: 'file' },
      ],
    })
    expect(out).toContain('🔍 Провенанс:')
    expect(out).toContain('span_001: operator')
    expect(out).toContain('span_002: untrusted (file)')
  })

  it('renders guardian, mcp, memory and journal lines', () => {
    const out = renderDebugTail({
      guardian: { cycle: 3, rulesChecked: 14, violations: 0 },
      mcp: { servers: ['filesystem', 'git'], last: 'read_file 47ms' },
      memory: { episodic: 3, semanticK: 5 },
      journalCount: 8,
    })
    expect(out).toContain('🛡️ Safety: Guardian #3 · rules:14 · violations:0')
    expect(out).toContain('🔌 MCP: filesystem · git (last: read_file 47ms)')
    expect(out).toContain('📊 Memory: episodic 3 · semantic k=5')
    expect(out).toContain('💾 Журнал: 8 событий')
  })

  it('escapes dynamic content', () => {
    const out = renderDebugTail({ mcp: { servers: ['<x>'] } })
    expect(out).toContain('&lt;x&gt;')
  })

  it('omits sections that are absent', () => {
    const out = renderDebugTail({ journalCount: 2 })
    expect(out).toBe('💾 Журнал: 2 событий')
  })
})
