import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveExecutable } from './resolve-executable.js'

function fixture(): { root: string; bin: string; libexec: string } {
  // realpath the root: on macOS the temp dir itself lives behind /var → /private/var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-which-')))
  const bin = join(root, 'bin')
  const libexec = join(root, 'libexec')
  mkdirSync(bin)
  mkdirSync(libexec)
  return { root, bin, libexec }
}

describe('resolveExecutable', () => {
  it('returns the canonical target so a global npm bin symlink is usable', () => {
    const { bin, libexec } = fixture()
    const real = join(libexec, 'codex.js')
    writeFileSync(real, '#!/usr/bin/env node\n', { mode: 0o755 })
    symlinkSync(real, join(bin, 'codex'))

    expect(resolveExecutable('codex', { PATH: bin })).toBe(real)
  })

  it('reports an absent tool instead of throwing', () => {
    const { bin } = fixture()

    expect(resolveExecutable('codex', { PATH: bin })).toBeNull()
    expect(resolveExecutable('codex', {})).toBeNull()
  })

  it('skips a non-executable file and keeps walking PATH', () => {
    const { bin, libexec } = fixture()
    const decoy = join(bin, 'codex')
    writeFileSync(decoy, 'not runnable')
    chmodSync(decoy, 0o644)
    const real = join(libexec, 'codex')
    writeFileSync(real, '#!/bin/sh\n', { mode: 0o755 })

    expect(resolveExecutable('codex', { PATH: [bin, libexec].join(delimiter) })).toBe(real)
  })

  it('refuses a path-shaped name so PATH stays the only lookup', () => {
    const { bin } = fixture()
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 })

    expect(resolveExecutable('../bin/codex', { PATH: bin })).toBeNull()
    expect(resolveExecutable('', { PATH: bin })).toBeNull()
  })

  it('ignores relative PATH entries', () => {
    const { bin, libexec } = fixture()
    const real = join(libexec, 'codex')
    writeFileSync(real, '#!/bin/sh\n', { mode: 0o755 })

    expect(resolveExecutable('codex', { PATH: ['.', '', libexec].join(delimiter) })).toBe(real)
  })
})
