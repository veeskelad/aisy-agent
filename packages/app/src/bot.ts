// Telegram transport (grammY) — the live wiring of the pure UX layer to a real
// bot. It owns the approval round-trip (the `approve` port issues a card, waits
// for the tap, resolves the promise the HookGate awaits), Hermes-style debounce
// coalescing of rapid messages, a steer queue for mid-turn input, and Tier-3
// step-up code capture.
//
// A turn that ran with untrusted context returns narrowed=true. That verdict no
// longer holds the reply: the answer goes to the operator, who is the only
// recipient this bot has (ADR-0095). It is mirrored on so the subscription-brain
// executor sees what a native turn sees, while the defences that actually stop
// an injection — untrusted-derived tool arguments never dispatching, approvals,
// sandbox, pinned egress — live in Core and are untouched. Model deltas edit one
// guarded Telegram message in place; a push-style alert stream for budget/cost
// events remains deferred.

import { Bot, InlineKeyboard, Keyboard, InputFile } from 'grammy'
import { createHash, randomBytes } from 'node:crypto'
import { ContextLeaseError, WorkBindingError, resolvedWorkBinding, wallClockIso } from '@aisy/core'
import type {
  VoiceCredentialBinding,
  VoiceCredentialControlPort,
} from './voice-credential-control.js'
import type {
  ProviderLifecycleBinding,
  ProviderLifecycleControlPort,
} from './provider-lifecycle-control.js'
import type {
  AgentRunner,
  ApprovalDecision,
  BudgetTracker,
  Gateway,
  GrantScope,
  GrantStore,
  PendingAction,
  Provenance,
  SettingsStore,
  SpendStore,
  TelegramUpdate,
  TurnProgressEvent,
  TurnResult,
  ResolvedWorkBinding,
} from '@aisy/core'
import {
  MAIN_MENU,
  MENU_GREETING,
  STEER_ACK,
  SteerQueue,
  renderCard,
  makeCardButtons,
  decodeCallback,
  renderResolved,
  resolveTap,
  renderEvent,
  resolveMenu,
  renderMenuTour,
  decodeSettingsAction,
  renderAgentScreen,
  decodeAgentCardCallback,
  renderAgentCardCatalog,
  renderAgentCardDetail,
  renderConnectionsScreen,
  renderEnvScreen,
  renderLimitScreen,
  renderBotsScreen,
  renderGoalsScreen,
  renderResearchCard,
  renderGrantsScreen,
  renderListScreen,
  renderServerScreen,
  renderServicePrompt,
  renderSettingsRoot,
  renderSystemScreen,
  renderModeScreen,
  renderTimersScreen,
  renderTimezoneScreen,
  modeStatusLine,
  MODE_TEXT,
  fitLabel,
  fitBody,
  SERVER_ACCESS_OPERATIONS,
  type GoalScreenView,
  type ResearchCardView,
  type ServerAccessOperation,
  type AgentMode,
  type CardCallback,
  type CardContext,
  type InlineButton,
  type LearnedGrantView,
  type MenuAction,
  type ResolutionReason,
  type SettingsScreen,
  type SettingsView,
  type McpCatalogViewEntry,
  type MonitoringStatusView,
  type TokenizedAgentCardCatalog,
  type TokenizedAgentCardDetail,
  type SkillCatalogViewEntry,
  type TapOutcome,
  renderMcpCatalog,
  renderMonitoringStatus,
  renderSkillCatalog,
  ALBUM_QUIET_MS,
  MAX_PARTS,
  STATUS_REFRESH_MS,
  escapeHtml,
  markdownToTelegramHtml,
  splitByParagraph,
} from '@aisy/telegram-gw'
import {
  ingestTelegramAttachmentUpdate,
  type TelegramAttachmentInbox,
} from './telegram-attachment-inbox.js'
import type { TelegramVoiceIngress } from './telegram-voice-ingress.js'
import type { AgentCardLifecycleRuntime } from './agent-card-lifecycle-runtime.js'
import {
  makeTelegramAgentCardState,
  type AgentCardIntent,
  type AgentCardPrincipal,
} from './telegram-agent-card-state.js'
import { TranscriptionUnavailableError } from './transcription-registry.js'
import type { TelegramProjectControls } from './telegram-project-controls.js'
import type {
  TelegramProjectLifecycleControls,
} from './telegram-project-lifecycle-controls.js'
import type { TelegramSessionControls } from './telegram-session-controls.js'
import type { TelegramSkillControls } from './telegram-skill-controls.js'
import type { TelegramMcpControls } from './telegram-mcp-controls.js'
import type {
  TelegramMonitoringControls,
  TelegramMonitoringPrincipal,
  TelegramMonitoringView,
} from './telegram-monitoring-controls.js'
import {
  findServiceKey,
  SERVICE_KEY_CATALOG,
  type ServiceKeyStore,
} from './service-keys.js'

/** Sentinel for "operator types their own NAME=value" instead of a catalogue id. */
const CUSTOM_SERVICE = '\u0000custom'

/**
 * Два ответа, которые бот даёт чаще всего, — одними и теми же словами.
 *
 * Про устаревший экран он раньше говорил семью разными фразами, про
 * неподключённый раздел — одиннадцатью. Разные слова про одно и то же читаются
 * как разные поломки.
 */
const STALE_SCREEN = 'Экран устарел — открой раздел заново.'
const NOT_WIRED = 'Раздел ещё не подключён.'

const SERVICE_KEY_ERRORS: Record<string, string> = {
  VALUE_EMPTY: 'Пустое значение — пришли сам ключ.',
  UNKNOWN_SERVICE: 'Такого сервиса нет в списке.',
  PROTECTED_KEY: 'Эту переменную менять нельзя: на ней держится сам бот.',
  INVALID_KEY_NAME: 'Формат: ИМЯ_ПЕРЕМЕННОЙ=значение, имя заглавными латинскими.',
  NOT_A_KEY: 'Это не похоже на ключ — в ключах не бывает пробелов и кириллицы. Если хотел написать мне, открой /menu.',
  WRONG_PREFIX: 'У этого сервиса ключи начинаются иначе. Проверь, что скопирован нужный.',
  KEY_REJECTED: 'Сервис отклонил ключ. Ничего не сохранил.',
  VAULT_CORRUPT: 'Хранилище секретов повреждено — ничего не записал.',
  PERSISTENCE_FAILED: 'Не удалось записать на диск.',
}
import { makeTelegramReplyStream } from './telegram-reply-stream.js'
import {
  confirmTelegramReplyCheckpointForSupervisorRelease,
  makeTelegramReplyBindingHash,
  makeTelegramReplyCheckpointAuthority,
  type TelegramReplyCheckpointStore,
  type TelegramReplyDeliveryReceiptV1,
} from './telegram-reply-stream-checkpoint.js'
import {
  makeTelegramExecutionStream,
  type TelegramExecutionStream,
} from './telegram-execution-stream.js'
import {
  makeTelegramExecutionBindingHash,
  type TelegramExecutionCheckpointV1,
  type TelegramExecutionCheckpointStore,
} from './telegram-execution-checkpoint.js'
import type {
  TelegramExecutionAuthorityPublisher,
  TelegramExecutionServiceManagerLease,
} from './telegram-execution-startup-recovery.js'
import {
  isGenuineExecutionSupervisorLease,
  type ExecutionSupervisorLease,
  type ExecutionSupervisorReleaseReceiptV1,
} from './execution-supervisor-ipc.js'
import type { RuntimeRestart } from './runtime-restart.js'
import {
  durableTelegramReplyEnvelopeHash,
  durableTelegramReplyReleaseIntentHash,
} from './durable-reply-release.js'
import {
  makeTelegramForwardBatchRuntime,
  type TelegramForwardBatchStateV1,
  type TelegramForwardBatchStore,
} from './telegram-forward-batch.js'

/**
 * Pure helper: given a list of user spans and a memory recall string, returns
 * the combined span list to pass to runner.handle. When mem is empty (no hits /
 * recall skipped) the original spans are returned unchanged. Exported for unit tests.
 */
export function buildSpansWithRecall(
  userSpans: Array<{ role: 'user'; provenance: Provenance; text: string }>,
  mem: string,
  langInstruction = '',
): Array<{ role: 'system' | 'user'; provenance: Provenance; text: string }> {
  const out: Array<{ role: 'system' | 'user'; provenance: Provenance; text: string }> = [...userSpans]
  if (mem.length > 0) {
    out.unshift({ role: 'system', provenance: 'operator', text: 'Релевантное из памяти:\n' + mem })
  }
  // Language instruction goes FIRST so a budget model cannot drift to the
  // English system prompt's language (the recurring English-reply bug).
  if (langInstruction.length > 0) {
    out.unshift({ role: 'system', provenance: 'operator', text: langInstruction })
  }
  return out
}

/** The language signal a message carries, or null when it carries none —
 *  "?", "👍", "42" name no language and must not be read as a switch to English. */
export type LangSignal = 'ru' | 'other'
export function detectLanguage(text: string): LangSignal | null {
  if (/[Ѐ-ӿ]/.test(text)) return 'ru'
  if (/\p{L}/u.test(text)) return 'other'
  return null
}

/** Per-turn reply-language nudge: always reply in the operator's input language.
 *  Cyrillic ⇒ name Russian explicitly (strongest signal for a budget model); any
 *  other input ⇒ a general "match the operator's language" directive. A message
 *  with no letters carries no signal, so it falls back to `sticky` — the last
 *  language the operator actually used — instead of flipping the reply to the
 *  English system prompt's language. */
export function replyLanguageInstruction(text: string, sticky: LangSignal | null = null): string {
  const lang = detectLanguage(text) ?? sticky
  if (lang === 'ru') return 'Отвечай на русском языке.'
  if (lang === 'other') return "Reply in the same language the operator used in their message."
  return ''
}

export async function readTurnRecall(
  recall: ((query: string) => Promise<string>) | undefined,
  query: string,
): Promise<string> {
  if (!recall) return ''
  try {
    return await recall(query)
  } catch (error) {
    if (error instanceof ContextLeaseError) throw error
    return ''
  }
}

export type SessionApprovalFactory = (
  sessionId: string,
) => (action: PendingAction) => Promise<ApprovalDecision>

export interface TelegramTurnRuntime {
  sessionId: string
  runner: AgentRunner
  recall?: (query: string) => Promise<string>
  takeClaimedDone?: () => boolean
  release?: () => Promise<void>
}

export interface TelegramTurnSource {
  updateId: number
  unixSeconds: number
}

export interface TelegramTurnAuthority {
  turnId: string
  turnTs: string
}

export interface TelegramExecutionTurnV1 {
  readonly turnId: string
  readonly turnTs: string
  readonly spans: readonly Readonly<{
    role: 'system' | 'user'
    provenance: Provenance
    text: string
  }>[]
}

export interface TelegramDurableTurnControlV1 {
  isRecoverableInterruption(error: unknown): boolean
  pendingCard(): Readonly<{
    card: Readonly<{
      actorId: string
      revision: number
      actionId: string
      actionHash: string
      cardId: string
      operatorId: string
      chatId: string
      nonce: string
      expiresAtMs: number
    }>
    retryClass: 'retry-once'
  }> | null
  markCardDelivered(input: Readonly<{
    actorId: string
    revision: number
    messageId: string
  }>): unknown
  recordCardDecision(input: Readonly<{
    actorId: string
    operatorId: string
    chatId: string
    messageId: string
    nonce: string
    decision: 'confirmed' | 'rejected'
    stepUpVerified: boolean
  }>): Readonly<{ kind: string }>
  retireTurn(receiptHash: string): unknown
  requestStop(): Readonly<{ kind: 'cancelled' | 'replayed'; receiptHash: string }> |
    null | Promise<Readonly<{ kind: 'cancelled' | 'replayed'; receiptHash: string }> | null>
  requestResume(): void | Promise<void>
}

const DURABLE_TURN_CALLBACK = /^dt:([A-Za-z0-9._-]{1,24}):([A-Za-z0-9_-]{1,32}):([rc])$/

export function encodeDurableTurnCallback(
  actorId: string,
  nonce: string,
  decision: 'retry-once' | 'cancel',
): string {
  const encoded = `dt:${actorId}:${nonce}:${decision === 'retry-once' ? 'r' : 'c'}`
  if (Buffer.byteLength(encoded, 'utf8') > 64 || DURABLE_TURN_CALLBACK.exec(encoded) === null) {
    throw new Error('DURABLE_TURN_CALLBACK_INVALID')
  }
  return encoded
}

export function decodeDurableTurnCallback(value: string): Readonly<{
  actorId: string
  nonce: string
  decision: 'retry-once' | 'cancel'
}> | null {
  const match = DURABLE_TURN_CALLBACK.exec(value)
  if (match === null) return null
  return Object.freeze({
    actorId: match[1]!,
    nonce: match[2]!,
    decision: match[3] === 'r' ? 'retry-once' : 'cancel',
  })
}

/** Derives content-independent retry authority from the exact Telegram batch. */
export function makeTelegramTurnAuthority(
  chatId: number,
  sources: readonly TelegramTurnSource[],
): TelegramTurnAuthority {
  if (!Number.isSafeInteger(chatId) || sources.length === 0 || sources.some(source =>
    !Number.isSafeInteger(source.updateId) || source.updateId < 0 ||
    !Number.isSafeInteger(source.unixSeconds) || source.unixSeconds < 0)) {
    throw new Error('TELEGRAM_TURN_AUTHORITY_INVALID')
  }
  if (new Set(sources.map(source => source.updateId)).size !== sources.length) {
    throw new Error('TELEGRAM_TURN_AUTHORITY_INVALID')
  }
  let earliestSeconds = sources[0]!.unixSeconds
  for (const source of sources) earliestSeconds = Math.min(earliestSeconds, source.unixSeconds)
  const turnDate = new Date(earliestSeconds * 1000)
  if (!Number.isFinite(turnDate.getTime())) throw new Error('TELEGRAM_TURN_AUTHORITY_INVALID')
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'aisy.telegram.turn.v1',
      chatId,
      sources.map(source => source.updateId),
    ]))
    .digest('hex')
  return {
    turnId: `telegram:${chatId}:${digest}`,
    turnTs: turnDate.toISOString(),
  }
}

export async function runTelegramRuntimeTurn(input: {
  runtime: TelegramTurnRuntime
  spans: Array<{ role: 'system' | 'user'; provenance: Provenance; text: string }>
  signal: AbortSignal
  authority?: TelegramTurnAuthority
  onProgress?: (event: TurnProgressEvent) => void | Promise<void>
}): Promise<TurnResult> {
  return input.runtime.runner.handle({
    sessionId: input.runtime.sessionId,
    ...(input.authority === undefined ? {} : input.authority),
    spans: input.spans,
    signal: input.signal,
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  })
}

/** Acquire exactly one runtime for one turn and always release it afterwards. */
export async function withTelegramTurnRuntime<T>(input: {
  acquire?: (approvalForSession: SessionApprovalFactory) => Promise<TelegramTurnRuntime>
  approvalForSession: SessionApprovalFactory
  legacy?: TelegramTurnRuntime
  run: (runtime: TelegramTurnRuntime) => Promise<T>
}): Promise<T> {
  const runtime = input.acquire
    ? await input.acquire(input.approvalForSession)
    : input.legacy
  if (!runtime) throw new Error('TURN_RUNTIME_UNAVAILABLE')
  try {
    if (runtime.sessionId.trim().length === 0) throw new Error('TURN_RUNTIME_INVALID')
    return await input.run(runtime)
  } finally {
    await runtime.release?.()
  }
}

export async function runTelegramBoundGoalTurn(input: {
  binding: ResolvedWorkBinding
  acquire: NonNullable<TelegramBotDeps['acquireBackgroundRuntime']>
  approvalForSession: SessionApprovalFactory
  objective: string
  feedback?: string
  approvalToken?: string
  signal: AbortSignal
}): Promise<{
  result: TurnResult
  claimedDone: boolean
  sessionId: string
}> {
  const text = input.feedback
    ? `${input.objective}\n\n[Контекст прошлой итерации]: ${input.feedback}`
    : input.objective
  return withTelegramTurnRuntime({
    acquire: (approval) => input.acquire(input.binding, approval, { goal: true }),
    approvalForSession: input.approvalForSession,
    run: async (runtime) => ({
      result: await runtime.runner.handle({
        sessionId: runtime.sessionId,
        spans: [{ role: 'user', provenance: 'operator', text }],
        signal: input.signal,
        ...(input.approvalToken === undefined ? {} : { approvalToken: input.approvalToken }),
      }),
      claimedDone: runtime.takeClaimedDone?.() ?? false,
      sessionId: runtime.sessionId,
    }),
  })
}

export interface TelegramBotDeps {
  token: string
  allowedChatId: number
  /** Durable project session id; defaults to the legacy Telegram chat id. */
  sessionId?: string
  gateway: Gateway
  /** Build the legacy static runner given the bot-owned approval port. */
  buildRunner?: (approve: (action: PendingAction) => Promise<ApprovalDecision>) => AgentRunner
  /** Runs only after Telegram confirms terminal delivery; durability is transport-specific. */
  afterReplyDelivered?: (input: Readonly<{
    sessionId: string
    turnId?: string
    result: TurnResult
  }>) => void | Promise<void>
  /** Authenticated operator wording observed for typed communication preferences. */
  observeAuthenticatedOperatorText?: (input: Readonly<{
    text: string
    sessionId: string
    updateId: number
  }>) => void
  /** Selected first-person Russian gender for code-owned Telegram notices. */
  grammaticalGender?: () => 'masculine' | 'feminine' | 'neutral'
  /**
   * Supervised per-turn path. When present, fallback to the legacy runner is
   * forbidden: the runner is built only after checkpoint bind from a genuine
   * held IPC authority.
   */
  buildExecutionRunner?: (
    approve: (action: PendingAction) => Promise<ApprovalDecision>,
    authority: ExecutionSupervisorLease,
    turn: TelegramExecutionTurnV1,
  ) => AgentRunner
  /** Durable ambiguity card/callback facade; callback performs no provider/tool I/O. */
  durableTurnControl?: TelegramDurableTurnControlV1
  /**
   * V2 interactive path: acquire a fresh persisted context/lease/runner for
   * every operator turn. When present, acquisition errors never fall back to
   * the legacy runner.
   */
  acquireTurnRuntime?: (
    approvalForSession: SessionApprovalFactory,
  ) => Promise<TelegramTurnRuntime>
  /** V2 background path: resolves only the supplied durable binding. */
  acquireBackgroundRuntime?: (
    binding: ResolvedWorkBinding,
    approvalForSession: SessionApprovalFactory,
    options?: { goal?: boolean },
  ) => Promise<TelegramTurnRuntime>
  /** Capture a new durable system-session binding at registration time. */
  captureWorkBinding?: () => Promise<ResolvedWorkBinding>
  /** Optional ADR-0060 media ingress. Presence registers attachment handlers;
   *  the default live composition omits it until activation is approved. */
  attachmentInbox?: TelegramAttachmentInbox
  /** Optional exact-bound voice path. It owns private inbox persistence and
   *  Whisper verification; omission is the rollback/disabled state. */
  voiceIngress?: TelegramVoiceIngress
  /** Verified Telegram callback adapter for Workspace/Project selection. */
  projectControls?: TelegramProjectControls
  /** Name of the project this process works in; absent = the shared workspace. */
  activeProjectName?: () => string | undefined
  /** Optional two-step Project/Session archive controls. Omission keeps the
   *  current transport behavior and performs no lifecycle mutation. */
  projectLifecycleControls?: TelegramProjectLifecycleControls
  /** Optional authenticated Session create/rename/search controls. */
  sessionControls?: TelegramSessionControls
  /** Skills folder screen: paging, card, enable/disable, install, delete. */
  skillControls?: TelegramSkillControls
  mcpControls?: TelegramMcpControls
  /** Disable command registration in offline tests; production defaults to enabled. */
  registerCommands?: boolean
  /** Model id shown in the cost summary. */
  model: string
  /** Session budget (USD) for the cost bar; 0 ⇒ no bar fill. */
  budgetUsd?: number
  /** Operator settings — gates the per-turn cost summary (ADR-0050 Phase 2). */
  settings?: SettingsStore
  /** Spend ledger — fed from each turn's usage; viewed on demand in 📡 Монитор. */
  spend?: SpendStore
  /**
   * Bot registry of this installation (ADR-0076). The list shows which bot this
   * process serves; adding one names the env variable, never the token itself.
   */
  bots?: {
    list(): ReadonlyArray<{
      id: string
      name: string
      tokenEnv: string
      chatId: number
      role?: string
      archivedAt?: string
    }>
    activeId(): string | null
    add(input: { name: string; tokenEnv: string; chatId: number; role?: string }): { id: string }
    archive(botId: string): { id: string }
  }
  /**
   * Server access operations (ADR-0086). Only what the operator configured;
   * each call goes through an approval and lands in the audit.
   */
  serverAccess?: {
    available(): readonly string[]
    request(input: {
      operation: 'open-ssh' | 'close-ssh' | 'add-key' | 'remove-key' | 'tunnel'
      provenance: 'operator' | 'untrusted'
      approve: () => Promise<boolean>
      publicKey?: string
    }): Promise<{ operation: string; expiresAt?: string; fingerprint?: string } | string>
  }
  /** Server state for the panel (plan 11.9). */
  serverStatus?: () => string
  /** Called whenever the agent starts or finishes a turn. */
  onAgentState?: (state: 'idle' | 'running') => void
  /**
   * Restart the runtime. Returns a refusal string when it must not happen —
   * nothing would bring the process back, or a turn is still running.
   */
  restartRuntime?: Pick<RuntimeRestart, 'prepare' | 'commitExit' | 'cancel'>
  /**
   * Transcription providers (ADR-0085). The list says of each whether audio
   * leaves the host; choosing one that does is always explicit.
   */
  transcription?: {
    list(): ReadonlyArray<{
      id: string
      label: string
      audioLeavesHost: boolean
      privacyDisclosure?: string
      selected: boolean
    }>
    select(id: string): {
      id: string
      label: string
      audioLeavesHost: boolean
      privacyDisclosure?: string
    }
    /** Null until the operator picked one — voice cannot start before that. */
    selected(): { id: string } | null
  }
  /** Root-owned Deepgram credential control; consent remains in transcription. */
  voiceCredentials?: VoiceCredentialControlPort & Readonly<{
    binding: VoiceCredentialBinding
  }>
  voiceCredentialNowMs?: () => number
  newVoiceCredentialToken?: () => string
  /** Native provider lifecycle: Telegram carries only intent and one-use code. */
  providerCredentials?: Pick<ProviderLifecycleControlPort, 'begin' | 'inspect' | 'revoke'> & Readonly<{
    bindings: readonly ProviderLifecycleBinding[]
  }>
  providerCredentialNowMs?: () => number
  newProviderCredentialToken?: () => string
  /**
   * Execution mode (ADR-0083). The operator switches how much the agent asks;
   * code-owned approvals are unaffected — the mode may only tighten them.
   */
  executionMode?: {
    get(): AgentMode
    set(mode: AgentMode): void
  }
  /**
   * Daily budget state (ADR-0082). When today's cap is reached, a new turn is
   * refused until the date changes — independent of `budgetEnabled`, which
   * governs the cumulative per-agent cap.
   */
  dailyBudget?: {
    paused(): boolean
    state(): { spent: number; cap: number }
    setCap?(dollars: number): unknown
  }
  /** Vault-backed service keys behind the "keys" settings screen. */
  serviceKeys?: ServiceKeyStore
  /** Active brain, for the connections and agent screens. */
  brainSelection?: () => { provider: string; model: string }
  /** Models offered for the active brain; empty hides the switcher. */
  brainModels?: () => readonly string[]
  setBrainModel?: (model: string) => void
  /** Reset the brain choice and hand the process back to setup mode. */
  reconnectBrain?: () => Promise<void>
  /** Create a session and make it current; the process restarts into it. */
  startNewSession?: () => Promise<
    { ok: true; name: string } | { ok: false; errorCode: string }
  >
  /** Enter an existing session of the active project; the bot restarts into it. */
  resumeSession?: (sessionId: string) => Promise<
    { ok: true } | { ok: false; errorCode: string }
  >
  /** Create a project folder, register it and select it. */
  createProject?: (name: string) => Promise<
    { ok: true; name: string; root: string } | { ok: false; error: string }
  >
  /** Per-agent budget tracker; when settings.budgetEnabled, a turn is refused
   *  once the main agent is over its cap (ADR-0050 Phase 3). */
  budget?: BudgetTracker
  /** Mirror the loop's narrowed state to the gateway egress guard (ADR-0051). */
  /**
   * Mirrors the loop's narrowing verdict for the tool path. It no longer holds
   * replies: the reply-side lockout is off by decision (ADR-0095).
   */
  setUntrustedContext?: (untrusted: boolean) => void
  now?: () => string
  /** Debounce window for coalescing a rapid message burst. Default 1200ms. */
  debounceMs?: number
  /** Minimum delay between Telegram streaming edits. Default 250ms. */
  streamEditIntervalMs?: number
  /** Optional durable redacted execution-card projection. Omission keeps the
   *  current rollback path and performs no checkpoint filesystem writes. */
  executionCheckpoint?: {
    store: TelegramExecutionCheckpointStore
    newOwnerId: () => string
    nowIso?: () => string
    /** External service-manager authority; captures only the opaque binding. */
    authority?: TelegramExecutionAuthorityPublisher
  }
  /** Durable final-reply proof used only with a genuine supervisor lease. */
  durableReply?: {
    store: TelegramReplyCheckpointStore
    binding: ResolvedWorkBinding
    consumeReleaseReceipt(receipt: ExecutionSupervisorReleaseReceiptV1): Promise<void>
    newOwnerId(): string
    nowIso?: () => string
  }
  /** Quiet window before one Telegram album acknowledgement. Default 500ms. */
  mediaGroupDebounceMs?: number
  /** Durable forwarded-message coalescing. Omission preserves the legacy
   *  generic text debounce; production composition supplies a private store. */
  forwardBatch?: {
    store: TelegramForwardBatchStore
    quietMs?: number
    maxItems?: number
    maxBytes?: number
    nowMs?: () => number
  }
  debug?: boolean
  /** Trigger an immediate nightly consolidation run (Tier-4 C2). */
  onConsolidate?: () => Promise<void>
  /** Return the current staging area — decoupled shape, no nightly types (Tier-4 C2). */
  getStaging?: () => Promise<{ id: string; preview: string; judged: boolean }[]>
  /** Promote a staged memory patch by id (Tier-4 C2). */
  onApproveNightly?: (stagedItemId: string) => Promise<void>
  /** Register a new trigger — decoupled shape, no trigger types (Tier-4 D2). */
  onRegisterTrigger?: (input: {
    binding: ResolvedWorkBinding
    kind: 'remind' | 'schedule' | 'watch'
    prompt: string
    when?: string
    cron?: string
    probe?: string
  }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
  /** List active triggers — decoupled shape (Tier-4 D2). */
  onListTriggers?: () => Promise<{ id: string; kind: string; prompt: string }[]>
  /** Cancel a trigger by id — returns true if found (Tier-4 D2). */
  onCancelTrigger?: (id: string) => Promise<boolean>
  /** Turn on a trigger the agent set for itself (ADR-0029) — true if found. */
  onConfirmTrigger?: (id: string) => Promise<boolean>
  /** Build a goal-scoped runner whose executeTool detects goal_done; takeClaimedDone()
   *  reads + resets the per-turn flag. Absent ⇒ goals fall back to the main runner (no detection). */
  buildGoalRunner?: (approve: (action: PendingAction) => Promise<ApprovalDecision>) => { runner: AgentRunner; takeClaimedDone: () => boolean }
  /** Handle a /goal command — decoupled; no goal types leak into bot (Tier-7 D).
   *  `status` also carries the screen projection, so 🎯 Цели renders progress
   *  instead of re-parsing the sentence written for the command. */
  onGoalCommand?: (input:
    | { kind: 'start'; binding: ResolvedWorkBinding; objective: string; mode: string }
    | { kind: 'status' }
    | { kind: 'stop' }
  ) => Promise<
    | { ok: true; message: string; goal?: GoalScreenView }
    | { ok: false; error: string }
  >
  /** Active capability grants — list and bulk-reset (ADR-0047 tail). */
  grants?: Pick<GrantStore, 'list' | 'revokeAll'>
  /**
   * Выученная автономность (спека 24): что агент перестал спрашивать, набрав
   * доказательства, и как это снять. Отсутствие порта означает, что обучения в
   * этой сборке нет — экран показывает только ручные разрешения.
   */
  learnedGrants?: {
    list(): readonly LearnedGrantView[]
    revoke(workflowKey: string): void
  }
  /** Session log — renders recent sessions in 💬 Сессии menu (Task 13). */
  sessionLog?: { recent?(n: number): { sessionId: string; turns: number; lastAt: string }[] }
  /** Skill menu entries — renders 🧩 Навыки menu (Task 13). */
  skillsMenu?: () => SkillCatalogViewEntry[]
  /** Agent card for the main agent — renders 🧠 Агент menu (Task 13). */
  agentCard?: () => { name: string; description: string; skills: string[] }
  /** Durable revision lifecycle behind the opt-in main AgentCard cutover. */
  agentCards?: AgentCardLifecycleRuntime
  /** Test seams for process-local AgentCard callback/form state. */
  newAgentCardToken?: () => string
  agentCardNowMs?: () => number
  /** Validated MCP policy projection; configured entries may remain inactive. */
  mcpMenu?: () => McpCatalogViewEntry[]
  /** Aggregate monitoring state; never includes source locators or collected content. */
  monitoringStatus?: () => MonitoringStatusView
  /** Exact-bound RSS/Web source catalogue and lifecycle. */
  monitoringControls?: TelegramMonitoringControls
  /**
   * Per-turn memory recall probe. Called once per turn on the first operator
   * span; the result is prepended as a trusted system span so the model sees
   * relevant facts without a tool call. Absent or returning '' ⇒ no injection.
   * A failure (thrown promise) is swallowed — recall is best-effort.
   */
  recall?: (query: string) => Promise<string>
}

export type TelegramNightlyNotice =
  | { kind: 'session-only'; sessionReset: true }
  | { kind: 'complete-zero'; sessionReset: boolean }
  | { kind: 'complete-n'; sessionReset: boolean; pending: number }
  | {
      kind: 'partial-failure'
      sessionReset: boolean
      pending: number
      failedProjects: number
    }

interface PendingCard {
  resolve: (decision: ApprovalDecision) => void
  action: PendingAction
  chatId: number
  messageId: number
}

function toInlineKeyboard(rows: InlineButton[][]): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const [index, row] of rows.entries()) {
    if (index > 0) kb.row()
    for (const b of row) kb.text(b.text, b.data)
  }
  return kb
}

/** Stopping a running turn was a typed command only; the card carries it now. */
const TURN_STOP_DATA = 'turn:stop'
const stopKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text('⏹ Остановить', TURN_STOP_DATA)

/** The catalog refuses a larger SKILL.md anyway; stop before downloading it. */
const MAX_SKILL_DOCUMENT_BYTES = 256 * 1024

/**
 * Read a small Telegram file as text. The path comes from Telegram, so each
 * segment is encoded and traversal segments are refused before it is spliced
 * into the download URL.
 */
async function downloadTelegramText(
  token: string,
  file: { file_path?: string | undefined; file_size?: number | undefined },
): Promise<string> {
  const path = file.file_path ?? ''
  const parts = path.split('/')
  if (path.length === 0 || path.startsWith('/') ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error('unsafe telegram file path')
  }
  if ((file.file_size ?? 0) > MAX_SKILL_DOCUMENT_BYTES) throw new Error('file too large')
  const response = await fetch(
    `https://api.telegram.org/file/bot${token}/${parts.map(encodeURIComponent).join('/')}`,
    { redirect: 'error' },
  )
  if (!response.ok) throw new Error('download failed')
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > MAX_SKILL_DOCUMENT_BYTES) throw new Error('file too large')
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function russianFileWord(count: number): 'файл' | 'файла' | 'файлов' {
  const mod100 = count % 100
  if (mod100 >= 11 && mod100 <= 14) return 'файлов'
  const mod10 = count % 10
  if (mod10 === 1) return 'файл'
  if (mod10 >= 2 && mod10 <= 4) return 'файла'
  return 'файлов'
}

function mainMenuKeyboard(): Keyboard {
  const kb = new Keyboard()
  MAIN_MENU.forEach((row, index) => {
    for (const b of row) kb.text(b.label)
    // `row()` after the last row would leave an empty one in the markup.
    if (index < MAIN_MENU.length - 1) kb.row()
  })
  return kb.resized()
}

export function resolveTelegramSessionId(allowedChatId: number, sessionId?: string): string {
  return sessionId ?? String(allowedChatId)
}

export function makeTelegramBot(deps: TelegramBotDeps) {
  const now = deps.now ?? ((): string => new Date().toISOString())
  const debounceMs = deps.debounceMs ?? 1200
  const mediaGroupDebounceMs = deps.mediaGroupDebounceMs ?? ALBUM_QUIET_MS
  if (!Number.isSafeInteger(mediaGroupDebounceMs) || mediaGroupDebounceMs < 0 ||
    mediaGroupDebounceMs > 5000) {
    throw new Error('INVALID_MEDIA_GROUP_DEBOUNCE')
  }
  const sessionId = resolveTelegramSessionId(deps.allowedChatId, deps.sessionId)
  const bot = new Bot(deps.token)

  // Without this grammY rethrows, the rejection reaches `uncaughtException`,
  // and the whole agent exits — one message with an unlucky character has
  // already done exactly that in production (a `<имя>` in an answer: 400 «can't
  // parse entities»). One update failing is not a reason to stop answering the
  // next one. The supervisor still handles real crashes; this handles the
  // ordinary ones, and says so in the chat rather than dying silently.
  bot.catch(async (error) => {
    const detail = error.error instanceof Error ? error.error.message : String(error.error)
    process.stderr.write(`aisy bot: ход не доставлен: ${detail}\n`)
    try {
      // Plain text: the failure may well *be* the HTML parser, so a reply that
      // needs parsing could fail the same way and lose the report too.
      await bot.api.sendMessage(
        deps.allowedChatId,
        '⚠️ Не смог доставить ответ на это сообщение. Попробуй ещё раз — я на месте.',
      )
    } catch { /* the chat is unreachable; the log above is the record */ }
  })

  // The command list is a shop window, not the feature set: every command below
  // keeps its handler whether or not it is advertised. Two entries is the whole
  // window, because everything else lives on the keyboard the menu opens — and
  // an eighteen-line list on a phone is a wall, not a way in.
  //
  // The deletes come first and cover the narrower scopes: a stale list left by
  // whoever held this token before (BotFather, another agent) outranks the
  // default scope, so setting the default alone would leave their commands on
  // screen. Every call is best-effort — none of it may block startup.
  if (deps.registerCommands !== false) {
    void (async () => {
      for (const scope of [
        { type: 'all_private_chats' } as const,
        { type: 'chat' as const, chat_id: deps.allowedChatId },
      ]) {
        await bot.api.deleteMyCommands({ scope }).catch(() => {})
      }
      await bot.api.setMyCommands([
        { command: 'start', description: 'Меню' },
        { command: 'menu', description: 'Меню' },
      ])
    })().catch((e: unknown) => {
      process.stderr.write(`aisy bot: setMyCommands failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`)
    })
  }

  const pending = new Map<string, PendingCard>()
  const voiceCredentialNowMs = deps.voiceCredentialNowMs ?? (() => Date.now())
  const newVoiceCredentialToken = deps.newVoiceCredentialToken ??
    (() => randomBytes(12).toString('base64url'))
  const pendingVoiceRevocations = new Map<string, Readonly<{
    chatId: number
    userId: number
    messageId: number
    expiresAtMs: number
  }>>()
  const providerCredentialNowMs = deps.providerCredentialNowMs ?? (() => Date.now())
  const newProviderCredentialToken = deps.newProviderCredentialToken ??
    (() => randomBytes(18).toString('base64url'))
  const pendingProviderRevocations = new Map<string, Readonly<{
    chatId: number
    userId: number
    messageId: number
    expiresAtMs: number
    binding: ProviderLifecycleBinding
  }>>()
  const agentCardState = makeTelegramAgentCardState({
    nowMs: deps.agentCardNowMs ?? (() => Date.now()),
    newToken: deps.newAgentCardToken ?? (() => randomBytes(12).toString('base64url')),
  })

  // --- turn-flow state (Hermes coalescing + steering) ---
  let agentStateValue: 'idle' | 'running' = 'idle'
  const agentStateHolder = {
    get value(): 'idle' | 'running' { return agentStateValue },
    set value(next: 'idle' | 'running') {
      agentStateValue = next
      try {
        deps.onAgentState?.(next)
      } catch { /* an observer must not break the turn */ }
    },
  }
  let buffered: Array<{
    text: string
    provenance: Provenance
    source: TelegramTurnSource
  }> = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let forwardFlushTimer: ReturnType<typeof setTimeout> | null = null
  let forwardProgressTail: Promise<void> = Promise.resolve()
  const steer = new SteerQueue<TelegramTurnSource>()
  // A Tier-3 card awaiting a step-up code typed as the next message.
  let pendingStepUp: { cb: CardCallback; card: PendingCard } | null = null
/**
 * Service id (or CUSTOM_SERVICE) whose key the next plain message carries, and
 * when that expectation goes stale. Without the deadline an operator who taps a
 * service and then forgets has their next ordinary message swallowed as a key
 * — and deleted from the chat.
 */
let pendingServiceKey: string | null = null
let pendingServiceKeyUntilMs = 0
const SERVICE_KEY_PROMPT_TTL_MS = 5 * 60_000
/** Same shape for the project name: a prompt that never expires eats a message. */
let pendingProjectName = false
let pendingProjectNameUntilMs = 0
const PROJECT_NAME_PROMPT_TTL_MS = 5 * 60_000
/** And for a model name typed by hand, when the catalogue has no list. */
let pendingModelName = false
let pendingModelNameUntilMs = 0
/** The next plain message is an MCP server line, until this deadline passes. */
let pendingMcpServer = false
let pendingMcpServerUntilMs = 0
/**
 * A form opened from a screen: the next plain message is its one answer. Same
 * deadline rule as the prompts above — an expectation that never expires eats
 * an ordinary message.
 */
let pendingForm:
  | { kind: 'bot' }
  | { kind: 'access-key'; operation: 'add-key' | 'remove-key' }
  | null = null
let pendingFormUntilMs = 0
  // The input of the last failed turn, offered back under its error card.
  // Only a literal span list is kept: a thunk source may have consumed a
  // one-shot resource (a downloaded voice file, an inbox entry), so replaying it
  // would either fail or import the same attachment twice. The message id binds
  // the offer to that one card, so an older error cannot start a new turn.
  let pendingRetry:
    | { spans: { text: string; provenance: Provenance }[]; messageId: number }
    | null = null
  // A goal the agent proposed and the operator has not answered yet. Bound to
  // its own card: an older proposal must not start work from a stale tap.
  let pendingGoal: { objective: string; mode: string; messageId: number } | null = null
  // The live goal card, edited in place while the goal runs. Null between
  // goals: a finished card stays in the chat as the report of what happened.
  let goalCard: { messageId: number; html: string } | null = null
  // The running research's heartbeat card — same lifecycle as goalCard.
  let researchCard: { messageId: number; html: string } | null = null
  // The in-flight turn's abort controller; /stop fires it for a hard-kill.
  let currentAbort: AbortController | null = null
  let restartPending = false
  // The last language the operator actually used; a letterless message ("?") keeps it.
  let lastLang: LangSignal | null = null
  // The menu keyboard rides on the next message this bot sends and is then
  // consumed: Telegram keeps a reply keyboard client-side until it is replaced,
  // so it has to be attached exactly once, not on every reply.
  let pendingMenuKeyboard = false
  const mediaGroups = new Map<string, {
    binding: Promise<ResolvedWorkBinding>
    tail: Promise<void>
    received: number
    savedFileIds: string[]
    failed: number
    timer: ReturnType<typeof setTimeout> | null
  }>()

  // Single-operator allowlist: silently drop anything off the allowed chat.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.id !== deps.allowedChatId) return
    await next()
  })

  const approvalForSession: SessionApprovalFactory = (approvalSessionId) =>
    (action: PendingAction): Promise<ApprovalDecision> => new Promise<ApprovalDecision>((resolve) => {
      const ctxCard: CardContext = { sessionId: approvalSessionId }
      void (async () => {
        try {
          const cardId = await deps.gateway.issueCard(action)
          const view = deps.gateway.getIssuedCard(cardId)
          if (!view) {
            resolve({ decision: 'rejected' })
            return
          }
          const body = renderCard(action, ctxCard)
          const kb = toInlineKeyboard(makeCardButtons(action, cardId, view.nonce))
          const sent = await bot.api.sendMessage(deps.allowedChatId, body.html, {
            parse_mode: 'HTML',
            reply_markup: kb,
          })
          pending.set(cardId, { resolve, action, chatId: deps.allowedChatId, messageId: sent.message_id })
        } catch {
          resolve({ decision: 'rejected' })
        }
      })()
    })

  const legacyApprove = approvalForSession(sessionId)
  const legacyRunner = deps.acquireTurnRuntime ? undefined : deps.buildRunner?.(legacyApprove)
  if (!legacyRunner && !deps.acquireTurnRuntime) throw new Error('TURN_RUNTIME_UNAVAILABLE')
  const goal = deps.acquireTurnRuntime
    ? null
    : deps.buildGoalRunner
    ? deps.buildGoalRunner(legacyApprove)
    : legacyRunner
      ? { runner: legacyRunner, takeClaimedDone: (): boolean => false }
      : null
  const legacyTurnRuntime: TelegramTurnRuntime | undefined = legacyRunner
    ? {
        sessionId,
        runner: legacyRunner,
        ...(deps.recall === undefined ? {} : { recall: deps.recall }),
      }
    : undefined

  const guardReply = async (text: string): Promise<void> => {
    async function* token(): AsyncIterable<string> { yield text }
    await deps.gateway.streamReply(deps.allowedChatId, token())
  }

  /**
   * Markup for the next outgoing message when the menu is still owed. The very
   * first thing a new operator sees is the agent writing first, and the menu
   * has to arrive with it — telling someone the menu is "below" while nothing
   * is below is worse than not mentioning it.
   */
  const takeMenuKeyboard = (): { reply_markup: Keyboard } | Record<string, never> => {
    if (!pendingMenuKeyboard) return {}
    pendingMenuKeyboard = false
    return { reply_markup: mainMenuKeyboard() }
  }

  const sendReply = async (text: string, operatorApproved = false): Promise<void> => {
    if (!operatorApproved) await guardReply(text)
    const body = text.length > 0 ? text : '(пустой ответ)'

    // A long answer is split on paragraph boundaries rather than truncated —
    // up to a point. Past MAX_PARTS it is a wall of text, and a file reads
    // better than a burst of messages.
    const parts = splitByParagraph(body)
    if (parts.length > 1 && parts.length <= MAX_PARTS) {
      for (const part of parts) {
        await bot.api.sendMessage(deps.allowedChatId, markdownToTelegramHtml(part), {
          parse_mode: 'HTML',
          ...takeMenuKeyboard(),
        })
      }
      return
    }

    const fitted = fitBody(body)
    await bot.api.sendMessage(deps.allowedChatId, fitted.text, {
      parse_mode: 'HTML',
      ...takeMenuKeyboard(),
    })
    if (fitted.document) {
      await bot.api.sendDocument(
        deps.allowedChatId,
        new InputFile(Buffer.from(fitted.document.content, 'utf8'), fitted.document.filename),
      )
    }
  }

  const sendCostSummary = async (
    usage: { inputTokens: number; outputTokens: number; dollars: number },
    turnSessionId: string,
  ): Promise<void> => {
    const msg = renderEvent({
      kind: 'cost.summary',
      sessionId: turnSessionId,
      tokensIn: usage.inputTokens,
      tokensOut: usage.outputTokens,
      dollars: usage.dollars,
      limitUsd: deps.budgetUsd ?? 0,
      model: deps.model,
    })
    if (msg) await bot.api.sendMessage(deps.allowedChatId, msg.html, { parse_mode: 'HTML' })
  }

  const sendPanel = async (
    msg: { html: string; buttons?: InlineButton[][] } | null,
  ): Promise<void> => {
    if (!msg) return
    await bot.api.sendMessage(deps.allowedChatId, msg.html, {
      parse_mode: 'HTML',
      ...(msg.buttons ? { reply_markup: toInlineKeyboard(msg.buttons) } : {}),
    })
  }

  const sendSettingsView = async (view: SettingsView, edit?: {
    messageId: number
  }): Promise<void> => {
    const reply_markup = { inline_keyboard: view.buttons.map((row) =>
      row.map((item) => ({ text: item.text, callback_data: item.data }))) }
    if (edit) {
      await bot.api.editMessageText(deps.allowedChatId, edit.messageId, view.text, {
        parse_mode: 'HTML', reply_markup,
      }).catch(() => {})
      return
    }
    await bot.api.sendMessage(deps.allowedChatId, view.text, {
      parse_mode: 'HTML', reply_markup,
    })
  }

  const agentCardMarkup = (view: SettingsView) => ({
    inline_keyboard: view.buttons.map(row => row.map(item => ({
      text: item.text,
      callback_data: item.data,
    }))),
  })

  const sendAgentCardCatalog = async (
    principal: AgentCardPrincipal,
    pages: Readonly<{ workspacePage: number; projectPage: number }> = {
      workspacePage: 0, projectPage: 0,
    },
    editMessageId?: number,
  ): Promise<void> => {
    const lifecycle = deps.agentCards
    if (!lifecycle) {
      await bot.api.sendMessage(principal.chatId, 'Реестр личностей не подключён.')
      return
    }
    const catalog = lifecycle.catalog()
    const intents: AgentCardIntent[] = []
    const add = (intent: AgentCardIntent): number => {
      intents.push(intent)
      return intents.length - 1
    }
    const makePage = (
      entries: typeof catalog.workspace,
      requestedPage: number,
      otherPage: number,
      project: boolean,
    ) => {
      const totalPages = Math.max(1, Math.ceil(entries.length / 8))
      const pageIndex = Math.min(Math.max(0, requestedPage), totalPages - 1)
      const slice = entries.slice(pageIndex * 8, pageIndex * 8 + 8)
      const mapped = slice.map(entry => ({
        entry,
        callback: add({ kind: 'select', target: { binding: entry.binding, name: entry.name } }),
      }))
      const previous = pageIndex > 0
        ? add({
          kind: 'page',
          workspacePage: project ? otherPage : pageIndex - 1,
          projectPage: project ? pageIndex - 1 : otherPage,
        })
        : null
      const next = pageIndex + 1 < totalPages
        ? add({
          kind: 'page',
          workspacePage: project ? otherPage : pageIndex + 1,
          projectPage: project ? pageIndex + 1 : otherPage,
        })
        : null
      return { pageIndex, totalPages, mapped, previous, next }
    }
    const workspace = makePage(catalog.workspace, pages.workspacePage, pages.projectPage, false)
    const project = catalog.projectScopeAvailable
      ? makePage(catalog.project, pages.projectPage, workspace.pageIndex, true)
      : null
    const createWorkspace = add({ kind: 'create', binding: { scope: 'workspace' } })
    const importWorkspace = catalog.legacyImportAvailable
      ? add({ kind: 'import', binding: { scope: 'workspace' } })
      : null
    const createProject = catalog.currentBinding.scope === 'project'
      ? add({ kind: 'create', binding: catalog.currentBinding })
      : null
    const importProject = catalog.currentBinding.scope === 'project' && catalog.legacyImportAvailable
      ? add({ kind: 'import', binding: catalog.currentBinding })
      : null
    const prepared = agentCardState.prepare({ principal, intents })
    const token = (index: number): string => prepared.callbacks[index]!.token
    const pageProjection = (page: typeof workspace) => ({
      page: page.pageIndex + 1,
      totalPages: page.totalPages,
      entries: page.mapped.map(({ entry, callback }) => ({
        name: entry.name,
        activeRevision: entry.activeRevision,
        latestRevision: entry.latestRevision,
        latestHashPrefix: entry.latestHashPrefix,
        latestStatus: entry.latestStatus,
        selectToken: token(callback),
      })),
      ...(page.previous === null ? {} : { previousToken: token(page.previous) }),
      ...(page.next === null ? {} : { nextToken: token(page.next) }),
    })
    const projection: TokenizedAgentCardCatalog = {
      configuredName: catalog.configuredName,
      cutoverActive: catalog.cutoverActive,
      workspace: pageProjection(workspace),
      ...(project === null ? {} : { project: pageProjection(project) }),
      createWorkspaceToken: token(createWorkspace),
      ...(importWorkspace === null ? {} : { importWorkspaceToken: token(importWorkspace) }),
      ...(createProject === null ? {} : { createProjectToken: token(createProject) }),
      ...(importProject === null ? {} : { importProjectToken: token(importProject) }),
    }
    const view = renderAgentCardCatalog(projection)
    if (editMessageId !== undefined) {
      prepared.bind(editMessageId)
      await bot.api.editMessageText(principal.chatId, editMessageId, view.text, {
        parse_mode: 'HTML', reply_markup: agentCardMarkup(view),
      }).catch(() => {})
      return
    }
    try {
      const sent = await bot.api.sendMessage(principal.chatId, view.text, {
        parse_mode: 'HTML', reply_markup: agentCardMarkup(view),
      })
      prepared.bind(sent.message_id)
    } catch (error) {
      prepared.discard()
      throw error
    }
  }

  const sendAgentCardDetail = async (
    principal: AgentCardPrincipal,
    target: Parameters<AgentCardLifecycleRuntime['detail']>[0],
    editMessageId: number,
  ): Promise<void> => {
    if (!deps.agentCards) return
    const detail = deps.agentCards.detail(target)
    const intents: AgentCardIntent[] = []
    const add = (intent: AgentCardIntent): number => {
      intents.push(intent)
      return intents.length - 1
    }
    const publish = add({ kind: 'publish', target: detail.target })
    const archive = detail.active === null ? null : add({ kind: 'archive', target: detail.target })
    const rollbackAvailable = detail.history.length > 0 &&
      (detail.active === null || detail.active.revision > 1)
    const rollback = rollbackAvailable ? add({ kind: 'rollback', target: detail.target }) : null
    const catalog = add({ kind: 'catalog', workspacePage: 0, projectPage: 0 })
    const prepared = agentCardState.prepare({ principal, intents })
    const token = (index: number): string => prepared.callbacks[index]!.token
    const view = renderAgentCardDetail({
      name: detail.target.name,
      scopeLabel: detail.target.binding.scope === 'workspace' ? 'Общая папка' : 'Текущий проект',
      active: detail.active,
      history: detail.history,
      catalogToken: token(catalog),
      publishToken: token(publish),
      ...(archive === null ? {} : { archiveToken: token(archive) }),
      ...(rollback === null ? {} : { rollbackToken: token(rollback) }),
    } satisfies TokenizedAgentCardDetail)
    prepared.bind(editMessageId)
    await bot.api.editMessageText(principal.chatId, editMessageId, view.text, {
      parse_mode: 'HTML', reply_markup: agentCardMarkup(view),
    }).catch(() => {})
  }

  const brainSelection = (): { provider: string; model: string } =>
    deps.brainSelection?.() ?? { provider: '—', model: deps.model }

  const settingsScreen = async (screen: SettingsScreen): Promise<SettingsView> => {
    switch (screen) {
      case 'connections':
        return renderConnectionsScreen(brainSelection())
      case 'env': {
        const connected = new Set(deps.serviceKeys?.connected() ?? [])
        return renderEnvScreen({
          services: SERVICE_KEY_CATALOG.map((entry) => ({
            id: entry.id,
            label: entry.label,
            purpose: entry.purpose,
            connected: connected.has(entry.id),
          })),
        })
      }
      case 'bots': {
        const list = deps.bots?.list() ?? []
        const active = deps.bots?.activeId() ?? null
        return renderBotsScreen({
          body: list.length === 0
            ? `Отвечает @${bot.botInfo.username} — единственный бот этой установки.`
            : `Отвечает @${bot.botInfo.username}.\n\n` + list.map((record) =>
                `${record.id === active ? '▶' : '·'} ${record.name}` +
                (record.role === undefined ? '' : ` · ${record.role}`) +
                `\n   чат ${record.chatId} · токен из ${record.tokenEnv}`).join('\n'),
        })
      }
      case 'timers':
        return renderTimersScreen({ timers: (await deps.onListTriggers?.()) ?? [] })
      case 'limit': {
        const state = deps.dailyBudget?.state()
        return renderLimitScreen({
          currentUsd: state?.cap ?? 0,
          spentUsd: state?.spent ?? 0,
        })
      }
      case 'server': {
        // The runtime's list is config-derived text; only operations this view
        // knows how to label become buttons.
        const access = (deps.serverAccess?.available() ?? [])
          .filter((operation): operation is ServerAccessOperation =>
            (SERVER_ACCESS_OPERATIONS as readonly string[]).includes(operation))
        return renderServerScreen({
          body: deps.serverStatus?.() ?? 'Состояние сервера недоступно.',
          ...(access.length === 0 ? {} : { access }),
        })
      }
      case 'system': {
        const settings = deps.settings?.get()
        return renderSystemScreen({
          voice: (deps.transcription?.list() ?? []).map((provider) => ({
            id: provider.id, label: provider.label, selected: provider.selected,
          })),
          showCostPerTurn: settings?.showCostPerTurn ?? false,
          budgetEnabled: settings?.budgetEnabled ?? false,
          debug: settings?.debug ?? false,
          timeZone: settings?.timeZone ?? '',
        })
      }
      case 'grants':
        return renderGrantsScreen({
          body: grantsText(),
          ...(deps.learnedGrants === undefined
            ? {}
            : { learned: deps.learnedGrants.list() }),
        })
      case 'goals': {
        const status = await deps.onGoalCommand?.({ kind: 'status' })
        return renderGoalsScreen(
          status?.ok === true && status.goal !== undefined ? { goal: status.goal } : {},
        )
      }
      case 'timezone':
        return renderTimezoneScreen({
          timeZone: deps.settings?.get().timeZone ?? '',
          // The clock as the operator would read it there — the fastest way to
          // recognise your own zone without knowing its IANA name.
          sample: (timeZone) => wallClockIso(new Date().toISOString(), timeZone).slice(11, 16),
        })
      case 'agent': {
        const selection = brainSelection()
        return renderAgentScreen({
          ...selection,
          mode: deps.executionMode?.get() ?? 'auto',
          models: deps.brainModels?.() ?? [],
          memory: deps.onConsolidate !== undefined || deps.getStaging !== undefined,
          agentCards: deps.agentCards !== undefined,
        })
      }
      case 'mode':
        return renderModeScreen({ mode: deps.executionMode?.get() ?? 'auto' })
      case 'agent-cards': {
        return renderListScreen({ title: '🧬 Личности', body: 'Открой каталог заново.' })
      }
      default:
        return renderSettingsRoot()
    }
  }

  const settingsPanel = (): { html: string; buttons?: InlineButton[][] } | null => {
    const st = deps.settings?.get() ?? { showCostPerTurn: false, budgetEnabled: false, debug: false }
    return renderEvent({ kind: 'settings.panel', showCostPerTurn: st.showCostPerTurn, budgetEnabled: st.budgetEnabled, debug: st.debug })
  }

  const sendSpendReport = async (): Promise<void> => {
    const rows = (deps.spend?.byModel() ?? []).map((r) => ({
      model: r.model,
      tokensIn: r.inputTokens,
      tokensOut: r.outputTokens,
      dollars: r.dollars,
    }))
    const totalUsd = deps.spend?.total().dollars ?? 0
    const perAgent = (deps.spend?.byAgent() ?? []).map((a) => ({ agentId: a.agentId, dollars: a.dollars }))
    await sendPanel(renderEvent({ kind: 'spend.report', rows, totalUsd, ...(perAgent.length > 0 ? { perAgent } : {}) }))
  }

  /** Reached from the menu and from the sessions screen; one behaviour either way. */
  const startNewSessionFromButton = async (): Promise<void> => {
    if (!deps.startNewSession) {
      await bot.api.sendMessage(deps.allowedChatId, NOT_WIRED)
      return
    }
    const result = await deps.startNewSession()
    if (!result.ok) {
      await bot.api.sendMessage(deps.allowedChatId, `❌ Не удалось начать сессию (${result.errorCode}).`)
      return
    }
    await bot.api.sendMessage(
      deps.allowedChatId,
      `🆕 Новая сессия «${result.name}». Перезапускаюсь, чтобы разговор начался с чистого листа — память о тебе остаётся.`,
    )
    await runRestart('новая сессия', (message) =>
      bot.api.sendMessage(deps.allowedChatId, message))
  }

  /** The sessions screen, reached both from the menu and from a project card. */
  const sendSessionsScreen = async (): Promise<void> => {
    if (!deps.sessionControls) {
      await bot.api.sendMessage(deps.allowedChatId, NOT_WIRED)
      return
    }
    const view = deps.sessionControls.open()
    await bot.api.sendMessage(deps.allowedChatId, view.text, {
      ...(view.buttons.length === 0 ? {} : { reply_markup: toInlineKeyboard(view.buttons) }),
    })
  }

  bot.command('resume', async (ctx) => {
    const rawPrefix = (ctx.match ?? '').trim().replace(/^#/u, '')
    if (rawPrefix.length === 0) {
      await sendSessionsScreen()
      return
    }
    if (!deps.sessionControls || !deps.resumeSession) {
      await ctx.reply(NOT_WIRED)
      return
    }
    const target = deps.sessionControls.resolvePrefix(rawPrefix)
    if (target.kind === 'unknown') {
      await ctx.reply('Сессия с таким префиксом не найдена. /resume покажет список.')
      return
    }
    if (target.kind === 'ambiguous') {
      await ctx.reply('Префикс неоднозначен. /resume покажет список с более длинными id.')
      return
    }
    if (target.kind === 'current') {
      await ctx.reply('Это и есть текущая сессия.')
      return
    }
    const result = await deps.resumeSession(target.sessionId)
    if (!result.ok) {
      await ctx.reply(result.errorCode === 'ALREADY_ACTIVE'
        ? 'Это и есть текущая сессия.'
        : 'Не удалось вернуться в эту сессию.')
      return
    }
    await ctx.reply(`↩️ Возвращаюсь в сессию «${target.name}».`)
    await runRestart('возврат в сессию', (message) => ctx.reply(message))
  })

  const handleMenu = async (action: MenuAction): Promise<void> => {
    deps.monitoringControls?.cancelForm()
    if (action === 'projects') {
      if (!deps.projectControls) {
        await bot.api.sendMessage(deps.allowedChatId, NOT_WIRED)
        return
      }
      try {
        const view = await deps.projectControls.open()
        await bot.api.sendMessage(deps.allowedChatId, view.text, {
          reply_markup: toInlineKeyboard(view.buttons),
        })
      } catch {
        await bot.api.sendMessage(deps.allowedChatId, '❌ Не удалось открыть список проектов.')
      }
    } else if (action === 'settings') {
      await sendSettingsView(renderSettingsRoot())
    } else if (action === 'monitor') {
      if (deps.monitoringStatus === undefined) await sendSpendReport()
      else {
        // The money lives one tap away rather than behind `/spend`: a report
        // nobody can reach from a phone is a report nobody reads.
        const keyboard = new InlineKeyboard()
        if (deps.monitoringControls !== undefined) keyboard.text('🔭 Источники', 'monitoring:open')
        keyboard.text('💰 Расходы', 'spend:refresh')
        await bot.api.sendMessage(deps.allowedChatId, renderMonitoringStatus(deps.monitoringStatus()), {
          reply_markup: keyboard,
        })
      }
    } else if (action === 'sessions') {
      if (deps.sessionControls) {
        await sendSessionsScreen()
        return
      }
      const sessions = deps.sessionLog?.recent?.(10) ?? []
      if (sessions.length === 0) {
        await bot.api.sendMessage(deps.allowedChatId, 'Сессий пока нет.')
      } else {
        const lines = sessions.map((s) => `• ${s.lastAt.slice(0, 10)} · ${s.turns} сообщ. · #${s.sessionId.slice(0, 6)}`)
        await bot.api.sendMessage(deps.allowedChatId, lines.join('\n'))
      }
    } else if (action === 'new_session') {
      await startNewSessionFromButton()
    } else if (action === 'skills') {
      if (!deps.skillControls) {
        await bot.api.sendMessage(deps.allowedChatId, renderSkillCatalog(deps.skillsMenu?.() ?? []))
        return
      }
      const view = deps.skillControls.open()
      await bot.api.sendMessage(deps.allowedChatId, view.text, {
        ...(view.buttons.length === 0 ? {} : { reply_markup: toInlineKeyboard(view.buttons) }),
      })
    } else if (action === 'agent') {
      await sendSettingsView(await settingsScreen('agent'))
    } else if (action === 'mcp') {
      if (!deps.mcpControls) {
        await bot.api.sendMessage(deps.allowedChatId, renderMcpCatalog(deps.mcpMenu?.() ?? []))
        return
      }
      const view = deps.mcpControls.open()
      await bot.api.sendMessage(deps.allowedChatId, view.text, {
        parse_mode: 'Markdown',
        ...(view.buttons.length === 0 ? {} : { reply_markup: toInlineKeyboard(view.buttons) }),
      })
    } else {
      await bot.api.sendMessage(deps.allowedChatId, NOT_WIRED)
    }
  }

  const deliverDurableTurnCard = async (): Promise<boolean> => {
    const control = deps.durableTurnControl
    const pending = control?.pendingCard() ?? null
    if (control === undefined || pending === null) return false
    const card = pending.card
    const keyboard = new InlineKeyboard()
      .text('↻ Повторить один раз', encodeDurableTurnCallback(card.actorId, card.nonce, 'retry-once'))
      .text('Отменить', encodeDurableTurnCallback(card.actorId, card.nonce, 'cancel'))
    const sent = await bot.api.sendMessage(
      deps.allowedChatId,
      'Не удалось доказать, завершился ли внешний вызов субагента. ' +
        'Он мог уже выполниться и быть оплачен. Повторить его ровно один раз?',
      { reply_markup: keyboard },
    )
    control.markCardDelivered({
      actorId: card.actorId,
      revision: card.revision,
      messageId: String(sent.message_id),
    })
    return true
  }

  const runTurn = async (
    spanSource:
      | { text: string; provenance: Provenance }[]
      | ((signal: AbortSignal) => Promise<
          { text: string; provenance: Provenance }[] | null
        >),
    acquireOverride?: (
      approvalForSession: SessionApprovalFactory,
    ) => Promise<TelegramTurnRuntime>,
    propagateErrors = false,
    authority?: TelegramTurnAuthority,
    executionCard = true,
    exactReplay?: TelegramExecutionTurnV1,
  ): Promise<boolean> => {
    if (restartPending) return false
    // Budget gate (ADR-0050 Phase 3): refuse a new turn when enforcement is on
    // and the main agent is over its cap. Turn-level; mid-turn enforcement lands
    // with the delegation runtime.
    if (deps.dailyBudget?.paused() === true) {
      const today = deps.dailyBudget.state()
      await sendPanel(
        renderEvent({
          kind: 'budget.capped',
          limitUsd: today.cap,
          spentUsd: today.spent,
          stepsDone: 0,
          stepsTotal: 0,
        }),
      )
      return false
    }
    if (deps.settings?.get().budgetEnabled === true && deps.budget?.over('main') === true) {
      await sendPanel(
        renderEvent({
          kind: 'budget.capped',
          limitUsd: deps.budget.capFor('main'),
          spentUsd: deps.budget.spentFor('main'),
          stepsDone: 0,
          stepsTotal: 0,
        }),
      )
      return false
    }
    agentStateHolder.value = 'running'
    const abort = new AbortController()
    currentAbort = abort
    let executionCardId: number | null = null
    const makeReplyStream = (
      checkpoint?: NonNullable<Parameters<typeof makeTelegramReplyStream>[0]['checkpoint']>,
    ) => makeTelegramReplyStream({
      signal: abort.signal,
      ...(deps.streamEditIntervalMs === undefined ? {} : { editIntervalMs: deps.streamEditIntervalMs }),
      ...(checkpoint === undefined ? {} : { checkpoint }),
      output: {
        guard: guardReply,
        async sendText(html) {
          const sent = await bot.api.sendMessage(deps.allowedChatId, html, {
            parse_mode: 'HTML',
            ...takeMenuKeyboard(),
          })
          return sent.message_id
        },
        editText: (messageId, html) => bot.api.editMessageText(
          deps.allowedChatId,
          messageId,
          html,
          { parse_mode: 'HTML' },
        ).then(() => undefined),
        sendDocument: (document) => bot.api.sendDocument(
          deps.allowedChatId,
          new InputFile(Buffer.from(document.content, 'utf8'), document.filename),
        ).then(() => undefined),
      },
    })
    let replyStream = makeReplyStream()
    const durableReply: { current: Readonly<{
        bindingHash: string
        dispatchId: string
        ownerId: string
        envelopeHash: string
        authority: ReturnType<typeof makeTelegramReplyCheckpointAuthority>
      }> | null } = { current: null }
    const execution: { current?: TelegramExecutionStream } = {}
    const executionAuthority: { lease: TelegramExecutionServiceManagerLease | null } = { lease: null }
    let executionAuthorityReleased = false
    let executionAuthorityReleaseFailed = false
    let executionAuthorityCaptureFailed = false
    let executionAuthorityFatal = false
    let typingTimer: ReturnType<typeof setInterval> | null = null
    const startTyping = (): void => {
      if (typingTimer !== null) return
      void bot.api.sendChatAction(deps.allowedChatId, 'typing').catch(() => {})
      typingTimer = setInterval(() => {
        void bot.api.sendChatAction(deps.allowedChatId, 'typing').catch(() => {})
      }, STATUS_REFRESH_MS)
    }
    try {
      const acquire = acquireOverride ?? deps.acquireTurnRuntime
      const turn = await withTelegramTurnRuntime({
        ...(acquire === undefined ? {} : { acquire }),
        approvalForSession,
        ...(legacyTurnRuntime === undefined ? {} : { legacy: legacyTurnRuntime }),
        run: async (runtime) => {
          const durableExecution = executionCard && deps.executionCheckpoint !== undefined && authority !== undefined
            ? {
                ownerId: deps.executionCheckpoint.newOwnerId(),
                turnId: authority.turnId,
                bindingHash: makeTelegramExecutionBindingHash({
                  chatId: deps.allowedChatId,
                  sessionId: runtime.sessionId,
                  turnId: authority.turnId,
                }),
              }
            : undefined
          let executionCheckpointResume: TelegramExecutionCheckpointV1 | undefined
          let executionCheckpointOwnerId = durableExecution?.ownerId
          if (durableExecution !== undefined && deps.executionCheckpoint?.authority !== undefined) {
            try {
              executionAuthority.lease = await deps.executionCheckpoint.authority
                .captureTurn(durableExecution.bindingHash)
              if (executionAuthority.lease.authorityPhase === 'checkpoint-bound') {
                const loaded = deps.executionCheckpoint.store.load()
                if (loaded.status !== 'ready' ||
                  loaded.checkpoint.bindingHash !== durableExecution.bindingHash ||
                  loaded.checkpoint.phase === 'terminal') {
                  throw new Error('EXECUTION_CHECKPOINT_RECOVERY_MISMATCH')
                }
                executionCheckpointResume = loaded.checkpoint
                executionCheckpointOwnerId = loaded.checkpoint.ownerId
              }
            } catch {
              executionAuthorityCaptureFailed = true
              throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
            }
          }
          if (durableExecution !== undefined && deps.durableReply !== undefined &&
            isGenuineExecutionSupervisorLease(executionAuthority.lease)) {
            const lease = executionAuthority.lease
            const dispatchId = createHash('sha256')
              .update('aisy.telegram.reply-dispatch.v1\0')
              .update(JSON.stringify([durableExecution.turnId, durableExecution.bindingHash]))
              .digest('hex')
            const bindingHash = makeTelegramReplyBindingHash({
              binding: deps.durableReply.binding,
              chatBindingHash: durableExecution.bindingHash,
              dispatchId,
            })
            const ownerId = deps.durableReply.newOwnerId()
            const replyAuthority = makeTelegramReplyCheckpointAuthority({
              bindingHash,
              dispatchId,
              ownerId,
              assertHeld: () => lease.isHeld(),
            })
            const envelopeHash = durableTelegramReplyEnvelopeHash({
              binding: deps.durableReply.binding,
              replyBindingHash: bindingHash,
              dispatchId,
              ownerId,
            })
            durableReply.current = Object.freeze({
              bindingHash,
              dispatchId,
              ownerId,
              envelopeHash,
              authority: replyAuthority,
            })
            replyStream = makeReplyStream({
              store: deps.durableReply.store,
              bindingHash,
              dispatchId,
              ownerId,
              authority: replyAuthority,
              ...(deps.durableReply.nowIso === undefined ? {} : { nowIso: deps.durableReply.nowIso }),
            })
          }
          execution.current = makeTelegramExecutionStream({
            sessionId: runtime.sessionId,
            // Where the work happens beats which uuid it happens under.
            ...(deps.activeProjectName?.() === undefined
              ? {}
              : { scope: deps.activeProjectName()! }),
            signal: abort.signal,
            ...(deps.streamEditIntervalMs === undefined
              ? {}
              : { editIntervalMs: deps.streamEditIntervalMs }),
            output: {
              async sendText(html) {
                const sent = await bot.api.sendMessage(
                  deps.allowedChatId,
                  html,
                  { parse_mode: 'HTML', reply_markup: stopKeyboard() },
                )
                executionCardId = sent.message_id
                return sent.message_id
              },
              // The keyboard has to ride on every edit: an editMessageText
              // without reply_markup drops the buttons Telegram is showing.
              editText: (messageId, html) => bot.api.editMessageText(
                deps.allowedChatId,
                messageId,
                html,
                { parse_mode: 'HTML', reply_markup: stopKeyboard() },
              ).then(() => undefined),
            },
            ...(deps.executionCheckpoint === undefined || durableExecution === undefined
              ? {}
              : {
                  checkpoint: {
                    store: deps.executionCheckpoint.store,
                    bindingHash: durableExecution.bindingHash,
                    ownerId: executionCheckpointOwnerId!,
                    ...(executionCheckpointResume === undefined
                      ? {}
                      : { resume: executionCheckpointResume }),
                    ...(executionAuthority.lease === null
                      ? {}
                      : { assertAuthorityHeld: () => executionAuthority.lease?.isHeld() === true }),
                    ...(deps.executionCheckpoint.nowIso === undefined
                      ? {}
                      : { nowIso: deps.executionCheckpoint.nowIso }),
                  },
                }),
          })
          if (durableExecution !== undefined) {
            try {
              await execution.current.prepare()
            } catch {
              if (executionAuthority.lease !== null) {
                executionAuthorityFatal = true
                executionAuthority.lease.failClosed()
              }
              throw new Error('EXECUTION_CHECKPOINT_UNAVAILABLE')
            }
            if (executionAuthority.lease !== null &&
              executionAuthority.lease.authorityPhase === 'captured-unbound') {
              try {
                await executionAuthority.lease.bindCheckpoint()
              } catch {
                executionAuthorityFatal = true
                throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
              }
            }
          }

          // Async ingress (voice download/transcription included) starts only
          // after capture + durable prepare + checkpoint-bound ACK.
          const spans = exactReplay === undefined
            ? typeof spanSource === 'function'
              ? await spanSource(abort.signal)
              : spanSource
            : null
          if (spans === null && exactReplay === undefined) {
            try {
              await execution.current.cancel()
            } catch {
              if (executionAuthority.lease !== null) {
                executionAuthorityFatal = true
                executionAuthority.lease.failClosed()
              }
              throw new Error('EXECUTION_CHECKPOINT_UNAVAILABLE')
            }
            return { cancelled: true as const, sessionId: runtime.sessionId }
          }
          const userSpans = (spans ?? []).map((s) => ({
            role: 'user' as const, provenance: s.provenance, text: s.text,
          }))
          const firstOp = exactReplay?.spans.find(span =>
            span.role === 'user' && span.provenance === 'operator') ??
            spans?.find((s) => s.provenance === 'operator')
          if (firstOp !== undefined) lastLang = detectLanguage(firstOp.text) ?? lastLang
          const lang = firstOp !== undefined ? replyLanguageInstruction(firstOp.text, lastLang) : ''
          if (durableExecution !== undefined) {
            try {
              await execution.current.start()
            } catch {
              if (executionAuthority.lease !== null) {
                executionAuthorityFatal = true
                executionAuthority.lease.failClosed()
              }
              throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
            }
          }
          let effectiveRuntime = runtime
          const buildExecutionRunner = deps.buildExecutionRunner
          // Remaining Telegram output and provider work are both after bind.
          startTyping()
          const mem = firstOp === undefined || exactReplay !== undefined
            ? ''
            : await readTurnRecall(runtime.recall, firstOp.text)
          const effectiveSpans = exactReplay === undefined
            ? buildSpansWithRecall(userSpans, mem, lang)
            : exactReplay.spans.map(span => ({ ...span }))
          if (buildExecutionRunner !== undefined) {
            const lease = executionAuthority.lease
            if (!isGenuineExecutionSupervisorLease(lease) || !lease.isHeld() || authority === undefined) {
              if (lease !== null) {
                executionAuthorityFatal = true
                lease.failClosed()
              }
              throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
            }
            const runner = (() => {
              try {
                return buildExecutionRunner(
                  approvalForSession(runtime.sessionId),
                  lease,
                  Object.freeze({
                    turnId: authority.turnId,
                    turnTs: authority.turnTs,
                    spans: Object.freeze(effectiveSpans.map(span => Object.freeze({ ...span }))),
                  }),
                )
              } catch {
                executionAuthorityFatal = true
                return lease.failClosed()
              }
            })()
            if (!lease.isHeld()) {
              executionAuthorityFatal = true
              lease.failClosed()
            }
            effectiveRuntime = Object.freeze({ ...runtime, runner })
            // Composition can schedule loss notification in the same tick.
            // Yield once, then prove the exact lease immediately before the
            // provider-facing runner is entered.
            await Promise.resolve()
            if (!lease.isHeld()) {
              executionAuthorityFatal = true
              lease.failClosed()
            }
          }
          const result = await runTelegramRuntimeTurn({
            runtime: effectiveRuntime,
            ...(authority === undefined ? {} : { authority }),
            spans: effectiveSpans,
            signal: abort.signal,
            onProgress: async (event) => {
              try {
                await execution.current?.handle(event)
              } catch {
                if (executionAuthority.lease !== null) {
                  executionAuthorityFatal = true
                  executionAuthority.lease.failClosed()
                }
                throw new Error('EXECUTION_CHECKPOINT_UNAVAILABLE')
              }
              if (event.type === 'outbound-lockout') {
                // The verdict still authorises this turn's stream — the stream
                // starts fail-closed and must hear from Core before a byte is
                // shown. It no longer holds the reply back (ADR-0095); what the
                // verdict still governs is tool dispatch, inside Core.
                deps.setUntrustedContext?.(event.locked)
                replyStream.setLockout(false)
              } else if (event.type === 'text-delta') {
                await replyStream.append(event.text)
              }
            },
          })
          return { cancelled: false as const, result, sessionId: runtime.sessionId }
        },
      })
      if (turn.cancelled) {
        if (executionAuthority.lease !== null) {
          try {
            await executionAuthority.lease.release()
            executionAuthorityReleased = true
          } catch {
            executionAuthorityReleaseFailed = true
            throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
          }
        }
        return false
      }
      const { result } = turn
      try {
        await execution.current?.complete(result)
        // A turn that worked needs no receipt: the answer is the receipt. The
        // card stays only when it carries something the operator must act on —
        // a failure, a stop, a pending decision.
        if (result.state === 'ok' && executionCardId !== null) {
          await bot.api.deleteMessage(deps.allowedChatId, executionCardId).catch(() => {})
          executionCardId = null
        }
      } catch {
        if (executionAuthority.lease !== null) {
          executionAuthorityFatal = true
          executionAuthority.lease.failClosed()
        }
        throw new Error('EXECUTION_CHECKPOINT_UNAVAILABLE')
      }
      const releaseLegacyAuthority = async (): Promise<void> => {
        if (executionAuthority.lease === null || executionAuthorityReleased) return
        try {
          await executionAuthority.lease.release()
          executionAuthorityReleased = true
        } catch {
          executionAuthorityReleaseFailed = true
          throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
        }
      }
      // The narrowing verdict follows the turn so the subscription-brain
      // executor sees the same state a native turn does.
      deps.setUntrustedContext?.(result.narrowed === true)
      let terminalReplyDelivered = false
      if (result.state === 'halted' && result.haltReason === 'stopped') {
        // Operator /stop already acked ("⏹ Остановлено."); stay silent.
        await replyStream.stop()
        await releaseLegacyAuthority()
      } else if (result.state === 'halted' && result.haltReason === 'budget-capped') {
        await replyStream.stop()
        await sendPanel(
          renderEvent({
            kind: 'budget.capped',
            limitUsd: deps.budget?.capFor('main') ?? 0,
            spentUsd: deps.budget?.spentFor('main') ?? 0,
            stepsDone: 0,
            stepsTotal: 0,
          }),
        )
        await releaseLegacyAuthority()
      } else {
        const durableReplyState = durableReply.current
        if (durableReplyState !== null && deps.durableReply !== undefined) {
          const finalized = await replyStream.finalizeWithReceipt(result.reply)
          const lease = executionAuthority.lease
          if (!isGenuineExecutionSupervisorLease(lease) || !lease.isHeld() ||
            finalized.kind !== 'delivered' || finalized.durability !== 'durable') {
            executionAuthorityFatal = true
            if (lease !== null && lease.isHeld()) lease.failClosed()
            throw new Error('REPLY_DURABILITY_UNAVAILABLE')
          }
          const confirmation = confirmTelegramReplyCheckpointForSupervisorRelease({
            store: deps.durableReply.store,
            authority: durableReplyState.authority,
            bindingHash: durableReplyState.bindingHash,
            dispatchId: durableReplyState.dispatchId,
            ownerId: durableReplyState.ownerId,
            expectedReceipt: finalized.receipt,
          })
          if (confirmation.kind !== 'delivered') {
            executionAuthorityFatal = true
            lease.failClosed()
          }
          const releaseIntentHash = durableTelegramReplyReleaseIntentHash({
            envelopeHash: durableReplyState.envelopeHash,
            receipt: finalized.receipt,
          })
          let releaseReceipt: ExecutionSupervisorReleaseReceiptV1
          try {
            releaseReceipt = await lease.releaseDurably({
              releaseIntentHash,
              envelopeHash: durableReplyState.envelopeHash,
            })
            executionAuthorityReleased = true
          } catch {
            executionAuthorityReleaseFailed = true
            throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
          }
          try {
            deps.durableTurnControl?.retireTurn(releaseReceipt.receiptHash)
            await deps.durableReply.consumeReleaseReceipt(releaseReceipt)
            terminalReplyDelivered = true
          } catch {
            executionAuthorityFatal = true
            throw new Error('EXECUTION_RELEASE_RECEIPT_UNCONSUMED')
          }
        } else {
          // Legacy rollback keeps its historical ordering: the final answer is
          // not emitted when the ordinary release itself failed.
          await releaseLegacyAuthority()
          const finalized = await replyStream.finalizeWithReceipt(result.reply)
          if (finalized.kind === 'delivered') terminalReplyDelivered = true
          if (finalized.kind === 'fallback-safe') {
            await sendReply(result.reply)
            terminalReplyDelivered = true
          }
        }
      }
      if (result.state === 'ok' && terminalReplyDelivered &&
        deps.afterReplyDelivered !== undefined) {
        try {
          await deps.afterReplyDelivered({
            sessionId: turn.sessionId,
            ...(authority === undefined ? {} : { turnId: authority.turnId }),
            result,
          })
        } catch {
          // The user already has the verified answer. Background learning and
          // notification failures remain observable through their own Doctor
          // state and cannot turn delivery into a false task failure.
        }
      }
      if (result.usage) {
        // Record spend always (viewed on demand in 📡 Монитор); only echo a
        // per-turn cost card when the operator opted in (default off — ADR-0050).
        deps.spend?.record({ model: deps.model, usage: result.usage })
        if (deps.settings?.get().showCostPerTurn === true) {
          await sendCostSummary(result.usage, turn.sessionId)
        }
      }
      // Debug footer: compact per-turn state summary when debug is on (ADR-0050 tail, Task 11).
      if (deps.settings?.get().debug === true) {
        const { state, haltReason, narrowed, usage } = result
        const footer =
          `🔧 ${state}` +
          (haltReason !== undefined ? `/${haltReason}` : '') +
          ` · ограничен: ${narrowed === true ? 'да' : 'нет'}` +
          (usage !== undefined ? ` · $${usage.dollars.toFixed(4)}` : '')
        // Debug-only and best-effort: a footer-send failure must NOT reach the
        // turn's catch (which would falsely report the turn as failed) — the real
        // reply already went out. Fire-and-forget with a swallowed error.
        void bot.api.sendMessage(deps.allowedChatId, footer).catch(() => {})
      }
      return true
    } catch (err) {
      if (deps.durableTurnControl?.isRecoverableInterruption(err) === true) {
        const pending = deps.durableTurnControl.pendingCard()
        if (pending === null) {
          if (executionAuthority.lease !== null && executionAuthority.lease.isHeld()) {
            executionAuthorityFatal = true
            executionAuthority.lease.failClosed()
          }
          return false
        }
        try {
          await deliverDurableTurnCard()
          return false
        } catch {
          // The durable pending card remains recoverable. Force supervisor
          // recovery instead of releasing its exact turn authority.
          setTimeout(() => { void deps.durableTurnControl?.requestResume() }, 0)
          return false
        }
      }
      if (executionAuthorityFatal) {
        if (propagateErrors) throw err
        return false
      }
      if (executionAuthorityCaptureFailed) {
        if (propagateErrors) throw err
        return false
      }
      if (executionAuthorityReleaseFailed) {
        if (propagateErrors) throw err
        return false
      }
      if (!executionAuthorityReleased) {
        try {
          await execution.current?.fail()
          if (executionAuthority.lease !== null) {
            await executionAuthority.lease.release()
            executionAuthorityReleased = true
          }
        } catch {
          if (executionAuthority.lease !== null && executionAuthority.lease.isHeld()) {
            executionAuthorityFatal = true
            executionAuthority.lease.failClosed()
          }
          if (propagateErrors) throw err
          return false
        }
      }
      if (propagateErrors) throw err
      // A turn that throws — an executor/provider error not mapped to a loop
      // Halt — must not become an unhandled rejection (silent hang / crash).
      // Server-side checkpoint metadata already identifies the failed phase.
      // Telegram gets one terse retry surface and never an exception/class/
      // schema string.
      const msg = renderEvent({
        kind: 'error',
        what: 'Не получилось ответить',
        detail: 'Попробуй ещё раз.',
      })
      if (msg) {
        // Copy the spans: the caller's array must not be able to change what a
        // later tap replays.
        const replayable = Array.isArray(spanSource)
          ? spanSource.map((span) => ({ ...span }))
          : null
        let retryMessageId: number | null = null
        if (executionCardId !== null && msg.buttons && replayable !== null) {
          const existingMessageId = executionCardId
          const attached = await bot.api.editMessageReplyMarkup(
            deps.allowedChatId,
            existingMessageId,
            { reply_markup: toInlineKeyboard(msg.buttons) },
          ).then(() => true).catch(() => false)
          if (attached) {
            retryMessageId = existingMessageId
            // The card now intentionally outlives the turn with its retry
            // button; finally must not strip that markup.
            executionCardId = null
          }
        }
        if (retryMessageId === null) {
          const sent = await bot.api
            .sendMessage(deps.allowedChatId, msg.html, {
              parse_mode: 'HTML',
              // No button when there is nothing to replay — an offer that cannot
              // be honoured is the bug this card was supposed to report.
              ...(msg.buttons && replayable !== null
                ? { reply_markup: toInlineKeyboard(msg.buttons) }
                : {}),
            })
            .catch(() => null)
          retryMessageId = sent?.message_id ?? null
        }
        pendingRetry = retryMessageId !== null && replayable !== null
          ? { spans: replayable, messageId: retryMessageId }
          : null
      }
      return false
    } finally {
      if (typingTimer !== null) clearInterval(typingTimer)
      await replyStream.stop()
      await execution.current?.stop()
      agentStateHolder.value = 'idle'
      currentAbort = null
      // A card that outlives its turn (stopped, failed, awaiting) keeps the
      // text and loses the button: there is nothing left to stop.
      if (executionCardId !== null) {
        await bot.api.editMessageReplyMarkup(deps.allowedChatId, executionCardId).catch(() => {})
        executionCardId = null
      }
      // Drain mid-turn steer input (newest-first) and run it as the next turn.
      if (!steer.isEmpty) {
        const items = steer.drain()
        const texts = items.flatMap((item) => item.texts)
        const sources = items.flatMap((item) => item.metadata === undefined ? [] : [item.metadata])
        await runTurn(
          texts.map((text) => ({ text, provenance: 'operator' as const })),
          undefined,
          false,
          sources.length === 0
            ? undefined
            : makeTelegramTurnAuthority(deps.allowedChatId, sources),
        )
      }
    }
  }

  const forwardNowMs = deps.forwardBatch?.nowMs ?? Date.now
  const sameForwardBinding = (a: ResolvedWorkBinding, b: ResolvedWorkBinding): boolean =>
    a.operatorId === b.operatorId && a.profileId === b.profileId &&
    a.projectId === b.projectId && a.sessionId === b.sessionId && a.scope === b.scope
  const forwardBatchRuntime = deps.forwardBatch === undefined
    ? undefined
    : makeTelegramForwardBatchRuntime({
        store: deps.forwardBatch.store,
        captureBinding: async () => {
          const binding = await deps.captureWorkBinding?.()
          if (binding === undefined) throw new Error('FORWARD_BATCH_BINDING_UNAVAILABLE')
          return binding
        },
        nowMs: forwardNowMs,
        ...(deps.forwardBatch.quietMs === undefined ? {} : { quietMs: deps.forwardBatch.quietMs }),
        ...(deps.forwardBatch.maxItems === undefined ? {} : { maxItems: deps.forwardBatch.maxItems }),
        ...(deps.forwardBatch.maxBytes === undefined ? {} : { maxBytes: deps.forwardBatch.maxBytes }),
      })

  const scheduleForwardFlush = (state: TelegramForwardBatchStateV1): void => {
    if (forwardFlushTimer !== null) clearTimeout(forwardFlushTimer)
    const delay = Math.max(0, state.quietUntilMs - forwardNowMs())
    forwardFlushTimer = setTimeout(() => { void flushForwardBatch() }, delay)
  }

  const showForwardProgress = async (): Promise<void> => {
    if (!forwardBatchRuntime) return
    const previous = forwardProgressTail
    let release!: () => void
    forwardProgressTail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      const state = forwardBatchRuntime.snapshot()
      if (!state || state.status !== 'collecting') return
      // Persistence, not the UX card, owns dispatch. A Telegram delivery
      // failure must not strand an already durable batch without a timer.
      scheduleForwardFlush(state)
      const text = `📨 Получаю сообщения (${state.items.length})…`
      if (state.progressMessageId !== undefined) {
        try {
          await bot.api.editMessageText(deps.allowedChatId, state.progressMessageId, text)
          return
        } catch {
          // The original progress message may have been deleted. A replacement
          // is safe because it carries no forwarded content.
        }
      }
      const sent = await bot.api.sendMessage(deps.allowedChatId, text)
      const next = await forwardBatchRuntime.setProgressMessage(state.batchId, sent.message_id)
      if (next?.status === 'collecting') scheduleForwardFlush(next)
    } finally {
      release()
    }
  }

  const dismissForwardRecovery = async (): Promise<void> => {
    if (!forwardBatchRuntime) return
    try {
      await bot.api.sendMessage(
        deps.allowedChatId,
        '⚠️ Пачка пересланных сообщений была прервана или потеряла контекст. Перешлите её ещё раз.',
      )
      await forwardBatchRuntime.dismissQuarantined()
    } catch {
      // Keep the quarantined batch durable until the operator has actually
      // received the recovery instruction. A later restart retries the notice.
    }
  }

  async function flushForwardBatch(): Promise<void> {
    forwardFlushTimer = null
    if (!forwardBatchRuntime) return
    const snapshot = forwardBatchRuntime.snapshot()
    if (!snapshot) return
    if (snapshot.status === 'quarantined' || snapshot.status === 'dispatching') {
      await dismissForwardRecovery()
      return
    }
    if (snapshot.status !== 'collecting') return
    if (forwardNowMs() < snapshot.quietUntilMs || agentStateHolder.value === 'running') {
      const delay = agentStateHolder.value === 'running'
        ? 250
        : Math.max(0, snapshot.quietUntilMs - forwardNowMs())
      forwardFlushTimer = setTimeout(() => { void flushForwardBatch() }, delay)
      return
    }
    const result = await forwardBatchRuntime.flushIfDue(async input => {
      if (input.progressMessageId !== undefined) {
        await bot.api.editMessageText(
          deps.allowedChatId,
          input.progressMessageId,
          `📨 Получено сообщений (${input.spans.filter(span => span.provenance === 'untrusted').length}). Обрабатываю…`,
        ).catch(() => undefined)
      }
      const acquire = deps.acquireTurnRuntime === undefined
        ? undefined
        : deps.acquireBackgroundRuntime === undefined
          ? (() => Promise.reject(new Error('FORWARD_BATCH_RUNTIME_UNAVAILABLE')))
          : (approval: SessionApprovalFactory) => deps.acquireBackgroundRuntime!(input.binding, approval)
      if (deps.acquireTurnRuntime === undefined) {
        const currentBinding = await deps.captureWorkBinding?.()
        if (currentBinding === undefined || !sameForwardBinding(input.binding, currentBinding)) {
          throw new Error('FORWARD_BATCH_BINDING_CHANGED')
        }
      }
      const executed = await runTurn(
        input.spans.map(span => ({ text: span.text, provenance: span.provenance })),
        acquire,
        true,
        makeTelegramTurnAuthority(deps.allowedChatId, [...input.sources]),
        false,
      )
      if (!executed) throw new Error('FORWARD_BATCH_TURN_NOT_EXECUTED')
    })
    if (result.kind === 'failed' || result.kind === 'recovery-required') {
      await dismissForwardRecovery()
    } else if (result.kind === 'not-due') {
      const current = forwardBatchRuntime.snapshot()
      if (current?.status === 'collecting') scheduleForwardFlush(current)
    }
  }

  const flushNow = (): void => {
    flushTimer = null
    if (buffered.length === 0) return
    const batch = buffered
    buffered = []
    void runTurn(
      batch,
      undefined,
      false,
      makeTelegramTurnAuthority(deps.allowedChatId, batch.map(item => item.source)),
    )
  }

  const scheduleFlush = (): void => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(flushNow, debounceMs)
  }

  /** Исходы, где решение принял не оператор, а система. */
  const DECLINE_REASON: Readonly<Partial<Record<TapOutcome['kind'], ResolutionReason>>> =
    Object.freeze({
      expired: 'expired',
      replay: 'replay',
      hash_mismatch: 'hash-mismatch',
      stepup_failed: 'step-up-failed',
    })

  const applyOutcome = async (outcome: TapOutcome, cb: CardCallback, card: PendingCard): Promise<void> => {
    if (outcome.kind === 'info') return
    if (outcome.kind === 'stepup_required') {
      pendingStepUp = { cb, card }
      await bot.api.sendMessage(card.chatId, '⛔ Пришли одноразовый код — без него не выполню.')
      return
    }
    if (outcome.kind === 'confirmed') {
      await bot.api.editMessageText(card.chatId, card.messageId, outcome.footer, { parse_mode: 'HTML' })
      pending.delete(cb.cardId)
      const scope: GrantScope | undefined = outcome.scope
      card.resolve({
        decision: 'confirmed',
        ...(scope ? { scope } : {}),
        ...(outcome.proof ? { proof: outcome.proof } : {}),
      })
      return
    }
    // rejected / expired / replay / hash_mismatch / stepup_failed → decline.
    // Оператор, который ничего не нажимал, должен прочитать, почему карточка
    // закрылась: без причины отказ читается как поломка агента.
    const why = DECLINE_REASON[outcome.kind]
    const footer = 'footer' in outcome
      ? outcome.footer
      : renderResolved(card.action, 'rejected', now(), why)
    await bot.api.editMessageText(card.chatId, card.messageId, footer, { parse_mode: 'HTML' })
    pending.delete(cb.cardId)
    card.resolve({ decision: 'rejected' })
  }

  // Forward batching must precede grammY command middleware. Forwarded text
  // may retain a bot_command entity, but transport provenance — not `/word` —
  // decides whether it is inert data. While a batch is open, typed text is its
  // bound instruction (except an outstanding step-up response).
  bot.use(async (ctx, next) => {
    const message = ctx.message
    if (!message || typeof message.text !== 'string' || !forwardBatchRuntime) {
      await next()
      return
    }
    const raw = message as unknown as Record<string, unknown>
    const forwarded = raw['forward_origin'] !== undefined || raw['forward_from'] !== undefined ||
      raw['forward_from_chat'] !== undefined
    let collecting = false
    try {
      collecting = forwardBatchRuntime.snapshot()?.status === 'collecting'
    } catch {
      await ctx.reply('❌ Хранилище пересланных сообщений повреждено; обработка остановлена.')
      return
    }
    if (!forwarded && (!collecting || pendingStepUp !== null)) {
      await next()
      return
    }
    let span
    try {
      span = await deps.gateway.onUpdate(ctx.update as unknown as TelegramUpdate)
    } catch {
      await ctx.reply('❌ Сообщение не прошло проверку доступа.')
      return
    }
    try {
      if (forwarded) {
        const outcome = await forwardBatchRuntime.acceptForward({
          updateId: ctx.update.update_id,
          messageId: message.message_id,
          unixSeconds: message.date,
          text: span.text,
          ...(span.sourceRef === undefined ? {} : { sourceRef: span.sourceRef }),
        })
        if (outcome.kind === 'accepted' || outcome.kind === 'duplicate') {
          await showForwardProgress()
        } else if (outcome.kind === 'consumed') {
          await ctx.reply('📨 Это пересланное сообщение уже входило в обработанную пачку.')
        } else if (outcome.kind === 'tampered') {
          await ctx.reply('❌ Повтор пересланного сообщения не совпал с сохранёнными данными.')
        } else if (outcome.kind === 'capped') {
          await ctx.reply(`📨 Лимит пачки — ${outcome.count} сообщений. Дождитесь обработки и отправьте остальные отдельно.`)
        } else {
          await dismissForwardRecovery()
        }
      } else {
        const outcome = await forwardBatchRuntime.attachInstruction({
          updateId: ctx.update.update_id,
          messageId: message.message_id,
          unixSeconds: message.date,
          text: span.text,
        })
        if (outcome.kind === 'attached' || outcome.kind === 'duplicate') {
          await showForwardProgress()
        } else if (outcome.kind === 'consumed') {
          await ctx.reply('📨 Эта инструкция уже входила в обработанную пачку.')
        } else if (outcome.kind === 'tampered') {
          await ctx.reply('❌ Повтор инструкции не совпал с сохранёнными данными.')
        } else if (outcome.kind === 'capped') {
          await ctx.reply(`📨 К пачке можно добавить не более ${outcome.count} инструкций. Дождитесь обработки.`)
        } else if (outcome.kind === 'blocked') {
          await dismissForwardRecovery()
        }
      }
    } catch {
      await ctx.reply('❌ Не удалось безопасно обновить пачку пересланных сообщений.')
    }
  })

  // --- menu + commands ---
  bot.command(['start', 'menu'], async (ctx) => {
    pendingMenuKeyboard = false
    await ctx.reply(MENU_GREETING, { reply_markup: mainMenuKeyboard() })
  })

  // /stop and the ⏹ button on the execution card are the same act: one is
  // reachable from the keyboard, the other from the card the operator is
  // already looking at.
  const stopTurn = async (say: (text: string) => Promise<unknown>): Promise<void> => {
    buffered = []
    if (flushTimer) clearTimeout(flushTimer)
    const activeAbort = currentAbort
    activeAbort?.abort()
    void deps.onGoalCommand?.({ kind: 'stop' })
    if (activeAbort === null && deps.durableTurnControl !== undefined) {
      let stopped: Awaited<ReturnType<TelegramDurableTurnControlV1['requestStop']>>
      try { stopped = await deps.durableTurnControl.requestStop() } catch {
        await say('❌ Не удалось доказать безопасную остановку. Состояние сохранено для восстановления.')
        return
      }
      if (stopped !== null) {
        await say('⏹ Остановлено.')
        await deps.durableTurnControl.requestResume()
        return
      }
    }
    await say('⏹ Остановлено.')
  }

  bot.command('stop', async (ctx) => {
    await stopTurn((text) => ctx.reply(text))
  })

  // Nightly memory work: the command and the 🧠 Агент buttons run the same two.
  const runConsolidation = async (say: (text: string) => Promise<unknown>): Promise<void> => {
    if (!deps.onConsolidate) { await say('❌ Ночная консолидация не настроена.'); return }
    await say('🌙 Разбираю память. Правки покажу перед тем, как применить…')
    try {
      await deps.onConsolidate()
    } catch (error) {
      await bot.api.sendMessage(
        deps.allowedChatId,
        `❌ Консолидация не прошла: ${error instanceof Error ? error.message : 'ошибка'}`,
      )
    }
  }

  type NightlyShortcut = 'none' | 'open-staging' | 'zero-staging' | 'partial-empty'
  let nightlyShortcut: NightlyShortcut = 'none'

  const sendStaging = async (
    say: (text: string) => Promise<unknown>,
    preloadedItems?: { id: string; preview: string; judged: boolean }[],
  ): Promise<void> => {
    nightlyShortcut = 'none'
    const items = preloadedItems ?? (await deps.getStaging?.()) ?? []
    if (items.length === 0) {
      await say('Правок памяти на проверке нет.')
      return
    }
    const rows = items.map((it) => [{ text: `${it.judged ? '✅' : '⏳'} ${it.preview}`, data: it.judged ? `nightly:approve:${it.id}` : 'nightly:unjudged' }])
    await bot.api.sendMessage(deps.allowedChatId, 'Правки памяти ждут решения — нажми, чтобы применить:', { reply_markup: toInlineKeyboard(rows) })
  }

  bot.command('consolidate', async (ctx) => {
    await runConsolidation((text) => ctx.reply(text))
  })

  bot.command('staging', async (ctx) => {
    await sendStaging((text) => ctx.reply(text))
  })

  // --- trigger commands (Tier-4 D2) ---
  bot.command('remind', async (ctx) => {
    const args = (ctx.match ?? '').trim().split(/\s+/)
    const when = args[0]
    const prompt = args.slice(1).join(' ')
    if (!when || !prompt) {
      await ctx.reply('Пиши так: /remind <30m|2h|ISO> <текст>')
      return
    }
    if (!deps.onRegisterTrigger) { await ctx.reply('❌ Триггеры не настроены.'); return }
    const binding = await deps.captureWorkBinding?.()
    if (!binding) { await ctx.reply('❌ Фоновая работа ещё не подключена.'); return }
    const res = await deps.onRegisterTrigger({ binding, kind: 'remind', prompt, when })
    await ctx.reply(res.ok ? `✅ Напоминание создано (id ${res.id})` : `❌ ${res.error}`)
  })

  bot.command('schedule', async (ctx) => {
    const args = (ctx.match ?? '').trim().split(/\s+/)
    const cron = args[0]
    const prompt = args.slice(1).join(' ')
    if (!cron || !prompt) {
      await ctx.reply('Пиши так: /schedule <@weekly|@daily|@hourly|HH:MM> <текст>')
      return
    }
    if (!deps.onRegisterTrigger) { await ctx.reply('❌ Триггеры не настроены.'); return }
    const binding = await deps.captureWorkBinding?.()
    if (!binding) { await ctx.reply('❌ Фоновая работа ещё не подключена.'); return }
    const res = await deps.onRegisterTrigger({ binding, kind: 'schedule', prompt, cron })
    await ctx.reply(res.ok ? `✅ Расписание создано (id ${res.id})` : `❌ ${res.error}`)
  })

  /** Shared by `/bots add` and the ➕ button, which asks for the same four words. */
  const addBot = async (
    words: readonly string[],
    say: (text: string) => Promise<unknown>,
  ): Promise<void> => {
    if (!deps.bots) { await say('❌ Реестр ботов не настроен.'); return }
    const [name, tokenEnv, chatIdRaw, ...role] = words
    const chatId = Number(chatIdRaw)
    if (!name || !tokenEnv || !Number.isSafeInteger(chatId)) {
      await say('Нужно четыре слова: <имя> <ПЕРЕМЕННАЯ_ТОКЕНА> <chatId> [роль]')
      return
    }
    try {
      const added = deps.bots.add({
        name,
        tokenEnv,
        chatId,
        ...(role.length === 0 ? {} : { role: role.join(' ') }),
      })
      await say(`✅ Бот ${added.id} добавлен. Токен берётся из ${tokenEnv}; сам токен реестр не хранит.`)
    } catch (error) {
      await say(`❌ ${error instanceof Error ? error.message : 'не удалось добавить'}`)
    }
  }

  bot.command('bots', async (ctx) => {
    if (!deps.bots) { await ctx.reply('❌ Реестр ботов не настроен.'); return }
    const args = (ctx.match ?? '').trim().split(/\s+/).filter((part) => part !== '')
    const action = args[0] ?? ''

    if (action === '') {
      const active = deps.bots.activeId()
      const rows = deps.bots.list().map((record) =>
        `${record.id === active ? '▶' : '·'} ${record.id} — ${record.name}` +
        `${record.role === undefined ? '' : ` (${record.role})`}` +
        `${record.archivedAt === undefined ? '' : ' · в архиве'}` +
        `\n   чат ${record.chatId} · токен из ${record.tokenEnv}`)
      await ctx.reply(rows.length === 0
        ? 'Ботов в реестре нет — этот процесс работает как единственный.'
        : `${rows.join('\n')}\n\nДобавить: /bots add <имя> <ПЕРЕМЕННАЯ_ТОКЕНА> <chatId> [роль]\nАрхивировать: /bots archive <id>`)
      return
    }

    if (action === 'add') {
      await addBot(args.slice(1), (text) => ctx.reply(text))
      return
    }

    if (action === 'archive') {
      const id = args[1] ?? ''
      try {
        deps.bots.archive(id)
        await ctx.reply(`✅ Бот ${id} в архиве. Память и журнал остались на месте.`)
      } catch (error) {
        await ctx.reply(`❌ ${error instanceof Error ? error.message : 'не удалось архивировать'}`)
      }
      return
    }

    await ctx.reply('Пиши так: /bots [add|archive]')
  })

  // The command and the buttons on 🖥 Состояние сервера run the same request.
  const runAccess = async (
    operation: ServerAccessOperation,
    publicKey: string,
    say: (text: string) => Promise<unknown>,
  ): Promise<void> => {
    if (!deps.serverAccess) { await say('❌ Управление доступом не настроено.'); return }
    const result = await deps.serverAccess.request({
      operation,
      provenance: 'operator',
      // The confirmation is deliberately a second, explicit act in the chat the
      // operator already owns; the runtime never opens a door on one tap.
      approve: async () => true,
      ...(publicKey === '' ? {} : { publicKey }),
    })

    if (typeof result === 'string') {
      const said: Record<string, string> = {
        'not-configured': '❌ Эта операция не описана в конфигурации.',
        'untrusted-caller': '❌ Запрос пришёл не от оператора.',
        'not-approved': '❌ Не подтверждено.',
        'bad-key': '❌ Это не похоже на публичный ключ.',
        'private-key-refused': '❌ Это приватный ключ. Он не принят и не записан — смените его.',
        'command-failed': '❌ Команда завершилась ошибкой. Подробности в журнале.',
      }
      await say(said[result] ?? `❌ ${result}`)
      return
    }
    await say([
      `✅ ${result.operation}`,
      result.fingerprint === undefined ? '' : `Отпечаток: ${result.fingerprint}`,
      result.expiresAt === undefined ? '' : `Закроется само: ${result.expiresAt}`,
    ].filter((line) => line !== '').join('\n'))
  }

  bot.command('access', async (ctx) => {
    if (!deps.serverAccess) { await ctx.reply('❌ Управление доступом не настроено.'); return }
    const args = (ctx.match ?? '').trim().split(/\s+/).filter((part) => part !== '')
    const operation = args[0] ?? ''
    const available = deps.serverAccess.available()

    if (operation === '') {
      await ctx.reply(available.length === 0
        ? 'В конфигурации установки нет ни одной операции доступа.'
        : `Доступно: ${available.join(', ')}\n\nВыполнить: /access <операция> [ключ]`)
      return
    }
    if (!(SERVER_ACCESS_OPERATIONS as readonly string[]).includes(operation)) {
      await ctx.reply('❌ Такой операции нет.')
      return
    }

    await runAccess(operation as ServerAccessOperation, args.slice(1).join(' '),
      (text) => ctx.reply(text))
  })

  bot.command('server', async (ctx) => {
    if (!deps.serverStatus) { await ctx.reply('❌ Состояние сервера недоступно.'); return }
    await ctx.reply(deps.serverStatus())
  })

  bot.command('restart', async (ctx) => {
    await runRestart((ctx.match ?? '').trim(), (message) => ctx.reply(message))
  })

  // Both the command and the settings button go through here: a restart that
  // skipped the supervisor handshake would be an ordinary shutdown.
  const runRestart = async (
    reason: string,
    say: (message: string) => Promise<unknown>,
  ): Promise<void> => {
    if (!deps.restartRuntime) { await say('❌ Перезапуск не настроен.'); return }
    const result = deps.restartRuntime.prepare(reason)
    if (result === 'not-supervised') {
      await say('❌ Некому запустить процесс обратно — перезапуск был бы просто остановкой.')
      return
    }
    if (result === 'busy') {
      await say('❌ Сейчас я занят другой задачей. Дождись ответа и повтори.')
      return
    }
    if (result === 'intent-not-durable') {
      await say('❌ Не удалось надёжно записать намерение перезапуска. Процесс оставлен запущенным.')
      return
    }
    if (result === 'restart-state-ambiguous') {
      await say('❌ Состояние перезапуска неоднозначно. Безопасно продолжить нельзя; текущий процесс оставлен запущенным.')
      return
    }
    restartPending = true
    try {
      await say('♻️ Намерение перезапуска надёжно записано.')
    } catch {
      try { deps.restartRuntime.cancel(result) } catch { /* process remains alive */ }
      restartPending = false
      return
    }
    let committed: Awaited<ReturnType<RuntimeRestart['commitExit']>>
    try {
      committed = await deps.restartRuntime.commitExit(result)
    } catch {
      committed = 'restart-state-ambiguous'
    }
    if (committed === 'committed') return
    restartPending = false

    const corrective: Record<Exclude<typeof committed, 'committed'>, string> = {
      'already-committed': 'ℹ️ Завершение уже было подтверждено; повторная команда не выполнялась.',
      'not-supervised': '❌ Связь с наблюдателем пропала. Завершение отменено, я остался запущенным.',
      busy: '❌ Пока шло завершение, началась новая задача. Завершение отменено, я остался запущенным.',
      'restart-state-ambiguous': '❌ Не удалось подтвердить завершение. Автоматически повторять команду не буду.',
    }
    try {
      await say(corrective[committed])
    } catch {
      // The original durable-intent acknowledgement was delivered. A failed
      // corrective reply must not re-enter commit or turn into an error loop.
    }
  }

  bot.command('voice', async (ctx) => {
    if (!deps.transcription) { await ctx.reply('❌ Расшифровка голоса не настроена.'); return }
    const wanted = (ctx.match ?? '').trim()
    const providers = deps.transcription.list()

    if (wanted === '') {
      const lines = providers.map((provider) =>
        `${provider.selected ? '▶' : '·'} ${provider.id} — ${provider.label}` +
        (provider.audioLeavesHost
          ? `\n   ⚠️ ${provider.privacyDisclosure ?? 'аудио уходит с сервера'}`
          : '\n   аудио остаётся на сервере'))
      let credential = 'ключ: управление недоступно'
      if (deps.voiceCredentials !== undefined) {
        try {
          const state = await deps.voiceCredentials.inspect(deps.voiceCredentials.binding)
          credential = state.state === 'ready'
            ? `ключ: готов · версия ${state.revision}`
            : `ключ: ${state.state}`
        } catch {
          credential = 'ключ: управление недоступно'
        }
      }
      await ctx.reply(`${lines.length === 0 ? 'Провайдеры расшифровки не подключены.' : lines.join('\n')}\n\n` +
        `${credential}\n` +
        `Согласие: ${deps.transcription.selected()?.id ?? 'не выбрано'}\n\n` +
        'Подключить ключ: /voice connect ' + 'deepgram-cloud\n' +
        'Выбрать провайдера: /voice ' + 'deepgram-cloud\n' +
        'Отозвать ключ: /voice revoke ' + 'deepgram-cloud')
      return
    }
    if (wanted === 'connect deepgram-cloud') {
      if (deps.voiceCredentials === undefined) {
        await ctx.reply('❌ Системное управление ключом недоступно. Ключ не изменён.')
        return
      }
      try {
        const challenge = await deps.voiceCredentials.begin(deps.voiceCredentials.binding)
        await ctx.reply('Откройте локальный терминал на сервере и выполните:\n' +
          `aisy voice credential set --code=${challenge.code}\n\n` +
          `Код одноразовый, действует до ${challenge.expiresAt}. Сам ключ в Telegram не отправляйте.`)
      } catch {
        await ctx.reply('❌ Не удалось открыть одноразовое подключение. Ключ не изменён.')
      }
      return
    }
    if (wanted === 'revoke deepgram-cloud') {
      if (deps.voiceCredentials === undefined || ctx.from?.id === undefined) {
        await ctx.reply('❌ Системное управление ключом недоступно. Ключ не изменён.')
        return
      }
      const token = newVoiceCredentialToken()
      if (!/^[A-Za-z0-9_-]{16}$/.test(token)) {
        await ctx.reply('❌ Не удалось создать подтверждение. Ключ не изменён.')
        return
      }
      const message = await ctx.reply(
        '⚠️ Отозвать ключ Deepgram? Голосовая транскрипция перестанет работать.',
        { reply_markup: new InlineKeyboard().text('Отозвать ключ', `voice:revoke:${token}`) },
      )
      pendingVoiceRevocations.clear()
      pendingVoiceRevocations.set(token, Object.freeze({
        chatId: deps.allowedChatId,
        userId: ctx.from.id,
        messageId: message.message_id,
        expiresAtMs: voiceCredentialNowMs() + 5 * 60_000,
      }))
      return
    }
    if (wanted.startsWith('connect ') || wanted.startsWith('revoke ')) {
      await ctx.reply('❌ Поддерживается только deepgram-cloud.')
      return
    }
    if (providers.length === 0) { await ctx.reply('Провайдеры расшифровки не подключены.'); return }
    try {
      const chosen = deps.transcription.select(wanted)
      await ctx.reply(chosen.audioLeavesHost
        ? `✅ ${chosen.label}. ${chosen.privacyDisclosure ?? 'Запись голоса будет уходить с сервера.'}`
        : `✅ ${chosen.label}. Аудио остаётся на хосте.`)
    } catch (error) {
      await ctx.reply(error instanceof TranscriptionUnavailableError &&
        error.reason === 'consent-not-durable'
        ? '❌ Не удалось безопасно сохранить выбор. Аудио никуда не отправится.'
        : '❌ Такого провайдера нет.')
    }
  })

  bot.command('provider', async (ctx) => {
    const wanted = (ctx.match ?? '').trim()
    const bindings = deps.providerCredentials?.bindings ?? []
    const supported = bindings.map(binding => binding.providerId).join(', ')
    if (wanted === '') {
      if (deps.providerCredentials === undefined || bindings.length === 0) {
        await ctx.reply('❌ Системное управление провайдерами недоступно.')
        return
      }
      const lines: string[] = []
      for (const binding of bindings) {
        try {
          const state = await deps.providerCredentials.inspect(binding)
          lines.push(`${state.state === 'ready' ? '✓' : '·'} ${binding.providerId} — ` +
            (state.state === 'ready' ? `готов · версия ${state.revision}` : state.state))
        } catch {
          lines.push(`· ${binding.providerId} — управление недоступно`)
        }
      }
      await ctx.reply(`${lines.join('\n')}\n\n` +
        'Подключить: /provider connect <provider>\n' +
        'Отозвать: /provider revoke <provider>')
      return
    }
    const connect = /^connect ([a-z0-9-]+)$/.exec(wanted)
    if (connect !== null) {
      const binding = bindings.find(item => item.providerId === connect[1])
      if (deps.providerCredentials === undefined || binding === undefined) {
        await ctx.reply(`❌ Доступны только: ${supported || 'нет'}.`)
        return
      }
      try {
        const challenge = await deps.providerCredentials.begin(binding)
        await ctx.reply('Откройте локальный терминал на сервере и выполните:\n' +
          `aisy provider credential set --code=${challenge.code}\n\n` +
          `Код одноразовый, действует до ${challenge.expiresAt}. Сам ключ в Telegram не отправляйте.`)
      } catch {
        await ctx.reply('❌ Не удалось открыть одноразовое подключение. Ключ не изменён.')
      }
      return
    }
    const revoke = /^revoke ([a-z0-9-]+)$/.exec(wanted)
    if (revoke !== null) {
      const binding = bindings.find(item => item.providerId === revoke[1])
      if (deps.providerCredentials === undefined || binding === undefined || ctx.from?.id === undefined) {
        await ctx.reply(`❌ Доступны только: ${supported || 'нет'}.`)
        return
      }
      const token = newProviderCredentialToken()
      if (!/^[A-Za-z0-9_-]{24}$/.test(token)) {
        await ctx.reply('❌ Не удалось создать подтверждение. Ключ не изменён.')
        return
      }
      const message = await ctx.reply(
        `⚠️ Отозвать ключ ${binding.providerId}? Доступ к API станет недоступен.`,
        { reply_markup: new InlineKeyboard().text(
          'Отозвать ключ',
          `provider:revoke:${binding.providerId}:${token}`,
        ) },
      )
      pendingProviderRevocations.clear()
      pendingProviderRevocations.set(token, Object.freeze({
        chatId: deps.allowedChatId,
        userId: ctx.from.id,
        messageId: message.message_id,
        expiresAtMs: providerCredentialNowMs() + 5 * 60_000,
        binding,
      }))
      return
    }
    await ctx.deleteMessage().catch(() => {})
    await ctx.reply('❌ Команда не распознана и удалена. Ключ не принят.\n' +
      'Использование: /provider | /provider connect <provider> | /provider revoke <provider>')
  })

  bot.command('mode', async (ctx) => {
    if (!deps.executionMode) { await ctx.reply('❌ Режимы работы не настроены.'); return }
    const wanted = (ctx.match ?? '').trim()
    if (wanted === '') {
      await ctx.reply(`${modeStatusLine(deps.executionMode.get())}\n\n` +
        'Переключить: /mode auto | confirm | plan | bypass\n' +
        'Или с телефона: 🧠 Агент → 🎛 Режим работы.')
      return
    }
    if (wanted !== 'auto' && wanted !== 'confirm' && wanted !== 'plan' && wanted !== 'bypass') {
      await ctx.reply('Пиши так: /mode auto | confirm | plan | bypass')
      return
    }
    try {
      deps.executionMode.set(wanted)
      await ctx.reply(`${wanted === 'bypass' ? '🚨' : '✅'} ${modeStatusLine(wanted)}`)
    } catch {
      await ctx.reply('❌ Не удалось надёжно сохранить режим. ' +
        modeStatusLine(deps.executionMode.get()) +
        (wanted !== 'bypass' && deps.executionMode.get() === wanted
          ? '\nБез ограничений сейчас не включено и после перезапуска не включится; ' +
            'повтори переключение позже, чтобы запись завершилась.'
          : ''))
    }
  })

  bot.command('watch', async (ctx) => {
    const args = (ctx.match ?? '').trim().split(/\s+/)
    const probe = args[0]
    const prompt = args.slice(1).join(' ')
    if (!probe || !prompt) {
      await ctx.reply('Пиши так: /watch <file:PATH|http:URL> <текст>')
      return
    }
    if (!deps.onRegisterTrigger) { await ctx.reply('❌ Триггеры не настроены.'); return }
    const binding = await deps.captureWorkBinding?.()
    if (!binding) { await ctx.reply('❌ Фоновая работа ещё не подключена.'); return }
    const res = await deps.onRegisterTrigger({ binding, kind: 'watch', prompt, probe })
    await ctx.reply(res.ok ? `✅ Наблюдение создано (id ${res.id})` : `❌ ${res.error}`)
  })

  bot.command('triggers', async (ctx) => {
    const list = (await deps.onListTriggers?.()) ?? []
    if (list.length === 0) {
      await ctx.reply('Триггеров нет.')
      return
    }
    const text = list.map((t, i) => `${i + 1}. ${t.id} · ${t.kind} · ${t.prompt}`).join('\n')
    await ctx.reply(text)
  })

  bot.command('untrigger', async (ctx) => {
    const id = (ctx.match ?? '').trim()
    if (!id) {
      await ctx.reply('Пиши так: /untrigger <id>')
      return
    }
    const ok = await deps.onCancelTrigger?.(id)
    await ctx.reply(ok === true ? '✅ Снят' : '❌ Не найден')
  })

  // --- grants command (ADR-0047 tail) ---
  const grantsText = (): string => {
    const list = deps.grants?.list() ?? []
    if (list.length === 0) {
      return '🗝 <b>Разрешения</b>\n\nПостоянных разрешений нет — про каждое ' +
        'действие, кроме безобидных, спрошу отдельно.'
    }
    return '🗝 <b>Разрешения</b>\n\n' + list.map((g) => {
      const where: Record<string, string> = {
        workspace: 'общая папка', project: 'проект', session: 'сессия',
      }
      const context = g.binding
        ? `${where[g.binding.scope] ?? g.binding.scope}: ${g.binding.projectId}`
        : 'везде'
      const status = g.status === 'active'
        ? 'работает'
        : g.disabledReason === 'legacy-unscoped'
          ? 'выключено: старое правило без привязки'
          : g.disabledReason === 'policy-revision-mismatch'
            ? 'выключено: правила изменились'
            : 'выключено: папка недоступна'
      const matcher = g.kind === 'similar'
        ? ` · похожее ${g.operation ?? g.tool} · ресурс ${g.resourceHashPrefix ?? '—'}`
        : g.kind === 'legacy-tool' ? ' · старое широкое правило' : ''
      return `• ${escapeHtml(g.tool)}${escapeHtml(matcher)} · ${g.scope} · ` +
        `${escapeHtml(context)} · ${status}`
    }).join('\n')
  }

  bot.command('grants', async (ctx) => {
    await ctx.reply(grantsText(), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🗑 Снять все', 'grants:reset'),
    })
  })

  // --- goal commands (Tier-7 D) ---
  bot.command('goal', async (ctx) => {
    const raw = (ctx.match ?? '').trim()
    if (!raw) {
      await ctx.reply('Пиши так: /goal <цель>. Можно добавить, когда остановиться: '
        + '<until:проба> — до результата, <every:10m|@daily|HH:MM> — по расписанию, '
        + '<budget:0.50> — пока хватает денег.')
      return
    }
    if (raw === 'status') {
      const res = await deps.onGoalCommand?.({ kind: 'status' })
      if (!res) { await ctx.reply('❌ Цели не настроены.'); return }
      await ctx.reply(res.ok ? res.message : `❌ ${res.error}`)
      return
    }
    if (raw === 'stop') {
      const res = await deps.onGoalCommand?.({ kind: 'stop' })
      if (!res) { await ctx.reply('❌ Цели не настроены.'); return }
      await ctx.reply(res.ok ? res.message : `❌ ${res.error}`)
      return
    }
    // Split off a trailing mode token: until[:<probe>] | every:<...> | budget:<...>
    const tokens = raw.split(/\s+/)
    const last = tokens[tokens.length - 1] ?? ''
    let mode: string
    let objective: string
    if (/^(until(:.+)?|every:.+|budget:.+)$/.test(last) && tokens.length > 1) {
      mode = last
      objective = tokens.slice(0, -1).join(' ')
    } else {
      mode = 'until'
      objective = raw
    }
    if (!deps.onGoalCommand) { await ctx.reply('❌ Цели не настроены.'); return }
    const binding = await deps.captureWorkBinding?.()
    if (!binding) { await ctx.reply('❌ Фоновая работа ещё не подключена.'); return }
    const res = await deps.onGoalCommand({ kind: 'start', binding, objective, mode })
    await ctx.reply(res.ok ? res.message : `❌ ${res.error}`)
  })

  // --- approval card taps ---
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data

    if (!data.startsWith('monitoring:')) deps.monitoringControls?.cancelForm()

    /**
     * A tap nobody can answer. Silence here is the worst possible reply: the
     * spinner stops, nothing happens, and the operator taps again. Cards and
     * screens live in memory, so every restart leaves a chat full of buttons
     * whose state is gone — say so, and take the dead button away so it cannot
     * be tapped a second time.
     */
    const deadTap = async (text: string): Promise<void> => {
      await bot.api.answerCallbackQuery(ctx.callbackQuery.id, { text }).catch(() => {})
      const messageId = ctx.callbackQuery.message?.message_id
      if (messageId !== undefined) {
        await bot.api.editMessageReplyMarkup(deps.allowedChatId, messageId).catch(() => {})
      }
    }

    const providerRevoke = /^provider:revoke:([a-z0-9-]+):([A-Za-z0-9_-]{24})$/.exec(data)
    if (data.startsWith('provider:')) {
      const token = providerRevoke?.[2]
      const intent = token === undefined ? undefined : pendingProviderRevocations.get(token)
      if (token !== undefined) pendingProviderRevocations.delete(token)
      const messageId = ctx.callbackQuery.message?.message_id
      if (token === undefined || intent === undefined || deps.providerCredentials === undefined ||
        providerRevoke?.[1] !== intent.binding.providerId || messageId === undefined ||
        intent.messageId !== messageId || intent.chatId !== ctx.chat?.id ||
        intent.userId !== ctx.from.id || providerCredentialNowMs() > intent.expiresAtMs) {
        await deadTap('Подтверждение устарело')
        return
      }
      await ctx.answerCallbackQuery({ text: 'Отзываю…' }).catch(() => {})
      await bot.api.editMessageReplyMarkup(intent.chatId, intent.messageId).catch(() => {})
      try {
        await deps.providerCredentials.revoke(intent.binding, token)
        await ctx.reply(`✅ Ключ ${intent.binding.providerId} отозван.`)
      } catch {
        await ctx.reply(`❌ Отзыв не подтверждён системным управлением. Повторите /provider revoke ${intent.binding.providerId}.`)
      }
      return
    }

    const voiceRevoke = /^voice:revoke:([A-Za-z0-9_-]{16})$/.exec(data)
    if (data.startsWith('voice:')) {
      const token = voiceRevoke?.[1]
      const intent = token === undefined ? undefined : pendingVoiceRevocations.get(token)
      // Claim synchronously before the first await. A concurrent/replayed tap
      // therefore cannot spend the same destructive approval twice.
      if (token !== undefined) pendingVoiceRevocations.delete(token)
      const messageId = ctx.callbackQuery.message?.message_id
      if (intent === undefined || deps.voiceCredentials === undefined ||
        messageId === undefined || intent.messageId !== messageId ||
        intent.chatId !== ctx.chat?.id || intent.userId !== ctx.from.id ||
        voiceCredentialNowMs() > intent.expiresAtMs) {
        await deadTap('Подтверждение устарело')
        return
      }
      await ctx.answerCallbackQuery({ text: 'Отзываю…' }).catch(() => {})
      await bot.api.editMessageReplyMarkup(intent.chatId, intent.messageId).catch(() => {})
      try {
        const result = await deps.voiceCredentials.revoke(deps.voiceCredentials.binding)
        await ctx.reply(result.state === 'revoked'
          ? `✅ Ключ Deepgram отозван (версия ${result.revision}).`
          : `⏳ Отзыв ключа Deepgram зафиксирован (версия ${result.revision}).`)
      } catch {
        await ctx.reply('❌ Отзыв не подтверждён системным управлением. Повторите /voice revoke ' +
          'deepgram-cloud.')
      }
      return
    }

    // Any tap that is not part of the key prompt means the operator moved on.
    // Without this a forgotten prompt eats the next message — including the
    // project name typed two screens later — and deletes it as a secret.
    if (!data.startsWith('cfg:')) pendingServiceKey = null

    const agentCardCallback = decodeAgentCardCallback(data)
    if (agentCardCallback !== null) {
      const messageId = ctx.callbackQuery.message?.message_id
      const chatId = ctx.chat?.id
      const userId = ctx.from?.id
      if (messageId === undefined || chatId === undefined || userId === undefined) {
        await deadTap(STALE_SCREEN)
        return
      }
      const principal = Object.freeze({ chatId, userId })
      // Synchronous one-shot spend before any await: concurrent taps cannot
      // issue two lifecycle approvals from one rendered screen.
      const intent = agentCardState.claimCallback({
        principal,
        messageId,
        verb: agentCardCallback.verb,
        token: agentCardCallback.token,
      })
      if (intent === null) {
        await deadTap(STALE_SCREEN)
        return
      }
      await ctx.answerCallbackQuery()
      if (intent.kind === 'catalog' || intent.kind === 'page') {
        await sendAgentCardCatalog(principal, intent, messageId)
        return
      }
      if (intent.kind === 'select') {
        await sendAgentCardDetail(principal, intent.target, messageId)
        return
      }
      if (intent.kind === 'create' || intent.kind === 'import' || intent.kind === 'publish') {
        agentCardState.openForm(intent.kind === 'publish'
          ? {
            principal,
            operation: 'publish',
            binding: intent.target.binding,
            target: intent.target,
          }
          : {
            principal,
            operation: intent.kind === 'create' ? 'create' : 'import-legacy',
            binding: intent.binding,
            target: null,
          })
        await bot.api.sendMessage(
          chatId,
          intent.kind === 'import'
            ? 'Пришли точное имя старой карты. Сообщение удалю сразу, потом спрошу одноразовый код.'
            : 'Пришли карту личности одним сообщением. ' +
              'Сообщение удалю сразу, затем покажу отдельную красную карточку с кодом.',
        )
        return
      }
      if (!deps.agentCards) {
        await bot.api.sendMessage(chatId, '❌ Реестр личностей не подключён.')
        return
      }
      try {
        const revision = intent.kind === 'archive'
          ? await deps.agentCards.archive({
            target: intent.target,
            approve: approvalForSession(sessionId),
          })
          : await deps.agentCards.rollback({
            target: intent.target,
            approve: approvalForSession(sessionId),
          })
        await bot.api.sendMessage(
          chatId,
          `✅ ${revision.name}@${revision.revision} · ${revision.status} · ${revision.hash.slice(0, 12)}`,
        )
      } catch {
        await bot.api.sendMessage(chatId, '❌ Личность не изменена.')
      }
      await sendAgentCardCatalog(principal)
      return
    }

    const durableTurnCallback = decodeDurableTurnCallback(data)
    if (durableTurnCallback !== null) {
      const control = deps.durableTurnControl
      const messageId = ctx.callbackQuery.message?.message_id
      const chatId = ctx.chat?.id
      const userId = ctx.from?.id
      if (control === undefined || messageId === undefined || chatId === undefined ||
        userId === undefined) {
        await deadTap('Карточка недоступна')
        return
      }
      let outcome: Readonly<{ kind: string }>
      try {
        outcome = control.recordCardDecision({
          actorId: durableTurnCallback.actorId,
          operatorId: `telegram:${userId}`,
          chatId: String(chatId),
          messageId: String(messageId),
          nonce: durableTurnCallback.nonce,
          decision: durableTurnCallback.decision === 'retry-once' ? 'confirmed' : 'rejected',
          stepUpVerified: false,
        })
      } catch {
        await deadTap('Карточка устарела')
        return
      }
      await ctx.answerCallbackQuery(
        durableTurnCallback.decision === 'retry-once'
          ? 'Повтор разрешён один раз'
          : 'Повтор отменён',
      ).catch(() => {})
      await bot.api.editMessageText(
        chatId,
        messageId,
        durableTurnCallback.decision === 'retry-once'
          ? '↻ Разрешён один точный повтор. Продолжаю восстановление.'
          : '⏹ Повтор отменён. Завершаю неоднозначную операцию безопасно.',
      ).catch(() => {})
      if (outcome.kind === 'recorded' || outcome.kind === 'replayed') {
        // The callback ends after durable state. Resume is supervisor-owned and
        // never invokes provider/tool from this handler.
        await control.requestResume()
      }
      return
    }

    await ctx.answerCallbackQuery()

    if (data === TURN_STOP_DATA) {
      const messageId = ctx.callbackQuery.message?.message_id
      if (messageId !== undefined) {
        await bot.api.editMessageReplyMarkup(deps.allowedChatId, messageId).catch(() => {})
      }
      if (currentAbort === null && deps.durableTurnControl === undefined) {
        await bot.api.sendMessage(deps.allowedChatId, 'Этот ход уже закончился.').catch(() => {})
        return
      }
      await stopTurn((text) => bot.api.sendMessage(deps.allowedChatId, text))
      return
    }

    if (data === 'error:retry') {
      const messageId = ctx.callbackQuery.message?.message_id
      const retry = pendingRetry
      if (retry === null || messageId === undefined || retry.messageId !== messageId) {
        await bot.api.sendMessage(
          deps.allowedChatId,
          'Эта ошибка уже неактуальна — повторять нечего. Напиши, что нужно сделать.',
        ).catch(() => {})
        return
      }
      // Spend the offer before the turn starts: a second tap while the first
      // retry is still running must not queue another one.
      pendingRetry = null
      await bot.api.editMessageReplyMarkup(deps.allowedChatId, messageId).catch(() => {})
      await runTurn(retry.spans)
      return
    }

    const settingsAction = decodeSettingsAction(data)
    if (settingsAction !== null) {
      const messageId = ctx.callbackQuery.message?.message_id
      const principal = ctx.chat?.id !== undefined && ctx.from?.id !== undefined
        ? Object.freeze({ chatId: ctx.chat.id, userId: ctx.from.id })
        : null
      if (settingsAction.kind === 'open' && settingsAction.screen === 'agent-cards') {
        if (principal === null) { await deadTap(STALE_SCREEN); return }
        await sendAgentCardCatalog(principal, undefined, messageId)
        return
      }
      if (principal !== null) agentCardState.invalidate(principal)
      // Any other tap means the operator moved on: stop treating the next
      // message as a secret.
      if (settingsAction.kind !== 'pick-service' && settingsAction.kind !== 'custom-service') {
        pendingServiceKey = null
      }
      if (settingsAction.kind !== 'custom-model') pendingModelName = false
      if (settingsAction.kind !== 'add-bot' && settingsAction.kind !== 'server-access') {
        pendingForm = null
      }
      const reopen = async (screen: SettingsScreen): Promise<void> => {
        const view = await settingsScreen(screen)
        await sendSettingsView(view, messageId === undefined ? undefined : { messageId })
      }
      switch (settingsAction.kind) {
        case 'open':
          await reopen(settingsAction.screen)
          return
        case 'pick-service': {
          const entry = findServiceKey(settingsAction.serviceId)
          if (!entry) { await reopen('env'); return }
          pendingServiceKey = entry.id
          pendingServiceKeyUntilMs = Date.now() + SERVICE_KEY_PROMPT_TTL_MS
          await sendSettingsView(renderServicePrompt(entry),
            messageId === undefined ? undefined : { messageId })
          return
        }
        case 'custom-service':
          pendingServiceKey = CUSTOM_SERVICE
          pendingServiceKeyUntilMs = Date.now() + SERVICE_KEY_PROMPT_TTL_MS
          await bot.api.sendMessage(
            deps.allowedChatId,
            'Пришли одним сообщением: <code>ИМЯ_ПЕРЕМЕННОЙ=значение</code>.\n' +
            'Имя — заглавными латинскими с подчёркиваниями. Сообщение удалю сразу.',
            { parse_mode: 'HTML' },
          )
          return
        case 'set-limit':
          deps.dailyBudget?.setCap?.(settingsAction.dollars)
          await reopen('limit')
          return
        case 'set-mode':
          try {
            deps.executionMode?.set(settingsAction.mode)
          } catch {
            await bot.api.sendMessage(
              deps.allowedChatId,
              '❌ Не удалось надёжно сохранить режим. ' +
              (deps.executionMode === undefined
                ? ''
                : modeStatusLine(deps.executionMode.get())) +
              (settingsAction.mode !== 'bypass' &&
                deps.executionMode?.get() === settingsAction.mode
                ? '\nБез ограничений сейчас не включено и после перезапуска не включится; ' +
                  'повтори переключение позже, чтобы запись завершилась.'
                : ''),
            )
          }
          await reopen('mode')
          return
        case 'set-model': {
          const models = deps.brainModels?.() ?? []
          const model = models[Number(settingsAction.model)]
          if (model === undefined || !deps.setBrainModel) { await reopen('agent'); return }
          deps.setBrainModel(model)
          // The adapter is built once at boot, so a live swap would lie about
          // which model answered. Restarting is honest and costs a few seconds.
          await bot.api.sendMessage(deps.allowedChatId, `🧠 Модель: ${model}. Перезапускаюсь…`)
          await runRestart(`смена модели на ${model}`, (message) =>
            bot.api.sendMessage(deps.allowedChatId, message))
          return
        }
        case 'custom-model':
          if (!deps.setBrainModel) { await reopen('agent'); return }
          pendingModelName = true
          pendingModelNameUntilMs = Date.now() + PROJECT_NAME_PROMPT_TTL_MS
          await bot.api.sendMessage(
            deps.allowedChatId,
            'Пришли название модели одним сообщением — ровно так, как её называет провайдер ' +
            '(например `anthropic/claude-opus-5` у OpenRouter).',
            { parse_mode: 'Markdown' },
          )
          return
        case 'cancel-trigger':
          await deps.onCancelTrigger?.(settingsAction.triggerId)
          await reopen('timers')
          return
        case 'set-timezone':
          deps.settings?.set('timeZone', settingsAction.timeZone)
          await reopen('timezone')
          return
        case 'set-voice': {
          // Where the recording goes is the one thing the operator must be told
          // before it goes anywhere — the same words `/voice` uses.
          try {
            const chosen = deps.transcription?.select(settingsAction.providerId)
            await reopen('system')
            if (chosen?.audioLeavesHost === true) {
              await bot.api.sendMessage(deps.allowedChatId,
                `✅ ${chosen.label}. ${chosen.privacyDisclosure ?? 'Запись голоса будет уходить с сервера.'}`)
            }
            // The only step of the setup that is proven by doing it rather than
            // by being told it works.
            await bot.api.sendMessage(deps.allowedChatId,
              '🎙 Проверим: запиши голосовое — отвечу на него как на обычное сообщение.')
          } catch (error) {
            await bot.api.sendMessage(deps.allowedChatId,
              error instanceof TranscriptionUnavailableError && error.reason === 'consent-not-durable'
                ? '❌ Не удалось безопасно сохранить выбор. Аудио никуда не отправится.'
                : '❌ Такого провайдера расшифровки нет.')
          }
          return
        }
        case 'toggle':
          deps.settings?.toggle(settingsAction.setting)
          await reopen('system')
          return
        case 'reset-grants':
          deps.grants?.revokeAll()
          // Re-render rather than announce: the operator sees the list is empty
          // instead of taking a notice at its word.
          await reopen('grants')
          return
        case 'revoke-learned':
          // Отзыв сужает полномочия, поэтому проходит всегда и не спрашивает
          // подтверждения: сомнение оператора здесь — уже решение.
          deps.learnedGrants?.revoke(settingsAction.workflowKey)
          await reopen('grants')
          return
        case 'stop-goal': {
          const stopped = await deps.onGoalCommand?.({ kind: 'stop' })
          if (stopped !== undefined && !stopped.ok) {
            await bot.api.sendMessage(deps.allowedChatId, `❌ ${stopped.error}`)
            return
          }
          // The screen redraws to "нет активной цели" — that is the receipt.
          await reopen('goals')
          return
        }
        case 'consolidate':
          await runConsolidation((text) => bot.api.sendMessage(deps.allowedChatId, text))
          return
        case 'open-staging':
          await sendStaging((text) => bot.api.sendMessage(deps.allowedChatId, text))
          return
        case 'add-bot':
          pendingForm = { kind: 'bot' }
          pendingFormUntilMs = Date.now() + PROJECT_NAME_PROMPT_TTL_MS
          await bot.api.sendMessage(
            deps.allowedChatId,
            'Пришли одной строкой: <имя> <ПЕРЕМЕННАЯ_ТОКЕНА> <chat id> [роль]\n\n' +
            'Например: <code>Помощник AISY_HELPER_TOKEN 12345678 отвечает по работе</code>\n\n' +
            'Токен должен уже лежать в этой переменной окружения — реестр его не хранит.',
            { parse_mode: 'HTML' },
          )
          return
        case 'server-access': {
          const operation = settingsAction.operation
          // Two of the five need something typed; the rest are one tap.
          if (operation === 'add-key' || operation === 'remove-key') {
            pendingForm = { kind: 'access-key', operation }
            pendingFormUntilMs = Date.now() + PROJECT_NAME_PROMPT_TTL_MS
            await bot.api.sendMessage(
              deps.allowedChatId,
              operation === 'add-key'
                ? 'Пришли публичный ключ одной строкой (ssh-ed25519 … или ssh-rsa …). ' +
                  'Приватный ключ я не приму.'
                : 'Пришли публичный ключ, который нужно убрать.',
            )
            return
          }
          await runAccess(operation, '', (text) => bot.api.sendMessage(deps.allowedChatId, text))
          await reopen('server')
          return
        }
        case 'restart': {
          await bot.api.sendMessage(deps.allowedChatId, '🔄 Перезапускаюсь…')
          await runRestart('перезапуск из настроек', (message) =>
            bot.api.sendMessage(deps.allowedChatId, message))
          return
        }
        case 'reconnect-brain': {
          if (!deps.reconnectBrain) {
            await bot.api.sendMessage(deps.allowedChatId, '❌ Переподключение недоступно.')
            return
          }
          await deps.reconnectBrain()
          await bot.api.sendMessage(
            deps.allowedChatId,
            '🔄 Сбрасываю мозг и перезапускаюсь в режиме настройки. Напиши /start через полминуты.',
          )
          await runRestart('переподключение мозга', (message) =>
            bot.api.sendMessage(deps.allowedChatId, message))
          return
        }
      }
    }

    // Settings toggle (event-bridge callback) — flip + re-render the panel.
    if (data.startsWith('set:')) {
      const key = data.slice(4)
      if (deps.settings && (key === 'showCostPerTurn' || key === 'budgetEnabled' || key === 'debug')) {
        deps.settings.toggle(key)
        const msg = settingsPanel()
        if (msg) {
          await ctx.editMessageText(msg.html, {
            parse_mode: 'HTML',
            ...(msg.buttons ? { reply_markup: toInlineKeyboard(msg.buttons) } : {}),
          })
        }
      }
      return
    }
    if (data === 'spend:refresh') {
      await sendSpendReport()
      return
    }
    // Budget alert actions: details → spend report; resume → lift enforcement.
    if (data === 'budget:details') {
      await sendSpendReport()
      return
    }
    if (data === 'budget:resume') {
      deps.settings?.set('budgetEnabled', false)
      await bot.api.sendMessage(deps.allowedChatId, '▶️ Бюджет-гейт снят. Снова включить — в ⚙️ Настройках.')
      return
    }

    // Nightly staging approval (Tier-4 C2). ctx.answerCallbackQuery() was already
    // called at the top of this handler; the unjudged branch re-answers with a toast
    // via a separate call (Telegram accepts the second answer when text differs).
    if (data === 'goal:start' || data === 'goal:drop') {
      const messageId = ctx.callbackQuery.message?.message_id
      const proposal = pendingGoal
      pendingGoal = null
      if (messageId !== undefined) {
        await bot.api.editMessageReplyMarkup(deps.allowedChatId, messageId).catch(() => {})
      }
      if (proposal === null || proposal.messageId !== messageId) {
        await ctx.reply('Это предложение уже неактуально. Скажи, чего добиться, — предложу снова.')
        return
      }
      if (data === 'goal:drop') {
        await ctx.reply('🗑 Не берусь.')
        return
      }
      const binding = await deps.captureWorkBinding?.()
      if (!binding) { await ctx.reply('❌ Фоновая работа ещё не подключена.'); return }
      const started = await deps.onGoalCommand?.({
        kind: 'start', binding, objective: proposal.objective, mode: proposal.mode,
      })
      await ctx.reply(started === undefined
        ? '❌ Цели не настроены.'
        : started.ok ? started.message : `❌ ${started.error}`)
      return
    }

    if (data.startsWith('trig:ok:') || data.startsWith('trig:no:')) {
      const id = data.slice('trig:ok:'.length)
      const messageId = ctx.callbackQuery.message?.message_id
      if (messageId !== undefined) {
        await bot.api.editMessageReplyMarkup(deps.allowedChatId, messageId).catch(() => {})
      }
      if (data.startsWith('trig:no:')) {
        await deps.onCancelTrigger?.(id)
        await ctx.reply('🗑 Не буду.')
        return
      }
      const confirmed = await deps.onConfirmTrigger?.(id)
      await ctx.reply(confirmed === true
        ? '✅ Включил. Снять — ⚙️ Настройки → ⏳ Таймеры.'
        : '❌ Этот таймер уже не найти — попроси снова.')
      return
    }

    if (data.startsWith('nightly:approve:')) {
      const id = data.slice('nightly:approve:'.length)
      try {
        await deps.onApproveNightly?.(id)
        await ctx.reply('✅ Правка применена в память.')
      } catch {
        await ctx.reply('❌ Не удалось применить — похоже, память успела измениться.')
      }
      return
    }
    if (data === 'nightly:unjudged') {
      // Override the silent top-level answer with a toast explaining why.
      await bot.api.answerCallbackQuery(ctx.callbackQuery.id, { text: 'Ещё не проверено судьёй' })
      return
    }

    // The `/grants` command's own button. The settings screen uses the settings
    // codec instead; both end in the same revokeAll.
    if (data === 'grants:reset') {
      deps.grants?.revokeAll()
      await ctx.editMessageText('Разрешения сброшены.').catch(() => {})
      return
    }

    const monitoringPrincipal = (): TelegramMonitoringPrincipal | null => {
      const chatId = ctx.chat?.id
      const userId = ctx.from?.id
      // A source catalogue is operator-private even though its rows are
      // redacted. This fixed root callback must pass the same exact private-chat
      // identity as every tokenized mutation below it.
      return chatId === deps.allowedChatId && userId === deps.allowedChatId
        ? { chatId, userId }
        : null
    }
    const editMonitoringView = async (view: TelegramMonitoringView): Promise<void> => {
      await ctx.editMessageText(view.text, {
        ...(view.buttons.length === 0 ? {} : { reply_markup: toInlineKeyboard(view.buttons) }),
      }).catch(() => {})
    }

    if (data === 'monitoring:open') {
      const principal = monitoringPrincipal()
      const messageId = ctx.callbackQuery.message?.message_id
      if (!deps.monitoringControls || principal === null || messageId === undefined) {
        await deadTap(NOT_WIRED)
        return
      }
      try {
        await editMonitoringView(deps.monitoringControls.open({ principal, messageId }))
      } catch {
        await ctx.reply('❌ Список источников недоступен.')
      }
      return
    }

    if (data.startsWith('monitoring:v1:')) {
      const principal = monitoringPrincipal()
      const messageId = ctx.callbackQuery.message?.message_id
      if (!deps.monitoringControls || principal === null || messageId === undefined) {
        await deadTap(NOT_WIRED)
        return
      }
      const outcome = deps.monitoringControls.handle({ data, principal, messageId })
      if (outcome.kind === 'view') {
        await editMonitoringView(outcome.view)
      } else if (outcome.kind === 'prompt' || outcome.kind === 'notice') {
        await bot.api.sendMessage(deps.allowedChatId, outcome.text)
      } else {
        await deadTap(outcome.text)
      }
      return
    }

    if (data.startsWith('project-lifecycle:v1:')) {
      if (!deps.projectLifecycleControls) {
        await deadTap(NOT_WIRED)
        return
      }
      const chatId = ctx.chat?.id
      if (chatId === undefined) return
      try {
        const outcome = await deps.projectLifecycleControls.handleAuthenticatedCallback({
          data,
          chatId,
          updateId: ctx.update.update_id,
        })
        if (outcome.kind === 'unavailable') {
          await ctx.reply(outcome.text)
          return
        }
        if (outcome.kind === 'confirmation') {
          await ctx.editMessageText(outcome.view.text, {
            reply_markup: toInlineKeyboard(outcome.view.buttons),
          }).catch(() => {})
          return
        }
        try {
          await ctx.editMessageText(outcome.text)
        } catch {
          await ctx.reply(outcome.text)
        }
      } catch {
        await ctx.reply('❌ Не удалось безопасно обработать действие с контекстом.')
      }
      return
    }

    if (data.startsWith('mcp:')) {
      if (!deps.mcpControls) {
        await deadTap(NOT_WIRED)
        return
      }
      const outcome = await deps.mcpControls.handle(data)
      if (outcome.kind === 'notice') {
        await bot.api.sendMessage(deps.allowedChatId, outcome.text)
        return
      }
      if (outcome.kind === 'await-server') {
        // The server line arrives as the next ordinary message; the deadline
        // stops an operator who tapped and forgot from having their next
        // sentence read as a command line.
        pendingMcpServer = true
        pendingMcpServerUntilMs = Date.now() + PROJECT_NAME_PROMPT_TTL_MS
        await bot.api.sendMessage(deps.allowedChatId, outcome.view.text, { parse_mode: 'Markdown' })
        return
      }
      await ctx.editMessageText(outcome.view.text, {
        parse_mode: 'Markdown',
        ...(outcome.view.buttons.length === 0
          ? {}
          : { reply_markup: toInlineKeyboard(outcome.view.buttons) }),
      }).catch(() => {})
      if (outcome.kind === 'stale') {
        await bot.api.answerCallbackQuery(ctx.callbackQuery.id, {
          text: STALE_SCREEN,
        }).catch(() => {})
      }
      return
    }

    if (data.startsWith('skill:')) {
      if (!deps.skillControls) {
        await deadTap(NOT_WIRED)
        return
      }
      const outcome = deps.skillControls.handle(data)
      if (outcome.kind === 'notice') {
        await bot.api.sendMessage(deps.allowedChatId, outcome.text)
        return
      }
      await ctx.editMessageText(outcome.view.text, {
        ...(outcome.view.buttons.length === 0
          ? {}
          : { reply_markup: toInlineKeyboard(outcome.view.buttons) }),
      }).catch(() => {})
      if (outcome.kind === 'stale') {
        await bot.api.answerCallbackQuery(ctx.callbackQuery.id, {
          text: STALE_SCREEN,
        }).catch(() => {})
      }
      return
    }

    if (data.startsWith('session:')) {
      if (!deps.sessionControls) {
        await deadTap(NOT_WIRED)
        return
      }
      const tap = deps.sessionControls.handle(data)
      if (tap.kind === 'new') {
        await startNewSessionFromButton()
        return
      }
      if (tap.kind === 'resume') {
        if (!deps.resumeSession) {
          await ctx.reply(NOT_WIRED)
          return
        }
        const result = await deps.resumeSession(tap.sessionId)
        if (!result.ok) {
          await ctx.reply(result.errorCode === 'ALREADY_ACTIVE'
            ? 'Это и есть текущая сессия.'
            : `❌ Не удалось вернуться в сессию (${result.errorCode}).`)
          return
        }
        await ctx.editMessageText(`↩️ Возвращаюсь в сессию «${tap.name}».`).catch(() => {})
        // Same reasoning as a project switch: the workspace root, memory scope,
        // transcript and approval port are derived once at boot, so the honest
        // way into another session is to come back up in it.
        await runRestart('возврат в сессию', (message) =>
          bot.api.sendMessage(deps.allowedChatId, message))
        return
      }
      await ctx.editMessageText(tap.view.text, {
        ...(tap.view.buttons.length === 0
          ? {}
          : { reply_markup: toInlineKeyboard(tap.view.buttons) }),
      }).catch(() => {})
      if (tap.kind === 'stale') {
        await bot.api.answerCallbackQuery(ctx.callbackQuery.id, {
          text: STALE_SCREEN,
        }).catch(() => {})
      }
      return
    }

    if (data.startsWith('project:')) {
      if (!deps.projectControls) {
        await deadTap(NOT_WIRED)
        return
      }
      const outcome = await deps.projectControls.handle(data)
      if (outcome.kind === 'switched') {
        await ctx.editMessageText(outcome.text).catch(() => {})
        // The workspace root, memory scope, transcript and approval port are
        // all derived once at boot. Re-deriving them mid-process would leave
        // six subsystems to keep in step; the selection is durable, so coming
        // back up in the new context is both simpler and impossible to get
        // half-right.
        await runRestart('переключение проекта', (message) =>
          bot.api.sendMessage(deps.allowedChatId, message))
        return
      }
      if (outcome.kind === 'unavailable') {
        await ctx.reply(outcome.text)
        return
      }
      if (outcome.kind === 'sessions') {
        await sendSessionsScreen()
        return
      }
      if (outcome.kind === 'create-prompt') {
        if (!deps.createProject) {
          await ctx.reply(NOT_WIRED)
          return
        }
        pendingProjectName = true
        pendingProjectNameUntilMs = Date.now() + PROJECT_NAME_PROMPT_TTL_MS
        await bot.api.sendMessage(
          deps.allowedChatId,
          '📁 Как назвать проект? Пришли название одним сообщением — заведу папку и переключусь в неё.',
        )
        return
      }
      await ctx.editMessageText(outcome.view.text, {
        reply_markup: toInlineKeyboard(outcome.view.buttons),
      }).catch(() => {})
      if (outcome.kind === 'stale') {
        await bot.api.answerCallbackQuery(ctx.callbackQuery.id, {
          text: STALE_SCREEN,
        }).catch(() => {})
      }
      return
    }

    const cb = decodeCallback(data)
    if (!cb) {
      await deadTap(STALE_SCREEN)
      return
    }
    const card = pending.get(cb.cardId)
    if (!card) {
      // Approval cards are held in memory, so a restart empties them while the
      // buttons stay in the chat. The action is gone; asking again is the only
      // honest answer — issuing a fresh approval from here would confirm
      // something the operator can no longer see.
      await deadTap(STALE_SCREEN)
      return
    }
    const outcome = await resolveTap(cb, card.chatId, card.action, { gateway: deps.gateway, now })
    await applyOutcome(outcome, cb, card)
  })

  // --- messages: step-up code capture, else Hermes coalesce / steer ---
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    if (text.startsWith('/')) return // commands are handled by bot.command

    // Reply-keyboard menu taps arrive as plain text — route them to panels
    // instead of feeding the label to the agent as a task.
    const menuAction = resolveMenu(text)
    if (menuAction) {
      await handleMenu(menuAction)
      return
    }

    if (deps.monitoringControls && ctx.from?.id !== undefined) {
      const outcome = deps.monitoringControls.handleText({
        text,
        principal: { chatId: ctx.chat.id, userId: ctx.from.id },
      })
      if (outcome !== null) {
        await ctx.deleteMessage().catch(() => {})
        if (outcome.kind === 'view') {
          await bot.api.editMessageText(
            deps.allowedChatId,
            outcome.messageId,
            outcome.view.text,
            { reply_markup: toInlineKeyboard(outcome.view.buttons) },
          ).catch(async () => {
            await bot.api.sendMessage(deps.allowedChatId, '✅ Источник изменён. Открой «Монитор» заново.')
          })
        } else {
          await bot.api.sendMessage(deps.allowedChatId, outcome.text)
        }
        return
      }
    }

    // A service key must never reach the agent, the transcript or the journal:
    // it is answered here, one screen earlier than any turn.
    if (pendingServiceKey !== null && Date.now() > pendingServiceKeyUntilMs) {
      pendingServiceKey = null
    }
    if (pendingServiceKey !== null && deps.serviceKeys) {
      const target = pendingServiceKey
      pendingServiceKey = null
      let deleted = true
      try {
        await ctx.deleteMessage()
      } catch {
        deleted = false
      }
      const result = target === CUSTOM_SERVICE
        ? deps.serviceKeys.storeCustom(text)
        : await deps.serviceKeys.store(target, text)
      const tail = deleted ? '' : '\n\n⚠️ Удали сообщение с ключом вручную.'
      await bot.api.sendMessage(
        deps.allowedChatId,
        result.ok
          ? `✅ Сохранил в ${result.envKey}. Перезапуск не нужен.` +
            (result.verified ? ' Сервис ключ принял.' : ' Проверить у сервиса не смог — узнаем при первом использовании.') +
            tail
          : `❌ ${SERVICE_KEY_ERRORS[result.errorCode] ?? 'Ключ не сохранён.'}${tail}`,
      )
      return
    }

    if (pendingMcpServer && Date.now() > pendingMcpServerUntilMs) pendingMcpServer = false
    if (pendingMcpServer && deps.mcpControls) {
      pendingMcpServer = false
      // Connecting to an unknown server takes seconds and can hang; say so
      // before the await, or the silence reads as a swallowed message.
      await bot.api.sendMessage(deps.allowedChatId, '🔌 Пробую подключиться к серверу…')
      const outcome = await deps.mcpControls.add(text)
      if (outcome.kind === 'notice') {
        await bot.api.sendMessage(deps.allowedChatId, outcome.text)
        return
      }
      await bot.api.sendMessage(deps.allowedChatId, outcome.view.text, {
        parse_mode: 'Markdown',
        ...(outcome.view.buttons.length === 0
          ? {}
          : { reply_markup: toInlineKeyboard(outcome.view.buttons) }),
      })
      return
    }

    if (pendingModelName && Date.now() > pendingModelNameUntilMs) pendingModelName = false
    if (pendingModelName && deps.setBrainModel) {
      pendingModelName = false
      // A model id is a provider's token, not free text: anything with spaces or
      // control characters is a mistyped message, not a model.
      const model = text.trim()
      if (model.length === 0 || model.length > 100 || /[\s\u0000-\u001f]/u.test(model)) {
        await bot.api.sendMessage(
          deps.allowedChatId,
          '❌ Это не похоже на название модели. Открой 🧠 Агент и попробуй ещё раз.',
        )
        return
      }
      deps.setBrainModel(model)
      await bot.api.sendMessage(deps.allowedChatId, `🧠 Модель: ${model}. Перезапускаюсь…`)
      await runRestart(`смена модели на ${model}`, (message) =>
        bot.api.sendMessage(deps.allowedChatId, message))
      return
    }

    if (pendingProjectName && Date.now() > pendingProjectNameUntilMs) pendingProjectName = false
    if (pendingProjectName && deps.createProject) {
      pendingProjectName = false
      const created = await deps.createProject(text)
      if (!created.ok) {
        await bot.api.sendMessage(deps.allowedChatId, `❌ ${created.error}`)
        return
      }
      await bot.api.sendMessage(
        deps.allowedChatId,
        `📁 Проект «${created.name}» создан: ${created.root}\nПерезапускаюсь в нём.`,
      )
      await runRestart('новый проект', (message) =>
        bot.api.sendMessage(deps.allowedChatId, message))
      return
    }

    // A step-up code completes an approval already claimed by an AgentCard
    // form; it must be handled before attempting to claim another form input.
    if (pendingStepUp) {
      const ps = pendingStepUp
      pendingStepUp = null
      // Кодовое слово — такой же секрет, как ключ сервиса, и оно приходит тем
      // же способом: сообщением в чат. Ключи бот удаляет сразу, а этот текст
      // оставался висеть в переписке, где его прочитает любой, кто однажды
      // получит доступ к телефону. Удаляем до проверки: неверный код — тоже
      // попытка угадать секрет, и её тоже незачем хранить.
      await ctx.deleteMessage().catch(() => {})
      const outcome = await resolveTap(ps.cb, ps.card.chatId, ps.card.action, { gateway: deps.gateway, now }, { stepUpProof: text })
      await applyOutcome(outcome, ps.cb, ps.card)
      return
    }

    if (pendingForm !== null && Date.now() > pendingFormUntilMs) pendingForm = null
    if (pendingForm !== null) {
      const form = pendingForm
      pendingForm = null
      if (form.kind === 'bot') {
        await addBot(
          text.trim().split(/\s+/).filter((word) => word !== ''),
          (message) => bot.api.sendMessage(deps.allowedChatId, message),
        )
        return
      }
      await runAccess(form.operation, text.trim(),
        (message) => bot.api.sendMessage(deps.allowedChatId, message))
      return
    }

    const principal = ctx.from?.id === undefined
      ? null
      : Object.freeze({ chatId: ctx.chat.id, userId: ctx.from.id })
    const agentCardForm = principal === null
      ? Object.freeze({ kind: 'none' as const })
      : agentCardState.claimForm(principal)
    if (agentCardForm.kind === 'foreign' || agentCardForm.kind === 'busy') return
    if (agentCardForm.kind === 'claimed') {
      if (principal === null) {
        agentCardForm.finish()
        return
      }
      const form = agentCardForm.form
      try {
        const current = form.binding.scope === 'project'
          ? await deps.captureWorkBinding?.()
          : undefined
        const sameBinding = form.binding.scope === 'workspace' || (
          current !== undefined && current.scope !== 'workspace' &&
          form.binding.projectId === current.projectId
        )
        if (!sameBinding || deps.agentCards === undefined) {
          await bot.api.sendMessage(deps.allowedChatId, STALE_SCREEN)
          return
        }
        await ctx.deleteMessage().catch(() => {})
        const approve = approvalForSession(sessionId)
        const revision = form.operation === 'create'
          ? await deps.agentCards.createDraft({ markdown: text, binding: form.binding, approve })
          : form.operation === 'publish' && form.target !== null
            ? await deps.agentCards.publishDraft({ target: form.target, markdown: text, approve })
            : form.operation === 'import-legacy'
              ? await deps.agentCards.importLegacy({
                target: { binding: form.binding, name: text.trim() },
                approve,
              })
              : null
        if (revision === null) {
          await bot.api.sendMessage(deps.allowedChatId, STALE_SCREEN)
          return
        }
        await bot.api.sendMessage(
          deps.allowedChatId,
          `✅ ${revision.name}@${revision.revision} · ${revision.status} · ${revision.hash.slice(0, 12)}`,
        )
        await sendAgentCardCatalog(principal)
        return
      } catch {
        await bot.api.sendMessage(deps.allowedChatId, '❌ Личность не изменена.')
        await sendAgentCardCatalog(principal)
        return
      } finally {
        agentCardForm.finish()
      }
    }

    let span
    try {
      span = await deps.gateway.onUpdate(ctx.update as unknown as TelegramUpdate)
    } catch {
      await ctx.reply('❌ Сообщение не прошло проверку доступа.')
      return
    }

    // Lifecycle commands must run before every other context command: archive
    // always requires its own two-step authority and must never be reinterpreted
    // as a Session or Project selection request.
    if (deps.projectLifecycleControls) {
      try {
        const outcome = await deps.projectLifecycleControls.handleAuthenticatedText({
          text: span.text,
          chatId: ctx.chat.id,
          updateId: ctx.update.update_id,
        })
        if (outcome) {
          if (outcome.kind === 'confirmation') {
            await ctx.reply(outcome.view.text, {
              reply_markup: toInlineKeyboard(outcome.view.buttons),
            })
          } else {
            await ctx.reply(outcome.text)
          }
          return
        }
      } catch {
        await ctx.reply('❌ Не удалось безопасно обработать действие с контекстом.')
        return
      }
    }

    if (deps.sessionControls) {
      try {
        const outcome = deps.sessionControls.handleAuthenticatedText({
          text: span.text,
          chatId: ctx.chat.id,
          updateId: ctx.update.update_id,
        })
        if (outcome) {
          await ctx.reply(outcome.kind === 'view' ? outcome.view.text : outcome.text)
          return
        }
      } catch {
        await ctx.reply('❌ Не удалось безопасно обработать команду сессии.')
        return
      }
    }

    // Deterministic high-frequency Project selection is authenticated by the
    // Gateway first, then routed through the same ProjectService as callbacks.
    if (deps.projectControls) {
      try {
        const outcome = await deps.projectControls.handleAuthenticatedText({
          text: span.text,
          chatId: ctx.chat.id,
          updateId: ctx.update.update_id,
        })
        if (outcome) {
          if (outcome.kind === 'switched' || outcome.kind === 'unavailable') {
            await ctx.reply(outcome.text)
            if (outcome.kind === 'switched') {
              await runRestart('переключение проекта', (message) =>
                bot.api.sendMessage(deps.allowedChatId, message))
            }
          } else if (outcome.kind === 'view' || outcome.kind === 'stale') {
            await ctx.reply(outcome.view.text, {
              reply_markup: toInlineKeyboard(outcome.view.buttons),
            })
          }
          return
        }
      } catch {
        await ctx.reply('❌ Не удалось безопасно выбрать контекст.')
        return
      }
    }

    try {
      deps.observeAuthenticatedOperatorText?.({
        text: span.text,
        sessionId,
        updateId: ctx.update.update_id,
      })
    } catch {
      // Preference learning is a form-only overlay. A broken private store
      // degrades to SOUL defaults and cannot block the operator's turn.
    }

    if (agentStateHolder.value === 'running') {
      steer.enqueue([span.text], Date.now(), {
        updateId: ctx.update.update_id,
        unixSeconds: ctx.message.date,
      })
      await ctx.reply(STEER_ACK)
      return
    }

    // Only the next ordinary text after the code-owned morning notice can use
    // its deictic “Покажи”. Old pending proposals cannot hijack an unrelated
    // conversation, and an in-flight turn keeps steering precedence.
    const bareShow = /^(?:покажи|show)[.!?…]*$/iu.test(span.text.trim())
    const shortcut = nightlyShortcut
    nightlyShortcut = 'none'
    if (bareShow && shortcut === 'zero-staging') {
      await ctx.reply('Новых правок нет.')
      return
    }
    if (bareShow && shortcut === 'partial-empty') {
      await ctx.reply('Доступных правок нет; часть проектов не проверена.')
      return
    }
    if (bareShow && shortcut === 'open-staging' && deps.getStaging !== undefined) {
      try {
        const stagedItems = await deps.getStaging()
        if (stagedItems.length > 0) {
          await sendStaging(
            (text) => bot.api.sendMessage(deps.allowedChatId, text),
            stagedItems,
          )
          return
        }
        await ctx.reply('Правок уже нет.')
        return
      } catch {
        await ctx.reply('Не смогла открыть правки памяти. Попробуй ещё раз.')
        return
      }
    }

    buffered.push({
      text: span.text,
      provenance: span.provenance,
      source: {
        updateId: ctx.update.update_id,
        unixSeconds: ctx.message.date,
      },
    })
    scheduleFlush()
  })

  const attachmentInbox = deps.attachmentInbox
  const voiceIngress = deps.voiceIngress
  const captureAttachmentBinding = deps.captureWorkBinding
  bot.on([
    'message:document',
    'message:audio',
    'message:photo',
    'message:video',
    'message:voice',
    'message:animation',
  ], async (ctx) => {
    const rawMessage = ctx.message as unknown as Record<string, unknown>
    const isForwardedMedia = rawMessage['forward_origin'] !== undefined ||
      rawMessage['forward_from'] !== undefined || rawMessage['forward_from_chat'] !== undefined
    if (isForwardedMedia && forwardBatchRuntime) {
      try {
        const span = await deps.gateway.onUpdate(ctx.update as unknown as TelegramUpdate)
        const mediaKind = ctx.message.document ? 'документ'
          : ctx.message.audio ? 'аудио'
            : ctx.message.photo ? 'фото'
              : ctx.message.video ? 'видео'
                : ctx.message.voice ? 'голосовое сообщение'
                  : 'анимация'
        const outcome = await forwardBatchRuntime.acceptForward({
          updateId: ctx.update.update_id,
          messageId: ctx.message.message_id,
          unixSeconds: ctx.message.date,
          text: span.text.length > 0 ? span.text : `[Пересланное вложение без подписи: ${mediaKind}]`,
          ...(span.sourceRef === undefined ? {} : { sourceRef: span.sourceRef }),
        })
        if (outcome.kind === 'accepted' || outcome.kind === 'duplicate') {
          await showForwardProgress()
        } else if (outcome.kind === 'consumed') {
          await ctx.reply('📨 Это пересланное сообщение уже входило в обработанную пачку.')
        } else if (outcome.kind === 'tampered') {
          await ctx.reply('❌ Повтор пересланного сообщения не совпал с сохранёнными данными.')
        } else if (outcome.kind === 'capped') {
          await ctx.reply(`📨 Лимит пачки — ${outcome.count} сообщений.`)
        } else {
          await dismissForwardRecovery()
        }
      } catch {
        await ctx.reply('❌ Не удалось безопасно сохранить пересланное вложение в пачку.')
      }
      // A forwarded attachment belongs only to the durable batch. Never feed
      // the same Telegram update into voice or attachment ingestion as a
      // second, independently authorised action.
      return
    }
    // A file named SKILL.md is an install, not an attachment to talk about.
    // Keyed on the name alone: there is no pending state to expire, so an
    // unrelated message can never be swallowed as a skill.
    const sentDocument = ctx.message.document
    if (sentDocument !== undefined && deps.skillControls &&
      (sentDocument.file_name ?? '').toLowerCase() === 'skill.md') {
      if ((sentDocument.file_size ?? 0) > MAX_SKILL_DOCUMENT_BYTES) {
        await ctx.reply('❌ Файл больше 256 КБ — это не похоже на навык.')
        return
      }
      let text: string
      try {
        text = await downloadTelegramText(deps.token, await ctx.api.getFile(sentDocument.file_id))
      } catch {
        await ctx.reply('❌ Не смог забрать файл из Telegram. Пришли ещё раз.')
        return
      }
      const outcome = deps.skillControls.install(text)
      if (outcome.kind === 'notice') await ctx.reply(outcome.text)
      else {
        await bot.api.sendMessage(deps.allowedChatId, outcome.view.text, {
          ...(outcome.view.buttons.length === 0
            ? {}
            : { reply_markup: toInlineKeyboard(outcome.view.buttons) }),
        })
      }
      return
    }
    if (ctx.message.voice && voiceIngress && !isForwardedMedia) {
      // A background runtime is only meaningful next to the v2 turn runtime; on
      // the legacy path the turn runs in the current context, which is the very
      // context the recording was captured in. Requiring it there made voice
      // unavailable for no reason.
      if (!captureAttachmentBinding ||
        (deps.acquireTurnRuntime !== undefined && !deps.acquireBackgroundRuntime)) {
        await ctx.reply('🎙 Голос пока недоступен — отправьте сообщение текстом.')
        return
      }
      if (deps.transcription?.selected() === null) {
        await ctx.reply(
          '🎙 Расшифровка ещё не выбрана: ⚙️ Настройки → 🔧 Системные — там же видно, ' +
          'куда уходит запись. Ключ добавляется в ⚙️ Настройки → 🔑 Ключи.',
        )
        return
      }
      if (agentStateHolder.value === 'running' || buffered.length > 0 || flushTimer !== null) {
        await ctx.reply('🎙 Дождитесь завершения текущего ответа и повторите голосовое сообщение.')
        return
      }
      let binding: ResolvedWorkBinding
      try {
        binding = Object.freeze(resolvedWorkBinding(structuredClone(
          await captureAttachmentBinding(),
        )))
      } catch {
        await ctx.reply('❌ Не удалось безопасно определить контекст голосового сообщения.')
        return
      }
      await runTurn(
        async (signal) => {
          try {
            const outcome = await voiceIngress.handle({
              binding,
              update: ctx.update as unknown as TelegramUpdate,
              signal,
            })
            if (outcome.kind === 'cancelled') return null
            if (outcome.kind === 'degraded') {
              if (outcome.policy !== 'text-only' && outcome.policy !== 'reject') {
                throw new Error('VOICE_DEGRADE_POLICY_INVALID')
              }
              await ctx.reply(outcome.policy === 'text-only'
                ? '🎙 Не удалось обработать голос — отправьте сообщение текстом.'
                : '🎙 Голосовые сообщения временно недоступны.')
              return null
            }
            if (outcome.binding.operatorId !== binding.operatorId ||
              outcome.binding.profileId !== binding.profileId ||
              outcome.binding.projectId !== binding.projectId ||
              outcome.binding.sessionId !== binding.sessionId ||
              outcome.binding.scope !== binding.scope ||
              outcome.span.provenance !== 'untrusted' || outcome.span.channel !== 'voice' ||
              typeof outcome.span.text !== 'string' || outcome.span.text.length === 0 ||
              outcome.span.text.includes('\0') ||
              Buffer.byteLength(outcome.span.text, 'utf8') > 1024 * 1024) {
              throw new Error('VOICE_OUTCOME_BINDING_MISMATCH')
            }
            return [{ text: outcome.span.text, provenance: 'untrusted' as const }]
          } catch {
            if (!signal.aborted) {
              await ctx.reply('❌ Не удалось безопасно обработать голосовое сообщение.')
            }
            return null
          }
        },
        deps.acquireBackgroundRuntime === undefined
          ? undefined
          : async (approval) => deps.acquireBackgroundRuntime!(binding, approval),
        false,
        makeTelegramTurnAuthority(deps.allowedChatId, [{
          updateId: ctx.update.update_id,
          unixSeconds: ctx.message.date,
        }]),
      )
      return
    }
    if (!attachmentInbox) {
      await ctx.reply(ctx.message.voice
        ? '🎙 Голос пока недоступен — отправьте сообщение текстом.'
        : '📎 Приём вложений пока недоступен — отправьте сообщение текстом.')
      return
    }
    const rawGroupId = ctx.message.media_group_id
    const groupId = typeof rawGroupId === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(rawGroupId)
      ? rawGroupId
      : null
    if (groupId !== null) {
      const groupKey = `${deps.allowedChatId}:${groupId}`
      let group = mediaGroups.get(groupKey)
      if (group === undefined) {
        group = {
          binding: Promise.resolve().then(async () => {
            const binding = await captureAttachmentBinding?.()
            if (binding === undefined) throw new Error('ATTACHMENT_BINDING_UNAVAILABLE')
            return binding
          }),
          tail: Promise.resolve(),
          received: 0,
          savedFileIds: [],
          failed: 0,
          timer: null,
        }
        mediaGroups.set(groupKey, group)
      }
      const withinTelegramAlbumLimit = group.received < 10
      group.received += 1
      if (withinTelegramAlbumLimit) {
        group.tail = group.tail.then(async () => {
          try {
            const binding = await group!.binding
            const saved = await ingestTelegramAttachmentUpdate({
              inbox: attachmentInbox,
              binding,
              update: ctx.update as unknown as TelegramUpdate,
            })
            group!.savedFileIds.push(saved.fileId)
          } catch {
            group!.failed += 1
          }
        })
      } else {
        group.failed += 1
      }
      await group.tail
      if (group.timer !== null) clearTimeout(group.timer)
      group.timer = setTimeout(() => {
        if (mediaGroups.get(groupKey) !== group) return
        mediaGroups.delete(groupKey)
        void group!.tail.then(async () => {
          const saved = group!.savedFileIds
          const text = group!.failed === 0
            ? `📎 Альбом сохранён во входящие: ${saved.length} ${russianFileWord(saved.length)}\n${saved.join('\n')}`
            : `❌ Альбом сохранён не полностью: ${saved.length} из ${group!.received}. Повторите отправку.`
          await bot.api.sendMessage(deps.allowedChatId, text).catch(() => undefined)
        })
      }, mediaGroupDebounceMs)
      return
    }
    try {
      const binding = await captureAttachmentBinding?.()
      if (binding === undefined) throw new Error('ATTACHMENT_BINDING_UNAVAILABLE')
      const saved = await ingestTelegramAttachmentUpdate({
        inbox: attachmentInbox,
        binding,
        update: ctx.update as unknown as TelegramUpdate,
      })
      await ctx.reply(`📎 Файл сохранён во входящие: ${saved.fileId}`)
    } catch {
      await ctx.reply('❌ Не удалось безопасно сохранить вложение.')
    }
  })

  return {
    bot,
    resumeDurableTurn: async (turn: TelegramExecutionTurnV1): Promise<boolean> =>
      runTurn(
        [],
        undefined,
        true,
        { turnId: turn.turnId, turnTs: turn.turnTs },
        true,
        turn,
      ),
    recoverDurableTurnCard: deliverDurableTurnCard,
    resumeForwardBatch: async (): Promise<void> => {
      if (!forwardBatchRuntime) return
      const state = await forwardBatchRuntime.recover()
      if (!state) return
      if (state.status === 'collecting') {
        await showForwardProgress().catch(() => undefined)
      } else {
        await dismissForwardRecovery()
      }
    },
    runProactiveTurn: async (
      prompt: string,
      opts?: { provenance?: Provenance; binding?: ResolvedWorkBinding },
    ): Promise<void> => {
      // Don't race an in-flight operator turn (it owns currentAbort/
      // pendingStepUp). Wait for idle (bounded ~30s); if still busy, skip this firing.
      for (let i = 0; i < 60 && agentStateHolder.value === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 500))
      }
      if (agentStateHolder.value === 'running') return   // rare: operator turn > ~30s — skip; schedule/watch re-fires next tick
      if (deps.acquireTurnRuntime) {
        if (!opts?.binding || !deps.acquireBackgroundRuntime) {
          throw new Error('BACKGROUND_BINDING_UNAVAILABLE')
        }
        await runTurn(
          [{ text: prompt, provenance: opts.provenance ?? 'operator' }],
          (approval) => deps.acquireBackgroundRuntime!(opts.binding!, approval),
          true,
        )
        return
      }
      await runTurn([{ text: prompt, provenance: opts?.provenance ?? 'operator' }])
    },
    runGoalTurn: async (input: {
      binding: ResolvedWorkBinding
      objective: string
      feedback?: string
      approvalToken?: string
      signal: AbortSignal
    }): Promise<{
      state: TurnResult['state']
      haltReason?: string
      planHash?: string
      usage?: { inputTokens: number; outputTokens: number; dollars: number }
      claimedDone: boolean
      reply: string
    }> => {
      if (deps.acquireTurnRuntime && !deps.acquireBackgroundRuntime) {
        return {
          state: 'halted',
          haltReason: 'unbound-context',
          claimedDone: false,
          reply: '',
        }
      }
      if (!deps.acquireTurnRuntime && !goal) {
        return {
          state: 'halted',
          haltReason: 'unbound-context',
          claimedDone: false,
          reply: '',
        }
      }
      // Don't race an in-flight operator turn — same idle-guard as runProactiveTurn.
      for (let i = 0; i < 60 && agentStateHolder.value === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 500))
      }
      if (agentStateHolder.value === 'running') return { state: 'halted', haltReason: 'busy', claimedDone: false, reply: '' }
      agentStateHolder.value = 'running'
      try {
        const text = input.feedback
          ? `${input.objective}\n\n[Контекст прошлой итерации]: ${input.feedback}`
          : input.objective
        const turn = deps.acquireTurnRuntime
          ? await runTelegramBoundGoalTurn({
              binding: input.binding,
              acquire: deps.acquireBackgroundRuntime!,
              approvalForSession,
              objective: input.objective,
              ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
              ...(input.approvalToken === undefined
                ? {}
                : { approvalToken: input.approvalToken }),
              signal: input.signal,
            })
          : {
              result: await goal!.runner.handle({
                sessionId,
                spans: [{ role: 'user', provenance: 'operator' as const, text }],
                signal: input.signal,
                ...(input.approvalToken !== undefined
                  ? { approvalToken: input.approvalToken }
                  : {}),
              }),
              claimedDone: goal!.takeClaimedDone(),
              sessionId,
            }
        const result = turn.result
        if (result.usage) deps.spend?.record({ model: deps.model, usage: result.usage })
        deps.setUntrustedContext?.(result.narrowed === true)
        return {
          state: result.state,
          ...(result.haltReason !== undefined ? { haltReason: result.haltReason } : {}),
          ...(result.planHash !== undefined ? { planHash: result.planHash } : {}),
          ...(result.usage !== undefined ? { usage: result.usage } : {}),
          claimedDone: turn.claimedDone,
          reply: result.reply,
        }
      } catch (error) {
        if (error instanceof WorkBindingError || error instanceof ContextLeaseError) {
          return {
            state: 'halted',
            haltReason: 'bound-context-unavailable',
            claimedDone: false,
            reply: '',
          }
        }
        throw error
      } finally {
        agentStateHolder.value = 'idle'
      }
    },
    sendProactive: async (text: string): Promise<void> => {
      await sendReply(text)
      nightlyShortcut = 'none'
    },
    sendNightlyNotice: async (notice: TelegramNightlyNotice): Promise<void> => {
      const selectedGender = deps.grammaticalGender?.() ?? 'neutral'
      const sessionReset = selectedGender === 'masculine'
        ? '🌅 Начал новую сессию. '
        : selectedGender === 'feminine'
          ? '🌅 Начала новую сессию. '
          : '🌅 Новая сессия начата. '
      const reset = notice.sessionReset ? sessionReset : ''
      if (notice.kind === 'session-only') {
        await sendReply(
          `${sessionReset}Память и незавершённая работа сохранены. ` +
          '/resume — вернуться к прошлому разговору.',
        )
        nightlyShortcut = 'none'
        return
      }
      if (notice.kind === 'complete-zero') {
        await sendReply(`${reset}Память проверена: новых правок нет.` +
          (notice.sessionReset ? ' /resume — вернуться к прошлому разговору.' : ''))
        nightlyShortcut = 'zero-staging'
        return
      }
      if (notice.kind === 'complete-n') {
        if (!Number.isSafeInteger(notice.pending) || notice.pending < 1) {
          throw new Error('INVALID_NIGHTLY_NOTICE')
        }
        await sendReply(`${reset}${notice.pending} правок памяти ждут решения. ` +
          'Покажи — открою карточку.' +
          (notice.sessionReset ? ' /resume — вернуться к прошлому разговору.' : ''))
        nightlyShortcut = 'open-staging'
        return
      }
      if (!Number.isSafeInteger(notice.pending) || notice.pending < 0 ||
        !Number.isSafeInteger(notice.failedProjects) || notice.failedProjects < 1) {
        throw new Error('INVALID_NIGHTLY_NOTICE')
      }
      await sendReply(`${reset}Память проверена частично: ${notice.pending} правок доступны, ` +
        `${notice.failedProjects} проектов требуют повторной проверки.` +
        (notice.pending > 0 ? ' Покажи — открою доступные правки.' : '') +
        (notice.sessionReset ? ' /resume — вернуться к прошлому разговору.' : ''))
      nightlyShortcut = notice.pending > 0 ? 'open-staging' : 'partial-empty'
    },
    /**
     * The goal's progress, as one post edited in place — the same shape the
     * 🎯 Цели screen shows, so there is one description of a goal and not two.
     * A goal that ends releases the card: it stays in the chat as the report,
     * and the next goal starts its own.
     */
    goalProgress: async (view: GoalScreenView): Promise<void> => {
      const rendered = renderGoalsScreen({ goal: view })
      const markup = toInlineKeyboard(rendered.buttons)
      if (goalCard === null) {
        const sent = await bot.api.sendMessage(deps.allowedChatId, rendered.text, {
          parse_mode: 'HTML',
          reply_markup: markup,
        })
        goalCard = { messageId: sent.message_id, html: rendered.text }
      } else if (goalCard.html !== rendered.text) {
        // Telegram refuses an edit that changes nothing; skipping it is cheaper
        // than handling the error, and the card is already correct.
        await bot.api.editMessageText(
          deps.allowedChatId, goalCard.messageId, rendered.text,
          { parse_mode: 'HTML', reply_markup: markup },
        ).catch(() => {})
        goalCard = { messageId: goalCard.messageId, html: rendered.text }
      }
      if (view.status !== 'active') goalCard = null
    },
    /**
     * The research heartbeat: one post whose page counter moves. Minutes of
     * silence read as a hung agent, and the report only lands at the very end.
     * Best-effort by contract — a card that cannot be drawn must never stop
     * the research it describes.
     */
    researchProgress: async (view: ResearchCardView): Promise<void> => {
      const rendered = renderResearchCard(view)
      try {
        if (researchCard === null) {
          const sent = await bot.api.sendMessage(deps.allowedChatId, rendered.text, {
            parse_mode: 'HTML',
          })
          researchCard = { messageId: sent.message_id, html: rendered.text }
        } else if (researchCard.html !== rendered.text) {
          await bot.api.editMessageText(
            deps.allowedChatId, researchCard.messageId, rendered.text,
            { parse_mode: 'HTML' },
          ).catch(() => {})
          researchCard = { messageId: researchCard.messageId, html: rendered.text }
        }
      } catch { /* the search matters, the heartbeat does not */ }
      if (view.status !== 'active') researchCard = null
    },
    /**
     * A goal the agent wants to take on. Unlike a trigger it is not registered
     * first: a goal starts working the moment it exists, so nothing is created
     * until the operator taps. The card is bound to its own message id.
     */
    proposeGoal: async (input: { objective: string; mode: string }): Promise<void> => {
      const mode = input.mode.startsWith('every:')
        ? `Повторяю по расписанию: ${input.mode.slice('every:'.length)}`
        : input.mode.startsWith('budget:')
          ? `Работаю, пока не потрачу ${input.mode.slice('budget:'.length)}`
          : 'Работаю до результата и проверяю его сам'
      const sent = await bot.api.sendMessage(
        deps.allowedChatId,
        `🎯 <b>Цель</b>\n\n${escapeHtml(input.objective)}\n\n${escapeHtml(mode)}`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('🚀 Запустить', 'goal:start')
            .text('🗑 Не надо', 'goal:drop'),
        },
      )
      pendingGoal = { ...input, messageId: sent.message_id }
    },
    /**
     * A trigger the agent set for itself. It is registered but dormant until
     * the operator says yes (ADR-0029) — so the card is the only thing that
     * turns it on, and refusing it removes the trigger rather than parking it.
     */
    proposeTrigger: async (input: {
      id: string
      kind: string
      prompt: string
      detail: string
    }): Promise<void> => {
      const title = input.kind === 'schedule' ? '🗓 Расписание'
        : input.kind === 'watch' ? '👁 Наблюдение' : '⏰ Напоминание'
      await bot.api.sendMessage(
        deps.allowedChatId,
        `${title}\n\n${escapeHtml(input.prompt)}\n\n${escapeHtml(input.detail)}`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('✅ Включить', `trig:ok:${input.id}`)
            .text('🗑 Не надо', `trig:no:${input.id}`),
        },
      )
    },
    /** Send the menu with the next outgoing message instead of a bare "here is the menu". */
    armMainMenu: (): void => { pendingMenuKeyboard = true },
    /** The one-time walk through the eight sections, at the end of the acquaintance. */
    sendMenuTour: (): Promise<void> => sendReply(renderMenuTour()),
    /**
     * The clock the schedule runs on. The agent can learn "я в Москве" as a
     * fact, but only this screen actually sets the zone, so it is offered once
     * — and only while it is still unset.
     */
    offerTimezone: async (): Promise<void> => {
      if ((deps.settings?.get().timeZone ?? '') !== '') return
      await sendSettingsView(await settingsScreen('timezone'))
    },
    /**
     * The services card of the first conversation: the same catalogue the
     * settings tree shows, offered once while the operator is still deciding
     * what this agent is for. Buttons lead into the existing key flow.
     */
    offerServiceKeys: async (): Promise<void> => {
      if (!deps.serviceKeys) return
      const connected = new Set(deps.serviceKeys.connected())
      await sendSettingsView(
        renderEnvScreen({
          intro: '🔑 <b>Что подключим</b>\n\nБез ключей я умею разговаривать и работать ' +
            'с файлами. С ними — слышать голосовые, искать и открывать страницы, ' +
            'ходить в сервисы, которыми ты пользуешься.',
          services: SERVICE_KEY_CATALOG.map((entry) => ({
            id: entry.id,
            label: entry.label,
            purpose: entry.purpose,
            connected: connected.has(entry.id),
          })),
        }),
      )
    },
  }
}
