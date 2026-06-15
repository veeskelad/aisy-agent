// Public entry point for `@aisy/core`.
//
// Adapters (e.g. the Telegram gateway) consume the harness through this
// barrel. Only the Gateway connectivity surface is re-exported today; widen
// this deliberately as new public seams are needed — internal component
// types stay internal.

export type {
  Gateway,
  GatewayDeps,
  TelegramUpdate,
  InboundSpan,
  PendingAction,
  CardId,
  CardTap,
  ApprovalResult,
  Provenance,
  Channel,
} from './gateway/index.js'

export {
  AuthzRejected,
  RateLimited,
  VoiceUnavailable,
  IngestTooLarge,
  OutboundBlocked,
  TransportError,
  NonceReplay,
  NonceStale,
  ActionHashMismatch,
  StepUpRequired,
  StepUpFailed,
  NoSuchPendingAction,
} from './gateway/index.js'
