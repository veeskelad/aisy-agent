// The MCP screen: what is approved, what it may do, and the two-step road from
// "here is a command" to "this server is allowed".
//
// Server and tool names are data — they come from a server we do not control —
// so callbacks carry a minted token, never a name. Tokens are per-process and
// per-render, which also makes a tap on a card from before a change land as
// "stale" instead of acting on whatever now sits in that position.
//
// Every write goes through the writer, and the manifest is re-validated from
// scratch on the next start. Nothing here shortens that: approving records a
// decision, it does not grant a running capability.

import { randomUUID } from 'node:crypto'

import { askLevel, fitLabel } from '@aisy/telegram-gw'

import type { McpAllowlistWriter } from './mcp-allowlist-store.js'
import type { McpServerDraft, McpServerOnboarding } from './mcp-server-onboarding.js'
import { McpOnboardingError } from './mcp-server-onboarding.js'

export interface TelegramMcpButton {
  text: string
  data: string
}

export interface TelegramMcpView {
  text: string
  buttons: TelegramMcpButton[][]
}

export type TelegramMcpOutcome =
  | { kind: 'view'; view: TelegramMcpView }
  | { kind: 'notice'; text: string }
  | { kind: 'stale'; view: TelegramMcpView }
  /** The next plain message is the server line. */
  | { kind: 'await-server'; view: TelegramMcpView }

export interface TelegramMcpControls {
  open(): TelegramMcpView
  handle(data: string): TelegramMcpOutcome | Promise<TelegramMcpOutcome>
  /** A server line the operator typed after tapping "add". */
  add(text: string): Promise<TelegramMcpOutcome>
}

type PendingAction =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'card'; server: string }
  | { kind: 'toggle'; server: string; active: boolean }
  | { kind: 'confirm-remove'; server: string }
  | { kind: 'remove'; server: string }
  | { kind: 'approve'; draftId: string }
  | { kind: 'discard'; draftId: string }

const CALLBACK_PREFIX = 'mcp:'
const PAGE_LIMIT = 16
const MAX_ISSUED_TOKENS = 100_000

const ADD_HELP = 'Пришли одной строкой: имя, затем команда запуска сервера полным путём, ' +
  'и при необходимости имя переменной с токеном.\n\n' +
  'Например:\n`tracker /usr/local/bin/tracker-mcp --stdio TRACKER_TOKEN`\n\n' +
  'Значение токена сюда присылать не нужно — оно берётся из хранилища ключей. ' +
  'Путь именно полный: `npx` завтра запустит не то, что одобрено сегодня.'

const FAILURE_TEXT: Record<string, string> = {
  INVALID_NAME: 'Имя сервера — латиница, цифры, точка, дефис или подчёркивание.',
  NAME_TAKEN: 'Сервер с таким именем уже одобрен. Удали его или возьми другое имя.',
  INVALID_COMMAND: 'Команда должна начинаться с полного пути (со слэша).',
  INVALID_TOKEN_ENV: 'Имя переменной с токеном — заглавными буквами и подчёркиваниями.',
  TOKEN_UNRESOLVED: 'Такой переменной нет в хранилище ключей — сначала добавь ключ.',
  UNREACHABLE: 'Сервер не отвечает как MCP. Проверь путь и права на запуск.',
  NO_TOOLS: 'Сервер не отдал ни одного инструмента — одобрять нечего.',
  INVALID_PIN: 'Сервер не называет свою версию, а без точной версии его не запинить.',
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength - 1).trimEnd() + '…'
}

export function makeTelegramMcpControls(input: {
  writer: McpAllowlistWriter
  onboarding: McpServerOnboarding
  /** Names of servers that answered a live gauntlet in this process. */
  activeServerNames?: () => Iterable<string>
  /** Called after the manifest changed, so the composition can say so. */
  onChanged?: () => void
  newTokenId?: () => string
}): TelegramMcpControls {
  const newTokenId = input.newTokenId ?? randomUUID
  const pending = new Map<string, PendingAction>()
  const issued = new Set<string>()
  const drafts = new Map<string, McpServerDraft>()

  const mint = (action: PendingAction): string => {
    if (issued.size >= MAX_ISSUED_TOKENS) issued.clear()
    const token = newTokenId()
    issued.add(token)
    pending.set(token, action)
    return CALLBACK_PREFIX + token
  }

  const changed = (): void => {
    // A manifest change the running agent never learns about is a lie on
    // screen; a failing notification must not roll back what was written.
    try { input.onChanged?.() } catch { /* the manifest is already durable */ }
  }

  const entries = () => {
    try { return input.writer.entries() } catch { return [] }
  }

  const renderList = (): TelegramMcpView => {
    pending.clear()
    const servers = entries().slice(0, PAGE_LIMIT)
    const live = new Set(input.activeServerNames?.() ?? [])
    const lines = servers.map(server => {
      const state = server.status !== 'active'
        ? '⏸ выключен'
        : live.has(server.name) ? '🟢 на связи' : '✅ одобрен'
      return `${state} · *${server.name}* — ${String(server.tools.length)} инстр.`
    })
    const text = servers.length === 0
      ? '🔌 MCP-серверов пока нет.\n\nMCP — это способ дать мне чужие инструменты: трекер, ' +
        'базу, файлы. Каждый сервер одобряется вручную, по одному инструменту.'
      : `🔌 MCP-серверы:\n\n${lines.join('\n')}`
    return {
      text,
      buttons: [
        ...servers.map(server => [{
          text: fitLabel(`${server.status === 'active' ? '🔌' : '⏸'} ${server.name}`),
          data: mint({ kind: 'card', server: server.name }),
        }]),
        [{ text: '➕ Добавить сервер', data: mint({ kind: 'add' }) }],
      ],
    }
  }

  const stale = (): TelegramMcpOutcome => ({ kind: 'stale', view: renderList() })

  const renderCard = (name: string): TelegramMcpView => {
    const server = entries().find(item => item.name === name)
    if (server === undefined) return renderList()
    const tools = server.tools.map(policy =>
      `• \`${policy.tool}\` — ${policy.outboundSink ? 'пишет' : 'читает'}, ` +
      `${askLevel(policy.tier)}` +
      (policy.summary === null ? '\n   (без описания — агенту не показывается)' : `\n   ${policy.summary}`))
    const text = `🔌 *${server.name}*\n` +
      `Версия: \`${server.pin}\`\n` +
      `Запуск: \`${compact(server.command?.join(' ') ?? server.endpoint ?? '', 200)}\`\n` +
      `Токен: ${server.tokenEnv ?? 'не нужен'}\n\n` +
      `Инструменты:\n${tools.join('\n')}`
    const active = server.status === 'active'
    return {
      text,
      buttons: [
        [{
          text: active ? '⏸ Выключить' : '▶️ Включить',
          data: mint({ kind: 'toggle', server: server.name, active: !active }),
        }],
        [{ text: '🗑 Удалить', data: mint({ kind: 'confirm-remove', server: server.name }) }],
        [{ text: '← К списку', data: mint({ kind: 'list' }) }],
      ],
    }
  }

  const renderDraft = (draftId: string, draft: McpServerDraft): TelegramMcpView => {
    // The summary is the server's own words and is shown here on purpose: it is
    // the exact line the agent will read later, and approving is what makes it
    // authority. A tool without one stays invisible to the agent.
    const tools = draft.tools.map(policy =>
      `• \`${policy.tool}\` — ${policy.outboundSink ? 'пишет' : 'читает'}, ` +
      `${askLevel(policy.tier)}` +
      (policy.summary === null ? '\n   (без описания — агенту не покажу)' : `\n   ${policy.summary}`))
    return {
      text: `🔌 Сервер *${draft.name}* ответил.\n\n` +
        `Версия: \`${draft.pin}\`\n` +
        `Отпечаток набора: \`${draft.descriptorHash.slice(0, 16)}…\`\n\n` +
        `Инструменты, которые он отдаёт:\n${tools.join('\n')}\n\n` +
        'Одобришь — запишу эти правила: версию, отпечаток набора и режим на каждый ' +
        'инструмент. Если сервер потом подменит набор, я не подключусь молча, а покажу, ' +
        'что изменилось.\n\n' +
        'После одобрения инструменты станут доступны мне со следующего запуска — ' +
        'каждый вызов проходит те же подтверждения, что и остальные действия.',
      buttons: [
        [{ text: '✅ Одобрить', data: mint({ kind: 'approve', draftId }) }],
        [{ text: '✖️ Не надо', data: mint({ kind: 'discard', draftId }) }],
      ],
    }
  }

  return {
    open: renderList,

    async add(text: string): Promise<TelegramMcpOutcome> {
      let draft: McpServerDraft
      try {
        const request = input.onboarding.parse(text)
        draft = await input.onboarding.discover(request)
      } catch (error) {
        const reason = error instanceof McpOnboardingError ? error.reason : 'UNREACHABLE'
        return { kind: 'notice', text: `❌ ${FAILURE_TEXT[reason] ?? 'Не получилось.'}` }
      }
      const draftId = newTokenId()
      drafts.set(draftId, draft)
      return { kind: 'view', view: renderDraft(draftId, draft) }
    },

    handle(data: string): TelegramMcpOutcome {
      if (!data.startsWith(CALLBACK_PREFIX)) return stale()
      const action = pending.get(data.slice(CALLBACK_PREFIX.length))
      if (action === undefined) return stale()
      pending.delete(data.slice(CALLBACK_PREFIX.length))

      if (action.kind === 'list') return { kind: 'view', view: renderList() }
      if (action.kind === 'add') {
        return { kind: 'await-server', view: { text: ADD_HELP, buttons: [] } }
      }
      if (action.kind === 'card') return { kind: 'view', view: renderCard(action.server) }
      if (action.kind === 'toggle') {
        try {
          input.writer.setStatus(action.server, action.active ? 'active' : 'archived')
        } catch {
          return { kind: 'notice', text: '❌ Не удалось записать изменение.' }
        }
        changed()
        return {
          kind: 'view',
          view: {
            ...renderCard(action.server),
            text: `${renderCard(action.server).text}\n\n` +
              (action.active ? '▶️ Включён.' : '⏸ Выключен.'),
          },
        }
      }
      if (action.kind === 'confirm-remove') {
        return {
          kind: 'view',
          view: {
            text: `🗑 Удалить сервер *${action.server}* вместе с одобрением?\n\n` +
              'Чтобы вернуть, его придётся одобрять заново.',
            buttons: [
              [{ text: '🗑 Да, удалить', data: mint({ kind: 'remove', server: action.server }) }],
              [{ text: '← Назад', data: mint({ kind: 'card', server: action.server }) }],
            ],
          },
        }
      }
      if (action.kind === 'remove') {
        try {
          input.writer.remove(action.server)
        } catch {
          return { kind: 'notice', text: '❌ Не удалось удалить.' }
        }
        changed()
        return { kind: 'view', view: renderList() }
      }
      if (action.kind === 'discard') {
        drafts.delete(action.draftId)
        return { kind: 'view', view: renderList() }
      }
      const draft = drafts.get(action.draftId)
      if (draft === undefined) return stale()
      drafts.delete(action.draftId)
      try {
        input.onboarding.approve(draft)
      } catch {
        return { kind: 'notice', text: '❌ Не удалось записать одобрение.' }
      }
      changed()
      return {
        kind: 'view',
        view: {
          ...renderList(),
          text: `✅ Сервер *${draft.name}* одобрен и записан.`,
        },
      }
    },
  }
}
