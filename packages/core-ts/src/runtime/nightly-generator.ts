// packages/core-ts/src/runtime/nightly-generator.ts
// LLM-backed Generator and Judge adapters for nightly consolidation (Tier-4 B3).

import type { Generator, Judge, MemOp, FactKey, Fact, Diff, NormalizedDayLog, QuarantinedDiff, JudgeVerdict, SkillDraft } from '../nightly/index.js'
import type { ProviderAdapter } from '../agent-loop/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a raw slug string from the LLM into the structured nightly FactKey.
 * Convention: { entity: 'fact', relation: 'asserts', object: <slug> }
 */
function wrapSlug(slug: string): FactKey {
  return { entity: 'fact', relation: 'asserts', object: slug }
}

/**
 * Extract the first top-level JSON array from a string that may contain prose.
 * Finds the first '[' and matches the corresponding ']' by tracking bracket depth.
 * Returns the raw substring or null if not found.
 */
function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf('[')
  if (start === -1) return null

  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }
  return null
}

/**
 * Extract the first top-level JSON object from a string that may contain prose.
 * Used by the judge to parse { verdict: ... }.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }
  return null
}

const MAX_OPS = 50

/**
 * Parse the LLM reply into validated MemOps.
 * - Extracts the first JSON array from reply (handles prose wrapping).
 * - Validates each element: kind ∈ {ADD,UPDATE,DELETE,NOOP} + required fields.
 * - Wraps the string factKey slug into the structured FactKey for ADD/UPDATE.
 * - For UPDATE missing factKey, reuses the live fact's factKey.
 * - Drops malformed elements silently.
 * - Caps array at MAX_OPS.
 * On any parse failure returns [].
 */
function parseMemOps(reply: string, liveFacts: Fact[]): MemOp[] {
  const raw = extractFirstJsonArray(reply)
  if (raw === null) return []

  let parsed: unknown[]
  try {
    parsed = JSON.parse(raw) as unknown[]
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) return []

  const ops: MemOp[] = []

  for (const el of parsed) {
    if (ops.length >= MAX_OPS) break
    if (el === null || typeof el !== 'object') continue
    const elem = el as Record<string, unknown>

    const kind = elem['kind']
    if (kind !== 'ADD' && kind !== 'UPDATE' && kind !== 'DELETE' && kind !== 'NOOP') continue

    if (kind === 'ADD') {
      const rawKey = elem['factKey']
      const text = elem['text']
      if (typeof text !== 'string' || text === '') continue
      // factKey may be a string slug (from LLM) or already a structured object
      const factKey = typeof rawKey === 'string'
        ? wrapSlug(rawKey)
        : isStructuredFactKey(rawKey)
          ? rawKey
          : null
      if (factKey === null) continue
      ops.push({ kind: 'ADD', factKey, text })
    } else if (kind === 'UPDATE') {
      const factId = elem['factId']
      const text = elem['text']
      if (typeof factId !== 'string' || typeof text !== 'string' || text === '') continue

      // factKey: use LLM-provided slug/object, or fall back to live fact's factKey
      const rawKey = elem['factKey']
      let factKey: FactKey | null = null
      if (typeof rawKey === 'string') {
        factKey = wrapSlug(rawKey)
      } else if (isStructuredFactKey(rawKey)) {
        factKey = rawKey
      } else {
        // LLM omitted factKey — reuse from live facts
        factKey = liveFacts.find((f) => f.id === factId)?.factKey ?? null
      }
      if (factKey === null) continue
      ops.push({ kind: 'UPDATE', factId, factKey, text })
    } else if (kind === 'DELETE') {
      const factId = elem['factId']
      const reason = elem['reason']
      if (typeof factId !== 'string' || typeof reason !== 'string') continue
      ops.push({ kind: 'DELETE', factId, reason })
    } else if (kind === 'NOOP') {
      const factId = elem['factId']
      if (typeof factId !== 'string') continue
      ops.push({ kind: 'NOOP', factId })
    }
  }

  return ops
}

function isStructuredFactKey(v: unknown): v is FactKey {
  if (v === null || typeof v !== 'object') return false
  const k = v as Record<string, unknown>
  return typeof k['entity'] === 'string' && typeof k['relation'] === 'string' && typeof k['object'] === 'string'
}

function buildDiff(ops: MemOp[]): Diff {
  const added: MemOp[] = []
  const removed: string[] = []
  const updated: MemOp[] = []

  for (const op of ops) {
    if (op.kind === 'ADD') added.push(op)
    else if (op.kind === 'DELETE') removed.push(op.factId)
    else if (op.kind === 'UPDATE') updated.push(op)
    // NOOP excluded from the diff
  }

  return { added, removed, updated }
}

const EMPTY_DIFF: Diff = { added: [], removed: [], updated: [] }

// ---------------------------------------------------------------------------
// makeNightlyGenerator
// ---------------------------------------------------------------------------

export function makeNightlyGenerator(deps: {
  provider: ProviderAdapter
  nowIso: () => string
}): Generator {
  return {
    async proposeMemoryOps(log: NormalizedDayLog, liveFacts: Fact[]): Promise<{ ops: MemOp[]; diff: Diff }> {
      const logText = JSON.stringify(log.records)
      const factsText = liveFacts
        .map((f) => `${f.id} | ${f.factKey.object} | ${f.text}`)
        .join('\n')

      const systemPrompt =
        'You consolidate a day\'s events into durable long-term memory. ' +
        'Output ONLY a JSON array of operations, no prose. ' +
        'Each element must be one of:\n' +
        '  {"kind":"ADD","factKey":"<short-topic-slug>","text":"..."}\n' +
        '  {"kind":"UPDATE","factId":"<existing id>","factKey":"<slug>","text":"..."}\n' +
        '  {"kind":"DELETE","factId":"<existing id>","reason":"..."}\n' +
        '  {"kind":"NOOP","factId":"<id>"}\n' +
        'factKey must be a plain string slug (e.g. "user-location"). Do NOT emit structured objects.'

      const userPrompt =
        `Day log records:\n${logText}\n\n` +
        `Current live facts (factId | topic | text):\n${factsText || '(none)'}`

      let response: { reply: string }
      try {
        response = await deps.provider.complete({
          sessionId: 'nightly',
          prefixBytes: new Uint8Array(0),
          spans: [
            { role: 'system', provenance: 'operator', text: systemPrompt },
            { role: 'user', provenance: 'operator', text: userPrompt },
          ],
        })
      } catch {
        // Provider unavailable — graceful degrade
        return { ops: [], diff: EMPTY_DIFF }
      }

      const ops = parseMemOps(response.reply, liveFacts)
      const diff = buildDiff(ops)
      return { ops, diff }
    },

    async draftSkills(_log: NormalizedDayLog): Promise<SkillDraft[]> {
      // Skill drafting deferred to a follow-up task. The runner handles an empty
      // draft set gracefully (the lint pass is not skipped on an empty return).
      return []
    },
  }
}

// ---------------------------------------------------------------------------
// makeNightlyJudge
// ---------------------------------------------------------------------------

export function makeNightlyJudge(deps: { provider: ProviderAdapter }): Judge {
  return {
    async grade(quarantinedDiff: QuarantinedDiff): Promise<JudgeVerdict> {
      const systemPrompt =
        'You are a STRICT reviewer of a proposed memory diff. ' +
        'You see only the artifact, never the author\'s reasoning. ' +
        'Accept only safe, durable, non-redundant edits. ' +
        'Output ONLY strict JSON: {"verdict":"accept"} or {"verdict":"reject"} or {"verdict":"edit"}. No prose.'

      const diffSummary =
        `Added ops: ${quarantinedDiff.diff.added.length}\n` +
        `Removed factIds: ${quarantinedDiff.diff.removed.join(', ') || '(none)'}\n` +
        `Updated ops: ${quarantinedDiff.diff.updated.length}`

      const userPrompt =
        `Proposed diff body:\n${quarantinedDiff.body}\n\n` +
        `Diff summary:\n${diffSummary}`

      let reply: string
      try {
        const response = await deps.provider.complete({
          sessionId: 'nightly',
          prefixBytes: new Uint8Array(0),
          spans: [
            { role: 'system', provenance: 'operator', text: systemPrompt },
            { role: 'user', provenance: 'operator', text: userPrompt },
          ],
        })
        reply = response.reply
      } catch {
        // Provider unavailable — fail-safe: reject
        return 'reject'
      }

      // Parse the verdict from the reply
      const raw = extractFirstJsonObject(reply)
      if (raw === null) return 'reject'

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return 'reject'
      }

      if (parsed === null || typeof parsed !== 'object') return 'reject'
      const verdict = (parsed as Record<string, unknown>)['verdict']

      if (verdict === 'accept') return 'accept'
      if (verdict === 'edit') return 'edit'
      // 'reject' or anything else → reject (fail-safe)
      return 'reject'
    },
  }
}
