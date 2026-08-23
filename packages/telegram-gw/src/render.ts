// Rendering & length strategy (plan §5).
//
// Parse mode is HTML — simpler and more robust to escape than MarkdownV2 for
// arbitrary agent output. Telegram's 4096-character limit applies to the
// *visible* text (after entity parsing), so markup tags do not count; we budget
// on the plain body length and fall back to a document on overflow.

import { markdownToTelegramHtml } from './markdown.js'
import type { BotMessage } from './types.js'

export const TELEGRAM_TEXT_LIMIT = 4096

/** Escape the three characters Telegram's HTML parser treats specially. */
/**
 * Русское число словом: «1 шаг», «3 шага», «5 шагов».
 *
 * Без этого карточка плана обещала «5 шага», а сводка — «2 файлов»: счётчик,
 * который не умеет склонять, читается как ошибка в самом агенте.
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100
  if (mod100 >= 11 && mod100 <= 14) return many
  const mod10 = mod100 % 10
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Escape a value going inside an attribute. Telegram accepts exactly four named
 * entities — `&lt; &gt; &amp; &quot;` — so a bare quote in an href would end the
 * attribute early and take the rest of the message with it.
 */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * Wrap source in a Telegram <pre><code> block; content is escaped.
 *
 * The language class is what makes Telegram highlight the block, so a known
 * language is worth carrying through. It is filtered rather than escaped: an
 * attribute is not a place to find out whether the model invented a language
 * name with quotes in it.
 */
const LANGUAGE = /^[a-z][a-z0-9+#-]{0,19}$/i

export function codeBlock(code: string, lang?: string): string {
  const cls = lang !== undefined && LANGUAGE.test(lang) ? ` class="language-${lang.toLowerCase()}"` : ''
  return `<pre><code${cls}>${escapeHtml(code)}</code></pre>`
}

/** A 20-cell unicode progress bar for budget display, clamped to [0,1]. */
export function bar(fraction: number, width = 20): string {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const filled = Math.round(f * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export interface FittedBody {
  /** Final HTML to send, with visible length within the limit. */
  text: string
  /** Present only when the body overflowed and was offloaded to a document. */
  document?: { filename: string; content: string }
}

/**
 * Fit a plain-text body into a Telegram message.
 *
 * The body is the agent's own answer, written in Markdown, so it is converted
 * rather than merely escaped — otherwise the operator reads `**bold**` with the
 * asterisks. Conversion happens *after* the length cut so a tag can never be
 * severed in the middle. Bodies over the limit keep a marker inline and the
 * full (unconverted) text travels as a .txt document, where Markdown is the
 * right format anyway.
 */
export function fitBody(
  body: string,
  opts?: { filename?: string; limit?: number },
): FittedBody {
  const limit = opts?.limit ?? TELEGRAM_TEXT_LIMIT
  if (body.length <= limit) {
    return { text: markdownToTelegramHtml(body) }
  }
  const marker = '\n… (полностью — в файле)'
  const head = body.slice(0, Math.max(0, limit - marker.length))
  return {
    text: markdownToTelegramHtml(head) + escapeHtml(marker),
    document: { filename: opts?.filename ?? 'output.txt', content: body },
  }
}

/** Apply fitBody to a BotMessage's html, attaching an overflow document if needed. */
export function fitMessage(msg: BotMessage, filename?: string): BotMessage {
  const fitted = fitBody(stripTags(msg.html), filename ? { filename } : undefined)
  if (!fitted.document) return msg
  return { ...msg, document: fitted.document }
}

/** Rough visible-length estimate: strip tags to approximate post-parse length. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}
