// Local domain types for the Telegram gateway adapter. Core types are imported
// from `@aisy/core`; everything here is adapter-private presentation state.

export type AgentState = 'idle' | 'running' | 'paused'

/** A single inline-keyboard button: visible label + opaque callback payload. */
export interface InlineButton {
  text: string
  data: string
}

/**
 * A message ready to hand to the transport: pre-rendered HTML, optional inline
 * keyboard, and an optional document for overflow content (>4096 visible chars).
 */
export interface BotMessage {
  html: string
  buttons?: InlineButton[][]
  document?: { filename: string; content: string }
}
