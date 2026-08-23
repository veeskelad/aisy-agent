#!/usr/bin/env node
// Unified `aisy` CLI.
//   aisy run                  → boot the live Telegram agent (this package)
//   aisy init|doctor|…        → onboarding (delegated to @aisy/core's runCli)
//
// Secrets are read from the vault (~/.aisy/vault.json), seeded by `aisy init`.
// Run adapters: SQLite-backed memory (FTS) + search_memory tool, and a durable
// jsonl session log (ADR-0048, Tier-1 wiring). Full crash-resume
// (SessionLog.resume) is still deferred.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { Api } from 'grammy'
import {
  makeAgentRunner,
  runtimeToolDefinition,
  runtimeToolMinimumTiers,
  makeGateway,
  autonomyWorkflowStep,
  demoteLearnedAutonomy,
  forgetLearnedAutonomy,
  makeAutonomyLedger,
  makeGrantStore,
  makeLearnedAutonomyPort,
  makeLearnedGrantRegistry,
  learnedGrantAction,
  workflowKey,
  type ProjectServiceEvent,
  type GrantStore,
  makeGuardian,
  makeNodeOnboardingOps,
  makeBrainBootstrap,
  makeBrainBootstrapCoordinator,
  makeClaudeSubscriptionAuthSpike,
  makeClaudeSubscriptionSetupDriver,
  makeNodeClaudeAuthProcessPort,
  makeCodexSubscriptionAuth,
  makeCodexSubscriptionSetupDriver,
  buildProvider,
  loadDotEnvState,
  makeTieredProvider,
  findProvider,
  makeSpendStore,
  makeSettingsStore,
  makeBudgetTracker,
  makeProviderMonitoringScorer,
  makeJsonlSessionLog,
  AGENT_PROTOCOL,
  GLOBAL_DNA_PREFIX_FILES,
  serializeFactIndex,
  makeContextLeaseCoordinator,
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  makeCardResolver,
  makeAgentCardRegistry,
  resolveAgentCapabilityMatrix,
  resolveChildAgentCapabilityMatrix,
  makeActiveSkillCatalog,
  CALL_MCP_TOOL_DEFINITION,
  CALL_MCP_TOOL_NAME,
  makeActiveMcpAllowlist,
  makeInputGuard,
  makeSkillPromptRuntime,
  makeCodexCapabilityExecutor,
  makeHostBash,
  makeDelegationManager,
  runDelegation,
  makeSubAgentRunner,
  normalizeSpawnPlan,
  BUILTIN_CARDS,
  DEFAULT_GENERAL_CARD,
  DEFAULT_RESEARCHER_CARD,
  runCli,
  harnessVersion,
  isNewerVersion,
  VoiceUnavailable,
  parseDuckDuckGo,
  type AnthropicTool,
  type ApprovalDecision,
  type FsPort,
  type GrantBinding,
  type MemoryPort,
  type ModelToolRuntimeContext,
  type PendingAction,
  type ProviderAdapter,
  type SessionLog,
  type SpendEntry,
  type SpendStore,
  type Settings,
  type TaskObservation,
  type ToolExecutionContext,
  type LogEntry,
  type ResolvedWorkBinding,
  type VerificationTrace,
} from '@aisy/core'
import { plural, TOOL_LABEL, type GoalScreenView } from '@aisy/telegram-gw'
import { makeTelegramBot, type TelegramExecutionTurnV1 } from '../bot.js'
import { makeSetupTelegramBot } from '../setup-bot.js'
import { makeServiceKeyStore } from '../service-keys.js'
import { makeOnboardingBrief } from '../onboarding-brief.js'
import { makeOnboardingProgress, TOPIC_LABEL } from '../onboarding-progress.js'
import { makeOperatorProfileWriter } from '../operator-profile.js'
import {
  claudeCodeEnvironment,
  makeClaudeTokenSetup,
  BRAIN_RUNTIME_PACKAGES,
  makeNodeBrainRuntimeInstaller,
  makeNodeClaudeSmokeTest,
  resolveNodeToolPath,
} from '../claude-subscription-setup.js'
import { makeNodeBrainBootstrapStore } from '../brain-bootstrap-store.js'
import { makeAgentBudgetCheck } from '../agent-budget.js'
import { makeJsonlJournal } from '../journal.js'
import { makeScheduler } from '../scheduler.js'
import { makeTriggerStore } from '../trigger-store.js'
import { makeTriggerProbeRunner } from '../trigger-probe.js'
import { makeGoalStore } from '../goal-store.js'
import { makeGoalOrchestrator } from '../goal-orchestrator.js'
import { parseGoalMode } from '../goal-parse.js'
import { makeNodeBackgroundBindingStore } from '../background-binding-store.js'
import { makeNodeApprovalGrantPersistence } from '../approval-grant-store.js'
import { makeNodeActiveSkillPersistence } from '../active-skill-store.js'
import { makeNodeMcpAllowlistPersistence, makeNodeMcpAllowlistWriter } from '../mcp-allowlist-store.js'
import { connectMcpCapability } from '../mcp-capability-composition.js'
import { makeMcpRuntime } from '../mcp-runtime.js'
import { makeMcpServerOnboarding } from '../mcp-server-onboarding.js'
import { makeTelegramMcpControls } from '../telegram-mcp-controls.js'
import { makeMainAgentCapabilityRuntime } from '../main-agent-capability-runtime.js'
import { makeAgentCardRegistryStore } from '../agent-card-registry-store.js'
import { makeAgentCardLifecycleRuntime } from '../agent-card-lifecycle-runtime.js'
import { makeAgentCardLegacyImportPort } from '../agent-card-legacy-import.js'
import { selectAgentCardForRun } from '../agent-card-live-selection.js'
import { makeNodeConfinementProcessPort } from '../confinement-sidecar.js'
import { makeConfiguredMcpMenuSource } from '../mcp-menu-runtime.js'
import { makeConfiguredSkillMenuSource } from '../skill-menu-runtime.js'
import {
  makeMonitoringDeliveryCoordinator,
  makeNodeMonitoringRuntime,
} from '../monitoring-runtime.js'
import { loadJsonSecretSource, makeLiveSecretValues } from '../live-secret-sources.js'
import {
  NATIVE_API_SECRET_PROXY_REQUIRED,
  nativeApiProviderIds,
} from '../native-api-secret-policy.js'
import { makeProviderBrokerFetch } from '../provider-broker-fetch.js'
import {
  makeNodeProviderLifecycleControl,
  ProviderLifecycleControlError,
  runProviderMaterialSetCommand,
} from '../provider-lifecycle-control.js'
import {
  asBrokerNativeProviderId,
  inspectProviderBrokerDoctor,
  inspectProviderBrokerReady,
  makeNodeProviderBrokerReadinessPort,
} from '../provider-broker-readiness.js'
import { makeMonitoringStatusSource } from '../monitoring-status-runtime.js'
import { makeTelegramMonitoringControls } from '../telegram-monitoring-controls.js'
import {
  DEFAULT_MONITORING_LIVE_CONFIG,
  makeMonitoringLiveCoordinator,
  makeNodeMonitoringWindowStore,
  type MonitoringLiveConfig,
} from '../monitoring-live-runtime.js'
import { makeTelegramMonitoringDigestDeliveryPort } from '../telegram-monitoring-delivery.js'
import { makeNodeMonitoringTelegramSendLedger } from '../monitoring-telegram-send-ledger.js'
import { makeNightlyLiveSnapshotLoader } from '../nightly-live-snapshot.js'
import {
  makeSingletonTelegramAttachmentInbox,
  makeTelegramBotApiAttachmentDownloadPort,
  type SingletonTelegramAttachmentInbox,
} from '../telegram-attachment-inbox.js'
import {
  inspectMediaInboxWriterLock,
  makeDeadWriterQuiescence,
  makeMediaInboxWriterRecovery,
  unattendedRecoveryAuthorization,
} from '../telegram-attachment-inbox-recovery.js'
import { makeClaudeSubscriptionProvider } from '../claude-subscription-provider.js'
import {
  makeNodeCodexSubscriptionRuntime,
  makeRefreshingNodeCodexAuthProcessPort,
  type NodeCodexSubscriptionRuntime,
} from '../codex-subscription-runtime.js'
import { liveProviderTools, makeLiveToolExecutor } from '../live-network-tool-policy.js'
import { makeProductionDurableDelegationDispatcher } from '../durable-delegation-production.js'
import { makeNodeDurableDelegationRunRegistry } from '../durable-delegation-run-registry.js'
import { makeNodeDelegationRunLock } from '../delegation-persistence.js'
import { makeDurableDelegationStartupRecoveryPortV1 } from '../durable-delegation-startup-recovery.js'
import { makeNodeDurableDelegationOperationJournalV2 } from '../durable-delegation-operation-journal.js'
import {
  durableParentAmbiguityOperationHash,
  durableParentContinuationWorkBindingHash,
  makeNodeDurableParentContinuationStore,
  type DurableParentAmbiguityV1,
} from '../durable-parent-continuation.js'
import {
  makeDurableTurnActorProductionPortsV1,
} from '../durable-turn-actor-production-ports.js'
import { makeNodeDurableTurnActorController } from '../durable-turn-actor.js'
import {
  makeDurableDelegationTurnCoordinatorV1,
  type DurableDelegationTurnCoordinatorV1,
} from '../durable-delegation-turn-coordinator.js'
import {
  durableDelegationRecoverableInterruptionCode,
  durableDelegationRecoverableRuntimeErrorCode,
} from '../durable-delegation-runtime.js'
import {
  makeNodePlanExecutionPersistence,
  makePlanExecutionStateController,
  type PlanExecutionToolEffect,
} from '../plan-execution-state.js'
import {
  makePlanToolProtocol,
  PLAN_SUBMIT_TOOL_DEFINITION,
  type PlanReviewDecision,
  type PlanReviewView,
} from '../plan-tool-protocol.js'
import { makeOpenPageFetch } from '../page-fetch.js'
import {
  makePinnedHttpsJson,
  makePinnedHttpsTextGet,
  pinnedWebSearchUrl,
} from '../pinned-https-egress.js'
import { makeLinkReader, makeServiceSearch, SERVICE_HOSTS } from '../link-services.js'
import {
  DEFAULT_RESEARCH_LIMITS,
  makeResearchApproval,
  researchPlan,
  stopLine,
  stopNote,
  type ResearchApproval,
} from '../deep-research.js'
import {
  discardNodeTelegramExecutionCheckpoint,
  inspectNodeTelegramExecutionCheckpoint,
  makeNodeTelegramExecutionCheckpointStore,
} from '../telegram-execution-checkpoint.js'
import { makeNodeTelegramReplyCheckpointStore } from '../telegram-reply-stream-checkpoint.js'
import { recoverDurableTelegramReplyRelease } from '../durable-reply-release.js'
import { recoverTelegramExecutionAtStartup } from '../telegram-execution-startup-recovery.js'
import {
  acquireTranscriptWriterLease,
  inspectTranscriptWriterLease,
  TranscriptWriterLeaseError,
} from '../transcript-writer-lease.js'
import { makeWorkspaceV2DoctorProbe } from '../workspace-v2-doctor.js'
import {
  makeLiveProjectRegistryView,
  type LiveProjectRegistryView,
} from '../project-registry-v2-live-adapter.js'
import {
  makeNodeProjectRegistryV2Store,
  ProjectRegistryV2StoreError,
} from '../project-registry-v2-store.js'
import { makeNodeAutonomyEvidenceStore } from '../autonomy-evidence-store.js'
import { makeNodeLearnedGrantStore } from '../learned-grant-store.js'
import { makeNodeProjectServiceRuntime } from '../project-service-runtime.js'
import { makeTelegramProjectControls } from '../telegram-project-controls.js'
import { makeTelegramSessionControls } from '../telegram-session-controls.js'
import { makeTelegramSkillControls } from '../telegram-skill-controls.js'
import { makeNewSessionRunner, makeResumeSessionRunner } from '../telegram-new-session.js'
import { makeNodeProjectLifecycleAuthorityRuntime } from '../project-lifecycle-authority-runtime.js'
import { makeTelegramProjectLifecycleControls } from '../telegram-project-lifecycle-controls.js'
import { makeTranscriptCompactionSummarizer } from '../transcript-compaction.js'
import {
  makeNodeProtectedMemoryPreviewRouter,
  makeNodeProtectedMemoryScopeRuntime,
  parseProtectedMemoryPreviewMode,
  parseProtectedMemorySemanticConfig,
  ProtectedMemoryRuntimeError,
} from '../protected-memory-runtime.js'
import { makeScopedMemoryLiveView } from '../scoped-memory-live-adapter.js'
import { makeMemoryLeaseSource } from '../memory-lease-source.js'
import { makeFrozenPrefixSource } from '../frozen-prefix-source.js'
import { makeMemorySelfCheckRuntime } from '../memory-self-check-runtime.js'
import { makeDailyJournal } from '../daily-journal.js'
import { makeTaskTracker } from '../task-tracker.js'
import { makeDailyBudget } from '../daily-budget.js'
import { makeExecutionModeGrantStore, makeExecutionModeStore } from '../execution-mode.js'
import { makeTranscriptionRegistry } from '../transcription-registry.js'
import { makeDeepgramProxyProvider } from '../deepgram-proxy-provider.js'
import {
  DEFAULT_VOICE_DAILY_MS,
  makeNodeDeepgramProxySpendAuthority,
} from '../deepgram-runtime.js'
import { makeTelegramVoiceIngress } from '../telegram-voice-ingress.js'
import { makeTelegramVoiceMediaCapabilityIssuer } from '../telegram-voice-media-capability.js'
import {
  makeNodeVoiceCredentialControl,
  runVoiceCredentialSetCommand,
  VoiceCredentialControlError,
} from '../voice-credential-control.js'
import { readVoiceCredentialFromTty } from '../voice-credential-tty.js'
import { readServerStatus, renderServerStatus } from '../server-status.js'
import { makeRuntimeRestart } from '../runtime-restart.js'
import {
  establishExecutionSupervisorStartupBarrier,
  EXECUTION_SUPERVISOR_SELECTOR_ENV,
  makeExecutionSupervisorRecoveryContextV1,
  makeExecutionSupervisorChildEnv,
  makeNodeExecutionSupervisorChildChannel,
  type ExecutionSupervisorLease,
} from '../execution-supervisor-ipc.js'
import {
  AISY_PLANNED_RESTART_EXIT_CODE,
  makeExecutionParentSupervisor,
  makeNodeExecutionSupervisorSpawnPort,
} from '../execution-parent-supervisor.js'
import { openLinuxVoiceBrokerNativePort, type VoiceBrokerNativePort } from '../voice-broker-native.js'
import {
  makeNodeExecutionSupervisorStateStore,
  resolveExecutionSupervisorStateRoot,
} from '../supervisor-state.js'
import {
  EXECUTION_SUPERVISOR_LIVENESS_ENV,
  ExecutionSupervisorLeaseError,
  acquireExecutionRunLiveness,
  decodeExecutionSupervisorChildLivenessDescriptor,
} from '../execution-supervisor-liveness.js'
import { executionDockerStartupRefusal } from '../execution-docker-startup-policy.js'
import {
  enrollNodeOwnedDockerProductionRecovery,
  makeNodeOwnedDockerProductionRecovery,
  makeNodeOwnedDockerProductionRecoveryDoctorProbe,
  ownedDockerProductionRecoveryRequested,
  OWNED_DOCKER_PRODUCTION_CONFIG_INVALID,
  OWNED_DOCKER_SUPERVISOR_REQUIRED,
} from '../owned-docker-production-recovery.js'
import { makeServerAccess, type ServerAccessConfig } from '../server-access.js'
import { KnowledgeZoneError, makeKnowledgeZone } from '../knowledge-zone.js'
import {
  collectHookContext,
  loadExtensionHooks,
  type ExtensionHookModule,
} from '../extension-hooks.js'
import { makeNodeLeaseBoundSessionTranscriptRecorder } from '../session-transcript-runtime.js'
import { makeNodeTelegramForwardBatchStore } from '../telegram-forward-batch-store.js'
import { makeBotRegistry } from '../bot-registry-store.js'
import { resolveExecutable } from '../resolve-executable.js'
import { runManagedUpdateCli } from '../managed-install.js'
import { botStateRoots } from '../bot-paths.js'
import {
  makeProtectedMemoryDoctorPort,
  makeTranscriptionDoctorProbe,
} from '../doctor-runtime-probes.js'
import {
  makeConsolidationRunner,
  makeFileRunLock,
  makeMemoryValidators,
  memOpToMemoryOp,
  makeNightlyGenerator,
  makeNightlyJudge,
  makeTriggerEngine,
  makeGoalSpec,
  makeExactCache,
  makeMemoryExactCacheStore,
  makeFailoverProvider,
  isKnownTimeZone,
  type ActiveSkillCatalog,
  type GoalMode,
  type GoalSpec,
  type NightlyConfig,
  type ProjectRegistryStateV2,
  type ProjectRegistryV2,
  type TurnContextLease,
  type TriggerBudget,
} from '@aisy/core'

const argv = process.argv.slice(2)

if (argv[0] === 'update') {
  process.exit(await runManagedUpdateCli(argv.slice(1)))
}

const VOICE_CONTROL_SOCKET_PATH = '/run/aisy/voice-control.sock'
const VOICE_BOOTSTRAP_SOCKET_PATH = '/run/aisy/voice-bootstrap.sock'
const VOICE_BROKER_PID_PATH = '/run/aisy/voice-broker.pid'
const VOICE_BROKER_ADDON_PATH =
  '/usr/lib/aisy/voice-proxy/current/aisy_voice_broker_bridge.node'

let ownedDockerRecoveryRequested = false
if (argv[0] === 'supervise' || argv[0] === 'run') {
  const refusal = executionDockerStartupRefusal(process.env)
  if (refusal !== null) {
    process.stderr.write(`aisy: ${refusal}\n`)
    process.exit(70)
  }
  try {
    ownedDockerRecoveryRequested = ownedDockerProductionRecoveryRequested(process.env)
  } catch {
    process.stderr.write(`aisy: ${OWNED_DOCKER_PRODUCTION_CONFIG_INVALID}\n`)
    process.exit(70)
  }
  if (argv[0] === 'run' && ownedDockerRecoveryRequested) {
    process.stderr.write(`aisy: ${OWNED_DOCKER_SUPERVISOR_REQUIRED}\n`)
    process.exit(70)
  }
}

if (argv[0] === 'supervise') {
  const binPath = process.argv[1]
  if (binPath === undefined || binPath === '') {
    process.stderr.write('aisy: supervisor executable unavailable\n')
    process.exit(70)
  }
  const stateRoot = resolveExecutionSupervisorStateRoot({
    platform: process.platform,
    home: homedir(),
    ...(process.env['XDG_STATE_HOME'] === undefined ? {} : { xdgStateHome: process.env['XDG_STATE_HOME'] }),
  })
  const childEnv = makeExecutionSupervisorChildEnv(process.env)
  delete childEnv['AISY_VOICE_BROKER_ADDON_PATH']
  delete childEnv['AISY_VOICE_BROKER_BOOTSTRAP_SOCKET']
  delete childEnv['AISY_VOICE_BROKER_PID']
  const voiceFilesPresent = [VOICE_BROKER_ADDON_PATH, VOICE_BOOTSTRAP_SOCKET_PATH,
    VOICE_BROKER_PID_PATH].filter(path => existsSync(path)).length
  let voiceBridge: VoiceBrokerNativePort | null = null
  let ownedDockerManager: ReturnType<typeof makeNodeOwnedDockerProductionRecovery> = null
  const abort = new AbortController()
  const stop = (): void => { abort.abort() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms)
      timer.unref?.()
      function done(): void {
        signal.removeEventListener('abort', done)
        clearTimeout(timer)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
    })
  }
  try {
    if (voiceFilesPresent !== 0) {
      if (voiceFilesPresent !== 3) {
        throw new Error('VOICE_BROKER_CONFIG_INCOMPLETE')
      }
      const pidInfo = statSync(VOICE_BROKER_PID_PATH)
      if (!pidInfo.isFile() || pidInfo.uid !== 0 || (pidInfo.mode & 0o022) !== 0 ||
        realpathSync(VOICE_BROKER_PID_PATH) !== VOICE_BROKER_PID_PATH || pidInfo.size > 32) {
        throw new Error('VOICE_BROKER_CONFIG_INVALID')
      }
      const voiceBrokerPidRaw = readFileSync(VOICE_BROKER_PID_PATH, 'utf8').trim()
      if (!/^[1-9][0-9]{0,9}$/.test(voiceBrokerPidRaw)) {
        throw new Error('VOICE_BROKER_CONFIG_INVALID')
      }
      const expectedBrokerPid = Number(voiceBrokerPidRaw)
      if (!Number.isSafeInteger(expectedBrokerPid) || expectedBrokerPid < 1) {
        throw new Error('VOICE_BROKER_CONFIG_INVALID')
      }
      voiceBridge = openLinuxVoiceBrokerNativePort({
        addonPath: VOICE_BROKER_ADDON_PATH,
        bootstrapSocketPath: VOICE_BOOTSTRAP_SOCKET_PATH,
        expectedBrokerPid,
      })
    }
    ownedDockerManager = makeNodeOwnedDockerProductionRecovery({
      source: process.env,
      stateRoot,
    })
    const supervisor = makeExecutionParentSupervisor({
      execPath: process.execPath,
      binPath,
      childEnv,
      spawn: makeNodeExecutionSupervisorSpawnPort(),
      state: makeNodeExecutionSupervisorStateStore({ root: stateRoot }),
      nowMs: () => Date.now(),
      newId: () => randomBytes(32).toString('base64url'),
      randomNonce: () => randomBytes(32).toString('base64url'),
      sleep,
      ...(ownedDockerManager === null ? {} : { ownedDockerManager }),
      ...(voiceBridge === null
        ? {}
        : {
            voice: {
              mediaRoot: join(process.env['AISY_HOME'] ?? join(homedir(), '.aisy'), 'media-inbox', 'objects'),
              bridge: voiceBridge,
            },
          }),
      onQuarantine: (code) => {
        process.stderr.write(`aisy: supervisor quarantined (${code})\n`)
      },
    })
    const result = await supervisor.run(abort.signal)
    if (result.kind === 'quarantined') {
      process.exit(70)
    }
    process.exit(0)
  } catch {
    process.stderr.write('aisy: execution supervisor unavailable\n')
    process.exit(70)
  } finally {
    await ownedDockerManager?.close()
    voiceBridge?.close()
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

if (argv.length === 2 && argv[0] === 'docker' && argv[1] === 'enroll') {
  const stateRoot = resolveExecutionSupervisorStateRoot({
    platform: process.platform,
    home: homedir(),
    ...(process.env['XDG_STATE_HOME'] === undefined
      ? {}
      : { xdgStateHome: process.env['XDG_STATE_HOME'] }),
  })
  try {
    enrollNodeOwnedDockerProductionRecovery({ source: process.env, stateRoot })
    process.stdout.write('Aisy: Docker recovery enrollment completed.\n')
    process.exit(0)
  } catch {
    process.stderr.write(`aisy: ${OWNED_DOCKER_PRODUCTION_CONFIG_INVALID}\n`)
    process.exit(70)
  }
}

// Skills from the shell. The manifest pins a hash per skill, so dropping a file
// into ~/.aisy/skills would leave it quarantined — this is the only way to seed
// one without the phone.
if (argv[0] === 'skill') {
  const skillHome = process.env['AISY_HOME'] ?? join(homedir(), '.aisy')
  const store = makeNodeActiveSkillPersistence({ root: skillHome })
  const sub = argv[1]
  const argument = argv[2]
  if (sub === 'list') {
    for (const entry of store.list()) {
      process.stdout.write(`${entry.enabled ? '✓' : '·'} ${entry.name} v${entry.version}` +
        `${entry.problem === null ? '' : ` [${entry.problem}]`} — ${entry.description}\n`)
    }
    process.exit(0)
  }
  if (sub === 'install' && argument !== undefined) {
    const result = store.install(readFileSync(argument, 'utf8'))
    if (!result.ok) {
      process.stderr.write(`aisy skill install: ${result.errorCode}` +
        `${result.detail === undefined ? '' : ` (${result.detail})`}\n`)
      process.exit(1)
    }
    process.stdout.write(`installed ${result.name} v${result.version}\n`)
    process.exit(0)
  }
  if (sub === 'remove' && argument !== undefined) {
    if (!store.remove(argument)) {
      process.stderr.write(`aisy skill remove: ${argument} is not installed\n`)
      process.exit(1)
    }
    process.stdout.write(`removed ${argument}\n`)
    process.exit(0)
  }
  process.stderr.write('usage: aisy skill list | install <path to SKILL.md> | remove <name>\n')
  process.exit(2)
}

// The key is accepted only from the controlling terminal. Parsing happens
// before /dev/tty or the root-owned control socket is opened; the narrow
// client then sends raw bytes outside the JSON header and zeroizes them on
// every path. No vault, dotenv or process environment participates here.
if (argv[0] === 'provider' && argv[1] === 'credential') {
  try {
    const control = makeNodeProviderLifecycleControl()
    const result = await runProviderMaterialSetCommand({
      argv,
      readMaterial: () => readVoiceCredentialFromTty(),
      ingress: control,
    })
    process.stdout.write(`Provider credential сохранён (revision ${result.revision}).\n`)
    process.exit(0)
  } catch (error) {
    const code = error instanceof ProviderLifecycleControlError ? error.code : 'CONTROL_UNAVAILABLE'
    process.stderr.write(`aisy provider credential: операция отклонена (${code}).\n`)
    process.exit(code === 'INVALID_COMMAND' ? 2 : 1)
  }
}

if (argv[0] === 'voice') {
  try {
    const control = makeNodeVoiceCredentialControl({
      socketPath: VOICE_CONTROL_SOCKET_PATH,
    })
    const result = await runVoiceCredentialSetCommand({
      argv,
      readSecret: () => readVoiceCredentialFromTty(),
      ingress: control,
    })
    process.stdout.write(`Deepgram credential сохранён (revision ${result.revision}).\n`)
    process.exit(0)
  } catch (error) {
    const code = error instanceof VoiceCredentialControlError ? error.code : 'CONTROL_UNAVAILABLE'
    process.stderr.write(`aisy voice: операция отклонена (${code}).\n`)
    process.exit(code === 'INVALID_COMMAND' ? 2 : 1)
  }
}

// Non-run commands → onboarding CLI. `setup` is a validated alias for init (see SETUP_ELEMENTS).
if (argv[0] !== 'run') {
  try {
    const doctorBase = process.env['AISY_HOME'] ?? join(homedir(), '.aisy')
    const doctorVault = loadJsonSecretSource(join(doctorBase, 'vault.json'), {
      existsSync,
      readFileSync,
    }).values
    const doctorDotenv = loadDotEnvState(join(doctorBase, '.env'), {
      existsSync,
      readFileSync,
    }).values
    const doctorCfg = (key: string): string | undefined =>
      doctorVault[key] ?? process.env[key] ?? doctorDotenv[key]
    const doctorRegistry = makeBotRegistry({ path: join(doctorBase, 'bots.json') })
    const doctorActiveBot = doctorRegistry.byTokenEnv('AISY_TELEGRAM_BOT_TOKEN') ??
      doctorRegistry.primary()
    const doctorRoots = botStateRoots({
      base: doctorBase,
      botId: doctorActiveBot?.id ?? null,
      primaryBotId: doctorRegistry.primary()?.id ?? null,
      overrides: {
        ...(doctorCfg('AISY_MEMORY_ROOT') === undefined
          ? {}
          : { memory: doctorCfg('AISY_MEMORY_ROOT') as string }),
        ...(doctorCfg('AISY_PROTECTED_MEMORY_ROOT') === undefined
          ? {}
          : { protectedMemory: doctorCfg('AISY_PROTECTED_MEMORY_ROOT') as string }),
      },
    })
    const doctorChatId = Number(doctorCfg('AISY_TELEGRAM_CHAT_ID'))
    const doctorProviderInstallationHash = createHash('sha256')
      .update('aisy.provider.installation.v1\0')
      .update(doctorBase)
      .digest('hex')
    const doctorSupervisorStateRoot = resolveExecutionSupervisorStateRoot({
      platform: process.platform,
      home: homedir(),
      ...(process.env['XDG_STATE_HOME'] === undefined
        ? {}
        : { xdgStateHome: process.env['XDG_STATE_HOME'] }),
    })
    const exitCode = await runCli(argv, {
      ops: makeNodeOnboardingOps({
        memory: makeProtectedMemoryDoctorPort({
          mode: doctorCfg('AISY_PROTECTED_MEMORY'),
          root: doctorRoots.protectedMemory,
          operatorId: Number.isSafeInteger(doctorChatId)
            ? `telegram:${doctorChatId}`
            : 'telegram:unconfigured',
          profileId: 'default',
        }),
        transcription: makeTranscriptionDoctorProbe({
          path: join(doctorBase, 'transcription.json'),
          voice: {
            artifactPath: VOICE_BROKER_ADDON_PATH,
            controlSocketPath: VOICE_CONTROL_SOCKET_PATH,
            bootstrapSocketPath: VOICE_BOOTSTRAP_SOCKET_PATH,
            statusPath: '/run/aisy/voice-status.json',
          },
        }),
        mediaInbox: {
          writerLock: () => inspectMediaInboxWriterLock({
            inboxRoot: join(doctorBase, 'media-inbox'),
          }),
        },
        telegramExecution: {
          inspect: () => inspectNodeTelegramExecutionCheckpoint({
            path: join(doctorBase, 'telegram', 'execution-card.json'),
          }),
        },
        transcriptWriter: {
          lease: () => inspectTranscriptWriterLease({ root: join(doctorBase, 'journal') }),
        },
        ownedDockerRecovery: makeNodeOwnedDockerProductionRecoveryDoctorProbe({
          source: process.env,
          stateRoot: doctorSupervisorStateRoot,
        }),
        providerBroker: {
          inspect: selectedProviders => inspectProviderBrokerDoctor({
            platform: process.platform,
            selectedProviders,
            expectedInstallationHash: doctorProviderInstallationHash,
            port: makeNodeProviderBrokerReadinessPort(),
          }),
        },
        // Read-only Workspace v2 readiness (ADR-0073). Never advances a phase and
        // never enables v2 writes; an absent manifest reads as "not prepared".
        migration: makeWorkspaceV2DoctorProbe({
          home: doctorBase,
          sourceRegistryPath: join(doctorBase, 'projects.json'),
          sourceDbPath: process.env['AISY_DB_PATH'] ?? join(doctorBase, 'memory.db'),
          owners: [],
          policy: {
            homeRoot: homedir(),
            projectsRoot: join(homedir(), 'projects'),
            protectedRoots: [doctorBase],
          },
        }),
      }),
      out: (s) => process.stdout.write(s + '\n'),
      err: (s) => process.stderr.write(s + '\n'),
      version: harnessVersion(),
      color: process.stdout.isTTY === true && !process.env['NO_COLOR'],
    })
    process.exit(exitCode)
  } catch (err) {
    // Surface a clean status line, never a raw Node stack trace.
    process.stderr.write(`aisy: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

// --- aisy run: boot the live agent ---

// ADR-0071 runtime lease and startup barrier come before update checks, vault/provider
// construction, scheduler state and Telegram. The environment is only a
// selector: without a live inherited IPC channel it proves nothing and fails
// closed here. A direct unsupervised `aisy run` remains supported.
let executionSupervisorSession: Awaited<ReturnType<typeof establishExecutionSupervisorStartupBarrier>>
let executionRuntimeLease: ReturnType<typeof acquireExecutionRunLiveness>
try {
  const selected = process.env[EXECUTION_SUPERVISOR_SELECTOR_ENV] === '1'
  const rawDescriptor = process.env[EXECUTION_SUPERVISOR_LIVENESS_ENV]
  delete process.env[EXECUTION_SUPERVISOR_LIVENESS_ENV]
  const runStateRoot = resolveExecutionSupervisorStateRoot({
    platform: process.platform,
    home: homedir(),
    ...(process.env['XDG_STATE_HOME'] === undefined ? {} : { xdgStateHome: process.env['XDG_STATE_HOME'] }),
  })
  const expectedDescriptor = selected && rawDescriptor !== undefined
    ? decodeExecutionSupervisorChildLivenessDescriptor(rawDescriptor)
    : undefined
  if (selected && expectedDescriptor === undefined) throw new Error('MISSING_CHILD_LIVENESS_DESCRIPTOR')
  executionRuntimeLease = acquireExecutionRunLiveness({
    stateRoot: runStateRoot,
    ...(expectedDescriptor === undefined ? {} : { supervisedDescriptor: expectedDescriptor }),
  })
  executionRuntimeLease.onLost(() => { process.exit(1) })
  const channel = selected && process.connected === true && typeof process.send === 'function'
    ? makeNodeExecutionSupervisorChildChannel(process as never)
    : null
  executionSupervisorSession = await establishExecutionSupervisorStartupBarrier({
    selected,
    channel,
    newRequestId: () => randomUUID(),
    randomNonce: () => randomBytes(32).toString('base64url'),
    nowMs: () => Date.now(),
    ...(selected ? { livenessDescriptorHash: executionRuntimeLease.descriptorHash } : {}),
  })
} catch (error) {
  const detail = error instanceof ExecutionSupervisorLeaseError ? ` (${error.code})` : ''
  process.stderr.write(`aisy: execution supervisor authority unavailable${detail}\n`)
  process.exit(1)
}
void executionRuntimeLease
executionSupervisorSession?.onLost(() => { process.exit(1) })

const base = process.env['AISY_HOME'] ?? join(homedir(), '.aisy')
const vaultPath = join(base, 'vault.json')
const grantsPath = join(base, 'grants.json')
// The home directory itself is not a legal context root, and neither is any
// ancestor of it or anything overlapping ~/.aisy. A service manager starts the
// agent with cwd = $HOME, so taking cwd would make the very first full run die
// inside the registry with CORRUPT_STATE — before Telegram, with no card to
// explain it. `~/workspace` is the default; cwd is used only when it qualifies.
const workspaceRoot = process.env['AISY_WORKSPACE'] ?? ((): string => {
  const cwd = process.cwd()
  const home = homedir()
  const insideHome = cwd.startsWith(home + '/')
  const insideState = cwd === base || cwd.startsWith(base + '/') || base.startsWith(cwd + '/')
  return insideHome && !insideState ? cwd : join(home, 'workspace')
})()

const vaultState = loadJsonSecretSource(vaultPath, { existsSync, readFileSync })
const vault = vaultState.values
// A fresh install has no vault — `aisy init` scaffolds ~/.aisy/.env and the
// operator fills it in. Read it as the lowest-precedence config layer so that
// file is real config, not decoration. Precedence: vault > process.env > .env.
const dotenvState = loadDotEnvState(join(base, '.env'), { existsSync, readFileSync })
const dotenv = dotenvState.values
const cfg = (key: string): string | undefined => vault[key] ?? process.env[key] ?? dotenv[key]

const token = cfg('AISY_TELEGRAM_BOT_TOKEN') ?? ''
const chatIdRaw = cfg('AISY_TELEGRAM_CHAT_ID') ?? ''
const postToolUse = {
  secretValues: makeLiveSecretValues({ vault: vaultState, dotenv: dotenvState, processEnv: process.env }),
}
// Provider selection from ~/.aisy/providers.json (per-tier or a single default).
// Back-compat: no file ⇒ Anthropic + AISY_PROVIDER_MODEL + the legacy reasoning key.
interface ProviderSel {
  provider: string
  model: string
}
interface ProvidersConfig {
  default?: ProviderSel
  tiers?: { reasoning: ProviderSel; critique: ProviderSel; routine: ProviderSel }
  /** Fallback provider used when the primary fails with a transient error. */
  fallback?: ProviderSel
  /** Per-(sub)agent overrides + budgets (ADR-0050 Phase 3). The main agent's
   *  budget may also come from AISY_BUDGET_USD. */
  agents?: Record<string, { provider?: string; model?: string; budgetUsd?: number }>
}
const providersPath = join(base, 'providers.json')
function loadProviders(): ProvidersConfig {
  if (!existsSync(providersPath)) return {}
  try {
    return JSON.parse(readFileSync(providersPath, 'utf8')) as ProvidersConfig
  } catch {
    return {}
  }
}
const providersCfg = loadProviders()
/** Atomic, private write: providers.json holds no secret but selects the brain. */
function writeProvidersConfig(next: ProvidersConfig): void {
  const temp = providersPath + '.tmp'
  writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, providersPath)
}
const defaultSel: ProviderSel =
  providersCfg.default ?? { provider: 'anthropic', model: process.env['AISY_PROVIDER_MODEL'] ?? 'claude-sonnet-4-6' }

if (!token || !chatIdRaw) {
  process.stderr.write(
    'aisy run: missing bot token / paired chat_id.\n' +
      'Run `aisy init`, or fill them in yourself: ' + join(base, '.env') + '\n' +
      '  AISY_TELEGRAM_BOT_TOKEN=  (from @BotFather)\n' +
      '  AISY_TELEGRAM_CHAT_ID=    (paired Telegram user id)\n',
  )
  process.exit(1)
}
const allowedChatId = Number(chatIdRaw)
if (!Number.isSafeInteger(allowedChatId)) {
  process.stderr.write('aisy run: invalid paired chat_id.\n')
  process.exit(1)
}

const executionCardPath = join(base, 'telegram', 'execution-card.json')
const executionCheckpointStore = makeNodeTelegramExecutionCheckpointStore({
  path: executionCardPath,
})
const replyCheckpointStore = executionSupervisorSession === null
  ? null
  : makeNodeTelegramReplyCheckpointStore({
      path: join(realpathSync(base), 'telegram', 'reply-card.json'),
      trustedRoot: realpathSync(base),
    })
const durableDelegationStateRoot = join(base, 'durable-delegation')
const durableDelegationRegistry = executionSupervisorSession === null
  ? null
  : (() => {
      mkdirSync(durableDelegationStateRoot, { recursive: true, mode: 0o700 })
      return makeNodeDurableDelegationRunRegistry({ stateRoot: durableDelegationStateRoot })
    })()
const durableInstallationHash = createHash('sha256')
  .update('aisy.durable-delegation.installation.v1\0')
  .update(base)
  .digest('hex')
const voiceInstallationHash = createHash('sha256')
  .update('aisy.voice.installation.v1\0')
  .update(base)
  .digest('hex')
const providerInstallationHash = createHash('sha256')
  .update('aisy.provider.installation.v1\0')
  .update(base)
  .digest('hex')
const voiceCredentialControl = makeNodeVoiceCredentialControl({
  socketPath: VOICE_CONTROL_SOCKET_PATH,
})
const providerCredentialControl = makeNodeProviderLifecycleControl()
const voiceCredentials = Object.freeze({
  binding: Object.freeze({
    installationHash: voiceInstallationHash,
    operatorId: `telegram:${allowedChatId}`,
    profileId: 'default',
    providerId: 'deepgram-cloud' as const,
  }),
  begin: voiceCredentialControl.begin,
  inspect: voiceCredentialControl.inspect,
  revoke: voiceCredentialControl.revoke,
})
const startupRecoveryLease = executionSupervisorSession?.recoveryLease ?? null
let startupDelegationRecoveryPending = false
let startupRecoveryLeaseClaimed = false
async function recoverExecutionCheckpointBeforeExternalIo(): Promise<void> {
  // Bytes today's validator refuses — corrupt, or simply written by a previous
  // version whose card had different fields — carry no message id, no binding
  // and no owner. There is nothing to recover from them and nothing in them to
  // protect, while refusing to boot on them costs the whole agent: that is how
  // a card left by an older build put the service in a restart loop until the
  // supervisor quarantined it. Move the file aside once and carry on.
  if (executionCheckpointStore.load().status === 'quarantined') {
    const moved = discardNodeTelegramExecutionCheckpoint({ path: executionCardPath })
    process.stderr.write(`aisy: unreadable execution checkpoint ${moved ? 'moved aside' : 'left in place'}\n`)
  }
  if (startupRecoveryLease === null) {
    const loaded = executionCheckpointStore.load()
    const clean = loaded.status === 'missing' || (loaded.status === 'ready' &&
      loaded.checkpoint.phase === 'terminal' && loaded.checkpoint.delivery === 'delivered')
    if (!clean) {
      process.stderr.write('aisy: execution recovery authority unavailable\n')
      process.exit(1)
    }
    return
  }
  if (durableDelegationRegistry?.listExact(startupRecoveryLease.bindingHash).length !== 0) {
    if (startupDelegationRecoveryPending) return
    process.stderr.write('aisy: durable delegation recovery requires full runtime\n')
    process.exit(1)
  }
  const telegram = new Api(token)
  let acquired = false
  const recovered = await recoverTelegramExecutionAtStartup({
    store: executionCheckpointStore,
    serviceManager: {
      async acquireRecoveryLease() {
        if (acquired) return null
        acquired = true
        return startupRecoveryLease
      },
    },
    output: {
      async sendText(html) {
        const sent = await telegram.sendMessage(allowedChatId, html, { parse_mode: 'HTML' })
        return sent.message_id
      },
      async editText(messageId, html) {
        await telegram.editMessageText(allowedChatId, messageId, html, { parse_mode: 'HTML' })
      },
    },
    newOwnerId: () => randomUUID(),
    nowIso: () => new Date().toISOString(),
  })
  if (recovered.kind !== 'none' && recovered.kind !== 'recovered') {
    process.stderr.write(`aisy: execution recovery unavailable (${recovered.code})\n`)
    process.exit(1)
  }
}

// Recovery and its release ACK precede every optional outbound boot action.
// The update check is fire-and-forget and never delays a healthy startup.
function startUpdateCheck(): void {
  void (async () => {
    try {
      const res = await fetch('https://registry.npmjs.org/@aisy/app/latest', {
        signal: AbortSignal.timeout(3000),
      })
      const json = (await res.json()) as { version?: unknown }
      const latest = typeof json.version === 'string' ? json.version : null
      if (latest !== null && isNewerVersion(harnessVersion(), latest)) {
        process.stderr.write(
          `Update available: ${harnessVersion()} → ${latest}. Run \`aisy update\`.\n`,
        )
      }
    } catch {
      // Offline, timeout, parse failure — silently ignore.
    }
  })()
}

// ADR-0087/0099: native API routes are executable only through a root-attested
// provider broker. A missing/drifted broker or a custom base URL stays in
// deterministic setup-only mode; known subscription/CLI providers are separate.
const selectedNativeApiProviders = nativeApiProviderIds(providersCfg, defaultSel)
const providerCredentials = Object.freeze({
  bindings: Object.freeze(selectedNativeApiProviders.map((value) => {
    const providerId = asBrokerNativeProviderId(value)
    if (providerId === null) throw new Error('native provider binding invariant')
    return Object.freeze({
      operatorId: `telegram:${allowedChatId}`,
      profileId: 'default',
      providerId,
    })
  })),
  begin: providerCredentialControl.begin,
  inspect: providerCredentialControl.inspect,
  revoke: providerCredentialControl.revoke,
})
const providerBrokerReady = selectedNativeApiProviders.length === 0
  ? null
  : inspectProviderBrokerReady({
      platform: process.platform,
      selectedProviders: selectedNativeApiProviders,
      port: makeNodeProviderBrokerReadinessPort(),
      expectedInstallationHash: providerInstallationHash,
    })
const blockedNativeApiProviders = providerBrokerReady === null
  ? selectedNativeApiProviders
  : []
const setupOnly = blockedNativeApiProviders.length !== 0
if (setupOnly) {
  // Setup has no agent transcript. It still must settle any durable execution
  // checkpoint before its first Telegram call, but does not take the full
  // runtime's journal writer authority.
  if (executionSupervisorSession?.recoveryReleaseReceipt !== null &&
    executionSupervisorSession?.recoveryReleaseReceipt !== undefined) {
    process.stderr.write('aisy setup: durable reply recovery requires full runtime binding\n')
    process.exit(1)
  }
  await recoverExecutionCheckpointBeforeExternalIo()
  if (!startupDelegationRecoveryPending) startUpdateCheck()
  mkdirSync(base, { recursive: true })
  const bootstrapPath = join(base, 'brain-bootstrap.json')
  const bootstrap = makeBrainBootstrap({
    store: makeNodeBrainBootstrapStore({ path: bootstrapPath }),
    nowIso: () => new Date().toISOString(),
  })
  // Without a coordinator the brain cards render but every button throws, so
  // the operator taps "войти" and nothing happens. Installation runs the
  // vendor's own published package through npm — the operator is in Telegram
  // and has no shell on this host, so a refusal here is a dead end, not safety.
  // On a fresh host neither CLI exists yet — that is the normal first run, and
  // the whole point of the card is to say so. The Codex port refuses a
  // non-canonical binary by throwing at construction, so an absent Codex used
  // to kill setup mode before Telegram ever came up.
  const codexSubscriptionHome = join(base, 'codex-subscription')
  // The installer may add Codex while this setup process is already alive.
  // Resolve the executable for every auth operation so the next button works
  // immediately instead of requiring a manual restart.
  const codexAuthProcessPort = makeRefreshingNodeCodexAuthProcessPort({
    resolveExecutable: () => resolveExecutable('codex'),
    codexHome: codexSubscriptionHome,
    environment: process.env,
  })
  const coordinator = makeBrainBootstrapCoordinator({
    bootstrap,
    drivers: [
      ((claudeAuthProcessPort) => makeClaudeSubscriptionSetupDriver({
        auth: makeClaudeSubscriptionAuthSpike(claudeAuthProcessPort),
        processPort: claudeAuthProcessPort,
        // The operator is in Telegram, not on the server. Refusing to run the
        // vendor's own documented install line leaves them with a button that
        // can only ever say "do it yourself on a machine you are not at".
        install: makeNodeBrainRuntimeInstaller({
          package: BRAIN_RUNTIME_PACKAGES['claude-code'],
        }),
      }))(makeNodeClaudeAuthProcessPort({ executable: resolveNodeToolPath('claude') })),
      makeCodexSubscriptionSetupDriver({
        auth: makeCodexSubscriptionAuth(codexAuthProcessPort),
        install: makeNodeBrainRuntimeInstaller({ package: BRAIN_RUNTIME_PACKAGES.codex }),
      }),
    ],
  })
  const { bot: setupBot } = makeSetupTelegramBot({
    token,
    allowedChatId,
    bootstrap,
    coordinator,
    claudeToken: makeClaudeTokenSetup({
      vaultPath,
      providersPath,
      exists: existsSync,
      readFile: (path) => readFileSync(path, 'utf8'),
      writePrivateFile: (path, content) =>
        writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 }),
      renameFile: renameSync,
      smokeTest: makeNodeClaudeSmokeTest(),
    }),
    // Setup mode and the agent are two compositions picked at boot, so the
    // brain only becomes real on the next start. Exit through the supervisor's
    // planned-restart path so the hand-over does not spend the crash budget.
    onBrainReady: () => {
      void (async () => {
        try {
          const ready = await bootstrap.state()
          if (ready.selectedBrain?.connectionId === 'codex-subscription') {
            writeProvidersConfig({
              ...providersCfg,
              default: { provider: 'codex-subscription', model: 'default' },
            })
          }
        } catch {
          process.stderr.write('aisy setup: не удалось сохранить выбранный мозг\n')
          return
        }
        try {
          await executionSupervisorSession?.authorizePlannedRestart(
            createHash('sha256').update('brain-bootstrap-handover').digest('hex'),
          )
        } catch {
          // Unsupervised or refused: a plain exit is still the honest end of
          // setup mode, the service manager is what brings the agent back.
        }
        process.exit(executionSupervisorSession === null ? 0 : AISY_PLANNED_RESTART_EXIT_CODE)
      })()
    },
    onError: (code) => { process.stderr.write(`aisy setup: ${code}\n`) },
  })
  process.stdout.write(`aisy run: starting setup-only Telegram mode (chat ${allowedChatId})…\n`)
  await setupBot.start()
  process.exit(0)
}

// Resolve the per-bot journal before any full-runtime recovery send/edit,
// update fetch, provider construction or Telegram polling. The enabled journal
// is a durable runtime invariant; only exact `0` is an explicit rollback.
const botRegistry = makeBotRegistry({ path: join(base, 'bots.json') })
const activeBot = botRegistry.byTokenEnv('AISY_TELEGRAM_BOT_TOKEN') ?? botRegistry.primary()
const primaryBot = botRegistry.primary()
const botRoots = botStateRoots({
  base,
  botId: activeBot?.id ?? null,
  primaryBotId: primaryBot?.id ?? null,
  overrides: {
    ...(cfg('AISY_MEMORY_ROOT') === undefined ? {} : { memory: cfg('AISY_MEMORY_ROOT') as string }),
    ...(cfg('AISY_PROTECTED_MEMORY_ROOT') === undefined
      ? {}
      : { protectedMemory: cfg('AISY_PROTECTED_MEMORY_ROOT') as string }),
  },
})
const memoryRoot = botRoots.memory
const journalRoot = botRoots.journal
let journalLease: ReturnType<typeof acquireTranscriptWriterLease> | null = null
if (process.env['AISY_SESSION_JOURNAL'] !== '0') {
  try {
    journalLease = acquireTranscriptWriterLease({ root: journalRoot })
  } catch (error) {
    const reason = error instanceof TranscriptWriterLeaseError ? error.reason : 'lease-unavailable'
    process.stderr.write(`aisy run: writer lease журнала сессий недоступен (${reason}).\n`)
    process.exit(1)
  }
}
const releaseJournalLease = (): void => {
  const held = journalLease
  journalLease = null
  if (held === null) return
  try { held.release() } catch { /* a foreign/replaced identity is left untouched */ }
}
process.once('exit', releaseJournalLease)

mkdirSync(base, { recursive: true })
const registryOwner = { operatorId: `telegram:${allowedChatId}`, profileId: 'default' }
const registryPolicy = {
  homeRoot: homedir(),
  projectsRoot: join(homedir(), 'projects'),
  protectedRoots: [base],
}

// The v2 registry is the only registry the live path knows. There is no v1
// fallback and no implicit migration: a first run simply publishes a fresh v2
// state. A legacy v1 file, if any, stays on disk untouched and unread.
const registryPair: { view: LiveProjectRegistryView; registry: ProjectRegistryV2 } = (() => {
  const store = makeNodeProjectRegistryV2Store({
    path: join(base, 'projects-v2.json'),
    policy: registryPolicy,
  })
  let state: ProjectRegistryStateV2 | null = null
  try {
    state = store.load()
  } catch (error) {
    if (error instanceof ProjectRegistryV2StoreError && error.code === 'CORRUPT_REGISTRY') {
      process.stderr.write('aisy run: реестр v2 повреждён; live writes закрыты. Запустите aisy doctor.\n')
      process.exit(1)
      throw error
    }
    // REGISTRY_NOT_FOUND — first run; a fresh state is published below.
  }
  if (state === null) {
    // v2 from the start: a first run publishes a fresh v2 registry. Any legacy v1
    // file is left untouched on disk and is never read into the live path.
    state = makeFreshProjectRegistryV2({
      ...registryOwner,
      workspaceRoot,
      policy: registryPolicy,
      nowIso: () => new Date().toISOString(),
      newId: () => randomUUID(),
    })
    store.saveAtomic(state)
  }
  // One registry instance, two consumers: the narrow view the startup path uses
  // and the raw registry the project/session controls need. A second
  // makeProjectRegistryV2 over the same file would be a second writer with its
  // own cache.
  const registry = makeProjectRegistryV2({
    state,
    policy: registryPolicy,
    nowIso: () => new Date().toISOString(),
    newId: () => randomUUID(),
    persistence: store,
  })
  return { view: makeLiveProjectRegistryView({ registry, owner: registryOwner }), registry }
})()
const projectRegistry = registryPair.view
const activeProjectSelection = projectRegistry.ensureDefault(registryOwner)
const activeProject = projectRegistry.snapshot().projects.find(
  (project) => project.id === activeProjectSelection.projectId,
)
if (!activeProject) {
  process.stderr.write('aisy run: active project is missing from the registry.\n')
  process.exit(1)
}
const activeWorkspaceRoot = activeProject.root
// The registry records a root; it does not create one. Every file tool and
// `bash` resolves against this directory, so a missing one turns every first
// action into ENOENT.
mkdirSync(activeWorkspaceRoot, { recursive: true, mode: 0o700 })
const staticWorkBinding: ResolvedWorkBinding = {
  ...(activeBot === null ? {} : { botId: activeBot.id }),
  operatorId: `telegram:${allowedChatId}`,
  profileId: 'default',
  projectId: activeProjectSelection.projectId,
  sessionId: activeProjectSelection.sessionId,
  scope: activeProject.isDefault ? 'workspace' : 'project',
}
const durableTurnState = executionSupervisorSession === null || durableDelegationRegistry === null
  ? null
  : (() => {
      const root = join(base, 'durable-turn')
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const continuation = makeNodeDurableParentContinuationStore({
        path: join(root, 'parent-continuation.json'),
      })
      let currentLease: ExecutionSupervisorLease | null = startupRecoveryLease
      let coordinator: DurableDelegationTurnCoordinatorV1 | null = null
      const activeRun = (ambiguity: Readonly<DurableParentAmbiguityV1>) => {
        if (currentLease === null || !currentLease.isHeld()) return null
        for (const record of durableDelegationRegistry.listExact(currentLease.bindingHash)) {
          if (record.phase !== 'active' || !record.plan.nodes.some(node =>
            node.taskId === ambiguity.taskId)) continue
          const journal = makeNodeDurableDelegationOperationJournalV2({
            runRoot: durableDelegationRegistry.runRoot(record),
          })
          if (journal.runRootHash === ambiguity.runRootHash) return { record, journal }
        }
        return null
      }
      const ports = makeDurableTurnActorProductionPortsV1({
        continuation,
        currentLease: () => currentLease,
        assertBudget(candidate, parent, ambiguity) {
          if (ambiguity === null) return parent.phase === 'active'
          const run = activeRun(ambiguity)
          const task = run?.record.plan.nodes.find(node => node.taskId === ambiguity.taskId)
          return task !== undefined && candidate.iterations === task.budgetSlice.iterations &&
            candidate.spendNanos === Math.round(task.budgetSlice.spendUsd * 1_000_000_000) &&
            candidate.inputTokens === 0 && candidate.outputTokens === 0 &&
            candidate.wallMs === 24 * 60 * 60 * 1000 &&
            candidate.ledgerRevision === (parent.phase === 'cancelling'
              ? parent.revision - 1
              : parent.revision)
        },
        assertResolutionApplied(authority, parent) {
          return parent.phase === 'active' &&
            parent.ambiguity?.operationHash === authority.operationHash
        },
        assertClaimReplaySafe(_authority, _parent, ambiguity) {
          if (ambiguity === null) return false
          const run = activeRun(ambiguity)
          if (run === null) return false
          const entry = run.journal.scan().entries.find(item =>
            item.key.logicalSlotHash === ambiguity.journalLogicalSlotHash &&
            item.key.attempt === ambiguity.attempt)
          return entry?.state === 'ambiguous'
        },
        assertCancellationQuiesced(authority, parent, ambiguity) {
          if (parent.phase !== 'cancelling' || ambiguity === null ||
            parent.cancellationReceiptHash !== authority.receiptHash) return false
          const run = activeRun(ambiguity)
          if (run === null) return false
          let release: (() => void) | null = null
          let proven = false
          try {
            release = makeNodeDelegationRunLock(
              durableDelegationRegistry.runRoot(run.record),
            ).acquire()
            const entry = run.journal.scan().entries.find(item =>
              item.key.logicalSlotHash === ambiguity.journalLogicalSlotHash &&
              item.key.attempt === ambiguity.attempt)
            proven = currentLease?.isHeld() === true && entry?.state === 'ambiguous'
          } catch {
            return false
          } finally {
            try { release?.() } catch { proven = false }
          }
          return proven
        },
      })
      let actorSequence = 0
      const actor = makeNodeDurableTurnActorController({
        path: join(root, 'turn-actor.sqlite3'),
        ...ports,
        nowMs: () => Date.now(),
        newActorId: () => `a${(++actorSequence).toString(36)}${randomBytes(8).toString('base64url')}`,
        newCardId: () => `c${(++actorSequence).toString(36)}${randomBytes(8).toString('base64url')}`,
        newNonce: () => randomBytes(12).toString('base64url'),
        newClaimId: () => `q${(++actorSequence).toString(36)}${randomBytes(8).toString('base64url')}`,
      })
      const makeCoordinator = (): DurableDelegationTurnCoordinatorV1 =>
        makeDurableDelegationTurnCoordinatorV1({
          continuation,
          actor,
          actorPorts: ports,
          budget(request, parent) {
            const ambiguity = parent.ambiguity
            if (ambiguity === undefined || ambiguity.operationHash !==
              durableParentAmbiguityOperationHash(request)) {
              throw new Error('DURABLE_TURN_BUDGET_BINDING_MISMATCH')
            }
            const run = activeRun(ambiguity)
            const task = run?.record.plan.nodes.find(node => node.taskId === request.taskId)
            if (task === undefined) throw new Error('DURABLE_TURN_BUDGET_UNAVAILABLE')
            return {
              iterations: task.budgetSlice.iterations,
              inputTokens: 0,
              outputTokens: 0,
              spendNanos: Math.round(task.budgetSlice.spendUsd * 1_000_000_000),
              wallMs: 24 * 60 * 60 * 1000,
              ledgerRevision: parent.revision,
            }
          },
          chatId: String(allowedChatId),
          nowMs: () => Date.now(),
          approvalTtlMs: 24 * 60 * 60 * 1000,
          quiescenceReceipt(request, parent) {
            const ambiguity = parent.ambiguity
            if (ambiguity === undefined || ambiguity.operationHash !==
              durableParentAmbiguityOperationHash(request)) {
              throw new Error('DURABLE_TURN_QUIESCENCE_BINDING_MISMATCH')
            }
            const run = activeRun(ambiguity)
            if (run === null) throw new Error('DURABLE_TURN_QUIESCENCE_UNAVAILABLE')
            let release: (() => void) | null = null
            try {
              release = makeNodeDelegationRunLock(
                durableDelegationRegistry.runRoot(run.record),
              ).acquire()
              if (currentLease?.isHeld() !== true) {
                throw new Error('DURABLE_TURN_QUIESCENCE_UNAVAILABLE')
              }
              const entry = run.journal.scan().entries.find(item =>
                item.key.logicalSlotHash === ambiguity.journalLogicalSlotHash &&
                item.key.attempt === ambiguity.attempt)
              if (entry?.state !== 'ambiguous') {
                throw new Error('DURABLE_TURN_QUIESCENCE_UNAVAILABLE')
              }
              return createHash('sha256')
                .update('aisy.durable-turn.cancellation-quiescence.v1\0')
                .update(JSON.stringify([
                  parent.continuationHash,
                  parent.identity.supervisorBindingHash,
                  ambiguity.operationHash,
                  ambiguity.runRootHash,
                  ambiguity.journalLogicalSlotHash,
                  ambiguity.attempt,
                ]))
                .digest('hex')
            } finally {
              release?.()
            }
          },
          retireCancelledRun(request, receiptHash) {
            const loaded = continuation.load()
            if (loaded.status !== 'ready' || loaded.record.phase !== 'terminal' ||
              loaded.record.cancellationReceiptHash !== receiptHash ||
              loaded.record.ambiguity?.operationHash !==
                durableParentAmbiguityOperationHash(request)) {
              throw new Error('DURABLE_TURN_CANCELLATION_RETIRE_MISMATCH')
            }
            const ambiguity = loaded.record.ambiguity
            const run = activeRun(ambiguity)
            if (run === null) {
              const remaining = durableDelegationRegistry.listExact(
                loaded.record.identity.supervisorBindingHash,
              )
              if (remaining.length !== 0) {
                throw new Error('DURABLE_TURN_CANCELLATION_RETIRE_MISMATCH')
              }
              return
            }
            durableDelegationRegistry.register({
              runRoot: durableDelegationRegistry.runRoot(run.record),
              bindingHash: run.record.bindingHash,
              binding: run.record.binding,
              plan: run.record.plan,
            }).retire()
          },
        })
      return {
        continuation,
        actor,
        ports,
        currentCoordinator: () => coordinator,
        ensureCoordinator: () => (coordinator ??= makeCoordinator()),
        capture(turn: TelegramExecutionTurnV1, lease: ExecutionSupervisorLease) {
          currentLease = lease
          const captured = continuation.capture({
            ownerId: randomUUID(),
            identity: {
              binding: staticWorkBinding,
              workBindingHash: durableParentContinuationWorkBindingHash(staticWorkBinding),
              sessionId: staticWorkBinding.sessionId,
              turnId: turn.turnId,
              turnTs: turn.turnTs,
              supervisorBindingHash: lease.bindingHash,
              policyRevision: 'durable-parent-continuation-v1',
              spans: turn.spans,
            },
          })
          if (captured.kind === 'busy' || captured.kind === 'terminal-replay') {
            throw new Error('DURABLE_PARENT_CONTINUATION_UNAVAILABLE')
          }
          coordinator = makeCoordinator()
          return coordinator
        },
        setLease(lease: ExecutionSupervisorLease | null) { currentLease = lease },
      }
    })()
// Switching context is an authenticated operation: the service issues a
// one-use receipt and consumes it. The secret must outlive a restart, or every
// receipt minted before it becomes unverifiable after one.
function durableSecret(path: string): Uint8Array {
  if (existsSync(path)) {
    const stored = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
    if (stored.byteLength >= 32) return new Uint8Array(stored)
  }
  const fresh = randomBytes(32)
  mkdirSync(base, { recursive: true, mode: 0o700 })
  writeFileSync(path, fresh.toString('base64') + '\n', { encoding: 'utf8', mode: 0o600 })
  return new Uint8Array(fresh)
}
const switchAuthoritySecret = durableSecret(join(base, 'switch-authority.key'))

// Archiving is a separate authority from switching, with its own secret: a
// receipt minted to move context must never be spendable to archive a project.
const lifecycleAuthoritySecret = durableSecret(join(base, 'project-lifecycle.key'))
const lifecycleRuntime = makeNodeProjectLifecycleAuthorityRuntime({
  secret: lifecycleAuthoritySecret,
  noncePath: join(base, 'project-lifecycle-nonces.json'),
  newReceiptId: () => randomUUID(),
  // Restoring points the operator back at a directory that has been out of use.
  // The registry proves ownership; this proves the directory is still a real
  // directory under the projects root, and not a symlink pointing elsewhere.
  validateRestorableRoot: (project) => {
    const resolved = realpathSync(project.root)
    if (!statSync(resolved).isDirectory()) throw new Error('ROOT_NOT_A_DIRECTORY')
    const allowed = realpathSync(registryPolicy.projectsRoot)
    if (resolved !== allowed && !resolved.startsWith(allowed + sep)) {
      throw new Error('ROOT_OUTSIDE_PROJECTS')
    }
  },
})

// Per-turn context lease (ADR-0060): every scoped subsystem — protected memory,
// transcript, project tools — takes its authority from this coordinator rather
// than from ambient process state. It belongs to the project service, because
// switching context closes the leases of the previous binding: a second, private
// coordinator here would leave the startup lease open and unreachable.
const projectRuntime = makeNodeProjectServiceRuntime({
  registry: registryPair.registry,
  authoritySecret: switchAuthoritySecret,
  noncePath: join(base, 'switch-authority-nonces.json'),
  newReceiptId: () => randomUUID(),
  newLeaseId: () => randomUUID(),
  lifecycle: lifecycleRuntime.lifecycle,
  // Каскад забывания (спека 24 §7, AC-24-10). Объявление поднято, а журнал
  // автономности создаётся ниже: к моменту первой архивации он уже есть.
  emit: (event) => { forgetAutonomyOn(event) },
})
const contextLeases = projectRuntime.leases
const newSessionRunner = makeNewSessionRunner({
  runtime: projectRuntime,
  owner: registryOwner,
  newRequestId: () => randomUUID(),
})
const resumeSessionRunner = makeResumeSessionRunner({
  runtime: projectRuntime,
  owner: registryOwner,
  newRequestId: () => randomUUID(),
})
const sessionLease = contextLeases.acquire({
  operatorId: staticWorkBinding.operatorId,
  profileId: staticWorkBinding.profileId,
  projectId: staticWorkBinding.projectId,
  projectKind: staticWorkBinding.scope === 'workspace' ? 'workspace' : 'project',
  sessionId: staticWorkBinding.sessionId,
  root: activeWorkspaceRoot,
  generation: 1,
})

const backgroundBindingStore = makeNodeBackgroundBindingStore({
  path: join(base, 'background-bindings.json'),
})
const workspaceProject = projectRegistry.snapshot().projects.find((project) => project.isDefault)
if (!workspaceProject) {
  process.stderr.write('aisy run: Workspace project is missing from the registry.\n')
  process.exit(1)
  throw new Error('WORKSPACE_PROJECT_MISSING')
}
const nightlyWorkspaceProject = workspaceProject
let nightlyBindingState = backgroundBindingStore.load('nightly')
if (nightlyBindingState.status === 'missing') {
  const nightlySession = projectRegistry.createSession(nightlyWorkspaceProject.id, 'Aisy system (nightly)')
  backgroundBindingStore.save('nightly', {
    operatorId: `telegram:${allowedChatId}`,
    profileId: 'default',
    projectId: nightlyWorkspaceProject.id,
    sessionId: nightlySession.id,
    scope: 'workspace',
  })
  nightlyBindingState = backgroundBindingStore.load('nightly')
}
const resolveNightlyBinding = (): ResolvedWorkBinding | null =>
  nightlyBindingState.status === 'ready' ? nightlyBindingState.binding : null

const TOOLS: AnthropicTool[] = liveProviderTools()
const TOOL_MINIMUM_TIERS = runtimeToolMinimumTiers()
const searchHtml = makePinnedHttpsTextGet({
  allowedHosts: ['html.duckduckgo.com'],
  timeoutMs: 15_000,
  maxResponseBytes: 2 * 1024 * 1024,
  userAgent: 'aisy-agent',
})

// A link the operator sends is not on any list written in advance, so this
// egress has no host allowlist — every other defence (https only, DNS pinned to
// the address dialled, private ranges refused, bounded body, deadline, redirect
// hops re-checked) stays. `fetch_url` is tier 2: the first page on a domain
// stops at an approval card, and the grant then covers that whole domain.
const fetchPage = makeOpenPageFetch({
  timeoutMs: 15_000,
  maxResponseBytes: 2 * 1024 * 1024,
  userAgent: 'aisy-agent',
})
const FETCH_FAILURE: Record<string, string> = {
  EGRESS_URL_DENIED: 'нужен обычный https-адрес — без порта, логина и голого IP',
  EGRESS_ADDRESS_DENIED: 'адрес ведёт во внутреннюю сеть',
  EGRESS_DNS_FAILED: 'домен не разрешается',
  EGRESS_TIMEOUT: 'страница не ответила вовремя',
  EGRESS_RESPONSE_TOO_LARGE: 'страница слишком большая',
  EGRESS_RESPONSE_DENIED: 'сервер вернул не текстовую страницу',
  EGRESS_RESPONSE_INVALID: 'страница не читается как текст',
  EGRESS_TRANSPORT_FAILED: 'не удалось соединиться',
}
// The services the key catalogue already offers. They live behind the same
// pinned gauntlet as everything else — the only additions are a method, a
// credential header and a body, which is exactly what an API needs and what
// the text getter could never carry.
const serviceJson = makePinnedHttpsJson({
  allowedHosts: SERVICE_HOSTS,
  timeoutMs: 60_000,
  maxResponseBytes: 4 * 1024 * 1024,
  userAgent: 'aisy-agent',
})
const serviceKey = (envKey: string): string | undefined => {
  const value = cfg(envKey)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
const readLink = makeLinkReader({
  json: serviceJson,
  key: serviceKey,
  direct: async (url) => {
    const page = await fetchPage(url)
    return { url: page.url, text: page.text }
  },
})
const searchThroughService = makeServiceSearch({ json: serviceJson, key: serviceKey })

const fetchUrlPort = async (url: string): Promise<string> => {
  try {
    return await readLink(url)
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    return `fetch_url: ${FETCH_FAILURE[code] ?? 'страницу открыть не удалось'}`
  }
}

const webSearchPort = async (query: string): Promise<string> => {
  try {
    // Serper when the operator connected it, the free DuckDuckGo parser
    // otherwise. Same tool, same output shape — only the quality differs.
    const viaService = await searchThroughService(query)
    const results = viaService ?? parseDuckDuckGo(await searchHtml(pinnedWebSearchUrl(query)))
    if (results.length === 0) return 'web_search: ничего не найдено.'
    return results.map((r) => `${r.title}\n${r.url}\n${r.snippet}`).join('\n\n')
  } catch (err) {
    return `web_search: ${err instanceof Error ? err.message : String(err)}`
  }
}

const fsPort: FsPort = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c, 'utf8'),
  listDir: (p) => readdirSync(p),
  exists: (p) => existsSync(p),
}

const grantPersistence = makeNodeApprovalGrantPersistence({ path: grantsPath })

const nowIso = (): string => new Date().toISOString()

const journalPath = join(base, 'journal.jsonl')
const journal = makeJsonlJournal({
  appendLine: (line) => appendFileSync(journalPath, line + '\n', { encoding: 'utf8', mode: 0o600 }),
  nowIso,
})

const resolveLiveMonitoringBinding = (binding: ResolvedWorkBinding): void => {
  if (binding.operatorId !== staticWorkBinding.operatorId ||
    binding.profileId !== staticWorkBinding.profileId ||
    binding.projectId !== staticWorkBinding.projectId ||
    binding.sessionId !== staticWorkBinding.sessionId ||
    binding.scope !== staticWorkBinding.scope) {
    throw new Error('MONITORING_CONTEXT_UNAVAILABLE')
  }
  const state = projectRegistry.snapshot()
  const project = state.projects.find((item) => item.id === binding.projectId)
  const session = state.sessions.find((item) => item.id === binding.sessionId)
  if (!project || project.archivedAt !== undefined || project.operatorId !== binding.operatorId ||
    project.profileId !== binding.profileId || !session || session.projectId !== project.id ||
    session.status !== 'active') {
    throw new Error('MONITORING_CONTEXT_UNAVAILABLE')
  }
}
// Protected scoped memory (ADR-0063). Built at startup so the harness starts in
// its target shape rather than growing into it; the embedding descriptor is
// operator-owned because changing it invalidates the semantic index.
const protectedMemoryRoot = botRoots.protectedMemory
// Operator-owned: changing any field invalidates the semantic index, so it is
// configuration rather than a derived default.
const protectedMemoryMode = parseProtectedMemoryPreviewMode(
  cfg('AISY_PROTECTED_MEMORY') ?? 'preview',
)
let embeddingDescriptor: ReturnType<typeof parseProtectedMemorySemanticConfig> = Object.freeze({
  provider: 'none',
})
if (protectedMemoryMode === 'preview') {
  const embeddingConfig = {
    provider: cfg('AISY_EMBEDDING_PROVIDER'),
    modelId: cfg('AISY_EMBEDDING_MODEL'),
    modelRevision: cfg('AISY_EMBEDDING_REVISION'),
    dimensions: cfg('AISY_EMBEDDING_DIMENSIONS'),
  }
  try {
    embeddingDescriptor = parseProtectedMemorySemanticConfig(
      embeddingConfig.provider === undefined || embeddingConfig.provider === 'none'
        ? { provider: 'none' }
        : {
            provider: embeddingConfig.provider,
            modelId: embeddingConfig.modelId,
            modelRevision: embeddingConfig.modelRevision,
            dimensions: Number(embeddingConfig.dimensions),
            normalizationVersion: 'nfkc-v1',
            chunkerVersion: 'fact-v1',
          },
    )
  } catch (error) {
    if (error instanceof ProtectedMemoryRuntimeError &&
      error.code === 'INVALID_SEMANTIC_DESCRIPTOR') {
      process.stderr.write('aisy: некорректная конфигурация семантической памяти.\n')
      process.exit(1)
    }
    throw error
  }
}
const protectedMemory = makeNodeProtectedMemoryScopeRuntime({
  mode: protectedMemoryMode,
  paths: {
    ledger: join(protectedMemoryRoot, 'db', 'ledger.sqlite'),
    keyword: join(protectedMemoryRoot, 'db', 'keyword.sqlite'),
    semantic: join(protectedMemoryRoot, 'db', 'semantic.sqlite'),
    barrier: join(protectedMemoryRoot, 'db', 'barrier.sqlite'),
    contentRoot: join(protectedMemoryRoot, 'content'),
    stagingRoot: join(protectedMemoryRoot, 'staging'),
  },
  operatorId: staticWorkBinding.operatorId,
  profileId: staticWorkBinding.profileId,
  scope: { kind: 'global', scopeId: 'global' },
  leases: contextLeases,
  descriptor: embeddingDescriptor,
  nowIso: () => new Date().toISOString(),
  newFactId: () => randomUUID(),
  // Audit delivery is code-owned and idempotent; the journal is the sink.
  deliverPublicationAuditOnce: async () => undefined,
  deliverDeletionAuditOnce: async () => undefined,
  deliverUpdateAuditOnce: async () => undefined,
})

// Live memory is the protected scoped ledger (ADR-0074). No legacy store is
// built here: a fallback would be exactly the second source of truth where a
// forget in one half does not apply to the other.
// Project-scoped memory is built lazily, one runtime per project, so a
// Workspace-only session never opens project databases it will not read.
const projectMemoryRuntimes = new Map<string, ReturnType<typeof makeNodeProtectedMemoryScopeRuntime>>()
const projectMemoryRuntime = (
  projectId: string,
): ReturnType<typeof makeNodeProtectedMemoryScopeRuntime> => {
  if (protectedMemory.mode === 'off') return { mode: 'off' }
  const cached = projectMemoryRuntimes.get(projectId)
  if (cached !== undefined) return cached
  // The directory name is derived, never the raw id: a project id is data, and
  // data does not get to choose a path.
  const directory = createHash('sha256').update(projectId).digest('hex').slice(0, 32)
  const projectRoot = join(protectedMemoryRoot, 'projects', directory)
  const runtime = makeNodeProtectedMemoryScopeRuntime({
    mode: 'preview',
    paths: {
      ledger: join(projectRoot, 'db', 'ledger.sqlite'),
      keyword: join(projectRoot, 'db', 'keyword.sqlite'),
      semantic: join(projectRoot, 'db', 'semantic.sqlite'),
      barrier: join(projectRoot, 'db', 'barrier.sqlite'),
      contentRoot: join(projectRoot, 'content'),
      stagingRoot: join(projectRoot, 'staging'),
    },
    operatorId: staticWorkBinding.operatorId,
    profileId: staticWorkBinding.profileId,
    scope: { kind: 'project', scopeId: `project:${projectId}`, projectId },
    leases: contextLeases,
    descriptor: embeddingDescriptor,
    nowIso: () => new Date().toISOString(),
    newFactId: () => randomUUID(),
    deliverPublicationAuditOnce: async () => undefined,
    deliverDeletionAuditOnce: async () => undefined,
    deliverUpdateAuditOnce: async () => undefined,
  })
  projectMemoryRuntimes.set(projectId, runtime)
  return runtime
}

const scopedMemoryRouter = makeNodeProtectedMemoryPreviewRouter({
  leases: contextLeases,
  globalRuntime: protectedMemory,
  projectRuntime: (projectId: string) => projectMemoryRuntime(projectId),
  newFactId: () => randomUUID(),
  provenanceFor: ({ lease, scope }: { lease: TurnContextLease; scope: { scopeId: string } }) =>
    `session:${lease.sessionId}:${scope.scopeId}`,
  // Human-confirmed deletion is an operator decision; until the approval card is
  // wired, code refuses rather than granting it silently.
  authorizeHumanConfirmedDelete: async () => false,
  emit: (event: unknown) => { void journal.append('memory', 'scoped', event) },
})
const scopedMemory = makeScopedMemoryLiveView({
  router: scopedMemoryRouter,
  ledger: protectedMemory.mode === 'preview' ? protectedMemory.store : null,
})
const memoryLeases = makeMemoryLeaseSource({
  leases: contextLeases,
  operatorId: staticWorkBinding.operatorId,
  profileId: staticWorkBinding.profileId,
  workspace: { projectId: staticWorkBinding.projectId, root: activeWorkspaceRoot },
  rootFor: (binding: { projectId: string }) => projectRegistry.snapshot().projects
    .find((project) => project.id === binding.projectId)?.root ?? null,
})
// Knowledge zone (ADR-0075/0080): only the catalogue enters context, never
// bodies. The zone follows the scope of the session — a project session works
// with the project's knowledge, exactly as it does with the project's memory.
const knowledgeZone = makeKnowledgeZone({
  root: staticWorkBinding.scope === 'project'
    ? join(activeWorkspaceRoot, 'knowledge')
    : botRoots.knowledge,
})
// Daily journal (ADR-0079): the course of the day next to, not inside, memory.
const dailyJournal = makeDailyJournal({ root: memoryRoot, nowIso })
// Task tracker (ADR-0081): "надо не забыть" that outlives the conversation.
const taskTracker = makeTaskTracker({
  path: join(base, 'tasks.json'),
  nowIso,
  onQuarantine: (detail) => journal.append('tasks', 'tasks.quarantined', { detail }),
})
// Per-turn memory self-check (ADR-0078): thresholds are code-owned, notices go
// to the operator through the journal, and nothing here can stop a turn.
const memorySelfCheck = makeMemorySelfCheckRuntime({
  operatorProfileBytes: () => {
    const path = join(memoryRoot, 'USER.md')
    return existsSync(path) ? statSync(path).size : 0
  },
  emit: (notice) => journal.append('memory', 'memory.self-check', notice),
  onConsolidate: (messages) =>
    dailyJournal.append(`сессия выросла до ${messages} сообщений`),
})
// Also the condition for greeting first: the brief is present exactly while
// Aisy has not met the operator yet.
const onboardingProgress = makeOnboardingProgress({
  path: join(base, 'onboarding-progress.json'),
})
// USER.md is one of the DNA files the frozen prefix reads, and the memory
// self-check reports it empty on every turn until something fills it.
const operatorProfile = makeOperatorProfileWriter({
  path: join(memoryRoot, 'USER.md'),
  onError: (detail) => journal.append('onboarding', 'onboarding.profile_write_failed', { detail }),
})
const onboardingBrief = makeOnboardingBrief({ missing: () => onboardingProgress.missing() })
const frozenPrefix = makeFrozenPrefixSource({
  memoryRoot,
  files: GLOBAL_DNA_PREFIX_FILES,
  projectionFile: 'MEMORY.md',
  onProjectionHealth: (health) => memorySelfCheck.observeProjection(health),
  sections: [
    () => {
      const catalogue = knowledgeZone.catalogue()
      return catalogue.entries.length === 0 ? null : catalogue.markdown
    },
    onboardingBrief,
  ],
})

// MEMORY.md is the deterministic projection of live facts and one of the DNA
// files the frozen prefix reads. Producing it belongs to the runtime that owns
// the ledger, so it is regenerated after every write instead of once a night.
const memoryProjectionPath = join(memoryRoot, 'MEMORY.md')
async function refreshMemoryProjection(): Promise<void> {
  try {
    const content = serializeFactIndex(await scopedMemory.listLive(sessionLease))
    if (existsSync(memoryProjectionPath) &&
      readFileSync(memoryProjectionPath, 'utf8') === content) return
    const temp = memoryProjectionPath + '.tmp'
    writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, memoryProjectionPath)
  } catch (error) {
    // A projection that cannot be written must not cost the operator their
    // turn; the fact is already durable in the ledger.
    journal.append('memory', 'memory.projection-failed', {
      detail: error instanceof Error ? error.message : 'unknown',
    })
  }
}

const memory: MemoryPort = {
  async snapshot() {
    const prefix = frozenPrefix.read()
    const bytes = Buffer.concat([Buffer.from(AGENT_PROTOCOL, 'utf8'), prefix.bytes])
    return {
      prefixBytes: bytes,
      prefixHash: createHash('sha256').update(bytes).digest('hex'),
      breakpoints: [],
      takenAt: nowIso(),
    }
  },
  async forget(factRef: string, humanConfirmed: boolean) {
    await memoryLeases.withMaintenanceLease(async (lease) =>
      scopedMemory.forget(lease, factRef, 'agent-loop forget', humanConfirmed))
    await refreshMemoryProjection()
  },
}

const sessionLogPath = join(base, 'session-log.jsonl')
const sessionLog: SessionLog = makeJsonlSessionLog({
  appendLine: (line) => appendFileSync(sessionLogPath, line + '\n', { encoding: 'utf8', mode: 0o600 }),
  readLines: () => {
    if (!existsSync(sessionLogPath)) return []
    try {
      return readFileSync(sessionLogPath, 'utf8').split('\n').filter((l) => l.trim().length > 0)
    } catch {
      return []
    }
  },
})

const grants = makeGrantStore({
  persistence: grantPersistence,
  policyRevision: 'similar-grant-v1',
  isBindingUsable: (binding: GrantBinding) => {
    const state = projectRegistry.snapshot()
    const project = state.projects.find((item) => item.id === binding.projectId)
    if (!project || project.archivedAt !== undefined ||
      project.operatorId !== binding.operatorId || project.profileId !== binding.profileId) return false
    if (binding.scope !== 'session') return true
    return state.sessions.some((item) => item.id === binding.sessionId &&
      item.projectId === binding.projectId && item.status === 'active')
  },
})

// --- Обучаемая автономность (спека 24, ADR-0061/0099) ---
//
// До этого среза компонент был написан и покрыт тестами, но не создавался
// нигде: агент спрашивал разрешение на одно и то же снова и снова. Здесь он
// собирается целиком — журнал демонстраций, реестр выученных грантов и порт,
// который читает HookGate.
//
// Ни одно из этого не расширяет полномочия само по себе: грант появляется
// только после карточки со вторым фактором, а порт отвечает «да» лишь на точный
// процесс в точном проекте.
const autonomyLedger = makeAutonomyLedger({
  persistence: makeNodeAutonomyEvidenceStore({ path: join(base, 'autonomy', 'evidence.jsonl') }),
  nowIso: () => new Date().toISOString(),
  emit: (event, payload) => { void journal.append('autonomy', event, payload) },
})
const learnedGrants = makeLearnedGrantRegistry({
  persistence: makeNodeLearnedGrantStore({ path: join(base, 'autonomy', 'grants.json') }),
  nowIso: () => new Date().toISOString(),
})

/**
 * Проект или сессия ушли в архив — их доказательства и выученные разрешения
 * уходят следом (спека 24 §7, AC-24-10).
 *
 * Каскад был написан и покрыт тестами, но композиция его не звала: разрешение
 * переживало проект, ради которого набиралось, и продолжало действовать по
 * доказательствам, которых уже нет. Порядок внутри нормативный — сначала отзыв
 * гранта, потом чистка записей.
 */
function forgetAutonomyOn(event: ProjectServiceEvent): void {
  const selector: { projectId?: string; sessionId?: string } | null =
    event.kind === 'project.archived'
      ? { projectId: event.projectId }
      : event.kind === 'session.archived' && event.sessionId !== undefined
        ? { sessionId: event.sessionId }
        : null
  if (selector === null) return
  try {
    forgetLearnedAutonomy({
      selector,
      grants: learnedGrants,
      evidence: autonomyLedger,
      emit: (name, payload) => { void journal.append('autonomy', name, payload) },
    })
  } catch { /* архивация проекта не падает из-за журнала автономности */ }
}

/** Ключ процесса для одного вызова, или null — вызов не входит ни в один. */
const autonomyKeyFor = (call: { name: string; args: Record<string, unknown> }): string | null => {
  const step = autonomyWorkflowStep({ tool: call.name, args: call.args })
  return step === null ? null : workflowKey([step])
}
const autonomyResourceFor = (
  call: { name: string; args: Record<string, unknown> },
): string | null => autonomyWorkflowStep({ tool: call.name, args: call.args })?.resourceMask ?? null

/**
 * Демонстрации, накопленные за текущий ход.
 *
 * В журнал они попадают только после того, как ход завершился (AC-24-1):
 * подтверждение, после которого агент упал, ничего не доказывает. Буфер живёт
 * в композиции, а не в ядре, потому что «ход завершился» знает тот, кто его
 * запускал.
 */
const pendingDemonstrations: Array<{
  workflowKey: string
  tool: string
  resourcePattern: string
  tier: 1 | 2
  outcome: 'confirmed' | 'rejected'
  title: string
}> = []

/**
 * Рабочий процесс словами — то, что оператор прочитает на карточке автономии и
 * на экране разрешений.
 *
 * Ключ процесса состоит из хэшей и человеку ничего не говорит, поэтому подпись
 * запоминается отдельно, в момент наблюдения: к тому дню, когда процесс дозреет
 * до предложения, вызов может уже не повториться.
 */
const autonomyTitlesPath = join(base, 'autonomy', 'titles.json')
const autonomyTitles = new Map<string, string>(
  ((): Array<[string, string]> => {
    try {
      const raw: unknown = JSON.parse(readFileSync(autonomyTitlesPath, 'utf8'))
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
      return Object.entries(raw as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    } catch {
      return []
    }
  })(),
)
const rememberAutonomyTitle = (key: string, title: string): void => {
  if (autonomyTitles.get(key) === title) return
  autonomyTitles.set(key, title)
  try {
    mkdirSync(dirname(autonomyTitlesPath), { recursive: true, mode: 0o700 })
    writeFileSync(autonomyTitlesPath, `${JSON.stringify(Object.fromEntries(autonomyTitles), null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 })
  } catch { /* подпись — удобство, её потеря не ломает автономию */ }
}

/** Человеческая подпись вызова: глагол и ресурс, без аргументов-значений. */
const autonomyTitleFor = (call: { name: string; args: Record<string, unknown> }): string => {
  const verb = TOOL_LABEL[call.name]?.now ?? call.name
  const args = call.args
  if (call.name === 'write_file' || call.name === 'write_knowledge' || call.name === 'read_file') {
    return typeof args['path'] === 'string' ? `${verb} ${args['path']}` : verb
  }
  if (call.name === 'remember') {
    return typeof args['topic'] === 'string' ? `${verb} про ${args['topic']}` : verb
  }
  if (call.name === 'fetch_url') {
    try {
      return `${verb} ${new URL(String(args['url'])).hostname}`
    } catch {
      return verb
    }
  }
  if (call.name === 'bash') {
    const cmd = typeof args['cmd'] === 'string' ? args['cmd'].trim().split(/\s+/) : []
    const head = cmd.slice(0, 2).join(' ')
    return head.length === 0 ? verb : `${verb} ${head}`
  }
  return verb
}

const observeApprovalForAutonomy = (input: {
  call: { name: string; args: Record<string, unknown> }
  ctx: { provenance?: string; narrowed?: boolean }
  tier: 1 | 2
  outcome: 'confirmed' | 'rejected'
}): void => {
  // Доказательства собираются о работе оператора. Ход, суженный из-за чужого
  // контента, и спан из письма или страницы демонстрацией не являются.
  if (input.ctx.provenance !== 'operator' || input.ctx.narrowed === true) return
  const step = autonomyWorkflowStep({ tool: input.call.name, args: input.call.args })
  if (step === null) return
  pendingDemonstrations.push({
    workflowKey: workflowKey([step]),
    tool: step.tool,
    resourcePattern: step.resourceMask,
    tier: input.tier,
    outcome: input.outcome,
    title: autonomyTitleFor(input.call),
  })
}

/** Сколько живёт выданная автономия. Продление — только новой карточкой. */
const LEARNED_GRANT_TTL_DAYS = 90

/**
 * Дозревший процесс предлагается оператору карточкой со вторым фактором.
 *
 * Расширение полномочий — операция того же класса, что деньги и постоянная
 * память (ADR-0029), поэтому обычного тапа мало. Отказ ничего не ломает: счёт
 * демонстраций остаётся, предложение вернётся после следующих подтверждений.
 */
const offerRipeAutonomy = async (): Promise<void> => {
  if (approveRef === null || learnedGrants.corrupted() || autonomyLedger.corrupted()) return
  const now = new Date()
  for (const candidate of autonomyLedger.ripeCandidates()) {
    if (candidate.scope.projectId !== staticWorkBinding.projectId) continue
    if (learnedGrants.active(candidate.workflowKey, now.toISOString()) !== null) continue
    const prior = learnedGrants.list().filter((g) => g.workflowKey === candidate.workflowKey)
    const envelope = {
      workflowKey: candidate.workflowKey,
      scope: candidate.scope,
      tier: candidate.tier,
      version: prior.reduce((max, g) => Math.max(max, g.version), 0) + 1,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + LEARNED_GRANT_TTL_DAYS * 86_400_000).toISOString(),
    }
    const identity = learnedGrantAction(envelope)
    const title = autonomyTitles.get(candidate.workflowKey) ?? candidate.scope.tool
    const summary = [
      `🎓 Перестать спрашивать: ${title}`,
      '',
      `Ты подтверждал это ${candidate.stats.confirmed} ` +
      `${plural(candidate.stats.confirmed, 'раз', 'раза', 'раз')} ` +
      `в ${candidate.stats.distinctSessions} разных разговорах, за ${candidate.stats.windowDays} ` +
      `${plural(candidate.stats.windowDays, 'день', 'дня', 'дней')}, ни разу не поправив.`,
      '',
      'Разрешу себе делать ровно это — тот же инструмент, тот же ресурс, этот же ' +
      `проект — на ${LEARNED_GRANT_TTL_DAYS} дней. Любая твоя правка снимет автономию сама.`,
    ].join('\n')
    let decision: ApprovalDecision
    try {
      decision = await approveRef(Object.freeze({
        actionId: identity.actionId,
        actionHash: identity.actionHash,
        tier: 3 as const,
        requiresStepUp: true,
        summary,
        canRememberSimilar: false,
      }))
    } catch {
      return
    }
    if (decision.decision !== 'confirmed') return
    const result = learnedGrants.promote({
      envelope,
      approvedBy: staticWorkBinding.operatorId,
      proof: decision.proof,
    })
    void journal.append('autonomy', 'autonomy.promotion', {
      workflowKey: candidate.workflowKey,
      granted: 'granted' in result,
      ...('refused' in result ? { refused: result.refused } : {}),
    })
    // По одному предложению за ход: очередь карточек посреди работы — это не
    // предложение, а допрос.
    return
  }
}

/** Ход дошёл до конца — только теперь подтверждения становятся доказательствами. */
const flushDemonstrations = (turnId: string, completed: boolean): void => {
  const collected = pendingDemonstrations.splice(0)
  if (!completed) return
  for (const entry of collected) {
    try {
      autonomyLedger.observe({
        workflowKey: entry.workflowKey,
        scope: {
          projectId: staticWorkBinding.projectId,
          tool: entry.tool,
          resourcePattern: entry.resourcePattern,
        },
        tier: entry.tier,
        binding: {
          operatorId: staticWorkBinding.operatorId,
          projectId: staticWorkBinding.projectId,
          sessionId: staticWorkBinding.sessionId,
        },
        evidence: { transcriptRef: turnId },
        outcome: entry.outcome,
        provenance: 'operator',
      })
      // Shadow-счёт: автономный путь предложил бы выполнить этот вызов, и
      // сверяется он с тем, что оператор действительно ответил.
      autonomyLedger.shadowResult({
        workflowKey: entry.workflowKey,
        projectId: staticWorkBinding.projectId,
        matched: entry.outcome === 'confirmed',
      })
      // Отказ — это правка: процесс, который оператор только что остановил,
      // теряет зрелость целиком, а не просто не прибавляет её. Порядок здесь
      // нормативен (спека 24 §7) — сначала отзыв гранта, потом демоушен, — и
      // держит его ядро: собранная вручную пара делала обратное.
      if (entry.outcome === 'rejected') {
        demoteLearnedAutonomy({
          workflowKey: entry.workflowKey,
          reason: 'operator-correction',
          grants: learnedGrants,
          evidence: autonomyLedger,
          emit: (event, payload) => { void journal.append('autonomy', event, payload) },
        })
      } else {
        rememberAutonomyTitle(entry.workflowKey, entry.title)
      }
    } catch { /* журнал автономности не может уронить ход */ }
  }
}

const learnedAutonomyPort = makeLearnedAutonomyPort({
  grants: learnedGrants,
  keyFor: autonomyKeyFor,
  resourceFor: autonomyResourceFor,
  // Проект берётся из durable binding хода, а не из аргументов вызова:
  // аргументы приходят от модели, привязка — от runtime.
  projectId: () => staticWorkBinding.projectId,
  nowIso: () => new Date().toISOString(),
})

const prefixCache = process.env['AISY_PREFIX_CACHE'] !== '0'

// AgentCard registries are resolved before provider construction so a selected
// main card constrains the schemas sent to every configured provider. The
// selection is opt-in until the operator approves the live-default cutover.
const cardResolver = makeCardResolver({
  dir: join(base, 'agents'),
  exists: (p) => existsSync(p),
  readDir: (d) => (existsSync(d) ? readdirSync(d) : []),
  readFile: (p) => readFileSync(p, 'utf8'),
})
const configuredMainCardName = cfg('AISY_MAIN_AGENT_CARD')?.trim() ?? ''
const agentCardRegistry = makeAgentCardRegistry({
  persistence: makeAgentCardRegistryStore({
    path: join(base, 'agent-cards', 'registry.json'),
  }),
})
const agentCardBinding = staticWorkBinding.scope === 'workspace'
  ? Object.freeze({ scope: 'workspace' as const })
  : Object.freeze({ scope: 'project' as const, projectId: staticWorkBinding.projectId })
// Explicit rollback gate: lifecycle management may be used while the legacy
// loader remains active. Only exact `1` makes published revisions authoritative.
const agentCardRegistryCutover = process.env['AISY_AGENT_CARD_REGISTRY'] === '1'
const sidecarsRoot = fileURLToPath(new URL('../../../sidecars-py/', import.meta.url))
const pythonExecutable = join(sidecarsRoot, '.venv', 'bin', 'python')
const confinementWorkerPath = join(sidecarsRoot, 'aisy_sidecars', 'confinement_worker.py')
const agentCardLegacyImport = (() => {
  if (!existsSync(pythonExecutable) || !existsSync(confinementWorkerPath) ||
    !existsSync(join(base, 'agents'))) return undefined
  try {
    return makeAgentCardLegacyImportPort({
      root: join(base, 'agents'),
      process: makeNodeConfinementProcessPort({
        pythonExecutable,
        workerPath: confinementWorkerPath,
      }),
      newId: () => randomUUID(),
    })
  } catch {
    // Import is optional. An unsafe/missing root hides the operation instead of
    // falling back to an unconfined path reader or preventing normal startup.
    return undefined
  }
})()
const activeSkillStore = makeNodeActiveSkillPersistence({ root: base })
// The catalog reads the manifest once, when it is built. A skill installed or
// switched off from the phone would otherwise reach the agent only after a
// restart, so the folder screen rebuilds it — a handful of files per change.
let skillCatalog = makeActiveSkillCatalog(activeSkillStore)
const reloadSkills = (): void => { skillCatalog = makeActiveSkillCatalog(activeSkillStore) }
const activeSkills: ActiveSkillCatalog = {
  menu: () => skillCatalog.menu(),
  names: () => skillCatalog.names(),
  matchTriggers: (request) => skillCatalog.matchTriggers(request),
  loadBody: (name) => skillCatalog.loadBody(name),
  touchedPaths: (name) => skillCatalog.touchedPaths(name),
}
const activeSkillNames = new Set(activeSkills.names())
const resolveRunnableCard = (name: string) => {
  const card = selectAgentCardForRun({
    name,
    registryCutover: agentCardRegistryCutover,
    binding: agentCardBinding,
    registry: agentCardRegistry,
    legacy: cardResolver,
    builtinNames: BUILTIN_CARDS.map((c) => c.name),
  })
  if (!card) return undefined
  try {
    resolveAgentCapabilityMatrix({
      card,
      toolCatalog: TOOLS,
      activeSkills: activeSkillNames,
      activeMcpServers,
      minimumToolTiers: TOOL_MINIMUM_TIERS,
    })
    return card
  } catch {
    return undefined
  }
}
const mcpPersistence = makeNodeMcpAllowlistPersistence({ root: base })
const configuredMcp = makeActiveMcpAllowlist(mcpPersistence)
const activeMcpServers = new Set<string>() // populated only by a live transport gauntlet after approval
const configuredMcpMenu = makeConfiguredMcpMenuSource({
  snapshot: configuredMcp.snapshot(),
  activeServerNames: () => activeMcpServers,
})
journal.append('mcp', 'mcp.allowlist_validated', {
  configuredServers: configuredMcp.names().length,
  transportActive: false,
})
// Adding a server is a two-step decision made from the phone: connect once to
// see what it is, then approve. The writer is the only path that records one,
// and the allowlist above re-validates every entry from scratch on the next
// start — approving here never shortens that.
const mcpWriter = makeNodeMcpAllowlistWriter({ root: base })
// MCP tokens live in the vault under their own variable name. Nothing about a
// token ever passes through the chat — the operator names it, not values it.
const resolveMcpToken = (envName: string): string | null => {
  try {
    const vault = JSON.parse(readFileSync(vaultPath, 'utf8')) as Record<string, unknown>
    const value = vault[envName]
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}
const mcpOnboarding = makeMcpServerOnboarding({
  runtime: makeMcpRuntime({
    allowlist: () => configuredMcp.snapshot(),
    emit: (event, payload) => { void journal.append('mcp', event, payload) },
  }),
  writer: mcpWriter,
  resolveToken: resolveMcpToken,
  taken: () => mcpWriter.entries().map(entry => entry.name),
  emit: (event, payload) => { void journal.append('mcp', event, payload) },
})

// Approved servers are connected once, here, before the provider exists. What
// survives the gauntlet becomes the model's MCP menu for this whole process;
// what does not is simply absent, and the screen says so rather than offering a
// button that would fail at call time.
const mcpCapability = await connectMcpCapability({
  allowlist: configuredMcp,
  runtime: makeMcpRuntime({
    allowlist: () => configuredMcp.snapshot(),
    emit: (event, payload) => { void journal.append('mcp', event, payload) },
  }),
  inputGuard: makeInputGuard(),
  resolveToken: resolveMcpToken,
  quarantine: (name, reason) => {
    // Durable: a server that failed the gauntlet stays refused across restarts
    // until the operator looks at it, instead of being retried silently.
    try { mcpPersistence.quarantine(name, reason) } catch { /* the journal still records it */ }
    void journal.append('mcp', 'mcp.quarantined', { server: name, reason })
  },
  emit: (event, payload) => { void journal.append('mcp', event, payload) },
  // Read per call, never captured: while an untrusted span is in context the
  // manager narrows outbound tools exactly as it does for native ones.
  hasUntrustedSpan: () => untrustedContext,
})
for (const name of mcpCapability?.servers ?? []) activeMcpServers.add(name)
journal.append('mcp', 'mcp.capability_ready', {
  servers: mcpCapability?.servers.length ?? 0,
  tools: mcpCapability?.capability.menu().length ?? 0,
})

const mainCapabilityRuntime = (() => {
  if (configuredMainCardName.length === 0) return null
  const card = selectAgentCardForRun({
    name: configuredMainCardName,
    registryCutover: agentCardRegistryCutover,
    binding: agentCardBinding,
    registry: agentCardRegistry,
    legacy: cardResolver,
    builtinNames: BUILTIN_CARDS.map((c) => c.name),
  })
  if (!card) {
    process.stderr.write('aisy run: configured main AgentCard is unavailable.\n')
    process.exit(1)
  }
  try {
    return makeMainAgentCapabilityRuntime({
      card,
      toolCatalog: TOOLS,
      activeSkills,
      activeSkillNames,
      activeMcpServers,
      minimumToolTiers: TOOL_MINIMUM_TIERS,
    })
  } catch {
    process.stderr.write('aisy run: configured main AgentCard failed capability validation.\n')
    process.exit(1)
  }
})()
const agentCardLifecycle = makeAgentCardLifecycleRuntime({
  registry: agentCardRegistry,
  configuredName: configuredMainCardName,
  cutoverActive: agentCardRegistryCutover,
  currentBinding: () => agentCardBinding,
  approvedBy: staticWorkBinding.operatorId,
  ...(agentCardLegacyImport === undefined ? {} : { legacy: agentCardLegacyImport }),
  emit: (event, payload) => { void journal.append('agent-card', event, payload) },
})
const agentCardCatalog = agentCardLifecycle.catalog()
journal.append('agent-card', 'agent_card.registry_ready', {
  cutoverActive: agentCardRegistryCutover,
  configured: configuredMainCardName.length > 0,
  activeRevision: [...agentCardCatalog.workspace, ...agentCardCatalog.project]
    .find((entry) => entry.name === configuredMainCardName)?.activeRevision ?? null,
})
const mainProviderTools = mainCapabilityRuntime?.matrix.tools ?? TOOLS
// `submit_plan` is a code-owned control tool, not a project capability. It is
// always visible to the interactive brain so switching /mode is immediate;
// outside Plan Mode the preflight returns PLAN_MODE_INACTIVE with zero I/O.
const interactiveProviderTools: AnthropicTool[] = [
  ...mainProviderTools,
  PLAN_SUBMIT_TOOL_DEFINITION,
  // One wrapper for every connected server. Published only when something is
  // actually on the other end: a tool that can only fail is worse than none.
  ...(mcpCapability === null ? [] : [CALL_MCP_TOOL_DEFINITION as AnthropicTool]),
]
const skillPromptRuntime = mainCapabilityRuntime?.skillPromptRuntime ?? makeSkillPromptRuntime(activeSkills)
// The frozen prefix carries both menus. The MCP half is the operator-approved
// summary line per tool — never a schema, an endpoint or a server's own prose.
const promptPrefixExtension = mcpCapability === null
  ? skillPromptRuntime.prefixExtension
  : (): Uint8Array => {
    const skills = skillPromptRuntime.prefixExtension()
    const mcp = mcpCapability.capability.prefixExtension()
    const combined = new Uint8Array(skills.length + mcp.length)
    combined.set(skills)
    combined.set(mcp, skills.length)
    return combined
  }
const configuredSkillMenu = makeConfiguredSkillMenuSource({
  entries: activeSkills.menu(),
  allowedSkillNames: mainCapabilityRuntime?.matrix.skills ?? null,
})

// The transcript is composed before the provider exists, and compaction needs
// one. A thunk keeps the order legal: until the provider is built the summariser
// refuses, and the context engine falls back to deterministic trimming.
let compactionProvider: ProviderAdapter | null = null
const summarizeTranscript = makeTranscriptCompactionSummarizer({
  provider: () => compactionProvider,
  emit: (event, payload) => { void journal.append('transcript', event, payload) },
})

// Session journal (ADR-0064/0068). The writer lease is already held by this
// process, so the recorder writes under proven single-writer ownership. The
// only lease-free path is the explicit AISY_SESSION_JOURNAL=0 rollback.
const sessionTranscriptRecorder = journalLease === null ? undefined : (() => {
  try {
    return makeNodeLeaseBoundSessionTranscriptRecorder({
      root: journalRoot,
      binding: {
        operatorId: staticWorkBinding.operatorId,
        profileId: staticWorkBinding.profileId,
        projectId: staticWorkBinding.projectId,
        sessionId: staticWorkBinding.sessionId,
      },
      lease: sessionLease,
      leases: contextLeases,
      budget: { windowTokens: 128_000, compactAtFraction: 0.8 },
      // Code-owned classifier: the model never decides what is load bearing.
      // Nothing is marked, deliberately. A load-bearing entry is kept verbatim
      // by every compaction tier, so a rule as broad as "everything the operator
      // typed" would build a view larger than the window instead of compacting
      // it. The summariser below is what preserves the content.
      classifyLoadBearing: () => ({ loadBearing: false, classifierVersion: 'rules-v1' }),
      summarize: summarizeTranscript,
      estimateTokens: (text: string) => Math.ceil(text.length / 4),
      writerLease: journalLease,
      emitEvent: (event, payload) => { void journal.append('transcript', event, payload) },
    })
  } catch {
    process.stderr.write('aisy run: журнал сессий не собран; запуск остановлен.\n')
    releaseJournalLease()
    process.exit(1)
  }
})()

// The local transcript composition is now complete. Only after that invariant
// is proven may recovery Telegram I/O, update fetch or provider construction
// begin for the full runtime.
if (startupRecoveryLease !== null && durableDelegationRegistry !== null &&
  durableDelegationRegistry.listExact(startupRecoveryLease.bindingHash).length !== 0) {
  const recoveryContext = makeExecutionSupervisorRecoveryContextV1(startupRecoveryLease)
  if (recoveryContext === null) {
    process.stderr.write('aisy run: durable delegation recovery authority unavailable\n')
    releaseJournalLease()
    process.exit(1)
  }
  const recovered = await makeDurableDelegationStartupRecoveryPortV1({
    registry: durableDelegationRegistry,
    resolveCard: resolveRunnableCard,
    skillTouchedPaths: name => activeSkills.touchedPaths(name),
    mcpWritable: () => false,
    isBindingActive: binding => binding.sessionId === staticWorkBinding.sessionId,
  }).recover(recoveryContext as never)
  if (recovered.kind === 'denied' || recovered.kind === 'none') {
    process.stderr.write('aisy run: durable delegation recovery unavailable\n')
    releaseJournalLease()
    process.exit(1)
  }
  startupDelegationRecoveryPending = true
}
if (replyCheckpointStore !== null && executionSupervisorSession !== null) {
  try {
    await recoverDurableTelegramReplyRelease({
      store: replyCheckpointStore,
      binding: staticWorkBinding,
      releaseReceipt: executionSupervisorSession.recoveryReleaseReceipt,
      consumeReleaseReceipt: receipt => executionSupervisorSession.consumeReleaseReceipt(receipt),
    })
  } catch {
    process.stderr.write('aisy run: durable reply recovery unavailable\n')
    releaseJournalLease()
    process.exit(1)
  }
}
await recoverExecutionCheckpointBeforeExternalIo()

// Subscription brains run the model's own loop, so their tool calls arrive over
// the MCP bridge instead of the agent loop. The executor that serves them is
// built further down (it needs grants, execution mode and the approval card), so
// the provider gets a late-bound reference rather than a second composition.
let invokeSubscriptionTool:
  | ((
    call: { name: string; args: Record<string, unknown> },
    signal: AbortSignal,
    context: ModelToolRuntimeContext,
  )
    => Promise<{ text: string; isError: boolean }>)
  | null = null
let codexSubscriptionRuntime: NodeCodexSubscriptionRuntime | null = null

function liveCodexSubscriptionRuntime(): NodeCodexSubscriptionRuntime {
  if (codexSubscriptionRuntime !== null) return codexSubscriptionRuntime
  const executable = resolveExecutable('codex')
  if (executable === null) throw new Error('CODEX_RUNTIME_UNAVAILABLE')
  codexSubscriptionRuntime = makeNodeCodexSubscriptionRuntime({
    codexExecutable: executable,
    codexHome: join(base, 'codex-subscription'),
    threadDbPath: join(base, 'codex-subscription-threads.sqlite'),
    environment: process.env,
    projectRoot: projectId => projectId === staticWorkBinding.projectId
      ? activeWorkspaceRoot
      : null,
  })
  return codexSubscriptionRuntime
}

function adapterFor(sel: ProviderSel, tools: AnthropicTool[] = interactiveProviderTools): ProviderAdapter {
  if (sel.provider === 'claude-subscription') {
    return makeClaudeSubscriptionProvider({
      tools,
      executable: resolveNodeToolPath('claude'),
      // The subscription token lives in the vault: without it here the CLI
      // would try to open a browser on a headless server.
      environment: claudeCodeEnvironment(process.env, cfg('CLAUDE_CODE_OAUTH_TOKEN')),
      ...(sel.model === '' || sel.model === 'default' ? {} : { model: sel.model }),
      invokeTool: async (call, signal, context) => invokeSubscriptionTool === null
        ? { text: 'TOOL_RUNTIME_UNAVAILABLE', isError: true }
        : invokeSubscriptionTool(call, signal, context),
    })
  }
  if (sel.provider === 'codex-subscription') {
    return liveCodexSubscriptionRuntime().provider({
      projectId: staticWorkBinding.projectId,
      tools,
      ...(sel.model === '' || sel.model === 'default' ? {} : { model: sel.model }),
      invokeTool: async (call, signal, context) => invokeSubscriptionTool === null
        ? { text: 'TOOL_RUNTIME_UNAVAILABLE', isError: true }
        : invokeSubscriptionTool(call, signal, context),
    })
  }
  const providerEntry = findProvider(sel.provider)
  if (providerEntry === undefined) {
    throw new Error(NATIVE_API_SECRET_PROXY_REQUIRED)
  }
  if (providerEntry.kind !== 'cli') {
    const providerId = asBrokerNativeProviderId(sel.provider)
    if (providerId === null || providerBrokerReady === null ||
      !providerBrokerReady.providers.includes(providerId)) {
      throw new Error(NATIVE_API_SECRET_PROXY_REQUIRED)
    }
    return buildProvider({
      provider: sel.provider,
      model: sel.model,
      tools,
      prefixCache,
      fetchImpl: makeProviderBrokerFetch({ providerId }),
    })
  }
  return buildProvider({
    provider: sel.provider,
    model: sel.model,
    tools,
    prefixCache,
  })
}
const primaryAdapter: ProviderAdapter = providersCfg.tiers
  ? makeTieredProvider({
      reasoning: adapterFor(providersCfg.tiers.reasoning),
      critique: adapterFor(providersCfg.tiers.critique),
      routine: adapterFor(providersCfg.tiers.routine),
    })
  : adapterFor(defaultSel)
const provider: ProviderAdapter = providersCfg.fallback
  ? makeFailoverProvider(primaryAdapter, adapterFor(providersCfg.fallback))
  : primaryAdapter
// Compaction runs on the routine tier when one is configured — it is a rewrite,
// not a decision — and with no tools at all: the summariser reads a transcript
// and writes prose, so anything it could call would be a bug, not a feature.
compactionProvider = adapterFor(providersCfg.tiers?.routine ?? defaultSel, [])
// The 'mixed (per-tier)' sentinel is matched by event-bridge.ts renderEvent
// (cost.summary) to show the tiered note instead of a fake model name (#15).
// Keep the two literals in sync; the event-bridge spec asserts on this exact value.
const modelLabel = providersCfg.tiers ? 'mixed (per-tier)' : defaultSel.model

const monitoringEnabled = cfg('AISY_MONITORING') !== '0'
const boundedMonitoringInteger = (name: string, fallback: number, maximum: number): number => {
  const parsed = Number(cfg(name))
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback
}
const boundedMonitoringNumber = (name: string, fallback: number, maximum: number): number => {
  const parsed = Number(cfg(name))
  return Number.isFinite(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback
}
const digestAtCandidate = cfg('AISY_MONITORING_DIGEST_AT') ?? DEFAULT_MONITORING_LIVE_CONFIG.digestAt
const monitoringLiveConfig: MonitoringLiveConfig = {
  digestAt: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(digestAtCandidate)
    ? digestAtCandidate
    : DEFAULT_MONITORING_LIVE_CONFIG.digestAt,
  maxSources: boundedMonitoringInteger(
    'AISY_MONITORING_MAX_SOURCES_PER_TICK', DEFAULT_MONITORING_LIVE_CONFIG.maxSources, 100,
  ),
  maxCollectedItems: boundedMonitoringInteger(
    'AISY_MONITORING_MAX_ITEMS_PER_TICK', DEFAULT_MONITORING_LIVE_CONFIG.maxCollectedItems, 1_000,
  ),
  maxScoringCalls: boundedMonitoringInteger(
    'AISY_MONITORING_MAX_SCORING_PER_TICK', DEFAULT_MONITORING_LIVE_CONFIG.maxScoringCalls, 100,
  ),
  maxDeliveryDigests: boundedMonitoringInteger(
    'AISY_MONITORING_MAX_DELIVERY_PER_TICK', DEFAULT_MONITORING_LIVE_CONFIG.maxDeliveryDigests, 100,
  ),
  windowHours: boundedMonitoringInteger(
    'AISY_MONITORING_WINDOW_HOURS', DEFAULT_MONITORING_LIVE_CONFIG.windowHours, 24 * 30,
  ),
  digestTtlHours: boundedMonitoringInteger(
    'AISY_MONITORING_DIGEST_TTL_HOURS', DEFAULT_MONITORING_LIVE_CONFIG.digestTtlHours, 24 * 30,
  ),
  maxDigestItems: boundedMonitoringInteger(
    'AISY_MONITORING_DIGEST_MAX_ITEMS', DEFAULT_MONITORING_LIVE_CONFIG.maxDigestItems, 100,
  ),
  maxPerSource: boundedMonitoringInteger(
    'AISY_MONITORING_DIGEST_MAX_PER_SOURCE', DEFAULT_MONITORING_LIVE_CONFIG.maxPerSource, 100,
  ),
  maxPerAuthor: boundedMonitoringInteger(
    'AISY_MONITORING_DIGEST_MAX_PER_AUTHOR', DEFAULT_MONITORING_LIVE_CONFIG.maxPerAuthor, 100,
  ),
  halfLifeHours: boundedMonitoringNumber(
    'AISY_MONITORING_HALF_LIFE_HOURS', DEFAULT_MONITORING_LIVE_CONFIG.halfLifeHours, 24 * 30,
  ),
}
const monitoringRuntime = (() => {
  if (!monitoringEnabled) return null
  try {
    return makeNodeMonitoringRuntime({
      dbPath: join(base, 'monitoring.db'),
      resolveBinding: resolveLiveMonitoringBinding,
      // Scoring has its own no-tools adapter. Untrusted source content cannot
      // cause a tool call even when the interactive brain normally has tools.
      scorer: makeProviderMonitoringScorer({
        provider: adapterFor(providersCfg.tiers?.routine ?? defaultSel, []),
      }),
      // Operator-wide criteria live in one file next to the rest of the state
      // (ADR-0084); a per-source line narrows them, never replaces them.
      globalCriteria: () => {
        const path = join(base, 'monitoring-criteria.md')
        if (!existsSync(path)) return null
        try { return readFileSync(path, 'utf8').slice(0, 4096) } catch { return null }
      },
      nowIso,
      emit: (event) => {
        journal.append('monitoring', event.kind, {
          projectId: event.projectId,
          sessionId: event.sessionId,
          scope: event.scope,
          ...(event.sourceId === undefined ? {} : { sourceId: event.sourceId }),
          ...(event.digestId === undefined ? {} : { digestId: event.digestId }),
          ...(event.counts === undefined ? {} : { counts: event.counts }),
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        })
      },
    })
  } catch {
    try {
      journal.append('monitoring', 'monitor.runtime_unavailable', {
        collectionActive: false,
        deliveryActive: false,
      })
    } catch { /* optional monitoring failure must not disable the base agent */ }
    return null
  }
})()
const monitoringWindows = (() => {
  if (monitoringRuntime === null) return null
  try {
    return makeNodeMonitoringWindowStore({ path: join(base, 'monitoring-windows.json') })
  } catch {
    try { journal.append('monitoring', 'monitor.window_state_unavailable', {}) } catch { /* optional */ }
    return null
  }
})()
const monitoringTelegramSendLedger = (() => {
  if (monitoringRuntime === null) return null
  try {
    return makeNodeMonitoringTelegramSendLedger({
      path: join(base, 'monitoring-telegram-delivery.json'),
    })
  } catch {
    try { journal.append('monitoring', 'monitor.delivery_state_unavailable', {}) } catch { /* optional */ }
    return null
  }
})()
const monitoringLiveActive = monitoringRuntime !== null && monitoringWindows !== null &&
  monitoringTelegramSendLedger !== null
const monitoringStatus = makeMonitoringStatusSource({
  ...(monitoringRuntime === null ? {} : { store: monitoringRuntime.store }),
  binding: staticWorkBinding,
  resolveBinding: resolveLiveMonitoringBinding,
  collectionActive: monitoringLiveActive,
  deliveryActive: monitoringLiveActive,
})
const monitoringControls = monitoringRuntime === null || !monitoringLiveActive
  ? undefined
  : makeTelegramMonitoringControls({
      engine: monitoringRuntime.engine,
      store: monitoringRuntime.store,
      binding: staticWorkBinding,
      resolveBinding: resolveLiveMonitoringBinding,
    })

// Native extension hooks (ADR-0077). Loaded once at startup, in name order;
// a broken hook is reported and skipped rather than taking the runtime down.
const hooksRoot = cfg('AISY_HOOKS_ROOT') ?? join(base, 'hooks')
const extensionHooks = await (async () => {
  let files: string[] = []
  try {
    files = readdirSync(hooksRoot)
      .filter((name) => name.endsWith('.mjs'))
      .sort()
      .map((name) => join(hooksRoot, name))
  } catch {
    return { tools: [], providers: [], failed: [], disabled: false }
  }
  const loaded = await loadExtensionHooks({
    files,
    importModule: (file) => import(pathToFileURL(file).href) as Promise<ExtensionHookModule>,
  })
  for (const failure of loaded.failed) {
    process.stderr.write(`aisy run: хук пропущен (${failure.reason}).\n`)
  }
  return loaded
})()


/**
 * Turn augmentation: Skills first, then hook context providers bound to
 * `pre-prompt`. Hook fragments enter this turn only and stay `untrusted`, so a
 * provider cannot smuggle privileged text into the stable prefix.
 */
const augmentTurnWithHooks = async (
  input: Parameters<NonNullable<Parameters<typeof makeAgentRunner>[0]['augmentTurn']>>[0],
): Promise<Awaited<ReturnType<NonNullable<Parameters<typeof makeAgentRunner>[0]['augmentTurn']>>>> => {
  const skillSpans = await skillPromptRuntime.augmentTurn(input)
  // Today's journal is pulled per turn, never frozen into the prefix: the file
  // changes during the day and a stable prefix must not (ADR-0079).
  const today = dailyJournal.today()
  const tasks = taskTracker.contextBlock()
  // Both spans are harness-owned state, not external content: the journal is
  // written by the runtime alone (ADR-0079) and tasks come from the operator's
  // own `track_task` calls. Marking them `untrusted` narrowed every turn once a
  // single task existed, which held back every reply behind an approval card.
  // ponytail: task text is model-authored, so a laundered injection could ride
  // in; a dedicated third provenance tier is the upgrade path.
  const journalSpans = [
    ...(today === null
      ? []
      : [{
          role: 'user' as const,
          provenance: 'operator' as const,
          text: `[AISY_DAILY_JOURNAL]\n${today}`,
        }]),
    // Open tasks change during the conversation, so they are pulled per turn
    // rather than frozen into the prefix (ADR-0081).
    ...(tasks === null
      ? []
      : [{
          role: 'user' as const,
          provenance: 'operator' as const,
          text: `[AISY_OPEN_TASKS]\n${tasks}`,
        }]),
  ]
  if (extensionHooks.providers.length === 0) return [...skillSpans, ...journalSpans]
  const query = input.spans
    .map((span) => (typeof span.text === 'string' ? span.text : ''))
    .join(' ')
    .slice(0, 2048)
  const fragments = await collectHookContext({
    providers: extensionHooks.providers,
    at: 'pre-prompt',
    query,
  })
  return [
    ...skillSpans,
    ...journalSpans,
    ...fragments.map((fragment) => ({
      role: 'user' as const,
      provenance: 'untrusted' as const,
      text: `[${fragment.name}]\n${fragment.text}`,
    })),
  ]
}


/** Late context for `pre-provider` (ADR-0077): pulled per provider call. */
const lateContextFromHooks = async (
  input: { at: 'pre-provider' | 'post-tool'; spans: readonly { text: string }[] },
) => {
  // Every turn passes here exactly once before the provider call, which is the
  // one place that knows how long the session has grown.
  if (input.at === 'pre-provider') memorySelfCheck.check({ sessionMessages: input.spans.length })

  if (extensionHooks.providers.length === 0) return []
  const query = input.spans.map((span) => span.text).join(' ').slice(0, 2048)
  const fragments = await collectHookContext({
    providers: extensionHooks.providers,
    at: input.at,
    query,
  })
  return fragments.map((fragment) => ({
    role: 'user' as const,
    provenance: 'untrusted' as const,
    text: `[${fragment.name}]\n${fragment.text}`,
  }))
}

const memSearch = async (query: string): Promise<string> => {
  try {
    const hits = await scopedMemory.search(sessionLease, query, { limit: 8 })
    if (hits.length === 0) return 'Память: ничего не найдено.'
    return hits.map((hit) => `• [${hit.factKey}] ${hit.text}`).join('\n')
  } catch {
    return 'Память: индекс пуст или недоступен.'
  }
}

// Durable operator switch. It is created before the host adapter so every Bash
// dispatch reads the current mode instead of a boot-time snapshot (ADR-0091).
const executionMode = makeExecutionModeStore({ path: join(base, 'execution-mode.json') })

const planToolEffect = (name: string): PlanExecutionToolEffect | null => {
  const effect = runtimeToolDefinition(name)?.effect
  if (effect === 'read' || effect === 'write' || effect === 'execute' || effect === 'delegate') {
    return effect
  }
  // `goal_done` changes durable goal state and therefore belongs in the plan.
  if (effect === 'sentinel') return 'write'
  // The wrapper alone does not say whether the MCP tool behind it reads or
  // writes, so it counts as a write: in Plan Mode it belongs in the plan rather
  // than in free research.
  return name === CALL_MCP_TOOL_NAME ? 'write' : null
}
const planWorkBindingHash = createHash('sha256')
  .update('aisy.plan-mode.live-binding.v1\0')
  .update(JSON.stringify([
    staticWorkBinding.botId ?? null,
    staticWorkBinding.operatorId,
    staticWorkBinding.profileId,
    staticWorkBinding.projectId,
    staticWorkBinding.sessionId,
    staticWorkBinding.scope,
  ]))
  .digest('hex')
const planExecutionState = makePlanExecutionStateController({
  persistence: makeNodePlanExecutionPersistence({ path: join(base, 'plan-execution.json') }),
  toolEffect: planToolEffect,
})
const nativePlanContexts = new WeakMap<object, ToolExecutionContext>()
const planContext = (context: ToolExecutionContext): ModelToolRuntimeContext => {
  const projected: ModelToolRuntimeContext = Object.freeze({
    sessionId: context.sessionId,
    ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
  })
  nativePlanContexts.set(projected, context)
  return projected
}

const hostBash = makeHostBash({
  workspaceRoot: activeWorkspaceRoot,
  bypass: () => executionMode.bypassesHostBash(),
})

const durableSpawnByContext = new WeakMap<
  ToolExecutionContext,
  Readonly<{
    dispatch(planJson: string, context?: ToolExecutionContext): Promise<TaskObservation[]>
    setResearchApproval(approval: ResearchApproval | null): void
  }>
>()

const executeTool = makeLiveToolExecutor({
  fs: fsPort,
  workspaceRoot: activeWorkspaceRoot,
  fetchUrl: fetchUrlPort,
  // Commands run on the machine the agent lives on. `bash` is tier-2, so each
  // call the operator has not granted stops at the approval card. Explicit
  // ADR-0091 bypass is the only mode that skips both card and adapter denylist.
  runBash: hostBash,
  searchMemory: memSearch,
  trackTask: async ({ action, text, id }) => {
    const refusal: Record<string, string> = {
      'empty-text': 'track_task: текст задачи обязателен',
      'text-too-long': 'track_task: текст задачи слишком длинный',
      'too-many-tasks': 'track_task: слишком много открытых задач',
      'unknown-task': 'track_task: такой задачи нет',
    }
    const say = (value: unknown, ok: string): string =>
      typeof value === 'string' ? refusal[value] ?? `track_task: ${value}` : ok

    switch (action) {
      case 'add': {
        const result = taskTracker.add(text ?? '')
        return say(result, typeof result === 'string' ? '' : `Записал ${result.id}: ${result.text}`)
      }
      case 'done': {
        const result = taskTracker.done(id ?? '')
        return say(result, typeof result === 'string' ? '' : `Закрыл ${result.id}.`)
      }
      case 'drop': {
        const result = taskTracker.drop(id ?? '')
        return say(result, 'Удалил задачу.')
      }
      case 'list':
        return taskTracker.contextBlock() ?? 'Открытых задач нет.'
      default:
        return 'track_task: action должен быть add, done, drop или list'
    }
  },
  setTrigger: async (input) => proposeTriggerRef === null
    ? 'set_trigger: unavailable'
    : proposeTriggerRef(input),
  setGoal: async (input) => proposeGoalRef === null
    ? 'set_goal: unavailable'
    : proposeGoalRef(input),
  knowledge: {
    read: async (path) => {
      try {
        return knowledgeZone.readArticle(path)
      } catch (error) {
        return `read_knowledge: ${error instanceof KnowledgeZoneError ? error.reason : 'failed'}`
      }
    },
    write: async (path, content) => {
      try {
        knowledgeZone.writeArticle(path, content)
        return `Сохранил статью ${path}.`
      } catch (error) {
        return `write_knowledge: ${error instanceof KnowledgeZoneError ? error.reason : 'failed'}`
      }
    },
  },
  readJournal: async (date) => {
    const day = dailyJournal.read(date)
    if (day === 'bad-date') return 'read_journal: дата должна быть в формате YYYY-MM-DD'
    if (day === 'out-of-window') return 'read_journal: доступны только сегодня и три предыдущих дня'
    return day ?? 'read_journal: за этот день записей нет'
  },
  memory: {
    commit: async (op, ctx) => {
      const result = await scopedMemory.commit(sessionLease, op, ctx)
      // The topic is recorded only for a fact that actually landed: a duplicate
      // or a blocked write must not close a topic the operator never answered.
      if (ctx.topic !== undefined && result.status === 'COMMITTED') {
        onboardingProgress.cover(ctx.topic, op.op === 'ADD' ? op.text : undefined)
        operatorProfile.refresh(onboardingProgress.profile())
      }
      // The ledger is the authority, but the prefix reads the projection: a
      // fact that never lands in MEMORY.md is remembered only in the sense that
      // `search_memory` can still find it, and the agent stops knowing the
      // operator the moment the conversation scrolls away.
      if (result.status === 'COMMITTED') await refreshMemoryProjection()
      if (result.status !== 'DUPLICATE') return result
      // For the agent this is simply true: the fact is in memory. The second
      // record is what does not happen (ADR-0078); the journal keeps the trace.
      journal.append('memory', 'memory.duplicate', { factId: result.factId })
      return { status: 'COMMITTED', factId: result.factId }
    },
  },
  ...(extensionHooks.tools.length === 0 ? {} : { hookTools: extensionHooks.tools }),
  spawnSubagent: (planJson, context) => {
    const durable = context === undefined ? undefined : durableSpawnByContext.get(context)
    return durable === undefined
      ? spawnSubagent(planJson, context)
      : durable.dispatch(planJson, context)
  },
  webSearch: webSearchPort,
  // Wrapped: the port is declared further down, next to the delegation it uses.
  deepResearch: (question, context) => deepResearchPort(question, context),
})
// Execution modes (ADR-0083): a mode may only tighten what the code already
// enforces. Plan Mode now uses the durable research→submit→execute protocol;
// ordinary Safety/approval remains between preflight and actual execution.
// In `confirm` grants are ignored, not revoked: returning to `auto` restores
// them without the operator re-issuing anything. The mode is read per call, so
// a switch takes effect on the next tool, not on the next restart.
const modeAwareGrants: GrantStore = makeExecutionModeGrantStore(grants, executionMode)
const nativeExecuteTool = mainCapabilityRuntime?.bindToolExecutor(executeTool) ?? executeTool
// `call_mcp` is not a narrow-waist tool and never reaches the native executor:
// only the capability runtime can prove this exact call is the one the hook
// gate approved, and it is the only thing that quarantines what comes back.
const boundExecuteTool: typeof nativeExecuteTool = (call, context) =>
  call.name === CALL_MCP_TOOL_NAME && mcpCapability !== null
    ? mcpCapability.capability.execute(call)
    : nativeExecuteTool(call, context)
/**
 * Показать план оператору и дождаться тапа (ADR-0100).
 *
 * Переиспользует карточку подтверждения, а не заводит второй механизм ожидания:
 * тот уже умеет одноразовый nonce, привязку к хэшу и переживает рестарт.
 * `actionHash` — хэш самого плана, поэтому согласие относится ровно к тому
 * плану, который человек прочитал.
 */
const reviewPlanWithOperator = async (view: PlanReviewView): Promise<PlanReviewDecision> => {
  // Карточку показать некому — значит согласия нет. Режим «сначала согласуй»
  // не может тихо стать режимом «делай сразу».
  if (approveRef === null) return 'rejected'
  const numbered = view.steps.map((step, index) =>
    `${index + 1}. ${step.intent.length > 0 ? step.intent : step.tool}`)
  // Инструменты называются так же, как на живой карточке работы: одно имя у
  // одной вещи, иначе оператор сверяет план с ходом по разным словарям.
  const tools = view.steps
    .map((step) => TOOL_LABEL[step.tool]?.now ?? step.tool)
    .join(' · ')
  const summary = [
    `📋 План: ${view.steps.length} ${plural(view.steps.length, 'шаг', 'шага', 'шагов')}`,
    '',
    ...numbered,
    '',
    `Задействую: ${tools}`,
    'Начну после твоего ✔ и выполню всё разом.',
  ].join('\n')
  const decision = await approveRef(Object.freeze({
    actionId: randomUUID(),
    actionHash: view.planHash,
    tier: 2 as const,
    requiresStepUp: false,
    summary,
    // План — не «похожее действие»: запоминать его на будущее нечего.
    canRememberSimilar: false,
  }))
  return decision.decision === 'confirmed' ? 'approved' : 'rejected'
}

const mainPlanProtocol = makePlanToolProtocol({
  state: planExecutionState,
  mode: () => executionMode.get(),
  reviewPlan: reviewPlanWithOperator,
  toolEffect: planToolEffect,
  execute: (call, context) => {
    const authority = nativePlanContexts.get(context)
    if (authority === undefined) return { ok: false, output: 'PLAN_EXECUTION_IDENTITY_REQUIRED' }
    return boundExecuteTool(call, authority)
  },
  workBindingHash: planWorkBindingHash,
  policyRevision: 'plan-live-v1',
})
const mainExecuteTool: typeof boundExecuteTool = async (call, context) => {
  if (context === undefined) return { ok: false, output: 'PLAN_EXECUTION_IDENTITY_REQUIRED' }
  return mainPlanProtocol.executeAfterGate(call, planContext(context))
}
const augmentTurnForPlan = async (
  input: Parameters<NonNullable<Parameters<typeof makeAgentRunner>[0]['augmentTurn']>>[0],
): Promise<Awaited<ReturnType<NonNullable<Parameters<typeof makeAgentRunner>[0]['augmentTurn']>>>> => {
  const ordinary = await augmentTurnWithHooks(input)
  if (executionMode.get() !== 'plan') return ordinary
  return [...ordinary, Object.freeze({
    role: 'system' as const,
    provenance: 'operator' as const,
    text: 'РЕЖИМ ПЛАНА. Сначала исследуй задачу инструментами чтения/поиска и собери факты. ' +
      'До готового плана не вызывай инструменты записи, выполнения или делегирования. ' +
      'Затем кратко покажи пользователю проверяемые шаги и в том же ответе вызови submit_plan ' +
      'с exact JSON-планом. После PLAN_ACCEPTED сразу выполняй шаги по порядку; не проси пользователя ' +
      'отдельно написать «выполняй». Обычные approval-карточки опасных действий остаются обязательными.',
  })]
}

// Live narrowing state: mirrors the loop's verdict after each turn. It feeds the
// subscription-brain executor, which must see exactly what a native turn sees.
// It no longer locks the reply channel — see `isOutboundLocked` below.
let untrustedContext = false

// Server access from the panel (plan 11.9). A restart is refused when nothing
// would bring the process back: that would be a shutdown, not a restart, and the
// operator would have no way left to say so.
let liveTurns = 0
const runtimeRestart = makeRuntimeRestart({
  path: join(base, 'restart.json'),
  nowIso,
  // ADR-0071 requires an authenticated parent-supervisor ACK.  An environment
  // marker cannot prove that anything will bring this exact child back.
  supervised: () => executionSupervisorSession?.isHeld() === true,
  activeTurns: () => liveTurns,
  authorizePlannedRestart: async (intentHash) => {
    if (executionSupervisorSession === null) throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
    await executionSupervisorSession.authorizePlannedRestart(intentHash)
  },
  exit: (intent) => {
    journal.append('server', 'server.restart_requested', intent)
    process.exit(AISY_PLANNED_RESTART_EXIT_CODE)
  },
})
const previousRestart = runtimeRestart.previous()
if (previousRestart !== null) {
  journal.append('server', 'server.restart_intent_recovered', previousRestart)
}

// Server access (ADR-0086): only operations the operator described, each one
// confirmed and audited, and every opened door closes itself on a timer.
const serverAccess = makeServerAccess({
  config: (() => {
    const path = join(base, 'server-access.json')
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as ServerAccessConfig
    } catch {
      return null
    }
  })(),
  runner: {
    run: async (argv) => {
      const [command, ...rest] = argv
      if (command === undefined) return { ok: false, output: 'empty command' }
      try {
        const { spawnSync } = await import('node:child_process')
        // The argv comes from the operator's own configuration and is passed
        // without a shell, so a key or comment can never become a command.
        const result = spawnSync(command, rest, { encoding: 'utf8', timeout: 30_000 })
        return {
          ok: result.status === 0,
          output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 2000),
        }
      } catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : 'failed' }
      }
    },
  },
  nowIso,
  audit: (event, payload) => journal.append('server', event, payload),
})

// Transcription providers (ADR-0085, ADR-0098). Cloud voice exists only behind
// the authenticated parent session and root-owned broker bridge. A direct
// `aisy run` has no provider instead of falling back to vault/env/plain HTTPS.
// Genuine media capabilities are issued by the inbox ingress and are consumed
// once by the proxy provider before the supervisor can stage a descriptor.
const voiceMediaCapabilities = makeTelegramVoiceMediaCapabilityIssuer()
const transcription = makeTranscriptionRegistry({
  path: join(base, 'transcription.json'),
  providers: executionSupervisorSession === null
    ? []
    : [makeDeepgramProxyProvider({
        timeoutMs: 120_000,
        // A Telegram voice message is minutes at most; this is the ceiling a
        // single request may reserve against the daily cap.
        maximumBillableDurationMs: 10 * 60_000,
        consumeMediaCapability: voiceMediaCapabilities.consume,
        proxy: executionSupervisorSession.voiceProxy,
        spend: makeNodeDeepgramProxySpendAuthority({
          path: join(base, 'voice-spend.json'),
          dailyLimitMs: Number(process.env['AISY_VOICE_DAILY_MINUTES'] ?? 0) > 0
            ? Number(process.env['AISY_VOICE_DAILY_MINUTES']) * 60_000
            : DEFAULT_VOICE_DAILY_MS,
        }),
      })],
  onSelect: (choice) => journal.append('voice', 'voice.provider_selected', choice),
})

// Durable media inbox (ADR-0060). The writer lock is process-lifetime and is
// never reclaimed by age or PID, so a lock left by a crashed run keeps
// attachments unavailable until `aisy doctor --fix` archives it. Failing soft
// here is deliberate: a stale lock must not stop the whole agent from talking.
const MEDIA_INBOX_MAX_BYTES = 20 * 1024 * 1024
const mediaInboxRoot = join(base, 'media-inbox')
const mediaInbox = ((): SingletonTelegramAttachmentInbox | null => {
  const open = (): SingletonTelegramAttachmentInbox =>
    makeSingletonTelegramAttachmentInbox({
      inboxRoot: mediaInboxRoot,
      allowedChatId,
      maxAttachmentBytes: MEDIA_INBOX_MAX_BYTES,
      download: makeTelegramBotApiAttachmentDownloadPort({ token }),
    })
  try {
    return open()
  } catch { /* the lock is held — by a live writer or by a dead one */ }
  // A lock left by a crashed run made attachments and voice unavailable until
  // someone deleted a file over SSH. Nothing about that needed a human: this
  // process has not opened the inbox yet, so a recorded pid that no longer
  // exists proves nobody is writing. A live owner still refuses.
  try {
    const recovery = makeMediaInboxWriterRecovery({
      inboxRoot: mediaInboxRoot,
      authorization: unattendedRecoveryAuthorization,
      quiescence: makeDeadWriterQuiescence({ inboxRoot: mediaInboxRoot }),
    })
    const held = recovery.inspect()
    // Оборванный захват: директория lock есть, владельца в ней нет — процесс
    // убили между `mkdir` и записью владельца. Прежде это читалось как
    // повреждённое состояние, и приём вложений с голосом выключались до тех
    // пор, пока кто-нибудь не удалит директорию по SSH.
    if (held.state === 'abandoned' && recovery.discardAbandoned()) {
      const inbox = open()
      journal.append('media', 'media.writer_lock_discarded', { reason: 'abandoned' })
      process.stdout.write('aisy run: убрал оборванный writer lock вложений.\n')
      return inbox
    }
    if (held.state === 'held') {
      const archived = recovery.archive({
        expectedOwnerFingerprint: held.ownerFingerprint,
        approval: null,
      })
      journal.append('media', 'media.writer_lock_recovered', {
        recoveryId: archived.recoveryId,
      })
      const inbox = open()
      process.stdout.write('aisy run: убрал зависший writer lock вложений от прошлого запуска.\n')
      return inbox
    }
  } catch { /* fall through to the honest refusal below */ }
  process.stdout.write(
    'aisy run: приём вложений и голос выключены — writer lock держит живой процесс.\n',
  )
  return null
})()

// Voice: the durable inbox saves the recording, the registry transcribes it.
// Without the inbox there is nowhere to put the bytes, so there is no ingress
// either — the bot then says so instead of silently swallowing the message.
const voiceIngress = mediaInbox === null ? undefined : makeTelegramVoiceIngress({
  inbox: mediaInbox.inbox,
  inboxRoot: mediaInboxRoot,
  transcriber: transcription,
  degradePolicy: 'text-only',
  maxAudioBytes: MEDIA_INBOX_MAX_BYTES,
  mediaCapabilities: voiceMediaCapabilities,
  emit: (event, payload) => journal.append('voice', event, payload),
})

const gateway = makeGateway({
  getAllowedChatId: async () => allowedChatId,
  getBotToken: async () => token,
  isReady: () => true,
  transcribeVoice: async () => {
    // The registry decides who transcribes; the file pipeline that feeds it is
    // the media inbox, still outside `aisy run`. Until then the refusal is
    // explicit — a transcript that never happened must never be invented.
    const provider = transcription.selected()
    throw new VoiceUnavailable(provider === null
      ? 'voice transcription not configured'
      : `voice pipeline not wired (provider: ${provider.id})`)
  },
  // Off by decision (ADR-0095). The port stays — the gateway still fails closed
  // for anyone who wires it — but this composition never holds an answer to its
  // own operator. What stops an injection here is the sandbox, approvals and the
  // code-owned rule that a tool argument derived from untrusted text never
  // dispatches; asking the owner to approve a message addressed to the owner
  // only taught them to tap "allow".
  isOutboundLocked: () => false,
  isSafetyAvailable: () => true,
// Второго фактора здесь нет намеренно (ADR-0104): у установки один оператор и
  // один приватный канал, тап по карточке приходит только от него. Кодовое
  // слово поверх этого не добавляло защиты, а добавляло шаг, на котором
  // необратимое действие зависало без ответа.
})

const budgetUsd = Number(process.env['AISY_BUDGET_USD'] ?? '0') || 0

// Spend ledger + operator settings (ADR-0050 Phase 2), persisted under AISY_HOME.
const spendPath = join(base, 'spend.json')
const settingsPath = join(base, 'settings.json')
const readJson = <T>(path: string, fallback: T): T => {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}
const spendLedger = makeSpendStore({
  persistence: {
    load: () => readJson<SpendEntry[]>(spendPath, []),
    save: (entries) => writeFileSync(spendPath, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 }),
  },
})
// Daily budget (ADR-0082): the per-agent cap is cumulative for all time and says
// nothing about today. Warn once at 80 %, pause turns at 100 % until midnight.
const dailyBudget = makeDailyBudget({
  path: join(base, 'daily-budget.json'),
  capUsd: Number(process.env['AISY_DAILY_BUDGET_USD'] ?? 0),
  nowIso,
  onWarning: (state) => journal.append('budget', 'budget.daily_warning', state),
  onPause: (state) => journal.append('budget', 'budget.daily_paused', state),
})
// Every charge is counted twice on purpose: the ledger stays the source of truth
// for reports, the daily counter only decides the threshold.
const spend: SpendStore = {
  ...spendLedger,
  record: (entry) => {
    spendLedger.record(entry)
    dailyBudget.record(entry.usage.dollars)
  },
}
const settings = makeSettingsStore({
  persistence: {
    load: () => readJson<Partial<Settings>>(settingsPath, {}),
    save: (s) => writeFileSync(settingsPath, JSON.stringify(s, null, 2), { encoding: 'utf8', mode: 0o600 }),
  },
})

// Where the operator lives, for anything that promises a wall-clock time. The
// setting wins, then AISY_TIMEZONE, then the host's own zone; a name the runtime
// does not know is ignored rather than silently shifting every schedule.
const operatorTimeZone = (): string | undefined => {
  const chosen = settings.get().timeZone
  const configured = chosen.length > 0 ? chosen : process.env['AISY_TIMEZONE'] ?? ''
  if (configured.length > 0) {
    return isKnownTimeZone(configured) ? configured : undefined
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

// Per-agent budget caps (ADR-0050 Phase 3): the main agent's cap is
// agents.main.budgetUsd or AISY_BUDGET_USD; sub-agents declare their own.
// `spent` is read live from the spend ledger.
const caps: Record<string, number> = { main: providersCfg.agents?.['main']?.budgetUsd ?? budgetUsd }
for (const [id, a] of Object.entries(providersCfg.agents ?? {})) {
  if (typeof a.budgetUsd === 'number') caps[id] = a.budgetUsd
}
const budget = makeBudgetTracker({
  caps,
  spent: (agentId) => spend.byAgent().find((a) => a.agentId === agentId)?.dollars ?? 0,
})
const budgetCheckFor = (agentId: string) => makeAgentBudgetCheck({
  agentId,
  isEnabled: () => settings.get().budgetEnabled === true,
  capFor: (id) => budget.capFor(id),
  spentFor: (id) => budget.spentFor(id),
})

// --- Tier-3 sub-agent delegation wiring ---
// Sub-agents use a base executor WITHOUT spawn_subagent — no nested delegation in v1.
const subAgentBaseExecutor = makeLiveToolExecutor({
  fs: fsPort,
  workspaceRoot: activeWorkspaceRoot,
  searchMemory: memSearch,
  // A child sent to research something has to be able to open the page. It
  // passes the same tier-2 card as the parent — the approval port is shared.
  fetchUrl: fetchUrlPort,
  // ...and to find the page in the first place. Without this a researcher can
  // only read links someone else already chose, which is not research.
  webSearch: webSearchPort,
})

// Per-(sub)agent model selection from providers.json:agents; fall back to the default.
function selectionForAgent(agentId: string): ProviderSel {
  const a = providersCfg.agents?.[agentId]
  return a?.provider != null && a.model != null ? { provider: a.provider, model: a.model } : defaultSel
}

// The bot supplies the human approval port inside buildRunner; capture it for sub-agents.
let approveRef: ((action: PendingAction) => Promise<ApprovalDecision>) | null = null

// Serves the MCP bridge of a subscription brain. It reuses the shared capability
// executor so a tool asked for by the CLI passes exactly the checks a native
// turn would: safety policy, hook gate, grants, execution mode and the Telegram
// approval card. The name is Codex-era; the contract is transport-agnostic.
const subscriptionPlanProtocol = makePlanToolProtocol({
  state: planExecutionState,
  mode: () => executionMode.get(),
  reviewPlan: reviewPlanWithOperator,
  toolEffect: planToolEffect,
  execute: (call) => boundExecuteTool(call),
  workBindingHash: planWorkBindingHash,
  policyRevision: 'plan-live-v1',
})
const subscriptionCapabilityExecutor = makeCodexCapabilityExecutor({
  grants: modeAwareGrants,
  unsafeHostBashBypass: () => executionMode.bypassesHostBash(),
  approve: async (_binding, action) => approveRef === null
    ? { decision: 'rejected' as const }
    : approveRef(action),
  executeTool: async (_binding, call, _signal, runtimeContext) => runtimeContext === undefined
    ? { ok: false, output: 'PLAN_EXECUTION_IDENTITY_REQUIRED' }
    : subscriptionPlanProtocol.executeAfterGate(call, runtimeContext),
})
invokeSubscriptionTool = async (call, signal, runtimeContext) => {
  const candidate = Object.freeze({
    name: call.name,
    args: call.args,
    sourceSpanProvenance: 'operator' as const,
  })
  const preflight = await subscriptionPlanProtocol.preflight(candidate, runtimeContext)
  if (preflight.kind === 'intercept') {
    return { text: preflight.result.output, isError: !preflight.result.ok }
  }
  const result = await subscriptionCapabilityExecutor(
    staticWorkBinding,
    preflight.call,
    { provenance: 'operator', narrowed: untrustedContext },
    signal,
    runtimeContext,
  )
  // Учёт research-наблюдения — побочная запись, а не часть выполнения: инструмент
  // уже отработал, и его результат принадлежит модели. Прежняя версия здесь
  // возвращала `PLAN_PROTOCOL_UNAVAILABLE`, из-за чего оператор читал код вместо
  // ответа на свой вопрос, а причина отказа терялась целиком.
  try { subscriptionPlanProtocol.observeAfterGate(preflight.call, runtimeContext, result) } catch (error) {
    journal.append('plan', 'plan.observe_failed', {
      tool: preflight.call.name,
      code: error instanceof Error ? error.message : 'unknown',
    })
  }
  return { text: result.output, isError: !result.ok }
}

// The mutex for the search the operator just confirmed. The approval authority
// itself is passed only into that exact spawnSubagent invocation below; keeping
// it here solely marks the composition busy and cannot authorize a concurrent
// researcher started by another session.
let activeResearch: ResearchApproval | null = null

/**
 * One tap covers the whole search (ADR-0097). The operator confirms
 * `deep_research` at tier 2; inside, the researcher's page approvals are
 * answered by `makeResearchApproval` under a page count and a deadline.
 */
const deepResearchPort = async (
  question: string,
  context?: ToolExecutionContext,
): Promise<string> => {
  if (activeResearch !== null) {
    return 'deep_research: одно исследование уже идёт — дождись его.'
  }
  // The heartbeat card: sent before the first page, edited as the counter
  // moves, closed with the reason when the search ends. Fire-and-forget — the
  // card describes the work and must never gate it.
  const heartbeat = (pages: number, status: 'active' | 'done', note?: string): void => {
    void researchProgress({
      question, pages, maxPages: DEFAULT_RESEARCH_LIMITS.maxPages, status,
      ...(note === undefined ? {} : { note }),
    }).catch(() => {})
  }
  const approval = makeResearchApproval(
    DEFAULT_RESEARCH_LIMITS,
    () => Date.now(),
    (spent) => { heartbeat(spent, 'active') },
  )
  const deadline = AbortSignal.timeout(DEFAULT_RESEARCH_LIMITS.maxMs)
  const signal = context?.signal === undefined
    ? deadline
    : AbortSignal.any([context.signal, deadline])
  activeResearch = approval
  heartbeat(0, 'active')
  let observations: TaskObservation[]
  try {
    const durable = context === undefined ? undefined : durableSpawnByContext.get(context)
    if (durable === undefined) {
      observations = await spawnSubagent(
        researchPlan(question, DEFAULT_RESEARCHER_CARD.name),
        context,
        signal,
        approval,
      )
    } else {
      durable.setResearchApproval(approval)
      try {
        observations = await durable.dispatch(
          researchPlan(question, DEFAULT_RESEARCHER_CARD.name),
          context,
        )
      } finally {
        durable.setResearchApproval(null)
      }
    }
  } finally {
    activeResearch = null
    heartbeat(approval.spent(), 'done', stopLine(approval.stopped(), approval.spent()) ?? undefined)
  }
  const failed = observations.filter((o) => o.status === 'failed')
  const report = observations
    .filter((o) => o.status === 'completed')
    .map((o) => o.summary)
    .filter((text) => typeof text === 'string' && text.trim().length > 0)
    .join('\n\n')
  if (report.length === 0) {
    const why = failed.length > 0 ? ' Исследователь остановился, не дойдя до ответа.' : ''
    return `deep_research: отчёта нет.${why}${stopNote(approval.stopped(), approval.spent())}`
  }
  return `${report}${stopNote(approval.stopped(), approval.spent())}`
}

const spawnSubagent = async (
  planJson: string,
  _context?: ToolExecutionContext,
  signal: AbortSignal | undefined = _context?.signal,
  researchApproval?: ResearchApproval,
): Promise<TaskObservation[]> => {
  let parsed: unknown
  try { parsed = JSON.parse(planJson) }
  catch { return [] }
  const plan = normalizeSpawnPlan(parsed, DEFAULT_GENERAL_CARD.name)
  let manager
  try {
    manager = makeDelegationManager(plan, {
      binding: staticWorkBinding,
      resolveCard: resolveRunnableCard,
      skillTouchedPaths: (name) => activeSkills.touchedPaths(name),
      mcpWritable: () => false,      // MCP (07) not live yet
      emit: () => {},                // Observability journal wired in Tier 4
    })
  } catch { return [] }
  return runDelegation({
    manager,
    ...(signal === undefined ? {} : { signal }),
    runTask: async (handle, task) => {
      const agentId = task.assignedTo ?? handle.card.name
      const sel = selectionForAgent(agentId)
      const capabilities = resolveChildAgentCapabilityMatrix({
        card: handle.card,
        toolCatalog: TOOLS,
        activeSkills: activeSkillNames,
        activeMcpServers,
        minimumToolTiers: TOOL_MINIMUM_TIERS,
      })
      const allowedSkills = new Set(capabilities.skills)
      const childSkillRuntime = makeSkillPromptRuntime({
        menu: () => activeSkills.menu().filter(item => allowedSkills.has(item.name)),
        matchTriggers: request => activeSkills.matchTriggers(request).filter(name => allowedSkills.has(name)),
        loadBody: name => allowedSkills.has(name) ? activeSkills.loadBody(name) : Promise.resolve(''),
      })
      const shardLog: SessionLog = {
        append: (e: LogEntry) => { handle.append(e.kind, e.payload) },
        resume: () => null,
      }
      const subRunner = makeSubAgentRunner({
        handle,
        provider: adapterFor(sel, capabilities.tools),
        baseExecuteTool: subAgentBaseExecutor,
        // The search the operator confirmed answers its own page cards; every
        // other sub-agent still goes to the operator. Both the card name and
        // the invocation-local port are required, so a concurrent researcher
        // cannot borrow this search's authority.
        approve: handle.card.name === DEFAULT_RESEARCHER_CARD.name && researchApproval !== undefined
          ? researchApproval.approve
          : approveRef ?? (async () => ({ decision: 'rejected' as const })),
        memory,
        sessionLog: shardLog,
        parentNarrowed: untrustedContext,   // Tier-2 narrowed mirror (one-turn-stale, ADR-0052)
        doNotTouch: task.scope.doNotTouch,
        budgetCheck: budgetCheckFor(agentId),
        skillPromptRuntime: childSkillRuntime,
        postToolUse,
      })
      const result = await subRunner.handle({
        sessionId: handle.delegationId,
        spans: [{ role: 'user', provenance: 'operator', text: task.intent }],
        ...(signal === undefined ? {} : { signal }),
      })
      if (result.usage != null) {
        spend.record({ model: sel.model, agentId, usage: result.usage })
      }
      const cost = { iterations: 1, spendUsd: result.usage?.dollars ?? 0, wallMs: 0 }
      return result.state === 'halted'
        ? handle.fail(result.haltReason ?? 'halted', cost)
        : handle.complete(result.reply, result.reply, cost)
    },
  })
}

// --- Tier-4 nightly consolidation ---
const nightlyAt = process.env['AISY_NIGHTLY_AT'] ?? '03:30'
const nightlyConfig: NightlyConfig = {
  runAt: nightlyAt,
  maxHeldMs: 2 * 60 * 60 * 1000,
  lintStaleDays: 30,
  backupRemote: process.env['AISY_BACKUP_REMOTE'] ?? '',
  stagingDir: join(base, 'staging'),
  archiveDir: join(base, 'archive'),
}

// Generator on the routine tier; judge on critique. Single-provider fallback logged.
const genSel = providersCfg.tiers?.routine ?? defaultSel
const judgeSel = providersCfg.tiers?.critique ?? defaultSel
if (genSel === judgeSel) {
  process.stdout.write('aisy run: nightly judge uses the same provider as the generator (single-provider config)\n')
}

const bootStamp = nowIso()
const processStartTime = Date.now()

// Rebuild the derived index before the first run. Each nightly execution then
// captures fresh facts plus matching validator authority under night.lock; the
// long-lived runner no longer freezes these at process boot.
// Cold start (fresh `aisy init`): the memory tree exists but the derived FTS index
// (memory.db) does not yet — build it before the first read, or listLive() throws
// CorruptIndexError and the bot never reaches polling. Idempotent + cheap.
// ADR-0074: files are no longer the authority, the ledger is. Cold start
// recovers any interrupted scope operation instead of rebuilding an index.
if (protectedMemory.mode === 'preview') {
  await memoryLeases.withMaintenanceLease(async (lease) => {
    await protectedMemory.recovery.recoverScope(lease, protectedMemory.scope)
  })
}
const exactStore = makeMemoryExactCacheStore()
const nightlyExact = process.env['AISY_NIGHTLY_EXACT_CACHE'] === '1'
const wrapNightly = (a: ProviderAdapter, ns: string): ProviderAdapter =>
  nightlyExact ? makeExactCache(a, exactStore, ns) : a
const nightlyRunner = makeConsolidationRunner({
  clock: { now: () => new Date(nowIso()) },
  generator: makeNightlyGenerator({
    provider: wrapNightly(adapterFor(genSel, mainProviderTools), `gen:${genSel.model}`), nowIso,
  }),
  judge: makeNightlyJudge({
    provider: wrapNightly(adapterFor(judgeSel, mainProviderTools), `judge:${judgeSel.model}`),
  }),
  // Legacy fallback for direct runLintPass(); run() always uses loadRunSnapshot.
  validators: makeMemoryValidators({ liveFactIds: new Set() }),
  loadRunSnapshot: makeNightlyLiveSnapshotLoader({
    listLive: async () => {
      const binding = resolveNightlyBinding()
      // No binding means no authority to read memory on behalf of anyone.
      if (binding === null) return []
      return memoryLeases.withBackgroundLease(binding, (lease) => scopedMemory.listLive(lease))
    },
  }),
  lock: makeFileRunLock({
    lockPath: join(base, 'nightly.lock'),
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, c) => writeFileSync(p, c, { encoding: 'utf8', mode: 0o600 }),
    exists: (p) => existsSync(p),
    removeFile: (p) => { try { unlinkSync(p) } catch { /* stale lock already gone */ } },
    pid: process.pid,
    bootId: bootStamp,
    startTime: processStartTime,
    now: () => Date.now(),
  }),
  memoryTxn: async (apply) => { await apply() },
  // No reindex hook: derived indexes follow the ledger inside each commit.
  reindex: () => { /* ADR-0074: derivatives are maintained by the ledger itself */ },
  emit: (event) => journal.append('nightly', event, {}),
  commitOp: async (op) => {
    const mop = memOpToMemoryOp(op)
    if (!mop) return null
    const binding = resolveNightlyBinding()
    if (binding === null) return null
    return memoryLeases.withBackgroundLease(binding, async (lease) => {
      if (mop.op === 'DELETE') {
        await scopedMemory.forget(lease, mop.targetId, mop.reason, mop.humanConfirmed)
        return mop.targetId
      }
      const r = await scopedMemory.commit(lease, mop, { withinSession: false })
      return r.factId ?? null
    })
  },
})

// --- Tier-4 D2: helpers for trigger command parsing ---

/** Parse a relative or absolute time string into an ISO-8601 string, or null. */
function parseWhen(when?: string): string | null {
  if (!when) return null
  const rel = /^(\d+)(m|h|d)$/.exec(when)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]!
    const ms = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000
    return new Date(Date.now() + ms).toISOString()
  }
  const parsed = Date.parse(when)
  if (!isNaN(parsed)) return new Date(parsed).toISOString()
  return null
}

/** Parse a probe shorthand (file:<path> or http:<url>) into a VerificationTrace, or null. */
function parseProbe(p?: string): VerificationTrace | null {
  if (!p) return null
  if (p.startsWith('file:')) {
    const path = p.slice('file:'.length)
    if (!path) return null
    return { kind: 'file', path, existsExpected: true }
  }
  if (p.startsWith('http:')) {
    const url = p.slice('http:'.length)
    if (!url) return null
    return { kind: 'http', method: 'GET', url, expectStatus: 200 }
  }
  return null
}

// sendProactive is resolved after makeTelegramBot; runNightly captures it via closure.
let sendProactiveRef: ((text: string) => Promise<void>) | null = null

// `set_trigger` is built into the tool executor long before the trigger engine
// and the bot exist, so it calls through this ref. Null ⇒ the tool answers
// "unavailable" instead of pretending it scheduled something.
let proposeTriggerRef:
  | ((input: {
      kind: string
      prompt: string
      when?: string
      cron?: string
      probe?: string
    }) => Promise<string>)
  | null = null

// Same shape for `set_goal`: the tool exists before the bot that shows the card.
let proposeGoalRef:
  | ((input: { objective: string; mode?: string }) => Promise<string>)
  | null = null

/**
 * The goal as the operator sees it — on the 🎯 Цели screen and on the live card
 * the orchestrator keeps up to date. One projection for both, so a goal never
 * has two descriptions.
 */
const goalScreenView = (g: GoalSpec): GoalScreenView => ({
  objective: g.objective,
  mode: g.mode.kind,
  status: g.status,
  iterationsSpent: g.iterationsSpent,
  maxIterations: g.backstop.maxIterations,
  dollarsSpent: g.usageSpent.dollars,
  dollarCeiling: g.backstop.dollarCeiling,
  ...(g.lastFeedback === undefined ? {} : { lastFeedback: g.lastFeedback }),
  ...(g.haltReason === undefined ? {} : { haltReason: g.haltReason }),
})

// --- Tier-7 goal wiring (pre-bot declarations; onGoalCommand closes over these) ---
const goalStore = makeGoalStore({
  path: join(base, 'goal.json'),
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c, { encoding: 'utf8', mode: 0o600 }),
  exists: (p) => existsSync(p),
  removeFile: (p) => { try { unlinkSync(p) } catch { /* already gone */ } },
})
const goalBackstop = {
  maxIterations: Number(process.env['AISY_GOAL_MAX_ITERATIONS'] ?? '25') || 25,
  tokenCeiling: Number(process.env['AISY_GOAL_TOKEN_CEILING'] ?? '500000') || 500000,
  dollarCeiling: Number(process.env['AISY_GOAL_DOLLAR_CEILING'] ?? '5') || 5,
}
// Forward reference: orchestrator is assigned after makeTelegramBot (chicken-egg break).
// onGoalCommand (inside makeTelegramBot deps) closes over orchestrator by reference;
// it is only called at runtime (never at definition time), so the assignment below is safe.
let orchestrator: ReturnType<typeof makeGoalOrchestrator>
let goalAbort: AbortController | null = null

async function runNightly(binding: ResolvedWorkBinding): Promise<void> {
  const session = projectRegistry.snapshot().sessions.find((item) => item.id === binding.sessionId)
  if (binding.scope !== 'workspace' || binding.projectId !== nightlyWorkspaceProject.id ||
    session?.projectId !== nightlyWorkspaceProject.id || session.status !== 'active') {
    throw new Error('NIGHTLY_BOUND_CONTEXT_UNAVAILABLE')
  }
  journal.append('nightly', 'job.binding_resolved', {
    projectId: binding.projectId,
    sessionId: binding.sessionId,
    scope: binding.scope,
  })
  // Monitoring retention (ADR-0084) rides the nightly pass: it already holds a
  // lock and already runs once a day, so a second schedule would only add a
  // second point of failure.
  if (monitoringRuntime !== null) {
    try {
      const retentionDays = Number(process.env['AISY_MONITORING_RETENTION_DAYS'] ?? 30)
      const maxRows = Number(process.env['AISY_MONITORING_MAX_ROWS'] ?? 20_000)
      const now = nowIso()
      const pruned = monitoringRuntime.store.prune({
        olderThan: new Date(Date.parse(now) - retentionDays * 86_400_000).toISOString(),
        maxRows,
        now,
      })
      journal.append('monitoring', 'monitor.pruned', pruned)
    } catch (error) {
      journal.append('monitoring', 'monitor.prune_failed', {
        detail: error instanceof Error ? error.message : 'unknown',
      })
    }
  }
  const result = await nightlyRunner.run(nightlyConfig)
  await gateway.issueCard({
    actionId: `nightly-${result.runDate}`,
    actionHash: createHash('sha256').update(`nightly:${result.runDate}`).digest('hex'),
    tier: 1,
    requiresStepUp: false,
    summary: `🌅 Ночная консолидация ${result.runDate}: ${result.card.memoryEdits.length} правок памяти на одобрение.`,
  })
  await sendProactiveRef?.(`🌅 Разобрала память за ${result.runDate}: ${result.card.memoryEdits.length} правок ждут решения. Открой карточку — покажу каждую.`)
}

const buildMainRunner = (
  approve: (action: PendingAction) => Promise<ApprovalDecision>,
  executeForTurn: typeof mainExecuteTool = mainExecuteTool,
) => {
  approveRef = approve
  const runner = makeAgentRunner({
    provider,
    memory,
    grants: modeAwareGrants,
    grantBinding: staticWorkBinding,
    executeTool: executeForTurn,
    propagateToolInterruption: error =>
      durableDelegationRecoverableRuntimeErrorCode(error) !== undefined,
    preToolDispatch: (call, context) => mainPlanProtocol.preflight(call, planContext(context)),
    postToolDispatch: (call, context, result) =>
      mainPlanProtocol.observeAfterGate(call, planContext(context), result),
    approve,
    guardian: makeGuardian(),
    sessionLog,
    maxTotalToolCalls: mainCapabilityRuntime?.matrix.maxIterations ?? 50,
    budgetCheck: budgetCheckFor('main'),
    prefixExtension: promptPrefixExtension,
    augmentTurn: augmentTurnForPlan,
    lateContext: lateContextFromHooks,
    postToolUse,
    toolTiers: {
      ...(mainCapabilityRuntime?.matrix.toolTiers ?? TOOL_MINIMUM_TIERS),
      ...executionMode.toolTiers(),
    },
    unsafeHostBashBypass: () => executionMode.bypassesHostBash(),
    learnedAutonomy: (call) =>
      executionMode.get() === 'auto' && learnedAutonomyPort(call),
    observeApproval: observeApprovalForAutonomy,
    ...(mcpCapability === null ? {} : {
      mcpCapability: {
        resolveSafetyCall: mcpCapability.capability.resolveSafetyCall,
        completeSafetyCall: mcpCapability.capability.completeSafetyCall,
      },
    }),
    ...(sessionTranscriptRecorder === undefined
      ? {}
      : { transcriptRecorder: sessionTranscriptRecorder }),
  })
  const wrapped = mainCapabilityRuntime?.wrapRunner(runner) ?? runner
  return {
    handle: async (turnInput: Parameters<typeof wrapped.handle>[0]) => {
      const result = await wrapped.handle(turnInput)
      flushDemonstrations(turnInput.turnId ?? 'turn', result.state === 'ok')
      void offerRipeAutonomy()
      return result
    },
  }
}

const {
  bot,
  runProactiveTurn,
  sendProactive,
  goalProgress,
  researchProgress,
  proposeGoal,
  proposeTrigger,
  runGoalTurn,
  resumeDurableTurn,
  recoverDurableTurnCard,
  resumeForwardBatch,
  armMainMenu,
  offerServiceKeys,
  sendMenuTour,
  offerTimezone,
} = makeTelegramBot({
  token,
  allowedChatId,
  sessionId: activeProjectSelection.sessionId,
  gateway,
  model: modelLabel,
  budgetUsd,
  settings,
  spend,
  budget,
  dailyBudget,
  executionMode,
  transcription,
  voiceCredentials,
  providerCredentials,
  bots: {
    list: () => botRegistry.list(true),
    activeId: () => activeBot?.id ?? null,
    add: (input) => botRegistry.add(input),
    archive: (botId) => botRegistry.archive(botId),
  },
  serverAccess,
  serverStatus: () => renderServerStatus(readServerStatus({ root: base, version: harnessVersion() })),
  onAgentState: (state) => { liveTurns = state === 'running' ? 1 : 0 },
  restartRuntime: runtimeRestart,
  ...(durableTurnState === null
    ? {}
    : {
        durableTurnControl: {
          isRecoverableInterruption: (error: unknown) =>
            durableDelegationRecoverableRuntimeErrorCode(error) ===
              'DELEGATION_OPERATION_AMBIGUOUS',
          pendingCard: () => durableTurnState.currentCoordinator()?.pendingCard() ?? null,
          markCardDelivered: (input: Parameters<
            DurableDelegationTurnCoordinatorV1['markCardDelivered']
          >[0]) => durableTurnState.ensureCoordinator().markCardDelivered(input),
          recordCardDecision: (input: Parameters<
            DurableDelegationTurnCoordinatorV1['recordCardDecision']
          >[0]) => durableTurnState.ensureCoordinator().recordCardDecision(input),
          retireTurn: (receiptHash: string) =>
            durableTurnState.ensureCoordinator().retireParent(receiptHash),
          requestStop() {
            const loaded = durableTurnState.continuation.load()
            if (loaded.status !== 'ready' || loaded.record.ambiguity === undefined ||
              (loaded.record.phase !== 'paused' && loaded.record.phase !== 'active' &&
                loaded.record.phase !== 'cancelling' &&
                loaded.record.cancellationReceiptHash === undefined)) return null
            return durableTurnState.ensureCoordinator().requestStop()
          },
          async requestResume() {
            const intent = runtimeRestart.prepare('durable ambiguity resume')
            if (typeof intent === 'string') throw new Error(`DURABLE_RESUME_${intent}`)
            const committed = await runtimeRestart.commitExit(intent)
            if (committed !== 'committed') throw new Error(`DURABLE_RESUME_${committed}`)
          },
        },
      }),
  ...(executionSupervisorSession === null
    ? {}
    : {
        executionCheckpoint: {
          store: executionCheckpointStore,
          newOwnerId: () => randomUUID(),
          authority: {
            captureTurn: async (bindingHash: string) => {
              if (startupDelegationRecoveryPending) {
                if (startupRecoveryLease === null || startupRecoveryLeaseClaimed ||
                  startupRecoveryLease.bindingHash !== bindingHash ||
                  !startupRecoveryLease.isHeld()) {
                  throw new Error('EXECUTION_RECOVERY_BINDING_MISMATCH')
                }
                startupRecoveryLeaseClaimed = true
                return startupRecoveryLease
              }
              return await executionSupervisorSession.captureTurn(bindingHash)
            },
          },
        },
        ...(replyCheckpointStore === null ? {} : {
          durableReply: {
            store: replyCheckpointStore,
            binding: staticWorkBinding,
            consumeReleaseReceipt: (receipt: Parameters<
              NonNullable<typeof executionSupervisorSession>['consumeReleaseReceipt']
            >[0]) => executionSupervisorSession.consumeReleaseReceipt(receipt),
            newOwnerId: () => randomUUID(),
          },
        }),
      }),
  grants,
  // Что агент перестал спрашивать сам — на том же экране, что и ручные
  // разрешения: появились они по-разному, но снимаются одинаково.
  learnedGrants: {
    list: () => learnedGrants.list()
      .filter((grant) => grant.revoked === undefined)
      .map((grant) => ({
        workflowKey: grant.workflowKey,
        title: autonomyTitles.get(grant.workflowKey) ?? grant.scope.tool,
        version: grant.version,
        expires: grant.expiresAt.slice(0, 10),
        demonstrations: autonomyLedger.candidates()
          .find((c) => c.workflowKey === grant.workflowKey)?.stats.confirmed ?? 0,
      })),
    revoke: (workflowKey) => { learnedGrants.revoke(workflowKey, 'operator-revoke') },
  },
  setUntrustedContext: (untrusted) => { untrustedContext = untrusted },
  sessionLog,
  recall: async (query: string): Promise<string> => {
    try {
      const hits = await scopedMemory.search(sessionLease, query, { limit: 5 })
      return hits.map((hit) => `• ${hit.text}`).join('\n')
    } catch {
      return ''
    }
  },
  captureWorkBinding: async () => staticWorkBinding,
  ...(mediaInbox === null ? {} : { attachmentInbox: mediaInbox.inbox }),
  ...(voiceIngress === undefined ? {} : { voiceIngress }),
  forwardBatch: {
    store: makeNodeTelegramForwardBatchStore({
      path: join(base, 'telegram', 'forward-batch.json'),
    }),
  },
  skillsMenu: configuredSkillMenu,
  mcpMenu: configuredMcpMenu,
  monitoringStatus,
  ...(monitoringControls === undefined ? {} : { monitoringControls }),
  agentCard: () => {
    const c = mainCapabilityRuntime?.card ?? cardResolver.resolve('general')
    if (!c) return { name: 'general', description: '—', skills: [] }
    return {
      name: c.name,
      description: c.description ?? '—',
      skills: c.skills,
    }
  },
  agentCards: agentCardLifecycle,
  serviceKeys: makeServiceKeyStore({
    vaultPath,
    exists: existsSync,
    readFile: (path) => readFileSync(path, 'utf8'),
    writePrivateFile: (path, content) =>
      writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 }),
    renameFile: renameSync,
  }),
  projectControls: makeTelegramProjectControls({
    runtime: projectRuntime,
    owner: registryOwner,
    displayRoot: (root) => root.replace(homedir(), '~'),
  }),
  sessionControls: makeTelegramSessionControls({
    runtime: projectRuntime,
    owner: registryOwner,
  }),
  projectLifecycleControls: makeTelegramProjectLifecycleControls({
    runtime: projectRuntime,
    authority: lifecycleRuntime.authority,
    owner: registryOwner,
  }),
  activeProjectName: () => activeProject.isDefault ? undefined : activeProject.name,
  skillControls: makeTelegramSkillControls({
    folder: activeSkillStore,
    onChanged: reloadSkills,
  }),
  mcpControls: makeTelegramMcpControls({
    writer: mcpWriter,
    onboarding: mcpOnboarding,
    // Only a live gauntlet may claim a server is on the line, and this build
    // does not run one yet — an approved server is approved, not connected.
    activeServerNames: () => activeMcpServers,
  }),
  startNewSession: async () => {
    const result = await newSessionRunner()
    return result.ok
      ? { ok: true as const, name: result.session.name }
      : { ok: false as const, errorCode: result.errorCode }
  },
  resumeSession: async (sessionId) => {
    const result = await resumeSessionRunner(sessionId)
    return result.ok ? { ok: true as const } : { ok: false as const, errorCode: result.errorCode }
  },
  createProject: async (rawName) => {
    const name = rawName.trim()
    if (name.length === 0 || name.length > 80) {
      return { ok: false as const, error: 'Название должно быть от одного до 80 символов.' }
    }
    // The directory name is derived from the name, never taken from it: a
    // project name is operator text, and operator text does not pick a path.
    const slug = name.toLowerCase().normalize('NFKD')
      .replace(/[^a-z0-9а-я]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    const root = join(registryPolicy.projectsRoot, slug.length > 0 ? slug : randomUUID().slice(0, 8))
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 })
      registryPair.registry.createProject({
        ...registryOwner, name, root, origin: 'created',
      })
      return { ok: true as const, name, root }
    } catch (error) {
      const code = (error as { code?: unknown }).code
      return {
        ok: false as const,
        error: `Не удалось создать проект (${typeof code === 'string' ? code : 'ошибка'}).`,
      }
    }
  },
  brainSelection: () => ({ provider: defaultSel.provider, model: defaultSel.model }),
  brainModels: () => findProvider(defaultSel.provider)?.defaultModels ?? [],
  setBrainModel: (model) => {
    writeProvidersConfig({ ...providersCfg, default: { ...defaultSel, model } })
  },
  reconnectBrain: async () => {
    // Setup mode is chosen at boot from providers.json plus the key: drop the
    // default and the bootstrap state, and the next start is the choice card.
    const { default: _dropped, ...rest } = providersCfg
    writeProvidersConfig(rest)
    try {
      unlinkSync(join(base, 'brain-bootstrap.json'))
    } catch { /* never created, or already gone */ }
  },
  onConsolidate: async () => {
    const binding = resolveNightlyBinding()
    if (!binding) throw new Error('NIGHTLY_BINDING_QUARANTINED')
    await runNightly(binding)
  },
  getStaging: async () => {
    const area = await nightlyRunner.getStagedProposals()
    return area.memoryPatches.map((p) => ({ id: p.id, preview: p.body.slice(0, 80), judged: p.judged }))
  },
  onApproveNightly: async (id: string) => {
    await nightlyRunner.approveStagedItem(id)
  },
  onRegisterTrigger: async (input) => registerTrigger({ ...input, createdBy: 'operator' }),
  onListTriggers: async () => (await triggerEngine.list()).map((t) => ({ id: t.id, kind: t.kind, prompt: t.prompt })),
  onCancelTrigger: async (id) => { try { await triggerEngine.cancel(id); return true } catch { return false } },
  onConfirmTrigger: async (id) => {
    const known = (await triggerEngine.list()).some((spec) => spec.id === id)
    if (!known) return false
    await triggerEngine.confirm(id)
    return true
  },
  buildRunner: buildMainRunner,
  ...(executionSupervisorSession === null || durableDelegationRegistry === null
    ? {}
    : {
        buildExecutionRunner: (
          approve: (action: PendingAction) => Promise<ApprovalDecision>,
          authority: Parameters<NonNullable<Parameters<typeof makeTelegramBot>[0]['buildExecutionRunner']>>[1],
          turn: TelegramExecutionTurnV1,
        ) => {
          if (durableTurnState === null) throw new Error('DURABLE_TURN_STATE_UNAVAILABLE')
          const turnCoordinator = durableTurnState.capture(turn, authority)
          let exactResearchApproval: ResearchApproval | null = null
          const durableSpawn = makeProductionDurableDelegationDispatcher({
            stateRoot: durableDelegationStateRoot,
            executionAuthority: authority,
            binding: staticWorkBinding,
            defaultCardName: DEFAULT_GENERAL_CARD.name,
            registry: durableDelegationRegistry,
            installationHash: durableInstallationHash,
            policyRevision: 'durable-delegation-live-v1',
            dailyEpoch: new Date().toISOString().slice(0, 10),
            maximumDailySpendUsd: budgetUsd > 0 ? budgetUsd : 1_000_000,
            maxConcurrency: 4,
            resolveCard: resolveRunnableCard,
            skillTouchedPaths: name => activeSkills.touchedPaths(name),
            mcpWritable: () => false,
            isBindingActive: binding => binding.sessionId === staticWorkBinding.sessionId,
            onAmbiguity: request => turnCoordinator.onAmbiguity(request),
            resolveAmbiguity: request => turnCoordinator.resolveAmbiguity(request),
            onResolutionApplied: (request, decision) =>
              turnCoordinator.onResolutionApplied(request, decision),
            resolveCapabilities: handle => resolveChildAgentCapabilityMatrix({
              card: handle.card,
              toolCatalog: TOOLS,
              activeSkills: activeSkillNames,
              activeMcpServers,
              minimumToolTiers: TOOL_MINIMUM_TIERS,
            }),
            createChild: ({ handle, task, authority: childAuthority }) => {
              const agentId = task.assignedTo ?? handle.card.name
              const selection = selectionForAgent(agentId)
              const allowedSkills = new Set(childAuthority.capabilities.skills)
              const childSkillRuntime = makeSkillPromptRuntime({
                menu: () => activeSkills.menu().filter(item => allowedSkills.has(item.name)),
                matchTriggers: request => activeSkills.matchTriggers(request)
                  .filter(name => allowedSkills.has(name)),
                loadBody: name => allowedSkills.has(name)
                  ? activeSkills.loadBody(name)
                  : Promise.resolve(''),
              })
              const shardLog: SessionLog = {
                append: (event: LogEntry) => { handle.append(event.kind, event.payload) },
                resume: () => null,
              }
              return {
                providerIdentityHash: createHash('sha256')
                  .update('aisy.durable-delegation.provider.v1\0')
                  .update(JSON.stringify([selection.provider, selection.model]))
                  .digest('hex'),
                provider: adapterFor(selection, childAuthority.capabilities.tools),
                executeTool: subAgentBaseExecutor,
                run: async ({ provider: childProvider, executeTool: childExecuteTool, signal, childSessionId }) => {
                  const subRunner = makeSubAgentRunner({
                    handle,
                    provider: childProvider,
                    baseExecuteTool: childExecuteTool,
                    approve: handle.card.name === DEFAULT_RESEARCHER_CARD.name && exactResearchApproval !== null
                      ? exactResearchApproval.approve
                      : approve,
                    memory,
                    sessionLog: shardLog,
                    parentNarrowed: untrustedContext,
                    doNotTouch: task.scope.doNotTouch,
                    budgetCheck: budgetCheckFor(agentId),
                    skillPromptRuntime: childSkillRuntime,
                    postToolUse,
                    propagateToolInterruption: error =>
                      durableDelegationRecoverableInterruptionCode(error) !== undefined ||
                      durableDelegationRecoverableRuntimeErrorCode(error) !== undefined,
                  })
                  const result = await subRunner.handle({
                    sessionId: childSessionId,
                    spans: [{ role: 'user', provenance: 'operator', text: task.intent }],
                    signal,
                  })
                  if (result.usage !== undefined) {
                    spend.record({ model: selection.model, agentId, usage: result.usage })
                  }
                  return result
                },
              }
            },
          })
          const executeForTurn: typeof mainExecuteTool = async (call, context) => {
            if (context === undefined) {
              return { ok: false, output: 'DURABLE_DELEGATION_IDENTITY_UNAVAILABLE' }
            }
            durableSpawnByContext.set(context, Object.freeze({
              dispatch: durableSpawn,
              setResearchApproval: (approval: ResearchApproval | null) => {
                exactResearchApproval = approval
              },
            }))
            try { return await mainExecuteTool(call, context) } finally {
              durableSpawnByContext.delete(context)
            }
          }
          return buildMainRunner(approve, executeForTurn)
        },
      }),
  buildGoalRunner: (approve: (action: PendingAction) => Promise<ApprovalDecision>) => {
    let done = false
    const rawGoalExec: typeof boundExecuteTool = (call, context) => {
      if (call.name === 'goal_done') {
        if (mainCapabilityRuntime &&
          !mainCapabilityRuntime.matrix.tools.some((tool) => tool.name === 'goal_done')) {
          return boundExecuteTool(call, context)
        }
        done = true
        return Promise.resolve({ ok: true as const, output: 'acknowledged' })
      }
      return boundExecuteTool(call, context)
    }
    const goalPlanProtocol = makePlanToolProtocol({
      state: planExecutionState,
      mode: () => executionMode.get(),
      reviewPlan: reviewPlanWithOperator,
      toolEffect: planToolEffect,
      execute: (call, context) => {
        const authority = nativePlanContexts.get(context)
        if (authority === undefined) return { ok: false, output: 'PLAN_EXECUTION_IDENTITY_REQUIRED' }
        return rawGoalExec(call, authority)
      },
      workBindingHash: planWorkBindingHash,
      policyRevision: 'plan-live-v1',
    })
    const goalExec: typeof boundExecuteTool = (call, context) => context === undefined
      ? Promise.resolve({ ok: false, output: 'PLAN_EXECUTION_IDENTITY_REQUIRED' })
      : goalPlanProtocol.executeAfterGate(call, planContext(context))
    const runner = makeAgentRunner({
      provider,
      memory,
      grants: modeAwareGrants,
      grantBinding: staticWorkBinding,
      executeTool: goalExec,
      preToolDispatch: (call, context) => goalPlanProtocol.preflight(call, planContext(context)),
      postToolDispatch: (call, context, result) =>
        goalPlanProtocol.observeAfterGate(call, planContext(context), result),
      approve,
      guardian: makeGuardian(),
      sessionLog,
      maxTotalToolCalls: mainCapabilityRuntime?.matrix.maxIterations ?? 50,
      budgetCheck: budgetCheckFor('main'),
      prefixExtension: promptPrefixExtension,
      augmentTurn: augmentTurnForPlan,
      ...(lateContextFromHooks === undefined ? {} : { lateContext: lateContextFromHooks }),
      postToolUse,
      toolTiers: {
        ...(mainCapabilityRuntime?.matrix.toolTiers ?? TOOL_MINIMUM_TIERS),
        ...executionMode.toolTiers(),
      },
      unsafeHostBashBypass: () => executionMode.bypassesHostBash(),
      ...(mcpCapability === null ? {} : {
        mcpCapability: {
          resolveSafetyCall: mcpCapability.capability.resolveSafetyCall,
          completeSafetyCall: mcpCapability.capability.completeSafetyCall,
        },
      }),
      ...(sessionTranscriptRecorder === undefined
        ? {}
        : { transcriptRecorder: sessionTranscriptRecorder }),
    })
    return {
      runner: mainCapabilityRuntime?.wrapRunner(runner) ?? runner,
      takeClaimedDone: () => { const d = done; done = false; return d },
    }
  },
  onGoalCommand: async (input) => {
    if (input.kind === 'status') {
      const g = orchestrator.status() ?? await goalStore.load()
      if (!g) return { ok: true as const, message: 'Активной цели нет.' }
      return {
        ok: true as const,
        message: `🎯 ${g.objective}\nРежим: ${g.mode.kind} · статус: ${g.status} · итераций: ${g.iterationsSpent}/${g.backstop.maxIterations} · $${g.usageSpent.dollars.toFixed(3)}/${g.backstop.dollarCeiling}`,
        goal: goalScreenView(g),
      }
    }
    if (input.kind === 'stop') {
      goalAbort?.abort()
      await goalStore.clear()
      return { ok: true as const, message: '⏹ Цель остановлена.' }
    }
    // start
    const mode: GoalMode | null = parseGoalMode(input.mode)
    if (!mode) return { ok: false as const, error: `Не понял режим «${input.mode}». Примеры: until, until:file:/p, every:10m, budget:0.50` }
    goalAbort?.abort()
    goalAbort = new AbortController()
    const grantedScope = (process.env['AISY_GOAL_SCOPE']?.split(',').map((s) => s.trim()).filter(Boolean)) ?? ['read_file', 'list_dir', 'search_memory']
    const spec = makeGoalSpec({ id: randomUUID(), binding: input.binding, objective: input.objective, mode, backstop: goalBackstop, grantedScope, nowIso: nowIso() })
    await goalStore.save(spec)
    if (mode.kind !== 'every') void orchestrator.start(spec, goalAbort.signal)
    return { ok: true as const, message: `🎯 Цель принята (${mode.kind}). ${mode.kind === 'every' ? 'Буду работать по расписанию.' : 'Работаю до завершения/бэкстопа. /goal status — прогресс, /goal stop — стоп.'}` }
  },
})
sendProactiveRef = sendProactive

const monitoringCoordinator = monitoringRuntime === null || monitoringWindows === null ||
  monitoringTelegramSendLedger === null
  ? null
  : makeMonitoringLiveCoordinator({
      engine: monitoringRuntime.engine,
      store: monitoringRuntime.store,
      windows: monitoringWindows,
      binding: staticWorkBinding,
      config: monitoringLiveConfig,
      nowIso,
      timeZone: operatorTimeZone,
      delivery: makeMonitoringDeliveryCoordinator({
        engine: monitoringRuntime.engine,
        nowIso,
        delivery: makeTelegramMonitoringDigestDeliveryPort({
          allowedChatId,
          output: {
            async guard({ binding, html }) {
              resolveLiveMonitoringBinding(binding)
              async function* exactPayload(): AsyncGenerator<string> { yield html }
              await gateway.streamReply(allowedChatId, exactPayload())
            },
            async sendMessage({ chatId, html, idempotencyKey }) {
              return monitoringTelegramSendLedger.send({
                idempotencyKey,
                chatId,
                html,
                transport: async () => {
                  const sent = await bot.api.sendMessage(chatId, html, {
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: true },
                  })
                  return { messageId: sent.message_id }
                },
              })
            },
          },
        }),
      }),
    })
const tickMonitoring = monitoringCoordinator === null ? undefined : async (): Promise<void> => {
  try {
    const result = await monitoringCoordinator.tick()
    if (result.collection.length > 0 || result.digest === 'created' ||
      (result.delivery?.attempted ?? 0) > 0) {
      journal.append('monitoring', 'monitor.tick_completed', {
        collection: result.collection.length,
        digest: result.digest,
        delivered: result.delivery?.delivered ?? 0,
        failed: result.delivery?.failed ?? 0,
      })
    }
  } catch {
    journal.append('monitoring', 'monitor.tick_failed', {})
    throw new Error('MONITORING_TICK_FAILED')
  }
}

// `set_goal` only asks. A goal starts working the moment it is created, so the
// mode is validated here — an unparseable one would otherwise become a card the
// operator can tap into an error.
proposeGoalRef = async ({ objective, mode }) => {
  const requested = mode ?? 'until'
  if (parseGoalMode(requested) === null) {
    return `set_goal: не понял режим «${requested}». Примеры: until, every:@daily, budget:0.50`
  }
  await proposeGoal({ objective, mode: requested })
  return 'Показал оператору карточку — возьмусь за цель, когда он подтвердит.'
}

// --- Tier-4 triggers ---
const triggerStore = makeTriggerStore({
  path: join(base, 'triggers.json'),
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c, { encoding: 'utf8', mode: 0o600 }),
  exists: (p) => existsSync(p),
})
const triggerProbe = makeTriggerProbeRunner({
  exists: (p) => existsSync(p),
})
const triggerBudget: TriggerBudget = {
  tokenCeiling: 200000,
  dollarCeiling: Number(process.env['AISY_TRIGGER_BUDGET_USD'] ?? '1') || 1,
  tokensSpent: 0,
  dollarsSpent: 0,
}
const triggerEngine = makeTriggerEngine({
  clock: { now: () => nowIso() },
  probeRunner: triggerProbe,
  startTurn: async ({ binding, prompt, spans }) => {
    const provenance = spans.some((s) => s.provenance === 'untrusted') ? 'untrusted' as const : 'operator' as const
    // Debit the global background budget so budgetExhausted() eventually bites
    // and pauses further background firings. Per-trigger spec.budget debit needs
    // store persistence and is a documented follow-up; the shared cap is the key
    // anti-drain guard for v1.
    const before = spend.total()
    await runProactiveTurn(prompt, { provenance, binding })
    const after = spend.total()
    triggerBudget.tokensSpent += Math.max(0, (after.inputTokens + after.outputTokens) - (before.inputTokens + before.outputTokens))
    triggerBudget.dollarsSpent += Math.max(0, after.dollars - before.dollars)
  },
  store: triggerStore,
  emitEvent: (event, payload) => { journal.append('triggers', event, payload) },
  globalBackgroundBudget: triggerBudget,
  timeZone: operatorTimeZone,
})

/**
 * One registration path for both authors. The operator's triggers are live the
 * moment they are made; the agent's are registered dormant and wait for the
 * card (ADR-0029), which is why `createdBy` is the only thing that differs.
 */
const registerTrigger = async (input: {
  binding: ResolvedWorkBinding
  kind: string
  prompt: string
  when?: string
  cron?: string
  probe?: string
  createdBy: 'operator' | 'agent'
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
  try {
    const budget = { tokenCeiling: 50000, dollarCeiling: 0.5, tokensSpent: 0, dollarsSpent: 0 }
    const common = {
      id: randomUUID(),
      binding: input.binding,
      createdBy: input.createdBy,
      prompt: input.prompt,
      budget,
    }
    if (input.kind === 'remind') {
      const fireAt = parseWhen(input.when)
      if (!fireAt) return { ok: false, error: 'Не понял время. Примеры: 30m, 2h, 1d, или ISO-8601.' }
      const spec = await triggerEngine.register({ ...common, kind: 'remind', fireAt })
      return { ok: true, id: spec.id }
    }
    if (input.kind === 'schedule') {
      if (!input.cron) return { ok: false, error: 'Нужно расписание: @daily, @hourly, @weekly или HH:MM.' }
      const spec = await triggerEngine.register({ ...common, kind: 'schedule', cron: input.cron })
      return { ok: true, id: spec.id }
    }
    if (input.kind !== 'watch') {
      return { ok: false, error: 'Вид таймера — remind, schedule или watch.' }
    }
    const probe = parseProbe(input.probe)
    if (!probe) return { ok: false, error: 'Не понял пробу. Примеры: file:/path, http:https://…' }
    const spec = await triggerEngine.register({
      ...common, kind: 'watch', probe, intervalMs: 60000,
    })
    return { ok: true, id: spec.id }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'ошибка' } }
}

// What `set_trigger` does: register dormant, then show the operator the card
// that turns it on. The model gets back the wording it should repeat, not a
// claim that something is already scheduled.
proposeTriggerRef = async (input) => {
  const outcome = await registerTrigger({
    ...input,
    binding: staticWorkBinding,
    createdBy: 'agent',
  })
  if (!outcome.ok) return `set_trigger: ${outcome.error}`
  const detail = input.kind === 'schedule'
    ? `Расписание: ${input.cron ?? '—'} (часовой пояс: ${operatorTimeZone || 'как на сервере'})`
    : input.kind === 'watch'
      ? `Проверяю: ${input.probe ?? '—'}`
      : `Когда: ${input.when ?? '—'}`
  await proposeTrigger({
    id: outcome.id, kind: input.kind, prompt: input.prompt, detail,
  })
  return 'Показал оператору карточку — таймер включится, когда он подтвердит.'
}

// --- Tier-7 goal orchestrator (assigned here; triggerProbe + sendProactive now in scope) ---
orchestrator = makeGoalOrchestrator({
  store: goalStore,
  runGoalTurn,
  probeRunner: triggerProbe,
  recordGrant: (tool, binding) => grants.record(tool, 'session', binding),
  sendProgress: sendProactive,
  reportProgress: (spec) => goalProgress(goalScreenView(spec)),
  clock: { now: () => nowIso() },
  emit: (event, payload) => { journal.append('goal', event, payload) },
})

// First contact and the follow-ups to it share one durable record: the greeting
// is sent once per home, and an unanswered acquaintance is picked up again at
// most three times, a day apart. Bounded on purpose — an agent that keeps asking
// the same question is worse company than one that lets it go.
const greetedPath = join(base, 'first-contact.json')
const NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_NUDGES = 3
interface FirstContactRecord { greetedAt?: string; nudges?: string[]; tourAt?: string }
function readFirstContact(): FirstContactRecord | null {
  if (!existsSync(greetedPath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(greetedPath, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed as FirstContactRecord : null
  } catch {
    return null
  }
}
function writeFirstContact(record: FirstContactRecord): void {
  writeFileSync(greetedPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
}
async function nudgeAcquaintance(): Promise<void> {
  const missing = onboardingProgress.missing()
  if (missing.length === 0) return
  const record = readFirstContact()
  // Nothing to follow up on until the greeting itself has gone out.
  if (record?.greetedAt === undefined) return
  const nudges = Array.isArray(record.nudges) ? record.nudges : []
  if (nudges.length >= MAX_NUDGES) return
  const last = Date.parse(nudges[nudges.length - 1] ?? record.greetedAt)
  if (!Number.isFinite(last) || Date.now() - last < NUDGE_INTERVAL_MS) return
  try {
    await runProactiveTurn(
      'Оператор не ответил на знакомство. Вернись к нему один раз, коротко и без ' +
      `упрёка, и спроси про одно: ${TOPIC_LABEL[missing[0]!]}.`,
      { provenance: 'operator', binding: staticWorkBinding },
    )
    // Recorded after the turn: a failed send should be retried, not counted.
    writeFirstContact({ ...record, nudges: [...nudges, nowIso()] })
  } catch (error) {
    journal.append('onboarding', 'onboarding.nudge_failed', { detail: String(error) })
  }
}

// The acquaintance ends the way it started — with the agent talking, not with a
// progress bar. It says what it understood, then one deterministic card walks
// through the menu. Both happen exactly once per home; the marker is written
// only after they go out. Checked on the scheduler tick rather than inside the
// memory commit that closed the last topic, so it never interleaves with the
// reply that turn is still streaming.
async function finishAcquaintance(): Promise<void> {
  if (onboardingProgress.missing().length > 0) return
  const record = readFirstContact()
  if (record?.greetedAt === undefined || record.tourAt !== undefined) return
  try {
    await runProactiveTurn(
      'Знакомство закончено. Подведи итог тремя короткими блоками: что ты понял ' +
      'про человека, что уже подключено и чем это делает тебя полезнее, что можно ' +
      'попросить прямо сейчас. Коротко, без списка на весь экран.',
      { provenance: 'operator', binding: staticWorkBinding },
    )
    await offerTimezone()
    await sendMenuTour()
    writeFirstContact({ ...record, tourAt: nowIso() })
  } catch (error) {
    journal.append('onboarding', 'onboarding.tour_failed', { detail: String(error) })
  }
}

// --- Scheduler: drives nightly + trigger tick (triggers wired in Phase D) ---
const lastRunPath = join(base, 'nightly-last.json')
const scheduler = makeScheduler({
  now: () => new Date(nowIso()),
  nightlyAt,
  timeZone: operatorTimeZone,
  resolveNightlyBinding,
  lastNightlyRun: () => {
    try {
      return (JSON.parse(readFileSync(lastRunPath, 'utf8')) as { date?: string }).date ?? null
    } catch {
      return null
    }
  },
  markNightlyRun: (date) => {
    try {
      writeFileSync(lastRunPath, JSON.stringify({ date }), { encoding: 'utf8', mode: 0o600 })
    } catch { /* non-fatal */ }
  },
  runNightly,
  tickTriggers: async () => {
    await triggerEngine.tick()
    // Closing an expired door is the runtime's own call and needs no approval.
    try { await serverAccess.expire() } catch { /* the loop must survive */ }
    await nudgeAcquaintance()
    await finishAcquaintance()
  },
  tickGoal: (() => {
    let lastGoalTick = 0
    return async () => {
      const g = await goalStore.load()
      if (g?.mode.kind !== 'every' || g.status !== 'active') return
      const intervalMs = (g.mode as { kind: 'every'; intervalMs?: number }).intervalMs ?? 600_000
      if ((Date.now() - lastGoalTick) < intervalMs) return
      if (!goalAbort) return
      lastGoalTick = Date.now()
      await orchestrator.tick(goalAbort.signal)
    }
  })(),
  ...(tickMonitoring === undefined ? {} : { tickMonitoring }),
})

// Durable foreground recovery precedes every scheduler/goal/forward action.
// A pending card keeps the installation cardinality-one until its callback
// triggers a supervised restart and exact parent replay.
goalAbort = new AbortController()
if (startupDelegationRecoveryPending && durableTurnState !== null) {
  const loaded = durableTurnState.continuation.load()
  if (loaded.status !== 'ready' || startupRecoveryLease === null ||
    !startupRecoveryLease.isHeld()) {
    throw new Error('DURABLE_PARENT_CONTINUATION_RECOVERY_UNAVAILABLE')
  }
  durableTurnState.setLease(startupRecoveryLease)
  const coordinator = durableTurnState.ensureCoordinator()
  if (loaded.record.phase === 'terminal') {
    if (loaded.record.cancellationReceiptHash === undefined) {
      throw new Error('DURABLE_PARENT_CONTINUATION_RECOVERY_UNAVAILABLE')
    }
    coordinator.requestStop()
    startupDelegationRecoveryPending = false
    await recoverExecutionCheckpointBeforeExternalIo()
  } else {
    const recovery = coordinator.recover()
    if (recovery.kind === 'cancelling') {
      coordinator.requestStop()
      startupDelegationRecoveryPending = false
      await recoverExecutionCheckpointBeforeExternalIo()
    } else if (recovery.kind === 'card-pending' || recovery.kind === 'awaiting-decision') {
      if (!await recoverDurableTurnCard()) {
        throw new Error('DURABLE_TURN_CARD_RECOVERY_UNAVAILABLE')
      }
    } else {
      const replayed = await resumeDurableTurn({
        turnId: loaded.record.identity.turnId,
        turnTs: loaded.record.identity.turnTs,
        spans: loaded.record.identity.spans,
      })
      if (!replayed) throw new Error('DURABLE_PARENT_CONTINUATION_REPLAY_FAILED')
      startupDelegationRecoveryPending = false
    }
  }
}
if (!startupDelegationRecoveryPending) {
  startUpdateCheck()
  scheduler.start()
  await orchestrator.resume(goalAbort.signal)
  await resumeForwardBatch()
}

// Single exit path: every way this process can end must release the journal
// lease and the inbox writer lock. A lock left behind is never reclaimed by age
// or PID, so a crash would silently disable attachments on the next run.
let shuttingDown = false
const shutdown = (code: number, reason?: unknown): never => {
  if (!shuttingDown) {
    shuttingDown = true
    try { codexSubscriptionRuntime?.close() } catch { /* best effort on the way out */ }
    try { releaseJournalLease() } catch { /* best effort on the way out */ }
    try { mediaInbox?.close() } catch { /* an in-flight ingest keeps the lock */ }
  }
  if (reason !== undefined) {
    process.stderr.write(`aisy run: остановлен из-за ошибки: ${String(reason)}\n`)
  }
  process.exit(code)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => shutdown(0))
}
// A polling or handler fault must not become an unhandled rejection: the
// supervisor can only restart a process that exits, and it must exit clean.
process.once('uncaughtException', (error) => shutdown(70, error))
process.once('unhandledRejection', (reason) => shutdown(70, reason))

// First contact. After the brain is connected the operator should not have to
// discover that they must type /start — the agent opens the conversation, the
// same way it does for every later proactive turn.
//
// Two conditions, both meaningful: the greeting has never been sent from this
// home, and Aisy has not met the operator yet. The marker is written only after
// the turn goes out, so a crash on the way retries at the next start.
if (readFirstContact() === null && onboardingBrief() !== null) {
  setTimeout(() => {
    void (async () => {
      try {
        // The menu rides on the greeting itself, so the first message the
        // operator ever gets already has the keyboard under it.
        armMainMenu()
        await runProactiveTurn(
          'Ты только что подключён и пишешь первым. Поздоровайся, назовись, ' +
          'в двух-трёх предложениях скажи, что умеешь и как тобой пользоваться ' +
          '(меню внизу, голосом тоже можно), и начни знакомство с одного вопроса: ' +
          'пусть человек либо расскажет о себе сам, либо даст ссылку на свой канал ' +
          'или страницу — ты её прочитаешь. Про ключи и сервисы не пиши: сразу за ' +
          'твоим сообщением придёт карточка с кнопками.',
          { provenance: 'operator', binding: staticWorkBinding },
        )
        writeFirstContact({ greetedAt: nowIso() })
        await offerServiceKeys()
      } catch (error) {
        journal.append('onboarding', 'onboarding.greeting_failed', { detail: String(error) })
      }
    })()
  }, 3_000).unref()
}

process.stdout.write(`aisy run: starting Telegram agent (chat ${allowedChatId}, model ${modelLabel})…\n`)
bot.start().catch((error: unknown) => shutdown(70, error))
