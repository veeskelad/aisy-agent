// Public entry point for `@aisy/core`.
//
// Two surfaces are exported:
//  1. The Gateway connectivity types (consumed by transport adapters).
//  2. The runtime composition surface (consumed by the app package to assemble
//     and run a live agent): the runner, the real provider/tool/hook adapters,
//     the gateway + grant factories, and the agent-loop vocabulary.
// Internal component types stay internal; widen this deliberately.

// --- Gateway connectivity ---
export type {
  Gateway,
  GatewayDeps,
  TelegramUpdate,
  InboundSpan,
  PendingAction,
  CardId,
  CardTap,
  ApprovalProof,
  ApprovalResult,
  ApprovalScope,
  IssuedCardView,
  Provenance,
  Channel,
} from './gateway/index.js'

export {
  makeGateway,
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

// --- Runtime composition (app package assembles a live agent from these) ---
export { makeAgentRunner } from './runtime/agent-runner.js'
export type { AgentRunner, AgentRunnerDeps } from './runtime/agent-runner.js'
export * from './runtime/session-activity-journal.js'

export {
  makeAisyCapabilityBrainProviderAdapter,
  makeReadOnlyBrainProviderAdapter,
} from './runtime/brain-provider-adapter.js'

export { parseDotEnv, loadDotEnv, loadDotEnvState } from './runtime/dotenv.js'
export type { DotEnvLoadState } from './runtime/dotenv.js'

export { makeAnthropicProvider } from './runtime/provider-anthropic.js'
export type { AnthropicProviderDeps, AnthropicTool } from './runtime/provider-anthropic.js'

export { makeOpenAICompatProvider, parseOpenAIResponse } from './runtime/provider-openai.js'
export type { OpenAIProviderDeps, ModelPrice } from './runtime/provider-openai.js'

export { makeCliProvider, promptFromSpans } from './runtime/provider-cli.js'
export type { CliProviderDeps, CliRunResult } from './runtime/provider-cli.js'

export { PROVIDER_CATALOG, findProvider, buildProvider, makeTieredProvider } from './runtime/providers.js'
export type { ProviderEntry, ProviderKind, BuildProviderConfig, TierAdapters } from './runtime/providers.js'

export { makeFailoverProvider } from './runtime/failover-provider.js'

export { makeToolExecutor } from './runtime/execute-tool.js'
export type { ExecuteToolDeps, FsPort, ToolResult } from './runtime/execute-tool.js'
export {
  makeMemoryRememberReceipt,
  parseMemoryRememberReceipt,
  parseRememberFactArgs,
  renderMemoryAcknowledgement,
} from './runtime/memory-receipt.js'
export type {
  MemoryRememberReceiptV1,
  RememberFactInput,
  VerifiedToolMutationReceipt,
} from './runtime/memory-receipt.js'
export {
  RUNTIME_TOOL_CATALOG,
  RUNTIME_TOOL_NAMES,
  runtimeProviderTools,
  runtimeToolDefinition,
  runtimeToolMinimumTiers,
  validateRuntimeToolCall,
  isRuntimeToolName,
  isChildExecutableRuntimeTool,
} from './runtime/tool-catalog.js'
export type {
  RuntimeToolDefinition,
  ToolCallValidation,
  ToolEffect,
  ToolTier,
  RuntimeToolName,
} from './runtime/tool-catalog.js'

export { htmlToText, parseDuckDuckGo, isPublicHttpUrl } from './runtime/web-tools.js'

export {
  RESTRICTED_CLONE_MIN_DOCKER_VERSION,
  isRestrictedCloneDockerVersionCompatible,
  isRestrictedCloneImageDigest,
  isPublicRestrictedCloneAddress,
  resolveRestrictedCloneTarget,
  RestrictedCloneTargetError,
} from './runtime/restricted-public-clone.js'
export type {
  RestrictedCloneDnsAnswer,
  RestrictedCloneDnsPort,
  RestrictedCloneTarget,
  RestrictedCloneTargetErrorCode,
} from './runtime/restricted-public-clone.js'

export { makeHookGate, makePostToolUseProcessor } from './runtime/hook-gate.js'
export type { HookGateDeps, ApprovalDecision, PostToolUseDeps } from './runtime/hook-gate.js'

export { makeGuardian } from './runtime/guardian.js'
export type { GuardianDeps } from './runtime/guardian.js'

export { makeDockerBash, dockerRunArgs } from './runtime/sandbox-bash.js'
export type { DockerBashDeps, DockerResult } from './runtime/sandbox-bash.js'
export { makeHostBash, hostBashEnvironment, refusedHostCommand } from './runtime/host-bash.js'
export type { HostBashDeps, HostBashResult } from './runtime/host-bash.js'

export { makeSpendStore } from './runtime/spend.js'
export type {
  SpendStore,
  SpendEntry,
  SpendUsage,
  ModelSpend,
  AgentSpend,
  SpendPersistencePort,
} from './runtime/spend.js'

export { makeSettingsStore, DEFAULT_SETTINGS } from './runtime/settings.js'
export type { SettingsStore, Settings, SettingsPersistencePort } from './runtime/settings.js'

export { makeBudgetTracker } from './runtime/budget.js'
export type { BudgetTracker } from './runtime/budget.js'

export {
  deriveDeterministicMemoryFactKey,
  makeMemoryStore,
  serializeFactIndex,
  GLOBAL_DNA_PREFIX_FILES,
} from './memory/index.js'
export type {
  CommitResult,
  DeterministicMemoryFactKey,
  Memory,
  MemoryOp,
  MemoryStore,
  MemoryStoreDeps,
  RankedHit,
  MemoryFact,
} from './memory/index.js'
export { makeMemoryPort, makeMemorySearch, makeMemoryRecall } from './runtime/memory-adapter.js'
export { AGENT_PROTOCOL } from './runtime/agent-protocol.js'

// --- Evidence-linked monitoring and digests (ADR-0062) ---
export {
  makeGitHubMonitoringCollector,
  makeMonitoringEngine,
  makeMonitoringStore,
  makeProviderMonitoringScorer,
  makeRssMonitoringCollector,
  makeTelegramMonitoringCollector,
  makeWebMonitoringCollector,
  makeYouTubeMonitoringCollector,
  MonitoringError,
  parseMonitoringFeed,
  parsePublicTelegramPage,
} from './monitoring/index.js'
export type {
  CollectedEvidence,
  CollectionBatch,
  DigestBuildConfig,
  DigestItem,
  EvidenceCategory,
  EvidenceScore,
  EvidenceScoreInput,
  MonitoringCollector,
  MonitoringDigest,
  MonitoringEngine,
  MonitoringEvent,
  MonitoringHttpPort,
  MonitoringHttpResponse,
  MonitoringEvidence,
  MonitoringFeedback,
  MonitoringPollBudget,
  MonitoringPollResult,
  MonitoringScorer,
  MonitoringSearchHit,
  MonitoringSource,
  MonitoringSourceKind,
  MonitoringSourceStatus,
  MonitoringStore,
  MonitoringTickBudget,
} from './monitoring/index.js'
export { makeJsonlSessionLog } from './runtime/session-log.js'

export { makeProjectRegistry, ProjectRegistryError } from './runtime/project-registry.js'
export type {
  ProjectId,
  ProjectRegistry,
  ProjectRegistryEvent,
  ProjectRegistryPersistencePort,
  ProjectRegistryState,
  ProjectRecord,
  ProjectSelection,
  ProjectSessionId,
  ProjectSessionRecord,
} from './runtime/project-registry.js'
export {
  advanceWorkspaceMigration,
  makeFreshProjectRegistryV2,
  makeWorkspaceMigrationCoordinator,
  migrateProjectRegistryV1,
  planWorkspaceRegistryV1Migration,
  ProjectRegistryV2Error,
  recoveryModeForWorkspaceMigration,
  resolveWorkspaceRegistryStartupMode,
  validateProjectRegistryStateV2,
  validateWorkspaceMigrationManifest,
  verifyProjectRegistryV1Migration,
} from './runtime/project-registry-v2.js'
export type {
  LegacyRegistryOwner,
  ProjectOrigin,
  ProjectRecordV2,
  ProjectRegistryMigrationEquivalence,
  ProjectRegistryStateV2,
  ProjectRegistryV2Policy,
  ProjectSelectionV2,
  WorkContextKind,
  WorkspaceMigrationArtifact,
  WorkspaceMigrationCoordinator,
  WorkspaceMigrationManifest,
  WorkspaceMigrationManifestPersistencePort,
  WorkspaceMigrationPhase,
  WorkspaceRegistryMigrationPlan,
  WorkspaceRegistryStartupMode,
} from './runtime/project-registry-v2.js'
export { makeProjectRegistryV2 } from './runtime/project-registry-v2-lifecycle.js'
export type {
  ProjectRegistryV2,
  ProjectRegistryV2Event,
  ProjectRegistryV2Owner,
  ProjectRegistryV2PersistencePort,
} from './runtime/project-registry-v2-lifecycle.js'
export { ContextLeaseError, makeContextLeaseCoordinator } from './runtime/context-lease.js'
export type {
  ContextLeaseCoordinator,
  ContextLeaseEvent,
  ContextLeaseStatus,
  LeaseOperation,
  TurnContextLease,
} from './runtime/context-lease.js'

export {
  LayeredContextError,
  makeLayeredContextAssembler,
} from './runtime/layered-context-assembler.js'
export type {
  LayeredContextAssembler,
  LayeredContextBatch,
  LayeredContextEvent,
  LayeredContextSource,
  LazyContextExcerpt,
  LazyContextKind,
  LazyContextScope,
  ProjectLazyContextBatch,
} from './runtime/layered-context-assembler.js'
export { evaluateWorkspaceV2Readiness } from './runtime/workspace-v2-readiness.js'
export {
  authorizeWorkspaceV2Activation,
  workspaceV2ActivationApprovalKey,
  workspaceV2ActivationEvidenceHash,
} from './runtime/workspace-v2-activation.js'
export type {
  WorkspaceV2ActivationApproval,
  WorkspaceV2ActivationInput,
  WorkspaceV2ActivationRefusal,
  WorkspaceV2ActivationVerdict,
  WorkspaceV2RollbackRehearsal,
} from './runtime/workspace-v2-activation.js'
export type {
  WorkspaceV2ReadinessEvidence,
  WorkspaceV2ReadinessIssue,
  WorkspaceV2ReadinessReport,
  WorkspaceV2ReadinessState,
} from './runtime/workspace-v2-readiness.js'
export {
  assertLeaseMatchesBinding,
  parseWorkBinding,
  resolvedWorkBinding,
  workBindingFromLease,
  WorkBindingError,
} from './runtime/work-binding.js'
export type {
  ResolvedWorkBinding,
  WorkBinding,
  WorkBindingScope,
} from './runtime/work-binding.js'
export { ConfinementError, makeConfinementPort } from './runtime/confinement.js'
export type {
  ConfinementErrorCode,
  ConfinementEvent,
  ConfinementOperation,
  ConfinementPort,
  ConfinementProcessPort,
  ConfinementScanLimits,
  ConfinementScanResult,
  ConfinementWorkerRequest,
} from './runtime/confinement.js'
export { makeLeaseBoundToolExecutor } from './runtime/lease-bound-tool-executor.js'
export type { LeaseBoundToolExecutorDeps } from './runtime/lease-bound-tool-executor.js'
export {
  FACT_DUPLICATE_MIN_CHARS,
  FACT_DUPLICATE_PREFIX_CHARS,
  MEMORY_PROJECTION_LIMIT_BYTES,
  MEMORY_PROJECTION_TARGET_LINES,
  MEMORY_PROJECTION_WARN_BYTES,
  SESSION_CONSOLIDATION_MESSAGES,
  factDuplicatePrefix,
  findDuplicateFact,
  memorySelfCheck,
  projectionHealth,
  truncateProjection,
} from './runtime/memory-health.js'
export type {
  MemoryNotice,
  MemoryNoticeCode,
  MemoryProjectionHealth,
  TruncatedProjection,
} from './runtime/memory-health.js'
export { makeScopedMemoryRouter, ScopedMemoryError } from './runtime/scoped-memory.js'
export type {
  ScopedMemoryEvent,
  ScopedMemoryHit,
  ScopedMemoryRouter,
  ScopedMemorySearchResult,
} from './runtime/scoped-memory.js'
export {
  makeProtectedScopedMemoryRouter,
  ProtectedScopedMemoryError,
} from './runtime/protected-scoped-memory.js'
export type {
  ProtectedScopedMemoryRuntime,
} from './runtime/protected-scoped-memory.js'
export {
  makeMemoryPermanenceAuthority,
  MemoryPermanenceAuthorityError,
} from './runtime/protected-memory-permanence-authority.js'
export type {
  MemoryPermanenceAuditEvent,
  MemoryPermanenceAuthorizationRequest,
  MemoryPermanenceAuthority,
  MemoryPermanenceNonceRecord,
  MemoryPermanenceNonceStore,
  MemoryPermanenceReceipt,
} from './runtime/protected-memory-permanence-authority.js'
export {
  CrossProjectSearchError,
  crossProjectQueryHash,
  makeCrossProjectSearchAuthority,
  makeWorkspaceProjectSearch,
  normalizeCrossProjectQuery,
} from './runtime/cross-project-search.js'
export type {
  CrossProjectNonceRecord,
  CrossProjectNonceStore,
  CrossProjectSearchAuthority,
  CrossProjectSearchBinding,
  CrossProjectSearchIndex,
  CrossProjectSearchReceipt,
  ExcerptReadBinding,
  ExcerptReadCapability,
  ProjectSearchHit,
  WorkspaceProjectSearch,
} from './runtime/cross-project-search.js'
export {
  makeProtectedMemoryPublicationService,
  parseProtectedMemoryAuditEvent,
  parseProtectedMemoryFactRecord,
  parseProtectedMemoryPublicationWal,
  ProtectedMemoryPublicationError,
} from './runtime/protected-memory-publication.js'
export type {
  PreparedMemoryFactMetadata,
  ProtectedMemoryAuditEvent,
  ProtectedMemoryFactRecordV2,
  ProtectedMemoryPublicationFilePort,
  ProtectedMemoryPublicationPersistencePort,
  ProtectedMemoryPublicationPhase,
  ProtectedMemoryPublicationService,
  ProtectedMemoryPublicationWalV1,
  ProtectedMemoryScope,
} from './runtime/protected-memory-publication.js'
export {
  makeProtectedMemoryFileStore,
  ProtectedMemoryFileStoreError,
} from './runtime/protected-memory-file-store.js'
export {
  makeProtectedMemoryDeletionService,
  parseProtectedMemoryDeletionAuditEvent,
  parseProtectedMemoryDeletionWal,
  ProtectedMemoryDeletionError,
} from './runtime/protected-memory-deletion.js'
export {
  makeProtectedMemoryUpdateService,
  parseProtectedMemoryUpdateAuditEvent,
  parseProtectedMemoryUpdateWal,
  ProtectedMemoryUpdateError,
} from './runtime/protected-memory-update.js'
export type {
  ProtectedMemoryUpdateAuditEvent,
  ProtectedMemoryUpdatePersistencePort,
  ProtectedMemoryUpdatePhase,
  ProtectedMemoryUpdateResult,
  ProtectedMemoryUpdateService,
  ProtectedMemoryUpdateTarget,
  ProtectedMemoryUpdateWalV1,
} from './runtime/protected-memory-update.js'
export {
  makeProtectedMemoryRecoveryGate,
  ProtectedMemoryRecoveryGateError,
} from './runtime/protected-memory-recovery-gate.js'
export type {
  ProtectedMemoryRecoveryGate,
  ProtectedMemoryRecoveryReport,
  ProtectedMemoryRecoveryStatePort,
} from './runtime/protected-memory-recovery-gate.js'
export { makeProtectedMemorySemanticDeletionPort } from './runtime/protected-memory-semantic-deletion.js'
export type {
  ProtectedMemoryDeletionAuditEvent,
  ProtectedMemoryDeletionDerivedPort,
  ProtectedMemoryDeletionFilePort,
  ProtectedMemoryDeletionPersistencePort,
  ProtectedMemoryDeletionPhase,
  ProtectedMemoryDeletionResult,
  ProtectedMemoryDeletionService,
  ProtectedMemoryDeletionTarget,
  ProtectedMemoryDeletionWalV1,
} from './runtime/protected-memory-deletion.js'
export type {
  ProtectedMemoryFileFault,
  ProtectedMemoryFileStore,
} from './runtime/protected-memory-file-store.js'
export {
  makeProtectedMemorySqliteStore,
  ProtectedMemorySqliteStoreError,
} from './runtime/protected-memory-sqlite-store.js'
export type {
  ProtectedMemoryForgetCandidate,
  ProtectedMemoryForgetVerdict,
  ProtectedMemorySqliteFault,
  ProtectedMemorySqliteStore,
} from './runtime/protected-memory-sqlite-store.js'
export {
  makeProtectedMemoryScopeBarrier,
  ProtectedMemoryScopeBarrierError,
} from './runtime/protected-memory-scope-barrier.js'
export type {
  ProtectedMemoryScopeBarrier,
} from './runtime/protected-memory-scope-barrier.js'
export {
  PROTECTED_KEYWORD_SCHEMA,
  PROTECTED_LEDGER_SCHEMA,
  PROTECTED_LEDGER_SCHEMA_VERSION,
} from './runtime/protected-memory-schema.js'
export {
  LegacyMemoryMigrationError,
  planLegacyMemoryV1Migration,
  prepareLegacyMemoryV1Migration,
  resumeLegacyMemoryV1MigrationPreparation,
  validateLegacyMemoryMigrationManifest,
  verifyLegacyMemoryMigrationBundle,
  verifyLegacyMemoryMigrationCandidate,
} from './runtime/legacy-memory-migration.js'
export type {
  LegacyMemoryMigrationArtifact,
  LegacyMemoryMigrationCohort,
  LegacyMemoryMigrationManifest,
  LegacyMemoryMigrationPhase,
  LegacyMemoryMigrationPlan,
} from './runtime/legacy-memory-migration.js'
export {
  AgentCardRegistryError,
  agentCardLifecycleAction,
  canonicalAgentCardHash,
  makeAgentCardRegistry,
  validateAgentCardRegistryState,
} from './runtime/agent-card-registry.js'
export type {
  AgentCardBinding,
  AgentCardCatalogEntry,
  AgentCardEnvelopeApproval,
  AgentCardLifecycleEnvelope,
  AgentCardLifecycleHead,
  AgentCardLifecycleOperation,
  AgentCardLifecyclePlanInput,
  AgentCardTarget,
  AgentCardRegistryPersistencePort,
  AgentCardRegistryStateV1,
  AgentCardRegistryStateV2,
  AgentCardProvenance,
  AgentCardRegistry,
  AgentCardRegistryRefusal,
  AgentCardRevision,
  AgentCardScope,
  AgentCardStatus,
} from './runtime/agent-card-registry.js'
export {
  memoryMigrationManifestPath,
  verifyMigrationCohort,
} from './runtime/migration-cohort.js'
export type {
  MigrationCohortRefusal,
  MigrationCohortVerdict,
} from './runtime/migration-cohort.js'
export {
  HYBRID_LEG_CAP,
  HYBRID_RRF_K,
  HybridRetrievalIntegrityError,
  SensitiveEmbeddingInputError,
  embeddingCacheKey,
  makeHybridRetrieval,
  makeSensitiveEmbeddingProvider,
  reciprocalRankFusion,
  scanEmbeddingInput,
} from './runtime/hybrid-retrieval.js'
export type {
  EmbeddingDescriptor,
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingSensitivityReason,
  EmbeddingSensitivityVerdict,
  HybridRetrievalEvent,
  HybridRetrievalHit,
  HybridRetrievalMode,
  HybridRetrievalResult,
  HybridRetrievalStatus,
  KeywordRetrievalLeg,
  RetrievalScope,
  ScopedRetrievalCandidate,
  SemanticRetrievalLeg,
} from './runtime/hybrid-retrieval.js'
export {
  makeSqliteVecSemanticStore,
  SemanticVectorStoreError,
} from './runtime/sqlite-vec-semantic-store.js'
export type {
  SemanticIndexRecord,
  SemanticVectorIntegrityResult,
  SemanticVectorStore,
  SemanticVectorStoreState,
} from './runtime/sqlite-vec-semantic-store.js'
export {
  makeOpenRouterEmbeddingProvider,
  OpenRouterEmbeddingError,
} from './runtime/provider-openrouter-embeddings.js'
export {
  makeSemanticRetrievalRuntime,
  normalizedEmbeddingContentHash,
} from './runtime/semantic-retrieval-runtime.js'
export type {
  SemanticIndexResult,
  SemanticRetrievalRuntime,
  SemanticRetrievalRuntimeEvent,
} from './runtime/semantic-retrieval-runtime.js'
export {
  makeProtectedMemorySemanticReconciler,
  ProtectedMemorySemanticReconcilerError,
  semanticDescriptorId,
} from './runtime/protected-memory-semantic-reconciler.js'
export type {
  ProtectedMemorySemanticDerivationPort,
  ProtectedMemorySemanticReconcileSummary,
  ProtectedMemorySemanticReconciler,
  ProtectedMemorySemanticReconcilerEvent,
  ProtectedMemorySemanticReconcilerState,
  ProtectedMemorySemanticSourcePort,
} from './runtime/protected-memory-semantic-reconciler.js'
export {
  makeSemanticEgressConsentAuthority,
  semanticEgressBindingHash,
  semanticEgressConsentActionHash,
  semanticEgressOutboxEventId,
  semanticEgressRecoveryEventId,
  semanticEgressRequestEventId,
  SEMANTIC_EGRESS_DISCLOSURE_HASH,
  SEMANTIC_EGRESS_DISCLOSURE_REVISION,
  SEMANTIC_EGRESS_DISCLOSURE_V1,
  SEMANTIC_EGRESS_EXCLUDED_CATEGORIES,
  SEMANTIC_EGRESS_SCOPE_V1,
  SemanticEgressConsentError,
} from './runtime/semantic-egress-consent.js'
export type {
  SemanticEgressActiveConsentRecordV1,
  SemanticEgressAwaitingConsentRecordV1,
  SemanticEgressBlockedConsentRecordV1,
  SemanticEgressBootRecoveryV1,
  SemanticEgressConsentAuthority,
  SemanticEgressConsentBinding,
  SemanticEgressConsentChallengeV1,
  SemanticEgressConsentNonceRecord,
  SemanticEgressConsentPurpose,
  SemanticEgressConsentRecordV1,
  SemanticEgressConsentScope,
  SemanticEgressConsentSlot,
  SemanticEgressConsentState,
  SemanticEgressDurableStore,
  SemanticEgressDurableTransitionResult,
  SemanticEgressDurableTransitionV1,
  SemanticEgressDurableUseStartV1,
  SemanticEgressDisclosureVersion,
  SemanticEgressNonceMutationV1,
  SemanticEgressOutboxEventV1,
  SemanticEgressPendingConsentV1,
  SemanticEgressRevokedConsentRecordV1,
  SemanticEgressRevokingConsentRecordV1,
  SemanticEgressUseProofV1,
  SemanticEgressUseLease,
} from './runtime/semantic-egress-consent.js'
export {
  makeSemanticEgressOutboxWorker,
  SemanticEgressOutboxWorkerError,
} from './runtime/semantic-egress-outbox-worker.js'
export type {
  SemanticEgressOutboxAckHeadResult,
  SemanticEgressOutboxDeliveryResult,
  SemanticEgressOutboxDurablePort,
  SemanticEgressOutboxRunSummary,
  SemanticEgressOutboxSink,
  SemanticEgressOutboxWorker,
} from './runtime/semantic-egress-outbox-worker.js'
export {
  makeOpaqueCredentialProxy,
  OpaqueCredentialProxyError,
} from './runtime/opaque-credential-proxy.js'
export type {
  OpaqueCredentialByteTransportPort,
  OpaqueCredentialByteTransportResult,
  OpaqueCredentialBindingAuthorityAttestationV1,
  OpaqueCredentialBindingAuthorityPort,
  OpaqueCredentialClientPolicyV1,
  OpaqueCredentialDescriptorV1,
  OpaqueCredentialLocatorV1,
  OpaqueCredentialProxy,
  OpaqueCredentialProxyClient,
  OpaqueCredentialProxyDeps,
  OpaqueCredentialProxyErrorCode,
  OpaqueCredentialProxyEventV1,
  OpaqueCredentialProxyQuotas,
  OpaqueCredentialProxyRequestV1,
  OpaqueCredentialProxyResponseV1,
  OpaqueCredentialResponseMode,
  OpaqueCredentialUseAuthorizationV1,
  OpaqueProxyTransportAttestationV1,
  OpaqueSecretBackendAttestationV1,
  OpaqueSecretBackendPort,
  OpaqueSecretHandle,
  OpaqueSecretProvider,
} from './runtime/opaque-credential-proxy.js'
export { makeSwitchAuthority, SwitchAuthorityError } from './runtime/switch-authority.js'
export type {
  SwitchAuthority,
  SwitchAuthorityBinding,
  SwitchAuthorityNonceRecord,
  SwitchAuthorityNonceStore,
  SwitchAuthorityReceipt,
} from './runtime/switch-authority.js'
export {
  makeProjectLifecycleAuthority,
  ProjectLifecycleAuthorityError,
} from './runtime/project-lifecycle-authority.js'
export type {
  ProjectLifecycleAuthorityIssuer,
  ProjectLifecycleAuthorityNonceRecord,
  ProjectLifecycleAuthorityNonceStore,
} from './runtime/project-lifecycle-authority.js'
export { makeProjectService, ProjectServiceError } from './runtime/project-service.js'
export type {
  ProjectLifecycleAction,
  ProjectLifecycleAuthority,
  ProjectLifecycleAuthorityBinding,
  ProjectLifecycleAuthorityReceipt,
  ProjectService,
  ProjectServiceArchiveResult,
  ProjectServiceContextResult,
  ProjectServiceEvent,
  ProjectServiceLifecycleDeps,
  ProjectServiceSwitchResult,
} from './runtime/project-service.js'

// --- Brain connections + deterministic Telegram-first bootstrap (ADR-0057/0058) ---
export {
  BRAIN_BOOTSTRAP_PHASES,
  CorruptBrainBootstrapState,
  InvalidBrainBootstrapTransition,
  makeBrainBootstrap,
  validateBrainBootstrapState,
} from './onboarding/brain-bootstrap.js'
export type {
  BrainBootstrap,
  BrainBootstrapDeps,
  BrainBootstrapEvent,
  BrainBootstrapEvents,
  BrainBootstrapPhase,
  BrainBootstrapState,
  BrainBootstrapStore,
  SelectedBrain,
} from './onboarding/brain-bootstrap.js'
export {
  BrainBootstrapCoordinatorError,
  makeBrainBootstrapCoordinator,
} from './onboarding/brain-bootstrap-coordinator.js'
export type {
  BrainBootstrapCoordinator,
  BrainBootstrapCoordinatorResult,
  BrainBootstrapSelection,
  BrainConnectionSetupDriver,
} from './onboarding/brain-bootstrap-coordinator.js'
export type {
  AuthChallenge,
  BrainAuthMode,
  BrainCapabilities,
  BrainConnection,
  BrainConnectionStatus,
  BrainDetectionResult,
  BrainDriver,
  BrainEvent,
  BrainInstallResult,
  BrainRoute,
  BrainRuntime,
  BrainTurn,
  BrainValidationResult,
} from './onboarding/brain-connections.js'
export { ApiKeySetupDriverError, makeApiKeySetupDriver } from './runtime/api-key-setup-driver.js'
export type {
  ApiCredentialBinding,
  ApiCredentialBroker,
  ApiCredentialEntryChallenge,
} from './runtime/api-key-setup-driver.js'
export { makeApiCredentialIngress } from './runtime/api-credential-ingress.js'
export type {
  ApiCredentialCommittingRecord,
  ApiCredentialIngress,
  ApiCredentialIngressRecord,
  ApiCredentialIngressStatus,
  ApiCredentialIngressStore,
  ApiCredentialIssuedRecord,
  ApiCredentialProviderValidator,
  ApiCredentialTerminalRecord,
  ApiCredentialVaultTransactions,
} from './runtime/api-credential-ingress.js'
export {
  ANTHROPIC_CREDENTIAL_VALIDATION_URL,
  makeAnthropicApiCredentialProviderValidator,
  makeOpenAIApiCredentialProviderValidator,
  makeOpenRouterApiCredentialProviderValidator,
  OPENAI_CREDENTIAL_VALIDATION_URL,
  OPENROUTER_CREDENTIAL_VALIDATION_URL,
} from './runtime/openai-api-credential-validator.js'
export type {
  ApiCredentialAuthProtocol,
  ApiCredentialLocator,
  ApiCredentialValidationProxyPort,
  ApiCredentialValidationProxyRequest,
  NativeApiCredentialProvider,
} from './runtime/openai-api-credential-validator.js'
export {
  makeSqliteApiCredentialIngressStore,
  SqliteApiCredentialIngressStoreError,
} from './runtime/sqlite-api-credential-ingress-store.js'

export {
  CodexAuthDriverError,
  makeCodexSubscriptionAuth,
  makeNodeCodexAuthProcessPort,
  parseCodexDeviceChallenge,
} from './runtime/codex-auth.js'
export type {
  CodexAuthProcessPort,
  CodexCommandResult,
  CodexStreamingCommand,
  CodexSubscriptionAuth,
} from './runtime/codex-auth.js'
export { makeCodexSubscriptionSetupDriver } from './runtime/codex-setup-driver.js'
export {
  CODEX_APP_SERVER_CAPABILITY_PROTOCOL_PROFILE,
  CODEX_APP_SERVER_PROTOCOL_PROFILE,
  makeCodexAppServerCapabilityDriver,
  makeCodexAppServerReadOnlyDriver,
} from './runtime/codex-app-server-driver.js'
export {
  CodexAppServerTransportError,
  makeNodeCodexAppServerSessionFactory,
} from './runtime/codex-app-server-node.js'
export type { CodexAppServerSpawnPort } from './runtime/codex-app-server-node.js'
export {
  CodexThreadStoreError,
  makeSqliteCodexThreadStore,
} from './runtime/sqlite-codex-thread-store.js'
export type { SqliteCodexThreadStore } from './runtime/sqlite-codex-thread-store.js'
export {
  bindCodexCapabilityBridge,
  CodexCapabilityBridgeError,
} from './runtime/codex-capability-bridge.js'
export type {
  BoundCodexCapabilityBridge,
  CodexCapabilityContext,
  CodexCapabilityBridgeEvent,
  CodexCapabilityCall,
} from './runtime/codex-capability-bridge.js'
export { makeCodexCapabilityExecutor } from './runtime/codex-capability-executor.js'
export type { CodexCapabilityExecutor } from './runtime/codex-capability-executor.js'
export type {
  CodexAppServerCapabilityBridge,
  CodexAppServerCapabilityBridgeFactory,
  CodexAppServerProtocolProfile,
  CodexAppServerSession,
  CodexAppServerSessionFactory,
  CodexAppServerThreadRecord,
  CodexAppServerThreadStore,
} from './runtime/codex-app-server-driver.js'

export {
  CLAUDE_SUBSCRIPTION_AUTH_INSTRUCTIONS,
  buildClaudeAuthSmokeCommand,
  makeClaudeSubscriptionAuthSpike,
  parseClaudeAuthSmoke,
} from './runtime/claude-auth.js'
export type {
  ClaudeAuthProcessPort,
  ClaudeCommandResult,
  ClaudeSubscriptionAuth,
  ClaudeSubscriptionAuthSpike,
} from './runtime/claude-auth.js'
export {
  makeClaudeSubscriptionSetupDriver,
  makeNodeClaudeAuthProcessPort,
} from './runtime/claude-setup-driver.js'
export { withNodeBinOnPath } from './runtime/node-tool-path.js'

// --- CLI (the app's unified `aisy` reuses these for init/doctor/diagnostics) ---
export { makeNodeOnboardingOps, harnessVersion, isNewerVersion } from './runtime/onboarding-node.js'
export type {
  MemoryPort as OnboardingMemoryPort,
  OwnedDockerRecoveryReadinessProbe,
  ProviderBrokerReadinessProbe,
  TranscriptionReadinessProbe,
} from './onboarding/types.js'
export { makeCredentialTerminalPrompt, makeNodeCredentialTerminalPrompt, CredentialTerminalError } from './runtime/credential-terminal.js'
export type { CredentialTerminalInput, CredentialTerminalOutput, CredentialTerminalPrompt } from './runtime/credential-terminal.js'
export { runCli } from './cli/index.js'
export { systemdUnit, launchdPlist } from './runtime/service-files.js'
export type { ServiceOpts } from './runtime/service-files.js'
export {
  computeTranscriptRowHash,
  makeSessionTranscript,
  SessionTranscriptError,
  TranscriptCommitUncertainError,
  transcriptUpdatedAt,
} from './runtime/session-transcript.js'
export type {
  FrozenPrefixRecord,
  LoadBearingDecision,
  SessionTranscript,
  SessionTranscriptManifestV1,
  SessionTranscriptPersistencePort,
  TranscriptAppendInput,
  TranscriptBinding,
  TranscriptCommit,
  TranscriptEnvelope,
  TranscriptQuarantineReason,
} from './runtime/session-transcript.js'
export {
  makeSessionTranscriptRecorder,
  SessionTranscriptRecorderError,
  transcriptTurnEventId,
} from './runtime/session-transcript-recorder.js'
export {
  makeSessionTranscriptHistoryProjector,
  SessionTranscriptHistoryError,
} from './runtime/session-transcript-history.js'
export type {
  SessionTranscriptHistoryProjector,
} from './runtime/session-transcript-history.js'
// The app supplies the `summarize` port the projector calls, so the entry shape
// it receives is part of that contract, not an internal of the context engine.
export type { TranscriptEntry } from './context-engine/types.js'
export {
  projectSessionTranscriptDayLog,
  TranscriptDayLogError,
} from './runtime/transcript-day-log.js'
export type { TranscriptDayLogErrorCode } from './runtime/transcript-day-log.js'
export {
  makeLeaseBoundTranscriptRecorder,
  TranscriptLeaseBindingError,
} from './runtime/lease-bound-transcript-recorder.js'
export {
  AttachmentImportError,
  makeAttachmentImportService,
  parseAttachmentImportWal,
  parseInboxAttachment,
  parseProjectFileManifest,
} from './runtime/attachment-import.js'
export type {
  AttachmentDestination,
  AttachmentImportAuditEvent,
  AttachmentImportFilePort,
  AttachmentImportPersistencePort,
  AttachmentImportPhase,
  AttachmentImportService,
  AttachmentImportWalV1,
  AttachmentSource,
  InboxAttachmentV1,
  ProjectFileManifestV1,
} from './runtime/attachment-import.js'

// --- Safety: grant store (transport records grants; app may inspect/reset) ---
export {
  autonomyWorkflowStep, GrantStoreError, makeGrantStore, makeInputGuard,
} from './safety/index.js'
export type {
  GrantStore,
  GrantScope,
  GrantBinding,
  GrantListEntry,
  PersistedApprovalGrantV2,
  PersistedSimilarApprovalGrantV3,
  GrantPersistenceStateV2,
  GrantPersistenceStateV3,
  GrantPersistencePort,
  InputGuard,
  InjectionVerdict,
  SandboxSecurityLevel,
} from './safety/index.js'

// --- Agent-loop vocabulary (the app builds these; transport-facing) ---
export { isGenuineToolExecutionContextFor } from './agent-loop/index.js'
export type {
  TurnInput,
  TurnProgressEvent,
  TurnProgressSink,
  TurnResult,
  ContextSpan,
  FrozenSnapshot,
  ToolCall,
  ToolExecutionContext,
  ProviderAdapter,
  ProviderError,
  ModelRequest,
  ModelToolRuntimeContext,
  ModelProgressEvent,
  ModelProgressSink,
  ModelResponse,
  MemoryPort,
  LoopGuardian,
  SessionLog,
  SessionSummary,
  TranscriptRecorder,
  TranscriptRecordRequest,
  TranscriptHistoryRequest,
  TranscriptSessionStartRequest,
  LogEntry,
  Clock,
  HookGate,
  HookCtx,
  VerificationTrace,
  ActionCompletionStatus,
  ActionContractKind,
  ActionMissingEvidence,
} from './agent-loop/types.js'

export {
  actionEvidence,
  actionRecoveryInstruction,
  actionToolFamily,
  attachProviderActionEvidence,
  classifyActionContract,
  evaluateActionContract,
  readProviderActionEvidence,
} from './agent-loop/action-contract.js'
export type {
  ActionContract,
  ActionContractVerdict,
  ActionEvidence,
  ActionToolFamily,
} from './agent-loop/action-contract.js'

// --- AgentCard loader (Tier-3, ADR-0039/0052) ---
export { makeCardResolver, parseAgentCard, validateAgentCardValue, DEFAULT_GENERAL_CARD, DEFAULT_RESEARCHER_CARD, BUILTIN_CARDS } from './runtime/agent-cards.js'
export type { CardResolver } from './runtime/agent-cards.js'
export { makeAutonomyLedger, workflowKey, NORMATIVE_THRESHOLDS } from './runtime/autonomy-evidence.js'
export {
  demoteLearnedAutonomy,
  forgetLearnedAutonomy,
  learnedGrantAction,
  makeLearnedAutonomyPort,
  makeLearnedGrantRegistry,
  LEARNED_GRANT_TTL_DAYS_MAX,
} from './runtime/autonomy-promotion.js'
export type {
  DemotionReason,
  LearnedGrant,
  LearnedGrantEnvelope,
  LearnedGrantPersistence,
  LearnedGrantRegistry,
  LearnedGrantStateV1,
  PromoteRefusal,
} from './runtime/autonomy-promotion.js'
export type {
  AutonomyCandidate,
  AutonomyLedger,
  AutonomyThresholds,
  DemonstrationInput,
  DemonstrationOutcome,
  EvidencePersistence,
  ObserveResult,
  WorkflowStep,
} from './runtime/autonomy-evidence.js'
export {
  AgentCapabilityError,
  DelegationAuthorityError,
  resolveAgentCapabilityMatrix,
  resolveChildAgentCapabilityMatrix,
  resolveDelegationExecutionAuthority,
  validateDelegationExecutionAuthority,
} from './runtime/agent-capabilities.js'
export type {
  AgentCapabilityErrorCode,
  AgentCapabilityMatrix,
  DelegationAuthorityErrorCode,
  DelegationAuthorityHandle,
  DelegationExecutionAuthorityV1,
  DelegationExecutionIdentityV1,
  DelegationExecutionLimitsV1,
} from './runtime/agent-capabilities.js'
export { makeSkillPromptRuntime } from './runtime/skill-prompt-runtime.js'
export type { SkillPromptRuntime } from './runtime/skill-prompt-runtime.js'
export { isKnownTimeZone, wallClockIso } from './runtime/wall-clock.js'
export { makeActiveSkillCatalog } from './runtime/active-skill-catalog.js'
export {
  autoSkillScopeKey,
  buildAutoSkillManifest,
  canonicalAutoSkillScope,
  makeVerifiedWorkflowEvidence,
  parseSkillRecipeDraft,
  renderAutoSkillDocument,
  sameAutoSkillModelIdentity,
  shadowVerifyAutoSkill,
  validateSkillRecipeDraft,
} from './runtime/auto-skill-learning.js'
export type {
  AutoSkillDescriptor,
  AutoSkillDescriptorRegistry,
  AutoSkillManifestV1,
  AutoSkillModelIdentity,
  AutoSkillPlaceholderDescriptor,
  AutoSkillScope,
  AutoSkillValidationCode,
  AutoSkillValidationResult,
  SkillRecipeDraftV1,
  SkillRecipeGeneratorPort,
  SkillRecipeJudgePort,
  SkillRecipeStepV1,
  VerifiedWorkflowEvidenceV1,
  VerifiedWorkflowStepV1,
} from './runtime/auto-skill-learning.js'
// Installing a skill must accept exactly what the catalog will later serve, so
// the installer parses with the very same function instead of a lookalike.
export { parseSkillDocument } from './skills/index.js'
export type { ParseError, ParsedSkill, SkillFrontmatter } from './skills/types.js'
export type {
  ActiveSkillCatalog,
  ActiveSkillManifestEntryV1,
  ActiveSkillManifestV1,
  ActiveSkillPersistencePort,
  ActiveSkillQuarantineReason,
  SkillTrustSource,
} from './runtime/active-skill-catalog.js'
export {
  canonicalDescriptorHash,
  makeMCPManager,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  McpWireError,
  openMcpWireSession,
  planMcpTransport,
} from './mcp/index.js'
export type {
  ConnectResult,
  DescriptorDiff,
  DiffCard,
  McpAllowlistConfig,
  McpEvent,
  McpManager,
  McpManagerDeps,
  McpMenuLine,
  McpProcessHandle,
  McpServerEntry,
  McpToolPolicy,
  McpTransport,
  RawDescriptor,
  ResolvedMcpCall,
  UntrustedResultSpan,
  McpProtocolEra,
  McpSdkClientPlan,
  McpSdkClientPort,
  McpWireCallResult,
  McpWireErrorCode,
  McpWireEvent,
  McpWirePolicy,
  McpWireSession,
  McpTransportPlan,
  McpTransportPlanResult,
  OpenMcpWireSessionOptions,
} from './mcp/index.js'
export { makeActiveMcpAllowlist } from './runtime/active-mcp-allowlist.js'
export type {
  ActiveMcpAllowlist,
  ActiveMcpAllowlistPersistencePort,
  ActiveMcpManifestEntryV1,
  ActiveMcpManifestV1,
  ActiveMcpQuarantineReason,
} from './runtime/active-mcp-allowlist.js'
export { connectActiveMcpCatalog } from './runtime/active-mcp-catalog.js'
export type {
  ActiveMcpCatalog,
  ActiveMcpCatalogDeps,
} from './runtime/active-mcp-catalog.js'
export {
  CALL_MCP_TOOL_DEFINITION,
  CALL_MCP_TOOL_NAME,
  makeMcpCapabilityRuntime,
  McpCapabilityRuntimeError,
} from './runtime/mcp-capability-runtime.js'
export type {
  McpCapabilityRuntime,
  McpCapabilityRuntimeErrorCode,
  McpCapabilityToolResult,
} from './runtime/mcp-capability-runtime.js'

// --- Delegation (Tier-3 sub-agent delegation, ADR-0039) ---
export {
  canonicalizeIterationCost,
  DelegationResumeError,
  iterationCostSpendNanos,
  makeDelegationManager,
  ScopeConflictError,
  ScopeViolationError,
} from './orchestration/index.js'
export {
  BoundedDelegationError,
  runBoundedDelegation,
  runDelegation,
} from './runtime/delegation-driver.js'
export type {
  BoundedDelegationDriverDeps,
  BoundedDelegationEvent,
  BoundedDelegationFailureCode,
  BoundedDelegationOutcome,
  DelegationDriverDeps,
} from './runtime/delegation-driver.js'
export type {
  DelegationManager,
  DelegationId,
  DelegationHandle,
  DelegationDeps,
  DelegationCheckpoint,
  DelegationPersistencePort,
  DelegationQuarantineReason,
  DelegationRecoveryPreflight,
  DelegationRecoveryResult,
  DelegationStatus,
  DelegationTask,
  DelegationScope,
  PlanDAG,
  LinearPlanLike,
  AgentCard,
  CapabilityRequest,
  TaskObservation,
  PersistedDelegationV1,
  PersistedDelegationRunV1,
  ScheduleResult,
  BudgetSlice,
  IterationCost,
  OrchestrationEvent,
  ShardEntry,
} from './orchestration/index.js'

// --- Sub-agent runner (Tier-3 sub-agent delegation, ADR-0052) ---
export {
  makeBoundSubAgentRunner,
  makeSubAgentRunner,
} from './runtime/sub-agent-runner.js'
export type {
  BoundSubAgentRunner,
  BoundSubAgentRunnerDeps,
  DelegationAuthorityJournal,
  SubAgentRunnerDeps,
  SubAgentRunnerHandle,
} from './runtime/sub-agent-runner.js'

// --- Plan normalizer (Tier-3 fix: ensures every node has non-null assignedTo) ---
export { normalizeSpawnPlan } from './runtime/spawn-plan.js'

// --- Tier-4 triggers ---
export { makeTriggerEngine } from './triggers/index.js'
export type {
  TriggerEngine,
  TriggerEngineDeps,
  TriggerSpec,
  TriggerStore,
  TriggerBudget,
  TriggerFiring,
} from './triggers/index.js'

// --- Tier-4 nightly consolidation (runner + adapters + LLM generator/judge) ---
export { makeConsolidationRunner } from './nightly/index.js'
export type {
  ConsolidationRunner,
  ConsolidationDeps,
  ConsolidationRunSnapshot,
  NightlyConfig,
  NightResult,
  MorningCard,
  MemOp,
  Fact,
  NormalizedDayLog,
  NormalizedDayLogRecord,
  Generator,
  RunLock,
  LockToken,
} from './nightly/index.js'
export { makeFileRunLock, makeMemoryValidators, liveFactsForNightly, memOpToMemoryOp } from './runtime/nightly-adapters.js'
export type { FileRunLockDeps, MemoryValidatorsDeps } from './runtime/nightly-adapters.js'
export { makeNightlyGenerator, makeNightlyJudge } from './runtime/nightly-generator.js'

// --- Tier-8 exact-response cache (deterministic paths only; NEVER the live loop — ADR-0055) ---
export { makeExactCache, makeMemoryExactCacheStore } from './runtime/exact-cache.js'
export type { ExactCacheStore } from './runtime/exact-cache.js'

// --- Tier-7 goal-driven loop ---
export { makeGoalSpec } from './goals/index.js'
export type {
  GoalSpec,
  GoalStore,
  GoalMode,
  GoalBackstop,
  GoalUsage,
  GoalStatus,
} from './goals/index.js'
