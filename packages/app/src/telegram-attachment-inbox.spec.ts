import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResolvedWorkBinding, TelegramUpdate } from '@aisy/core'
import {
  ingestTelegramAttachmentUpdate,
  makeSingletonTelegramAttachmentInbox,
  makeTelegramAttachmentInbox,
  makeTelegramBotApiAttachmentDownloadPort,
  parseTelegramAttachmentUpdate,
  TelegramAttachmentInboxError,
  type TelegramAttachmentDescriptor,
  type TelegramAttachmentDownloadPort,
  type TelegramAttachmentInboxFault,
  type TelegramFetchPort,
} from './telegram-attachment-inbox.js'

const roots: string[] = []
const binding: ResolvedWorkBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-telegram-inbox-')))
  roots.push(root)
  return root
}

function update(overrides: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: 500,
    message: {
      message_id: 77,
      date: Date.parse('2026-07-27T05:00:00.000Z') / 1000,
      chat: { id: 42 },
      document: {
        file_id: 'telegram-secret-file-id',
        file_unique_id: 'stable-file-id',
        file_name: '../../данные.bin',
        file_size: 8,
      },
      ...overrides,
    },
  }
}

function descriptor(overrides: Partial<TelegramAttachmentDescriptor> = {}) {
  const parsed = parseTelegramAttachmentUpdate(update())
  if (parsed === null) throw new Error('fixture invalid')
  return { ...parsed, ...overrides }
}

function chunks(payload: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield payload.subarray(0, 3)
    yield payload.subarray(3)
  })()
}

function downloader(payload: Uint8Array, calls: string[]): TelegramAttachmentDownloadPort {
  return {
    async download(fileId) {
      calls.push(fileId)
      return { body: chunks(payload), sizeBytes: payload.byteLength }
    },
  }
}

describe('parseTelegramAttachmentUpdate', () => {
  it('extracts exact document authority and keeps the original name as metadata only', () => {
    expect(parseTelegramAttachmentUpdate(update())).toEqual({
      updateId: 500,
      messageId: 77,
      chatId: 42,
      unixSeconds: Date.parse('2026-07-27T05:00:00.000Z') / 1000,
      kind: 'document',
      telegramFileId: 'telegram-secret-file-id',
      telegramFileUniqueId: 'stable-file-id',
      originalName: '../../данные.bin',
      declaredSizeBytes: 8,
    })
  })

  it('selects the largest valid Telegram photo variant', () => {
    const message = (update().message ?? {}) as Record<string, unknown>
    delete message['document']
    message['photo'] = [
      { file_id: 'small', file_unique_id: 'photo', file_size: 10 },
      { file_id: 'large', file_unique_id: 'photo', file_size: 100 },
    ]
    const parsed = parseTelegramAttachmentUpdate({ update_id: 500, message })
    expect(parsed).toMatchObject({
      kind: 'photo',
      telegramFileId: 'large',
      originalName: 'photo-77.jpg',
      declaredSizeBytes: 100,
    })
  })
})

describe('makeTelegramAttachmentInbox', () => {
  it('composes a parsed Telegram update with the durable inbox without a model turn', async () => {
    const calls: string[] = []
    const inbox = makeTelegramAttachmentInbox({
      inboxRoot: tempRoot(),
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(Uint8Array.from([0, 255, 65, 105, 115, 121, 10, 128]), calls),
    })

    const saved = await ingestTelegramAttachmentUpdate({ inbox, binding, update: update() })

    expect(saved).toMatchObject({ source: 'telegram', sessionId: 'session-a', sizeBytes: 8 })
    expect(calls).toEqual(['telegram-secret-file-id'])
  })

  it('streams arbitrary binary, publishes object before exact record and resumes without download', async () => {
    const inboxRoot = tempRoot()
    const payload = Uint8Array.from([0, 255, 65, 105, 115, 121, 10, 128])
    const calls: string[] = []
    const first = makeTelegramAttachmentInbox({
      inboxRoot,
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(payload, calls),
    })

    const saved = await first.ingest({ binding, attachment: descriptor() })
    const restarted = makeTelegramAttachmentInbox({
      inboxRoot,
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(Uint8Array.of(9), calls),
    })
    const resumed = await restarted.ingest({ binding, attachment: descriptor() })

    expect(saved).toEqual(resumed)
    expect(saved).toMatchObject({
      operatorId: binding.operatorId,
      profileId: binding.profileId,
      sessionId: binding.sessionId,
      source: 'telegram',
      originalName: '../../данные.bin',
      provenanceRef: expect.stringMatching(/^telegram:update:500:message:77:document:/),
      receivedAt: '2026-07-27T05:00:00.000Z',
      sizeBytes: payload.byteLength,
    })
    expect(saved.fileId).toMatch(/^tg-[a-f0-9]{64}$/)
    expect(saved.provenanceRef).not.toContain('telegram-secret-file-id')
    expect(readFileSync(join(inboxRoot, 'objects', saved.fileId))).toEqual(Buffer.from(payload))
    expect(JSON.parse(readFileSync(join(inboxRoot, 'records', `${saved.fileId}.json`), 'utf8')))
      .toEqual(saved)
    expect(calls).toEqual(['telegram-secret-file-id'])
  })

  it.each(['after-download-temp', 'after-object', 'after-record'] as const)(
    'recovers idempotently after a durable boundary: %s',
    async (fault) => {
      const inboxRoot = tempRoot()
      const payload = Uint8Array.from([0, 255, 65, 105, 115, 121, 10, 128])
      const calls: string[] = []
      let fired = false
      const crashing = makeTelegramAttachmentInbox({
        inboxRoot,
        allowedChatId: 42,
        maxAttachmentBytes: 1024,
        download: downloader(payload, calls),
        faultAt: (point: TelegramAttachmentInboxFault) => {
          if (!fired && point === fault) {
            fired = true
            throw new Error(`crash:${fault}`)
          }
        },
      })
      await expect(crashing.ingest({ binding, attachment: descriptor() }))
        .rejects.toThrow(`crash:${fault}`)

      const recovered = await makeTelegramAttachmentInbox({
        inboxRoot,
        allowedChatId: 42,
        maxAttachmentBytes: 1024,
        download: downloader(payload, calls),
      }).ingest({ binding, attachment: descriptor() })
      expect(readFileSync(join(inboxRoot, 'objects', recovered.fileId))).toEqual(Buffer.from(payload))
      expect(calls.length).toBe(fault === 'after-record' ? 1 : 2)
    },
  )

  it('rejects a foreign chat and declared oversize before network I/O', async () => {
    const calls: string[] = []
    const inbox = makeTelegramAttachmentInbox({
      inboxRoot: tempRoot(),
      allowedChatId: 42,
      maxAttachmentBytes: 8,
      download: downloader(Uint8Array.of(1), calls),
    })

    await expect(inbox.ingest({ binding, attachment: descriptor({ chatId: 7 }) }))
      .rejects.toEqual(new TelegramAttachmentInboxError('AUTHZ_REJECTED'))
    await expect(inbox.ingest({
      binding,
      attachment: descriptor({ declaredSizeBytes: 9 }),
    })).rejects.toEqual(new TelegramAttachmentInboxError('LIMIT_EXCEEDED'))
    expect(calls).toEqual([])
  })

  it('snapshots binding and attachment authority before the download can mutate callers', async () => {
    const mutableBinding = { ...binding }
    const mutableAttachment = descriptor()
    const payload = Uint8Array.from([0, 255, 65, 105, 115, 121, 10, 128])
    const inbox = makeTelegramAttachmentInbox({
      inboxRoot: tempRoot(),
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: {
        async download() {
          mutableBinding.sessionId = 'session-mutated'
          mutableAttachment.originalName = 'mutated.bin'
          return { body: chunks(payload), sizeBytes: payload.byteLength }
        },
      },
    })

    const saved = await inbox.ingest({
      binding: mutableBinding,
      attachment: mutableAttachment,
    })

    expect(saved.sessionId).toBe('session-a')
    expect(saved.originalName).toBe('../../данные.bin')
  })

  it('rejects changed authoritative size metadata on an otherwise identical retry', async () => {
    const calls: string[] = []
    const inbox = makeTelegramAttachmentInbox({
      inboxRoot: tempRoot(),
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(Uint8Array.from([0, 255, 65, 105, 115, 121, 10, 128]), calls),
    })
    await inbox.ingest({ binding, attachment: descriptor() })

    await expect(inbox.ingest({
      binding,
      attachment: descriptor({ declaredSizeBytes: 7 }),
    })).rejects.toEqual(new TelegramAttachmentInboxError('STATE_CONFLICT'))
    expect(calls).toHaveLength(1)
  })

  it('never overwrites a colliding or symlinked code-owned object', async () => {
    const inboxRoot = tempRoot()
    const payload = Uint8Array.from([0, 255, 65, 105, 115, 121, 10, 128])
    const calls: string[] = []
    const inbox = makeTelegramAttachmentInbox({
      inboxRoot,
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(payload, calls),
    })
    const first = await inbox.ingest({ binding, attachment: descriptor() })
    rmSync(join(inboxRoot, 'records', `${first.fileId}.json`))
    writeFileSync(join(inboxRoot, 'objects', first.fileId), 'different')

    await expect(inbox.ingest({ binding, attachment: descriptor() }))
      .rejects.toEqual(new TelegramAttachmentInboxError('STATE_CONFLICT'))
    expect(readFileSync(join(inboxRoot, 'objects', first.fileId), 'utf8')).toBe('different')

    rmSync(join(inboxRoot, 'objects', first.fileId))
    const outside = join(tempRoot(), 'outside.bin')
    writeFileSync(outside, payload)
    symlinkSync(outside, join(inboxRoot, 'objects', first.fileId))
    await expect(inbox.ingest({ binding, attachment: descriptor() }))
      .rejects.toEqual(new TelegramAttachmentInboxError('STATE_CORRUPT'))
  })

  it('fails closed on streamed and declared size disagreement', async () => {
    const calls: string[] = []
    const inbox = makeTelegramAttachmentInbox({
      inboxRoot: tempRoot(),
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(Uint8Array.of(1, 2, 3), calls),
    })
    await expect(inbox.ingest({
      binding,
      attachment: descriptor({ declaredSizeBytes: 8 }),
    })).rejects.toEqual(new TelegramAttachmentInboxError('SIZE_MISMATCH'))
  })
})

describe('makeSingletonTelegramAttachmentInbox', () => {
  it('admits one writer, fails closed on a competitor, and resumes after clean restart', async () => {
    const inboxRoot = tempRoot()
    const payload = Uint8Array.from([0, 255, 65, 105, 115, 121, 10, 128])
    const calls: string[] = []
    const first = makeSingletonTelegramAttachmentInbox({
      inboxRoot,
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(payload, calls),
      nowIso: () => '2026-07-28T06:00:00.000Z',
      newNonce: () => 'writer-a',
      pid: 101,
    })

    expect(() => makeSingletonTelegramAttachmentInbox({
      inboxRoot,
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(payload, calls),
      newNonce: () => 'writer-b',
      pid: 202,
    })).toThrow('WRITER_LOCK_HELD')

    const saved = await first.inbox.ingest({ binding, attachment: descriptor() })
    first.close()
    const restarted = makeSingletonTelegramAttachmentInbox({
      inboxRoot,
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(Uint8Array.of(9), calls),
      newNonce: () => 'writer-c',
      pid: 303,
    })
    const resumed = await restarted.inbox.ingest({ binding, attachment: descriptor() })
    restarted.close()

    expect(resumed).toEqual(saved)
    expect(calls).toEqual(['telegram-secret-file-id'])
  })

  it('does not reclaim an abandoned lock by PID or age', () => {
    const inboxRoot = tempRoot()
    makeSingletonTelegramAttachmentInbox({
      inboxRoot,
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(Uint8Array.of(1), []),
      nowIso: () => '2000-01-01T00:00:00.000Z',
      newNonce: () => 'abandoned',
      pid: 1,
    })

    expect(() => makeSingletonTelegramAttachmentInbox({
      inboxRoot,
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(Uint8Array.of(1), []),
      nowIso: () => '2030-01-01T00:00:00.000Z',
      newNonce: () => 'new-writer',
      pid: 99999,
    })).toThrow('WRITER_LOCK_HELD')
  })

  it('cleans up its own new lock when owner token initialization fails', () => {
    const inboxRoot = tempRoot()
    expect(() => makeSingletonTelegramAttachmentInbox({
      inboxRoot,
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(Uint8Array.of(1), []),
      newNonce: () => '',
    })).toThrow('STATE_CORRUPT')

    const recovered = makeSingletonTelegramAttachmentInbox({
      inboxRoot,
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(Uint8Array.of(1), []),
      newNonce: () => 'valid-owner',
    })
    recovered.close()
  })

  it('detects foreign owner replacement before network and never removes it', async () => {
    const inboxRoot = tempRoot()
    const calls: string[] = []
    const runtime = makeSingletonTelegramAttachmentInbox({
      inboxRoot,
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: downloader(Uint8Array.of(1), calls),
      newNonce: () => 'owned',
    })
    const ownerPath = join(inboxRoot, '.writer.lock', 'owner.json')
    unlinkSync(ownerPath)
    writeFileSync(ownerPath, '{"version":1,"pid":7,"nonce":"foreign"}\n', { mode: 0o600 })

    await expect(runtime.inbox.ingest({ binding, attachment: descriptor() }))
      .rejects.toEqual(new TelegramAttachmentInboxError('STATE_CORRUPT'))
    expect(() => runtime.close()).toThrow('STATE_CORRUPT')
    expect(readFileSync(ownerPath, 'utf8')).toContain('foreign')
    expect(calls).toEqual([])
  })

  it('refuses release while an ingest is in flight', async () => {
    const inboxRoot = tempRoot()
    let allowBody!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const bodyGate = new Promise<void>(resolve => { allowBody = resolve })
    const runtime = makeSingletonTelegramAttachmentInbox({
      inboxRoot,
      allowedChatId: 42,
      maxAttachmentBytes: 1024,
      download: {
        async download() {
          return {
            sizeBytes: 8,
            body: (async function* () {
              markStarted()
              await bodyGate
              yield Uint8Array.from([0, 255, 65, 105, 115, 121, 10, 128])
            })(),
          }
        },
      },
    })

    const ingesting = runtime.inbox.ingest({ binding, attachment: descriptor() })
    await started
    expect(() => runtime.close()).toThrow('WRITER_BUSY')
    allowBody()
    await ingesting
    runtime.close()
  })
})

describe('makeTelegramBotApiAttachmentDownloadPort', () => {
  it('resolves an official file path and streams the response without buffering the payload', async () => {
    const payload = Uint8Array.from([0, 255, 1, 2])
    const requests: Array<{ url: string; method: string }> = []
    const fetch: TelegramFetchPort = async (url, init) => {
      requests.push({ url, method: init.method })
      if (init.method === 'POST') {
        const metadata = Buffer.from(JSON.stringify({
          ok: true,
          result: { file_path: 'documents/data.bin', file_size: payload.byteLength },
        }))
        return {
          ok: true,
          status: 200,
          headers: { get: () => String(metadata.byteLength) },
          body: chunks(metadata),
        }
      }
      return {
        ok: true,
        status: 200,
        headers: { get: name => name === 'content-length' ? String(payload.byteLength) : null },
        body: chunks(payload),
      }
    }
    const download = await makeTelegramBotApiAttachmentDownloadPort({
      token: '12345678:TEST_TOKEN',
      fetch,
    }).download('telegram-file')
    const received: number[] = []
    for await (const chunk of download.body) received.push(...chunk)

    expect(received).toEqual([...payload])
    expect(download.sizeBytes).toBe(payload.byteLength)
    expect(requests.map(request => request.method)).toEqual(['POST', 'GET'])
    expect(requests[1]?.url).toContain('/file/bot12345678:TEST_TOKEN/documents/data.bin')
  })

  it('rejects a server-supplied path escape with a redacted error', async () => {
    const metadata = Buffer.from(JSON.stringify({
      ok: true,
      result: { file_path: '../secret', file_size: 1 },
    }))
    const fetch: TelegramFetchPort = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: chunks(metadata),
    })
    const port = makeTelegramBotApiAttachmentDownloadPort({
      token: '12345678:DO_NOT_LEAK',
      fetch,
    })
    await expect(port.download('telegram-file')).rejects.toEqual(
      new TelegramAttachmentInboxError('DOWNLOAD_FAILED'),
    )
  })

  it('enforces the official Bot API 20 MiB download ceiling before file GET', async () => {
    let requests = 0
    const metadata = Buffer.from(JSON.stringify({
      ok: true,
      result: { file_path: 'documents/large.bin', file_size: 20 * 1024 * 1024 + 1 },
    }))
    const fetch: TelegramFetchPort = async () => {
      requests += 1
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: chunks(metadata),
      }
    }
    const port = makeTelegramBotApiAttachmentDownloadPort({
      token: '12345678:LIMIT_TEST',
      fetch,
    })

    await expect(port.download('telegram-file')).rejects.toEqual(
      new TelegramAttachmentInboxError('LIMIT_EXCEEDED'),
    )
    expect(requests).toBe(1)
  })
})
