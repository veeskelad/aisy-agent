import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DurableExecutionEnvelopeError,
  durableExecutionEnvelopeHash,
  durableExecutionWorkBindingHash,
  makeNodeDurableExecutionEnvelopeController,
  type DurableExecutionActorRefV1,
  type DurableExecutionEnvelopeIdentityV1,
  type DurableExecutionEnvelopeRecordV1,
  type DurableExecutionEnvelopeStartV1,
  type DurableExecutionEnvelopeTransitionV1,
  type DurableExecutionTelegramDeliveryV1,
  type NodeDurableExecutionEnvelopeControllerV1,
} from './durable-execution-envelope.js'

const H1 = '1'.repeat(64)
const H2 = '2'.repeat(64)
const H3 = '3'.repeat(64)
const H4 = '4'.repeat(64)
const H5 = '5'.repeat(64)
const H6 = '6'.repeat(64)
const H7 = '7'.repeat(64)
const H8 = '8'.repeat(64)
const H9 = '9'.repeat(64)
const HA = 'a'.repeat(64)
const HB = 'b'.repeat(64)
const HC = 'c'.repeat(64)
const HD = 'd'.repeat(64)
const roots: string[] = []

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const binding = Object.freeze({
  botId: 'bot-1',
  operatorId: 'operator-1',
  profileId: 'profile-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  scope: 'session' as const,
})

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function root(): Readonly<{ root: string; path: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'aisy-execution-envelope-'))
  roots.push(directory)
  return Object.freeze({ root: directory, path: join(directory, 'execution-envelope.sqlite3') })
}

function identityFor(
  workBinding: DurableExecutionEnvelopeIdentityV1['binding'] = binding,
  options: Readonly<{
    mode?: 'auto' | 'confirm' | 'plan' | 'bypass'
    chatBindingHash?: string
    turnIdHash?: string
    dispatchId?: string
  }> = {},
): Omit<DurableExecutionEnvelopeIdentityV1, 'schemaVersion'> {
  const projection = {
    binding: workBinding,
    sessionId: workBinding.sessionId,
    installationHash: H1,
    mode: options.mode ?? 'confirm',
    runLivenessHash: H2,
    workBindingHash: durableExecutionWorkBindingHash(workBinding),
    chatBindingHash: options.chatBindingHash ?? H3,
    replyBindingHash: HC,
    dispatchId: options.dispatchId ?? H4,
    turnIdHash: options.turnIdHash ?? H5,
    executionBindingHash: H6,
    supervisorBindingHash: H6,
    continuationHash: HD,
    policyRevision: 'policy-1',
  } as const
  return Object.freeze({ ...projection, envelopeHash: durableExecutionEnvelopeHash(projection) })
}

function pendingDelivery(identity: Omit<DurableExecutionEnvelopeIdentityV1, 'schemaVersion'>):
DurableExecutionTelegramDeliveryV1 {
  return Object.freeze({
    revision: 1,
    delivery: 'pending',
    executionBindingHash: identity.executionBindingHash,
    replyBindingHash: identity.replyBindingHash,
    dispatchId: identity.dispatchId,
    checkpointHash: H7,
    refHash: null,
  })
}

function startInput(
  identity = identityFor(),
  overrides: Partial<Omit<DurableExecutionEnvelopeStartV1, 'identity'>> = {},
): DurableExecutionEnvelopeStartV1 {
  return {
    identity,
    telegramDelivery: pendingDelivery(identity),
    delegationInventory: [],
    actor: null,
    control: {
      controlHash: H8,
      revision: 1,
      envelopeHash: identity.envelopeHash,
      supervisorBindingHash: identity.supervisorBindingHash,
      policyRevision: identity.policyRevision,
    },
    ...overrides,
  }
}

function actor(
  record: DurableExecutionEnvelopeRecordV1,
  revision = 1,
  actorHash = H9,
): DurableExecutionActorRefV1 {
  return {
    actorId: 'actor-1',
    actorHash,
    revision,
    envelopeHash: record.identity.envelopeHash,
    workBindingHash: record.identity.workBindingHash,
    executionBindingHash: record.identity.executionBindingHash,
    policyRevision: record.identity.policyRevision,
  }
}

function transition(
  record: DurableExecutionEnvelopeRecordV1,
  nextPhase: DurableExecutionEnvelopeTransitionV1['nextPhase'],
  overrides: Partial<DurableExecutionEnvelopeTransitionV1> = {},
): DurableExecutionEnvelopeTransitionV1 {
  return {
    envelopeHash: record.identity.envelopeHash,
    expectedRevision: record.revision,
    expectedPhase: record.phase,
    nextPhase,
    telegramDelivery: record.telegramDelivery,
    delegationInventory: record.delegationInventory,
    actor: record.actor,
    control: record.control,
    terminalReceipt: null,
    ...overrides,
  }
}

function started(controller: NodeDurableExecutionEnvelopeControllerV1,
  input = startInput()): DurableExecutionEnvelopeRecordV1 {
  const result = controller.manager.start(input)
  if (result.kind !== 'started') throw new Error('expected started envelope')
  return result.record
}

function delivered(record: DurableExecutionEnvelopeRecordV1): DurableExecutionTelegramDeliveryV1 {
  return {
    revision: record.telegramDelivery.revision + 1,
    delivery: 'delivered',
    executionBindingHash: record.identity.executionBindingHash,
    replyBindingHash: record.identity.replyBindingHash,
    dispatchId: record.identity.dispatchId,
    checkpointHash: HA,
    refHash: HB,
  }
}

function terminalReceipt(
  record: DurableExecutionEnvelopeRecordV1,
  kind: 'completed' | 'cancelled' | 'failed' | 'denied',
  code: string,
  receiptHash: string,
  atMs: number,
) {
  return {
    kind,
    code,
    receiptHash,
    envelopeHash: record.identity.envelopeHash,
    workBindingHash: record.identity.workBindingHash,
    executionBindingHash: record.identity.executionBindingHash,
    dispatchId: record.identity.dispatchId,
    policyRevision: record.identity.policyRevision,
    atMs,
  } as const
}

describe('dormant durable execution envelope', () => {
  it('persists exact hashed bindings and exposes a frozen informational inspection plan', () => {
    const location = root()
    const rawChat = 'telegram-chat-987654321'
    const rawTurn = 'telegram-chat-987654321:turn:42'
    const rawRunRoot = '/srv/aisy/private/runs/operator-secret'
    const identity = identityFor(binding, {
      chatBindingHash: digest(rawChat),
      turnIdHash: digest(rawTurn),
    })
    const input = startInput(identity, {
      delegationInventory: [{
        runRootHash: digest(rawRunRoot),
        inventoryHash: HA,
        authorityHash: HB,
        revision: 1,
        policyRevision: identity.policyRevision,
      }],
    })
    const controller = makeNodeDurableExecutionEnvelopeController({
      path: location.path,
      nowMs: () => 1_000,
    })
    const record = started(controller, input)
    const plan = controller.inspector.recoveryPlan()
    expect(plan).toMatchObject({
      kind: 'inspect-running',
      envelopeHash: record.identity.envelopeHash,
      chatBindingHash: digest(rawChat),
      turnIdHash: digest(rawTurn),
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan?.binding)).toBe(true)
    expect(Object.isFrozen(plan?.delegationInventory)).toBe(true)
    expect(Object.keys(controller.inspector)).toEqual(['inspect', 'recoveryPlan'])

    const bytes = readFileSync(location.path)
    for (const forbidden of [rawChat, rawTurn, rawRunRoot, location.root, 'raw prompt', 'secret-token']) {
      expect(bytes.includes(Buffer.from(forbidden))).toBe(false)
    }
    for (const expected of [digest(rawChat), digest(rawTurn), digest(rawRunRoot)]) {
      expect(bytes.includes(Buffer.from(expected))).toBe(true)
    }
    controller.close()
  })

  it('binds actor, control and delegation projections without copying actor decisions', () => {
    const location = root()
    const clock = { now: 1_000 }
    const controller = makeNodeDurableExecutionEnvelopeController({
      path: location.path,
      nowMs: () => clock.now,
    })
    const running = started(controller)
    clock.now = 1_100
    const paused = controller.manager.transition(transition(running, 'paused-awaiting-approval', {
      delegationInventory: [{
        runRootHash: HA,
        inventoryHash: HB,
        authorityHash: HC,
        revision: 1,
        policyRevision: running.identity.policyRevision,
      }],
      actor: actor(running),
      control: { ...running.control, controlHash: HD, revision: 2 },
    }))
    expect(paused.actor).toMatchObject({ actorId: 'actor-1', revision: 1 })
    expect(Object.keys(paused.actor!)).not.toContain('decision')
    expect(Object.keys(paused.actor!)).not.toContain('nonce')

    clock.now = 1_200
    const ready = controller.manager.transition(transition(paused, 'resume-ready', {
      actor: actor(paused, 2, HC),
      delegationInventory: [{ ...paused.delegationInventory[0]!, inventoryHash: HD, revision: 2 }],
    }))
    expect(ready.actor?.revision).toBe(2)
    controller.close()
  })

  it('keeps terminal active until exact delivery and supervisor release, including restart', () => {
    const location = root()
    const clock = { now: 1_000 }
    const first = makeNodeDurableExecutionEnvelopeController({
      path: location.path,
      nowMs: () => clock.now,
    })
    const running = started(first)
    clock.now = 1_100
    const terminal = first.manager.transition(transition(running, 'terminal', {
      terminalReceipt: terminalReceipt(running, 'denied', 'POLICY_DENIED', HC, 1_050),
    }))
    expect(terminal.terminalReceipt?.atMs).toBe(1_050)
    expect(first.inspector.recoveryPlan()).toMatchObject({ kind: 'inspect-terminal' })
    expect(() => first.manager.retireTerminal({
      envelopeHash: terminal.identity.envelopeHash,
      expectedRevision: terminal.revision,
      receiptHash: HC,
      releaseReceiptHash: HD,
    })).toThrowError(new DurableExecutionEnvelopeError(
      'DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED',
    ))

    clock.now = 1_200
    const withDelivery = first.manager.recordTelegramDelivery({
      envelopeHash: terminal.identity.envelopeHash,
      expectedRevision: terminal.revision,
      delivery: delivered(terminal),
    })
    expect(() => first.manager.retireTerminal({
      envelopeHash: terminal.identity.envelopeHash,
      expectedRevision: withDelivery.revision,
      receiptHash: HC,
      releaseReceiptHash: HD,
    })).toThrowError(new DurableExecutionEnvelopeError(
      'DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED',
    ))

    clock.now = 1_300
    expect(() => first.manager.recordSupervisorRelease({
      envelopeHash: terminal.identity.envelopeHash,
      expectedRevision: withDelivery.revision,
      release: {
        releaseReceiptHash: HD,
        supervisorBindingHash: terminal.identity.supervisorBindingHash,
        runLivenessHash: terminal.identity.runLivenessHash,
        releasedAtMs: 1_199,
      },
    })).toThrowError(new DurableExecutionEnvelopeError(
      'DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED',
    ))
    expect(first.inspector.recoveryPlan()).toMatchObject({ revision: withDelivery.revision })
    const withRelease = first.manager.recordSupervisorRelease({
      envelopeHash: terminal.identity.envelopeHash,
      expectedRevision: withDelivery.revision,
      release: {
        releaseReceiptHash: HD,
        supervisorBindingHash: terminal.identity.supervisorBindingHash,
        runLivenessHash: terminal.identity.runLivenessHash,
        releasedAtMs: 1_250,
      },
    })
    first.close()

    const second = makeNodeDurableExecutionEnvelopeController({
      path: location.path,
      nowMs: () => clock.now,
    })
    expect(second.inspector.recoveryPlan()).toMatchObject({
      kind: 'inspect-terminal',
      revision: withRelease.revision,
      supervisorRelease: { releaseReceiptHash: HD, releasedAtMs: 1_250 },
    })
    clock.now = 1_400
    const retired = second.manager.retireTerminal({
      envelopeHash: terminal.identity.envelopeHash,
      expectedRevision: withRelease.revision,
      receiptHash: HC,
      releaseReceiptHash: HD,
    })
    expect(retired.retiredAtMs).toBe(1_400)
    expect(second.inspector.recoveryPlan()).toBeNull()
    const nextIdentity = identityFor(binding, { turnIdHash: HC, dispatchId: HD })
    expect(second.manager.start(startInput(nextIdentity))).toMatchObject({
      kind: 'started',
      record: { identity: { turnIdHash: HC, dispatchId: HD } },
    })
    second.close()
  })

  it('rejects delivery/release cross-binding and does not mutate the envelope', () => {
    const location = root()
    const clock = { now: 1_000 }
    const controller = makeNodeDurableExecutionEnvelopeController({
      path: location.path,
      nowMs: () => clock.now,
    })
    const running = started(controller)
    clock.now = 1_100
    const otherIdentity = identityFor(binding, { turnIdHash: HB, dispatchId: HD })
    for (const crossReceipt of [
      {
        ...terminalReceipt(running, 'completed', 'DONE', HA, 1_100),
        envelopeHash: HD,
      },
      {
        ...terminalReceipt(running, 'completed', 'DONE', HA, 1_100),
        envelopeHash: otherIdentity.envelopeHash,
        dispatchId: otherIdentity.dispatchId,
      },
    ]) {
      expect(() => controller.manager.transition(transition(running, 'terminal', {
        terminalReceipt: crossReceipt,
      }))).toThrowError(new DurableExecutionEnvelopeError(
        'DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED',
      ))
    }
    expect(() => controller.manager.transition(transition(running, 'terminal', {
      terminalReceipt: terminalReceipt(running, 'completed', 'DONE', HA, 999),
    }))).toThrowError(new DurableExecutionEnvelopeError(
      'DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED',
    ))
    expect(controller.inspector.recoveryPlan()).toMatchObject({ revision: running.revision })
    const terminal = controller.manager.transition(transition(running, 'terminal', {
      terminalReceipt: terminalReceipt(running, 'completed', 'DONE', HA, 1_100),
    }))
    for (const drift of [
      { ...delivered(terminal), executionBindingHash: HD },
      { ...delivered(terminal), replyBindingHash: HD },
      { ...delivered(terminal), dispatchId: HD },
    ]) {
      expect(() => controller.manager.recordTelegramDelivery({
        envelopeHash: terminal.identity.envelopeHash,
        expectedRevision: terminal.revision,
        delivery: drift,
      })).toThrowError(new DurableExecutionEnvelopeError(
        'DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED',
      ))
    }
    expect(controller.inspector.recoveryPlan()).toMatchObject({ revision: terminal.revision })
    const withDelivery = controller.manager.recordTelegramDelivery({
      envelopeHash: terminal.identity.envelopeHash,
      expectedRevision: terminal.revision,
      delivery: delivered(terminal),
    })
    expect(() => controller.manager.recordSupervisorRelease({
      envelopeHash: terminal.identity.envelopeHash,
      expectedRevision: withDelivery.revision,
      release: {
        releaseReceiptHash: HB,
        supervisorBindingHash: HD,
        runLivenessHash: terminal.identity.runLivenessHash,
        releasedAtMs: 1_100,
      },
    })).toThrowError(new DurableExecutionEnvelopeError(
      'DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED',
    ))
    expect(controller.inspector.recoveryPlan()).toMatchObject({ revision: withDelivery.revision })
    controller.close()
  })

  it('enforces one installation envelope and reports the exact active plan', () => {
    const location = root()
    const controller = makeNodeDurableExecutionEnvelopeController({ path: location.path })
    const first = started(controller)
    const secondBinding = { ...binding, sessionId: 'session-2' }
    const busy = controller.manager.start(startInput(identityFor(secondBinding, {
      turnIdHash: HA,
      chatBindingHash: HB,
    })))
    expect(busy).toMatchObject({
      kind: 'busy',
      plan: { envelopeHash: first.identity.envelopeHash, sessionId: 'session-1' },
    })
    controller.close()
  })

  it('rejects cross-task, cross-chat and cross-mode identity drift before persistence', () => {
    for (const changed of [
      identityFor({ ...binding, sessionId: 'session-2' }),
      identityFor(binding, { chatBindingHash: HA }),
      identityFor(binding, { mode: 'bypass' }),
    ]) {
      const location = root()
      const controller = makeNodeDurableExecutionEnvelopeController({ path: location.path })
      expect(() => controller.manager.start(startInput({ ...changed, envelopeHash: H1 })))
        .toThrowError(new DurableExecutionEnvelopeError(
          'DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID',
        ))
      expect(controller.inspector.recoveryPlan()).toBeNull()
      controller.close()
    }
  })

  it('rejects inventory removal, actor replacement and approval without actor advance', () => {
    const location = root()
    const clock = { now: 1_000 }
    const controller = makeNodeDurableExecutionEnvelopeController({
      path: location.path,
      nowMs: () => clock.now,
    })
    const running = started(controller)
    clock.now = 1_100
    const paused = controller.manager.transition(transition(running, 'paused-awaiting-approval', {
      delegationInventory: [{
        runRootHash: HA, inventoryHash: HB, authorityHash: HC, revision: 1,
        policyRevision: running.identity.policyRevision,
      }],
      actor: actor(running),
    }))
    const attempts = [
      transition(paused, 'resume-ready', { delegationInventory: [], actor: actor(paused, 2) }),
      transition(paused, 'resume-ready', {
        actor: { ...actor(paused, 2), actorId: 'actor-2' },
      }),
      transition(paused, 'resume-ready', { actor: actor(paused, 1) }),
      transition(paused, 'resume-ready', {
        actor: { ...actor(paused, 2), envelopeHash: HD },
      }),
      transition(paused, 'resume-ready', {
        actor: actor(paused, 2),
        delegationInventory: [{ ...paused.delegationInventory[0]!, policyRevision: 'policy-2' }],
      }),
    ]
    for (const attempt of attempts) {
      expect(() => controller.manager.transition(attempt)).toThrowError(
        new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED'),
      )
    }
    expect(controller.inspector.recoveryPlan()).toMatchObject({ revision: 2 })
    controller.close()
  })

  it('lets one stale CAS contender win and rejects clock rollback without mutation', () => {
    const location = root()
    const clock = { now: 1_100 }
    const controller = makeNodeDurableExecutionEnvelopeController({
      path: location.path,
      nowMs: () => clock.now,
    })
    const running = started(controller)
    const candidate = transition(running, 'cancelling')
    expect(controller.manager.transition(candidate).phase).toBe('cancelling')
    expect(() => controller.manager.transition(candidate)).toThrowError(
      new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED'),
    )
    const cancelling = controller.inspector.inspect(running.identity.envelopeHash)!
    clock.now = 1_099
    expect(() => controller.manager.transition(transition(cancelling, 'quarantine'))).toThrowError(
      new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED'),
    )
    expect(controller.inspector.recoveryPlan()).toMatchObject({
      revision: 2,
      kind: 'inspect-cancelling',
    })
    controller.close()
  })

  it('recovers a hot rollback journal and removes the recovered sidecar', () => {
    const location = root()
    const first = makeNodeDurableExecutionEnvelopeController({ path: location.path })
    const running = started(first)
    first.close()
    const crashed = spawnSync(process.execPath, ['-e', [
      "const Database = require('better-sqlite3')",
      'const db = new Database(process.argv[1])',
      "db.pragma('journal_mode = DELETE')",
      "db.exec('BEGIN IMMEDIATE')",
      "db.prepare('UPDATE durable_execution_envelopes SET revision = revision + 9').run()",
      "process.kill(process.pid, 'SIGKILL')",
    ].join(';'), location.path], { cwd: process.cwd() })
    expect(crashed.signal).toBe('SIGKILL')
    expect(existsSync(location.path + '-journal')).toBe(true)
    const recovered = makeNodeDurableExecutionEnvelopeController({ path: location.path })
    expect(recovered.inspector.recoveryPlan()).toMatchObject({
      envelopeHash: running.identity.envelopeHash,
      revision: 1,
    })
    expect(existsSync(location.path + '-journal')).toBe(false)
    recovered.close()
  })

  it('rejects private stale journals and private or unsafe WAL/SHM sidecars', () => {
    const safeStale = root()
    const safeInitialized = makeNodeDurableExecutionEnvelopeController({ path: safeStale.path })
    safeInitialized.close()
    writeFileSync(safeStale.path + '-journal', Buffer.alloc(8), { mode: 0o600 })
    const safeReopened = makeNodeDurableExecutionEnvelopeController({ path: safeStale.path })
    expect(existsSync(safeStale.path + '-journal')).toBe(false)
    safeReopened.close()

    const stale = root()
    const initialized = makeNodeDurableExecutionEnvelopeController({ path: stale.path })
    initialized.close()
    writeFileSync(stale.path + '-journal', Buffer.from('not-a-recovered-journal'), { mode: 0o600 })
    expect(() => makeNodeDurableExecutionEnvelopeController({ path: stale.path }))
      .toThrowError(new DurableExecutionEnvelopeError(
        'DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT',
      ))

    for (const [suffix, mode, code] of [
      ['-wal', 0o600, 'DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT'],
      ['-shm', 0o644, 'DURABLE_EXECUTION_ENVELOPE_STORE_UNSAFE'],
    ] as const) {
      const location = root()
      writeFileSync(location.path + suffix, 'sidecar', { mode })
      chmodSync(location.path + suffix, mode)
      expect(() => makeNodeDurableExecutionEnvelopeController({ path: location.path }))
        .toThrowError(new DurableExecutionEnvelopeError(code))
    }
  })

  it('validates every retired row and refuses a corrupt retired record', () => {
    const location = root()
    const clock = { now: 1_000 }
    const first = makeNodeDurableExecutionEnvelopeController({
      path: location.path,
      nowMs: () => clock.now,
    })
    const running = started(first)
    clock.now = 1_100
    const terminal = first.manager.transition(transition(running, 'terminal', {
      terminalReceipt: terminalReceipt(running, 'failed', 'FAILED', HA, 1_100),
    }))
    clock.now = 1_200
    const delivery = first.manager.recordTelegramDelivery({
      envelopeHash: terminal.identity.envelopeHash,
      expectedRevision: terminal.revision,
      delivery: delivered(terminal),
    })
    clock.now = 1_300
    const release = first.manager.recordSupervisorRelease({
      envelopeHash: terminal.identity.envelopeHash,
      expectedRevision: delivery.revision,
      release: {
        releaseReceiptHash: HB,
        supervisorBindingHash: terminal.identity.supervisorBindingHash,
        runLivenessHash: terminal.identity.runLivenessHash,
        releasedAtMs: 1_300,
      },
    })
    clock.now = 1_400
    first.manager.retireTerminal({
      envelopeHash: terminal.identity.envelopeHash,
      expectedRevision: release.revision,
      receiptHash: HA,
      releaseReceiptHash: HB,
    })
    first.close()

    const database = new Database(location.path)
    database.exec("UPDATE durable_execution_envelopes SET record_json = '{\"corrupt\":true}'")
    database.close()
    const reopened = makeNodeDurableExecutionEnvelopeController({ path: location.path })
    expect(() => reopened.inspector.recoveryPlan()).toThrowError(
      new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT'),
    )
    reopened.close()

    const oversized = root()
    const oversizedController = makeNodeDurableExecutionEnvelopeController({ path: oversized.path })
    started(oversizedController)
    oversizedController.close()
    const oversizedDb = new Database(oversized.path)
    oversizedDb.prepare('UPDATE durable_execution_envelopes SET record_json = ?')
      .run('x'.repeat(1024 * 1024 + 1))
    oversizedDb.close()
    const oversizedReopened = makeNodeDurableExecutionEnvelopeController({ path: oversized.path })
    expect(() => oversizedReopened.inspector.recoveryPlan()).toThrowError(
      new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT'),
    )
    oversizedReopened.close()
  })

  it('bounds the full ordered inventory at 4096 rows before parsing records', () => {
    const location = root()
    const initialized = makeNodeDurableExecutionEnvelopeController({ path: location.path })
    initialized.close()
    const database = new Database(location.path)
    const insert = database.prepare(
      'INSERT INTO durable_execution_envelopes '
      + '(envelope_hash, session_id, turn_id_hash, phase, revision, active_slot, record_json, '
      + 'record_hash) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
    )
    const fill = database.transaction(() => {
      for (let index = 0; index < 4_097; index += 1) {
        insert.run(index.toString(16).padStart(64, '0'), 'session', H1, 'terminal', 1, '{}', H2)
      }
    })
    fill()
    database.close()
    const reopened = makeNodeDurableExecutionEnvelopeController({ path: location.path })
    expect(() => reopened.inspector.recoveryPlan()).toThrowError(
      new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT'),
    )
    reopened.close()
  })

  it('refuses schema drift, active-slot downgrade, concurrent writers and closed surfaces', () => {
    const location = root()
    const first = makeNodeDurableExecutionEnvelopeController({ path: location.path })
    started(first)
    expect(() => makeNodeDurableExecutionEnvelopeController({ path: location.path }))
      .toThrowError(new DurableExecutionEnvelopeError(
        'DURABLE_EXECUTION_ENVELOPE_STORE_UNAVAILABLE',
      ))
    first.close()
    expect(() => first.inspector.recoveryPlan()).toThrowError(
      new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_STORE_CLOSED'),
    )

    const database = new Database(location.path)
    database.exec('UPDATE durable_execution_envelopes SET active_slot = NULL')
    database.close()
    const reopened = makeNodeDurableExecutionEnvelopeController({ path: location.path })
    expect(() => reopened.manager.start(startInput())).toThrowError(
      new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT'),
    )
    reopened.close()

    const extra = root()
    const clean = makeNodeDurableExecutionEnvelopeController({ path: extra.path })
    clean.close()
    const extraDb = new Database(extra.path)
    extraDb.exec('CREATE TABLE unexpected (value TEXT)')
    extraDb.close()
    expect(() => makeNodeDurableExecutionEnvelopeController({ path: extra.path }))
      .toThrowError(new DurableExecutionEnvelopeError(
        'DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT',
      ))

    const wrongVersion = root()
    const versioned = makeNodeDurableExecutionEnvelopeController({ path: wrongVersion.path })
    versioned.close()
    const versionDb = new Database(wrongVersion.path)
    versionDb.pragma('user_version = 2')
    versionDb.close()
    expect(() => makeNodeDurableExecutionEnvelopeController({ path: wrongVersion.path }))
      .toThrowError(new DurableExecutionEnvelopeError(
        'DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT',
      ))
  })

  it('rejects raw-like expansion and Proxy input before persistence', () => {
    const location = root()
    const controller = makeNodeDurableExecutionEnvelopeController({ path: location.path })
    expect(() => controller.manager.start({ ...startInput(), rawPrompt: 'secret' } as never))
      .toThrowError(new DurableExecutionEnvelopeError(
        'DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID',
      ))
    expect(() => controller.manager.start(new Proxy(startInput(), {}) as never)).toThrowError(
      new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID'),
    )
    const identity = identityFor()
    expect(() => controller.manager.start(startInput(identity, {
      telegramDelivery: {
        ...pendingDelivery(identity),
        revision: 2,
        delivery: 'delivered',
        refHash: HA,
      },
    }))).toThrowError(new DurableExecutionEnvelopeError(
      'DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED',
    ))
    expect(controller.inspector.recoveryPlan()).toBeNull()
    controller.close()
  })
})
