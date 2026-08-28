// Parent process that owns execution-recovery authority (ADR-0071).
//
// It understands only versioned IPC control frames and opaque hashes. It never
// receives model output, Telegram content or credentials, and never starts a
// second child before the previous child's exit has been observed.

import { randomBytes } from 'node:crypto'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'

import {
  EXECUTION_SUPERVISOR_PROTOCOL_VERSION,
  EXECUTION_SUPERVISOR_SELECTOR_ENV,
  encodeExecutionSupervisorFrame,
  makeExecutionSupervisorReleaseReceiptHash,
  makeExecutionSupervisorSessionProof,
  makeNodeExecutionSupervisorChildChannel,
  parseExecutionSupervisorFrame,
  type ExecutionSupervisorChannel,
  type ExecutionSupervisorFrame,
  type ExecutionSupervisorRefusalCode,
} from './execution-supervisor-ipc.js'
import {
  EXECUTION_SUPERVISOR_LIVENESS_ENV,
  encodeExecutionSupervisorChildLivenessDescriptor,
  type ExecutionSupervisorChildLivenessLease,
} from './execution-supervisor-liveness.js'
import {
  makeExecutionSupervisorState,
  migrateExecutionSupervisorStateV1,
  withExecutionSupervisorStateChecksum,
  type ExecutionSupervisorManagerLease,
  type ExecutionSupervisorQuarantineCode,
  type ExecutionSupervisorStateStore,
  type ExecutionSupervisorReleaseReceiptV1,
  type ExecutionSupervisorStateV2,
} from './supervisor-state.js'
import { withoutChildOwnedDockerEnv } from './execution-docker-startup-policy.js'
import {
  isNodeOwnedDockerParentRecoveryManager,
  type NodeOwnedDockerParentRecoveryManager,
} from './owned-docker-parent-recovery-manager.js'
import {
  isVoiceBrokerNativePort,
  withVoiceMediaDescriptor,
  type VoiceBrokerNativePort,
} from './voice-broker-native.js'

export const AISY_PLANNED_RESTART_EXIT_CODE = 75 as const
export const EXECUTION_SUPERVISOR_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const
export const EXECUTION_SUPERVISOR_CRASH_WINDOW_MS = 300_000
export const EXECUTION_SUPERVISOR_CRASH_BUDGET = 5
export const EXECUTION_SUPERVISOR_STABLE_RUN_MS = 120_000

const MAX_PROTOCOL_DEADLINE_MS = 60_000
const MAX_VOICE_DISPATCH_DEADLINE_MS = 120_000
const PLANNED_RESTART_DELAY_MS = 250
const IDLE_CHANNEL_WAIT_MS = 2_147_000_000

/**
 * Backoff is part of the parent supervisor's liveness contract. The timer must
 * stay referenced: between children it can be the process's only active handle.
 */
export async function sleepExecutionSupervisorDelay(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    // Close the narrow race where abort happens after the first check but
    // before the listener is registered.
    if (signal.aborted) done()
  })
}

export interface ExecutionSupervisorChildSpawn {
  execPath: string
  binPath: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
}

export interface ExecutionSupervisorChildExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface ExecutionSupervisorChildProcess {
  readonly instanceId: string
  readonly channel: ExecutionSupervisorChannel
  readonly started: Promise<{ kind: 'spawned' } | { kind: 'spawn-failed' }>
  readonly exited: Promise<ExecutionSupervisorChildExit>
  terminate(signal: 'SIGTERM' | 'SIGKILL'): void
}

export interface ExecutionSupervisorSpawnPort {
  spawn(input: ExecutionSupervisorChildSpawn): ExecutionSupervisorChildProcess
}

function randomOpaqueId(): string {
  return randomBytes(32).toString('base64url')
}

export function makeNodeExecutionSupervisorSpawnPort(): ExecutionSupervisorSpawnPort {
  return {
    spawn(input) {
      const child: ChildProcess = nodeSpawn(input.execPath, [input.binPath, ...input.args], {
        env: { ...input.env },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
      const started = new Promise<{ kind: 'spawned' } | { kind: 'spawn-failed' }>((resolve) => {
        let spawned = false
        child.once('spawn', () => {
          spawned = true
          resolve({ kind: 'spawned' })
        })
        child.once('error', () => {
          if (!spawned) resolve({ kind: 'spawn-failed' })
        })
      })
      const exited = new Promise<ExecutionSupervisorChildExit>((resolve) => {
        child.once('exit', (code, signal) => resolve({
          code,
          signal: signal as NodeJS.Signals | null,
        }))
      })
      return {
        instanceId: randomOpaqueId(),
        channel: makeNodeExecutionSupervisorChildChannel(child),
        started,
        exited,
        terminate(signal) {
          try { child.kill(signal) } catch { /* exit observation remains authoritative */ }
        },
      }
    },
  }
}

export type ExecutionParentSupervisorPhase =
  | 'starting'
  | 'handshaking'
  | 'running'
  | 'backoff'
  | 'quarantined'
  | 'stopping'
  | 'stopped'

export interface ExecutionParentSupervisorStatus {
  phase: ExecutionParentSupervisorPhase
  childInstanceId: string | null
  consecutiveUnexpectedExits: number
  nextDelayMs: number | null
  quarantineCode: ExecutionSupervisorQuarantineCode | null
}

export type ExecutionParentSupervisorRunResult =
  | { kind: 'stopped' }
  | { kind: 'quarantined'; code: ExecutionSupervisorQuarantineCode }

export interface ExecutionParentSupervisor {
  run(signal: AbortSignal): Promise<ExecutionParentSupervisorRunResult>
  status(): Readonly<ExecutionParentSupervisorStatus>
}

export interface ExecutionParentSupervisorDeps {
  execPath: string
  binPath: string
  childArgs?: readonly string[]
  childEnv: Readonly<Record<string, string>>
  spawn: ExecutionSupervisorSpawnPort
  state: ExecutionSupervisorStateStore
  nowMs: () => number
  newId: () => string
  randomNonce: () => string
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  /** Dormant ADR-0089 gate. When present it must be the genuine Node manager. */
  ownedDockerManager?: unknown
  /** Dormant secure voice proxy. Structural adapters cannot activate the parent relay. */
  voice?: Readonly<{ mediaRoot: string; bridge: unknown }>
  onQuarantine?: (code: ExecutionSupervisorQuarantineCode) => void
  handshakeTimeoutMs?: number
  stopTimeoutMs?: number
}

class SupervisorProtocolError extends Error {}

interface ActiveChildSession {
  sessionId: string
  runLivenessHash: string
  usedRequestIds: Set<string>
  plannedPermit: null | {
    intentHash: string
    deadlineAtMs: number
  }
  voiceTickets: Map<string, string>
  voicePermits: Map<string, string>
}

function requestId(id: string): string {
  return `req_${id}`.slice(0, 64)
}

function isRequestCurrent(frame: ExecutionSupervisorFrame, nowMs: number): boolean {
  const maximum = frame.type === 'voice-dispatch' || frame.type === 'voice-dispatch-ack'
    ? MAX_VOICE_DISPATCH_DEADLINE_MS
    : MAX_PROTOCOL_DEADLINE_MS
  return frame.deadlineAtMs > nowMs && frame.deadlineAtMs <= nowMs + maximum
}

function nextState(
  state: ExecutionSupervisorStateV2,
  update: Omit<ExecutionSupervisorStateV2, 'schemaVersion' | 'revision' | 'checksum' |
  'releaseReceipt'> & { releaseReceipt?: ExecutionSupervisorReleaseReceiptV1 | null },
): ExecutionSupervisorStateV2 {
  return withExecutionSupervisorStateChecksum({
    schemaVersion: 2,
    revision: state.revision + 1,
    manager: update.manager,
    authority: update.authority,
    releaseReceipt: update.releaseReceipt === undefined
      ? state.releaseReceipt
      : update.releaseReceipt,
    restart: update.restart,
  }) as ExecutionSupervisorStateV2
}

function safeClose(channel: ExecutionSupervisorChannel): void {
  try { channel.close() } catch { /* protocol failure remains code-only */ }
}

function refusal(
  frame: ExecutionSupervisorFrame & { sessionId: string },
  code: ExecutionSupervisorRefusalCode,
): ExecutionSupervisorFrame {
  return {
    version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION,
    type: 'refusal',
    requestId: frame.requestId,
    deadlineAtMs: frame.deadlineAtMs,
    sessionId: frame.sessionId,
    code,
  }
}

async function receiveFrame(channel: ExecutionSupervisorChannel, timeoutMs: number): Promise<ExecutionSupervisorFrame> {
  const parsed = parseExecutionSupervisorFrame(await channel.receive(timeoutMs))
  if (!parsed.ok) throw new SupervisorProtocolError()
  return parsed.frame
}

async function waitForExit(
  child: ExecutionSupervisorChildProcess,
  timeoutMs: number,
): Promise<ExecutionSupervisorChildExit | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      child.exited,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export function makeExecutionParentSupervisor(
  deps: ExecutionParentSupervisorDeps,
): ExecutionParentSupervisor {
  const handshakeTimeoutMs = deps.handshakeTimeoutMs ?? 2_000
  const stopTimeoutMs = deps.stopTimeoutMs ?? 10_000
  const childEnv = withoutChildOwnedDockerEnv(deps.childEnv)
  const ownedDockerManager: NodeOwnedDockerParentRecoveryManager | null =
    deps.ownedDockerManager === undefined
      ? null
      : isNodeOwnedDockerParentRecoveryManager(deps.ownedDockerManager)
        ? deps.ownedDockerManager
        : (() => { throw new Error('INVALID_OWNED_DOCKER_PARENT_MANAGER') })()
  const voice: Readonly<{ mediaRoot: string; bridge: VoiceBrokerNativePort }> | null =
    deps.voice === undefined
      ? null
      : isVoiceBrokerNativePort(deps.voice.bridge)
        ? Object.freeze({ mediaRoot: deps.voice.mediaRoot, bridge: deps.voice.bridge })
        : (() => { throw new Error('INVALID_VOICE_BROKER_BRIDGE') })()
  if (!Number.isInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 100 || handshakeTimeoutMs > 60_000 ||
    !Number.isInteger(stopTimeoutMs) || stopTimeoutMs < 100 || stopTimeoutMs > 60_000) {
    throw new Error('INVALID_EXECUTION_SUPERVISOR_CONFIG')
  }

  let running = false
  let state: ExecutionSupervisorStateV2 | null = null
  let activeChild: ExecutionSupervisorChildProcess | null = null
  let activeManagerLease: ExecutionSupervisorManagerLease | null = null
  let activeChildFence: ExecutionSupervisorChildLivenessLease | null = null
  let quarantineReported = false
  let terminalQuarantine = false
  let status: ExecutionParentSupervisorStatus = {
    phase: 'starting',
    childInstanceId: null,
    consecutiveUnexpectedExits: 0,
    nextDelayMs: null,
    quarantineCode: null,
  }

  const setStatus = (patch: Partial<ExecutionParentSupervisorStatus>): void => {
    status = { ...status, ...patch }
  }

  const publish = (
    update: Omit<ExecutionSupervisorStateV2, 'schemaVersion' | 'revision' | 'checksum' |
    'releaseReceipt'> & { releaseReceipt?: ExecutionSupervisorReleaseReceiptV1 | null },
  ): void => {
    if (state === null) throw new SupervisorProtocolError()
    if (activeManagerLease === null || !activeManagerLease.isHeld()) {
      throw new SupervisorProtocolError()
    }
    const candidate = nextState(state, update)
    deps.state.publish(candidate)
    state = candidate
    setStatus({ consecutiveUnexpectedExits: candidate.restart.consecutiveUnexpectedExits })
  }

  const setQuarantine = (
    code: ExecutionSupervisorQuarantineCode,
    durable: boolean,
  ): ExecutionSupervisorQuarantineCode => {
    if (durable && state !== null) {
      try {
        publish({
          manager: state.manager,
          authority: state.authority,
          restart: {
            ...state.restart,
            quarantine: { code, atMs: deps.nowMs() },
          },
        })
      } catch {
        code = 'SUPERVISOR_STATE_UNAVAILABLE'
      }
    }
    setStatus({
      phase: 'quarantined',
      childInstanceId: null,
      nextDelayMs: null,
      quarantineCode: code,
    })
    if (!quarantineReported) {
      quarantineReported = true
      try { deps.onQuarantine?.(code) } catch { /* observability never changes supervision */ }
    }
    return code
  }

  const handshake = async (
    child: ExecutionSupervisorChildProcess,
    expectedLivenessDescriptorHash: string,
  ): Promise<ActiveChildSession> => {
    const now = deps.nowMs()
    const helloRequestId = requestId(deps.newId())
    const parentNonce = deps.randomNonce()
    const deadlineAtMs = now + handshakeTimeoutMs
    child.channel.send(encodeExecutionSupervisorFrame({
      version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION,
      type: 'hello-challenge',
      requestId: helloRequestId,
      deadlineAtMs,
      parentNonce,
    }))
    const hello = await receiveFrame(child.channel, handshakeTimeoutMs)
    if (hello.type !== 'hello' || hello.requestId !== helloRequestId ||
      hello.deadlineAtMs !== deadlineAtMs || hello.parentNonce !== parentNonce ||
      hello.livenessDescriptorHash !== expectedLivenessDescriptorHash ||
      deps.nowMs() >= deadlineAtMs) throw new SupervisorProtocolError()
    const sessionId = deps.newId()
    child.channel.send(encodeExecutionSupervisorFrame({
      version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION,
      type: 'hello-ack',
      requestId: helloRequestId,
      deadlineAtMs,
      sessionId,
      sessionProof: makeExecutionSupervisorSessionProof({
        requestId: helloRequestId,
        parentNonce,
        childNonce: hello.childNonce,
        sessionId,
        livenessDescriptorHash: expectedLivenessDescriptorHash,
      }),
    }))

    const recovery = await receiveFrame(child.channel, handshakeTimeoutMs)
    if (recovery.type !== 'recovery-request' || recovery.sessionId !== sessionId ||
      recovery.requestId === helloRequestId || !isRequestCurrent(recovery, deps.nowMs())) {
      throw new SupervisorProtocolError()
    }
    if (state === null) throw new SupervisorProtocolError()
    if (state.authority !== null) {
      const leaseId = deps.newId()
      const bindingHash = state.authority.bindingHash
      const authorityPhase = state.authority.phase === 'recovery-leased'
        ? state.authority.authorityPhase
        : state.authority.phase
      publish({
        manager: state.manager,
        authority: {
          phase: 'recovery-leased',
          authorityPhase,
          bindingHash,
          leaseId,
          leasedToSessionId: sessionId,
          leasedAtMs: deps.nowMs(),
        },
        restart: state.restart,
      })
      child.channel.send(encodeExecutionSupervisorFrame({
        version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION,
        type: 'recovery-lease',
        requestId: recovery.requestId,
        deadlineAtMs: recovery.deadlineAtMs,
        sessionId,
        bindingHash,
        leaseId,
        authorityPhase,
        releaseReceipt: null,
      }))
    } else {
      child.channel.send(encodeExecutionSupervisorFrame({
        version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION,
        type: 'recovery-lease',
        requestId: recovery.requestId,
        deadlineAtMs: recovery.deadlineAtMs,
        sessionId,
        bindingHash: null,
        leaseId: null,
        authorityPhase: null,
        releaseReceipt: state.releaseReceipt,
      }))
    }
    return {
      sessionId,
      runLivenessHash: expectedLivenessDescriptorHash,
      usedRequestIds: new Set([helloRequestId, recovery.requestId]),
      plannedPermit: null,
      voiceTickets: new Map(),
      voicePermits: new Map(),
    }
  }

  const handleRequest = async (
    child: ExecutionSupervisorChildProcess,
    frame: ExecutionSupervisorFrame,
    session: ActiveChildSession,
  ): Promise<void> => {
    const now = deps.nowMs()
    if (!('sessionId' in frame) || frame.sessionId !== session.sessionId ||
      session.usedRequestIds.has(frame.requestId) || !isRequestCurrent(frame, now)) {
      throw new SupervisorProtocolError()
    }
    if (session.usedRequestIds.size >= 256) throw new SupervisorProtocolError()
    session.usedRequestIds.add(frame.requestId)
    if (state === null) throw new SupervisorProtocolError()

    if (frame.type === 'voice-stage') {
      if (voice === null || !voice.bridge.isHeld()) {
        child.channel.send(encodeExecutionSupervisorFrame({
          version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION, type: 'voice-stage-ack',
          requestId: frame.requestId, deadlineAtMs: frame.deadlineAtMs,
          sessionId: session.sessionId, mediaBindingHash: frame.mediaBindingHash,
          ok: false, mediaTicket: null, code: 'BACKEND_UNAVAILABLE',
        }))
        return
      }
      let result: Awaited<ReturnType<VoiceBrokerNativePort['stageMedia']>>
      try {
        result = await withVoiceMediaDescriptor({
          mediaRoot: voice.mediaRoot,
          relativePath: frame.relativePath,
          expectedSha256: frame.expectedSha256,
          expectedSizeBytes: frame.expectedSizeBytes,
          maxBytes: frame.maxBytes,
          use: descriptor => voice.bridge.stageMedia({
            descriptor,
            mediaBindingHash: frame.mediaBindingHash,
            expectedSha256: frame.expectedSha256,
            expectedSizeBytes: frame.expectedSizeBytes,
            maxBytes: frame.maxBytes,
            contentType: frame.contentType,
            language: frame.language,
          }),
        })
      } catch {
        result = { ok: false, code: 'BACKEND_UNAVAILABLE' }
      }
      if (result.ok) session.voiceTickets.set(result.mediaTicket, frame.mediaBindingHash)
      child.channel.send(encodeExecutionSupervisorFrame({
        version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION, type: 'voice-stage-ack',
        requestId: frame.requestId, deadlineAtMs: frame.deadlineAtMs,
        sessionId: session.sessionId, mediaBindingHash: frame.mediaBindingHash,
        ok: result.ok, mediaTicket: result.ok ? result.mediaTicket : null,
        code: result.ok ? null : result.code,
      }))
      return
    }

    if (frame.type === 'voice-cancel-media') {
      const exact = session.voiceTickets.get(frame.mediaTicket) === frame.mediaBindingHash
      if (!exact || voice === null || !voice.bridge.isHeld()) {
        child.channel.send(encodeExecutionSupervisorFrame({
          version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION, type: 'voice-cancel-media-ack',
          requestId: frame.requestId, deadlineAtMs: frame.deadlineAtMs,
          sessionId: session.sessionId, mediaBindingHash: frame.mediaBindingHash,
          ok: false, code: 'PROTOCOL_REFUSED',
        }))
        return
      }
      session.voiceTickets.delete(frame.mediaTicket)
      let cancelled = false
      try { cancelled = await voice.bridge.cancelMedia({ mediaTicket: frame.mediaTicket }) } catch {}
      child.channel.send(encodeExecutionSupervisorFrame({
        version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION, type: 'voice-cancel-media-ack',
        requestId: frame.requestId, deadlineAtMs: frame.deadlineAtMs,
        sessionId: session.sessionId, mediaBindingHash: frame.mediaBindingHash,
        ok: cancelled, code: cancelled ? null : 'BACKEND_UNAVAILABLE',
      }))
      return
    }

    if (frame.type === 'voice-prepare') {
      const exact = session.voiceTickets.get(frame.mediaTicket) === frame.mediaBindingHash
      if (!exact || voice === null || !voice.bridge.isHeld()) {
        child.channel.send(encodeExecutionSupervisorFrame({
          version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION, type: 'voice-prepare-ack',
          requestId: frame.requestId, deadlineAtMs: frame.deadlineAtMs,
          sessionId: session.sessionId, mediaBindingHash: frame.mediaBindingHash,
          ok: false, dispatchPermitId: null, code: 'PROTOCOL_REFUSED',
        }))
        return
      }
      let result: Awaited<ReturnType<VoiceBrokerNativePort['prepare']>>
      try {
        result = await voice.bridge.prepare({
          mediaTicket: frame.mediaTicket,
          reservationRecoveryKey: frame.reservationRecoveryKey,
        })
      } catch { result = { ok: false, code: 'BACKEND_UNAVAILABLE' } }
      if (result.ok) {
        session.voiceTickets.delete(frame.mediaTicket)
        session.voicePermits.set(result.dispatchPermitId, frame.mediaBindingHash)
      }
      child.channel.send(encodeExecutionSupervisorFrame({
        version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION, type: 'voice-prepare-ack',
        requestId: frame.requestId, deadlineAtMs: frame.deadlineAtMs,
        sessionId: session.sessionId, mediaBindingHash: frame.mediaBindingHash,
        ok: result.ok, dispatchPermitId: result.ok ? result.dispatchPermitId : null,
        code: result.ok ? null : result.code,
      }))
      return
    }

    if (frame.type === 'voice-cancel-prepared') {
      const exact = session.voicePermits.get(frame.dispatchPermitId) === frame.mediaBindingHash
      session.voicePermits.delete(frame.dispatchPermitId)
      let outcome: 'cancelled' | 'claimed' | 'ambiguous' = 'ambiguous'
      if (exact && voice !== null && voice.bridge.isHeld()) {
        try { outcome = await voice.bridge.cancelPrepared({
          dispatchPermitId: frame.dispatchPermitId,
        }) } catch {}
      }
      child.channel.send(encodeExecutionSupervisorFrame({
        version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION, type: 'voice-cancel-prepared-ack',
        requestId: frame.requestId, deadlineAtMs: frame.deadlineAtMs,
        sessionId: session.sessionId, mediaBindingHash: frame.mediaBindingHash, outcome,
      }))
      return
    }

    if (frame.type === 'voice-dispatch') {
      const exact = session.voicePermits.get(frame.dispatchPermitId) === frame.mediaBindingHash
      session.voicePermits.delete(frame.dispatchPermitId)
      if (!exact || voice === null || !voice.bridge.isHeld()) {
        child.channel.send(encodeExecutionSupervisorFrame({
          version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION, type: 'voice-dispatch-ack',
          requestId: frame.requestId, deadlineAtMs: frame.deadlineAtMs,
          sessionId: session.sessionId, mediaBindingHash: frame.mediaBindingHash,
          ok: false, transcript: null, language: null, durationMs: null,
          code: 'PROTOCOL_REFUSED', dispatch: 'none',
        }))
        return
      }
      let result: Awaited<ReturnType<VoiceBrokerNativePort['dispatch']>>
      try { result = await voice.bridge.dispatch({ dispatchPermitId: frame.dispatchPermitId }) } catch {
        result = { ok: false, code: 'UPSTREAM_UNAVAILABLE', dispatch: 'attempted' }
      }
      child.channel.send(encodeExecutionSupervisorFrame({
        version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION, type: 'voice-dispatch-ack',
        requestId: frame.requestId, deadlineAtMs: frame.deadlineAtMs,
        sessionId: session.sessionId, mediaBindingHash: frame.mediaBindingHash,
        ok: result.ok,
        transcript: result.ok ? result.transcript : null,
        language: result.ok ? result.language ?? null : null,
        durationMs: result.ok ? result.durationMs : null,
        code: result.ok ? null : result.code,
        dispatch: result.ok ? null : result.dispatch,
      }))
      return
    }

    if (frame.type === 'planned-restart') {
      if (session.plannedPermit !== null && session.plannedPermit.deadlineAtMs > now) {
        child.channel.send(encodeExecutionSupervisorFrame(refusal(frame, 'AUTHORITY_BUSY')))
        return
      }
      session.plannedPermit = {
        intentHash: frame.intentHash,
        deadlineAtMs: frame.deadlineAtMs,
      }
      child.channel.send(encodeExecutionSupervisorFrame({
        version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION,
        type: 'planned-restart-ack',
        requestId: frame.requestId,
        deadlineAtMs: frame.deadlineAtMs,
        sessionId: session.sessionId,
        intentHash: frame.intentHash,
      }))
      return
    }

    if (frame.type === 'capture') {
      if (state.authority !== null || state.releaseReceipt !== null) {
        child.channel.send(encodeExecutionSupervisorFrame(refusal(frame, 'AUTHORITY_BUSY')))
        return
      }
      const leaseId = deps.newId()
      publish({
        manager: state.manager,
        authority: {
          phase: 'captured-unbound',
          bindingHash: frame.bindingHash,
          leaseId,
          capturedAtMs: deps.nowMs(),
        },
        restart: state.restart,
      })
      child.channel.send(encodeExecutionSupervisorFrame({
        version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION,
        type: 'capture-ack',
        requestId: frame.requestId,
        deadlineAtMs: frame.deadlineAtMs,
        sessionId: session.sessionId,
        bindingHash: frame.bindingHash,
        leaseId,
      }))
      return
    }

    if (frame.type === 'checkpoint-bound') {
      const authority = state.authority
      const exact = authority?.phase === 'captured-unbound' &&
        authority.bindingHash === frame.bindingHash && authority.leaseId === frame.leaseId
      if (!exact) {
        child.channel.send(encodeExecutionSupervisorFrame(refusal(frame, 'AUTHORITY_MISMATCH')))
        return
      }
      publish({
        manager: state.manager,
        authority: {
          phase: 'checkpoint-bound',
          bindingHash: authority.bindingHash,
          leaseId: authority.leaseId,
          capturedAtMs: authority.capturedAtMs,
          boundAtMs: deps.nowMs(),
        },
        restart: state.restart,
      })
      child.channel.send(encodeExecutionSupervisorFrame({
        version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION,
        type: 'checkpoint-bound-ack',
        requestId: frame.requestId,
        deadlineAtMs: frame.deadlineAtMs,
        sessionId: session.sessionId,
        bindingHash: frame.bindingHash,
        leaseId: frame.leaseId,
      }))
      return
    }

    if (frame.type === 'release') {
      const authority = state.authority
      const exact = authority !== null && authority.bindingHash === frame.bindingHash &&
        authority.leaseId === frame.leaseId &&
        (authority.phase !== 'recovery-leased' || authority.leasedToSessionId === session.sessionId)
      if (!exact) {
        child.channel.send(encodeExecutionSupervisorFrame(refusal(frame, 'AUTHORITY_MISMATCH')))
        return
      }
      publish({
        manager: state.manager,
        authority: null,
        restart: state.restart,
      })
      child.channel.send(encodeExecutionSupervisorFrame({
        version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION,
        type: 'release-ack',
        requestId: frame.requestId,
        deadlineAtMs: frame.deadlineAtMs,
        sessionId: session.sessionId,
        bindingHash: frame.bindingHash,
        leaseId: frame.leaseId,
      }))
      return
    }

    if (frame.type === 'release-durable') {
      const authority = state.authority
      const exact = authority !== null && authority.bindingHash === frame.bindingHash &&
        authority.leaseId === frame.leaseId &&
        (authority.phase !== 'recovery-leased' || authority.leasedToSessionId === session.sessionId)
      if (!exact) {
        child.channel.send(encodeExecutionSupervisorFrame(refusal(frame, 'AUTHORITY_MISMATCH')))
        return
      }
      const authorityPhase = authority.phase === 'recovery-leased'
        ? authority.authorityPhase
        : authority.phase
      const authorityAtMs = authority.phase === 'captured-unbound'
        ? authority.capturedAtMs
        : authority.phase === 'checkpoint-bound'
          ? authority.boundAtMs
          : authority.leasedAtMs
      const releasedAtMs = deps.nowMs()
      if (releasedAtMs < Math.max(state.manager.startedAtMs, authorityAtMs)) {
        throw new SupervisorProtocolError()
      }
      const releaseReceipt: ExecutionSupervisorReleaseReceiptV1 = Object.freeze({
        releaseIntentHash: frame.releaseIntentHash,
        envelopeHash: frame.envelopeHash,
        receiptHash: makeExecutionSupervisorReleaseReceiptHash({
          releaseIntentHash: frame.releaseIntentHash,
          envelopeHash: frame.envelopeHash,
          bindingHash: frame.bindingHash,
          runLivenessHash: session.runLivenessHash,
          authorityPhase,
          leaseId: frame.leaseId,
          releasedAtMs,
        }),
        bindingHash: frame.bindingHash,
        runLivenessHash: session.runLivenessHash,
        authorityPhase,
        releasedAtMs,
      })
      publish({
        manager: state.manager,
        authority: null,
        releaseReceipt,
        restart: state.restart,
      })
      child.channel.send(encodeExecutionSupervisorFrame({
        version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION,
        type: 'release-durable-ack',
        requestId: frame.requestId,
        deadlineAtMs: frame.deadlineAtMs,
        sessionId: session.sessionId,
        receipt: releaseReceipt,
      }))
      return
    }

    if (frame.type === 'release-receipt-consumed') {
      const receipt = state.releaseReceipt
      if (state.authority !== null || receipt === null ||
        receipt.envelopeHash !== frame.envelopeHash ||
        receipt.releaseIntentHash !== frame.releaseIntentHash ||
        receipt.receiptHash !== frame.receiptHash) {
        child.channel.send(encodeExecutionSupervisorFrame(refusal(frame, 'AUTHORITY_MISMATCH')))
        return
      }
      publish({
        manager: state.manager,
        authority: null,
        releaseReceipt: null,
        restart: state.restart,
      })
      child.channel.send(encodeExecutionSupervisorFrame({
        version: EXECUTION_SUPERVISOR_PROTOCOL_VERSION,
        type: 'release-receipt-consumed-ack',
        requestId: frame.requestId,
        deadlineAtMs: frame.deadlineAtMs,
        sessionId: session.sessionId,
        envelopeHash: frame.envelopeHash,
        releaseIntentHash: frame.releaseIntentHash,
        receiptHash: frame.receiptHash,
      }))
      return
    }
    throw new SupervisorProtocolError()
  }

  const serveUntilExit = async (
    child: ExecutionSupervisorChildProcess,
    session: ActiveChildSession,
    signal: AbortSignal,
  ): Promise<ExecutionSupervisorChildExit | null> => {
    let disconnected = false
    let stopWaiting!: () => void
    const aborted = new Promise<{ kind: 'abort' }>((resolve) => {
      stopWaiting = () => resolve({ kind: 'abort' })
      if (signal.aborted) stopWaiting()
      else signal.addEventListener('abort', stopWaiting, { once: true })
    })
    const removeDisconnect = child.channel.onDisconnect(() => { disconnected = true })
    try {
      while (true) {
        const event = await Promise.race([
          child.exited.then((exit) => ({ kind: 'exit' as const, exit })),
          aborted,
          // No protocol request is expected merely because the child is idle.
          // Request deadlines are validated on received frames; this wait only
          // ends for an actual frame, disconnect or child exit.
          child.channel.receive(IDLE_CHANNEL_WAIT_MS)
            .then((raw) => ({ kind: 'frame' as const, raw }))
            .catch(() => ({ kind: 'receive-failed' as const })),
        ])
        if (event.kind === 'exit') return event.exit
        if (event.kind === 'abort') return null
        if (event.kind === 'receive-failed') {
          if (disconnected) {
            // Node may report IPC disconnect just before the process exit. A
            // previously ACKed permit gives that exact child only a bounded
            // opportunity to prove its real exit; no permit means immediate
            // protocol failure and termination by the caller.
            const permit = session.plannedPermit
            if (permit === null) throw new SupervisorProtocolError()
            const remaining = permit.deadlineAtMs - deps.nowMs()
            if (remaining <= 0) throw new SupervisorProtocolError()
            const exit = await waitForExit(child, Math.min(stopTimeoutMs, remaining))
            if (exit === null) throw new SupervisorProtocolError()
            return exit
          }
          continue
        }
        const parsed = parseExecutionSupervisorFrame(event.raw)
        if (!parsed.ok) throw new SupervisorProtocolError()
        await handleRequest(child, parsed.frame, session)
      }
    } finally {
      signal.removeEventListener('abort', stopWaiting)
      removeDisconnect()
    }
  }

  const stopChild = async (): Promise<void> => {
    const child = activeChild
    if (child === null) return
    child.terminate('SIGTERM')
    const exited = await waitForExit(child, stopTimeoutMs)
    if (exited === null) {
      child.terminate('SIGKILL')
      await child.exited
    }
    safeClose(child.channel)
    activeChild = null
    setStatus({ childInstanceId: null })
  }

  return {
    status: () => ({ ...status }),

    async run(signal) {
      if (running) throw new Error('EXECUTION_SUPERVISOR_ALREADY_RUNNING')
      running = true
      const abortActiveChild = (): void => { activeChild?.terminate('SIGTERM') }
      signal.addEventListener('abort', abortActiveChild, { once: true })
      const quarantineAndWait = async (
        requestedCode: ExecutionSupervisorQuarantineCode,
        durable: boolean,
      ): Promise<ExecutionParentSupervisorRunResult> => {
        terminalQuarantine = true
        await stopChild()
        if (state !== null && (activeChildFence === null || !activeChildFence.isHeld())) {
          try {
            activeChildFence = await deps.state.acquireChildLivenessFence(new AbortController().signal)
          } catch {
            requestedCode = 'SUPERVISOR_STATE_UNAVAILABLE'
            durable = false
          }
        }
        const code = setQuarantine(requestedCode, durable)
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        }
        if (state !== null) {
          try {
            publish({
              manager: { ...state.manager, cleanShutdown: true },
              authority: state.authority,
              restart: state.restart,
            })
          } catch { /* unsafe/corrupt state remains untouched */ }
        }
        setStatus({ phase: 'stopped', childInstanceId: null, nextDelayMs: null })
        signal.removeEventListener('abort', abortActiveChild)
        return { kind: 'quarantined', code }
      }
      let managerLease: ExecutionSupervisorManagerLease
      try {
        managerLease = deps.state.acquireManagerLease()
      } catch {
        return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
      }
      activeManagerLease = managerLease
      try {
        if (!managerLease.isHeld()) {
          return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
        }
        setStatus({ phase: 'starting' })
        try {
          activeChildFence = await deps.state.acquireChildLivenessFence(signal)
        } catch {
          if (signal.aborted) {
            setStatus({ phase: 'stopped', childInstanceId: null, nextDelayMs: null })
            signal.removeEventListener('abort', abortActiveChild)
            return { kind: 'stopped' }
          }
          return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
        }
        const loaded = deps.state.load()
      if (loaded.kind === 'refused') {
        return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
      }
      if (loaded.kind === 'missing') {
        state = makeExecutionSupervisorState({ epoch: deps.newId(), startedAtMs: deps.nowMs() })
        if (!managerLease.isHeld()) {
          return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
        }
        try { deps.state.publish(state) } catch {
          return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
        }
      } else {
        if (loaded.state.schemaVersion === 1) {
          try {
            const migrated = migrateExecutionSupervisorStateV1(loaded.state)
            deps.state.publish(migrated)
            state = migrated
          } catch {
            return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
          }
        } else {
          state = loaded.state
        }
        if (state.restart.quarantine !== null) {
          return await quarantineAndWait(state.restart.quarantine.code, false)
        }
        try {
          publish({
            manager: {
              epoch: deps.newId(),
              cleanShutdown: false,
              startedAtMs: deps.nowMs(),
            },
            authority: state.authority,
            restart: state.restart,
          })
        } catch {
          return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
        }
      }

      if (ownedDockerManager !== null) {
        if (!managerLease.isHeld() || activeChildFence === null || !activeChildFence.isHeld()) {
          return await quarantineAndWait('OWNED_DOCKER_RECOVERY_UNAVAILABLE', true)
        }
        try {
          await ownedDockerManager.recoverBeforeFirstChild({ signal })
        } catch {
          if (signal.aborted) {
            setStatus({ phase: 'stopped', childInstanceId: null, nextDelayMs: null })
            signal.removeEventListener('abort', abortActiveChild)
            return { kind: 'stopped' }
          }
          return await quarantineAndWait('OWNED_DOCKER_RECOVERY_UNAVAILABLE', true)
        }
        if (!managerLease.isHeld() || activeChildFence === null || !activeChildFence.isHeld() ||
          !ownedDockerManager.isReady()) {
          return await quarantineAndWait('OWNED_DOCKER_RECOVERY_UNAVAILABLE', true)
        }
      }

      try {
        while (!signal.aborted) {
          if (activeChild !== null) throw new Error('EXECUTION_SUPERVISOR_CHILD_OVERLAP')
          if (!managerLease.isHeld()) {
            return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
          }
          if (activeChildFence === null || !activeChildFence.isHeld()) {
            try { activeChildFence = await deps.state.acquireChildLivenessFence(signal) } catch {
              if (signal.aborted) break
              return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
            }
          }
          const startedAtMs = deps.nowMs()
          const livenessDescriptor = activeChildFence.descriptor
          const livenessDescriptorHash = activeChildFence.descriptorHash
          activeChildFence.release()
          activeChildFence = null
          let child: ExecutionSupervisorChildProcess
          try {
            child = deps.spawn.spawn({
              execPath: deps.execPath,
              binPath: deps.binPath,
              args: deps.childArgs ?? ['run'],
              env: {
                ...childEnv,
                [EXECUTION_SUPERVISOR_SELECTOR_ENV]: '1',
                [EXECUTION_SUPERVISOR_LIVENESS_ENV]: encodeExecutionSupervisorChildLivenessDescriptor(livenessDescriptor),
              },
            })
          } catch {
            activeChildFence = await deps.state.acquireChildLivenessFence(signal)
            throw new SupervisorProtocolError()
          }
          activeChild = child
          setStatus({
            phase: 'handshaking',
            childInstanceId: child.instanceId,
            nextDelayMs: null,
          })

          let exit: ExecutionSupervisorChildExit
          let plannedExitAuthorized = false
          const startup = await child.started
          if (startup.kind === 'spawn-failed') {
            // A pre-spawn failure proves that no OS process was created. It is
            // budgeted as an unexpected exit, but never masquerades as an exit
            // event and never permits another child while startup is unknown.
            exit = { code: null, signal: null }
          } else {
            try {
              const session = await handshake(child, livenessDescriptorHash)
              setStatus({ phase: 'running' })
              const observedExit = await serveUntilExit(child, session, signal)
              if (observedExit === null) break
              exit = observedExit
              const permit = session.plannedPermit
              session.plannedPermit = null
              plannedExitAuthorized = observedExit.code === AISY_PLANNED_RESTART_EXIT_CODE &&
                observedExit.signal === null && permit !== null && deps.nowMs() < permit.deadlineAtMs
            } catch {
              safeClose(child.channel)
              child.terminate('SIGTERM')
              const gracefulExit = await waitForExit(child, stopTimeoutMs)
              if (gracefulExit === null) {
                child.terminate('SIGKILL')
                exit = await child.exited
              } else {
                exit = gracefulExit
              }
            }
          }
          safeClose(child.channel)
          activeChild = null
          setStatus({ childInstanceId: null })
          if (signal.aborted) break

          try { activeChildFence = await deps.state.acquireChildLivenessFence(signal) } catch {
            if (signal.aborted) break
            return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
          }

          if (plannedExitAuthorized) {
            setStatus({ phase: 'backoff', nextDelayMs: PLANNED_RESTART_DELAY_MS })
            await deps.sleep(PLANNED_RESTART_DELAY_MS, signal)
            continue
          }

          if (state === null) return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
          const now = deps.nowMs()
          const stable = now - startedAtMs >= EXECUTION_SUPERVISOR_STABLE_RUN_MS
          const window = state.restart.unexpectedExitMs
            .filter((at) => now - at < EXECUTION_SUPERVISOR_CRASH_WINDOW_MS)
          window.push(now)
          const consecutive = stable ? 1 : state.restart.consecutiveUnexpectedExits + 1
          if (window.length >= EXECUTION_SUPERVISOR_CRASH_BUDGET) {
            try {
              publish({
                manager: state.manager,
                authority: state.authority,
                restart: {
                  unexpectedExitMs: window.slice(-EXECUTION_SUPERVISOR_CRASH_BUDGET),
                  consecutiveUnexpectedExits: consecutive,
                  quarantine: null,
                },
              })
            } catch {
              return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
            }
            return await quarantineAndWait('RESTART_BUDGET_EXHAUSTED', true)
          }
          try {
            publish({
              manager: state.manager,
              authority: state.authority,
              restart: {
                unexpectedExitMs: window,
                consecutiveUnexpectedExits: consecutive,
                quarantine: null,
              },
            })
          } catch {
            return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
          }
          const delay = EXECUTION_SUPERVISOR_BACKOFF_MS[
            Math.min(consecutive - 1, EXECUTION_SUPERVISOR_BACKOFF_MS.length - 1)
          ]!
          setStatus({ phase: 'backoff', nextDelayMs: delay })
          await deps.sleep(delay, signal)
        }
      } catch {
        if (!signal.aborted) return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', true)
      } finally {
        if (!terminalQuarantine) {
          setStatus({ phase: 'stopping', nextDelayMs: null })
          await stopChild()
          if (activeChildFence === null || !activeChildFence.isHeld()) {
            activeChildFence = await deps.state.acquireChildLivenessFence(new AbortController().signal)
          }
        }
      }

      if (state !== null) {
        try {
          publish({
            manager: { ...state.manager, cleanShutdown: true },
            authority: state.authority,
            restart: state.restart,
          })
        } catch {
          return await quarantineAndWait('SUPERVISOR_STATE_UNAVAILABLE', false)
        }
      }
      setStatus({ phase: 'stopped', quarantineCode: null })
      signal.removeEventListener('abort', abortActiveChild)
        return { kind: 'stopped' }
      } finally {
        try {
          await ownedDockerManager?.close()
        } finally {
          try {
            voice?.bridge.close()
          } finally {
            try {
              if (activeChildFence !== null) activeChildFence.release()
            } finally {
              activeChildFence = null
              try { managerLease.release() } finally { activeManagerLease = null }
            }
          }
        }
      }
    },
  }
}
