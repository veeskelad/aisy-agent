import type { ModelRequest } from '../agent-loop/types.js'

export type BrainAuthMode = 'subscription' | 'api-key'

export type BrainRuntime = 'native-api' | 'claude-code' | 'codex-app-server'

export type BrainConnectionStatus =
  | 'installing'
  | 'auth-required'
  | 'validating'
  | 'ready'
  | 'failed'

export type BrainRoute = 'reasoning' | 'routine' | 'critique' | 'coding'

export interface BrainCapabilities {
  structuredTools: boolean
  streaming: boolean
  approvals: boolean
  sessions: boolean
  usage: boolean
}

/** Durable metadata only. Credentials and raw auth challenges never belong here. */
export interface BrainConnection {
  id: string
  provider: string
  label: string
  authMode: BrainAuthMode
  runtime: BrainRuntime
  status: BrainConnectionStatus
  capabilities: BrainCapabilities
  defaultFor: BrainRoute[]
  createdAt: string
  updatedAt: string
  /** Stable, redaction-safe error code. Never a provider response body. */
  lastErrorCode?: string
}

export type AuthChallenge =
  | {
      kind: 'device-code'
      verificationUri: string
      userCode: string
      expiresAt?: string
    }
  | {
      kind: 'browser'
      authorizationUri: string
      safeInstructions: string
    }
  | {
      kind: 'secret-input'
      provider: string
      secretKind: 'api-key'
      /** Explains that Telegram bot chats are not end-to-end encrypted. */
      safeInstructions: string
      secureEntryAvailable: boolean
    }

export interface BrainDetectionResult {
  installed: boolean
  version?: string
}

export interface BrainInstallResult {
  installed: boolean
  version?: string
  /** Redaction-safe operator-facing detail. */
  safeDetail: string
}

export interface BrainValidationResult {
  ok: boolean
  /** Redaction-safe account/workspace label when the runtime exposes one. */
  accountLabel?: string
  safeDetail: string
  errorCode?: string
}

export interface BrainTurn {
  request: ModelRequest
  projectId: string
  sessionId: string
}

export type BrainEvent =
  | { type: 'started' }
  | { type: 'thinking'; safeSummary?: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-requested'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool-result'; toolCallId: string; result: unknown }
  | { type: 'approval-required'; approvalId: string; summary: string; tier: 0 | 1 | 2 | 3 }
  | { type: 'usage'; inputTokens: number; outputTokens: number; dollars?: number }
  | { type: 'completed'; reply: string }
  | { type: 'failed'; errorCode: string; safeDetail: string }

/**
 * Common contract for native API and supervised subscription runtimes.
 * Implementations must not place credentials in returned values or BrainEvents.
 */
export interface BrainDriver {
  readonly runtime: BrainRuntime
  detect(): Promise<BrainDetectionResult>
  install(): Promise<BrainInstallResult>
  beginAuth(): Promise<AuthChallenge>
  validate(): Promise<BrainValidationResult>
  run(turn: BrainTurn, signal: AbortSignal): AsyncIterable<BrainEvent>
}

