export type TranscriptionErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_PATH'
  | 'SYMLINK_DENIED'
  | 'SPECIAL_FILE_DENIED'
  | 'HARDLINK_DENIED'
  | 'CROSS_DEVICE_DENIED'
  | 'LIMIT_EXCEEDED'
  | 'NOT_FOUND'
  | 'NOT_DIRECTORY'
  | 'NOT_REGULAR'
  | 'HASH_MISMATCH'
  | 'IO_FAILED'
  | 'UNSUPPORTED_PLATFORM'
  | 'MODEL_UNAVAILABLE'
  | 'TRANSCRIPTION_FAILED'
  | 'AUTHENTICATION_FAILED'
  | 'INTERNAL_ERROR'
  | 'DOCKER_INCOMPATIBLE'
  | 'SANDBOX_DENIED'
  | 'PROCESS_FAILED'
  | 'PROTOCOL_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'QUOTA_EXCEEDED'
  | 'CLEANUP_FAILED'

export class TranscriptionError extends Error {
  constructor(public readonly code: TranscriptionErrorCode) {
    super(code)
    this.name = 'TranscriptionError'
  }
}

export interface TranscriptionAudioRequest {
  readonly audioRoot: string
  readonly relativePath: string
  readonly expectedSha256: string
  readonly expectedSizeBytes: number
  readonly maxBytes: number
  readonly language?: string
  readonly signal?: AbortSignal
  /** Process-local one-use authority; only external providers require it. */
  readonly mediaCapability?: unknown
}

export interface TranscriptionTranscript {
  readonly text: string
  readonly provenance: 'untrusted'
  readonly channel: 'voice'
  readonly language?: string
  readonly durationMs?: number
}

export interface Transcriber {
  transcribe(request: TranscriptionAudioRequest): Promise<TranscriptionTranscript>
}
