import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_LIVE_TASKS, MAX_TASK_CHARS, makeTaskTracker } from './task-tracker.js'

const roots: string[] = []
const NOW = '2026-07-29T12:00:00Z'

function statePath(): string {
  const created = mkdtempSync(join(tmpdir(), 'aisy-tasks-'))
  roots.push(created)
  return join(created, 'tasks.json')
}

const tracker = (path: string, onQuarantine?: (detail: string) => void) =>
  makeTaskTracker({ path, nowIso: () => NOW, ...(onQuarantine ? { onQuarantine } : {}) })

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('persistent task tracker (ADR-0081)', () => {
  it('survives a restart with ids intact', () => {
    const path = statePath()
    const first = tracker(path)
    first.add('починить деплой')
    const second = first.add('написать отчёт')

    const reopened = tracker(path)

    expect(reopened.list().map((task) => `${task.id}:${task.text}`))
      .toEqual(['t1:починить деплой', 't2:написать отчёт'])
    expect(second).toMatchObject({ id: 't2', status: 'open' })
  })

  it('never reuses an id after a task is dropped', () => {
    const path = statePath()
    const track = tracker(path)
    track.add('первая')
    track.drop('t1')

    expect(track.add('вторая')).toMatchObject({ id: 't2' })
  })

  it('closes a task without losing it', () => {
    const path = statePath()
    const track = tracker(path)
    track.add('починить деплой')

    expect(track.done('t1')).toMatchObject({ id: 't1', status: 'done', closedAt: NOW })
    expect(tracker(path).list()).toHaveLength(1)
    // …but a closed task no longer occupies the context.
    expect(tracker(path).contextBlock()).toBeNull()
  })

  it('refuses unknown ids rather than silently doing nothing', () => {
    const track = tracker(statePath())
    expect(track.done('t99')).toBe('unknown-task')
    expect(track.drop('t99')).toBe('unknown-task')
  })

  it('refuses empty and oversized text instead of truncating it', () => {
    const track = tracker(statePath())
    expect(track.add('   ')).toBe('empty-text')
    expect(track.add('я'.repeat(MAX_TASK_CHARS + 1))).toBe('text-too-long')
  })

  it('refuses to grow past the live ceiling', () => {
    const track = tracker(statePath())
    for (let i = 0; i < MAX_LIVE_TASKS; i += 1) track.add(`задача ${i}`)

    expect(track.add('лишняя')).toBe('too-many-tasks')
    // Closing one makes room again: the ceiling counts живые, not all.
    track.done('t1')
    expect(track.add('теперь можно')).toMatchObject({ status: 'open' })
  })

  it('shows open tasks in context and caps how many', () => {
    const track = tracker(statePath())
    for (let i = 1; i <= 25; i += 1) track.add(`задача ${i}`)

    const block = track.contextBlock() ?? ''
    expect(block).toContain('t1: задача 1')
    expect(block).toContain('и ещё 5 задач')
    expect(block.split('\n')).toHaveLength(21)
  })

  it('starts empty rather than refusing to boot on a corrupted list', () => {
    const path = statePath()
    writeFileSync(path, '{ это не json')
    const reported: string[] = []

    const track = tracker(path, (detail) => reported.push(detail))

    expect(track.list()).toEqual([])
    expect(reported).toHaveLength(1)
    expect(existsSync(`${path}.quarantine`)).toBe(true)
  })

  it('writes a file that reads back as valid state', () => {
    const path = statePath()
    tracker(path).add('починить деплой')

    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      nextId: 2,
      tasks: [{ id: 't1', status: 'open' }],
    })
  })
})
