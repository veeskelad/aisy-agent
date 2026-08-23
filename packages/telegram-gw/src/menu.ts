// Main menu (plan §3). Mirrors the reference screenshot: a persistent 2×4
// reply keyboard. This module is pure data + resolution; the grammY Keyboard is
// assembled from MAIN_MENU in bot.ts.

export type MenuAction =
  | 'new_session'
  | 'projects'
  | 'sessions'
  | 'skills'
  | 'agent'
  | 'mcp'
  | 'settings'
  | 'monitor'

export interface MenuButton {
  label: string
  action: MenuAction
}

export const MENU_GREETING = 'Aisy готов. Пиши задачу или выбери действие.'

export const MAIN_MENU: readonly (readonly MenuButton[])[] = [
  [
    { label: '🆕 Новая сессия', action: 'new_session' },
    { label: '📁 Проекты', action: 'projects' },
  ],
  [
    { label: '💬 Сессии', action: 'sessions' },
    { label: '🧩 Навыки', action: 'skills' },
  ],
  [
    { label: '🧠 Агент', action: 'agent' },
    { label: '🔌 MCP', action: 'mcp' },
  ],
  [
    { label: '⚙️ Настройки', action: 'settings' },
    { label: '📡 Монитор', action: 'monitor' },
  ],
]

/** What each section is for, in the operator's terms. Missing one is a type error. */
const MENU_PURPOSE: Readonly<Record<MenuAction, string>> = {
  new_session: 'начать с чистого листа — прошлый разговор остаётся в истории',
  projects: 'папка, в которой я работаю; переключение меняет и файлы, и доступ',
  sessions: 'вернуться в прошлый разговор и продолжить его',
  skills: 'инструкции под конкретную работу — подхватываю их сам',
  agent: 'какой мозг отвечает и насколько свободно я действую',
  mcp: 'внешние инструменты: подключить, посмотреть, отключить',
  settings: 'ключи сервисов, голос, часовой пояс, лимит расходов',
  monitor: 'что происходит на сервере и сколько потрачено',
}

/**
 * The tour of the keyboard, built from the keyboard itself so the two cannot
 * drift apart. Plain text on purpose: it goes out through the same reply path
 * as anything else the agent says, and that path escapes markup.
 */
export function renderMenuTour(): string {
  return [
    '⌨️ Меню внизу — восемь разделов:',
    '',
    ...MAIN_MENU.flat().map((b) => `${b.label} — ${MENU_PURPOSE[b.action]}`),
    '',
    'Всё это можно и просто попросить словами — кнопки быстрее, слова точнее.',
  ].join('\n')
}

const BY_LABEL: ReadonlyMap<string, MenuAction> = new Map(
  MAIN_MENU.flat().map((b) => [b.label, b.action]),
)

/** Resolve a tapped reply-keyboard label to its action, or null if not a menu label. */
export function resolveMenu(label: string): MenuAction | null {
  return BY_LABEL.get(label.trim()) ?? null
}
