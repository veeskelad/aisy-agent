#!/usr/bin/env node

import {
  bootstrapManagedInstall,
  ManagedUpdateFailure,
} from '../managed-install.js'

function argumentsMap(argv: string[]): {
  root: string; binDir: string; commit: string; recordIntegrity: boolean
} {
  const values = new Map<string, string>()
  for (const raw of argv) {
    if (!raw.startsWith('--') || !raw.includes('=')) throw new Error('arguments')
    const separator = raw.indexOf('=')
    const name = raw.slice(2, separator)
    const value = raw.slice(separator + 1)
    if (!['install-root', 'bin-dir', 'commit', 'record-integrity'].includes(name) ||
      values.has(name) || value === '') {
      throw new Error('arguments')
    }
    values.set(name, value)
  }
  if (values.size !== 3 && values.size !== 4) throw new Error('arguments')
  if (!['install-root', 'bin-dir', 'commit'].every(name => values.has(name))) {
    throw new Error('arguments')
  }
  if (values.has('record-integrity') && values.get('record-integrity') !== 'yes') {
    throw new Error('arguments')
  }
  return {
    root: values.get('install-root') as string,
    binDir: values.get('bin-dir') as string,
    commit: values.get('commit') as string,
    recordIntegrity: values.get('record-integrity') === 'yes',
  }
}

try {
  const input = argumentsMap(process.argv.slice(2))
  const generation = bootstrapManagedInstall({
    root: input.root,
    binDir: input.binDir,
    commit: input.commit,
    recordIntegrity: input.recordIntegrity,
  })
  process.stdout.write(`Aisy installed: current=${generation.current}\n`)
  process.exit(0)
} catch (error) {
  const code = error instanceof ManagedUpdateFailure ? error.code : 'UPDATE_STATE_REFUSED'
  process.stderr.write(`aisy install: операция отклонена (${code})\n`)
  process.exit(1)
}
