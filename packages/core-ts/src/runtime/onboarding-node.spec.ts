import { describe, it, expect } from 'vitest'
import { detectGlobalInstall } from './onboarding-node.js'

describe('detectGlobalInstall', () => {
  it('global npm install via a bin symlink — argv[1] is the symlink, realpath is under node_modules', () => {
    // The bug we hit: process.argv[1] is the symlink, NOT under node_modules.
    const binPath = '/opt/homebrew/bin/aisy'
    const binReal = '/opt/homebrew/lib/node_modules/@aisy/app/dist/bin/aisy.js'
    const moduleUrl = 'file:///opt/homebrew/lib/node_modules/@aisy/core/dist/runtime/onboarding-node.js'
    expect(detectGlobalInstall(binPath, binReal, moduleUrl)).toBe(true)
  })

  it('global install where argv[1] already resolves under node_modules', () => {
    const p = '/usr/local/lib/node_modules/@aisy/app/dist/bin/aisy.js'
    expect(detectGlobalInstall(p, p, `file://${p}`)).toBe(true)
  })

  it('source checkout — nothing is under node_modules', () => {
    const binPath = '/Users/iam/Work/Projects/aisy-harness/packages/app/dist/bin/aisy.js'
    const moduleUrl = 'file:///Users/iam/Work/Projects/aisy-harness/packages/core-ts/dist/runtime/onboarding-node.js'
    expect(detectGlobalInstall(binPath, binPath, moduleUrl)).toBe(false)
  })
})
