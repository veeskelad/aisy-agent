import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  makeTelegramReplyStream,
  type TelegramReplyStreamOutput,
} from './telegram-reply-stream.js'
import {
  makeJsonTelegramReplyCheckpointStore,
  makeNodeTelegramReplyCheckpointStore,
  makeTelegramReplyCheckpointAuthority,
  replyContentHash,
  type TelegramReplyCheckpointAuthorityV1,
  type TelegramReplyCheckpointStore,
} from './telegram-reply-stream-checkpoint.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-reply-stream-')))
  roots.push(value)
  return value
}

function checkpointHarness(input: {
  output: TelegramReplyStreamOutput
  store?: TelegramReplyCheckpointStore
  authority?: TelegramReplyCheckpointAuthorityV1
  assertAuthorityHeld?: () => boolean
}) {
  let content: string | undefined
  const store = input.store ?? makeJsonTelegramReplyCheckpointStore({
    exists: () => content !== undefined,
    read: () => content ?? '',
    saveAtomic: (next) => { content = next },
  })
  const stream = makeTelegramReplyStream({
    output: input.output,
    signal: new AbortController().signal,
    editIntervalMs: 0,
    checkpoint: {
      store,
      bindingHash: HASH_A,
      dispatchId: HASH_B,
      ownerId: 'owner-1',
      nowIso: () => '2026-07-28T10:00:00.000Z',
      ...(input.authority === undefined ? {} : { authority: input.authority }),
      ...(input.assertAuthorityHeld === undefined
        ? {}
        : { assertAuthorityHeld: input.assertAuthorityHeld }),
    },
  })
  stream.setLockout(false)
  return { stream, store, content: () => content }
}

function harness(input: { guardFails?: boolean } = {}) {
  const calls: string[] = []
  const output: TelegramReplyStreamOutput = {
    async guard(text) {
      calls.push(`guard:${text}`)
      if (input.guardFails) throw new Error('locked')
    },
    async sendText(html) { calls.push(`send:${html}`); return 17 },
    async editText(id, html) { calls.push(`edit:${id}:${html}`) },
    async sendDocument(document) { calls.push(`document:${document.filename}`) },
  }
  const abort = new AbortController()
  const stream = makeTelegramReplyStream({ output, signal: abort.signal, editIntervalMs: 250 })
  return { stream, calls, abort }
}

describe('Telegram reply stream', () => {
  it('starts fail-closed and writes only after Core explicitly unlocks the turn', async () => {
    const h = harness()
    await h.stream.append('hidden')
    expect(h.calls).toEqual([])

    h.stream.setLockout(false)
    await h.stream.append(' now visible')
    expect(h.calls).toEqual([
      'guard: now visible',
      'send: now visible',
    ])
  })

  it('edits one message and flushes the authoritative final reply', async () => {
    const h = harness()
    h.stream.setLockout(false)
    await h.stream.append('hel')
    await h.stream.append('l')
    await expect(h.stream.finalize('hello')).resolves.toBe(true)

    expect(h.calls).toEqual([
      'guard:hel',
      'send:hel',
      'guard:hello',
      'edit:17:hello',
    ])
  })

  it('sends no model text for a locked turn', async () => {
    const h = harness()
    h.stream.setLockout(true)
    await h.stream.append('secret output')
    await expect(h.stream.finalizeWithReceipt('secret output')).resolves.toEqual({
      kind: 'fallback-safe', code: 'NO_TELEGRAM_WRITE',
    })
    await expect(h.stream.finalize('secret output')).resolves.toBe(false)
    expect(h.calls).toEqual([])
  })

  it('stops accepting deltas after cancellation', async () => {
    const h = harness()
    h.stream.setLockout(false)
    await h.stream.append('first')
    h.abort.abort()
    await h.stream.stop()
    await h.stream.append('second')
    expect(h.calls).toEqual(['guard:first', 'send:first'])
  })

  it('fails closed when the egress guard rejects a write', async () => {
    const h = harness({ guardFails: true })
    h.stream.setLockout(false)
    await h.stream.append('blocked')
    await expect(h.stream.finalize('blocked')).resolves.toBe(false)
    expect(h.calls).toEqual(['guard:blocked', 'guard:blocked'])
  })

  it('records the exact final hash before an ambiguous first send and never retries it', async () => {
    const sendText = vi.fn(async () => { throw new Error('accepted but response lost') })
    const h = checkpointHarness({
      output: {
        async guard() {}, sendText, async editText() {}, async sendDocument() {},
      },
    })

    await expect(h.stream.finalizeWithReceipt('финальный ответ')).resolves.toEqual({
      kind: 'delivery-uncertain',
      code: 'DELIVERY_UNCERTAIN',
      checkpointRevision: 1,
    })
    expect(sendText).toHaveBeenCalledTimes(1)
    expect(h.store.load()).toMatchObject({
      status: 'ready',
      checkpoint: {
        phase: 'prepared',
        delivery: 'pending',
        replyHash: replyContentHash('финальный ответ'),
      },
    })
  })

  it('latches an ambiguous first send across already queued append and finalize work', async () => {
    let rejectSend!: (error: Error) => void
    const sendText = vi.fn(() => new Promise<number>((_resolve, reject) => { rejectSend = reject }))
    const stream = makeTelegramReplyStream({
      signal: new AbortController().signal,
      editIntervalMs: 0,
      output: {
        async guard() {}, sendText, async editText() {}, async sendDocument() {},
      },
    })
    stream.setLockout(false)

    const first = stream.append('первая часть')
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1))
    const queued = stream.append(' вторая часть')
    const final = stream.finalizeWithReceipt('точный финал')
    rejectSend(new Error('accepted but response lost'))

    await Promise.all([first, queued])
    const result = await final
    expect(result).toEqual({ kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN' })
    await expect(stream.finalizeWithReceipt('точный финал')).resolves.toBe(result)
    expect(sendText).toHaveBeenCalledTimes(1)
  })

  it('reports a known message as uncertain when the delivered commit fails', async () => {
    let content: string | undefined
    const underlying = makeJsonTelegramReplyCheckpointStore({
      exists: () => content !== undefined,
      read: () => content ?? '',
      saveAtomic: (next) => { content = next },
    })
    const store: TelegramReplyCheckpointStore = {
      load: () => underlying.load(),
      begin: checkpoint => underlying.begin(checkpoint),
      replace() { throw new Error('durable commit unavailable') },
    }
    const sendText = vi.fn(async () => 29)
    const h = checkpointHarness({
      store,
      output: {
        async guard() {}, sendText, async editText() {}, async sendDocument() {},
      },
    })

    await expect(h.stream.finalizeWithReceipt('готово')).resolves.toEqual({
      kind: 'delivery-uncertain',
      code: 'DELIVERY_UNCERTAIN',
      messageId: 29,
      checkpointRevision: 1,
    })
    expect(sendText).toHaveBeenCalledTimes(1)
  })

  it('never marks an ambiguous final edit as fallback-safe', async () => {
    const editText = vi.fn(async () => { throw new Error('response lost') })
    const output: TelegramReplyStreamOutput = {
      async guard() {}, async sendText() { return 31 }, editText, async sendDocument() {},
    }
    const stream = makeTelegramReplyStream({
      output, signal: new AbortController().signal, editIntervalMs: 0,
    })
    stream.setLockout(false)
    await stream.append('черновик')

    await expect(stream.finalizeWithReceipt('финал')).resolves.toEqual({
      kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN', messageId: 31,
    })
    expect(editText).toHaveBeenCalledTimes(1)
  })

  it('treats an invalid first-send response as ambiguous delivery', async () => {
    const stream = makeTelegramReplyStream({
      signal: new AbortController().signal,
      output: {
        async guard() {}, async sendText() { return 0 }, async editText() {}, async sendDocument() {},
      },
    })
    stream.setLockout(false)

    await expect(stream.finalizeWithReceipt('ответ')).resolves.toEqual({
      kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN',
    })
  })

  it('keeps pending when authority is lost across the Telegram await', async () => {
    let held = true
    const h = checkpointHarness({
      assertAuthorityHeld: () => held,
      output: {
        async guard() {},
        async sendText() { held = false; return 33 },
        async editText() {},
        async sendDocument() {},
      },
    })

    await expect(h.stream.finalizeWithReceipt('ответ')).resolves.toEqual({
      kind: 'delivery-uncertain',
      code: 'DELIVERY_UNCERTAIN',
      messageId: 33,
      checkpointRevision: 1,
    })
    expect(h.store.load()).toMatchObject({
      status: 'ready', checkpoint: { phase: 'prepared', delivery: 'pending' },
    })
  })

  it('keeps the delivered inline marker pending when document delivery is ambiguous', async () => {
    const sendDocument = vi.fn(async () => { throw new Error('document response lost') })
    const h = checkpointHarness({
      output: {
        async guard() {}, async sendText() { return 35 }, async editText() {}, sendDocument,
      },
    })
    const reply = 'д'.repeat(5_000)

    await expect(h.stream.finalizeWithReceipt(reply)).resolves.toEqual({
      kind: 'delivery-uncertain',
      code: 'DELIVERY_UNCERTAIN',
      messageId: 35,
      checkpointRevision: 2,
    })
    expect(sendDocument).toHaveBeenCalledTimes(1)
    expect(h.store.load()).toMatchObject({
      status: 'ready',
      checkpoint: {
        phase: 'terminal', delivery: 'delivered', messageId: 35,
        replyHash: replyContentHash(reply), document: 'pending',
      },
    })
  })

  it('returns one durable receipt only for a real Node store and exact bound authority', async () => {
    const trustedRoot = root()
    const store = makeNodeTelegramReplyCheckpointStore({
      path: join(trustedRoot, 'reply.json'), trustedRoot,
    })
    const authority = makeTelegramReplyCheckpointAuthority({
      bindingHash: HASH_A, dispatchId: HASH_B, ownerId: 'owner-1', assertHeld: () => true,
    })
    const h = checkpointHarness({
      store,
      authority,
      output: {
        async guard() {}, async sendText() { return 37 }, async editText() {}, async sendDocument() {},
      },
    })

    const result = await h.stream.finalizeWithReceipt('готово')
    expect(result).toMatchObject({
      kind: 'delivered', durability: 'durable',
      receipt: { messageId: 37, replyHash: replyContentHash('готово'), document: 'none' },
    })
    await expect(h.stream.finalize('готово')).resolves.toBe(true)
    await expect(h.stream.finalize('другой ответ')).resolves.toBe(false)
  })

  it('does not brand a store reached through a symlinked grandparent', async () => {
    const trustedRoot = root()
    const outside = root()
    mkdirSync(join(outside, 'nested'), { mode: 0o700 })
    symlinkSync(outside, join(trustedRoot, 'linked'))
    const store = makeNodeTelegramReplyCheckpointStore({
      path: join(trustedRoot, 'linked', 'nested', 'reply.json'), trustedRoot,
    })
    const authority = makeTelegramReplyCheckpointAuthority({
      bindingHash: HASH_A, dispatchId: HASH_B, ownerId: 'owner-1', assertHeld: () => true,
    })
    const h = checkpointHarness({
      store,
      authority,
      output: {
        async guard() {}, async sendText() { return 42 }, async editText() {}, async sendDocument() {},
      },
    })

    await expect(h.stream.finalizeWithReceipt('готово')).resolves.toMatchObject({
      kind: 'delivered', durability: 'volatile', messageId: 42,
    })
  })

  it('fails uncertain when a pinned ancestor is swapped across Telegram I/O', async () => {
    const trustedRoot = root()
    const outside = root()
    mkdirSync(join(trustedRoot, 'state', 'telegram'), { recursive: true, mode: 0o700 })
    const path = join(trustedRoot, 'state', 'telegram', 'reply.json')
    const store = makeNodeTelegramReplyCheckpointStore({ path, trustedRoot })
    const authority = makeTelegramReplyCheckpointAuthority({
      bindingHash: HASH_A, dispatchId: HASH_B, ownerId: 'owner-1', assertHeld: () => true,
    })
    const h = checkpointHarness({
      store,
      authority,
      output: {
        async guard() {},
        async sendText() {
          renameSync(join(trustedRoot, 'state'), join(trustedRoot, 'state-old'))
          symlinkSync(outside, join(trustedRoot, 'state'))
          return 44
        },
        async editText() {},
        async sendDocument() {},
      },
    })

    await expect(h.stream.finalizeWithReceipt('готово')).resolves.toEqual({
      kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN',
      messageId: 44, checkpointRevision: 1,
    })
  })

  it('re-reads exact committed bytes and rejects a post-save replacement', async () => {
    const trustedRoot = root()
    const path = join(trustedRoot, 'reply.json')
    const store = makeNodeTelegramReplyCheckpointStore({ path, trustedRoot })
    let authorityChecks = 0
    const authority = makeTelegramReplyCheckpointAuthority({
      bindingHash: HASH_A,
      dispatchId: HASH_B,
      ownerId: 'owner-1',
      assertHeld() {
        authorityChecks += 1
        if (authorityChecks === 5) writeFileSync(path, '{', { encoding: 'utf8', mode: 0o600 })
        return true
      },
    })
    const h = checkpointHarness({
      store,
      authority,
      output: {
        async guard() {}, async sendText() { return 46 }, async editText() {}, async sendDocument() {},
      },
    })

    await expect(h.stream.finalizeWithReceipt('готово')).resolves.toEqual({
      kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN',
      messageId: 46, checkpointRevision: 2,
    })
  })

  it('rejects exact bytes copied into a replacement private directory', async () => {
    const trustedRoot = root()
    const stateDirectory = join(trustedRoot, 'state')
    mkdirSync(stateDirectory, { mode: 0o700 })
    const path = join(stateDirectory, 'reply.json')
    const store = makeNodeTelegramReplyCheckpointStore({ path, trustedRoot })
    let authorityChecks = 0
    const authority = makeTelegramReplyCheckpointAuthority({
      bindingHash: HASH_A,
      dispatchId: HASH_B,
      ownerId: 'owner-1',
      assertHeld() {
        authorityChecks += 1
        if (authorityChecks === 5) {
          const exactBytes = readFileSync(path)
          renameSync(stateDirectory, join(trustedRoot, 'state-old'))
          mkdirSync(stateDirectory, { mode: 0o700 })
          writeFileSync(path, exactBytes, { mode: 0o600 })
        }
        return true
      },
    })
    const h = checkpointHarness({
      store,
      authority,
      output: {
        async guard() {}, async sendText() { return 48 }, async editText() {}, async sendDocument() {},
      },
    })

    await expect(h.stream.finalizeWithReceipt('готово')).resolves.toEqual({
      kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN',
      messageId: 48, checkpointRevision: 2,
    })
  })

  it('never upgrades structural store or authority copies to release-safe durability', async () => {
    const unboundStore = makeNodeTelegramReplyCheckpointStore({ path: join(root(), 'reply.json') })
    const unbound = checkpointHarness({
      store: unboundStore,
      output: {
        async guard() {}, async sendText() { return 38 }, async editText() {}, async sendDocument() {},
      },
    })
    await expect(unbound.stream.finalizeWithReceipt('готово')).resolves.toMatchObject({
      kind: 'delivered', durability: 'volatile', messageId: 38,
    })

    let content: string | undefined
    const structuralStore = makeJsonTelegramReplyCheckpointStore({
      exists: () => content !== undefined,
      read: () => content ?? '',
      saveAtomic: next => { content = next },
    })
    const authority = makeTelegramReplyCheckpointAuthority({
      bindingHash: HASH_A, dispatchId: HASH_B, ownerId: 'owner-1', assertHeld: () => true,
    })
    const structural = checkpointHarness({
      store: structuralStore,
      authority,
      output: {
        async guard() {}, async sendText() { return 39 }, async editText() {}, async sendDocument() {},
      },
    })
    await expect(structural.stream.finalizeWithReceipt('готово')).resolves.toMatchObject({
      kind: 'delivered', durability: 'volatile', messageId: 39,
    })

    const proxyRoot = root()
    const realStore = makeNodeTelegramReplyCheckpointStore({
      path: join(proxyRoot, 'reply.json'), trustedRoot: proxyRoot,
    })
    const proxyStore = new Proxy(realStore, {})
    const proxied = checkpointHarness({
      store: proxyStore,
      authority,
      output: {
        async guard() {}, async sendText() { return 40 }, async editText() {}, async sendDocument() {},
      },
    })
    await expect(proxied.stream.finalizeWithReceipt('готово')).resolves.toMatchObject({
      kind: 'delivered', durability: 'volatile', messageId: 40,
    })

    const secondRoot = root()
    const secondStore = makeNodeTelegramReplyCheckpointStore({
      path: join(secondRoot, 'reply.json'), trustedRoot: secondRoot,
    })
    const copiedAuthority: TelegramReplyCheckpointAuthorityV1 = { ...authority }
    const copiedSend = vi.fn(async () => 41)
    const fake = checkpointHarness({
      store: secondStore,
      authority: copiedAuthority,
      output: {
        async guard() {}, sendText: copiedSend, async editText() {}, async sendDocument() {},
      },
    })
    await expect(fake.stream.finalizeWithReceipt('готово')).resolves.toEqual({
      kind: 'blocked', code: 'REPLY_DURABILITY_UNAVAILABLE',
    })
    expect(copiedSend).not.toHaveBeenCalled()
  })
})
