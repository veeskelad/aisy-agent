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
    { label: '🔌 МСР', action: 'mcp' },
  ],
  [
    { label: '⚙️ Настройки', action: 'settings' },
    { label: '📡 Монитор', action: 'monitor' },
  ],
]

const BY_LABEL: ReadonlyMap<string, MenuAction> = new Map(
  MAIN_MENU.flat().map((b) => [b.label, b.action]),
)

/** Resolve a tapped reply-keyboard label to its action, or null if not a menu label. */
export function resolveMenu(label: string): MenuAction | null {
  return BY_LABEL.get(label.trim()) ?? null
}
