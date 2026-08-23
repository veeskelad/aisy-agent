import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { ExecutionState } from '@aisy/telegram-gw'
import {
  confirmTelegramExecutionCheckpointDelivery,
  computeTelegramExecutionCheckpointChecksum,
  discardNodeTelegramExecutionCheckpoint,
  inspectNodeTelegramExecutionCheckpoint,
  inspectNodeTelegramExecutionCheckpointForDirectRun,
  makeJsonTelegramExecutionCheckpointStore,
  makeNodeTelegramExecutionCheckpointStore,
  makeTelegramExecutionDeliveryReceipt,
  makeTelegramExecutionBindingHash,
  makeTelegramExecutionCheckpoint,
  recoverTelegramExecutionCheckpoint,
  validateTelegramExecutionCheckpoint,
} from './telegram-execution-checkpoint.js'

const BINDING = makeTelegramExecutionBindingHash({
  chatId: 42,
  sessionId: 'session-a',
  turnId: 'telegram:42:turn-a',
})

function runningState(): ExecutionState {
  return {
    scope: 'проект «A»',
    steps: [],
    tool: { name: 'read_file', kind: 'tool', status: 'running' },
    action: { kind: 'inspect-required', status: 'recovering', missing: 'observation' },
    usage: { inputTokens: 12, outputTokens: 3, dollars: 0.05 },
    thinking: true,
    status: 'running',
  }
}

function checkpoint(overrides?: Partial<Parameters<typeof makeTelegramExecutionCheckpoint>[0]>) {
  return makeTelegramExecutionCheckpoint({
    bindingHash: BINDING,
    ownerId: 'owner-a',
    revision: 1,
    phase: 'prepared',
    delivery: 'pending',
    locked: false,
    state: runningState(),
    updatedAt: '2026-07-28T06:00:00.000Z',
    ...overrides,
  })
}

function memoryStore(initial?: string) {
  let content = initial
  const saveAtomic = vi.fn((next: string) => { content = next })
  const store = makeJsonTelegramExecutionCheckpointStore({
    exists: () => content !== undefined,
    read: () => content ?? '',
    saveAtomic,
  })
  return { store, saveAtomic, content: () => content }
}

function bind(store: ReturnType<typeof memoryStore>['store'], initial = checkpoint()) {
  store.begin(initial)
  const bound = checkpoint({
    revision: initial.revision + 1,
    phase: 'bound',
    delivery: 'delivered',
    messageId: 9,
  })
  store.replace(bound, {
    ownerId: initial.ownerId,
    revision: initial.revision,
    bindingHash: initial.bindingHash,
  })
  return bound
}

describe('Telegram execution checkpoint', () => {
  it('uses only hashed chat/session/turn binding material', () => {
    expect(BINDING).toMatch(/^[a-f0-9]{64}$/)
    expect(makeTelegramExecutionBindingHash({
      chatId: 42,
      sessionId: 'session-a',
      turnId: 'telegram:42:turn-b',
    })).not.toBe(BINDING)
    expect(JSON.stringify(checkpoint())).not.toContain('telegram:42:turn-a')
  })

  it('accepts the strict redacted projection and rejects display-bearing extras', () => {
    expect(validateTelegramExecutionCheckpoint(checkpoint())).toMatchObject({
      schemaVersion: 1,
      bindingHash: BINDING,
      ownerId: 'owner-a',
    })

    const unsafe = structuredClone(checkpoint()) as unknown as Record<string, unknown>
    const unsafeState = unsafe['state'] as Record<string, unknown>
    unsafeState['note'] = 'raw provider diagnostic'
    unsafe['checksum'] = computeTelegramExecutionCheckpointChecksum(unsafe as never)
    expect(() => validateTelegramExecutionCheckpoint(unsafe)).toThrow('EXECUTION_CHECKPOINT_INVALID')

    const withArgs = structuredClone(checkpoint()) as unknown as Record<string, unknown>
    const state = withArgs['state'] as Record<string, unknown>
    ;(state['tool'] as Record<string, unknown>)['arg'] = '--private-value omitted'
    withArgs['checksum'] = computeTelegramExecutionCheckpointChecksum(withArgs as never)
    expect(() => validateTelegramExecutionCheckpoint(withArgs)).toThrow('EXECUTION_CHECKPOINT_INVALID')
  })

  it('quarantines corrupt bytes and rejects active or stale-owner replacement', () => {
    const corrupt = memoryStore('{"schemaVersion":1,"unexpected":"value"}')
    expect(corrupt.store.load()).toEqual({
      status: 'quarantined',
      reason: 'corrupt-or-unsafe-checkpoint',
    })
    expect(() => corrupt.store.begin(checkpoint())).toThrow('EXECUTION_CHECKPOINT_QUARANTINED')

    const h = memoryStore()
    const current = bind(h.store)
    expect(() => h.store.begin(checkpoint({ ownerId: 'owner-b' })))
      .toThrow('EXECUTION_CHECKPOINT_ACTIVE')
    expect(() => h.store.replace(checkpoint({
      ownerId: 'owner-b',
      revision: current.revision + 1,
      phase: 'bound',
      delivery: 'pending',
      messageId: 9,
    }), {
      ownerId: 'owner-b',
      revision: current.revision,
      bindingHash: current.bindingHash,
    })).toThrow('EXECUTION_CHECKPOINT_STALE_OWNER')
  })

  it('persists a private atomic checkpoint and restores it after a Node restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-execution-checkpoint-'))
    const path = join(root, 'telegram', 'execution-card.json')
    const first = makeNodeTelegramExecutionCheckpointStore({ path })
    const expected = bind(first)

    const restarted = makeNodeTelegramExecutionCheckpointStore({ path })
    expect(restarted.load()).toEqual({ status: 'ready', checkpoint: expected })
    expect(statSync(path).mode & 0o077).toBe(0)
    expect(readFileSync(path, 'utf8')).not.toContain('telegram:42:turn-a')
  })

  it('confirms exact delivery only through a pinned private Node-store capability', () => {
    const trustedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-execution-confirm-')))
    const path = join(trustedRoot, 'telegram', 'execution-card.json')
    const store = makeNodeTelegramExecutionCheckpointStore({ path, trustedRoot })
    const bound = bind(store)
    const terminal = checkpoint({
      ownerId: bound.ownerId,
      revision: bound.revision + 1,
      phase: 'terminal',
      delivery: 'delivered',
      messageId: 9,
      state: { ...runningState(), thinking: false, status: 'completed' },
    })
    store.replace(terminal, {
      ownerId: bound.ownerId,
      revision: bound.revision,
      bindingHash: bound.bindingHash,
    })
    const receipt = makeTelegramExecutionDeliveryReceipt(terminal)
    expect(receipt).not.toBeNull()
    expect(confirmTelegramExecutionCheckpointDelivery({
      store,
      bindingHash: BINDING,
      expectedReceipt: receipt!,
    })).toEqual({ kind: 'delivered', receipt })
    expect(confirmTelegramExecutionCheckpointDelivery({
      store: new Proxy(store, {}),
      bindingHash: BINDING,
      expectedReceipt: receipt!,
    })).toEqual({ kind: 'unavailable' })
    expect(confirmTelegramExecutionCheckpointDelivery({
      store,
      bindingHash: BINDING,
      expectedReceipt: { ...receipt!, checkpointHash: 'f'.repeat(64) },
    })).toEqual({
      kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN', revision: terminal.revision, messageId: 9,
    })
  })

  it('quarantines an on-disk checkpoint with public permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-execution-permissions-'))
    const path = join(root, 'execution-card.json')
    writeFileSync(path, JSON.stringify(checkpoint()), { mode: 0o600 })
    chmodSync(path, 0o644)
    expect(makeNodeTelegramExecutionCheckpointStore({ path }).load()).toEqual({
      status: 'quarantined',
      reason: 'corrupt-or-unsafe-checkpoint',
    })
    expect(inspectNodeTelegramExecutionCheckpoint({ path })).toEqual({ state: 'corrupt' })
    expect(inspectNodeTelegramExecutionCheckpointForDirectRun({ path, trustedRoot: root })).toEqual({
      state: 'corrupt',
      code: 'SUPERVISED_RECOVERY_REQUIRED',
    })
  })

  it('moves a checkpoint written by another version aside instead of blocking forever', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-execution-foreign-'))
    const path = join(root, 'execution-card.json')
    // Shaped like a checkpoint, with a state field this build does not know —
    // exactly what an older card looks like to today's validator.
    writeFileSync(path, JSON.stringify({
      ...checkpoint(),
      state: { sessionId: 'e8a945b8', steps: [], thinking: false, status: 'completed' },
    }), { mode: 0o600 })
    const store = makeNodeTelegramExecutionCheckpointStore({ path })
    expect(store.load().status).toBe('quarantined')

    expect(discardNodeTelegramExecutionCheckpoint({ path })).toBe(true)

    expect(store.load()).toEqual({ status: 'missing' })
    // The bytes survive for inspection rather than being deleted.
    expect(existsSync(`${path}.rejected`)).toBe(true)
    // Nothing to move a second time, and a missing checkpoint is not an error.
    expect(discardNodeTelegramExecutionCheckpoint({ path })).toBe(false)
  })

  it('inspects absent, pending and clean state without creating doctor paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-execution-doctor-'))
    const directory = join(root, 'telegram')
    const path = join(directory, 'execution-card.json')

    expect(inspectNodeTelegramExecutionCheckpoint({ path })).toEqual({ state: 'absent' })
    expect(existsSync(directory)).toBe(false)

    const store = makeNodeTelegramExecutionCheckpointStore({ path })
    const bound = bind(store)
    expect(inspectNodeTelegramExecutionCheckpoint({ path })).toEqual({ state: 'pending' })

    const terminal = checkpoint({
      revision: bound.revision + 1,
      phase: 'terminal',
      delivery: 'delivered',
      messageId: 9,
      state: {
        ...runningState(),
        thinking: false,
        status: 'completed',
      },
    })
    store.replace(terminal, {
      ownerId: bound.ownerId,
      revision: bound.revision,
      bindingHash: bound.bindingHash,
    })
    expect(inspectNodeTelegramExecutionCheckpoint({ path })).toEqual({ state: 'clean' })
  })

  it('inspects direct-run absent, pending, foreign and clean evidence without mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-execution-direct-inspection-'))
    const directory = join(root, 'telegram')
    const path = join(directory, 'execution-card.json')

    expect(inspectNodeTelegramExecutionCheckpointForDirectRun({ path, trustedRoot: root })).toEqual({
      state: 'absent',
    })
    expect(existsSync(directory)).toBe(false)

    const store = makeNodeTelegramExecutionCheckpointStore({ path })
    const bound = bind(store)
    const before = lstatSync(path)
    const directoryBefore = lstatSync(directory)
    const content = readFileSync(path)
    const pending = {
      state: 'pending',
      code: 'SUPERVISED_RECOVERY_REQUIRED',
      bindingHash: BINDING,
      revision: bound.revision,
      phase: 'bound',
      delivery: 'delivered',
    }
    expect(inspectNodeTelegramExecutionCheckpointForDirectRun({
      path,
      trustedRoot: root,
      expectedBindingHash: BINDING,
    })).toEqual(pending)
    expect(inspectNodeTelegramExecutionCheckpointForDirectRun({
      path,
      trustedRoot: root,
      expectedBindingHash: 'f'.repeat(64),
    })).toEqual({ ...pending, state: 'foreign' })
    expect(inspectNodeTelegramExecutionCheckpointForDirectRun({
      path,
      trustedRoot: root,
      expectedBindingHash: BINDING,
    })).toEqual(pending)
    const after = lstatSync(path)
    const directoryAfter = lstatSync(directory)
    expect({ dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs })
      .toEqual({ dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs })
    expect({
      dev: directoryAfter.dev,
      ino: directoryAfter.ino,
      mtimeMs: directoryAfter.mtimeMs,
    }).toEqual({
      dev: directoryBefore.dev,
      ino: directoryBefore.ino,
      mtimeMs: directoryBefore.mtimeMs,
    })
    expect(readFileSync(path)).toEqual(content)

    const terminal = checkpoint({
      revision: bound.revision + 1,
      phase: 'terminal',
      delivery: 'delivered',
      messageId: 9,
      state: { ...runningState(), thinking: false, status: 'completed' },
    })
    store.replace(terminal, {
      ownerId: bound.ownerId,
      revision: bound.revision,
      bindingHash: bound.bindingHash,
    })
    expect(inspectNodeTelegramExecutionCheckpointForDirectRun({
      path,
      trustedRoot: root,
      expectedBindingHash: BINDING,
    })).toEqual({
      state: 'clean',
      bindingHash: BINDING,
      revision: terminal.revision,
      phase: 'terminal',
      delivery: 'delivered',
    })
  })

  it('fails direct-run inspection closed for corrupt, linked and unsafe paths', () => {
    const corruptRoot = mkdtempSync(join(tmpdir(), 'aisy-execution-direct-corrupt-'))
    const corruptPath = join(corruptRoot, 'execution-card.json')
    writeFileSync(corruptPath, '{"schemaVersion":1}', { mode: 0o600 })
    const required = { state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' }
    expect(inspectNodeTelegramExecutionCheckpointForDirectRun({
      path: corruptPath,
      trustedRoot: corruptRoot,
    }))
      .toEqual(required)

    const oversizedPath = join(corruptRoot, 'oversized.json')
    writeFileSync(oversizedPath, 'x'.repeat(64 * 1024 + 1), { mode: 0o600 })
    expect(inspectNodeTelegramExecutionCheckpointForDirectRun({
      path: oversizedPath,
      trustedRoot: corruptRoot,
    }))
      .toEqual(required)

    const linkedRoot = mkdtempSync(join(tmpdir(), 'aisy-execution-direct-links-'))
    const target = join(linkedRoot, 'target.json')
    const hardlink = join(linkedRoot, 'hardlink.json')
    const symlink = join(linkedRoot, 'symlink.json')
    writeFileSync(target, JSON.stringify(checkpoint()), { mode: 0o600 })
    linkSync(target, hardlink)
    symlinkSync(target, symlink)
    expect(inspectNodeTelegramExecutionCheckpointForDirectRun({
      path: hardlink,
      trustedRoot: linkedRoot,
    }))
      .toEqual(required)
    expect(inspectNodeTelegramExecutionCheckpointForDirectRun({
      path: symlink,
      trustedRoot: linkedRoot,
    }))
      .toEqual(required)

    const unsafeRoot = mkdtempSync(join(tmpdir(), 'aisy-execution-direct-parent-'))
    const unsafeDirectory = join(unsafeRoot, 'telegram')
    mkdirSync(unsafeDirectory, { mode: 0o700 })
    const unsafePath = join(unsafeDirectory, 'execution-card.json')
    writeFileSync(unsafePath, JSON.stringify(checkpoint()), { mode: 0o600 })
    chmodSync(unsafeDirectory, 0o755)
    expect(inspectNodeTelegramExecutionCheckpointForDirectRun({
      path: unsafePath,
      trustedRoot: unsafeRoot,
    }))
      .toEqual(required)

    const actualDirectory = join(unsafeRoot, 'actual')
    const linkedDirectory = join(unsafeRoot, 'linked')
    mkdirSync(actualDirectory, { mode: 0o700 })
    const parentLinkedPath = join(linkedDirectory, 'execution-card.json')
    writeFileSync(join(actualDirectory, 'execution-card.json'), JSON.stringify(checkpoint()), {
      mode: 0o600,
    })
    symlinkSync(actualDirectory, linkedDirectory)
    expect(inspectNodeTelegramExecutionCheckpointForDirectRun({
      path: parentLinkedPath,
      trustedRoot: unsafeRoot,
    }))
      .toEqual(required)

    const actualGrandparent = join(unsafeRoot, 'actual-grandparent')
    const actualNestedParent = join(actualGrandparent, 'telegram')
    const linkedGrandparent = join(unsafeRoot, 'linked-grandparent')
    mkdirSync(actualNestedParent, { recursive: true, mode: 0o700 })
    const grandparentLinkedPath = join(linkedGrandparent, 'telegram', 'execution-card.json')
    writeFileSync(join(actualNestedParent, 'execution-card.json'), JSON.stringify(checkpoint()), {
      mode: 0o600,
    })
    symlinkSync(actualGrandparent, linkedGrandparent)
    expect(inspectNodeTelegramExecutionCheckpointForDirectRun({
      path: grandparentLinkedPath,
      trustedRoot: unsafeRoot,
    }))
      .toEqual(required)
  })

  it('fails closed when the checkpoint grows during its bounded read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-execution-direct-growth-'))
    const path = join(root, 'execution-card.json')
    const store = makeNodeTelegramExecutionCheckpointStore({ path })
    bind(store)
    let grew = false
    vi.resetModules()
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        readSync(
          fd: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) {
          const count = actual.readSync(fd, buffer, offset, length, position)
          if (!grew && count > 0) {
            grew = true
            actual.appendFileSync(path, ' ')
          }
          return count
        },
      }
    })
    try {
      const inspected = await import('./telegram-execution-checkpoint.js')
      expect(inspected.inspectNodeTelegramExecutionCheckpointForDirectRun({
        path,
        trustedRoot: root,
      })).toEqual({ state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' })
      expect(grew).toBe(true)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('fails closed when an ancestor is replaced with a symlink during inspection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-execution-direct-ancestor-swap-'))
    const directory = join(root, 'telegram')
    const movedDirectory = join(root, 'telegram-before-swap')
    const path = join(directory, 'execution-card.json')
    const movedPath = join(movedDirectory, 'execution-card.json')
    const store = makeNodeTelegramExecutionCheckpointStore({ path })
    bind(store)
    const before = lstatSync(path)
    const content = readFileSync(path)
    let swapped = false
    vi.resetModules()
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        readSync(
          fd: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) {
          const count = actual.readSync(fd, buffer, offset, length, position)
          if (!swapped && count > 0) {
            swapped = true
            actual.renameSync(directory, movedDirectory)
            actual.symlinkSync(movedDirectory, directory)
          }
          return count
        },
      }
    })
    try {
      const inspected = await import('./telegram-execution-checkpoint.js')
      expect(inspected.inspectNodeTelegramExecutionCheckpointForDirectRun({
        path,
        trustedRoot: root,
      })).toEqual({ state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' })
      expect(swapped).toBe(true)
      expect(lstatSync(directory).isSymbolicLink()).toBe(true)
      const after = lstatSync(movedPath)
      expect({ dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs })
        .toEqual({ dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs })
      expect(readFileSync(movedPath)).toEqual(content)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('fails closed when an absent directory becomes a symlink to a pending checkpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-execution-direct-absent-race-'))
    const directory = join(root, 'telegram')
    const targetDirectory = join(root, 'late-checkpoint')
    const path = join(directory, 'execution-card.json')
    const targetPath = join(targetDirectory, 'execution-card.json')
    mkdirSync(targetDirectory, { mode: 0o700 })
    writeFileSync(targetPath, JSON.stringify(checkpoint()), { mode: 0o600 })
    const before = lstatSync(targetPath)
    const content = readFileSync(targetPath)
    let appeared = false
    vi.resetModules()
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        lstatSync(candidate: Parameters<typeof actual.lstatSync>[0]) {
          try {
            return actual.lstatSync(candidate)
          } catch (error) {
            if (!appeared && candidate === directory) {
              appeared = true
              actual.symlinkSync(targetDirectory, directory)
            }
            throw error
          }
        },
      }
    })
    try {
      const inspected = await import('./telegram-execution-checkpoint.js')
      expect(inspected.inspectNodeTelegramExecutionCheckpointForDirectRun({
        path,
        trustedRoot: root,
      })).toEqual({ state: 'corrupt', code: 'SUPERVISED_RECOVERY_REQUIRED' })
      expect(appeared).toBe(true)
      expect(lstatSync(directory).isSymbolicLink()).toBe(true)
      const after = lstatSync(targetPath)
      expect({ dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs })
        .toEqual({ dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs })
      expect(readFileSync(targetPath)).toEqual(content)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })
})

describe('Telegram execution checkpoint recovery', () => {
  it('requires exact binding and quiescence before any Telegram I/O', async () => {
    const h = memoryStore()
    bind(h.store)
    const output = { sendText: vi.fn(), editText: vi.fn() }

    await expect(recoverTelegramExecutionCheckpoint({
      store: h.store,
      bindingHash: 'f'.repeat(64),
      output,
      quiescence: { assertHeld: () => true },
      newOwnerId: () => 'recovery-a',
    })).resolves.toEqual({ kind: 'denied', code: 'FOREIGN_BINDING' })
    await expect(recoverTelegramExecutionCheckpoint({
      store: h.store,
      bindingHash: BINDING,
      output,
      quiescence: { assertHeld: () => false },
      newOwnerId: () => 'recovery-a',
    })).resolves.toEqual({ kind: 'denied', code: 'QUIESCENCE_REQUIRED' })
    expect(output.sendText).not.toHaveBeenCalled()
    expect(output.editText).not.toHaveBeenCalled()
  })

  it('edits a bound card to an interrupted terminal state and fences the old owner', async () => {
    const h = memoryStore()
    const old = bind(h.store)
    const output = {
      sendText: vi.fn(),
      editText: vi.fn(async (_messageId: number, _html: string) => undefined),
    }
    await expect(recoverTelegramExecutionCheckpoint({
      store: h.store,
      bindingHash: BINDING,
      output,
      quiescence: { assertHeld: () => true },
      newOwnerId: () => 'recovery-a',
      nowIso: () => '2026-07-28T06:10:00.000Z',
    })).resolves.toEqual({ kind: 'recovered', delivery: 'edited', messageId: 9 })

    expect(output.editText).toHaveBeenCalledWith(
      9,
      expect.stringContaining('⚠️ Прервано перезапуском'),
    )
    expect(output.editText.mock.calls[0]?.[1]).not.toContain('diagnostic')
    expect(h.store.load()).toMatchObject({
      status: 'ready',
      checkpoint: {
        ownerId: 'recovery-a',
        phase: 'terminal',
        delivery: 'delivered',
        state: { status: 'interrupted', thinking: false },
      },
    })
    expect(() => h.store.replace(checkpoint({
      revision: old.revision + 1,
      phase: 'bound',
      delivery: 'pending',
      messageId: 9,
    }), {
      ownerId: old.ownerId,
      revision: old.revision,
      bindingHash: old.bindingHash,
    })).toThrow('EXECUTION_CHECKPOINT_STALE_OWNER')
  })

  it('keeps delivery pending when quiescence is lost during Telegram await', async () => {
    const h = memoryStore()
    bind(h.store)
    const held = [true, false]
    const output = {
      sendText: vi.fn(),
      editText: vi.fn(async () => undefined),
    }

    await expect(recoverTelegramExecutionCheckpoint({
      store: h.store,
      bindingHash: BINDING,
      output,
      quiescence: { assertHeld: () => held.shift() ?? false },
      newOwnerId: () => 'recovery-a',
    })).resolves.toEqual({ kind: 'denied', code: 'QUIESCENCE_REQUIRED' })
    expect(output.editText).toHaveBeenCalledOnce()
    expect(h.store.load()).toMatchObject({
      status: 'ready',
      checkpoint: { phase: 'terminal', delivery: 'pending' },
    })
  })

  it('surfaces the ambiguous first-send window as a replacement recovery card', async () => {
    const h = memoryStore()
    h.store.begin(checkpoint())
    const output = {
      sendText: vi.fn(async () => 17),
      editText: vi.fn(),
    }
    await expect(recoverTelegramExecutionCheckpoint({
      store: h.store,
      bindingHash: BINDING,
      output,
      quiescence: { assertHeld: () => true },
      newOwnerId: () => 'recovery-unbound',
    })).resolves.toEqual({
      kind: 'recovered',
      delivery: 'replacement-sent',
      messageId: 17,
    })
    expect(output.sendText).toHaveBeenCalledWith(
      expect.stringContaining('⚠️ Прервано перезапуском'),
    )
    expect(output.editText).not.toHaveBeenCalled()
  })

  it('keeps a pending terminal checkpoint after Telegram failure and retries idempotently', async () => {
    const h = memoryStore()
    bind(h.store)
    const failedOutput = {
      sendText: vi.fn(),
      editText: vi.fn(async () => { throw new Error('private telegram detail') }),
    }
    await expect(recoverTelegramExecutionCheckpoint({
      store: h.store,
      bindingHash: BINDING,
      output: failedOutput,
      quiescence: { assertHeld: () => true },
      newOwnerId: () => 'recovery-first',
    })).resolves.toEqual({ kind: 'delivery-pending', code: 'TELEGRAM_DELIVERY_FAILED' })
    expect(h.store.load()).toMatchObject({
      status: 'ready',
      checkpoint: { phase: 'terminal', delivery: 'pending', ownerId: 'recovery-first' },
    })

    const retryOutput = { sendText: vi.fn(), editText: vi.fn(async () => undefined) }
    await expect(recoverTelegramExecutionCheckpoint({
      store: h.store,
      bindingHash: BINDING,
      output: retryOutput,
      quiescence: { assertHeld: () => true },
      newOwnerId: () => 'recovery-second',
    })).resolves.toEqual({ kind: 'recovered', delivery: 'edited', messageId: 9 })
    expect(retryOutput.editText).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(h.store.load())).not.toContain('private telegram detail')
  })
})
