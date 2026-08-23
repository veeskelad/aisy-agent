// The dialogue's numbers, in one place.
//
// Every value here used to be a literal somewhere in the transport, which meant
// nobody could answer "how often does the status refresh" without grepping.
// They are code-owned: the operator does not tune them and the model cannot.

/** How often the "typing" status is refreshed while a turn runs. */
export const STATUS_REFRESH_MS = 4_000
/** Minimum gap between streaming edits of the same message. */
export const STREAM_EDIT_MS = 250
/** Quiet window that collects one Telegram album into a single acknowledgement. */
export const ALBUM_QUIET_MS = 500
/** Telegram's own hard limit on a text message. */
export const MESSAGE_LIMIT = 4_096
/** A reply longer than this is split; past MAX_PARTS it goes to a file instead. */
export const SPLIT_LIMIT = 3_500
/** More parts than this is a wall of text — send a document. */
export const MAX_PARTS = 3
/** How much of a voice transcript is echoed back as a preview. */
export const VOICE_PREVIEW_CHARS = 280
/**
 * Сколько символов подписи кнопки видно на телефоне целиком.
 *
 * Телеграм подпись не обрезает — он её сжимает, и «⬇️ Импортировать legacy в
 * Workspace» превращается в нечитаемую полоску. Считаем сами.
 */
export const BUTTON_LABEL_MAX = 20

/** Подпись кнопки, укороченная до читаемой длины. */
export function fitLabel(text: string, limit = BUTTON_LABEL_MAX): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, limit - 1).trimEnd()}…`
}

/**
 * Split a long reply on paragraph boundaries.
 *
 * Paragraphs first, then lines, then a hard cut — a hard cut in the middle of a
 * word is ugly but never loses a character, and losing characters is the one
 * outcome that is not acceptable.
 */
export function splitByParagraph(text: string, limit = SPLIT_LIMIT): string[] {
  if (text.length <= limit) return text === '' ? [] : [text]

  const parts: string[] = []
  let current = ''

  const flush = (): void => {
    if (current !== '') parts.push(current)
    current = ''
  }
  const push = (piece: string, separator: string): void => {
    if (current === '') {
      current = piece
      return
    }
    if (current.length + separator.length + piece.length <= limit) {
      current += separator + piece
      return
    }
    flush()
    current = piece
  }

  for (const paragraph of text.split('\n\n')) {
    if (paragraph.length <= limit) {
      push(paragraph, '\n\n')
      continue
    }
    for (const line of paragraph.split('\n')) {
      if (line.length <= limit) {
        push(line, '\n')
        continue
      }
      flush()
      for (let at = 0; at < line.length; at += limit) {
        parts.push(line.slice(at, at + limit))
      }
    }
  }
  flush()
  return parts
}

export type RetryDecision =
  | { retry: false; reason: 'rate-limited' | 'permanent' }
  | { retry: true; afterMs: number; attemptsLeft: number }

/** Bounded retry: at most this many attempts after the first one. */
export const MAX_RETRIES = 2
const BACKOFF_MS = [500, 2_000] as const

/**
 * Decide whether a failed Telegram call is worth repeating.
 *
 * A 429 is never retried here: Telegram already told us to slow down, and the
 * transport's own retry is exactly what turns a rate limit into a ban. The
 * caller honours `retry_after` instead.
 */
export function retryPlan(input: {
  statusCode?: number
  attempt: number
}): RetryDecision {
  if (input.statusCode === 429) return { retry: false, reason: 'rate-limited' }
  const retryable = input.statusCode === undefined ||
    input.statusCode >= 500 ||
    input.statusCode === 408
  if (!retryable) return { retry: false, reason: 'permanent' }
  if (input.attempt >= MAX_RETRIES) return { retry: false, reason: 'permanent' }
  return {
    retry: true,
    afterMs: BACKOFF_MS[Math.min(input.attempt, BACKOFF_MS.length - 1)] ?? 2_000,
    attemptsLeft: MAX_RETRIES - input.attempt,
  }
}

/** Extensions accepted as a document upload; anything else is refused. */
export const DOCUMENT_EXTENSIONS: readonly string[] = Object.freeze([
  '.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.log',
  '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif',
])
/** Upper bound of one accepted document. */
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024

export type DocumentRefusal = 'extension-not-allowed' | 'too-large'

export function acceptDocument(input: {
  filename: string
  sizeBytes: number
}): true | DocumentRefusal {
  const lower = input.filename.toLowerCase()
  if (!DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return 'extension-not-allowed'
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes > DOCUMENT_MAX_BYTES) return 'too-large'
  return true
}

/** Preview of a voice transcript, explicitly marked when it is cut. */
export function transcriptPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= VOICE_PREVIEW_CHARS) return collapsed
  return `${collapsed.slice(0, VOICE_PREVIEW_CHARS)}… (расшифровка обрезана)`
}
