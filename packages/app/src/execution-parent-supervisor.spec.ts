import { randomBytes } from 'node:crypto'
import { mkdtempSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { makeDockerRecoveryActivationTestFixture } from './__test_support__/docker-recovery-activation.js'

import {
  AISY_PLANNED_RESTART_EXIT_CODE,
  makeExecutionParentSupervisor,
  makeNodeExecutionSupervisorSpawnPort,
  type ExecutionSupervisorChildExit,
  type ExecutionSupervisorChildProcess,
  type ExecutionSupervisorChildSpawn,
  type ExecutionSupervisorSpawnPort,
} from './execution-parent-supervisor.js'
import {
  encodeExecutionSupervisorFrame,
  makeExecutionSupervisorSessionProof,
  parseExecutionSupervisorFrame,
  type ExecutionSupervisorChannel,
  type ExecutionSupervisorFrame,
} from './execution-supervisor-ipc.js'
import {
  initializeOwnedDockerResourceLedger,
  openActivatedOwnedDockerResourceLedger,
} from './execution-owned-docker-resources.js'
import {
  makeNodeOwnedDockerParentRecoveryManager,
} from './owned-docker-parent-recovery-manager.js'
import {
  type ExecutionSupervisorStateStore,
  type ExecutionSupervisorState,
  withExecutionSupervisorStateChecksum,
} from './supervisor-state.js'
import {
  makeVoiceBrokerNativePort,
  type VoiceBrokerNativePort,
} from './voice-broker-native.js'

const HASH = 'a'.repeat(64)
const LIVENESS_HASH = 'b'.repeat(64)
const ENVELOPE_HASH = 'c'.repeat(64)
const RELEASE_INTENT_HASH = 'd'.repeat(64)
const LIVENESS_DESCRIPTOR = { version: 1 as const, path: '/private/aisy/child-liveness.sqlite3', dev: '1', ino: '2' }
type PeerMode = 'healthy' | 'bad-liveness' | 'planned' | 'planned-expired' |
  'planned-replay' | 'planned-foreign' | 'unauthorized75' | 'crash' |
  'capture-release' | 'durable-release' | 'durable-release-crash' |
  'durable-release-ack-write-fails' | 'durable-release-clock-rollback' |
  'receipt-consume' | 'receipt-consume-ack-write-fails' | 'capture-with-receipt' |
  'replay' | 'flood' | 'stubborn' |
  'voice' |
  'spawn-failed'

function opaque(): string {
  return randomBytes(32).toString('base64url')
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('condition not reached')
}

function memoryStore(initial: ExecutionSupervisorState | null = null, audit: string[] = []) {
  let current = initial
  let managerHeld = false
  const published: ExecutionSupervisorState[] = []
  const events: string[] = []
  const store: ExecutionSupervisorStateStore = {
    acquireManagerLease() {
      if (managerHeld) throw new Error('manager busy')
      managerHeld = true
      return {
        isHeld: () => managerHeld,
        release() { managerHeld = false },
      }
    },
    async acquireChildLivenessFence() {
      let held = true
      audit.push('fence:acquire')
      return {
        descriptor: LIVENESS_DESCRIPTOR,
        descriptorHash: LIVENESS_HASH,
        isHeld: () => held,
        onLost: () => () => undefined,
        release() { held = false; audit.push('fence:release') },
      }
    },
    load: () => current === null ? { kind: 'missing' } : { kind: 'ready', state: current },
    publish(state) {
      const stateKind = state.authority?.phase ??
        (state.schemaVersion === 2 && state.releaseReceipt !== null ? 'receipt' : 'none')
      events.push(`publish:${stateKind}`)
      audit.push(`publish:${stateKind}`)
      current = structuredClone(state)
      published.push(structuredClone(state))
    },
  }
  return { store, published, events, current: () => current }
}

class PeerChannel implements ExecutionSupervisorChannel {
  readonly sent: ExecutionSupervisorFrame[] = []
  readonly events: string[] = []
  private readonly queue: string[] = []
  private readonly waiters: Array<(raw: string) => void> = []
  private readonly disconnectListeners = new Set<() => void>()
  private closed = false
  private sessionId: string | null = null
  private hello: { requestId: string; deadlineAtMs: number; parentNonce: string; childNonce: string; livenessDescriptorHash: string } | null = null
  private requestCounter = 0

  constructor(
    private readonly mode: PeerMode,
    private readonly finish: (exit: ExecutionSupervisorChildExit) => void,
    private readonly abort?: () => void,
    private readonly audit: string[] = [],
    private readonly nowMs: () => number = Date.now,
    private readonly expirePermit: () => void = () => undefined,
    private readonly rollbackClock: () => void = () => undefined,
  ) {}

  private enqueue(frame: ExecutionSupervisorFrame): void {
    const raw = encodeExecutionSupervisorFrame(frame)
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.queue.push(raw)
    else waiter(raw)
  }

  send(raw: string): void {
    const parsed = parseExecutionSupervisorFrame(raw)
    if (!parsed.ok) throw new Error('bad parent frame')
    const frame = parsed.frame
    this.sent.push(frame)
    this.events.push(`send:${frame.type}`)
    this.audit.push(`send:${frame.type}`)
    if (frame.type === 'hello-challenge') {
      const childNonce = opaque()
      this.hello = {
        requestId: frame.requestId,
        deadlineAtMs: frame.deadlineAtMs,
        parentNonce: frame.parentNonce,
        childNonce,
        livenessDescriptorHash: this.mode === 'bad-liveness' ? 'c'.repeat(64) : LIVENESS_HASH,
      }
      this.enqueue({
        version: 3,
        type: 'hello',
        requestId: frame.requestId,
        deadlineAtMs: frame.deadlineAtMs,
        parentNonce: frame.parentNonce,
        childNonce,
        livenessDescriptorHash: this.hello.livenessDescriptorHash,
      })
      return
    }
    if (frame.type === 'hello-ack') {
      const hello = this.hello!
      expect(frame.sessionProof).toBe(makeExecutionSupervisorSessionProof({
        requestId: hello.requestId,
        parentNonce: hello.parentNonce,
        childNonce: hello.childNonce,
        sessionId: frame.sessionId,
        livenessDescriptorHash: hello.livenessDescriptorHash,
      }))
      this.sessionId = frame.sessionId
      this.enqueue({
        version: 3,
        type: 'recovery-request',
        requestId: 'recovery_1',
        deadlineAtMs: this.nowMs() + 30_000,
        sessionId: frame.sessionId,
      })
      return
    }
    if (frame.type === 'recovery-lease') {
      if (frame.releaseReceipt !== null && (this.mode === 'receipt-consume' ||
        this.mode === 'receipt-consume-ack-write-fails')) {
        this.enqueue({
          version: 3,
          type: 'release-receipt-consumed',
          requestId: `consume_${++this.requestCounter}`,
          deadlineAtMs: this.nowMs() + 30_000,
          sessionId: this.sessionId!,
          envelopeHash: frame.releaseReceipt.envelopeHash,
          releaseIntentHash: frame.releaseReceipt.releaseIntentHash,
          receiptHash: frame.releaseReceipt.receiptHash,
        })
      }
      else if (frame.releaseReceipt !== null && this.mode === 'capture-with-receipt') {
        this.enqueue({
          version: 3,
          type: 'capture',
          requestId: `capture_${++this.requestCounter}`,
          deadlineAtMs: this.nowMs() + 30_000,
          sessionId: this.sessionId!,
          bindingHash: HASH,
        })
      }
      else if (this.mode === 'planned' || this.mode === 'planned-expired' || this.mode === 'planned-replay' ||
        this.mode === 'planned-foreign') {
        this.enqueue({
          version: 3,
          type: 'planned-restart',
          requestId: 'planned_1',
          deadlineAtMs: this.nowMs() + 30_000,
          sessionId: this.mode === 'planned-foreign' ? opaque() : this.sessionId!,
          intentHash: HASH,
        })
      }
      else if (this.mode === 'voice') {
        this.enqueue({
          version: 3, type: 'voice-stage', requestId: 'voice_stage',
          deadlineAtMs: this.nowMs() + 30_000, sessionId: this.sessionId!,
          mediaBindingHash: HASH, relativePath: 'voice.ogg', expectedSha256: HASH,
          expectedSizeBytes: 10, maxBytes: 10, contentType: 'audio/ogg', language: 'ru',
        })
      }
      else if (this.mode === 'unauthorized75') {
        this.finish({ code: AISY_PLANNED_RESTART_EXIT_CODE, signal: null })
      }
      else if (this.mode === 'crash') this.finish({ code: 1, signal: null })
      else if (this.mode === 'healthy') this.abort?.()
      else if (this.mode === 'flood') {
        for (let index = 1; index <= 255; index++) {
          this.enqueue({
            version: 3,
            type: 'release',
            requestId: `flood_${index}`,
            deadlineAtMs: this.nowMs() + 30_000,
            sessionId: this.sessionId!,
            bindingHash: HASH,
            leaseId: opaque(),
          })
        }
      }
      else {
        const capture: ExecutionSupervisorFrame = {
          version: 3,
          type: 'capture',
          requestId: `capture_${++this.requestCounter}`,
          deadlineAtMs: this.nowMs() + 30_000,
          sessionId: this.sessionId!,
          bindingHash: HASH,
        }
        this.enqueue(capture)
      }
      return
    }
    if (frame.type === 'voice-stage-ack' && this.mode === 'voice') {
      expect(frame.ok).toBe(true)
      this.enqueue({
        version: 3, type: 'voice-prepare', requestId: 'voice_prepare',
        deadlineAtMs: this.nowMs() + 30_000, sessionId: this.sessionId!,
        mediaBindingHash: HASH, mediaTicket: frame.mediaTicket!,
        reservationRecoveryKey: 'r'.repeat(43),
      })
      return
    }
    if (frame.type === 'voice-prepare-ack' && this.mode === 'voice') {
      expect(frame.ok).toBe(true)
      this.enqueue({
        version: 3, type: 'voice-dispatch', requestId: 'voice_dispatch',
        deadlineAtMs: this.nowMs() + 30_000, sessionId: this.sessionId!,
        mediaBindingHash: HASH, dispatchPermitId: frame.dispatchPermitId!,
      })
      return
    }
    if (frame.type === 'voice-dispatch-ack' && this.mode === 'voice') {
      expect(frame).toMatchObject({ ok: true, transcript: 'parent relay', durationMs: 100 })
      this.abort?.()
      return
    }
    if (frame.type === 'planned-restart-ack') {
      if (this.mode === 'planned-expired') this.expirePermit()
      if (this.mode === 'planned-replay') {
        this.enqueue({
          version: 3,
          type: 'planned-restart',
          requestId: frame.requestId,
          deadlineAtMs: frame.deadlineAtMs,
          sessionId: this.sessionId!,
          intentHash: frame.intentHash,
        })
        return
      }
      if (this.mode === 'planned' || this.mode === 'planned-expired') {
        this.finish({ code: AISY_PLANNED_RESTART_EXIT_CODE, signal: null })
      }
      return
    }
    if (frame.type === 'capture-ack') {
      if (this.mode === 'replay') {
        this.enqueue({
          version: 3,
          type: 'capture',
          requestId: 'capture_1',
          deadlineAtMs: frame.deadlineAtMs,
          sessionId: this.sessionId!,
          bindingHash: HASH,
        })
        return
      }
      if (this.mode === 'capture-release' || this.mode === 'durable-release' ||
        this.mode === 'durable-release-crash' ||
        this.mode === 'durable-release-ack-write-fails' ||
        this.mode === 'durable-release-clock-rollback') {
        this.enqueue({
          version: 3,
          type: 'checkpoint-bound',
          requestId: `bound_${++this.requestCounter}`,
          deadlineAtMs: this.nowMs() + 30_000,
          sessionId: this.sessionId!,
          bindingHash: frame.bindingHash,
          leaseId: frame.leaseId,
        })
        return
      }
      this.enqueue({
        version: 3,
        type: 'release',
        requestId: `release_${++this.requestCounter}`,
        deadlineAtMs: this.nowMs() + 30_000,
        sessionId: this.sessionId!,
        bindingHash: frame.bindingHash,
        leaseId: frame.leaseId,
      })
      return
    }
    if (frame.type === 'checkpoint-bound-ack') {
      if (this.mode === 'durable-release' || this.mode === 'durable-release-crash' ||
        this.mode === 'durable-release-ack-write-fails' ||
        this.mode === 'durable-release-clock-rollback') {
        if (this.mode === 'durable-release-clock-rollback') this.rollbackClock()
        this.enqueue({
          version: 3,
          type: 'release-durable',
          requestId: `durable_${++this.requestCounter}`,
          deadlineAtMs: this.nowMs() + 30_000,
          sessionId: this.sessionId!,
          bindingHash: frame.bindingHash,
          leaseId: frame.leaseId,
          envelopeHash: ENVELOPE_HASH,
          releaseIntentHash: RELEASE_INTENT_HASH,
        })
        return
      }
      this.enqueue({
        version: 3,
        type: 'release',
        requestId: `release_${++this.requestCounter}`,
        deadlineAtMs: this.nowMs() + 30_000,
        sessionId: this.sessionId!,
        bindingHash: frame.bindingHash,
        leaseId: frame.leaseId,
      })
      return
    }
    if (frame.type === 'release-durable-ack') {
      if (this.mode === 'durable-release-ack-write-fails') {
        throw new Error('simulated ACK transport failure')
      }
      if (this.mode === 'durable-release-crash') {
        this.finish({ code: 1, signal: null })
        return
      }
      this.enqueue({
        version: 3,
        type: 'release-receipt-consumed',
        requestId: `consume_${++this.requestCounter}`,
        deadlineAtMs: this.nowMs() + 30_000,
        sessionId: this.sessionId!,
        envelopeHash: frame.receipt.envelopeHash,
        releaseIntentHash: frame.receipt.releaseIntentHash,
        receiptHash: frame.receipt.receiptHash,
      })
      return
    }
    if (frame.type === 'release-receipt-consumed-ack') {
      if (this.mode === 'receipt-consume-ack-write-fails') {
        throw new Error('simulated consume ACK transport failure')
      }
      this.abort?.()
    }
    if (frame.type === 'release-ack') this.abort?.()
    if (frame.type === 'refusal' && this.mode === 'capture-with-receipt') this.abort?.()
  }

  async receive(): Promise<string> {
    const queued = this.queue.shift()
    if (queued !== undefined) return queued
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener)
    return () => { this.disconnectListeners.delete(listener) }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.disconnectListeners) listener()
    if (this.mode === 'replay' || this.mode === 'flood') this.abort?.()
  }
}

function fakeSpawn(input: {
  modes: PeerMode[]
  controller: AbortController
  audit?: string[]
  nowMs?: () => number
  expirePermit?: () => void
  rollbackClock?: () => void
}) {
  const children: ExecutionSupervisorChildProcess[] = []
  const events: string[] = []
  const inputs: ExecutionSupervisorChildSpawn[] = []
  const spawn: ExecutionSupervisorSpawnPort = {
    spawn(spawnInput) {
      inputs.push(spawnInput)
      const mode = input.modes.shift() ?? 'healthy'
      const number = children.length + 1
      let finish!: (exit: ExecutionSupervisorChildExit) => void
      const exited = new Promise<ExecutionSupervisorChildExit>((resolve) => { finish = resolve })
      const channel = new PeerChannel(mode, (exit) => {
        events.push(`exit:${number}`)
        input.audit?.push(`exit:${number}`)
        finish(exit)
      }, () => input.controller.abort(), input.audit ?? [], input.nowMs, input.expirePermit,
      input.rollbackClock)
      const child: ExecutionSupervisorChildProcess = {
        instanceId: `child_${number}`,
        channel,
        started: Promise.resolve(mode === 'spawn-failed' ? { kind: 'spawn-failed' } : { kind: 'spawned' }),
        exited,
        terminate(signal) {
          events.push(`terminate:${signal}`)
          if (mode === 'stubborn' && signal === 'SIGTERM') return
          finish({ code: null, signal })
        },
      }
      events.push(`spawn:${number}`)
      input.audit?.push(`spawn:${number}`)
      children.push(child)
      return child
    },
  }
  return { spawn, children, events, inputs }
}

function harness(modes: PeerMode[], ownedDockerManager?: unknown, voice?: Readonly<{
  mediaRoot: string
  bridge: VoiceBrokerNativePort
}>) {
  const controller = new AbortController()
  const audit: string[] = []
  const state = memoryStore(null, audit)
  let now = Date.now()
  const quarantineCodes: string[] = []
  const child = fakeSpawn({
    modes: [...modes],
    controller,
    audit,
    nowMs: () => now,
    expirePermit: () => { now += 30_000 },
    rollbackClock: () => { now -= 1 },
  })
  const sleeps: number[] = []
  const supervisor = makeExecutionParentSupervisor({
    execPath: '/usr/bin/node',
    binPath: '/opt/aisy.js',
    childEnv: {},
    spawn: child.spawn,
    state: state.store,
    nowMs: () => now,
    newId: opaque,
    randomNonce: opaque,
    sleep: async (ms) => { sleeps.push(ms); now += ms },
    ...(ownedDockerManager === undefined ? {} : { ownedDockerManager }),
    ...(voice === undefined ? {} : { voice }),
    stopTimeoutMs: 100,
    onQuarantine: (code) => { quarantineCodes.push(code) },
  })
  return {
    supervisor, controller, state, child, sleeps, audit, quarantineCodes,
    advance: (ms: number) => { now += ms },
  }
}

describe('execution parent supervisor', () => {
  it('relays voice only through a genuine parent bridge and an exact reopened descriptor', async () => {
    const mediaRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-parent-voice-')))
    writeFileSync(join(mediaRoot, 'voice.ogg'), Buffer.alloc(10, 7), { mode: 0o600 })
    const calls: string[] = []
    try {
      const bridge = makeVoiceBrokerNativePort({
        isHeld: () => true,
        async stageMedia(input) {
          const bytes = Buffer.alloc(10)
          expect(readSync(input.descriptor, bytes, 0, 10, 0)).toBe(10)
          expect([...bytes]).toEqual(Array(10).fill(7))
          expect(input).not.toHaveProperty('relativePath')
          calls.push('stage')
          return { ok: true, mediaTicket: 'm'.repeat(43) }
        },
        async cancelMedia() { calls.push('cancel-media'); return true },
        async prepare() { calls.push('prepare'); return { ok: true, dispatchPermitId: 'p'.repeat(43) } },
        async cancelPrepared() { calls.push('cancel-prepared'); return 'cancelled' },
        async dispatch() {
          calls.push('dispatch')
          return { ok: true, transcript: 'parent relay', durationMs: 100 }
        },
        close() { calls.push('close') },
      })
      const h = harness(['voice'], undefined, { mediaRoot, bridge })
      await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })
      expect(calls).toEqual(['stage', 'prepare', 'dispatch', 'close'])
    } finally {
      rmSync(mediaRoot, { recursive: true, force: true })
    }
  })

  it('rejects a structural voice bridge before state or child spawn', () => {
    const controller = new AbortController()
    const state = memoryStore()
    const child = fakeSpawn({ modes: [], controller })
    expect(() => makeExecutionParentSupervisor({
      execPath: 'node', binPath: 'aisy', childEnv: {}, spawn: child.spawn, state: state.store,
      nowMs: () => Date.now(), newId: opaque, randomNonce: opaque, sleep: vi.fn(),
      voice: { mediaRoot: '/private/voice', bridge: {
        isHeld: () => true, stageMedia: vi.fn(), cancelMedia: vi.fn(), prepare: vi.fn(),
        cancelPrepared: vi.fn(), dispatch: vi.fn(), close: vi.fn(),
      } },
    })).toThrowError('INVALID_VOICE_BROKER_BRIDGE')
    expect(child.children).toEqual([])
  })

  it('rejects a structural Docker manager before state or child spawn', () => {
    const controller = new AbortController()
    const state = memoryStore()
    const child = fakeSpawn({ modes: [], controller })
    expect(() => makeExecutionParentSupervisor({
      execPath: 'node', binPath: 'aisy', childEnv: {}, spawn: child.spawn, state: state.store,
      nowMs: () => Date.now(), newId: opaque, randomNonce: opaque, sleep: vi.fn(),
      ownedDockerManager: {
        recoverBeforeFirstChild: async () => ({ kind: 'ready' }),
        isReady: () => true,
        close: async () => undefined,
      },
    })).toThrowError('INVALID_OWNED_DOCKER_PARENT_MANAGER')
    expect(child.children).toEqual([])
  })

  it('finishes genuine Docker recovery before first spawn and closes it on stop', async () => {
    const fixture = await makeDockerRecoveryActivationTestFixture()
    const base = mkdtempSync(join(tmpdir(), 'aisy-parent-supervisor-docker-'))
    try {
      const root = join(base, 'ledger')
      const activation = initializeOwnedDockerResourceLedger({
        root,
        installationId: '1'.repeat(64),
        endpointIdentity: fixture.endpointIdentity,
      })
      const manager = makeNodeOwnedDockerParentRecoveryManager({
        root,
        activation,
        engine: { socketPath: fixture.socketPath, endpointIdentity: fixture.endpointIdentity },
      })
      const h = harness(['healthy'], manager)
      const originalSpawn = h.child.spawn.spawn.bind(h.child.spawn)
      let readyAtSpawn = false
      h.child.spawn.spawn = (input) => {
        readyAtSpawn = manager.isReady()
        return originalSpawn(input)
      }

      await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })
      expect(readyAtSpawn).toBe(true)
      expect(manager.isReady()).toBe(false)
      const reopened = openActivatedOwnedDockerResourceLedger({ root, activation })
      reopened.close()
    } finally {
      await fixture.close()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('quarantines with zero child spawn when genuine Docker recovery fails', async () => {
    const fixture = await makeDockerRecoveryActivationTestFixture()
    const base = mkdtempSync(join(tmpdir(), 'aisy-parent-supervisor-docker-'))
    try {
      const root = join(base, 'ledger')
      const activation = initializeOwnedDockerResourceLedger({
        root,
        installationId: '2'.repeat(64),
        endpointIdentity: fixture.endpointIdentity,
      })
      const manager = makeNodeOwnedDockerParentRecoveryManager({
        root,
        activation,
        engine: {
          socketPath: join(base, 'missing.sock'),
          endpointIdentity: fixture.endpointIdentity,
        },
      })
      const h = harness([], manager)
      const running = h.supervisor.run(h.controller.signal)
      await waitUntil(() => h.supervisor.status().phase === 'quarantined')
      expect(h.child.children).toEqual([])
      expect(h.quarantineCodes).toEqual(['OWNED_DOCKER_RECOVERY_UNAVAILABLE'])
      h.controller.abort()
      await expect(running).resolves.toEqual({
        kind: 'quarantined',
        code: 'OWNED_DOCKER_RECOVERY_UNAVAILABLE',
      })
    } finally {
      await fixture.close()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('removes its abort listener on an already-aborted pre-state return', async () => {
    const controller = new AbortController()
    controller.abort()
    const state = memoryStore()
    state.store.acquireChildLivenessFence = async () => { throw new Error('aborted') }
    const load = vi.spyOn(state.store, 'load')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const child = fakeSpawn({ modes: [], controller })
    const supervisor = makeExecutionParentSupervisor({
      execPath: 'node', binPath: 'aisy', childEnv: {}, spawn: child.spawn, state: state.store,
      nowMs: () => Date.now(), newId: opaque, randomNonce: opaque, sleep: vi.fn(),
    })

    await expect(supervisor.run(controller.signal)).resolves.toEqual({ kind: 'stopped' })
    expect(load).not.toHaveBeenCalled()
    expect(child.children).toEqual([])
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('represents a pre-spawn error separately and never fabricates an exit event', async () => {
    const child = makeNodeExecutionSupervisorSpawnPort().spawn({
      execPath: join(tmpdir(), `aisy-missing-exec-${opaque()}`),
      binPath: 'unused',
      args: [],
      env: {},
    })

    await expect(child.started).resolves.toEqual({ kind: 'spawn-failed' })
    let exitObserved = false
    void child.exited.then(() => { exitObserved = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(exitObserved).toBe(false)
    child.channel.close()
  })

  it('authenticates a direct child, proves a null recovery lease and stops cleanly', async () => {
    const h = harness(['healthy'])

    await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })

    expect(h.child.children).toHaveLength(1)
    expect((h.child.children[0]!.channel as PeerChannel).sent.map((frame) => frame.type))
      .toEqual(['hello-challenge', 'hello-ack', 'recovery-lease'])
    expect(h.state.current()).toMatchObject({ manager: { cleanShutdown: true } })
    const firstFence = h.audit.indexOf('fence:acquire')
    const firstPublish = h.audit.indexOf('publish:none')
    const firstRelease = h.audit.indexOf('fence:release')
    const firstSpawn = h.audit.indexOf('spawn:1')
    expect(firstFence).toBeGreaterThanOrEqual(0)
    expect(firstPublish).toBeGreaterThan(firstFence)
    expect(firstRelease).toBeGreaterThan(firstPublish)
    expect(firstSpawn).toBeGreaterThan(firstRelease)
  })

  it('escalates an aborted child that ignores SIGTERM to SIGKILL after the bound', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(['stubborn'])
      const run = h.supervisor.run(h.controller.signal)
      await waitUntil(() => h.supervisor.status().phase === 'running')

      h.controller.abort()
      await vi.advanceTimersByTimeAsync(100)

      await expect(run).resolves.toEqual({ kind: 'stopped' })
      expect(h.child.events).toContain('terminate:SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes no manager root, content or credential sentinel to child argv/env/IPC', async () => {
    const h = harness(['healthy'])

    await h.supervisor.run(h.controller.signal)

    const exposed = JSON.stringify({
      spawn: h.child.inputs,
      frames: (h.child.children[0]!.channel as PeerChannel).sent,
      state: h.state.current(),
    })
    expect(exposed).not.toContain('/private/manager-root-sentinel')
    expect(exposed).not.toContain('telegram-content-sentinel')
    expect(exposed).not.toContain('credential-sentinel')
    expect(h.child.inputs[0]?.env['AISY_SUPERVISED']).toBe('1')
  })

  it('strips child-owned Docker configuration at the parent boundary', async () => {
    const controller = new AbortController()
    const state = memoryStore()
    const child = fakeSpawn({ modes: ['healthy'], controller })
    const supervisor = makeExecutionParentSupervisor({
      execPath: '/usr/bin/node',
      binPath: '/opt/aisy.js',
      childEnv: {
        AISY_DOCKER: '/usr/bin/docker',
        AISY_RESTRICTED_CLONE_ENABLED: 'true',
        AISY_RESTRICTED_CLONE_GATEWAY_IMAGE: 'gateway',
        AISY_RESTRICTED_CLONE_WORKER_IMAGE: 'worker',
        AISY_SANDBOX_GVISOR: '1',
        AISY_SANDBOX_IMAGE: 'bash',
        AISY_WHISPER_IMAGE: 'whisper',
        DOCKER_CONFIG: '/private/docker-config',
        DOCKER_CONTEXT: 'private-context',
        DOCKER_HOST: 'unix:///private/docker.sock',
        AISY_HOME: '/private/aisy',
      },
      spawn: child.spawn,
      state: state.store,
      nowMs: () => Date.now(),
      newId: opaque,
      randomNonce: opaque,
      sleep: async () => {},
    })

    const run = supervisor.run(controller.signal)
    await waitUntil(() => child.inputs.length === 1)
    controller.abort()
    await expect(run).resolves.toEqual({ kind: 'stopped' })

    expect(child.inputs[0]?.env).toMatchObject({
      AISY_HOME: '/private/aisy',
      AISY_SUPERVISED: '1',
    })
    expect(JSON.stringify(child.inputs[0]?.env)).not.toMatch(
      /(?:AISY_(?:DOCKER|RESTRICTED_CLONE|SANDBOX_(?:GVISOR|IMAGE)|WHISPER_IMAGE)|DOCKER_)/,
    )
  })

  it('waits for planned child exit before spawning exactly one replacement', async () => {
    const h = harness(['planned', 'healthy'])

    await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })

    expect(h.child.events.slice(0, 3)).toEqual(['spawn:1', 'exit:1', 'spawn:2'])
    expect(h.child.children).toHaveLength(2)
    expect(h.sleeps[0]).toBe(250)
    expect(h.state.current()?.restart.unexpectedExitMs).toEqual([])
    expect((h.child.children[0]!.channel as PeerChannel).sent.map((frame) => frame.type))
      .toContain('planned-restart-ack')
  })

  it('budgets exit(75) when its acknowledged permit expires at the deadline boundary', async () => {
    const h = harness(['planned-expired', 'healthy'])

    await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })

    expect(h.child.children).toHaveLength(2)
    expect(h.sleeps).toEqual([1_000])
    expect(h.state.current()?.restart.unexpectedExitMs).toHaveLength(1)
    expect(h.state.current()?.restart.consecutiveUnexpectedExits).toBe(1)
  })

  it.each(['planned-replay', 'planned-foreign'] as const)(
    'rejects a %s permit attempt and budgets the terminated child',
    async (mode) => {
      const h = harness([mode, 'healthy'])

      await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })

      expect(h.child.children).toHaveLength(2)
      expect(h.sleeps).toEqual([1_000])
      expect(h.state.current()?.restart.unexpectedExitMs).toHaveLength(1)
      expect(h.child.events).toContain('terminate:SIGTERM')
    },
  )

  it('quarantines after five unauthorized exit(75) events before spawning child six', async () => {
    const h = harness([
      'unauthorized75', 'unauthorized75', 'unauthorized75', 'unauthorized75', 'unauthorized75',
    ])
    const run = h.supervisor.run(h.controller.signal)
    await waitUntil(() => h.supervisor.status().phase === 'quarantined')

    expect(h.child.children).toHaveLength(5)
    expect(h.sleeps).toEqual([1_000, 2_000, 5_000, 15_000])
    expect(h.state.current()?.restart.unexpectedExitMs).toHaveLength(5)
    h.controller.abort()
    await expect(run).resolves.toEqual({
      kind: 'quarantined',
      code: 'RESTART_BUDGET_EXHAUSTED',
    })
  })

  it('budgets a proved pre-spawn failure without waiting for a fictional exit', async () => {
    const h = harness(['spawn-failed', 'healthy'])

    await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })

    expect(h.child.events.filter((event) => event.startsWith('spawn:'))).toEqual(['spawn:1', 'spawn:2'])
    expect(h.child.events).not.toContain('exit:1')
    expect(h.sleeps).toEqual([1_000])
    expect(h.state.current()?.restart.unexpectedExitMs).toHaveLength(1)
    const firstSpawn = h.audit.indexOf('spawn:1')
    const reacquired = h.audit.indexOf('fence:acquire', firstSpawn + 1)
    const crashPublish = h.audit.indexOf('publish:none', reacquired + 1)
    const secondRelease = h.audit.indexOf('fence:release', reacquired + 1)
    const secondSpawn = h.audit.indexOf('spawn:2')
    expect(reacquired).toBeGreaterThan(firstSpawn)
    expect(crashPublish).toBeGreaterThan(reacquired)
    expect(secondRelease).toBeGreaterThan(crashPublish)
    expect(secondSpawn).toBeGreaterThan(secondRelease)
  })

  it('rejects a pre-v2-hello liveness mismatch before recovery authority', async () => {
    const h = harness(['bad-liveness', 'healthy'])

    await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })

    const first = h.child.children[0]!.channel as PeerChannel
    expect(first.sent.map((entry) => entry.type)).toEqual(['hello-challenge'])
    expect(h.child.events).toContain('terminate:SIGTERM')
    expect(h.child.children).toHaveLength(2)
    expect(h.audit.indexOf('fence:acquire', h.audit.indexOf('spawn:1') + 1))
      .toBeGreaterThan(h.audit.indexOf('spawn:1'))
  })

  it('returns stable quarantine when a replacement fence becomes corrupt', async () => {
    const controller = new AbortController()
    const state = memoryStore()
    const acquire = state.store.acquireChildLivenessFence.bind(state.store)
    let attempts = 0
    state.store.acquireChildLivenessFence = async (signal) => {
      attempts += 1
      if (attempts > 1) throw new Error('CHILD_LIVENESS_CORRUPT')
      return await acquire(signal)
    }
    const child = fakeSpawn({ modes: ['bad-liveness'], controller })
    const supervisor = makeExecutionParentSupervisor({
      execPath: 'node', binPath: 'aisy', childEnv: {}, spawn: child.spawn, state: state.store,
      nowMs: () => Date.now(), newId: opaque, randomNonce: opaque, sleep: vi.fn(),
    })
    const run = supervisor.run(controller.signal)
    await waitUntil(() => supervisor.status().phase === 'quarantined')
    controller.abort()

    await expect(run).resolves.toEqual({
      kind: 'quarantined', code: 'SUPERVISOR_STATE_UNAVAILABLE',
    })
    expect(child.children).toHaveLength(1)
    expect(attempts).toBe(3)
  })

  it('publishes capture and checkpoint binding before each ACK, then durable clear before release ACK', async () => {
    const h = harness(['capture-release'])
    const run = h.supervisor.run(h.controller.signal)
    await run
    const channel = h.child.children[0]!.channel as PeerChannel
    expect(h.state.published.some((entry) => entry.authority?.phase === 'captured-unbound')).toBe(true)
    expect(h.state.current()?.authority).toBeNull()
    expect(channel.sent.map((frame) => frame.type)).toContain('capture-ack')
    expect(channel.sent.map((frame) => frame.type)).toContain('checkpoint-bound-ack')
    expect(channel.sent.map((frame) => frame.type)).toContain('release-ack')
    const capturePublish = h.audit.indexOf('publish:captured-unbound')
    const captureAck = h.audit.indexOf('send:capture-ack')
    const boundPublish = h.audit.indexOf('publish:checkpoint-bound', capturePublish + 1)
    const boundAck = h.audit.indexOf('send:checkpoint-bound-ack')
    const releasePublish = h.audit.indexOf('publish:none', boundPublish + 1)
    const releaseAck = h.audit.indexOf('send:release-ack')
    expect(capturePublish).toBeGreaterThan(-1)
    expect(captureAck).toBeGreaterThan(capturePublish)
    expect(boundPublish).toBeGreaterThan(captureAck)
    expect(boundAck).toBeGreaterThan(boundPublish)
    expect(releasePublish).toBeGreaterThan(boundAck)
    expect(releaseAck).toBeGreaterThan(releasePublish)
  })

  it('latches request ids and closes a replay without a second mutation or ACK', async () => {
    const h = harness(['replay'])

    await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })

    const channel = h.child.children[0]!.channel as PeerChannel
    expect(channel.sent.filter((frame) => frame.type === 'capture-ack')).toHaveLength(1)
    const capturedLeaseIds = h.state.published.flatMap((entry) =>
      entry.authority?.phase === 'captured-unbound' ? [entry.authority.leaseId] : [])
    expect(new Set(capturedLeaseIds).size).toBe(1)
    expect(h.state.current()?.authority).toMatchObject({ phase: 'captured-unbound', bindingHash: HASH })
  })

  it('persists a durable release receipt before ACK and consumes it before new work', async () => {
    const h = harness(['durable-release'])

    await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })

    const channel = h.child.children[0]!.channel as PeerChannel
    const receiptPublish = h.audit.indexOf('publish:receipt')
    const receiptAck = h.audit.indexOf('send:release-durable-ack')
    const consumedPublish = h.audit.indexOf('publish:none', receiptPublish + 1)
    const consumedAck = h.audit.indexOf('send:release-receipt-consumed-ack')
    expect(receiptPublish).toBeGreaterThan(-1)
    expect(receiptAck).toBeGreaterThan(receiptPublish)
    expect(consumedPublish).toBeGreaterThan(receiptAck)
    expect(consumedAck).toBeGreaterThan(consumedPublish)
    expect(channel.sent.filter(frame => frame.type === 'release-durable-ack')).toHaveLength(1)
    expect(h.state.current()).toMatchObject({ authority: null, releaseReceipt: null })
  })

  it('replays the same release receipt after ACK loss and clears it only after consumption', async () => {
    const h = harness(['durable-release-crash', 'receipt-consume'])

    await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })

    expect(h.child.children).toHaveLength(2)
    const first = h.child.children[0]!.channel as PeerChannel
    const second = h.child.children[1]!.channel as PeerChannel
    const issued = first.sent.find(frame => frame.type === 'release-durable-ack')
    const replayed = second.sent.find(frame => frame.type === 'recovery-lease')
    expect(issued?.type === 'release-durable-ack' ? issued.receipt : null)
      .toEqual(replayed?.type === 'recovery-lease' ? replayed.releaseReceipt : null)
    const durableReceiptHashes = h.state.published.flatMap(state => state.schemaVersion === 2 &&
      state.releaseReceipt !== null ? [state.releaseReceipt.receiptHash] : [])
    expect(new Set(durableReceiptHashes)).toEqual(new Set([
      issued?.type === 'release-durable-ack' ? issued.receipt.receiptHash : null,
    ]))
    expect(h.state.current()).toMatchObject({ authority: null, releaseReceipt: null })
  })

  it('replays a receipt when the durable ACK transport fails after publication', async () => {
    const h = harness(['durable-release-ack-write-fails', 'receipt-consume'])

    await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })

    expect(h.child.children).toHaveLength(2)
    const first = h.child.children[0]!.channel as PeerChannel
    const second = h.child.children[1]!.channel as PeerChannel
    const issued = first.sent.find(frame => frame.type === 'release-durable-ack')
    const replayed = second.sent.find(frame => frame.type === 'recovery-lease')
    expect(issued?.type === 'release-durable-ack' ? issued.receipt : null)
      .toEqual(replayed?.type === 'recovery-lease' ? replayed.releaseReceipt : null)
    expect(h.state.current()).toMatchObject({ authority: null, releaseReceipt: null })
  })

  it('keeps a consumed receipt cleared when its consumption ACK is lost', async () => {
    const receipt = {
      releaseIntentHash: RELEASE_INTENT_HASH,
      envelopeHash: ENVELOPE_HASH,
      receiptHash: 'e'.repeat(64),
      bindingHash: HASH,
      runLivenessHash: LIVENESS_HASH,
      authorityPhase: 'checkpoint-bound' as const,
      releasedAtMs: 10,
    }
    const initial = withExecutionSupervisorStateChecksum({
      schemaVersion: 2,
      revision: 3,
      manager: { epoch: opaque(), cleanShutdown: true, startedAtMs: 1 },
      authority: null,
      releaseReceipt: receipt,
      restart: { unexpectedExitMs: [], consecutiveUnexpectedExits: 0, quarantine: null },
    })
    const controller = new AbortController()
    const state = memoryStore(initial)
    const child = fakeSpawn({ modes: ['receipt-consume-ack-write-fails', 'healthy'], controller })
    const supervisor = makeExecutionParentSupervisor({
      execPath: 'node', binPath: 'aisy', childEnv: {}, spawn: child.spawn, state: state.store,
      nowMs: () => Date.now(), newId: opaque, randomNonce: opaque, sleep: vi.fn(),
    })

    await expect(supervisor.run(controller.signal)).resolves.toEqual({ kind: 'stopped' })

    expect(child.children).toHaveLength(2)
    const first = child.children[0]!.channel as PeerChannel
    const second = child.children[1]!.channel as PeerChannel
    expect(first.sent.some(frame => frame.type === 'release-receipt-consumed-ack')).toBe(true)
    expect(second.sent).toContainEqual(expect.objectContaining({
      type: 'recovery-lease', releaseReceipt: null,
    }))
    expect(state.current()).toMatchObject({ authority: null, releaseReceipt: null })
  })

  it('keeps authority and sends no ACK when receipt publication fails', async () => {
    const controller = new AbortController()
    const state = memoryStore()
    let receiptPublishAttempts = 0
    const child = fakeSpawn({ modes: ['durable-release', 'healthy'], controller })
    const supervisor = makeExecutionParentSupervisor({
      execPath: 'node', binPath: 'aisy', childEnv: {}, spawn: child.spawn,
      state: {
        ...state.store,
        publish(candidate) {
          if (candidate.releaseReceipt !== null) {
            receiptPublishAttempts += 1
            throw new Error('simulated durable state failure')
          }
          state.store.publish(candidate)
        },
      },
      nowMs: () => Date.now(), newId: opaque, randomNonce: opaque,
      sleep: async () => undefined,
    })

    await expect(supervisor.run(controller.signal)).resolves.toEqual({ kind: 'stopped' })
    const first = child.children[0]!.channel as PeerChannel
    expect(receiptPublishAttempts).toBe(1)
    expect(first.sent.some(frame => frame.type === 'release-durable-ack')).toBe(false)
    expect(state.published.every(candidate => candidate.schemaVersion === 1 ||
      candidate.releaseReceipt === null)).toBe(true)
    expect(state.current()?.authority).not.toBeNull()
  })

  it('denies durable release on clock rollback without clearing authority', async () => {
    const h = harness(['durable-release-clock-rollback', 'healthy'])

    await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })

    const first = h.child.children[0]!.channel as PeerChannel
    expect(first.sent.some(frame => frame.type === 'release-durable-ack')).toBe(false)
    expect(h.state.published.every(candidate => candidate.schemaVersion === 1 ||
      candidate.releaseReceipt === null)).toBe(true)
    expect(h.state.current()?.authority).not.toBeNull()
  })

  it('blocks capture while a release receipt remains unconsumed', async () => {
    const receipt = {
      releaseIntentHash: RELEASE_INTENT_HASH,
      envelopeHash: ENVELOPE_HASH,
      receiptHash: 'e'.repeat(64),
      bindingHash: HASH,
      runLivenessHash: LIVENESS_HASH,
      authorityPhase: 'checkpoint-bound' as const,
      releasedAtMs: 10,
    }
    const initial = withExecutionSupervisorStateChecksum({
      schemaVersion: 2,
      revision: 3,
      manager: { epoch: opaque(), cleanShutdown: true, startedAtMs: 1 },
      authority: null,
      releaseReceipt: receipt,
      restart: { unexpectedExitMs: [], consecutiveUnexpectedExits: 0, quarantine: null },
    })
    const controller = new AbortController()
    const state = memoryStore(initial)
    const child = fakeSpawn({ modes: ['capture-with-receipt'], controller })
    const supervisor = makeExecutionParentSupervisor({
      execPath: 'node', binPath: 'aisy', childEnv: {}, spawn: child.spawn, state: state.store,
      nowMs: () => Date.now(), newId: opaque, randomNonce: opaque, sleep: vi.fn(),
    })

    await expect(supervisor.run(controller.signal)).resolves.toEqual({ kind: 'stopped' })
    const channel = child.children[0]!.channel as PeerChannel
    expect(channel.sent).toContainEqual(expect.objectContaining({
      type: 'refusal', code: 'AUTHORITY_BUSY',
    }))
    expect(state.current()).toMatchObject({ authority: null, releaseReceipt: receipt })
  })

  it('closes at the bounded request limit instead of evicting an old id', async () => {
    const h = harness(['flood'])

    await expect(h.supervisor.run(h.controller.signal)).resolves.toEqual({ kind: 'stopped' })

    const channel = h.child.children[0]!.channel as PeerChannel
    expect(channel.sent.filter((frame) => frame.type === 'refusal')).toHaveLength(254)
    expect(channel.sent.filter((frame) => frame.type === 'release-ack')).toHaveLength(0)
    expect(h.state.current()?.authority).toBeNull()
  })

  it('rotates a recovery lease to the replacement only after the previous child is gone', async () => {
    const oldLeaseId = opaque()
    const previous = withExecutionSupervisorStateChecksum({
      schemaVersion: 1,
      revision: 4,
      manager: { epoch: opaque(), cleanShutdown: true, startedAtMs: 1 },
      authority: {
        phase: 'recovery-leased',
        authorityPhase: 'checkpoint-bound',
        bindingHash: HASH,
        leaseId: oldLeaseId,
        leasedToSessionId: opaque(),
        leasedAtMs: 2,
      },
      restart: { unexpectedExitMs: [], consecutiveUnexpectedExits: 0, quarantine: null },
    })
    const controller = new AbortController()
    const state = memoryStore(previous)
    const child = fakeSpawn({ modes: ['healthy'], controller })
    const supervisor = makeExecutionParentSupervisor({
      execPath: 'node', binPath: 'aisy', childEnv: {}, spawn: child.spawn, state: state.store,
      nowMs: () => Date.now(), newId: opaque, randomNonce: opaque, sleep: vi.fn(),
    })

    await expect(supervisor.run(controller.signal)).resolves.toEqual({ kind: 'stopped' })

    const lease = (child.children[0]!.channel as PeerChannel).sent.find(
      (frame) => frame.type === 'recovery-lease',
    )
    expect(lease).toMatchObject({ type: 'recovery-lease', bindingHash: HASH })
    expect(lease?.type === 'recovery-lease' ? lease.leaseId : null).not.toBe(oldLeaseId)
    expect(state.current()?.authority).toMatchObject({
      phase: 'recovery-leased',
      bindingHash: HASH,
      leaseId: lease?.type === 'recovery-lease' ? lease.leaseId : null,
    })
  })

  it('uses exact backoff and quarantines before a sixth child', async () => {
    const h = harness(['crash', 'crash', 'crash', 'crash', 'crash'])
    let settled = false
    const run = h.supervisor.run(h.controller.signal).finally(() => { settled = true })
    await waitUntil(() => h.supervisor.status().phase === 'quarantined')

    expect(settled).toBe(false)
    expect(h.child.children).toHaveLength(5)
    expect(h.quarantineCodes).toEqual(['RESTART_BUDGET_EXHAUSTED'])
    h.controller.abort()
    await expect(run).resolves.toEqual({
      kind: 'quarantined',
      code: 'RESTART_BUDGET_EXHAUSTED',
    })

    expect(h.sleeps).toEqual([1_000, 2_000, 5_000, 15_000])
    expect(h.state.current()).toMatchObject({
      restart: {
        consecutiveUnexpectedExits: 5,
        quarantine: { code: 'RESTART_BUDGET_EXHAUSTED' },
      },
    })

    const persisted = h.state.current()!
    const nextStateStore = memoryStore(persisted)
    const nextController = new AbortController()
    const nextChildren = fakeSpawn({ modes: ['healthy'], controller: nextController })
    const reconstructed = makeExecutionParentSupervisor({
      execPath: 'node', binPath: 'aisy', childEnv: {}, spawn: nextChildren.spawn,
      state: nextStateStore.store, nowMs: () => Date.now(), newId: opaque,
      randomNonce: opaque, sleep: vi.fn(),
    })
    let reconstructedSettled = false
    const reconstructedRun = reconstructed.run(nextController.signal)
      .finally(() => { reconstructedSettled = true })
    await waitUntil(() => reconstructed.status().phase === 'quarantined')
    expect(reconstructedSettled).toBe(false)
    expect(nextChildren.children).toHaveLength(0)
    nextController.abort()
    await expect(reconstructedRun).resolves.toEqual({
      kind: 'quarantined', code: 'RESTART_BUDGET_EXHAUSTED',
    })
  })

  it('recovers an unclean manager only after runtime quiescence was proven', async () => {
    const first = harness(['healthy'])
    const prior = first.state.current()
    expect(prior).toBeNull()
    const state = memoryStore(withExecutionSupervisorStateChecksum({
      schemaVersion: 1,
      revision: 1,
      manager: { epoch: opaque(), cleanShutdown: false, startedAtMs: 1 },
      authority: null,
      restart: { unexpectedExitMs: [], consecutiveUnexpectedExits: 0, quarantine: null },
    }))
    const controller = new AbortController()
    const child = fakeSpawn({ modes: ['healthy'], controller })
    const supervisor = makeExecutionParentSupervisor({
      execPath: 'node', binPath: 'aisy', childEnv: {}, spawn: child.spawn, state: state.store,
      nowMs: () => Date.now(), newId: opaque, randomNonce: opaque, sleep: vi.fn(),
    })

    await expect(supervisor.run(controller.signal)).resolves.toEqual({ kind: 'stopped' })
    expect(child.children).toHaveLength(1)
    expect(state.published[0]).toMatchObject({
      schemaVersion: 2,
      revision: 2,
      manager: { cleanShutdown: false },
      releaseReceipt: null,
    })
  })

  it('preserves a durable quarantine code after an unclean manager exit', async () => {
    const state = memoryStore(withExecutionSupervisorStateChecksum({
      schemaVersion: 1,
      revision: 1,
      manager: { epoch: opaque(), cleanShutdown: false, startedAtMs: 1 },
      authority: null,
      restart: {
        unexpectedExitMs: [1, 2, 3, 4, 5],
        consecutiveUnexpectedExits: 5,
        quarantine: { code: 'RESTART_BUDGET_EXHAUSTED', atMs: 5 },
      },
    }))
    const controller = new AbortController()
    const child = fakeSpawn({ modes: ['healthy'], controller })
    const supervisor = makeExecutionParentSupervisor({
      execPath: 'node', binPath: 'aisy', childEnv: {}, spawn: child.spawn, state: state.store,
      nowMs: () => Date.now(), newId: opaque, randomNonce: opaque, sleep: vi.fn(),
    })

    const run = supervisor.run(controller.signal)
    await waitUntil(() => supervisor.status().phase === 'quarantined')
    controller.abort()
    await expect(run).resolves.toEqual({
      kind: 'quarantined', code: 'RESTART_BUDGET_EXHAUSTED',
    })
    expect(child.children).toEqual([])
    expect(state.current()?.restart.quarantine?.code).toBe('RESTART_BUDGET_EXHAUSTED')
  })

  it('quarantines with zero child when the exact manager lease is lost before spawn', async () => {
    const controller = new AbortController()
    const child = fakeSpawn({ modes: ['healthy'], controller })
    const state = memoryStore()
    let leaseChecks = 0
    const release = vi.fn()
    const supervisor = makeExecutionParentSupervisor({
      execPath: 'node', binPath: 'aisy', childEnv: {}, spawn: child.spawn,
      state: {
        ...state.store,
        acquireManagerLease: () => ({
          isHeld: () => ++leaseChecks <= 2,
          release,
        }),
      },
      nowMs: () => Date.now(), newId: opaque, randomNonce: opaque, sleep: vi.fn(),
    })

    let settled = false
    const run = supervisor.run(controller.signal).finally(() => { settled = true })
    await waitUntil(() => supervisor.status().phase === 'quarantined')

    expect(settled).toBe(false)
    expect(child.children).toEqual([])
    expect(supervisor.status().quarantineCode).toBe('SUPERVISOR_STATE_UNAVAILABLE')
    controller.abort()
    await expect(run).resolves.toEqual({
      kind: 'quarantined', code: 'SUPERVISOR_STATE_UNAVAILABLE',
    })
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps corrupt or unsafe state as in-memory quarantine with zero publish and zero spawn', async () => {
    const controller = new AbortController()
    const child = fakeSpawn({ modes: ['healthy'], controller })
    const publish = vi.fn()
    const supervisor = makeExecutionParentSupervisor({
      execPath: 'node', binPath: 'aisy', childEnv: {}, spawn: child.spawn,
      state: {
        acquireManagerLease: () => ({ isHeld: () => true, release: vi.fn() }),
        acquireChildLivenessFence: async () => ({
          descriptor: LIVENESS_DESCRIPTOR,
          descriptorHash: LIVENESS_HASH,
          isHeld: () => true,
          onLost: () => () => undefined,
          release: vi.fn(),
        }),
        load: () => ({ kind: 'refused', code: 'CORRUPT_STATE' }),
        publish,
      },
      nowMs: () => Date.now(), newId: opaque, randomNonce: opaque, sleep: vi.fn(),
    })
    let settled = false
    const run = supervisor.run(controller.signal).finally(() => { settled = true })
    await waitUntil(() => supervisor.status().phase === 'quarantined')

    expect(settled).toBe(false)
    expect(child.children).toEqual([])
    expect(publish).not.toHaveBeenCalled()
    controller.abort()
    await expect(run).resolves.toEqual({
      kind: 'quarantined', code: 'SUPERVISOR_STATE_UNAVAILABLE',
    })
    expect(publish).not.toHaveBeenCalled()
  })
})
