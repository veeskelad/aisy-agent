import { describe, expect, it } from 'vitest'
import type { Update, UserFromGetMe } from 'grammy/types'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  makeGateway,
  type AgentRunner,
  type ResolvedWorkBinding,
  type TurnInput,
} from '@aisy/core'
import { makeTelegramBot, type TelegramBotDeps } from './bot.js'
import { makeJsonTelegramExecutionCheckpointStore } from './telegram-execution-checkpoint.js'
import type { TelegramExecutionAuthorityPublisher } from './telegram-execution-startup-recovery.js'
import {
  makeTelegramAttachmentInbox,
  type TelegramAttachmentDescriptor,
  type TelegramAttachmentInbox,
} from './telegram-attachment-inbox.js'
import {
  makeTelegramVoiceIngress,
  type TelegramVoiceIngress,
} from './telegram-voice-ingress.js'

const BOT_INFO: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: 'Aisy',
  username: 'aisy_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}

const BINDING: ResolvedWorkBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
}

const runner: AgentRunner = {
  async handle() { return { state: 'ok', reply: 'unused', narrowed: false } },
}

function mediaUpdate(
  updateId: number,
  media: Record<string, unknown>,
  mediaGroupId?: string,
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_785_000_000 + updateId,
      chat: { id: 42, type: 'private', first_name: 'Operator' },
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      ...(mediaGroupId === undefined ? {} : { media_group_id: mediaGroupId }),
      ...media,
    },
  } as Update
}

function harness(input: {
  attachmentInbox?: TelegramAttachmentInbox
  voiceIngress?: TelegramVoiceIngress
  captureWorkBinding?: () => Promise<ResolvedWorkBinding>
  acquireBackgroundRuntime?: NonNullable<TelegramBotDeps['acquireBackgroundRuntime']>
  mediaGroupDebounceMs?: number
  debounceMs?: number
  executionCheckpoint?: TelegramBotDeps['executionCheckpoint']
  failSendMessage?: boolean
}) {
  const gateway = makeGateway({
    getAllowedChatId: async () => 42,
    getBotToken: async () => 'unused',
    isReady: () => true,
    transcribeVoice: async () => '',
    isOutboundLocked: () => false,
    isSafetyAvailable: () => true,
  })
  let messageId = 100
  const sent: string[] = []
  const { bot } = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => ({ sessionId: BINDING.sessionId, runner }),
    model: 'test-model',
    registerCommands: false,
    ...(input.debounceMs === undefined ? {} : { debounceMs: input.debounceMs }),
    mediaGroupDebounceMs: input.mediaGroupDebounceMs ?? 5,
    ...(input.attachmentInbox === undefined
      ? {}
      : { attachmentInbox: input.attachmentInbox }),
    ...(input.voiceIngress === undefined ? {} : { voiceIngress: input.voiceIngress }),
    ...(input.captureWorkBinding === undefined
      ? {}
      : { captureWorkBinding: input.captureWorkBinding }),
    ...(input.acquireBackgroundRuntime === undefined
      ? {}
      : { acquireBackgroundRuntime: input.acquireBackgroundRuntime }),
    ...(input.executionCheckpoint === undefined
      ? {}
      : { executionCheckpoint: input.executionCheckpoint }),
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === 'sendMessage') {
      if (input.failSendMessage === true) throw new Error('private Telegram failure')
      sent.push(String((payload as { text?: unknown }).text ?? ''))
      return {
        ok: true,
        result: {
          message_id: ++messageId,
          date: 0,
          chat: { id: 42, type: 'private' },
          text: sent.at(-1) ?? '',
        },
      } as never
    }
    return { ok: true, result: true } as never
  })
  return { bot, sent }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Telegram media acknowledgement not observed')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('Telegram media intake', () => {
  it.each([
    ['voice', { voice: { file_id: 'voice-file', file_unique_id: 'voice-1' } },
      '🎙 Голос пока недоступен — отправьте сообщение текстом.'],
    ['document', { document: { file_id: 'doc-file', file_unique_id: 'doc-1' } },
      '📎 Приём вложений пока недоступен — отправьте сообщение текстом.'],
  ] as const)('degrades explicitly for disabled %s intake without downloading', async (
    _kind,
    media,
    expected,
  ) => {
    const h = harness({})
    await h.bot.handleUpdate(mediaUpdate(1, media))
    expect(h.sent).toEqual([expected])
  })

  it('persists a document and every photo in an album under the captured binding', async () => {
    const ingested: Array<{
      binding: ResolvedWorkBinding
      attachment: TelegramAttachmentDescriptor
    }> = []
    const attachmentInbox: TelegramAttachmentInbox = {
      async ingest(input) {
        ingested.push({
          binding: { ...input.binding },
          attachment: { ...input.attachment },
        })
        return {
          schemaVersion: 1,
          fileId: `saved-${input.attachment.messageId}`,
          operatorId: input.binding.operatorId,
          profileId: input.binding.profileId,
          sessionId: input.binding.sessionId,
          source: 'telegram',
          originalName: input.attachment.originalName,
          sha256: 'a'.repeat(64),
          sizeBytes: input.attachment.declaredSizeBytes ?? 0,
          provenanceRef: `telegram:test:${input.attachment.messageId}`,
          receivedAt: new Date(input.attachment.unixSeconds * 1000).toISOString(),
        }
      },
    }
    let captures = 0
    const h = harness({
      attachmentInbox,
      captureWorkBinding: async () => {
        captures += 1
        return { ...BINDING }
      },
    })

    await h.bot.handleUpdate(mediaUpdate(1, {
      document: {
        file_id: 'doc-file',
        file_unique_id: 'doc-1',
        file_name: 'report.pdf',
        file_size: 12,
      },
    }))
    await h.bot.handleUpdate(mediaUpdate(2, {
      photo: [{ file_id: 'photo-a', file_unique_id: 'photo-a', file_size: 10 }],
    }, 'album-1'))
    await h.bot.handleUpdate(mediaUpdate(3, {
      photo: [{ file_id: 'photo-b', file_unique_id: 'photo-b', file_size: 20 }],
    }, 'album-1'))
    await waitFor(() => h.sent.some(text => text.startsWith('📎 Альбом сохранён')))

    expect(ingested.map(item => item.attachment.kind)).toEqual(['document', 'photo', 'photo'])
    expect(ingested.every(item => item.binding.sessionId === BINDING.sessionId)).toBe(true)
    expect(ingested.map(item => item.attachment.messageId)).toEqual([1, 2, 3])
    expect(captures).toBe(2)
    expect(h.sent).toEqual([
      '📎 Файл сохранён во входящие: saved-1',
      '📎 Альбом сохранён во входящие: 2 файла\nsaved-2\nsaved-3',
    ])
  })

  it('dispatches a verified voice transcript through the exact captured runtime binding', async () => {
    const acquired: ResolvedWorkBinding[] = []
    const turns: TurnInput[] = []
    const h = harness({
      captureWorkBinding: async () => ({ ...BINDING }),
      voiceIngress: {
        async handle(input) {
          return {
            kind: 'transcribed',
            binding: { ...input.binding },
            span: {
              provenance: 'untrusted',
              channel: 'voice',
              text: 'Проверенный голосовой текст',
              receivedAt: '2026-07-28T00:00:00.000Z',
              sourceRef: 'telegram:update:20:message:20:voice:test',
            },
          }
        },
      },
      acquireBackgroundRuntime: async (binding) => {
        acquired.push({ ...binding })
        return {
          sessionId: binding.sessionId,
          runner: {
            async handle(input) {
              turns.push(input)
              return { state: 'ok', reply: 'Голос принят', narrowed: false }
            },
          },
        }
      },
    })

    await h.bot.handleUpdate(mediaUpdate(20, {
      voice: { file_id: 'voice-file', file_unique_id: 'voice-20', file_size: 12 },
    }))

    expect(acquired).toEqual([BINDING])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      sessionId: BINDING.sessionId,
      spans: [{ role: 'user', provenance: 'untrusted', text: 'Проверенный голосовой текст' }],
    })
    expect(turns[0]?.turnId).toMatch(/^telegram:42:[a-f0-9]{64}$/)
    expect(h.sent).toContain('Голос принят')
  })

  it('refuses a substituted voice outcome after bound runtime acquisition but before model work', async () => {
    let acquired = false
    let modelCalls = 0
    const h = harness({
      captureWorkBinding: async () => ({ ...BINDING }),
      voiceIngress: {
        async handle(input) {
          return {
            kind: 'transcribed',
            binding: { ...input.binding, sessionId: 'substituted-session' },
            span: {
              provenance: 'untrusted', channel: 'voice', text: 'Подмена',
              receivedAt: '2026-07-28T00:00:00.000Z', sourceRef: 'telegram:test',
            },
          }
        },
      },
      acquireBackgroundRuntime: async (binding) => {
        acquired = true
        return {
          sessionId: binding.sessionId,
          runner: { async handle() { modelCalls += 1; return { state: 'ok', reply: '', narrowed: false } } },
        }
      },
    })

    await h.bot.handleUpdate(mediaUpdate(21, {
      voice: { file_id: 'voice-file', file_unique_id: 'voice-21' },
    }))

    expect(acquired).toBe(true)
    expect(modelCalls).toBe(0)
    expect(h.sent).toContain('❌ Не удалось безопасно обработать голосовое сообщение.')
  })

  it('renders degradation from code-owned policy and ignores injected notice text', async () => {
    let acquired = false
    let modelCalls = 0
    const h = harness({
      captureWorkBinding: async () => ({ ...BINDING }),
      voiceIngress: {
        async handle() {
          return {
            kind: 'degraded', policy: 'text-only', notice: 'private backend detail',
          }
        },
      },
      acquireBackgroundRuntime: async (binding) => {
        acquired = true
        return {
          sessionId: binding.sessionId,
          runner: { async handle() { modelCalls += 1; return { state: 'ok', reply: '', narrowed: false } } },
        }
      },
    })

    await h.bot.handleUpdate(mediaUpdate(24, {
      voice: { file_id: 'voice-file', file_unique_id: 'voice-24' },
    }))

    expect(acquired).toBe(true)
    expect(modelCalls).toBe(0)
    expect(h.sent).toContain('🎙 Не удалось обработать голос — отправьте сообщение текстом.')
    expect(h.sent.join('\n')).not.toContain('private backend detail')
  })

  it('closes and releases a bound voice turn when no-output ingress fails', async () => {
    let content: string | undefined
    const checkpointStore = makeJsonTelegramExecutionCheckpointStore({
      exists: () => content !== undefined,
      read: () => content ?? '',
      saveAtomic: (next) => { content = next },
    })
    const order: string[] = []
    let failClosedCalls = 0
    let h!: ReturnType<typeof harness>
    const authority: TelegramExecutionAuthorityPublisher = {
      async captureTurn(bindingHash) {
        order.push('capture')
        let held = true
        return {
          bindingHash,
          authorityPhase: 'captured-unbound',
          isHeld: () => held,
          async bindCheckpoint() { order.push('bind') },
          async release() {
            expect(checkpointStore.load()).toMatchObject({
              status: 'ready',
              checkpoint: { phase: 'terminal', delivery: 'delivered', state: { status: 'failed' } },
            })
            order.push('release')
            held = false
          },
          failClosed(): never {
            failClosedCalls += 1
            throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE')
          },
        }
      },
    }
    h = harness({
      captureWorkBinding: async () => ({ ...BINDING }),
      voiceIngress: {
        async handle() {
          return { kind: 'degraded', policy: 'text-only', notice: 'private backend detail' }
        },
      },
      acquireBackgroundRuntime: async (binding) => ({
        sessionId: binding.sessionId,
        runner,
      }),
      executionCheckpoint: {
        store: checkpointStore,
        newOwnerId: () => 'bot-runtime-a',
        nowIso: () => '2026-07-29T06:00:00.000Z',
        authority,
      },
      failSendMessage: true,
    })

    await h.bot.handleUpdate(mediaUpdate(25, {
      voice: { file_id: 'voice-file', file_unique_id: 'voice-25' },
    }))

    expect(order).toEqual(['capture', 'bind', 'release'])
    expect(failClosedCalls).toBe(0)
    expect(checkpointStore.load())
      .not.toMatchObject({ checkpoint: { messageId: expect.anything() } })
  })

  it('does not start voice while a text turn is still buffered', async () => {
    let voiceCalls = 0
    const h = harness({
      debounceMs: 5000,
      captureWorkBinding: async () => ({ ...BINDING }),
      voiceIngress: {
        async handle() {
          voiceCalls += 1
          return { kind: 'cancelled' }
        },
      },
      acquireBackgroundRuntime: async (binding) => ({
        sessionId: binding.sessionId, runner,
      }),
    })

    await h.bot.handleUpdate({
      update_id: 25,
      message: {
        message_id: 25, date: 1_785_000_025,
        chat: { id: 42, type: 'private', first_name: 'Operator' },
        from: { id: 42, is_bot: false, first_name: 'Operator' },
        text: 'Сначала текст',
      },
    } as Update)
    await h.bot.handleUpdate(mediaUpdate(26, {
      voice: { file_id: 'voice-file', file_unique_id: 'voice-26' },
    }))
    await h.bot.handleUpdate({
      update_id: 27,
      message: {
        message_id: 27, date: 1_785_000_027,
        chat: { id: 42, type: 'private', first_name: 'Operator' },
        from: { id: 42, is_bot: false, first_name: 'Operator' },
        text: '/stop', entities: [{ offset: 0, length: 5, type: 'bot_command' }],
      },
    } as Update)

    expect(voiceCalls).toBe(0)
    expect(h.sent).toContain(
      '🎙 Дождитесь завершения текущего ответа и повторите голосовое сообщение.',
    )
  })

  it('propagates /stop into voice transcription and never starts a model turn', async () => {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let acquired = false
    let modelCalls = 0
    const h = harness({
      captureWorkBinding: async () => ({ ...BINDING }),
      voiceIngress: {
        async handle(input) {
          started()
          await new Promise<void>((resolve) => {
            if (input.signal?.aborted === true) resolve()
            else input.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          return { kind: 'cancelled' }
        },
      },
      acquireBackgroundRuntime: async (binding) => {
        acquired = true
        return {
          sessionId: binding.sessionId,
          runner: { async handle() { modelCalls += 1; return { state: 'ok', reply: '', narrowed: false } } },
        }
      },
    })

    const pending = h.bot.handleUpdate(mediaUpdate(22, {
      voice: { file_id: 'voice-file', file_unique_id: 'voice-22' },
    }))
    await ready
    await h.bot.handleUpdate({
      update_id: 23,
      message: {
        message_id: 23, date: 1_785_000_023,
        chat: { id: 42, type: 'private', first_name: 'Operator' },
        from: { id: 42, is_bot: false, first_name: 'Operator' },
        text: '/stop',
        entities: [{ offset: 0, length: 5, type: 'bot_command' }],
      },
    } as Update)
    await pending

    expect(acquired).toBe(true)
    expect(modelCalls).toBe(0)
    expect(h.sent).toContain('⏹ Остановлено.')
  })

  it('replays the full bot-to-inbox voice path after restart without redownloading bytes', async () => {
    const inboxRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-bot-voice-')))
    const audio = Buffer.from('OggS restart voice')
    let downloads = 0
    let turns = 0
    const makeHarness = () => {
      const attachmentInbox = makeTelegramAttachmentInbox({
        inboxRoot,
        allowedChatId: 42,
        maxAttachmentBytes: 1024 * 1024,
        download: {
          async download() {
            downloads += 1
            return {
              body: (async function* () { yield audio })(),
              sizeBytes: audio.byteLength,
            }
          },
        },
      })
      return harness({
        captureWorkBinding: async () => ({ ...BINDING }),
        voiceIngress: makeTelegramVoiceIngress({
          inbox: attachmentInbox,
          inboxRoot,
          transcriber: {
            async transcribe() {
              return {
                text: 'Голос после рестарта',
                provenance: 'untrusted',
                channel: 'voice',
              }
            },
          },
          degradePolicy: 'text-only',
          maxAudioBytes: 1024 * 1024,
        }),
        acquireBackgroundRuntime: async (binding) => ({
          sessionId: binding.sessionId,
          runner: {
            async handle() {
              turns += 1
              return { state: 'ok', reply: 'Принято', narrowed: false }
            },
          },
        }),
      })
    }

    try {
      const first = makeHarness()
      const voice = {
        voice: {
          file_id: 'voice-restart',
          file_unique_id: 'voice-restart-unique',
          file_size: audio.byteLength,
        },
      }
      await first.bot.handleUpdate(mediaUpdate(30, voice))
      const restarted = makeHarness()
      await restarted.bot.handleUpdate(mediaUpdate(30, voice))

      expect(downloads).toBe(1)
      expect(turns).toBe(2)
      expect(restarted.sent).toContain('Принято')
    } finally {
      rmSync(inboxRoot, { recursive: true, force: true })
    }
  })

  it('reports a partial album once without exposing the ingest error', async () => {
    let call = 0
    const h = harness({
      attachmentInbox: {
        async ingest(input) {
          call += 1
          if (call === 2) throw new Error('private failure detail')
          return {
            schemaVersion: 1,
            fileId: `saved-${input.attachment.messageId}`,
            operatorId: input.binding.operatorId,
            profileId: input.binding.profileId,
            sessionId: input.binding.sessionId,
            source: 'telegram',
            originalName: input.attachment.originalName,
            sha256: 'b'.repeat(64),
            sizeBytes: 1,
            provenanceRef: 'telegram:test',
            receivedAt: new Date(input.attachment.unixSeconds * 1000).toISOString(),
          }
        },
      },
      captureWorkBinding: async () => ({ ...BINDING }),
    })

    await h.bot.handleUpdate(mediaUpdate(1, {
      photo: [{ file_id: 'photo-a', file_unique_id: 'photo-a', file_size: 1 }],
    }, 'album-partial'))
    await h.bot.handleUpdate(mediaUpdate(2, {
      photo: [{ file_id: 'photo-b', file_unique_id: 'photo-b', file_size: 1 }],
    }, 'album-partial'))
    await waitFor(() => h.sent.length === 1)

    expect(h.sent).toEqual(['❌ Альбом сохранён не полностью: 1 из 2. Повторите отправку.'])
    expect(h.sent.join('\n')).not.toContain('private failure detail')
  })

  it('caps an album at ten downloads and reports an oversized group once', async () => {
    let downloads = 0
    const h = harness({
      attachmentInbox: {
        async ingest(input) {
          downloads += 1
          return {
            schemaVersion: 1,
            fileId: `saved-${input.attachment.messageId}`,
            operatorId: input.binding.operatorId,
            profileId: input.binding.profileId,
            sessionId: input.binding.sessionId,
            source: 'telegram',
            originalName: input.attachment.originalName,
            sha256: 'c'.repeat(64),
            sizeBytes: 1,
            provenanceRef: 'telegram:test',
            receivedAt: new Date(input.attachment.unixSeconds * 1000).toISOString(),
          }
        },
      },
      captureWorkBinding: async () => ({ ...BINDING }),
      mediaGroupDebounceMs: 50,
    })

    for (let index = 1; index <= 11; index += 1) {
      await h.bot.handleUpdate(mediaUpdate(index, {
        photo: [{
          file_id: `photo-${index}`,
          file_unique_id: `photo-${index}`,
          file_size: 1,
        }],
      }, 'album-oversized'))
    }
    await waitFor(() => h.sent.length === 1)

    expect(downloads).toBe(10)
    expect(h.sent).toEqual(['❌ Альбом сохранён не полностью: 10 из 11. Повторите отправку.'])
  })

  it('redacts inbox and binding failures', async () => {
    const h = harness({
      attachmentInbox: {
        async ingest() { throw new Error('sensitive internal path') },
      },
      captureWorkBinding: async () => ({ ...BINDING }),
    })

    await h.bot.handleUpdate(mediaUpdate(1, {
      video: { file_id: 'video-file', file_unique_id: 'video-1' },
    }))

    expect(h.sent).toEqual(['❌ Не удалось безопасно сохранить вложение.'])
    expect(h.sent.join('\n')).not.toContain('sensitive internal path')
  })
})
