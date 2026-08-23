import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeBrainBootstrap } from '@aisy/core'
import { makeNodeBrainBootstrapStore } from './brain-bootstrap-store.js'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'aisy-brain-bootstrap-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Node Brain bootstrap store integration', () => {
  it('durably resumes the exact state after restart with private permissions', async () => {
    const root = temporaryRoot()
    const path = join(root, 'state', 'brain-bootstrap.json')
    const first = makeBrainBootstrap({
      store: makeNodeBrainBootstrapStore({ path }),
      nowIso: () => '2026-07-27T08:00:00.000Z',
    })
    const paired = await first.dispatch({ type: 'telegram-paired' })

    const restarted = makeBrainBootstrap({
      store: makeNodeBrainBootstrapStore({ path }),
      nowIso: () => '2026-07-27T08:01:00.000Z',
    })
    await expect(restarted.state()).resolves.toEqual(paired)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
  })

  it('does not follow a state symlink or alter its target', async () => {
    const root = temporaryRoot()
    const outside = join(root, 'outside.json')
    const path = join(root, 'state', 'brain-bootstrap.json')
    makeNodeBrainBootstrapStore({ path })
    writeFileSync(outside, 'outside-safe\n', { mode: 0o600 })
    symlinkSync(outside, path)

    const flow = makeBrainBootstrap({
      store: makeNodeBrainBootstrapStore({ path }),
      nowIso: () => '2026-07-27T08:00:00.000Z',
    })
    await expect(flow.state()).rejects.toMatchObject({
      code: 'BRAIN_BOOTSTRAP_UNSAFE_PATH',
    })
    expect(readFileSync(outside, 'utf8')).toBe('outside-safe\n')
  })

  it('fails closed for a pre-existing lock and over-broad state permissions', async () => {
    const root = temporaryRoot()
    const path = join(root, 'state', 'brain-bootstrap.json')
    const store = makeNodeBrainBootstrapStore({ path })
    writeFileSync(path + '.lock', 'foreign\n', { mode: 0o600 })
    await expect(store.save({
      version: 1,
      phase: 'CHOOSE_BRAIN',
      revision: 1,
      updatedAt: '2026-07-27T08:00:00.000Z',
    })).rejects.toMatchObject({ code: 'BRAIN_BOOTSTRAP_LOCK_HELD' })
    rmSync(path + '.lock')

    await store.save({
      version: 1,
      phase: 'CHOOSE_BRAIN',
      revision: 1,
      updatedAt: '2026-07-27T08:00:00.000Z',
    })
    chmodSync(path, 0o644)
    await expect(store.load()).rejects.toMatchObject({
      code: 'BRAIN_BOOTSTRAP_UNSAFE_PATH',
    })
  })
})
