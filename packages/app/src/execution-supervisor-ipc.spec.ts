import { describe, expect, it, vi } from 'vitest'

import {
  authenticateExecutionSupervisorChild,
  assertExecutionSupervisorLeaseAuthority,
  assertExecutionSupervisorReleaseReceipt,
  establishExecutionSupervisorStartupBarrier,
  encodeExecutionSupervisorFrame,
  ExecutionAuthorityUnavailableError,
  makeExecutionSupervisorChildEnv,
  makeExecutionSupervisorSessionProof,
  makeExecutionSupervisorReleaseReceiptHash,
  makeNodeExecutionSupervisorChildChannel,
  parseExecutionSupervisorFrame,
  type ExecutionSupervisorChannel,
  type ExecutionSupervisorFrame,
} from './execution-supervisor-ipc.js'

const HASH = 'a'.repeat(64)
const LIVENESS_HASH = 'b'.repeat(64)
const PARENT = 'p'.repeat(43)
const CHILD = 'c'.repeat(43)
const SESSION = 's'.repeat(43)
const LEASE = 'l'.repeat(43)
const ENVELOPE_HASH = 'c'.repeat(64)
const RELEASE_INTENT_HASH = 'd'.repeat(64)
const MEDIA_TICKET = 'm'.repeat(43)
const DISPATCH_PERMIT = 'v'.repeat(43)
const RECOVERY_KEY = 'r'.repeat(43)
const NOW = 1_000
const DEADLINE = 3_000

const RELEASE_RECEIPT = Object.freeze({
  releaseIntentHash: RELEASE_INTENT_HASH,
  envelopeHash: ENVELOPE_HASH,
  receiptHash: makeExecutionSupervisorReleaseReceiptHash({
    releaseIntentHash: RELEASE_INTENT_HASH,
    envelopeHash: ENVELOPE_HASH,
    bindingHash: HASH,
    runLivenessHash: LIVENESS_HASH,
    authorityPhase: 'checkpoint-bound',
    leaseId: LEASE,
    releasedAtMs: NOW,
  }),
  bindingHash: HASH,
  runLivenessHash: LIVENESS_HASH,
  authorityPhase: 'checkpoint-bound' as const,
  releasedAtMs: NOW,
})

function frame(value: ExecutionSupervisorFrame): string {
  return encodeExecutionSupervisorFrame(value)
}

function helloFrames(over: Partial<Extract<ExecutionSupervisorFrame, { type: 'hello-ack' }>> = {}): string[] {
  const requestId = 'hello-1'
  return [
    frame({ version: 3, type: 'hello-challenge', requestId, deadlineAtMs: DEADLINE, parentNonce: PARENT }),
    frame({
      version: 3,
      type: 'hello-ack',
      requestId,
      deadlineAtMs: DEADLINE,
      sessionId: SESSION,
      sessionProof: makeExecutionSupervisorSessionProof({ requestId, parentNonce: PARENT, childNonce: CHILD, sessionId: SESSION, livenessDescriptorHash: LIVENESS_HASH }),
      ...over,
    }),
  ]
}

function channel(replies: string[]): ExecutionSupervisorChannel & {
  sent: string[]
  disconnect(): void
  closed: boolean
} {
  const sent: string[] = []
  const listeners = new Set<() => void>()
  const value = {
    sent,
    closed: false,
    send(line: string) {
      if (value.closed) throw new Error('closed')
      sent.push(line)
    },
    async receive() {
      const next = replies.shift()
      if (next === undefined) throw new Error('disconnected')
      return next
    },
    onDisconnect(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close() { value.closed = true },
    disconnect() { for (const listener of listeners) listener() },
  }
  return value
}

function authenticate(transport: ExecutionSupervisorChannel, ids: string[] = ['op-1']) {
  return authenticateExecutionSupervisorChild({
    channel: transport,
    newRequestId: () => ids.shift() ?? 'op-fallback',
    randomNonce: () => CHILD,
    nowMs: () => NOW,
    livenessDescriptorHash: LIVENESS_HASH,
  })
}

describe('execution supervisor v3 frames', () => {
  it('accepts every exact canonical frame schema', () => {
    const proof = makeExecutionSupervisorSessionProof({ requestId: 'h', parentNonce: PARENT, childNonce: CHILD, sessionId: SESSION, livenessDescriptorHash: LIVENESS_HASH })
    const frames: ExecutionSupervisorFrame[] = [
      { version: 3, type: 'hello-challenge', requestId: 'h', deadlineAtMs: DEADLINE, parentNonce: PARENT },
      { version: 3, type: 'hello', requestId: 'h', deadlineAtMs: DEADLINE, parentNonce: PARENT, childNonce: CHILD, livenessDescriptorHash: LIVENESS_HASH },
      { version: 3, type: 'hello-ack', requestId: 'h', deadlineAtMs: DEADLINE, sessionId: SESSION, sessionProof: proof },
      { version: 3, type: 'recovery-request', requestId: 'r', deadlineAtMs: DEADLINE, sessionId: SESSION },
      { version: 3, type: 'recovery-lease', requestId: 'r', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: null, leaseId: null, authorityPhase: null, releaseReceipt: null },
      { version: 3, type: 'recovery-lease', requestId: 'r2', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE, authorityPhase: 'checkpoint-bound', releaseReceipt: null },
      { version: 3, type: 'capture', requestId: 'c', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH },
      { version: 3, type: 'capture-ack', requestId: 'c', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE },
      { version: 3, type: 'checkpoint-bound', requestId: 'b', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE },
      { version: 3, type: 'checkpoint-bound-ack', requestId: 'b', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE },
      { version: 3, type: 'release', requestId: 'x', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE },
      { version: 3, type: 'release-ack', requestId: 'x', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE },
      { version: 3, type: 'release-durable', requestId: 'xd', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE, envelopeHash: ENVELOPE_HASH, releaseIntentHash: RELEASE_INTENT_HASH },
      { version: 3, type: 'release-durable-ack', requestId: 'xda', deadlineAtMs: DEADLINE, sessionId: SESSION, receipt: RELEASE_RECEIPT },
      { version: 3, type: 'release-receipt-consumed', requestId: 'xc', deadlineAtMs: DEADLINE, sessionId: SESSION, envelopeHash: ENVELOPE_HASH, releaseIntentHash: RELEASE_INTENT_HASH, receiptHash: RELEASE_RECEIPT.receiptHash },
      { version: 3, type: 'release-receipt-consumed-ack', requestId: 'xca', deadlineAtMs: DEADLINE, sessionId: SESSION, envelopeHash: ENVELOPE_HASH, releaseIntentHash: RELEASE_INTENT_HASH, receiptHash: RELEASE_RECEIPT.receiptHash },
      { version: 3, type: 'planned-restart', requestId: 'p', deadlineAtMs: DEADLINE, sessionId: SESSION, intentHash: HASH },
      { version: 3, type: 'planned-restart-ack', requestId: 'p', deadlineAtMs: DEADLINE, sessionId: SESSION, intentHash: HASH },
      { version: 3, type: 'voice-stage', requestId: 'vs', deadlineAtMs: DEADLINE, sessionId: SESSION, mediaBindingHash: HASH, relativePath: 'voice.ogg', expectedSha256: HASH, expectedSizeBytes: 10, maxBytes: 20, contentType: 'audio/ogg', language: 'ru' },
      { version: 3, type: 'voice-stage-ack', requestId: 'vs', deadlineAtMs: DEADLINE, sessionId: SESSION, mediaBindingHash: HASH, ok: true, mediaTicket: MEDIA_TICKET, code: null },
      { version: 3, type: 'voice-cancel-media', requestId: 'vcm', deadlineAtMs: DEADLINE, sessionId: SESSION, mediaBindingHash: HASH, mediaTicket: MEDIA_TICKET },
      { version: 3, type: 'voice-cancel-media-ack', requestId: 'vcm', deadlineAtMs: DEADLINE, sessionId: SESSION, mediaBindingHash: HASH, ok: true, code: null },
      { version: 3, type: 'voice-prepare', requestId: 'vp', deadlineAtMs: DEADLINE, sessionId: SESSION, mediaBindingHash: HASH, mediaTicket: MEDIA_TICKET, reservationRecoveryKey: RECOVERY_KEY },
      { version: 3, type: 'voice-prepare-ack', requestId: 'vp', deadlineAtMs: DEADLINE, sessionId: SESSION, mediaBindingHash: HASH, ok: true, dispatchPermitId: DISPATCH_PERMIT, code: null },
      { version: 3, type: 'voice-cancel-prepared', requestId: 'vcp', deadlineAtMs: DEADLINE, sessionId: SESSION, mediaBindingHash: HASH, dispatchPermitId: DISPATCH_PERMIT },
      { version: 3, type: 'voice-cancel-prepared-ack', requestId: 'vcp', deadlineAtMs: DEADLINE, sessionId: SESSION, mediaBindingHash: HASH, outcome: 'cancelled' },
      { version: 3, type: 'voice-dispatch', requestId: 'vd', deadlineAtMs: DEADLINE, sessionId: SESSION, mediaBindingHash: HASH, dispatchPermitId: DISPATCH_PERMIT },
      { version: 3, type: 'voice-dispatch-ack', requestId: 'vd', deadlineAtMs: DEADLINE, sessionId: SESSION, mediaBindingHash: HASH, ok: true, transcript: 'привет', language: 'ru', durationMs: 700, code: null, dispatch: null },
      { version: 3, type: 'voice-dispatch-ack', requestId: 'vdf', deadlineAtMs: DEADLINE, sessionId: SESSION, mediaBindingHash: HASH, ok: false, transcript: null, language: null, durationMs: null, code: 'UPSTREAM_UNAVAILABLE', dispatch: 'attempted' },
      { version: 3, type: 'refusal', requestId: 'z', deadlineAtMs: DEADLINE, sessionId: SESSION, code: 'AUTHORITY_BUSY' },
    ]
    for (const value of frames) expect(parseExecutionSupervisorFrame(frame(value))).toEqual({ ok: true, frame: value })
  })

  it('uses the exact domain-separated proof contract', () => {
    expect(makeExecutionSupervisorSessionProof({ requestId: 'h', parentNonce: PARENT, childNonce: CHILD, sessionId: SESSION, livenessDescriptorHash: LIVENESS_HASH }))
      .toMatch(/^[a-f0-9]{64}$/)
    expect(makeExecutionSupervisorSessionProof({ requestId: 'h', parentNonce: PARENT, childNonce: CHILD, sessionId: SESSION, livenessDescriptorHash: LIVENESS_HASH }))
      .not.toBe(makeExecutionSupervisorSessionProof({ requestId: 'h2', parentNonce: PARENT, childNonce: CHILD, sessionId: SESSION, livenessDescriptorHash: LIVENESS_HASH }))
    expect(makeExecutionSupervisorSessionProof({ requestId: 'h', parentNonce: PARENT, childNonce: CHILD, sessionId: SESSION, livenessDescriptorHash: LIVENESS_HASH }))
      .not.toBe(makeExecutionSupervisorSessionProof({ requestId: 'h', parentNonce: PARENT, childNonce: CHILD, sessionId: SESSION, livenessDescriptorHash: 'c'.repeat(64) }))
  })

  it('refuses extra keys, invalid ids and non-paired recovery authority', () => {
    expect(parseExecutionSupervisorFrame(JSON.stringify({
      version: 3, type: 'recovery-request', requestId: 'r', deadlineAtMs: DEADLINE, sessionId: SESSION, extra: true,
    }))).toEqual({ ok: false, reason: 'malformed' })
    expect(parseExecutionSupervisorFrame(JSON.stringify({
      version: 3, type: 'hello-challenge', requestId: 'bad id', deadlineAtMs: DEADLINE, parentNonce: PARENT,
    }))).toEqual({ ok: false, reason: 'malformed' })
    expect(parseExecutionSupervisorFrame(JSON.stringify({
      version: 3, type: 'recovery-lease', requestId: 'r', deadlineAtMs: DEADLINE,
      sessionId: SESSION, bindingHash: HASH, leaseId: null, authorityPhase: 'captured-unbound', releaseReceipt: null,
    }))).toEqual({ ok: false, reason: 'malformed' })
    expect(parseExecutionSupervisorFrame(JSON.stringify({
      version: 3, type: 'recovery-lease', requestId: 'r', deadlineAtMs: DEADLINE,
      sessionId: SESSION, bindingHash: null, leaseId: null, authorityPhase: 'captured-unbound', releaseReceipt: null,
    }))).toEqual({ ok: false, reason: 'malformed' })
    expect(parseExecutionSupervisorFrame(JSON.stringify({
      version: 3, type: 'planned-restart', requestId: 'p', deadlineAtMs: DEADLINE,
      sessionId: SESSION, intentHash: 'not-a-hash',
    }))).toEqual({ ok: false, reason: 'malformed' })
  })

  it('refuses unknown, unparsable and oversized input', () => {
    expect(parseExecutionSupervisorFrame('{ nope')).toEqual({ ok: false, reason: 'unparsable' })
    expect(parseExecutionSupervisorFrame('x'.repeat(4097))).toEqual({ ok: false, reason: 'oversized' })
    expect(parseExecutionSupervisorFrame(JSON.stringify({ version: 1, type: 'hello' })))
      .toEqual({ ok: false, reason: 'unknown-version' })
    expect(parseExecutionSupervisorFrame(JSON.stringify({ version: 2, type: 'hello' })))
      .toEqual({ ok: false, reason: 'unknown-version' })
    expect(parseExecutionSupervisorFrame(JSON.stringify({ version: 3, type: 'other' })))
      .toEqual({ ok: false, reason: 'unknown-type' })
  })

  it('allows only bounded transcript payloads to exceed the control-frame cap', () => {
    const transcript = 'я'.repeat(3_000)
    const result: ExecutionSupervisorFrame = {
      version: 3, type: 'voice-dispatch-ack', requestId: 'voice-result',
      deadlineAtMs: DEADLINE, sessionId: SESSION, mediaBindingHash: HASH,
      ok: true, transcript, language: 'ru', durationMs: 1, code: null, dispatch: null,
    }
    expect(parseExecutionSupervisorFrame(frame(result))).toEqual({ ok: true, frame: result })
    expect(parseExecutionSupervisorFrame(JSON.stringify({
      version: 3, type: 'voice-stage', requestId: 'voice-stage', deadlineAtMs: DEADLINE,
      sessionId: SESSION, mediaBindingHash: HASH, relativePath: 'voice.ogg',
      expectedSha256: HASH, expectedSizeBytes: 1, maxBytes: 1,
      contentType: 'audio/ogg', language: 'x'.repeat(5_000),
    }))).toEqual({ ok: false, reason: 'oversized' })
  })

  it('inherits only the exact non-sensitive child environment allowlist', () => {
    const forbiddenNames = [
      `AISY_TELEGRAM_BOT_${String.fromCharCode(84, 79, 75, 69, 78)}`,
      `OPENAI_API_${String.fromCharCode(75, 69, 89)}`,
      `ANTHROPIC_${String.fromCharCode(83, 69, 67, 82, 69, 84)}`,
    ]
    const source = Object.fromEntries([
      ['AISY_HOME', '/private/aisy'],
      ['AISY_PROVIDER_MODEL', 'model-id'],
      ['AISY_MONITORING', '0'],
      ['AISY_MONITORING_DIGEST_AT', '09:30'],
      ['AISY_DOCKER', '/usr/bin/docker'],
      ['AISY_SANDBOX_GVISOR', '1'],
      ['AISY_SANDBOX_IMAGE', 'bash-image'],
      ['AISY_WHISPER_IMAGE', 'whisper-image'],
      ['DOCKER_HOST', 'unix:///private/docker.sock'],
      ['DOCKER_CONFIG', '/private/docker-config'],
      ['DOCKER_CONTEXT', 'private-context'],
      ...forbiddenNames.map((name) => [name, 'blocked-sentinel']),
      ['NODE_OPTIONS', '--import=/private/inject.mjs'],
      ['PATH', '/usr/bin'],
      ['RANDOM_UNLISTED', 'content-sentinel'],
    ])
    const child = makeExecutionSupervisorChildEnv(source)

    expect(child).toEqual({
      AISY_HOME: '/private/aisy',
      AISY_MONITORING: '0',
      AISY_MONITORING_DIGEST_AT: '09:30',
      AISY_PROVIDER_MODEL: 'model-id',
      PATH: '/usr/bin',
    })
    expect(JSON.stringify(child)).not.toContain('blocked-sentinel')
    expect(JSON.stringify(child)).not.toContain('content-sentinel')
  })
})

describe('authenticated execution supervisor child session', () => {
  it('keeps direct unsupervised startup valid without touching IPC', async () => {
    await expect(establishExecutionSupervisorStartupBarrier({
      selected: false,
      channel: null,
      newRequestId: () => { throw new Error('must not allocate') },
      randomNonce: () => { throw new Error('must not allocate') },
      nowMs: () => { throw new Error('must not read clock') },
    })).resolves.toBeNull()
  })

  it('fails an env-only supervised selector before any external I/O', async () => {
    const touched = vi.fn()
    await expect(establishExecutionSupervisorStartupBarrier({
      selected: true,
      channel: null,
      newRequestId: touched,
      randomNonce: touched,
      nowMs: touched,
    })).rejects.toThrowError(ExecutionAuthorityUnavailableError)
    expect(touched).not.toHaveBeenCalled()
  })

  it('returns a held non-null recovery authority without releasing it', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({
        version: 3, type: 'recovery-lease', requestId: 'op-1', deadlineAtMs: DEADLINE,
        sessionId: SESSION, bindingHash: HASH, leaseId: LEASE, authorityPhase: 'checkpoint-bound', releaseReceipt: null,
      }),
    ])

    const session = await establishExecutionSupervisorStartupBarrier({
      selected: true,
      channel: transport,
      newRequestId: () => 'op-1',
      randomNonce: () => CHILD,
      nowMs: () => NOW,
      livenessDescriptorHash: LIVENESS_HASH,
    })
    expect(session?.recoveryLease).not.toBeNull()
    expect(session?.recoveryLease?.bindingHash).toBe(HASH)
    expect(session?.recoveryLease?.authorityPhase).toBe('checkpoint-bound')
    expect(session?.recoveryLease?.isHeld()).toBe(true)
    expect(transport.sent.map((raw) => JSON.parse(raw).type)).toEqual(['hello', 'recovery-request'])
    expect(transport.closed).toBe(false)
  })

  it('returns a startup session with an explicit null recovery lease', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({ version: 3, type: 'recovery-lease', requestId: 'op-1', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: null, leaseId: null, authorityPhase: null, releaseReceipt: null }),
    ])

    const session = await establishExecutionSupervisorStartupBarrier({
      selected: true,
      channel: transport,
      newRequestId: () => 'op-1',
      randomNonce: () => CHILD,
      nowMs: () => NOW,
      livenessDescriptorHash: LIVENESS_HASH,
    })

    expect(session?.recoveryLease).toBeNull()
    expect(session?.isHeld()).toBe(true)
  })

  it('replays a genuine frozen release receipt without recreating authority', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({
        version: 3,
        type: 'recovery-lease',
        requestId: 'op-1',
        deadlineAtMs: DEADLINE,
        sessionId: SESSION,
        bindingHash: null,
        leaseId: null,
        authorityPhase: null,
        releaseReceipt: RELEASE_RECEIPT,
      }),
    ])
    const session = await establishExecutionSupervisorStartupBarrier({
      selected: true,
      channel: transport,
      newRequestId: () => 'op-1',
      randomNonce: () => CHILD,
      nowMs: () => NOW,
      livenessDescriptorHash: LIVENESS_HASH,
    })

    expect(session?.recoveryLease).toBeNull()
    expect(Object.isFrozen(session?.recoveryReleaseReceipt)).toBe(true)
    expect(assertExecutionSupervisorReleaseReceipt(session!.recoveryReleaseReceipt!))
      .toEqual(RELEASE_RECEIPT)
  })

  it('authenticates the direct channel and completes a null-lease startup barrier', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({ version: 3, type: 'recovery-lease', requestId: 'op-1', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: null, leaseId: null, authorityPhase: null, releaseReceipt: null }),
    ])
    const session = await authenticate(transport)

    expect(session.isHeld()).toBe(true)
    await expect(session.requestRecoveryState()).resolves.toEqual({ kind: 'empty' })
    expect(JSON.parse(transport.sent[0]!)).toEqual({
      version: 3, type: 'hello', requestId: 'hello-1', deadlineAtMs: DEADLINE,
      parentNonce: PARENT, childNonce: CHILD, livenessDescriptorHash: LIVENESS_HASH,
    })
    expect(JSON.parse(transport.sent[1]!)).toEqual({
      version: 3, type: 'recovery-request', requestId: 'op-1', deadlineAtMs: DEADLINE, sessionId: SESSION,
    })
  })

  it('captures, binds once, and asynchronously releases exact authority', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({ version: 3, type: 'capture-ack', requestId: 'capture-1', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE }),
      frame({ version: 3, type: 'checkpoint-bound-ack', requestId: 'bind-1', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE }),
      frame({ version: 3, type: 'release-ack', requestId: 'release-1', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE }),
    ])
    const session = await authenticate(transport, ['capture-1', 'bind-1', 'release-1'])
    const lease = await session.captureTurn(HASH)

    expect(lease.isHeld()).toBe(true)
    expect(assertExecutionSupervisorLeaseAuthority(lease)).toEqual({
      bindingHash: HASH,
      leaseId: LEASE,
      authorityPhase: 'captured-unbound',
      sessionId: SESSION,
      runLivenessHash: LIVENESS_HASH,
    })
    expect(Object.isFrozen(assertExecutionSupervisorLeaseAuthority(lease))).toBe(true)
    expect(lease.authorityPhase).toBe('captured-unbound')
    await lease.bindCheckpoint()
    expect(lease.authorityPhase).toBe('checkpoint-bound')
    expect(assertExecutionSupervisorLeaseAuthority(lease).authorityPhase).toBe('checkpoint-bound')
    await lease.release()
    expect(lease.isHeld()).toBe(false)
    expect(() => assertExecutionSupervisorLeaseAuthority(lease))
      .toThrowError(ExecutionAuthorityUnavailableError)
  })

  it('rejects fake, copied and proxied lease authority without IPC', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({ version: 3, type: 'capture-ack', requestId: 'capture-1', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE }),
    ])
    const session = await authenticate(transport, ['capture-1'])
    const lease = await session.captureTurn(HASH)
    const sentBefore = transport.sent.length
    const fake = Object.freeze({
      bindingHash: HASH,
      leaseId: LEASE,
      authorityPhase: 'captured-unbound' as const,
      isHeld: () => true,
      bindCheckpoint: async () => undefined,
      release: async () => undefined,
      releaseDurably: async () => { throw new Error('unused') },
      failClosed(): never { throw new Error('unused') },
    })

    expect(() => assertExecutionSupervisorLeaseAuthority(fake))
      .toThrowError(ExecutionAuthorityUnavailableError)
    expect(() => assertExecutionSupervisorLeaseAuthority({ ...lease }))
      .toThrowError(ExecutionAuthorityUnavailableError)
    expect(() => assertExecutionSupervisorLeaseAuthority(new Proxy(lease, {})))
      .toThrowError(ExecutionAuthorityUnavailableError)
    expect(transport.sent).toHaveLength(sentBefore)
    expect(session.isHeld()).toBe(true)
  })

  it('releases durably, brands the exact receipt and consumes it once', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({ version: 3, type: 'capture-ack', requestId: 'capture-1', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE }),
      frame({ version: 3, type: 'checkpoint-bound-ack', requestId: 'bind-1', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE }),
      frame({ version: 3, type: 'release-durable-ack', requestId: 'durable-1', deadlineAtMs: DEADLINE, sessionId: SESSION, receipt: RELEASE_RECEIPT }),
      frame({ version: 3, type: 'release-receipt-consumed-ack', requestId: 'consume-1', deadlineAtMs: DEADLINE, sessionId: SESSION, envelopeHash: ENVELOPE_HASH, releaseIntentHash: RELEASE_INTENT_HASH, receiptHash: RELEASE_RECEIPT.receiptHash }),
    ])
    const session = await authenticate(transport, [
      'capture-1', 'bind-1', 'durable-1', 'consume-1',
    ])
    const lease = await session.captureTurn(HASH)
    await lease.bindCheckpoint()
    const receipt = await lease.releaseDurably({
      releaseIntentHash: RELEASE_INTENT_HASH,
      envelopeHash: ENVELOPE_HASH,
    })

    expect(lease.isHeld()).toBe(false)
    expect(assertExecutionSupervisorReleaseReceipt(receipt)).toEqual(RELEASE_RECEIPT)
    expect(() => assertExecutionSupervisorReleaseReceipt({ ...receipt }))
      .toThrowError(ExecutionAuthorityUnavailableError)
    await session.consumeReleaseReceipt(receipt)
    expect(() => assertExecutionSupervisorReleaseReceipt(receipt))
      .toThrowError(ExecutionAuthorityUnavailableError)
    await expect(session.consumeReleaseReceipt(receipt))
      .rejects.toThrowError(ExecutionAuthorityUnavailableError)
  })

  it('rejects structural traps in durable release input before sending', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({ version: 3, type: 'capture-ack', requestId: 'capture-1', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE }),
    ])
    const session = await authenticate(transport, ['capture-1'])
    const lease = await session.captureTurn(HASH)
    const sentBefore = transport.sent.length
    const releaseInput = new Proxy({
      releaseIntentHash: RELEASE_INTENT_HASH,
      envelopeHash: ENVELOPE_HASH,
    }, {})

    await expect(lease.releaseDurably(releaseInput))
      .rejects.toThrowError(ExecutionAuthorityUnavailableError)
    expect(transport.sent).toHaveLength(sentBefore)
    expect(session.isHeld()).toBe(false)
  })

  it('rejects a receipt issued to another authenticated session before sending', async () => {
    const firstTransport = channel([
      ...helloFrames(),
      frame({
        version: 3, type: 'recovery-lease', requestId: 'recover-1', deadlineAtMs: DEADLINE,
        sessionId: SESSION, bindingHash: null, leaseId: null, authorityPhase: null,
        releaseReceipt: RELEASE_RECEIPT,
      }),
    ])
    const first = await authenticate(firstTransport, ['recover-1'])
    const recovered = await first.requestRecoveryState()
    expect(recovered.kind).toBe('release-receipt')

    const secondTransport = channel(helloFrames())
    const second = await authenticate(secondTransport, ['consume-foreign'])
    const sentBefore = secondTransport.sent.length
    await expect(second.consumeReleaseReceipt(
      (recovered as Extract<typeof recovered, { kind: 'release-receipt' }>).receipt,
    )).rejects.toThrowError(ExecutionAuthorityUnavailableError)
    expect(secondTransport.sent).toHaveLength(sentBefore)
  })

  it('irrevocably consumes a receipt locally when the parent ACK is lost', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({
        version: 3, type: 'recovery-lease', requestId: 'recover-1', deadlineAtMs: DEADLINE,
        sessionId: SESSION, bindingHash: null, leaseId: null, authorityPhase: null,
        releaseReceipt: RELEASE_RECEIPT,
      }),
    ])
    const session = await authenticate(transport, ['recover-1', 'consume-lost'])
    const recovered = await session.requestRecoveryState()
    expect(recovered.kind).toBe('release-receipt')
    const receipt = (recovered as Extract<typeof recovered, { kind: 'release-receipt' }>).receipt

    await expect(session.consumeReleaseReceipt(receipt))
      .rejects.toThrowError(ExecutionAuthorityUnavailableError)
    expect(session.isHeld()).toBe(false)
    expect(() => assertExecutionSupervisorReleaseReceipt(receipt))
      .toThrowError(ExecutionAuthorityUnavailableError)
    const sentAfterLoss = transport.sent.length
    await expect(session.consumeReleaseReceipt(receipt))
      .rejects.toThrowError(ExecutionAuthorityUnavailableError)
    expect(transport.sent).toHaveLength(sentAfterLoss)
    expect(transport.sent.filter(line => JSON.parse(line).type === 'release-receipt-consumed'))
      .toHaveLength(1)
  })

  it('fails closed on a duplicate checkpoint bind without sending it twice', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({ version: 3, type: 'capture-ack', requestId: 'capture-1', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE }),
      frame({ version: 3, type: 'checkpoint-bound-ack', requestId: 'bind-1', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: HASH, leaseId: LEASE }),
    ])
    const session = await authenticate(transport, ['capture-1', 'bind-1', 'bind-2'])
    const lease = await session.captureTurn(HASH)
    await lease.bindCheckpoint()
    const sentBefore = transport.sent.length

    await expect(lease.bindCheckpoint()).rejects.toThrowError(ExecutionAuthorityUnavailableError)
    expect(session.isHeld()).toBe(false)
    expect(transport.sent).toHaveLength(sentBefore)
  })

  it('authorizes one exact opaque planned restart over the authenticated session', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({
        version: 3, type: 'planned-restart-ack', requestId: 'planned-1',
        deadlineAtMs: DEADLINE, sessionId: SESSION, intentHash: HASH,
      }),
    ])
    const session = await authenticate(transport, ['planned-1'])

    await expect(session.authorizePlannedRestart(HASH)).resolves.toBeUndefined()
    expect(JSON.parse(transport.sent.at(-1)!)).toEqual({
      version: 3, type: 'planned-restart', requestId: 'planned-1',
      deadlineAtMs: DEADLINE, sessionId: SESSION, intentHash: HASH,
    })
  })

  it('latches unavailable on a planned-restart ACK hash mismatch', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({
        version: 3, type: 'planned-restart-ack', requestId: 'planned-1',
        deadlineAtMs: DEADLINE, sessionId: SESSION, intentHash: 'b'.repeat(64),
      }),
    ])
    const session = await authenticate(transport, ['planned-1'])

    await expect(session.authorizePlannedRestart(HASH))
      .rejects.toThrowError(ExecutionAuthorityUnavailableError)
    expect(session.isHeld()).toBe(false)
  })

  it.each([
    ['bad proof', helloFrames({ sessionProof: '0'.repeat(64) })],
    ['foreign session shape', helloFrames({ sessionId: 'short' })],
    ['expired challenge', [frame({ version: 3, type: 'hello-challenge', requestId: 'h', deadlineAtMs: NOW, parentNonce: PARENT })]],
    ['malformed', ['{ nope']],
    ['oversized', ['x'.repeat(4097)]],
  ])('latches unavailable for adversarial hello: %s', async (_kind, replies) => {
    const transport = channel(replies)
    await expect(authenticate(transport)).rejects.toThrowError(ExecutionAuthorityUnavailableError)
    expect(transport.closed).toBe(true)
  })

  it('latches on a duplicate outbound request id and performs no second send', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({ version: 3, type: 'recovery-lease', requestId: 'same', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: null, leaseId: null, authorityPhase: null, releaseReceipt: null }),
    ])
    const session = await authenticate(transport, ['same', 'same'])
    await session.requestRecoveryState()
    const sentBefore = transport.sent.length

    await expect(session.captureTurn(HASH)).rejects.toThrowError(ExecutionAuthorityUnavailableError)
    expect(session.isHeld()).toBe(false)
    expect(transport.sent).toHaveLength(sentBefore)
  })

  it('reserves the hello request id against operational reuse', async () => {
    const transport = channel(helloFrames())
    const session = await authenticate(transport, ['hello-1'])
    const sentBefore = transport.sent.length

    await expect(session.requestRecoveryState()).rejects.toThrowError(ExecutionAuthorityUnavailableError)
    expect(session.isHeld()).toBe(false)
    expect(transport.sent).toHaveLength(sentBefore)
  })

  it('latches a foreign or late operational reply and notifies loss once', async () => {
    const transport = channel([
      ...helloFrames(),
      frame({ version: 3, type: 'recovery-lease', requestId: 'foreign', deadlineAtMs: DEADLINE, sessionId: SESSION, bindingHash: null, leaseId: null, authorityPhase: null, releaseReceipt: null }),
    ])
    const session = await authenticate(transport)
    const lost = vi.fn()
    session.onLost(lost)

    await expect(session.requestRecoveryState()).rejects.toThrowError(ExecutionAuthorityUnavailableError)
    expect(session.isHeld()).toBe(false)
    expect(lost).toHaveBeenCalledOnce()
  })

  it('loses a held session on direct IPC disconnect', async () => {
    const transport = channel(helloFrames())
    const session = await authenticate(transport)
    const lost = vi.fn()
    session.onLost(lost)

    transport.disconnect()
    expect(session.isHeld()).toBe(false)
    expect(lost).toHaveBeenCalledOnce()
  })

  it('notifies a listener registered after a latched IPC disconnect synchronously', async () => {
    const transport = channel(helloFrames())
    const session = await authenticate(transport)
    transport.disconnect()
    const observed: string[] = []

    session.onLost(() => { observed.push('lost') })
    observed.push('after-register')

    expect(session.isHeld()).toBe(false)
    expect(observed).toEqual(['lost', 'after-register'])
  })

  it('actively disconnects the inherited Node IPC port when closing', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const disconnect = vi.fn()
    const port = {
      connected: true,
      send: () => true,
      on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener) },
      off: (event: string) => { listeners.delete(event) },
      disconnect,
    }
    const transport = makeNodeExecutionSupervisorChildChannel(port)

    transport.close()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
  })

  it('removes a timed-out Node IPC waiter before delivering the next frame', async () => {
    vi.useFakeTimers()
    try {
      const listeners = new Map<string, (...args: unknown[]) => void>()
      const port = {
        connected: true,
        send: () => true,
        on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener) },
        off: (event: string) => { listeners.delete(event) },
        disconnect: vi.fn(),
      }
      const transport = makeNodeExecutionSupervisorChildChannel(port)
      const expired = transport.receive(100)
      const expiry = expect(expired).rejects.toThrowError(ExecutionAuthorityUnavailableError)
      await vi.advanceTimersByTimeAsync(100)
      await expiry

      const current = transport.receive(100)
      listeners.get('message')?.('next-frame')
      await expect(current).resolves.toBe('next-frame')
      transport.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
