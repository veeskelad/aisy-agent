// Rendering & length strategy (plan §5).
//
// Parse mode is HTML — simpler and more robust to escape than MarkdownV2 for
// arbitrary agent output. Telegram's 4096-character limit applies to the
// *visible* text (after entity parsing), so markup tags do not count; we budget
// on the plain body length and fall back to a document on overflow.

import type { BotMessage } from './types.js'

export const TELEGRAM_TEXT_LIMIT = 4096

/** Escape the three characters Telegram's HTML parser treats specially. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Wrap source in a Telegram <pre><code> block; content is escaped. */
export function codeBlock(code: string, lang?: string): string {
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ''
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
 * Fit a plain-text body into a Telegram message. Short bodies are HTML-escaped
 * and returned inline. Bodies whose visible length exceeds the limit are
 * truncated inline with a marker, and the full (un-escaped) body is returned as
 * a .txt document so nothing is lost.
 */
export function fitBody(
  body: string,
  opts?: { filename?: string; limit?: number },
): FittedBody {
  const limit = opts?.limit ?? TELEGRAM_TEXT_LIMIT
  if (body.length <= limit) {
    return { text: escapeHtml(body) }
  }
  const marker = '\n… (полностью — в файле)'
  const head = body.slice(0, Math.max(0, limit - marker.length))
  return {
    text: escapeHtml(head) + marker,
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
