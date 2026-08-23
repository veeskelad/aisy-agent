import { describe, expect, it } from 'vitest'
import { makePostToolUseProcessor, type DotEnvLoadState } from '@aisy/core'
import {
  loadJsonSecretSource,
  makeLiveSecretValues,
  type JsonSecretSourceState,
} from './live-secret-sources.js'

const missingVault: JsonSecretSourceState = { status: 'missing', values: {} }
const missingDotenv: DotEnvLoadState = { status: 'missing', values: {} }

describe('live PostToolUse secret source composition', () => {
  it.each([
    ['vault unreadable', { status: 'unavailable', values: {}, error: 'READ_FAILED' }, missingDotenv],
    ['vault malformed', { status: 'unavailable', values: {}, error: 'MALFORMED' }, missingDotenv],
    ['dotenv unreadable', missingVault, { status: 'unavailable', values: {}, error: 'READ_FAILED' }],
    ['dotenv malformed', missingVault, { status: 'unavailable', values: {}, error: 'MALFORMED' }],
  ] as const)('withholds raw output when %s', async (_label, vault, dotenv) => {
    const post = makePostToolUseProcessor({
      secretValues: makeLiveSecretValues({ vault, dotenv, processEnv: {} }),
    })
    const result = await post({ name: 'read_file', args: { path: 'a' } }, {
      ok: true,
      output: 'raw-output-must-not-enter-context',
    })
    expect(result).toEqual({
      ok: false,
      output: 'tool result withheld (redaction or filter unavailable)',
    })
    expect(result.output).not.toContain('raw-output')
  })

  it('treats both missing sources as available empty layers', () => {
    expect(makeLiveSecretValues({
      vault: missingVault,
      dotenv: missingDotenv,
      processEnv: {},
    })()).toEqual([])
  })

  it('preserves malformed and unreadable JSON state', () => {
    const malformed = loadJsonSecretSource('/vault', {
      existsSync: () => true,
      readFileSync: () => '[]',
    })
    const unreadable = loadJsonSecretSource('/vault', {
      existsSync: () => true,
      readFileSync: () => { throw new Error('EACCES') },
    })
    expect(malformed).toMatchObject({ status: 'unavailable', error: 'MALFORMED' })
    expect(unreadable).toMatchObject({ status: 'unavailable', error: 'READ_FAILED' })
  })
})
