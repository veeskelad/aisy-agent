// The skills folder as a screen: page through what is installed, open one,
// switch it off, delete it, install a sent SKILL.md.
//
// Skill names are data — they come from files an operator may have written — so
// callbacks carry a minted token, never the name. Tokens are per-process and
// per-render, which also makes a tap on a card from before a delete land as
// "stale" instead of acting on whatever now sits at that position.

import { randomUUID } from 'node:crypto'
import type { SkillFolderEntry, SkillFolderPort, SkillInstallResult } from './active-skill-store.js'
import { fitLabel } from '@aisy/telegram-gw'

export interface TelegramSkillButton {
  text: string
  data: string
}

export interface TelegramSkillView {
  text: string
  buttons: TelegramSkillButton[][]
}

export type TelegramSkillOutcome =
  /** Replace the current card. */
  | { kind: 'view'; view: TelegramSkillView }
  /** Say something and leave the card as it is. */
  | { kind: 'notice'; text: string }
  | { kind: 'stale'; view: TelegramSkillView }

export interface TelegramSkillControls {
  open(): TelegramSkillView
  handle(data: string): TelegramSkillOutcome
  /** A SKILL.md that arrived in the chat. */
  install(skillText: string): TelegramSkillOutcome
}

type PendingAction =
  | { kind: 'page'; page: number }
  | { kind: 'card'; name: string; page: number }
  | { kind: 'toggle'; name: string; enabled: boolean; page: number }
  | { kind: 'confirm-delete'; name: string; page: number }
  | { kind: 'delete'; name: string; page: number }
  | { kind: 'install-help' }

const CALLBACK_PREFIX = 'skill:'
const PAGE_SIZE = 8
const MAX_ISSUED_TOKENS = 100_000

const PROBLEM_TEXT: Record<string, string> = {
  'invalid-manifest': 'запись в манифесте битая',
  'invalid-skill': 'файл навыка не читается или не разбирается',
  'hash-mismatch': 'файл правили вручную — не совпадает с записью',
  'identity-mismatch': 'имя или версия в файле не те, что в записи',
  unverified: 'навык не прошёл проверку',
}

const INSTALL_HELP = 'Пришли файл SKILL.md одним сообщением — установлю или обновлю навык.\n' +
  'В файле нужен заголовок между «---» (name, description, version, provenance, triggers) ' +
  'и раздел «## Verification».'

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength - 1).trimEnd() + '…'
}

function installNotice(result: SkillInstallResult): string {
  if (result.ok) {
    if (result.previousVersion === null) return `🧩 Навык «${result.name}» установлен (версия ${result.version}).`
    return `🧩 Навык «${result.name}» обновлён: ${result.previousVersion} → ${result.version}.` +
      (result.versionRaised ? '\nВ файле стояла старая версия — поднял сам.' : '')
  }
  if (result.errorCode === 'ALREADY_INSTALLED') return '🧩 Такой навык уже стоит — файл не изменился.'
  if (result.errorCode === 'NOT_A_SKILL') {
    return '❌ Это не похоже на SKILL.md' + (result.detail === undefined ? '.' : `: ${result.detail}.`)
  }
  if (result.errorCode === 'NO_VERIFICATION') {
    return '❌ В файле нет раздела «## Verification» — без него навык не запускается.'
  }
  if (result.errorCode === 'TOO_LARGE') return '❌ Файл больше 256 КБ.'
  if (result.errorCode === 'REVISION_CONFLICT') {
    return '❌ Файл этого навыка на сервере правили мимо меня. Удали навык в списке и пришли файл заново.'
  }
  return '❌ Не удалось записать навык.'
}

export function makeTelegramSkillControls(input: {
  folder: SkillFolderPort
  /** Called after the folder actually changed, so the runtime can re-read it. */
  onChanged?: () => void
  newTokenId?: () => string
  pageSize?: number
}): TelegramSkillControls {
  const pageSize = input.pageSize ?? PAGE_SIZE
  const newTokenId = input.newTokenId ?? randomUUID
  const pending = new Map<string, PendingAction>()
  const issued = new Set<string>()

  const mint = (action: PendingAction): string => {
    if (issued.size >= MAX_ISSUED_TOKENS) issued.clear()
    const token = newTokenId()
    issued.add(token)
    pending.set(token, action)
    return CALLBACK_PREFIX + token
  }

  const changed = (): void => {
    // A folder change that the running agent never learns about is a lie on
    // screen; the notification failing must not roll back what was written.
    try { input.onChanged?.() } catch { /* the manifest is already durable */ }
  }

  const failed = (text: string): TelegramSkillView => {
    pending.clear()
    return { text, buttons: [[{ text: '⬇️ Как установить', data: mint({ kind: 'install-help' }) }]] }
  }

  const entries = (): SkillFolderEntry[] | null => {
    try { return input.folder.list() } catch { return null }
  }

  const renderList = (requestedPage: number): TelegramSkillView => {
    const all = entries()
    if (all === null) {
      return failed('🧩 Навыки\n❌ Список навыков повреждён — открой его через `aisy doctor`.')
    }
    pending.clear()
    if (all.length === 0) {
      return {
        text: '🧩 Навыки\nПапка пустая.\n\n' + INSTALL_HELP,
        buttons: [],
      }
    }
    const pageCount = Math.max(1, Math.ceil(all.length / pageSize))
    const page = Math.min(Math.max(0, requestedPage), pageCount - 1)
    const buttons: TelegramSkillButton[][] = all
      .slice(page * pageSize, (page + 1) * pageSize)
      .map((entry) => [{
        text: fitLabel(`${entry.problem !== null ? '⚠️' : entry.enabled ? '✅' : '⏸'} ${entry.name}`),
        data: mint({ kind: 'card', name: entry.name, page }),
      }])
    if (pageCount > 1) {
      buttons.push([
        ...(page > 0 ? [{ text: '◀️', data: mint({ kind: 'page', page: page - 1 }) }] : []),
        { text: `${page + 1}/${pageCount}`, data: mint({ kind: 'page', page }) },
        ...(page + 1 < pageCount ? [{ text: '▶️', data: mint({ kind: 'page', page: page + 1 }) }] : []),
      ])
    }
    buttons.push([{ text: '⬇️ Установить навык', data: mint({ kind: 'install-help' }) }])
    const off = all.filter((entry) => !entry.enabled && entry.problem === null).length
    const broken = all.filter((entry) => entry.problem !== null).length
    return {
      text: `🧩 Навыки · ${all.length}` +
        (off > 0 ? `, выключено ${off}` : '') +
        (broken > 0 ? `, с проблемой ${broken}` : '') +
        '\nОткрой навык, чтобы посмотреть и что-то с ним сделать.',
      buttons,
    }
  }

  const renderCard = (name: string, page: number): TelegramSkillView => {
    const all = entries()
    const entry = all?.find((candidate) => candidate.name === name)
    if (!entry) return renderList(page)
    pending.clear()
    const state = entry.problem !== null
      ? `⚠️ ${PROBLEM_TEXT[entry.problem] ?? entry.problem}`
      : entry.enabled ? '✅ включён' : '⏸ выключен'
    return {
      text: `🧩 ${compact(entry.name, 80)}\n` +
        `Версия ${entry.version} · ${entry.trustSource} · ${state}\n\n` +
        (entry.description.length === 0 ? 'Описание не читается.' : compact(entry.description, 300)),
      buttons: [
        [
          {
            text: entry.enabled ? '⏸ Выключить' : '▶️ Включить',
            data: mint({ kind: 'toggle', name: entry.name, enabled: !entry.enabled, page }),
          },
          { text: '🗑 Удалить', data: mint({ kind: 'confirm-delete', name: entry.name, page }) },
        ],
        [{ text: '⬅️ К списку', data: mint({ kind: 'page', page }) }],
      ],
    }
  }

  const renderDeleteConfirm = (name: string, page: number): TelegramSkillView => {
    pending.clear()
    return {
      text: `🗑 Удалить навык «${compact(name, 80)}»?\nФайл и запись в списке будут стёрты.`,
      buttons: [[
        { text: '🗑 Да, удалить', data: mint({ kind: 'delete', name, page }) },
        { text: '⬅️ Отмена', data: mint({ kind: 'card', name, page }) },
      ]],
    }
  }

  return Object.freeze<TelegramSkillControls>({
    open: () => renderList(0),

    handle(data) {
      if (!data.startsWith(CALLBACK_PREFIX)) return { kind: 'stale', view: renderList(0) }
      const action = pending.get(data.slice(CALLBACK_PREFIX.length))
      if (!action) return { kind: 'stale', view: renderList(0) }
      if (action.kind === 'install-help') return { kind: 'notice', text: INSTALL_HELP }
      if (action.kind === 'page') return { kind: 'view', view: renderList(action.page) }
      if (action.kind === 'card') return { kind: 'view', view: renderCard(action.name, action.page) }
      if (action.kind === 'confirm-delete') {
        return { kind: 'view', view: renderDeleteConfirm(action.name, action.page) }
      }
      if (action.kind === 'toggle') {
        try {
          if (!input.folder.setEnabled(action.name, action.enabled)) {
            return { kind: 'stale', view: renderList(action.page) }
          }
        } catch {
          return { kind: 'notice', text: '❌ Не удалось изменить состояние навыка.' }
        }
        changed()
        return { kind: 'view', view: renderCard(action.name, action.page) }
      }
      try {
        if (!input.folder.remove(action.name)) return { kind: 'stale', view: renderList(action.page) }
      } catch {
        return { kind: 'notice', text: '❌ Не удалось удалить навык.' }
      }
      changed()
      return { kind: 'view', view: renderList(action.page) }
    },

    install(skillText) {
      let result: SkillInstallResult
      try { result = input.folder.install(skillText) } catch {
        return { kind: 'notice', text: '❌ Не удалось записать навык.' }
      }
      // A change to the folder always comes back as the folder, so the operator
      // sees the new state instead of taking the notice on faith.
      if (!result.ok) return { kind: 'notice', text: installNotice(result) }
      changed()
      const view = renderList(0)
      return { kind: 'view', view: { ...view, text: `${installNotice(result)}\n\n${view.text}` } }
    },
  })
}
