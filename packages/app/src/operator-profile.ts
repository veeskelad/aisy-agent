// USER.md, kept honest.
//
// The scaffold writes an empty questionnaire and nothing ever fills it, so the
// per-turn memory self-check reports an empty operator profile forever — a
// warning with no way to act on it. What the agent learns during the
// acquaintance goes here, in one clearly delimited generated block.
//
// Everything outside the markers is the operator's own file and is preserved
// byte for byte: this appends a section, it does not own the document.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { TOPIC_LABEL, type OnboardingTopic } from './onboarding-progress.js'

const BEGIN = '<!-- aisy:profile:begin -->'
const END = '<!-- aisy:profile:end -->'

export type OperatorProfile = ReadonlyArray<{
  topic: OnboardingTopic
  facts: readonly string[]
}>

/** The generated block, or an empty string when nothing is known yet. */
export function renderProfileBlock(profile: OperatorProfile): string {
  const sections = profile
    .filter((entry) => entry.facts.length > 0)
    .map((entry) => `**${TOPIC_LABEL[entry.topic]}**\n${
      entry.facts.map((fact) => `- ${fact}`).join('\n')}`)
  if (sections.length === 0) return ''
  return [
    BEGIN,
    '## Что Aisy узнал при знакомстве',
    '',
    'Этот раздел пишет Aisy. Правки внутри него будут перезаписаны — всё, что',
    'снаружи маркеров, остаётся твоим.',
    '',
    sections.join('\n\n'),
    END,
  ].join('\n')
}

/**
 * Replaces the generated block in `body`, or appends it when there is none.
 * A file with a begin marker and no end marker is treated as having no block:
 * truncating from a stray marker to the end of the file would eat the
 * operator's text.
 */
export function mergeProfileBlock(body: string, block: string): string {
  const begin = body.indexOf(BEGIN)
  const end = body.indexOf(END)
  const own = begin >= 0 && end > begin
    ? (body.slice(0, begin) + body.slice(end + END.length)).replace(/\n{3,}$/u, '\n')
    : body
  const kept = own.replace(/\s+$/u, '')
  if (block.length === 0) return kept.length === 0 ? '' : `${kept}\n`
  return kept.length === 0 ? `${block}\n` : `${kept}\n\n${block}\n`
}

export interface OperatorProfileWriter {
  /** Regenerates the block from the current profile. Never throws. */
  refresh(profile: OperatorProfile): void
}

export function makeOperatorProfileWriter(input: {
  path: string
  onError?: (detail: string) => void
}): OperatorProfileWriter {
  return Object.freeze<OperatorProfileWriter>({
    refresh(profile) {
      try {
        const body = existsSync(input.path) ? readFileSync(input.path, 'utf8') : ''
        const next = mergeProfileBlock(body, renderProfileBlock(profile))
        if (next === body) return
        const temporary = `${input.path}.tmp`
        mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 })
        writeFileSync(temporary, next, { encoding: 'utf8', mode: 0o600 })
        renameSync(temporary, input.path)
      } catch (error) {
        // The ledger already holds the fact; a profile file that failed to
        // update is a stale view, not lost memory.
        input.onError?.(error instanceof Error ? error.message : 'unknown')
      }
    },
  })
}
