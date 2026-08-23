// What the agent has actually learned about the operator.
//
// The first version of the acquaintance gate counted facts: six of anything and
// the brief dropped out. Six facts about a deploy pipeline satisfied it just as
// well as six facts about the person, so the agent could stop asking before it
// knew who it was talking to. This records which of the six topics have been
// answered instead, and the brief renders from what is still missing.
//
// The record is durable and additive: a topic never becomes uncovered again, and
// a broken file reads as "nothing covered" — asking one question too many is
// cheap, silently skipping the introduction is not.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The six topics of the acquaintance, in the order the brief lists them. */
export const ONBOARDING_TOPICS = [
  'name',
  'work',
  'projects',
  'style',
  'autonomy',
  'expectations',
] as const

export type OnboardingTopic = (typeof ONBOARDING_TOPICS)[number]

export const TOPIC_LABEL: Record<OnboardingTopic, string> = {
  name: 'как обращаться, часовой пояс, язык',
  work: 'чем занимается и какими инструментами живёт',
  projects: 'какие проекты идут сейчас',
  style: 'как любит общаться',
  autonomy: 'что можно делать самому, а что только с подтверждением',
  expectations: 'чего ждёт в первую неделю',
}

export function isOnboardingTopic(value: string): value is OnboardingTopic {
  return (ONBOARDING_TOPICS as readonly string[]).includes(value)
}

export interface OnboardingProgress {
  /** Topics still unanswered, in brief order. Empty ⇒ the introduction is done. */
  missing(): OnboardingTopic[]
  /** Records a topic as covered, keeping the fact that answered it. Unknown
   *  topics are ignored, not an error. */
  cover(topic: string, fact?: string): void
  /** Covered topics with the facts that answered them, in brief order. */
  profile(): Array<{ topic: OnboardingTopic; facts: string[] }>
}

interface ProgressFile {
  version: 1
  covered: string[]
  /** Fact texts per topic, in the order they were learned. */
  facts?: Record<string, string[]>
}

const MAX_FACTS_PER_TOPIC = 8
const MAX_FACT_CHARS = 300

interface ParsedProgress {
  covered: Set<string>
  facts: Map<string, string[]>
}

function parse(raw: string): ParsedProgress {
  const empty: ParsedProgress = { covered: new Set(), facts: new Map() }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return empty
    const file = parsed as ProgressFile
    if (!Array.isArray(file.covered)) return empty
    const covered = new Set(file.covered.filter((item): item is string =>
      typeof item === 'string' && isOnboardingTopic(item)))
    const facts = new Map<string, string[]>()
    if (file.facts !== null && typeof file.facts === 'object') {
      for (const [topic, texts] of Object.entries(file.facts)) {
        if (!isOnboardingTopic(topic) || !Array.isArray(texts)) continue
        facts.set(topic, texts.filter((text): text is string => typeof text === 'string'))
      }
    }
    return { covered, facts }
  } catch {
    return empty
  }
}

/** One line, bounded: a fact is a short phrase, and a paragraph pasted here
 *  would turn the profile file into a second transcript. */
function normalizeFact(fact: string): string | null {
  const text = fact.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (text.length === 0) return null
  return text.length <= MAX_FACT_CHARS ? text : `${text.slice(0, MAX_FACT_CHARS - 1)}…`
}

export function makeOnboardingProgress(input: { path: string }): OnboardingProgress {
  // Read once and keep the set in memory: `missing()` runs on every turn as part
  // of the frozen prefix, and re-reading a file for that is noise.
  let state = existsSync(input.path)
    ? parse(readFileSync(input.path, 'utf8'))
    : { covered: new Set<string>(), facts: new Map<string, string[]>() }

  const persist = (): void => {
    const body: ProgressFile = {
      version: 1,
      covered: [...state.covered],
      facts: Object.fromEntries(state.facts),
    }
    const temporary = `${input.path}.tmp`
    mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 })
    writeFileSync(temporary, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, input.path)
  }

  return Object.freeze<OnboardingProgress>({
    missing: () => ONBOARDING_TOPICS.filter((topic) => !state.covered.has(topic)),

    cover(topic, fact) {
      if (!isOnboardingTopic(topic)) return
      const text = fact === undefined ? null : normalizeFact(fact)
      const existing = state.facts.get(topic) ?? []
      // A topic stays open until something is written about it, and a repeated
      // answer is one answer: the operator saying the same thing twice must not
      // make the profile twice as long.
      const alreadyKnown = text === null || existing.includes(text)
      if (state.covered.has(topic) && alreadyKnown) return
      const facts = new Map(state.facts)
      if (!alreadyKnown) facts.set(topic, [...existing, text].slice(-MAX_FACTS_PER_TOPIC))
      state = { covered: new Set(state.covered).add(topic), facts }
      // A failed write costs one repeated question after a restart, which is
      // better than losing the fact the write was about.
      try { persist() } catch { /* progress is a convenience, not the memory */ }
    },

    profile: () => ONBOARDING_TOPICS
      .filter((topic) => state.covered.has(topic))
      .map((topic) => ({ topic, facts: [...(state.facts.get(topic) ?? [])] })),
  })
}
