// Memory thresholds, deduplication and per-turn self-check (ADR-0078).
//
// These numbers are code-owned on purpose: a threshold the model can raise is
// not a threshold. Everything here is pure — no clock, no filesystem, no store —
// so the same facts always produce the same projection, byte for byte.

/** Operator gets a warning at this size. */
export const MEMORY_PROJECTION_WARN_BYTES = 8 * 1024
/** Above this the projection is truncated; the ledger keeps every fact. */
export const MEMORY_PROJECTION_LIMIT_BYTES = 10 * 1024
/** Guideline, not a limit: a projection past this is asking for consolidation. */
export const MEMORY_PROJECTION_TARGET_LINES = 200
/** How much of a fact is compared when deciding whether it is a repeat. */
export const FACT_DUPLICATE_PREFIX_CHARS = 60
/** Below this length a shared opening means nothing — "да" is not a fact. */
export const FACT_DUPLICATE_MIN_CHARS = 20
/** A session longer than this is reminded to consolidate. */
export const SESSION_CONSOLIDATION_MESSAGES = 32

const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).length
}

export interface MemoryProjectionHealth {
  bytes: number
  lines: number
  level: 'ok' | 'warn' | 'over'
}

export function projectionHealth(content: string): MemoryProjectionHealth {
  const bytes = byteLength(content)
  // A trailing newline terminates the last line rather than starting a new one.
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  const lines = body === '' ? 0 : body.split('\n').length
  const level = bytes > MEMORY_PROJECTION_LIMIT_BYTES
    ? 'over'
    : bytes > MEMORY_PROJECTION_WARN_BYTES
      ? 'warn'
      : 'ok'
  return { bytes, lines, level }
}

export interface TruncatedProjection {
  content: string
  truncated: boolean
  /** How many lines the operator no longer sees. They stay in the ledger. */
  droppedLines: number
}

/**
 * Cut the projection down to the hard limit at a line boundary.
 *
 * The marker is part of the budget, not an extra: a truncated projection never
 * exceeds the limit, so the memory contribution to a turn has a known ceiling.
 * Facts that fall off remain live in the ledger and reachable through search.
 */
export function truncateProjection(content: string): TruncatedProjection {
  if (byteLength(content) <= MEMORY_PROJECTION_LIMIT_BYTES) {
    return { content, truncated: false, droppedLines: 0 }
  }

  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  const lines = body.split('\n')

  // Reserve room for the marker up front. The dropped count is not known yet,
  // so reserve for the widest plausible one rather than guessing low and
  // overflowing the limit after the fact.
  const marker = (dropped: number) =>
    `\n— проекция обрезана: ещё ${dropped} строк в памяти, нужна консолидация\n`
  const reserved = byteLength(marker(lines.length))

  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = byteLength(line) + 1
    if (used + cost + reserved > MEMORY_PROJECTION_LIMIT_BYTES) break
    kept.push(line)
    used += cost
  }

  const droppedLines = lines.length - kept.length
  return {
    content: kept.join('\n') + marker(droppedLines),
    truncated: true,
    droppedLines,
  }
}

function normalizeFactText(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Normalized comparison key of a fact.
 *
 * Case and whitespace carry no meaning here, and only the opening of the text
 * is compared: the same statement with a clarification appended is the same
 * fact, while a different opening is a different one.
 */
export function factDuplicatePrefix(text: string): string {
  return normalizeFactText(text).slice(0, FACT_DUPLICATE_PREFIX_CHARS)
}

/**
 * Find an existing fact the candidate merely repeats.
 *
 * Comparison runs over the shared opening, capped at the prefix length — that
 * is what makes "X" and "X, уточнение" the same fact. Texts too short to carry
 * a distinguishing opening are never merged: a shared "да" says nothing about
 * whether two statements mean the same thing.
 */
export function findDuplicateFact<T extends { id: string; text: string }>(
  candidateText: string,
  existing: readonly T[],
): T | null {
  const candidate = normalizeFactText(candidateText)
  if (candidate.length < FACT_DUPLICATE_MIN_CHARS) return null
  for (const fact of existing) {
    const other = normalizeFactText(fact.text)
    if (other.length < FACT_DUPLICATE_MIN_CHARS) continue
    const width = Math.min(FACT_DUPLICATE_PREFIX_CHARS, candidate.length, other.length)
    if (candidate.slice(0, width) === other.slice(0, width)) return fact
  }
  return null
}

export type MemoryNoticeCode =
  | 'projection-warn'
  | 'projection-over'
  | 'session-consolidate'
  | 'operator-profile-empty'

export interface MemoryNotice {
  code: MemoryNoticeCode
  detail: string
}

/**
 * The per-turn self-check.
 *
 * Notices are addressed to the operator, not to the model: they describe the
 * state of the installation, and none of them stops a turn.
 */
export function memorySelfCheck(input: {
  projection: MemoryProjectionHealth
  sessionMessages: number
  /** Size of the operator profile file; zero means onboarding never happened. */
  operatorProfileBytes: number
}): readonly MemoryNotice[] {
  const notices: MemoryNotice[] = []
  const kb = (bytes: number) => (bytes / 1024).toFixed(1)

  if (input.projection.level === 'over') {
    notices.push({
      code: 'projection-over',
      detail: `проекция памяти ${kb(input.projection.bytes)} КБ при пределе ${kb(MEMORY_PROJECTION_LIMIT_BYTES)} КБ — часть фактов не видна в контексте`,
    })
  } else if (input.projection.level === 'warn') {
    notices.push({
      code: 'projection-warn',
      detail: `проекция памяти ${kb(input.projection.bytes)} КБ, ориентир ${MEMORY_PROJECTION_TARGET_LINES} строк — пора консолидировать`,
    })
  }

  if (input.sessionMessages >= SESSION_CONSOLIDATION_MESSAGES) {
    notices.push({
      code: 'session-consolidate',
      detail: `в сессии ${input.sessionMessages} сообщений — стоит сохранить итог в память`,
    })
  }

  if (input.operatorProfileBytes <= 0) {
    notices.push({
      code: 'operator-profile-empty',
      detail: 'профиль оператора пуст — агент работает без знания о том, с кем говорит',
    })
  }

  return notices
}
