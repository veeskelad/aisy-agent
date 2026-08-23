import { describe, it, expect } from 'vitest'
import { parseDotEnv, loadDotEnv, loadDotEnvState } from './dotenv.js'

describe('parseDotEnv', () => {
  it('parses KEY=value lines', () => {
    expect(parseDotEnv('AISY_TELEGRAM_BOT_TOKEN=123:AA\nAISY_TELEGRAM_CHAT_ID=42\n')).toEqual({
      AISY_TELEGRAM_BOT_TOKEN: '123:AA',
      AISY_TELEGRAM_CHAT_ID: '42',
    })
  })

  it('skips comments, blanks, and the empty values of a fresh scaffold', () => {
    const scaffold = '# aisy\n\nAISY_TELEGRAM_BOT_TOKEN=\nAISY_DB_PATH=/x/y\n'
    expect(parseDotEnv(scaffold)).toEqual({ AISY_DB_PATH: '/x/y' })
  })

  it('keeps a value containing "=" intact (only the first splits)', () => {
    expect(parseDotEnv('K=a=b=c')).toEqual({ K: 'a=b=c' })
  })

  it('strips one layer of matching quotes', () => {
    expect(parseDotEnv('A="tok"\nB=\'tok\'\nC="tok\n')).toEqual({ A: 'tok', B: 'tok', C: '"tok' })
  })

  it('ignores malformed lines', () => {
    expect(parseDotEnv('no-equals\n=novalue\nlower_case=x\n')).toEqual({})
  })
})

describe('loadDotEnv', () => {
  const fs = (files: Record<string, string>) => ({
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => files[p] ?? '',
  })

  it('reads the file when present', () => {
    expect(loadDotEnv('/home/.aisy/.env', fs({ '/home/.aisy/.env': 'K=v\n' }))).toEqual({ K: 'v' })
  })

  it('a missing file is an empty layer, not an error', () => {
    expect(loadDotEnv('/nope/.env', fs({}))).toEqual({})
  })

  it('an unreadable file is an empty layer, not a crash', () => {
    const throwing = {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error('EACCES')
      },
    }
    expect(loadDotEnv('/x/.env', throwing)).toEqual({})
    expect(loadDotEnvState('/x/.env', throwing)).toEqual({
      status: 'unavailable', values: {}, error: 'READ_FAILED',
    })
  })

  it('preserves missing vs malformed source state', () => {
    expect(loadDotEnvState('/missing/.env', fs({}))).toEqual({ status: 'missing', values: {} })
    expect(loadDotEnvState('/x/.env', fs({ '/x/.env': 'lower=value\n' }))).toEqual({
      status: 'unavailable', values: {}, error: 'MALFORMED',
    })
  })
})
