// Persistent task tracker (ADR-0081).
//
// The third durable planning entity, deliberately the simplest: a goal needs a
// completion probe, a trigger needs a schedule, a task needs neither. What it
// does need is to survive a restart, which is exactly what the conversation
// cannot do.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Живых задач больше этого не бывает: список дел, а не очередь работ. */
export const MAX_LIVE_TASKS = 200
export const MAX_TASK_CHARS = 500
/** How many open tasks reach the context of one turn. */
export const MAX_TASKS_IN_CONTEXT = 20

export interface Task {
  id: string
  text: string
  status: 'open' | 'done'
  createdAt: string
  closedAt?: string
}

export type TaskRefusal = 'empty-text' | 'text-too-long' | 'too-many-tasks' | 'unknown-task'

export interface TaskTracker {
  list(): readonly Task[]
  add(text: string): Task | TaskRefusal
  done(id: string): Task | TaskRefusal
  drop(id: string): true | TaskRefusal
  /** Open tasks as a context fragment, or null when there are none. */
  contextBlock(): string | null
}

interface Persisted {
  schemaVersion: 1
  nextId: number
  tasks: Task[]
}

function decode(raw: string): Persisted | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const input = value as Record<string, unknown>
  if (input['schemaVersion'] !== 1) return null
  if (!Number.isSafeInteger(input['nextId']) || Number(input['nextId']) < 1) return null
  if (!Array.isArray(input['tasks'])) return null
  const tasks: Task[] = []
  for (const item of input['tasks']) {
    if (typeof item !== 'object' || item === null) return null
    const task = item as Record<string, unknown>
    if (typeof task['id'] !== 'string' || task['id'] === '') return null
    if (typeof task['text'] !== 'string' || task['text'] === '') return null
    if (task['status'] !== 'open' && task['status'] !== 'done') return null
    if (typeof task['createdAt'] !== 'string') return null
    const decoded: Task = {
      id: task['id'],
      text: task['text'],
      status: task['status'],
      createdAt: task['createdAt'],
    }
    if (typeof task['closedAt'] === 'string') decoded.closedAt = task['closedAt']
    tasks.push(decoded)
  }
  return { schemaVersion: 1, nextId: Number(input['nextId']), tasks }
}

export function makeTaskTracker(deps: {
  path: string
  nowIso: () => string
  /** Reported once when the stored list could not be read. */
  onQuarantine?: (detail: string) => void
}): TaskTracker {
  let state: Persisted = { schemaVersion: 1, nextId: 1, tasks: [] }

  if (existsSync(deps.path)) {
    let raw = ''
    try {
      raw = readFileSync(deps.path, 'utf8')
    } catch {
      raw = ''
    }
    const loaded = raw === '' ? null : decode(raw)
    if (loaded === null) {
      // Losing the list is bad; refusing to start is worse.
      try {
        renameSync(deps.path, `${deps.path}.quarantine`)
      } catch { /* the quarantine copy is a courtesy, not a requirement */ }
      deps.onQuarantine?.('task list unreadable, quarantined')
    } else {
      state = loaded
    }
  }

  const persist = (): void => {
    try {
      mkdirSync(dirname(deps.path), { recursive: true, mode: 0o700 })
      const temporary = `${deps.path}.tmp`
      writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
      renameSync(temporary, deps.path)
    } catch { /* a full disk must not cost the operator a turn */ }
  }

  const find = (id: string): Task | undefined => state.tasks.find((task) => task.id === id)

  return {
    list() {
      return state.tasks.map((task) => ({ ...task }))
    },

    add(text) {
      const trimmed = text.replace(/\s+/g, ' ').trim()
      if (trimmed === '') return 'empty-text'
      if (trimmed.length > MAX_TASK_CHARS) return 'text-too-long'
      if (state.tasks.filter((task) => task.status === 'open').length >= MAX_LIVE_TASKS) {
        return 'too-many-tasks'
      }
      // The counter never rewinds: a reference to t7 must not one day point at
      // a different task.
      const task: Task = {
        id: `t${state.nextId}`,
        text: trimmed,
        status: 'open',
        createdAt: deps.nowIso(),
      }
      state = { ...state, nextId: state.nextId + 1, tasks: [...state.tasks, task] }
      persist()
      return { ...task }
    },

    done(id) {
      const task = find(id)
      if (task === undefined) return 'unknown-task'
      task.status = 'done'
      task.closedAt = deps.nowIso()
      persist()
      return { ...task }
    },

    drop(id) {
      if (find(id) === undefined) return 'unknown-task'
      state = { ...state, tasks: state.tasks.filter((task) => task.id !== id) }
      persist()
      return true
    },

    contextBlock() {
      const open = state.tasks.filter((task) => task.status === 'open')
      if (open.length === 0) return null
      const shown = open.slice(0, MAX_TASKS_IN_CONTEXT)
      const lines = shown.map((task) => `- ${task.id}: ${task.text}`)
      if (open.length > shown.length) {
        lines.push(`- …и ещё ${open.length - shown.length} задач`)
      }
      return lines.join('\n')
    },
  }
}
